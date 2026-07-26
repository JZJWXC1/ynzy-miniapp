'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')
const path = require('path')
const crypto = require('crypto')
const { createBitableClient } = require('../src/feishu-bitable-client')
const { createFeishuNoteMaterialClient } = require('../src/feishu-note-material-client')
const config = require('../src/config')
const domain = require('../src/domain')
const feishuSync = require('../src/feishu-sync')
const {
  syncNoteMaterialVideos,
  syncNoteMaterialsForInventory
} = require('../src/feishu-note-material-sync')

function readMaterialConfigInChild(envPatch = {}) {
  const childEnv = { ...process.env, ...envPatch }
  delete childEnv.FEISHU_NOTE_MATERIAL_SYNC_ENABLED
  delete childEnv.FEISHU_NOTE_MATERIAL_TARGET_ROOT_FOLDER_TOKEN
  if (Object.prototype.hasOwnProperty.call(envPatch, 'FEISHU_NOTE_MATERIAL_SYNC_ENABLED')) {
    childEnv.FEISHU_NOTE_MATERIAL_SYNC_ENABLED = envPatch.FEISHU_NOTE_MATERIAL_SYNC_ENABLED
  }
  if (Object.prototype.hasOwnProperty.call(envPatch, 'FEISHU_NOTE_MATERIAL_TARGET_ROOT_FOLDER_TOKEN')) {
    childEnv.FEISHU_NOTE_MATERIAL_TARGET_ROOT_FOLDER_TOKEN = envPatch.FEISHU_NOTE_MATERIAL_TARGET_ROOT_FOLDER_TOKEN
  }
  const configPath = path.resolve(__dirname, '..', 'src', 'config.js')
  const child = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({
      enabled: config.feishu.noteMaterialSyncEnabled,
      targetRoot: config.feishu.noteMaterialTargetRootFolderToken
    }))
  `], {
    cwd: path.resolve(__dirname, '..'),
    env: childEnv,
    encoding: 'utf8'
  })
  assert.strictEqual(child.status, 0, '素材配置子进程必须可读取')
  return JSON.parse(child.stdout)
}

function testMaterialSyncRequiresExplicitOptIn() {
  const defaultConfig = readMaterialConfigInChild({
    FEISHU_MATERIAL_FOLDER_TOKEN: 'legacyMaterialFolder123'
  })
  assert.strictEqual(defaultConfig.enabled, false, '新素材写链路必须默认关闭，首次 dry-run 前不得被自动同步触发')
  assert.strictEqual(defaultConfig.targetRoot, '', '新素材链路不得静默借用旧素材目录，必须配置独立目标根目录')

  const explicitConfig = readMaterialConfigInChild({
    FEISHU_MATERIAL_FOLDER_TOKEN: 'legacyMaterialFolder123',
    FEISHU_NOTE_MATERIAL_SYNC_ENABLED: 'true',
    FEISHU_NOTE_MATERIAL_TARGET_ROOT_FOLDER_TOKEN: 'noteMaterialRoot123'
  })
  assert.strictEqual(explicitConfig.enabled, true, '明确开启后素材链路才可进入正式同步')
  assert.strictEqual(explicitConfig.targetRoot, 'noteMaterialRoot123', '明确的新素材目标目录必须原样生效')
}

const HOST = 'ccn9urs7d60k.feishu.cn'
const ROOT = 'fldTargetRoot123'

function testStableSourceFieldContract() {
  assert.strictEqual(config.feishu.noteMaterialFieldId, 'fldyeAGJHV')
  const bindings = feishuSync._internal.sourceBindingsWithNoteMaterial({
    community: { fieldId: 'fldCommunity123' }
  }, {
    enabled: true,
    fieldId: config.feishu.noteMaterialFieldId
  })
  assert.deepStrictEqual(bindings.noteMaterialLink, {
    fieldId: 'fldyeAGJHV',
    type: 15,
    required: false
  })
  assert.strictEqual(
    feishuSync._internal.sourceBindingsWithNoteMaterial({}, { enabled: false }).noteMaterialLink,
    undefined
  )
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data }
    }
  }
}

function bufferResponse(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-length') return String(buffer.length)
        if (String(name).toLowerCase() === 'content-type') return 'video/mp4'
        return ''
      }
    },
    body: {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true }
            sent = true
            return { done: false, value: buffer }
          },
          async cancel() {}
        }
      }
    }
  }
}

async function testSourceClientHardReadOnly() {
  let fetchCount = 0
  const client = createBitableClient({
    fetchImpl: async () => {
      fetchCount += 1
      throw new Error('禁止发出写请求')
    },
    baseUrl: 'https://open.feishu.cn/open-apis',
    appToken: 'appTokenSource123',
    accessToken: 'tenantTokenSource123',
    readOnly: true
  })
  assert.strictEqual(client.readOnly, true)
  await assert.rejects(
    () => client.batchCreateRecords('tblSource123', [{ fields: { a: 1 } }]),
    /硬只读|禁止/
  )
  await assert.rejects(
    () => client.batchUpdateRecords('tblSource123', [{ record_id: 'recSource123', fields: { a: 1 } }]),
    /硬只读|禁止/
  )
  assert.strictEqual(fetchCount, 0, '员工源表写请求必须在网络层之前被阻断')
}

async function testDriveHierarchyAndRedirectPolicy() {
  const children = new Map([[ROOT, []]])
  const createNames = []
  let sequence = 1
  let redirectPolicy = ''
  const fetchImpl = async (url, options) => {
    redirectPolicy = options.redirect
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/drive/v1/files') && options.method === 'GET') {
      const parent = parsed.searchParams.get('folder_token')
      return jsonResponse({
        files: children.get(parent) || [],
        has_more: false,
        total: (children.get(parent) || []).length
      })
    }
    if (parsed.pathname.endsWith('/drive/v1/files/create_folder') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      const token = `fldCreated${String(sequence++).padStart(4, '0')}`
      const item = { token, name: body.name, type: 'folder' }
      if (!children.has(body.folder_token)) children.set(body.folder_token, [])
      children.get(body.folder_token).push(item)
      children.set(token, [])
      createNames.push(body.name)
      return jsonResponse(item)
    }
    throw new Error(`unexpected request: ${options.method} ${parsed.pathname}`)
  }
  const client = createFeishuNoteMaterialClient({
    fetchImpl,
    accessToken: 'tenantToken123',
    targetRootFolderToken: ROOT
  })
  const context = {
    parentFolderToken: ROOT,
    sourceRecordId: 'rec-source-1',
    district: '拱墅区',
    block: '新天地',
    locationId: 'LOC-001',
    community: '新德佳苑',
    building: '1幢',
    unit: '2单元',
    roomNumber: '301'
  }
  const first = await client.ensureListingFolder(context)
  const second = await client.ensureListingFolder(context)
  assert.strictEqual(first.token, second.token)
  assert.deepStrictEqual(createNames, [
    '房源笔记导入-v1',
    '拱墅区',
    '新天地',
    'LOC-001__新德佳苑',
    '1幢__2单元__301'
  ])
  assert.strictEqual(redirectPolicy, 'error', '所有飞书素材 API 请求必须禁止跟随重定向')
}

async function testDrivePaginationContract() {
  const pageTokens = []
  const pagedClient = createFeishuNoteMaterialClient({
    accessToken: 'tenantToken123',
    fetchImpl: async (url, options) => {
      const parsed = new URL(url)
      assert.strictEqual(options.method, 'GET')
      const pageToken = parsed.searchParams.get('page_token') || ''
      pageTokens.push(pageToken)
      if (!pageToken) {
        return jsonResponse({
          files: [{ token: 'filePageOne123', name: '第一页.mp4', type: 'file' }],
          has_more: true,
          next_page_token: 'nextPageToken123'
        })
      }
      assert.strictEqual(pageToken, 'nextPageToken123')
      return jsonResponse({
        files: [{ token: 'filePageTwo123', name: '第二页.mp4', type: 'file' }],
        has_more: false
      })
    }
  })
  const pagedItems = await pagedClient.listFolder('fldPagedSource123')
  assert.deepStrictEqual(
    pagedItems.map((item) => item.token),
    ['filePageOne123', 'filePageTwo123'],
    '素材目录必须读取并合并全部分页，不能只取第一页'
  )
  assert.deepStrictEqual(pageTokens, ['', 'nextPageToken123'])

  const missingTokenClient = createFeishuNoteMaterialClient({
    accessToken: 'tenantToken123',
    fetchImpl: async () => jsonResponse({
      files: [{ token: 'fileMissingToken123', name: '缺游标.mp4', type: 'file' }],
      has_more: true
    })
  })
  await assert.rejects(
    () => missingTokenClient.listFolder('fldMissingToken123'),
    /has_more.*page_token|缺少.*page_token/,
    'has_more=true 却没有下一页令牌时必须 fail-closed'
  )

  let loopCalls = 0
  const loopClient = createFeishuNoteMaterialClient({
    accessToken: 'tenantToken123',
    fetchImpl: async () => {
      loopCalls += 1
      return jsonResponse({
        files: [{ token: `fileLoopToken${loopCalls}23`, name: `循环${loopCalls}.mp4`, type: 'file' }],
        has_more: true,
        next_page_token: 'samePageToken123'
      })
    }
  })
  await assert.rejects(
    () => loopClient.listFolder('fldLoopSource123'),
    /token.*循环|循环/,
    '服务端重复下一页令牌时必须主动阻断，不能形成分页死循环'
  )
  assert.strictEqual(loopCalls, 2, '重复令牌必须在第二页立即阻断')

  let boundedCalls = 0
  const boundedClient = createFeishuNoteMaterialClient({
    accessToken: 'tenantToken123',
    maxItems: 3,
    fetchImpl: async () => {
      boundedCalls += 1
      return jsonResponse({
        files: [
          { token: `fileBounded${boundedCalls}A123`, name: `上限-${boundedCalls}-A.mp4`, type: 'file' },
          { token: `fileBounded${boundedCalls}B123`, name: `上限-${boundedCalls}-B.mp4`, type: 'file' }
        ],
        has_more: true,
        next_page_token: `boundedPageToken${boundedCalls}23`
      })
    }
  })
  await assert.rejects(
    () => boundedClient.listFolder('fldBoundedSource123'),
    /数量.*安全上限|超过.*上限/,
    '客户端必须在累计元数据超过 maxItems 时立即阻断，不能先读完最多五万项再由解析层拒绝'
  )
  assert.strictEqual(boundedCalls, 2, '累计超过 maxItems 后不得继续请求第三页')
}

async function testDriveMaterializeRequiresTargetHashReadback() {
  const sourceToken = 'fileSourceVideo123'
  const targetToken = 'fileTargetVideo123'
  const targetFolderToken = 'fldTargetVideo123'
  const targetName = 'MAT-readback-check.mp4'
  const verifiedSourceBuffer = Buffer.from('source-video')
  const verifiedSourceSha256 = crypto.createHash('sha256').update(verifiedSourceBuffer).digest('hex')
  let created = false
  let copyCalls = 0
  let uploadedBuffer = null
  let targetDownloadCount = 0
  const client = createFeishuNoteMaterialClient({
    accessToken: 'tenantToken123',
    fetchImpl: async (url, options) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith(`/drive/v1/files/${sourceToken}/download`)) {
        return bufferResponse('source-video')
      }
      if (parsed.pathname.endsWith('/drive/v1/files') && options.method === 'GET') {
        assert.strictEqual(parsed.searchParams.get('folder_token'), targetFolderToken)
        return jsonResponse({
          files: created ? [{ token: targetToken, name: targetName, type: 'file' }] : [],
          has_more: false,
          total: created ? 1 : 0
        })
      }
      if (parsed.pathname.endsWith(`/drive/v1/files/${sourceToken}/copy`) && options.method === 'POST') {
        copyCalls += 1
        created = true
        return jsonResponse({
          file: { token: targetToken, name: targetName, type: 'file' }
        })
      }
      if (parsed.pathname.endsWith('/drive/v1/files/upload_all') && options.method === 'POST') {
        const file = options.body && options.body.get && options.body.get('file')
        assert.ok(file && typeof file.arrayBuffer === 'function', '目标云盘上传必须携带已验证视频内容')
        uploadedBuffer = Buffer.from(await file.arrayBuffer())
        created = true
        return jsonResponse({ file_token: targetToken })
      }
      if (parsed.pathname.endsWith(`/drive/v1/files/${targetToken}/download`)) {
        targetDownloadCount += 1
        return bufferResponse('corrupt-video')
      }
      throw new Error(`unexpected request: ${options.method} ${parsed.pathname}`)
    }
  })
  await assert.rejects(
    () => client.materializeVideo({
      asset: {
        sourceToken,
        sourceKind: 'drive-file',
        mimeType: 'video/mp4'
      },
      targetFolderToken,
      targetName,
      sourceEvidence: {
        buffer: verifiedSourceBuffer,
        contentSha256: verifiedSourceSha256,
        size: verifiedSourceBuffer.length,
        contentType: 'video/mp4'
      }
    }),
    /目标文件内容回读不一致/,
    '目标云盘文件必须重新下载并按内容 SHA 校验，不能只相信复制接口成功'
  )
  assert.strictEqual(copyCalls, 0, 'Drive 源文件也不得在校验后再次按可变 token 发起服务端复制')
  assert.deepStrictEqual(uploadedBuffer, verifiedSourceBuffer, '目标云盘收到的必须是刚刚完成摘要校验的同一份内容')
  assert.strictEqual(targetDownloadCount, 1, '目标文件写入后必须真实下载一次做内容回读')
  await assert.rejects(
    () => client.materializeVideo({
      asset: {
        sourceToken,
        sourceKind: 'drive-file',
        mimeType: 'video/mp4'
      },
      targetFolderToken,
      targetName: 'MAT-invalid-source-evidence.mp4',
      sourceEvidence: {
        buffer: Buffer.from('source-video'),
        contentSha256: '0'.repeat(64),
        size: Buffer.byteLength('source-video'),
        contentType: 'video/mp4'
      }
    }),
    /源素材证据摘要无效/,
    '物化客户端必须重新计算调用方传入 buffer 的 SHA，不能信任声明摘要'
  )
}

async function testClientReusesSuppliedEvidenceBuffer() {
  const sourceToken = 'docxSourceBuffer123'
  const targetToken = 'targetBufferReuse123'
  const targetFolderToken = 'folderBufferReuse123'
  const targetName = 'MAT-buffer-reuse.mp4'
  const sourceBuffer = Buffer.from('same-buffer-reference')
  const contentSha256 = crypto.createHash('sha256').update(sourceBuffer).digest('hex')
  const client = createFeishuNoteMaterialClient({
    accessToken: 'tenantToken123',
    fetchImpl: async (url, options) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/drive/v1/files') && options.method === 'GET') {
        return jsonResponse({
          files: [{ token: targetToken, name: targetName, type: 'file' }],
          has_more: false,
          total: 1
        })
      }
      if (parsed.pathname.endsWith(`/drive/v1/files/${targetToken}/download`)) {
        return bufferResponse(sourceBuffer)
      }
      throw new Error(`unexpected request: ${options.method} ${parsed.pathname}`)
    }
  })
  const result = await client.materializeVideo({
    asset: {
      sourceToken,
      sourceKind: 'docx-file',
      mimeType: 'video/mp4'
    },
    targetFolderToken,
    targetName,
    sourceEvidence: {
      buffer: sourceBuffer,
      contentSha256,
      size: sourceBuffer.length,
      contentType: 'video/mp4'
    }
  })
  assert.strictEqual(
    result.buffer,
    sourceBuffer,
    '真实客户端必须只读复核并沿用上层独占 Buffer，不得在适配器内部再次复制整段视频'
  )
}

async function testRealDriveClientSameTokenContentReplacement() {
  const sourceToken = 'fileStableSourceToken123'
  const targetFolderToken = 'fldStableTarget123'
  const sourceRecordId = 'rec-stable-content'
  const sourceFingerprint = crypto.createHash('sha256').update('same-source-metadata').digest('hex')
  let sourceBody = Buffer.from('old!')
  let targetSequence = 0
  let copyCalls = 0
  let uploadCalls = 0
  let ossPutCalls = 0
  const targetFiles = new Map()

  const sourceAsset = () => ({
    sourceToken,
    sourceKind: 'drive-file',
    name: '房源视频.mp4',
    extension: 'mp4',
    mimeType: 'video/mp4',
    modifiedTime: 'fixed-metadata',
    size: 4,
    sourceOrder: 0,
    sourceFingerprint
  })

  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    const pathname = parsed.pathname
    if (pathname === '/open-apis/drive/v1/files' && options.method === 'GET') {
      assert.strictEqual(parsed.searchParams.get('folder_token'), targetFolderToken)
      const files = Array.from(targetFiles.values()).map(({ token, name, type }) => ({ token, name, type }))
      return jsonResponse({ files, has_more: false, total: files.length })
    }
    if (pathname === `/open-apis/drive/v1/files/${sourceToken}/download` && options.method === 'GET') {
      return bufferResponse(sourceBody)
    }
    if (pathname === `/open-apis/drive/v1/files/${sourceToken}/copy` && options.method === 'POST') {
      copyCalls += 1
      const body = JSON.parse(options.body)
      assert.strictEqual(body.folder_token, targetFolderToken)
      const target = {
        token: `fileTarget${String(++targetSequence).padStart(4, '0')}123`,
        name: body.name,
        type: 'file',
        body: Buffer.from(sourceBody)
      }
      targetFiles.set(target.name, target)
      return jsonResponse({ file: { token: target.token, name: target.name, type: 'file' } })
    }
    if (pathname === '/open-apis/drive/v1/files/upload_all' && options.method === 'POST') {
      uploadCalls += 1
      const file = options.body && options.body.get && options.body.get('file')
      const name = options.body && options.body.get && String(options.body.get('file_name') || '')
      assert.ok(file && typeof file.arrayBuffer === 'function', '内容寻址目标必须上传已验证的视频 Buffer')
      const target = {
        token: `fileTarget${String(++targetSequence).padStart(4, '0')}123`,
        name,
        type: 'file',
        body: Buffer.from(await file.arrayBuffer())
      }
      targetFiles.set(target.name, target)
      return jsonResponse({ file_token: target.token })
    }
    const target = Array.from(targetFiles.values()).find((item) => (
      pathname === `/open-apis/drive/v1/files/${item.token}/download`
    ))
    if (target && options.method === 'GET') return bufferResponse(target.body)
    throw new Error(`unexpected request: ${options.method} ${pathname}`)
  }

  const client = createFeishuNoteMaterialClient({
    fetchImpl,
    accessToken: 'tenantTokenForTest123',
    targetRootFolderToken: targetFolderToken
  })
  const drive = {
    async ensureListingFolder() { return { token: targetFolderToken } },
    materializeVideo: client.materializeVideo,
    downloadToken: client.downloadToken,
    verifyMaterializedVideo: client.verifyMaterializedVideo
  }
  const ossObjects = new Map()
  const oss = {
    async putVideoDeterministic(input) {
      ossPutCalls += 1
      ossObjects.set(input.objectKey, Buffer.from(input.buffer))
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    },
    async verifyVideoDeterministic(asset) {
      const body = ossObjects.get(asset.objectKey)
      const sha = body && crypto.createHash('sha256').update(body).digest('hex')
      return { ...asset, verified: Boolean(body) && sha === asset.contentSha256 }
    }
  }
  const verifyExisting = async (asset, target) => {
    const source = await client.downloadToken(target.sourceToken, target.sourceKind)
    const sourceVerified = source.contentSha256 === asset.contentSha256 && source.size === asset.size
    if (!sourceVerified) return { sourceVerified: false, driveVerified: false, ossVerified: false }
    const driveEvidence = await client.verifyMaterializedVideo({
      ...target,
      contentSha256: asset.contentSha256,
      size: asset.size
    })
    const ossEvidence = await oss.verifyVideoDeterministic(asset)
    return {
      sourceVerified,
      driveVerified: driveEvidence.verified === true,
      ossVerified: ossEvidence.verified === true
    }
  }

  const first = await syncNoteMaterialVideos({
    sourceRecordId,
    assets: [sourceAsset()],
    existingMediaAssets: [],
    uploadDir: 'house-videos',
    drive,
    oss
  })
  assert.strictEqual(first.mediaAssets.length, 1)
  assert.strictEqual(copyCalls, 0, '首次同步不得按可变源 token 复制 Drive 文件')
  assert.strictEqual(uploadCalls, 1, '首次同步必须上传刚完成摘要校验的 Buffer')
  const oldTargetName = Array.from(targetFiles.keys())[0]
  const oldObjectKey = first.mediaAssets[0].objectKey

  sourceBody = Buffer.from('new!')
  const second = await syncNoteMaterialVideos({
    sourceRecordId,
    assets: [sourceAsset()],
    existingMediaAssets: first.mediaAssets,
    uploadDir: 'house-videos',
    drive,
    oss,
    verifyExisting
  })
  const newHash = crypto.createHash('sha256').update(sourceBody).digest('hex')
  assert.strictEqual(copyCalls, 0, '同 token 内容变化后仍不得回退服务端复制')
  assert.strictEqual(uploadCalls, 2, '同 token 内容变化后必须用新验证内容创建新的内容寻址目标')
  assert.strictEqual(ossPutCalls, 2, '同 token 内容变化后必须写入新的 OSS 对象')
  assert.strictEqual(second.mediaAssets[0].contentSha256, newHash)
  assert.notStrictEqual(second.mediaAssets[0].objectKey, oldObjectKey, '新内容不得覆盖旧 OSS 对象键')
  assert.ok(Array.from(targetFiles.keys()).some((name) => name.includes(newHash)), '新 Drive 目标名必须包含完整内容 SHA-256')
  assert.strictEqual(targetFiles.get(oldTargetName).body.toString(), 'old!', '旧 Drive 目标必须保留')
  assert.strictEqual(ossObjects.get(oldObjectKey).toString(), 'old!', '旧 OSS 对象必须保留')

  const third = await syncNoteMaterialVideos({
    sourceRecordId,
    assets: [sourceAsset()],
    existingMediaAssets: second.mediaAssets,
    uploadDir: 'house-videos',
    drive,
    oss,
    verifyExisting
  })
  assert.strictEqual(third.counts.reused, 1, '内容未变的第三轮必须复用已验证目标')
  assert.strictEqual(copyCalls, 0, '内容未变的第三轮也不得调用源 token 复制接口')
  assert.strictEqual(uploadCalls, 2, '内容未变的第三轮不得重复上传 Drive 文件')
  assert.strictEqual(ossPutCalls, 2, '内容未变的第三轮不得重复写 OSS')
}

async function testBoundedDownload() {
  let cancelled = 0
  const chunks = [Buffer.from('1234'), Buffer.from('5678')]
  const client = createFeishuNoteMaterialClient({
    accessToken: 'tenantToken123',
    maxBytes: 6,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '' },
      body: {
        getReader() {
          let index = 0
          return {
            async read() {
              return index < chunks.length
                ? { done: false, value: chunks[index++] }
                : { done: true }
            },
            async cancel() {
              cancelled += 1
            }
          }
        }
      }
    })
  })
  await assert.rejects(
    () => client.downloadToken('boxVideo123456', 'drive-file'),
    (error) => error && error.statusCode === 413
  )
  assert.strictEqual(cancelled, 1, '超过上限时必须立即取消响应流')
}

function listing(sourceRecordId) {
  return {
    id: `listing-${sourceRecordId}`,
    feishuRecordId: sourceRecordId,
    status: '上架',
    district: '拱墅区',
    block: '新天地',
    locationId: 'LOC-001',
    community: '新德佳苑',
    building: '1幢',
    unit: '2单元',
    roomNumber: sourceRecordId === 'rec-1' ? '301' : '302',
    mediaAssets: []
  }
}

function materialAdapters(options = {}) {
  const writes = []
  const drive = {
    async listFolder(token) {
      if (options.listFailure) {
        const error = new Error(options.permanentFailure ? '素材结构损坏' : '临时无权限')
        if (!options.permanentFailure) error.statusCode = 503
        throw error
      }
      const videoCount = Number(options.videoCount || 1)
      return Array.from({ length: videoCount }, (_, index) => ({
        token: options.sharedToken ||
          `box${crypto.createHash('sha256').update(`${token}:${index}`).digest('hex').slice(0, 20)}`,
        name: videoCount === 1 ? '看房视频.mp4' : `看房视频-${String(index + 1).padStart(3, '0')}.mp4`,
        type: 'file',
        modifiedTime: '10',
        size: 4
      }))
    },
    async downloadToken() {
      const buffer = Buffer.from('body')
      return {
        buffer,
        contentType: 'video/mp4',
        contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        size: buffer.length
      }
    },
    async ensureListingFolder(input) {
      writes.push(['folder', input.sourceRecordId])
      return { token: `fld-target-${input.sourceRecordId}` }
    },
    async materializeVideo(input) {
      writes.push(['drive', input.targetName])
      const buffer = Buffer.from(input.sourceEvidence.buffer)
      const contentSha256 = options.invalidContentHash
        ? 'not-a-sha256'
        : crypto.createHash('sha256').update(buffer).digest('hex')
      return {
        targetToken: `target-${input.targetName}`,
        targetName: input.targetName,
        buffer,
        contentType: 'video/mp4',
        contentSha256,
        size: buffer.length,
        verified: true
      }
    },
    async verifyMaterializedVideo() {
      return { verified: true }
    }
  }
  const oss = {
    async putVideoDeterministic(input) {
      writes.push(['oss', input.objectKey])
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    },
    async verifyVideoDeterministic(asset) {
      return { ...asset, verified: true }
    }
  }
  return { drive, oss, writes }
}

function verifiedNoteAsset(assetId, label) {
  return {
    assetId,
    kind: 'video',
    objectKey: `house-videos/feishu-note-v1/rec-1/${label}.mp4`,
    contentSha256: crypto.createHash('sha256').update(`content-${label}`).digest('hex'),
    sourceFingerprint: crypto.createHash('sha256').update(`source-${label}`).digest('hex'),
    targetDriveFingerprint: crypto.createHash('sha256').update(`drive-${label}`).digest('hex'),
    displayOrder: 0,
    mimeType: 'video/mp4',
    size: 4,
    verified: true
  }
}

async function runConcurrentStateScenario(mode) {
  const initialAsset = verifiedNoteAsset('MAT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'initial')
  const concurrentAsset = verifiedNoteAsset('MAT-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', `concurrent-${mode}`)
  const item = {
    ...listing('rec-1'),
    city: '杭州',
    area: '新天地',
    rent: 3000,
    layout: '2室1厅',
    room: '两室',
    rentMode: '整租',
    type: '整租',
    source: '公司房源',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    communityMatched: true,
    mediaAssets: [initialAsset],
    videoKey: initialAsset.objectKey,
    noteMaterialState: {
      sourceLinkFingerprint: 'old-link',
      physicalUnitFingerprint: 'old-room',
      status: 'verified',
      updatedAt: '2026-07-26T09:00:00.000Z'
    }
  }
  const db = { users: [], listings: [item] }
  const adapters = materialAdapters()
  const originalMaterializeVideo = adapters.drive.materializeVideo
  const concurrentState = {
    sourceLinkFingerprint: `concurrent-link-${mode}`,
    physicalUnitFingerprint: `concurrent-room-${mode}`,
    digest: `concurrent-digest-${mode}`,
    status: 'verified',
    updatedAt: '2026-07-26T10:04:00.000Z'
  }
  adapters.drive.materializeVideo = async (input) => {
    domain.replaceListingMediaAssets(db, item.id, [concurrentAsset], {
      expectedStateKey: domain.listingMediaAssetsStateKey(item),
      updatedAt: concurrentState.updatedAt
    })
    item.noteMaterialState = JSON.parse(JSON.stringify(concurrentState))
    if (mode === 'cleanup') {
      const error = new Error('素材结构永久失败')
      error.statusCode = 422
      throw error
    }
    return originalMaterializeVideo(input)
  }
  const result = await syncNoteMaterialsForInventory({
    db,
    sourceRows: [{
      sourceRecordId: 'rec-1',
      value: `https://${HOST}/drive/folder/fldConcurrentSource123`
    }],
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: adapters.drive,
    oss: adapters.oss,
    mediaAssetsStateKey: (current) => domain.listingMediaAssetsStateKey(current),
    replaceMediaAssets: (current, mediaAssets, context) => domain.replaceListingMediaAssets(
      db,
      current.id,
      mediaAssets,
      context
    ),
    nowText: '2026-07-26T10:05:00.000Z'
  })
  assert.strictEqual(result.failed, 1)
  assert.strictEqual(result.published, false)
  assert.strictEqual(result.rows[0].status, 'state-conflict')
  assert.deepStrictEqual(
    item.mediaAssets,
    [concurrentAsset],
    '状态冲突后必须完整保留并发任务刚写入的素材集合'
  )
  assert.deepStrictEqual(
    item.noteMaterialState,
    concurrentState,
    '状态冲突后不得把并发任务的笔记素材状态改成 cleared 或 retained'
  )
}

