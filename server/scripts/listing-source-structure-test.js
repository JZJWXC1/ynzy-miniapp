const assert = require('assert')
const fs = require('fs')
const path = require('path')
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
    mapLatitude: 30.31,
    mapLongitude: 120.17,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    ...overrides
  }
}

function run() {
  ;[true, 1, 'true', '1', 'yes', 'y', '是', '公司', '公司房源'].forEach((value) => {
    assert.strictEqual(domain.isCompanyListing({ companyListing: value }), true, `companyListing=${String(value)} 必须保持公司真值兼容`)
    assert.strictEqual(domain.isCompanyListing({ isCompanyListing: value }), true, `isCompanyListing=${String(value)} 必须保持公司真值兼容`)
  })
  ;[false, 0, 'false', '0', 'no', '', null, undefined].forEach((value) => {
    assert.strictEqual(domain.isCompanyListing({ companyListing: value }), false, `companyListing=${String(value)} 不得被当作公司真值`)
    assert.strictEqual(domain.isCompanyListing({ isCompanyListing: value }), false, `isCompanyListing=${String(value)} 不得被当作公司真值`)
  })
  assert.strictEqual(domain.isCompanyListing({ ownerType: '公司房源', houseSourceType: '公司房源' }), false, '仅有合作来源字段不得提升为公司权限')
  assert.strictEqual(domain.isCompanyListing({ source: '公司房源' }), true, 'canonical source 公司枚举必须仍识别为公司')
  assert.strictEqual(domain.isCompanyListing({ source: '公司自营' }), false, '未列入服务端 canonical 的公司近义词不得提升权限')
  assert.strictEqual(domain.isCompanyListing({ source: 'COMPANY' }), false, '服务端既有 company 来源兼容保持区分大小写')
  assert.strictEqual(domain.isCompanyListing({ source: 'company' }), true, '服务端既有小写 company 来源兼容必须保留')
  ;['y', '公司', '公司房源'].forEach((value) => {
    assert.strictEqual(domain.isCompanyListing({ companyOwned: value }), false, `companyOwned=${value} 只允许通用真值，不得套用公司专用兼容`)
  })
  ;[true, 1, 'true', '1', 'yes', '是'].forEach((value) => {
    assert.strictEqual(domain.isCompanyListing({ companyOwned: value }), true, `companyOwned=${String(value)} 必须保留通用真值兼容`)
  })

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
      }),
      baseListing({
        id: 'REAL_SECOND',
        title: '真实二房东房源',
        shortTitle: '真实二房东小区',
        community: '真实二房东小区',
        source: '二房东房源',
        ownerType: '二房东房源',
        houseSourceType: '二房东房源',
        companyListing: false,
        isCompanyListing: false
      }),
      baseListing({
        id: 'FALSE_STRING_OWNER',
        title: '字符串假值业主房源',
        shortTitle: '字符串假值业主小区',
        community: '字符串假值业主小区',
        source: '业主房源',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        companyListing: 'false',
        isCompanyListing: '0',
        companyOwned: 'no'
      }),
      baseListing({
        id: 'FALSE_STRING_SECOND',
        title: '字符串假值二房东房源',
        shortTitle: '字符串假值二房东小区',
        community: '字符串假值二房东小区',
        source: '二房东房源',
        ownerType: '二房东房源',
        houseSourceType: '二房东房源',
        companyListing: 'false',
        isCompanyListing: '0',
        companyOwned: 'no'
      }),
      baseListing({
        id: 'OWNER_CONFLICT',
        title: '业主优先冲突房源',
        shortTitle: '业主优先冲突小区',
        community: '业主优先冲突小区',
        source: '二房东房源',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        companyListing: false,
        isCompanyListing: false
      }),
      baseListing({
        id: 'SECOND_CONFLICT',
        title: '二房东优先冲突房源',
        shortTitle: '二房东优先冲突小区',
        community: '二房东优先冲突小区',
        source: '业主房源',
        ownerType: '二房东房源',
        houseSourceType: '业主房源',
        companyListing: false,
        isCompanyListing: false
      }),
      baseListing({
        id: 'INVALID_FIRST_DEFAULT_SECOND',
        title: '非法首字段按既有默认归类',
        shortTitle: '非法首字段小区',
        community: '非法首字段小区',
        ownerType: 'INVALID',
        houseSourceType: '业主房源',
        source: '二房东房源',
        companyListing: false,
        isCompanyListing: false
      }),
      baseListing({
        id: 'DERIVED_SOURCE_TYPE_ONLY',
        title: '仅派生来源字段房源',
        shortTitle: '仅派生来源字段小区',
        community: '仅派生来源字段小区',
        ownerType: '',
        houseSourceType: '',
        source: '',
        sourceType: '业主房源',
        companyListing: false,
        isCompanyListing: false
      })
    ],
    footprints: [],
    rentalNeeds: [],
    clientReports: [],
    dealRecords: [],
    commissionRecords: []
  }
  db.favorites = db.listings.map((item, index) => ({
    id: `F-${index + 1}`,
    userId: 'U1',
    listingId: item.id,
    createdAt: new Date(Date.now() + index).toISOString()
  }))

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
  const falseStringOwner = db.listings.find((item) => item.id === 'FALSE_STRING_OWNER')
  const falseStringOwnerFeatures = falseStringOwner.features || []
  assert.ok(!falseStringOwnerFeatures.includes('免押金'), '字符串假值不得给业主房源补公司默认特点')
  assert.ok(!falseStringOwnerFeatures.includes('电梯'), '字符串假值不得给业主房源补公司电梯特点')

  const ownerIds = domain.filterListings(db, { category: '业主房源' }).map((item) => item.id).sort()
  const companyIds = domain.filterListings(db, { category: '公司房源' }).map((item) => item.id).sort()
  const secondLandlordIds = domain.filterListings(db, { category: '二房东房源' }).map((item) => item.id).sort()
  const allIds = domain.filterListings(db, {}).map((item) => item.id).sort()
  const guestCompanyIds = domain.filterListings(db, { companyOnly: true }).map((item) => item.id).sort()
  assert.ok(!ownerIds.includes('COMPANY_DESC_OWNER'), '描述或户型含“业主”的公司房源不得进入业主筛选')
  assert.ok(ownerIds.includes('REAL_OWNER'), '真实业主房源仍应进入业主筛选')
  assert.ok(companyIds.includes('COMPANY_DESC_OWNER'), '公司房源仍应进入公司专区')
  assert.ok(allIds.includes('COMPANY_DESC_OWNER'), '公司房源无视频仍应进入全部房源')
  assert.ok(allIds.includes('REAL_OWNER'), '真实业主房源有视频且审核通过应进入全部房源')
  assert.deepStrictEqual(companyIds, ['COMPANY_DESC_OWNER'], '公司分类只能包含结构化公司房源，字符串假值不得被当真')
  assert.deepStrictEqual(guestCompanyIds, companyIds, 'filterListings 的游客 companyOnly 必须直接收敛为公司房源全集')
  assert.deepStrictEqual(
    ownerIds,
    ['FALSE_STRING_OWNER', 'OWNER_CONFLICT', 'REAL_OWNER'],
    '业主分类必须按结构化字段优先级唯一归类'
  )
  assert.deepStrictEqual(
    secondLandlordIds,
    ['DERIVED_SOURCE_TYPE_ONLY', 'FALSE_STRING_SECOND', 'INVALID_FIRST_DEFAULT_SECOND', 'REAL_SECOND', 'SECOND_CONFLICT'],
    '二房东分类必须沿用第一个非空 canonical 字段与非法默认规则，不能靠派生/拼接文本跨类'
  )
  assert.strictEqual(new Set(companyIds.concat(ownerIds, secondLandlordIds)).size, allIds.length, '三类来源并集必须恰好覆盖全部有效房源')
  assert.strictEqual(companyIds.length + ownerIds.length + secondLandlordIds.length, allIds.length, '每套有效房源必须且只能属于一个来源')

  function mapIds(filter) {
    return domain.mapCommunities(db, filter)
      .flatMap((item) => item.activeListingIds || [])
      .sort()
  }
  assert.deepStrictEqual(mapIds({ sourceType: '公司房源' }), companyIds, '地图公司筛选必须与列表同口径')
  assert.deepStrictEqual(mapIds({ sourceType: '业主房源' }), ownerIds, '地图业主筛选必须与列表同口径')
  assert.deepStrictEqual(mapIds({ sourceType: '二房东房源' }), secondLandlordIds, '地图二房东筛选必须与列表同口径')
  assert.deepStrictEqual(mapIds({ companyOnly: true, sourceType: '业主房源' }), [], '游客权限与业主筛选取交集必须为空')
  assert.deepStrictEqual(mapIds({ companyOnly: true, sourceType: '二房东房源' }), [], '游客权限与二房东筛选取交集必须为空')

  function favoriteIds(category) {
    return domain.favoriteListings(db, 'U1', { category }).map((item) => item.id).sort()
  }
  assert.deepStrictEqual(favoriteIds('公司房源'), companyIds, '收藏公司筛选必须与列表同口径')
  assert.deepStrictEqual(favoriteIds('业主房源'), ownerIds, '收藏业主筛选必须与列表同口径')
  assert.deepStrictEqual(favoriteIds('二房东房源'), secondLandlordIds, '收藏二房东筛选必须与列表同口径')

  const invalidFirstListing = db.listings.find((item) => item.id === 'INVALID_FIRST_DEFAULT_SECOND')
  const commissionDb = {
    ...db,
    commissionConfig: {
      secondLandlordRate: 11,
      secondLandlordPlatformRate: 3,
      ownerRate: 31,
      ownerPlatformRate: 7
    }
  }
  assert.deepStrictEqual(
    domain.commissionRuleForListing(invalidFirstListing, commissionDb, 'U1', 'U2'),
    { rate: 14, uploaderRate: 11, platformRate: 3 },
    '畸形首字段的筛选归类必须继续与既有服务端分佣默认口径一致'
  )
  assert.strictEqual(domain.dashboardSummary(db).listingCount, allIds.length, '首页统计应与全部房源使用同一前台有效口径')

  const inventoryPath = path.join(__dirname, 'company-listings-inventory.js')
  const inventorySource = fs.readFileSync(inventoryPath, 'utf8')
  assert.ok(inventorySource.includes('if (require.main === module) main()'), '公司清单脚本被测试引用时不得写清单文件')
  assert.ok(inventorySource.includes("require('../src/domain')"), '公司清单脚本必须复用服务端来源判定')
  const inventory = require(inventoryPath)
  assert.strictEqual(inventory.isCompanyListing({ companyListing: 'false', source: '业主房源' }), false, '公司清单不得把字符串 false 误计为公司')
  assert.strictEqual(inventory.isCompanyListing({ companyListing: '公司房源' }), true, '公司清单必须保留既有公司真值兼容')

  console.log('listing-source-structure-test passed')
}

run()
