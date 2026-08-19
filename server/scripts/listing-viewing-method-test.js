'use strict'

// 看房方式（钥匙/密码/联系房东）锁定测试：条件必填矩阵、存量兼容、敏感边界（留痕前不泄漏钥匙位置/密码）、
// 编辑切换清空旧值、公司房源公开口径、助手安全层脱敏。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
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
    contact: '13911112222',
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

// 1) 钥匙 + 钥匙位置 + 房东手机号 → 通过；房东手机号对所有方式必填。
{
  const db = makeDb()
  const created = domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙', viewingKeyLocation: '前台领取' }))
  const listing = db.listings[0]
  assert.strictEqual(listing.viewingMethod, '钥匙', '看房方式落库')
  assert.strictEqual(listing.viewingKeyLocation, '前台领取', '钥匙位置落库')
  assert.strictEqual(listing.landlordPhone, '13911112222', '钥匙方式也保存房东手机号')
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
    () => domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '联系房东', contact: '' })),
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
    () => domain.addNormalListing(db, 'U1', baseForm({ roomNumber: '504', contact: '' })),
    (e) => e && e.statusCode === 400 && /房东手机号/.test(e.message),
    '无方式且无联系方式应 400'
  )
}

// 5) 敏感边界：非公司房源详情留痕前连方式名也不下发；地址、房号、钥匙、密码和备注全部锁住。
{
  const db = makeDb()
  domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙', viewingKeyLocation: '3栋门卫处', remark: '门口鞋柜取钥匙' }))
  const detail = domain.listingDetail(db, db.listings[0].id)
  assert.ok(!('viewingMethod' in detail), '留痕前不下发看房方式')
  assert.ok(!('viewingMethodText' in detail), '留痕前不下发看房方式文案')
  assert.ok(!('viewingKeyLocation' in detail), '留痕前不下发钥匙位置')
  assert.ok(!('viewingPassword' in detail), '留痕前不下发看房密码')
  assert.ok(!('address' in detail), '留痕前不下发完整地址字段')
  assert.ok(!('remark' in detail), '留痕前不下发敏感备注')
}