async function testConcurrentStateConflictPreservesNewestListingState() {
  await runConcurrentStateScenario('publish')
  await runConcurrentStateScenario('cleanup')

  const initialAsset = verifiedNoteAsset('MAT-cccccccccccccccccccccccccccccccc', 'reported-conflict')
  const item = {
    ...listing('rec-1'),
    mediaAssets: [initialAsset],
    videoKey: initialAsset.objectKey,
    noteMaterialState: {
      sourceLinkFingerprint: 'existing-link',
      physicalUnitFingerprint: 'existing-room',
      status: 'verified',
      updatedAt: '2026-07-26T10:06:00.000Z'
    }
  }
  const beforeAssets = JSON.parse(JSON.stringify(item.mediaAssets))
  const beforeState = JSON.parse(JSON.stringify(item.noteMaterialState))
  const db = { listings: [item] }
  const adapters = materialAdapters()
  adapters.drive.listFolder = async () => {
    const error = new Error('素材状态冲突')
    error.statusCode = 409
    throw error
  }
  const result = await syncNoteMaterialsForInventory({
    db,
    sourceRows: [{
      sourceRecordId: 'rec-1',
      value: `https://${HOST}/drive/folder/fldReportedConflict123`
    }],
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: adapters.drive,
    oss: adapters.oss,
    mediaAssetsStateKey: (current) => domain.listingMediaAssetsStateKey(current),
    replaceMediaAssets: (current, mediaAssets, context) => domain.replaceListingMediaAssets(
      db,
      current.id,
      mediaAssets,
      context
    )
  })
  assert.strictEqual(result.rows[0].status, 'state-conflict')
  assert.deepStrictEqual(item.mediaAssets, beforeAssets, '任何 409 状态冲突都不得触发失败清理')
  assert.deepStrictEqual(item.noteMaterialState, beforeState, '任何 409 状态冲突都不得改写素材状态')
}

