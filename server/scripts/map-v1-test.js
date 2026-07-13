const assert = require('assert')
const domain = require('../src/domain')
const {
  communityCoordinates,
  isReliableCoordinateSource
} = require('../src/community-coordinates')

const NOW = new Date().toLocaleString('zh-CN', { hour12: false })
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 86400000).toLocaleString('zh-CN', { hour12: false })

function listing(overrides) {
  return {
    id: 'L0',
    title: '测试房源',
    shortTitle: '测试小区',
    uploaderId: 'U001',
    rent: 2500,
    layout: '整租一室一厅一卫',
    city: '杭州',
    district: '上城区',
    area: '上城区',
    block: '艮北',
    community: '京漾东韵府',
    building: '1幢',
    unit: '1单元',
    roomNumber: '101',
    address: '杭州市上城区京漾东韵府1幢1单元101',
    landlordPhone: '13800000000',
    commissionRate: 20,
    videoUrl: 'https://example.com/video.mp4',
    status: '待确认',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: '整租',
    rentMode: '整租',
    source: '普通上传',
    lastVerifiedAt: NOW,
    updatedAt: NOW,
    createdAt: NOW,
    ...overrides
  }
}

function testDb() {
  return {
    users: [{ id: 'U001', name: '测试中介' }],
    listings: [
      listing({ id: 'L1', rent: 2200, layout: '整租一室一厅一卫' }),
      listing({ id: 'L2', rent: 3500, layout: '整租两室一厅一卫' }),
      listing({ id: 'L3', community: '无坐标小区', mapLatitude: '', mapLongitude: '', coordinateSource: 'pending-map-coordinate' }),
      listing({
        id: 'L4',
        community: '默认中心小区',
        mapLatitude: 30.3192,
        mapLongitude: 120.1694,
        coordinateSource: 'default-center',
        coordinateVerified: true
      }),
      listing({
        id: 'L5',
        community: '散列估算小区',
        mapLatitude: 30.326,
        mapLongitude: 120.178,
        coordinateSource: 'estimated-by-area',
        coordinateVerified: true
      }),
      listing({
        id: 'L6',
        community: '旧偏移小区',
        mapLatitude: 30.321,
        mapLongitude: 120.171,
        coordinateSource: 'legacy-map-offset',
        coordinateVerified: true
      }),
      listing({
        id: 'L7',
        community: '手填未验证小区',
        mapLatitude: 30.312,
        mapLongitude: 120.166,
        coordinateSource: 'listing-coordinate',
        coordinateVerified: false
      }),
      listing({
        id: 'L8',
        community: '兴业杨家府',
        rent: 2600
      }),
      listing({
        id: 'L8A',
        community: '腾讯近似小区',
        mapLatitude: 30.318,
        mapLongitude: 120.162,
        coordinateSource: 'tencent-geocode',
        coordinateVerified: false,
        coordinateLevel: 'approximate',
        coordinateStatus: '近似位置'
      }),
      listing({
        id: 'L8B',
        community: '板块中心小区',
        mapLatitude: 30.333,
        mapLongitude: 120.128,
        coordinateSource: 'block-center:万达',
        coordinateVerified: false,
        coordinateLevel: 'block-center',
        coordinateStatus: '板块中心近似位置'
      }),
      listing({
        id: 'L9',
        community: '管理员确认小区',
        rent: 4800,
        layout: '整租三室一厅一卫',
        mapLatitude: 30.35,
        mapLongitude: 120.16,
        coordinateSource: 'admin-verified-coordinate',
        coordinateVerified: true
      }),
      listing({
        id: 'L10',
        community: '待审核小区',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        requiresManualReview: true,
        reviewStatus: '待审核',
        status: '待审核',
        coordinateVerified: true,
        mapLatitude: 30.36,
        mapLongitude: 120.18,
        coordinateSource: 'admin-verified-coordinate'
      }),
      listing({
        id: 'L11',
        community: '已失效小区',
        lifecycleStatus: 'expired',
        status: '已下架',
        coordinateVerified: true,
        mapLatitude: 30.37,
        mapLongitude: 120.19,
        coordinateSource: 'admin-verified-coordinate'
      }),
      listing({
        id: 'L12',
        community: '华丰欣苑',
        lastVerifiedAt: EIGHT_DAYS_AGO,
        updatedAt: EIGHT_DAYS_AGO
      }),
      listing({
        id: 'L13',
        community: '缺素材公司房源小区',
        rent: 3100,
        videoUrl: '',
        videoKey: '',
        source: '公司房源',
        ownerType: '公司房源',
        houseSourceType: '公司房源',
        companyListing: true,
        isCompanyListing: true,
        noCommission: true,
        mapLatitude: 30.352,
        mapLongitude: 120.152,
        coordinateSource: 'admin-verified-coordinate',
        coordinateVerified: true
      })
    ]
  }
}

