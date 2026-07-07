const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

// 需求5：只有超级管理员（permission='全部后台权限' 或无显式受限权限的存量账号）能访问「系统配置」组
// 的只读端点；普通管理员（区域查看权限）一律 403。前端隐藏菜单只是体验，这里固化后端硬拦。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-super-guard-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 41000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`

function seedDb() {
  const db = {
    users: [
      { id: 'U1', name: '超管员工', phone: '13900000001', isAdmin: true },
      { id: 'U2', name: '区域主管', phone: '13900000002' }
    ],
    listings: [],
    footprints: [],
    assistantFeedbacks: [],
    assistantTraceLogs: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'superadmin', password: 'superpass123', name: '超级管理员', userId: 'U1', permission: '全部后台权限', status: '启用' },
      { id: 'A-REST', account: 'restadmin', password: 'restpass123', name: '区域管理员', userId: 'U2', permission: '区域查看权限', status: '启用' },
      { id: 'A-LEGACY', account: 'legacyadmin', password: 'legacypass123', name: '存量管理员', userId: 'U1', status: '启用' }
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
  assert.strictEqual(res.statusCode, 200, `${account} 应能登录：${JSON.stringify(res.body)}`)
  return { Authorization: `Bearer ${res.body.data.token}` }
}

const GATED_GETS = [
  '/admin/launch-check',
  '/admin/assistant/feedbacks',
  '/admin/assistant/eval-cases',
  '/admin/assistant/traces',
  '/admin/feishu-sync/status',
  '/admin/env-template',
  '/admin/llm-config',
  '/admin/backup/status',
  '/admin/accounts'
]

const UNGATED_GETS = ['/admin/dashboard', '/admin/footprints', '/admin/listings']

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN_SECRET: 'super-guard-secret', AUTH_TOKEN_SECRET: 'super-guard-mini', V1_DISABLE_LEGACY_ROUTES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (c) => { output += c.toString() })
  server.stderr.on('data', (c) => { output += c.toString() })

  try {
    assert.ok(await waitForServer(), `服务未启动：${output}`)

    const superAuth = await login('superadmin', 'superpass123')
    const restAuth = await login('restadmin', 'restpass123')
    const legacyAuth = await login('legacyadmin', 'legacypass123')

    // 普通管理员对系统配置组只读端点一律 403
    for (const target of GATED_GETS) {
      const res = await request('GET', target, null, restAuth)
      assert.strictEqual(res.statusCode, 403, `区域查看权限不得访问 ${target}，应 403，实为 ${res.statusCode}`)
    }
    const restLlmTest = await request('POST', '/admin/llm-config/test', { testText: '测试' }, restAuth)
    assert.strictEqual(restLlmTest.statusCode, 403, '区域查看权限不得调用 /admin/llm-config/test')

    // 超级管理员与存量账号可访问
    for (const target of GATED_GETS) {
      const superRes = await request('GET', target, null, superAuth)
      assert.strictEqual(superRes.statusCode, 200, `超级管理员应可访问 ${target}，实为 ${superRes.statusCode}`)
      const legacyRes = await request('GET', target, null, legacyAuth)
      assert.strictEqual(legacyRes.statusCode, 200, `存量（无 permission）账号应按超管放行 ${target}，实为 ${legacyRes.statusCode}`)
    }

    // 普通管理员仍可看非系统配置的运营数据
    for (const target of UNGATED_GETS) {
      const res = await request('GET', target, null, restAuth)
      assert.strictEqual(res.statusCode, 200, `区域查看权限应仍能访问 ${target}`)
    }

    // /admin/auth/me 返回角色
    const superMe = await request('GET', '/admin/auth/me', null, superAuth)
    assert.strictEqual(superMe.body.data.isSuperAdmin, true, '超管 auth/me.isSuperAdmin 应为 true')
    const restMe = await request('GET', '/admin/auth/me', null, restAuth)
    assert.strictEqual(restMe.body.data.isSuperAdmin, false, '区域查看权限 auth/me.isSuperAdmin 应为 false')
    const legacyMe = await request('GET', '/admin/auth/me', null, legacyAuth)
    assert.strictEqual(legacyMe.body.data.isSuperAdmin, true, '存量账号 auth/me.isSuperAdmin 应为 true')

    // /admin/users：admins 账号清单仅超管可见，users 对普通管理员仍可见（smoke-test 依赖 users）
    const superUsers = await request('GET', '/admin/users', null, superAuth)
    assert.ok(Array.isArray(superUsers.body.data.admins) && superUsers.body.data.admins.length > 0, '超管 /admin/users 应返回账号清单')
    const restUsers = await request('GET', '/admin/users', null, restAuth)
    assert.strictEqual(restUsers.statusCode, 200, '普通管理员仍可拉 /admin/users 的 users 列表')
    assert.deepStrictEqual(restUsers.body.data.admins, [], '普通管理员不得看到 admins 账号清单')
    assert.ok(Array.isArray(restUsers.body.data.users), '普通管理员应仍能拿到 users 列表')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-super-config-guard-v1-test passed')
}).catch((error) => {
  console.error(`admin-super-config-guard-v1-test failed: ${error.message}`)
  process.exit(1)
})
