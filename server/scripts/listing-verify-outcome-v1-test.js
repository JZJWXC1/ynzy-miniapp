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

console.log('listing-verify-outcome-v1-test passed')
