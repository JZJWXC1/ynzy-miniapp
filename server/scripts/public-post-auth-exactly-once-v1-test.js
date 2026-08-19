'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')

const BROKER_PASSWORD = 'synthetic-broker-password-123'
const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-public-post-auth-once-'))
const dataFile = path.join(tempDir, 'db.json')
const appPort = 42500 + Math.floor(Math.random() * 500)
const providerPort = appPort + 1000
const baseUrl = `http://127.0.0.1:${appPort}`

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function seedDb() {
  const now = nowText()
  fs.writeFileSync(dataFile, JSON.stringify({
    currentUserId: 'U1',
    users: [{
      id: 'U1',
      name: '合成测试中介',
      phone: '13900000001',
      role: '中介',
      authed: '手机号登录',
      passwordHash: hashPassword(BROKER_PASSWORD),
      tokenVersion: 0
    }],
    listings: [{
      id: 'AUTH_ONCE_COMPANY_1',
      title: '合成测试公司房源',
      shortTitle: '合成测试小区',
      uploaderId: 'U1',
      rent: 3600,
      layout: '整租两室一厅',
      city: '杭州',
      district: '拱墅区',
      area: '拱墅区',
      block: '合成测试板块',
      community: '合成测试小区',
      building: '1幢',
      unit: '1单元',
      roomNumber: '101',
      address: '杭州拱墅区合成测试小区1幢1单元101室',
      landlordPhone: '13911112222',
      status: '在租',
      reviewStatus: '无需审核',
      lifecycleStatus: 'active',
      ownerType: '公司房源',
      houseSourceType: '公司房源',
      source: '公司房源',
      companyListing: true,
      isCompanyListing: true,
      noCommission: true,
      lastVerifiedAt: now,
      updatedAt: now,
      createdAt: now
    }],
    llmConfig: {
      enabled: true,
      provider: 'synthetic-auth-once-provider',
      apiBaseUrl: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
      model: 'synthetic-model',
      secretName: 'AUTH_ONCE_PROVIDER_KEY',
      providerTimeoutMs: 5000
    }
  }), 'utf8')
}

function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${baseUrl}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json = {}
        try { json = text ? JSON.parse(text) : {} } catch (error) {}
        resolve({ statusCode: res.statusCode, body: json, text })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitForServer() {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/healthz')
      if (response.statusCode === 200) return true
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function dataOf(response) {
  return response.body && response.body.data
}

async function main() {
  seedDb()
  let providerCallCount = 0
  let heldProviderResponse = null
  let signalProviderStarted
  const providerStarted = new Promise((resolve) => { signalProviderStarted = resolve })
  const provider = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      providerCallCount += 1
      heldProviderResponse = res
      signalProviderStarted({ body })
    })
  })
  await new Promise((resolve) => provider.listen(providerPort, '127.0.0.1', resolve))

  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: 'synthetic-auth-once-secret',
      AUTH_ONCE_PROVIDER_KEY: 'synthetic-provider-key',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk.toString() })
  server.stderr.on('data', (chunk) => { output += chunk.toString() })

  try {
    assert.ok(await waitForServer(), `public POST auth exactly-once 测试服务未启动：${output}`)

    const malformed = await request('POST', '/mini/llm/match', {
      stage: 'match',
      confirmed: true,
      form: { community: '合成测试小区' }
    }, { Authorization: 'Bearer malformed.synthetic.token' })
    assert.strictEqual(malformed.statusCode, 401, '非空畸形 Authorization 必须 401')
    assert.strictEqual(dataOf(malformed).authFailurePhase, 'pre_execution', '业务执行前拒绝的 401 必须有可审计阶段标记')
    assert.strictEqual(providerCallCount, 0, '执行前鉴权失败不得调用 LLM')

    const login = await request('POST', '/mini/auth/login', {
      phone: '13900000001',
      password: BROKER_PASSWORD
    })
    assert.strictEqual(login.statusCode, 200)
    const token = dataOf(login).token
    assert.ok(token, '登录必须返回合法 token')

    const inFlight = request('POST', '/mini/llm/match', {
      stage: 'match',
      confirmed: true,
      text: '合成测试小区两室三千六',
      form: {
        community: '合成测试小区',
        layout: '两室',
        maxBudget: 3600
      }
    }, { Authorization: `Bearer ${token}` })

    await Promise.race([
      providerStarted,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('LLM provider 未收到请求')), 5000))
    ])
    assert.strictEqual(providerCallCount, 1, '已通过初始鉴权的请求只应启动一次 LLM 执行')

    const logout = await request('POST', '/mini/auth/logout', {}, { Authorization: `Bearer ${token}` })
    assert.strictEqual(logout.statusCode, 200, '并发登出必须撤销请求中的会话')

    heldProviderResponse.writeHead(200, { 'Content-Type': 'application/json' })
    heldProviderResponse.end(JSON.stringify({
      choices: [{ message: { content: '合成提供商已返回' } }]
    }))

    const revokedAfterExecution = await inFlight
    assert.strictEqual(revokedAfterExecution.statusCode, 401, '执行中会话被撤销时必须拒绝迟到结果')
    assert.notStrictEqual(
      dataOf(revokedAfterExecution) && dataOf(revokedAfterExecution).authFailurePhase,
      'pre_execution',
      '已调用 LLM 后的 401 不得伪装成“执行前失败”，否则客户端会重放'
    )
    assert.strictEqual(providerCallCount, 1, '执行后撤销不得触发第二次 LLM 调用')
  } finally {
    if (heldProviderResponse && !heldProviderResponse.writableEnded) heldProviderResponse.destroy()
    server.kill()
    await new Promise((resolve) => provider.close(resolve))
  }

  console.log('public-post-auth-exactly-once-v1-test passed')
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
