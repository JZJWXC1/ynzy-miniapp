'use strict'

const assert = require('assert')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const https = require('https')

process.env.ALI_OSS_BUCKET = 'synthetic-private-bucket'
process.env.ALI_OSS_REGION = 'oss-cn-hangzhou'
process.env.ALI_OSS_ACCESS_KEY_ID = 'synthetic-access-key'
process.env.ALI_OSS_ACCESS_KEY_SECRET = 'synthetic-secret'
process.env.ALI_OSS_MAX_VIDEO_MB = '1'

const originalRequest = https.request
const calls = []
let storedBody = Buffer.alloc(0)
let storedSha256 = ''
let corruptReadback = false

https.request = (options, callback) => {
  const request = new EventEmitter()
  request.destroy = () => {}
  request.end = (body) => {
    calls.push({ method: options.method, path: options.path, headers: options.headers })
    if (options.method === 'PUT') {
      storedBody = Buffer.from(body || '')
      storedSha256 = String(options.headers['x-oss-meta-content-sha256'] || '')
    }
    process.nextTick(() => {
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = options.method === 'GET'
        ? {
            'content-length': String(storedBody.length),
            'x-oss-meta-content-sha256': storedSha256
          }
        : {}
      response.setEncoding = () => {}
      response.resume = () => {}
      callback(response)
      if (options.method === 'GET') {
        response.emit('data', corruptReadback ? Buffer.from('corrupt') : storedBody)
      }
      response.emit('end')
    })
  }
  return request
}

async function run() {
  const oss = require('../src/oss')
  const buffer = Buffer.from('verified-video-body')
  const contentSha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  const objectKey = 'house-videos/feishu-note-v1/source/MAT-1234567890abcdef.mp4'
  try {
    const result = await oss.putVideoDeterministic({
      objectKey,
      buffer,
      contentType: 'video/mp4',
      contentSha256
    })
    assert.strictEqual(result.verified, true)
    assert.strictEqual(result.contentSha256, contentSha256)
    assert.deepStrictEqual(calls.map((call) => call.method), ['PUT', 'GET'])
    assert.strictEqual(
      calls[0].headers['x-oss-meta-content-sha256'],
      contentSha256,
      'PUT 必须携带内容哈希元数据'
    )
    assert.ok(calls[1].headers.Authorization, 'GET 回读必须使用服务端签名鉴权')

    calls.length = 0
    const imageBuffer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('verified-image-body')])
    const imageSha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex')
    const imageKey = 'house-videos/feishu-note-v1/source/MAT-abcdef1234567890.jpg'
    const imageResult = await oss.putMaterialDeterministic({
      kind: 'image',
      objectKey: imageKey,
      buffer: imageBuffer,
      contentType: 'image/jpeg',
      contentSha256: imageSha256
    })
    assert.strictEqual(imageResult.verified, true, '图片也必须完成 OSS PUT + 鉴权 GET 摘要回读')
    assert.deepStrictEqual(calls.map((call) => call.method), ['PUT', 'GET'])
    assert.strictEqual(calls[0].headers['Content-Type'], 'image/jpeg')
    await assert.rejects(
      () => oss.putMaterialDeterministic({
        kind: 'image',
        objectKey: imageKey.replace(/\.jpg$/, '.png'),
        buffer: imageBuffer,
        contentType: 'image/jpeg',
        contentSha256: imageSha256
      }),
      /类型|对象键|扩展名/,
      '图片对象扩展名与 MIME 不一致时不得写入 OSS'
    )
    const fakeImageBuffer = Buffer.from('ordinary-document-disguised-as-jpeg')
    const fakeImageSha256 = crypto.createHash('sha256').update(fakeImageBuffer).digest('hex')
    await assert.rejects(
      () => oss.putMaterialDeterministic({
        kind: 'image',
        objectKey: imageKey,
        buffer: fakeImageBuffer,
        contentType: 'image/jpeg',
        contentSha256: fakeImageSha256
      }),
      /真实字节类型/,
      '扩展名和 MIME 均伪装成 JPEG 的普通文档也不得写入 OSS'
    )
    assert.deepStrictEqual(calls.map((call) => call.method), ['PUT', 'GET'], '被真实字节门禁拒绝的伪图片不得产生额外 OSS 请求')

    calls.length = 0
    corruptReadback = true
    await assert.rejects(
      () => oss.putVideoDeterministic({
        objectKey,
        buffer,
        contentType: 'video/mp4',
        contentSha256
      }),
      /GET|哈希|回读/
    )
  } finally {
    https.request = originalRequest
  }
  console.log('feishu-note-material-oss-v1-test passed')
}

run().catch((error) => {
  https.request = originalRequest
  console.error(error)
  process.exit(1)
})