async function testAtomicInventoryState() {
  const db = { listings: [listing('rec-1'), listing('rec-2')] }
  const adapters = materialAdapters()
  const sourceRows = [
    { sourceRecordId: 'rec-1', value: `https://${HOST}/drive/folder/fldSourceOne123` },
    { sourceRecordId: 'rec-2', value: `https://${HOST}/drive/folder/fldSourceTwo123` }
  ]
  const first = await syncNoteMaterialsForInventory({
    db,
    sourceRows,
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: adapters.drive,
    oss: adapters.oss,
    nowText: '2026-07-26T10:00:00.000Z'
  })
  assert.strictEqual(first.failed, 0)
  assert.strictEqual(first.synced, 2)
  assert.ok(db.listings.every((item) => item.noteMaterialState.status === 'verified'))
  assert.ok(db.listings.every((item) => item.mediaAssets.length === 1))
  assert.ok(db.listings.every((item) => item.videoKey === item.mediaAssets[0].objectKey))

  const beforeRetain = JSON.stringify(db.listings[0].mediaAssets)
  const verifiedState = JSON.parse(JSON.stringify(db.listings[0].noteMaterialState))
  const sameLinkFailure = await syncNoteMaterialsForInventory({
    db,
    sourceRows: [sourceRows[0]],
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: materialAdapters({ listFailure: true }).drive,
    oss: adapters.oss,
    nowText: '2026-07-26T10:01:00.000Z'
  })
  assert.strictEqual(sameLinkFailure.retained, 1, '同链接、同房间、仍在架时才允许临时沿用')
  assert.strictEqual(JSON.stringify(db.listings[0].mediaAssets), beforeRetain)

  db.listings[0].roomNumber = '999'
  const movedFailure = await syncNoteMaterialsForInventory({
    db,
    sourceRows: [sourceRows[0]],
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: materialAdapters({ listFailure: true }).drive,
    oss: adapters.oss,
    nowText: '2026-07-26T10:02:00.000Z'
  })
  assert.strictEqual(movedFailure.retained, 0)
  assert.deepStrictEqual(db.listings[0].mediaAssets, [], '物理房间变化后必须禁止沿用旧素材')

  const restored = listing('rec-1')
  restored.mediaAssets = JSON.parse(beforeRetain)
  restored.videoKey = restored.mediaAssets[0].objectKey
  restored.noteMaterialState = verifiedState
  db.listings[0] = restored
  const permanentFailure = await syncNoteMaterialsForInventory({
    db,
    sourceRows: [sourceRows[0]],
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: materialAdapters({ listFailure: true, permanentFailure: true }).drive,
    oss: adapters.oss,
    nowText: '2026-07-26T10:02:30.000Z'
  })
  assert.strictEqual(permanentFailure.retained, 0, '结构或校验类永久错误不得沿用旧素材')
  assert.strictEqual(permanentFailure.published, false)
  assert.deepStrictEqual(db.listings[0].mediaAssets, [])

  const noIdentity = {
    id: 'listing-no-identity',
    feishuRecordId: 'rec-no-identity',
    status: '上架',
    mediaAssets: JSON.parse(beforeRetain),
    videoKey: JSON.parse(beforeRetain)[0].objectKey,
    noteMaterialState: {
      ...verifiedState,
      physicalUnitFingerprint: ''
    }
  }
  db.listings.push(noIdentity)
  const noIdentityFailure = await syncNoteMaterialsForInventory({
    db,
    sourceRows: [{
      sourceRecordId: 'rec-no-identity',
      value: sourceRows[0].value
    }],
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: materialAdapters({ listFailure: true }).drive,
    oss: adapters.oss,
    nowText: '2026-07-26T10:02:45.000Z'
  })
  assert.strictEqual(noIdentityFailure.retained, 0, '物理房身份为空时空值相等也不得沿用')
  assert.deepStrictEqual(noIdentity.mediaAssets, [])

  db.listings[1].mediaAssets = [{
    assetId: 'MAT-old',
    objectKey: 'house-videos/feishu-note-v1/old/MAT-old.mp4',
    kind: 'video',
    verified: true
  }]
  db.listings[1].videoKey = db.listings[1].mediaAssets[0].objectKey
  const cleared = await syncNoteMaterialsForInventory({
    db,
    sourceRows: [{ sourceRecordId: 'rec-2', value: '' }],
    allowedHosts: [HOST],
    drive: adapters.drive,
    oss: adapters.oss,
    nowText: '2026-07-26T10:03:00.000Z'
  })
  assert.strictEqual(cleared.cleared, 1)
  assert.deepStrictEqual(db.listings[1].mediaAssets, [])
  assert.strictEqual(db.listings[1].videoKey, '')
}

