'use strict'

const crypto = require('crypto')

const DEFAULT_PAGE_SIZE = 200
const DEFAULT_MAX_PAGES = 1000
const DEFAULT_MAX_ITEMS = 5000
const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_BYTES = 300 * 1024 * 1024
const SMALL_UPLOAD_LIMIT = 20 * 1024 * 1024
const NOTE_ROOT_FOLDER_NAME = '房源笔记导入-v1'

function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).normalize('NFKC').trim()
}

function tokenText(value) {
  const token = normalizeText(value)
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(token)) throw new Error('飞书素材 token 格式无效')
  return token
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function readResponseBufferBounded(response, maxBytes) {
  const declaredLength = Number(response.headers && response.headers.get && response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error('飞书房源素材超过允许大小')
    error.statusCode = 413
    throw error
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const error = new Error('飞书房源素材响应不支持有界流式读取')
    error.statusCode = 502
    throw error
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.length
      if (total > maxBytes) {
        const error = new Error('飞书房源素材超过允许大小')
        error.statusCode = 413
        throw error
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (typeof reader.cancel === 'function') {
      try {
        await reader.cancel()
      } catch (cancelError) {
        // 读取上限已经生效，取消流失败不覆盖原始错误。
      }
    }
    throw error
  }
  return Buffer.concat(chunks, total)
}

function adler32(buffer) {
  const MOD = 65521
  let a = 1
  let b = 0
  for (let index = 0; index < buffer.length; index += 1) {
    a = (a + buffer[index]) % MOD
    b = (b + a) % MOD
  }
  return String(((b << 16) | a) >>> 0)
}

function normalizeDriveItem(item) {
  const source = item && typeof item === 'object' ? item : {}
  const token = tokenText(source.token || source.file_token || source.fileToken)
  const name = normalizeText(source.name || source.file_name || source.title)
  const type = normalizeText(source.type || source.file_type || source.doc_type).toLowerCase()
  if (!name || !type) throw new Error('飞书 Drive 项目缺少名称或类型')
  const rawSize = source.size === undefined || source.size === null || source.size === ''
    ? null
    : Number(source.size)
  if (rawSize !== null && (!Number.isSafeInteger(rawSize) || rawSize < 0)) {
    throw new Error('飞书 Drive 项目大小无效')
  }
  return {
    token,
    name,
    type,
    modifiedTime: normalizeText(source.modified_time || source.modifiedTime || source.modified_at),
    size: rawSize
  }
}

function createForm(fields, fileBuffer) {
  if (typeof FormData !== 'function' || typeof Blob !== 'function') {
    throw new Error('当前 Node 运行时不支持飞书 multipart 上传')
  }
  const form = new FormData()
  Object.keys(fields).forEach((key) => form.append(key, String(fields[key])))
  if (fileBuffer) {
    form.append('file', new Blob([fileBuffer], { type: 'application/octet-stream' }), fields.file_name || 'material.bin')
  }
  return form
}

function createFeishuNoteMaterialClient(options = {}) {
  if (typeof options.fetchImpl !== 'function') throw new Error('房源笔记素材客户端缺少 fetchImpl')
  const accessToken = normalizeText(options.accessToken)
  if (!accessToken) throw new Error('房源笔记素材客户端缺少 accessToken')
  let baseUrl
  try {
    baseUrl = new URL(normalizeText(options.baseUrl || 'https://open.feishu.cn/open-apis'))
  } catch (error) {
    throw new Error('房源笔记素材客户端 baseUrl 无效')
  }
  if (baseUrl.protocol !== 'https:' && options.allowHttpForTests !== true) {
    throw new Error('房源笔记素材客户端只允许 HTTPS API')
  }
  baseUrl = baseUrl.toString().replace(/\/+$/, '')
  const pageSize = Number(options.pageSize || DEFAULT_PAGE_SIZE)
  const maxPages = Number(options.maxPages || DEFAULT_MAX_PAGES)
  const maxItems = Number(options.maxItems || DEFAULT_MAX_ITEMS)
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('飞书素材 pageSize 无效')
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) throw new Error('飞书素材 maxPages 无效')
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100000) throw new Error('飞书素材 maxItems 无效')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('飞书素材 timeoutMs 无效')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('飞书素材 maxBytes 无效')

  async function request(apiPath, requestOptions = {}, operation = '请求飞书素材') {
    if (!String(apiPath || '').startsWith('/')) throw new Error('飞书素材 API 路径无效')
    const controller = new AbortController()
    let timer
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`${operation}超时`))
        }, timeoutMs)
      })
      const response = await Promise.race([
        options.fetchImpl(`${baseUrl}${apiPath}`, {
          ...requestOptions,
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(requestOptions.headers || {})
          },
          signal: controller.signal
        }),
        timeoutPromise
      ])
      return response
    } finally {
      clearTimeout(timer)
    }
  }

  async function requestJson(apiPath, requestOptions = {}, operation = '请求飞书素材') {
    const response = await request(apiPath, requestOptions, operation)
    let body
    try {
      body = await response.json()
    } catch (error) {
      const invalid = new Error(`${operation}响应不是有效 JSON`)
      invalid.statusCode = Number(response && response.status) || 502
      throw invalid
    }
    if (!response.ok || !body || Number(body.code || 0) !== 0) {
      const failure = new Error(`${operation}失败`)
      failure.statusCode = Number(response && response.status) || 502
      failure.apiCode = Number(body && body.code) || 0
      throw failure
    }
    return body.data || {}
  }

  async function readAllPages(apiPathFactory, operation, itemKeys) {
    const items = []
    const seenTokens = new Set()
    let pageToken = ''
    for (let page = 1; page <= maxPages; page += 1) {
      const data = await requestJson(apiPathFactory(pageToken), { method: 'GET' }, operation)
      if (typeof data.has_more !== 'boolean') throw new Error(`${operation}分页缺少严格 has_more`)
      let pageItems = null
      for (const key of itemKeys) {
        if (Array.isArray(data[key])) {
          pageItems = data[key]
          break
        }
      }
      if (!pageItems) {
        const firstEmpty = page === 1 && data.has_more === false && Number(data.total || 0) === 0
        if (!firstEmpty) throw new Error(`${operation}分页缺少项目数组`)
        pageItems = []
      }
      items.push(...pageItems)
      if (items.length > maxItems) throw new Error(`${operation}数量超过安全上限`)
      if (!data.has_more) return items
      const next = normalizeText(data.next_page_token || data.page_token)
      if (!next) throw new Error(`${operation}分页声明 has_more 但缺少 page_token`)
      if (seenTokens.has(next)) throw new Error(`${operation}分页 token 循环`)
      seenTokens.add(next)
      pageToken = next
    }
    throw new Error(`${operation}分页超过安全上限`)
  }

  async function listFolder(folderToken) {
    const safeToken = tokenText(folderToken)
    const raw = await readAllPages((pageToken) => {
      const params = new URLSearchParams({
        folder_token: safeToken,
        page_size: String(pageSize)
      })
      if (pageToken) params.set('page_token', pageToken)
      return `/drive/v1/files?${params.toString()}`
    }, '列举飞书素材文件夹', ['files', 'items'])
    return raw.map(normalizeDriveItem)
  }

  async function getFile(fileToken) {
    const safeToken = tokenText(fileToken)
    const data = await requestJson('/drive/v1/metas/batch_query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        request_docs: [{ doc_token: safeToken, doc_type: 'file' }],
        with_url: false
      })
    }, '读取飞书文件元数据')
    const metas = Array.isArray(data.metas) ? data.metas : []
    if (metas.length !== 1) throw new Error('飞书文件元数据无法唯一解析')
    return normalizeDriveItem({
      token: metas[0].doc_token || safeToken,
      name: metas[0].title,
      type: metas[0].doc_type || 'file',
      modified_time: metas[0].latest_modify_time || metas[0].modified_time,
      size: metas[0].size
    })
  }

  async function listDocxBlocks(documentToken) {
    const safeToken = tokenText(documentToken)
    return readAllPages((pageToken) => {
      const params = new URLSearchParams({
        page_size: String(Math.min(pageSize, 500)),
        document_revision_id: '-1'
      })
      if (pageToken) params.set('page_token', pageToken)
      return `/docx/v1/documents/${encodeURIComponent(safeToken)}/blocks?${params.toString()}`
    }, '读取飞书文档全部块', ['items', 'blocks'])
  }

  async function resolveWikiNode(wikiToken) {
    const safeToken = tokenText(wikiToken)
    const params = new URLSearchParams({ token: safeToken })
    const data = await requestJson(`/wiki/v2/spaces/get_node?${params.toString()}`, {
      method: 'GET'
    }, '解析飞书知识库节点')
    const node = data.node && typeof data.node === 'object' ? data.node : {}
    const objToken = tokenText(node.obj_token || node.objToken)
    const objType = normalizeText(node.obj_type || node.objType).toLowerCase()
    if (!objType) throw new Error('飞书知识库节点缺少 obj_type')
    return { objToken, objType }
  }

  async function downloadToken(rawToken, preferredKind = '') {
    const safeToken = tokenText(rawToken)
    const endpoints = preferredKind === 'drive-file'
      ? [`/drive/v1/files/${encodeURIComponent(safeToken)}/download`]
      : [
          `/drive/v1/medias/${encodeURIComponent(safeToken)}/download`,
          `/drive/v1/files/${encodeURIComponent(safeToken)}/download`
        ]
    let lastError = null
    for (const endpoint of endpoints) {
      try {
        const response = await request(endpoint, { method: 'GET' }, '下载飞书房源素材')
        if (!response.ok) {
          const error = new Error('下载飞书房源素材失败')
          error.statusCode = Number(response.status) || 502
          throw error
        }
        const buffer = await readResponseBufferBounded(response, maxBytes)
        if (!buffer.length) throw new Error('飞书房源素材为空文件')
        return {
          buffer,
          size: buffer.length,
          contentType: normalizeText(response.headers && response.headers.get && response.headers.get('content-type')) ||
            'application/octet-stream',
          contentSha256: sha256Buffer(buffer)
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new Error('下载飞书房源素材失败')
  }

  async function createFolder(parentToken, name) {
    const data = await requestJson('/drive/v1/files/create_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        name: normalizeText(name),
        folder_token: tokenText(parentToken)
      })
    }, '创建房源素材目录')
    return normalizeDriveItem({
      token: data.token || data.folder_token,
      name: data.name || name,
      type: 'folder'
    })
  }

  async function uploadSmall(buffer, targetFolderToken, name) {
    const form = createForm({
      file_name: normalizeText(name),
      parent_type: 'explorer',
      parent_node: tokenText(targetFolderToken),
      size: buffer.length,
      checksum: adler32(buffer)
    }, buffer)
    const data = await requestJson('/drive/v1/files/upload_all', {
      method: 'POST',
      body: form
    }, '上传房源视频到专用云盘')
    return tokenText(data.file_token || data.token)
  }

  async function uploadLarge(buffer, targetFolderToken, name) {
    const prepared = await requestJson('/drive/v1/files/upload_prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        file_name: normalizeText(name),
        parent_type: 'explorer',
        parent_node: tokenText(targetFolderToken),
        size: buffer.length
      })
    }, '准备分片上传房源视频')
    const uploadId = normalizeText(prepared.upload_id)
    const blockSize = Number(prepared.block_size)
    const blockNum = Number(prepared.block_num)
    if (!uploadId || !Number.isSafeInteger(blockSize) || blockSize < 1 ||
        !Number.isSafeInteger(blockNum) || blockNum < 1 ||
        Math.ceil(buffer.length / blockSize) !== blockNum) {
      throw new Error('飞书分片上传策略无效')
    }
    for (let seq = 0; seq < blockNum; seq += 1) {
      const part = buffer.subarray(seq * blockSize, Math.min(buffer.length, (seq + 1) * blockSize))
      const form = createForm({
        upload_id: uploadId,
        seq,
        size: part.length,
        checksum: adler32(part),
        file_name: normalizeText(name)
      }, part)
      await requestJson('/drive/v1/files/upload_part', {
        method: 'POST',
        body: form
      }, `上传房源视频分片 ${seq + 1}/${blockNum}`)
    }
    const finished = await requestJson('/drive/v1/files/upload_finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ upload_id: uploadId, block_num: blockNum })
    }, '完成分片上传房源视频')
    return tokenText(finished.file_token || finished.token)
  }

  async function uploadFile(buffer, targetFolderToken, name) {
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
    if (!body.length || body.length > maxBytes) throw new Error('待上传房源视频大小无效')
    return body.length <= SMALL_UPLOAD_LIMIT
      ? uploadSmall(body, targetFolderToken, name)
      : uploadLarge(body, targetFolderToken, name)
  }

  function folderNameForRecord(sourceRecordId) {
    const fingerprint = crypto.createHash('sha256').update(normalizeText(sourceRecordId)).digest('hex').slice(0, 24)
    if (!fingerprint) throw new Error('房源素材目录缺少 sourceRecordId')
    return `SRC-${fingerprint}`
  }

  function safeFolderSegment(value, fallback) {
    const normalized = normalizeText(value)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\.+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
    return normalized || fallback
  }

  async function ensureChildFolder(parentFolderToken, expectedName) {
    const parent = tokenText(parentFolderToken)
    const before = (await listFolder(parent)).filter((item) => item.name === expectedName)
    if (before.length > 1 || (before.length === 1 && before[0].type !== 'folder')) {
      throw new Error('房源素材目标目录存在冲突')
    }
    if (before.length === 1) return before[0]
    let created
    try {
      created = await createFolder(parent, expectedName)
    } catch (error) {
      const afterUncertain = (await listFolder(parent)).filter((item) => item.name === expectedName)
      if (afterUncertain.length === 1 && afterUncertain[0].type === 'folder') return afterUncertain[0]
      throw error
    }
    const after = (await listFolder(parent)).filter((item) => item.name === expectedName)
    if (after.length !== 1 || after[0].type !== 'folder' || after[0].token !== created.token) {
      throw new Error('房源素材目录创建后回读不一致')
    }
    return after[0]
  }

  async function ensureListingFolder({
    parentFolderToken,
    sourceRecordId,
    district,
    block,
    locationId,
    community,
    building,
    unit,
    roomNumber
  }) {
    let current = { token: tokenText(parentFolderToken || options.targetRootFolderToken) }
    const locationName = `${safeFolderSegment(locationId, 'LOC')}__${safeFolderSegment(community, '未知小区')}`
    const roomParts = [
      safeFolderSegment(building, '未知楼栋'),
      safeFolderSegment(unit, '无单元'),
      safeFolderSegment(roomNumber, folderNameForRecord(sourceRecordId))
    ]
    const pathSegments = [
      NOTE_ROOT_FOLDER_NAME,
      safeFolderSegment(district, '未知行政区'),
      safeFolderSegment(block, '未知板块'),
      locationName,
      roomParts.join('__')
    ]
    for (const segment of pathSegments) {
      current = await ensureChildFolder(current.token, segment)
    }
    return current
  }

  async function targetFileByName(folderToken, targetName) {
    const sameName = (await listFolder(folderToken)).filter((item) => item.name === targetName)
    if (sameName.length > 1 || (sameName.length === 1 && sameName[0].type !== 'file')) {
      throw new Error('房源素材目标文件存在冲突')
    }
    return sameName[0] || null
  }

  async function checkedSourceEvidence(asset, sourceEvidence) {
    if (!sourceEvidence) return downloadToken(asset.sourceToken, asset.sourceKind)
    if (!Buffer.isBuffer(sourceEvidence.buffer) || !sourceEvidence.buffer.length ||
        sourceEvidence.buffer.length > maxBytes) {
      throw new Error('房源笔记源素材证据大小无效')
    }
    // 上层已对本次独占 Buffer 做过 SHA/大小核验；本层再次计算摘要但不复制整段视频，
    // 避免 300MB 上限文件在适配器交界处产生不必要的双倍峰值。
    const buffer = sourceEvidence.buffer
    const actualHash = sha256Buffer(buffer)
    if (sourceEvidence.contentSha256 && normalizeText(sourceEvidence.contentSha256).toLowerCase() !== actualHash) {
      throw new Error('房源笔记源素材证据摘要无效')
    }
    if (sourceEvidence.size !== undefined && sourceEvidence.size !== null && sourceEvidence.size !== '' &&
        Number(sourceEvidence.size) !== buffer.length) {
      throw new Error('房源笔记源素材证据字节数无效')
    }
    return {
      buffer,
      size: buffer.length,
      contentType: normalizeText(sourceEvidence.contentType) || normalizeText(asset && asset.mimeType) || 'application/octet-stream',
      contentSha256: actualHash
    }
  }

  async function materializeVideo({ asset, targetFolderToken, targetName, sourceEvidence }) {
    const downloaded = await checkedSourceEvidence(asset, sourceEvidence)
    let target = await targetFileByName(targetFolderToken, targetName)
    if (!target) {
      try {
        // 所有来源都上传刚完成 SHA/大小校验的 Buffer。Drive 服务端 copy 会再次按可变
        // sourceToken 取内容，存在校验后被替换的竞态，不能作为已验证内容的写入方式。
        await uploadFile(downloaded.buffer, targetFolderToken, targetName)
      } catch (error) {
        target = await targetFileByName(targetFolderToken, targetName)
        if (!target) throw error
      }
      target = await targetFileByName(targetFolderToken, targetName)
    }
    if (!target) throw new Error('房源素材目标文件写后不可见')
    const targetDownloaded = await downloadToken(target.token, 'drive-file')
    if (targetDownloaded.contentSha256 !== downloaded.contentSha256) {
      throw new Error('房源素材目标文件内容回读不一致')
    }
    return {
      targetToken: target.token,
      targetName,
      buffer: downloaded.buffer,
      contentType: downloaded.contentType,
      contentSha256: downloaded.contentSha256,
      size: downloaded.size,
      verified: true
    }
  }

  async function verifyMaterializedVideo({ targetFolderToken, targetName, contentSha256, size }) {
    const target = await targetFileByName(targetFolderToken, targetName)
    if (!target) return { verified: false }
    const downloaded = await downloadToken(target.token, 'drive-file')
    const verified = downloaded.contentSha256 === normalizeText(contentSha256) &&
      (Number(size) <= 0 || downloaded.size === Number(size))
    return {
      verified,
      targetToken: target.token,
      targetName,
      contentSha256: downloaded.contentSha256,
      size: downloaded.size
    }
  }

  return {
    listFolder,
    getFile,
    listDocxBlocks,
    resolveWikiNode,
    downloadToken,
    createFolder,
    uploadFile,
    ensureListingFolder,
    materializeVideo,
    verifyMaterializedVideo
  }
}

module.exports = {
  createFeishuNoteMaterialClient,
  normalizeDriveItem,
  sha256Buffer,
  readResponseBufferBounded,
  adler32,
  SMALL_UPLOAD_LIMIT,
  NOTE_ROOT_FOLDER_NAME
}
