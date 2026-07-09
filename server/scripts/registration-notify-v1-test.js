// 注册申请飞书提醒：新申请/驳回后重申请→异步推群提醒管理员；待审核期重复提交不重复轰炸；
// 已开通号(409)不通知；通知内容手机号打码不带完整 PII；未配 webhook 时注册完全不受影响。
// 本地 http 桩当假 webhook（真收 send-feishu-alert.js 发的请求），真起服务端到端验证。
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-reg-notify-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 45200 + Math.floor(Math.random() * 300)
const baseUrl = `http://127.0.0.1:${port}`

const EXISTING_PHONE = '13900000061'
const EXISTING_PASSWORD = 'exist-pass-123'
const APPLY_PHONE = '13900000062'
const APPLY_NAME = '通知测试申请人'
const NOHOOK_PHONE = '13900000063'

function seedDb() {
  const db = {
    users: [
      { id: 'U-ADMIN', name: '超管员工', phone: '13900000069', isAdmin: true },
      { id: 'U-EXIST', name: '既有中介', phone: EXISTING_PHONE, role: '中介', isAdmin: false, authed: '手机号登录', passwordHash: hashPassword(EXISTING_PASSWORD) }
    ],
    listings: [],
    footprints: [],
    registrationRequests: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'super1', password: 'super1pass', name: '超管', userId: 'U-ADMIN', permission: '全部后台权限', status: '启用' }
    ]
  }
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')
}

