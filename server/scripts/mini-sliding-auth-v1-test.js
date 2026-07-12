'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')

const DAY_MS = 24 * 60 * 60 * 1000
const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-mini-sliding-auth-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 45300 + Math.floor(Math.random() * 300)
const baseUrl = `http://127.0.0.1:${port}`
const authSecret = 'mini-sliding-auth-test-secret'
const brokerPassword = 'broker-pass-123'
const victimPassword = 'victim-pass-123'
const racePassword = 'race-pass-123'

function seedDb() {
  fs.writeFileSync(dataFile, JSON.stringify({
    users: [
      { id: 'U-ADMIN', name: '合成管理员', phone: '13900000200', isAdmin: true },
      { id: 'U-BROKER', name: '合成中介甲', phone: '13900000201', role: '中介', authed: '手机号登录', passwordHash: hashPassword(brokerPassword), tokenVersion: 0 },
      { id: 'U-VICTIM', name: '合成中介乙', phone: '13900000202', role: '中介', authed: '手机号登录', passwordHash: hashPassword(victimPassword), tokenVersion: 0 },
      { id: 'U-RACE', name: '合成竞态账号', phone: '13900000203', role: '中介', authed: '手机号登录', passwordHash: hashPassword(racePassword), tokenVersion: 0 },
      { id: 'U-DISABLED', name: '合成停用账号', phone: '13900000204', role: '中介', status: '禁用', brokerStatus: '禁用', passwordHash: hashPassword('disabled-pass-123'), tokenVersion: 3 },
      { id: 'U-DELETED', name: '合成删除账号', phone: '13900000205', role: '中介', status: '已删除', deleted: true, passwordHash: hashPassword('deleted-pass-123'), tokenVersion: 4 }
    ],
    listings: [],
    rentalNeeds: [],
    footprints: [],
    registrationRequests: [],
    adminAccounts: [
      {
        id: 'A-SUPER',
        account: 'sliding-super',
        password: 'sliding-super-pass',
        name: '合成超级管理员',
        userId: 'U-ADMIN',
        permission: '全部后台权限',
        status: '启用'
      }
    ]
  }, null, 2), 'utf8')
}

function signMiniToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function tokenPayload(token) {
  return JSON.parse(Buffer.from(String(token || '').split('.')[0], 'base64url').toString('utf8'))
}

function auth(token) {
  return { Authorization: `Bearer ${token}` }
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
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function rawJsonRequest(method, targetPath, payload, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const rawPayload = String(payload || '')
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawPayload),
        ...headers
      }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let parsed = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch (error) { parsed = { raw } }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed })
      })
    })
    req.on('error', reject)
    req.end(rawPayload)
  })
}

function delayedJsonRequest(method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = JSON.stringify(body || {})
  let req
  let finished = false
  const promise = new Promise((resolve, reject) => {
    req = http.request(url, {
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
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed })
      })
    })
    req.on('error', reject)
    // 先发一个不完整 JSON 字节，确保服务端已完成锁外初验并停在 parseBody；只 flush headers
    // 无法证明 handler 已启动，撤销发生得太早时旧实现也会 401，导致竞态测试假绿。
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

function dataOf(response) {
  return response.body && response.body.data
}

function readDb() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'))
}

function writeDb(db) {
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')
}

