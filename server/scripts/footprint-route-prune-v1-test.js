'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const rootDir = path.resolve(__dirname, '..', '..')
const DAY = 24 * 60 * 60 * 1000

function signToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function requestJson(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: pathname,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, raw }))
    })
    req.once('error', reject)
    req.end()
  })
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`足迹清理测试服务提前退出：${child.exitCode}`)
    try {
      const response = await requestJson(port, '/healthz')
      if (response.statusCode === 200) return
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error('足迹清理测试服务启动超时')
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function makeDb() {
  const now = Date.now()
  return {
    users: [
      { id: 'U1', name: '上传人', role: '中介', authed: '已实名' },
      { id: 'U2', name: '查看人', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [{
      id: 'L1', uploaderId: 'U1', ownerType: '二房东房源', source: '二房东房源',
      status: '在租', lifecycleStatus: 'active', reviewStatus: '无需审核', communityMatched: true,
      city: '杭州', area: '拱墅区', community: '测试小区', address: '测试地址', rent: 3000,
      landlordPhone: '19900000001', videoKey: 'house-videos/test.mp4',
      lastVerifiedAt: new Date(now).toLocaleString('zh-CN', { hour12: false })
    }],
    footprints: [
      {
        id: 'F-EXPIRED', viewerId: 'U2', listingId: 'L1', actionType: 'sensitive_view',
        occurredAt: new Date(now - 91 * DAY).toISOString(), idempotencyKey: 'expired_route_01'
      },
      {
        id: 'F-RECENT', viewerId: 'U2', listingId: 'L1', actionType: 'sensitive_view',
        occurredAt: new Date(now - DAY).toISOString(), idempotencyKey: 'recent_route_001'
      }
    ],
    adminAccounts: [{
      id: 'A1', account: 'synthetic-admin', name: '合成管理员', userId: 'ADMIN',
      permission: '全部后台权限', status: '启用'
    }]
  }
}

async function verifyRoutePrunes(route) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-footprint-prune-'))
  const dataFile = path.join(tempDir, 'db.json')
  const miniSecret = 'synthetic-footprint-mini-secret'
  const adminSecret = 'synthetic-footprint-admin-secret'
  fs.writeFileSync(dataFile, JSON.stringify(makeDb()), 'utf8')
  const port = await freePort()
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(rootDir, 'server'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: miniSecret,
      ADMIN_TOKEN_SECRET: adminSecret,
      REPORT_DEAL_WRITES_ENABLED: '0',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  try {
    await waitForServer(port, child)
    const token = route.admin
      ? signToken({ id: 'A1', account: 'synthetic-admin', userId: 'ADMIN', exp: Date.now() + 60000 }, adminSecret)
      : signToken({ userId: 'U2', tokenVersion: 0, exp: Date.now() + 60000 }, miniSecret)
    const response = await requestJson(port, route.pathname, token)
    assert.strictEqual(response.statusCode, 200, `${route.pathname} 必须成功读取足迹`)
    const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assert.ok(!persisted.footprints.some((item) => item.id === 'F-EXPIRED'), `${route.pathname} 必须在写锁内物理清理 90 天外足迹`)
    assert.ok(persisted.footprints.some((item) => item.id === 'F-RECENT'), `${route.pathname} 不得误删 90 天内足迹`)
  } finally {
    await stopChild(child)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  assert.strictEqual(stderr.includes('19900000001'), false, '足迹清理测试日志不得输出假手机号')
}

async function run() {
  const routes = [
    { pathname: '/mini/footprints', admin: false },
    { pathname: '/mini/listings/L1/footprints', admin: false },
    { pathname: '/admin/footprints', admin: true }
  ]
  for (const route of routes) await verifyRoutePrunes(route)
}

run().then(() => {
  console.log('footprint-route-prune-v1-test: ok')
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
