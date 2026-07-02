const assert = require('assert')
const domain = require('../src/domain')
const { NO_FEATURE } = require('../src/listing-features')

const DAY = 24 * 60 * 60 * 1000

function daysAgo(days) {
  return new Date(Date.now() - days * DAY).toISOString()
}

function createDb() {
  return {
    users: [
      { id: 'U1', name: '上传人', phone: '13900000001', role: '中介', authed: '已实名' },
      { id: 'U2', name: '成交中介', phone: '13900000002', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', phone: '13900000003', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [],
    rentalNeeds: [
      {
        id: 'N1',
        brokerId: 'U2',
        rawText: '客户找滨江两室，预算 4500',
        confirmedNeed: { area: '滨江区', layout: '两室', budgetMax: 4500 },
        status: 'active'
      }
    ],
    footprints: [],
    pointLogs: [],
    commissionRecords: [],
    clientReports: [],
    dealRecords: []
  }
}

function listingPayload(overrides = {}) {
  return {
    city: '杭州',
    district: '滨江区',
    area: '滨江区',
    block: '滨江区',
    communityName: '后端契约测试小区',
    community: '后端契约测试小区',
    buildingNo: '1',
    building: '1',
    unitNo: '1',
    unit: '1',
    roomNo: '101',
    roomNumber: '101',
    address: '杭州滨江区后端契约测试小区1幢1单元101室',
    contact: '13911112222',
    rent: 3500,
    layout: '整租两室一厅一卫',
    videoKey: 'house-videos/backend-contract/test.mp4',
    features: [NO_FEATURE],
    commissionRate: 3,
    brokerId: 'EVIL_BROKER',
    uploaderId: 'EVIL_UPLOADER',
    ...overrides
  }
}

function assertRejects(fn, check, message) {
  let failed = false
  try {
    fn()
  } catch (error) {
    failed = true
    assert.ok(check(error), message || error.message)
  }
  if (!failed) throw new Error(message || '预期抛出错误')
}

function assertNoPublicSensitiveFields(row, context) {
  const forbiddenKeys = ['building', 'unit', 'roomNumber', 'roomAddress', 'uploaderPhone', 'landlordPhone']
  forbiddenKeys.forEach((key) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, key), `${context} 不能返回 ${key}`)
  })
  const text = JSON.stringify(row)
  assert.ok(text.indexOf('1幢') === -1, `${context} 不能返回楼栋`)
  assert.ok(text.indexOf('1单元') === -1, `${context} 不能返回单元`)
  assert.ok(text.indexOf('101室') === -1, `${context} 不能返回房号`)
  assert.ok(text.indexOf('13911112222') === -1, `${context} 不能返回房东电话`)
  assert.ok(text.indexOf('13900000001') === -1, `${context} 不能返回上传人电话`)
}

