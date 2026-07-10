'use strict'

// 看房方式（钥匙/密码/联系房东）锁定测试：条件必填矩阵、存量兼容、敏感边界（留痕前不泄漏钥匙位置/密码）、
// 编辑切换清空旧值、公司房源公开口径、助手安全层脱敏。

const assert = require('assert')
const domain = require('../src/domain')
const safety = require('../src/assistant/safety')

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '上传人', role: '中介', authed: '已实名' },
      { id: 'U2', name: '查看人', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', isAdmin: true }
    ],
    listings: [],
    footprints: [],
    pointLogs: [],
    rentalNeeds: []
  }
}

function baseForm(extra) {
  return Object.assign({
    city: '杭州',
    district: '拱墅区',
    community: '皋塘运都',
    building: '3',
    unit: '1',
    roomNumber: '502',
    rent: 3500,
    rentMode: '整租',
    room: '二室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯'],
    videoUrl: 'https://example.com/v.mp4',
    videoKey: 'v.mp4'
  }, extra || {})
}

// 1) 钥匙 + 钥匙位置、无房东手机号 → 通过；房东手机号不再无条件必填。
{
  const db = makeDb()
  const created = domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙', viewingKeyLocation: '前台领取' }))
  const listing = db.listings[0]
  assert.strictEqual(listing.viewingMethod, '钥匙', '看房方式落库')
  assert.strictEqual(listing.viewingKeyLocation, '前台领取', '钥匙位置落库')
  assert.strictEqual(listing.landlordPhone, '', '未填手机号不报错、不编值')
  assert.strictEqual(created.viewingMethod, '钥匙', '编辑回包带看房方式')
  assert.strictEqual(created.viewingKeyLocation, '前台领取', '编辑回包带钥匙位置')
}

// 2) 条件必填矩阵：钥匙缺位置 / 密码缺密码 / 联系房东缺手机号 → 400。
{
  const db = makeDb()
  assert.throws(
    () => domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙' })),
    (e) => e && e.statusCode === 400 && /钥匙/.test(e.message),
    '钥匙缺位置应 400'
  )
  assert.throws(
    () => domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '密码' })),
    (e) => e && e.statusCode === 400 && /密码/.test(e.message),
    '密码缺密码应 400'
  )
  assert.throws(
    () => domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '联系房东' })),
    (e) => e && e.statusCode === 400 && /房东手机号/.test(e.message),
    '联系房东缺手机号应 400'
  )
  assert.strictEqual(db.listings.length, 0, '被拒后不落库')
}

// 3) 密码 / 联系房东 各自补齐后通过。
{
  const db = makeDb()
  domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '密码', viewingPassword: '1234#' }))
  assert.strictEqual(db.listings[0].viewingPassword, '1234#')
  assert.strictEqual(db.listings[0].showingPassword, '1234#', '兼容旧字段名同步写')
  domain.addNormalListing(db, 'U1', baseForm({ roomNumber: '503', viewingMethod: '联系房东', contact: '13800001111' }))
  assert.strictEqual(db.listings[0].landlordPhone, '13800001111')
}

// 4) 存量兼容：旧客户端不传看房方式但带联系方式 → 仍通过（老契约不破）；两者都缺 → 400。
{
  const db = makeDb()
  domain.addNormalListing(db, 'U1', baseForm({ contact: '13800002222' }))
  assert.strictEqual(db.listings[0].viewingMethod, '', '未显式指定不编造方式')
  assert.throws(
    () => domain.addNormalListing(db, 'U1', baseForm({ roomNumber: '504' })),
    (e) => e && e.statusCode === 400 && /看房方式/.test(e.message),
    '无方式且无联系方式应 400'
  )
}

