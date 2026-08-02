'use strict'

const assert = require('assert')
const crypto = require('crypto')
const config = require('../src/config')
const domain = require('../src/domain')
const feishuSync = require('../src/feishu-sync')
const noteMaterial = require('../src/feishu-note-material-sync')

const HOST = 'tenant.example'
const ROOT = 'fldTargetRoot123456'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sourceAsset(token, sourceOrder, overrides = {}) {
  return {
    sourceToken: token,
    sourceKind: 'drive-file',
    name: `${token}.mp4`,
    extension: 'mp4',
    mimeType: 'video/mp4',
    sourceOrder,
    sourceFingerprint: sha256(`metadata:${token}`),
    ...overrides
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
  return async ({ asset, sourceEvidence }) => {
    if (Array.isArray(options.calls)) {
      options.calls.push({
        sourceToken: asset && asset.sourceToken,
        sourceContentSha256: sourceEvidence && sourceEvidence.contentSha256
      })
    }
    const outputBuffer = Buffer.isBuffer(options.outputBuffer)
      ? Buffer.from(options.outputBuffer)
      : Buffer.concat([Buffer.from('normalized:'), sourceEvidence.buffer])
    const outputMimeType = options.outputMimeType || 'video/mp4'
    const transformProfileSha256 = Object.prototype.hasOwnProperty.call(options, 'transformProfileSha256')
      ? options.transformProfileSha256
      : sha256('fake-transform-profile-v1')
    return {
      buffer: outputBuffer,
      kind: 'video',
      extension: 'mp4',
      sourceContentSha256: sourceEvidence.contentSha256,
      sourceSize: sourceEvidence.size,
      sourceMimeType: sourceEvidence.contentType,
      contentSha256: sha256(outputBuffer),
      size: outputBuffer.length,
      contentType: outputMimeType,
      mimeType: outputMimeType,
      transformProfileVersion: options.transformProfileVersion || 'feishu-note-serving-v1',
      transformProfileSha256,
      transformToolFingerprint: options.transformToolFingerprint || sha256('fake-ffmpeg-tool-v1'),
      transformAction: options.transformAction || 'transcode'
    }
  }
}

async function directPlan(options = {}) {
  const bodies = options.bodies || new Map([
    ['tokenVideoAlpha123', Buffer.from('alpha-content-v1')],
    ['tokenVideoBeta1234', Buffer.from('beta-content-v1')]
  ])
  const mimeTypes = options.mimeTypes || new Map()
  const assets = options.assets || [
    sourceAsset('tokenVideoAlpha123', 0),
    sourceAsset('tokenVideoBeta1234', 1)
  ]
  const drive = {
    async downloadToken(token) {
      if (!bodies.has(token)) throw new Error('合成源内容缺失')
      return downloadEvidence(bodies.get(token), mimeTypes.get(token) || 'video/mp4')
    },
    async ensureListingFolder() {
      return { token: 'fldListingTarget123' }
    },
    async materializeVideo(input) {
      return {
        targetToken: `target-${input.asset.sourceToken}`,
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
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    }
  }
  return noteMaterial.syncNoteMaterialVideos({
    sourceRecordId: options.sourceRecordId || 'source-record-private-alpha',
    assets,
    uploadDir: 'house-videos',
    drive,
    oss,
    prepareMaterial: options.prepareMaterial,
    dryRun: options.dryRun !== false
  })
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

function inventoryFixture(options = {}) {
  const records = options.records || [
    {
      sourceRecordId: 'source-record-private-alpha',
      folderToken: 'folderSourceAlpha123',
      assetToken: 'tokenVideoAlpha123',
      name: 'A.mp4',
      body: Buffer.from('alpha-content-v1'),
      mimeType: 'video/mp4'
    },
    {
      sourceRecordId: 'source-record-private-beta',
      folderToken: 'folderSourceBeta1234',
      assetToken: 'tokenVideoBeta1234',
      name: 'B.mp4',
      body: Buffer.from('beta-content-v1'),
      mimeType: 'video/mp4'
    }
  ]
  const byFolder = new Map(records.map((record) => [record.folderToken, record]))
  const byAsset = new Map(records.map((record) => [record.assetToken, record]))
  const db = { users: [], listings: records.map((record) => listing(record.sourceRecordId)) }
  const writes = []
  const drive = {
    async listFolder(folderToken) {
      const record = byFolder.get(folderToken)
      if (!record) throw new Error('合成目录不存在')
      return [{
        token: record.assetToken,
        name: record.name,
        type: record.mimeType,
        size: record.body.length,
        modifiedTime: '1'
      }]
    },
    async downloadToken(assetToken) {
      const record = byAsset.get(assetToken)
      if (!record) throw new Error('合成素材不存在')
      if (options.downloadFailureToken === assetToken) {
        const error = new Error('合成受限下载失败')
        error.statusCode = 503
        throw error
      }
      return downloadEvidence(record.body, record.mimeType)
    },
    async ensureListingFolder(input) {
      writes.push(['folder', input.sourceRecordId])
      return { token: `target-folder-${sha256(input.sourceRecordId).slice(0, 12)}` }
    },
    async materializeVideo(input) {
      writes.push(['drive', input.asset.sourceToken])
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
      writes.push(['oss', input.contentSha256])
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    }
  }
  return {
    db,
    drive,
    oss,
    writes,
    sourceRows: records.map((record) => ({
      sourceRecordId: record.sourceRecordId,
      value: `https://${HOST}/drive/folder/${record.folderToken}`
    }))
  }
}

async function inventoryPlan(options = {}) {
  const fixture = inventoryFixture(options)
  const result = await noteMaterial.syncNoteMaterialsForInventory({
    db: fixture.db,
    sourceRows: options.reverseRows === true
      ? fixture.sourceRows.slice().reverse()
      : fixture.sourceRows,
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: fixture.drive,
    oss: fixture.oss,
    prepareMaterial: options.prepareMaterial,
    dryRun: options.dryRun !== false,
    nowText: '2026-07-27T00:00:00.000Z'
  })
  return { ...fixture, result }
}

function safeSummary(result) {
  return {
    contentPlanSha256: result.contentPlanSha256,
    contentPlanAssetCount: result.contentPlanAssetCount
  }
}

async function run() {
  assert.strictEqual(
    typeof noteMaterial._internal.buildContentPlanSummary,
    'function',
    '必须提供真实业务共用的内容计划摘要构造器'
  )

  const first = await directPlan()
  assert.match(first.contentPlanSha256, /^[0-9a-f]{64}$/, '单房源 dry-run 必须返回 64 位内容计划摘要')
  assert.strictEqual(first.contentPlanAssetCount, 2, '单房源摘要数量必须等于真实下载素材数')

  const changedSameSize = await directPlan({
    bodies: new Map([
      ['tokenVideoAlpha123', Buffer.from('alpha-content-v2')],
      ['tokenVideoBeta1234', Buffer.from('beta-content-v1')]
    ])
  })
  assert.notStrictEqual(
    changedSameSize.contentPlanSha256,
    first.contentPlanSha256,
    '同一 token 与相同字节数原位换内容时计划摘要必须变化'
  )

  const reorderedInput = await directPlan({
    assets: [
      sourceAsset('tokenVideoBeta1234', 1),
      sourceAsset('tokenVideoAlpha123', 0)
    ]
  })
  assert.strictEqual(
    reorderedInput.contentPlanSha256,
    first.contentPlanSha256,
    '原始数组顺序变化但稳定展示顺序不变时摘要必须一致'
  )

  const changedMime = await directPlan({
    mimeTypes: new Map([['tokenVideoAlpha123', 'video/quicktime']])
  })
  assert.notStrictEqual(changedMime.contentPlanSha256, first.contentPlanSha256, '真实 MIME 类型变化必须改变摘要')

  const changedOrder = await directPlan({
    assets: [
      sourceAsset('tokenVideoAlpha123', 1),
      sourceAsset('tokenVideoBeta1234', 0)
    ]
  })
  assert.notStrictEqual(changedOrder.contentPlanSha256, first.contentPlanSha256, '展示顺序变化必须改变摘要')

  const changedOwner = await directPlan({ sourceRecordId: 'source-record-private-other' })
  assert.notStrictEqual(changedOwner.contentPlanSha256, first.contentPlanSha256, '源记录归属变化必须改变摘要')

  const buildSummary = noteMaterial._internal.buildContentPlanSummary
  const evidence = [{
    sourceRecordFingerprint: sha256('private-owner-a'),
    assetId: 'MAT-11111111111111111111111111111111',
    sourceContentSha256: sha256('source-content'),
    sourceSize: 18,
    sourceMimeType: 'video/quicktime',
    contentSha256: sha256('same-content'),
    size: 12,
    mimeType: 'video/mp4',
    transformProfileVersion: 'feishu-note-serving-v1',
    transformProfileSha256: sha256('fake-transform-profile-v1'),
    transformToolFingerprint: sha256('fake-ffmpeg-tool-v1'),
    transformAction: 'transcode',
    displayOrder: 0
  }]
  const baseEvidenceSummary = buildSummary(evidence)
  const dimensions = [
    ['sourceContentSha256', sha256('changed-source-content')],
    ['sourceSize', 19],
    ['sourceMimeType', 'video/webm'],
    ['contentSha256', sha256('changed-content')],
    ['size', 13],
    ['mimeType', 'video/quicktime'],
    ['transformProfileVersion', 'feishu-note-serving-v2'],
    ['transformProfileSha256', sha256('fake-transform-profile-v2')],
    ['transformToolFingerprint', sha256('fake-ffmpeg-tool-v2')],
    ['transformAction', 'compress'],
    ['displayOrder', 1],
    ['sourceRecordFingerprint', sha256('private-owner-b')],
    ['assetId', 'MAT-22222222222222222222222222222222']
  ]
  dimensions.forEach(([field, value]) => {
    const changed = buildSummary([{ ...evidence[0], [field]: value }])
    assert.notStrictEqual(changed.contentPlanSha256, baseEvidenceSummary.contentPlanSha256, `${field} 必须进入摘要`)
  })
  assert.strictEqual(
    buildSummary([evidence[0], { ...evidence[0], assetId: 'MAT-33333333333333333333333333333333', displayOrder: 1 }]).contentPlanSha256,
    buildSummary([{ ...evidence[0], assetId: 'MAT-33333333333333333333333333333333', displayOrder: 1 }, evidence[0]]).contentPlanSha256,
    '内容证据输入顺序不得影响排序摘要'
  )

  const prepareCalls = []
  const normalizedPlan = await inventoryPlan({
    records: [{
      sourceRecordId: 'source-record-private-alpha',
      folderToken: 'folderSourceAlpha123',
      assetToken: 'tokenVideoAlpha123',
      name: 'A.mov',
      body: Buffer.from('raw-source-before-normalization'),
      mimeType: 'video/quicktime'
    }],
    prepareMaterial: createFakePrepareMaterial({ calls: prepareCalls })
  })
  const missingProfileDigestEvidence = { ...evidence[0] }
  delete missingProfileDigestEvidence.transformProfileSha256
  for (const [label, invalidEvidence] of [
    ['缺失', missingProfileDigestEvidence],
    ['空值', { ...evidence[0], transformProfileSha256: '' }],
    ['非十六进制', { ...evidence[0], transformProfileSha256: 'g'.repeat(64) }],
    ['大写十六进制', { ...evidence[0], transformProfileSha256: 'A'.repeat(64) }],
    ['错误长度', { ...evidence[0], transformProfileSha256: 'a'.repeat(63) }]
  ]) {
    assert.throws(
      () => buildSummary([invalidEvidence]),
      `${label} transformProfileSha256 必须 fail-closed`
    )
  }
  const normalizedConfirmation = noteMaterial._internal.contentPlanConfirmationFromReport(
    normalizedPlan.result
  )
  const normalizedEvidence = normalizedConfirmation.expectedContentPlanEvidence[0]
  const expectedSource = downloadEvidence(
    Buffer.from('raw-source-before-normalization'),
    'video/quicktime'
  )
  const expectedOutput = Buffer.concat([Buffer.from('normalized:'), expectedSource.buffer])
  assert.deepStrictEqual({
    prepareCalls: prepareCalls.length,
    sourceContentSha256: normalizedEvidence.sourceContentSha256,
    sourceSize: normalizedEvidence.sourceSize,
    sourceMimeType: normalizedEvidence.sourceMimeType,
    contentSha256: normalizedEvidence.contentSha256,
    size: normalizedEvidence.size,
    mimeType: normalizedEvidence.mimeType,
    transformProfileVersion: normalizedEvidence.transformProfileVersion,
    transformProfileSha256: normalizedEvidence.transformProfileSha256,
    transformToolFingerprint: normalizedEvidence.transformToolFingerprint,
    transformAction: normalizedEvidence.transformAction
  }, {
    prepareCalls: 1,
    sourceContentSha256: expectedSource.contentSha256,
    sourceSize: expectedSource.size,
    sourceMimeType: expectedSource.contentType,
    contentSha256: sha256(expectedOutput),
    size: expectedOutput.length,
    mimeType: 'video/mp4',
    transformProfileVersion: 'feishu-note-serving-v1',
    transformProfileSha256: sha256('fake-transform-profile-v1'),
    transformToolFingerprint: sha256('fake-ffmpeg-tool-v1'),
    transformAction: 'transcode'
  }, 'dry-run 的私有内容计划必须同时绑定源文件、最终归一化产物及转换身份')

  const normalizedDirectBase = await directPlan({
    assets: [sourceAsset('tokenVideoAlpha123', 0)],
    prepareMaterial: createFakePrepareMaterial()
  })
  const normalizedOutputChanged = await directPlan({
    assets: [sourceAsset('tokenVideoAlpha123', 0)],
    prepareMaterial: createFakePrepareMaterial({ outputBuffer: Buffer.from('normalized-output-v2') })
  })
  const normalizedProfileChanged = await directPlan({
    assets: [sourceAsset('tokenVideoAlpha123', 0)],
    prepareMaterial: createFakePrepareMaterial({ transformProfileVersion: 'feishu-note-serving-v2' })
  })
  const normalizedProfileDigestChanged = await directPlan({
    assets: [sourceAsset('tokenVideoAlpha123', 0)],
    prepareMaterial: createFakePrepareMaterial({ transformProfileSha256: sha256('fake-transform-profile-v2') })
  })
  assert.notStrictEqual(
    normalizedOutputChanged.contentPlanSha256,
    normalizedDirectBase.contentPlanSha256,
    '归一化输出字节变化必须改变内容计划摘要'
  )
  assert.notStrictEqual(
    normalizedProfileChanged.contentPlanSha256,
    normalizedDirectBase.contentPlanSha256,
    '归一化 profile 变化必须改变内容计划摘要'
  )
  assert.notStrictEqual(
    normalizedProfileDigestChanged.contentPlanSha256,
    normalizedDirectBase.contentPlanSha256,
    '完整转换参数规则摘要变化必须改变私有内容计划摘要'
  )

  const normalizedAggregateBase = await inventoryPlan({
    records: [{
      sourceRecordId: 'source-record-private-alpha',
      folderToken: 'folderSourceAlpha123',
      assetToken: 'tokenVideoAlpha123',
      name: 'A.mov',
      body: Buffer.from('raw-source-before-normalization'),
      mimeType: 'video/quicktime'
    }],
    prepareMaterial: createFakePrepareMaterial()
  })
  const normalizedAggregateProfileChanged = await inventoryPlan({
    records: [{
      sourceRecordId: 'source-record-private-alpha',
      folderToken: 'folderSourceAlpha123',
      assetToken: 'tokenVideoAlpha123',
      name: 'A.mov',
      body: Buffer.from('raw-source-before-normalization'),
      mimeType: 'video/quicktime'
    }],
    prepareMaterial: createFakePrepareMaterial({ transformProfileSha256: sha256('fake-transform-profile-v2') })
  })
  assert.notStrictEqual(
    normalizedAggregateProfileChanged.result.contentPlanSha256,
    normalizedAggregateBase.result.contentPlanSha256,
    '完整转换参数规则摘要变化必须改变多房源聚合内容计划摘要'
  )

  const aggregate = await inventoryPlan()
  const aggregateReordered = await inventoryPlan({ reverseRows: true })
  assert.strictEqual(aggregate.result.complete, true)
  assert.strictEqual(aggregate.result.dryRun, true)
  assert.match(aggregate.result.contentPlanSha256, /^[0-9a-f]{64}$/)
  assert.strictEqual(aggregate.result.contentPlanAssetCount, 2)
  assert.deepStrictEqual(
    safeSummary(aggregateReordered.result),
    safeSummary(aggregate.result),
    '聚合摘要不得受源记录输入顺序影响'
  )
  assert.strictEqual(aggregate.writes.length, 0, '内容计划 dry-run 必须保持 Drive/OSS/数据库零写')

  const applied = await inventoryPlan({ dryRun: false })
  assert.strictEqual(applied.result.complete, true)
  assert.strictEqual(applied.result.published, true)
  assert.deepStrictEqual(
    safeSummary(applied.result),
    safeSummary(aggregate.result),
    '同一真实内容的 dry-run 与正式 apply 必须返回相同摘要'
  )
  applied.db.listings.forEach((item) => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(item, 'contentPlanSha256'),
      false,
      '聚合内容计划不得持久化到房源'
    )
    assert.ok(
      !JSON.stringify(item.noteMaterialState || {}).includes('contentPlan'),
      '聚合内容计划不得写入房源笔记私有状态'
    )
  })

  let mimeReadCount = 0
  let writesAfterMimeChange = 0
  await assert.rejects(
    () => noteMaterial.syncNoteMaterialVideos({
      sourceRecordId: 'source-record-mime-changing',
      assets: [sourceAsset('tokenMimeChanging123', 0)],
      uploadDir: 'house-videos',
      drive: {
        async downloadToken() {
          mimeReadCount += 1
          return downloadEvidence(
            Buffer.from('same-bytes-across-mime-change'),
            mimeReadCount === 1 ? 'video/mp4' : 'video/quicktime'
          )
        },
        async ensureListingFolder() {
          writesAfterMimeChange += 1
          return { token: 'should-not-create-folder' }
        },
        async materializeVideo() {
          writesAfterMimeChange += 1
          throw new Error('MIME 变化后不得物化')
        }
      },
      oss: {
        async putVideoDeterministic() {
          writesAfterMimeChange += 1
          throw new Error('MIME 变化后不得写 OSS')
        }
      }
    }),
    /源素材在同步计划执行前发生变化/,
    '正式写入前 MIME 变化必须由既有全批变化门禁阻断'
  )
  assert.strictEqual(mimeReadCount, 2, 'MIME 变化必须在第二遍全批预检被发现')
  assert.strictEqual(writesAfterMimeChange, 0, 'MIME 变化不得产生 Drive/OSS 外部写入')

  const empty = await noteMaterial.syncNoteMaterialsForInventory({
    db: { listings: [] },
    sourceRows: [],
    dryRun: true
  })
  const emptyAgain = await noteMaterial.syncNoteMaterialsForInventory({
    db: { listings: [] },
    sourceRows: [],
    dryRun: true
  })
  assert.strictEqual(empty.complete, true)
  assert.strictEqual(empty.contentPlanAssetCount, 0)
  assert.match(empty.contentPlanSha256, /^[0-9a-f]{64}$/)
  assert.deepStrictEqual(safeSummary(emptyAgain), safeSummary(empty), '零素材必须返回确定且稳定的摘要')

  const previousNoteMaterialEnabled = config.feishu.noteMaterialSyncEnabled
  const previousSourceCompatibilityProfile = config.feishu.sourceCompatibilityProfile
  let wiredEmpty
  try {
    config.feishu.noteMaterialSyncEnabled = true
    config.feishu.sourceCompatibilityProfile = 'employee-current-stock-v1'
    wiredEmpty = await feishuSync._internal.syncMirrorNoteMaterials(
      { listings: [] },
      { sourceNoteMaterials: [] },
      { dryRun: true }
    )
  } finally {
    config.feishu.noteMaterialSyncEnabled = previousNoteMaterialEnabled
    config.feishu.sourceCompatibilityProfile = previousSourceCompatibilityProfile
  }
  assert.deepStrictEqual(
    safeSummary(wiredEmpty),
    safeSummary(empty),
    '生产镜像接线在已启用但零素材时也必须返回同一个确定空计划摘要'
  )

  const failed = await inventoryPlan({ downloadFailureToken: 'tokenVideoAlpha123' })
  assert.strictEqual(failed.result.complete, false)
  assert.strictEqual(failed.result.failed, 1)
  assert.match(
    failed.result.contentPlanSha256,
    /^[0-9a-f]{64}$/,
    '已知逐行素材失败必须返回包含延期证据的确定计划摘要'
  )
  assert.strictEqual(failed.result.contentPlanAssetCount, 1, '素材数量只统计本轮已完成验证的素材')
  assert.strictEqual(failed.result.contentPlanDeferredCount, 1, '失败房源必须进入延期证据而不是伪装成功')

  const sensitiveValues = [
    'source-record-private-alpha',
    'tokenVideoAlpha123',
    'folderSourceAlpha123',
    ROOT,
    `https://${HOST}/drive/folder/folderSourceAlpha123`,
    'house-videos/feishu-note-v1/'
  ]
  const serializedSummary = JSON.stringify(safeSummary(aggregate.result))
  sensitiveValues.forEach((value) => {
    assert.ok(!serializedSummary.includes(value), `计划摘要不得暴露敏感值：${value}`)
  })
  assert.ok(!serializedSummary.includes('Buffer'), '计划摘要不得暴露 Buffer')

  const publicListing = {
    ...listing('public-safe-record'),
    contentPlanSha256: aggregate.result.contentPlanSha256,
    contentPlanAssetCount: aggregate.result.contentPlanAssetCount,
    noteMaterialState: {
      contentPlanSha256: aggregate.result.contentPlanSha256,
      sourceRecordId: 'source-record-private-alpha',
      sourceToken: 'tokenVideoAlpha123'
    }
  }
  const publicProjection = domain.formatHomeListing({ users: [] }, publicListing, { publicGuest: true })
  const publicText = JSON.stringify(publicProjection)
  assert.ok(!publicText.includes('contentPlan'), '公开房源投影不得出现私有内容计划字段')
  assert.ok(!publicText.includes('source-record-private-alpha'), '公开房源投影不得出现源记录 ID')
  assert.ok(!publicText.includes('tokenVideoAlpha123'), '公开房源投影不得出现源 token')

  const capturedLogs = []
  const originalConsole = { log: console.log, warn: console.warn, error: console.error }
  try {
    console.log = (...args) => capturedLogs.push(args.join(' '))
    console.warn = (...args) => capturedLogs.push(args.join(' '))
    console.error = (...args) => capturedLogs.push(args.join(' '))
    await inventoryPlan()
  } finally {
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    console.error = originalConsole.error
  }
  const loggedText = capturedLogs.join('\n')
  sensitiveValues.forEach((value) => {
    assert.ok(!loggedText.includes(value), `素材计划日志不得泄露敏感值：${value}`)
  })

  const persistedLogDb = { feishuSyncLogs: [{}] }
  feishuSync._internal.recordMirrorSyncOutcome(persistedLogDb, {
    success: true,
    status: 'success',
    inventoryCommittable: false,
    inventoryPublished: false,
    noteMaterials: aggregate.result
  })
  const persistedNoteLog = persistedLogDb.feishuSyncLogs[0].noteMaterials
  assert.ok(persistedNoteLog && persistedNoteLog.complete === true, '同步日志应保留非敏感完成状态')
  assert.ok(
    !JSON.stringify(persistedNoteLog).includes('contentPlan'),
    '持久同步日志不得记录可跨轮关联的私有内容计划摘要'
  )

  console.log('feishu-note-material-content-plan-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
