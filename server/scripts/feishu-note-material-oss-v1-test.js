'use strict'

const assert = require('assert')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')

process.env.ALI_OSS_BUCKET = 'synthetic-private-bucket'
process.env.ALI_OSS_REGION = 'oss-cn-hangzhou'
process.env.ALI_OSS_ACCESS_KEY_ID = 'synthetic-access-key'
process.env.ALI_OSS_ACCESS_KEY_SECRET = 'synthetic-secret'
process.env.ALI_OSS_SECURITY_TOKEN = 'synthetic-sts-token'
process.env.ALI_OSS_MAX_VIDEO_MB = '1'

const originalRequest = https.request
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-oss-v12-test-'))
const calls = []
const objects = new Map()
let versioning = 'Disabled'
let race = null
let timeoutTarget = null
let corruptNextPut = null
let oversizedPutError = false
let oversizedVersioningResponse = false
let omitContentLengthForNextGet = false

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function objectKeyFromPath(requestPath) {
  return String(requestPath || '')
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => decodeURIComponent(part))
    .join('/')
}

function response(request, callback, statusCode, headers = {}, body = Buffer.alloc(0)) {
  process.nextTick(() => {
    const value = new EventEmitter()
    value.statusCode = statusCode
    value.headers = headers
    value.setEncoding = () => {}
    value.resume = () => {}
    request.response = value
    callback(value)
    if (body.length) value.emit('data', body)
    value.emit('end')
  })
}

function versioningXml() {
  if (versioning === 'Disabled') {
    return Buffer.from(
      '<VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com"/>'
    )
  }
  return Buffer.from(
    `<VersioningConfiguration><Status>${versioning}</Status></VersioningConfiguration>`
  )
}

https.request = (options, callback) => {
  const request = new EventEmitter()
  const bodyChunks = []
  let bodyBytes = 0
  request.callRecord = null
  request.response = null
  request.timeoutMs = 0
  request.timeoutHandler = null
  request.setTimeout = (timeoutMs, handler) => {
    request.timeoutMs = timeoutMs
    request.timeoutHandler = handler
    return request
  }
  request.destroy = (error) => {
    if (request.callRecord) {
      request.callRecord.destroyCount += 1
      request.callRecord.destroyError = error ? String(error.message || error) : ''
    }
    if (request.response) {
      process.nextTick(() => {
        request.response.emit('aborted')
        request.response.emit('error', new Error('synthetic response reset after destroy'))
      })
    }
    if (error) process.nextTick(() => request.emit('error', error))
  }
  request.write = (chunk) => {
    const bodyChunk = Buffer.from(chunk)
    bodyChunks.push(bodyChunk)
    bodyBytes += bodyChunk.length
    return true
  }
  request.end = (body) => {
    if (body !== undefined && body !== null) request.write(body)
    const requestBody = Buffer.concat(bodyChunks, bodyBytes)
    request.callRecord = {
      method: options.method,
      path: options.path,
      headers: { ...(options.headers || {}) },
      body: requestBody,
      timeoutMs: request.timeoutMs,
      destroyCount: 0,
      destroyError: ''
    }
    calls.push(request.callRecord)
    if (timeoutTarget &&
        timeoutTarget.method === options.method &&
        timeoutTarget.path === options.path) {
      timeoutTarget = null
      process.nextTick(() => request.timeoutHandler())
      return
    }
    if (options.method === 'GET' && options.path === '/?versioning') {
      const xml = oversizedVersioningResponse
        ? Buffer.alloc(64 * 1024 + 1, 0x78)
        : versioningXml()
      oversizedVersioningResponse = false
      response(request, callback, 200, {
        'content-length': String(xml.length),
        'content-type': 'application/xml'
      }, xml)
      return
    }

    const objectKey = objectKeyFromPath(options.path)
    if (options.method === 'GET') {
      const stored = objects.get(objectKey)
      if (!stored) {
        response(request, callback, 404)
        return
      }
      const responseHeaders = {
        'content-length': String(stored.body.length),
        'content-type': stored.contentType,
        'x-oss-meta-content-sha256': stored.metadataSha256
      }
      if (omitContentLengthForNextGet) {
        delete responseHeaders['content-length']
        omitContentLengthForNextGet = false
      }
      response(request, callback, 200, responseHeaders, stored.body)
      return
    }

    if (options.method === 'PUT') {
      if (oversizedPutError) {
        oversizedPutError = false
        response(request, callback, 500, {}, Buffer.alloc(64 * 1024 + 1, 0x78))
        return
      }
      if (race && race.objectKey === objectKey) {
        objects.set(objectKey, race.object)
        race = null
        response(request, callback, 409, {}, Buffer.from('<Error><Code>FileAlreadyExists</Code></Error>'))
        return
      }
      if (objects.has(objectKey) && options.headers['x-oss-forbid-overwrite'] === 'true') {
        response(request, callback, 409, {}, Buffer.from('<Error><Code>FileAlreadyExists</Code></Error>'))
        return
      }
      const stored = {
        body: requestBody,
        metadataSha256: String(options.headers['x-oss-meta-content-sha256'] || ''),
        contentType: String(options.headers['Content-Type'] || '')
      }
      objects.set(objectKey, corruptNextPut || stored)
      corruptNextPut = null
      response(request, callback, 200)
      return
    }

    throw new Error(`unexpected OSS request ${options.method}`)
  }
  return request
}