// 5) 敏感边界：非公司房源详情留痕前只下发方式名，不泄漏钥匙位置/密码；地址仍锁。
{
  const db = makeDb()
  domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙', viewingKeyLocation: '3栋门卫处' }))
  const detail = domain.listingDetail(db, db.listings[0].id)
  assert.strictEqual(detail.viewingMethod, '钥匙', '方式名公开展示')
  assert.strictEqual(detail.viewingMethodText, '钥匙')
  assert.ok(!('viewingKeyLocation' in detail), '留痕前不下发钥匙位置')
  assert.ok(!('viewingPassword' in detail), '留痕前不下发看房密码')
  assert.strictEqual(detail.address, '确认留痕后可查看', '地址口径不变')
}

// 6) 留痕后（他人查看）sensitive 载荷携带钥匙位置；上传人自查免留痕分支同样带全。
{
  const db = makeDb()
  domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙', viewingKeyLocation: '3栋门卫处' }))
  const listingId = db.listings[0].id
  const need = domain.createRentalNeed(db, 'U2', { rawText: '客户想看皋塘运都两室' })
  const viewed = domain.addSensitiveFootprint(db, 'U2', listingId, {
    needId: need.need.id,
    purpose: '带客户看房'
  })
  assert.strictEqual(viewed.sensitive.viewingMethod, '钥匙')
  assert.strictEqual(viewed.sensitive.viewingKeyLocation, '3栋门卫处', '留痕后下发钥匙位置')
  assert.strictEqual(db.footprints.length, 1, '他人查看留足迹')
  const own = domain.addSensitiveFootprint(db, 'U1', listingId, {})
  assert.strictEqual(own.sensitive.viewingKeyLocation, '3栋门卫处', '上传人自查直出')
  assert.strictEqual(db.footprints.length, 1, '自查不留足迹')
}

// 7) 编辑切换方式：钥匙 → 密码，显式空串清掉钥匙位置；editableListingDetail 回填新方式。
{
  const db = makeDb()
  domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙', viewingKeyLocation: '前台' }))
  const listingId = db.listings[0].id
  domain.updateNormalListing(db, 'U1', listingId, baseForm({
    viewingMethod: '密码',
    viewingPassword: '6688#',
    viewingKeyLocation: ''
  }))
  const listing = db.listings[0]
  assert.strictEqual(listing.viewingMethod, '密码')
  assert.strictEqual(listing.viewingPassword, '6688#')
  assert.strictEqual(listing.viewingKeyLocation, '', '切换方式后旧钥匙位置被清空')
  const editable = domain.editableListingDetail(db, 'U1', listingId)
  assert.strictEqual(editable.viewingMethod, '密码')
  assert.strictEqual(editable.viewingPassword, '6688#')
}

// 8) 存量推导展示：老房源无显式方式，有看房密码 → 展示「密码」；只有电话 → 展示「联系房东」。
{
  const db = makeDb()
  db.listings.push({
    id: 'L-OLD-PWD', uploaderId: 'U1', status: '在租', lifecycleStatus: 'active',
    rent: 3000, address: '杭州拱墅区东新园3栋1单元501室', layout: '整租二室1厅1卫',
    community: '皋塘运都', building: '3', unit: '1', roomNumber: '501',
    viewingPassword: '336699#', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
  })
  db.listings.push({
    id: 'L-OLD-PHONE', uploaderId: 'U1', status: '在租', lifecycleStatus: 'active',
    rent: 3000, address: '杭州拱墅区东新园3栋1单元502室', layout: '整租二室1厅1卫',
    community: '皋塘运都', building: '3', unit: '1', roomNumber: '502',
    landlordPhone: '13800003333', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
  })
  const pwdDetail = domain.listingDetail(db, 'L-OLD-PWD')
  assert.strictEqual(pwdDetail.viewingMethod, '密码', '有密码的存量推导为密码')
  const phoneDetail = domain.listingDetail(db, 'L-OLD-PHONE')
  assert.strictEqual(phoneDetail.viewingMethod, '联系房东', '有电话的存量推导为联系房东')
  // 存量房源编辑（不带看房方式字段）不因新校验被卡（老契约：有联系方式即可）
  domain.updateNormalListing(db, 'U1', 'L-OLD-PHONE', { rent: 3100 })
  assert.strictEqual(db.listings.find((item) => item.id === 'L-OLD-PHONE').rent, 3100)
}

