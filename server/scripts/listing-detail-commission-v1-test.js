'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
process.env.REPORT_DEAL_WRITES_ENABLED = '1' // 冻结佣金测试显式进入历史恢复模式。
const domain = require('../src/domain')

const rootDir = path.resolve(__dirname, '..', '..')

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `缺少 ${name} 函数`)
  const braceStart = source.indexOf('{', start)
  let depth = 0
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`${name} 函数体未闭合`)
}

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
  assert.ok(!Object.prototype.hasOwnProperty.call(detail, 'remark'), '合作房源备注属于敏感信息，留痕前不得在基础详情展示')
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

// 6) 历史脏佣金快照只能降级派生展示，不能拖垮整页；写路径仍须 fail-loud。
{
  const db = makeDb()
  db.listings.push(activeListing())
  db.dealRecords.push(
    {
      id: 'D-CLEAN', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: 30, uploaderRate: 20, platformRate: 10 }, status: '待管理员确认'
    },
    {
      id: 'D-DIRTY-SAVED', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: 120, uploaderRate: 60, platformRate: 60 },
      commissionBreakdown: { landlordPercentOfRent: 50, viewingAgentPercentOfRent: 0, maintainerPercentOfRent: 30, platformPercentOfRent: 30 },
      uploaderCommissionFen: 123, platformCommissionFen: 45, status: '待管理员确认'
    },
    {
      id: 'D-DIRTY-MISSING', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: 30, uploaderRate: 30, platformRate: 10 }, status: '待管理员确认'
    },
    {
      id: 'D-DIRTY-CONFIRMED', needId: 'N1', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: 120, uploaderRate: 60, platformRate: 60 }, status: '已确认', confirmedAt: '2026-07-01 10:00:00'
    },
    {
      id: 'D-RULE-EMPTY', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: {}, status: '待管理员确认'
    },
    {
      id: 'D-RULE-NON-OBJECT', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: 'bad-rule', status: '待管理员确认'
    },
    {
      id: 'D-RULE-RATE-ONLY', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: 30 }, status: '待管理员确认'
    },
    {
      id: 'D-RULE-MISSING-PLATFORM', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: 30, uploaderRate: 20 }, status: '待管理员确认'
    },
    {
      id: 'D-RULE-NULLS', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: null, uploaderRate: null, platformRate: null }, status: '待管理员确认'
    },
    {
      id: 'D-RULE-EMPTY-STRINGS', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: '', uploaderRate: '', platformRate: '' }, status: '待管理员确认'
    },
    {
      id: 'D-RULE-BOOLEANS', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      commissionRule: { rate: false, uploaderRate: false, platformRate: false }, status: '待管理员确认'
    },
    {
      id: 'D-SNAPSHOT-RULE-INCOMPLETE', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      dealSnapshot: { landlordCommissionPercent: 50, commissionRule: { rate: 30, uploaderRate: 20 } },
      status: '待管理员确认'
    },
    {
      id: 'D-SNAPSHOT-RULE-CLEAN', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      dealSnapshot: { landlordCommissionPercent: 50, commissionRule: { rate: 45, uploaderRate: 15, platformRate: 30 } },
      status: '待管理员确认'
    },
    {
      id: 'D-LEGACY-NO-RULE', listingId: 'L1', brokerId: 'U2', uploaderId: 'U1',
      dealMonthlyRentFen: 400000, landlordCommissionFen: 200000,
      status: '待管理员确认'
    }
  )

  const adminRows = domain.adminDealRows(db)
  const userRows = domain.userDealRows(db, 'U2')
  assert.deepStrictEqual(adminRows.map((item) => item.id), [
    'D-CLEAN',
    'D-DIRTY-SAVED',
    'D-DIRTY-MISSING',
    'D-DIRTY-CONFIRMED',
    'D-RULE-EMPTY',
    'D-RULE-NON-OBJECT',
    'D-RULE-RATE-ONLY',
    'D-RULE-MISSING-PLATFORM',
    'D-RULE-NULLS',
    'D-RULE-EMPTY-STRINGS',
    'D-RULE-BOOLEANS',
    'D-SNAPSHOT-RULE-INCOMPLETE',
    'D-SNAPSHOT-RULE-CLEAN',
    'D-LEGACY-NO-RULE'
  ], '后台列表必须保留正常、畸形冻结规则、快照规则及纯老记录的原顺序')
  assert.deepStrictEqual(userRows.map((item) => item.id), adminRows.map((item) => item.id), '中介历史列表也不能被单条脏数据拖垮')
  assert.deepStrictEqual(adminRows[0].commissionIntegrity, { valid: true, reason: '' }, '正常签单仍应返回可信派生佣金')

  const dirtyIds = [
    'D-DIRTY-SAVED',
    'D-DIRTY-MISSING',
    'D-DIRTY-CONFIRMED',
    'D-RULE-EMPTY',
    'D-RULE-NON-OBJECT',
    'D-RULE-RATE-ONLY',
    'D-RULE-MISSING-PLATFORM',
    'D-RULE-NULLS',
    'D-RULE-EMPTY-STRINGS',
    'D-RULE-BOOLEANS',
    'D-SNAPSHOT-RULE-INCOMPLETE'
  ]
  for (const dirtyId of dirtyIds) {
    const row = adminRows.find((item) => item.id === dirtyId)
    assert.deepStrictEqual(row.commissionIntegrity, { valid: false, reason: 'INVALID_COMMISSION_SNAPSHOT' }, '脏历史必须带稳定机器标记')
    assert.strictEqual(row.commissionBreakdown, null, '脏历史不得把存量或当前规则包装成可信佣金拆分')
    assert.strictEqual(row.expectedUploaderCommissionFen, null, '脏历史不得伪算维护人预期金额')
    assert.strictEqual(row.expectedPlatformCommissionFen, null, '脏历史不得伪算平台预期金额')
    assert.strictEqual(row.expectedUploaderCommission, '待核对')
    assert.strictEqual(row.expectedPlatformCommission, '待核对')
    assert.strictEqual(row.uploaderCommissionRate, null, '脏冻结规则不得返回伪造总比例')
    assert.strictEqual(row.uploaderRate, null, '脏冻结规则不得返回伪造维护人比例')
    assert.strictEqual(row.platformRate, null, '脏冻结规则不得返回伪造平台比例')
    assert.strictEqual(row.landlordCommissionFen, 200000, '脏历史原始房东佣金事实必须保留')
    const rawDeal = db.dealRecords.find((item) => item.id === dirtyId)
    const rawRule = Object.prototype.hasOwnProperty.call(rawDeal, 'commissionRule')
      ? rawDeal.commissionRule
      : rawDeal.dealSnapshot.commissionRule
    assert.deepStrictEqual(row.commissionRule, rawRule, '冻结原始规则必须保留供审计，不得逐字段补当前配置')
  }

  const snapshotRuleRow = adminRows.find((item) => item.id === 'D-SNAPSHOT-RULE-CLEAN')
  assert.deepStrictEqual(snapshotRuleRow.commissionIntegrity, { valid: true, reason: '' }, '顶层缺失时应使用完整 dealSnapshot 冻结规则')
  assert.deepStrictEqual(snapshotRuleRow.commissionRule, { rate: 45, uploaderRate: 15, platformRate: 30 })
  assert.strictEqual(snapshotRuleRow.expectedUploaderCommissionFen, 30000, '快照冻结规则不得被当前房源 30/20/10 覆盖')
  assert.strictEqual(snapshotRuleRow.expectedPlatformCommissionFen, 60000)

  const legacyNoRuleRow = adminRows.find((item) => item.id === 'D-LEGACY-NO-RULE')
  assert.deepStrictEqual(legacyNoRuleRow.commissionIntegrity, { valid: true, reason: '' }, '只有两处冻结规则都缺失的真老记录可回退当前规则')
  assert.deepStrictEqual(legacyNoRuleRow.commissionRule, { rate: 30, uploaderRate: 20, platformRate: 10 })
  const savedDirty = adminRows.find((item) => item.id === 'D-DIRTY-SAVED')
  assert.strictEqual(savedDirty.uploaderCommissionFen, 123, '已落库维护人金额不得被降级覆盖')
  assert.strictEqual(savedDirty.platformCommissionFen, 45, '已落库平台金额不得被降级覆盖')

  const beforeConfirm = JSON.stringify(db)
  assert.throws(
    () => domain.confirmDeal(db, 'ADM', 'D-DIRTY-SAVED'),
    (error) => error && error.statusCode === 500 && /分佣规则异常/.test(error.message),
    '列表降级不能削弱签单确认写路径的 money 守恒'
  )
  assert.strictEqual(JSON.stringify(db), beforeConfirm, '脏单确认失败不得产生状态或分佣副作用')
  assert.throws(
    () => domain.confirmDeal(db, 'ADM', 'D-DIRTY-CONFIRMED'),
    (error) => error && error.statusCode === 500 && /分佣规则异常/.test(error.message),
    '已确认脏单重复确认也必须在任何里程碑副作用前 fail-loud'
  )
  assert.strictEqual(JSON.stringify(db), beforeConfirm, '已确认脏单重复确认失败也不得修改漏斗或数据库')

  for (const dirtyRuleId of [
    'D-RULE-EMPTY',
    'D-RULE-NON-OBJECT',
    'D-RULE-RATE-ONLY',
    'D-RULE-MISSING-PLATFORM',
    'D-RULE-NULLS',
    'D-RULE-EMPTY-STRINGS',
    'D-RULE-BOOLEANS',
    'D-SNAPSHOT-RULE-INCOMPLETE'
  ]) {
    const beforeDirtyConfirm = JSON.stringify(db)
    assert.throws(
      () => domain.confirmDeal(db, 'ADM', dirtyRuleId),
      (error) => error && error.statusCode === 500 && /分佣规则异常/.test(error.message),
      `${dirtyRuleId} 写路径必须与读路径一致认定为畸形冻结规则`
    )
    assert.strictEqual(JSON.stringify(db), beforeDirtyConfirm, `${dirtyRuleId} 确认失败不得产生任何副作用`)
  }

  const snapshotConfirmed = domain.confirmDeal(db, 'ADM', 'D-SNAPSHOT-RULE-CLEAN')
  assert.strictEqual(snapshotConfirmed.commissionRecord.uploaderCommissionFen, 30000, '顶层缺失时确认也必须按完整快照规则结算维护人金额')
  assert.strictEqual(snapshotConfirmed.commissionRecord.platformCommissionFen, 60000, '顶层缺失时确认也必须按完整快照规则结算平台金额')

  const adminSource = fs.readFileSync(path.join(rootDir, 'admin-web/index.html'), 'utf8')
  const miniSource = fs.readFileSync(path.join(rootDir, 'pages/deal-records/deal-records.js'), 'utf8')
  assert.match(adminSource, /commissionIntegrity/, '后台历史签单展示必须识别服务端完整性标记，禁止 null 后默认重算')
  assert.match(miniSource, /commissionIntegrity/, '保留的小程序历史签单页也必须显示待核对，禁止默认 30%')
  const summarySandbox = {
    pickText: (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim()) || '',
    snapshotObject: (item) => item.dealSnapshot || {},
    result: null
  }
  vm.runInNewContext(`${extractFunction(adminSource, 'snapshotSummaryText')}\nresult = snapshotSummaryText`, summarySandbox)
  const invalidSummary = summarySandbox.result({
    commissionIntegrity: { valid: false, reason: 'INVALID_COMMISSION_SNAPSHOT' },
    uploader: '维护中介',
    broker: '带看中介',
    listingTitle: '测试房源'
  }, '带看中介')
  assert.strictEqual(invalidSummary, '分佣规则待复核', '后台快照摘要不得对脏行回退并展示默认 20%')
}

