const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

// 需求2：账号管理支持删除（软删归档）。红线：不能删当前登录账号、不能删到零个可用超管、留痕。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-acct-delete-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 42000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`

function seedDb() {
  const db = {
    users: [{ id: 'U1', name: '超管员工', phone: '13900000001', isAdmin: true }],
    listings: [],
    footprints: [],
    adminAccounts: [
      { id: 'A-SUPER1', account: 'super1', password: 'super1pass', name: '超管一', userId: 'U1', permission: '全部后台权限', status: '启用' },
      { id: 'A-SUPER2', account: 'super2', password: 'super2pass', name: '超管二', userId: 'U1', permission: '全部后台权限', status: '启用' },
      { id: 'A-REST', account: 'restadmin', password: 'restpass1', name: '区域', userId: 'U1', permission: '区域查看权限', status: '启用' },
      { id: 'A-VICTIM', account: 'victim', password: 'victimpass', name: '待删', userId: 'U1', permission: '后台查看权限', status: '启用' }
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
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN_SECRET: 'acct-delete-secret', AUTH_TOKEN_SECRET: 'acct-delete-mini', V1_DISABLE_LEGACY_ROUTES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (c) => { output += c.toString() })
  server.stderr.on('data', (c) => { output += c.toString() })

  try {
    assert.ok(await waitForServer(), `服务未启动：${output}`)

    const super1 = await login('super1', 'super1pass')
    const restAuth = await login('restadmin', 'restpass1')
    const victimAuth = await login('victim', 'victimpass')

    // 普通管理员不得删除任何账号
    const restDelete = await request('DELETE', '/admin/accounts/A-VICTIM', null, restAuth)
    assert.strictEqual(restDelete.statusCode, 403, '区域查看权限不得删除账号')

    // 不能删除当前登录账号（防自锁）
    const selfDelete = await request('DELETE', '/admin/accounts/A-SUPER1', null, super1)
    assert.strictEqual(selfDelete.statusCode, 400, '不能删除当前登录账号')

    // 删除不存在账号 → 404
    const missing = await request('DELETE', '/admin/accounts/A-NOEXIST', null, super1)
    assert.strictEqual(missing.statusCode, 404, '删除不存在账号应 404')

    // 超管删除普通账号 → 成功，账号从列表消失
    const okDelete = await request('DELETE', '/admin/accounts/A-VICTIM', null, super1)
    assert.strictEqual(okDelete.statusCode, 200, `超管删除普通账号应 200：${JSON.stringify(okDelete.body)}`)
    const remainIds = okDelete.body.data.admins.map((item) => item.id)
    assert.ok(remainIds.indexOf('A-VICTIM') === -1, '删除后账号不应再出现在列表')

    // 已删除账号：旧 token 失效、无法再登录
    const victimMe = await request('GET', '/admin/auth/me', null, victimAuth)
    assert.strictEqual(victimMe.statusCode, 403, '已删除账号的旧 token 应失效')
    const victimRelogin = await request('POST', '/admin/auth/login', { account: 'victim', password: 'victimpass' })
    assert.strictEqual(victimRelogin.statusCode, 403, '已删除账号不能再登录')

    // 防删到零个可用超管：删掉 super2 后仅剩 super1，super1 删自己仍被拦（无法把超管清零）
    const delSuper2 = await request('DELETE', '/admin/accounts/A-SUPER2', null, super1)
    assert.strictEqual(delSuper2.statusCode, 200, '两个超管时删其一应允许')
    const selfDeleteAgain = await request('DELETE', '/admin/accounts/A-SUPER1', null, super1)
    assert.strictEqual(selfDeleteAgain.statusCode, 400, '删到最后一个超管应被拦（自锁保护）')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-account-delete-v1-test passed')
}).catch((error) => {
  console.error(`admin-account-delete-v1-test failed: ${error.message}`)
  process.exit(1)
})