function videoInput(index, body = Buffer.from(`video-${index}`)) {
  const contentSha256 = sha256(body)
  const filePath = path.join(tempRoot, `video-${index}.mp4`)
  fs.writeFileSync(filePath, body, { flag: 'wx', mode: 0o600 })
  return {
    kind: 'video',
    objectKey: `house-videos/feishu-note-v1/source-${index}/MAT-${String(index).padStart(8, '0')}-${contentSha256}.mp4`,
    filePath,
    size: body.length,
    contentType: 'video/mp4',
    contentSha256,
    _body: Buffer.from(body)
  }
}

function imageInput(index, body) {
  const contentSha256 = sha256(body)
  const filePath = path.join(tempRoot, `image-${index}.jpg`)
  fs.writeFileSync(filePath, body, { flag: 'wx', mode: 0o600 })
  return {
    kind: 'image',
    objectKey: `house-videos/feishu-note-v1/source-${index}/MAT-${String(index).padStart(8, '0')}-${contentSha256}.jpg`,
    filePath,
    size: body.length,
    contentType: 'image/jpeg',
    contentSha256,
    _body: Buffer.from(body)
  }
}

function storedObject(input, overrides = {}) {
  const body = overrides.body || Buffer.from(input._body)
  return {
    body,
    metadataSha256: overrides.metadataSha256 || sha256(body),
    contentType: overrides.contentType || input.contentType
  }
}

function requestMethods() {
  return calls.map((call) => call.method)
}

function putCalls() {
  return calls.filter((call) => call.method === 'PUT')
}

function versioningCalls() {
  return calls.filter((call) => call.method === 'GET' && call.path === '/?versioning')
}

function expectedAuthorization(call, resourcePath) {
  const ossHeaders = Object.keys(call.headers)
    .filter((key) => /^x-oss-/i.test(key))
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map((key) => `${key.toLowerCase()}:${String(call.headers[key]).trim()}\n`)
    .join('')
  const stringToSign = [
    call.method,
    '',
    String(call.headers['Content-Type'] || ''),
    String(call.headers.Date || ''),
    `${ossHeaders}${resourcePath}`
  ].join('\n')
  const signature = crypto
    .createHmac('sha1', process.env.ALI_OSS_ACCESS_KEY_SECRET)
    .update(stringToSign)
    .digest('base64')
  return `OSS ${process.env.ALI_OSS_ACCESS_KEY_ID}:${signature}`
}

async function testExistingExactReuse(oss) {
  const input = videoInput(1)
  objects.set(input.objectKey, storedObject(input))
  calls.length = 0
  const result = await oss.putMaterialDeterministic(input)
  assert.strictEqual(result.verified, true)
  assert.strictEqual(result.reused, true)
  assert.deepStrictEqual(requestMethods(), ['GET'], '已有同内容对象只能鉴权 GET 复用')
  assert.strictEqual(versioningCalls().length, 0, '已有对象不得再读 Bucket 版本状态')
}

