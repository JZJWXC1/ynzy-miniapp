const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const migration = require('./migrate-listing-landlord-commission-v1')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-m1-commission-'))
  try {
    const dataFile = path.join(tempDir, 'db.json')
    const original = {
      users: [{ id: 'U1' }],
      listings: [
        { id: 'L1', commissionRate: 20 },
        { id: 'L2', commissionRate: 0, landlordCommissionPercent: 0 },
        { id: 'L3', commissionRate: 12, landlordCommissionPercent: 88 },
        { id: 'L4', commissionRate: 20, landlordCommissionPercent: '' }
      ],
      footprints: []
    }
    fs.writeFileSync(dataFile, JSON.stringify(original), 'utf8')

    const preview = migration.migrateFile({ dataFile, apply: false, now: '2026-07-11T10:00:00.000Z' })
    assert.deepStrictEqual(
      { total: preview.total, missing: preview.missing, changed: preview.changed, coverage: preview.coverage },
      { total: 4, missing: 2, changed: 0, coverage: 50 },
      'dry-run 只报告缺失量和现有覆盖率'
    )
    assert.deepStrictEqual(readJson(dataFile), original, '默认 dry-run 不得写库')
    assert.strictEqual(preview.backupFile, '', 'dry-run 不生成伪备份')

    const applied = migration.migrateFile({ dataFile, apply: true, now: '2026-07-11T10:00:00.000Z' })
    assert.strictEqual(applied.total, 4)
    assert.strictEqual(applied.changed, 2)
    assert.strictEqual(applied.coverage, 100)
    assert.ok(applied.backupFile && fs.existsSync(applied.backupFile), 'apply 前必须生成可回滚备份')
    const migrated = readJson(dataFile)
    assert.strictEqual(migrated.listings.length, original.listings.length, '迁移前后房源总数不能变化')
    assert.deepStrictEqual(migrated.listings.map((item) => item.landlordCommissionPercent), [50, 0, 88, 50])
    assert.deepStrictEqual(migrated.listings.map((item) => item.commissionRate), [20, 0, 12, 20], '旧 commissionRate 必须原样保留')

    const second = migration.migrateFile({ dataFile, apply: true, now: '2026-07-11T10:01:00.000Z' })
    assert.strictEqual(second.changed, 0, '重复 apply 必须幂等')
    assert.strictEqual(second.backupFile, '', '无变化时不重复制造备份')

    const rolledBack = migration.rollbackFile({ dataFile, backupFile: applied.backupFile })
    assert.strictEqual(rolledBack.total, 4)
    assert.deepStrictEqual(readJson(dataFile), original, 'rollback 必须恢复迁移前结构')

    const invalidFile = path.join(tempDir, 'invalid.json')
    fs.writeFileSync(invalidFile, JSON.stringify({ listings: [{ id: 'BAD', landlordCommissionPercent: 101 }] }), 'utf8')
    assert.throws(
      () => migration.migrateFile({ dataFile: invalidFile, apply: true }),
      /存在非法.*landlordCommissionPercent/,
      '非法存量值必须 fail-loud，不能静默覆盖'
    )
    assert.strictEqual(readJson(invalidFile).listings[0].landlordCommissionPercent, 101, '校验失败不得写库')

    const malformedFile = path.join(tempDir, 'malformed.json')
    const malformedText = JSON.stringify({ listings: [null] })
    fs.writeFileSync(malformedFile, malformedText, 'utf8')
    assert.throws(
      () => migration.migrateFile({ dataFile: malformedFile, apply: true }),
      /存在非法.*landlordCommissionPercent/,
      '非对象房源项必须在备份和写盘前失败'
    )
    assert.strictEqual(fs.readFileSync(malformedFile, 'utf8'), malformedText, '结构异常不得改写磁盘')

    const nonArrayFile = path.join(tempDir, 'non-array.json')
    const nonArrayText = JSON.stringify({ listings: {} })
    fs.writeFileSync(nonArrayFile, nonArrayText, 'utf8')
    assert.throws(
      () => migration.migrateFile({ dataFile: nonArrayFile, apply: true }),
      /listings 必须是数组/,
      'listings 非数组必须 fail-loud'
    )
    assert.strictEqual(fs.readFileSync(nonArrayFile, 'utf8'), nonArrayText, 'listings 非数组不得改写磁盘')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  console.log('listing-landlord-commission-migration-v1-test passed')
}

run()