async function waitForServer() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 12000) {
    try {
      const response = await request('GET', '/healthz')
      if (response.statusCode === 200) return true
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return false
}

async function login(phone, password) {
  return request('POST', '/mini/auth/login', { phone, password })
}

function assertNoRefresh(response, label) {
  assert.ok(!response.headers['x-auth-token'], `${label} 不得下发续签 token`)
  assert.ok(!response.headers['x-auth-token-expires-at'], `${label} 不得下发续签过期时间`)
}

function assertAuthNoStore(response, label) {
  assert.strictEqual(response.headers['cache-control'], 'no-store', `${label} 必须禁止缓存`)
  assert.ok(String(response.headers.vary || '').toLowerCase().includes('authorization'), `${label} 必须按 Authorization 区分缓存`)
}

function assertThirtyDays(expiresAt, startedAt, label) {
  const ttl = Number(expiresAt) - startedAt
  assert.ok(ttl >= 30 * DAY_MS - 5000 && ttl <= 30 * DAY_MS + 5000, `${label} 必须约为服务端当前时间后 30 天，实际 ${ttl}ms`)
}

function assertIsolatedUploadPolicy(response, injectedKey, expectedPrefix, label) {
  assert.strictEqual(response.statusCode, 200, `${label} 策略接口必须成功`)
  const policyResult = dataOf(response)
  assert.ok(policyResult && String(policyResult.objectKey || '').startsWith(`${expectedPrefix}/`), `${label} 必须由服务端生成目录内对象键`)
  assert.notStrictEqual(policyResult.objectKey, injectedKey, `${label} 必须忽略客户端指定的已知对象键`)
  const decoded = JSON.parse(Buffer.from(policyResult.formData.policy, 'base64').toString('utf8'))
  const conditions = decoded.conditions || []
  assert.ok(
    conditions.some((condition) => condition && !Array.isArray(condition) && condition.key === policyResult.objectKey),
    `${label} policy 必须精确绑定服务端生成的对象键`
  )
  assert.ok(
    !conditions.some((condition) => Array.isArray(condition) && condition[0] === 'starts-with' && condition[1] === '$key'),
    `${label} policy 不得允许客户端把 key 改成同目录任意已有对象`
  )
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
      AUTH_TOKEN_SECRET: authSecret,
      ADMIN_TOKEN_SECRET: 'mini-sliding-admin-test-secret',
      V1_DISABLE_LEGACY_ROUTES: '0',
      ALI_OSS_BUCKET: 'synthetic-test-bucket',
      ALI_OSS_REGION: 'oss-cn-hangzhou',
      ALI_OSS_ACCESS_KEY_ID: 'synthetic-test-access-key',
      ALI_OSS_ACCESS_KEY_SECRET: 'synthetic-test-access-secret',
      ALI_OSS_PUBLIC_BASE_URL: 'https://synthetic-test-bucket.example.test'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  let stderr = ''
  server.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  try {
    assert.ok(await waitForServer(), `测试服务未启动：${stderr}`)

    // 1. 新登录固定签发 30 天 token，载荷只含服务端身份、到期和撤销版本。
    const loginStartedAt = Date.now()
    const brokerA = await login('13900000201', brokerPassword)
    const brokerB = await login('13900000201', brokerPassword)
    assert.strictEqual(brokerA.statusCode, 200)
    assert.strictEqual(brokerB.statusCode, 200)
    assertThirtyDays(dataOf(brokerA).tokenExpiresAt, loginStartedAt, '登录 token')
    const loginPayload = tokenPayload(dataOf(brokerA).token)
    assert.deepStrictEqual(Object.keys(loginPayload).sort(), ['exp', 'tokenVersion', 'userId'])
    assert.strictEqual(loginPayload.userId, 'U-BROKER')
    assert.strictEqual(loginPayload.tokenVersion, 0)

    const policyCases = [
      ['/mini/uploads/video-policy', 'house-videos/known-victim.mp4', 'house-videos', '视频上传'],
      ['/mini/uploads/group-screenshot-policy', 'group-screenshots/known-victim.jpg', 'group-screenshots', '群截图上传'],
      ['/mini/uploads/showing-photo-policy', 'showing-photos/known-victim.jpg', 'showing-photos', '带看照片上传']
    ]
    for (const [endpoint, injectedKey, prefix, label] of policyCases) {
      const policyResponse = await request('POST', endpoint, {
        objectKey: injectedKey,
        fileName: label.includes('视频') ? 'synthetic-upload.mp4' : 'synthetic-upload.jpg',
        mimeType: label.includes('视频') ? 'video/mp4' : 'image/jpeg',
        size: 1024
      }, auth(dataOf(brokerA).token))
      assertIsolatedUploadPolicy(policyResponse, injectedKey, prefix, label)
    }

    const wrongLogin = await login('13900000201', 'wrong-password-value')
    assert.strictEqual(wrongLogin.statusCode, 403)
    assertAuthNoStore(wrongLogin, '错密登录响应')

    const wrongPasswordChange = await request('POST', '/mini/auth/password', {
      oldPassword: 'wrong-password-value',
      newPassword: 'unused-new-password-123'
    }, auth(dataOf(brokerA).token))
    assert.strictEqual(wrongPasswordChange.statusCode, 403)
    assertAuthNoStore(wrongPasswordChange, '改密失败响应')

    const invalidLogout = await request('POST', '/mini/auth/logout', {}, auth('invalid.token'))
    assert.strictEqual(invalidLogout.statusCode, 401)
    assertAuthNoStore(invalidLogout, '无效退出响应')

    const malformedLogin = await rawJsonRequest('POST', '/mini/auth/login', '{"phone":')
    assert.strictEqual(malformedLogin.statusCode, 400)
    assertAuthNoStore(malformedLogin, '登录畸形 JSON 响应')

    const invalidProtectedRead = await request('GET', '/mini/profile', null, auth('invalid.token'))
    assert.strictEqual(invalidProtectedRead.statusCode, 401)
    assertAuthNoStore(invalidProtectedRead, '无效 token 受保护接口响应')

    // 2. 兼容存量短期/无 tokenVersion token；有效活动响应必须滑动到 30 天并带防缓存头。
    const legacyToken = signMiniToken({ userId: 'U-BROKER', exp: Date.now() + 60 * 60 * 1000 })
    const refreshStartedAt = Date.now()
    const refreshed = await request('GET', '/mini/auth/me', null, auth(legacyToken))
    assert.strictEqual(refreshed.statusCode, 200)
    const refreshedToken = refreshed.headers['x-auth-token']
    const refreshedExpiresAt = Number(refreshed.headers['x-auth-token-expires-at'])
    assert.ok(refreshedToken, '有效登录活动必须通过响应头下发续签 token')
    assertThirtyDays(refreshedExpiresAt, refreshStartedAt, '滑动续签 token')
    const refreshedPayload = tokenPayload(refreshedToken)
    assert.strictEqual(refreshedPayload.userId, 'U-BROKER')
    assert.strictEqual(refreshedPayload.tokenVersion, 0)
    assert.strictEqual(refreshedPayload.exp, refreshedExpiresAt)
    assert.strictEqual(refreshed.headers['cache-control'], 'no-store')
    assert.ok(String(refreshed.headers.vary || '').toLowerCase().includes('authorization'))
    const exposed = String(refreshed.headers['access-control-expose-headers'] || '').toLowerCase()
    assert.ok(exposed.includes('x-auth-token') && exposed.includes('x-auth-token-expires-at'), '跨域响应必须暴露续签头')

    // 3. 游客、无效/停用/删除 token 和错误响应一律不续签。
    const guest = await request('GET', '/mini/home/listings')
    assert.strictEqual(guest.statusCode, 200)
    assertNoRefresh(guest, '游客响应')

    const invalid = await request('GET', '/mini/auth/me', null, auth('invalid.token'))
    assert.strictEqual(invalid.statusCode, 401)
    assertNoRefresh(invalid, '无效 token 响应')

    const disabledToken = signMiniToken({ userId: 'U-DISABLED', exp: Date.now() + DAY_MS, tokenVersion: 3 })
    const disabled = await request('GET', '/mini/auth/me', null, auth(disabledToken))
    assert.strictEqual(disabled.statusCode, 401)
    assertNoRefresh(disabled, '停用账号响应')

    const deletedToken = signMiniToken({ userId: 'U-DELETED', exp: Date.now() + DAY_MS, tokenVersion: 4 })
    const deleted = await request('GET', '/mini/auth/me', null, auth(deletedToken))
    assert.strictEqual(deleted.statusCode, 401)
    assertNoRefresh(deleted, '删除账号响应')

    const authenticated404 = await request('GET', '/mini/not-found', null, auth(dataOf(brokerA).token))
    assert.strictEqual(authenticated404.statusCode, 404)
    assertNoRefresh(authenticated404, '业务错误响应')

    // 4. 主动退出只信 Authorization 身份，并撤销该账号所有设备；伪造 body 不能踢掉他人。
    const victimToken = signMiniToken({ userId: 'U-VICTIM', exp: Date.now() + DAY_MS, tokenVersion: 0 })
    const loggedOut = await request('POST', '/mini/auth/logout', {
      userId: 'U-VICTIM',
      tokenVersion: 999,
      role: '超级管理员',
      permission: '全部权限'
    }, auth(dataOf(brokerA).token))
    assert.strictEqual(loggedOut.statusCode, 200)
    assert.deepStrictEqual(dataOf(loggedOut), { loggedOut: true, scope: 'all-devices' })
    assertNoRefresh(loggedOut, '退出响应')
    assert.strictEqual(readDb().users.find((item) => item.id === 'U-BROKER').tokenVersion, 1)
    assert.strictEqual(readDb().users.find((item) => item.id === 'U-VICTIM').tokenVersion, 0)

    for (const token of [dataOf(brokerA).token, dataOf(brokerB).token, refreshedToken, legacyToken]) {
      const response = await request('GET', '/mini/auth/me', null, auth(token))
      assert.strictEqual(response.statusCode, 401, '退出后该账号全部旧 token 必须立即失效')
    }
    const victimMe = await request('GET', '/mini/auth/me', null, auth(victimToken))
    assert.strictEqual(victimMe.statusCode, 200, '客户端伪造 userId 不得撤销其他账号')

    // 5. 管理员停用/恢复必须提升并保留版本，旧 token 不得在恢复后复活；删除同样立即撤销。
    const brokerAfterLogout = await login('13900000201', brokerPassword)
    assert.strictEqual(brokerAfterLogout.statusCode, 200)
    assert.strictEqual(tokenPayload(dataOf(brokerAfterLogout).token).tokenVersion, 1)
    const adminLogin = await request('POST', '/admin/auth/login', { account: 'sliding-super', password: 'sliding-super-pass' })
    assert.strictEqual(adminLogin.statusCode, 200)
    const adminAuth = auth(dataOf(adminLogin).token)

    const disabledByAdmin = await request('POST', '/admin/users/U-BROKER/status', {
      action: 'disable',
      userId: 'U-VICTIM',
      permission: '全部权限'
    }, adminAuth)
    assert.strictEqual(disabledByAdmin.statusCode, 200)
    let brokerRow = readDb().users.find((item) => item.id === 'U-BROKER')
    assert.strictEqual(brokerRow.status, '禁用')
    assert.strictEqual(brokerRow.tokenVersion, 2)
    const afterDisable = await request('GET', '/mini/auth/me', null, auth(dataOf(brokerAfterLogout).token))
    assert.strictEqual(afterDisable.statusCode, 401)
    assert.strictEqual((await login('13900000201', brokerPassword)).statusCode, 403)

    const disabledAgain = await request('POST', '/admin/users/U-BROKER/status', { action: 'disable' }, adminAuth)
    assert.strictEqual(disabledAgain.statusCode, 200)
    assert.strictEqual(readDb().users.find((item) => item.id === 'U-BROKER').tokenVersion, 2, '幂等重复停用不能重复提升版本')

    const enabled = await request('POST', '/admin/users/U-BROKER/status', { action: 'enable' }, adminAuth)
    assert.strictEqual(enabled.statusCode, 200)
    brokerRow = readDb().users.find((item) => item.id === 'U-BROKER')
    assert.strictEqual(brokerRow.status, '启用')
    assert.strictEqual(brokerRow.tokenVersion, 2, '恢复账号不能回退撤销版本')
    assert.strictEqual((await request('GET', '/mini/auth/me', null, auth(dataOf(brokerAfterLogout).token))).statusCode, 401, '恢复后旧 token 不能复活')
    const brokerAfterEnable = await login('13900000201', brokerPassword)
    assert.strictEqual(brokerAfterEnable.statusCode, 200)
    assert.strictEqual(tokenPayload(dataOf(brokerAfterEnable).token).tokenVersion, 2)

    const removed = await request('DELETE', '/admin/users/U-BROKER', null, adminAuth)
    assert.strictEqual(removed.statusCode, 200)
    brokerRow = readDb().users.find((item) => item.id === 'U-BROKER')
    assert.strictEqual(brokerRow.deleted, true)
    assert.strictEqual(brokerRow.tokenVersion, 3, '软删必须提升版本防止未来恢复时旧 token 复活')
    assert.strictEqual((await request('GET', '/mini/auth/me', null, auth(dataOf(brokerAfterEnable).token))).statusCode, 401)
    assert.strictEqual((await login('13900000201', brokerPassword)).statusCode, 403)

    // 6. 在途写请求通过锁外初验后才发生撤销：写锁内必须基于 fresh DB 重验，且零副作用。
    const raceToken = signMiniToken({ userId: 'U-RACE', exp: Date.now() + DAY_MS, tokenVersion: 0 })
    const delayed = delayedJsonRequest('POST', '/mini/rental-needs', { rawText: '合成竞态需求' }, auth(raceToken))
    await new Promise((resolve) => setTimeout(resolve, 250))
    const racedDb = readDb()
    racedDb.users.find((item) => item.id === 'U-RACE').tokenVersion = 1
    writeDb(racedDb)
    delayed.finish()
    const racedResponse = await delayed.promise
    assert.strictEqual(racedResponse.statusCode, 401, '撤销后仍在途的旧 token 写请求必须在事务内被拒绝')
    assert.strictEqual((readDb().rentalNeeds || []).length, 0, '撤销后的在途请求不得产生数据库副作用')

    // 7. 源码合同：所有登录态数据库写统一走 fresh 验签 helper，不能继续捕获锁外 userId。
    const indexSource = fs.readFileSync(path.join(serverDir, 'src', 'index.js'), 'utf8')
    assert.ok(/function updateMiniDb\(req,\s*mutator\)/.test(indexSource), '必须提供登录态写事务统一 fresh 验签 helper')
    assert.ok(!/dbStore\.updateDb\(\(nextDb\) => domain\.createRentalNeed\(nextDb, userId, body\)\)/.test(indexSource), '需求写入不得继续使用锁外 userId')
    assert.ok(!/dbStore\.updateDb\(\(nextDb\) => domain\.addNormalListing\(nextDb, userId, body\)\)/.test(indexSource), '房源写入不得继续使用锁外 userId')
    assert.ok(!/dbStore\.updateDb\(\(nextDb\) => domain\.addSensitiveFootprint\(nextDb, userId/.test(indexSource), '敏感查看写入不得继续使用锁外 userId')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('mini-sliding-auth-v1-test passed')
}).catch((error) => {
  console.error(`mini-sliding-auth-v1-test failed: ${error.stack || error.message}`)
  process.exit(1)
})
