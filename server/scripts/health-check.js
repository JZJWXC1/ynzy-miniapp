'use strict'

// 独立健康巡检：检查「会拖垮生产但 /healthz 未必发现」的信号——db 可解析、磁盘余量、备份新鲜度、
// 服务端点可达。失败打结构化 [health] 日志并**非零退出**（供 systemd/journald 告警）；配了
// HEALTH_ALERT_CMD 时经环境变量把摘要传给外部通知命令（仓库不写凭据/webhook）。不改 index.js/readyz。
//
// 用法：node server/scripts/health-check.js
// 环境：PORT(默认3101)、DATA_FILE(db 路径，同服务)、BACKUP_STAGE_DIR/BACKUP_DIR(备份目录)、
//       BACKUP_MAX_AGE_HOURS(默认24)、DISK_MIN_FREE_PCT(默认10)、HEALTH_ALERT_CMD(可选外部通知)。

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const SERVER_DIR = path.join(__dirname, '..')

// ---------- 纯函数（可单测，无副作用） ----------

function evaluateDb(raw) {
  try {
    const text = String(raw || '').charCodeAt(0) === 65279 ? String(raw).slice(1) : String(raw || '')
    const db = JSON.parse(text)
    const listings = Array.isArray(db.listings) ? db.listings.length : -1
    const users = Array.isArray(db.users) ? db.users.length : -1
    if (listings < 0) return { ok: false, detail: 'db.json 缺 listings 数组' }
    return { ok: true, listings, users, sizeBytes: Buffer.byteLength(String(raw || '')) }
  } catch (error) {
    return { ok: false, detail: 'db.json 不可解析：' + (error && error.message) }
  }
}

// 解析 `df -Pk <path>` 输出，可用百分比低于 minFreePct 判失败。
function parseDfFreePct(dfOutput, minFreePct) {
  const min = Number.isFinite(minFreePct) ? minFreePct : 10
  const lines = String(dfOutput || '').trim().split('\n')
  if (lines.length < 2) return { ok: false, detail: 'df 输出异常' }
  const cols = lines[lines.length - 1].trim().split(/\s+/)
  // POSIX `df -Pk`: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const total = Number(cols[1])
  const avail = Number(cols[3])
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(avail)) return { ok: false, detail: 'df 解析失败' }
  const freePct = Math.round((avail / total) * 100)
  return { ok: freePct >= min, freePct, availKb: avail, minFreePct: min }
}

function aggregate(checks) {
  const list = Array.isArray(checks) ? checks : []
  const failures = list.filter((item) => item && item.ok === false).map((item) => item.name)
  return { ok: failures.length === 0, checks: list, failures }
}

function resolveDbPath() {
  const env = process.env.DATA_FILE || ''
  if (env && path.isAbsolute(env)) return env
  return path.join(SERVER_DIR, env || 'data/db.json')
}

// ---------- CLI 各项检查（含 IO 副作用，不进单测） ----------

function checkDb() {
  try {
    return { name: 'db', ...evaluateDb(fs.readFileSync(resolveDbPath(), 'utf8')) }
  } catch (error) {
    return { name: 'db', ok: false, detail: 'db.json 读取失败：' + (error && error.code) }
  }
}

function checkDisk() {
  try {
    const out = execSync('df -Pk "' + SERVER_DIR + '"', { encoding: 'utf8' })
    return { name: 'disk', ...parseDfFreePct(out, Number(process.env.DISK_MIN_FREE_PCT || 10)) }
  } catch (error) {
    return { name: 'disk', ok: true, skipped: 'df 不可用（' + (error && error.code) + '）' } // 无 df 则跳过、不误报
  }
}

function checkBackup() {
  try {
    const backup = require('../src/backup')
    if (typeof backup.checkFreshness !== 'function') return { name: 'backup', ok: true, skipped: '无 checkFreshness' }
    const dir = process.env.BACKUP_STAGE_DIR || process.env.BACKUP_DIR
    if (!dir) return { name: 'backup', ok: true, skipped: '未配置备份目录' } // 未配置则跳过、不误报
    const fresh = backup.checkFreshness({ dir, maxAgeHours: Number(process.env.BACKUP_MAX_AGE_HOURS || 24) })
    return { name: 'backup', ok: fresh.ok !== false, latest: fresh.latest, ageHours: fresh.ageMs != null ? Math.round(fresh.ageMs / 3600000) : null, reason: fresh.reason }
  } catch (error) {
    return { name: 'backup', ok: true, skipped: 'backup 检查异常：' + (error && error.message) }
  }
}

function checkService() {
  const port = process.env.PORT || 3101
  try {
    const code = execSync('curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:' + port + '/healthz"', { encoding: 'utf8' }).trim()
    return { name: 'service', ok: code === '200', httpCode: code, port: Number(port) }
  } catch (error) {
    return { name: 'service', ok: false, detail: 'healthz 不可达', port: Number(port) }
  }
}

function alertIfNeeded(result) {
  if (result.ok) return
  process.stderr.write('[health][ALERT] 巡检失败：' + result.failures.join(',') + '\n')
  const cmd = process.env.HEALTH_ALERT_CMD
  if (!cmd || !cmd.trim()) return
  try {
    // 摘要经环境变量传入，避免拼接注入；不含任何凭据。
    execSync(cmd, {
      env: { ...process.env, HEALTH_FAILURES: result.failures.join(','), HEALTH_SUMMARY: JSON.stringify(result) },
      stdio: 'ignore',
      timeout: 15000
    })
  } catch (error) {
    process.stderr.write('[health] 告警命令执行失败：' + (error && error.message) + '\n')
  }
}

if (require.main === module) {
  const result = aggregate([checkDb(), checkDisk(), checkBackup(), checkService()])
  process.stdout.write('[health] ' + JSON.stringify(result) + '\n')
  alertIfNeeded(result)
  process.exit(result.ok ? 0 : 1)
}

module.exports = { evaluateDb, parseDfFreePct, aggregate, resolveDbPath }
