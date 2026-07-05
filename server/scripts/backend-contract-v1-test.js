const assert = require('assert')
process.env.COMPANY_CONTACT_PHONES = process.env.COMPANY_CONTACT_PHONES || '10000000001,10000000002'

const domain = require('../src/domain')
const feishuSync = require('../src/feishu-sync')
const locationMap = require('../src/location-map')
const backfillDistricts = require('./backfill-listing-districts')
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
  assert.strictEqual(companyNoVideoDetail.commissionText, '公司房源成交不抽佣，带看中介全佣', '公司房源详情必须展示带看中介全佣文案')
  assert.strictEqual(companyNoVideoDetail.videoUrl, '', '公司房源无视频时详情不能伪造视频')
  assert.strictEqual(companyNoVideoDetail.sensitiveLocked, false, '公司房源详情地址电话必须直接公开')
  assert.deepStrictEqual(companyNoVideoDetail.companyContactPhones, ['10000000001', '10000000002'], '公司房源详情必须下发服务端配置电话')
  assert.strictEqual(companyNoVideoDetail.landlordPhone, '10000000001/10000000002', '公司房源详情电话必须使用公司看房电话')

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
  function markSyncedCompanyListing(detail) {
    const listing = db.listings.find((item) => item.id === detail.id)
    listing.status = '在租'
    listing.reviewStatus = '无需审核'
    listing.communityMatched = true
    listing.communityMatchStatus = '已匹配'
    listing.requiresManualReview = false
    return listing
  }
  const dongxinyuanListing = domain.addNormalListing(db, 'ADMIN', listingPayload({
    district: '拱墅区',
    area: '拱墅区',
    block: '东新园',
    communityName: '东新园测试小区',
    community: '东新园测试小区',
    roomNo: '204',
    roomNumber: '204',
    address: '杭州拱墅区东新园测试小区2幢1单元204室',
    rent: 4200,
    layout: '整租两室一厅一卫',
    source: '公司房源',
    companyListing: true,
    requiresManualReview: false,
    videoKey: ''
  }), { admin: true })
  markSyncedCompanyListing(dongxinyuanListing)
  const fourRoomListing = domain.addNormalListing(db, 'ADMIN', listingPayload({
    district: '拱墅区',
    area: '拱墅区',
    block: '东新园',
    communityName: '东新园测试小区',
    community: '东新园测试小区',
    roomNo: '404',
    roomNumber: '404',
    address: '杭州拱墅区东新园测试小区4幢1单元404室',
    rent: 6200,
    layout: '整租四室两厅两卫',
    source: '公司房源',
    companyListing: true,
    requiresManualReview: false,
    videoKey: ''
  }), { admin: true })
  markSyncedCompanyListing(fourRoomListing)
  assert.ok(domain.filterListings(db, {
    district: '拱墅区',
    block: '东新园',
    layout: '两室',
    rentMin: 3000,
    rentMax: 5000
  }).some((item) => item.id === dongxinyuanListing.id), '前台列表应支持拱墅区+东新园+两室+3000-5000 组合筛选')
  assert.ok(domain.filterListings(db, { layout: '三室以上' }).some((item) => item.id === fourRoomListing.id), '三室以上应包含四室及更多户型')
  assert.ok(!domain.filterListings(db, { layout: '三室以上' }).some((item) => item.id === dongxinyuanListing.id), '三室以上不应包含两室')
  ;['小洋坝家园一区', '小洋坝家园二区', '小洋坝家园三区', '大华海派风景', '风雅乐府', '瑷颐湾'].forEach((community) => {
    assert.strictEqual(locationMap.districtForLocation({
      community,
      block: '祥符'
    }), '余杭区', `${community} 小区级行政区覆盖必须优先于板块映射`)
    assert.strictEqual(locationMap.blockForLocation({
      community,
      block: '祥符'
    }), '城北万象城', `${community} 小区级板块覆盖必须固定为城北万象城`)
  })
  assert.strictEqual(locationMap.districtForLocation({
    community: '普通万达小区',
    block: '万达'
  }), '拱墅区', '未配置小区覆盖时应继续按板块映射')
  const yuhangSyncedRow = feishuSync.normalizeRecord({
    fields: {
      小区: '风雅乐府',
      板块: '祥符',
      房号: '1-1-101',
      户型描述: '两室一厅一卫',
      租金: '4200'
    }
  }, 0)
  assert.strictEqual(yuhangSyncedRow.area, '余杭区', '飞书同步应按小区覆盖写入余杭区')
  assert.strictEqual(yuhangSyncedRow.block, '城北万象城', '飞书同步应按小区覆盖写入城北万象城板块')
  const backfillDb = {
    listings: [
      { id: 'YH1', community: '小洋坝家园一区', block: '祥符', district: '拱墅区', area: '拱墅区', companyListing: true },
      { id: 'GS1', community: '普通万达小区', block: '万达', district: '', area: '', companyListing: true },
      { id: 'SC1', community: '闸弄口小区', block: '闸弄口', district: '', area: '', companyListing: true }
    ]
  }
  const backfillResult = backfillDistricts.backfill(backfillDb)
  assert.strictEqual(backfillDb.listings[0].district, '余杭区', '回填应把小区覆盖房源改为余杭区')
  assert.strictEqual(backfillDb.listings[0].area, '余杭区', '回填应同步更新 area')
  assert.strictEqual(backfillDb.listings[0].block, '城北万象城', '回填应把小区覆盖房源改为城北万象城板块')
  assert.deepStrictEqual(backfillResult.distribution, { '余杭区': 1, '拱墅区': 1, '上城区': 1 }, '回填分布应覆盖三区')

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
  domain.updateListingCoordinate(db, 'U1', reliableMapListing.id, { latitude: 31.111, longitude: 121.222 })
  const correctedPin = domain.mapPins(db).find((item) => item.community === '京漾东韵府')
  assert.strictEqual(correctedPin.latitude, 31.111, '后台人工修正坐标必须优先于已有小区坐标库')
  assert.strictEqual(correctedPin.longitude, 121.222, '后台人工修正坐标必须真正进入地图点位')

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
  assert.strictEqual(sheetCompanyRows.length, 0, '公司房源列表必须只读取同步后的房源库，不能混入飞书快照虚拟房源')
  const upperBlockRows = domain.filterListings(db, { district: '上城区', block: '闸弄口' })
  assert.ok(upperBlockRows.every((item) => item.district === '上城区' && String(item.block || '').indexOf('闸弄口') !== -1), '上城区+闸弄口筛选不能混入其他行政区或板块')
  const sheetMapPins = domain.mapPins(db, { sourceType: '公司房源' })
  assert.ok(!sheetMapPins.some((item) => String(item.id || '').indexOf('CS') === 0), '地图也不能混入飞书快照虚拟房源')
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
    id: 'STALE_3',
    title: '三天提醒房源',
    shortTitle: '三天提醒房源',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租一室',
    area: '滨江区',
    community: '滨江金色黎明',
    address: '三天提醒地址',
    landlordPhone: '13911113333',
    commissionRate: 20,
    videoUrl: 'https://example.com/stale-3.mp4',
    status: '在租',
    lifecycleStatus: 'active',
    lastVerifiedAt: daysAgo(3),
    createdAt: daysAgo(3)
  })
  const stale3 = domain.adminListings(db).find((item) => item.id === 'STALE_3')
  assert.ok(stale3, '第 3 天提醒房源必须存在于后台清单')
  assert.strictEqual(stale3.verifyStatus, '提醒核验', '第 3 天档必须进入提醒核验（区别于第 5 天的重点核验）')
  assert.strictEqual(stale3.needsVerify, true, '第 3 天档必须标记需核验')
  assert.ok(stale3.staleDays >= 3 && stale3.staleDays < 5, '第 3 天档 staleDays 应落在 [3,5)')

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
  // 3/5 天档只提醒不下架：enforce 后仍为 active 且留在前台列表，防止档位阈值被误改成下架
  const stale3AfterEnforce = db.listings.find((item) => item.id === 'STALE_3')
  const stale5AfterEnforce = db.listings.find((item) => item.id === 'STALE_5')
  assert.strictEqual(stale3AfterEnforce.lifecycleStatus, 'active', '第 3 天档只提醒不下架')
  assert.strictEqual(stale5AfterEnforce.lifecycleStatus, 'active', '第 5 天档只提醒不下架')
  assert.ok(domain.filterListings(db).some((item) => item.id === 'STALE_3'), '第 3 天档仍应出现在前台列表')

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
  assert.strictEqual(companyConfirm.noCommission, true, '公司房源确认签单必须标记不抽佣')
  assert.strictEqual(db.dealRecords.find((item) => item.id === companyDeal.id).commissionRecordId, '', '公司房源签单不能挂载 commissionRecordId')
  assert.strictEqual(db.commissionRecords.length, beforeCompanyCommissionCount, '公司房源确认签单不能增加分佣记录')

  const convertedCompany = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '半山家苑',
    community: '半山家苑',
    roomNo: '778',
    roomNumber: '778',
    address: '杭州滨江区半山家苑1幢1单元778室',
    videoKey: 'house-videos/backend-contract/company-to-partner.mp4'
  }))
  const convertedCompanyRaw = db.listings.find((item) => item.id === convertedCompany.id)
  Object.assign(convertedCompanyRaw, {
    source: '公司房源',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    noCommission: true,
    commissionRate: 0,
    features: ['不分佣', '押一付一', '电梯房']
  })
  assert.strictEqual(domain.isNoCommissionListing(convertedCompanyRaw), true, '测试前公司房源应命中免佣 OR 链')
  domain.updateNormalListing(db, 'ADMIN', convertedCompany.id, {
    area: convertedCompanyRaw.area,
    block: convertedCompanyRaw.block,
    community: convertedCompanyRaw.community,
    building: convertedCompanyRaw.building,
    unit: convertedCompanyRaw.unit,
    roomNumber: convertedCompanyRaw.roomNumber,
    rentMode: convertedCompanyRaw.rentMode,
    room: convertedCompanyRaw.room,
    hall: convertedCompanyRaw.hall,
    bath: convertedCompanyRaw.bath,
    rent: convertedCompanyRaw.rent,
    contact: convertedCompanyRaw.landlordPhone,
    ownerType: '二房东房源',
    companyListing: false,
    features: [NO_FEATURE]
  }, { admin: true })
  assert.strictEqual(convertedCompanyRaw.companyListing, false, '公司房源改为二房东后 companyListing 必须清除')
  assert.strictEqual(convertedCompanyRaw.isCompanyListing, false, '公司房源改为二房东后 isCompanyListing 必须清除')
  assert.strictEqual(domain.isCompanyListing(convertedCompanyRaw), false, '公司房源改为二房东后来源文本也不能继续命中公司房源')
  assert.strictEqual(convertedCompanyRaw.noCommission, false, '公司房源改为二房东后不得沿用免佣状态')
  assert.strictEqual(convertedCompanyRaw.commissionRate, 15, '公司房源改为二房东后必须重算上传人 15% 分佣')
  assert.strictEqual(convertedCompanyRaw.features.indexOf('不分佣'), -1, '公司房源改为二房东后必须清理不分佣特点')
  assert.strictEqual(domain.isNoCommissionListing(convertedCompanyRaw), false, '公司房源改为二房东后免佣 OR 链必须整体为 false')
  const convertedReportResult = domain.createClientReport(db, 'U2', convertedCompany.id, {
    needId: 'N1',
    customerPhone: '13800005555'
  })
  const convertedReport = db.clientReports.find((item) => item.id === convertedReportResult.report.id)
  const convertedDealResult = domain.createDealFromReport(db, 'U2', convertedReport.id, {
    monthlyRent: 3500,
    landlordCommission: 5000
  })
  const convertedDeal = db.dealRecords.find((item) => item.id === convertedDealResult.deal.id)
  const convertedConfirm = domain.confirmDeal(db, 'ADMIN', convertedDeal.id)
  assert.strictEqual(convertedConfirm.commissionRecord.rate, 20, '转为二房东后的房源成交总比例必须恢复 20%')
  assert.strictEqual(convertedConfirm.commissionRecord.uploaderRate, 15, '转为二房东后的房源上传人必须拿 15%')
  assert.strictEqual(convertedConfirm.commissionRecord.uploaderCommissionFen, 75000, '转为二房东后的房源上传人分佣必须按 15% 计算')

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

  assert.strictEqual(domain.commissionConfig(db).secondLandlordRate, 15, '默认二房东上传人比例为 15%')
  const savedCommissionConfig = domain.setCommissionConfig(db, 'ADMIN', {
    secondLandlordRate: 12,
    ownerRate: 18
  })
  assert.strictEqual(savedCommissionConfig.secondLandlordRate, 12, '分佣配置应允许调整二房东上传人比例')
  assert.strictEqual(savedCommissionConfig.ownerRate, 18, '分佣配置应允许调整业主上传人比例')
  assert.ok(db.footprints.some((item) => item.action === '调整分佣配置'), '分佣配置变更必须写足迹')
  assert.strictEqual(db.commissionRecords.find((item) => item.id === confirmResult.commissionRecord.id).uploaderRate, 15, '旧分佣记录不受后续配置调整影响')

  const configurableListing = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '半山家苑',
    community: '半山家苑',
    roomNo: '780',
    roomNumber: '780',
    address: '杭州滨江区半山家苑1幢1单元780室',
    videoKey: 'house-videos/backend-contract/configurable-second.mp4'
  }))
  const configurableRaw = db.listings.find((item) => item.id === configurableListing.id)
  assert.strictEqual(configurableRaw.commissionRate, 12, '配置改为 12 后新二房东房源应写入 12% 上传人比例')
  const configurableDetail = domain.listingDetail(db, configurableListing.id)
  assert.strictEqual(configurableDetail.commissionText, '成交总比例按房东实付佣金的 20% 计算', '二房东详情黄条只展示成交总比例')
  assert.ok(!/平台|抽成/.test(configurableDetail.commissionText), '二房东详情黄条不得出现平台抽成字样')
  const configurableReportResult = domain.createClientReport(db, 'U2', configurableListing.id, {
    needId: 'N1',
    customerPhone: '13800006666'
  })
  const configurableReport = db.clientReports.find((item) => item.id === configurableReportResult.report.id)
  const configurableDealResult = domain.createDealFromReport(db, 'U2', configurableReport.id, {
    monthlyRent: 3500,
    landlordCommission: 5000
  })
  const configurableDeal = db.dealRecords.find((item) => item.id === configurableDealResult.deal.id)
  assert.deepStrictEqual(configurableDeal.commissionRule, { rate: 20, uploaderRate: 12, platformRate: 8 }, '签单应冻结当前二房东 12% 分佣配置')
  const configurableConfirm = domain.confirmDeal(db, 'ADMIN', configurableDeal.id)
  assert.strictEqual(configurableConfirm.commissionRecord.uploaderRate, 12, '配置改为 12 后新成交按 12% 结算')
  assert.strictEqual(configurableConfirm.commissionRecord.platformRate, 8, '配置改为 12 后平台留存为 8%')
  assert.strictEqual(configurableConfirm.commissionRecord.uploaderCommissionFen, 60000, '房东实付佣金 5000 元时 12% 为 600 元')
  assert.strictEqual(configurableConfirm.commissionRecord.platformCommissionFen, 40000, '房东实付佣金 5000 元时 8% 为 400 元')

  const configurableOwner = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    roomNo: '902',
    roomNumber: '902',
    address: '杭州上城区京漾东韵府1幢1单元902室',
    ownerType: '业主房源',
    houseSourceType: '业主房源',
    source: '业主房源',
    videoKey: 'house-videos/backend-contract/configurable-owner.mp4'
  }))
  domain.reviewOwnerListing(db, 'ADMIN', configurableOwner.id, { action: 'approve' })
  const configurableOwnerDetail = domain.listingDetail(db, configurableOwner.id)
  assert.strictEqual(configurableOwnerDetail.commissionText, '管理员确认签单后，上传人按房东实付佣金的 18% 结算', '业主详情黄条应展示当前业主上传人比例')
  const configurableOwnerReportResult = domain.createClientReport(db, 'U2', configurableOwner.id, {
    needId: 'N1',
    customerPhone: '13800007777'
  })
  const configurableOwnerReport = db.clientReports.find((item) => item.id === configurableOwnerReportResult.report.id)
  const configurableOwnerDealResult = domain.createDealFromReport(db, 'U2', configurableOwnerReport.id, {
    monthlyRent: 3500,
    landlordCommission: 5000
  })
  const configurableOwnerDeal = db.dealRecords.find((item) => item.id === configurableOwnerDealResult.deal.id)
  assert.deepStrictEqual(configurableOwnerDeal.commissionRule, { rate: 20, uploaderRate: 18, platformRate: 2 }, '签单应冻结当前业主 18% 分佣配置')
  const configurableOwnerConfirm = domain.confirmDeal(db, 'ADMIN', configurableOwnerDeal.id)
  assert.strictEqual(configurableOwnerConfirm.commissionRecord.uploaderRate, 18, '配置改为 18 后新业主成交按 18% 结算')
  assert.strictEqual(configurableOwnerConfirm.commissionRecord.uploaderCommissionFen, 90000, '房东实付佣金 5000 元时 18% 为 900 元')

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
