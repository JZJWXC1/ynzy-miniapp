// “我的房源”卡片结构回归：普通房源摘要与页面专属管理操作分层，媒体和按钮不被内容撑出屏幕。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const wxml = fs.readFileSync(path.join(root, 'pages', 'my-listings', 'my-listings.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(root, 'pages', 'my-listings', 'my-listings.wxss'), 'utf8')
const appWxss = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8')

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))
  assert(match, `缺少 CSS 规则：${selector}`)
  return match[1]
}

function rpxValue(rule, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = rule.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*(\\d+)rpx`, 'i'))
  assert(match, `${property} 必须使用可计算的 rpx 数值`)
  return Number(match[1])
}

function horizontalPaddingTotal(rule) {
  const match = rule.match(/(?:^|;)\s*padding\s*:\s*([^;]+)/i)
  assert(match, '参与宽度计算的规则必须声明 padding')
  const values = (match[1].match(/\d+(?:\.\d+)?rpx/g) || []).map((value) => Number.parseFloat(value))
  assert(values.length >= 1 && values.length <= 4, 'padding 必须是 1-4 个 rpx 值')
  if (values.length === 1) return values[0] * 2
  if (values.length === 2 || values.length === 3) return values[1] * 2
  return values[1] + values[3]
}

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

// 从真实 WXSS 读取布局数值，防止测试用自写常量“自己证明自己”。rpx 以 750 宽设计稿等比缩放，
// 因此计算出的相对边界同样适用于 320-375px 窄屏。
const pagePaddingTotal = horizontalPaddingTotal(cssRule(appWxss, '.page-shell'))
const summaryRule = cssRule(wxss, '.company-listing-card')
const summaryPaddingTotal = horizontalPaddingTotal(summaryRule)
const summaryGap = rpxValue(summaryRule, 'gap')
const mediaRule = cssRule(wxss, '.company-listing-media')
const mediaBasisMatch = mediaRule.match(/(?:^|;)\s*flex\s*:\s*0\s+0\s+(\d+)rpx/i)
assert(mediaBasisMatch, '封面宽度必须由 company-listing-media 的 flex-basis 固定')
const mediaWidth = Number(mediaBasisMatch[1])
const managementPaddingTotal = horizontalPaddingTotal(cssRule(wxss, '.owner-management'))
const actionGap = rpxValue(cssRule(wxss, '.owner-card-actions'), 'gap')

const cardWidth = 750 - pagePaddingTotal
const summaryTextWidth = cardWidth - summaryPaddingTotal - mediaWidth - summaryGap
const actionButtonWidth = (cardWidth - managementPaddingTotal - actionGap) / 2
assert.ok(summaryTextWidth >= 440, `摘要正文宽度不足：${summaryTextWidth}rpx`)
assert.ok(actionButtonWidth >= 300, `底部按钮宽度不足：${actionButtonWidth}rpx`)

console.log('my-listings-card-layout-test passed')