async function testCrossRecordConflictBeforeWrites() {
  const db = { listings: [listing('rec-1'), listing('rec-2')] }
  const adapters = materialAdapters({ sharedToken: 'boxSharedVideo123' })
  const result = await syncNoteMaterialsForInventory({
    db,
    sourceRows: [
      { sourceRecordId: 'rec-1', value: `https://${HOST}/drive/folder/fldSourceOne123` },
      { sourceRecordId: 'rec-2', value: `https://${HOST}/drive/folder/fldSourceTwo123` }
    ],
    allowedHosts: [HOST],
    targetRootFolderToken: ROOT,
    uploadDir: 'house-videos',
    drive: adapters.drive,
    oss: adapters.oss
  })
  assert.strictEqual(result.complete, false)
  assert.ok(result.rows.some((row) => row.status === 'cross-record-token-conflict'))
  assert.strictEqual(adapters.writes.length, 0, '跨记录 token 冲突必须在任何 Drive/OSS/清单写入前阻断')
  assert.ok(db.listings.every((item) => item.mediaAssets.length === 0))
}

async function testMediaCountLimitBeforeExternalWrites() {
  async function runCount(videoCount) {
    const item = listing('rec-1')
    const db = { listings: [item] }
    const adapters = materialAdapters({ videoCount })
    const result = await syncNoteMaterialsForInventory({
      db,
      sourceRows: [{
        sourceRecordId: 'rec-1',
        value: `https://${HOST}/drive/folder/fldCountSource123`
      }],
      allowedHosts: [HOST],
      targetRootFolderToken: ROOT,
      uploadDir: 'house-videos',
      drive: adapters.drive,
      oss: adapters.oss,
      mediaAssetsStateKey: (current) => domain.listingMediaAssetsStateKey(current),
      replaceMediaAssets: (current, mediaAssets, context) => domain.replaceListingMediaAssets(
        db,
        current.id,
        mediaAssets,
        context
      )
    })
    return { item, result, writes: adapters.writes }
  }

  const atLimit = await runCount(domain.MAX_LISTING_MEDIA_ASSETS)
  assert.strictEqual(atLimit.result.complete, true, '64 个视频必须允许完整同步')
  assert.strictEqual(atLimit.result.published, true, '64 个视频必须允许正式发布')
  assert.strictEqual(atLimit.item.mediaAssets.length, domain.MAX_LISTING_MEDIA_ASSETS)
  assert.strictEqual(
    atLimit.writes.filter(([kind]) => kind === 'drive').length,
    domain.MAX_LISTING_MEDIA_ASSETS,
    '安全上限内的每个视频都必须真实进入 Drive 写入链路'
  )

  const overLimit = await runCount(domain.MAX_LISTING_MEDIA_ASSETS + 1)
  assert.strictEqual(overLimit.result.complete, false, '第 65 个视频必须在同步前拒绝')
  assert.strictEqual(overLimit.result.published, false)
  assert.strictEqual(overLimit.result.failed, 1)
  assert.ok(
    overLimit.result.rows.some((row) => row.status === 'media-limit-exceeded'),
    '超限结果必须返回明确的 media-limit-exceeded 状态'
  )
  assert.strictEqual(overLimit.writes.length, 0, '第 65 个视频必须在任何 Drive/OSS 外部写入前失败')
  assert.deepStrictEqual(overLimit.item.mediaAssets, [], '超限失败不得改写房源素材清单')
}

