'use strict'

// 生产 db.json 异地加密备份 / 恢复演练 / 保留策略 / 失败告警 的核心库。
// 设计要点：
//  - 零外部依赖：仅用 Node 内置 crypto / zlib / fs / child_process。
//  - 全部函数可注入 now(毫秒) 与 alertSink，便于测试确定性构造与断言，绝不触碰真实 db。
//  - 加密密钥、异地目标、外部通知命令一律只从环境变量读取；本库不含任何目标/凭据/密钥常量。
//  - 备份只“读” db.json：db.js 的 writeDb 已用「写临时文件 + rename」原子替换，
//    因此直接 readFileSync 永远读到完整旧版或完整新版，不会读到半截写入，无需加锁、不停服。
//  - 恢复演练只把数据解密到临时目录做计数校验，绝不写回生产 db.json。

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

// 备份文件二进制头：MAGIC(6) + salt(16) + iv(12) + tag(16) + 密文。
const MAGIC = Buffer.from('YGBK01', 'utf8')
const MAGIC_LEN = MAGIC.length
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC_LEN + SALT_LEN + IV_LEN + TAG_LEN

// 七个核心集合：label 用于对外汇报（与需求口径一致），key 是 db.json 真实顶层键。
// reports/deals 在库里分别存为 clientReports/dealRecords，若按字面 key 计数会恒为 0、
// 使往返校验形同虚设，故这里做显式映射。favorites 是后加计数项；历史备份正文与整库 SHA
// 已覆盖收藏，但 meta.counts 没有该键，因此只允许这一新增项在旧元数据中缺省。
const CORE_COLLECTIONS = [
  { label: 'listings', key: 'listings' },
  { label: 'users', key: 'users' },
  { label: 'reports', key: 'clientReports' },
  { label: 'deals', key: 'dealRecords' },
  { label: 'commissionRecords', key: 'commissionRecords' },
  { label: 'footprints', key: 'footprints' },
  { label: 'favorites', key: 'favorites', optionalInLegacyMeta: true }
]

const ALERT_KINDS = {
  BACKUP_FAILED: 'BACKUP_FAILED', // 生成加密备份失败（读源/加密/写盘任一步）
  BACKUP_VERIFY_FAILED: 'BACKUP_VERIFY_FAILED', // 新备份即时自检（解密+计数往返）不通过
  BACKUP_EMPTY_SOURCE: 'BACKUP_EMPTY_SOURCE', // 跨备份回归：整库七项全为 0，但上一份备份有数据（疑似源被截断/读空）
  BACKUP_REMOTE_REQUIRED: 'BACKUP_REMOTE_REQUIRED', // 未配置 BACKUP_REMOTE_CMD 且未显式允许仅本地 → 未达成异地目标
  REMOTE_UPLOAD_FAILED: 'REMOTE_UPLOAD_FAILED', // 异地上传命令失败
  RESTORE_MISMATCH: 'RESTORE_MISMATCH', // 恢复演练数量往返校验不符
  RESTORE_FAILED: 'RESTORE_FAILED', // 恢复演练失败（解密/解压/解析/无备份）
  BACKUP_STALE: 'BACKUP_STALE' // 最近一次备份超过阈值（默认 24 小时）
}

const SCHEMA = 'ynzy-db-backup/1'
const CORE_COUNTS_VERSION = 2

// ---------- 计数 ----------

function countCoreCollections(db) {
  const safe = db && typeof db === 'object' ? db : {}
  const counts = {}
  for (const { label, key } of CORE_COLLECTIONS) {
    counts[label] = Array.isArray(safe[key]) ? safe[key].length : 0
  }
  return counts
}

// ---------- 加解密（AES-256-GCM + scrypt 派生密钥） ----------

function deriveKey(passphrase, salt) {
  // 接受任意长度口令，用随机 salt 通过 scrypt 派生 32 字节密钥；salt 随文件保存。
  return crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, 32)
}

function encryptPayload(plaintext, passphrase) {
  if (!passphrase) throw new Error('缺少加密密钥（BACKUP_ENCRYPTION_KEY）')
  const salt = crypto.randomBytes(SALT_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(MAGIC) // 把 MAGIC 绑进认证范围，头部被篡改会导致解密失败
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext])
}