// 6) 留痕后（他人查看）sensitive 载荷携带钥匙位置；上传人自查免留痕分支同样带全。
{
  const db = makeDb()
  domain.addNormalListing(db, 'U1', baseForm({ viewingMethod: '钥匙', viewingKeyLocation: '3栋门卫处', remark: '门口鞋柜取钥匙' }))
  const listingId = db.listings[0].id
  const need = domain.createRentalNeed(db, 'U2', { rawText: '客户想看皋塘运都两室' })
  const viewed = domain.addSensitiveFootprint(db, 'U2', listingId, {
    needId: need.need.id,
    purpose: '带客户看房'
  })
  assert.strictEqual(viewed.sensitive.viewingMethod, '钥匙')
  assert.strictEqual(viewed.sensitive.viewingKeyLocation, '3栋门卫处', '留痕后下发钥匙位置')
  assert.strictEqual(viewed.sensitive.remark, '门口鞋柜取钥匙', '留痕后下发敏感备注')
  assert.strictEqual(db.footprints.length, 1, '他人查看留足迹')
  const own = domain.addSensitiveFootprint(db, 'U1', listingId, {})
  assert.strictEqual(own.sensitive.viewingKeyLocation, '3栋门卫处', '上传人自查直出')
  assert.strictEqual(own.sensitive.remark, '门口鞋柜取钥匙', '上传人自查同样拿到敏感备注')
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

// 8) 存量推导展示：公开详情仍隐藏方式；留痕后老房源有密码 →「密码」，只有电话 →「联系房东」。
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
  assert.ok(!('viewingMethod' in pwdDetail), '存量合作房源公开详情也不下发方式')
  const phoneDetail = domain.listingDetail(db, 'L-OLD-PHONE')
  assert.ok(!('viewingMethod' in phoneDetail), '存量电话房源公开详情也不下发方式')
  const pwdSensitive = domain.addSensitiveFootprint(db, 'U2', 'L-OLD-PWD', { idempotencyKey: 'SV-OLD-PWD-001' })
  assert.strictEqual(pwdSensitive.sensitive.viewingMethod, '密码', '留痕后有密码的存量推导为密码')
  const phoneSensitive = domain.addSensitiveFootprint(db, 'U2', 'L-OLD-PHONE', { idempotencyKey: 'SV-OLD-PHONE-001' })
  assert.strictEqual(phoneSensitive.sensitive.viewingMethod, '联系房东', '留痕后有电话的存量推导为联系房东')
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

// 10) 助手安全层：看房方式、密码、钥匙位置和备注都属敏感键，scrubDeep 后不外泄。
{
  const scrubbed = safety.scrubDeep({
    community: '皋塘运都',
    viewingPassword: '1234#',
    showingPassword: '1234#',
    viewingMethod: '密码',
    viewingMethodText: '密码',
    viewingKeyLocation: '前台领取',
    keyLocation: '前台领取',
    remark: '门口鞋柜取钥匙'
  })
  assert.strictEqual(scrubbed.community, '皋塘运都', '非敏感字段保留')
  assert.notStrictEqual(scrubbed.viewingPassword, '1234#', 'viewingPassword 被脱敏')
  assert.notStrictEqual(scrubbed.showingPassword, '1234#', 'showingPassword 被脱敏')
  assert.notStrictEqual(scrubbed.viewingMethod, '密码', 'viewingMethod 被脱敏')
  assert.notStrictEqual(scrubbed.remark, '门口鞋柜取钥匙', 'remark 被脱敏')
  assert.notStrictEqual(scrubbed.viewingKeyLocation, '前台领取', 'viewingKeyLocation 被脱敏')
  assert.notStrictEqual(scrubbed.keyLocation, '前台领取', 'keyLocation 被脱敏')
  assert.ok(safety._internal.SENSITIVE_KEYS.has('viewingPassword'), '敏感键清单含 viewingPassword')
  assert.ok(safety._internal.SENSITIVE_KEYS.has('viewingKeyLocation'), '敏感键清单含 viewingKeyLocation')
}

// 10.1) 客户端也必须 fail-closed：即使连接旧/灰度后端误带 remark，合作房源仍只在留痕解锁后渲染。
{
  const detailWxml = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'listing-detail', 'listing-detail.wxml'), 'utf8')
  assert.ok(
    detailWxml.includes('listing.remark && (listing.companyListing || sensitiveVisible)'),
    '详情备注必须由公司公开规则或 sensitiveVisible 门禁保护'
  )
}

