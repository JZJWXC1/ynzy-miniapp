'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const domain = require('../src/domain')

const now = new Date().toISOString()

function expiredListing(id, overrides = {}) {
  return {
    id,
    title: `废房源 ${id}`,
    shortTitle: `废房源 ${id}`,
    source: '公司房源',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    status: '已下架',
    lifecycleStatus: 'expired',
    expiredAt: now,
    city: '杭州',
    district: '云城区',
    area: '云城区',
    block: '未来板块',
    community: '未来花苑',
    rent: 3200,
    layout: '2室1厅',
    room: '二室',
    rentMode: '整租',
    type: '整租',
    updatedAt: now,
    createdAt: now,
    ...overrides
  }
}

const db = {
  users: [],
  listings: [
    expiredListing('EXACT'),
    expiredListing('WRONG-RENT', { rent: 4200 }),
    expiredListing('WRONG-LAYOUT', { layout: '3室1厅', room: '三室' }),
    expiredListing('WRONG-MODE', { rentMode: '合租', type: '合租' }),
    expiredListing('WRONG-SOURCE', {
      source: '业主房源',
      ownerType: '业主房源',
      houseSourceType: '业主房源',
      companyListing: false,
      isCompanyListing: false
    }),
    expiredListing('ACTIVE', { status: '在租', lifecycleStatus: 'active' })
  ]
}

const rows = domain.expiredListings(db, {
  district: '云城区',
  block: '未来板块',
  community: '未来花苑',
  sourceType: '公司房源',
  rentMin: 3000,
  rentMax: 3500,
  layout: '两室',
  rentMode: '整租'
})
assert.deepStrictEqual(rows.map((item) => item.id), ['EXACT'], '废房源池多维筛选必须按 AND 精确生效')
assert.deepStrictEqual(
  domain.expiredListings(db, { layout: '两室' }).map((item) => item.id).sort(),
  ['EXACT', 'WRONG-MODE', 'WRONG-RENT', 'WRONG-SOURCE'].sort(),
  '废房源池户型必须兼容“2室1厅”与“两室”的语义匹配'
)
assert.deepStrictEqual(
  domain.expiredListingFilterOptions(db).regionOptions,
  [{ name: '云城区', blocks: ['未来板块'] }],
  '废房源池必须从完整废房源集合生成独立区域/板块元数据，不能复用排除废房源的公开元数据'
)

const privateExpired = expiredListing('PRIVATE-LOCATION', {
  source: '业主房源',
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  companyListing: false,
  isCompanyListing: false,
  district: '西湖区文三路99号',
  area: '西湖区文三路99号',
  block: '文三路99号',
  community: '内部待整理小区'
})
const privateDb = { users: [], listings: [privateExpired] }
const privateOptions = domain.expiredListingFilterOptions(privateDb)
assert.deepStrictEqual(
  privateOptions.regionOptions,
  [{ name: '西湖区文三路99号', blocks: ['文三路99号'] }],
  '管理员废房源元数据必须与废房源列表使用同一位置真值，不能改用游客清洗值'
)
assert.deepStrictEqual(
  domain.expiredListings(privateDb, {
    district: privateOptions.regionOptions[0].name,
    block: privateOptions.regionOptions[0].blocks[0]
  }).map((item) => item.id),
  ['PRIVATE-LOCATION'],
  '废房源下拉选项必须能回查出生成该选项的同一房源'
)

const adminHtml = fs.readFileSync(path.resolve(__dirname, '..', '..', 'admin-web', 'index.html'), 'utf8')
;[
  'expiredDistrictFilter',
  'expiredBlockFilter',
  'expiredCommunityFilter',
  'expiredSourceFilter',
  'expiredRentMinFilter',
  'expiredRentMaxFilter',
  'expiredLayoutFilter',
  'expiredRentModeFilter'
].forEach((id) => {
  assert.ok(adminHtml.includes(`id="${id}"`), `废房源池必须拥有独立筛选控件：${id}`)
})
assert.ok(
  /renderExpiredListings[\s\S]*expiredDistrictFilter\.value[\s\S]*expiredRentModeFilter\.value/.test(adminHtml),
  '废房源池请求必须读取自己的完整筛选条件，不能偷用房源管理页控件'
)
assert.ok(
  adminHtml.includes('/admin/expired-listing-filter-options'),
  '废房源池必须读取管理员专用元数据，不能复用仅覆盖有效公开房源的接口'
)

console.log('expired-listing-filters-v1-test: PASS')
