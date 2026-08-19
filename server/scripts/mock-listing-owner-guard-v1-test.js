'use strict'

const assert = require('assert')
const mockData = require('../../utils/mock-data')

function capture(action) {
  try {
    return { value: action(), error: null }
  } catch (error) {
    return { value: undefined, error }
  }
}

function assertStatus(outcome, statusCode, label) {
  assert.ok(outcome.error, `${label} 必须失败`)
  assert.strictEqual(outcome.error.statusCode, statusCode, `${label} 必须返回 ${statusCode}`)
}

function listingPayload() {
  return {
    city: '杭州',
    district: '上城区',
    area: '上城区',
    block: '彭埠',
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    building: '1',
    unit: '2',
    roomNumber: '701',
    address: '杭州上城区京漾东韵府1栋2单元701室',
    contact: '19900001111',
    landlordPhone: '19900001111',
    rent: '3200',
    layout: '两室1厅1卫',
    rentMode: '整租',
    type: '整租',
    room: '两室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯'],
    videoUrl: 'https://example.com/synthetic/owner-guard.mp4',
    viewingMethod: '联系房东',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    landlordCommissionPercent: 50
  }
}

mockData.loginByPhone('13800010005')
const created = mockData.addNormalListing(listingPayload())
assert.ok(created && created.id, '测试前置必须由普通中介创建房源')
const listingId = created.id

mockData.loginByPhone('13800010002')
const crossAccountRead = capture(() => mockData.getEditableListing(listingId))
const crossAccountUpdate = capture(() => mockData.updateNormalListing(listingId, {}))
const crossAccountVerify = capture(() => mockData.verifyMyListing(listingId, '未出租'))
assertStatus(crossAccountRead, 403, '其他中介读取可编辑房源详情')
assertStatus(crossAccountUpdate, 403, '其他中介修改房源')
assertStatus(crossAccountVerify, 403, '其他中介维护房态')

// 管理员例外必须与生产领域层一致：可协助读取、编辑和维护任意房源。
mockData.loginByPhone('13800010004')
const adminView = mockData.getEditableListing(listingId)
assert.strictEqual(adminView.id, listingId, '管理员必须仍可读取房源编辑详情')
const adminUpdated = mockData.updateNormalListing(listingId, {
  ...listingPayload(),
  rent: '3300'
})
assert.strictEqual(String(adminUpdated.rent), '3300', '管理员必须仍可协助编辑房源')
assert.ok(Array.isArray(mockData.verifyMyListing(listingId, '未出租')), '管理员必须仍可协助维护房态')

// 上传人自己的原流程不得因越权修复受损。
mockData.loginByPhone('13800010005')
const ownerView = mockData.getEditableListing(listingId)
assert.strictEqual(ownerView.id, listingId, '上传人必须仍可读取自己的编辑详情')
const ownerUpdated = mockData.updateNormalListing(listingId, {
  ...listingPayload(),
  rent: '3400'
})
assert.strictEqual(String(ownerUpdated.rent), '3400', '上传人必须仍可编辑自己的房源')
assert.ok(Array.isArray(mockData.verifyMyListing(listingId, '未出租')), '上传人必须仍可维护自己的房态')

mockData.logout()
assertStatus(capture(() => mockData.getEditableListing(listingId)), 401, '未登录读取可编辑房源详情')
assertStatus(capture(() => mockData.updateNormalListing(listingId, {})), 401, '未登录修改房源')
assertStatus(capture(() => mockData.verifyMyListing(listingId, '未出租')), 401, '未登录维护房态')

console.log('mock-listing-owner-guard-v1-test passed')
