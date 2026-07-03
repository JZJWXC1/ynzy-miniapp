const assert = require('assert')
const domain = require('../src/domain')
const {
  NO_FEATURE,
  LISTING_FEATURE_OPTIONS,
  normalizeListingFeatures
} = require('../src/listing-features')

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
    communityName: '半山家苑',
    community: '半山家苑',
    buildingNo: '1',
    building: '1',
    unitNo: '1',
    unit: '1',
    roomNo: '101',
    roomNumber: '101',
    address: '杭州滨江区半山家苑1幢1单元101室',
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
  assert.ok(text.indexOf('4-2-601D') === -1, `${context} 不能返回飞书房号`)
  assert.ok(text.indexOf('1-1-101') === -1, `${context} 不能返回飞书房号`)
  assert.ok(text.indexOf('336699#') === -1, `${context} 不能返回看房密码`)
  assert.ok(text.indexOf('123456#') === -1, `${context} 不能返回看房密码`)
  assert.ok(text.indexOf('13911112222') === -1, `${context} 不能返回房东电话`)
  assert.ok(text.indexOf('13900000001') === -1, `${context} 不能返回上传人电话`)
}

function assertCompanySheetPublicFields(row, context) {
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'roomNumber'), `${context} 应返回公司房号字段`)
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'roomAddress'), `${context} 应返回公司房号地址字段`)
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'viewingPassword'), `${context} 应返回看房密码字段`)
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'remark'), `${context} 应返回备注字段`)
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

  const companyNoVideo = domain.addNormalListing(db, 'ADMIN', listingPayload({
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    roomNo: '102',
    roomNumber: '102',
    address: '杭州上城区京漾东韵府1幢1单元102室',
    source: '公司房源',
    companyListing: true,
    videoKey: '',
    videoUrl: ''
  }), { admin: true })
  assert.ok(domain.filterListings(db, { category: '公司房源' }).some((item) => item.id === companyNoVideo.id), '公司房源允许无视频进入前台列表')
  const companyNoVideoDetail = domain.listingDetail(db, companyNoVideo.id)
  assert.ok(companyNoVideoDetail, '公司房源无视频也应可打开前台详情')
  assert.strictEqual(companyNoVideoDetail.noCommission, true, '公司房源详情必须展示无分佣')
  assert.strictEqual(companyNoVideoDetail.videoUrl, '', '公司房源无视频时详情不能伪造视频')

  const created = domain.addNormalListing(db, 'U1', listingPayload())
  const createdRaw = db.listings.find((item) => item.id === created.id)
  assert.strictEqual(createdRaw.uploaderId, 'U1', '房源上传人必须来自服务端当前用户')
  assert.strictEqual(createdRaw.commissionRate, 15, '客户端 commissionRate 不能覆盖二房东固定 15%')
  assert.strictEqual(createdRaw.videoKey, 'house-videos/backend-contract/test.mp4', '只有 videoKey 也应视为有真实视频')
  assert.strictEqual(createdRaw.coordinateSource, 'pending-map-coordinate', '无可靠小区坐标时不能写入默认地图坐标')
  assert.ok(LISTING_FEATURE_OPTIONS.indexOf('带露台（阁楼）') !== -1, '上传特点必须允许选择带露台（阁楼）')
  assert.strictEqual(LISTING_FEATURE_OPTIONS.indexOf('可带看'), -1, '上传特点必须停止新选可带看')
  assert.strictEqual(LISTING_FEATURE_OPTIONS.indexOf('急租'), -1, '上传特点必须停止新选急租')
  assert.ok(normalizeListingFeatures(['可带看', '急租']).indexOf('可带看') !== -1, '存量可带看标签应兼容保留')
  assert.ok(normalizeListingFeatures(['可带看', '急租']).indexOf('急租') !== -1, '存量急租标签应兼容保留')
  const terraceListing = domain.addNormalListing(db, 'U1', listingPayload({
    roomNo: '103',
    roomNumber: '103',
    address: '杭州滨江区半山家苑1幢1单元103室',
    features: ['带露台（阁楼）'],
    videoKey: 'house-videos/backend-contract/terrace.mp4'
  }))
  const terraceRaw = db.listings.find((item) => item.id === terraceListing.id)
  assert.ok(terraceRaw.features.indexOf('带露台（阁楼）') !== -1, '新特点带露台（阁楼）应可写入房源')

  const adminSecondLandlordListing = domain.addNormalListing(db, 'ADMIN', listingPayload({
    communityName: '半山家苑',
    community: '半山家苑',
    roomNo: '777',
    roomNumber: '777',
    address: '杭州滨江区半山家苑1幢1单元777室',
    contact: '13911117777',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    videoKey: 'house-videos/backend-contract/admin-second-landlord.mp4'
  }), { admin: true })
  const adminSecondLandlordRaw = db.listings.find((item) => item.id === adminSecondLandlordListing.id)
  assert.strictEqual(adminSecondLandlordRaw.uploaderId, 'ADMIN', '管理员上传二房东房源时上传人必须来自服务端当前管理员')
  assert.strictEqual(adminSecondLandlordRaw.ownerType, '二房东房源', '管理员必须允许上传二房东房源')
  assert.strictEqual(adminSecondLandlordRaw.companyListing, false, '管理员上传二房东房源不能被强制标记为公司房源')
  assert.strictEqual(adminSecondLandlordRaw.commissionRate, 15, '管理员上传二房东房源仍按二房东类型记录上传人到手比例')

  const listRow = domain.filterListings(db).find((item) => item.id === created.id)
  assert.ok(domain.filterListings(db, { rentMode: '整租' }).some((item) => item.id === created.id), '前台列表应支持整租筛选')
  assert.ok(!domain.filterListings(db, { rentMode: '合租' }).some((item) => item.id === created.id), '整租房源不应出现在合租筛选结果')
  assert.ok(domain.filterListings(db, { rentMin: 3000, rentMax: 3600 }).some((item) => item.id === created.id), '前台列表应支持自定义租金区间')
  assert.ok(!domain.filterListings(db, { rentMin: 3601 }).some((item) => item.id === created.id), '低于自定义最低租金的房源应被过滤')
  const matchRow = domain.matchListings(db, { area: '半山家苑' }).listings.find((item) => item.id === created.id)
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

  db.companySheetSnapshot = {
    rows: [
      ['区域', '小区', '房号', '户型描述', '户型分类', '押一付一', '押二付一', '看房方式密码', '备注'],
      ['闸弄口', '京漾东韵府', '4-2-601D', '一室朝南带阳台单间', '一室', '1700', '1400', '336699#', '水30/月'],
      ['闸弄口', '无坐标测试小区', '1-1-101', '一室', '一室', '1200', '1100', '123456#', '水电自理']
    ],
    updatedAt: daysAgo(0),
    cachedAt: daysAgo(0)
  }
  const sheetCompanyRows = domain.filterListings(db, { category: '公司房源' })
    .filter((item) => String(item.id || '').indexOf('CS') === 0)
  const sheetKnownCoordinate = sheetCompanyRows.find((item) => item.community === '京漾东韵府')
  assert.ok(sheetKnownCoordinate, '飞书快照公司房源无视频也应进入公司房源列表')
  assert.ok(sheetCompanyRows.some((item) => item.community === '无坐标测试小区'), '无坐标飞书公司房源可进入普通公司列表')
  sheetCompanyRows.forEach((item) => assertCompanySheetPublicFields(item, '飞书公司房源列表'))
  assert.strictEqual(sheetKnownCoordinate.roomNumber, '4-2-601D', '飞书公司房源列表应返回房号')
  assert.strictEqual(sheetKnownCoordinate.viewingPassword, '336699#', '飞书公司房源列表应返回看房密码')
  assert.strictEqual(sheetKnownCoordinate.remark, '水30/月', '飞书公司房源列表应返回备注')
  const sheetDetail = domain.listingDetail(db, sheetKnownCoordinate.id)
  assert.ok(sheetDetail, '飞书快照公司房源应可打开前台详情')
  assert.strictEqual(sheetDetail.noCommission, true, '飞书快照公司房源详情必须展示无分佣')
  assert.strictEqual(sheetDetail.videoUrl, '', '飞书快照公司房源无视频时详情不能伪造视频')
  assertCompanySheetPublicFields(sheetDetail, '飞书公司房源详情')
  assert.strictEqual(sheetDetail.roomNumber, '4-2-601D', '飞书公司房源详情应返回房号')
  assert.strictEqual(sheetDetail.viewingPassword, '336699#', '飞书公司房源详情应返回看房密码')
  const sheetMapPins = domain.mapPins(db, { sourceType: '公司房源' })
  assert.ok(sheetMapPins.some((item) => item.community === '京漾东韵府'), '飞书快照公司房源命中真实小区坐标时应进入地图')
  assert.ok(!sheetMapPins.some((item) => item.community === '无坐标测试小区'), '飞书快照公司房源无真实坐标时不能进入地图')
  sheetMapPins.forEach((pin) => {
    assertNoPublicSensitiveFields(pin, '飞书公司房源地图点')
    ;(pin.listings || []).forEach((item) => assertNoPublicSensitiveFields(item, '飞书公司房源地图摘要'))
  })

  const clientCoordinateListing = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '北海公园',
    community: '北海公园',
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
    community: '财富壹号',
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
    community: '城市风景',
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
    community: '浜河部落',
    address: '历史地址',
    landlordPhone: '13911113333',
    commissionRate: 20,
    status: '在租',
    lifecycleStatus: 'active',
    lastVerifiedAt: daysAgo(1),
    createdAt: daysAgo(1)
  })
  assert.ok(!domain.filterListings(db).some((item) => item.id === 'LEGACY_NO_VIDEO'), '前台列表必须排除无视频历史房源')
  assert.ok(!domain.matchListings(db, { area: '浜河部落' }).listings.some((item) => item.id === 'LEGACY_NO_VIDEO'), '匹配必须排除无视频历史房源')
  assert.strictEqual(domain.listingDetail(db, 'LEGACY_NO_VIDEO'), null, '前台详情必须排除无视频历史房源')

  db.listings.unshift({
    id: 'STALE_5',
    title: '五天提醒房源',
    shortTitle: '五天提醒房源',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租一室',
    area: '滨江区',
    community: '保利香槟国际',
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
    community: '北景园水镜苑',
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
  assert.strictEqual(confirmResult.commissionRecord.rate, 20, '二房东房源成交总比例必须固定 20%')
  assert.strictEqual(confirmResult.commissionRecord.uploaderRate, 15, '二房东房源上传人到手比例必须固定 15%')
  assert.strictEqual(confirmResult.commissionRecord.platformRate, 5, '二房东房源平台留存比例必须固定 5%')
  assert.strictEqual(confirmResult.commissionRecord.uploaderCommissionFen, 75000, '二房东房源上传人分佣必须等于房东实际支付佣金的 15%')
  assert.strictEqual(confirmResult.commissionRecord.platformCommissionFen, 25000, '二房东房源平台留存必须等于房东实际支付佣金的 5%')
  assert.strictEqual(confirmResult.commissionRecord.landlordCommissionFen, 500000, '正式分佣记录必须保留房东实付佣金分值')
  assert.strictEqual(db.listings.find((item) => item.id === created.id).lifecycleStatus, 'sold', '确认签单后房源应退出前台有效池')
  assert.ok(!domain.filterListings(db).some((item) => item.id === created.id), '已成交房源不能继续在前台展示')

  const ownerListing = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    roomNo: '901',
    roomNumber: '901',
    address: '杭州上城区京漾东韵府1幢1单元901室',
    ownerType: '业主房源',
    houseSourceType: '业主房源',
    source: '业主房源',
    videoKey: 'house-videos/backend-contract/owner.mp4',
    commissionRate: 99
  }))
  const ownerRaw = db.listings.find((item) => item.id === ownerListing.id)
  assert.strictEqual(ownerRaw.commissionRate, 20, '客户端 commissionRate 不能覆盖业主固定 20%')
  domain.reviewOwnerListing(db, 'ADMIN', ownerListing.id, { action: 'approve' })
  const ownerReportResult = domain.createClientReport(db, 'U2', ownerListing.id, {
    needId: 'N1',
    customerPhone: '13800002222'
  })
  const ownerReport = db.clientReports.find((item) => item.id === ownerReportResult.report.id)
  const ownerDealResult = domain.createDealFromReport(db, 'U2', ownerReport.id, {
    monthlyRent: 3500,
    landlordCommission: 5000,
    commissionRate: 99
  })
  const ownerDeal = db.dealRecords.find((item) => item.id === ownerDealResult.deal.id)
  assert.ok(!Object.prototype.hasOwnProperty.call(ownerDeal, 'commissionRate'), '业主签单不能保存客户端 commissionRate')
  const ownerConfirm = domain.confirmDeal(db, 'ADMIN', ownerDeal.id)
  assert.strictEqual(ownerConfirm.commissionRecord.rate, 20, '业主房源成交总比例必须固定 20%')
  assert.strictEqual(ownerConfirm.commissionRecord.uploaderRate, 20, '业主房源上传人到手比例必须固定 20%')
  assert.strictEqual(ownerConfirm.commissionRecord.platformRate, 0, '业主房源平台留存比例必须固定 0%')
  assert.strictEqual(ownerConfirm.commissionRecord.uploaderCommissionFen, 100000, '业主房源上传人分佣必须等于房东实际支付佣金的 20%')
  assert.strictEqual(ownerConfirm.commissionRecord.platformCommissionFen, 0, '业主房源平台留存必须为 0')

  const beforeCompanyCommissionCount = db.commissionRecords.length
  const companyReportResult = domain.createClientReport(db, 'U2', companyNoVideo.id, {
    needId: 'N1',
    customerPhone: '13800003333'
  })
  const companyReport = db.clientReports.find((item) => item.id === companyReportResult.report.id)
  const companyDealResult = domain.createDealFromReport(db, 'U2', companyReport.id, {
    monthlyRent: 3500,
    landlordCommission: 5000,
    commissionRate: 99
  })
  const companyDeal = db.dealRecords.find((item) => item.id === companyDealResult.deal.id)
  assert.deepStrictEqual(companyDeal.commissionRule, { rate: 0, uploaderRate: 0, platformRate: 0 }, '公司房源签单快照必须记录不分佣')
  const companyConfirm = domain.confirmDeal(db, 'ADMIN', companyDeal.id)
  assert.strictEqual(companyConfirm.commissionRecord, null, '公司房源确认签单不能生成分佣记录')
  assert.strictEqual(db.commissionRecords.length, beforeCompanyCommissionCount, '公司房源确认签单不能增加分佣记录')

  const beforeAdminUploadCommissionCount = db.commissionRecords.length
  const adminUploadReportResult = domain.createClientReport(db, 'U2', adminSecondLandlordListing.id, {
    needId: 'N1',
    customerPhone: '13800004444'
  })
  const adminUploadReport = db.clientReports.find((item) => item.id === adminUploadReportResult.report.id)
  const adminUploadDealResult = domain.createDealFromReport(db, 'U2', adminUploadReport.id, {
    monthlyRent: 3500,
    landlordCommission: 5000,
    commissionRate: 99,
    uploaderRate: 99,
    platformRate: 99
  })
  const adminUploadDeal = db.dealRecords.find((item) => item.id === adminUploadDealResult.deal.id)
  assert.ok(!Object.prototype.hasOwnProperty.call(adminUploadDeal, 'commissionRate'), '管理员上传二房东签单不能保存客户端 commissionRate')
  const adminUploadConfirm = domain.confirmDeal(db, 'ADMIN', adminUploadDeal.id)
  assert.strictEqual(db.commissionRecords.length, beforeAdminUploadCommissionCount + 1, '管理员上传的二房东房源成交后必须生成平台留存记录')
  assert.strictEqual(adminUploadConfirm.commissionRecord.rate, 20, '管理员上传二房东房源成交总比例必须固定 20%')
  assert.strictEqual(adminUploadConfirm.commissionRecord.uploaderRate, 0, '管理员上传二房东房源不生成个人分佣比例')
  assert.strictEqual(adminUploadConfirm.commissionRecord.platformRate, 20, '管理员上传二房东房源平台留存比例必须固定 20%')
  assert.strictEqual(adminUploadConfirm.commissionRecord.uploaderCommissionFen, 0, '管理员上传二房东房源上传人分佣必须为 0')
  assert.strictEqual(adminUploadConfirm.commissionRecord.platformCommissionFen, 100000, '管理员上传二房东房源平台留存必须等于房东实付佣金的 20%')

  // 回归用例（2026-07-02 P1 修复）：库外小区裸提交（不带任何匹配/审核字段）
  // 必须由服务端小区库判定为 未匹配 + 待审核，且不得进入首页/前台列表/地图
  const outsidePayload = listingPayload({
    communityName: '库外未知小区ABC',
    community: '库外未知小区ABC',
    roomNumber: '9901',
    videoKey: 'house-videos/contract/outside-community.mp4'
  })
  ;[
    'communityMatched',
    'isCommunityMatched',
    'communityMatchStatus',
    'requiresManualReview',
    'manualReviewRequired'
  ].forEach((field) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(outsidePayload, field), `库外裸提交不得预置 ${field}`)
  })
  const outsideListing = domain.addNormalListing(db, 'U1', outsidePayload)
  const outsideRow = db.listings.find((item) => item.id === outsideListing.id)
  assert.strictEqual(outsideRow.communityMatched, false, '库外小区必须判定为未匹配')
  assert.strictEqual(outsideRow.communityMatchStatus, '未匹配', '库外小区匹配状态必须为未匹配')
  assert.strictEqual(outsideRow.requiresManualReview, true, '库外小区必须进入人工审核')
  assert.strictEqual(outsideRow.status, '待审核', '库外小区业务状态必须为待审核')
  assert.strictEqual(outsideRow.reviewStatus, '待审核', '库外小区审核状态必须为待审核')
  assert.ok(/未匹配/.test(outsideRow.manualReviewReason || ''), '库外小区必须记录未匹配审核原因')
  assert.ok(!domain.homeListings(db).some((item) => item.id === outsideListing.id), '待审核房源不得出现在首页')
  assert.ok(!domain.filterListings(db).some((item) => item.id === outsideListing.id), '待审核房源不得出现在前台列表')
  assert.ok(!domain.mapCommunities(db, {}).some((item) => (item.listings || []).some((row) => row.id === outsideListing.id)), '待审核房源不得出现在地图')
  // 管理员审核通过后方可进入前台
  domain.reviewOwnerListing(db, 'ADMIN', outsideListing.id, { action: 'approve' })
  assert.strictEqual(outsideRow.reviewStatus, '已通过', '审核通过后审核状态应为已通过')
  assert.strictEqual(outsideRow.status, '待确认', '审核通过后业务状态应回到待确认')
  assert.ok(domain.homeListings(db).some((item) => item.id === outsideListing.id), '审核通过后房源应进入首页候选')
  assert.ok(domain.filterListings(db).some((item) => item.id === outsideListing.id), '审核通过后房源应进入前台列表')
  assert.ok(!domain.mapCommunities(db, {}).some((item) => (item.listings || []).some((row) => row.id === outsideListing.id)), '库外小区无可靠坐标，审核通过后仍不得进入地图')

  console.log('backend-contract-v1-test passed')
}

run()