function decryptPayload(fileBuffer, passphrase) {
  if (!passphrase) throw new Error('缺少解密密钥（BACKUP_ENCRYPTION_KEY）')
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < HEADER_LEN) {
    throw new Error('备份文件损坏：长度不足以容纳头部')
  }
  if (!fileBuffer.subarray(0, MAGIC_LEN).equals(MAGIC)) {
    throw new Error('备份文件格式不识别（magic 不匹配）')
  }
  let off = MAGIC_LEN
  const salt = fileBuffer.subarray(off, (off += SALT_LEN))
  const iv = fileBuffer.subarray(off, (off += IV_LEN))
  const tag = fileBuffer.subarray(off, (off += TAG_LEN))
  const ciphertext = fileBuffer.subarray(off)
  const key = deriveKey(passphrase, salt)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(tag)
  // 密钥错误、密文被篡改或损坏都会在 final() 抛出，天然承担完整性校验。
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

// ---------- 信封（gzip(JSON{meta, db})） ----------

function buildEnvelope(db, meta) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ meta, db }), 'utf8'))
}

function parseEnvelope(plaintextGz) {
  const json = zlib.gunzipSync(plaintextGz).toString('utf8')
  const obj = JSON.parse(json)
  return { meta: obj.meta, db: obj.db }
}

// 供测试构造任意（含故意不一致）信封的底层写盘工具。
function writeEnvelopeFile({ file, meta, db, passphrase }) {
  const encrypted = encryptPayload(buildEnvelope(db, meta), passphrase)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, encrypted)
  return file
}

// ---------- 文件名 / 时间戳 ----------

function stampFromMs(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

const FILE_RE = /^db-backup-(\d{8}T\d{6}Z)\.ygbak$/

function backupFileName(ms) {
  return `db-backup-${stampFromMs(ms)}.ygbak`
}

function parseBackupTimeMs(fileName) {
  const m = FILE_RE.exec(fileName)
  if (!m) return null
  const s = m[1]
  const g = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s)
  if (!g) return null
  const ms = Date.UTC(+g[1], +g[2] - 1, +g[3], +g[4], +g[5], +g[6])
  // 回验：Date.UTC 对越界字段（月13、日40、时25…）会静默进位成合法（甚至未来）时间戳，
  // 使垃圾文件名冒充“最新备份”从而抑制超期告警、逃过保留清理。用 stampFromMs 反解比对，
  // 不一致即视为非法文件名返回 null，从源头挡在 listBackups 之外。
  return stampFromMs(ms) === s ? ms : null
}

function listBackups(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    return []
  }
  return names
    .map((name) => ({ name, timeMs: parseBackupTimeMs(name), file: path.join(dir, name) }))
    .filter((item) => item.timeMs != null)
    .sort((a, b) => b.timeMs - a.timeMs) // 新 → 旧
}

// ---------- 生成备份 ----------

function readSourceDb(dataFile) {
  const raw = fs.readFileSync(dataFile, 'utf8').replace(/^﻿/, '')
  return raw.trim() ? JSON.parse(raw) : {}
}

function createBackup({ dataFile, stageDir, passphrase, now }) {
  const nowMs = Number.isFinite(now) ? now : Date.now()
  const db = readSourceDb(dataFile)
  const counts = countCoreCollections(db)
  const dbSha256 = crypto.createHash('sha256').update(JSON.stringify(db)).digest('hex')
  const meta = {
    schema: SCHEMA,
    countsVersion: CORE_COUNTS_VERSION,
    createdAtMs: nowMs,
    createdAt: new Date(nowMs).toISOString(),
    dataFile: path.basename(dataFile),
    counts,
    dbSha256
  }
  const encrypted = encryptPayload(buildEnvelope(db, meta), passphrase)
  fs.mkdirSync(stageDir, { recursive: true })
  const fileName = backupFileName(nowMs)
  const filePath = path.join(stageDir, fileName)
  // 原子落盘：先写 .tmp 再 rename，避免异地上传/演练读到半截备份文件。
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, encrypted)
  fs.renameSync(tmp, filePath)
  return { file: filePath, fileName, meta, bytes: encrypted.length, sourceCounts: counts }
}

// ---------- 恢复演练（只解密到临时目录，不写回生产） ----------

