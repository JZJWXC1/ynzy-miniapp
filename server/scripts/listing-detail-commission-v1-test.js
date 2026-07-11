'use strict'

const assert = require('assert')
const domain = require('../src/domain')

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '维护中介', role: '中介', authed: '手机号登录' },
      { id: 'U2', name: '带看中介', role: '中介', authed: '手机号登录' },
      { id: 'ADM', name: '管理员', role: '管理员', isAdmin: true, authed: '手机号登录' }
    ],
    listings: [],
    rentalNeeds: [{ id: 'N1', brokerId: 'U2', status: 'active', confirmedNeed: {} }],
    clientReports: [],
    dealRecords: [],
    commissionRecords: [],
    footprints: [],
    pointLogs: []
  }
}

function activeListing(overrides = {}) {
  return {
    id: 'L1',
    uploaderId: 'U1',
    ownerType: '二房东房源',
    source: '二房东房源',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    communityMatched: true,
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '测试板块',
    community: '测试小区',
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: '测试地址',
    rent: 4000,
    layout: '整租一室一厅一卫',
    videoKey: 'house-videos/test/listing.mp4',
    landlordPhone: '19900000001',
    viewingMethod: '联系房东',
    landlordCommissionPercent: 50,
    remark: '可预约工作日晚间看房',
    ...overrides
  }
}

function assertBreakdown(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message)
  const sum = actual.viewingAgentPercentOfRent + actual.maintainerPercentOfRent + actual.platformPercentOfRent
  assert.ok(Math.abs(sum - actual.landlordPercentOfRent) < 0.0001, `${message}：月租占比必须守恒`)
}

// 1) 普通房源详情只返回服务端计算后的月租占比，不暴露上传人和旧佣金字段。
{
  const db = makeDb()
  db.listings.push(activeListing())
  const detail = domain.listingDetail(db, 'L1', 'U2')
  assert.ok(detail, '有效房源必须可读')
  ;['uploader', 'commissionRate', 'commissionText'].forEach((field) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(detail, field), `详情不得返回旧字段 ${field}`)
  })
  assert.strictEqual(detail.remark, '可预约工作日晚间看房', '安全备注应在详情展示')
  assertBreakdown(detail.commissionBreakdown, {
    landlordPercentOfRent: 50,
    viewingAgentPercentOfRent: 35,
    maintainerPercentOfRent: 10,
    platformPercentOfRent: 5,
    split: {
      viewingAgentRate: 70,
      maintainerRate: 20,
      platformRate: 10
    }
  }, '普通二房东房源默认拆分')
}

// 2) 非 50% 比例也必须由服务端按当前配置动态计算，不能在前端写死 35/10/5。
{
  const db = makeDb()
  db.listings.push(activeListing({ landlordCommissionPercent: 33 }))
  const detail = domain.listingDetail(db, 'L1', 'U2')
  assertBreakdown(detail.commissionBreakdown, {
    landlordPercentOfRent: 33,
    viewingAgentPercentOfRent: 23.1,
    maintainerPercentOfRent: 6.6,
    platformPercentOfRent: 3.3,
    split: {
      viewingAgentRate: 70,
      maintainerRate: 20,
      platformRate: 10
    }
  }, '33% 房东佣金动态拆分')

  ;[
    { total: 0, viewing: 0, maintainer: 0, platform: 0 },
    { total: 1, viewing: 0.7, maintainer: 0.2, platform: 0.1 },
    { total: 100, viewing: 70, maintainer: 20, platform: 10 }
  ].forEach((fixture) => {
    const boundaryDb = makeDb()
    boundaryDb.listings.push(activeListing({ landlordCommissionPercent: fixture.total }))
    const breakdown = domain.listingDetail(boundaryDb, 'L1', 'U2').commissionBreakdown
    assert.strictEqual(breakdown.landlordPercentOfRent, fixture.total, `${fixture.total}% 总比例`)
    assert.strictEqual(breakdown.viewingAgentPercentOfRent, fixture.viewing, `${fixture.total}% 带看人比例`)
    assert.strictEqual(breakdown.maintainerPercentOfRent, fixture.maintainer, `${fixture.total}% 维护人比例`)
    assert.strictEqual(breakdown.platformPercentOfRent, fixture.platform, `${fixture.total}% 平台比例`)
  })
}

