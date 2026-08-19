'use strict'

const assert = require('assert')
const path = require('path')
const domain = require('../src/domain')

const repoRoot = path.resolve(__dirname, '..', '..')
const clientOptions = require(path.join(repoRoot, 'utils', 'listing-filter-options'))
const now = new Date().toISOString()

function companyListing(id, district, block, community, overrides = {}) {
  return {
    id,
    title: `${community}测试房源`,
    shortTitle: community,
    source: '公司房源',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    city: '杭州',
    district,
    area: district,
    block,
    community,
    rent: 3200,
    layout: '2室1厅',
    room: '二室',
    hall: '1厅',
    bath: '1卫',
    rentMode: '整租',
    type: '整租',
    mapLatitude: 30.4,
    mapLongitude: 120.25,
    coordinateVerified: true,
    coordinateSource: 'admin-verified-coordinate',
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    ...overrides
  }
}

const db = {
  users: [],
  listings: [
    companyListing('DYN-LINPING', '临平区', '星桥', '星桥花苑'),
    companyListing('DYN-YUNCHENG', '云城区', '未来板块', '未来花苑'),
    companyListing('DYN-EXPIRED', '过期区', '过期板块', '过期花苑', {
      status: '已下架',
      lifecycleStatus: 'expired'
    })
  ]
}

assert.strictEqual(typeof domain.listingFilterOptions, 'function', '领域层必须提供安全的动态房源筛选元数据')
const options = domain.listingFilterOptions(db)
assert.deepStrictEqual(options.regionOptions, [
  { name: '临平区', blocks: ['星桥'] },
  { name: '云城区', blocks: ['未来板块'] }
], '动态区域和板块必须来自当前有效公开房源，且排序稳定')
assert.ok(!JSON.stringify(options).includes('过期区'), '废房源不得污染小程序动态筛选项')
assert.deepStrictEqual(options.layoutOptions, ['不限', '一室', '两室', '三室', '三室以上'], '户型筛选口径必须统一')
assert.deepStrictEqual(options.rentModeOptions, ['全部', '整租', '合租'], '整合租筛选口径必须统一')

const normalized = clientOptions.normalizeListingFilterOptions({
  regionOptions: [
    { name: ' 云城区 ', blocks: ['未来板块', '未来板块', ' 新板块 '] },
    { name: '', blocks: ['不得出现'] }
  ]
})
assert.deepStrictEqual(normalized.regionOptions, [
  { name: '云城区', blocks: ['新板块', '未来板块'] }
], '客户端必须清洗、去重动态区域板块，不得信任脏响应')
assert.deepStrictEqual(
  clientOptions.blocksForDistrict(options.regionOptions, '临平区'),
  ['星桥'],
  '选择行政区后只能展示其下属板块'
)
assert.deepStrictEqual(
  clientOptions.blocksForDistrict(options.regionOptions, ''),
  ['星桥', '未来板块'],
  '未选择行政区时可展示全部板块'
)

const mapIds = domain.mapCommunities(db, { layout: '两室' })
  .flatMap((item) => item.activeListingIds || [])
assert.ok(mapIds.includes('DYN-LINPING'), '地图“两室”必须匹配飞书规范户型“2室1厅”')
assert.ok(mapIds.includes('DYN-YUNCHENG'), '地图语义户型不得因新行政区而误筛')
assert.deepStrictEqual(
  domain.mapCommunities(db, { district: '临平区', block: '星桥' })
    .flatMap((item) => item.activeListingIds || []),
  ['DYN-LINPING'],
  '地图必须真正消费行政区和下属板块，不能只在客户端显示选项'
)
assert.deepStrictEqual(
  domain.mapCommunities(db, { district: '云城区', block: '星桥' }),
  [],
  '地图行政区与板块必须按从属关系组合筛选，不能把不同区域的板块混在一起'
)

const exactDb = {
  users: [{ id: 'USER-EXACT', name: '筛选测试账号' }],
  favorites: [
    { id: 'FAV-EXACT-A', userId: 'USER-EXACT', listingId: 'EXACT-A', createdAt: now },
    { id: 'FAV-EXACT-B', userId: 'USER-EXACT', listingId: 'EXACT-B', createdAt: now },
    { id: 'FAV-EXACT-C', userId: 'USER-EXACT', listingId: 'EXACT-C', createdAt: now }
  ],
  listings: [
    companyListing('EXACT-A', '甲区', '东新', '同名花苑', {
      mapLatitude: 30.1,
      mapLongitude: 120.1
    }),
    companyListing('EXACT-B', '乙区', '东新园', '同名花苑', {
      mapLatitude: 30.5,
      mapLongitude: 120.5
    }),
    companyListing('EXACT-C', '甲区', '东新园', '相似板块花苑', {
      mapLatitude: 30.2,
      mapLongitude: 120.2
    }),
    companyListing('EXPIRED-EXACT-A', '甲区', '东新', '废房源甲', {
      status: '已下架',
      lifecycleStatus: 'expired'
    }),
    companyListing('EXPIRED-EXACT-B', '甲区', '东新园', '废房源乙', {
      status: '已下架',
      lifecycleStatus: 'expired'
    })
  ]
}
assert.deepStrictEqual(
  domain.filterListings(exactDb, { district: '甲', block: '东新' }).map((item) => item.id),
  ['EXACT-A'],
  '公开列表的结构化行政区和板块必须等值匹配，不能把东新园混入东新'
)
assert.deepStrictEqual(
  domain.mapCommunities(exactDb, { district: '甲区', block: '东新' })
    .flatMap((item) => item.activeListingIds),
  ['EXACT-A'],
  '地图的结构化行政区和板块必须等值匹配'
)
assert.deepStrictEqual(
  domain.favoriteListings(exactDb, 'USER-EXACT', { district: '甲区', block: '东新' })
    .map((item) => item.id),
  ['EXACT-A'],
  '收藏页的结构化行政区和板块必须等值匹配'
)
assert.deepStrictEqual(
  domain.expiredListings(exactDb, { district: '甲区', block: '东新' })
    .map((item) => item.id),
  ['EXPIRED-EXACT-A'],
  '废房源池的结构化行政区和板块必须等值匹配'
)

const sameNameGroups = domain.mapCommunities(exactDb, {})
  .filter((item) => item.community === '同名花苑')
assert.strictEqual(sameNameGroups.length, 2, '不同行政区或板块的同名小区必须生成两个地图点')
assert.strictEqual(new Set(sameNameGroups.map((item) => item.groupId)).size, 2, '同名小区地图点必须有不同的稳定分组 ID')
assert.deepStrictEqual(
  sameNameGroups.map((item) => [item.district, item.block, item.activeListingIds[0]]).sort(),
  [['乙区', '东新园', 'EXACT-B'], ['甲区', '东新', 'EXACT-A']].sort(),
  '每个同名小区地图点必须保留自己的行政区、板块和房源'
)

console.log('dynamic-listing-filter-options-v1-test: PASS')
