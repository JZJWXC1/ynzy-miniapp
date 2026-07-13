'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const repoRoot = path.resolve(__dirname, '..', '..')
const serverEntry = path.join(repoRoot, 'server', 'src', 'index.js')
const syntheticSecret = 'synthetic-nearby-http-secret'
const now = new Date().toISOString()

function listing(id, latitude, longitude, overrides = {}) {
  return {
    id,
    uploaderId: 'U1',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    communityMatched: true,
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '合成板块',
    community: `合成小区-${id}`,
    address: `SENTINEL_HTTP_NEARBY_ADDRESS_${id}`,
    landlordPhone: '19900000042',
    viewingPassword: 'SENTINEL_HTTP_NEARBY_PASSWORD',
    viewingKeyLocation: 'SENTINEL_HTTP_NEARBY_KEY',
    rent: 3000,
    rentMode: '整租',
    type: '整租',
    layout: '整租一室一厅一卫',
    features: ['Loft', '落地窗'],
    videoKey: `house-videos/synthetic/${id}.mp4`,
    mapLatitude: latitude,
    mapLongitude: longitude,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    coordinateLevel: 'verified',
    coordinateAccuracy: 'verified',
    landlordCommissionPercent: 50,
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    ...overrides
  }
}

function company(id, latitude, longitude, overrides = {}) {
  return listing(id, latitude, longitude, {
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    companyListing: true,
    ...overrides
  })
}

function owner(id, latitude, longitude, overrides = {}) {
  return listing(id, latitude, longitude, {
    ownerType: '业主房源',
    houseSourceType: '业主房源',
    source: '业主房源',
    requiresManualReview: true,
    reviewStatus: '已通过',
    ...overrides
  })
}

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '合成中介甲', role: '中介', authed: '已实名', tokenVersion: 0 },
      { id: 'U2', name: '合成中介乙', role: '中介', authed: '已实名', tokenVersion: 0 }
    ],
    listings: [
      company('ANCHOR', 30.3, 120.1),
      company('C1', 30.304, 120.1),
      owner('O1', 30.308, 120.1),
      listing('S1', 30.312, 120.1),
      company('C2', 30.316, 120.1, { videoKey: '' }),
      owner('O2', 30.32, 120.1),
      listing('S2', 30.324, 120.1),
      company('C3', 30.326, 120.1),
      company('NO_COORDINATE', '', '', {
        coordinateSource: 'pending-map-coordinate',
        coordinateVerified: false,
        coordinateLevel: '',
        coordinateAccuracy: ''
      }),
      company('EXPIRED_ANCHOR', 30.3, 120.1, { lifecycleStatus: 'expired', status: '已下架' }),
      owner('EXPIRED_PARTNER', 30.3, 120.1, { lifecycleStatus: 'expired', status: '已下架' }),
      company('OUTSIDE', 30.34, 120.1),
      listing('UNSAFE', 30.302, 120.1, {
        coordinateSource: 'block-center:合成板块',
        coordinateVerified: false,
        coordinateLevel: 'block-center',
        coordinateAccuracy: 'block-center'
      })
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 7 },
    footprints: [],
    commissionRecords: [],
    clientReports: [],
    dealRecords: [],
    pointLogs: [],
    adminLogs: []
  }
}

function signToken(userId, tokenVersion = 0) {
  const encoded = Buffer.from(JSON.stringify({
    userId,
    tokenVersion,
    exp: Date.now() + 60 * 60 * 1000
  })).toString('base64url')
  const signature = crypto.createHmac('sha256', syntheticSecret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function requestJson(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: pathname,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { raw += chunk })
      response.on('end', () => {
        try {
          const body = raw ? JSON.parse(raw) : {}
          resolve({ statusCode: response.statusCode, body, data: body.data })
        } catch (error) {
          reject(error)
        }
      })
    })
    request.once('error', reject)
    request.end()
  })
}

function startServer(port, dataFile) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: syntheticSecret,
      ADMIN_TOKEN_SECRET: 'synthetic-nearby-admin-secret',
      COMPANY_CONTACT_PHONES: '19900000099',
      FEISHU_SYNC_INTERVAL_MINUTES: '99999',
      REPORT_DEAL_WRITES_ENABLED: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  child.testOutput = () => output.slice(-4000)
  return child
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`附近推荐测试服务提前退出 ${child.exitCode}\n${child.testOutput()}`)
    try {
      const response = await requestJson(port, '/healthz')
      if (response.statusCode === 200) return
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`附近推荐测试服务启动超时\n${child.testOutput()}`)
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

