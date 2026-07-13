'use strict'

// 电话确认房态三选项锁定测试：未出租=已维护；已出租/不租了=下架进后台资产池(原因分开记)；权限/缺省。

const assert = require('assert')
const domain = require('../src/domain')

function makeDb() {
  return {
    users: [{ id: 'U1' }, { id: 'U2' }, { id: 'ADMIN', isAdmin: true }],
    listings: [{
      id: 'L1', uploaderId: 'U1', status: '在租', lifecycleStatus: 'active',
      rent: 3500, landlordPhone: '13800001111', address: '杭州x', lastVerifiedAt: '2026/7/1',
      videoKey: 'v.mp4', communityMatched: true
    }],
    footprints: [], rentalNeeds: []
  }
}

// 1) 未出租 → 已维护（仍 active，不下架）。
{
  const db = makeDb()
  const r = domain.submitListingVerification(db, 'U1', 'L1', '未出租')
  assert.strictEqual(r.outcome, 'available', '未出租=已维护')
  assert.strictEqual(db.listings[0].lifecycleStatus, 'active')
  assert.notStrictEqual(db.listings[0].status, '已下架')
}

// 2) 已出租 → 下架进资产池，原因=房东反馈已出租。
{
  const db = makeDb()
  const r = domain.submitListingVerification(db, 'U1', 'L1', '已出租')
  assert.strictEqual(r.outcome, 'rented')
  const l = db.listings[0]
  assert.strictEqual(l.lifecycleStatus, 'expired')
  assert.strictEqual(l.status, '已下架')
  assert.strictEqual(l.expiredPool, '后台资产池')
  assert.strictEqual(l.expiredReason, '房东反馈已出租')
}

// 3) 不租了 → 下架进资产池，原因=房东反馈不租了。
{
  const db = makeDb()
  const r = domain.submitListingVerification(db, 'U1', 'L1', '不租了')
  assert.strictEqual(r.outcome, 'withdrawn')
  assert.strictEqual(db.listings[0].status, '已下架')
  assert.strictEqual(db.listings[0].expiredReason, '房东反馈不租了')
}

// 4) 非上传人（且非管理员）不能操作别人房源；被拒后状态不变。
{
  const db = makeDb()
  assert.throws(
    () => domain.submitListingVerification(db, 'U2', 'L1', '已出租'),
    (e) => e && e.statusCode === 403,
    '非上传人不能操作别人房源'
  )
  assert.strictEqual(db.listings[0].status, '在租', '被拒后房源状态不变')
}

// 5) 无效 outcome → 400。
{
  const db = makeDb()
  assert.throws(() => domain.submitListingVerification(db, 'U1', 'L1', 'xxx'), (e) => e && e.statusCode === 400)
}

// 6) 缺省 outcome（旧客户端只点确认）→ 已维护，向后兼容。
{
  const db = makeDb()
  assert.strictEqual(domain.submitListingVerification(db, 'U1', 'L1').outcome, 'available', '缺省=已维护')
}

// 7) isOwnListing（详情页自查免留痕判定）：本人 true；他人/游客空/不存在 false。
{
  const db = makeDb()
  assert.strictEqual(domain.isOwnListing(db, 'L1', 'U1'), true, '上传人本人 = own')
  assert.strictEqual(domain.isOwnListing(db, 'L1', 'U2'), false, '他人 ≠ own（查看敏感信息仍须留痕，但无需绑定需求单）')
  assert.strictEqual(domain.isOwnListing(db, 'L1', ''), false, '空 userId = false（游客）')
  assert.strictEqual(domain.isOwnListing(db, 'NOPE', 'U1'), false, '不存在房源 = false')
}

// 8) 上传人反复核验也受服务端一分钟窗口约束；窗口结束后恢复，不能用唯一动作无限放大足迹。
{
  const db = makeDb()
  for (let index = 0; index < 30; index += 1) {
    domain.submitListingVerification(db, 'U1', 'L1', '未出租')
  }
  const before = db.footprints.length
  assert.throws(
    () => domain.submitListingVerification(db, 'U1', 'L1', '未出租'),
    (error) => error && error.statusCode === 429 && error.data && error.data.reason === 'FOOTPRINT_RATE_LIMITED',
    '上传人高频核验必须由服务端按验签账号和动作限流'
  )
  assert.strictEqual(db.footprints.length, before, '核验限流后不得新增足迹')
  db.footprints.forEach((record) => { record.occurredAt = new Date(Date.now() - 61 * 1000).toISOString() })
  assert.strictEqual(domain.submitListingVerification(db, 'U1', 'L1', '未出租').outcome, 'available', '一分钟窗口结束后应恢复核验')
}

// 9) 待审核房源不能通过“未出租”或旧客户端缺省确认绕过审核重新上架；拒绝必须零变化。
{
  ;['未出租', undefined].forEach((outcome) => {
    const db = makeDb()
    Object.assign(db.listings[0], {
      status: '待审核',
      reviewStatus: '待审核',
      requiresManualReview: true,
      lifecycleStatus: 'active'
    })
    const before = JSON.parse(JSON.stringify(db))
    assert.throws(
      () => domain.submitListingVerification(db, 'U1', 'L1', outcome),
      (error) => error && error.statusCode === 409 && /审核/.test(error.message),
      '待审核房源确认“未出租”必须 409'
    )
    assert.deepStrictEqual(db, before, '待审核房源被拒后状态、推荐资料和足迹必须零变化')
  })

  const adminDb = makeDb()
  Object.assign(adminDb.listings[0], { status: '待审核', reviewStatus: '待审核', requiresManualReview: true })
  assert.throws(
    () => domain.submitListingVerification(adminDb, 'ADMIN', 'L1', '未出租', { admin: true }),
    (error) => error && error.statusCode === 409,
    '管理员也必须走审核接口，不能用房态核验旁路上架待审核房源'
  )

  const adminRouteDb = makeDb()
  Object.assign(adminRouteDb.listings[0], { status: '待审核', reviewStatus: '待审核', requiresManualReview: true })
  const adminRouteBefore = JSON.parse(JSON.stringify(adminRouteDb))
  assert.throws(
    () => domain.verifyListingAvailability(adminRouteDb, 'ADMIN', 'L1', { admin: true }),
    (error) => error && error.statusCode === 409 && /审核/.test(error.message),
    '后台核验路由直接调用 verifyListingAvailability 时也必须阻止待审核房源上架'
  )
  assert.deepStrictEqual(adminRouteDb, adminRouteBefore, '后台核验路由被拒后必须保持房源、推荐资料与足迹零变化')

  const withdrawDb = makeDb()
  Object.assign(withdrawDb.listings[0], { status: '待审核', reviewStatus: '待审核', requiresManualReview: true })
  const withdrawn = domain.submitListingVerification(withdrawDb, 'U1', 'L1', '不租了')
  assert.strictEqual(withdrawn.outcome, 'withdrawn', '待审核上传人仍可撤回不租，保留原下架通道')
  assert.strictEqual(withdrawDb.listings[0].status, '已下架')
}

console.log('listing-verify-outcome-v1-test passed')