function restoreDrill({ backupFile, passphrase, tempDir, now }) {
  const result = {
    ok: false,
    backupFile,
    counts: null,
    meta: null,
    mismatches: [],
    dbSha256Match: null,
    restoredPath: null,
    error: null
  }

  let plaintext
  try {
    plaintext = decryptPayload(fs.readFileSync(backupFile), passphrase)
  } catch (error) {
    result.error = `解密失败：${error.message}`
    return result
  }

  let envelope
  try {
    envelope = parseEnvelope(plaintext)
  } catch (error) {
    result.error = `解压或 JSON 解析失败：${error.message}`
    return result
  }

  const { meta, db } = envelope
  result.meta = meta || null

  // 解密结果落到临时目录再从磁盘读回，确认真的可解析、可恢复。
  // 明文残留安全：调用方未传 tempDir 时，本函数自建临时目录并在 finally 用完即删，
  // 绝不把整库解密明文长期留在系统临时目录（否则等于绕过 AES-256-GCM 加密）。
  // 调用方显式传入 tempDir 时视为“调用方自管生命周期”（如真恢复要保留产物），本函数不删。
  let dir = tempDir
  let selfCreatedDir = null
  try {
    if (!dir) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-restore-drill-'))
      selfCreatedDir = dir
    } else {
      fs.mkdirSync(dir, { recursive: true })
    }
  } catch (error) {
    result.error = `创建临时目录失败：${error.message}`
    return result
  }

  try {
    const restoredPath = path.join(dir, 'db.restored.json')
    const dbJson = JSON.stringify(db)
    let reparsed
    try {
      fs.writeFileSync(restoredPath, dbJson, 'utf8')
      reparsed = JSON.parse(fs.readFileSync(restoredPath, 'utf8'))
    } catch (error) {
      result.error = `恢复出的 db 无法写入临时目录或再次解析：${error.message}`
      return result
    }
    // 自建目录用完即删，restoredPath 不对外暴露（已随目录删除）；调用方传入目录时才保留路径。
    result.restoredPath = selfCreatedDir ? null : restoredPath

    const counts = countCoreCollections(reparsed)
    result.counts = counts

    if (!meta || !meta.counts || typeof meta.counts !== 'object' || Array.isArray(meta.counts)) {
      result.error = '备份缺少 meta.counts，无法做往返一致性校验'
      return result
    }

    const hasCountsVersion = Object.prototype.hasOwnProperty.call(meta, 'countsVersion')
    if (hasCountsVersion && meta.countsVersion !== CORE_COUNTS_VERSION) {
      result.error = `不支持的核心计数版本：${String(meta.countsVersion)}`
      return result
    }

    // 所有由本备份模块生成的历史信封自首版起就带整库 SHA。它既是字段级完整性二次防线，
    // 也是“旧计数尚无 favorites”兼容的可信锚点；缺失或格式非法时不得把任意信封当历史好备份放行。
    if (typeof meta.dbSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(meta.dbSha256)) {
      result.dbSha256Match = false
      result.error = '备份缺少有效的 db 内容哈希，无法确认整库完整性'
      return result
    }
    const actualSha256 = crypto.createHash('sha256').update(dbJson).digest('hex')
    result.dbSha256Match = actualSha256 === meta.dbSha256.toLowerCase()
    if (!result.dbSha256Match) {
      result.error = 'db 内容哈希与备份记录不一致（数量相同但内容被改动/损坏）'
      return result
    }

    // 信封自洽校验：恢复出的七项数量逐项 == 备份时刻记录的源数量（meta.counts）。
    // 说明：meta.counts 与 db 同在一个信封里，本项确保备份内部一致、完整可恢复、解析路径正确；
    // “源被读成空/截断”这类问题由 runBackup 里对上一份备份的跨备份计数回归检查兜底，二者互补。
    for (const { label, optionalInLegacyMeta } of CORE_COLLECTIONS) {
      const hasCount = Object.prototype.hasOwnProperty.call(meta.counts, label)
      // 真正的历史格式没有 countsVersion；只有其整库 SHA 已在上方验证通过时，才允许缺后加的收藏计数。
      if (!hasCount && optionalInLegacyMeta && !hasCountsVersion) continue
      if (!hasCount) {
        result.mismatches.push({ collection: label, expected: '非负整数计数', got: '缺失' })
        continue
      }
      const expected = meta.counts[label]
      if (!Number.isSafeInteger(expected) || expected < 0) {
        result.mismatches.push({ collection: label, expected: '非负整数计数', got: expected })
        continue
      }
      const got = counts[label]
      if (expected !== got) result.mismatches.push({ collection: label, expected, got })
    }
    if (result.mismatches.length > 0) {
      result.error = '往返数量校验不符：' +
        result.mismatches.map((m) => `${m.collection} 期望 ${m.expected} 实得 ${m.got}`).join('；')
      return result
    }

    result.ok = true
    return result
  } finally {
    if (selfCreatedDir) {
      try { fs.rmSync(selfCreatedDir, { recursive: true, force: true }) } catch (cleanupError) { /* 忽略清理失败 */ }
    }
  }
}

