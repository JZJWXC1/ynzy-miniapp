'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const config = require('../src/config')
const feishuSync = require('../src/feishu-sync')
const noteMaterial = require('../src/feishu-note-material-sync')

const HOST = 'tenant.example'
const TARGET_ROOT = 'fldTargetRoot123456'
const FIXED_NOW_MS = Date.UTC(2026, 6, 27, 1, 2, 3)
const FIXED_RUN_ID = 'confirmation-test-run'
const EMPLOYEE_PROFILE = 'employee-current-stock-v1'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function listing(sourceRecordId) {
  return {
    id: `listing-${sourceRecordId}`,
    feishuRecordId: sourceRecordId,
    status: '上架',
    lifecycleStatus: 'active',
    companyListing: true,
    isCompanyListing: true,
    source: '公司房源',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    title: '合成公开房源',
    district: '合成区',
    block: '合成板块',
    area: '合成板块',
    locationId: `LOC-${sourceRecordId}`,
    community: '合成小区',
    building: '1幢',
    unit: '1单元',
    roomNumber: '101',
    rent: 3000,
    layout: '2室1厅',
    room: '两室',
    rentMode: '整租',
    type: '整租',
    mediaAssets: [],
    videoKey: ''
  }
}

function downloadEvidence(body, mimeType = 'video/mp4') {
  const buffer = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body))
  return {
    buffer,
    contentSha256: sha256(buffer),
    size: buffer.length,
    contentType: mimeType
  }
}

function inventoryFixture(options = {}) {
  const records = options.records || [{
    sourceRecordId: 'source-record-confirm-alpha',
    folderToken: 'folderSourceConfirmAlpha123',
    assetToken: 'tokenVideoConfirmAlpha123',
    body: Buffer.from('confirmation-alpha-v1'),
    mimeType: 'video/mp4'
  }]
  const byFolder = new Map(records.map((record) => [record.folderToken, record]))
  const byAsset = new Map(records.map((record) => [record.assetToken, record]))
  const db = { users: [], listings: records.map((record) => listing(record.sourceRecordId)) }
  const calls = {
    list: 0,
    download: 0,
    folderWrite: 0,
    driveWrite: 0,
    ossWrite: 0,
    dbWrite: 0
  }
  const downloadCounts = new Map()
  const drive = {
    async listFolder(folderToken) {
      calls.list += 1
      const record = byFolder.get(folderToken)
      if (!record) throw new Error('合成目录不存在')
      return [{
        token: record.assetToken,
        name: record.name || `${record.assetToken}.mp4`,
        type: record.mimeType,
        size: record.body.length,
        modifiedTime: '1'
      }]
    },
    async downloadToken(assetToken) {
      calls.download += 1
      const record = byAsset.get(assetToken)
      if (!record) throw new Error('合成素材不存在')
      const count = (downloadCounts.get(assetToken) || 0) + 1
      downloadCounts.set(assetToken, count)
      const body = typeof options.bodyForDownload === 'function'
        ? options.bodyForDownload(record, count)
        : record.body
      return downloadEvidence(body, record.mimeType)
    },
    async ensureListingFolder(input) {
      calls.folderWrite += 1
      return { token: `target-folder-${sha256(input.sourceRecordId).slice(0, 12)}` }
    },
    async materializeVideo(input) {
      calls.driveWrite += 1
      return {
        targetToken: `target-file-${sha256(input.asset.sourceToken).slice(0, 12)}`,
        targetName: input.targetName,
        buffer: input.sourceEvidence.buffer,
        contentSha256: input.sourceEvidence.contentSha256,
        contentType: input.sourceEvidence.contentType,
        size: input.sourceEvidence.size,
        verified: true
      }
    }
  }
  const oss = {
    async putVideoDeterministic(input) {
      calls.ossWrite += 1
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    }
  }
  return {
    records,
    db,
    calls,
    drive,
    oss,
    sourceRows: records.map((record) => ({
      sourceRecordId: record.sourceRecordId,
      value: `https://${HOST}/drive/folder/${record.folderToken}`
    }))
  }
}

function writeCount(calls) {
  return calls.folderWrite + calls.driveWrite + calls.ossWrite + calls.dbWrite
}

async function runInventory(fixture, options = {}) {
  return noteMaterial.syncNoteMaterialsForInventory({
    db: fixture.db,
    sourceRows: fixture.sourceRows,
    allowedHosts: [HOST],
    targetRootFolderToken: TARGET_ROOT,
    uploadDir: 'house-videos',
    drive: fixture.drive,
    oss: fixture.oss,
    dryRun: options.dryRun === true,
    nowText: '2026-07-27T01:02:03.000Z',
    contentPlanConfirmationRequired: options.contentPlanConfirmationRequired === true,
    expectedContentPlanSha256: options.expectedContentPlanSha256,
    expectedContentAssetCount: options.expectedContentAssetCount,
    expectedContentPlanEvidence: options.expectedContentPlanEvidence,
    mediaAssetsStateKey: (current) => sha256(JSON.stringify(current.mediaAssets || [])),
    replaceMediaAssets: async (current, mediaAssets) => {
      fixture.calls.dbWrite += 1
      current.mediaAssets = clone(mediaAssets)
      current.videoKey = mediaAssets[0] ? mediaAssets[0].objectKey : ''
    }
  })
}

function confirmationFromReport(report) {
  return noteMaterial._internal.contentPlanConfirmationFromReport(report)
}

function assertConfirmationError(error, message) {
  assert.ok(error instanceof Error, message)
  assert.ok([400, 409, 412].includes(Number(error.statusCode)), `${message}：必须给出可分类的 4xx 状态`)
  assert.ok(/内容计划|确认|content/i.test(error.message), `${message}：错误必须明确指向内容计划确认`)
  return true
}

function restoreObject(target, snapshot) {
  Object.keys(target).forEach((key) => delete target[key])
  Object.assign(target, snapshot)
}

function fieldBinding(fieldId, type, required) {
  return { fieldId, type, required }
}

