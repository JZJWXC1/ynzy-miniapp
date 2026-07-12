const assert = require('assert')
const fs = require('fs')
const path = require('path')

const domain = require('../src/domain')
const serverFeatures = require('../src/listing-features')
const clientFeatures = require('../../utils/listing-features')
const matchService = require('../src/match-service')

const repoRoot = path.resolve(__dirname, '..', '..')
const uploadJs = fs.readFileSync(path.join(repoRoot, 'pages', 'upload', 'upload.js'), 'utf8')
const uploadWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'upload', 'upload.wxml'), 'utf8')

let roomSeed = 8000

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '测试中介', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '测试管理员', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [],
    footprints: [],
    pointLogs: []
  }
}

function listingForm(overrides = {}) {
  roomSeed += 1
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新园',
    community: '棠润府',
    building: '8',
    unit: '1',
    roomNumber: String(roomSeed),
    contact: '13911112222',
    rent: 3600,
    rentMode: '整租',
    room: '一室',
    hall: '1厅',
    bath: '1卫',
    features: ['Loft', '落地窗'],
    viewingMethod: '联系房东',
    videoKey: 'house-videos/m1-fields-test.mp4',
    remark: '采光很好，可月付',
    ...overrides
  }
}

function expectBad(form, pattern, label, options = {}) {
  assert.throws(
    () => domain.addNormalListing(makeDb(), options.userId || 'U1', form, options.domainOptions || {}),
    (error) => error && error.statusCode === 400 && pattern.test(error.message),
    label
  )
}

function run() {
  ;['Loft', '落地窗'].forEach((feature) => {
    assert.ok(serverFeatures.LISTING_FEATURE_OPTIONS.includes(feature), `服务端特点白名单缺少 ${feature}`)
    assert.ok(clientFeatures.LISTING_FEATURE_OPTIONS.includes(feature), `客户端特点白名单缺少 ${feature}`)
  })

  const db = makeDb()
  const created = domain.addNormalListing(db, 'U1', listingForm())
  const raw = db.listings.find((item) => item.id === created.id)
  assert.strictEqual(raw.landlordCommissionPercent, 50, '缺省房东佣金占月租比例必须由服务端固定为 50')
  assert.strictEqual(raw.commissionRate, 20, '新字段不得复用或覆盖旧上传人分佣 commissionRate')
  assert.strictEqual(raw.remark, '采光很好，可月付', '安全备注必须规范化并落库')
  assert.strictEqual(created.landlordCommissionPercent, 50, '编辑回包必须带新佣金字段')
  assert.strictEqual(created.remark, '采光很好，可月付', '编辑回包必须带备注')
  assert.deepStrictEqual(raw.features.filter((item) => ['Loft', '落地窗'].includes(item)), ['Loft', '落地窗'])
  assert.strictEqual(domain.filterListings(db, { features: 'Loft' }).length, 1, '列表必须支持按 Loft 筛选')
  assert.strictEqual(domain.filterListings(db, { features: '落地窗' }).length, 1, '列表必须支持按落地窗筛选')
  assert.ok(raw.recommendationProfile.features.includes('Loft') && raw.recommendationProfile.features.includes('落地窗'), '推荐资料必须保留两个新特点')
  const parsedNeed = matchService.parseNeed({ text: '必须是 Loft，而且必须有落地窗' })
  assert.ok(parsedNeed.hardConstraints.features.includes('Loft'), '找房需求必须能解析 Loft')
  assert.ok(parsedNeed.hardConstraints.features.includes('落地窗'), '找房需求必须能解析落地窗')

  const boundaries = [0, 100]
  boundaries.forEach((value) => {
    const current = makeDb()
    domain.addNormalListing(current, 'U1', listingForm({ landlordCommissionPercent: value }))
    assert.strictEqual(current.listings[0].landlordCommissionPercent, value, `应接受边界值 ${value}`)
  })
  const numericStringDb = makeDb()
  domain.addNormalListing(numericStringDb, 'U1', listingForm({ landlordCommissionPercent: '37' }))
  assert.strictEqual(numericStringDb.listings[0].landlordCommissionPercent, 37, '表单数字字符串应规范化为整数')

  for (const invalid of [-1, 101, 12.5, '12.5', '', 'abc', '5e1', [50], { value: 50 }, true]) {
    expectBad(
      listingForm({ landlordCommissionPercent: invalid }),
      /房东佣金.*0.*100.*整数/,
      `非法房东佣金比例必须拒绝：${JSON.stringify(invalid)}`
    )
  }

  for (const viewing of [
    { viewingMethod: '钥匙', viewingKeyLocation: '前台领取' },
    { viewingMethod: '密码', viewingPassword: 'TEST#1234' },
    { viewingMethod: '联系房东' }
  ]) {
    expectBad(
      listingForm({ ...viewing, contact: '' }),
      /房东手机号/,
      `${viewing.viewingMethod}方式也必须填写房东手机号`
    )
  }
  expectBad(
    listingForm({ companyListing: true, source: '公司房源', contact: '', videoKey: '' }),
    /房东手机号/,
    '公司房源也必须填写房东手机号',
    { userId: 'ADMIN', domainOptions: { admin: true } }
  )
  expectBad(
    listingForm({ contact: '' }),
    /房东手机号/,
    '飞书缺号内部开关不得放宽非公司房源校验',
    { userId: 'ADMIN', domainOptions: { admin: true, allowMissingLandlordPhone: true } }
  )
  expectBad(listingForm({ viewingMethod: '钥匙', viewingKeyLocation: '前台', contact: 'TEST-PHONE' }), /11 位.*手机号/, '所有方式都必须校验手机号格式')

  const safe200 = '房'.repeat(200)
  const safeDb = makeDb()
  domain.addNormalListing(safeDb, 'U1', listingForm({ remark: safe200 }))
  assert.strictEqual(Array.from(safeDb.listings[0].remark).length, 200, '200 字备注应允许')
  expectBad(listingForm({ remark: '房'.repeat(201) }), /备注.*200/, '201 字备注必须拒绝')
  for (const unsafeRemark of ['联系 139 1111 2222', '联系 139，1111，2222', '微信：broker_test', 'weixin broker_test', 'vx broker_test', '请扫二维码', 'https://example.test/contact']) {
    expectBad(listingForm({ remark: unsafeRemark }), /备注.*联系方式/, '备注不得夹带联系方式')
  }

  const legacyDb = makeDb()
  const legacyCreated = domain.addNormalListing(legacyDb, 'U1', listingForm())
  const legacy = legacyDb.listings.find((item) => item.id === legacyCreated.id)
  delete legacy.landlordPhone
  delete legacy.landlordCommissionPercent
  assert.throws(
    () => domain.updateNormalListing(legacyDb, 'U1', legacy.id, { rent: 3800 }),
    (error) => error && error.statusCode === 400 && /房东手机号/.test(error.message),
    '存量缺手机号房源编辑时必须补齐，不能只改其他字段绕过'
  )

  assert.match(uploadJs, /landlordCommissionPercent:\s*50/, '上传表单默认佣金比例必须为 50')
  assert.match(uploadJs, /remark:\s*''/, '上传表单必须包含备注字段')
  assert.match(uploadWxml, /data-field="landlordCommissionPercent"/, '上传页必须渲染房东佣金占月租比例输入')
  assert.match(uploadWxml, /data-field="remark"/, '上传页必须渲染备注输入')
  assert.doesNotMatch(uploadWxml, /房东手机号仅在「联系房东」时必填/, '上传页不得保留条件必填旧文案')

  console.log('listing-experience-fields-v1-test passed')
}

run()