// ---------- 保留策略 ----------

function enforceRetention({ dir, days, now }) {
  const nowMs = Number.isFinite(now) ? now : Date.now()
  const keepDays = Number.isFinite(days) && days > 0 ? days : 30
  const cutoff = nowMs - keepDays * 86400000
  const removed = []
  for (const item of listBackups(dir)) {
    if (item.timeMs < cutoff) {
      try {
        fs.unlinkSync(item.file)
        removed.push(item.name)
      } catch (error) {
        // 单个删除失败不致命，交由上层日志，避免阻塞其余清理。
      }
    }
  }
  return { removed, remaining: listBackups(dir).map((item) => item.name) }
}

// ---------- 新鲜度（最近备份是否超期） ----------

function checkFreshness({ dir, maxAgeHours, now }) {
  const nowMs = Number.isFinite(now) ? now : Date.now()
  const maxMs = (Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24) * 3600000
  const all = listBackups(dir)
  if (all.length === 0) {
    return { ok: false, latest: null, latestMs: null, ageMs: null, maxMs, reason: '没有任何备份文件' }
  }
  const latest = all[0]
  const ageMs = nowMs - latest.timeMs
  return { ok: ageMs <= maxMs, latest: latest.name, latestMs: latest.timeMs, ageMs, maxMs }
}

// ---------- 告警 ----------

function defaultAlertSink({ kind, message, detail }) {
  process.stderr.write(`[备份告警][${kind}] ${message}\n`)
  // 外部通知命令只从环境变量读取（仓库不写目标/凭据/webhook）；把内容经环境变量传入，避免拼接注入。
  const cmd = process.env.BACKUP_ALERT_CMD
  if (cmd && cmd.trim()) {
    const env = {
      ...process.env,
      ALERT_KIND: kind,
      ALERT_MESSAGE: message,
      ALERT_DETAIL: JSON.stringify(detail || {})
    }
    try {
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', cmd], { env, stdio: 'ignore', timeout: 15000 })
      } else {
        execFileSync('/bin/sh', ['-c', cmd], { env, stdio: 'ignore', timeout: 15000 })
      }
    } catch (error) {
      process.stderr.write(`[备份告警] 外部通知命令执行失败：${error.message}\n`)
    }
  }
}

function raiseAlert(sink, kind, message, detail) {
  const record = { kind, message, detail: detail || {} }
  try {
    ;(sink || defaultAlertSink)(record)
  } catch (error) {
    process.stderr.write(`[备份告警] 告警发送失败：${error.message}\n`)
  }
  return record
}

// ---------- 异地上传钩子 ----------

function defaultExec(cmd, extraEnv) {
  const env = { ...process.env, ...extraEnv }
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', cmd], { env, stdio: 'inherit', timeout: 300000 })
  } else {
    execFileSync('/bin/sh', ['-c', cmd], { env, stdio: 'inherit', timeout: 300000 })
  }
}

function uploadRemote({ file, remoteCmd, exec }) {
  // 远端目标/凭据全在 remoteCmd（来自环境变量）里；把文件路径经环境变量传入，命令用 $BACKUP_FILE 引用。
  const runner = exec || defaultExec
  runner(remoteCmd, { BACKUP_FILE: file, BACKUP_FILENAME: path.basename(file) })
}

// ---------- 跨备份计数回归（独立第二数据源） ----------

// 读取某备份文件信封里的 meta（含备份时刻计数）；解密/解析失败返回 null。
function readBackupMeta(file, passphrase) {
  try {
    return parseEnvelope(decryptPayload(fs.readFileSync(file), passphrase)).meta || null
  } catch (error) {
    return null
  }
}

