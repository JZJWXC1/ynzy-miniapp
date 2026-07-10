'use strict'

// 小程序请求诊断契约：失败时保留真实 errMsg/超时/耗时/后端 trace，且日志绝不带请求体、
// Authorization 或 OSS 签名查询参数。全部 mock wx，不请求公网。

const assert = require('assert')

const API_BASE = 'https://api.example.test'
const AUTH_TOKEN = 'FAKE_AUTH_TOKEN_MUST_NOT_BE_LOGGED'
const BODY_SECRET = 'FAKE_BODY_SECRET_MUST_NOT_BE_LOGGED'

function setupEnv(wxOverrides = {}) {
  global.getApp = () => ({
    globalData: {
      authToken: AUTH_TOKEN,
      apiConfig: {
        env: 'prod',
        baseUrl: API_BASE,
        timeout: 15000,
        token: AUTH_TOKEN
      }
    }
  })
  global.getCurrentPages = () => [{ route: 'pages/match-chat/match-chat' }]
  global.wx = {
    getStorageSync() { return '' },
    removeStorageSync() {},
    ...wxOverrides
  }
}

function loadFresh() {
  const clientPath = require.resolve('../../utils/api-client')
  delete require.cache[clientPath]
  return require('../../utils/api-client')
}

function captureDiagnostics() {
  const lines = []
  const original = console.error
  console.error = (...args) => lines.push(args.map((item) => String(item)).join(' '))
  return {
    lines,
    restore() { console.error = original }
  }
}

async function expectRejected(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('预期 Promise 拒绝，但实际成功')
}

async function testNetworkTimeout() {
  let capturedOptions
  setupEnv({
    request(options) {
      capturedOptions = options
      options.fail({ errMsg: `request:fail timeout ${options.url}`, errno: 5 })
    }
  })
  const diagnostics = captureDiagnostics()
  try {
    const client = loadFresh()
    const error = await expectRejected(client.request({
      path: `/mini/llm/match?phone=13800000000&secret=${BODY_SECRET}`,
      method: 'POST',
      timeout: 60000,
      data: { text: BODY_SECRET }
    }))

    assert.strictEqual(capturedOptions.timeout, 60000, '实际 wx.request 必须使用调用方 60s 超时')
    assert.strictEqual(capturedOptions.header.Authorization, `Bearer ${AUTH_TOKEN}`, '原鉴权头行为保持不变')
    assert.ok(error.message.startsWith('request:fail timeout'), '调用方仍能拿到微信原始失败类型')
    assert.ok(error.errMsg.includes(`${API_BASE}/mini/llm/match?[查询参数已隐藏]`), '原 errMsg 仅脱敏查询参数，不吞路径证据')
    assert.strictEqual(error.requestType, 'request')
    assert.strictEqual(error.requestMethod, 'POST')
    assert.strictEqual(error.requestUrl, `${API_BASE}/mini/llm/match`, '诊断 URL 必须去掉全部查询参数')
    assert.strictEqual(error.timeout, 60000)
    assert.strictEqual(error.networkError, true)
    assert.strictEqual(error.errorCode, 5)
    assert.ok(Number.isFinite(error.durationMs) && error.durationMs >= 0, '应记录失败前实际耗时')
    assert.strictEqual(error.traceId, '', '请求未到后端时没有伪造 traceId')
    assert.strictEqual(diagnostics.lines.length, 1, '一次失败只写一条统一诊断日志')

    const log = diagnostics.lines[0]
    assert.ok(log.includes('[api-request-fail]'), 'vConsole 应有稳定日志前缀')
    assert.ok(log.includes('request:fail timeout'), '日志应保留原始失败类型')
    assert.ok(log.includes('"timeout":60000'), '日志应包含真实超时值')
    assert.ok(log.includes('"errorCode":5'), '日志应包含微信底层 errno')
    assert.ok(!log.includes(AUTH_TOKEN), '日志绝不能泄露 Authorization token')
    assert.ok(!log.includes(BODY_SECRET), '日志绝不能泄露请求体或查询参数')
    assert.ok(!log.includes('13800000000'), '日志绝不能泄露查询参数中的手机号')
  } finally {
    diagnostics.restore()
  }
}

async function testHttpErrorTrace() {
  const traceId = '0123456789abcdef'
  setupEnv({
    request(options) {
      options.success({
        statusCode: 502,
        data: { message: '手机号 13900000001 的 LLM 供应商失败', data: { private: BODY_SECRET } },
        header: { 'x-trace-id': traceId }
      })
    }
  })
  const diagnostics = captureDiagnostics()
  try {
    const client = loadFresh()
    const error = await expectRejected(client.request({ path: '/mini/llm/match', method: 'POST' }))
    assert.strictEqual(error.statusCode, 502)
    assert.strictEqual(error.traceId, traceId, 'HTTP 错误必须接住后端 X-Trace-Id')
    assert.strictEqual(error.networkError, false, '收到 HTTP 响应不属于手机侧网络失败')
    assert.strictEqual(error.data.private, BODY_SECRET, '保持既有 error.data 供调用方处理')
    assert.strictEqual(diagnostics.lines.length, 1)
    assert.ok(diagnostics.lines[0].includes(traceId), '诊断日志必须能与后端日志按 trace 对齐')
    assert.ok(!diagnostics.lines[0].includes('13900000001'), '诊断日志必须脱敏响应消息里的手机号')
    assert.ok(!diagnostics.lines[0].includes(BODY_SECRET), '诊断日志不得打印响应 data')
  } finally {
    diagnostics.restore()
  }
}