function e2eMirrorBindings() {
  return {
    source: {
      community: fieldBinding('src-community', 1, true),
      roomLabel: fieldBinding('src-room-label', 1, true),
      layoutDescription: fieldBinding('src-layout', 1, true),
      layoutCategory: fieldBinding('src-layout-category', 1, false),
      monthlyRent: fieldBinding('src-rent', 2, true),
      viewingMethod: fieldBinding('src-viewing-method', 1, false),
      remark: fieldBinding('src-remark', 1, false)
    },
    mini: {
      sourceRecordId: fieldBinding('mini-source-record', 1, true),
      locationId: fieldBinding('mini-location-id', 1, true),
      locationRecordId: fieldBinding('mini-location-record', 1, true),
      city: fieldBinding('mini-city', 1, true),
      district: fieldBinding('mini-district', 1, true),
      block: fieldBinding('mini-block', 1, true),
      community: fieldBinding('mini-community', 1, true),
      latitude: fieldBinding('mini-latitude', 2, true),
      longitude: fieldBinding('mini-longitude', 2, true),
      roomLabel: fieldBinding('mini-room-label', 1, true),
      building: fieldBinding('mini-building', 1, true),
      unit: fieldBinding('mini-unit', 1, false),
      roomNumber: fieldBinding('mini-room-number', 1, true),
      layoutDescription: fieldBinding('mini-layout', 1, true),
      layoutCategory: fieldBinding('mini-layout-category', 1, true),
      monthlyRent: fieldBinding('mini-rent', 2, true),
      rentMode: fieldBinding('mini-rent-mode', 1, true),
      viewingMethod: fieldBinding('mini-viewing-method', 1, false),
      viewingPassword: fieldBinding('mini-viewing-password', 1, false),
      remark: fieldBinding('mini-remark', 1, false),
      listingStatus: fieldBinding('mini-status', 1, true),
      published: fieldBinding('mini-published', 7, true),
      canonical: fieldBinding('mini-canonical', 7, true),
      enabled: fieldBinding('mini-enabled', 7, true)
    },
    location: {
      locationId: fieldBinding('loc-id', 1, true),
      city: fieldBinding('loc-city', 1, true),
      district: fieldBinding('loc-district', 1, true),
      block: fieldBinding('loc-block', 1, true),
      community: fieldBinding('loc-community', 1, true),
      latitude: fieldBinding('loc-latitude', 2, true),
      longitude: fieldBinding('loc-longitude', 2, true),
      enabled: fieldBinding('loc-enabled', 7, true)
    }
  }
}

function e2eSnapshot(records, fieldNames = {}) {
  return {
    complete: true,
    records: clone(records),
    recordCount: records.length,
    digest: sha256(JSON.stringify(records)),
    schemaFingerprint: sha256(JSON.stringify(fieldNames)),
    fieldNames: clone(fieldNames)
  }
}

function e2eMirrorFieldNames() {
  return [
    'sourceRecordId', 'locationId', 'locationRecordId', 'city', 'district', 'block',
    'community', 'latitude', 'longitude', 'roomLabel', 'building', 'unit', 'roomNumber',
    'layoutDescription', 'layoutCategory', 'monthlyRent', 'rentMode', 'viewingMethod',
    'viewingPassword', 'remark', 'listingStatus', 'published', 'canonical', 'enabled'
  ].reduce((result, semantic) => {
    result[semantic] = semantic
    return result
  }, {})
}

function e2eSourceRecords(records) {
  return records.map((record, index) => ({
    recordId: record.sourceRecordId,
    fields: {
      community: '风雅乐府',
      roomLabel: `风雅乐府 1幢1单元${101 + index}`,
      layoutDescription: '2室1厅（整）',
      layoutCategory: '两室',
      monthlyRent: 3200 + index * 100,
      viewingMethod: '',
      remark: '',
      noteMaterialLink: `https://${HOST}/drive/folder/${record.folderToken}`
    }
  }))
}

function e2eLocationSnapshot() {
  return e2eSnapshot([{
    recordId: 'location-record-fengya',
    fields: {
      locationId: 'LOC-FENGYA',
      city: '杭州市',
      district: '余杭区',
      block: '城北万象城',
      community: '风雅乐府',
      latitude: 30.345286,
      longitude: 120.121984,
      aliases: ['风雅乐府小区'],
      enabled: true
    }
  }])
}