// 9) 公司房源公开口径：钥匙位置/密码随公司公开字段直接下发（沿用 README 既有约定）。
{
  const db = makeDb()
  domain.addNormalListing(db, 'ADMIN', baseForm({
    companyListing: true,
    viewingMethod: '钥匙',
    viewingKeyLocation: '门店前台'
  }), { admin: true })
  const detail = domain.listingDetail(db, db.listings[0].id)
  assert.strictEqual(detail.companyListing, true)
  assert.strictEqual(detail.viewingMethod, '钥匙')
  assert.strictEqual(detail.viewingKeyLocation, '门店前台', '公司房源钥匙位置公开')
  assert.strictEqual(detail.sensitiveLocked, false)
}

// 10) 助手安全层：viewingPassword / viewingKeyLocation 属敏感键，scrubDeep 后不外泄。
{
  const scrubbed = safety.scrubDeep({
    community: '皋塘运都',
    viewingPassword: '1234#',
    showingPassword: '1234#',
    viewingKeyLocation: '前台领取',
    keyLocation: '前台领取'
  })
  assert.strictEqual(scrubbed.community, '皋塘运都', '非敏感字段保留')
  assert.notStrictEqual(scrubbed.viewingPassword, '1234#', 'viewingPassword 被脱敏')
  assert.notStrictEqual(scrubbed.showingPassword, '1234#', 'showingPassword 被脱敏')
  assert.notStrictEqual(scrubbed.viewingKeyLocation, '前台领取', 'viewingKeyLocation 被脱敏')
  assert.notStrictEqual(scrubbed.keyLocation, '前台领取', 'keyLocation 被脱敏')
  assert.ok(safety._internal.SENSITIVE_KEYS.has('viewingPassword'), '敏感键清单含 viewingPassword')
  assert.ok(safety._internal.SENSITIVE_KEYS.has('viewingKeyLocation'), '敏感键清单含 viewingKeyLocation')
}

// 11) 存量「电话+密码并存」的非公司房源 → 电话优先推导为联系房东（老口径详情页必须继续展示房东电话）；
//     公司房源仍密码优先（飞书看房方式密码列是公司权威）。
{
  const db = makeDb()
  db.listings.push({
    id: 'L-BOTH', uploaderId: 'U1', status: '在租', lifecycleStatus: 'active',
    rent: 3000, address: '杭州拱墅区皋塘运都3栋1单元505室', layout: '整租二室1厅1卫',
    community: '皋塘运都', building: '3', unit: '1', roomNumber: '505',
    landlordPhone: '13800004444', viewingPassword: '9999#', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
  })
  db.listings.push({
    id: 'L-COMPANY-BOTH', uploaderId: 'ADMIN', status: '在租', lifecycleStatus: 'active',
    rent: 3200, address: '杭州拱墅区皋塘运都3栋1单元506室', layout: '整租二室1厅1卫',
    community: '皋塘运都', building: '3', unit: '1', roomNumber: '506',
    companyListing: true, isCompanyListing: true, source: '公司房源',
    landlordPhone: '公司统一维护', viewingPassword: '2468#', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
  })
  const both = domain.listingDetail(db, 'L-BOTH')
  assert.strictEqual(both.viewingMethod, '联系房东', '非公司双信息电话优先，留痕后仍能看电话')
  const companyBoth = domain.listingDetail(db, 'L-COMPANY-BOTH')
  assert.strictEqual(companyBoth.viewingMethod, '密码', '公司双信息密码优先')
}