async function testExistingConflictNeverOverwrites(oss) {
  const input = videoInput(2)
  const conflicting = Buffer.from('changed')
  assert.strictEqual(conflicting.length, input.size, '哈希门夹具必须保持相同字节数')
  objects.set(input.objectKey, storedObject(input, {
    body: conflicting,
    metadataSha256: input.contentSha256
  }))
  calls.length = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic(input),
    /不一致|禁止覆盖/
  )
  assert.deepStrictEqual(requestMethods(), ['GET'])
  assert.deepStrictEqual(objects.get(input.objectKey).body, conflicting, '异内容同键不得被覆盖')

  objects.set(input.objectKey, storedObject(input))
  calls.length = 0
  const wrongSize = await oss.verifyMaterialDeterministic({
    kind: input.kind,
    objectKey: input.objectKey,
    mimeType: input.contentType,
    contentSha256: input.contentSha256,
    size: input.size + 1
  })
  assert.strictEqual(wrongSize.verified, false, '声明大小与实际回读不一致必须独立判失败')
  assert.deepStrictEqual(requestMethods(), ['GET'])

  objects.set(input.objectKey, storedObject(input, { contentType: 'application/octet-stream' }))
  calls.length = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic(input),
    /不一致|禁止覆盖/,
    '已有对象 MIME 不一致也必须阻断'
  )
  assert.deepStrictEqual(requestMethods(), ['GET'])
}

async function testMissingCreatesWithoutOverwrite(oss) {
  const input = videoInput(3)
  objects.delete(input.objectKey)
  versioning = 'Disabled'
  calls.length = 0
  const result = await oss.putMaterialDeterministic(input)
  assert.strictEqual(result.verified, true)
  assert.strictEqual(result.reused, false)
  assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT', 'GET'])
  assert.strictEqual(versioningCalls().length, 1)
  assert.strictEqual(putCalls().length, 1)
  assert.strictEqual(calls[0].headers['x-oss-security-token'], 'synthetic-sts-token')
  assert.strictEqual(
    calls[0].headers.Authorization,
    expectedAuthorization(
      calls[0],
      `/${process.env.ALI_OSS_BUCKET}/${input.objectKey}`
    ),
    '确定性素材 GET 的 STS 请求头必须参与签名'
  )
  assert.strictEqual(putCalls()[0].headers['x-oss-forbid-overwrite'], 'true')
  assert.strictEqual(putCalls()[0].headers['x-oss-security-token'], 'synthetic-sts-token')
  assert.strictEqual(
    putCalls()[0].headers['x-oss-meta-content-sha256'],
    input.contentSha256
  )
  assert.strictEqual(
    putCalls()[0].headers.Authorization,
    expectedAuthorization(
      putCalls()[0],
      `/${process.env.ALI_OSS_BUCKET}/${input.objectKey}`
    ),
    '禁止覆盖头和内容摘要必须同时参与 PUT 签名'
  )
  assert.strictEqual(
    versioningCalls()[0].headers.Authorization,
    expectedAuthorization(
      versioningCalls()[0],
      `/${process.env.ALI_OSS_BUCKET}/?versioning`
    ),
    'versioning 子资源必须参与 GET 签名'
  )
}

async function testVersioningBlocksWrite(oss) {
  for (const [index, state] of ['Enabled', 'Suspended', 'Unknown'].entries()) {
    const input = videoInput(4 + index)
    objects.delete(input.objectKey)
    versioning = state
    calls.length = 0
    await assert.rejects(
      () => oss.putMaterialDeterministic(input),
      /版本控制|版本状态|禁止覆盖/
    )
    assert.deepStrictEqual(requestMethods(), ['GET', 'GET'])
    assert.strictEqual(putCalls().length, 0, `${state} 或不可解析状态时不得 PUT`)
  }
  versioning = 'Disabled'
}

