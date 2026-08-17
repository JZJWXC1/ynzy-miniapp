'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

if (process.env.YNZY_OSS_STREAMING_CHILD !== '1') {
  const child = spawnSync(process.execPath, ['--max-old-space-size=32', __filename], {
    env: { ...process.env, YNZY_OSS_STREAMING_CHILD: '1' },
    encoding: 'utf8',
    timeout: 120000
  })
  if (child.status !== 0) {
    process.stderr.write(String(child.stdout || ''))
    process.stderr.write(String(child.stderr || ''))
    process.exit(child.status === null ? 1 : child.status)
  }
  process.stdout.write(String(child.stdout || ''))
  process.exit(0)
}
const { EventEmitter } = require('events')
const { createFeishuNoteMaterialClient } = require('../src/feishu-note-material-client')

process.env.ALI_OSS_BUCKET = 'synthetic-streaming-bucket'
process.env.ALI_OSS_REGION = 'oss-cn-hangzhou'
process.env.ALI_OSS_ACCESS_KEY_ID = 'synthetic-streaming-key'
process.env.ALI_OSS_ACCESS_KEY_SECRET = 'synthetic-streaming-secret'
process.env.ALI_OSS_MAX_VIDEO_MB = '16'

const originalRequest = https.request
const originalReadFile = fs.readFile
const originalReadFileSync = fs.readFileSync
const originalPromisesReadFile = fs.promises.readFile
const originalPromisesLstat = fs.promises.lstat
const originalPromisesOpen = fs.promises.open
const originalBufferConcat = Buffer.concat
const calls = []
const patternChunk = Buffer.alloc(64 * 1024, 0x5a)
patternChunk.writeUInt32BE(24, 0)
patternChunk.write('ftypisom', 4, 'ascii')

let remoteMode = 'missing'
let remoteObject = null
let expectedSize = 0
let sourcePath = ''
let wholeFileReadAttempts = 0
let mutateDuringPut = null
let earlyPutConflict = null
let slowDripResponse = false

function sha256FilePattern(size) {
  const hash = crypto.createHash('sha256')
  let remaining = size
  while (remaining > 0) {
    const chunk = remaining >= patternChunk.length ? patternChunk : patternChunk.subarray(0, remaining)
    hash.update(chunk)
    remaining -= chunk.length
  }
  return hash.digest('hex')
}