// 7) 规则类型必须严格：数组/对象不能借 Number 强转；历史严格数字字符串保持兼容。
{
  for (const [id, commissionRule] of [
    ['D-RULE-ARRAYS', { rate: [0], uploaderRate: [0], platformRate: [0] }],
    ['D-RULE-OBJECTS', { rate: { value: 0 }, uploaderRate: { value: 0 }, platformRate: { value: 0 } }]
  ]) {
    const db = makeDb()
    db.listings.push(activeListing())
    db.dealRecords.push({
      id,
      listingId: 'L1',
      brokerId: 'U2',
      uploaderId: 'U1',
      landlordCommissionFen: 200000,
      commissionRule,
      status: '待管理员确认'
    })
    const row = domain.adminDealRows(db)[0]
    assert.deepStrictEqual(row.commissionIntegrity, { valid: false, reason: 'INVALID_COMMISSION_SNAPSHOT' }, `${id} 不得借强制类型转换伪装合法`)
    const before = JSON.stringify(db)
    assert.throws(() => domain.confirmDeal(db, 'ADM', id), /分佣规则异常/)
    assert.strictEqual(JSON.stringify(db), before, `${id} 确认失败不得有副作用`)
  }

  const stringDb = makeDb()
  stringDb.listings.push(activeListing())
  stringDb.dealRecords.push({
    id: 'D-RULE-NUMERIC-STRINGS',
    listingId: 'L1',
    brokerId: 'U2',
    uploaderId: 'U1',
    landlordCommissionFen: 200000,
    commissionRule: { rate: '30', uploaderRate: '20', platformRate: '10' },
    status: '待管理员确认'
  })
  const stringRow = domain.adminDealRows(stringDb)[0]
  assert.deepStrictEqual(stringRow.commissionIntegrity, { valid: true, reason: '' }, '历史严格数字字符串规则应兼容读取')
  assert.strictEqual(stringRow.expectedUploaderCommissionFen, 40000)
  assert.strictEqual(stringRow.expectedPlatformCommissionFen, 20000)
}