async function testMaterialTargetMustBeIndependentFromLegacySource() {
  const previous = {
    enabled: config.feishu.noteMaterialSyncEnabled,
    hosts: config.feishu.noteMaterialAllowedHosts,
    root: config.feishu.noteMaterialTargetRootFolderToken,
    legacyRoot: config.feishu.folderToken
  }
  const sharedRoot = 'sharedLegacyAndTarget123'
  const adapters = materialAdapters()
  config.feishu.noteMaterialSyncEnabled = true
  config.feishu.noteMaterialAllowedHosts = [HOST]
  config.feishu.noteMaterialTargetRootFolderToken = sharedRoot
  config.feishu.folderToken = sharedRoot
  try {
    const result = await feishuSync._internal.syncMirrorNoteMaterials(
      { listings: [listing('rec-1')] },
      {
        feishuToken: 'tenantToken123',
        sourceNoteMaterials: [{
          sourceRecordId: 'rec-1',
          value: `https://${HOST}/drive/folder/fldSourceOne123`
        }]
      },
      {
        dryRun: false,
        noteMaterialDrive: adapters.drive,
        noteMaterialOss: adapters.oss
      }
    )
    assert.strictEqual(result.complete, false)
    assert.strictEqual(result.published, false)
    assert.strictEqual(result.status, 'configuration-not-ready')
    assert.strictEqual(adapters.writes.length, 0, '新素材目标根与旧素材源根相同时必须在任何外部写入前拒绝')
  } finally {
    config.feishu.noteMaterialSyncEnabled = previous.enabled
    config.feishu.noteMaterialAllowedHosts = previous.hosts
    config.feishu.noteMaterialTargetRootFolderToken = previous.root
    config.feishu.folderToken = previous.legacyRoot
  }
}