function request(method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let parsed = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch (error) { parsed = { raw } }
        resolve({ statusCode: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitForServer() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 12000) {
    try {
      const res = await request('GET', '/healthz')
      if (res.statusCode === 200) return true
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

// 通知是 detached spawn 的子进程发出的，异步到达：轮询等桩收到第 n 条（上限 8s）。
async function waitForHits(hits, count, ms = 8000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < ms) {
    if (hits.length >= count) return true
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return hits.length >= count
}

function spawnServer(extraEnv) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: 'reg-notify-secret',
      ADMIN_TOKEN_SECRET: 'reg-notify-admin',
      V1_DISABLE_LEGACY_ROUTES: '1',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  child.stdout.on('data', (c) => { output += c.toString() })
  child.stderr.on('data', (c) => { output += c.toString() })
  return { child, outputRef: () => output }
}

async function run() {
  // 假 webhook 桩：记录 send-feishu-alert.js 发来的每条消息
  const hits = []
  const stub = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { hits.push(JSON.parse(raw)) } catch (error) { hits.push({ raw }) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0 }))
    })
  })
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const webhook = `http://127.0.0.1:${stub.address().port}/hook`

  seedDb()
  let server = spawnServer({ HEALTH_ALERT_WEBHOOK: webhook })

  try {
    assert.ok(await waitForServer(), `注册提醒测试服务未启动：${server.outputRef()}`)

    // 1. 新注册申请 → 403 + 一条群通知（含姓名 + 打码手机号，不含完整手机号）
    const apply = await request('POST', '/mini/auth/register', { name: APPLY_NAME, phone: APPLY_PHONE, password: 'apply-pass-123' })
    assert.strictEqual(apply.statusCode, 403, '新申请应 403 待审核')
    assert.ok(await waitForHits(hits, 1), '新申请应触发 1 条飞书通知')
    const text1 = String((hits[0].content && hits[0].content.text) || '')
    assert.ok(text1.includes(APPLY_NAME), '通知应含申请人姓名')
    assert.ok(text1.includes('139****0062'), '通知手机号应打码为 139****0062')
    assert.ok(!text1.includes(APPLY_PHONE), '通知绝不能含完整手机号')
    assert.ok(text1.includes('注册审核'), '通知应指引到后台注册审核')

    // 2. 待审核期重复提交 → 仍 403，但不重复通知（防轰炸）
    await request('POST', '/mini/auth/register', { name: APPLY_NAME, phone: APPLY_PHONE, password: 'apply-pass-123' })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.strictEqual(hits.length, 1, `待审核重复提交不应再通知（实收 ${hits.length} 条）`)

    // 3. 管理员驳回后重新申请 → 再通知一条
    const login = await request('POST', '/admin/auth/login', { account: 'super1', password: 'super1pass' })
    assert.strictEqual(login.statusCode, 200, '超管应能登录')
    const superAuth = { Authorization: `Bearer ${login.body.data.token}` }
    const list = await request('GET', '/admin/registrations', null, superAuth)
    const target = (list.body.data.requests || []).find((item) => item.phone === APPLY_PHONE)
    assert.ok(target, '后台应能看到该申请')
    const reject = await request('POST', `/admin/registrations/${target.id}/review`, { action: 'reject', reason: '通知测试' }, superAuth)
    assert.strictEqual(reject.statusCode, 200, '驳回应 200')
    const reApply = await request('POST', '/mini/auth/register', { name: APPLY_NAME, phone: APPLY_PHONE, password: 'apply-pass-456' })
    assert.strictEqual(reApply.statusCode, 403, '重新申请应 403 回待审核')
    assert.ok(await waitForHits(hits, 2), '驳回后重新申请应再触发 1 条通知')

    // 4. 已开通号再注册（409 引导登录）→ 不通知
    const existed = await request('POST', '/mini/auth/register', { name: '既有中介', phone: EXISTING_PHONE, password: 'whatever-123' })
    assert.strictEqual(existed.statusCode, 409, '已开通号应 409')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.strictEqual(hits.length, 2, `已开通号注册不应通知（实收 ${hits.length} 条）`)

    // 5. 全程 PII 复查：所有通知都不含任何完整 11 位手机号
    hits.forEach((hit, index) => {
      const text = String((hit.content && hit.content.text) || '')
      assert.ok(!/1\d{10}/.test(text), `通知#${index} 不得含完整手机号：${text}`)
    })

    // 6. 崩溃防线（对抗审发现的严重项）：超长 name 注册被 400 拦在通知路径之前，
    //    即便到达 spawn，子进程 'error' 监听也把 execve E2BIG 降级为日志——服务必须保持健康、不重启。
    const before = hits.length
    const longName = 'x'.repeat(200000) // ~200KB，远超 execve 单 argv 128KiB 上限
    const longApply = await request('POST', '/mini/auth/register', { name: longName, phone: '13900000064', password: 'longname-pass-123' })
    assert.strictEqual(longApply.statusCode, 400, '超长 name 应被 400 拦截（长度上限）')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.strictEqual(hits.length, before, '被拦的注册不应触发通知')
    const alive = await request('GET', '/healthz')
    assert.strictEqual(alive.statusCode, 200, '超长 name 注册后服务必须仍健康（未被打崩重启）')
    // 崩溃循环会重置内存限流计数并让后续请求异常；再打一条正常查询确认进程连续存活
    const alive2 = await request('GET', '/healthz')
    assert.strictEqual(alive2.statusCode, 200, '服务应连续健康（无进程重启迹象）')
  } finally {
    server.child.kill()
  }

  // 6. 未配 webhook：注册流程完全不受影响（403 正常、无通知、服务不报错崩溃）
  server = spawnServer({ HEALTH_ALERT_WEBHOOK: '' })
  try {
    assert.ok(await waitForServer(), `无 webhook 服务未启动：${server.outputRef()}`)
    const before = hits.length
    const apply = await request('POST', '/mini/auth/register', { name: '无钩子申请人', phone: NOHOOK_PHONE, password: 'nohook-pass-123' })
    assert.strictEqual(apply.statusCode, 403, '无 webhook 时新申请仍应 403 待审核')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.strictEqual(hits.length, before, '无 webhook 不应有任何通知')
    const health = await request('GET', '/healthz')
    assert.strictEqual(health.statusCode, 200, '服务应保持健康')
  } finally {
    server.child.kill()
    stub.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('registration-notify-v1-test passed')
}).catch((error) => {
  console.error(`registration-notify-v1-test failed: ${error.message}`)
  process.exit(1)
})