function communities(filter) {
  return domain.mapCommunities(testDb(), filter || {})
}

function byCommunity(rows, community) {
  return rows.find((item) => item.community === community)
}

const rows = communities()
assert.strictEqual(communities({ rentMin: '', rentMax: '' }).length, rows.length, '空租金参数不应误过滤地图结果')
const jingyang = byCommunity(rows, '京漾东韵府')
assert(jingyang, '标准小区坐标可以进入地图')
assert.strictEqual(jingyang.coordinateVerified, false, '合作房源公共地图不得把小区点标成逐套精确坐标')
assert.strictEqual(jingyang.coordinateLevel, 'approximate', '合作房源公共地图统一按小区近似位置展示')
assert.strictEqual(jingyang.listingCount, 2, '同小区多套房源应聚合为一个点')
assert.deepStrictEqual(jingyang.activeListingIds.sort(), ['L1', 'L2'], '聚合点应返回有效房源 id')
assert.strictEqual(jingyang.minRent, 2200, 'minRent 应正确')
assert.strictEqual(jingyang.maxRent, 3500, 'maxRent 应正确')

assert(!byCommunity(rows, '无坐标小区'), '无坐标房源不会进入地图')
assert(!byCommunity(rows, '默认中心小区'), '默认中心坐标不会进入地图')
assert(!byCommunity(rows, '散列估算小区'), '区域估算或散列坐标不会进入地图')
assert(!byCommunity(rows, '旧偏移小区'), 'legacy map offset 坐标不会进入地图')
assert(!byCommunity(rows, '手填未验证小区'), '未验证的手填经纬度不会进入地图')
assert(Object.entries(communityCoordinates).every(([, coordinate]) => (
  isReliableCoordinateSource(coordinate.source)
)), '坐标库不能保留估算、散列、默认中心或待确认来源')
assert(byCommunity(rows, '兴业杨家府'), '已补可靠 POI 坐标的小区应进入地图')
const approximate = byCommunity(rows, '腾讯近似小区')
assert(approximate, '腾讯地理编码近似坐标应进入地图')
assert.strictEqual(approximate.coordinateLevel, 'approximate', '腾讯地理编码点应标记 approximate')
assert.strictEqual(approximate.coordinateCalloutNote, '近似位置', '近似坐标 callout 应注明近似位置')
const blockCenter = byCommunity(rows, '板块中心小区')
assert(blockCenter, '地理编码失败后的板块中心兜底应进入地图')
assert.strictEqual(blockCenter.coordinateLevel, 'approximate', '合作房源公共地图不得暴露内部板块中心坐标等级')
assert.strictEqual(blockCenter.coordinateCalloutNote, '近似位置', '合作房源板块中心兜底对外只标记为小区近似位置')
const adminVerified = byCommunity(rows, '管理员确认小区')
assert(adminVerified, '内部已核实坐标的合作房源仍可按近似小区位置进入地图')
assert.strictEqual(adminVerified.coordinateVerified, false, '逐套管理员核实坐标不得在公共地图标为精确')
assert.strictEqual(adminVerified.coordinateLevel, 'approximate', '逐套管理员核实坐标对外必须降为近似位置')
assert.notStrictEqual(adminVerified.coordinateSource, 'admin-verified-coordinate', '公共地图不得泄露逐套管理员核实坐标来源')
assert(!byCommunity(rows, '待审核小区'), '待审核房源不会进入地图')
assert(!byCommunity(rows, '已失效小区'), '已失效房源不会进入地图')
assert(!byCommunity(rows, '华丰欣苑'), '7 天未维护房源不会进入地图')
const missingVideoCompany = byCommunity(rows, '缺素材公司房源小区')
assert(missingVideoCompany, '无视频公司房源应进入地图聚合')
assert.strictEqual(missingVideoCompany.listingCount, 1, '无视频公司房源应计入地图套数')
assert.deepStrictEqual(missingVideoCompany.activeListingIds, ['L13'], '无视频公司房源应返回可打开详情的房源 id')
assert.strictEqual(missingVideoCompany.listings[0].hasVideo, false, '无视频公司房源地图侧边卡不应显示视频标签')
assert.strictEqual(missingVideoCompany.listings[0].video, '', '无视频公司房源地图摘要不应携带视频文案')