// 3) 公司房源、自传自带、管理员维护的分支都以可信服务端身份计算。
{
  const companyDb = makeDb()
  companyDb.listings.push(activeListing({
    companyListing: true,
    isCompanyListing: true,
    ownerType: '公司房源',
    source: '公司房源',
    landlordCommissionPercent: 40,
    videoKey: ''
  }))
  assertBreakdown(domain.listingDetail(companyDb, 'L1', 'U2').commissionBreakdown, {
    landlordPercentOfRent: 40,
    viewingAgentPercentOfRent: 40,
    maintainerPercentOfRent: 0,
    platformPercentOfRent: 0,
    split: { viewingAgentRate: 100, maintainerRate: 0, platformRate: 0 }
  }, '公司房源带看人取得全部房东佣金')

  const ownDb = makeDb()
  ownDb.listings.push(activeListing())
  assertBreakdown(domain.listingDetail(ownDb, 'L1', 'U1').commissionBreakdown, {
    landlordPercentOfRent: 50,
    viewingAgentPercentOfRent: 50,
    maintainerPercentOfRent: 0,
    platformPercentOfRent: 0,
    split: { viewingAgentRate: 100, maintainerRate: 0, platformRate: 0 }
  }, '自传自带不重复分佣')

  const adminDb = makeDb()
  adminDb.listings.push(activeListing({ uploaderId: 'ADM' }))
  assertBreakdown(domain.listingDetail(adminDb, 'L1', 'U2').commissionBreakdown, {
    landlordPercentOfRent: 50,
    viewingAgentPercentOfRent: 45,
    maintainerPercentOfRent: 0,
    platformPercentOfRent: 5,
    split: { viewingAgentRate: 90, maintainerRate: 0, platformRate: 10 }
  }, '管理员维护房源不取得维护人分佣')
}

// 4) 成交总佣金只能由成交月租 × 房源冻结比例计算；客户端金额、身份和拆分字段全部无效。
{
  const db = makeDb()
  db.listings.push(activeListing())
  db.clientReports.push({
    id: 'R1',
    needId: 'N1',
    listingId: 'L1',
    brokerId: 'U2',
    uploaderId: 'U1',
    customerName: '测试客户',
    customerPhone: '19900000002',
    status: '已报备'
  })

  const result = domain.createDealFromReport(db, 'U2', 'R1', {
    dealMonthlyRent: 4000,
    landlordCommission: 999999,
    landlordCommissionFen: 1,
    landlordCommissionPercent: 1,
    commissionRule: { rate: 1, uploaderRate: 1, platformRate: 0 },
    uploaderId: 'EVIL_UPLOADER',
    maintainerId: 'EVIL_MAINTAINER',
    brokerId: 'EVIL_BROKER'
  })
  const raw = db.dealRecords[0]
  assert.strictEqual(raw.dealMonthlyRentFen, 400000, '成交月租应规范化为分')
  assert.strictEqual(raw.landlordCommissionPercent, 50, '必须冻结房源服务端存储比例')
  assert.strictEqual(raw.landlordCommissionFen, 200000, '总佣金必须自动计算为 4000 × 50%')
  assert.strictEqual(raw.uploaderId, 'U1', '维护人必须来自房源服务端记录')
  assert.strictEqual(raw.brokerId, 'U2', '带看人必须来自已验签报备记录')
  assert.deepStrictEqual(raw.commissionRule, { rate: 30, uploaderRate: 20, platformRate: 10 }, '拆分规则必须由服务端计算并冻结')
  assert.strictEqual(raw.dealSnapshot.landlordCommissionPercent, 50, '成交快照必须冻结房东佣金比例')
  assert.strictEqual(raw.dealSnapshot.landlordCommissionFen, 200000, '成交快照必须冻结服务端计算金额')
  assert.deepStrictEqual(raw.dealSnapshot.commissionBreakdown, {
    landlordPercentOfRent: 50,
    viewingAgentPercentOfRent: 35,
    maintainerPercentOfRent: 10,
    platformPercentOfRent: 5,
    split: { viewingAgentRate: 70, maintainerRate: 20, platformRate: 10 }
  }, '成交快照必须冻结详情同口径拆分')
  assert.strictEqual(result.deal.landlordCommissionFen, 200000, '对外成交记录使用可信计算金额')
}

// 5) 极小金额也必须 money 守恒：总佣金 1 分、维护/平台各 50% 时不能分别进位成 2 分。
{
  const db = makeDb()
  db.listings.push(activeListing())
  db.dealRecords.push({
    id: 'D-TINY',
    reportId: 'R-TINY',
    listingId: 'L1',
    brokerId: 'U2',
    uploaderId: 'U1',
    landlordCommissionFen: 1,
    dealMonthlyRentFen: 2,
    commissionRule: { rate: 100, uploaderRate: 50, platformRate: 50 },
    status: '待管理员确认'
  })
  const result = domain.confirmDeal(db, 'ADM', 'D-TINY')
  const record = result.commissionRecord
  assert.strictEqual(record.uploaderCommissionFen + record.platformCommissionFen, 1, '两方实付合计不得超过 1 分总佣金')
  assert.strictEqual(record.uploaderCommissionFen, 1, '维护人先按冻结比例进位')
  assert.strictEqual(record.platformCommissionFen, 0, '平台取总可分金额剩余值，禁止再次独立进位')
  assert.strictEqual(result.deal.expectedUploaderCommissionFen + result.deal.expectedPlatformCommissionFen, 1, '展示预期金额也必须守恒')
}

console.log('listing detail commission v1 test passed')
