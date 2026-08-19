'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createGuestPublicContextCache } = require('../src/guest-public-context-cache')
const { GONGSHU_COMMUNITIES } = require('../src/community-library')

// 1100 套用于锁定部署/重启后的真实首笔大列表；缓存容量边界另用生产同款工厂的
// 8+1 缩小模型做确定性断言，避免为了复现 8192+1 把门禁拖到数分钟。
const LISTING_COUNT = 1100
const FALLBACK_LISTING_COUNT = 256
const CONTEXT_TEST_LIMIT = 8
const CANONICAL_BLOCKS = ['万达', '北部软件园', '城北万象城', '石桥', '华丰', '永佳', '半山', '东新园']
const domainModulePath = require.resolve('../src/domain')
const mockModulePath = require.resolve('../../utils/mock-data')

function loadFreshDomain() {
  delete require.cache[domainModulePath]
  return require(domainModulePath)
}

function loadFreshMock() {
  delete require.cache[mockModulePath]
  return require(mockModulePath)
}

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

function partnerListing(index, options = {}) {
  const suffix = String(index + 1).padStart(4, '0')
  const roomNumber = String(700 + index)
  const canonical = options.canonical !== false
  const community = canonical
    ? GONGSHU_COMMUNITIES[index % GONGSHU_COMMUNITIES.length]
    : `性能门禁测试小区${index + 1}`
  return {
    id: `PERF-LISTING-${suffix}`,
    uploaderId: 'PERF-UPLOADER',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: canonical ? CANONICAL_BLOCKS[index % CANONICAL_BLOCKS.length] : `性能板块${index + 1}`,
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

function performanceDb(options = {}) {
  const count = Number.isInteger(options.count) && options.count > 0 ? options.count : LISTING_COUNT
  const listings = Array.from({ length: count }, (_, index) => partnerListing(index, options))
  return {
    listings,
    users: [{ id: 'PERF-UPLOADER', name: '性能测试账号', status: '正常', authed: '已实名' }],
    commissionConfig: {}
  }
}

function assertWarmProjectionReused(label, action, options = {}) {
  const expectedCount = options.expectedCount || LISTING_COUNT
  const cold = elapsedMs(action)
  const warmRuns = [elapsedMs(action), elapsedMs(action), elapsedMs(action)]
  const warmMilliseconds = median(warmRuns.map((item) => item.milliseconds))
  assert.strictEqual(cold.value.length, expectedCount, `${label} 冷启动必须返回完整房源`)
  warmRuns.forEach((warm) => assert.strictEqual(warm.value.length, expectedCount, `${label} 热路径必须返回完整房源`))
  assert.ok(
    warmMilliseconds < Math.max(80, cold.milliseconds * 0.65),
    `${label} 跨请求未复用同一安全投影：cold=${cold.milliseconds.toFixed(1)}ms warmMedian=${warmMilliseconds.toFixed(1)}ms`
  )
  assert.ok(
    cold.milliseconds < options.maxColdMilliseconds,
    `${label} 首次投影仍会长时间同步阻塞：cold=${cold.milliseconds.toFixed(1)}ms limit=${options.maxColdMilliseconds}ms`
  )
  assert.ok(
    warmMilliseconds < options.maxWarmMilliseconds,
    `${label} 热路径超出上限：warmMedian=${warmMilliseconds.toFixed(1)}ms limit=${options.maxWarmMilliseconds}ms`
  )
  return { cold: cold.milliseconds, warm: warmMilliseconds }
}

function assertContextCacheScanResistance() {
  const cache = createGuestPublicContextCache({
    limit: CONTEXT_TEST_LIMIT,
    createEntry: (contextKey) => ({ contextKey, fragments: null, textBucket: new Map() })
  })
  const originalKeys = Array.from({ length: CONTEXT_TEST_LIMIT + 1 }, (_, index) => `context-${index}`)
  const runRound = (keys) => {
    cache.resetStats()
    cache.prepare(keys)
    keys.forEach((contextKey) => cache.entry({}, contextKey))
    return cache.stats()
  }

  const first = runRound(originalKeys)
  assert.strictEqual(first.contextMisses, CONTEXT_TEST_LIMIT + 1, '首次 8+1 扫描必须真实创建全部上下文')
  assert.strictEqual(first.cacheSize, CONTEXT_TEST_LIMIT, '上下文缓存不得超过配置上限')
  assert.strictEqual(first.overflowMisses, 1, '容量外条目必须走本轮临时对象而非逐项淘汰热点')

  for (let round = 0; round < 3; round += 1) {
    const repeated = runRound(originalKeys.slice())
    assert.ok(repeated.contextMisses <= 1, `容量 8+1 第 ${round + 2} 轮不得级联全冷`)
    assert.ok(repeated.contextHits >= CONTEXT_TEST_LIMIT, `容量 8+1 第 ${round + 2} 轮至少复用 8 个热点`)
    assert.strictEqual(repeated.cacheSize, CONTEXT_TEST_LIMIT, '重复扫描后缓存仍不得越界')
  }

  const editedKeys = originalKeys.slice()
  editedKeys[0] = 'context-0-edited-phone-and-address'
  const edited = runRound(editedKeys)
  assert.ok(edited.contextMisses <= 2, '单套敏感上下文变化只允许新条目与容量外条目失效')
  assert.strictEqual(edited.evictions, 1, '整库准备阶段必须清理已编辑房源的旧指纹')
  assert.strictEqual(edited.cacheSize, CONTEXT_TEST_LIMIT, '编辑后缓存仍不得越界')
  return { first, edited }
}

function assertDomainContextCacheWiring() {
  const domain = loadFreshDomain()
  const db = performanceDb({ count: CONTEXT_TEST_LIMIT + 1 })
  db.listings.forEach((listing, index) => {
    listing.viewingKeyLocation = `钥匙柜-${index + 1}`
    listing.viewingPassword = `开门密码-${index + 1}`
    listing.remark = `敏感备注-${index + 1}`
  })
  return domain.__withGuestPublicContextCacheForTest(CONTEXT_TEST_LIMIT, (cache) => {
    const project = () => domain.filterListings(JSON.parse(JSON.stringify(db)), {})
    cache.resetStats()
    assert.strictEqual(project().length, CONTEXT_TEST_LIMIT + 1, '生产实际列表必须返回 8+1 套')
    const first = cache.stats()
    assert.strictEqual(first.preparations, 1, '生产 filterListings 必须真实调用完整数据集缓存准备')
    assert.strictEqual(first.contextMisses, CONTEXT_TEST_LIMIT + 1, '生产实际首轮必须创建 8+1 个上下文')

    cache.resetStats()
    project()
    const repeated = cache.stats()
    assert.strictEqual(repeated.preparations, 1, '生产重复列表仍必须执行一次缓存准备')
    assert.ok(repeated.contextMisses <= 1, '生产实际 8+1 跨 clone 重扫不得级联全冷')

    db.listings[0].address = '杭州拱墅区万达广场9栋8单元701室'
    db.listings[0].landlordPhone = '19900009999'
    db.listings[0].contact = '19900009999'
    db.listings[0].manualReviewReason = '资料待补 19900009999 9栋8单元701室'
    cache.resetStats()
    const editedRows = project()
    const edited = cache.stats()
    assert.strictEqual(edited.preparations, 1, '生产编辑后必须先清理旧上下文指纹')
    assert.ok(edited.contextMisses <= 2, '生产实际单套编辑不得让其余房源重新投影')
    assert.strictEqual(edited.evictions, 1, '生产实际单套编辑必须清理一个旧指纹')
    assertPartnerSecretsHidden('生产实际 8+1 编辑', editedRows)
    return { first, repeated, edited }
  })
}

function assertMockContextCacheWiring() {
  const mockData = loadFreshMock()
  mockData.loginByPhone('13800010005')
  const added = []
  for (let index = 0; index < CONTEXT_TEST_LIMIT + 1; index += 1) {
    added.push(mockData.addNormalListing(mockListingPayload(index)))
  }
  return mockData.__withGuestPublicContextCacheForTest(CONTEXT_TEST_LIMIT, (cache) => {
    cache.resetStats()
    assert.strictEqual(mockData.getListings({}).length, CONTEXT_TEST_LIMIT + 1, 'Mock 实际列表必须返回 8+1 套')
    const first = cache.stats()
    assert.strictEqual(first.preparations, 1, 'Mock getListings 必须真实调用完整数据集缓存准备')
    assert.strictEqual(first.contextMisses, CONTEXT_TEST_LIMIT + 1, 'Mock 实际首轮必须创建 8+1 个上下文')

    cache.resetStats()
    mockData.getListings({})
    const repeated = cache.stats()
    assert.strictEqual(repeated.preparations, 1, 'Mock 重复列表仍必须执行一次缓存准备')
    assert.strictEqual(repeated.contextMisses, 0, 'Mock 同对象重扫必须全部走弱引用缓存')

    // Mock 新增房源按 unshift 排序；最后新增的一套位于缓存准入区，编辑它才能锁住旧指纹清扫。
    const changedIndex = CONTEXT_TEST_LIMIT
    const changedPayload = mockListingPayload(changedIndex)
    changedPayload.address = '杭州拱墅区万达广场9栋8单元701室'
    changedPayload.contact = '19900009999'
    changedPayload.landlordPhone = changedPayload.contact
    changedPayload.manualReviewReason = '资料待补 19900009999 9栋8单元701室'
    mockData.updateNormalListing(added[changedIndex].id, changedPayload)
    cache.resetStats()
    const editedRows = mockData.getListings({})
    const edited = cache.stats()
    assert.strictEqual(edited.preparations, 1, 'Mock 编辑后必须先清理旧上下文指纹')
    assert.ok(edited.contextMisses <= 1, 'Mock 实际单套编辑不得让其余房源重新投影')
    assert.strictEqual(edited.evictions, 1, 'Mock 实际单套编辑必须清理一个旧指纹')
    assertPartnerSecretsHidden('Mock 实际 8+1 编辑', editedRows)
    return { first, repeated, edited }
  })
}

function assertPartnerSecretsHidden(label, rows) {
  const serialized = JSON.stringify(rows)
  assert.ok(!serialized.includes('1990000'), `${label} 登录列表仍不得下发合作房源手机号`)
  assert.ok(!serialized.includes('1栋2单元'), `${label} 登录列表仍不得下发合作房源楼栋单元`)
  assert.ok(!serialized.includes('钥匙柜'), `${label} 登录列表仍不得下发钥匙位置`)
  assert.ok(!serialized.includes('开门密码'), `${label} 登录列表仍不得下发开门密码`)
}

function assertPollutedLocationFallsBack(label, row) {
  const serialized = JSON.stringify(row || {})
  ;['19900009999', '9栋8单元701室', 'douyin.com', 'privateprofile'].forEach((secret) => {
    assert.ok(!serialized.includes(secret), `${label} 污染位置字段必须退出快路径并清除 ${secret}`)
  })
}

function pollutedListing(index = 0) {
  const listing = partnerListing(index)
  listing.city = '杭州 19900009999'
  listing.district = '拱墅区 douyin.com/privateprofile'
  listing.area = listing.district
  listing.block = '万达 9栋8单元701室'
  listing.community = '万达广场 19900009999'
  listing.communityName = listing.community
  listing.address = '杭州拱墅区万达广场9栋8单元701室'
  listing.landlordPhone = '19900009999'
  listing.contact = listing.landlordPhone
  return listing
}

function assertDomainGuestProjection() {
  const domain = loadFreshDomain()
  const db = performanceDb()
  const snapshot = JSON.stringify(db)
  const timing = assertWarmProjectionReused(
    '生产游客列表真冷启动',
    () => domain.filterListings(JSON.parse(snapshot), { publicGuest: true }),
    { maxColdMilliseconds: 1500, maxWarmMilliseconds: 500 }
  )
  assert.deepStrictEqual(
    domain.publicListingIds(db),
    domain.filterListings(db, { publicGuest: true }).map((item) => item.id),
    '媒体资格 ID 必须与唯一前台有效房态口径一致'
  )
  const pollutionDb = {
    listings: [pollutedListing()],
    users: db.users,
    commissionConfig: {}
  }
  assertPollutedLocationFallsBack('生产游客', domain.filterListings(pollutionDb, { publicGuest: true })[0])
  return timing
}

function assertDomainAuthenticatedProjection() {
  const domain = loadFreshDomain()
  const db = performanceDb()
  db.listings.forEach((listing, index) => {
    listing.viewingKeyLocation = `钥匙柜-${index + 1}`
    listing.viewingPassword = `开门密码-${index + 1}`
    listing.remark = `敏感备注-${index + 1}`
  })
  const snapshot = JSON.stringify(db)
  const timing = assertWarmProjectionReused(
    '生产登录列表真冷启动',
    () => domain.filterListings(JSON.parse(snapshot), {}),
    { maxColdMilliseconds: 2500, maxWarmMilliseconds: 600 }
  )
  const rows = domain.filterListings(db, {})
  assertPartnerSecretsHidden('生产', rows)

  const target = db.listings[0]
  target.community = '性能缓存变更小区'
  target.communityName = target.community
  target.address = '杭州拱墅区性能缓存变更小区9栋8单元701室'
  target.landlordPhone = '19900009999'
  target.contact = '19900009999'
  target.manualReviewReason = '资料待补 19900009999 9栋8单元701室'
  const changed = domain.filterListings(db, {}).find((item) => item.id === target.id)
  const serialized = JSON.stringify(changed)
  assert.ok(serialized.includes('性能缓存变更小区'), '登录列表缓存失效后必须返回新的公开小区')
  assert.ok(!serialized.includes('19900009999'), '登录列表缓存失效后不得泄露新电话')
  assert.ok(!serialized.includes('9栋8单元701室'), '登录列表缓存失效后不得泄露新精确地址')
  return timing
}

function assertDomainFallbackProjection() {
  const guestDomain = loadFreshDomain()
  const guestDb = performanceDb({ canonical: false, count: FALLBACK_LISTING_COUNT })
  const guestSnapshot = JSON.stringify(guestDb)
  const guestTiming = assertWarmProjectionReused(
    '生产游客库外地点真冷启动',
    () => guestDomain.filterListings(JSON.parse(guestSnapshot), { publicGuest: true }),
    { expectedCount: FALLBACK_LISTING_COUNT, maxColdMilliseconds: 1200, maxWarmMilliseconds: 400 }
  )

  const authenticatedDomain = loadFreshDomain()
  const authenticatedDb = performanceDb({ canonical: false, count: FALLBACK_LISTING_COUNT })
  authenticatedDb.listings.forEach((listing, index) => {
    listing.viewingKeyLocation = `钥匙柜-${index + 1}`
    listing.viewingPassword = `开门密码-${index + 1}`
    listing.remark = `敏感备注-${index + 1}`
  })
  const authenticatedSnapshot = JSON.stringify(authenticatedDb)
  const authenticatedTiming = assertWarmProjectionReused(
    '生产登录库外地点真冷启动',
    () => authenticatedDomain.filterListings(JSON.parse(authenticatedSnapshot), {}),
    { expectedCount: FALLBACK_LISTING_COUNT, maxColdMilliseconds: 1600, maxWarmMilliseconds: 500 }
  )
  assertPartnerSecretsHidden('生产库外地点', authenticatedDomain.filterListings(authenticatedDb, {}))
  return { guestTiming, authenticatedTiming }
}

function mockListingPayload(index, options = {}) {
  const listing = partnerListing(index, options)
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

function seedMock(mockData, options = {}, count = LISTING_COUNT) {
  mockData.loginByPhone('13800010005')
  for (let index = 0; index < count; index += 1) {
    mockData.addNormalListing(mockListingPayload(index, options))
  }
}

function assertMockGuestProjection() {
  const mockData = loadFreshMock()
  seedMock(mockData)
  mockData.logout()
  const timing = assertWarmProjectionReused(
    'Mock 游客列表真冷启动',
    () => mockData.getListings({ publicGuest: true }),
    { maxColdMilliseconds: 2000, maxWarmMilliseconds: 600 }
  )
  return timing
}

function assertMockAuthenticatedProjection() {
  const mockData = loadFreshMock()
  seedMock(mockData)
  const timing = assertWarmProjectionReused(
    'Mock 登录列表真冷启动',
    () => mockData.getListings({}),
    { maxColdMilliseconds: 3000, maxWarmMilliseconds: 700 }
  )
  assertPartnerSecretsHidden('Mock', mockData.getListings({}))
  const pollutedPayload = mockListingPayload(LISTING_COUNT + 1)
  pollutedPayload.city = '杭州 19900009999'
  pollutedPayload.district = '拱墅区 douyin.com/privateprofile'
  pollutedPayload.area = pollutedPayload.district
  pollutedPayload.block = '万达 9栋8单元701室'
  pollutedPayload.community = '万达广场 19900009999'
  pollutedPayload.communityName = pollutedPayload.community
  pollutedPayload.address = '杭州拱墅区万达广场9栋8单元701室'
  pollutedPayload.contact = '19900009999'
  pollutedPayload.landlordPhone = pollutedPayload.contact
  const polluted = mockData.addNormalListing(pollutedPayload)
  const publicRow = mockData.getListings({ publicGuest: true }).find((item) => item.id === polluted.id)
  assert.ok(publicRow, 'Mock 污染位置样本必须仍按有效合作房源返回公开卡片')
  assertPollutedLocationFallsBack('Mock 游客', publicRow)
  return timing
}

function assertMockFallbackProjection() {
  const guestMock = loadFreshMock()
  seedMock(guestMock, { canonical: false }, FALLBACK_LISTING_COUNT)
  guestMock.logout()
  const guestTiming = assertWarmProjectionReused(
    'Mock 游客库外地点真冷启动',
    () => guestMock.getListings({ publicGuest: true }),
    { expectedCount: FALLBACK_LISTING_COUNT, maxColdMilliseconds: 1200, maxWarmMilliseconds: 400 }
  )

  const authenticatedMock = loadFreshMock()
  seedMock(authenticatedMock, { canonical: false }, FALLBACK_LISTING_COUNT)
  const authenticatedTiming = assertWarmProjectionReused(
    'Mock 登录库外地点真冷启动',
    () => authenticatedMock.getListings({}),
    { expectedCount: FALLBACK_LISTING_COUNT, maxColdMilliseconds: 1500, maxWarmMilliseconds: 500 }
  )
  assertPartnerSecretsHidden('Mock 库外地点', authenticatedMock.getListings({}))
  return { guestTiming, authenticatedTiming }
}

const contextCache = assertContextCacheScanResistance()
const domainContextCache = assertDomainContextCacheWiring()
const mockContextCache = assertMockContextCacheWiring()
const domainGuestTiming = assertDomainGuestProjection()
const domainAuthenticatedTiming = assertDomainAuthenticatedProjection()
const domainFallbackTiming = assertDomainFallbackProjection()
const mockGuestTiming = assertMockGuestProjection()
const mockAuthenticatedTiming = assertMockAuthenticatedProjection()
const mockFallbackTiming = assertMockFallbackProjection()
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
const domainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain.js'), 'utf8')
const mockSource = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'mock-data.js'), 'utf8')
assert.ok(indexSource.includes('domain.publicListingIds(db)'), '媒体资格集合必须使用轻量领域层 ID helper')
assert.ok(!indexSource.includes('domain.filterListings(db, { publicGuest: true })'), '媒体装饰不得为资格集合再次重投影全库游客 DTO')
assert.ok(indexSource.includes('createUniqueListingIndex'), '媒体装饰必须一次构建唯一 id→房源索引，不能逐行 O(n²) find')
assert.ok(domainSource.includes('createGuestPublicContextCache') && domainSource.includes('prepareGuestPublicContextCache'), '生产列表必须接入扫描抗性上下文缓存')
assert.ok(mockSource.includes('createGuestPublicContextCache') && mockSource.includes('prepareGuestPublicContextCache'), 'Mock 必须与生产共用扫描抗性缓存策略')
assert.ok(domainSource.includes('strictPartnerLocationText'), '生产规范地点必须走服务端权威值快路径')
assert.ok(mockSource.includes('strictPartnerLocationText'), 'Mock 规范地点必须与生产保持同一严格快路径')
console.log(`PUBLIC_LISTING_PROJECTION_PERFORMANCE PASS cache=${contextCache.first.contextMisses}→${contextCache.edited.contextMisses} wired[domain=${domainContextCache.first.contextMisses}→${domainContextCache.repeated.contextMisses}/${domainContextCache.edited.contextMisses} mock=${mockContextCache.first.contextMisses}→${mockContextCache.repeated.contextMisses}/${mockContextCache.edited.contextMisses}] canonical[guest=${domainGuestTiming.cold.toFixed(1)}→${domainGuestTiming.warm.toFixed(1)}ms auth=${domainAuthenticatedTiming.cold.toFixed(1)}→${domainAuthenticatedTiming.warm.toFixed(1)}ms mockGuest=${mockGuestTiming.cold.toFixed(1)}→${mockGuestTiming.warm.toFixed(1)}ms mockAuth=${mockAuthenticatedTiming.cold.toFixed(1)}→${mockAuthenticatedTiming.warm.toFixed(1)}ms] fallback256[guest=${domainFallbackTiming.guestTiming.cold.toFixed(1)}→${domainFallbackTiming.guestTiming.warm.toFixed(1)}ms auth=${domainFallbackTiming.authenticatedTiming.cold.toFixed(1)}→${domainFallbackTiming.authenticatedTiming.warm.toFixed(1)}ms mockGuest=${mockFallbackTiming.guestTiming.cold.toFixed(1)}→${mockFallbackTiming.guestTiming.warm.toFixed(1)}ms mockAuth=${mockFallbackTiming.authenticatedTiming.cold.toFixed(1)}→${mockFallbackTiming.authenticatedTiming.warm.toFixed(1)}ms]`)
