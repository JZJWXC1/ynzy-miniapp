'use strict'

// 详情页"上传人自查免留痕"模板契约测试：确保 WXML 真正接上自查文案，
// 上传人自己的非公司房源不再显示"查看即留痕/已记录足迹"（防验收假阴性）。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wxml = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'listing-detail', 'listing-detail.wxml'), 'utf8')

// 1) 存在 isOwnListing 自查分支。
assert.ok(/isOwnListing/.test(wxml), '详情页模板必须有 isOwnListing 自查分支')

// 2) 自查分支展示"免留痕/不留足迹"文案（与"直接展示"承诺一致）。
assert.ok(/不留足迹/.test(wxml) && /免留痕/.test(wxml), '自查分支必须展示"不留足迹/免留痕"文案')

// 3) 自查按钮文案改为"自己上传·免留痕直接展示"，不再对上传人显示"已记录足迹"。
assert.ok(/自己上传·免留痕直接展示/.test(wxml), '自查按钮文案必须为"自己上传·免留痕直接展示"')

// 4) 自查分支用 wx:if 优先命中；"已记录足迹"通用按钮改为 wx:elif（不再统一覆盖所有非公司房源含上传人自查）。
assert.ok(/wx:if="\{\{!listing\.companyListing && isOwnListing\}\}"/.test(wxml), '存在 isOwnListing 自查分支（wx:if 优先命中）')
assert.ok(/wx:elif="\{\{!listing\.companyListing\}\}"/.test(wxml), '"已记录足迹"通用文案改为 wx:elif 分支（不覆盖上传人自查）')

// 5) 需求单绑定只属于普通合作房源；上传人自查已经服务端确认身份，不应再显示“未绑定需求单”。
assert.ok(
  /wx:if="\{\{!listing\.companyListing && !isOwnListing\}\}" class="need-bind-row/.test(wxml),
  '需求单提示必须排除上传人自己的房源，同时保留普通合作房源分支'
)
assert.ok(
  !/wx:if="\{\{!listing\.companyListing\}\}" class="need-bind-row/.test(wxml),
  '禁止恢复为所有非公司房源都显示需求单提示的旧条件'
)

console.log('listing-detail-own-view-wxml-test passed')
