const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-assistant-route-timeout-'))
const dataFile = path.join(tempDir, 'db.json')
const appPort = 41000 + Math.floor(Math.random() * 1000)
const providerPort = appPort + 1200
const baseUrl = `http://127.0.0.1:${appPort}`

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function seedDb() {
  const now = nowText()
  fs.writeFileSync(dataFile, JSON.stringify({
    currentUserId: 'U1',
    users: [
      { id: 'U1', name: '测试中介', phone: '13900000001', role: '中介', authed: '手机号登录' }
    ],
    listings: [
      {
        id: 'AST_TIMEOUT_1',
        title: '新天地测试两室',
        shortTitle: '新天地测试房',
        uploaderId: 'U1',
        rent: 3900,
        layout: '整租两室一厅一卫',
        city: '杭州',
        district: '拱墅区',
        area: '拱墅',
        block: '新天地',
        community: '新天地测试小区',
        building: '1幢',
        unit: '1单元',
        roomNumber: '101',
        address: '杭州拱墅区新天地测试小区1幢1单元101室',
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
        videoUrl: '',
        videoKey: '',
        lastVerifiedAt: now,
        updatedAt: now,
        createdAt: now
      }
    ],
    llmConfig: {
      enabled: true,
      provider: 'timeout-route-test',
      apiBaseUrl: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
      model: 'test',
      secretName: 'ASSISTANT_TIMEOUT_TEST_KEY',
      providerTimeoutMs: 40000
    }
  }), 'utf8')
}

function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
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
        try {
          json = text ? JSON.parse(text) : {}
        } catch (error) {}
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
      const res = await request('GET', '/healthz')
      if (res.statusCode === 200) return true
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function dataOf(res) {
  return res.body && res.body.data
}

async function main() {
  seedDb()
  const provider = http.createServer(() => {})
  await new Promise((resolve) => provider.listen(providerPort, '127.0.0.1', resolve))

  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: 'assistant-route-timeout-secret',
      ASSISTANT_TIMEOUT_TEST_KEY: 'test-secret',
      ASSISTANT_CHAT_FALLBACK_TIMEOUT_MS: '80'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk.toString() })
  server.stderr.on('data', (chunk) => { output += chunk.toString() })

  try {
    assert.ok(await waitForServer(), `assistant chat route timeout test server 未启动：${output}`)
    const login = await request('POST', '/mini/auth/login', { phone: '13900000001' })
    assert.strictEqual(login.statusCode, 200, '登录应返回 200')
    const token = dataOf(login).token
    assert.ok(token, '登录应返回 token')

    const startedAt = Date.now()
    const assistant = await request('POST', '/mini/assistant/chat', {
      text: '新天地测试小区四千左右的两室。嗯。',
      form: {
        community: '新天地测试小区',
        layout: '两室',
        maxBudget: 4000
      }
    }, {
      Authorization: `Bearer ${token}`
    })
    const durationMs = Date.now() - startedAt
    assert.strictEqual(assistant.statusCode, 200, 'assistant chat 超时降级应返回 200')
    assert(durationMs < 25000, `assistant chat 真实路径必须 25 秒内返回，实际 ${durationMs}ms`)
    assert(durationMs < 2000, `测试超时覆盖应快速触发，实际 ${durationMs}ms`)
    const data = dataOf(assistant)
    assert.strictEqual(data.degraded, true, '真实 assistant chat 路径超时后必须 degraded=true')
    assert.strictEqual(data.degradedNotice, '智能解读稍后重试', '降级提示文案必须稳定')
    assert.ok((data.listings || []).some((item) => item.id === 'AST_TIMEOUT_1'), `降级结果必须返回本地真实房源匹配：${JSON.stringify(data)}`)

    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(/\[assistant-chat\].*guest=false/.test(output), 'assistant chat 日志必须标明 guest=false')
    assert.ok(/\[assistant-chat\].*degraded=true/.test(output), 'assistant chat 日志必须标明 degraded=true')
  } finally {
    server.kill()
    provider.close()
  }

  console.log('assistant-chat-route-timeout-fallback-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