function testInventoryCommitAndWholeRunStatusAreSeparated() {
  assert.strictEqual(
    typeof feishuSync._internal.finalizeMirrorSyncResult,
    'function',
    '镜像同步必须提供统一的整轮状态收口函数'
  )
  const nestedFailure = {
    complete: false,
    published: false,
    dryRun: false,
    failed: 1,
    status: 'pipeline-failed'
  }
  const result = feishuSync._internal.finalizeMirrorSyncResult({
    complete: true,
    published: true,
    validated: true,
    planned: true,
    failed: 0,
    schemaInvalid: false,
    mirrorIncomplete: false,
    success: true,
    status: 'success-noop',
    noop: true,
    dryRun: false,
    inventory: {
      complete: true,
      published: true,
      failed: 0,
      noop: true,
      noteMaterials: nestedFailure
    }
  })
  assert.strictEqual(result.success, false, '素材失败时整轮不得继续显示成功')
  assert.strictEqual(result.complete, false)
  assert.strictEqual(result.published, false)
  assert.strictEqual(result.status, 'inventory-published-materials-failed')
  assert.strictEqual(result.failed, 1)
  assert.strictEqual(result.inventoryCommittable, true, '素材失败不得回滚已经完整校验的库存变更')
  assert.strictEqual(result.inventoryPublished, true)
  assert.strictEqual(result.noop, false, '嵌套素材失败不得伪装为 success-noop')

  assert.strictEqual(
    typeof feishuSync._internal.recordMirrorSyncOutcome,
    'function',
    '整轮库存/素材状态必须写回最近同步日志，后台刷新后仍能区分部分失败'
  )
  const logDb = { feishuSyncLogs: [{ id: 'LOG-1', created: 1 }] }
  feishuSync._internal.recordMirrorSyncOutcome(logDb, result)
  assert.deepStrictEqual(logDb.feishuSyncLogs[0].noteMaterials, {
    complete: false,
    published: false,
    dryRun: false,
    sourceRecordCount: 0,
    resolved: 0,
    synced: 0,
    cleared: 0,
    retained: 0,
    failed: 1,
    video: 0,
    nonVideo: 0,
    duplicateReference: 0,
    skipped: false,
    status: 'pipeline-failed'
  })
  assert.strictEqual(logDb.feishuSyncLogs[0].success, false)
  assert.strictEqual(logDb.feishuSyncLogs[0].inventoryCommittable, true)
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(logDb.feishuSyncLogs[0].noteMaterials, 'rows'),
    false,
    '持久日志只保存素材汇总，不得扩大源记录或内部错误明细'
  )

  const previousMirrorMode = config.feishu.mirrorSyncEnabled
  config.feishu.mirrorSyncEnabled = true
  try {
    assert.strictEqual(
      feishuSync.isCommittableSyncResult(result),
      true,
      '数据库提交门禁必须只消费 inventoryCommittable，不得把整轮素材失败误当作库存回滚条件'
    )
  } finally {
    config.feishu.mirrorSyncEnabled = previousMirrorMode
  }
}