// 跨备份回归必须以“上一份实际恢复正文”为基线，而不能只信历史 meta.counts：
// M7 前正文已包含 favorites，但旧计数没有该键。只有整库 SHA 有效且匹配时才返回实际七项计数。
function readBackupBaselineCounts(file, passphrase) {
  try {
    const { meta, db } = parseEnvelope(decryptPayload(fs.readFileSync(file), passphrase))
    if (!meta || !meta.counts || typeof meta.counts !== 'object' || Array.isArray(meta.counts)) return null
    if (typeof meta.dbSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(meta.dbSha256)) return null
    const dbJson = JSON.stringify(db)
    const actual = crypto.createHash('sha256').update(dbJson).digest('hex')
    if (actual !== meta.dbSha256.toLowerCase()) return null
    return countCoreCollections(db)
  } catch (error) {
    return null
  }
}

// 判定“疑似源被截断/读成空”：本次七项计数全为 0，而上一份备份存在任一 > 0。
// 只在“整库全空 vs 上一份有数据”这一无歧义信号上触发，避免对正常的单集合清理误报。
function isEmptySourceRegression(newCounts, priorCounts) {
  if (!priorCounts || !newCounts) return false
  const total = (counts) => CORE_COLLECTIONS.reduce((sum, { label }) => sum + (Number(counts[label]) || 0), 0)
  return total(newCounts) === 0 && total(priorCounts) > 0
}

// ---------- 编排：一次完整备份 ----------

function runBackup(options) {
  const {
    dataFile,
    stageDir,
    passphrase,
    now,
    retentionDays = 30,
    remoteCmd,
    allowLocalOnly = false,
    exec,
    alertSink = defaultAlertSink,
    quiet = false
  } = options
  const alerts = []
  const result = { ok: false, file: null, meta: null, removed: [], remoteUploaded: false, alerts }
  const warn = (msg) => { if (!quiet) process.stderr.write(msg + '\n') }

  // 记录本轮之前的“上一份最新备份”，用作跨备份计数回归的独立第二数据源（见第 2.1 步）。
  const priorLatest = listBackups(stageDir)[0] || null

  // 1) 生成加密备份（读源 / 加密 / 写盘任一失败都判定备份失败并告警）。
  let created
  try {
    created = createBackup({ dataFile, stageDir, passphrase, now })
    result.file = created.file
    result.meta = created.meta
  } catch (error) {
    alerts.push(raiseAlert(alertSink, ALERT_KINDS.BACKUP_FAILED, `生成加密备份失败：${error.message}`, { dataFile, stageDir }))
    return result
  }

  // 2) 即时自检：对刚落盘的备份做恢复演练（解密 + 往返数量校验），不可信则删除、不外发。
  //    restoreDrill 未传 tempDir 时自建临时目录并用完即清，不残留明文。
  let drill
  try {
    drill = restoreDrill({ backupFile: created.file, passphrase, now })
  } catch (error) {
    drill = { ok: false, error: `自检异常：${error.message}`, mismatches: [] }
  }
  if (!drill.ok) {
    alerts.push(raiseAlert(alertSink, ALERT_KINDS.BACKUP_VERIFY_FAILED, `新备份自检失败：${drill.error}`, { file: created.fileName, mismatches: drill.mismatches }))
    try { fs.unlinkSync(created.file) } catch (error) { /* 忽略 */ }
    result.file = null
    return result
  }

  // 2.1) 跨备份计数回归：信封“自比自”无法发现“源被截断/读成空”。用上一份备份的计数做独立比对——
  //     若本次七项全为 0 而上一份有数据，几乎必是源被清空/截断，此空备份不可信：告警、删除、判失败，
  //     避免把一份丢光生产数据的“成功备份”上传异地并进入轮换。（时间型保留策略保证旧的好备份仍在。）
  if (priorLatest) {
    const priorCounts = readBackupBaselineCounts(priorLatest.file, passphrase)
    if (priorCounts && isEmptySourceRegression(created.meta.counts, priorCounts)) {
      alerts.push(raiseAlert(alertSink, ALERT_KINDS.BACKUP_EMPTY_SOURCE,
        `疑似源被截断：本次备份七项计数全为 0，但上一份备份（${priorLatest.name}）仍有数据`,
        { file: created.fileName, newCounts: created.meta.counts, priorCounts }))
      try { fs.unlinkSync(created.file) } catch (error) { /* 忽略 */ }
      result.file = null
      return result
    }
  }

  // 3) 异地目标门禁：P0-1 目标是“异地备份”。默认必须配置 BACKUP_REMOTE_CMD 并上传成功才算达成；
  //    只有显式 allowLocalOnly（BACKUP_ALLOW_LOCAL_ONLY=1）才允许“仅本地”作为成功，用于本地演练。
  //    本地加密备份已通过自检+回归、是可信文件，故门禁不达标时保留该文件、仅判本轮未达成异地目标。
  let remoteAchieved = false
  if (remoteCmd && remoteCmd.trim()) {
    try {
      uploadRemote({ file: created.file, remoteCmd, exec })
      result.remoteUploaded = true
      remoteAchieved = true
    } catch (error) {
      alerts.push(raiseAlert(alertSink, ALERT_KINDS.REMOTE_UPLOAD_FAILED, `异地上传失败：${error.message}`, { file: created.fileName }))
    }
  } else if (allowLocalOnly) {
    warn('[备份] 已显式允许仅本地备份（BACKUP_ALLOW_LOCAL_ONLY=1）：未配置异地目标，仅生成本地加密备份。')
    remoteAchieved = true
  } else {
    alerts.push(raiseAlert(alertSink, ALERT_KINDS.BACKUP_REMOTE_REQUIRED,
      '未配置 BACKUP_REMOTE_CMD 且未显式允许仅本地备份（BACKUP_ALLOW_LOCAL_ONLY=1）：未达成异地备份目标，本轮判失败。',
      { file: created.fileName }))
  }

  // 4) 保留策略：无论异地是否达成都按时间清理，避免持续失败时本地备份无限堆积。
  try {
    result.removed = enforceRetention({ dir: stageDir, days: retentionDays, now }).removed
  } catch (error) {
    warn(`[备份] 保留清理失败（不影响本次备份）：${error.message}`)
  }

  // 只有异地上传成功、或显式允许仅本地时，才判本轮备份成功。
  result.ok = remoteAchieved
  return result
}

