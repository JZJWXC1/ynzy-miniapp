'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const domain = require('../src/domain')
const mockData = require('../../utils/mock-data')

// 1100 套会稳定跨过旧版 1024 个房源上下文容量；每轮都 JSON clone 模拟生产 readDb()，
// 防止只靠 WeakMap 的实现把“同对象很快、每个真实请求仍全冷”误判成通过。
const LISTING_COUNT = 1100

function elapsedMs(action) {
  const startedAt = process.hrtime.bigint()
  const value = action()
  return {
    value,
    milliseconds: Number(process.hrtime.bigint() - startedAt) / 1e6
  }
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function partnerListing(index) {
  const suffix = String(index + 1).padStart(4, '0')
  const roomNumber = String(700 + index)
  const community = `性能门禁测试小区${index + 1}`
  return {
    id: `PERF-LISTING-${suffix}`,
    uploaderId: 'PERF-UPLOADER',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新',
    community,
    communityName: community,
    building: '1',
    unit: '2',
    roomNumber,
    address: `杭州拱墅区${community}1栋2单元${roomNumber}室`,
    landlordPhone: `1990000${suffix}`,
    contact: `1990000${suffix}`,
    rent: 3000 + index,
    rentMode: '整租',
    type: '整租',
    layout: '两室1厅1卫',
    room: '两室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯', '近地铁'],
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '已通过',
    requiresManualReview: true,
    manualReviewReason: `人工确认资料完整-${suffix}`,
    communityMatched: true,
    lastVerifiedAt: new Date().toISOString(),
    videoKey: `house-videos/synthetic/performance-${suffix}.mp4`,
    landlordCommissionPercent: 50
  }
}

function assertWarmProjectionReused(label, action, options = {}) {
  const cold = elapsedMs(action)
  const warmRuns = [elapsedMs(action), elapsedMs(action), elapsedMs(action)]
  const warmMilliseconds = median(warmRuns.map((item) => item.milliseconds))
  assert.strictEqual(cold.value.length, LISTING_COUNT, `${label} 冷启动必须返回完整房源`)
  warmRuns.forEach((warm) => assert.strictEqual(warm.value.length, LISTING_COUNT, `${label} 热路径必须返回完整房源`))
  // 使用相对门槛避免不同机器绝对速度造成假红；没有投影复用时两次耗时基本相同，
  // 有缓存时第二次只做轻量签名核对和 DTO 组装，应显著低于第一次。
  assert.ok(
    warmMilliseconds < cold.milliseconds * 0.65,
    `${label} 跨容量后未复用同一安全投影：cold=${cold.milliseconds.toFixed(1)}ms warmMedian=${warmMilliseconds.toFixed(1)}ms`
  )
  if (Number.isFinite(options.maxColdMilliseconds)) {
    assert.ok(
      cold.milliseconds < options.maxColdMilliseconds,
      `${label} 首次投影仍会长时间同步阻塞：cold=${cold.milliseconds.toFixed(1)}ms limit=${options.maxColdMilliseconds}ms`
    )
  }
  return { cold: cold.milliseconds, warm: warmMilliseconds }
}

function assertDomainProjection() {
  const listings = Array.from({ length: LISTING_COUNT }, (_, index) => partnerListing(index))
  const db = {
    listings,
    users: [{ id: 'PERF-UPLOADER', name: '性能测试账号', status: '正常', authed: '已实名' }],
    commissionConfig: {}
  }
  const snapshot = JSON.stringify(db)
  const timing = assertWarmProjectionReused('生产领域层跨读库克隆', () => (
    domain.filterListings(JSON.parse(snapshot), { publicGuest: true })
  ))
  assert.deepStrictEqual(
    domain.publicListingIds(db),
    domain.filterListings(db, { publicGuest: true }).map((item) => item.id),
    '媒体资格 ID 必须与唯一前台有效房态口径一致'
  )

  // 缓存必须跟随所有安全上下文字段变化失效；改变完整地址、电话及公开载体后，
  // 旧的“安全结果”绝不能复用到新原文。
  const target = listings[0]
  target.address = '杭州拱墅区性能变更测试小区9栋8单元701室'
  target.landlordPhone = '19900009999'
  target.contact = '19900009999'
  target.block = '东新 19900009999 9栋8单元701室'
  const changed = domain.filterListings(db, { publicGuest: true }).find((item) => item.id === target.id)
  const serialized = JSON.stringify(changed)
  assert.ok(!serialized.includes('19900009999'), '生产投影缓存失效后不得泄露新电话')
  assert.ok(!serialized.includes('9栋8单元701室'), '生产投影缓存失效后不得泄露新精确地址')
  return { timing, listings, db }
}

function assertPartnerSecretsHidden(label, rows) {
  const serialized = JSON.stringify(rows)
  assert.ok(!serialized.includes('1990000'), `${label} 登录列表仍不得下发合作房源手机号`)
  assert.ok(!serialized.includes('1栋2单元'), `${label} 登录列表仍不得下发合作房源楼栋单元`)
  assert.ok(!serialized.includes('钥匙柜'), `${label} 登录列表仍不得下发钥匙位置`)
  assert.ok(!serialized.includes('开门密码'), `${label} 登录列表仍不得下发开门密码`)
}