// 11) 存量「电话+密码并存」的非公司房源 → 留痕后电话优先推导为联系房东；
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
    landlordPhone: '13911112222', viewingPassword: '2468#', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
  })
  const both = domain.listingDetail(db, 'L-BOTH')
  assert.ok(!('viewingMethod' in both), '非公司双信息公开详情仍隐藏看房方式')
  const bothSensitive = domain.addSensitiveFootprint(db, 'U2', 'L-BOTH', { idempotencyKey: 'SV-BOTH-001' })
  assert.strictEqual(bothSensitive.sensitive.viewingMethod, '联系房东', '非公司双信息留痕后电话优先')
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
    landlordPhone: '13911112222', viewingPassword: '1357#', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
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
    contact: '13911112222'
  }), { admin: true })
  const listingId = db.listings[0].id
  domain.updateNormalListing(db, 'ADMIN', listingId, baseForm({
    companyListing: true,
    contact: '13911112222',
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
    landlordPhone: '13911112222', features: ['电梯'], videoKey: 'v.mp4', communityMatched: true
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
    landlordPhone: '13911112222', viewingPassword: '15号空出',
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

// 17) 真实前端载荷锁定（返修 Codex 2026-07-10 18:20 P2-1/P2-2）：加载真实 pages/upload/upload.js
//     捕获 Page 定义，经 loadEditableListing → buildSubmitPayload 走通四条路径：
//     ① 页面持有旧真密码、服务端并发变为腾房备注、只改租金 → 备注保留、有效方式=联系房东；
//     ② 页面持有旧腾房备注、服务端并发变为真密码 → 不被旧页覆盖、有效方式=密码；
//     ③ 用户确实修改当前密码 → 仍能保存（脏检查放行）；
//     ④ 显式切换与新建的三键契约不回退。
;(async () => {
  const path = require('path')
  const repoRoot = path.join(__dirname, '..', '..')
  const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
  const uploadPagePath = require.resolve(path.join(repoRoot, 'pages', 'upload', 'upload.js'))

  // api-service 桩占住 require 缓存，让真实 upload.js 加载时直接取到（不触真实网络层/mock 层）
  const apiStub = {
    _editable: null,
    getEditableListing() { return Promise.resolve(JSON.parse(JSON.stringify(apiStub._editable))) },
    getCurrentUser() { return Promise.resolve({ id: 'ADMIN', isAdmin: true }) },
    getCommissionConfig() { return Promise.resolve({}) }
  }
  require.cache[apiServicePath] = { id: apiServicePath, filename: apiServicePath, loaded: true, exports: apiStub }
  let pageDef = null
  global.Page = (def) => { pageDef = def }
  global.wx = {
    showLoading() {}, hideLoading() {}, showToast() {}, showModal() {},
    navigateTo() {}, navigateBack() {}, redirectTo() {}, chooseMedia() {}
  }
  require(uploadPagePath)
  assert.ok(pageDef && typeof pageDef.buildSubmitPayload === 'function', '真实上传页 Page 定义已捕获')

  function makePage() {
    const instance = Object.assign({}, pageDef)
    instance.data = JSON.parse(JSON.stringify(pageDef.data))
    // 小程序 setData 语义：支持 'form.x' 点路径 + 回调
    instance.setData = function (patch, callback) {
      Object.keys(patch || {}).forEach((key) => {
        const parts = key.split('.')
        let target = instance.data
        for (let i = 0; i < parts.length - 1; i += 1) target = target[parts[i]]
        target[parts[parts.length - 1]] = patch[key]
      })
      if (typeof callback === 'function') callback()
    }
    return instance
  }
  async function openEditPage(editable) {
    apiStub._editable = editable
    const page = makePage()
    page.setData({ isAdmin: true, currentUser: { id: 'ADMIN', isAdmin: true } })
    page.loadEditableListing(editable.id)
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(page.data.mode, 'edit', '编辑态加载完成')
    return page
  }
  function inputField(page, field, value) {
    page.updateField({ currentTarget: { dataset: { field } }, detail: { value } })
  }
  function submitPayload(page) {
    const validation = page.validateForm()
    assert.strictEqual(validation.ok, true, `前端校验应通过：${validation.message || ''}`)
    return page.buildSubmitPayload(validation, null)
  }
  function pushCompanyListing(db, id, roomNumber, viewingPassword) {
    db.listings.push({
      id, uploaderId: 'ADMIN', status: '在租', lifecycleStatus: 'active',
      rent: 3200, address: `杭州拱墅区半山家苑3栋1单元${roomNumber}室`, layout: '整租二室1厅1卫',
      community: '半山家苑', building: '3', unit: '1', roomNumber,
      companyListing: true, isCompanyListing: true, source: '公司房源', externalSource: 'feishu',
      landlordPhone: '13911112222', viewingPassword,
      features: ['电梯'], videoKey: 'v.mp4', videoUrl: 'https://example.com/v.mp4', communityMatched: true
    })
  }
  // 飞书同步形状：恒带显式 viewingPassword 键、从不带 viewingMethod 键
  function feishuConcurrentWrite(db, id, viewingPassword) {
    domain.updateNormalListing(db, 'ADMIN', id, { viewingPassword }, { admin: true })
  }

  // ① 页面旧真密码 vs 飞书并发腾房备注：只改租金保存，备注须保留
  {
    const db = makeDb()
    pushCompanyListing(db, 'L-CC-1', '801', '9527#')
    const page = await openEditPage(domain.editableListingDetail(db, 'ADMIN', 'L-CC-1', { admin: true }))
    assert.strictEqual(page.data.form.viewingMethod, '密码', '页面按真密码推导为密码方式')
    feishuConcurrentWrite(db, 'L-CC-1', '20号空出')
    inputField(page, 'rent', '3300')
    const payload = submitPayload(page)
    assert.ok(!('viewingMethod' in payload) && !('viewingPassword' in payload) && !('viewingKeyLocation' in payload),
      '方式未切换且密码未改动：三键全省略')
    domain.updateNormalListing(db, 'ADMIN', 'L-CC-1', payload, { admin: true })
    const listing = db.listings.find((item) => item.id === 'L-CC-1')
    assert.strictEqual(listing.rent, 3300, '租金已更新')
    assert.strictEqual(listing.viewingPassword, '20号空出', '飞书并发新备注不被页面旧密码覆盖')
    assert.strictEqual(domain.listingDetail(db, 'L-CC-1').viewingMethod, '联系房东', '有效方式为联系房东')
  }

  // ② 页面旧腾房备注 vs 飞书并发真密码：不被旧页覆盖
  {
    const db = makeDb()
    pushCompanyListing(db, 'L-CC-2', '802', '15号空出')
    const page = await openEditPage(domain.editableListingDetail(db, 'ADMIN', 'L-CC-2', { admin: true }))
    assert.strictEqual(page.data.form.viewingMethod, '联系房东', '页面按腾房备注推导为联系房东')
    feishuConcurrentWrite(db, 'L-CC-2', '6688#')
    inputField(page, 'rent', '3400')
    const payload = submitPayload(page)
    assert.ok(!('viewingMethod' in payload) && !('viewingPassword' in payload) && !('viewingKeyLocation' in payload),
      '联系房东未切换：三键全省略')
    domain.updateNormalListing(db, 'ADMIN', 'L-CC-2', payload, { admin: true })
    assert.strictEqual(db.listings.find((item) => item.id === 'L-CC-2').viewingPassword, '6688#', '并发真密码保留')
    assert.strictEqual(domain.listingDetail(db, 'L-CC-2').viewingMethod, '密码', '有效方式为密码')
  }

  // ③ 用户确实修改当前密码：脏检查放行，仍能保存
  {
    const db = makeDb()
    pushCompanyListing(db, 'L-CC-3', '803', '9527#')
    const page = await openEditPage(domain.editableListingDetail(db, 'ADMIN', 'L-CC-3', { admin: true }))
    inputField(page, 'viewingPassword', '8888#')
    const payload = submitPayload(page)
    assert.strictEqual(payload.viewingPassword, '8888#', '改动过的密码照常下发')
    assert.ok(!('viewingMethod' in payload), '方式未切换仍不物化')
    domain.updateNormalListing(db, 'ADMIN', 'L-CC-3', payload, { admin: true })
    assert.strictEqual(db.listings.find((item) => item.id === 'L-CC-3').viewingPassword, '8888#', '新密码已保存')
  }

  // ④ 契约不回退：显式切换清旧值；新建三键显式下发
  {
    const db = makeDb()
    pushCompanyListing(db, 'L-CC-4', '804', '9527#')
    const page = await openEditPage(domain.editableListingDetail(db, 'ADMIN', 'L-CC-4', { admin: true }))
    page.selectLayoutOption({ currentTarget: { dataset: { field: 'viewingMethod', value: '钥匙' } } })
    inputField(page, 'viewingKeyLocation', '门店前台')
    const payload = submitPayload(page)
    assert.strictEqual(payload.viewingMethod, '钥匙', '切换后显式下发新方式')
    assert.strictEqual(payload.viewingKeyLocation, '门店前台')
    assert.strictEqual(payload.viewingPassword, '', '切换后旧密码显式清空')
    domain.updateNormalListing(db, 'ADMIN', 'L-CC-4', payload, { admin: true })
    const listing = db.listings.find((item) => item.id === 'L-CC-4')
    assert.strictEqual(listing.viewingMethod, '钥匙')
    assert.strictEqual(listing.viewingPassword, '', '切换方式后密码被清空')

    const createPage = makePage()
    createPage.setData({
      isAdmin: false,
      videoPath: '/tmp/v.mp4',
      videoFile: { tempFilePath: '/tmp/v.mp4', fileName: 'v.mp4', size: 1024, mimeType: 'video/mp4' },
      'form.community': '半山家苑',
      'form.building': '3',
      'form.unit': '1',
      'form.roomNumber': '805',
      'form.rent': '3500',
      'form.contact': '13800006666',
      'form.features': ['电梯']
    })
    const createPayload = submitPayload(createPage)
    assert.strictEqual(createPayload.viewingMethod, '联系房东', '新建显式下发默认方式')
    assert.strictEqual(createPayload.viewingKeyLocation, '', '新建非钥匙方式下发空串')
    assert.strictEqual(createPayload.viewingPassword, '', '新建非密码方式下发空串')
  }

  console.log('listing-viewing-method-test passed')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