function e2eSyncFixture(options = {}) {
  const inventory = inventoryFixture(options)
  const sourceRecords = e2eSourceRecords(inventory.records)
  let mirrorRecords = []
  const baseCalls = []
  const driveWritesBySourceRecord = new Map()
  const targetFolderOwners = new Map()
  const sourceClient = {
    async readValidatedTableSnapshot(readOptions) {
      baseCalls.push({ client: 'source', action: 'read', tableId: readOptions.tableId })
      assert.strictEqual(readOptions.tableId, 'tbl-source-confirmation')
      return e2eSnapshot(sourceRecords)
    },
    async batchCreateRecords() {
      baseCalls.push({ client: 'source', action: 'create' })
      throw new Error('员工源 Base 必须保持只读')
    },
    async batchUpdateRecords() {
      baseCalls.push({ client: 'source', action: 'update' })
      throw new Error('员工源 Base 必须保持只读')
    },
    async batchDeleteRecords() {
      baseCalls.push({ client: 'source', action: 'delete' })
      throw new Error('员工源 Base 必须保持只读')
    }
  }
  const targetClient = {
    async readValidatedTableSnapshot(readOptions) {
      baseCalls.push({ client: 'target', action: 'read', tableId: readOptions.tableId })
      if (readOptions.tableId === 'tbl-location-confirmation') return e2eLocationSnapshot()
      assert.strictEqual(readOptions.tableId, 'tbl-mini-confirmation')
      return e2eSnapshot(mirrorRecords, e2eMirrorFieldNames())
    },
    async batchCreateRecords(tableId, records) {
      baseCalls.push({ client: 'target', action: 'create', tableId, count: records.length })
      assert.strictEqual(tableId, 'tbl-mini-confirmation')
      const created = records.map((record, index) => ({
        recordId: `mirror-record-${mirrorRecords.length + index + 1}`,
        fields: clone(record.fields)
      }))
      mirrorRecords.push(...created)
      return { records: clone(created) }
    },
    async batchUpdateRecords(tableId, records) {
      baseCalls.push({ client: 'target', action: 'update', tableId, count: records.length })
      assert.strictEqual(tableId, 'tbl-mini-confirmation')
      const byId = new Map(mirrorRecords.map((record) => [record.recordId, record]))
      records.forEach((record) => {
        const existing = byId.get(record.record_id)
        assert.ok(existing, `目标专用表更新必须命中已有记录：${record.record_id}`)
        Object.assign(existing.fields, clone(record.fields))
      })
      return { records: clone(records) }
    }
  }
  const originalEnsureListingFolder = inventory.drive.ensureListingFolder
  inventory.drive.ensureListingFolder = async (input) => {
    const result = await originalEnsureListingFolder(input)
    targetFolderOwners.set(result.token, input.sourceRecordId)
    return result
  }
  const originalMaterializeVideo = inventory.drive.materializeVideo
  inventory.drive.materializeVideo = async (input) => {
    const sourceRecordId = targetFolderOwners.get(input.targetFolderToken) || ''
    driveWritesBySourceRecord.set(
      sourceRecordId,
      (driveWritesBySourceRecord.get(sourceRecordId) || 0) + 1
    )
    return originalMaterializeVideo(input)
  }
  inventory.db = {
    users: [{ id: 'A-CONFIRM', name: '合成管理员', role: '管理员', isAdmin: true }],
    listings: []
  }
  return {
    ...inventory,
    sourceClient,
    targetClient,
    baseCalls,
    driveWritesBySourceRecord,
    getMirrorRecords: () => clone(mirrorRecords)
  }
}

function configureE2eSync() {
  const bindings = e2eMirrorBindings()
  Object.assign(config.feishu, {
    appId: 'synthetic-confirmation-app',
    appSecret: 'synthetic-confirmation-secret',
    syncEnabled: true,
    mirrorSyncEnabled: true,
    noteMaterialSyncEnabled: true,
    sourceCompatibilityProfile: EMPLOYEE_PROFILE,
    sourceBitableAppToken: 'source-base-confirmation',
    targetBitableAppToken: 'target-base-confirmation',
    crossBaseTokenPartial: false,
    sourceTableId: 'tbl-source-confirmation',
    miniTableId: 'tbl-mini-confirmation',
    locationTableId: 'tbl-location-confirmation',
    sourceFieldBindings: bindings.source,
    miniFieldBindings: bindings.mini,
    locationFieldBindings: bindings.location,
    folderToken: 'legacy-material-root-confirmation',
    materialsFile: '',
    noteMaterialFieldId: 'fldyeAGJHV',
    noteMaterialAllowedHosts: [HOST],
    noteMaterialTargetRootFolderToken: TARGET_ROOT,
    noteMaterialMaxDepth: 4,
    noteMaterialMaxItems: 100
  })
}

function e2eSyncOptions(fixture, options = {}) {
  return {
    sourceClient: fixture.sourceClient,
    targetClient: fixture.targetClient,
    noteMaterialDrive: fixture.drive,
    noteMaterialOss: fixture.oss,
    materials: [],
    feishuToken: 'synthetic-confirmation-tenant-token',
    runId: options.runId || FIXED_RUN_ID,
    nowMs: options.nowMs || FIXED_NOW_MS,
    dryRun: options.dryRun === true,
    ...(options.expectedContentPlanSha256
      ? {
          expectedContentPlanSha256: options.expectedContentPlanSha256,
          expectedContentAssetCount: options.expectedContentAssetCount
        }
      : {})
  }
}

function targetBaseWriteCount(fixture) {
  return fixture.baseCalls.filter((call) => (
    call.client === 'target' && ['create', 'update', 'delete'].includes(call.action)
  )).length
}

