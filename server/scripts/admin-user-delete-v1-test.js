const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

// 需求1：中介/员工账号（db.users）支持删除。策略：软删禁登 + 列表隐藏，名下房源/成交/分佣历史数据保留（无悬挂引用）。
// 锁定：软删后禁止手机号登录、deleted 标记、名下房源数据仍在、管理员用户不在此删、超管鉴权、软删后同号可重新开通。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-user-delete-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 42900 + Math.floor(Math.random() * 800)
const baseUrl = `http://127.0.0.1:${port}`

const BROKER_PHONE = '13900000021'

function seedDb() {
  const db = {
    users: [
      { id: 'U1', name: '超管员工', phone: '13900000001', isAdmin: true },
      { id: 'U-BROKER', name: '待删中介', phone: BROKER_PHONE, role: '中介', isAdmin: false, authed: '手机号登录' }
    ],
    // U-BROKER 名下的房源与分佣记录：软删后必须原样保留（不悬挂）。
    listings: [{ id: 'L-KEEP', title: '待保留房源', uploaderId: 'U-BROKER', rent: 2000, status: '在租', source: '二房东房源', ownerType: '二房东房源' }],
    commissionRecords: [{ id: 'C-KEEP', uploaderId: 'U-BROKER', listingId: 'L-KEEP', uploaderCommissionFen: 20000, platformCommissionFen: 10000 }],
    footprints: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'super1', password: 'super1pass', name: '超管', userId: 'U1', permission: '全部后台权限', status: '启用' },
      { id: 'A-REST', account: 'restadmin', password: 'restpass1', name: '区域', userId: 'U1', permission: '区域查看权限', status: '启用' }
    ]
  }
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')
}

function readDb() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^﻿/, ''))
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
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN_SECRET: 'user-delete-secret', AUTH_TOKEN_SECRET: 'user-delete-mini', V1_DISABLE_LEGACY_ROUTES: '1' },
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

    // 删除前中介可登录
    const preLogin = await request('POST', '/mini/auth/login', { phone: BROKER_PHONE })
    assert.strictEqual(preLogin.statusCode, 200, '删除前中介应能登录')

    // 超管鉴权：普通管理员不得删除
    const restDelete = await request('DELETE', '/admin/users/U-BROKER', null, restAuth)
    assert.strictEqual(restDelete.statusCode, 403, '区域查看权限不得删除用户')

    // 删除不存在用户 → 404
    const missing = await request('DELETE', '/admin/users/U-NOEXIST', null, superAuth)
    assert.strictEqual(missing.statusCode, 404, '删除不存在用户应 404')

    // 管理员用户不在此删除（走后台账号列表）→ 400
    const delAdminUser = await request('DELETE', '/admin/users/U1', null, superAuth)
    assert.strictEqual(delAdminUser.statusCode, 400, '管理员用户不应在此删除')

    // 超管软删中介 → 200
    const okDelete = await request('DELETE', '/admin/users/U-BROKER', null, superAuth)
    assert.strictEqual(okDelete.statusCode, 200, `超管删除中介应 200：${JSON.stringify(okDelete.body)}`)

    // 软删后：禁止手机号登录
    const postLogin = await request('POST', '/mini/auth/login', { phone: BROKER_PHONE })
    assert.strictEqual(postLogin.statusCode, 403, '软删后中介不能再登录')

    // 引用完整性：db 里用户记录仍在（deleted=true 留痕），名下房源与分佣记录原样保留
    const db = readDb()
    const brokerRecord = (db.users || []).find((item) => item.id === 'U-BROKER')
    assert.ok(brokerRecord, '软删应保留用户记录（留痕）')
    assert.strictEqual(brokerRecord.deleted, true, '软删应置 deleted=true')
    assert.ok(brokerRecord.deletedAt, '软删应记录 deletedAt')
    assert.ok((db.listings || []).some((item) => item.id === 'L-KEEP' && item.uploaderId === 'U-BROKER'), '名下房源应原样保留、不悬挂')
    assert.ok((db.commissionRecords || []).some((item) => item.id === 'C-KEEP' && item.uploaderId === 'U-BROKER'), '名下分佣记录应原样保留')

    // 软删后同号可重新开通（软删账号不占号）
    const reCreate = await request('POST', '/admin/users', { type: 'broker', name: '重新开通', phone: BROKER_PHONE }, superAuth)
    assert.strictEqual(reCreate.statusCode, 200, `软删后同号应可重新开通：${JSON.stringify(reCreate.body)}`)
    const reLogin = await request('POST', '/mini/auth/login', { phone: BROKER_PHONE })
    assert.strictEqual(reLogin.statusCode, 200, '重新开通后应能登录')
    assert.strictEqual(reLogin.body.data.name, '重新开通', '登录应返回新开通账号')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-user-delete-v1-test passed')
}).catch((error) => {
  console.error(`admin-user-delete-v1-test failed: ${error.message}`)
  process.exit(1)
})