async function testConcurrentCreate(oss) {
  const identical = videoInput(10)
  objects.delete(identical.objectKey)
  race = {
    objectKey: identical.objectKey,
    object: storedObject(identical)
  }
  calls.length = 0
  const reused = await oss.putMaterialDeterministic(identical)
  assert.strictEqual(reused.verified, true)
  assert.strictEqual(reused.reused, true)
  assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT', 'GET'])
  assert.strictEqual(putCalls()[0].headers['x-oss-forbid-overwrite'], 'true')

  const conflict = videoInput(11)
  const otherBody = Buffer.from('concurrent-conflicting-body')
  objects.delete(conflict.objectKey)
  race = {
    objectKey: conflict.objectKey,
    object: storedObject(conflict, {
      body: otherBody,
      metadataSha256: sha256(otherBody)
    })
  }
  calls.length = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic(conflict),
    /并发目标|禁止覆盖/
  )
  assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT', 'GET'])
  assert.deepStrictEqual(objects.get(conflict.objectKey).body, otherBody)
}

async function testWriteReadbackAndTransportFailClosed(oss) {
  const corrupted = videoInput(12)
  objects.delete(corrupted.objectKey)
  versioning = 'Disabled'
  const corruptedBody = Buffer.alloc(corrupted.size, 0x7a)
  corruptNextPut = storedObject(corrupted, {
    body: corruptedBody,
    metadataSha256: corrupted.contentSha256
  })
  calls.length = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic(corrupted),
    /写后 GET|回读不一致/,
    'PUT 成功响应后的对象仍必须通过真实字节回读'
  )
  assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT', 'GET'])
  assert.deepStrictEqual(objects.get(corrupted.objectKey).body, corruptedBody)

  const oversized = videoInput(13)
  objects.delete(oversized.objectKey)
  oversizedPutError = true
  calls.length = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic(oversized),
    /响应超过允许大小/,
    'OSS 异常响应正文必须限长且失败关闭'
  )
  assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT'])
  assert.strictEqual(objects.has(oversized.objectKey), false)
  assert.strictEqual(calls[2].destroyCount, 1, 'PUT 响应超限后必须销毁底层请求')

  const getTimeout = videoInput(14)
  objects.delete(getTimeout.objectKey)
  timeoutTarget = { method: 'GET', path: `/${getTimeout.objectKey}` }
  calls.length = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic(getTimeout),
    /回读素材请求超时/
  )
  assert.deepStrictEqual(requestMethods(), ['GET'])
  assert.strictEqual(calls[0].timeoutMs, 30000, '素材 GET 必须设置空闲超时')
  assert.strictEqual(calls[0].destroyCount, 1, '素材 GET 超时后必须销毁底层请求')
  assert.match(calls[0].destroyError, /回读素材请求超时/)

  const putTimeout = videoInput(15)
  objects.delete(putTimeout.objectKey)
  timeoutTarget = { method: 'PUT', path: `/${putTimeout.objectKey}` }
  calls.length = 0
  let putWriteDispatches = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic({
      ...putTimeout,
      onWriteDispatched() { putWriteDispatches += 1 }
    }),
    /上传请求超时/
  )
  assert.deepStrictEqual(requestMethods(), ['GET', 'GET', 'PUT'])
  assert.strictEqual(calls[2].timeoutMs, 30000, '素材 PUT 必须设置空闲超时')
  assert.strictEqual(calls[2].destroyCount, 1, '素材 PUT 超时后必须销毁底层请求')
  assert.match(calls[2].destroyError, /上传请求超时/)
  assert.strictEqual(objects.has(putTimeout.objectKey), false)
  assert.strictEqual(putWriteDispatches, 1, 'OSS 仅在 PUT 真正派发时标记一次外部写')

  const versioningTimeout = videoInput(17)
  objects.delete(versioningTimeout.objectKey)
  timeoutTarget = { method: 'GET', path: '/?versioning' }
  calls.length = 0
  let versioningWriteDispatches = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic({
      ...versioningTimeout,
      onWriteDispatched() { versioningWriteDispatches += 1 }
    }),
    /版本状态读取超时/
  )
  assert.deepStrictEqual(requestMethods(), ['GET', 'GET'])
  assert.strictEqual(versioningWriteDispatches, 0, 'OSS 版本状态只读检查失败不得误报外部写已派发')
  assert.strictEqual(calls[1].destroyCount, 1, '版本状态读取超时后必须销毁底层请求')

  const versioningOversized = videoInput(18)
  objects.delete(versioningOversized.objectKey)
  oversizedVersioningResponse = true
  calls.length = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic(versioningOversized),
    /版本状态响应过大/
  )
  assert.deepStrictEqual(requestMethods(), ['GET', 'GET'])
  assert.strictEqual(calls[1].destroyCount, 1, '版本状态响应超限后必须销毁底层请求')

  const oversizedRead = videoInput(16)
  objects.set(oversizedRead.objectKey, storedObject(oversizedRead, {
    body: Buffer.alloc(16, 0x61)
  }))
  calls.length = 0
  await assert.rejects(
    () => oss.readObjectBufferAuthenticated(oversizedRead.objectKey, 8),
    /回读素材超过允许大小/
  )
  assert.deepStrictEqual(requestMethods(), ['GET'])
  assert.strictEqual(calls[0].destroyCount, 1, '素材 GET 超限后必须销毁底层请求')

  omitContentLengthForNextGet = true
  calls.length = 0
  await assert.rejects(
    () => oss.readObjectBufferAuthenticated(oversizedRead.objectKey, 8),
    /回读素材超过允许大小/,
    '缺少 Content-Length 时也必须按实际流量限长'
  )
  assert.deepStrictEqual(requestMethods(), ['GET'])
  assert.strictEqual(calls[0].destroyCount, 1, '流式 GET 超限后必须销毁底层请求')
}