function assertDomainAuthenticatedProjection(domainState) {
  domainState.listings.forEach((listing, index) => {
    listing.viewingKeyLocation = `钥匙柜-${index + 1}`
    listing.viewingPassword = `开门密码-${index + 1}`
    listing.remark = `敏感备注-${index + 1}`
  })
  const authenticatedSnapshot = JSON.stringify(domainState.db)
  const timing = assertWarmProjectionReused(
    '生产登录列表跨读库克隆',
    () => domain.filterListings(JSON.parse(authenticatedSnapshot), {}),
    { maxColdMilliseconds: 10000 }
  )
  const rows = domain.filterListings(domainState.db, {})
  assertPartnerSecretsHidden('生产', rows)

  // 缓存不能只按 id、对象身份或 updatedAt：原地变化后，公开值应更新，秘密仍须剥离。
  const target = domainState.listings[0]
  target.community = '性能缓存变更小区'
  target.communityName = target.community
  target.address = '杭州拱墅区性能缓存变更小区9栋8单元701室'
  target.landlordPhone = '19900009999'
  target.contact = '19900009999'
  target.manualReviewReason = '资料待补 19900009999 9栋8单元701室'
  const changed = domain.filterListings(domainState.db, {}).find((item) => item.id === target.id)
  const serialized = JSON.stringify(changed)
  assert.ok(serialized.includes('性能缓存变更小区'), '登录列表缓存失效后必须返回新的公开小区')
  assert.ok(!serialized.includes('19900009999'), '登录列表缓存失效后不得泄露新电话')
  assert.ok(!serialized.includes('9栋8单元701室'), '登录列表缓存失效后不得泄露新精确地址')
  return timing
}

function mockListingPayload(index) {
  const listing = partnerListing(index)
  return {
    city: listing.city,
    district: listing.district,
    area: listing.area,
    block: listing.block,
    communityName: listing.community,
    community: listing.community,
    building: listing.building,
    unit: listing.unit,
    roomNumber: listing.roomNumber,
    address: listing.address,
    contact: listing.contact,
    landlordPhone: listing.landlordPhone,
    rent: listing.rent,
    layout: listing.layout,
    rentMode: listing.rentMode,
    room: listing.room,
    hall: listing.hall,
    bath: listing.bath,
    features: listing.features,
    videoUrl: `https://example.com/synthetic/performance-${index + 1}.mp4`,
    videoKey: listing.videoKey,
    viewingMethod: '联系房东',
    viewingKeyLocation: `钥匙柜-${index + 1}`,
    viewingPassword: `开门密码-${index + 1}`,
    remark: `敏感备注-${index + 1}`,
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    landlordCommissionPercent: 50
  }
}

function assertMockProjection() {
  mockData.loginByPhone('13800010005')
  for (let index = 0; index < LISTING_COUNT; index += 1) {
    mockData.addNormalListing(mockListingPayload(index))
  }
  const guestTiming = assertWarmProjectionReused('Mock 游客预览层', () => mockData.getListings({ publicGuest: true }))
  const authenticatedTiming = assertWarmProjectionReused('Mock 登录列表', () => mockData.getListings({}))
  assertPartnerSecretsHidden('Mock', mockData.getListings({}))
  return { guestTiming, authenticatedTiming }
}

const domainState = assertDomainProjection()
const domainAuthenticatedTiming = assertDomainAuthenticatedProjection(domainState)
const mockTiming = assertMockProjection()
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
const domainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain.js'), 'utf8')
const mockSource = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'mock-data.js'), 'utf8')
assert.ok(indexSource.includes('domain.publicListingIds(db)'), '媒体资格集合必须使用轻量领域层 ID helper')
assert.ok(!indexSource.includes('domain.filterListings(db, { publicGuest: true })'), '媒体装饰不得为资格集合再次重投影全库游客 DTO')
assert.ok(indexSource.includes('createUniqueListingIndex'), '媒体装饰必须一次构建唯一 id→房源索引，不能逐行 O(n²) find')
assert.ok(domainSource.includes('new WeakMap()') && domainSource.includes('guestPublicFingerprintContextCache'), '生产投影必须同时具备对象缓存与跨 clone 指纹缓存')
assert.ok(mockSource.includes('new WeakMap()') && mockSource.includes('guestPublicFingerprintContextCache'), 'Mock 投影必须与生产保持双层缓存等价')
console.log(`PUBLIC_LISTING_PROJECTION_PERFORMANCE PASS guest=${domainState.timing.cold.toFixed(1)}→${domainState.timing.warm.toFixed(1)}ms auth=${domainAuthenticatedTiming.cold.toFixed(1)}→${domainAuthenticatedTiming.warm.toFixed(1)}ms mockGuest=${mockTiming.guestTiming.cold.toFixed(1)}→${mockTiming.guestTiming.warm.toFixed(1)}ms mockAuth=${mockTiming.authenticatedTiming.cold.toFixed(1)}→${mockTiming.authenticatedTiming.warm.toFixed(1)}ms`)