function run() {
  const db = createDb()

  const rule = domain.listingMaintenanceRule(db)
  assert.deepStrictEqual(rule.remindDays, [3, 5], '房态提醒必须是第 3 天和第 5 天')
  assert.strictEqual(rule.expireDays, 7, '房态自动失效必须是第 7 天')

  assertRejects(
    () => domain.addNormalListing(db, 'U1', listingPayload({ videoKey: '', videoUrl: '' })),
    (error) => error.statusCode === 400 && /视频/.test(error.message),
    '新增房源必须要求 videoUrl 或 videoKey'
  )

  const created = domain.addNormalListing(db, 'U1', listingPayload())
  const createdRaw = db.listings.find((item) => item.id === created.id)
  assert.strictEqual(createdRaw.uploaderId, 'U1', '房源上传人必须来自服务端当前用户')
  assert.strictEqual(createdRaw.commissionRate, 20, '客户端 commissionRate 不能覆盖固定 20%')
  assert.strictEqual(createdRaw.videoKey, 'house-videos/backend-contract/test.mp4', '只有 videoKey 也应视为有真实视频')
  assert.strictEqual(createdRaw.coordinateSource, 'pending-map-coordinate', '无可靠小区坐标时不能写入默认地图坐标')

  const listRow = domain.filterListings(db).find((item) => item.id === created.id)
  const matchRow = domain.matchListings(db, { area: '后端契约测试小区' }).listings.find((item) => item.id === created.id)
  const detailRow = domain.listingDetail(db, created.id)
  assert.ok(listRow && matchRow && detailRow, '前台列表、匹配和详情应返回有效房源')
  assertNoPublicSensitiveFields(listRow, '前台列表')
  assertNoPublicSensitiveFields(matchRow, '匹配候选')
  assertNoPublicSensitiveFields(detailRow, '前台详情')
  assert.notStrictEqual(detailRow.address, listingPayload().address, '前台详情不能返回完整地址')

  const reliableMapListing = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    address: '杭州上城区京漾东韵府1幢1单元101室',
    videoKey: 'house-videos/backend-contract/map-real.mp4'
  }))
  const mapPins = domain.mapPins(db)
  const realPin = mapPins.find((item) => item.community === '京漾东韵府')
  assert.ok(realPin, '地图必须展示可靠小区坐标')
  assert.strictEqual(realPin.coordinateVerified, true, '地图点必须是已确认坐标')
  assert.ok(realPin.listingCount >= 1, '地图点应按小区聚合房源')
  assertNoPublicSensitiveFields(realPin, '地图小区点')
  ;(realPin.listings || []).forEach((item) => assertNoPublicSensitiveFields(item, '地图房源摘要'))

  const clientCoordinateListing = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '客户端手填坐标小区',
    community: '客户端手填坐标小区',
    mapLatitude: 30.22,
    mapLongitude: 120.22,
    latitude: 30.22,
    longitude: 120.22,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    videoKey: 'house-videos/backend-contract/client-coordinate.mp4'
  }))
  assert.ok(domain.filterListings(db).some((item) => item.id === clientCoordinateListing.id), '无可靠坐标房源可以进入普通列表')
  assert.ok(!domain.mapPins(db).some((item) => (item.activeListingIds || []).indexOf(clientCoordinateListing.id) !== -1), '客户端手填坐标不能进入地图')

  db.listings.unshift({
    id: 'DEFAULT_CENTER',
    title: '默认中心点房源',
    shortTitle: '默认中心点房源',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租一室',
    area: '滨江区',
    community: '默认中心点小区',
    address: '默认中心点地址',
    landlordPhone: '13911116666',
    commissionRate: 20,
    videoUrl: 'https://example.com/default-center.mp4',
    status: '在租',
    lifecycleStatus: 'active',
    mapLatitude: 30.3192,
    mapLongitude: 120.1694,
    coordinateSource: 'default-center',
    coordinateVerified: true,
    lastVerifiedAt: daysAgo(1),
    createdAt: daysAgo(1)
  })
  db.listings.unshift({
    id: 'LEGACY_OFFSET',
    title: '旧偏移坐标房源',
    shortTitle: '旧偏移坐标房源',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租一室',
    area: '滨江区',
    community: '旧偏移小区',
    address: '旧偏移地址',
    landlordPhone: '13911117777',
    commissionRate: 20,
    videoUrl: 'https://example.com/legacy-offset.mp4',
    status: '在租',
    lifecycleStatus: 'active',
    mapLeft: 60,
    mapTop: 40,
    coordinateSource: 'legacy-map-offset',
    lastVerifiedAt: daysAgo(1),
    createdAt: daysAgo(1)
  })
  assert.ok(!domain.mapPins(db).some((item) => (item.activeListingIds || []).indexOf('DEFAULT_CENTER') !== -1), '默认中心点不能进入地图')
  assert.ok(!domain.mapPins(db).some((item) => (item.activeListingIds || []).indexOf('LEGACY_OFFSET') !== -1), 'legacy offset 不能进入地图')

  db.listings.unshift({
    id: 'LEGACY_NO_VIDEO',
    title: '历史无视频房源',
    shortTitle: '历史无视频房源',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租一室',
    area: '滨江区',
    community: '历史小区',
    address: '历史地址',
    landlordPhone: '13911113333',
    commissionRate: 20,
    status: '在租',
    lifecycleStatus: 'active',
    lastVerifiedAt: daysAgo(1),
    createdAt: daysAgo(1)
  })
  assert.ok(!domain.filterListings(db).some((item) => item.id === 'LEGACY_NO_VIDEO'), '前台列表必须排除无视频历史房源')
  assert.ok(!domain.matchListings(db, { area: '历史小区' }).listings.some((item) => item.id === 'LEGACY_NO_VIDEO'), '匹配必须排除无视频历史房源')
  assert.strictEqual(domain.listingDetail(db, 'LEGACY_NO_VIDEO'), null, '前台详情必须排除无视频历史房源')

  db.listings.unshift({
    id: 'STALE_5',
    title: '五天提醒房源',
    shortTitle: '五天提醒房源',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租一室',
    area: '滨江区',
    community: '提醒小区',
    address: '提醒地址',
    landlordPhone: '13911114444',
    commissionRate: 20,
    videoUrl: 'https://example.com/stale-5.mp4',
    status: '在租',
    lifecycleStatus: 'active',
    lastVerifiedAt: daysAgo(5),
    createdAt: daysAgo(5)
  })
  const stale5 = domain.adminListings(db).find((item) => item.id === 'STALE_5')
  assert.ok(stale5 && stale5.needsVerify && stale5.staleDays >= 5, '第 5 天必须进入再次提醒')

  db.listings.unshift({
    id: 'STALE_7',
    title: '七天失效房源',
    shortTitle: '七天失效房源',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租一室',
    area: '滨江区',
    community: '失效小区',
    address: '失效地址',
    landlordPhone: '13911115555',
    commissionRate: 20,
    videoUrl: 'https://example.com/stale-7.mp4',
    status: '在租',
    lifecycleStatus: 'active',
    lastVerifiedAt: daysAgo(7),
    createdAt: daysAgo(7)
  })
  const maintenance = domain.enforceListingMaintenanceRule(db)
  const stale7 = db.listings.find((item) => item.id === 'STALE_7')
  assert.ok(maintenance.expiredCount >= 1, '第 7 天未更新必须自动失效')
  assert.strictEqual(stale7.lifecycleStatus, 'expired', '自动失效必须进入失效生命周期')
  assert.ok(stale7.expiredPool, '自动失效必须保留后台资产池标记')
  assert.ok(!domain.filterListings(db).some((item) => item.id === 'STALE_7'), '失效房源不能进入前台列表')

  assertRejects(
    () => domain.createClientReport(db, 'U2', created.id, { customerName: '王先生' }),
    (error) => error.statusCode === 400 && /手机号/.test(error.message),
    '报备客户手机号必须必填'
  )
  const reportResult = domain.createClientReport(db, 'U2', created.id, {
    needId: 'N1',
    customerName: '王先生',
    customerPhone: '13800001111',
    brokerId: 'EVIL_BROKER'
  })
  const report = db.clientReports.find((item) => item.id === reportResult.report.id)
  assert.strictEqual(report.brokerId, 'U2', '报备 brokerId 必须来自服务端当前用户')
  assert.strictEqual(report.customerName, '王先生', '客户称呼可选但应保存传入值')

  assertRejects(
    () => domain.registerDeal(db, 'U2', created.id),
    (error) => error.statusCode === 400 && /报备/.test(error.message),
    '签单不能绕过报备直接从房源发起'
  )
  assert.strictEqual(db.commissionRecords.length, 0, '旧直签入口不能生成分佣记录')

  const dealResult = domain.createDealFromReport(db, 'U2', report.id, {
    monthlyRent: 3500,
    landlordCommission: 5000,
    remark: '测试签单',
    commissionRate: 99,
    brokerId: 'EVIL_BROKER',
    uploaderId: 'EVIL_UPLOADER'
  })
  const deal = db.dealRecords.find((item) => item.id === dealResult.deal.id)
  assert.strictEqual(deal.brokerId, 'U2', '签单 brokerId 必须来自报备记录')
  assert.strictEqual(deal.uploaderId, 'U1', '签单 uploaderId 必须来自房源归属')
  assert.strictEqual(deal.dealMonthlyRentFen, 350000, '成交月租必须按分存储')
  assert.strictEqual(deal.landlordCommissionFen, 500000, '房东实际支付佣金必须按分存储')
  assert.ok(!Object.prototype.hasOwnProperty.call(deal, 'commissionRate'), '签单不能保存客户端 commissionRate')
  assert.strictEqual(db.commissionRecords.length, 0, '管理员确认前不能生成正式分佣记录')

  const confirmResult = domain.confirmDeal(db, 'ADMIN', deal.id)
  assert.strictEqual(db.commissionRecords.length, 1, '管理员确认后必须生成正式分佣记录')
  assert.strictEqual(confirmResult.commissionRecord.rate, 20, '正式分佣比例必须固定 20%')
  assert.strictEqual(confirmResult.commissionRecord.uploaderCommissionFen, 100000, '上传人分佣必须等于房东实际支付佣金的 20%')
  assert.strictEqual(confirmResult.commissionRecord.landlordCommissionFen, 500000, '正式分佣记录必须保留房东实付佣金分值')
  assert.strictEqual(db.listings.find((item) => item.id === created.id).lifecycleStatus, 'sold', '确认签单后房源应退出前台有效池')
  assert.ok(!domain.filterListings(db).some((item) => item.id === created.id), '已成交房源不能继续在前台展示')

  console.log('backend-contract-v1-test passed')
}

run()
