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

function createFakePrepareMaterial(options = {}) {
  const transformProfileVersion = options.transformProfileVersion || 'feishu-note-serving-v1'
  const transformProfileSha256 = Object.prototype.hasOwnProperty.call(options, 'transformProfileSha256')
    ? options.transformProfileSha256
    : sha256('fake-transform-profile-v1')
  const transformToolFingerprint = options.transformToolFingerprint || sha256('fake-ffmpeg-tool-v1')
  const prepareMaterial = async ({ asset, sourceEvidence }) => {
    const outputBuffer = typeof options.outputForSource === 'function'
      ? Buffer.from(options.outputForSource(sourceEvidence, asset))
      : Buffer.concat([Buffer.from('normalized:'), sourceEvidence.buffer])
    const kind = asset && asset.kind === 'image' ? 'image' : 'video'
    const contentType = kind === 'image' ? sourceEvidence.contentType : 'video/mp4'
    const extension = kind === 'image'
      ? (contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg')
      : 'mp4'
    const prepared = {
      buffer: outputBuffer,
      kind,
      extension,
      sourceContentSha256: sourceEvidence.contentSha256,
      sourceSize: sourceEvidence.size,
      sourceMimeType: sourceEvidence.contentType,
      contentSha256: sha256(outputBuffer),
      size: outputBuffer.length,
      contentType,
      mimeType: contentType,
      transformProfileVersion,
      transformProfileSha256,
      transformToolFingerprint,
      transformAction: options.transformAction || (kind === 'image' ? 'compress' : 'transcode')
    }
    if (options.state) {
      options.state.calls = Number(options.state.calls || 0) + 1
      if (!Array.isArray(options.state.preparedBuffers)) options.state.preparedBuffers = []
      options.state.preparedBuffers.push(outputBuffer)
    }
    return prepared
  }
  prepareMaterial.profile = {
    transformProfileVersion,
    transformProfileSha256,
    transformToolFingerprint
  }
  return prepareMaterial
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
    dbWrite: 0,
    driveBuffers: [],
    ossBuffers: []
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
      calls.driveBuffers.push(input.sourceEvidence.buffer)
      return {
        targetToken: `target-file-${sha256(input.asset.sourceToken).slice(0, 12)}`,
        targetName: input.targetName,
        buffer: input.sourceEvidence.buffer,
        contentSha256: input.sourceEvidence.contentSha256,
        contentType: input.sourceEvidence.contentType,
        size: input.sourceEvidence.size,
        verified: true
      }
    },
    async verifyMaterializedVideo() {
      return { verified: true }
    }
  }
  const oss = {
    async putVideoDeterministic(input) {
      calls.ossWrite += 1
      calls.ossBuffers.push(input.buffer)
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    },
    async verifyVideoDeterministic() {
      return { verified: true }
    }
  }
  const prepareMaterial = options.prepareMaterial || createFakePrepareMaterial()
  return {
    records,
    db,
    calls,
    drive,
    oss,
    prepareMaterial,
    transformProfile: prepareMaterial.profile,
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
    prepareMaterial: options.prepareMaterial || fixture.prepareMaterial,
    describeProfile: options.describeProfile || (async () => fixture.transformProfile),
    dryRun: options.dryRun === true,
    nowText: '2026-07-27T01:02:03.000Z',
    contentPlanConfirmationRequired: options.contentPlanConfirmationRequired === true,
    expectedContentPlanSha256: options.expectedContentPlanSha256,
    expectedContentAssetCount: options.expectedContentAssetCount,
    expectedContentPlanEvidence: options.expectedContentPlanEvidence,
    expectedDeferredMaterialEvidence: options.expectedDeferredMaterialEvidence,
    mediaAssetsStateKey: (current) => sha256(JSON.stringify(current.mediaAssets || [])),
    replaceMediaAssets: async (current, mediaAssets) => {
      fixture.calls.dbWrite += 1
      current.mediaAssets = clone(mediaAssets)
      const primaryVideo = mediaAssets.find((asset) => asset.kind === 'video')
      current.videoKey = primaryVideo ? primaryVideo.objectKey : ''
    }
  })
}

function confirmationFromReport(report) {
  return noteMaterial._internal.contentPlanConfirmationFromReport(report)
}