// ---------- 编排：一次恢复演练 + 新鲜度巡检 ----------

function runRestoreDrill(options) {
  const {
    backupFile,
    dir,
    passphrase,
    tempDir,
    now,
    maxAgeHours = 24,
    checkStale = true,
    alertSink = defaultAlertSink
  } = options
  const alerts = []
  const result = { ok: false, drill: null, freshness: null, target: null, alerts }

  // 选定演练对象：显式指定优先，否则取目录内最新一份。
  let target = backupFile
  if (!target) {
    const all = listBackups(dir)
    if (all.length === 0) {
      alerts.push(raiseAlert(alertSink, ALERT_KINDS.RESTORE_FAILED, '没有可演练的备份文件', { dir }))
      return result
    }
    target = all[0].file
  }
  result.target = target

  // 新鲜度：最近一份备份超过阈值即告警（与演练结果相互独立）。
  if (checkStale && dir) {
    const fresh = checkFreshness({ dir, maxAgeHours, now })
    result.freshness = fresh
    if (!fresh.ok) {
      const ageDesc = fresh.reason || `${Math.round((fresh.ageMs || 0) / 3600000)} 小时前`
      alerts.push(raiseAlert(alertSink, ALERT_KINDS.BACKUP_STALE, `最近备份超过 ${maxAgeHours} 小时：${ageDesc}`, fresh))
    }
  }

  // 演练本体。
  const drill = restoreDrill({ backupFile: target, passphrase, tempDir, now })
  result.drill = drill
  if (!drill.ok) {
    const kind = drill.mismatches && drill.mismatches.length
      ? ALERT_KINDS.RESTORE_MISMATCH
      : ALERT_KINDS.RESTORE_FAILED
    alerts.push(raiseAlert(alertSink, kind, `恢复演练失败：${drill.error}`, { file: path.basename(target), mismatches: drill.mismatches }))
    return result
  }

  result.ok = true
  return result
}

module.exports = {
  CORE_COLLECTIONS,
  CORE_COUNTS_VERSION,
  ALERT_KINDS,
  SCHEMA,
  countCoreCollections,
  deriveKey,
  encryptPayload,
  decryptPayload,
  buildEnvelope,
  parseEnvelope,
  writeEnvelopeFile,
  stampFromMs,
  backupFileName,
  parseBackupTimeMs,
  listBackups,
  readSourceDb,
  readBackupMeta,
  readBackupBaselineCounts,
  isEmptySourceRegression,
  createBackup,
  restoreDrill,
  enforceRetention,
  checkFreshness,
  defaultAlertSink,
  uploadRemote,
  runBackup,
  runRestoreDrill
}
