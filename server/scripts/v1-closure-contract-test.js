const assert = require('assert')
const domain = require('../src/domain')
const { NO_FEATURE } = require('../src/listing-features')

function createDb() {
  return {
    users: [
      { id: 'U1', name: '上传中介', phone: '13900000001', role: '中介', authed: '已实名' },
      { id: 'U2', name: '成交中介', phone: '13900000002', role: '中介', authed: '已实名' },
      { id: 'U3', name: '临时中介', phone: '13900000004', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', phone: '13900000003', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [],
    footprints: [],
    pointLogs: [],
    commissionRecords: [],
    clientReports: [],
    dealRecords: [],
    rentalNeeds: []
  }
}

function listingPayload(overrides = {}) {
  return {
    city: '杭州',
    district: '滨江区',
    area: '滨江区',
    block: '长河',
    communityName: '城北天邑国际',
    community: '城北天邑国际',
    buildingNo: '1',
    building: '1',
    unitNo: '2',
    unit: '2',
    roomNo: '301',
    roomNumber: '301',
    address: '杭州市滨江区城北天邑国际1幢2单元301室',
    contact: '13911112222',
    rent: 4200,
    layout: '整租两室一厅一卫',
    features: [NO_FEATURE],
    videoKey: 'house-videos/v1-closure/test.mp4',
    commissionRate: 99,
    brokerId: 'EVIL_BROKER',
    uploaderId: 'EVIL_UPLOADER',
    ...overrides
  }
}

function assertRejects(fn, matcher, message) {
  let rejected = false
  try {
    fn()
  } catch (error) {
    rejected = true
    assert.ok(matcher(error), message || error.message)
  }
  if (!rejected) throw new Error(message || '预期操作被拒绝')
}

function run() {
  const db = createDb()

  const needResult = domain.createRentalNeed(db, 'U2', {
    rawText: '滨江两室，预算 4500，周末约看',
    voiceText: '语音识别文本',
    confirmedNeed: { area: '滨江区', layout: '两室', budgetMax: 4500 },
    source: 'match-chat'
  })
  const need = db.rentalNeeds.find((item) => item.id === needResult.need.id)
  assert.ok(need, '需求单必须持久化到 db.rentalNeeds')
  assert.strictEqual(need.brokerId, 'U2', '需求单 brokerId 必须来自当前用户')
  assert.strictEqual(need.rawText, '滨江两室，预算 4500，周末约看')
  assert.deepStrictEqual(need.confirmedNeed, { area: '滨江区', layout: '两室', budgetMax: 4500 })
  assert.strictEqual(need.status, 'active')
  assert.ok(need.createdAt && need.updatedAt, '需求单必须保存创建和更新时间')
  assert.ok(domain.userRentalNeeds(db, 'U2').some((item) => item.id === need.id), '当前用户能读取自己的需求单')
  assert.ok(!domain.userRentalNeeds(db, 'U1').some((item) => item.id === need.id), '其他用户不能读取该需求单')

  const listing = domain.addNormalListing(db, 'U1', listingPayload())
  const rawListing = db.listings.find((item) => item.id === listing.id)
  assert.strictEqual(rawListing.uploaderId, 'U1')

  domain.updateNormalListing(db, 'U1', listing.id, listingPayload({ rent: 4300 }))
  const editedListing = db.listings.find((item) => item.id === listing.id)
  assert.strictEqual(editedListing.rent, 4300, '编辑同一房源不能被去重误杀')
  // 编辑路径也必须无视客户端伪造的分佣与身份字段（listingPayload 提交了 commissionRate:99、
  // uploaderId:'EVIL_UPLOADER'）：分佣由服务端按 ownerType 固定计算，上传人不可被改写。
  assert.strictEqual(editedListing.commissionRate, 15, '编辑房源不能被客户端 commissionRate 覆盖，须服务端按二房东 15% 计算')
  assert.strictEqual(editedListing.uploaderId, 'U1', '编辑房源不能改写上传人 uploaderId')

  assertRejects(
    () => domain.addNormalListing(db, 'U2', listingPayload({ videoKey: 'house-videos/v1-closure/duplicate.mp4' })),
    (error) => error.statusCode === 409 &&
      /重复上传|已存在/.test(error.message) &&
      !error.message.includes('13911112222'),
    '重复有效房源必须拒绝，且错误信息不能输出完整手机号'
  )

  assertRejects(
    () => domain.addSensitiveFootprint(db, 'U2', listing.id, { purpose: '约带看' }),
    (error) => error.statusCode === 400 && /needId/.test(error.message),
    '普通中介查看非自己房源必须传 needId'
  )
  assertRejects(
    () => domain.addSensitiveFootprint(db, 'U2', listing.id, { needId: need.id }),
    (error) => error.statusCode === 400 && /用途/.test(error.message),
    '普通中介查看非自己房源必须传 purpose'
  )

  const sensitiveResult = domain.addSensitiveFootprint(db, 'U2', listing.id, {
    needId: need.id,
    purpose: '约带看',
    action: '查看地址和电话'
  })
  const footprint = db.footprints.find((item) => item.viewerId === 'U2' && item.listingId === listing.id)
  assert.ok(sensitiveResult.sensitive.landlordPhone, '绑定需求和用途后可返回敏感信息')
  assert.strictEqual(footprint.needId, need.id, '敏感查看足迹必须保存 needId')
  assert.strictEqual(footprint.purpose, '约带看', '敏感查看足迹必须保存 purpose')

  // 实名门槛：非中介且未实名的用户查看敏感信息必须 403，即便 needId/purpose 齐全也不放行。
  // （注：当前实现对角色含“中介”的用户整体豁免实名，此豁免是否符合产品预期需二次确认；
  //  此处仅固化“非中介未实名 → 403”这条明确规则。）
  db.users.push({ id: 'U_OPS', name: '运营未实名', phone: '13900000009', role: '运营', authed: '未实名' })
  const opsNeed = domain.createRentalNeed(db, 'U_OPS', { rawText: '客户找滨江两室', source: 'match-chat' }).need
  assertRejects(
    () => domain.addSensitiveFootprint(db, 'U_OPS', listing.id, { needId: opsNeed.id, purpose: '约带看' }),
    (error) => error.statusCode === 403 && /实名/.test(error.message),
    '非中介且未实名用户查看敏感信息必须先完成实名认证'
  )

  assertRejects(
    () => domain.addSensitiveFootprint(db, 'U1', listing.id, {}),
    (error) => error.statusCode === 400 && /needId/.test(error.message),
    '上传人从前台查看自己房源敏感信息也必须绑定 needId'
  )
  const uploaderNeedResult = domain.createRentalNeed(db, 'U1', {
    rawText: '上传人自查房源，客户想约看',
    confirmedNeed: { area: '滨江区', layout: '两室' },
    source: 'listing-detail'
  })
  const uploaderNeed = db.rentalNeeds.find((item) => item.id === uploaderNeedResult.need.id)
  domain.addSensitiveFootprint(db, 'U1', listing.id, {
    needId: uploaderNeed.id,
    purpose: '上传人服务客户查看'
  })
  assertRejects(
    () => domain.addSensitiveFootprint(db, 'ADMIN', listing.id, {}),
    (error) => error.statusCode === 400 && /needId/.test(error.message),
    '管理员从小程序前台查看也必须绑定 needId/purpose'
  )
  const adminNeedResult = domain.createRentalNeed(db, 'ADMIN', {
    rawText: '管理员协助核验客户约看需求',
    confirmedNeed: { area: '滨江区', layout: '两室' },
    source: 'admin-mini-sensitive-view'
  })
  const adminNeed = db.rentalNeeds.find((item) => item.id === adminNeedResult.need.id)
  domain.addSensitiveFootprint(db, 'ADMIN', listing.id, {
    needId: adminNeed.id,
    purpose: '管理员协助客户核验'
  })
  assert.ok(db.footprints.some((item) => item.viewerId === 'U1' && item.listingId === listing.id && item.needId === uploaderNeed.id), '上传人前台查看自己房源也必须保存 needId/purpose')
  assert.ok(db.footprints.some((item) => item.viewerId === 'ADMIN' && item.listingId === listing.id && item.needId === adminNeed.id), '管理员前台查看也必须保存 needId/purpose')

  assertRejects(
    () => domain.createClientReport(db, 'U2', listing.id, { needId: 'UNKNOWN', customerPhone: '13800001111' }),
    (error) => error.statusCode === 404 && /需求单/.test(error.message),
    '报备绑定不存在的需求单必须拒绝'
  )
  const reportResult = domain.createClientReport(db, 'U2', listing.id, {
    needId: need.id,
    customerName: '李先生',
    customerPhone: '13800001111'
  })
  const report = db.clientReports.find((item) => item.id === reportResult.report.id)
  assert.strictEqual(report.needId, need.id, '报备记录必须保存 needId')
  assert.ok(report.reportSnapshot && report.reportSnapshot.uploaderId === 'U1', '报备记录必须冻结房源快照')

  const dealResult = domain.createDealFromReport(db, 'U2', report.id, {
    monthlyRent: 4200,
    landlordCommission: 6000,
    remark: '闭环签单'
  })
  const deal = db.dealRecords.find((item) => item.id === dealResult.deal.id)
  assert.strictEqual(deal.needId, need.id, '签单必须继承 report.needId')
  assert.strictEqual(deal.uploaderId, 'U1', '签单必须冻结成交时上传人')
  assert.strictEqual(deal.listingTitle, '城北天邑国际', '签单必须保存房源标题快照')
  assert.strictEqual(deal.community, '城北天邑国际', '签单必须保存小区快照')
  assert.strictEqual(deal.rentFen, 430000, '签单必须保存成交时房源租金分值快照')
  assert.strictEqual(deal.commissionRule.rate, 20, '二房东签单快照必须保存成交总比例 20% 规则')
  assert.strictEqual(deal.commissionRule.uploaderRate, 15, '二房东签单快照必须保存上传人 15% 规则')
  assert.strictEqual(deal.commissionRule.platformRate, 5, '二房东签单快照必须保存平台 5% 规则')
  assert.ok(deal.snapshotAt, '签单必须保存快照时间')
  assert.deepStrictEqual(deal.dealSnapshot.commissionRule, { rate: 20, uploaderRate: 15, platformRate: 5 }, '签单必须保存不可变快照对象')

  // 待确认期间篡改房源：改上传人，并把房源标记为公司房源（公司房源重算得 0/0/0，会把上传人
  // 分佣清零、commissionRecord 置空）。确认分佣必须仍按签单冻结的 20/15/5 快照结算，且不得
  // 用确认时刻的重算值覆盖冻结快照。
  rawListing.uploaderId = 'U3'
  rawListing.companyListing = true
  const confirmResult = domain.confirmDeal(db, 'ADMIN', deal.id)
  assert.strictEqual(confirmResult.commissionRecord.uploaderId, 'U1', '确认分佣必须使用 deal.uploaderId，而不是当前 listing.uploaderId')
  assert.strictEqual(confirmResult.commissionRecord.rate, 20, '二房东成交总比例必须固定 20%')
  assert.strictEqual(confirmResult.commissionRecord.uploaderRate, 15, '二房东上传人到手比例必须固定 15%')
  assert.strictEqual(confirmResult.commissionRecord.platformRate, 5, '二房东平台留存比例必须固定 5%')
  assert.strictEqual(confirmResult.commissionRecord.uploaderCommissionFen, 90000, '二房东上传人分佣必须按房东实付佣金 15% 计算')
  assert.strictEqual(confirmResult.commissionRecord.platformCommissionFen, 30000, '二房东平台留存必须按房东实付佣金 5% 计算')
  assert.strictEqual(confirmResult.commissionRecord.needId, need.id, '正式分佣记录应保留 needId')
  assert.deepStrictEqual(confirmResult.deal.dealSnapshot.commissionRule, { rate: 20, uploaderRate: 15, platformRate: 5 }, '确认签单不得用确认时刻重算值覆盖签单冻结的分佣快照')

  console.log('v1-closure-contract-test passed')
}

run()