function confirmationForEvidence(evidence) {
  const summary = noteMaterial._internal.buildContentPlanSummary(evidence)
  return {
    expectedContentPlanSha256: summary.contentPlanSha256,
    expectedContentAssetCount: summary.contentPlanAssetCount,
    expectedContentPlanEvidence: evidence
  }
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
    prepareMaterial: fixture.prepareMaterial,
    describeProfile: async () => fixture.transformProfile,
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
    feishuSync.parseAdminSyncRequest({ dryRun: true }, { externalWorkerRequest: true }),
    { dryRun: true },
    '异步 worker 的外部请求只允许选择纯预演'
  )
  assert.deepStrictEqual(
    feishuSync.parseAdminSyncRequest({ dryRun: false }, { externalWorkerRequest: true }),
    { dryRun: false },
    '异步 worker 的正式请求身份和摘要由服务端生成'
  )
  for (const field of ['runId', 'nowMs', 'expectedContentPlanSha256', 'expectedContentAssetCount', 'expectedSchemaSha256', 'expectedResourceIdentitySha256', 'expectedMirrorPlanSha256']) {
    assert.throws(
      () => feishuSync.parseAdminSyncRequest({ dryRun: true, [field]: field.includes('Sha256') ? expectedHash : 1 }, { externalWorkerRequest: true }),
      (error) => Number(error.statusCode) === 400 && /只接受 dryRun|服务端生成/.test(error.message),
      `外部请求不得注入 ${field}`
    )
  }
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
  assert.deepStrictEqual(
    feishuSync.parseAdminSyncRequest({
      dryRun: true,
      runId: 'public-confirmation-run',
      nowMs: FIXED_NOW_MS
    }, { contentPlanConfirmationRequired: true }),
    {
      dryRun: true,
      runId: 'public-confirmation-run',
      nowMs: FIXED_NOW_MS
    },
    '后台解析器只允许输出公开同步契约字段'
  )

  for (const field of [
    'noteMaterialOss',
    'noteMaterialDrive',
    'sourceClient',
    'targetClient',
    'feishuToken',
    '_captureContentPlanConfirmation',
    'privateMappings',
    'materials',
    'scheduled'
  ]) {
    assert.throws(
      () => feishuSync.parseAdminSyncRequest({
        dryRun: true,
        [field]: {}
      }, { contentPlanConfirmationRequired: true }),
      (error) => Number(error.statusCode) === 400 && /字段|参数|不支持|未知/i.test(error.message),
      `后台 JSON 不得把内部字段 ${field} 透传到可信同步 options`
    )
  }
  for (const runId of [
    'short',
    '.invalid',
    '人工-confirmation-run',
    'invalid\nconfirmation-run',
    'a'.repeat(129),
    {}
  ]) {
    assert.throws(
      () => feishuSync.parseAdminSyncRequest({
        dryRun: true,
        runId
      }, { contentPlanConfirmationRequired: true }),
      (error) => Number(error.statusCode) === 400 && /runId/i.test(error.message),
      `公共 runId 必须拒绝非 ASCII 安全形状：${JSON.stringify(runId)}`
    )
  }
  for (const nowMs of ['1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => feishuSync.parseAdminSyncRequest({
        dryRun: true,
        nowMs
      }, { contentPlanConfirmationRequired: true }),
      (error) => Number(error.statusCode) === 400 && /nowMs/i.test(error.message),
      `公共 nowMs 必须拒绝非正安全整数：${JSON.stringify(nowMs)}`
    )
  }

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
    const imageRecord = {
      sourceRecordId: 'source-record-confirm-image',
      folderToken: 'folderSourceConfirmImage123',
      assetToken: 'tokenImageConfirm123456',
      name: 'room-photo.jpg',
      body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic-jpeg-content')]),
      mimeType: 'image/jpeg'
    }
    const fixture = inventoryFixture({
      records: [imageRecord]
    })
    const result = await runInventory(fixture, { dryRun: true })
    assert.strictEqual(result.complete, true, '安全图片必须与视频一样进入完整 dry-run')
    assert.strictEqual(result.image, 1)
    assert.strictEqual(result.nonVideo, 0)
    assert.strictEqual(result.contentPlanAssetCount, 1, '图片必须纳入同一真实内容计划确认摘要')
    assert.match(result.contentPlanSha256, /^[0-9a-f]{64}$/)
    assert.strictEqual(writeCount(fixture.calls), 0, '图片 dry-run 仍不得写 DB/Drive/OSS')

    const imageConfirmation = confirmationFromReport(result)
    const formalFixture = inventoryFixture({ records: [imageRecord] })
    const formal = await runInventory(formalFixture, {
      dryRun: false,
      contentPlanConfirmationRequired: true,
      ...imageConfirmation
    })
    assert.strictEqual(formal.complete, true, '确认摘要一致后图片正式同步必须完成')
    assert.strictEqual(formal.published, true)
    assert.strictEqual(formalFixture.calls.driveWrite, 1, '图片必须真实写入并回读飞书云盘')
    assert.strictEqual(formalFixture.calls.ossWrite, 1, '图片必须真实写入并回读 OSS')
    assert.strictEqual(formalFixture.calls.dbWrite, 1, '图片必须原子写入房源私有素材清单')
    assert.strictEqual(formalFixture.db.listings[0].mediaAssets[0].kind, 'image')
    assert.strictEqual(formalFixture.db.listings[0].videoKey, '', '图片-only 房源不得生成伪视频兼容索引')
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

