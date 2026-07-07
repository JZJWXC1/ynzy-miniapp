'use strict'

// 锁定：safeListing/safeListings 必须原样保留 listing.id，绝不能被 scrubSensitiveText 脱敏。
// 背景 bug：id 形如 L1783427664217530，其数字子串命中手机号正则 1[3-9]\d{9}，曾被脱敏成
// L[手机号已隐藏]17530，导致聊天/助手推荐卡「看详情」404、「地图查看」listingIds 匹配不到→空。
// 同时确认非 id 字段里的真实敏感信息仍被脱敏（不能因这次修复放开脱敏）。

const assert = require('assert')
const safety = require('../src/assistant/safety')

// 1) 各种真实格式 id（含手机号样数字串）必须原样保留。
const ids = [
  'L1783427664217530',
  'L1783383449353974',
  'L1782202720066119',
  'L17832779847014',
  'L1783078341005336',
  'CS1a2b3c', // 快照 id 也应原样
  'L-plain-id'
]
for (const id of ids) {
  const out = safety.safeListing({ id, community: '测试小区', rent: 5300 })
  assert.strictEqual(out.id, id, `safeListing 必须原样保留 id：${id}，实际 ${out.id}`)
}

// 2) safeListings 批量同样保留 id。
const rows = safety.safeListings(ids.map((id) => ({ id, community: '小区' })))
rows.forEach((row, i) => assert.strictEqual(row.id, ids[i], `safeListings[${i}] id 应保留`))

// 3) 非 id 字段里的真实敏感信息仍必须被脱敏（修复不得放开脱敏）。
const scrubbed = safety.safeListing({
  id: 'L1783427664217530',
  matchReason: '房东电话13800138000，随时可看',
  differenceText: '微信号 vx：13912345678'
})
assert.strictEqual(scrubbed.id, 'L1783427664217530', 'id 原样')
assert.ok(!/13800138000/.test(scrubbed.matchReason || ''), 'matchReason 里的手机号仍应被脱敏')
assert.ok(!/13912345678/.test(scrubbed.differenceText || ''), 'differenceText 里的手机号仍应被脱敏')

console.log('assistant-safe-listing-id-test passed')
