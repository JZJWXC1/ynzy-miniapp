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
