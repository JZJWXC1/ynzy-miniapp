'use strict'

const assert = require('assert')
const matchService = require('../src/match-service')
const mockData = require('../../utils/mock-data')
const llmService = require('../../utils/llm-service')

function listing(id, district, block, community) {
  return {
    id,
    city: '杭州',
    district,
    area: district,
    block,
    community,
    rent: 3200,
    layout: '2室1厅',
    room: '二室',
    rentMode: '整租',
    type: '整租',
    status: '在租',
    lifecycleStatus: 'active'
  }
}

const candidates = [
  listing('NEW-AREA-1', '云城区', '未来板块', '未来花苑'),
  listing('Fuyang-1', '富阳区', '银湖', '银湖花苑')
]
const db = { listings: candidates }

const futureNeed = matchService.parseNeed(
  { text: '云城区未来板块两室整租' },
  candidates,
  { db }
)
assert.strictEqual(futureNeed.area, '云城区', '候选房源新增行政区后，找房助手必须无需改代码即可识别')
assert.strictEqual(futureNeed.community, '未来板块', '候选房源新增板块后，找房助手必须按板块筛选')

const fuyangNeed = matchService.parseNeed(
  { text: '富阳区两室整租' },
  candidates,
  { db }
)
assert.strictEqual(fuyangNeed.area, '富阳区', '杭州现有但旧静态词表遗漏的行政区也必须动态识别')
assert.notStrictEqual(fuyangNeed.community, '富阳区', '行政区不得重复写入小区槽')

const result = matchService.buildLocalMatch(
  db,
  { text: '云城区未来板块两室整租' },
  { candidates }
)
const ids = (result.listings || []).map((item) => item.id)
assert.deepStrictEqual(ids, ['NEW-AREA-1'], '动态行政区和板块必须真正约束推荐结果，不能只写入展示字段')

const originalGetListings = mockData.getListings
let publicLocationQuery = null
mockData.getListings = (query) => {
  publicLocationQuery = query
  return candidates
}
const clientNeed = llmService.parseNeedText('云城区未来板块3000元两室整租')
mockData.getListings = originalGetListings
assert.deepStrictEqual(publicLocationQuery, { publicGuest: true }, '客户端动态地点词典只能读取游客安全公共投影')
assert.strictEqual(clientNeed.area, '云城区', '客户端 Mock/网络降级识别也必须从当前公开房源派生新行政区')
assert.strictEqual(clientNeed.community, '未来板块', '客户端 Mock/网络降级识别也必须从当前公开房源派生新板块')

console.log('dynamic-location-dictionary-v1-test: PASS')
