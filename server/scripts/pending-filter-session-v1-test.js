'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  createPendingFilterEnvelope,
  consumePendingFilterEnvelope
} = require('../../utils/pending-filter-storage')

const repoRoot = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8')

const privateFilters = {
  needId: 'NEED-ACCOUNT-A',
  listingIds: ['LISTING-ACCOUNT-A'],
  sourceType: '业主房源'
}
const privateEnvelope = createPendingFilterEnvelope(privateFilters, 'SESSION-A')
assert.deepStrictEqual(
  consumePendingFilterEnvelope(privateEnvelope, 'SESSION-A'),
  privateFilters,
  '同一稳定会话必须能消费自己的需求筛选'
)
assert.strictEqual(
  consumePendingFilterEnvelope(privateEnvelope, 'SESSION-B'),
  null,
  '账号B不得消费账号A遗留的需求单和房源 ID 筛选'
)
assert.deepStrictEqual(
  consumePendingFilterEnvelope(JSON.stringify(privateEnvelope), 'SESSION-A'),
  privateFilters,
  'JSON 字符串存储也必须按同一 owner 规则解包'
)
assert.throws(
  () => createPendingFilterEnvelope(privateFilters),
  /必须绑定当前会话/,
  '写入端不得把账号私有筛选伪装成公开 envelope'
)

const publicFilters = { category: '公司房源', filters: { area: '拱墅区' } }
const publicEnvelope = createPendingFilterEnvelope(publicFilters)
assert.deepStrictEqual(
  consumePendingFilterEnvelope(publicEnvelope, 'SESSION-B'),
  publicFilters,
  '显式公开分类筛选不绑定账号，切换会话后仍可正常打开'
)

assert.deepStrictEqual(
  consumePendingFilterEnvelope({ category: '公司房源', filters: { area: '拱墅区' } }, 'SESSION-B'),
  publicFilters,
  '旧版本留下的纯公开筛选继续兼容'
)
assert.strictEqual(
  consumePendingFilterEnvelope({ needId: 'LEGACY-NEED-A', listingIds: ['LEGACY-LISTING-A'] }, 'SESSION-B'),
  null,
  '无 owner 的旧需求筛选必须 fail-closed，不能串到新账号'
)
assert.strictEqual(
  consumePendingFilterEnvelope({ pendingFilterVersion: 1, ownerSessionKey: '', payload: privateFilters }, 'SESSION-B'),
  null,
  '篡改为无 owner 的私有 envelope 也必须 fail-closed'
)
assert.strictEqual(consumePendingFilterEnvelope('{broken-json', 'SESSION-A'), null, '畸形 JSON 不得被当作筛选')
assert.strictEqual(consumePendingFilterEnvelope([], 'SESSION-A'), null, '数组存储不得被当作筛选')
assert.strictEqual(
  consumePendingFilterEnvelope({ pendingFilterVersion: 1, ownerSessionKey: 'SESSION-A', payload: [] }, 'SESSION-A'),
  null,
  '版本化 envelope 的 payload 不是对象时必须 fail-closed'
)
assert.strictEqual(
  consumePendingFilterEnvelope({ pendingFilterVersion: 999, payload: publicFilters }, 'SESSION-A'),
  null,
  '未知 envelope 版本不得按旧公开结构误消费'
)

const indexSource = read('pages/index/index.js')
const matchSource = read('pages/match-chat/match-chat.js')
const mapSource = read('pages/map/map.js')
const listingsSource = read('pages/listings/listings.js')
assert.ok(indexSource.includes('createPendingFilterEnvelope(filters)'), '首页公开分类必须写显式公开 envelope')
assert.ok(matchSource.includes('createPendingFilterEnvelope(filters, currentAuthSessionKey())'), '助手进入地图必须绑定稳定会话')
assert.ok(mapSource.includes('consumePendingFilterEnvelope') && mapSource.includes('createPendingFilterEnvelope'), '地图必须校验入站 owner 并绑定出站 owner')
assert.ok(listingsSource.includes('consumePendingFilterEnvelope'), '房源列表必须校验待处理筛选 owner')

console.log('pending-filter-session-v1-test passed')
