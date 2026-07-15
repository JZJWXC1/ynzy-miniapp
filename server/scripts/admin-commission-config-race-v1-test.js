'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

// P2④：PUT /admin/commission-config 是资损向高危写，不能只信请求入口的权限快照。
// 请求体尚未收完期间若发起管理员被降权/禁用，真正持写锁落库前必须用最新数据库重新鉴权，
// 否则已失权的账号仍能改动全站分佣比例。本测试锁定「锁外初验通过、锁内 fresh 复验拒绝」。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-commission-config-race-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 47200 + Math.floor(Math.random() * 400)
const baseUrl = `http://127.0.0.1:${port}`

const SUPER_PERMISSION = '全部后台权限'
const RESTRICTED_PERMISSION = '区域查看权限'

function seedDb() {
  fs.writeFileSync(dataFile, JSON.stringify({
    users: [
      { id: 'U-ADMIN-COMMISSION', name: '合成分佣竞态管理员', phone: '13900000401', isAdmin: true },
      { id: 'U-ADMIN-VERIFY', name: '合成分佣核对管理员', phone: '13900000402', isAdmin: true }
    ],
    adminAccounts: [
      {
        id: 'A-RACE-COMMISSION',
        account: 'race-commission-admin',
        password: 'fake-commission-pass-123',
        name: '合成分佣竞态管理员',
        userId: 'U-ADMIN-COMMISSION',
        permission: SUPER_PERMISSION,
        status: '启用'
      },
      {
        id: 'A-VERIFY-COMMISSION',
        account: 'verify-commission-admin',
        password: 'fake-verify-pass-123',
        name: '合成分佣核对管理员',
        userId: 'U-ADMIN-VERIFY',
        permission: SUPER_PERMISSION,
        status: '启用'
      }
    ],
    listings: [],
    footprints: []
  }, null, 2), 'utf8')
}

function readDb() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^﻿/, ''))
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

// 先发一个不完整 JSON 字节，让服务端完成锁外鉴权后停在 parseBody；不能只 flush headers，
// 否则 handler 若恰好在降权后才启动，旧实现也会 403，测试会假绿。
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
      ADMIN_TOKEN_SECRET: 'synthetic-commission-race-secret',
      AUTH_TOKEN_SECRET: 'synthetic-commission-race-mini',
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
    const raceAuth = await login('race-commission-admin', 'fake-commission-pass-123')
    const verifyAuth = await login('verify-commission-admin', 'fake-verify-pass-123')

    // 降权前用始终有效的核对管理员读取分佣配置基线快照。
    const beforeConfig = await request('GET', '/admin/commission-config', null, verifyAuth)
    assert.strictEqual(beforeConfig.statusCode, 200, '核对管理员应能读取分佣配置基线')

    // 竞态：race 管理员的 PUT 已通过锁外初验并停在请求体，随后其超管权限被降为区域查看权限。
    // 与基线明显不同的一组合法比例（uploader+platform ≤ 100），若锁内不复验将改动全站分佣。
    const racePut = delayedJsonRequest(
      'PUT',
      '/admin/commission-config',
      { secondLandlordRate: 25, secondLandlordPlatformRate: 15, ownerRate: 35, ownerPlatformRate: 15 },
      raceAuth
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const beforeDowngrade = await request('GET', '/admin/accounts', null, raceAuth)
    assert.strictEqual(beforeDowngrade.statusCode, 200, '降权前 race 管理员必须具有超级管理员能力')
    atomicMutateDb((db) => {
      db.adminAccounts.find((item) => item.id === 'A-RACE-COMMISSION').permission = RESTRICTED_PERMISSION
    })
    await waitForStatus(
      () => request('GET', '/admin/accounts', null, raceAuth),
      403,
      'race 管理员降权状态'
    )
    racePut.finish()
    const raceResult = await racePut.promise

    const afterConfig = await request('GET', '/admin/commission-config', null, verifyAuth)
    assert.strictEqual(afterConfig.statusCode, 200, '核对管理员应能读取分佣配置结果')

    const failures = []
    if (raceResult.statusCode !== 403) {
      failures.push(`管理员已降权后的在途分佣配置写应为 403，实为 ${raceResult.statusCode}`)
    }
    // 零副作用：配置不得被已失权的账号改动（前后快照必须完全一致）。
    assert.deepStrictEqual(
      afterConfig.body.data,
      beforeConfig.body.data,
      '管理员已降权后分佣配置必须零副作用（前后快照应一致）'
    )
    assert.deepStrictEqual(failures, [], failures.join('；'))
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-commission-config-race-v1-test passed')
}).catch((error) => {
  console.error(`admin-commission-config-race-v1-test failed: ${error.stack || error.message}`)
  process.exit(1)
})
