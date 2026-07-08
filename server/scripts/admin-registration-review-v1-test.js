const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

// 需求2：注册审核。小程序注册先落库待审核，管理员审核通过（选类型）后才开通账号，驳回留原因。
// 锁定：注册不再直接开通(403待审核+不发token+落库)、去重、审核列表、通过开通(中介/员工)、驳回、重新申请、鉴权、已开通账号向后兼容。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-reg-review-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 43700 + Math.floor(Math.random() * 800)
const baseUrl = `http://127.0.0.1:${port}`

const EXISTING_PHONE = '13900000001'
const APPLY_PHONE = '13900000031'
const REJECT_PHONE = '13900000032'
const STAFF_PHONE = '13900000033'

function seedDb() {
  const db = {
    // 既有已开通中介：向后兼容——注册其手机号仍按登录发 token。
    users: [
      { id: 'U-ADMIN', name: '超管员工', phone: '13900000009', isAdmin: true },
      { id: 'U-EXIST', name: '既有中介', phone: EXISTING_PHONE, role: '中介', isAdmin: false, authed: '手机号登录' }
    ],
    listings: [],
    footprints: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'super1', password: 'super1pass', name: '超管', userId: 'U-ADMIN', permission: '全部后台权限', status: '启用' },
      { id: 'A-REST', account: 'restadmin', password: 'restpass1', name: '区域', userId: 'U-ADMIN', permission: '区域查看权限', status: '启用' }
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

async function login(account, password) {
  const res = await request('POST', '/admin/auth/login', { account, password })
  assert.strictEqual(res.statusCode, 200, `${account} 登录失败：${JSON.stringify(res.body)}`)
  return { Authorization: `Bearer ${res.body.data.token}` }
}

async function listRequests(auth) {
  const res = await request('GET', '/admin/registrations', null, auth)
  assert.strictEqual(res.statusCode, 200, `注册申请列表应 200：${JSON.stringify(res.body)}`)
  return res.body.data.requests || []
}

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN_SECRET: 'reg-review-secret', AUTH_TOKEN_SECRET: 'reg-review-mini', V1_DISABLE_LEGACY_ROUTES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (c) => { output += c.toString() })
  server.stderr.on('data', (c) => { output += c.toString() })

  try {
    assert.ok(await waitForServer(), `服务未启动：${output}`)

    const superAuth = await login('super1', 'super1pass')
    const restAuth = await login('restadmin', 'restpass1')

    // 向后兼容：注册既有已开通账号的手机号 → 200 + 发 token（按登录处理）
    const existRegister = await request('POST', '/mini/auth/register', { name: '既有中介', phone: EXISTING_PHONE })
    assert.strictEqual(existRegister.statusCode, 200, '既有账号注册应按登录返回 200')
    assert.ok(existRegister.body.data && existRegister.body.data.token, '既有账号注册应发 token')

    // 新手机号注册 → 403 待审核、不发 token、落库
    const apply = await request('POST', '/mini/auth/register', { name: '申请人甲', phone: APPLY_PHONE })
    assert.strictEqual(apply.statusCode, 403, '新手机号注册应待审核（403）')
    assert.ok(/审核/.test(JSON.stringify(apply.body)), '待审核提示应含“审核”')
    assert.ok(!(apply.body.data && apply.body.data.token), '待审核不应发 token')

    // 待审核期间不能登录
    const preLogin = await request('POST', '/mini/auth/login', { phone: APPLY_PHONE })
    assert.strictEqual(preLogin.statusCode, 403, '未开通账号不能登录')

    // 重复注册同号 → 去重，仍只有 1 条待审核
    await request('POST', '/mini/auth/register', { name: '申请人甲', phone: APPLY_PHONE })
    let requests = await listRequests(superAuth)
    const applyPending = requests.filter((item) => item.phone === APPLY_PHONE && item.status === '待审核')
    assert.strictEqual(applyPending.length, 1, '同号重复注册应去重为 1 条待审核')

    // 超管鉴权：普通管理员不得看列表 / 审核
    const restList = await request('GET', '/admin/registrations', null, restAuth)
    assert.strictEqual(restList.statusCode, 403, '区域查看权限不得查看注册申请')

    // 通过为中介 → 开通 db.users(role=中介)，之后可登录
    const applyId = applyPending[0].id
    const restApprove = await request('POST', `/admin/registrations/${applyId}/review`, { action: 'approve', type: 'broker' }, restAuth)
    assert.strictEqual(restApprove.statusCode, 403, '区域查看权限不得审核')
    const approve = await request('POST', `/admin/registrations/${applyId}/review`, { action: 'approve', type: 'broker' }, superAuth)
    assert.strictEqual(approve.statusCode, 200, `审核通过应 200：${JSON.stringify(approve.body)}`)
    const brokerLogin = await request('POST', '/mini/auth/login', { phone: APPLY_PHONE })
    assert.strictEqual(brokerLogin.statusCode, 200, '通过后应能登录')
    assert.strictEqual(brokerLogin.body.data.role, '中介', '通过为中介应 role=中介')

    // 已处理的申请不能再审核 → 400
    const reReview = await request('POST', `/admin/registrations/${applyId}/review`, { action: 'approve', type: 'broker' }, superAuth)
    assert.strictEqual(reReview.statusCode, 400, '已处理申请不能再审核')

    // 审核不存在申请 → 404
    const missing = await request('POST', '/admin/registrations/R-NOEXIST/review', { action: 'approve', type: 'broker' }, superAuth)
    assert.strictEqual(missing.statusCode, 404, '审核不存在申请应 404')

    // 驳回 + 留原因 → 状态已驳回、不能登录
    await request('POST', '/mini/auth/register', { name: '申请人乙', phone: REJECT_PHONE })
    requests = await listRequests(superAuth)
    const rejectId = requests.find((item) => item.phone === REJECT_PHONE && item.status === '待审核').id
    const reject = await request('POST', `/admin/registrations/${rejectId}/review`, { action: 'reject', reason: '资料不全' }, superAuth)
    assert.strictEqual(reject.statusCode, 200, `驳回应 200：${JSON.stringify(reject.body)}`)
    assert.strictEqual(reject.body.data.request.status, '已驳回', '驳回后状态应为已驳回')
    assert.strictEqual(reject.body.data.request.rejectReason, '资料不全', '驳回原因应保留')
    const rejectLogin = await request('POST', '/mini/auth/login', { phone: REJECT_PHONE })
    assert.strictEqual(rejectLogin.statusCode, 403, '被驳回账号不能登录')

    // 被驳回后可重新申请 → 回到待审核
    const reApply = await request('POST', '/mini/auth/register', { name: '申请人乙', phone: REJECT_PHONE })
    assert.strictEqual(reApply.statusCode, 403, '重新申请应回到待审核（403）')
    requests = await listRequests(superAuth)
    assert.ok(requests.some((item) => item.phone === REJECT_PHONE && item.status === '待审核'), '重新申请后应回到待审核')

    // 通过为员工 → role=内部员工
    await request('POST', '/mini/auth/register', { name: '员工丙', phone: STAFF_PHONE })
    requests = await listRequests(superAuth)
    const staffId = requests.find((item) => item.phone === STAFF_PHONE && item.status === '待审核').id
    const approveStaff = await request('POST', `/admin/registrations/${staffId}/review`, { action: 'approve', type: 'staff' }, superAuth)
    assert.strictEqual(approveStaff.statusCode, 200, '通过为员工应 200')
    const staffLogin = await request('POST', '/mini/auth/login', { phone: STAFF_PHONE })
    assert.strictEqual(staffLogin.statusCode, 200, '员工通过后应能登录')
    assert.strictEqual(staffLogin.body.data.role, '内部员工', '通过为员工应 role=内部员工')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-registration-review-v1-test passed')
}).catch((error) => {
  console.error(`admin-registration-review-v1-test failed: ${error.message}`)
  process.exit(1)
})