// 8) 真老签单缺少两处冻结规则时，列表与恢复确认必须用同一带看人身份回退；自传自带始终全免。
{
  const db = makeDb()
  db.listings.push(activeListing())
  db.dealRecords.push({
    id: 'D-LEGACY-SELF-DEAL',
    listingId: 'L1',
    brokerId: 'U1',
    uploaderId: 'U1',
    landlordCommissionFen: 200000,
    status: '待管理员确认'
  })

  const beforeRow = domain.adminDealRows(db)[0]
  assert.deepStrictEqual(beforeRow.commissionRule, { rate: 0, uploaderRate: 0, platformRate: 0 }, '老单列表必须识别自传自带并显示全免')
  assert.strictEqual(beforeRow.expectedUploaderCommissionFen, 0)
  assert.strictEqual(beforeRow.expectedPlatformCommissionFen, 0)

  const confirmed = domain.confirmDeal(db, 'ADM', 'D-LEGACY-SELF-DEAL')
  assert.strictEqual(confirmed.noCommission, true, '老单恢复确认也必须识别自传自带全免')
  assert.strictEqual(confirmed.commissionRecord, null, '自传自带不得生成分佣记录')
  assert.deepStrictEqual(confirmed.deal.commissionRule, { rate: 0, uploaderRate: 0, platformRate: 0 }, '确认后列表口径不得从旧展示跳变')
}

console.log('listing detail commission v1 test passed')
