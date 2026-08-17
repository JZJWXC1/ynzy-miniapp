'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')

const DEFAULT_PAGE_SIZE = 200
const DEFAULT_MAX_PAGES = 1000
const DEFAULT_MAX_ITEMS = 5000
const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_BYTES = 300 * 1024 * 1024
const SMALL_UPLOAD_LIMIT = 20 * 1024 * 1024
const NOTE_ROOT_FOLDER_NAME = '房源笔记导入-v1'
const FILE_STREAM_HIGH_WATER_MARK = 64 * 1024

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

function normalizeSha256(value) {
  const digest = normalizeText(value).toLowerCase()
  return /^[a-f0-9]{64}$/.test(digest) ? digest : ''
}

function multipartText(value, label) {
  const text = normalizeText(value)
  if (!text || /[\r\n\u0000]/.test(text)) throw new Error(`${label}无效`)
  return text
}

function multipartQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function multipartField(boundary, name, value) {
  const safeName = multipartText(name, 'multipart 字段名')
  const safeValue = multipartText(value, `multipart 字段 ${safeName}`)
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${multipartQuoted(safeName)}"\r\n\r\n${safeValue}\r\n`,
    'utf8'
  )
}

function createFileMultipart(fields, fileDescriptor, range = {}) {
  const boundary = `ynzy-note-${crypto.randomBytes(18).toString('hex')}`
  const fieldBuffers = Object.keys(fields).map((name) => multipartField(boundary, name, fields[name]))
  const fileName = multipartText(fields.file_name || 'material.bin', '房源素材文件名')
  const start = Number.isSafeInteger(Number(range.start)) ? Number(range.start) : 0
  const endExclusive = Number.isSafeInteger(Number(range.endExclusive))
    ? Number(range.endExclusive)
    : Number(fileDescriptor.size)
  if (start < 0 || endExclusive <= start || endExclusive > Number(fileDescriptor.size)) {
    throw new Error('飞书素材上传文件范围无效')
  }
  const rangeSize = endExclusive - start
  const encodedName = encodeURIComponent(fileName)
  const fileHeader = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${multipartQuoted(fileName)}"; filename*=UTF-8''${encodedName}\r\n` +
      `Content-Type: ${fileDescriptor.contentType || 'application/octet-stream'}\r\n\r\n`,
    'utf8'
  )
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const contentLength = fieldBuffers.reduce((sum, buffer) => sum + buffer.length, 0) +
    fileHeader.length + rangeSize + footer.length

  async function *streamParts() {
    for (const fieldBuffer of fieldBuffers) yield fieldBuffer
    yield fileHeader
    let streamed = 0
    const fileStream = fs.createReadStream(fileDescriptor.filePath, {
      start,
      end: endExclusive - 1,
      highWaterMark: FILE_STREAM_HIGH_WATER_MARK
    })
    for await (const chunkValue of fileStream) {
      const chunk = Buffer.from(chunkValue)
      if (!chunk.length) continue
      streamed += chunk.length
      if (streamed > rangeSize) {
        fileStream.destroy()
        throw new Error('飞书素材上传文件读取超过声明范围')
      }
      yield chunk
    }
    if (streamed !== rangeSize) throw new Error('飞书素材上传文件大小发生变化')
    yield footer
  }

  return {
    body: Readable.from(streamParts()),
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(contentLength)
    },
    contentLength
  }
}

async function consumeFileRange(filePath, start, endExclusive, visitor) {
  const stream = fs.createReadStream(filePath, {
    start,
    end: endExclusive - 1,
    highWaterMark: FILE_STREAM_HIGH_WATER_MARK
  })
  let total = 0
  for await (const chunkValue of stream) {
    const chunk = Buffer.from(chunkValue)
    if (!chunk.length) continue
    total += chunk.length
    if (total > endExclusive - start) {
      stream.destroy()
      throw new Error('房源素材文件读取超过声明范围')
    }
    visitor(chunk)
  }
  if (total !== endExclusive - start) throw new Error('房源素材文件大小发生变化')
  return total
}

async function sha256FileExact(filePath, size) {
  const hash = crypto.createHash('sha256')
  await consumeFileRange(filePath, 0, size, (chunk) => hash.update(chunk))
  return hash.digest('hex')
}

