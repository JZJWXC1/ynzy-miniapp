// OSS STS 临时凭证契约：security token 必须进入 V1 URL 签名与 PUT 请求头签名。
// 全部使用明显假凭据并拦截 https.request，不访问真实 OSS 或公网。
process.env.ALI_OSS_BUCKET = 'fake-sts-bucket'
process.env.ALI_OSS_REGION = 'oss-cn-hangzhou'
process.env.ALI_OSS_ACCESS_KEY_ID = 'FAKE_STS_ACCESS_KEY_ID'
process.env.ALI_OSS_ACCESS_KEY_SECRET = 'FAKE_STS_ACCESS_KEY_SECRET'
process.env.ALI_OSS_SECURITY_TOKEN = 'FAKE_STS_TOKEN+/='

const assert = require('assert')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const https = require('https')
const config = require('../src/config')
const oss = require('../src/oss')

const TOKEN = process.env.ALI_OSS_SECURITY_TOKEN
const SECRET = process.env.ALI_OSS_ACCESS_KEY_SECRET
const BUCKET = process.env.ALI_OSS_BUCKET
const SNAPSHOT_PROCESS = 'video/snapshot,t_0,f_jpg,w_640,h_0,m_fast'

function sign(text) {
  return crypto.createHmac('sha1', SECRET).update(text).digest('base64')
}

function assertSignedUrl(urlText, objectKey, expectedSubresources) {
  const url = new URL(urlText)
  const expires = url.searchParams.get('Expires')
  const actualSignature = url.searchParams.get('Signature')
  assert.strictEqual(url.searchParams.get('security-token'), TOKEN, 'STS 读链接必须携带完整 security-token')
  assert.ok(expires, 'STS 读链接必须携带 Expires')
  assert.ok(actualSignature, 'STS 读链接必须携带 Signature')

  const canonicalQuery = Object.keys(expectedSubresources)
    .sort()
    .map((key) => `${key}=${expectedSubresources[key]}`)
    .join('&')
  const canonicalResource = `/${BUCKET}/${objectKey}?${canonicalQuery}`
  const expectedSignature = sign(['GET', '', '', expires, canonicalResource].join('\n'))
  assert.strictEqual(actualSignature, expectedSignature, `签名必须覆盖排序后的 subresource：${canonicalQuery}`)

  const withoutToken = { ...expectedSubresources }
  delete withoutToken['security-token']
  const oldQuery = Object.keys(withoutToken)
    .sort()
    .map((key) => `${key}=${withoutToken[key]}`)
    .join('&')
  const oldResource = `/${BUCKET}/${objectKey}${oldQuery ? `?${oldQuery}` : ''}`
  const oldSignature = sign(['GET', '', '', expires, oldResource].join('\n'))
  assert.notStrictEqual(actualSignature, oldSignature, 'security-token 必须真正影响签名，不能只拼在 URL 上')
}

async function assertPutObjectUsesSts() {
  const originalRequest = https.request
  let captured = null
  https.request = (options, onResponse) => {
    const req = new EventEmitter()
    req.end = (body) => {
      captured = { options, body }
      process.nextTick(() => {
        const response = new EventEmitter()
        response.statusCode = 200
        response.setEncoding = () => {}
        onResponse(response)
        process.nextTick(() => response.emit('end'))
      })
    }
    return req
  }

  try {
    const objectKey = 'feishu-materials/带空格/video.mp4'
    const body = Buffer.from([0, 1, 2, 250, 255])
    const result = await oss.putObjectBuffer(objectKey, body, 'video/mp4')
    assert.strictEqual(result.statusCode, 200, '拦截的 PUT 成功响应应正常返回')
    assert.ok(captured, 'putObjectBuffer 必须发起 HTTPS PUT')
    assert.strictEqual(captured.options.method, 'PUT')
    assert.strictEqual(captured.options.headers['x-oss-security-token'], TOKEN, 'STS PUT 必须发送 x-oss-security-token 头')
    assert.deepStrictEqual(captured.body, body, 'STS 加固不得改变上传二进制正文')
    assert.ok(captured.options.path.includes('%E5%B8%A6%E7%A9%BA%E6%A0%BC'), '对象路径仍应按段 URL 编码')

    const date = captured.options.headers.Date
    const canonicalResource = `/${BUCKET}/${objectKey}`
    const stringToSign = [
      'PUT',
      '',
      'video/mp4',
      date,
      `x-oss-security-token:${TOKEN}\n${canonicalResource}`
    ].join('\n')
    const expectedAuthorization = `OSS ${process.env.ALI_OSS_ACCESS_KEY_ID}:${sign(stringToSign)}`
    assert.strictEqual(
      captured.options.headers.Authorization,
      expectedAuthorization,
      'STS PUT 签名必须覆盖 x-oss-security-token 规范化请求头'
    )

    const oldStringToSign = ['PUT', '', 'video/mp4', date, canonicalResource].join('\n')
    assert.notStrictEqual(
      captured.options.headers.Authorization,
      `OSS ${process.env.ALI_OSS_ACCESS_KEY_ID}:${sign(oldStringToSign)}`,
      'PUT 不能沿用漏签 security token 的长期 AK 签名串'
    )
  } finally {
    https.request = originalRequest
  }
}

