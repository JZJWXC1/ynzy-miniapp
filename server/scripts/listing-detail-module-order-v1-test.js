const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const wxml = fs.readFileSync(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.wxml'), 'utf8')

function count(source, marker) {
  return source.split(marker).length - 1
}

function readViewBlock(source, start) {
  assert(start >= 0, '目标模块不存在')
  const tagPattern = /<view\b[^>]*>|<\/view\s*>/g
  tagPattern.lastIndex = start
  let depth = 0
  let match
  while ((match = tagPattern.exec(source))) {
    depth += match[0].startsWith('</') ? -1 : 1
    if (depth === 0) {
      return { start, end: tagPattern.lastIndex, source: source.slice(start, tagPattern.lastIndex) }
    }
  }
  throw new Error('目标模块 view 标签未闭合')
}

const nearbyMarker = '<view wx:if="{{nearbyListings.length}}" class="nearby-section soft-card">'
const sensitiveMarker = '<view class="sensitive-card soft-card">'

assert.strictEqual(count(wxml, nearbyMarker), 1, '详情页必须且只能有一个带真实结果条件的附近推荐模块')
assert.strictEqual(count(wxml, sensitiveMarker), 1, '详情页必须且只能有一个敏感信息模块')

const sensitiveBlock = readViewBlock(wxml, wxml.indexOf(sensitiveMarker))
const nearbyBlock = readViewBlock(wxml, wxml.indexOf(nearbyMarker))

assert(sensitiveBlock.source.includes('wx:if="{{!listing.companyListing && isOwnListing}}"'), '敏感模块必须保留本人房源分支')
assert(sensitiveBlock.source.includes('wx:elif="{{!listing.companyListing}}"'), '敏感模块必须保留合作房源查看分支')
assert(sensitiveBlock.source.includes('wx:if="{{listing.companyListing}}"'), '敏感模块必须保留公司公开分支')
assert(nearbyBlock.source.includes('wx:for="{{nearbyListings}}"'), '附近模块必须保留推荐列表循环')
assert(nearbyBlock.source.includes('bindtap="goNearbyListings"'), '附近模块必须保留查看全部事件')

assert(
  nearbyBlock.start > sensitiveBlock.end,
  '3 公里内的其他房源必须渲染在详细地址、看房方式和房东联系方式之后'
)
assert.strictEqual(
  wxml.slice(sensitiveBlock.end, nearbyBlock.start).trim(),
  '',
  '附近推荐必须紧跟敏感信息模块，中间不得插入其他业务模块'
)

console.log('listing-detail-module-order-v1-test passed')
