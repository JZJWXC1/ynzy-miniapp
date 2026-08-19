const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')

// 小程序登录接入账号密码。锁定：正确密码发 token；错密/缺密/存量无密码/待审核/软删一律不发 token；
// passwordHash 绝不外泄；DB 只存 scrypt 哈希不存明文；后台可为存量/新建账号设初始密码后登录。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-mini-login-pw-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 44600 + Math.floor(Math.random() * 300)
const baseUrl = `http://127.0.0.1:${port}`

const OK_PHONE = '13900000041'
const OK_PASSWORD = 'broker-ok-123'
const ADMIN_PHONE = '13900000009'
const ADMIN_SYNC_PASSWORD = 'admin-mini-sync-123'
const ADMIN_SYNC_PASSWORD_NEXT = 'admin-mini-sync-456'
const LAZY_PHONE = '13900000008'
const LAZY_PASSWORD = 'existing-admin-123'
const AMBIG_PHONE = '13900000007'
const AMBIG_PASSWORD = 'ambiguous-admin-123'
const NOPW_PHONE = '13900000042'
const DEL_PHONE = '13900000043'
const DEL_PASSWORD = 'broker-del-123'
const NEW_PHONE = '13900000044'
const NEW_PASSWORD = 'broker-new-123'
const RESET_PASSWORD = 'broker-reset-456'
const BADHASH_PHONE = '13900000045'
const LINKED_PHONE = '13900000046'
const LINKED_PASSWORD = 'linked-admin-123'
const CHANGED_PASSWORD = 'changed-ok-789'

function seedDb() {
  const db = {
    users: [
      { id: 'U-ADMIN', name: '超管员工', phone: ADMIN_PHONE, isAdmin: true },
      { id: 'U-LAZY', name: '已有后台密码管理员', phone: LAZY_PHONE, isAdmin: true },
      { id: 'U-AMBIG', name: '多重绑定管理员', phone: AMBIG_PHONE, isAdmin: true },
      { id: 'U-OK', name: '已设密中介', phone: OK_PHONE, role: '中介', isAdmin: false, authed: '手机号登录', passwordHash: hashPassword(OK_PASSWORD) },
      { id: 'U-NOPW', name: '存量无密码中介', phone: NOPW_PHONE, role: '中介', isAdmin: false, authed: '手机号登录' },
      { id: 'U-DEL', name: '软删中介', phone: DEL_PHONE, role: '中介', isAdmin: false, deleted: true, status: '已删除', passwordHash: hashPassword(DEL_PASSWORD) },
      // 退化哈希（空 hash 段）：verifyPassword 必须 fail-closed，任意密码都不能登录（防认证绕过地雷）。
      { id: 'U-BADHASH', name: '坏哈希账号', phone: BADHASH_PHONE, role: '中介', isAdmin: false, authed: '手机号登录', passwordHash: 'scrypt$abcsalt$' },
      { id: 'U-LINKED', name: '待绑定员工', phone: LINKED_PHONE, role: '内部员工', isAdmin: false, authed: '手机号登录' }
    ],
    listings: [],
    footprints: [],
    registrationRequests: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'super1', passwordHash: hashPassword('super1pass'), name: '超管', userId: 'U-ADMIN', permission: '全部后台权限', status: '启用' },
      { id: 'A-LAZY', account: 'lazy1', passwordHash: hashPassword(LAZY_PASSWORD), name: '已有后台密码管理员', userId: 'U-LAZY', permission: '区域查看权限', status: '启用' },
      { id: 'A-AMBIG-1', account: 'ambig1', passwordHash: hashPassword(AMBIG_PASSWORD), name: '多重绑定一', userId: 'U-AMBIG', permission: '区域查看权限', status: '启用' },
      { id: 'A-AMBIG-2', account: 'ambig2', passwordHash: hashPassword('ambiguous-admin-456'), name: '多重绑定二', userId: 'U-AMBIG', permission: '区域查看权限', status: '启用' },
      { id: 'A-UNLINKED', account: 'unlinked1', password: 'unlinked-pass-1', name: '未绑定管理账号', permission: '区域查看权限', status: '启用' }
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

function dataOf(response) {
  return response.body && response.body.data
}

function hasToken(response) {
  return Boolean(dataOf(response) && dataOf(response).token)
}

function readDb() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^﻿/, ''))
}