async function testUploadRedaction() {
  const signedUrl = 'https://fake-bucket.oss-cn-hangzhou.aliyuncs.com/video.mp4?OSSAccessKeyId=FAKEID&Expires=9999999999&Signature=FAKE_SIGNATURE&security-token=FAKE_SECURITY_TOKEN'
  setupEnv({
    uploadFile(options) {
      options.fail({ errMsg: `uploadFile:fail timeout ${signedUrl}` })
      return {}
    }
  })
  const diagnostics = captureDiagnostics()
  try {
    const client = loadFresh()
    const error = await expectRejected(client.uploadFile({
      url: signedUrl,
      filePath: 'wxfile://private-video-path.mp4',
      name: 'file',
      formData: { policy: BODY_SECRET },
      timeout: 120000
    }))
    assert.strictEqual(error.requestType, 'upload')
    assert.strictEqual(error.requestUrl, 'https://fake-bucket.oss-cn-hangzhou.aliyuncs.com/video.mp4')
    assert.strictEqual(error.timeout, 120000)
    const text = `${error.message}\n${diagnostics.lines.join('\n')}`
    assert.ok(text.includes('uploadFile:fail timeout'), '上传错误类型应保留')
    assert.ok(!text.includes('FAKE_SIGNATURE'), '上传错误与日志必须隐藏 OSS Signature')
    assert.ok(!text.includes('FAKE_SECURITY_TOKEN'), '上传错误与日志必须隐藏 OSS security-token')
    assert.ok(!text.includes(BODY_SECRET), '上传日志不得打印 formData')
    assert.ok(!text.includes('private-video-path'), '上传日志不得打印本地文件路径')
  } finally {
    diagnostics.restore()
  }
}

async function testSuccessDoesNotLog() {
  setupEnv({
    request(options) {
      options.success({ statusCode: 200, data: { code: 0, data: { ok: true } }, header: { 'X-Trace-Id': 'fedcba9876543210' } })
    }
  })
  const diagnostics = captureDiagnostics()
  try {
    const client = loadFresh()
    const response = await client.request({ path: '/healthz' })
    assert.deepStrictEqual(response.data, { ok: true })
    assert.strictEqual(diagnostics.lines.length, 0, '成功请求不应制造错误日志噪声')
  } finally {
    diagnostics.restore()
  }
}

async function testPathPiiRedaction() {
  const pathPhone = '+8613800138000'
  const longPhone = '138001380009999'
  const encodedEmail = 'john%40example%2Ecom'
  setupEnv({
    request(options) {
      options.fail({ errMsg: `request:fail timeout ${options.url}` })
    }
  })
  const diagnostics = captureDiagnostics()
  try {
    const client = loadFresh()
    const error = await expectRejected(client.request({
      path: `/mini/user/${pathPhone}/${encodedEmail}/${longPhone}/detail`,
      method: 'GET'
    }))

    const text = `${error.message}\n${error.requestUrl}\n${diagnostics.lines.join('\n')}`
    assert.ok(error.requestUrl.includes('[手机号已隐藏]'), 'requestUrl 字段本身必须脱敏 path 内手机号')
    assert.ok(error.requestUrl.includes('[邮箱已隐藏]'), 'requestUrl 字段本身必须脱敏 URL 编码邮箱')
    assert.ok(!text.includes(pathPhone), '日志与 Error 不得泄露 +86 手机号')
    assert.ok(!text.includes('13800138000'), '长数字标识中的连续手机号也必须隐藏')
    assert.ok(!text.toLowerCase().includes(encodedEmail.toLowerCase()), '日志与 Error 不得泄露 URL 编码邮箱')

    const direct = client.sanitizeDiagnosticText('86 138-0013-8000 / alice@example.com / alice%40example%2Ecom')
    assert.strictEqual((direct.match(/\[手机号已隐藏\]/g) || []).length, 1, '带空格/短横线的 86 手机号应完整脱敏')
    assert.strictEqual((direct.match(/\[邮箱已隐藏\]/g) || []).length, 2, '普通与 URL 编码邮箱都应脱敏')
  } finally {
    diagnostics.restore()
  }
}

async function main() {
  await testNetworkTimeout()
  await testHttpErrorTrace()
  await testUploadRedaction()
  await testSuccessDoesNotLog()
  await testPathPiiRedaction()
  console.log('api-client-diagnostics-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