async function adler32FileRange(filePath, start, endExclusive) {
  const MOD = 65521
  let a = 1
  let b = 0
  await consumeFileRange(filePath, start, endExclusive, (chunk) => {
    for (let index = 0; index < chunk.length; index += 1) {
      a = (a + chunk[index]) % MOD
      b = (b + a) % MOD
    }
  })
  return String(((b << 16) | a) >>> 0)
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

function materialDownloadError(message, statusCode, code) {
  const error = new Error(message)
  error.statusCode = statusCode
  if (code) error.code = code
  return error
}

function assertWritableFileHandle(fileHandle) {
  if (!fileHandle || typeof fileHandle.write !== 'function' || typeof fileHandle.truncate !== 'function') {
    throw new TypeError('飞书房源素材流式下载缺少可写 FileHandle')
  }
}

function declaredContentLength(response) {
  const raw = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const text = String(raw).trim()
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw materialDownloadError('飞书房源素材大小信息无效', 502, 'FEISHU_MATERIAL_LENGTH_INVALID')
  }
  const size = Number(text)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw materialDownloadError('飞书房源素材大小信息无效', 502, 'FEISHU_MATERIAL_LENGTH_INVALID')
  }
  return size
}

async function cancelResponseBody(response, reader) {
  try {
    if (reader && typeof reader.cancel === 'function') {
      await reader.cancel()
      return
    }
    if (response && response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel()
    }
  } catch (error) {
    // 主错误和目标文件清理结果更重要；取消正文失败不得覆盖它们。
  }
}

async function truncateAfterFailure(fileHandle) {
  try {
    await fileHandle.truncate(0)
  } catch (truncateError) {
    const cleanupError = materialDownloadError(
      '飞书房源素材目标文件清理失败',
      507,
      'FEISHU_MATERIAL_FILE_CLEANUP_FAILED'
    )
    cleanupError.cause = truncateError
    throw cleanupError
  }
}

async function writeFileHandleFully(fileHandle, chunk, position) {
  let chunkOffset = 0
  while (chunkOffset < chunk.length) {
    const result = await fileHandle.write(
      chunk,
      chunkOffset,
      chunk.length - chunkOffset,
      position + chunkOffset
    )
    const bytesWritten = typeof result === 'number' ? result : Number(result && result.bytesWritten)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.length - chunkOffset) {
      throw materialDownloadError(
        '飞书房源素材写入目标文件失败',
        507,
        'FEISHU_MATERIAL_FILE_WRITE_FAILED'
      )
    }
    chunkOffset += bytesWritten
  }
}

async function readResponseToFileBounded(response, options = {}) {
  const fileHandle = options.fileHandle
  const limit = Number(options.maxBytes)
  assertWritableFileHandle(fileHandle)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('飞书素材流式下载 maxBytes 无效')

  let reader = null
  try {
    // 调用方可以复用已打开的临时文件；每次尝试都先清空，禁止旧尾部混入新摘要。
    await fileHandle.truncate(0)
    const declaredLength = declaredContentLength(response)
    if (declaredLength !== null && declaredLength > limit) {
      throw materialDownloadError('飞书房源素材超过允许大小', 413, 'FEISHU_MATERIAL_TOO_LARGE')
    }
    const contentEncoding = normalizeText(
      response && response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('content-encoding')
        : ''
    ).toLowerCase()
    if (contentEncoding && contentEncoding !== 'identity') {
      throw materialDownloadError(
        '飞书房源素材响应格式不受支持',
        502,
        'FEISHU_MATERIAL_CONTENT_ENCODING_UNSUPPORTED'
      )
    }
    if (!response || !response.body || typeof response.body.getReader !== 'function') {
      throw materialDownloadError(
        '飞书房源素材响应不支持有界流式读取',
        502,
        'FEISHU_MATERIAL_STREAM_UNAVAILABLE'
      )
    }

    reader = response.body.getReader()
    const hash = crypto.createHash('sha256')
    let total = 0
    while (true) {
      const readPromise = reader.read()
      const next = options.deadlinePromise
        ? await Promise.race([readPromise, options.deadlinePromise])
        : await readPromise
      if (next.done) break
      const chunk = Buffer.from(next.value || [])
      if (!chunk.length) continue
      if (chunk.length > limit - total) {
        throw materialDownloadError('飞书房源素材超过允许大小', 413, 'FEISHU_MATERIAL_TOO_LARGE')
      }
      await writeFileHandleFully(fileHandle, chunk, total)
      total += chunk.length
      hash.update(chunk)
      if (typeof options.isTimedOut === 'function' && options.isTimedOut()) throw options.timeoutError
    }
    if (!total) {
      throw materialDownloadError('飞书房源素材为空文件', 502, 'FEISHU_MATERIAL_EMPTY')
    }
    if (declaredLength !== null && declaredLength !== total) {
      throw materialDownloadError(
        '飞书房源素材实际大小与声明不一致',
        502,
        'FEISHU_MATERIAL_LENGTH_MISMATCH'
      )
    }
    if (typeof options.isTimedOut === 'function' && options.isTimedOut()) throw options.timeoutError
    await fileHandle.truncate(total)
    if (typeof options.isTimedOut === 'function' && options.isTimedOut()) throw options.timeoutError
    const result = {
      size: total,
      contentType: normalizeText(
        response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('content-type')
          : ''
      ) || 'application/octet-stream',
      contentSha256: hash.digest('hex')
    }
    if (typeof options.isTimedOut === 'function' && options.isTimedOut()) throw options.timeoutError
    return result
  } catch (error) {
    await cancelResponseBody(response, reader)
    await truncateAfterFailure(fileHandle)
    throw error
  } finally {
    if (reader && typeof reader.releaseLock === 'function') {
      try {
        reader.releaseLock()
      } catch (error) {
        // 已完成或已取消的正文可能自动释放锁；这里不覆盖下载结论。
      }
    }
  }
}

