const assert = require('assert')
const fs = require('fs')
const path = require('path')
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

const ROOT_DIR = path.resolve(__dirname, '..', '..')
const detailJs = fs.readFileSync(path.join(ROOT_DIR, 'pages/listing-detail/listing-detail.js'), 'utf8')
const detailWxml = fs.readFileSync(path.join(ROOT_DIR, 'pages/listing-detail/listing-detail.wxml'), 'utf8')
const detailWxss = fs.readFileSync(path.join(ROOT_DIR, 'pages/listing-detail/listing-detail.wxss'), 'utf8')

assert(detailJs.includes('wx.downloadFile'), '一键转发前必须先下载签名视频到临时文件')
assert(detailJs.includes('wx.shareFileMessage'), '一键转发必须发送原视频文件')
assert(detailJs.includes('wx.saveVideoToPhotosAlbum'), '不支持直接发送文件时必须回退保存视频到相册')
assert(!detailJs.includes('onShareAppMessage'), '一键转发不得再走小程序卡片分享')
assert(!detailWxml.includes('open-type="share"'), '一键转发按钮不得触发小程序卡片')

const shareFileBlock = detailJs.match(/wx\.shareFileMessage\(\{([\s\S]*?)\n\s*\}\)/)
assert(shareFileBlock, '必须存在 wx.shareFileMessage 调用')
const shareFilePayload = shareFileBlock[1].replace(/\bfilePath\b/g, '')
assert(!/\b(title|path|fileName|name)\s*:/.test(shareFilePayload), '发送文件不得携带小程序卡片、标题或文件名参数')

assert(detailJs.includes("sharePath: ''"), '转发留痕不得写入小程序分享路径')
assert(detailJs.includes('不包含地址、房东电话、楼栋单元房号'), '转发提示必须明确不包含敏感房源信息')
assert(detailWxss.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)'), '查看用途弹窗按钮区必须避免窄屏截断')
assert(detailWxss.includes('white-space: normal'), '查看用途按钮文字必须允许换行')

console.log('video-share-v1-test passed')