async function testSourceContentIsRevalidatedBeforeReuse() {
  const previous = {
    enabled: config.feishu.noteMaterialSyncEnabled,
    hosts: config.feishu.noteMaterialAllowedHosts,
    root: config.feishu.noteMaterialTargetRootFolderToken,
    legacyRoot: config.feishu.folderToken
  }
  const item = listing('rec-1')
  const db = { listings: [item] }
  let sourceBody = Buffer.from('old!')
  let materializeCalls = 0
  let sourceReadbacks = 0
  const sourceToken = 'boxStableSourceToken123'
  const drive = {
    async listFolder() {
      return [{
        token: sourceToken,
        name: '同名视频.mp4',
        type: 'file',
        modifiedTime: 'fixed-metadata',
        size: 4
      }]
    },
    async ensureListingFolder() {
      return { token: 'fldStableTarget123' }
    },
    async materializeVideo(input) {
      materializeCalls += 1
      const buffer = Buffer.from(sourceBody)
      return {
        targetToken: 'targetStableVideo123',
        targetName: input.targetName,
        buffer,
        contentType: 'video/mp4',
        contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        size: buffer.length,
        verified: true
      }
    },
    async downloadToken(token) {
      assert.strictEqual(token, sourceToken, '复用前必须回读同一个源 token')
      sourceReadbacks += 1
      return {
        buffer: Buffer.from(sourceBody),
        contentType: 'video/mp4',
        contentSha256: crypto.createHash('sha256').update(sourceBody).digest('hex'),
        size: sourceBody.length
      }
    },
    async verifyMaterializedVideo() {
      return { verified: true }
    }
  }
  const ossAdapter = {
    async putVideoDeterministic(input) {
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    },
    async verifyVideoDeterministic(asset) {
      return { ...asset, verified: true }
    }
  }
  config.feishu.noteMaterialSyncEnabled = true
  config.feishu.noteMaterialAllowedHosts = [HOST]
  config.feishu.noteMaterialTargetRootFolderToken = ROOT
  config.feishu.folderToken = 'legacyIndependentRoot123'
  const mirrorResult = {
    feishuToken: 'tenantToken123',
    sourceNoteMaterials: [{
      sourceRecordId: 'rec-1',
      value: `https://${HOST}/drive/folder/fldStableSource123`
    }]
  }
  try {
    const first = await feishuSync._internal.syncMirrorNoteMaterials(db, mirrorResult, {
      dryRun: false,
      noteMaterialDrive: drive,
      noteMaterialOss: ossAdapter
    })
    assert.strictEqual(first.published, true)
    const oldHash = item.mediaAssets[0].contentSha256

    sourceBody = Buffer.from('new!')
    const second = await feishuSync._internal.syncMirrorNoteMaterials(db, mirrorResult, {
      dryRun: false,
      noteMaterialDrive: drive,
      noteMaterialOss: ossAdapter
    })
    assert.strictEqual(second.published, true)
    assert.ok(sourceReadbacks >= 1, '同 token 元数据不变时也必须重新读取源内容')
    assert.strictEqual(materializeCalls, 2, '源内容变化后必须重新物化 Drive 与 OSS 素材')
    assert.notStrictEqual(item.mediaAssets[0].contentSha256, oldHash, '源内容变化必须进入新的素材状态')
  } finally {
    config.feishu.noteMaterialSyncEnabled = previous.enabled
    config.feishu.noteMaterialAllowedHosts = previous.hosts
    config.feishu.noteMaterialTargetRootFolderToken = previous.root
    config.feishu.folderToken = previous.legacyRoot
  }
}

