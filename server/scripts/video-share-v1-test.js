const assert = require('assert')
const domain = require('../src/domain')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function listing(overrides = {}) {
  return {
    id: 'L-video-share',
    title: '视频转发测试房源',
    shortTitle: '视频转发小区',
    uploaderId: 'U001',
    rent: 2600,
    layout: '整租一室1厅1卫',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '申花',
    community: '视频转发小区',
    address: '杭州拱墅区视频转发小区1幢1单元101',
    landlordPhone: '13800000000',
    commissionRate: 20,
    videoUrl: 'https://example.com/room-video.mp4',
    videoKey: 'house-videos/video-share.mp4',
    status: '待确认',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: '整租',
    rentMode: '整租',
    features: ['电梯', '近地铁'],
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    ...overrides
  }
}

function dbWithListing(item) {
  return {
    users: [
      { id: 'U001', name: '上传人', role: '中介', authed: '手机号登录' },
      { id: 'U002', name: '推荐中介', role: '中介', authed: '手机号登录' }
    ],
    listings: [item],
    footprints: []
  }
}

const db = dbWithListing(listing())
const result = domain.recordVideoShare(db, 'U002', 'L-video-share', {
  channel: 'wechat',
  target: 'tenant',
  sharePath: '/pages/shared-video/shared-video?id=L-video-share',
  shareTitle: '推荐你看这套房'
})

assert.strictEqual(result.message, '视频转发已留痕')
assert.strictEqual(result.share.broker, '推荐中介')
assert.strictEqual(db.footprints.length, 1)
assert.strictEqual(db.footprints[0].action, '转发房间视频给租客')
assert.strictEqual(db.footprints[0].viewerId, 'U002')
assert.strictEqual(db.footprints[0].shareTarget, 'tenant')
assert(result.logs.some((item) => item.action === '转发房间视频给租客'))

const noVideoDb = dbWithListing(listing({ id: 'L-no-video', videoUrl: '', videoKey: '' }))
assert.throws(() => {
  domain.recordVideoShare(noVideoDb, 'U002', 'L-no-video', {})
}, /缺少真实视频|暂无可转发视频/)

assert.throws(() => {
  domain.recordVideoShare(db, '', 'L-video-share', {})
}, /未登录|账号未开通/)

console.log('video-share-v1-test passed')
