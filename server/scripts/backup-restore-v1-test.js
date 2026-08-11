'use strict'

// 备份 / 恢复演练 / 保留策略 / 告警 的锁定测试。
// 全程只用系统临时目录模拟 db.json 与备份，绝不触碰真实 server/data。
// 覆盖：全链路往返一致、三种失败场景告警（备份写入失败 / 恢复数量不符 / 最近备份超24h）、
//       保留策略、篡改检测。

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

// backup.js 不依赖 config；仍防御性指向临时 DATA_FILE，确保任何情况下都不碰真实数据文件。
process.env.DATA_FILE = process.env.DATA_FILE || path.join(os.tmpdir(), 'ynzy-backup-test-db.json')

const backup = require('../src/backup')

const PW = 'test-backup-passphrase-兔子🐇'
const NOW = Date.UTC(2026, 6, 6, 12, 0, 0) // 固定时间，保证确定性
const EXPECTED_COUNTS = {
  listings: 3,
  users: 2,
  reports: 1,
  deals: 2,
  commissionRecords: 1,
  footprints: 4,
  favorites: 2
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ynzy-backup-${tag}-`))
}

function sampleDb() {
  return {
    listings: [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }],
    users: [{ id: 'U1' }, { id: 'U2' }],
    clientReports: [{ id: 'R1' }], // 对应 reports
    dealRecords: [{ id: 'D1' }, { id: 'D2' }], // 对应 deals
    commissionRecords: [{ id: 'C1' }],
    footprints: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }, { id: 'F4' }],
    favorites: [
      { id: 'FV1', userId: 'U1', listingId: 'L1' },
      { id: 'FV2', userId: 'U2', listingId: 'L2' }
    ],
    pointLogs: [{ id: 'P1' }] // 无关键：不应计入核心计数
  }
}

function sha256Db(db) {
  return crypto.createHash('sha256').update(JSON.stringify(db)).digest('hex')
}

function makeSink() {
  const alerts = []
  const sink = (record) => alerts.push(record)
  sink.alerts = alerts
  sink.kinds = () => alerts.map((a) => a.kind)
  return sink
}

function run() {
  // 1) 全链路：备份 → 演练 → 计数往返逐项一致，且不写回源。
  {
    const dir = tmpdir('roundtrip')
    const dataFile = path.join(dir, 'db.json')
    const stageDir = path.join(dir, 'backups')
    const original = JSON.stringify(sampleDb())
    fs.writeFileSync(dataFile, original)

    const sink = makeSink()
    const rb = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW, alertSink: sink, quiet: true, allowLocalOnly: true })
    assert.ok(rb.ok, '首次备份应成功')
    assert.strictEqual(sink.alerts.length, 0, '成功备份不应产生告警')
    assert.ok(fs.existsSync(rb.file), '加密备份文件应存在')
    assert.deepStrictEqual(rb.meta.counts, EXPECTED_COUNTS, '源计数应逐项正确（reports/deals 映射到 clientReports/dealRecords）')
    assert.strictEqual(rb.meta.countsVersion, 2, '新备份必须显式标记七项核心计数版本')

    const cipherBytes = fs.readFileSync(rb.file)
    assert.ok(!cipherBytes.toString('latin1').includes('commissionRecords'), '备份必须是密文，不得出现明文集合键名')

    const drillSink = makeSink()
    const rd = backup.runRestoreDrill({ dir: stageDir, passphrase: PW, now: NOW + 3600000, alertSink: drillSink })
    assert.ok(rd.ok, '恢复演练应成功')
    assert.strictEqual(drillSink.alerts.length, 0, '成功演练不应产生告警')
    assert.deepStrictEqual(rd.drill.counts, EXPECTED_COUNTS, '恢复计数应与备份时刻源计数逐项相等')
    assert.strictEqual(rd.drill.dbSha256Match, true, '内容哈希应吻合')
    assert.strictEqual(fs.readFileSync(dataFile, 'utf8'), original, '演练绝不能改动源 db.json')
  }

  // 2) 失败场景一：备份写入失败 → BACKUP_FAILED。
  {
    const dir = tmpdir('writefail')
    const dataFile = path.join(dir, 'db.json')
    fs.writeFileSync(dataFile, JSON.stringify(sampleDb()))
    // 让 stageDir 本身是一个已存在的普通文件，mkdir 必然失败 → 落盘失败。
    const stageDir = path.join(dir, 'stage-is-a-file')
    fs.writeFileSync(stageDir, 'occupied')

    const sink = makeSink()
    const rb = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW, alertSink: sink, quiet: true })
    assert.strictEqual(rb.ok, false, '写盘失败时备份必须判失败')
    const failAlert = sink.alerts.find((a) => a.kind === backup.ALERT_KINDS.BACKUP_FAILED)
    assert.ok(failAlert, '写盘失败必须触发 BACKUP_FAILED 告警')
    // 自由异常正文不得进入告警；用严格机器码证明失败来自写盘步骤。
    assert.ok(/^(?:EEXIST|ENOTDIR|EPERM|EACCES)$/.test(String(failAlert.detail && failAlert.detail.errorCode || '')), `告警须保留写盘机器码，实得：${JSON.stringify(failAlert.detail)}`)
  }

  // 3) 失败场景二：恢复数量校验不符 → RESTORE_MISMATCH。
  {
    const dir = tmpdir('mismatch')
    const stageDir = path.join(dir, 'backups')
    const db = sampleDb()
    // 故意构造：meta 记 listings/favorites=999，但 db 实际分别只有 3/2 条。
    backup.writeEnvelopeFile({
      file: path.join(stageDir, backup.backupFileName(NOW)),
      passphrase: PW,
      db,
      meta: {
        schema: backup.SCHEMA,
        createdAtMs: NOW,
        counts: { listings: 999, users: 2, reports: 1, deals: 2, commissionRecords: 1, footprints: 4, favorites: 999 },
        dbSha256: sha256Db(db)
      }
    })

    const sink = makeSink()
    const rd = backup.runRestoreDrill({ dir: stageDir, passphrase: PW, now: NOW + 1000, alertSink: sink })
    assert.strictEqual(rd.ok, false, '数量不符时演练必须判失败')
    assert.ok(sink.kinds().includes(backup.ALERT_KINDS.RESTORE_MISMATCH), '数量不符必须触发 RESTORE_MISMATCH 告警')
    assert.ok(
      rd.drill.mismatches.some((m) => m.collection === 'listings' && m.expected === 999 && m.got === 3),
      '应明确报告 listings 期望 999 实得 3'
    )
    assert.ok(
      rd.drill.mismatches.some((m) => m.collection === 'favorites' && m.expected === 999 && m.got === 2),
      '显式记录的 favorites 数量不符也必须报告，不能被历史兼容分支跳过'
    )
  }

  // 4) 向后兼容：历史备份正文可能已有 favorites，但旧 meta.counts 尚未单列该项；
  //    新版本恢复必须继续校验当时已记录的六项与整库 SHA，不能把历史好备份误判为损坏。
  {
    const dir = tmpdir('legacy-counts')
    const stageDir = path.join(dir, 'backups')
    const db = sampleDb()
    const legacyCounts = {
      listings: 3,
      users: 2,
      reports: 1,
      deals: 2,
      commissionRecords: 1,
      footprints: 4
    }
    backup.writeEnvelopeFile({
      file: path.join(stageDir, backup.backupFileName(NOW)),
      passphrase: PW,
      db,
      meta: { schema: backup.SCHEMA, createdAtMs: NOW, counts: legacyCounts, dbSha256: sha256Db(db) }
    })

    const sink = makeSink()
    const rd = backup.runRestoreDrill({ dir: stageDir, passphrase: PW, now: NOW + 1000, alertSink: sink })
    assert.ok(rd.ok, '缺少 favorites 计数的历史备份仍应可恢复')
    assert.strictEqual(rd.drill.dbSha256Match, true, '历史备份仍必须通过整库 SHA 校验')
    assert.strictEqual(rd.drill.counts.favorites, 2, '恢复结果应识别正文中已有的收藏关系')
    assert.strictEqual(sink.alerts.length, 0, '兼容历史备份不应产生误报告警')
  }

  // 5) 历史兼容必须收窄：缺少 favorites 的旧计数只有在整库 SHA 存在且匹配时才可放行；
  //    带新计数版本却缺 favorites 的信封必须失败，不能伪装历史格式。
  {
    const db = sampleDb()
    const legacyCounts = {
      listings: 3,
      users: 2,
      reports: 1,
      deals: 2,
      commissionRecords: 1,
      footprints: 4
    }

    const noShaDir = tmpdir('legacy-no-sha')
    const noShaFile = path.join(noShaDir, backup.backupFileName(NOW))
    backup.writeEnvelopeFile({
      file: noShaFile,
      passphrase: PW,
      db,
      meta: { schema: backup.SCHEMA, createdAtMs: NOW, counts: legacyCounts }
    })
    const noSha = backup.restoreDrill({ backupFile: noShaFile, passphrase: PW })
    assert.strictEqual(noSha.ok, false, '旧计数缺 favorites 且没有整库 SHA 时必须拒绝恢复')
    assert.ok(/哈希|完整性/.test(noSha.error), `缺 SHA 应报告完整性错误，实得：${noSha.error}`)

    const versionedDir = tmpdir('versioned-missing-favorite')
    const versionedFile = path.join(versionedDir, backup.backupFileName(NOW))
    backup.writeEnvelopeFile({
      file: versionedFile,
      passphrase: PW,
      db,
      meta: {
        schema: backup.SCHEMA,
        createdAtMs: NOW,
        countsVersion: 2,
        counts: legacyCounts,
        dbSha256: sha256Db(db)
      }
    })
    const versioned = backup.restoreDrill({ backupFile: versionedFile, passphrase: PW })
    assert.strictEqual(versioned.ok, false, '带七项计数版本却缺 favorites 的信封必须拒绝恢复')
    assert.ok(/favorites|计数版本/.test(versioned.error), `新版本缺收藏计数应明确报错，实得：${versioned.error}`)
  }

  // 6) 历史基线兼容：旧 meta.counts 没有 favorites，且旧库只有收藏时，
  //    下一次七项全空仍必须识别为源被清空，不能让旧元数据缺项绕过跨备份回归。
  {
    const dir = tmpdir('legacy-favorite-only-regression')
    const dataFile = path.join(dir, 'db.json')
    const stageDir = path.join(dir, 'backups')
    const priorMs = NOW - 6 * 3600000
    const priorDb = { favorites: [{ id: 'FV-LEGACY-ONLY' }] }
    backup.writeEnvelopeFile({
      file: path.join(stageDir, backup.backupFileName(priorMs)),
      passphrase: PW,
      db: priorDb,
      meta: {
        schema: backup.SCHEMA,
        createdAtMs: priorMs,
        counts: { listings: 0, users: 0, reports: 0, deals: 0, commissionRecords: 0, footprints: 0 },
        dbSha256: sha256Db(priorDb)
      }
    })
    fs.writeFileSync(dataFile, '{}')

    const sink = makeSink()
    const rb = backup.runBackup({
      dataFile,
      stageDir,
      passphrase: PW,
      now: NOW,
      alertSink: sink,
      quiet: true,
      allowLocalOnly: true
    })
    assert.strictEqual(rb.ok, false, '旧备份只有收藏时，本次七项全空也必须判空源回归')
    assert.ok(
      sink.kinds().includes(backup.ALERT_KINDS.BACKUP_EMPTY_SOURCE),
      '旧元数据缺 favorites 时必须从完整旧信封补算收藏，触发 BACKUP_EMPTY_SOURCE'
    )
  }

  // 7) 失败场景三：最近备份超 24 小时 → BACKUP_STALE。
  {
    const dir = tmpdir('stale')
    const stageDir = path.join(dir, 'backups')
    const staleMs = NOW - 25 * 3600000
    const db = sampleDb()
    backup.writeEnvelopeFile({
      file: path.join(stageDir, backup.backupFileName(staleMs)),
      passphrase: PW,
      db,
      meta: { schema: backup.SCHEMA, createdAtMs: staleMs, counts: backup.countCoreCollections(db), dbSha256: sha256Db(db) }
    })

    const sink = makeSink()
    const rd = backup.runRestoreDrill({ dir: stageDir, passphrase: PW, now: NOW, maxAgeHours: 24, alertSink: sink })
    assert.ok(sink.kinds().includes(backup.ALERT_KINDS.BACKUP_STALE), '最近备份超 24h 必须触发 BACKUP_STALE 告警')
    assert.ok(rd.drill && rd.drill.ok, '超期备份的数据本身仍应可正常恢复')

    // 反向：22 小时前的备份不应触发超期告警。
    const dir2 = tmpdir('fresh')
    const stageDir2 = path.join(dir2, 'backups')
    const freshMs = NOW - 22 * 3600000
    backup.writeEnvelopeFile({
      file: path.join(stageDir2, backup.backupFileName(freshMs)),
      passphrase: PW,
      db,
      meta: { schema: backup.SCHEMA, createdAtMs: freshMs, counts: backup.countCoreCollections(db), dbSha256: sha256Db(db) }
    })
    const sink2 = makeSink()
    backup.runRestoreDrill({ dir: stageDir2, passphrase: PW, now: NOW, maxAgeHours: 24, alertSink: sink2 })
    assert.ok(!sink2.kinds().includes(backup.ALERT_KINDS.BACKUP_STALE), '24h 内的备份不应误报超期')
  }

  // 8) 保留策略：保留 30 天内、清理过期、无视非备份命名文件。
  {
    const dir = tmpdir('retention')
    const stageDir = path.join(dir, 'backups')
    fs.mkdirSync(stageDir, { recursive: true })
    const at = (n) => backup.backupFileName(NOW - n * 86400000)
    const fresh1 = at(1)
    const fresh29 = at(29)
    const old31 = at(31)
    const old400 = at(400)
    for (const name of [fresh1, fresh29, old31, old400]) fs.writeFileSync(path.join(stageDir, name), 'x')
    fs.writeFileSync(path.join(stageDir, 'not-a-backup.txt'), 'x')

    const ret = backup.enforceRetention({ dir: stageDir, days: 30, now: NOW })
    assert.deepStrictEqual(ret.removed.slice().sort(), [old31, old400].slice().sort(), '应只清理超过 30 天的备份')
    const remain = fs.readdirSync(stageDir)
    assert.ok(remain.includes(fresh1) && remain.includes(fresh29), '30 天内备份必须保留')
    assert.ok(!remain.includes(old31) && !remain.includes(old400), '过期备份必须被删除')
    assert.ok(remain.includes('not-a-backup.txt'), '非备份命名文件不应被误删')
  }

  // 9) 篡改检测：翻转一个字节，GCM 认证失败 → 演练失败并告警。
  {
    const dir = tmpdir('tamper')
    const stageDir = path.join(dir, 'backups')
    const dataFile = path.join(dir, 'db.json')
    fs.writeFileSync(dataFile, JSON.stringify(sampleDb()))
    const rb = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW, quiet: true, alertSink: () => {}, allowLocalOnly: true })
    const buf = fs.readFileSync(rb.file)
    buf[buf.length - 1] ^= 0xff
    fs.writeFileSync(rb.file, buf)

    const sink = makeSink()
    const rd = backup.runRestoreDrill({ dir: stageDir, passphrase: PW, now: NOW + 1000, alertSink: sink })
    assert.strictEqual(rd.ok, false, '被篡改的备份演练必须失败')
    assert.ok(sink.kinds().includes(backup.ALERT_KINDS.RESTORE_FAILED), '篡改导致解密失败应触发 RESTORE_FAILED 告警')
  }

  // 10) 错误密钥无法解密。
  {
    const dir = tmpdir('wrongkey')
    const stageDir = path.join(dir, 'backups')
    const dataFile = path.join(dir, 'db.json')
    fs.writeFileSync(dataFile, JSON.stringify(sampleDb()))
    const rb = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW, quiet: true, alertSink: () => {}, allowLocalOnly: true })
    const drill = backup.restoreDrill({ backupFile: rb.file, passphrase: 'wrong-key' })
    assert.strictEqual(drill.ok, false, '错误密钥必须无法通过演练')
    assert.ok(/解密失败/.test(drill.error), '错误密钥应报解密失败')
  }

  // 11) 跨备份计数回归：源被清空后，空库备份必须被拦（BACKUP_EMPTY_SOURCE）而非静默判成功。
  {
    const dir = tmpdir('empty-regression')
    const dataFile = path.join(dir, 'db.json')
    const stageDir = path.join(dir, 'backups')
    // 先做一份有数据的正常备份。
    fs.writeFileSync(dataFile, JSON.stringify(sampleDb()))
    const firstSink = makeSink()
    const first = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW - 6 * 3600000, alertSink: firstSink, quiet: true, allowLocalOnly: true })
    assert.ok(first.ok, '首份有数据备份应成功')
    assert.strictEqual(firstSink.alerts.length, 0, '首份备份不应告警')

    // 源被截断成空对象，再次备份。
    fs.writeFileSync(dataFile, '{}')
    const sink = makeSink()
    const rb = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW, alertSink: sink, quiet: true, allowLocalOnly: true })
    assert.strictEqual(rb.ok, false, '源被清空时备份必须判失败，不能静默产出空备份')
    assert.ok(sink.kinds().includes(backup.ALERT_KINDS.BACKUP_EMPTY_SOURCE), '空库回归必须触发 BACKUP_EMPTY_SOURCE 告警')
    // 疑似空备份必须被删除，目录里只剩那份好的。
    const files = fs.readdirSync(stageDir).filter((n) => /\.ygbak$/.test(n))
    assert.strictEqual(files.length, 1, '疑似空备份应被删除，仅保留此前的好备份')

    // 反向：源本就为空（无历史备份）时，不应误触发回归告警。
    const dir2 = tmpdir('empty-fresh')
    const dataFile2 = path.join(dir2, 'db.json')
    fs.writeFileSync(dataFile2, '{}')
    const sink2 = makeSink()
    const rb2 = backup.runBackup({ dataFile: dataFile2, stageDir: path.join(dir2, 'backups'), passphrase: PW, now: NOW, alertSink: sink2, quiet: true, allowLocalOnly: true })
    assert.ok(rb2.ok, '首次备份空库（无历史）应允许，不算回归')
    assert.ok(!sink2.kinds().includes(backup.ALERT_KINDS.BACKUP_EMPTY_SOURCE), '无历史备份时不应误报空源回归')

    // 七项覆盖证明：上一份只有收藏也属于“有数据”，下一份全空必须拦截。
    const dir3 = tmpdir('favorite-only-regression')
    const dataFile3 = path.join(dir3, 'db.json')
    const stageDir3 = path.join(dir3, 'backups')
    fs.writeFileSync(dataFile3, JSON.stringify({ favorites: [{ id: 'FV-ONLY' }] }))
    const firstFavoriteOnly = backup.runBackup({
      dataFile: dataFile3,
      stageDir: stageDir3,
      passphrase: PW,
      now: NOW - 6 * 3600000,
      alertSink: () => {},
      quiet: true,
      allowLocalOnly: true
    })
    assert.ok(firstFavoriteOnly.ok, '仅有收藏关系的首份备份应成功')
    assert.strictEqual(firstFavoriteOnly.meta.counts.favorites, 1, '仅收藏库也必须记入核心计数')
    fs.writeFileSync(dataFile3, '{}')
    const favoriteOnlySink = makeSink()
    const favoriteOnlyEmpty = backup.runBackup({
      dataFile: dataFile3,
      stageDir: stageDir3,
      passphrase: PW,
      now: NOW,
      alertSink: favoriteOnlySink,
      quiet: true,
      allowLocalOnly: true
    })
    assert.strictEqual(favoriteOnlyEmpty.ok, false, '上一份只有收藏时，本次全空仍必须判空源回归')
    assert.ok(
      favoriteOnlySink.kinds().includes(backup.ALERT_KINDS.BACKUP_EMPTY_SOURCE),
      '收藏是唯一非空核心集合时也必须触发 BACKUP_EMPTY_SOURCE'
    )
  }

  // 12) 最新历史基线不可读时不得静默放行新空备份；非空新好备份允许告警自愈。
  {
    const priorDb = sampleDb()
    const priorMs = NOW - 6 * 3600000
    const fixtures = [
      {
        tag: 'old-key',
        write(file) {
          backup.writeEnvelopeFile({
            file,
            passphrase: 'rotated-old-test-key',
            db: priorDb,
            meta: { schema: backup.SCHEMA, countsVersion: 2, createdAtMs: priorMs, counts: backup.countCoreCollections(priorDb), dbSha256: sha256Db(priorDb) }
          })
        }
      },
      {
        tag: 'tampered',
        write(file) {
          backup.writeEnvelopeFile({
            file,
            passphrase: PW,
            db: priorDb,
            meta: { schema: backup.SCHEMA, countsVersion: 2, createdAtMs: priorMs, counts: backup.countCoreCollections(priorDb), dbSha256: sha256Db(priorDb) }
          })
          const bytes = fs.readFileSync(file)
          bytes[bytes.length - 1] ^= 0xff
          fs.writeFileSync(file, bytes)
        }
      },
      {
        tag: 'bad-sha',
        write(file) {
          backup.writeEnvelopeFile({
            file,
            passphrase: PW,
            db: priorDb,
            meta: { schema: backup.SCHEMA, countsVersion: 2, createdAtMs: priorMs, counts: backup.countCoreCollections(priorDb), dbSha256: '0'.repeat(64) }
          })
        }
      }
    ]

    for (const fixture of fixtures) {
      const dir = tmpdir(`baseline-${fixture.tag}`)
      const stageDir = path.join(dir, 'backups')
      const dataFile = path.join(dir, 'db.json')
      const priorFile = path.join(stageDir, backup.backupFileName(priorMs))
      fixture.write(priorFile)
      fs.writeFileSync(dataFile, '{}')
      const sink = makeSink()
      let uploads = 0
      const rb = backup.runBackup({
        dataFile,
        stageDir,
        passphrase: PW,
        now: NOW,
        remoteCmd: 'mock-upload',
        exec: () => { uploads += 1 },
        alertSink: sink,
        quiet: true
      })
      assert.strictEqual(rb.ok, false, `${fixture.tag}：最新历史基线不可读且本次全空时必须失败`)
      assert.strictEqual(rb.file, null, `${fixture.tag}：不可信的新空备份必须删除`)
      assert.strictEqual(rb.remoteUploaded, false, `${fixture.tag}：不得标记异地上传成功`)
      assert.strictEqual(uploads, 0, `${fixture.tag}：必须在远端上传前阻断`)
      assert.ok(sink.kinds().includes(backup.ALERT_KINDS.BACKUP_BASELINE_UNREADABLE), `${fixture.tag}：必须触发独立基线不可读告警`)
      assert.strictEqual(fs.readdirSync(stageDir).filter((name) => /\.ygbak$/.test(name)).length, 1, `${fixture.tag}：只保留原历史文件供排查`)
    }

    // 兼容密钥轮换自愈：旧基线不可读但本次源明确非空时，必须告警，同时允许上传已自检的新好备份。
    const dir = tmpdir('baseline-unreadable-nonempty')
    const stageDir = path.join(dir, 'backups')
    const dataFile = path.join(dir, 'db.json')
    const priorFile = path.join(stageDir, backup.backupFileName(priorMs))
    backup.writeEnvelopeFile({
      file: priorFile,
      passphrase: 'rotated-old-test-key',
      db: priorDb,
      meta: { schema: backup.SCHEMA, countsVersion: 2, createdAtMs: priorMs, counts: backup.countCoreCollections(priorDb), dbSha256: sha256Db(priorDb) }
    })
    fs.writeFileSync(dataFile, JSON.stringify(sampleDb()))
    const sink = makeSink()
    let uploads = 0
    const rb = backup.runBackup({
      dataFile,
      stageDir,
      passphrase: PW,
      now: NOW,
      remoteCmd: 'mock-upload',
      exec: () => { uploads += 1 },
      alertSink: sink,
      quiet: true
    })
    assert.ok(rb.ok, '旧基线不可读但本次明确非空时，应允许新密钥链自愈')
    assert.strictEqual(uploads, 1, '非空新好备份仍应完成异地上传')
    assert.ok(sink.kinds().includes(backup.ALERT_KINDS.BACKUP_BASELINE_UNREADABLE), '兼容自愈也必须告警，不能静默')
  }

  // 13) 文件名时间戳越界必须判非法（防未来时间戳抑制超期告警 / 逃过保留清理）。
  {
    assert.strictEqual(backup.parseBackupTimeMs('db-backup-20260706T120000Z.ygbak'), NOW, '合法文件名应解析出正确时间')
    for (const bad of ['db-backup-20261306T000000Z.ygbak', 'db-backup-20260740T000000Z.ygbak', 'db-backup-20260706T256199Z.ygbak']) {
      assert.strictEqual(backup.parseBackupTimeMs(bad), null, `越界文件名必须判非法：${bad}`)
    }
    // listBackups 必须把越界文件名挡在外面。
    const dir = tmpdir('badname')
    const stageDir = path.join(dir, 'backups')
    fs.mkdirSync(stageDir, { recursive: true })
    fs.writeFileSync(path.join(stageDir, 'db-backup-20261306T000000Z.ygbak'), 'x') // 月13
    fs.writeFileSync(path.join(stageDir, backup.backupFileName(NOW)), 'x') // 合法
    const listed = backup.listBackups(stageDir).map((b) => b.name)
    assert.strictEqual(listed.length, 1, 'listBackups 应忽略越界文件名')
    assert.ok(listed[0] === backup.backupFileName(NOW), '只保留合法命名的备份')
  }

  // 14) 恢复演练不残留明文：未传 tempDir 时自建临时目录用完即清；传入时才保留产物。
  {
    const dir = tmpdir('cleanup')
    const stageDir = path.join(dir, 'backups')
    const dataFile = path.join(dir, 'db.json')
    fs.writeFileSync(dataFile, JSON.stringify(sampleDb()))
    const rb = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW, quiet: true, alertSink: () => {}, allowLocalOnly: true })

    const countDrillTmp = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ynzy-restore-drill-')).length
    const before = countDrillTmp()
    const drill = backup.restoreDrill({ backupFile: rb.file, passphrase: PW })
    assert.ok(drill.ok, '演练应成功')
    assert.strictEqual(drill.restoredPath, null, '自建临时目录用完即清，restoredPath 不对外暴露')
    assert.strictEqual(countDrillTmp(), before, '纯演练不得在系统临时目录残留解密产物')

    // 传入 tempDir（真恢复取数）时保留产物，且路径可用。
    const outDir = path.join(dir, 'out')
    const drill2 = backup.restoreDrill({ backupFile: rb.file, passphrase: PW, tempDir: outDir })
    assert.ok(drill2.ok && drill2.restoredPath, '传入 tempDir 时应保留 restoredPath')
    assert.ok(fs.existsSync(drill2.restoredPath), '传入 tempDir 时解密产物应存在，供人工恢复')
  }

  // 15) 异地目标门禁：默认缺 BACKUP_REMOTE_CMD 必须失败；只有显式 allowLocalOnly 才允许仅本地成功。
  {
    const mk = (tag) => {
      const dir = tmpdir(tag)
      const dataFile = path.join(dir, 'db.json')
      fs.writeFileSync(dataFile, JSON.stringify(sampleDb()))
      return { dir, dataFile, stageDir: path.join(dir, 'backups') }
    }

    // (a) 缺 remoteCmd 且未 allowLocalOnly → 必须失败并告警 BACKUP_REMOTE_REQUIRED。
    {
      const { dataFile, stageDir } = mk('remote-required')
      const sink = makeSink()
      const rb = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW, alertSink: sink, quiet: true })
      assert.strictEqual(rb.ok, false, '缺异地目标且未显式允许仅本地时，备份必须判失败（不能谎报成功）')
      assert.ok(sink.kinds().includes(backup.ALERT_KINDS.BACKUP_REMOTE_REQUIRED), '缺异地目标必须触发 BACKUP_REMOTE_REQUIRED 告警')
      assert.strictEqual(rb.remoteUploaded, false, '未配置异地目标不应标记已上传')
      // 本地加密备份已通过自检+回归，是可信文件，应保留（只是未达成异地）。
      assert.strictEqual(fs.readdirSync(stageDir).filter((n) => /\.ygbak$/.test(n)).length, 1, '未达成异地时仍应保留本地可信备份')
    }

    // (b) 缺 remoteCmd 但显式 allowLocalOnly=true → 允许成功，不报 BACKUP_REMOTE_REQUIRED。
    {
      const { dataFile, stageDir } = mk('local-only')
      const sink = makeSink()
      const rb = backup.runBackup({ dataFile, stageDir, passphrase: PW, now: NOW, alertSink: sink, quiet: true, allowLocalOnly: true })
      assert.ok(rb.ok, '显式 allowLocalOnly 时仅本地备份应允许成功')
      assert.ok(!sink.kinds().includes(backup.ALERT_KINDS.BACKUP_REMOTE_REQUIRED), '显式允许仅本地时不应报 BACKUP_REMOTE_REQUIRED')
    }

    // (c) 配置 remoteCmd 且上传成功（注入 exec）→ 成功、标记已上传、命令收到 BACKUP_FILE。
    {
      const { dataFile, stageDir } = mk('remote-ok')
      const sink = makeSink()
      let gotEnv = null
      const rb = backup.runBackup({
        dataFile, stageDir, passphrase: PW, now: NOW, alertSink: sink, quiet: true,
        remoteCmd: 'upload $BACKUP_FILE',
        exec: (cmd, env) => { gotEnv = env }
      })
      assert.ok(rb.ok, '配置异地目标且上传成功时应成功')
      assert.strictEqual(rb.remoteUploaded, true, '上传成功应标记 remoteUploaded')
      assert.strictEqual(sink.alerts.length, 0, '异地上传成功不应有告警')
      assert.ok(gotEnv && gotEnv.BACKUP_FILE === rb.file, '上传命令应通过环境变量收到 BACKUP_FILE 完整路径')
    }

    // (d) 配置 remoteCmd 但上传失败（exec 抛错）→ 失败并告警 REMOTE_UPLOAD_FAILED。
    {
      const { dataFile, stageDir } = mk('remote-fail')
      const sink = makeSink()
      const rb = backup.runBackup({
        dataFile, stageDir, passphrase: PW, now: NOW, alertSink: sink, quiet: true,
        remoteCmd: 'upload $BACKUP_FILE',
        exec: () => { const error = new Error('scp: customer payload refused'); error.code = 'EACCES'; throw error }
      })
      assert.strictEqual(rb.ok, false, '异地上传失败时备份必须判失败')
      assert.ok(sink.kinds().includes(backup.ALERT_KINDS.REMOTE_UPLOAD_FAILED), '异地上传失败必须触发 REMOTE_UPLOAD_FAILED 告警')
      const remoteAlert = sink.alerts.find((item) => item.kind === backup.ALERT_KINDS.REMOTE_UPLOAD_FAILED)
      assert.strictEqual(remoteAlert.detail.errorCode, 'EACCES', '异地上传必须单独透传安全系统错误码，不依赖自由错误正文')
      assert.match(remoteAlert.eventId, /^AL-[A-F0-9]{16}$/, '备份告警必须在事件源生成稳定脱敏编号')
    }
  }

  console.log('backup-restore-v1-test passed')
}

run()
