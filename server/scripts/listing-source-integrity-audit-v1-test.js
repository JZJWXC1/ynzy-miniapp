const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const audit = require('./listing-source-integrity-audit')

function runCli(dbPath) {
  return spawnSync(process.execPath, [path.join(__dirname, 'listing-source-integrity-audit.js'), '--db', dbPath], {
    encoding: 'utf8'
  })
}

function run() {
  const cleanDb = {
    listings: [
      { id: 'SAFE-COMPANY', source: '公司房源', companyListing: true, isCompanyListing: true },
      { id: 'SAFE-OWNER', source: '业主房源', ownerType: '业主房源', companyListing: 'false', isCompanyListing: '0' }
    ]
  }
  assert.deepStrictEqual(audit.sourceIntegritySummary(cleanDb), {
    totalListings: 2,
    ambiguousFalseFlagCompanySource: 0
  }, '正常公司与合作房源不得触发旧误固化告警')
  assert.throws(
    () => audit.sourceIntegritySummary({ listings: {} }),
    /listings 必须为数组/,
    'JSON 可读但 listings 结构损坏时不得静默当成 0 套'
  )

  const ambiguousDb = {
    listings: [
      ...cleanDb.listings,
      {
        id: 'DO-NOT-PRINT-THIS-ID',
        source: '公司房源',
        ownerType: '公司房源',
        houseSourceType: '公司房源',
        companyListing: 'false',
        isCompanyListing: '0',
        landlordPhone: '19900000000'
      },
      {
        id: 'OLD-MIGRATION-CAN-ADD-TRUE',
        source: '公司房源',
        companyListing: 'false',
        isCompanyListing: true
      },
      {
        id: 'UNKNOWN-NONEMPTY-FLAG',
        source: '公司房源',
        companyListing: 'off'
      },
      {
        id: 'WHITESPACE-OLD-TRUTHY-FLAG',
        source: '公司房源',
        companyListing: ' '
      }
    ]
  }
  assert.deepStrictEqual(audit.sourceIntegritySummary(ambiguousDb), {
    totalListings: 6,
    ambiguousFalseFlagCompanySource: 4
  }, '显式假值或旧逻辑会误认的未知/空白非空值与 canonical 公司来源冲突时都必须标记为不可自动裁决')

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-source-audit-'))
  try {
    const cleanPath = path.join(tempRoot, 'clean.json')
    const ambiguousPath = path.join(tempRoot, 'ambiguous.json')
    const invalidStructurePath = path.join(tempRoot, 'invalid-structure.json')
    fs.writeFileSync(cleanPath, JSON.stringify(cleanDb), 'utf8')
    fs.writeFileSync(ambiguousPath, JSON.stringify(ambiguousDb), 'utf8')
    fs.writeFileSync(invalidStructurePath, JSON.stringify({ listings: {} }), 'utf8')

    const cleanRun = runCli(cleanPath)
    assert.strictEqual(cleanRun.status, 0, cleanRun.stderr || '干净数据审计必须通过')
    assert.deepStrictEqual(JSON.parse(cleanRun.stdout), {
      ok: true,
      dataFileFound: true,
      readable: true,
      totalListings: 2,
      ambiguousFalseFlagCompanySource: 0
    })

    const ambiguousRun = runCli(ambiguousPath)
    assert.strictEqual(ambiguousRun.status, 2, '可疑旧误固化签名必须阻断发布')
    const ambiguousOutput = JSON.parse(ambiguousRun.stdout)
    assert.strictEqual(ambiguousOutput.ok, false)
    assert.strictEqual(ambiguousOutput.ambiguousFalseFlagCompanySource, 4)
    assert.ok(!ambiguousRun.stdout.includes('DO-NOT-PRINT-THIS-ID'), '审计输出不得泄露房源 ID')
    assert.ok(!ambiguousRun.stdout.includes('19900000000'), '审计输出不得泄露电话')

    const invalidStructureRun = runCli(invalidStructurePath)
    assert.strictEqual(invalidStructureRun.status, 2, 'listings 非数组时必须阻断发布')
    assert.strictEqual(JSON.parse(invalidStructureRun.stdout).ok, false)
    assert.strictEqual(JSON.parse(invalidStructureRun.stdout).readable, false)

    const missingRun = runCli(path.join(tempRoot, 'missing.json'))
    assert.strictEqual(missingRun.status, 2, '缺少数据文件时不能伪造审计通过')
    assert.deepStrictEqual(JSON.parse(missingRun.stdout), {
      ok: false,
      dataFileFound: false,
      readable: false,
      totalListings: 0,
      ambiguousFalseFlagCompanySource: 0
    })
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  console.log('listing-source-integrity-audit-v1-test passed')
}

run()