async function testNormalizedContentConfirmationBehavior() {
  const rawBody = Buffer.from('confirmation-normalized-source-v1')
  const dryState = { calls: 0, preparedBuffers: [] }
  const dryFixture = inventoryFixture({
    records: [{
      sourceRecordId: 'source-record-confirm-alpha',
      folderToken: 'folderSourceConfirmAlpha123',
      assetToken: 'tokenVideoConfirmAlpha123',
      name: 'source.mov',
      body: rawBody,
      mimeType: 'video/quicktime'
    }],
    prepareMaterial: createFakePrepareMaterial({ state: dryState })
  })
  const dry = await runInventory(dryFixture, { dryRun: true })
  const confirmation = confirmationFromReport(dry)
  const evidence = confirmation.expectedContentPlanEvidence[0]
  const normalizedBody = Buffer.concat([Buffer.from('normalized:'), rawBody])
  assert.deepStrictEqual({
    prepareCalls: dryState.calls,
    sourceContentSha256: evidence.sourceContentSha256,
    sourceSize: evidence.sourceSize,
    sourceMimeType: evidence.sourceMimeType,
    contentSha256: evidence.contentSha256,
    size: evidence.size,
    mimeType: evidence.mimeType,
    transformProfileVersion: evidence.transformProfileVersion,
    transformProfileSha256: evidence.transformProfileSha256,
    transformToolFingerprint: evidence.transformToolFingerprint,
    transformAction: evidence.transformAction,
    writes: writeCount(dryFixture.calls)
  }, {
    prepareCalls: 1,
    sourceContentSha256: sha256(rawBody),
    sourceSize: rawBody.length,
    sourceMimeType: 'video/quicktime',
    contentSha256: sha256(normalizedBody),
    size: normalizedBody.length,
    mimeType: 'video/mp4',
    transformProfileVersion: 'feishu-note-serving-v1',
    transformProfileSha256: sha256('fake-transform-profile-v1'),
    transformToolFingerprint: sha256('fake-ffmpeg-tool-v1'),
    transformAction: 'transcode',
    writes: 0
  }, '人类 dry-run 必须调用 prepareMaterial，并把源证据、输出证据和转换身份一并纳入私有确认计划')

  const mutationCases = [
    ['sourceContentSha256', sha256('tampered-source-content')],
    ['contentSha256', sha256('tampered-normalized-content')],
    ['size', normalizedBody.length + 1],
    ['transformProfileVersion', 'feishu-note-serving-v2'],
    ['transformProfileSha256', sha256('fake-transform-profile-v2')],
    ['transformToolFingerprint', sha256('fake-ffmpeg-tool-v2')],
    ['transformAction', 'compress']
  ]
  for (const [field, value] of mutationCases) {
    const tamperedEvidence = confirmation.expectedContentPlanEvidence.map((item, index) => (
      index === 0 ? { ...item, [field]: value } : { ...item }
    ))
    const tamperedConfirmation = confirmationForEvidence(tamperedEvidence)
    const state = { calls: 0, preparedBuffers: [] }
    const fixture = inventoryFixture({
      records: dryFixture.records,
      prepareMaterial: createFakePrepareMaterial({ state })
    })
    const before = JSON.stringify(fixture.db)
    let rejected = null
    try {
      await runInventory(fixture, {
        dryRun: false,
        contentPlanConfirmationRequired: true,
        ...tamperedConfirmation
      })
    } catch (error) {
      rejected = error
      assertConfirmationError(error, `${field} 被篡改`)
    }
    assert.deepStrictEqual({
      rejected: Boolean(rejected),
      businessWrites: writeCount(fixture.calls),
      dbUnchanged: JSON.stringify(fixture.db) === before
    }, {
      rejected: true,
      businessWrites: 0,
      dbUnchanged: true
    }, `${field} 被篡改时必须在 Drive/OSS/DB 写入前拒绝`)
  }

  {
    const missingEvidence = confirmation.expectedContentPlanEvidence.map((item, index) => {
      const next = { ...item }
      if (index === 0) delete next.transformProfileSha256
      return next
    })
    const fixture = inventoryFixture({
      records: dryFixture.records,
      prepareMaterial: createFakePrepareMaterial()
    })
    const before = JSON.stringify(fixture.db)
    await assert.rejects(
      () => runInventory(fixture, {
        dryRun: false,
        contentPlanConfirmationRequired: true,
        ...confirmation,
        expectedContentPlanEvidence: missingEvidence
      }),
      '删除 transformProfileSha256 必须让正式确认 fail-closed'
    )
    assert.strictEqual(writeCount(fixture.calls), 0, '删除 transformProfileSha256 时 Drive/OSS/DB 写入必须为 0')
    assert.strictEqual(JSON.stringify(fixture.db), before, '删除 transformProfileSha256 不得改变数据库')
  }

  for (const invalidDigest of ['', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)]) {
    const fixture = inventoryFixture({
      records: dryFixture.records,
      prepareMaterial: createFakePrepareMaterial({ transformProfileSha256: invalidDigest })
    })
    const before = JSON.stringify(fixture.db)
    await assert.rejects(
      () => runInventory(fixture, { dryRun: true }),
      (error) => error && error.code === 'CONTENT_PLAN_CONFIRMATION_FAILED',
      '无效 transformProfileSha256 必须整轮阻断且不得降级为逐行延期'
    )
    assert.strictEqual(writeCount(fixture.calls), 0, '无效 transformProfileSha256 不得写 Drive/OSS/DB')
    assert.strictEqual(JSON.stringify(fixture.db), before, '无效 transformProfileSha256 不得改变数据库')
  }

  {
    const state = { calls: 0, preparedBuffers: [] }
    const fixture = inventoryFixture({
      records: dryFixture.records,
      bodyForDownload(record, count) {
        return count === 1 ? record.body : Buffer.from('source-changed-before-target-write')
      },
      prepareMaterial: createFakePrepareMaterial({ state })
    })
    const before = JSON.stringify(fixture.db)
    await assert.rejects(
      () => runInventory(fixture, {
        dryRun: false,
        contentPlanConfirmationRequired: true,
        ...confirmation
      }),
      (error) => assertConfirmationError(error, 'apply 再次取得的源内容变化'),
      'apply 再次取得源内容变化时必须在首个目标写入前拒绝'
    )
    assert.ok(state.calls >= 1, '源内容变化门必须建立在已调用 prepareMaterial 的归一化计划之上')
    assert.strictEqual(writeCount(fixture.calls), 0, '源内容变化不得产生 Drive/OSS/DB 写入')
    assert.strictEqual(JSON.stringify(fixture.db), before, '源内容变化不得改变工作数据库')
  }

  {
    const state = { calls: 0, preparedBuffers: [] }
    const fixture = inventoryFixture({
      records: dryFixture.records,
      prepareMaterial: createFakePrepareMaterial({ state })
    })
    const applied = await runInventory(fixture, {
      dryRun: false,
      contentPlanConfirmationRequired: true,
      ...confirmation
    })
    const driveBuffer = fixture.calls.driveBuffers[0]
    const ossBuffer = fixture.calls.ossBuffers[0]
    assert.deepStrictEqual({
      complete: applied.complete,
      published: applied.published,
      prepareCalled: state.calls > 0,
      driveUsesPreparedBuffer: state.preparedBuffers.includes(driveBuffer),
      ossUsesExactDriveBuffer: ossBuffer === driveBuffer,
      finalContentSha256: driveBuffer && sha256(driveBuffer)
    }, {
      complete: true,
      published: true,
      prepareCalled: true,
      driveUsesPreparedBuffer: true,
      ossUsesExactDriveBuffer: true,
      finalContentSha256: sha256(normalizedBody)
    }, '确认一致后 Drive 与 OSS 必须消费 prepareMaterial 生成的同一份最终归一化 Buffer')
  }
}