async function testFormalSyncReportsMaterialFailureWithoutUndoingInventory() {
  const previous = {
    enabled: config.feishu.noteMaterialSyncEnabled,
    hosts: config.feishu.noteMaterialAllowedHosts,
    root: config.feishu.noteMaterialTargetRootFolderToken
  }
  config.feishu.noteMaterialSyncEnabled = true
  config.feishu.noteMaterialAllowedHosts = [HOST]
  config.feishu.noteMaterialTargetRootFolderToken = ROOT
  const db = { listings: [listing('rec-1')] }
  db.listings[0].rent = 3600
  try {
    let forbiddenReads = 0
    const skipped = await feishuSync._internal.syncNoteMaterialsAfterInventory(
      db,
      { failed: 1, skippedInvalid: 0 },
      {
        sourceNoteMaterials: [{
          sourceRecordId: 'rec-1',
          value: `https://${HOST}/drive/folder/fldSourceOne123`
        }]
      },
      {
        noteMaterialDrive: {
          async listFolder() {
            forbiddenReads += 1
            return []
          }
        }
      }
    )
    assert.strictEqual(skipped.status, 'skipped-inventory-failed')
    assert.strictEqual(forbiddenReads, 0, '库存阶段失败时素材阶段必须完全隔离且零读写')

    const result = await feishuSync._internal.syncMirrorNoteMaterials(db, {
      feishuToken: 'tenantToken123',
      sourceNoteMaterials: [{
        sourceRecordId: 'rec-1',
        value: `https://${HOST}/drive/folder/fldSourceOne123`
      }]
    }, {
      dryRun: false,
      noteMaterialDrive: materialAdapters({ listFailure: true }).drive,
      noteMaterialOss: materialAdapters().oss
    })
    assert.strictEqual(result.published, false)
    assert.strictEqual(result.failed, 1)
    assert.strictEqual(db.listings[0].rent, 3600, '素材阶段失败不得回滚或覆盖已经成功的库存字段')

    const invalidDb = { listings: [listing('rec-1')] }
    const invalidAdapters = materialAdapters({ invalidContentHash: true })
    const invalidResult = await feishuSync._internal.syncMirrorNoteMaterials(invalidDb, {
      feishuToken: 'tenantToken123',
      sourceNoteMaterials: [{
        sourceRecordId: 'rec-1',
        value: `https://${HOST}/drive/folder/fldSourceOne123`
      }]
    }, {
      dryRun: false,
      noteMaterialDrive: invalidAdapters.drive,
      noteMaterialOss: invalidAdapters.oss
    })
    assert.strictEqual(invalidResult.failed, 1)
    assert.strictEqual(invalidResult.published, false)
    assert.deepStrictEqual(
      invalidDb.listings[0].mediaAssets,
      [],
      '非法素材清单必须被 domain 唯一落库门拒绝，不得绕过校验直接赋值'
    )
  } finally {
    config.feishu.noteMaterialSyncEnabled = previous.enabled
    config.feishu.noteMaterialAllowedHosts = previous.hosts
    config.feishu.noteMaterialTargetRootFolderToken = previous.root
  }
}

async function run() {
  testMaterialSyncRequiresExplicitOptIn()
  testStableSourceFieldContract()
  await testSourceClientHardReadOnly()
  await testDriveHierarchyAndRedirectPolicy()
  await testDrivePaginationContract()
  await testDriveMaterializeRequiresTargetHashReadback()
  await testClientReusesSuppliedEvidenceBuffer()
  await testRealDriveClientSameTokenContentReplacement()
  await testBoundedDownload()
  await testConcurrentStateConflictPreservesNewestListingState()
  await testAtomicInventoryState()
  await testCrossRecordConflictBeforeWrites()
  await testMediaCountLimitBeforeExternalWrites()
  await testMaterialTargetMustBeIndependentFromLegacySource()
  testInventoryCommitAndWholeRunStatusAreSeparated()
  await testSourceContentIsRevalidatedBeforeReuse()
  await testFormalSyncReportsMaterialFailureWithoutUndoingInventory()
  console.log('feishu-note-material-pipeline-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