async function readResponseDigestExact(response, expectedSize) {
  const size = Number(expectedSize)
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new TypeError('飞书目标素材 expected size 无效')
  }
  let declaredLength
  try {
    declaredLength = declaredContentLength(response)
  } catch (error) {
    await cancelResponseBody(response, null)
    throw error
  }
  if (declaredLength !== null && declaredLength !== size) {
    await cancelResponseBody(response, null)
    throw materialDownloadError(
      declaredLength > size ? '飞书目标素材超过期望大小' : '飞书目标素材实际大小与期望不一致',
      502,
      declaredLength > size ? 'FEISHU_MATERIAL_TARGET_TOO_LARGE' : 'FEISHU_MATERIAL_TARGET_SIZE_MISMATCH'
    )
  }
  const contentEncoding = normalizeText(
    response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-encoding')
      : ''
  ).toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') {
    await cancelResponseBody(response, null)
    throw materialDownloadError(
      '飞书目标素材响应格式不受支持',
      502,
      'FEISHU_MATERIAL_CONTENT_ENCODING_UNSUPPORTED'
    )
  }
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    await cancelResponseBody(response, null)
    throw materialDownloadError(
      '飞书目标素材响应不支持有界流式读取',
      502,
      'FEISHU_MATERIAL_STREAM_UNAVAILABLE'
    )
  }

  let reader = null
  let byob = false
  try {
    try {
      reader = response.body.getReader({ mode: 'byob' })
      byob = true
    } catch (error) {
      reader = response.body.getReader()
    }
    const hash = crypto.createHash('sha256')
    let total = 0
    while (true) {
      const remainingWithSentinel = Math.min(FILE_STREAM_HIGH_WATER_MARK, (size - total) + 1)
      const next = byob
        ? await reader.read(new Uint8Array(Math.max(1, remainingWithSentinel)))
        : await reader.read()
      if (next.done) break
      const value = next.value || []
      const chunk = Buffer.from(value.buffer || value, value.byteOffset || 0, value.byteLength === undefined ? value.length : value.byteLength)
      if (!chunk.length) continue
      if (chunk.length > size - total) {
        throw materialDownloadError(
          '飞书目标素材超过期望大小',
          502,
          'FEISHU_MATERIAL_TARGET_TOO_LARGE'
        )
      }
      total += chunk.length
      hash.update(chunk)
    }
    if (total !== size) {
      throw materialDownloadError(
        '飞书目标素材实际大小与期望不一致',
        502,
        'FEISHU_MATERIAL_TARGET_SIZE_MISMATCH'
      )
    }
    return {
      size: total,
      contentType: normalizeText(
        response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('content-type')
          : ''
      ) || 'application/octet-stream',
      contentSha256: hash.digest('hex')
    }
  } catch (error) {
    await cancelResponseBody(response, reader)
    throw error
  } finally {
    if (reader && typeof reader.releaseLock === 'function') {
      try {
        reader.releaseLock()
      } catch (error) {
        // 已完成或已取消的正文可能自动释放锁；这里不覆盖严格回读结论。
      }
    }
  }
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
  const downloadTimeoutMs = Number(options.downloadTimeoutMs || timeoutMs)
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('飞书素材 pageSize 无效')
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) throw new Error('飞书素材 maxPages 无效')
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100000) throw new Error('飞书素材 maxItems 无效')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('飞书素材 timeoutMs 无效')
  if (!Number.isFinite(downloadTimeoutMs) || downloadTimeoutMs < 100 || downloadTimeoutMs > 900000) {
    throw new Error('飞书素材 downloadTimeoutMs 无效')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('飞书素材 maxBytes 无效')

  async function requestWithDeadline(
    apiPath,
    requestOptions = {},
    operation = '请求飞书素材',
    consumer = null,
    deadlineMs = timeoutMs
  ) {
    if (!String(apiPath || '').startsWith('/')) throw new Error('飞书素材 API 路径无效')
    const controller = new AbortController()
    const timeoutError = new Error(`${operation}超时`)
    timeoutError.statusCode = 504
    timeoutError.code = 'FEISHU_MATERIAL_REQUEST_TIMEOUT'
    let timedOut = false
    let timer
    const fetchOptions = { ...requestOptions }
    const onWriteDispatched = typeof fetchOptions.onWriteDispatched === 'function'
      ? fetchOptions.onWriteDispatched
      : null
    delete fetchOptions.onWriteDispatched
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(timeoutError)
        }, deadlineMs)
      })
      const response = await Promise.race([
        Promise.resolve().then(() => {
          if (onWriteDispatched) onWriteDispatched()
          return options.fetchImpl(`${baseUrl}${apiPath}`, {
            ...fetchOptions,
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              ...(fetchOptions.headers || {})
            },
            signal: controller.signal
          })
        }),
        timeoutPromise
      ])
      if (typeof consumer !== 'function') return response
      return await Promise.race([
        Promise.resolve().then(() => consumer(response)),
        timeoutPromise
      ])
    } catch (error) {
      if (timedOut || (error && error.name === 'AbortError')) throw timeoutError
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function request(apiPath, requestOptions = {}, operation = '请求飞书素材') {
    return requestWithDeadline(apiPath, requestOptions, operation)
  }

  async function requestJson(apiPath, requestOptions = {}, operation = '请求飞书素材') {
    return requestWithDeadline(apiPath, requestOptions, operation, async (response) => {
      let body
      try {
        body = await response.json()
      } catch (error) {
        if (error && error.code === 'FEISHU_MATERIAL_REQUEST_TIMEOUT') throw error
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
    })
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
        return await requestWithDeadline(endpoint, { method: 'GET' }, '下载飞书房源素材', async (response) => {
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
        }, downloadTimeoutMs)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new Error('下载飞书房源素材失败')
  }

  async function downloadTokenToFile(rawToken, preferredKind = '', downloadOptions = {}) {
    const safeToken = tokenText(rawToken)
    const fileHandle = downloadOptions.fileHandle
    const downloadMaxBytes = downloadOptions.maxBytes === undefined
      ? maxBytes
      : Number(downloadOptions.maxBytes)
    assertWritableFileHandle(fileHandle)
    if (!Number.isSafeInteger(downloadMaxBytes) || downloadMaxBytes < 1) {
      throw new TypeError('飞书素材流式下载 maxBytes 无效')
    }
    const endpoints = preferredKind === 'drive-file'
      ? [`/drive/v1/files/${encodeURIComponent(safeToken)}/download`]
      : [
          `/drive/v1/medias/${encodeURIComponent(safeToken)}/download`,
          `/drive/v1/files/${encodeURIComponent(safeToken)}/download`
        ]
    let lastError = null
    for (const endpoint of endpoints) {
      const controller = new AbortController()
      const externalSignal = downloadOptions.signal
      const forwardExternalAbort = () => controller.abort()
      if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        externalSignal.addEventListener('abort', forwardExternalAbort, { once: true })
        if (externalSignal.aborted) controller.abort()
      }
      const timeoutError = materialDownloadError(
        '下载飞书房源素材超时',
        504,
        'FEISHU_MATERIAL_DOWNLOAD_TIMEOUT'
      )
      let timedOut = false
      let timer
      const deadlinePromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(timeoutError)
        }, downloadTimeoutMs)
      })
      let response = null
      try {
        await fileHandle.truncate(0)
        response = await Promise.race([
          options.fetchImpl(`${baseUrl}${endpoint}`, {
            method: 'GET',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Accept-Encoding': 'identity'
            },
            signal: controller.signal
          }),
          deadlinePromise
        ])
        if (!response || !response.ok) {
          await cancelResponseBody(response, null)
          const error = new Error('下载飞书房源素材失败')
          error.statusCode = Number(response && response.status) || 502
          throw error
        }
        return await readResponseToFileBounded(response, {
          fileHandle,
          maxBytes: downloadMaxBytes,
          deadlinePromise,
          isTimedOut: () => timedOut,
          timeoutError
        })
      } catch (error) {
        controller.abort()
        await cancelResponseBody(response, null)
        try {
          await truncateAfterFailure(fileHandle)
        } catch (cleanupError) {
          throw cleanupError
        }
        if (error && [
          'FEISHU_MATERIAL_FILE_CLEANUP_FAILED',
          'FEISHU_MATERIAL_FILE_WRITE_FAILED'
        ].includes(error.code)) throw error
        if (externalSignal && externalSignal.aborted) {
          throw materialDownloadError(
            '下载飞书房源素材已取消',
            499,
            'FEISHU_MATERIAL_DOWNLOAD_ABORTED'
          )
        }
        lastError = timedOut ? timeoutError : error
      } finally {
        clearTimeout(timer)
        if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
          externalSignal.removeEventListener('abort', forwardExternalAbort)
        }
      }
    }
    throw lastError || new Error('下载飞书房源素材失败')
  }

  async function downloadTokenDigestExact(rawToken, preferredKind, expectedSize, downloadOptions = {}) {
    const safeToken = tokenText(rawToken)
    const size = Number(expectedSize)
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new TypeError('飞书目标素材 expected size 无效')
    }
    const extra = normalizeText(downloadOptions && downloadOptions.extra)
    if (extra && (extra.length > 8192 || /[\r\n\u0000]/.test(extra))) {
      throw new Error('飞书目标素材下载扩展参数无效')
    }
    const mediaParams = extra ? `?${new URLSearchParams({ extra }).toString()}` : ''
    const mediaEndpoint = `/drive/v1/medias/${encodeURIComponent(safeToken)}/download${mediaParams}`
    const endpoints = preferredKind === 'drive-file'
      ? [`/drive/v1/files/${encodeURIComponent(safeToken)}/download`]
      : (preferredKind === 'bitable-file'
          ? [mediaEndpoint]
          : [
              mediaEndpoint,
              `/drive/v1/files/${encodeURIComponent(safeToken)}/download`
            ])
    let lastError = null
    for (const endpoint of endpoints) {
      const controller = new AbortController()
      const timeoutError = materialDownloadError(
        '回读飞书目标素材超时',
        504,
        'FEISHU_MATERIAL_TARGET_READBACK_TIMEOUT'
      )
      let timer
      const deadlinePromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(timeoutError)
        }, downloadTimeoutMs)
      })
      let response = null
      try {
        response = await Promise.race([
          options.fetchImpl(`${baseUrl}${endpoint}`, {
            method: 'GET',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Accept-Encoding': 'identity'
            },
            signal: controller.signal
          }),
          deadlinePromise
        ])
        if (!response || !response.ok) {
          await cancelResponseBody(response, null)
          const error = new Error('回读飞书目标素材失败')
          error.statusCode = Number(response && response.status) || 502
          throw error
        }
        return await Promise.race([
          readResponseDigestExact(response, size),
          deadlinePromise
        ])
      } catch (error) {
        controller.abort()
        await cancelResponseBody(response, null)
        lastError = error
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError || new Error('回读飞书目标素材失败')
  }

  async function createFolder(parentToken, name, onWriteDispatched) {
    const data = await requestJson('/drive/v1/files/create_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        name: normalizeText(name),
        folder_token: tokenText(parentToken)
      }),
      onWriteDispatched
    }, '创建房源素材目录')
    return normalizeDriveItem({
      token: data.token || data.folder_token,
      name: data.name || name,
      type: 'folder'
    })
  }

  async function uploadSmall(buffer, targetFolderToken, name, onWriteDispatched) {
    const form = createForm({
      file_name: normalizeText(name),
      parent_type: 'explorer',
      parent_node: tokenText(targetFolderToken),
      size: buffer.length,
      checksum: adler32(buffer)
    }, buffer)
    const data = await requestJson('/drive/v1/files/upload_all', {
      method: 'POST',
      body: form,
      onWriteDispatched
    }, '上传房源视频到专用云盘')
    return tokenText(data.file_token || data.token)
  }

  async function uploadLarge(buffer, targetFolderToken, name, onWriteDispatched) {
    const prepared = await requestJson('/drive/v1/files/upload_prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        file_name: normalizeText(name),
        parent_type: 'explorer',
        parent_node: tokenText(targetFolderToken),
        size: buffer.length
      }),
      onWriteDispatched
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
        body: form,
        onWriteDispatched
      }, `上传房源视频分片 ${seq + 1}/${blockNum}`)
    }
    const finished = await requestJson('/drive/v1/files/upload_finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ upload_id: uploadId, block_num: blockNum }),
      onWriteDispatched
    }, '完成分片上传房源视频')
    return tokenText(finished.file_token || finished.token)
  }

  async function uploadFile(buffer, targetFolderToken, name, onWriteDispatched) {
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
    if (!body.length || body.length > maxBytes) throw new Error('待上传房源视频大小无效')
    return body.length <= SMALL_UPLOAD_LIMIT
      ? uploadSmall(body, targetFolderToken, name, onWriteDispatched)
      : uploadLarge(body, targetFolderToken, name, onWriteDispatched)
  }

  async function checkedPreparedFileEvidence(sourceEvidence) {
    const source = sourceEvidence && typeof sourceEvidence === 'object' ? sourceEvidence : {}
    const rawFilePath = typeof source.filePath === 'string' ? source.filePath : ''
    if (!rawFilePath || !path.isAbsolute(rawFilePath)) {
      throw new Error('房源笔记成品素材缺少绝对文件路径')
    }
    const declaredSize = Number(source.size)
    const declaredHash = normalizeSha256(source.contentSha256)
    const contentType = multipartText(source.contentType || 'application/octet-stream', '房源笔记成品素材类型')
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maxBytes) {
      throw new Error('房源笔记成品素材大小无效')
    }
    if (!declaredHash) throw new Error('房源笔记成品素材摘要无效')

    let stats
    let realFilePath
    try {
      stats = await fs.promises.lstat(rawFilePath)
      realFilePath = await fs.promises.realpath(rawFilePath)
    } catch (error) {
      throw new Error('房源笔记成品素材文件不可读取')
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== declaredSize) {
      throw new Error('房源笔记成品素材文件大小无效')
    }
    const resolvedInput = path.resolve(rawFilePath)
    const resolvedReal = path.resolve(realFilePath)
    const samePath = process.platform === 'win32'
      ? resolvedInput.toLowerCase() === resolvedReal.toLowerCase()
      : resolvedInput === resolvedReal
    if (!samePath) throw new Error('房源笔记成品素材文件边界无效')
    const actualHash = await sha256FileExact(resolvedReal, declaredSize)
    if (actualHash !== declaredHash) throw new Error('房源笔记成品素材摘要无效')
    return {
      filePath: resolvedReal,
      size: declaredSize,
      contentType,
      contentSha256: actualHash
    }
  }

  async function uploadSmallFile(fileDescriptor, targetFolderToken, name, onWriteDispatched) {
    const checksum = await adler32FileRange(fileDescriptor.filePath, 0, fileDescriptor.size)
    const multipart = createFileMultipart({
      file_name: normalizeText(name),
      parent_type: 'explorer',
      parent_node: tokenText(targetFolderToken),
      size: fileDescriptor.size,
      checksum
    }, fileDescriptor)
    const data = await requestJson('/drive/v1/files/upload_all', {
      method: 'POST',
      headers: multipart.headers,
      body: multipart.body,
      duplex: 'half',
      onWriteDispatched
    }, '流式上传房源素材到专用云盘')
    return tokenText(data.file_token || data.token)
  }

  async function uploadLargeFile(fileDescriptor, targetFolderToken, name, onWriteDispatched) {
    const prepared = await requestJson('/drive/v1/files/upload_prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        file_name: normalizeText(name),
        parent_type: 'explorer',
        parent_node: tokenText(targetFolderToken),
        size: fileDescriptor.size
      }),
      onWriteDispatched
    }, '准备流式分片上传房源素材')
    const uploadId = normalizeText(prepared.upload_id)
    const blockSize = Number(prepared.block_size)
    const blockNum = Number(prepared.block_num)
    if (!uploadId || !Number.isSafeInteger(blockSize) || blockSize < 1 ||
        !Number.isSafeInteger(blockNum) || blockNum < 1 ||
        Math.ceil(fileDescriptor.size / blockSize) !== blockNum) {
      throw new Error('飞书分片上传策略无效')
    }
    for (let seq = 0; seq < blockNum; seq += 1) {
      const start = seq * blockSize
      const endExclusive = Math.min(fileDescriptor.size, (seq + 1) * blockSize)
      const partSize = endExclusive - start
      const checksum = await adler32FileRange(fileDescriptor.filePath, start, endExclusive)
      const multipart = createFileMultipart({
        upload_id: uploadId,
        seq,
        size: partSize,
        checksum,
        file_name: normalizeText(name)
      }, fileDescriptor, { start, endExclusive })
      await requestJson('/drive/v1/files/upload_part', {
        method: 'POST',
        headers: multipart.headers,
        body: multipart.body,
        duplex: 'half',
        onWriteDispatched
      }, `流式上传房源素材分片 ${seq + 1}/${blockNum}`)
    }
    const finished = await requestJson('/drive/v1/files/upload_finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ upload_id: uploadId, block_num: blockNum }),
      onWriteDispatched
    }, '完成流式分片上传房源素材')
    return tokenText(finished.file_token || finished.token)
  }

  async function uploadCheckedFileDescriptor(fileDescriptor, targetFolderToken, name, onWriteDispatched) {
    return fileDescriptor.size <= SMALL_UPLOAD_LIMIT
      ? uploadSmallFile(fileDescriptor, targetFolderToken, name, onWriteDispatched)
      : uploadLargeFile(fileDescriptor, targetFolderToken, name, onWriteDispatched)
  }

  async function uploadFileDescriptor(rawDescriptor, targetFolderToken, name, onWriteDispatched) {
    const fileDescriptor = await checkedPreparedFileEvidence(rawDescriptor)
    return uploadCheckedFileDescriptor(fileDescriptor, targetFolderToken, name, onWriteDispatched)
  }

  async function uploadSmallBitableFile(fileDescriptor, targetAppToken, name, onWriteDispatched) {
    const targetBaseToken = tokenText(targetAppToken)
    const checksum = await adler32FileRange(fileDescriptor.filePath, 0, fileDescriptor.size)
    const multipart = createFileMultipart({
      file_name: multipartText(name, '小程序专用表附件名称'),
      parent_type: 'bitable_file',
      parent_node: targetBaseToken,
      extra: JSON.stringify({ drive_route_token: targetBaseToken }),
      size: fileDescriptor.size,
      checksum
    }, fileDescriptor)
    const data = await requestJson('/drive/v1/medias/upload_all', {
      method: 'POST',
      headers: multipart.headers,
      body: multipart.body,
      duplex: 'half',
      onWriteDispatched
    }, '上传主视频到小程序专用表')
    return tokenText(data.file_token || data.token)
  }

  async function uploadLargeBitableFile(fileDescriptor, targetAppToken, name, onWriteDispatched) {
    const fileName = multipartText(name, '小程序专用表附件名称')
    const targetBaseToken = tokenText(targetAppToken)
    const prepared = await requestJson('/drive/v1/medias/upload_prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        file_name: fileName,
        parent_type: 'bitable_file',
        parent_node: targetBaseToken,
        extra: JSON.stringify({ drive_route_token: targetBaseToken }),
        size: fileDescriptor.size
      }),
      onWriteDispatched
    }, '准备分片上传主视频到小程序专用表')
    const uploadId = normalizeText(prepared.upload_id)
    const blockSize = Number(prepared.block_size)
    const blockNum = Number(prepared.block_num)
    if (!uploadId || !Number.isSafeInteger(blockSize) || blockSize < 1 ||
        !Number.isSafeInteger(blockNum) || blockNum < 1 ||
        Math.ceil(fileDescriptor.size / blockSize) !== blockNum) {
      throw new Error('小程序专用表附件分片策略无效')
    }
    for (let seq = 0; seq < blockNum; seq += 1) {
      const start = seq * blockSize
      const endExclusive = Math.min(fileDescriptor.size, (seq + 1) * blockSize)
      const partSize = endExclusive - start
      const checksum = await adler32FileRange(fileDescriptor.filePath, start, endExclusive)
      const multipart = createFileMultipart({
        upload_id: uploadId,
        seq,
        size: partSize,
        checksum,
        file_name: fileName
      }, fileDescriptor, { start, endExclusive })
      await requestJson('/drive/v1/medias/upload_part', {
        method: 'POST',
        headers: multipart.headers,
        body: multipart.body,
        duplex: 'half',
        onWriteDispatched
      }, `分片上传主视频到小程序专用表 ${seq + 1}/${blockNum}`)
    }
    const finished = await requestJson('/drive/v1/medias/upload_finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ upload_id: uploadId, block_num: blockNum }),
      onWriteDispatched
    }, '完成分片上传主视频到小程序专用表')
    return tokenText(finished.file_token || finished.token)
  }

  async function uploadBitableFileDescriptor(rawDescriptor, targetAppToken, name, onWriteDispatched) {
    const fileDescriptor = await checkedPreparedFileEvidence(rawDescriptor)
    const fileToken = fileDescriptor.size <= SMALL_UPLOAD_LIMIT
      ? await uploadSmallBitableFile(fileDescriptor, targetAppToken, name, onWriteDispatched)
      : await uploadLargeBitableFile(fileDescriptor, targetAppToken, name, onWriteDispatched)
    return {
      fileToken,
      contentType: fileDescriptor.contentType,
      contentSha256: fileDescriptor.contentSha256,
      size: fileDescriptor.size
    }
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

  async function ensureChildFolder(parentFolderToken, expectedName, onWriteDispatched, onWriteVerified) {
    const parent = tokenText(parentFolderToken)
    const before = (await listFolder(parent)).filter((item) => item.name === expectedName)
    if (before.length > 1 || (before.length === 1 && before[0].type !== 'folder')) {
      throw new Error('房源素材目标目录存在冲突')
    }
    if (before.length === 1) return before[0]
    let created
    try {
      created = await createFolder(parent, expectedName, onWriteDispatched)
    } catch (error) {
      const afterUncertain = (await listFolder(parent)).filter((item) => item.name === expectedName)
      if (afterUncertain.length === 1 && afterUncertain[0].type === 'folder') {
        if (typeof onWriteVerified === 'function') onWriteVerified()
        return afterUncertain[0]
      }
      throw error
    }
    const after = (await listFolder(parent)).filter((item) => item.name === expectedName)
    if (after.length !== 1 || after[0].type !== 'folder' || after[0].token !== created.token) {
      throw new Error('房源素材目录创建后回读不一致')
    }
    if (typeof onWriteVerified === 'function') onWriteVerified()
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
    roomNumber,
    onWriteDispatched,
    onWriteVerified
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
      current = await ensureChildFolder(current.token, segment, onWriteDispatched, onWriteVerified)
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

  async function materializeAsset({
    asset,
    targetFolderToken,
    targetName,
    sourceEvidence,
    onWriteDispatched,
    onWriteVerified
  }) {
    const preparedFile = sourceEvidence && typeof sourceEvidence.filePath === 'string'
      ? await checkedPreparedFileEvidence(sourceEvidence)
      : null
    // 旧调用方仍可短期使用独占 Buffer；生产标准化链路必须传 filePath 描述符，
    // 这样 Drive 上传和回读全程都不再把成品文件装入整块内存。
    const downloaded = preparedFile || await checkedSourceEvidence(asset, sourceEvidence)
    let writeDispatched = false
    const markWriteDispatched = () => {
      writeDispatched = true
      if (typeof onWriteDispatched === 'function') onWriteDispatched()
    }
    let target = await targetFileByName(targetFolderToken, targetName)
    if (!target) {
      try {
        if (preparedFile) {
          await uploadCheckedFileDescriptor(preparedFile, targetFolderToken, targetName, markWriteDispatched)
        } else {
          // 兼容旧适配器，但仍禁止按可变 sourceToken 做服务端 copy。
          await uploadFile(downloaded.buffer, targetFolderToken, targetName, markWriteDispatched)
        }
      } catch (error) {
        target = await targetFileByName(targetFolderToken, targetName)
        if (!target) throw error
      }
      target = await targetFileByName(targetFolderToken, targetName)
    }
    if (!target) throw new Error('房源素材目标文件写后不可见')
    if (target.size !== null && target.size !== downloaded.size) {
      throw new Error('房源素材目标文件大小回读不一致')
    }
    const targetDownloaded = await downloadTokenDigestExact(target.token, 'drive-file', downloaded.size)
    if (targetDownloaded.contentSha256 !== downloaded.contentSha256 || targetDownloaded.size !== downloaded.size) {
      throw new Error('房源素材目标文件内容回读不一致')
    }
    if (writeDispatched && typeof onWriteVerified === 'function') onWriteVerified()
    return {
      targetToken: target.token,
      targetName,
      contentType: downloaded.contentType,
      contentSha256: downloaded.contentSha256,
      size: downloaded.size,
      verified: true
    }
  }

  async function verifyMaterializedAsset({ targetFolderToken, targetName, contentSha256, size }) {
    const expectedHash = normalizeSha256(contentSha256)
    const expectedSize = Number(size)
    if (!expectedHash) throw new Error('房源素材目标文件摘要无效')
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) {
      throw new Error('房源素材目标文件大小无效')
    }
    const target = await targetFileByName(targetFolderToken, targetName)
    if (!target) return { verified: false }
    if (target.size !== null && target.size !== expectedSize) {
      throw new Error('房源素材目标文件大小回读不一致')
    }
    const downloaded = await downloadTokenDigestExact(target.token, 'drive-file', expectedSize)
    const verified = downloaded.contentSha256 === expectedHash && downloaded.size === expectedSize
    return {
      verified,
      targetToken: target.token,
      targetName,
      contentSha256: downloaded.contentSha256,
      size: downloaded.size
    }
  }

  return {
    writeDispatchEvidenceVersion: 1,
    listFolder,
    getFile,
    listDocxBlocks,
    resolveWikiNode,
    downloadToken,
    downloadTokenToFile,
    downloadTokenDigestExact,
    createFolder,
    uploadFile,
    uploadFileDescriptor,
    uploadBitableFileDescriptor,
    ensureListingFolder,
    materializeAsset,
    verifyMaterializedAsset,
    // 兼容旧控制器的方法名；正式标准化链路使用受信文件描述符并全程流式处理。
    materializeVideo: materializeAsset,
    verifyMaterializedVideo: verifyMaterializedAsset
  }
}

module.exports = {
  createFeishuNoteMaterialClient,
  normalizeDriveItem,
  sha256Buffer,
  readResponseBufferBounded,
  readResponseToFileBounded,
  adler32,
  SMALL_UPLOAD_LIMIT,
  NOTE_ROOT_FOLDER_NAME
}