async function testActualFeishuSyncEndToEndGate() {
  const previous = clone(config.feishu)
  const previousOss = clone(config.oss)
  try {
    configureE2eSync()
    Object.assign(config.oss, {
      bucket: 'synthetic-confirmation-bucket',
      region: 'oss-cn-hangzhou',
      accessKeyId: 'synthetic-confirmation-access-key',
      accessKeySecret: 'synthetic-confirmation-access-secret'
    })
    assert.strictEqual(
      feishuSync._internal.mirrorConfigurationStatus().ready,
      true,
      '真实 feishuSync.sync 端到端夹具必须先通过完整镜像配置门'
    )

    {
      const fixture = e2eSyncFixture()
      assert.strictEqual(
        feishuSync._internal.contentPlanConfirmationRequired(),
        true,
        '端到端确认夹具必须启用正式内容计划门'
      )
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
      assert.ok(
        noteMaterial._internal.recallContentPlanConfirmation(
          humanDry.noteMaterials.contentPlanSha256,
          humanDry.noteMaterials.contentPlanAssetCount
        ),
        '成功的人类 dry-run 必须把私有行级内容计划留在进程内短期确认缓存'
      )
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
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-root-shape-human` })
      )
      assert.strictEqual(humanDry.success, true, '目标根格式漂移场景必须先生成合法 human dry 摘要')
      const beforeDb = JSON.stringify(fixture.db)
      const beforeBaseCallCount = fixture.baseCalls.length
      const previousTargetRoot = config.feishu.noteMaterialTargetRootFolderToken
      config.feishu.noteMaterialTargetRootFolderToken = 'x'
      try {
        await assert.rejects(
          () => feishuSync.sync(
            fixture.db,
            'A-CONFIRM',
            e2eSyncOptions(fixture, {
              runId: `${FIXED_RUN_ID}-root-shape-formal`,
              expectedContentPlanSha256: humanDry.noteMaterials.contentPlanSha256,
              expectedContentAssetCount: humanDry.noteMaterials.contentPlanAssetCount
            })
          ),
          (error) => Number(error.statusCode) === 503 && /素材|目标根|配置/i.test(error.message),
          '格式非法但非空的目标根必须由真实 feishuSync.sync 写前拒绝'
        )
      } finally {
        config.feishu.noteMaterialTargetRootFolderToken = previousTargetRoot
      }
      assert.strictEqual(
        fixture.baseCalls.length,
        beforeBaseCallCount,
        '目标根格式非法必须早于员工源与目标 Base 的任何新增读写'
      )
      assert.strictEqual(targetBaseWriteCount(fixture), 0, '目标根格式非法时目标 Base 必须零写')
      assert.strictEqual(JSON.stringify(fixture.db), beforeDb, '目标根格式非法时工作 DB 必须保持逐字不变')
      assert.strictEqual(fixture.calls.folderWrite, 0, '目标根格式非法时目标 Drive 目录必须零创建')
      assert.strictEqual(fixture.calls.driveWrite, 0, '目标根格式非法时目标 Drive 文件必须零写')
      assert.strictEqual(fixture.calls.ossWrite, 0, '目标根格式非法时 OSS 必须零写')
    }

    for (const scenario of [{
      name: '空 OSS 适配器',
      patch: { noteMaterialOss: {} }
    }, {
      name: 'OSS 仅有写方法',
      patch: {
        noteMaterialOss: {
          async putVideoDeterministic() {
            throw new Error('非法 OSS 适配器不得被调用')
          }
        }
      }
    }, {
      name: 'OSS 仅有校验方法',
      patch: {
        noteMaterialOss: {
          async verifyVideoDeterministic() {
            throw new Error('非法 OSS 适配器不得被调用')
          }
        }
      }
    }, {
      name: '空 Drive 适配器',
      patch: { noteMaterialDrive: {} }
    }, ...[
      'listFolder',
      'downloadToken',
      'ensureListingFolder',
      'materializeVideo',
      'verifyMaterializedVideo'
    ].map((missingMethod) => ({
      name: `Drive 缺少 ${missingMethod}`,
      patchFactory: (fixture) => {
        const noteMaterialDrive = {}
        ;[
          'listFolder',
          'downloadToken',
          'ensureListingFolder',
          'materializeVideo',
          'verifyMaterializedVideo'
        ].filter((method) => method !== missingMethod).forEach((method) => {
          noteMaterialDrive[method] = (...args) => fixture.drive[method](...args)
        })
        return { noteMaterialDrive }
      }
    }))]) {
      const fixture = e2eSyncFixture()
      const patch = typeof scenario.patchFactory === 'function'
        ? scenario.patchFactory(fixture)
        : scenario.patch
      const humanDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, {
          dryRun: true,
          runId: `${FIXED_RUN_ID}-invalid-adapter-human`
        })
      )
      assert.strictEqual(humanDry.success, true, `${scenario.name} 场景必须先取得合法 human dry 摘要`)
      const beforeDb = JSON.stringify(fixture.db)
      const beforeBaseCallCount = fixture.baseCalls.length
      await assert.rejects(
        () => feishuSync.sync(
          fixture.db,
          'A-CONFIRM',
          {
            ...e2eSyncOptions(fixture, {
              runId: `${FIXED_RUN_ID}-invalid-adapter-formal`,
              expectedContentPlanSha256: humanDry.noteMaterials.contentPlanSha256,
              expectedContentAssetCount: humanDry.noteMaterials.contentPlanAssetCount
            }),
            ...patch
          }
        ),
        (error) => Number(error.statusCode) === 503 && /素材|适配器|配置/i.test(error.message),
        `${scenario.name} 必须在真实 feishuSync.sync 首个镜像读写前拒绝`
      )
      assert.strictEqual(
        fixture.baseCalls.length,
        beforeBaseCallCount,
        `${scenario.name} 不得新增员工源或目标 Base 读写`
      )
      assert.strictEqual(targetBaseWriteCount(fixture), 0, `${scenario.name} 必须保持目标 Base 零写`)
      assert.strictEqual(JSON.stringify(fixture.db), beforeDb, `${scenario.name} 必须保持工作 DB 不变`)
      assert.strictEqual(fixture.calls.folderWrite, 0, `${scenario.name} 必须保持目标 Drive 目录零写`)
      assert.strictEqual(fixture.calls.driveWrite, 0, `${scenario.name} 必须保持目标 Drive 文件零写`)
      assert.strictEqual(fixture.calls.ossWrite, 0, `${scenario.name} 必须保持 OSS 零写`)
    }

    {
      const prepareState = { calls: 0, preparedBuffers: [] }
      const fixture = e2eSyncFixture({
        prepareMaterial: createFakePrepareMaterial({ state: prepareState })
      })
      const humanDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-success-human` })
      )
      assert.strictEqual(prepareState.calls, 1, '人类 dry-run 必须真实生成一次压缩内容计划')
      prepareState.calls = 0
      prepareState.preparedBuffers = []
      fixture.calls.download = 0
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
      assert.deepStrictEqual(
        [prepareState.calls, fixture.calls.download],
        [1, 3],
        '真实正式入口必须只压缩缺失素材一次，同时保留预检核源、正式写前核源与压缩读取三道安全门'
      )
      assert.strictEqual(fixture.db.listings.length, 1, '确认一致后工作 DB 必须得到一套公司房源')
      assert.strictEqual(fixture.db.listings[0].mediaAssets.length, 1, '确认一致后工作 DB 必须原子替换素材清单')
    }

    {
      const deferredSourceRecordId = 'source-record-confirm-deferred'
      const deferredAssetToken = 'tokenVideoConfirmDeferred123'
      const fixture = e2eSyncFixture({
        records: [{
          sourceRecordId: 'source-record-confirm-ready',
          folderToken: 'folderSourceConfirmReady123',
          assetToken: 'tokenVideoConfirmReady123',
          body: Buffer.from('confirmation-ready-v1'),
          mimeType: 'video/mp4'
        }, {
          sourceRecordId: deferredSourceRecordId,
          folderToken: 'folderSourceConfirmDeferred123',
          assetToken: deferredAssetToken,
          body: Buffer.from('confirmation-deferred-v1'),
          mimeType: 'video/mp4'
        }]
      })
      const originalDownloadToken = fixture.drive.downloadToken
      let deferredDownloadAttempts = 0
      fixture.drive.downloadToken = async (assetToken) => {
        if (assetToken === deferredAssetToken) {
          deferredDownloadAttempts += 1
          const error = new Error('synthetic deferred row timeout')
          error.code = 'ETIMEDOUT'
          throw error
        }
        return originalDownloadToken(assetToken)
      }

      const humanDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-partial-human` })
      )
      assert.strictEqual(humanDry.success, false)
      assert.strictEqual(humanDry.status, 'inventory-validated-materials-failed')
      assert.strictEqual(humanDry.validated, true)
      assert.strictEqual(humanDry.planned, true)
      assert.strictEqual(humanDry.failed, 1)
      assert.match(humanDry.noteMaterials.contentPlanSha256, /^[0-9a-f]{64}$/)
      assert.strictEqual(humanDry.noteMaterials.contentPlanAssetCount, 1)
      assert.strictEqual(deferredDownloadAttempts, 1, '首次 dry 必须真实识别逐行素材失败')
      assert.ok(
        noteMaterial._internal.recallContentPlanConfirmation(
          humanDry.noteMaterials.contentPlanSha256,
          humanDry.noteMaterials.contentPlanAssetCount
        ),
        '部分素材告警 dry 仍须缓存受信的成功素材计划与延期行身份'
      )

      const formal = await feishuSync.sync(
        fixture.db,
        'A-CONFIRM',
        e2eSyncOptions(fixture, {
          runId: `${FIXED_RUN_ID}-partial-formal`,
          expectedContentPlanSha256: humanDry.noteMaterials.contentPlanSha256,
          expectedContentAssetCount: humanDry.noteMaterials.contentPlanAssetCount
        })
      )
      assert.strictEqual(formal.success, false)
      assert.strictEqual(formal.status, 'inventory-published-materials-failed')
      assert.strictEqual(formal.inventoryCommittable, true)
      assert.strictEqual(formal.inventoryPublished, true)
      assert.strictEqual(formal.failed, 1)
      assert.strictEqual(
        deferredDownloadAttempts,
        1,
        '正式预检与 apply 必须按受信延期计划跳过失败行，不得盲目重试或产生未知写入'
      )
      assert.strictEqual(targetBaseWriteCount(fixture), 1, '逐行素材失败不得阻断库存目标表发布')
      assert.strictEqual(
        fixture.driveWritesBySourceRecord.get('source-record-confirm-ready'),
        1,
        '已通过 dry 内容计划的房源素材仍须正常发布'
      )
      assert.strictEqual(
        fixture.driveWritesBySourceRecord.get(deferredSourceRecordId) || 0,
        0,
        '延期失败行本轮不得写 Drive'
      )
      assert.strictEqual(fixture.db.listings.length, 2, '两套库存与首页数据必须保留在可提交 working DB')
      assert.strictEqual(
        (fixture.db.listings.find((item) => (
          item.feishuRecordId === deferredSourceRecordId
        )).mediaAssets || []).length,
        0,
        '延期失败行不得伪造已同步素材'
      )

      fixture.drive.downloadToken = originalDownloadToken
      const retryDry = await feishuSync.sync(
        clone(fixture.db),
        'A-CONFIRM',
        e2eSyncOptions(fixture, { dryRun: true, runId: `${FIXED_RUN_ID}-partial-retry-human` })
      )
      assert.strictEqual(retryDry.success, true, '下一轮素材恢复后必须重新进入完整计划')
      assert.strictEqual(retryDry.noteMaterials.contentPlanAssetCount, 2)
      const retryFormal = await feishuSync.sync(
        fixture.db,
        'A-CONFIRM',
        e2eSyncOptions(fixture, {
          runId: `${FIXED_RUN_ID}-partial-retry-formal`,
          expectedContentPlanSha256: retryDry.noteMaterials.contentPlanSha256,
          expectedContentAssetCount: retryDry.noteMaterials.contentPlanAssetCount
        })
      )
      assert.strictEqual(retryFormal.success, true)
      assert.strictEqual(retryFormal.inventoryCommittable, true)
      assert.strictEqual(
        fixture.driveWritesBySourceRecord.get(deferredSourceRecordId),
        1,
        '延期素材必须在下一轮恢复后自动补齐'
      )
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
    restoreObject(config.oss, previousOss)
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
  const cachedConfirmation = {
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
  const order = []
  const db = { marker: 'working-db', listings: [] }
  const prepared = await feishuSync._internal.prepareMirrorContentPlanConfirmation({
    db,
    adminId: 'A-CONFIRM',
    runId: FIXED_RUN_ID,
    nowMs: FIXED_NOW_MS,
    ...expected,
    loadCachedConfirmation: async () => cachedConfirmation,
    runPreflight: async (context) => {
      order.push('read-only-preflight')
      assert.strictEqual(context.db, db, '协调器必须绑定同一 working DB 快照')
      assert.strictEqual(context.runId, FIXED_RUN_ID)
      assert.strictEqual(context.nowMs, FIXED_NOW_MS)
      return {
        complete: true,
        failed: 0,
        dryRun: true,
        sourcesGloballyVerified: true,
        contentPlanSha256: expected.expectedContentPlanSha256,
        contentPlanAssetCount: expected.expectedContentAssetCount,
        privateConfirmation: cachedConfirmation
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
      loadCachedConfirmation: async () => cachedConfirmation,
      runPreflight: async () => ({
        complete: true,
        failed: 0,
        dryRun: true,
        sourcesGloballyVerified: true,
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
  assert.ok(routeBlock.includes('feishuSync.parseAdminSyncRequest(body, { externalWorkerRequest: true })'), '后台路由必须使用只接受 dryRun 的外部请求校验器')
  assert.ok(
    routeBlock.indexOf('feishuSync.parseAdminSyncRequest(body, { externalWorkerRequest: true })') < routeBlock.indexOf('feishuSyncWorker.enqueue'),
    '后台请求必须在持久化任务或开始任何飞书操作前完成字段 400 校验'
  )
  assert.ok(routeBlock.includes('startFeishuSyncWorkerProcess(queued.runId)'), '后台路由必须把持久化任务交给独立 worker')
  assert.ok(routeBlock.includes('}, 202)'), '后台路由必须立即返回 202，不能等待长同步完成')
  assert.ok(!routeBlock.includes('await feishuSync.sync'), '后台 HTTP 请求不得再直接等待同步')
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

function observeChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
      event: 'already-exited'
    })
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.once('error', (error) => finish({ error, event: 'error' }))
    child.once('exit', (code, signal) => finish({ code, signal, event: 'exit' }))
  })
}

function childExitDescription(result) {
  if (result && result.error) return result.error.message || String(result.error)
  const code = result && result.code
  const signal = result && result.signal
  return `code=${code === null || code === undefined ? 'null' : code}, signal=${signal || 'none'}`
}

async function waitForServer(baseUrl, childExit) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 12000) {
    const attempt = await Promise.race([
      request(baseUrl, 'GET', '/healthz')
        .then((response) => ({ type: 'health', response }))
        .catch(() => ({ type: 'retry' })),
      childExit.then((result) => ({ type: 'exit', result }))
    ])
    if (attempt.type === 'exit') {
      throw new Error(`后台确认门 HTTP 测试服务在就绪前退出：${childExitDescription(attempt.result)}`)
    }
    if (attempt.type === 'health' && attempt.response.statusCode === 200) return true
    const delay = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve({ type: 'retry' }), 120)),
      childExit.then((result) => ({ type: 'exit', result }))
    ])
    if (delay.type === 'exit') {
      throw new Error(`后台确认门 HTTP 测试服务在就绪前退出：${childExitDescription(delay.result)}`)
    }
  }
  return false
}

async function stopChild(child, childExit) {
  if (child.exitCode === null && child.signalCode === null) child.kill()
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ event: 'timeout' }), 5000)
  })
  const result = await Promise.race([childExit, timeout])
  if (timer) clearTimeout(timer)
  assert.notStrictEqual(result.event, 'timeout', '后台确认门 HTTP 测试服务必须在清理阶段退出')
}

async function testAdminHttp400(options = {}) {
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
  const server = spawn(process.execPath, options.serverArgs || ['src/index.js'], {
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
  const serverExit = observeChildExit(server)
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk.toString() })
  server.stderr.on('data', (chunk) => { output += chunk.toString() })
  try {
    assert.ok(await waitForServer(baseUrl, serverExit), `后台确认门 HTTP 测试服务未启动：${output}`)
    const login = await request(baseUrl, 'POST', '/admin/auth/login', {
      account: 'admin',
      password: 'admin123'
    })
    assert.strictEqual(login.statusCode, 200, '合成超管必须登录成功')
    const token = login.body && login.body.data && login.body.data.token
    assert.ok(token, '超管登录必须返回 token')
    const auth = { Authorization: `Bearer ${token}` }
    const dataAfterLogin = fs.readFileSync(dataFile, 'utf8')
    for (const body of [
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
      },
      {
        dryRun: true,
        noteMaterialOss: {}
      },
      {
        dryRun: true,
        noteMaterialDrive: {}
      },
      {
        dryRun: true,
        sourceClient: {}
      },
      {
        dryRun: true,
        targetClient: {}
      },
      {
        dryRun: true,
        feishuToken: 'synthetic-http-injection'
      },
      {
        dryRun: true,
        _captureContentPlanConfirmation: {}
      },
      {
        dryRun: true,
        privateMappings: {}
      },
      {
        dryRun: true,
        client_supplied_sensitive_marker: {}
      },
      {
        dryRun: true,
        runId: '含中文的运行标识'
      },
      {
        dryRun: true,
        nowMs: '123'
      }
    ]) {
      const response = await request(baseUrl, 'POST', '/admin/feishu-sync/run', body, auth)
      assert.strictEqual(response.statusCode, 400, `非法正式同步确认必须真实返回 HTTP 400：${JSON.stringify(body)}`)
      const responseText = JSON.stringify(response.body)
      assert.ok(!responseText.includes('synthetic-note-confirm-admin-secret'), 'HTTP 400 响应不得泄露服务端密钥')
      assert.ok(!responseText.includes('tokenVideoConfirmAlpha123'), 'HTTP 400 响应不得泄露素材 token')
      assert.ok(
        !responseText.includes('client_supplied_sensitive_marker'),
        'HTTP 400 固定错误文案不得反射任意客户端字段名'
      )
    }
    const dryResponse = await request(baseUrl, 'POST', '/admin/feishu-sync/run', { dryRun: 'true' }, auth)
    assert.strictEqual(dryResponse.statusCode, 400, 'dryRun 错型仍必须真实返回 HTTP 400')
    assert.strictEqual(
      fs.readFileSync(dataFile, 'utf8'),
      dataAfterLogin,
      '全部非法 HTTP 注入必须在任何数据库写入前 400'
    )
  } finally {
    await stopChild(server, serverExit)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function runConfirmationScope(scope) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        FEISHU_NOTE_CONFIRM_TEST_SCOPE: scope
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

async function testHttpHarnessLifecycleBehavior() {
  const earlyExit = await runConfirmationScope('http-server-exit-probe')
  assert.notStrictEqual(earlyExit.code, 0, 'HTTP 入口子服务立即 exit(1) 时测试进程必须非 0')
  assert.ok(
    /在就绪前退出|code=1/.test(`${earlyExit.stdout}\n${earlyExit.stderr}`),
    'HTTP 入口子服务立即退出时必须输出可诊断的失败原因'
  )

  const healthy = await runConfirmationScope('http')
  assert.strictEqual(
    healthy.code,
    0,
    `HTTP 入口正常服务必须完整成功：${healthy.stdout}\n${healthy.stderr}`
  )
  assert.ok(
    healthy.stdout.includes('feishu-note-material-confirmation-v1-test http scope passed'),
    'HTTP 入口正常服务必须完整输出 passed'
  )
}

async function testDeferredMaterialActionsAreBoundAndApplied() {
  const records = [
    {
      sourceRecordId: 'source-record-action-clear',
      folderToken: 'folderActionClear123',
      assetToken: 'tokenActionClear123',
      body: Buffer.from('action-clear-source'),
      mimeType: 'video/mp4'
    },
    {
      sourceRecordId: 'source-record-action-retain',
      folderToken: 'folderActionRetain123',
      assetToken: 'tokenActionRetain123',
      body: Buffer.from('action-retain-source'),
      mimeType: 'video/mp4'
    },
    {
      sourceRecordId: 'source-record-action-good',
      folderToken: 'folderActionGood123',
      assetToken: 'tokenActionGood123',
      body: Buffer.from('action-good-source'),
      mimeType: 'video/mp4'
    }
  ]
  function createActionPrepareMaterial() {
    const base = createFakePrepareMaterial()
    const prepare = async (input) => {
      const token = input && input.asset && input.asset.sourceToken
      if (token === 'tokenActionClear123') {
        const error = new Error('合成确定性格式失败')
        error.statusCode = 422
        throw error
      }
      if (token === 'tokenActionRetain123') {
        const error = new Error('合成临时下载超时')
        error.code = 'ETIMEDOUT'
        throw error
      }
      return base(input)
    }
    prepare.profile = { ...base.profile }
    return prepare
  }
  function seedExistingMaterials(fixture) {
    for (const [sourceRecordId, folderToken, sameLink] of [
      ['source-record-action-clear', 'folderActionClear123', false],
      ['source-record-action-retain', 'folderActionRetain123', true]
    ]) {
      const current = fixture.db.listings.find((item) => item.feishuRecordId === sourceRecordId)
      const asset = {
        assetId: `MAT-${sha256(`${sourceRecordId}-old`).slice(0, 32)}`,
        kind: 'video',
        objectKey: `house-videos/feishu-note-v1/${sourceRecordId}/old.mp4`,
        contentSha256: sha256(`${sourceRecordId}-old-content`),
        sourceFingerprint: sha256(`${sourceRecordId}-old-source`),
        targetDriveFingerprint: sha256(`${sourceRecordId}-old-drive`),
        displayOrder: 0,
        mimeType: 'video/mp4',
        size: 16,
        verified: true
      }
      const physicalFingerprint = sha256([
        current.district,
        current.block || current.area,
        current.community,
        current.building,
        current.unit,
        current.roomNumber
      ].join('\n'))
      current.mediaAssets = [asset]
      current.videoKey = asset.objectKey
      current.noteMaterialState = {
        sourceLinkFingerprint: sameLink
          ? sha256(`https://${HOST}/drive/folder/${folderToken}`)
          : sha256('different-source-link'),
        physicalUnitFingerprint: physicalFingerprint,
        status: 'verified',
        updatedAt: '2026-07-27T00:00:00.000Z'
      }
    }
  }

  const dryFixture = inventoryFixture({ records, prepareMaterial: createActionPrepareMaterial() })
  seedExistingMaterials(dryFixture)
  const dry = await runInventory(dryFixture, { dryRun: true })
  assert.strictEqual(dry.complete, false)
  assert.strictEqual(dry.failed, 2)
  assert.strictEqual(dry.contentPlanAssetCount, 1, '正常行仍须进入可确认素材计划')
  const dryRows = new Map(dry.rows.map((row) => [row.sourceRecordId, row]))
  assert.strictEqual(dryRows.get('source-record-action-clear').deferredAction, 'clear')
  assert.strictEqual(dryRows.get('source-record-action-retain').deferredAction, 'retain')
  assert.strictEqual(dryRows.get('source-record-action-good').status, 'planned')
  const confirmation = confirmationFromReport(dry)

  const formalFixture = inventoryFixture({ records, prepareMaterial: createActionPrepareMaterial() })
  seedExistingMaterials(formalFixture)
  const formal = await runInventory(formalFixture, {
    dryRun: false,
    contentPlanConfirmationRequired: true,
    ...confirmation
  })
  assert.strictEqual(formal.complete, false)
  assert.strictEqual(formal.failed, 2)
  const cleared = formalFixture.db.listings.find((item) => (
    item.feishuRecordId === 'source-record-action-clear'
  ))
  const retained = formalFixture.db.listings.find((item) => (
    item.feishuRecordId === 'source-record-action-retain'
  ))
  const published = formalFixture.db.listings.find((item) => (
    item.feishuRecordId === 'source-record-action-good'
  ))
  assert.deepStrictEqual(cleared.mediaAssets, [], '链接变化或确定性失败必须清空旧笔记素材')
  assert.strictEqual(cleared.videoKey, '')
  assert.strictEqual(retained.mediaAssets.length, 1, '同链接同房间的临时失败必须保留已验证素材')
  assert.strictEqual(retained.noteMaterialState.status, 'retained-temporary-failure')
  assert.strictEqual(published.mediaAssets.length, 1, '正常素材行仍须发布')
  assert.strictEqual(formalFixture.calls.driveWrite, 1, '延期行不得产生 Drive 写，仅正常行写一次')
  assert.strictEqual(formalFixture.calls.ossWrite, 1, '延期行不得产生 OSS 写，仅正常行写一次')

  const driftFixture = inventoryFixture({ records, prepareMaterial: createActionPrepareMaterial() })
  seedExistingMaterials(driftFixture)
  driftFixture.db.listings.find((item) => (
    item.feishuRecordId === 'source-record-action-retain'
  )).noteMaterialState.sourceLinkFingerprint = sha256('changed-after-dry')
  const beforeDriftApply = JSON.stringify(driftFixture.db)
  await assert.rejects(
    () => runInventory(driftFixture, {
      dryRun: false,
      contentPlanConfirmationRequired: true,
      ...confirmation
    }),
    (error) => error && error.code === 'CONTENT_PLAN_CONFIRMATION_FAILED',
    'dry 后仅变更 noteMaterialState 链接也必须在本地处置前阻断'
  )
  assert.strictEqual(writeCount(driftFixture.calls), 0)
  assert.strictEqual(JSON.stringify(driftFixture.db), beforeDriftApply)
}

async function main() {
  if (process.env.FEISHU_NOTE_CONFIRM_TEST_SCOPE === 'sync') {
    await testActualFeishuSyncEndToEndGate()
    console.log('feishu-note-material-confirmation-v1-test sync scope passed')
    return
  }
  if (process.env.FEISHU_NOTE_CONFIRM_TEST_SCOPE === 'http') {
    await testAdminHttp400()
    console.log('feishu-note-material-confirmation-v1-test http scope passed')
    return
  }
  if (process.env.FEISHU_NOTE_CONFIRM_TEST_SCOPE === 'http-server-exit-probe') {
    await testAdminHttp400({ serverArgs: ['-e', 'process.exit(1)'] })
    throw new Error('HTTP 子服务立即退出探针不得到达成功分支')
  }
  await testParserAndScheduledGate()
  await testInventoryConfirmationBehavior()
  await testNormalizedContentConfirmationBehavior()
  await testDeferredMaterialActionsAreBoundAndApplied()
  await testActualFeishuSyncEndToEndGate()
  await testReadOnlyPreflightOrder()
  await testHttpHarnessLifecycleBehavior()
  console.log('feishu-note-material-confirmation-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
