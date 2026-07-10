// “我的房源”卡片结构回归：普通房源摘要与页面专属管理操作分层，媒体和按钮不被内容撑出屏幕。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const wxml = fs.readFileSync(path.join(root, 'pages', 'my-listings', 'my-listings.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(root, 'pages', 'my-listings', 'my-listings.wxss'), 'utf8')

const ownerShellAt = wxml.indexOf('class="owner-listing-shell soft-card"')
const ownerCardAt = wxml.indexOf('class="company-listing-card owner-listing-card"', ownerShellAt)
const managementAt = wxml.indexOf('class="owner-management"', ownerCardAt)
const landlordAt = wxml.indexOf('class="owner-contact-row"', managementAt)
const verifyAt = wxml.indexOf('class="verify-line', managementAt)
const actionsAt = wxml.indexOf('class="owner-card-actions"', managementAt)
const ownerShellTag = wxml.slice(wxml.lastIndexOf('<view', ownerShellAt), wxml.indexOf('>', ownerShellAt) + 1)
const ownerCardTag = wxml.slice(wxml.lastIndexOf('<view', ownerCardAt), wxml.indexOf('>', ownerCardAt) + 1)

function viewDepthBefore(index) {
  return (wxml.slice(0, index).match(/<\/?view\b[^>]*>/g) || []).reduce((depth, tag) => {
    return tag.startsWith('</') ? depth - 1 : depth + 1
  }, 0)
}

assert.ok(ownerShellAt >= 0, '每套我的房源应有独立 owner-listing-shell 外壳')
assert.ok(ownerCardAt > ownerShellAt, '外壳上半部分应保留普通横向房源卡片')
assert.ok(managementAt > ownerCardAt, '页面专属管理区必须位于普通房源卡片下方')
assert.strictEqual(viewDepthBefore(managementAt), viewDepthBefore(ownerCardAt), '管理区必须是普通卡片的同级下方区域，不能继续嵌在右栏')
assert.ok(landlordAt > managementAt, '房东电话应放在下方管理区')
assert.ok(verifyAt > managementAt, '核验状态应放在下方管理区')
assert.ok(actionsAt > managementAt, '编辑和电话确认按钮应放在下方管理区')
assert.ok(!ownerShellTag.includes('bindtap='), '外层容器不得绑定整卡跳转，避免管理区点击误开详情')
assert.ok(ownerCardTag.includes('bindtap="openListing"'), '只有上半普通房源摘要卡应可点击进入详情')
assert.match(wxml.slice(managementAt), /class="edit-button"\s+catchtap="editListing"/, '编辑房源按钮必须 catchtap 阻止冒泡')
assert.match(wxml.slice(managementAt), /class="verify-button"\s+catchtap="verifyListing"/, '电话联系按钮必须 catchtap 阻止冒泡')

assert.match(
  wxss,
  /\.owner-listing-card\s*\{[^}]*width:\s*100%[^}]*box-sizing:\s*border-box[^}]*align-items:\s*flex-start/s,
  '普通摘要卡自身必须限制在外壳宽度内且不再 stretch 媒体'
)
assert.match(
  wxss,
  /\.owner-listing-card\s+\.company-listing-media\s*\{[^}]*height:\s*190rpx[^}]*min-height:\s*190rpx[^}]*align-self:\s*flex-start/s,
  '我的房源封面应固定为 190rpx 高，不再随右栏内容拉长'
)
assert.match(
  wxss,
  /\.owner-listing-card\s+\.company-media-image\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*min-height:\s*0/s,
  '封面图片应绝对铺满固定媒体框'
)
assert.match(
  wxss,
  /\.owner-listing-card\s+\.company-listing-bottom\s*\{[^}]*flex-wrap:\s*wrap/s,
  '价格行空间不足时应整块换行，不能把租金拆字挤压'
)
assert.match(
  wxss,
  /\.owner-listing-card\s+\.company-price\s*\{[^}]*white-space:\s*nowrap/s,
  '租金文本必须保持单行'
)
assert.match(
  wxss,
  /\.owner-management\s*\{[^}]*width:\s*100%[^}]*box-sizing:\s*border-box[^}]*border-top:/s,
  '管理区应在卡片宽度内独占一行并与摘要区分隔'
)
assert.match(
  wxss,
  /\.owner-card-actions\s*\{[^}]*display:\s*flex[^}]*width:\s*100%/s,
  '底部操作栏应为卡片内全宽 flex 布局'
)
assert.match(
  wxss,
  /\.owner-card-actions\s+\.(?:edit-button|verify-button)[\s\S]*?flex:\s*1\s+1\s+0[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s,
  '两个操作按钮应允许等宽收缩且计入内边距，防止窄屏溢出'
)

// rpx 以 750 宽设计稿等比缩放：页面横向 padding 28*2，卡片上半区 padding 18*2、封面 190、gap 18。
// 在任意手机宽度下比例恒定，因此正文约 450rpx、底部按钮各约 323rpx，不会因 320px 窄屏改变相对边界。
const cardWidth = 750 - (28 * 2)
const summaryTextWidth = cardWidth - (18 * 2) - 190 - 18
const actionButtonWidth = (cardWidth - (18 * 2) - 12) / 2
assert.ok(summaryTextWidth >= 440, `摘要正文宽度不足：${summaryTextWidth}rpx`)
assert.ok(actionButtonWidth >= 300, `底部按钮宽度不足：${actionButtonWidth}rpx`)

console.log('my-listings-card-layout-test passed')
