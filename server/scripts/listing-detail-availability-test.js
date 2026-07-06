const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

process.env.COMPANY_CONTACT_PHONES = process.env.COMPANY_CONTACT_PHONES || '10000000001,10000000002'

const domain = require('../src/domain')
const feishuSync = require('../src/feishu-sync')
const matchService = require('../src/match-service')

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-listing-detail-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 40000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function listing(overrides = {}) {
  const now = nowText()
  return {
    id: 'ACTIVE',
    title: '详情可用测试房源',
    shortTitle: '详情测试小区',
    uploaderId: 'A1',
    rent: 3200,
    layout: '整租一室一厅一卫',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新园',
    community: '详情测试小区',
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: '杭州拱墅区详情测试小区1幢1单元101室',
    landlordPhone: '13911112222',
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    noCommission: true,
    type: '整租',
    rentMode: '整租',
    videoUrl: '',
    videoKey: '',
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    mapLatitude: 30.31,
    mapLongitude: 120.17,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    ...overrides
  }
}

function makeDb() {
  return {
    currentUserId: 'A1',
    users: [
      { id: 'A1', name: '管理员', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [
      listing(),
      listing({
        id: 'DOWN',
        title: '已下架测试房源',
        community: '已下架测试小区',
        status: '已下架',
        lifecycleStatus: 'expired',
        expiredReason: '飞书房源表未返回该房源，自动同步下架',
        expiredAt: nowText(),
        feishuLastSyncAction: 'down',
        feishuLastSyncAt: nowText(),
        feishuLastSyncReason: '飞书房源表未返回该房源，自动同步下架'
      }),
      listing({
        id: 'PENDING',
        title: '待审核测试房源',
        community: '待审核测试小区',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        source: '业主房源',
        companyListing: false,
        isCompanyListing: false,
        requiresManualReview: true,
        reviewStatus: '待审核',
        status: '待审核'
      }),
      listing({
        id: 'NO_COORD',
        title: '无坐标但详情可打开房源',
        community: '无坐标详情测试小区',
        mapLatitude: '',
        mapLongitude: '',
        coordinateSource: 'pending-map-coordinate',
        coordinateVerified: false
      })
    ],
    footprints: [],
    clientReports: [],
    dealRecords: [],
    commissionRecords: []
  }
}

function request(method, targetPath) {
  const url = new URL(targetPath, baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        let parsed = {}
        try {
          parsed = raw ? JSON.parse(raw) : {}
        } catch (error) {
          parsed = { raw }
        }
        resolve({ statusCode: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
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

function assertUnavailableSafe(payload, label) {
  const text = JSON.stringify(payload)
  assert.strictEqual(payload.unavailable, true, `${label} 应返回 unavailable`)
  assert.ok(!text.includes('13911112222'), `${label} 不应返回房东电话`)
  assert.ok(!text.includes('1单元'), `${label} 不应返回详细地址`)
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'videoUrl'), `${label} 不应返回视频字段`)
}

async function assertEndpointBehavior() {
  const db = makeDb()
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')

  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      V1_DISABLE_LEGACY_ROUTES: '1',
      AUTH_TOKEN_SECRET: 'listing-detail-availability-test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  server.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })

  try {
    assert.ok(await waitForServer(), `测试服务未启动：${output}`)

    const active = await request('GET', '/mini/listings/ACTIVE?queryId=active-q')
    assert.strictEqual(active.statusCode, 200, '有效房源详情应返回 200')
    assert.strictEqual(dataOf(active).id, 'ACTIVE', '有效房源详情应返回正常详情')

    const unavailable = await request('GET', '/mini/listings/DOWN?queryId=down-q')
    assert.strictEqual(unavailable.statusCode, 200, '已下架房源应返回结构化 200，不再裸 404')
    assert.strictEqual(dataOf(unavailable).reason, 'down', '已下架房源应标记 down')
    assertUnavailableSafe(dataOf(unavailable), '已下架房源')

    const missing = await request('GET', '/mini/listings/MISSING?queryId=missing-q')
    assert.strictEqual(missing.statusCode, 404, '查无此 id 仍应返回 404')
    assert.strictEqual(missing.body.message, '房源不存在', '查无此 id 不应混用已下架文案')

    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(output.includes('availability=unavailable'), '服务端应记录 unavailable 诊断日志')
    assert.ok(output.includes('queryId=down-q'), '诊断日志应包含 queryId')
    assert.ok(output.includes('feishuAction=down'), '诊断日志应包含最近飞书同步动作')
    assert.ok(output.includes('availability=not-found'), '查无 id 也应记录诊断日志')
  } finally {
    server.kill()
  }
}

function assertDomainInvariants() {
  const db = makeDb()
  const activeState = domain.listingDetailState(db, 'ACTIVE')
  assert.strictEqual(activeState.status, 'available', '有效房源应返回 available')
  assert.ok(domain.listingDetail(db, 'ACTIVE'), '旧 listingDetail 合约应保持有效房源返回详情')

  const downState = domain.listingDetailState(db, 'DOWN')
  assert.strictEqual(downState.status, 'unavailable', '已下架原始房源应返回 unavailable')
  assert.strictEqual(downState.reason, 'down', '已下架原因应为 down')
  assert.strictEqual(domain.listingDetail(db, 'DOWN'), null, '旧 listingDetail 合约应保持无效房源返回 null')
  assertUnavailableSafe(downState.unavailable, 'domain 已下架房源')

  const pendingState = domain.listingDetailState(db, 'PENDING')
  assert.strictEqual(pendingState.status, 'unavailable', '待审核原始房源应返回 unavailable')
  assert.strictEqual(pendingState.reason, 'pending', '待审核原因应为 pending')

  const candidates = matchService._internal.candidateListings(db)
  candidates.forEach((candidate) => {
    const state = domain.listingDetailState(db, candidate.id)
    assert.strictEqual(state.status, 'available', `推荐池房源 ${candidate.id} 在同一 db 下必须能打开详情`)
  })

  assert.ok(candidates.some((item) => item.id === 'NO_COORD'), '无坐标有效房源仍可进入推荐池')
  assert.strictEqual(domain.listingDetailState(db, 'NO_COORD').status, 'available', '无坐标有效房源详情应可打开')
  assert.ok(!domain.mapCommunities(db).some((item) => item.activeListingIds.includes('NO_COORD')), '无坐标只影响地图上图，不应与详情 404 耦合')
}

function syncRow(recordId, overrides = {}) {
  return {
    record_id: recordId,
    fields: {
      区域: '东新园',
      小区: '棠润府',
      几栋: '17',
      几单元: '',
      房号: '1004A',
      户型: '一室一厅一卫',
      押一付一: '3200',
      联系电话: '13900001111',
      ...overrides
    }
  }
}

async function assertFeishuIdStability() {
  const db = {
    users: [{ id: 'A1', name: '管理员', role: '管理员', isAdmin: true }],
    listings: [],
    footprints: [],
    pointLogs: []
  }

  const first = await feishuSync.applySync(db, [syncRow('rec-a')], [], 'A1', { dryRun: true })
  assert.strictEqual(first.created, 1, '首次同步应创建房源')
  const firstId = db.listings[0].id
  assert.strictEqual(db.listings[0].feishuLastSyncAction, 'created', '创建动作应写入房源')
  assert.ok(db.listings[0].feishuRoomIdentityKey, '应写入物理房间身份键')

  const second = await feishuSync.applySync(db, [syncRow('rec-a', { 押一付一: '3300' })], [], 'A1', { dryRun: true })
  assert.strictEqual(second.updated, 1, '同一飞书记录二次同步应更新')
  assert.strictEqual(db.listings.length, 1, '同一飞书记录二次同步不得产生重复房源')
  assert.strictEqual(db.listings[0].id, firstId, '同一飞书记录二次同步 listing.id 必须稳定')
  assert.strictEqual(db.listings[0].feishuLastSyncAction, 'updated', '更新动作应写入房源')

  const switchedRecordId = await feishuSync.applySync(db, [syncRow('rec-b', { 押一付一: '3400' })], [], 'A1', { dryRun: true })
  assert.strictEqual(switchedRecordId.updated, 1, '同一物理房源 record_id 变化时应复用旧房源')
  assert.strictEqual(switchedRecordId.down, 0, '同一物理房源 record_id 变化时不应先下架旧房源')
  assert.strictEqual(db.listings.length, 1, '同一物理房源 record_id 变化时不得重建重复房源')
  assert.strictEqual(db.listings[0].id, firstId, '同一物理房源 record_id 变化时 listing.id 必须稳定')
  assert.strictEqual(db.listings[0].feishuRecordId, 'rec-b', '复用后应更新为新的飞书记录 id')

  const removed = await feishuSync.applySync(db, [], [], 'A1', { dryRun: true })
  assert.strictEqual(removed.down, 1, '飞书表移除后应自动下架')
  assert.strictEqual(db.listings[0].status, '已下架', '移除后应进入已下架状态')
  assert.strictEqual(db.listings[0].feishuLastSyncAction, 'down', '下架动作应写入房源')
  assert.strictEqual(domain.listingDetailState(db, firstId).reason, 'down', '飞书移除后的详情状态应给出 down 原因')
}

async function main() {
  assertDomainInvariants()
  await assertFeishuIdStability()
  await assertEndpointBehavior()
  console.log('listing-detail-availability-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
