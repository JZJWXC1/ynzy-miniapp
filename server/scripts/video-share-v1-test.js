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
assert.strictEqual(db.footprints[0].actionType, 'video_shared')
assert.strictEqual(db.footprints[0].viewerId, 'U002')
assert.deepStrictEqual(Object.keys(db.footprints[0]).sort(), ['id', 'viewerId', 'listingId', 'actionType', 'occurredAt', 'idempotencyKey'].sort(), '视频转发足迹不得保存分享目标、路径或敏感正文')
assert(result.logs.some((item) => item.action === '转发房间视频给租客'))

const noVideoDb = dbWithListing(listing({ id: 'L-no-video', videoUrl: '', videoKey: '' }))
assert.throws(() => {
  domain.recordVideoShare(noVideoDb, 'U002', 'L-no-video', {})
}, /缺少真实视频|暂无可转发视频/)

assert.throws(() => {
  domain.recordVideoShare(db, '', 'L-video-share', {})
}, /未登录|账号未开通/)

const rateDb = dbWithListing(listing())
for (let index = 0; index < 30; index += 1) {
  domain.recordVideoShare(rateDb, 'U002', 'L-video-share', {})
}
const videoRowsBeforeRateLimit = rateDb.footprints.length
assert.throws(
  () => domain.recordVideoShare(rateDb, 'U002', 'L-video-share', {}),
  (error) => error && error.statusCode === 429 && error.data && error.data.reason === 'FOOTPRINT_RATE_LIMITED',
  '高频视频转发留痕必须由服务端按已验签账号限流'
)
assert.strictEqual(rateDb.footprints.length, videoRowsBeforeRateLimit, '视频留痕限流请求不得继续扩大数据库')

const ROOT_DIR = path.resolve(__dirname, '..', '..')
const detailJs = fs.readFileSync(path.join(ROOT_DIR, 'pages/listing-detail/listing-detail.js'), 'utf8')
const detailWxml = fs.readFileSync(path.join(ROOT_DIR, 'pages/listing-detail/listing-detail.wxml'), 'utf8')
const detailWxss = fs.readFileSync(path.join(ROOT_DIR, 'pages/listing-detail/listing-detail.wxss'), 'utf8')

assert(detailJs.includes('wx.downloadFile'), '一键转发前必须先下载签名视频到临时文件')
assert(detailJs.includes('wx.shareVideoMessage'), '一键转发必须优先发送视频气泡')
assert(detailJs.includes('videoPath: filePath'), 'wx.shareVideoMessage 必须使用本地视频路径')
assert(detailJs.includes('wx.shareFileMessage'), '一键转发必须发送原视频文件')
assert(detailJs.includes('wx.saveVideoToPhotosAlbum'), '不支持直接发送文件时必须回退保存视频到相册')
assert(detailJs.includes('wx.hideShareMenu'), '房源详情页必须禁用右上角原生小程序转发')
assert(!detailJs.includes('onShareAppMessage'), '一键转发不得再走小程序卡片分享')
assert(!detailWxml.includes('open-type="share"'), '一键转发按钮不得触发小程序卡片')

const prepareStart = detailJs.indexOf('async prepareVideoShare()')
const prepareEnd = detailJs.indexOf('revealSensitive()', prepareStart)
assert(prepareStart !== -1 && prepareEnd > prepareStart, '必须存在 prepareVideoShare 流程')
const prepareVideoShareSource = detailJs.slice(prepareStart, prepareEnd)
const videoShareIndex = prepareVideoShareSource.indexOf('this.shareVideoMessage(filePath)')
const fileShareIndex = prepareVideoShareSource.indexOf('this.shareVideoFile(filePath)')
const albumShareIndex = prepareVideoShareSource.indexOf('this.fallbackSaveVideo(filePath)')
assert(videoShareIndex !== -1 && fileShareIndex !== -1 && albumShareIndex !== -1, '必须实现视频气泡、文件、相册三级降级')
assert(videoShareIndex < fileShareIndex && fileShareIndex < albumShareIndex, '三级降级顺序必须是 shareVideoMessage -> shareFileMessage -> 保存相册')

const shareVideoBlock = detailJs.match(/wx\.shareVideoMessage\(\{([\s\S]*?)\n\s*\}\)/)
assert(shareVideoBlock, '必须存在 wx.shareVideoMessage 调用')
const shareVideoPayload = shareVideoBlock[1].replace(/\bvideoPath\b/g, '')
assert(!/\b(title|path|fileName|name)\s*:/.test(shareVideoPayload), '发送视频气泡不得携带小程序卡片、标题或文件名参数')

const shareFileBlock = detailJs.match(/wx\.shareFileMessage\(\{([\s\S]*?)\n\s*\}\)/)
assert(shareFileBlock, '必须存在 wx.shareFileMessage 调用')
const shareFilePayload = shareFileBlock[1].replace(/\bfilePath\b/g, '')
assert(!/\b(title|path|fileName|name)\s*:/.test(shareFilePayload), '发送文件不得携带小程序卡片、标题或文件名参数')

assert(detailJs.includes("sharePath: ''"), '转发留痕不得写入小程序分享路径')
assert(detailJs.includes('不包含地址、房东电话、楼栋单元房号'), '转发提示必须明确不包含敏感房源信息')
assert(!detailWxml.includes('purpose-options'), '暂停新流程后详情不得恢复查看用途选择')

console.log('video-share-v1-test passed')
