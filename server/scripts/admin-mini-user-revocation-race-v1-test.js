'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

// 管理员高危写不能只信请求开始时的权限快照：请求体尚未收完期间若管理员被禁用或降权，
// /admin/users/:id/status 必须在真正持写锁落库前用最新数据库重新鉴权，并保持目标用户不变。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-admin-mini-revocation-race-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 46600 + Math.floor(Math.random() * 500)
const baseUrl = `http://127.0.0.1:${port}`

const ENABLED = '启用'
const DISABLED = '禁用'
const SUPER_PERMISSION = '全部后台权限'
const RESTRICTED_PERMISSION = '区域查看权限'

function seedDb() {
  fs.writeFileSync(dataFile, JSON.stringify({
    users: [
      { id: 'U-ADMIN-DISABLE', name: '合成禁用竞态管理员', phone: '13900000301', isAdmin: true },
      { id: 'U-ADMIN-PERMISSION', name: '合成降权竞态管理员', phone: '13900000302', isAdmin: true },
      { id: 'U-ADMIN-PASSWORD', name: '合成改密竞态管理员', phone: '13900000305', isAdmin: true },
      { id: 'U-ADMIN-ACCOUNT-PASSWORD', name: '合成后台改密竞态管理员', phone: '13900000307', isAdmin: true },
      { id: 'U-TARGET-ADMIN-LINKED', name: '合成后台账号绑定用户', phone: '13900000308', isAdmin: true, tokenVersion: 0 },
      {
        id: 'U-TARGET-DISABLE',
        name: '合成禁用竞态目标',
        phone: '13900000303',
        role: '中介',
        isAdmin: false,
        status: ENABLED,
        brokerStatus: ENABLED,
        tokenVersion: 0
      },
      {
        id: 'U-TARGET-PERMISSION',
        name: '合成降权竞态目标',
        phone: '13900000304',
        role: '中介',
        isAdmin: false,
        status: ENABLED,
        brokerStatus: ENABLED,
        tokenVersion: 0
      },
      {
        id: 'U-TARGET-PASSWORD',
        name: '合成改密竞态目标',
        phone: '13900000306',
        role: '中介',
        isAdmin: false,
        status: ENABLED,
        brokerStatus: ENABLED,
        tokenVersion: 0
      }
    ],
    adminAccounts: [
      {
        id: 'A-RACE-DISABLE',
        account: 'race-disable-admin',
        password: 'fake-disable-pass-123',
        name: '合成禁用竞态管理员',
        userId: 'U-ADMIN-DISABLE',
        permission: SUPER_PERMISSION,
        status: ENABLED
      },
      {
        id: 'A-RACE-PERMISSION',
        account: 'race-permission-admin',
        password: 'fake-permission-pass-123',
        name: '合成降权竞态管理员',
        userId: 'U-ADMIN-PERMISSION',
        permission: SUPER_PERMISSION,
        status: ENABLED
      },
      {
        id: 'A-RACE-PASSWORD',
        account: 'race-password-admin',
        password: 'fake-password-admin-pass-123',
        name: '合成改密竞态管理员',
        userId: 'U-ADMIN-PASSWORD',
        permission: SUPER_PERMISSION,
        status: ENABLED
      },
      {
        id: 'A-RACE-ADMIN-PASSWORD',
        account: 'race-admin-password-admin',
        password: 'fake-admin-password-actor-123',
        name: '合成后台改密竞态管理员',
        userId: 'U-ADMIN-ACCOUNT-PASSWORD',
        permission: SUPER_PERMISSION,
        status: ENABLED
      },
      {
        id: 'A-TARGET-ADMIN',
        account: 'target-admin-account',
        password: 'fake-original-target-pass-123',
        name: '合成后台账号改密目标',
        userId: 'U-TARGET-ADMIN-LINKED',
        permission: RESTRICTED_PERMISSION,
        status: ENABLED
      }
    ],
    listings: [],
    footprints: []
  }, null, 2), 'utf8')
}

function readDb() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^\uFEFF/, ''))
}