async function testBatchOnlyCreatesFourMissing(oss) {
  objects.clear()
  versioning = 'Disabled'
  const inputs = Array.from({ length: 328 }, (_, index) => videoInput(1000 + index))
  for (const input of inputs.slice(0, 324)) {
    objects.set(input.objectKey, storedObject(input))
  }
  const existingDigests = new Map(inputs.slice(0, 324).map((input) => [
    input.objectKey,
    sha256(objects.get(input.objectKey).body)
  ]))
  calls.length = 0
  for (const input of inputs) {
    const result = await oss.putMaterialDeterministic(input)
    assert.strictEqual(result.verified, true)
  }
  assert.strictEqual(putCalls().length, 4, '324 已存在 + 4 缺失时只能新建 4 个 OSS 对象')
  assert.strictEqual(versioningCalls().length, 4, '只允许 4 个真实缺失对象读取禁止覆盖前置状态')
  assert.ok(putCalls().every((call) => call.headers['x-oss-forbid-overwrite'] === 'true'))
  for (const [objectKey, digest] of existingDigests) {
    assert.strictEqual(sha256(objects.get(objectKey).body), digest, '324 个既有对象字节不得变化')
  }
  assert.strictEqual(objects.size, 328)
}

async function testImageBytesRemainFailClosed(oss) {
  const imageBody = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('verified-image-body')
  ])
  const image = imageInput(8, imageBody)
  objects.set(image.objectKey, storedObject(image))
  calls.length = 0
  const reused = await oss.putMaterialDeterministic(image)
  assert.strictEqual(reused.verified, true)
  assert.deepStrictEqual(requestMethods(), ['GET'])

  const fakeBody = Buffer.from('ordinary-document-disguised-as-jpeg')
  const fake = imageInput(9, fakeBody)
  calls.length = 0
  await assert.rejects(
    () => oss.putMaterialDeterministic(fake),
    /真实字节类型/
  )
  assert.deepStrictEqual(requestMethods(), ['GET'], '伪图片只允许先做确定性 GET，不得读取版本状态或发起 PUT')
}

async function run() {
  const oss = require('../src/oss')
  try {
    await testExistingExactReuse(oss)
    await testExistingConflictNeverOverwrites(oss)
    await testMissingCreatesWithoutOverwrite(oss)
    await testVersioningBlocksWrite(oss)
    await testConcurrentCreate(oss)
    await testWriteReadbackAndTransportFailClosed(oss)
    await testBatchOnlyCreatesFourMissing(oss)
    await testImageBytesRemainFailClosed(oss)
  } finally {
    https.request = originalRequest
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
  console.log('feishu-note-material-oss-v1-test passed')
}

run().catch((error) => {
  https.request = originalRequest
  fs.rmSync(tempRoot, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