// 12) 公司/合作分池判重：同房间公司房源在架时，合作钥匙房源不被 409 误伤；
//     同池同房间空手机号重复 → 409 且提示语不残缺（不出现空手机号占位）。
{
  const db = makeDb()
  db.listings.push({
    id: 'L-FEISHU', uploaderId: 'ADMIN', status: '在租', lifecycleStatus: 'active',
    rent: 3000, address: '杭州拱墅区皋塘运都3栋1单元502室', layout: '整租二室1厅1卫',
    community: '皋塘运都', building: '3', unit: '1', roomNumber: '502',
    companyListing: true, isCompanyListing: true, source: '公司房源', externalSource: 'feishu',
    landlordPhone: '公司统一维护', viewingPassword: '1357#', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
  })
  domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙', viewingKeyLocation: '前台' }))
  assert.strictEqual(db.listings.length, 2, '合作钥匙房源不与同房间公司房源撞判重')
  assert.throws(
    () => domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '密码', viewingPassword: '1111#' })),
    (e) => e && e.statusCode === 409 && e.message.indexOf('（房东手机号 ）') === -1,
    '同池同房间空手机号仍判重，且提示语不残缺'
  )
}

// 13) 第三方全量更新兜底（飞书同步形状）：显式方式=密码的房源被「只清密码、不带看房方式」的更新命中
//     → 不再 400，密码清空且方式随之回退（否则飞书表清空密码列会卡死该行同步）。
{
  const db = makeDb()
  domain.addNormalListing(db, 'ADMIN', baseForm({
    companyListing: true,
    viewingMethod: '密码',
    viewingPassword: '9527#',
    contact: '公司统一维护'
  }), { admin: true })
  const listingId = db.listings[0].id
  domain.updateNormalListing(db, 'ADMIN', listingId, baseForm({
    companyListing: true,
    contact: '公司统一维护',
    viewingPassword: ''
  }), { admin: true })
  const listing = db.listings[0]
  assert.strictEqual(listing.viewingPassword, '', '密码被清空')
  assert.strictEqual(listing.viewingMethod, '', '依赖密码的显式方式随之回退，不卡 400')
}

// 14) 公司房源看房方式跟飞书表走：密码列是「几号空出」腾房备注 → 联系房东（电话走公司统一看房电话）；
//     真密码 → 密码；密码列空 → 联系房东。腾房备注不得当密码渲染。
{
  const db = makeDb()
  const companyBase = {
    uploaderId: 'ADMIN', status: '在租', lifecycleStatus: 'active',
    rent: 3200, layout: '整租二室1厅1卫', community: '皋塘运都', building: '3', unit: '1',
    companyListing: true, isCompanyListing: true, source: '公司房源', externalSource: 'feishu',
    landlordPhone: '公司统一维护', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
  }
  db.listings.push(Object.assign({}, companyBase, {
    id: 'L-VACANT', roomNumber: '601', address: '杭州拱墅区皋塘运都3栋1单元601室', viewingPassword: '15号空出'
  }))
  db.listings.push(Object.assign({}, companyBase, {
    id: 'L-REAL-PWD', roomNumber: '602', address: '杭州拱墅区皋塘运都3栋1单元602室', viewingPassword: '336699#'
  }))
  db.listings.push(Object.assign({}, companyBase, {
    id: 'L-NO-PWD', roomNumber: '603', address: '杭州拱墅区皋塘运都3栋1单元603室', viewingPassword: ''
  }))
  const vacant = domain.listingDetail(db, 'L-VACANT')
  assert.strictEqual(vacant.viewingMethod, '联系房东', '「几号空出」腾房备注不算密码，按联系房东展示')
  assert.strictEqual(vacant.viewingMethodText, '联系房东')
  const realPwd = domain.listingDetail(db, 'L-REAL-PWD')
  assert.strictEqual(realPwd.viewingMethod, '密码', '真密码仍按密码看房')
  const noPwd = domain.listingDetail(db, 'L-NO-PWD')
  assert.strictEqual(noPwd.viewingMethod, '联系房东', '公司房源无密码 → 联系房东（打公司看房电话）')
}

