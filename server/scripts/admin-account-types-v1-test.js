const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

// 需求1：后台「新增账号」支持类型（中介/员工），建 db.users（手机号登录）。
// 锁定：创建中介 role=中介、员工 role=内部员工；手机号去重；参数校验；超管鉴权；新账号可手机号登录。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-acct-types-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 42100 + Math.floor(Math.random() * 800)
const baseUrl = `http://127.0.0.1:${port}`

function seedDb() {
  const db = {
    users: [{ id: 'U1', name: '超管员工', phone: '13900000001', isAdmin: true }],
    listings: [],
    footprints: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'super1', password: 'super1pass', name: '超管', userId: 'U1', permission: '全部后台权限', status: '启用' },
      { id: 'A-REST', account: 'restadmin', password: 'restpass1', name: '区域', userId: 'U1', permission: '区域查看权限', status: '启用' }
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

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN_SECRET: 'acct-types-secret', AUTH_TOKEN_SECRET: 'acct-types-mini', V1_DISABLE_LEGACY_ROUTES: '1' },
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

    // 超管鉴权：普通管理员不得创建账号
    const restCreate = await request('POST', '/admin/users', { type: 'broker', name: '甲', phone: '13900000010' }, restAuth)
    assert.strictEqual(restCreate.statusCode, 403, '区域查看权限不得创建中介/员工账号')

    // 创建中介账号 → 200，db.users 出现 role=中介、isAdmin=false
    const brokerPhone = '13900000010'
    const createBroker = await request('POST', '/admin/users', { type: 'broker', name: '中介甲', phone: brokerPhone }, superAuth)
    assert.strictEqual(createBroker.statusCode, 200, `创建中介账号应 200：${JSON.stringify(createBroker.body)}`)
    const usersAfterBroker = (createBroker.body.data.users || [])
    const brokerRow = usersAfterBroker.find((item) => item.phone === brokerPhone)
    assert.ok(brokerRow, '创建后中介应出现在用户列表')
    assert.strictEqual(brokerRow.role, '中介', '中介账号 role 应为中介')
    assert.strictEqual(brokerRow.isAdmin, false, '中介账号 isAdmin 应为 false')

    // 新中介可手机号登录
    const brokerLogin = await request('POST', '/mini/auth/login', { phone: brokerPhone })
    assert.strictEqual(brokerLogin.statusCode, 200, `新中介应能手机号登录：${JSON.stringify(brokerLogin.body)}`)
    assert.strictEqual(brokerLogin.body.data.role, '中介', '登录返回 role 应为中介')

    // 创建员工账号 → role=内部员工
    const staffPhone = '13900000011'
    const createStaff = await request('POST', '/admin/users', { type: 'staff', name: '员工乙', phone: staffPhone }, superAuth)
    assert.strictEqual(createStaff.statusCode, 200, `创建员工账号应 200：${JSON.stringify(createStaff.body)}`)
    const staffRow = (createStaff.body.data.users || []).find((item) => item.phone === staffPhone)
    assert.ok(staffRow, '创建后员工应出现在用户列表')
    assert.strictEqual(staffRow.role, '内部员工', '员工账号 role 应为内部员工')

    // 手机号去重：同号再建 → 400
    const dup = await request('POST', '/admin/users', { type: 'broker', name: '重复', phone: brokerPhone }, superAuth)
    assert.strictEqual(dup.statusCode, 400, '重复手机号应被拒绝')

    // 参数校验
    const badPhone = await request('POST', '/admin/users', { type: 'broker', name: '甲', phone: '123' }, superAuth)
    assert.strictEqual(badPhone.statusCode, 400, '非法手机号应 400')
    const noName = await request('POST', '/admin/users', { type: 'broker', name: '', phone: '13900000099' }, superAuth)
    assert.strictEqual(noName.statusCode, 400, '缺姓名应 400')
    const badType = await request('POST', '/admin/users', { type: 'admin', name: '甲', phone: '13900000098' }, superAuth)
    assert.strictEqual(badType.statusCode, 400, '类型只能是中介或员工（管理账号走 /admin/accounts）')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-account-types-v1-test passed')
}).catch((error) => {
  console.error(`admin-account-types-v1-test failed: ${error.message}`)
  process.exit(1)
})
