const assert = require('assert')
const domain = require('../src/domain')

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function baseListing(overrides = {}) {
  const now = nowText()
  return {
    id: 'BASE',
    title: '结构化来源测试房源',
    shortTitle: '结构化来源测试小区',
    uploaderId: 'U1',
    rent: 3600,
    layout: '整租两室一厅',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '测试板块',
    community: '结构化来源测试小区',
    address: '杭州拱墅区结构化来源测试小区1幢1单元101室',
    status: '在租',
    reviewStatus: '已通过',
    lifecycleStatus: 'active',
    communityMatched: true,
    communityMatchStatus: '已匹配',
    requiresManualReview: false,
    type: '整租',
    rentMode: '整租',
    videoUrl: 'https://example.com/source-structure.mp4',
    videoKey: '',
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    ...overrides
  }
}

function run() {
  const db = {
    users: [
      { id: 'U1', name: '测试中介', phone: '13900000001', role: '中介', authed: '已实名' }
    ],
    listings: [
      baseListing({
        id: 'COMPANY_DESC_OWNER',
        title: '臻棠樾府公司房源',
        shortTitle: '臻棠樾府',
        community: '臻棠樾府',
        layout: '业主自主精装修两室一厅',
        source: '公司房源',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        companyListing: true,
        isCompanyListing: true,
        noCommission: true,
        commissionRate: 0,
        videoUrl: '',
        videoKey: '',
        reviewStatus: '无需审核'
      }),
      baseListing({
        id: 'REAL_OWNER',
        title: '真实业主房源',
        shortTitle: '真实业主小区',
        community: '真实业主小区',
        layout: '整租两室一厅',
        source: '业主房源',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        companyListing: false,
        isCompanyListing: false,
        noCommission: false,
        commissionRate: 20,
        reviewStatus: '已通过'
      })
    ],
    footprints: [],
    rentalNeeds: [],
    clientReports: [],
    dealRecords: [],
    commissionRecords: []
  }

  const migration = domain.migrateCompanyListings(db)
  const migratedCompany = db.listings.find((item) => item.id === 'COMPANY_DESC_OWNER')
  assert.strictEqual(migration.changed, true, '迁移应纠正存量公司房源误分类字段')
  assert.strictEqual(migratedCompany.source, '公司房源', '公司房源 source 必须回填为公司枚举')
  assert.strictEqual(migratedCompany.ownerType, '公司房源', '公司房源 ownerType 必须回填为公司枚举')
  assert.strictEqual(migratedCompany.houseSourceType, '公司房源', '公司房源 houseSourceType 必须回填为公司枚举')
  assert.strictEqual(migratedCompany.companyListing, true, '公司房源 companyListing 必须为 true')
  assert.strictEqual(migratedCompany.isCompanyListing, true, '公司房源 isCompanyListing 必须为 true')
  assert.strictEqual(migratedCompany.noCommission, true, '公司房源必须不分佣')
  assert.strictEqual(migratedCompany.commissionRate, 0, '公司房源佣金率必须归零')

  const ownerIds = domain.filterListings(db, { category: '业主房源' }).map((item) => item.id)
  const companyIds = domain.filterListings(db, { category: '公司房源' }).map((item) => item.id)
  const allIds = domain.filterListings(db, {}).map((item) => item.id)
  assert.ok(!ownerIds.includes('COMPANY_DESC_OWNER'), '描述或户型含“业主”的公司房源不得进入业主筛选')
  assert.ok(ownerIds.includes('REAL_OWNER'), '真实业主房源仍应进入业主筛选')
  assert.ok(companyIds.includes('COMPANY_DESC_OWNER'), '公司房源仍应进入公司专区')
  assert.ok(allIds.includes('COMPANY_DESC_OWNER'), '公司房源无视频仍应进入全部房源')
  assert.ok(allIds.includes('REAL_OWNER'), '真实业主房源有视频且审核通过应进入全部房源')
  assert.strictEqual(domain.dashboardSummary(db).listingCount, allIds.length, '首页统计应与全部房源使用同一前台有效口径')

  console.log('listing-source-structure-test passed')
}

run()