// 15) 非法看房方式枚举必须 400（返修 Codex 2026-07-10 15:49 P2）：
//     新增/编辑显式提交非空未知方式（即使带联系方式）→ 400 且原记录不变；
//     字段未传/显式空串维持旧口径；兼容别名（key/password/landlord）仍归一通过。
{
  const db = makeDb()
  assert.throws(
    () => domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '飞鸽传书', contact: '13800005555' })),
    (e) => e && e.statusCode === 400 && /看房方式只能是/.test(e.message),
    '新增非法方式应 400，不得静默归一混过校验'
  )
  assert.strictEqual(db.listings.length, 0, '非法方式不落库')
  domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '联系房东', contact: '13800005555' }))
  const listingId = db.listings[0].id
  const before = JSON.stringify(db.listings[0])
  assert.throws(
    () => domain.updateNormalListing(db, 'U1', listingId, baseForm({ viewingMethod: 'hacked', contact: '13800005555' })),
    (e) => e && e.statusCode === 400 && /看房方式只能是/.test(e.message),
    '编辑非法方式应 400'
  )
  assert.strictEqual(JSON.stringify(db.listings[0]), before, '被拒后原记录不变')
  domain.updateNormalListing(db, 'U1', listingId, baseForm({ viewingMethod: '', contact: '13800005555' }))
  assert.strictEqual(db.listings[0].viewingMethod, '', '显式空串=清空方式（旧口径），带联系方式仍可保存')
  domain.addNormalListing(db, 'U1', baseForm({ roomNumber: '702', viewingMethod: 'key', viewingKeyLocation: '前台' }))
  assert.strictEqual(db.listings[0].viewingMethod, '钥匙', '兼容别名 key 归一为钥匙')
}

// 16) 小程序编辑页原样保存不丢公司腾房备注（返修 Codex 2026-07-10 16:39 P2）：
//     公司房源 viewingPassword='15号空出'（推导展示为联系房东）经 editableListingDetail 加载后，
//     未切换方式只改租金保存——upload.js 此时不下发 viewingMethod/viewingKeyLocation/viewingPassword
//     三个键（编辑态方式未变不物化推导值、不清空非当前方式旧值）——备注必须原样保留。
{
  const db = makeDb()
  db.listings.push({
    id: 'L-VACANT-EDIT', uploaderId: 'ADMIN', status: '在租', lifecycleStatus: 'active',
    rent: 3200, address: '杭州拱墅区皋塘运都3栋1单元701室', layout: '整租二室1厅1卫',
    community: '皋塘运都', building: '3', unit: '1', roomNumber: '701',
    companyListing: true, isCompanyListing: true, source: '公司房源', externalSource: 'feishu',
    landlordPhone: '公司统一维护', viewingPassword: '15号空出',
    features: ['电梯'], videoKey: 'v.mp4', videoUrl: 'https://example.com/v.mp4', communityMatched: true
  })
  const editable = domain.editableListingDetail(db, 'ADMIN', 'L-VACANT-EDIT', { admin: true })
  assert.strictEqual(editable.viewingMethod, '联系房东', '编辑回包下发推导方式')
  assert.strictEqual(editable.viewingPassword, '15号空出', '编辑回包带原始备注')
  // 小程序编辑页等价 payload：方式未切换 → 不含 viewingMethod/viewingKeyLocation/viewingPassword 键
  domain.updateNormalListing(db, 'ADMIN', 'L-VACANT-EDIT', {
    city: '杭州', district: '拱墅区', community: '皋塘运都', building: '3', unit: '1', roomNumber: '701',
    contact: editable.contact, rent: 3300, rentMode: '整租', room: '二室', hall: '1厅', bath: '1卫',
    features: ['电梯'], companyListing: true, source: '公司房源'
  }, { admin: true })
  const listing = db.listings.find((item) => item.id === 'L-VACANT-EDIT')
  assert.strictEqual(listing.rent, 3300, '租金已更新')
  assert.strictEqual(listing.viewingPassword, '15号空出', '腾房备注不被原样保存清空')
  assert.strictEqual(String(listing.viewingMethod || ''), '', '推导方式未被物化落库')
  const detail = domain.listingDetail(db, 'L-VACANT-EDIT')
  assert.strictEqual(detail.viewingMethod, '联系房东', '保存后详情仍展示联系房东')
}

console.log('listing-viewing-method-test passed')