function createPatternFile(filePath, size) {
  const handle = fs.openSync(filePath, 'wx', 0o600)
  try {
    let remaining = size
    while (remaining > 0) {
      const chunk = remaining >= patternChunk.length ? patternChunk : patternChunk.subarray(0, remaining)
      fs.writeSync(handle, chunk)
      remaining -= chunk.length
    }
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  return sha256FilePattern(size)
}

function noteDownloadResponse(chunks = [], options = {}) {
  const bodies = chunks.map((chunk) => Buffer.from(chunk))
  const status = Number(options.status || 200)
  const declaredLength = options.contentLength === undefined
    ? bodies.reduce((sum, chunk) => sum + chunk.length, 0)
    : options.contentLength
  let readerCancelled = 0
  let bodyCancelled = 0
  return {
    response: {
      ok: options.ok === undefined ? status >= 200 && status < 300 : options.ok,
      status,
      headers: {
        get(name) {
          const key = String(name).toLowerCase()
          if (key === 'content-length') return declaredLength === null ? null : String(declaredLength)
          if (key === 'content-type') return options.contentType || 'video/mp4'
          if (key === 'content-encoding') return options.contentEncoding || ''
          return ''
        }
      },
      body: {
        async cancel() { bodyCancelled += 1 },
        getReader() {
          let index = 0
          return {
            async read() {
              if (index < bodies.length) return { done: false, value: bodies[index++] }
              if (options.terminalError) throw options.terminalError
              return { done: true }
            },
            async cancel() { readerCancelled += 1 },
            releaseLock() {}
          }
        }
      }
    },
    readerCancelled: () => readerCancelled,
    bodyCancelled: () => bodyCancelled
  }
}

function noteDownloadError(code, message = code) {
  const error = new Error(message)
  if (code) error.code = code
  return error
}

function createNoteDownloadSequence(steps) {
  const pending = steps.slice()
  const calls = []
  return {
    calls,
    remaining: () => pending.length,
    async fetchImpl(url, options = {}) {
      const parsed = new URL(url)
      calls.push({
        at: Date.now(),
        method: options.method,
        pathname: parsed.pathname,
        redirect: options.redirect,
        acceptEncoding: options.headers && options.headers['Accept-Encoding']
      })
      if (!pending.length) throw new Error('下载重试序列收到额外请求')
      const step = pending.shift()
      if (step && Object.prototype.hasOwnProperty.call(step, 'throwValue')) throw step.throwValue
      return typeof step === 'function' ? step(options, calls.length) : step
    }
  }
}

function assertNoteDownloadCalls(calls, expectedPaths) {
  assert.deepStrictEqual(calls.map((call) => call.pathname), expectedPaths)
  for (const call of calls) {
    assert.strictEqual(call.method, 'GET')
    assert.strictEqual(call.redirect, 'error')
    assert.strictEqual(call.acceptEncoding, 'identity')
  }
}

async function withNoteDownloadFile(tempRoot, label, task) {
  const targetPath = path.join(tempRoot, `note-download-${label}.tmp`)
  const fileHandle = await originalPromisesOpen.call(fs.promises, targetPath, 'w+', 0o600)
  try {
    return await task(fileHandle, targetPath)
  } finally {
    await fileHandle.close()
  }
}

function createNoteDownloadClient(sequence, downloadTimeoutMs = 3000) {
  return createFeishuNoteMaterialClient({
    accessToken: 'syntheticTenantToken123',
    downloadTimeoutMs,
    fetchImpl: sequence.fetchImpl
  })
}

async function readExactFileBytes(fileHandle) {
  const size = (await fileHandle.stat()).size
  const bytes = Buffer.alloc(size)
  if (size) {
    const readResult = await fileHandle.read(bytes, 0, size, 0)
    assert.strictEqual(readResult.bytesRead, size)
  }
  return bytes
}

async function testDownloadTransientRetryAndReset(tempRoot) {
  const sentinel = noteDownloadError('ECONNRESET', 'synthetic-download-stream-failure')
  const failed = noteDownloadResponse([
    Buffer.from('partial-old-bytes-that-are-longer-than-success')
  ], { terminalError: sentinel })
  const expected = Buffer.from('fresh')
  const succeeded = noteDownloadResponse([
    expected.subarray(0, 2),
    expected.subarray(2)
  ])
  let sequence

  await withNoteDownloadFile(tempRoot, 'transient-reset', async (fileHandle) => {
    sequence = createNoteDownloadSequence([
      async () => {
        assert.strictEqual((await fileHandle.stat()).size, 0, '首次 GET 发出前必须清除调用前旧尾部')
        return failed.response
      },
      async () => {
        assert.strictEqual((await fileHandle.stat()).size, 0, '重试 GET 发出前必须清除失败尝试部分字节')
        return succeeded.response
      }
    ])
    const client = createNoteDownloadClient(sequence)
    await fileHandle.writeFile(Buffer.from('stale-tail-must-not-survive'))
    const result = await client.downloadTokenToFile('fileSequenceToken123', 'drive-file', {
      fileHandle,
      maxBytes: 1024
    })
    assert.strictEqual(result.size, expected.length)
    assert.strictEqual(result.contentSha256, crypto.createHash('sha256').update(expected).digest('hex'))
    assert.deepStrictEqual(
      await readExactFileBytes(fileHandle),
      expected,
      '成功重试不得混入失败尝试或调用前旧尾部'
    )
  })
  assert.strictEqual(failed.readerCancelled(), 1, '流中途失败必须取消对应 reader')
  assert.strictEqual(sequence.remaining(), 0)
  assertNoteDownloadCalls(sequence.calls, [
    '/open-apis/drive/v1/files/fileSequenceToken123/download',
    '/open-apis/drive/v1/files/fileSequenceToken123/download'
  ])
  assert.ok(sequence.calls[1].at - sequence.calls[0].at >= 175, '首次重试必须执行固定 200ms 退避')
}

async function testDownloadRetryableClosedSet(tempRoot) {
  const nestedUndici = new TypeError('fetch failed')
  nestedUndici.cause = noteDownloadError('UND_ERR_SOCKET')
  const cases = [
    ['request-timeout', { throwValue: noteDownloadError('FEISHU_MATERIAL_REQUEST_TIMEOUT') }],
    ['download-timeout', { throwValue: noteDownloadError('FEISHU_MATERIAL_DOWNLOAD_TIMEOUT') }],
    ['nested-undici', { throwValue: nestedUndici }],
    ['undici-connect-timeout', { throwValue: noteDownloadError('UND_ERR_CONNECT_TIMEOUT') }],
    ['undici-length-mismatch', { throwValue: noteDownloadError('UND_ERR_RES_CONTENT_LENGTH_MISMATCH') }],
    ['eai-again', { throwValue: noteDownloadError('EAI_AGAIN') }],
    ['not-found-network', { throwValue: noteDownloadError('ENOTFOUND') }],
    ['net-unreachable', { throwValue: noteDownloadError('ENETUNREACH') }],
    ['host-unreachable', { throwValue: noteDownloadError('EHOSTUNREACH') }],
    ['http-408', noteDownloadResponse([], { status: 408 }).response],
    ['http-425', noteDownloadResponse([], { status: 425 }).response],
    ['http-429', noteDownloadResponse([], { status: 429 }).response],
    ['http-503', noteDownloadResponse([], { status: 503 }).response],
    ['empty-stream', noteDownloadResponse([]).response],
    ['length-mismatch', noteDownloadResponse([Buffer.from('short')], { contentLength: 99 }).response]
  ]

  for (const [label, firstStep] of cases) {
    const expected = Buffer.from(`fresh-${label}`)
    const sequence = createNoteDownloadSequence([
      firstStep,
      noteDownloadResponse([expected]).response
    ])
    const client = createNoteDownloadClient(sequence)
    await withNoteDownloadFile(tempRoot, `retryable-${label}`, async (fileHandle) => {
      const result = await client.downloadTokenToFile('fileSequenceToken123', 'drive-file', {
        fileHandle,
        maxBytes: 1024
      })
      assert.strictEqual(result.size, expected.length, `${label} 必须在一次有界重试后成功`)
      assert.deepStrictEqual(await readExactFileBytes(fileHandle), expected)
    })
    assert.strictEqual(sequence.calls.length, 2, `${label} 必须且只能重试一次`)
    assert.strictEqual(sequence.remaining(), 0)
  }
}

async function testDownloadGlobalBudgetAndFallback(tempRoot) {
  const mediaPath = '/open-apis/drive/v1/medias/fileSequenceToken123/download'
  const filePath = '/open-apis/drive/v1/files/fileSequenceToken123/download'
  const fallbackBytes = Buffer.from('fallback-file-bytes')
  const fallbackSequence = createNoteDownloadSequence([
    noteDownloadResponse([], { status: 404 }).response,
    noteDownloadResponse([], { status: 404 }).response,
    noteDownloadResponse([fallbackBytes]).response
  ])
  const fallbackClient = createNoteDownloadClient(fallbackSequence)
  await withNoteDownloadFile(tempRoot, 'fallback-budget', async (fileHandle) => {
    const result = await fallbackClient.downloadTokenToFile('fileSequenceToken123', '', {
      fileHandle,
      maxBytes: 1024
    })
    assert.strictEqual(result.size, fallbackBytes.length)
    assert.deepStrictEqual(await readExactFileBytes(fileHandle), fallbackBytes)
  })
  assertNoteDownloadCalls(fallbackSequence.calls, [mediaPath, mediaPath, filePath])
  assert.strictEqual(fallbackSequence.remaining(), 0, '404 同端点重读与 fallback 必须共用总计 3 次预算')
  assert.ok(fallbackSequence.calls[1].at - fallbackSequence.calls[0].at >= 175)
  assert.ok(fallbackSequence.calls[2].at - fallbackSequence.calls[1].at >= 375)

  const directFallbackSequence = createNoteDownloadSequence([
    noteDownloadResponse([], { status: 400 }).response,
    noteDownloadResponse([fallbackBytes]).response
  ])
  const directFallbackClient = createNoteDownloadClient(directFallbackSequence)
  await withNoteDownloadFile(tempRoot, 'fallback-400', async (fileHandle) => {
    await directFallbackClient.downloadTokenToFile('fileSequenceToken123', '', {
      fileHandle,
      maxBytes: 1024
    })
  })
  assertNoteDownloadCalls(directFallbackSequence.calls, [mediaPath, filePath])

  const exhaustedResponses = Array.from({ length: 3 }, () => noteDownloadResponse([], { status: 503 }))
  const exhaustedSequence = createNoteDownloadSequence(exhaustedResponses.map((entry) => entry.response))
  const exhaustedClient = createNoteDownloadClient(exhaustedSequence)
  await withNoteDownloadFile(tempRoot, 'exhausted-budget', async (fileHandle) => {
    await assert.rejects(
      () => exhaustedClient.downloadTokenToFile('fileSequenceToken123', '', { fileHandle, maxBytes: 1024 }),
      (error) => error && error.statusCode === 503,
      '临时 HTTP 失败耗尽 3 次后必须返回最后错误'
    )
    assert.strictEqual((await fileHandle.stat()).size, 0)
  })
  assertNoteDownloadCalls(exhaustedSequence.calls, [mediaPath, mediaPath, mediaPath])
  assert.strictEqual(exhaustedSequence.remaining(), 0, '临时失败耗尽原端点预算后不得再 fallback 成第 4 次请求')
  for (const response of exhaustedResponses) {
    assert.strictEqual(response.bodyCancelled(), 1, '每个失败 HTTP 响应体都必须在下一次请求前取消')
  }

  const drive404Sequence = createNoteDownloadSequence([
    noteDownloadResponse([], { status: 404 }).response,
    noteDownloadResponse([], { status: 404 }).response
  ])
  const drive404Client = createNoteDownloadClient(drive404Sequence)
  await withNoteDownloadFile(tempRoot, 'drive-file-404', async (fileHandle) => {
    await assert.rejects(
      () => drive404Client.downloadTokenToFile('fileSequenceToken123', 'drive-file', { fileHandle, maxBytes: 1024 }),
      (error) => error && error.statusCode === 404
    )
  })
  assertNoteDownloadCalls(drive404Sequence.calls, [filePath, filePath])
}

async function testDownloadPermanentFailuresAndAbort(tempRoot) {
  const permanentCases = [
    ['http-401', noteDownloadResponse([], { status: 401 }).response],
    ['http-403', noteDownloadResponse([], { status: 403 }).response],
    ['http-409', noteDownloadResponse([], { status: 409 }).response],
    ['http-413', noteDownloadResponse([], { status: 413 }).response],
    ['http-416', noteDownloadResponse([], { status: 416 }).response],
    ['http-422', noteDownloadResponse([], { status: 422 }).response],
    ['undici-aborted', { throwValue: noteDownloadError('UND_ERR_ABORTED') }],
    ['undici-size-limit', { throwValue: noteDownloadError('UND_ERR_RES_EXCEEDED_MAX_SIZE') }],
    ['content-encoding', noteDownloadResponse([Buffer.from('encoded')], { contentEncoding: 'gzip' }).response],
    ['too-large', noteDownloadResponse([Buffer.alloc(32)], { contentLength: 32 }).response, 16]
  ]
  for (const [label, response, caseMaxBytes = 1024] of permanentCases) {
    const sequence = createNoteDownloadSequence([response])
    const client = createNoteDownloadClient(sequence)
    await withNoteDownloadFile(tempRoot, `permanent-${label}`, async (fileHandle) => {
      await assert.rejects(
        () => client.downloadTokenToFile('fileSequenceToken123', '', {
          fileHandle,
          maxBytes: caseMaxBytes
        })
      )
      assert.strictEqual((await fileHandle.stat()).size, 0)
    })
    assert.strictEqual(sequence.calls.length, 1, `${label} 是确定性失败，既不得重试也不得 fallback`)
  }

  const abortController = new AbortController()
  const abortSequence = createNoteDownloadSequence([
    (options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('synthetic aborted fetch')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  ])
  const abortClient = createNoteDownloadClient(abortSequence)
  await withNoteDownloadFile(tempRoot, 'external-abort', async (fileHandle) => {
    const download = abortClient.downloadTokenToFile('fileSequenceToken123', '', {
      fileHandle,
      maxBytes: 1024,
      signal: abortController.signal
    })
    setTimeout(() => abortController.abort(), 10)
    await assert.rejects(
      () => download,
      (error) => error && error.code === 'FEISHU_MATERIAL_DOWNLOAD_ABORTED'
    )
  })
  assert.strictEqual(abortSequence.calls.length, 1, '外部 abort 必须终止当前请求且不得重试或 fallback')

  let abortedReads = 0
  let addedListeners = 0
  let removedListeners = 0
  const racedAbortSignal = {
    get aborted() {
      abortedReads += 1
      return abortedReads >= 2
    },
    addEventListener() { addedListeners += 1 },
    removeEventListener() { removedListeners += 1 }
  }
  const racedAbortSequence = createNoteDownloadSequence([
    noteDownloadResponse([Buffer.from('must-not-request')]).response
  ])
  const racedAbortClient = createNoteDownloadClient(racedAbortSequence)
  await withNoteDownloadFile(tempRoot, 'raced-external-abort', async (fileHandle) => {
    await fileHandle.writeFile(Buffer.from('stale-aborted-bytes'))
    await assert.rejects(
      () => racedAbortClient.downloadTokenToFile('fileSequenceToken123', '', {
        fileHandle,
        maxBytes: 1024,
        signal: racedAbortSignal
      }),
      (error) => error && error.code === 'FEISHU_MATERIAL_DOWNLOAD_ABORTED'
    )
    assert.strictEqual((await fileHandle.stat()).size, 0, '注册监听时竞态取消也必须清空复用目标文件')
  })
  assert.strictEqual(racedAbortSequence.calls.length, 0, '初检与监听注册之间的 abort 不得漏发一次请求')
  assert.strictEqual(addedListeners, 1)
  assert.strictEqual(removedListeners, 1)
}

async function testDownloadLocalIoAndCleanupStop(tempRoot) {
  await withNoteDownloadFile(tempRoot, 'local-write', async (realHandle) => {
    const localIoSequence = createNoteDownloadSequence([
      noteDownloadResponse([Buffer.from('write-must-fail')]).response
    ])
    const client = createNoteDownloadClient(localIoSequence)
    const fileHandle = {
      truncate: realHandle.truncate.bind(realHandle),
      async write() {
        const error = noteDownloadError('EIO', 'synthetic local write failure')
        error.statusCode = 503
        error.cause = noteDownloadError('ECONNRESET', '不得穿透本地 IO 主错误读取网络 cause')
        throw error
      }
    }
    await assert.rejects(
      () => client.downloadTokenToFile('fileSequenceToken123', '', { fileHandle, maxBytes: 1024 }),
      (error) => error && error.code === 'EIO'
    )
    assert.strictEqual(localIoSequence.calls.length, 1, '本地 IO 错误不得重试或 fallback')
  })

  await withNoteDownloadFile(tempRoot, 'cleanup-stop', async (realHandle) => {
    let truncateCalls = 0
    const fileHandle = {
      write: realHandle.write.bind(realHandle),
      async truncate(size) {
        truncateCalls += 1
        if (truncateCalls === 3) throw noteDownloadError('EIO', 'synthetic cleanup failure')
        return realHandle.truncate(size)
      }
    }
    const streamError = noteDownloadError('ECONNRESET', 'synthetic partial stream failure')
    const sequence = createNoteDownloadSequence([
      noteDownloadResponse([Buffer.from('partial')], { terminalError: streamError }).response
    ])
    const client = createNoteDownloadClient(sequence)
    await assert.rejects(
      () => client.downloadTokenToFile('fileSequenceToken123', '', { fileHandle, maxBytes: 1024 }),
      (error) => error && error.code === 'FEISHU_MATERIAL_FILE_CLEANUP_FAILED'
    )
    assert.strictEqual(truncateCalls, 3, '清理失败后不得再次清理并掩盖结论')
    assert.strictEqual(sequence.calls.length, 1, '清理失败必须立即终止，禁止重试或 fallback')
  })
}

async function testDownloadSharedDeadline(tempRoot) {
  const sequence = createNoteDownloadSequence([
    { throwValue: noteDownloadError('ECONNRESET') },
    (options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('synthetic deadline abort')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }),
    noteDownloadResponse([Buffer.from('must-not-run')]).response
  ])
  const client = createNoteDownloadClient(sequence, 350)
  const startedAt = Date.now()
  await withNoteDownloadFile(tempRoot, 'shared-deadline', async (fileHandle) => {
    await assert.rejects(
      () => client.downloadTokenToFile('fileSequenceToken123', '', { fileHandle, maxBytes: 1024 }),
      (error) => error && error.code === 'FEISHU_MATERIAL_DOWNLOAD_TIMEOUT'
    )
  })
  const elapsed = Date.now() - startedAt
  assert.strictEqual(sequence.calls.length, 2, '第二次挂起不得刷新总体 deadline 或发出第三次请求')
  assert.strictEqual(sequence.remaining(), 1)
  assert.ok(elapsed >= 300 && elapsed < 700, `总体 deadline 应接近原始 350ms，实际 ${elapsed}ms`)
}

async function testDownloadRetryContract(tempRoot) {
  await testDownloadTransientRetryAndReset(tempRoot)
  await testDownloadRetryableClosedSet(tempRoot)
  await testDownloadGlobalBudgetAndFallback(tempRoot)
  await testDownloadPermanentFailuresAndAbort(tempRoot)
  await testDownloadLocalIoAndCleanupStop(tempRoot)
  await testDownloadSharedDeadline(tempRoot)
}

function objectKeyFromPath(requestPath) {
  return String(requestPath || '')
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => decodeURIComponent(part))
    .join('/')
}