function atomicMutateDb(mutator) {
  const db = readDb()
  mutator(db)
  const tempFile = `${dataFile}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8')
  fs.renameSync(tempFile, dataFile)
}

function request(method, targetPath, body, headers = {}) {
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(targetPath, baseUrl), {
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

function delayedJsonRequest(method, targetPath, body, headers = {}) {
  const payload = JSON.stringify(body || {})
  let req
  let finished = false
  const promise = new Promise((resolve, reject) => {
    req = http.request(new URL(targetPath, baseUrl), {
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
    // 先发一个不完整 JSON 字节，让服务端完成锁外鉴权后停在 parseBody；不能只 flush headers，
    // 否则 handler 若恰好在撤权后才启动，旧实现也会 403，测试会假绿。
    req.write(payload.slice(0, 1))
  })
  return {
    promise,
    finish() {
      if (finished) return
      finished = true
      req.end(payload.slice(1))
    }
  }
}

function auth(token) {
  return { Authorization: `Bearer ${token}` }
}

function dataOf(response) {
  return response.body && response.body.data
}

async function waitForServer() {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/healthz')
      if (response.statusCode === 200) return true
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function login(account, password) {
  const response = await request('POST', '/admin/auth/login', { account, password })
  assert.strictEqual(response.statusCode, 200, `${account} 登录失败：${JSON.stringify(response.body)}`)
  return auth(dataOf(response).token)
}

async function waitForStatus(probe, expectedStatus, label) {
  const deadline = Date.now() + 3000
  let latest
  while (Date.now() < deadline) {
    latest = await probe()
    if (latest.statusCode === expectedStatus) return latest
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.strictEqual(latest && latest.statusCode, expectedStatus, `${label} 未被服务端及时读取`)
  return latest
}

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_FILE: dataFile,
      ADMIN_TOKEN_SECRET: 'synthetic-admin-race-secret',
      AUTH_TOKEN_SECRET: 'synthetic-mini-race-secret',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk.toString() })
  server.stderr.on('data', (chunk) => { output += chunk.toString() })

  try {
    assert.ok(await waitForServer(), `测试服务未启动：${output}`)
    const disableAuth = await login('race-disable-admin', 'fake-disable-pass-123')
    const permissionAuth = await login('race-permission-admin', 'fake-permission-pass-123')
    const passwordAuth = await login('race-password-admin', 'fake-password-admin-pass-123')
    const adminPasswordAuth = await login('race-admin-password-admin', 'fake-admin-password-actor-123')

    // 场景一：请求已通过初验并停在请求体，随后管理员被禁用。
    const disableRace = delayedJsonRequest(
      'POST',
      '/admin/users/U-TARGET-DISABLE/status',
      { action: 'disable' },
      disableAuth
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const beforeDisable = await request('GET', '/admin/auth/me', null, disableAuth)
    assert.strictEqual(beforeDisable.statusCode, 200, '禁用前管理员 token 必须有效')
    atomicMutateDb((db) => {
      db.adminAccounts.find((item) => item.id === 'A-RACE-DISABLE').status = DISABLED
    })
    await waitForStatus(
      () => request('GET', '/admin/auth/me', null, disableAuth),
      403,
      '管理员禁用状态'
    )
    disableRace.finish()
    const disabledResult = await disableRace.promise

    // 场景二：另一请求同样已通过初验，随后超级管理员权限被降为只读权限。
    const permissionRace = delayedJsonRequest(
      'POST',
      '/admin/users/U-TARGET-PERMISSION/status',
      { action: 'disable' },
      permissionAuth
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const beforeDowngrade = await request('GET', '/admin/accounts', null, permissionAuth)
    assert.strictEqual(beforeDowngrade.statusCode, 200, '降权前管理员必须具有超级管理员能力')
    atomicMutateDb((db) => {
      db.adminAccounts.find((item) => item.id === 'A-RACE-PERMISSION').permission = RESTRICTED_PERMISSION
    })
    await waitForStatus(
      () => request('GET', '/admin/accounts', null, permissionAuth),
      403,
      '管理员降权状态'
    )
    permissionRace.finish()
    const permissionResult = await permissionRace.promise

    // 场景三：管理员重置小程序密码会撤销全部旧会话；在途请求同样不能越过管理员停用。
    const passwordRace = delayedJsonRequest(
      'POST',
      '/admin/users/U-TARGET-PASSWORD/password',
      { password: 'synthetic-new-password-123' },
      passwordAuth
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const beforePasswordDisable = await request('GET', '/admin/auth/me', null, passwordAuth)
    assert.strictEqual(beforePasswordDisable.statusCode, 200, '改密竞态管理员停用前 token 必须有效')
    atomicMutateDb((db) => {
      db.adminAccounts.find((item) => item.id === 'A-RACE-PASSWORD').status = DISABLED
    })
    await waitForStatus(
      () => request('GET', '/admin/auth/me', null, passwordAuth),
      403,
      '改密竞态管理员禁用状态'
    )
    passwordRace.finish()
    const passwordResult = await passwordRace.promise

    // 场景四：重置后台账号密码还会联动撤销其绑定小程序用户，必须使用同一 fresh 管理员门禁。
    const adminPasswordRace = delayedJsonRequest(
      'POST',
      '/admin/accounts/A-TARGET-ADMIN/password',
      { password: 'synthetic-new-admin-password-123' },
      adminPasswordAuth
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const beforeAdminPasswordDisable = await request('GET', '/admin/auth/me', null, adminPasswordAuth)
    assert.strictEqual(beforeAdminPasswordDisable.statusCode, 200, '后台改密竞态管理员停用前 token 必须有效')
    atomicMutateDb((db) => {
      db.adminAccounts.find((item) => item.id === 'A-RACE-ADMIN-PASSWORD').status = DISABLED
    })
    await waitForStatus(
      () => request('GET', '/admin/auth/me', null, adminPasswordAuth),
      403,
      '后台改密竞态管理员禁用状态'
    )
    adminPasswordRace.finish()
    const adminPasswordResult = await adminPasswordRace.promise

    const finalDb = readDb()
    const disabledTarget = finalDb.users.find((item) => item.id === 'U-TARGET-DISABLE')
    const permissionTarget = finalDb.users.find((item) => item.id === 'U-TARGET-PERMISSION')
    const passwordTarget = finalDb.users.find((item) => item.id === 'U-TARGET-PASSWORD')
    const linkedAdminTarget = finalDb.users.find((item) => item.id === 'U-TARGET-ADMIN-LINKED')
    const targetAdminAccount = finalDb.adminAccounts.find((item) => item.id === 'A-TARGET-ADMIN')
    const failures = []
    if (disabledResult.statusCode !== 403) {
      failures.push(`管理员已禁用后的在途状态写应为 403，实为 ${disabledResult.statusCode}`)
    }
    if (disabledTarget.status !== ENABLED || disabledTarget.tokenVersion !== 0) {
      failures.push(`管理员已禁用后的目标必须零副作用，实为 status=${disabledTarget.status}, tokenVersion=${disabledTarget.tokenVersion}`)
    }
    if (permissionResult.statusCode !== 403) {
      failures.push(`管理员已降权后的在途状态写应为 403，实为 ${permissionResult.statusCode}`)
    }
    if (permissionTarget.status !== ENABLED || permissionTarget.tokenVersion !== 0) {
      failures.push(`管理员已降权后的目标必须零副作用，实为 status=${permissionTarget.status}, tokenVersion=${permissionTarget.tokenVersion}`)
    }
    if (passwordResult.statusCode !== 403) {
      failures.push(`管理员已禁用后的在途密码重置应为 403，实为 ${passwordResult.statusCode}`)
    }
    if (passwordTarget.tokenVersion !== 0 || passwordTarget.passwordHash) {
      failures.push(`管理员已禁用后的密码重置必须零副作用，实为 tokenVersion=${passwordTarget.tokenVersion}, passwordHash=${passwordTarget.passwordHash ? '存在' : '无'}`)
    }
    if (adminPasswordResult.statusCode !== 403) {
      failures.push(`管理员已禁用后的在途后台密码重置应为 403，实为 ${adminPasswordResult.statusCode}`)
    }
    if (targetAdminAccount.passwordHash || targetAdminAccount.password !== 'fake-original-target-pass-123' || linkedAdminTarget.tokenVersion !== 0 || linkedAdminTarget.passwordHash) {
      failures.push('管理员已禁用后的后台密码重置及绑定小程序改密必须全部零副作用')
    }
    assert.deepStrictEqual(failures, [], failures.join('；'))
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-mini-user-revocation-race-v1-test passed')
}).catch((error) => {
  console.error(`admin-mini-user-revocation-race-v1-test failed: ${error.stack || error.message}`)
  process.exit(1)
})