function assertSafeNearby(response) {
  const text = JSON.stringify(response)
  ;[
    'SENTINEL_HTTP_NEARBY_ADDRESS',
    '19900000042',
    'SENTINEL_HTTP_NEARBY_PASSWORD',
    'SENTINEL_HTTP_NEARBY_KEY',
    'mapLatitude',
    'mapLongitude',
    'coordinateSource',
    'uploaderId'
  ].forEach((marker) => assert.ok(!text.includes(marker), `HTTP 附近 DTO 不得包含 ${marker}`))
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-nearby-http-'))
  const dataFile = path.join(tempDir, 'db.json')
  fs.writeFileSync(dataFile, JSON.stringify(makeDb(), null, 2), 'utf8')
  const port = await freePort()
  const child = startServer(port, dataFile)
  const token = signToken('U1')

  try {
    await waitForServer(port, child)

    const guestDetail = await requestJson(port, '/mini/listings/ANCHOR')
    assert.strictEqual(guestDetail.statusCode, 200)
    assert.ok(guestDetail.data && guestDetail.data.nearby, '详情接口必须内嵌权限裁剪后的附近预览')
    assert.deepStrictEqual(guestDetail.data.nearby.listings.map((item) => item.id), ['C1', 'O1', 'S1', 'C2', 'O2', 'S2'], '游客详情附近预览必须包含三类公开房源')
    assert.strictEqual(guestDetail.data.nearby.total, 7, '游客详情 total 必须统计三类公开房源')
    assertSafeNearby(guestDetail.data.nearby)

    const brokerDetail = await requestJson(port, '/mini/listings/ANCHOR', token)
    assert.strictEqual(brokerDetail.statusCode, 200)
    assert.strictEqual(brokerDetail.data.nearby.listings.length, 6, '登录详情最多 6 套')
    assert.strictEqual(brokerDetail.data.nearby.total, 7)
    assert.strictEqual(brokerDetail.data.nearby.hasMore, true)

    const forgedGuest = await requestJson(
      port,
      '/mini/listings/ANCHOR/nearby?all=1&radiusKm=999&latitude=30.3&longitude=120.1&companyOnly=false&source=%E4%BA%8C%E6%88%BF%E4%B8%9C%E6%88%BF%E6%BA%90&userId=U1'
    )
    assert.strictEqual(forgedGuest.statusCode, 200)
    assert.strictEqual(forgedGuest.data.radiusKm, 3)
    assert.deepStrictEqual(forgedGuest.data.listings.map((item) => item.id), ['C1', 'O1', 'S1', 'C2', 'O2', 'S2', 'C3'], '游客全量附近结果应包含三类来源，伪造半径与身份字段仍无效')
    assertSafeNearby(forgedGuest.data)

    const brokerAll = await requestJson(port, '/mini/listings/ANCHOR/nearby?all=1&radiusKm=0.01&companyOnly=true', token)
    assert.strictEqual(brokerAll.statusCode, 200)
    assert.deepStrictEqual(brokerAll.data.listings.map((item) => item.id), ['C1', 'O1', 'S1', 'C2', 'O2', 'S2', 'C3'], '登录账号应看到三类来源，客户端 companyOnly/radius 无效')
    assert.strictEqual(brokerAll.data.total, 7)

    const partnerGuest = await requestJson(port, '/mini/listings/O1/nearby?all=1')
    assert.strictEqual(partnerGuest.statusCode, 200, '游客可用有效合作房源作为附近推荐锚点')
    assert.ok(partnerGuest.data.listings.some((item) => !item.companyListing), '合作锚点附近结果必须保留公开合作房源')
    assertSafeNearby(partnerGuest.data)

    const badToken = await requestJson(port, '/mini/listings/ANCHOR/nearby?all=1', `${token}broken`)
    assert.strictEqual(badToken.statusCode, 401, '无效 token 不能降级成游客')

    const noCoordinate = await requestJson(port, '/mini/listings/NO_COORDINATE/nearby?all=1')
    assert.strictEqual(noCoordinate.statusCode, 200)
    assert.deepStrictEqual(noCoordinate.data, { radiusKm: 3, total: 0, hasMore: false, listings: [] })

    const expired = await requestJson(port, '/mini/listings/EXPIRED_ANCHOR/nearby?all=1')
    assert.strictEqual(expired.statusCode, 200)
    assert.deepStrictEqual(expired.data, { radiusKm: 3, total: 0, hasMore: false, listings: [] })

    const expiredPartner = await requestJson(port, '/mini/listings/EXPIRED_PARTNER/nearby?all=1')
    assert.strictEqual(expiredPartner.statusCode, 404, '游客对已失效合作锚点必须得到与不存在同形的 404')

    console.log('listing-nearby-http-v1-test passed')
  } finally {
    await stopServer(child)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