async function assertPutErrorRedactsSts() {
  const originalRequest = https.request
  https.request = (options, onResponse) => {
    const req = new EventEmitter()
    req.end = () => {
      process.nextTick(() => {
        const response = new EventEmitter()
        response.statusCode = 403
        response.setEncoding = () => {}
        onResponse(response)
        response.emit('data', `<Error><StringToSign>PUT\nx-oss-security-token:${TOKEN}\n/${BUCKET}/fake.mp4</StringToSign>`)
        response.emit('data', `<Message>security-token=${encodeURIComponent(TOKEN)} rejected</Message></Error>`)
        response.emit('end')
      })
    }
    return req
  }

  try {
    let failure = null
    try {
      await oss.putObjectBuffer('fake.mp4', Buffer.from('fake'), 'video/mp4')
    } catch (error) {
      failure = error
    }
    assert(failure, 'OSS 非 2xx 响应必须拒绝 Promise')
    assert.strictEqual(failure.statusCode, 403)
    assert.ok(!failure.message.includes(TOKEN), 'OSS Error 不得泄露 STS token 原值')
    assert.ok(!failure.message.includes(encodeURIComponent(TOKEN)), 'OSS Error 不得泄露 URL 编码 STS token')
    assert.ok(failure.message.includes('[STS_TOKEN_REDACTED]'), 'OSS Error 应保留可诊断结构并标明已脱敏')
  } finally {
    https.request = originalRequest
  }
}

async function main() {
  const readKey = 'house-videos/20260710/room 101.mp4'
  assertSignedUrl(oss.createSignedReadUrl(readKey, 900), readKey, {
    'security-token': TOKEN
  })

  const snapshotKey = 'house-videos/20260710/room-102.mp4'
  assertSignedUrl(oss.createVideoSnapshotUrl(snapshotKey, 900), snapshotKey, {
    'security-token': TOKEN,
    'x-oss-process': SNAPSHOT_PROCESS
  })

  const videoPolicy = oss.createVideoUploadPolicy({ objectKey: 'house-videos/fake.mp4' })
  const screenshotPolicy = oss.createGroupScreenshotUploadPolicy({ objectKey: 'group-screenshots/fake.jpg' })
  assert.strictEqual(videoPolicy.formData['x-oss-security-token'], TOKEN, '视频直传 POST 必须携带 STS token')
  assert.strictEqual(screenshotPolicy.formData['x-oss-security-token'], TOKEN, '图片直传 POST 必须携带 STS token')

  await assertPutObjectUsesSts()
  await assertPutErrorRedactsSts()

  // 长期 AK/SK 模式继续兼容：不配置 token 时，签名串和 URL 不应凭空增加 subresource。
  config.oss.securityToken = ''
  const longTermUrl = new URL(oss.createSignedReadUrl('house-videos/long-term.mp4', 900))
  const expires = longTermUrl.searchParams.get('Expires')
  const expected = sign(['GET', '', '', expires, `/${BUCKET}/house-videos/long-term.mp4`].join('\n'))
  assert.strictEqual(longTermUrl.searchParams.has('security-token'), false, '长期 AK 链接不应出现空 security-token')
  assert.strictEqual(longTermUrl.searchParams.get('Signature'), expected, '长期 AK 原签名语义必须保持不变')

  console.log('oss-sts-signing-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
