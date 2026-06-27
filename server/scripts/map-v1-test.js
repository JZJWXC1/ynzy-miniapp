const assert = require('assert')
const domain = require('../src/domain')

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
assert.strictEqual(jingyang.listingCount, 2, '同小区多套房源应聚合为一个点')
assert.deepStrictEqual(jingyang.activeListingIds.sort(), ['L1', 'L2'], '聚合点应返回有效房源 id')
assert.strictEqual(jingyang.minRent, 2200, 'minRent 应正确')
assert.strictEqual(jingyang.maxRent, 3500, 'maxRent 应正确')

assert(!byCommunity(rows, '无坐标小区'), '无坐标房源不会进入地图')
assert(!byCommunity(rows, '默认中心小区'), '默认中心坐标不会进入地图')
assert(!byCommunity(rows, '散列估算小区'), '区域估算或散列坐标不会进入地图')
assert(!byCommunity(rows, '旧偏移小区'), 'legacy map offset 坐标不会进入地图')
assert(!byCommunity(rows, '手填未验证小区'), '未验证的手填经纬度不会进入地图')
assert(!byCommunity(rows, '兴业杨家府'), '坐标库中的估算来源不会进入地图')
assert(byCommunity(rows, '管理员确认小区'), 'coordinateVerified 为 true 的管理员坐标可以进入地图')
assert(!byCommunity(rows, '待审核小区'), '待审核房源不会进入地图')
assert(!byCommunity(rows, '已失效小区'), '已失效房源不会进入地图')
assert(!byCommunity(rows, '华丰欣苑'), '7 天未维护房源不会进入地图')

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