const bounded = communities({
  north: 30.285,
  south: 30.275,
  east: 120.205,
  west: 120.198
})
assert.strictEqual(bounded.length, 1, '经纬度边界筛选应只返回范围内小区')
assert.strictEqual(bounded[0].community, '京漾东韵府', '边界筛选返回的小区应正确')

const listingIdFiltered = communities({ listingIds: 'L9,L3' })
assert.strictEqual(listingIdFiltered.length, 1, 'listingIds 筛选应生效')
assert.strictEqual(listingIdFiltered[0].community, '管理员确认小区', 'listingIds 应兼容英文逗号分隔')

const listingIdArrayFiltered = communities({ listingIds: ['L1', 'L2'] })
assert.strictEqual(listingIdArrayFiltered.length, 1, 'listingIds 应兼容数组形式')
assert.strictEqual(listingIdArrayFiltered[0].listingCount, 2, 'listingIds 数组筛选后聚合数量应正确')

function mapRowForOrder(listings, community) {
  return domain.mapCommunities({ users: [{ id: 'U001', name: '测试中介' }], listings })
    .find((item) => item.community === community)
}

const mixedCompany = listing({
  id: 'L-MIXED-COMPANY',
  community: '混合顺序小区',
  source: '公司房源',
  ownerType: '公司房源',
  houseSourceType: '公司房源',
  companyListing: true,
  isCompanyListing: true,
  noCommission: true,
  mapLatitude: 30.411,
  mapLongitude: 120.411,
  coordinateSource: 'tencent-geocode contact privateid 19900007777',
  coordinateVerified: false,
  coordinateLevel: 'approximate',
  coordinateStatus: '近似位置 contact privateid 19900007777'
})
const mixedPartner = listing({
  id: 'L-MIXED-PARTNER',
  community: '混合顺序小区',
  mapLatitude: 30.499,
  mapLongitude: 120.499,
  coordinateSource: 'admin-verified-coordinate',
  coordinateVerified: true,
  coordinateLevel: 'verified'
})
const mixedCompanyFirst = mapRowForOrder([mixedCompany, mixedPartner], '混合顺序小区')
const mixedPartnerFirst = mapRowForOrder([mixedPartner, mixedCompany], '混合顺序小区')
assert(mixedCompanyFirst && mixedPartnerFirst, '公司/合作混合小区必须进入地图')
assert.strictEqual(mixedCompanyFirst.latitude, mixedPartnerFirst.latitude, '混合小区代表点不能受房源遍历顺序影响')
assert.strictEqual(mixedCompanyFirst.longitude, mixedPartnerFirst.longitude, '混合小区经度不能受房源遍历顺序影响')
assert.strictEqual(mixedCompanyFirst.latitude, mixedCompany.mapLatitude, '公司房源公开坐标必须优先于合作房源近似点')
assert.strictEqual(mixedCompanyFirst.coordinateSource, 'approximate-geocode', '公司公开坐标来源必须映射到固定服务端枚举')
assert.strictEqual(mixedCompanyFirst.coordinateStatus, '近似位置', '公司公开坐标状态必须由可信级别固定生成')
assert.ok(!JSON.stringify(mixedCompanyFirst).includes('privateid') && !JSON.stringify(mixedCompanyFirst).includes('19900007777'), '公司公开坐标元数据不得夹带联系方式')

