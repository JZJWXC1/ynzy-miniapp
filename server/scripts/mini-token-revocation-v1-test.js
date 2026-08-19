const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')

const serverDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(serverDir, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-mini-token-revoke-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 44900 + Math.floor(Math.random() * 300)
const baseUrl = `http://127.0.0.1:${port}`
const authSecret = 'mini-token-revocation-secret'
const originalPassword = 'original-pass-123'
const changedPassword = 'changed-pass-456'
const resetPassword = 'reset-pass-789'

function seedDb() {
  fs.writeFileSync(dataFile, JSON.stringify({
    users: [
      { id: 'U-ADMIN', name: '超级管理员', phone: '13900000100', isAdmin: true },
      {
        id: 'U-BROKER',
        name: '会话撤销测试中介',
        phone: '13900000101',
        role: '中介',
        isAdmin: false,
        authed: '手机号登录',
        passwordHash: hashPassword(originalPassword)
        // 故意不写 tokenVersion：锁定上线前存量账号和旧 token 的兼容行为。
      }
    ],
    listings: [],
    footprints: [],
    registrationRequests: [],
    adminAccounts: [
      {
        id: 'A-SUPER',
        account: 'super-token-test',
        password: 'super-token-pass',
        name: '超级管理员',
        userId: 'U-ADMIN',
        permission: '全部后台权限',
        status: '启用'
      }
    ]
  }, null, 2), 'utf8')
}

function request(method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
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

function dataOf(response) {
  return response.body && response.body.data
}

function auth(token) {
  return { Authorization: `Bearer ${token}` }
}

function signMiniToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function tokenPayload(token) {
  return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'))
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

async function login(password) {
  return request('POST', '/mini/auth/login', { phone: '13900000101', password })
}

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: authSecret,
      ADMIN_TOKEN_SECRET: 'mini-token-revocation-admin-secret',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  let stderr = ''
  server.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  try {
    assert.ok(await waitForServer(), `测试服务未启动：${stderr}`)

    // 1. 上线前签发的旧 token 没有 tokenVersion；账号尚未变更密码时继续有效，避免升级即全员掉线。
    const legacyToken = signMiniToken({ userId: 'U-BROKER', exp: Date.now() + 60 * 60 * 1000 })
    const legacyMe = await request('GET', '/mini/auth/me', null, auth(legacyToken))
    assert.strictEqual(legacyMe.statusCode, 200, 'tokenVersion 缺失的存量 token 在账号版本为 0 时应兼容')

    // 2. 模拟两台设备登录，均拿到版本 0 token。
    const deviceALogin = await login(originalPassword)
    const deviceBLogin = await login(originalPassword)
    assert.strictEqual(deviceALogin.statusCode, 200, '设备 A 应登录成功')
    assert.strictEqual(deviceBLogin.statusCode, 200, '设备 B 应登录成功')
    const tokenA = dataOf(deviceALogin).token
    const tokenB = dataOf(deviceBLogin).token
    assert.strictEqual(tokenPayload(tokenA).tokenVersion, 0, '首次登录 token 应显式携带版本 0')
    assert.strictEqual(tokenPayload(tokenB).tokenVersion, 0, '第二设备 token 应显式携带版本 0')
    assert.strictEqual(dataOf(deviceALogin).tokenVersion, undefined, 'tokenVersion 不得作为用户字段泄露')

    // 3. 设备 A 自助改密：响应必须带版本 1 新 token，当前设备继续使用；全部旧 token 立即 401。
    const changed = await request('POST', '/mini/auth/password', {
      oldPassword: originalPassword,
      newPassword: changedPassword
    }, auth(tokenA))
    assert.strictEqual(changed.statusCode, 200, '自助改密应成功')
    const changedUser = dataOf(changed)
    assert.ok(changedUser.token, '自助改密响应必须给当前设备签发新 token')
    assert.strictEqual(tokenPayload(changedUser.token).tokenVersion, 1, '自助改密后的新 token 应升级到版本 1')
    assert.strictEqual(changedUser.passwordHash, undefined, '改密响应不得泄露 passwordHash')
    assert.strictEqual(changedUser.tokenVersion, undefined, '改密响应不得泄露 tokenVersion 用户字段')

    for (const [label, token] of [['设备 A 旧 token', tokenA], ['设备 B 旧 token', tokenB], ['存量旧 token', legacyToken]]) {
      const response = await request('GET', '/mini/auth/me', null, auth(token))
      assert.strictEqual(response.statusCode, 401, `${label} 在改密后必须立即失效`)
    }
    const currentDeviceMe = await request('GET', '/mini/auth/me', null, auth(changedUser.token))
    assert.strictEqual(currentDeviceMe.statusCode, 200, '当前设备替换为新 token 后应保持登录')
    assert.strictEqual(dataOf(currentDeviceMe).tokenVersion, undefined, '/mini/auth/me 不得泄露 tokenVersion')

    let db = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assert.strictEqual(db.users.find((item) => item.id === 'U-BROKER').tokenVersion, 1, '自助改密必须持久化 tokenVersion=1')

    // 4. 管理员重置密码：所有现存小程序会话失效，用户只能用重置后的新密码重新登录。
    const adminLogin = await request('POST', '/admin/auth/login', {
      account: 'super-token-test',
      password: 'super-token-pass'
    })
    assert.strictEqual(adminLogin.statusCode, 200, '超级管理员应登录成功')
    const reset = await request('POST', '/admin/users/U-BROKER/password', {
      password: resetPassword
    }, auth(dataOf(adminLogin).token))
    assert.strictEqual(reset.statusCode, 200, '管理员重置用户密码应成功')
    const resetRows = dataOf(reset).users || []
    assert.strictEqual(resetRows.find((item) => item.id === 'U-BROKER').tokenVersion, undefined, '后台用户列表不得泄露 tokenVersion')

    const afterAdminReset = await request('GET', '/mini/auth/me', null, auth(changedUser.token))
    assert.strictEqual(afterAdminReset.statusCode, 401, '管理员重置后自助改密签发的新 token 也必须失效')
    const changedPasswordLogin = await login(changedPassword)
    assert.strictEqual(changedPasswordLogin.statusCode, 403, '管理员重置后旧密码不能登录')
    const resetPasswordLogin = await login(resetPassword)
    assert.strictEqual(resetPasswordLogin.statusCode, 200, '管理员重置后的密码应能登录')
    assert.strictEqual(tokenPayload(dataOf(resetPasswordLogin).token).tokenVersion, 2, '重置后新登录 token 应为版本 2')

    // 5. 即使攻击者知道签名密钥测试值，签出错误/畸形版本也不能绕过账号当前版本检查。
    const wrongVersion = signMiniToken({ userId: 'U-BROKER', exp: Date.now() + 60 * 60 * 1000, tokenVersion: 1 })
    const wrongVersionMe = await request('GET', '/mini/auth/me', null, auth(wrongVersion))
    assert.strictEqual(wrongVersionMe.statusCode, 401, '合法签名但旧 tokenVersion 必须被拒绝')
    const malformedVersion = signMiniToken({ userId: 'U-BROKER', exp: Date.now() + 60 * 60 * 1000, tokenVersion: '2' })
    const malformedVersionMe = await request('GET', '/mini/auth/me', null, auth(malformedVersion))
    assert.strictEqual(malformedVersionMe.statusCode, 401, '非整数类型 tokenVersion 必须被拒绝')

    db = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assert.strictEqual(db.users.find((item) => item.id === 'U-BROKER').tokenVersion, 2, '两次改密后 tokenVersion 应持久化为 2')

    // 6. 小程序改密页必须把服务端返回的新 token 写回 App，且向用户明确其他设备需重新登录。
    const pageJs = fs.readFileSync(path.join(repoRoot, 'pages', 'change-password', 'change-password.js'), 'utf8')
    const pageWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'change-password', 'change-password.wxml'), 'utf8')
    assert.ok(/changePassword[\s\S]*\.then\(\(user\)[\s\S]*app\.setCurrentUser\(user\)/.test(pageJs), '改密页必须保存响应里的新 token')
    assert.ok(pageWxml.includes('其他设备需使用新密码重新登录'), '改密页必须说明其他设备会话失效')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('mini-token-revocation-v1-test passed')
}).catch((error) => {
  console.error(`mini-token-revocation-v1-test failed: ${error.message}`)
  process.exit(1)
})
