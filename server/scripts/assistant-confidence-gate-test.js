const assert = require('assert')
const { evaluateConfidence } = require('../src/assistant/confidence-gate')
const { runAssistantGraph, _internal: graphInternal } = require('../src/assistant/graph')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function listing(id, data) {
  return {
    id,
    title: `杭州${data.area}${data.community}1栋1单元101室 · ${data.layout}`,
    shortTitle: data.community,
    uploaderId: 'U001',
    rent: data.rent,
    layout: data.layout,
    city: '杭州',
    district: data.area,
    area: data.area,
    block: data.block || data.area,
    community: data.community,
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: `杭州${data.area}${data.community}1栋1单元101室`,
    landlordPhone: '13900000001',
    commissionRate: 20,
    videoUrl: `https://example.com/${id}.mp4`,
    videoKey: `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: data.rentMode || '整租',
    rentMode: data.rentMode || '整租',
    room: data.room || '',
    hall: data.hall || '',
    bath: data.bath || '',
    features: data.features || [],
    source: '普通上传',
    mapLatitude: data.mapLatitude || 30.28,
    mapLongitude: data.mapLongitude || 120.18,
    coordinateSource: 'community-coordinate',
    coordinateVerified: true,
    createdAt: now,
    lastVerifiedAt: now
  }
}

function makeDb() {
  return {
    currentUserId: 'U001',
    users: [
      { id: 'U001', name: '测试中介', phone: '13800010001', role: '中介', authed: '手机号登录' }
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 15 },
    listings: [
      listing('L001', { area: '滨江', block: '西兴', community: '春波南苑', rent: 3900, layout: '整租两室一厅一卫', room: '两室', features: ['燃气', '近地铁'] })
    ],
    footprints: []
  }
}

async function main() {
  let gate = evaluateConfidence({
    layout: '单间',
    rentMode: '整租',
    hardConstraints: {}
  })
  assert.strictEqual(gate.confidence, 'low', '冲突条件应低置信')
  assert(gate.nextQuestion.indexOf('合租单间') !== -1, '冲突条件应追问单间/整租')

  gate = evaluateConfidence({
    searchMode: 'radius_around_place',
    radiusKm: 2,
    rentMode: '整租',
    layout: '一室',
    hardConstraints: {}
  })
  assert.strictEqual(gate.confidence, 'low', '半径找房缺少地点应低置信')
  assert(gate.nextQuestion.indexOf('地点') !== -1, '半径找房缺少地点应追问')

  const lowResult = await runAssistantGraph(makeDb(), { text: '必须有阳台' }, { threadId: 'T001' })
  assert(lowResult.trace.indexOf('confidence_gate') !== -1, '图链路应经过 confidence_gate')
  assert.strictEqual(lowResult.response.confidence, 'low', '核心字段不足应低置信')
  assert(lowResult.response.nextQuestion, '低置信应返回追问')
  assert.strictEqual((lowResult.response.listings || []).length, 0, '低置信不应返回房源')

  const previousRadiusNeed = {
    searchMode: 'radius_around_place',
    anchorName: '乐富智慧园',
    anchorRole: 'workplace',
    radiusKm: 2,
    rentMode: '整租',
    layout: '一室',
    hardConstraints: {
      rentMode: '整租',
      layout: '一室'
    },
    preferences: {}
  }
  const switchedNeed = graphInternal.mergeRentalNeed(previousRadiusNeed, {
    community: '东新园',
    layout: '两室',
    hardConstraints: {
      community: '东新园',
      layout: '两室'
    },
    preferences: {}
  })
  assert.strictEqual(switchedNeed.searchMode, '', '明确切到新小区时不应保留上一轮半径搜索')
  assert.strictEqual(switchedNeed.anchorName, '', '明确切到新小区时不应保留上一轮锚点')
  assert.strictEqual(switchedNeed.community, '东新园')

  const appendedNeed = graphInternal.mergeRentalNeed(previousRadiusNeed, {
    maxBudget: 1800,
    budgetText: '1800以内',
    hardConstraints: {
      maxBudget: 1800
    },
    preferences: {}
  })
  assert.strictEqual(appendedNeed.searchMode, 'radius_around_place', '只补预算时应保留上一轮半径搜索上下文')
  assert.strictEqual(appendedNeed.anchorName, '乐富智慧园')

  const communityToAreaNeed = graphInternal.mergeRentalNeed({
    area: '拱墅',
    community: '东新园',
    rentMode: '整租',
    layout: '一室',
    hardConstraints: {
      area: '拱墅',
      community: '东新园',
      rentMode: '整租',
      layout: '一室'
    },
    preferences: {}
  }, {
    area: '上城',
    layout: '两室',
    hardConstraints: {
      area: '上城',
      layout: '两室'
    },
    preferences: {}
  })
  assert.strictEqual(communityToAreaNeed.area, '上城', '明确切到新区时区域应使用最新输入')
  assert.strictEqual(communityToAreaNeed.community, '', '明确切到新区时不应保留旧小区')

  const radiusNeed = graphInternal.mergeRentalNeed({
    area: '拱墅',
    community: '东新园',
    hardConstraints: {
      area: '拱墅',
      community: '东新园'
    },
    preferences: {}
  }, {
    area: '拱墅',
    searchMode: 'radius_around_place',
    anchorName: '拱墅万达',
    radiusKm: 3,
    hardConstraints: {},
    preferences: {}
  })
  assert.strictEqual(radiusNeed.community, '', '切到半径找房时不应保留旧小区')
  assert.strictEqual(radiusNeed.hardConstraints.area, '', '半径找房不应把区域回流进硬条件')
  assert.strictEqual(radiusNeed.hardConstraints.community, '', '半径找房不应把小区回流进硬条件')

  const highResult = await runAssistantGraph(makeDb(), { text: '滨江四千左右两室' }, { threadId: 'T002' })
  assert(highResult.trace.indexOf('confidence_gate') !== -1, '完整找房也应经过 confidence_gate')
  assert(highResult.response.confidence === 'high' || highResult.response.confidence === 'medium', '完整找房不应低置信')
  assert(!highResult.response.nextQuestion, '完整找房不应追问')
  assert((highResult.response.listings || []).length > 0, '完整找房应返回房源')

  console.log('assistant-confidence-gate-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