function loadFeishuSyncWithFormalSummaryDrift() {
  const Module = require('module')
  const feishuSyncPath = require.resolve('../src/feishu-sync')
  const originalCacheEntry = require.cache[feishuSyncPath]
  const originalLoad = Module._load
  delete require.cache[feishuSyncPath]
  try {
    Module._load = function (request, parent, isMain) {
      if (request === './feishu-note-material-sync' &&
          parent && parent.filename === feishuSyncPath) {
        return {
          ...noteMaterial,
          async syncNoteMaterialsForInventory(input) {
            const result = await noteMaterial.syncNoteMaterialsForInventory(input)
            if (input && input.dryRun !== true &&
                input.contentPlanConfirmationRequired === true &&
                result && result.complete === true) {
              return { ...result, contentPlanSha256: 'f'.repeat(64) }
            }
            return result
          }
        }
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    return require('../src/feishu-sync')
  } finally {
    Module._load = originalLoad
    if (originalCacheEntry) require.cache[feishuSyncPath] = originalCacheEntry
    else delete require.cache[feishuSyncPath]
  }
}

async function testParserAndScheduledGate() {
  assert.strictEqual(
    typeof feishuSync.parseAdminSyncRequest,
    'function',
    '必须提供后台同步请求的统一确认字段校验器'
  )
  const expectedHash = 'a'.repeat(64)
  assert.deepStrictEqual(
    feishuSync.parseAdminSyncRequest({ dryRun: true }, { contentPlanConfirmationRequired: true }),
    { dryRun: true },
    'dry-run 不要求 expected 确认字段'
  )
  assert.deepStrictEqual(
    feishuSync.parseAdminSyncRequest({
      dryRun: false,
      expectedContentPlanSha256: expectedHash,
      expectedContentAssetCount: 0
    }, { contentPlanConfirmationRequired: true }),
    {
      dryRun: false,
      expectedContentPlanSha256: expectedHash,
      expectedContentAssetCount: 0
    },
    '正式同步必须精确保留合法小写摘要与安全整数数量'
  )
  assert.deepStrictEqual(
    feishuSync.parseAdminSyncRequest({ dryRun: false }, { contentPlanConfirmationRequired: false }),
    { dryRun: false },
    '素材确认门未启用时不得扩大旧正式同步请求契约'
  )

  const invalidBodies = [
    {},
    { dryRun: false, expectedContentPlanSha256: expectedHash },
    { dryRun: false, expectedContentAssetCount: 1 },
    { dryRun: false, expectedContentPlanSha256: 123, expectedContentAssetCount: 1 },
    { dryRun: false, expectedContentPlanSha256: expectedHash.toUpperCase(), expectedContentAssetCount: 1 },
    { dryRun: false, expectedContentPlanSha256: 'g'.repeat(64), expectedContentAssetCount: 1 },
    { dryRun: false, expectedContentPlanSha256: expectedHash, expectedContentAssetCount: '1' },
    { dryRun: false, expectedContentPlanSha256: expectedHash, expectedContentAssetCount: -1 },
    { dryRun: false, expectedContentPlanSha256: expectedHash, expectedContentAssetCount: 1.5 },
    { dryRun: false, expectedContentPlanSha256: expectedHash, expectedContentAssetCount: Number.MAX_SAFE_INTEGER + 1 }
  ]
  invalidBodies.forEach((body) => {
    assert.throws(
      () => feishuSync.parseAdminSyncRequest(body, { contentPlanConfirmationRequired: true }),
      (error) => Number(error.statusCode) === 400 && /内容计划|expected|确认/i.test(error.message),
      `非法后台确认请求必须在同步前 HTTP 400：${JSON.stringify(body)}`
    )
  })

  const previous = clone(config.feishu)
  let sourceReadCount = 0
  try {
    Object.assign(config.feishu, {
      mirrorSyncEnabled: true,
      noteMaterialSyncEnabled: true,
      sourceCompatibilityProfile: ''
    })
    assert.strictEqual(
      feishuSync._internal.contentPlanConfirmationRequired(),
      false,
      '非员工 profile 下笔记链实际未启用，不得误扩大 expected 契约'
    )
    Object.assign(config.feishu, {
      syncEnabled: true,
      mirrorSyncEnabled: true,
      noteMaterialSyncEnabled: true,
      sourceCompatibilityProfile: EMPLOYEE_PROFILE
    })
    await assert.rejects(
      () => feishuSync.sync({ users: [], listings: [] }, 'system-feishu-sync', {
        scheduled: true,
        sourceClient: new Proxy({}, {
          get() {
            sourceReadCount += 1
            throw new Error('缺确认时不得读取源表')
          }
        })
      }),
      (error) => Number(error.statusCode) === 400 && /确认|内容计划/i.test(error.message),
      '定时正式同步没有人类确认字段时必须在任何源表/目标表操作前阻断'
    )
    assert.strictEqual(sourceReadCount, 0, '定时任务缺确认时不得开始源表读取或目标写入')
  } finally {
    restoreObject(config.feishu, previous)
  }
}

async function testInventoryConfirmationBehavior() {
  assert.strictEqual(
    typeof noteMaterial._internal.contentPlanConfirmationFromReport,
    'function',
    '素材模块必须提供不可序列化的行级确认计划提取器'
  )

  const humanFixture = inventoryFixture()
  const humanDry = await runInventory(humanFixture, { dryRun: true })
  const confirmation = confirmationFromReport(humanDry)
  assert.match(humanDry.contentPlanSha256, /^[0-9a-f]{64}$/)
  assert.strictEqual(humanDry.contentPlanAssetCount, 1)
  assert.strictEqual(writeCount(humanFixture.calls), 0, '人类 dry-run 确认不得写 DB/Drive/OSS')
  assert.strictEqual(confirmation.expectedContentPlanSha256, humanDry.contentPlanSha256)
  assert.strictEqual(confirmation.expectedContentAssetCount, 1)
  assert.ok(Array.isArray(confirmation.expectedContentPlanEvidence), '私有确认对象必须带行级真实内容证据')
  assert.ok(
    !JSON.stringify(humanDry).includes('tokenVideoConfirmAlpha123') &&
      !JSON.stringify(humanDry).includes('folderSourceConfirmAlpha123') &&
      !JSON.stringify(humanDry).includes('https://'),
    '可返回的 dry-run 摘要不得泄露源 token、目录 token 或 URL'
  )

  {
    const fixture = inventoryFixture()
    const before = JSON.stringify(fixture.db)
    await assert.rejects(
      () => runInventory(fixture, {
        dryRun: false,
        contentPlanConfirmationRequired: true
      }),
      (error) => assertConfirmationError(error, '缺确认字段'),
      '缺确认必须 fail-closed'
    )
    assert.strictEqual(writeCount(fixture.calls), 0, '缺确认时目标 DB/Drive/OSS 写必须全部为 0')
    assert.strictEqual(fixture.calls.list + fixture.calls.download, 0, '缺确认必须在源素材读取前阻断')
    assert.strictEqual(JSON.stringify(fixture.db), before, '缺确认不得改变工作数据库')
  }

  for (const patch of [
    { expectedContentPlanSha256: 'b'.repeat(64) },
    { expectedContentAssetCount: confirmation.expectedContentAssetCount + 1 }
  ]) {
    const fixture = inventoryFixture()
    const before = JSON.stringify(fixture.db)
    await assert.rejects(
      () => runInventory(fixture, {
        dryRun: false,
        contentPlanConfirmationRequired: true,
        ...confirmation,
        ...patch
      }),
      (error) => assertConfirmationError(error, '摘要或数量不匹配'),
      '摘要或数量不匹配必须 fail-closed'
    )
    assert.strictEqual(writeCount(fixture.calls), 0, '摘要或数量不匹配不得写 DB/Drive/OSS')
    assert.strictEqual(JSON.stringify(fixture.db), before, '摘要或数量不匹配不得改变工作数据库')
  }

  {
    const fixture = inventoryFixture({
      records: [{
        sourceRecordId: 'source-record-confirm-alpha',
        folderToken: 'folderSourceConfirmAlpha123',
        assetToken: 'tokenVideoConfirmAlpha123',
        body: Buffer.from('confirmation-alpha-v2'),
        mimeType: 'video/mp4'
      }]
    })
    const before = JSON.stringify(fixture.db)
    await assert.rejects(
      () => runInventory(fixture, {
        dryRun: false,
        contentPlanConfirmationRequired: true,
        ...confirmation
      }),
      (error) => assertConfirmationError(error, '同 token 在人类确认后换字节'),
      '同 token 在人类 dry-run 后原位换字节必须在正式全局预检阻断'
    )
    assert.strictEqual(writeCount(fixture.calls), 0, '人类确认后同 token 换字节不得产生 DB/Drive/OSS 写')
    assert.strictEqual(JSON.stringify(fixture.db), before, '内容漂移不得改变工作数据库')
  }

  {
    const fixture = inventoryFixture({
      bodyForDownload(record, count) {
        return count === 1 ? record.body : Buffer.from('confirmation-alpha-after-global-preflight')
      }
    })
    const before = JSON.stringify(fixture.db)
    await assert.rejects(
      () => runInventory(fixture, {
        dryRun: false,
        contentPlanConfirmationRequired: true,
        ...confirmation
      }),
      (error) => assertConfirmationError(error, '全局预检与逐行正式读取之间变化'),
      '全局预检后、逐行正式处理前发生变化必须在该行 Drive/OSS 写前阻断'
    )
    assert.strictEqual(writeCount(fixture.calls), 0, '逐行内容变化时该行 DB/Drive/OSS 写必须全部为 0')
    assert.strictEqual(JSON.stringify(fixture.db), before, '逐行内容变化不得改变该房源媒体状态')
  }

  {
    const fixture = inventoryFixture()
    const applied = await runInventory(fixture, {
      dryRun: false,
      contentPlanConfirmationRequired: true,
      ...confirmation
    })
    assert.strictEqual(applied.complete, true)
    assert.strictEqual(applied.published, true)
    assert.strictEqual(applied.contentPlanSha256, confirmation.expectedContentPlanSha256)
    assert.strictEqual(applied.contentPlanAssetCount, confirmation.expectedContentAssetCount)
    assert.strictEqual(fixture.calls.driveWrite, 1, '确认一致后才允许写入 Drive')
    assert.strictEqual(fixture.calls.ossWrite, 1, '确认一致后才允许写入 OSS')
    assert.strictEqual(fixture.calls.dbWrite, 1, '确认一致后才允许替换工作数据库素材清单')
  }

  {
    const dryFixture = inventoryFixture({ records: [] })
    const emptyDry = await runInventory(dryFixture, { dryRun: true })
    const emptyConfirmation = confirmationFromReport(emptyDry)
    assert.strictEqual(emptyDry.contentPlanAssetCount, 0, '零素材 dry-run 必须形成确定的 0 数量确认')
    assert.match(emptyDry.contentPlanSha256, /^[0-9a-f]{64}$/)
    const formalFixture = inventoryFixture({ records: [] })
    const emptyFormal = await runInventory(formalFixture, {
      dryRun: false,
      contentPlanConfirmationRequired: true,
      ...emptyConfirmation
    })
    assert.strictEqual(emptyFormal.complete, true)
    assert.strictEqual(emptyFormal.published, true)
    assert.strictEqual(emptyFormal.contentPlanSha256, emptyDry.contentPlanSha256)
    assert.strictEqual(emptyFormal.contentPlanAssetCount, 0)
    assert.strictEqual(writeCount(formalFixture.calls), 0, '零素材确认不得制造空目录、DB 或 OSS 写')
  }

  {
    const fixture = inventoryFixture({
      records: [{
        sourceRecordId: 'source-record-confirm-image',
        folderToken: 'folderSourceConfirmImage123',
        assetToken: 'tokenImageConfirm123456',
        name: 'room-photo.jpg',
        body: Buffer.from('synthetic-image-content'),
        mimeType: 'image/jpeg'
      }]
    })
    const result = await runInventory(fixture, { dryRun: true })
    assert.strictEqual(result.complete, false, '发现小程序尚不支持的非视频素材时 dry-run 必须 fail-closed')
    assert.strictEqual(result.status, 'unsupported-non-video')
    assert.strictEqual(result.nonVideo, 1)
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(result, 'contentPlanSha256'),
      false,
      '非视频未纳入真实内容计划时不得生成可确认摘要'
    )
    assert.strictEqual(writeCount(fixture.calls), 0, '非视频阻断不得写 DB/Drive/OSS')
  }

  {
    const fixture = inventoryFixture()
    const legacyFormal = await runInventory(fixture, {
      dryRun: false,
      contentPlanConfirmationRequired: false
    })
    assert.strictEqual(legacyFormal.complete, true, '确认门未启用时既有素材正式链必须保持兼容')
    assert.strictEqual(legacyFormal.published, true)
  }
}

async function testActualFeishuSyncEndToEndGate() {
  const previous = clone(config.feishu)
  try {
    configureE2eSync()
    assert.strictEqual(
      feishuSync._internal.mirrorConfigurationStatus().ready,
      true,
      '真实 feishuSync.sync 端到端夹具必须先通过完整镜像配置门'
    )

    {
      const fixture = e2eSyncFixture()
      const humanDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-wrong-human` })
      )
      assert.strictEqual(humanDry.success, true, '错误确认场景的人类 dry-run 必须先完整成功')
      assert.strictEqual(humanDry.dryRun, true)
      const before = JSON.stringify(fixture.db)
      await assert.rejects(
        () => feishuSync.sync(
          fixture.db,
          'A-CONFIRM',
          e2eSyncOptions(fixture, {
            runId: `${FIXED_RUN_ID}-wrong-formal`,
            expectedContentPlanSha256: humanDry.noteMaterials.contentPlanSha256.replace(/^./, (value) => (
              value === 'a' ? 'b' : 'a'
            )),
            expectedContentAssetCount: humanDry.noteMaterials.contentPlanAssetCount
          })
        ),
        (error) => assertConfirmationError(error, '真实正式同步收到错误 expected'),
        '错误 expected 必须由真实 feishuSync.sync 在任何目标写入前阻断'
      )
      assert.strictEqual(targetBaseWriteCount(fixture), 0, '错误 expected 时小程序目标 Base 必须零写')
      assert.strictEqual(fixture.calls.folderWrite, 0, '错误 expected 时目标 Drive 目录必须零创建')
      assert.strictEqual(fixture.calls.driveWrite, 0, '错误 expected 时目标 Drive 素材必须零写')
      assert.strictEqual(fixture.calls.ossWrite, 0, '错误 expected 时 OSS 必须零写')
      assert.strictEqual(JSON.stringify(fixture.db), before, '错误 expected 时工作 DB 必须保持逐字不变')
      assert.deepStrictEqual(fixture.getMirrorRecords(), [], '错误 expected 时目标专用表不得出现残留记录')
    }

    {
      const fixture = e2eSyncFixture()
      const humanDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-config-human` })
      )
      assert.strictEqual(humanDry.success, true, '配置漂移场景的人类 dry-run 必须先生成合法确认摘要')
      const beforeDb = JSON.stringify(fixture.db)
      const beforeBaseCallCount = fixture.baseCalls.length
      const previousTargetRoot = config.feishu.noteMaterialTargetRootFolderToken
      config.feishu.noteMaterialTargetRootFolderToken = config.feishu.folderToken
      try {
        await assert.rejects(
          () => feishuSync.sync(
            fixture.db,
            'A-CONFIRM',
            e2eSyncOptions(fixture, {
              runId: `${FIXED_RUN_ID}-config-formal`,
              expectedContentPlanSha256: humanDry.noteMaterials.contentPlanSha256,
              expectedContentAssetCount: humanDry.noteMaterials.contentPlanAssetCount
            })
          ),
          (error) => Number(error.statusCode) === 503 && /素材|目标根|配置/i.test(error.message),
          '正式素材目标根与旧源根重合时必须由真实 feishuSync.sync 写前拒绝'
        )
      } finally {
        config.feishu.noteMaterialTargetRootFolderToken = previousTargetRoot
      }
      assert.strictEqual(
        fixture.baseCalls.length,
        beforeBaseCallCount,
        '确定性素材正式配置失败必须早于员工源与目标 Base 的任何新增读写'
      )
      assert.strictEqual(targetBaseWriteCount(fixture), 0, '确定性素材正式配置失败时目标 Base 必须零写')
      assert.strictEqual(JSON.stringify(fixture.db), beforeDb, '确定性素材正式配置失败时工作 DB 必须保持逐字不变')
      assert.strictEqual(fixture.calls.folderWrite, 0, '确定性素材正式配置失败时目标 Drive 目录必须零创建')
      assert.strictEqual(fixture.calls.driveWrite, 0, '确定性素材正式配置失败时目标 Drive 文件必须零写')
      assert.strictEqual(fixture.calls.ossWrite, 0, '确定性素材正式配置失败时 OSS 必须零写')
    }

    {
      const fixture = e2eSyncFixture()
      const humanDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-success-human` })
      )
      const formal = await feishuSync.sync(
        fixture.db,
        'A-CONFIRM',
        e2eSyncOptions(fixture, {
          runId: `${FIXED_RUN_ID}-success-formal`,
          expectedContentPlanSha256: humanDry.noteMaterials.contentPlanSha256,
          expectedContentAssetCount: humanDry.noteMaterials.contentPlanAssetCount
        })
      )
      assert.strictEqual(formal.complete, true, '确认一致时真实 feishuSync.sync 必须完整成功')
      assert.strictEqual(formal.success, true)
      assert.strictEqual(formal.published, true)
      assert.strictEqual(formal.inventoryCommittable, true, '确认一致的正式结果才允许原子提交工作 DB')
      assert.strictEqual(formal.inventoryPublished, true)
      assert.strictEqual(
        formal.noteMaterials.contentPlanSha256,
        humanDry.noteMaterials.contentPlanSha256,
        '正式结果必须回显与人类确认完全相同的内容摘要'
      )
      assert.strictEqual(
        formal.noteMaterials.contentPlanAssetCount,
        humanDry.noteMaterials.contentPlanAssetCount
      )
      assert.strictEqual(targetBaseWriteCount(fixture), 1, '确认一致后目标专用 Base 必须真实写入一次')
      assert.strictEqual(fixture.calls.folderWrite, 1, '确认一致后目标 Drive 房源目录必须真实创建')
      assert.strictEqual(fixture.calls.driveWrite, 1, '确认一致后目标 Drive 素材必须真实写入')
      assert.strictEqual(fixture.calls.ossWrite, 1, '确认一致后 OSS 素材必须真实写入')
      assert.strictEqual(fixture.db.listings.length, 1, '确认一致后工作 DB 必须得到一套公司房源')
      assert.strictEqual(fixture.db.listings[0].mediaAssets.length, 1, '确认一致后工作 DB 必须原子替换素材清单')
    }

    {
      const fixture = e2eSyncFixture()
      const humanDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-summary-human` })
      )
      const driftedFeishuSync = loadFeishuSyncWithFormalSummaryDrift()
      const formal = await driftedFeishuSync.sync(
        fixture.db,
        'A-CONFIRM',
        e2eSyncOptions(fixture, {
          runId: `${FIXED_RUN_ID}-summary-formal`,
          expectedContentPlanSha256: humanDry.noteMaterials.contentPlanSha256,
          expectedContentAssetCount: humanDry.noteMaterials.contentPlanAssetCount
        })
      )
      assert.strictEqual(targetBaseWriteCount(fixture), 1, '摘要漂移故障注入必须发生在真实目标 Base 写入之后')
      assert.strictEqual(fixture.calls.driveWrite, 1, '摘要漂移故障注入必须发生在真实素材写入之后')
      assert.strictEqual(formal.complete, false, '最终素材摘要漂移时整批结果必须降级失败')
      assert.strictEqual(formal.success, false)
      assert.strictEqual(formal.published, false)
      assert.strictEqual(formal.status, 'content-plan-confirmation-failed')
      assert.strictEqual(formal.inventoryCommittable, false, '最终摘要漂移绝不允许提交工作 DB')
      assert.strictEqual(formal.inventoryPublished, false)
      assert.strictEqual(
        driftedFeishuSync.isCommittableSyncResult(formal),
        false,
        '真实提交分类器必须拒绝最终摘要漂移结果'
      )
    }

    {
      const secondSourceRecordId = 'source-record-confirm-beta'
      const fixture = e2eSyncFixture({
        records: [{
          sourceRecordId: 'source-record-confirm-alpha',
          folderToken: 'folderSourceConfirmAlpha123',
          assetToken: 'tokenVideoConfirmAlpha123',
          body: Buffer.from('confirmation-alpha-v1'),
          mimeType: 'video/mp4'
        }, {
          sourceRecordId: secondSourceRecordId,
          folderToken: 'folderSourceConfirmBeta1234',
          assetToken: 'tokenVideoConfirmBeta1234',
          body: Buffer.from('confirmation-beta-v1'),
          mimeType: 'video/mp4'
        }],
        bodyForDownload(record, count) {
          if (record.sourceRecordId === secondSourceRecordId && count >= 4) {
            return Buffer.from('confirmation-beta-changed-after-global-preflight')
          }
          return record.body
        }
      })
      const humanDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-two-row-human` })
      )
      assert.strictEqual(humanDry.noteMaterials.contentPlanAssetCount, 2)
      const formal = await feishuSync.sync(
        fixture.db,
        'A-CONFIRM',
        e2eSyncOptions(fixture, {
          runId: `${FIXED_RUN_ID}-two-row-formal`,
          expectedContentPlanSha256: humanDry.noteMaterials.contentPlanSha256,
          expectedContentAssetCount: humanDry.noteMaterials.contentPlanAssetCount
        })
      )
      assert.strictEqual(targetBaseWriteCount(fixture), 1, '两行镜像计划允许一次批量目标 Base 写入')
      assert.strictEqual(
        fixture.driveWritesBySourceRecord.get('source-record-confirm-alpha'),
        1,
        '第一行未变化时允许完成该行素材写入'
      )
      assert.strictEqual(
        fixture.driveWritesBySourceRecord.get(secondSourceRecordId) || 0,
        0,
        '第二行在全局预检后变化时，该行首个 Drive 写入必须仍为 0'
      )
      assert.strictEqual(fixture.calls.ossWrite, 1, '第二行变化后不得产生第二次 OSS 写入')
      assert.strictEqual(formal.complete, false, '任一行内容变化必须让整批真实同步失败')
      assert.strictEqual(formal.success, false)
      assert.strictEqual(formal.status, 'content-plan-confirmation-failed')
      assert.strictEqual(formal.inventoryCommittable, false, '前一行已写也不得让部分结果进入正式 DB')
      assert.strictEqual(formal.inventoryPublished, false)
      assert.strictEqual(
        feishuSync.isCommittableSyncResult(formal),
        false,
        '两行中第二行漂移时提交分类器必须拒绝整批结果'
      )
    }
  } finally {
    restoreObject(config.feishu, previous)
  }
}

async function testReadOnlyPreflightOrder() {
  assert.strictEqual(
    typeof feishuSync._internal.prepareMirrorContentPlanConfirmation,
    'function',
    '镜像正式同步必须提供写入前的完整素材只读预检协调器'
  )
  const expected = {
    expectedContentPlanSha256: 'c'.repeat(64),
    expectedContentAssetCount: 2
  }
  const order = []
  const db = { marker: 'working-db', listings: [] }
  const prepared = await feishuSync._internal.prepareMirrorContentPlanConfirmation({
    db,
    adminId: 'A-CONFIRM',
    runId: FIXED_RUN_ID,
    nowMs: FIXED_NOW_MS,
    ...expected,
    runPreflight: async (context) => {
      order.push('read-only-preflight')
      assert.strictEqual(context.db, db, '协调器必须绑定同一 working DB 快照')
      assert.strictEqual(context.runId, FIXED_RUN_ID)
      assert.strictEqual(context.nowMs, FIXED_NOW_MS)
      return {
        complete: true,
        failed: 0,
        dryRun: true,
        contentPlanSha256: expected.expectedContentPlanSha256,
        contentPlanAssetCount: expected.expectedContentAssetCount,
        privateConfirmation: {
          ...expected,
          expectedContentPlanEvidence: [{
            sourceRecordFingerprint: 'd'.repeat(64),
            assetId: 'MAT-11111111111111111111111111111111',
            contentSha256: 'e'.repeat(64),
            size: 1,
            mimeType: 'video/mp4',
            displayOrder: 0
          }, {
            sourceRecordFingerprint: 'f'.repeat(64),
            assetId: 'MAT-22222222222222222222222222222222',
            contentSha256: '1'.repeat(64),
            size: 2,
            mimeType: 'video/mp4',
            displayOrder: 0
          }]
        }
      }
    }
  })
  assert.deepStrictEqual(order, ['read-only-preflight'])
  assert.strictEqual(prepared.expectedContentPlanSha256, expected.expectedContentPlanSha256)
  assert.strictEqual(prepared.expectedContentAssetCount, 2)

  let formalWriteCount = 0
  await assert.rejects(
    () => feishuSync._internal.prepareMirrorContentPlanConfirmation({
      db,
      adminId: 'A-CONFIRM',
      runId: FIXED_RUN_ID,
      nowMs: FIXED_NOW_MS,
      ...expected,
      runPreflight: async () => ({
        complete: true,
        failed: 0,
        dryRun: true,
        contentPlanSha256: '9'.repeat(64),
        contentPlanAssetCount: 2
      }),
      beginFormalWrite: async () => {
        formalWriteCount += 1
      }
    }),
    (error) => assertConfirmationError(error, '正式同步只读预检与 expected 不一致'),
    '正式同步只读预检必须精确匹配人类确认'
  )
  assert.strictEqual(formalWriteCount, 0, '预检不匹配时不得进入任何正式写阶段')

  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'feishu-sync.js'), 'utf8')
  const start = source.indexOf('async function syncViaMirror')
  const end = source.indexOf('function isCommittableSyncResult', start)
  const block = source.slice(start, end)
  assert.ok(start >= 0 && end > start, '必须定位镜像同步协调函数')
  assert.ok(block.includes('prepareMirrorContentPlanConfirmation'), '镜像正式同步必须调用内容计划确认预检')
  assert.ok(
    block.indexOf('prepareMirrorContentPlanConfirmation') < block.indexOf('runCompanySourceSync'),
    '内容计划确认预检必须早于目标表、库存、快照及提交协调器'
  )
  assert.ok(
    block.includes('expectedContentPlanEvidence'),
    '正式素材阶段必须取得同一确认预检的行级真实内容证据'
  )

  const indexSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'index.js'), 'utf8')
  const routeStart = indexSource.indexOf("pathname === '/admin/feishu-sync/run'")
  const routeEnd = indexSource.indexOf("pathname === '/admin/listings'", routeStart)
  const routeBlock = indexSource.slice(routeStart, routeEnd)
  assert.ok(routeBlock.includes('feishuSync.parseAdminSyncRequest(body)'), '后台路由必须调用统一确认字段校验器')
  assert.ok(
    routeBlock.indexOf('feishuSync.parseAdminSyncRequest(body)') < routeBlock.indexOf('if (feishuSyncRunning)'),
    '后台请求必须在取得同步互斥锁及开始任何飞书操作前完成确认字段 400 校验'
  )
}

function request(baseUrl, method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let parsed = {}
        try {
          parsed = raw ? JSON.parse(raw) : {}
        } catch (_error) {
          parsed = { raw }
        }
        resolve({ statusCode: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitForServer(baseUrl) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 12000) {
    try {
      const response = await request(baseUrl, 'GET', '/healthz')
      if (response.statusCode === 200) return true
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return false
}

async function testAdminHttp400() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-note-confirm-http-'))
  const dataFile = path.join(tempDir, 'db.json')
  const port = 43000 + Math.floor(Math.random() * 1000)
  const baseUrl = `http://127.0.0.1:${port}`
  fs.writeFileSync(dataFile, JSON.stringify({
    users: [{ id: 'U-ADMIN', name: '合成管理员', role: '中介' }],
    listings: [],
    adminAccounts: [{
      id: 'A-ADMIN',
      account: 'admin',
      password: 'admin123',
      name: '合成管理员',
      userId: 'U-ADMIN',
      permission: '全部后台权限',
      status: '启用'
    }]
  }), 'utf8')
  const serverDir = path.resolve(__dirname, '..')
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_FILE: dataFile,
      ADMIN_TOKEN_SECRET: 'synthetic-note-confirm-admin-secret',
      AUTH_TOKEN_SECRET: 'synthetic-note-confirm-mini-secret',
      V1_DISABLE_LEGACY_ROUTES: '1',
      FEISHU_SYNC_ENABLED: '1',
      FEISHU_MIRROR_SYNC_ENABLED: '1',
      FEISHU_NOTE_MATERIAL_SYNC_ENABLED: '1',
      FEISHU_SOURCE_COMPATIBILITY_PROFILE: EMPLOYEE_PROFILE
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk.toString() })
  server.stderr.on('data', (chunk) => { output += chunk.toString() })
  try {
    assert.ok(await waitForServer(baseUrl), `后台确认门 HTTP 测试服务未启动：${output}`)
    const login = await request(baseUrl, 'POST', '/admin/auth/login', {
      account: 'admin',
      password: 'admin123'
    })
    assert.strictEqual(login.statusCode, 200, '合成超管必须登录成功')
    const token = login.body && login.body.data && login.body.data.token
    assert.ok(token, '超管登录必须返回 token')
    const auth = { Authorization: `Bearer ${token}` }
    for (const body of [
      { dryRun: false },
      { dryRun: false, expectedContentPlanSha256: 'a'.repeat(64) },
      {
        dryRun: false,
        expectedContentPlanSha256: 'A'.repeat(64),
        expectedContentAssetCount: 1
      },
      {
        dryRun: false,
        expectedContentPlanSha256: 'a'.repeat(64),
        expectedContentAssetCount: '1'
      }
    ]) {
      const response = await request(baseUrl, 'POST', '/admin/feishu-sync/run', body, auth)
      assert.strictEqual(response.statusCode, 400, `非法正式同步确认必须真实返回 HTTP 400：${JSON.stringify(body)}`)
      const responseText = JSON.stringify(response.body)
      assert.ok(!responseText.includes('synthetic-note-confirm-admin-secret'), 'HTTP 400 响应不得泄露服务端密钥')
      assert.ok(!responseText.includes('tokenVideoConfirmAlpha123'), 'HTTP 400 响应不得泄露素材 token')
    }
    const dryResponse = await request(baseUrl, 'POST', '/admin/feishu-sync/run', { dryRun: 'true' }, auth)
    assert.strictEqual(dryResponse.statusCode, 400, 'dryRun 错型仍必须真实返回 HTTP 400')
  } finally {
    server.kill()
    await new Promise((resolve) => server.once('exit', resolve))
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function main() {
  await testParserAndScheduledGate()
  await testInventoryConfirmationBehavior()
  await testActualFeishuSyncEndToEndGate()
  await testReadOnlyPreflightOrder()
  await testAdminHttp400()
  console.log('feishu-note-material-confirmation-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