const partnerApproximate = listing({
  id: 'L-PARTNER-APPROXIMATE',
  community: '合作顺序小区',
  mapLatitude: 30.433,
  mapLongitude: 120.433,
  coordinateSource: 'tencent-geocode',
  coordinateVerified: false,
  coordinateLevel: 'approximate'
})
const partnerVerified = listing({
  id: 'L-PARTNER-VERIFIED',
  community: '合作顺序小区',
  mapLatitude: 30.486,
  mapLongitude: 120.486,
  coordinateSource: 'admin-verified-coordinate',
  coordinateVerified: true,
  coordinateLevel: 'verified'
})
const partnerApproximateFirst = mapRowForOrder([partnerApproximate, partnerVerified], '合作顺序小区')
const partnerVerifiedFirst = mapRowForOrder([partnerVerified, partnerApproximate], '合作顺序小区')
assert(partnerApproximateFirst && partnerVerifiedFirst, '纯合作房源小区必须进入地图')
assert.strictEqual(partnerApproximateFirst.latitude, partnerVerifiedFirst.latitude, '纯合作小区代表点不能受房源遍历顺序影响')
assert.strictEqual(partnerApproximateFirst.longitude, partnerVerifiedFirst.longitude, '纯合作小区经度不能受房源遍历顺序影响')
assert.strictEqual(partnerApproximateFirst.latitude, 30.49, '内部可信合作坐标只可经约一公里粒度投影后作为代表点')
assert.strictEqual(partnerApproximateFirst.coordinateVerified, false, '合作房源代表点始终不得对外标成逐套精确')

const exactCoordinateProbe = domain.mapCommunities({
  users: [{ id: 'U001', name: '测试中介' }],
  listings: [partnerVerified]
}, {
  north: 30.4865,
  south: 30.4855,
  east: 120.4865,
  west: 120.4855
})
assert.strictEqual(exactCoordinateProbe.length, 0, '地图边界筛选不得以合作房源内部精确点形成探测 oracle')
const publicCoordinateProbe = domain.mapCommunities({
  users: [{ id: 'U001', name: '测试中介' }],
  listings: [partnerVerified]
}, {
  north: 30.491,
  south: 30.489,
  east: 120.491,
  west: 120.489
})
assert.strictEqual(publicCoordinateProbe.length, 1, '地图边界筛选应按合作房源公开近似点命中')

function walk(value, visitor) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor))
    return
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => {
      visitor(key, value[key])
      walk(value[key], visitor)
    })
  }
}

const sensitiveKeys = new Set(['address', 'landlordPhone', 'roomNumber', 'building', 'unit'])
walk(rows, (key, value) => {
  assert(!sensitiveKeys.has(key), `地图返回值不应包含敏感字段：${key}`)
  const text = String(value || '')
  assert(text.indexOf('13800000000') === -1, '地图返回值不应包含房东电话')
  assert(text.indexOf('1单元') === -1, '地图返回值不应包含单元号')
  assert(text !== '101', '地图返回值不应包含房号')
})

console.log('map-v1-test passed')