function makeResponse(request, callback, statusCode, headers, totalBytes, options = {}) {
  const response = new EventEmitter()
  response.statusCode = statusCode
  response.headers = { ...(headers || {}) }
  response.setEncoding = () => response
  response.resume = () => {
    request.callRecord.responseResumed = true
    return response
  }
  request.response = response
  callback(response)

  let emitted = 0
  const emitNext = () => {
    if (request.destroyed) return
    if (emitted >= totalBytes) {
      response.emit('end')
      return
    }
    const remaining = totalBytes - emitted
    const chunk = remaining >= patternChunk.length ? patternChunk : patternChunk.subarray(0, remaining)
    emitted += chunk.length
    request.callRecord.responseBytesEmitted = emitted
    response.emit('data', chunk)
    setImmediate(emitNext)
  }
  if (options.controlBody) {
    process.nextTick(() => {
      if (request.destroyed) return
      request.callRecord.responseBytesEmitted = options.controlBody.length
      response.emit('data', options.controlBody)
      response.emit('end')
    })
    return
  }
  process.nextTick(emitNext)
}

https.request = (options, callback) => {
  const request = new EventEmitter()
  const bodyHash = crypto.createHash('sha256')
  request.destroyed = false
  request.response = null
  request.timeoutHandler = null
  request.callRecord = {
    method: options.method,
    path: options.path,
    headers: { ...(options.headers || {}) },
    writtenBytes: 0,
    maxWriteBytes: 0,
    endBodyBytes: 0,
    destroyCount: 0,
    responseBytesEmitted: 0,
    responseResumed: false,
    backpressureCount: 0
  }
  calls.push(request.callRecord)
  request.setTimeout = (timeoutMs, handler) => {
    request.callRecord.timeoutMs = timeoutMs
    request.timeoutHandler = handler
    return request
  }
  request.write = (chunk) => {
    const buffer = Buffer.from(chunk)
    request.callRecord.writtenBytes += buffer.length
    request.callRecord.maxWriteBytes = Math.max(request.callRecord.maxWriteBytes, buffer.length)
    bodyHash.update(buffer)
    if (options.method === 'PUT' && mutateDuringPut && mutateDuringPut.mutated !== true) {
      const mutationHandle = fs.openSync(mutateDuringPut.filePath, 'r+')
      try {
        fs.writeSync(mutationHandle, Buffer.from([0x5b]), 0, 1, mutateDuringPut.offset)
        fs.fsyncSync(mutationHandle)
      } finally {
        fs.closeSync(mutationHandle)
      }
      mutateDuringPut.mutated = true
    }
    if (options.method === 'PUT' && earlyPutConflict) {
      remoteObject = { ...earlyPutConflict }
      remoteMode = 'exact'
      earlyPutConflict = null
      makeResponse(request, callback, 409, {}, 0)
    }
    if (options.method === 'PUT' && request.callRecord.backpressureCount === 0) {
      request.callRecord.backpressureCount += 1
      setImmediate(() => {
        if (!request.destroyed) request.emit('drain')
      })
      return false
    }
    return true
  }
  request.destroy = (error) => {
    if (request.destroyed) return request
    request.destroyed = true
    request.callRecord.destroyCount += 1
    if (request.slowDripTimer) clearTimeout(request.slowDripTimer)
    if (request.response) {
      process.nextTick(() => {
        request.response.emit('aborted')
        request.response.emit('error', new Error('synthetic stream reset after destroy'))
      })
    }
    if (error) process.nextTick(() => request.emit('error', error))
    return request
  }
  request.end = (body) => {
    if (body !== undefined && body !== null) {
      const buffer = Buffer.from(body)
      request.callRecord.endBodyBytes = buffer.length
      request.write(buffer)
    }
    process.nextTick(() => {
      if (request.destroyed) return
      if (options.method === 'GET' && options.path === '/?versioning') {
        const xml = Buffer.from('<VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com"/>')
        makeResponse(request, callback, 200, {
          'content-length': String(xml.length),
          'content-type': 'application/xml'
        }, 0, { controlBody: xml })
        return
      }

      const objectKey = objectKeyFromPath(options.path)
      if (options.method === 'GET') {
        if (remoteMode === 'missing') {
          makeResponse(request, callback, 404, {}, 0)
          return
        }
        if (remoteMode === 'giant-header') {
          makeResponse(request, callback, 200, {
            'content-length': String(expectedSize + 1),
            'content-type': 'video/mp4',
            'x-oss-meta-content-sha256': remoteObject.contentSha256
          }, expectedSize + 1024 * 1024)
          return
        }
        if (remoteMode === 'overlong-no-length') {
          makeResponse(request, callback, 200, {
            'content-type': 'video/mp4',
            'x-oss-meta-content-sha256': remoteObject.contentSha256
          }, expectedSize + 1)
          return
        }
        if (slowDripResponse) {
          const response = new EventEmitter()
          response.statusCode = 200
          response.headers = {
            'content-type': 'video/mp4',
            'x-oss-meta-content-sha256': remoteObject.contentSha256
          }
          response.setEncoding = () => response
          response.resume = () => response
          request.response = response
          callback(response)
          const drip = () => {
            if (request.destroyed) return
            response.emit('data', Buffer.from([0x5a]))
            request.slowDripTimer = setTimeout(drip, 10)
          }
          request.slowDripTimer = setTimeout(drip, 10)
          return
        }
        makeResponse(request, callback, 200, {
          'content-length': String(remoteObject.size),
          'content-type': remoteObject.contentType,
          'x-oss-meta-content-sha256': remoteObject.contentSha256
        }, remoteObject.size)
        return
      }

      if (options.method === 'PUT') {
        const digest = bodyHash.digest('hex')
        remoteObject = {
          objectKey,
          size: request.callRecord.writtenBytes,
          contentSha256: digest,
          contentType: String(options.headers['Content-Type'] || '')
        }
        remoteMode = 'exact'
        makeResponse(request, callback, 200, {}, 0)
        return
      }

      throw new Error(`unexpected request ${options.method}`)
    })
    return request
  }
  return request
}