async function login(phone, password) {
  return request('POST', '/mini/auth/login', { phone, password })
}

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: 'mini-login-pw-secret',
      ADMIN_TOKEN_SECRET: 'mini-login-pw-admin',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (c) => { output += c.toString() })
  server.stderr.on('data', (c) => { output += c.toString() })

  try {
    assert.ok(await waitForServer(), `mini 登录密码测试服务未启动：${output}`)

    // 1. 正确手机号+密码 → 200 + token + 未来过期时间 + 不带 passwordHash
    const ok = await login(OK_PHONE, OK_PASSWORD)
    assert.strictEqual(ok.statusCode, 200, `正确密码应登录成功：${JSON.stringify(ok.body)}`)
    assert.ok(hasToken(ok), '正确密码必须签发 token')
    assert.ok(dataOf(ok).tokenExpiresAt > Date.now(), 'token 必须带未来过期时间')
    assert.strictEqual(dataOf(ok).passwordHash, undefined, '登录响应绝不能带出 passwordHash')
    assert.strictEqual(dataOf(ok).password, undefined, '登录响应绝不能带出 password')
    const okAuth = { Authorization: `Bearer ${dataOf(ok).token}` }

    // 2. 错误密码 → 403、不发 token
    const wrong = await login(OK_PHONE, 'wrong-pass-999')
    assert.strictEqual(wrong.statusCode, 403, '错误密码应 403')
    assert.ok(!hasToken(wrong), '错误密码绝不能发 token')

    // 3. 缺密码 → 400
    const noPass = await request('POST', '/mini/auth/login', { phone: OK_PHONE })
    assert.strictEqual(noPass.statusCode, 400, '缺密码应 400')
    assert.ok(!hasToken(noPass), '缺密码绝不能发 token')

    // 4. 存量无密码账号（即便给密码）→ 403 引导联系管理员、不发 token（fail-closed）
    const nopw = await login(NOPW_PHONE, 'anything-123')
    assert.strictEqual(nopw.statusCode, 403, '无密码存量账号应 fail-closed 禁登（403）')
    assert.ok(!hasToken(nopw), '无密码存量账号绝不能发 token')
    assert.ok(/设置登录密码|重置|联系管理员/.test(JSON.stringify(nopw.body)), '应提示联系管理员设/重置密码')

    // 5. 注册新号 → 403 待审核不发 token；随后登录该号（未进 db.users）→ 403 不发 token
    const reg = await request('POST', '/mini/auth/register', { name: '新申请人', phone: NEW_PHONE, password: NEW_PASSWORD })
    assert.strictEqual(reg.statusCode, 403, '新注册应待审核（403）')
    assert.ok(!hasToken(reg), '待审核注册绝不能发 token')
    const pendingLogin = await login(NEW_PHONE, NEW_PASSWORD)
    assert.strictEqual(pendingLogin.statusCode, 403, '待审核/未开通账号即便密码正确也不能登录')
    assert.ok(!hasToken(pendingLogin), '待审核账号绝不能发 token')

    // 6. 软删账号（正确密码）→ 403、不发 token
    const del = await login(DEL_PHONE, DEL_PASSWORD)
    assert.strictEqual(del.statusCode, 403, '软删账号即便密码正确也不能登录')
    assert.ok(!hasToken(del), '软删账号绝不能发 token')

    // 6b. 退化哈希（scrypt$salt$ 空 hash 段）账号：任意密码都 fail-closed 拒登，杜绝认证绕过地雷
    const badHash1 = await login(BADHASH_PHONE, 'whatever-pass-1')
    assert.strictEqual(badHash1.statusCode, 403, '空 hash 段账号用任意密码都应 403')
    assert.ok(!hasToken(badHash1), '空 hash 段账号绝不能发 token')
    const badHash2 = await login(BADHASH_PHONE, '')
    assert.strictEqual(badHash2.statusCode, 400, '空密码仍先按缺密码 400')

    // 7. /mini/auth/me 不带 passwordHash
    const me = await request('GET', '/mini/auth/me', null, okAuth)
    assert.strictEqual(me.statusCode, 200, '有效 token 应能取 me')
    assert.strictEqual(dataOf(me).id, 'U-OK', 'me 应解析出真实用户')
    assert.strictEqual(dataOf(me).passwordHash, undefined, '/mini/auth/me 绝不能带出 passwordHash')

    // 8. /mini/profile.user 不带 passwordHash
    const profile = await request('GET', '/mini/profile', null, okAuth)
    assert.strictEqual(profile.statusCode, 200, '有效 token 应能取 profile')
    assert.ok(dataOf(profile).user, 'profile 应含 user')
    assert.strictEqual(dataOf(profile).user.passwordHash, undefined, '/mini/profile.user 绝不能带出 passwordHash')

    // 9. DB 只存 scrypt 哈希、不存任何明文密码
    const db = readDb()
    const pendingReq = (db.registrationRequests || []).find((r) => r.phone === NEW_PHONE)
    assert.ok(pendingReq, '新注册应落待审核申请')
    assert.ok(/^scrypt\$/.test(String(pendingReq.passwordHash || '')), '注册申请应存 scrypt 哈希')
    const dumped = JSON.stringify(db)
    assert.ok(!dumped.includes(NEW_PASSWORD), 'DB 不得出现注册明文密码')
    assert.ok(!dumped.includes(OK_PASSWORD), 'DB 不得出现已设密明文密码')

    // 10. 后台鉴权 + 脱敏 + 为存量无密码账号设初始密码后可登录
    const superLogin = await request('POST', '/admin/auth/login', { account: 'super1', password: 'super1pass' })
    assert.strictEqual(superLogin.statusCode, 200, '超管应能登录')
    const superAuth = { Authorization: `Bearer ${dataOf(superLogin).token}` }
    const usersResp = await request('GET', '/admin/users', null, superAuth)
    assert.strictEqual(usersResp.statusCode, 200, '/admin/users 应 200')
    const rows = dataOf(usersResp).users || []
    rows.forEach((r) => assert.strictEqual(r.passwordHash, undefined, '/admin/users 绝不能带出 passwordHash'))
    const okRow = rows.find((r) => r.phone === OK_PHONE)
    const nopwRow = rows.find((r) => r.phone === NOPW_PHONE)
    assert.strictEqual(okRow.hasPassword, true, '已设密账号 hasPassword 应为 true')
    assert.strictEqual(nopwRow.hasPassword, false, '无密码账号 hasPassword 应为 false')

    // 10a. 已经在旧版本完成后台改密的唯一绑定账号：第一次用现有后台密码登录时安全回填，无需再重置。
    const lazyLogin = await login(LAZY_PHONE, LAZY_PASSWORD)
    assert.strictEqual(lazyLogin.statusCode, 200, '唯一绑定账号应可用已有后台密码首次登录小程序并完成安全回填')
    assert.ok(hasToken(lazyLogin), '安全回填后必须签发小程序 token')
    const lazyDb = readDb()
    const lazyAccount = lazyDb.adminAccounts.find((item) => item.id === 'A-LAZY')
    const lazyUser = lazyDb.users.find((item) => item.id === 'U-LAZY')
    assert.strictEqual(lazyUser.passwordHash, lazyAccount.passwordHash, '惰性回填必须复用唯一绑定管理账号的服务端哈希')
    assert.ok(Number(lazyUser.tokenVersion || 0) >= 1, '惰性回填必须撤销可能存在的旧小程序会话')

    const ambiguousLogin = await login(AMBIG_PHONE, AMBIG_PASSWORD)
    assert.strictEqual(ambiguousLogin.statusCode, 403, '同一用户绑定多个管理账号时必须拒绝猜测使用哪个密码')
    const ambiguousUser = readDb().users.find((item) => item.id === 'U-AMBIG')
    assert.strictEqual(ambiguousUser.passwordHash, undefined, '多重绑定失败不得回填任意管理账号密码')

    // 10b. 管理账号按服务端 userId 绑定同步小程序密码；不按账号文本或手机号猜测。
    const adminNoPwLogin = await login(ADMIN_PHONE, ADMIN_SYNC_PASSWORD)
    assert.strictEqual(adminNoPwLogin.statusCode, 403, '修复前绑定管理员用户没有小程序密码时应 fail-closed')
    const resetLinkedAdmin = await request('POST', '/admin/accounts/A-SUPER/password', { password: ADMIN_SYNC_PASSWORD }, superAuth)
    assert.strictEqual(resetLinkedAdmin.statusCode, 200, '管理账号改密应成功')
    assert.strictEqual(dataOf(resetLinkedAdmin).miniLoginSynced, true, '绑定管理账号改密必须同步小程序登录密码')
    assert.strictEqual(JSON.stringify(resetLinkedAdmin.body).includes('passwordHash'), false, '管理账号改密响应不得泄露密码哈希')
    const adminMiniLogin = await login(ADMIN_PHONE, ADMIN_SYNC_PASSWORD)
    assert.strictEqual(adminMiniLogin.statusCode, 200, '绑定管理账号改密后应可用同一新密码登录小程序')
    assert.ok(hasToken(adminMiniLogin), '绑定管理员小程序登录必须签发 token')
    const adminMiniAuth = { Authorization: `Bearer ${dataOf(adminMiniLogin).token}` }
    const oldAdminWebLogin = await request('POST', '/admin/auth/login', { account: 'super1', password: 'super1pass' })
    assert.strictEqual(oldAdminWebLogin.statusCode, 403, '管理账号改密后后台旧密码必须失效')
    const newAdminWebLogin = await request('POST', '/admin/auth/login', { account: 'super1', password: ADMIN_SYNC_PASSWORD })
    assert.strictEqual(newAdminWebLogin.statusCode, 200, '管理账号改密后后台新密码应生效')
    const newSuperAuth = { Authorization: `Bearer ${dataOf(newAdminWebLogin).token}` }

    const resetLinkedAgain = await request('POST', '/admin/accounts/A-SUPER/password', { password: ADMIN_SYNC_PASSWORD_NEXT }, newSuperAuth)
    assert.strictEqual(resetLinkedAgain.statusCode, 200, '绑定管理账号再次改密应成功')
    assert.strictEqual(dataOf(resetLinkedAgain).miniLoginSynced, true, '再次改密仍必须同步小程序密码')
    const staleAdminMiniSession = await request('GET', '/mini/auth/me', null, adminMiniAuth)
    assert.strictEqual(staleAdminMiniSession.statusCode, 401, '后台同步改密后必须撤销该用户全部旧小程序会话')
    const oldAdminMiniLogin = await login(ADMIN_PHONE, ADMIN_SYNC_PASSWORD)
    assert.strictEqual(oldAdminMiniLogin.statusCode, 403, '后台再次改密后小程序旧密码必须失效')
    const nextAdminMiniLogin = await login(ADMIN_PHONE, ADMIN_SYNC_PASSWORD_NEXT)
    assert.strictEqual(nextAdminMiniLogin.statusCode, 200, '后台再次改密后小程序新密码应生效')

    const linkedDb = readDb()
    const linkedAdminAccount = linkedDb.adminAccounts.find((item) => item.id === 'A-SUPER')
    const linkedAdminUser = linkedDb.users.find((item) => item.id === 'U-ADMIN')
    assert.ok(/^scrypt\$/.test(String(linkedAdminAccount.passwordHash || '')), '后台管理账号必须只存 scrypt 哈希')
    assert.strictEqual(linkedAdminUser.passwordHash, linkedAdminAccount.passwordHash, '绑定账号与小程序用户应保存同一轮服务端哈希')
    assert.ok(Number(linkedAdminUser.tokenVersion || 0) >= 2, '每次后台同步改密都必须提升小程序 tokenVersion')
    assert.strictEqual(JSON.stringify(linkedDb).includes(ADMIN_SYNC_PASSWORD_NEXT), false, '数据库不得保存同步密码明文')

    // 10c. 未绑定管理账号只改后台密码，不得按账号文本猜测或改写任意小程序用户。
    const usersBeforeUnlinkedReset = readDb().users.map((item) => ({ id: item.id, passwordHash: item.passwordHash || '', tokenVersion: item.tokenVersion || 0 }))
    const resetUnlinkedAdmin = await request('POST', '/admin/accounts/A-UNLINKED/password', { password: 'unlinked-pass-2' }, newSuperAuth)
    assert.strictEqual(resetUnlinkedAdmin.statusCode, 200, '未绑定管理账号仍应允许更新后台密码')
    assert.strictEqual(dataOf(resetUnlinkedAdmin).miniLoginSynced, false, '未绑定管理账号必须明确返回未同步小程序')
    const usersAfterUnlinkedReset = readDb().users.map((item) => ({ id: item.id, passwordHash: item.passwordHash || '', tokenVersion: item.tokenVersion || 0 }))
    assert.deepStrictEqual(usersAfterUnlinkedReset, usersBeforeUnlinkedReset, '未绑定管理账号改密不得改写任何小程序用户')

    // 10d. 新建管理账号时若显式绑定 userId，初始密码也应同步；未绑定时仍保持分离。
    const linkedNoPwLogin = await login(LINKED_PHONE, LINKED_PASSWORD)
    assert.strictEqual(linkedNoPwLogin.statusCode, 403, '绑定前员工没有小程序密码时应 fail-closed')
    const createLinkedAdmin = await request('POST', '/admin/accounts', {
      account: 'linkedstaff',
      password: LINKED_PASSWORD,
      name: '绑定员工后台账号',
      userId: 'U-LINKED',
      permission: '区域查看权限'
    }, newSuperAuth)
    assert.strictEqual(createLinkedAdmin.statusCode, 200, '显式绑定用户的新管理账号应创建成功')
    assert.strictEqual(dataOf(createLinkedAdmin).miniLoginSynced, true, '新建已绑定管理账号必须同步小程序初始密码')
    const linkedLoginAfterCreate = await login(LINKED_PHONE, LINKED_PASSWORD)
    assert.strictEqual(linkedLoginAfterCreate.statusCode, 200, '新建绑定管理账号后应可用同一密码登录小程序')
    assert.strictEqual(JSON.stringify(createLinkedAdmin.body).includes('passwordHash'), false, '新建管理账号响应不得泄露密码哈希')

    const setPw = await request('POST', '/admin/users/U-NOPW/password', { password: RESET_PASSWORD }, superAuth)
    assert.strictEqual(setPw.statusCode, 200, '超管为存量账号设初始密码应 200')
    const nopwLoginAfter = await login(NOPW_PHONE, RESET_PASSWORD)
    assert.strictEqual(nopwLoginAfter.statusCode, 200, '设初始密码后存量账号应能登录')
    assert.ok(hasToken(nopwLoginAfter), '设初始密码后登录应发 token')
    assert.strictEqual(dataOf(nopwLoginAfter).passwordHash, undefined, '设密后登录响应仍不得带 passwordHash')

    // 11. 登录后自助修改密码（userId 由 token 解析，不信任客户端身份）
    // 无 token → 401
    const changeNoAuth = await request('POST', '/mini/auth/password', { oldPassword: OK_PASSWORD, newPassword: CHANGED_PASSWORD })
    assert.strictEqual(changeNoAuth.statusCode, 401, '未登录改密必须 401')
    // 错误原密码 → 403
    const changeWrongOld = await request('POST', '/mini/auth/password', { oldPassword: 'wrong-old-999', newPassword: CHANGED_PASSWORD }, okAuth)
    assert.strictEqual(changeWrongOld.statusCode, 403, '原密码错误改密必须 403')
    // 弱新密码 → 400
    const changeWeak = await request('POST', '/mini/auth/password', { oldPassword: OK_PASSWORD, newPassword: '123' }, okAuth)
    assert.strictEqual(changeWeak.statusCode, 400, '弱新密码必须 400')
    // 新旧相同 → 400
    const changeSame = await request('POST', '/mini/auth/password', { oldPassword: OK_PASSWORD, newPassword: OK_PASSWORD }, okAuth)
    assert.strictEqual(changeSame.statusCode, 400, '新密码与原密码相同必须 400')
    // 正确改密 → 200，响应不带 passwordHash
    const changeOk = await request('POST', '/mini/auth/password', { oldPassword: OK_PASSWORD, newPassword: CHANGED_PASSWORD }, okAuth)
    assert.strictEqual(changeOk.statusCode, 200, '正确原密码改密应 200')
    assert.strictEqual(dataOf(changeOk).passwordHash, undefined, '改密响应不得带 passwordHash')
    // 旧密码失效、新密码可登
    const oldLoginAfterChange = await login(OK_PHONE, OK_PASSWORD)
    assert.strictEqual(oldLoginAfterChange.statusCode, 403, '改密后旧密码不能再登录')
    const newLoginAfterChange = await login(OK_PHONE, CHANGED_PASSWORD)
    assert.strictEqual(newLoginAfterChange.statusCode, 200, '改密后新密码可登录')

    const adminWebSource = fs.readFileSync(path.join(serverDir, '..', 'admin-web', 'index.html'), 'utf8')
    assert.ok(adminWebSource.includes('miniLoginSynced'), '后台改密 UI 必须按服务端同步结果提示')
    assert.ok(adminWebSource.includes('小程序登录密码已同步'), '绑定账号应明确提示小程序密码已同步')
    assert.ok(adminWebSource.includes('未绑定小程序用户'), '未绑定账号应明确提示没有同步小程序密码')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('mini-login-password-v1-test passed')
}).catch((error) => {
  console.error(`mini-login-password-v1-test failed: ${error.message}`)
  process.exit(1)
})