function requestMethods() {
  return calls.map((call) => call.method)
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-oss-streaming-test-'))
  sourcePath = path.join(tempRoot, 'normalized-material.mp4')
  expectedSize = (15 * 1024 * 1024) + 37
  const contentSha256 = createPatternFile(sourcePath, expectedSize)
  const input = {
    kind: 'video',
    objectKey: `house-videos/feishu-note-v1/streaming/MAT-STREAM-${contentSha256}.mp4`,
    filePath: sourcePath,
    size: expectedSize,
    contentType: 'video/mp4',
    contentSha256
  }

  const guardWholeFileRead = (target) => {
    if (path.resolve(String(target)) === path.resolve(sourcePath)) {
      wholeFileReadAttempts += 1
      throw new Error('受限内存测试禁止整文件读取')
    }
  }

  try {
    const oss = require('../src/oss')
    const runtimeConfig = require('../src/config')
    fs.readFileSync = (target, ...args) => {
      guardWholeFileRead(target)
      return originalReadFileSync.call(fs, target, ...args)
    }
    fs.readFile = (target, ...args) => {
      guardWholeFileRead(target)
      return originalReadFile.call(fs, target, ...args)
    }
    fs.promises.readFile = async (target, ...args) => {
      guardWholeFileRead(target)
      return originalPromisesReadFile.call(fs.promises, target, ...args)
    }
    Buffer.concat = (list, totalLength) => {
      const bytes = Number.isSafeInteger(totalLength)
        ? totalLength
        : (Array.isArray(list) ? list.reduce((sum, item) => sum + item.length, 0) : 0)
      if (bytes > 1024 * 1024) throw new Error('受限内存测试禁止拼接整份大素材')
      return originalBufferConcat.call(Buffer, list, totalLength)
    }

    remoteMode = 'missing'
    calls.length = 0
    const saved = await oss.putMaterialDeterministic(input)
    assert.strictEqual(saved.verified, true)
    assert.strictEqual(saved.reused, false)
    assert.strictEqual(saved.size, expectedSize)
    assert.strictEqual(saved.contentSha256, contentSha256)
    assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT', 'GET'])
    const put = calls[2]
    assert.strictEqual(put.headers['Content-Length'], expectedSize)
    assert.strictEqual(put.endBodyBytes, 0, 'PUT 不得把整份素材作为 req.end(Buffer) 发送')
    assert.strictEqual(put.writtenBytes, expectedSize)
    assert.ok(put.maxWriteBytes <= 128 * 1024, 'PUT 必须以小块流式写入，不能产生接近上限的单块 Buffer')
    assert.strictEqual(put.backpressureCount, 1, 'PUT 文件流必须服从 ClientRequest 背压后再继续')
    assert.strictEqual(wholeFileReadAttempts, 0, '近上限素材不得经过 readFile/readFileSync 整体载入')

    const previousTransferTimeoutMs = runtimeConfig.feishu.materialTransferTimeoutMs
    runtimeConfig.feishu.materialTransferTimeoutMs = 60
    remoteMode = 'exact'
    remoteObject = { ...input }
    slowDripResponse = true
    calls.length = 0
    const slowDripStartedAt = Date.now()
    await assert.rejects(
      () => oss.verifyMaterialDeterministic(input),
      (error) => error && error.code === 'OSS_REQUEST_TIMEOUT' && error.statusCode === 504,
      '持续有数据但永不结束的 OSS 响应也必须被绝对总时限终止'
    )
    assert.ok(Date.now() - slowDripStartedAt < 500, '绝对总时限不得被慢滴流活动无限续期')
    assert.strictEqual(calls[0].destroyCount, 1, '绝对总时限到期后必须销毁底层 OSS 请求')
    slowDripResponse = false
    runtimeConfig.feishu.materialTransferTimeoutMs = previousTransferTimeoutMs

    remoteMode = 'giant-header'
    remoteObject = { ...input, contentSha256 }
    calls.length = 0
    await assert.rejects(
      () => oss.putMaterialDeterministic(input),
      /超过允许大小|不一致|禁止覆盖/,
      '同名远端巨物必须在读取正文和打开 PUT 前提前拒绝'
    )
    assert.deepStrictEqual(requestMethods(), ['GET'])
    assert.strictEqual(calls[0].destroyCount, 1)
    assert.strictEqual(calls[0].responseBytesEmitted, 0, 'Content-Length 已超限时不得消费巨物正文')

    remoteMode = 'overlong-no-length'
    calls.length = 0
    await assert.rejects(
      () => oss.verifyMaterialDeterministic(input),
      /超过允许大小/,
      '无 Content-Length 的超长流必须在 expected size 后第一字节立即拒绝'
    )
    assert.deepStrictEqual(requestMethods(), ['GET'])
    assert.strictEqual(calls[0].destroyCount, 1)
    assert.strictEqual(calls[0].responseBytesEmitted, expectedSize + 1, '不得继续消费超限第一字节后的远端数据')

    calls.length = 0
    await assert.rejects(
      () => oss.verifyMaterialDeterministic({ ...input, size: undefined }),
      /大小/,
      '确定性回读缺少 expected size 时必须在网络前失败关闭'
    )
    assert.strictEqual(calls.length, 0)

    await assert.rejects(
      () => oss.putMaterialDeterministic({ ...input, buffer: Buffer.from('legacy-whole-buffer') }),
      /禁止整块 Buffer/,
      '确定性 OSS 写入不得悄悄退回旧的整块 Buffer 契约'
    )
    assert.strictEqual(calls.length, 0)

    remoteMode = 'missing'
    calls.length = 0
    await assert.rejects(
      () => oss.putMaterialDeterministic({ ...input, size: input.size + 1 }),
      /大小|身份/,
      '本地文件大小与声明不一致时不得进入版本检查或 PUT'
    )
    assert.deepStrictEqual(requestMethods(), ['GET'])

    calls.length = 0
    await assert.rejects(
      () => oss.putMaterialDeterministic({ ...input, contentSha256: '0'.repeat(64) }),
      /声明哈希/,
      '本地文件哈希与声明不一致时不得进入版本检查或 PUT'
    )
    assert.deepStrictEqual(requestMethods(), ['GET'])

    fs.promises.lstat = async (target) => {
      const stat = await originalPromisesLstat.call(fs.promises, target)
      if (path.resolve(String(target)) !== path.resolve(sourcePath)) return stat
      return {
        ...stat,
        isSymbolicLink: () => true,
        isFile: () => true
      }
    }
    calls.length = 0
    await assert.rejects(
      () => oss.putMaterialDeterministic(input),
      /普通文件/,
      '链接身份的本地路径必须在 GET 之后、任何写入之前失败关闭'
    )
    assert.deepStrictEqual(requestMethods(), ['GET'])
    fs.promises.lstat = originalPromisesLstat

    const racePath = path.join(tempRoot, 'early-conflict-material.mp4')
    const raceSize = (8 * 64 * 1024) + 37
    const raceSha256 = createPatternFile(racePath, raceSize)
    const raceInput = {
      kind: 'video',
      objectKey: `house-videos/feishu-note-v1/streaming/MAT-RACE-${raceSha256}.mp4`,
      filePath: racePath,
      size: raceSize,
      contentType: 'video/mp4',
      contentSha256: raceSha256
    }
    remoteMode = 'missing'
    earlyPutConflict = {
      objectKey: raceInput.objectKey,
      size: raceInput.size,
      contentSha256: raceInput.contentSha256,
      contentType: raceInput.contentType
    }
    calls.length = 0
    const raced = await oss.putMaterialDeterministic(raceInput)
    assert.strictEqual(raced.verified, true)
    assert.strictEqual(raced.reused, true)
    assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT', 'GET'])
    assert.ok(calls[2].writtenBytes < raceSize, 'PUT 提前返回 409 后必须停止继续读取本地文件')
    assert.strictEqual(calls[2].destroyCount, 1, 'PUT 提前返回 409 后必须销毁底层请求')

    const mutablePath = path.join(tempRoot, 'mutable-material.mp4')
    const mutableSize = (3 * 64 * 1024) + 37
    const mutableSha256 = createPatternFile(mutablePath, mutableSize)
    const mutableInput = {
      kind: 'video',
      objectKey: `house-videos/feishu-note-v1/streaming/MAT-MUTABLE-${mutableSha256}.mp4`,
      filePath: mutablePath,
      size: mutableSize,
      contentType: 'video/mp4',
      contentSha256: mutableSha256
    }
    let closeCount = 0
    fs.promises.open = async (target, ...args) => {
      const handle = await originalPromisesOpen.call(fs.promises, target, ...args)
      if (path.resolve(String(target)) === path.resolve(mutablePath)) {
        const originalClose = handle.close.bind(handle)
        handle.close = async () => {
          closeCount += 1
          return originalClose()
        }
      }
      return handle
    }
    mutateDuringPut = {
      filePath: mutablePath,
      offset: (2 * 64 * 1024) + 17,
      mutated: false
    }
    remoteMode = 'missing'
    calls.length = 0
    await assert.rejects(
      () => oss.putMaterialDeterministic(mutableInput),
      /上传期间本地文件内容发生变化/,
      '文件通过预检后在上传途中变化时必须按流内二次哈希拒绝'
    )
    assert.strictEqual(mutateDuringPut.mutated, true)
    assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT'])
    assert.strictEqual(closeCount, 1, '上传途中失败也必须只关闭一次受信文件句柄')
    mutateDuringPut = null
    earlyPutConflict = null
    slowDripResponse = false
    fs.promises.open = originalPromisesOpen
    await testDownloadRetryContract(tempRoot)
  } finally {
    https.request = originalRequest
    fs.readFile = originalReadFile
    fs.readFileSync = originalReadFileSync
    fs.promises.readFile = originalPromisesReadFile
    fs.promises.lstat = originalPromisesLstat
    fs.promises.open = originalPromisesOpen
    mutateDuringPut = null
    Buffer.concat = originalBufferConcat
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  console.log('feishu-note-material-streaming-v1-test passed')
}

main().catch((error) => {
  https.request = originalRequest
  fs.readFile = originalReadFile
  fs.readFileSync = originalReadFileSync
  fs.promises.readFile = originalPromisesReadFile
  fs.promises.lstat = originalPromisesLstat
  fs.promises.open = originalPromisesOpen
  mutateDuringPut = null
  earlyPutConflict = null
  slowDripResponse = false
  Buffer.concat = originalBufferConcat
  console.error(error)
  process.exit(1)
})
