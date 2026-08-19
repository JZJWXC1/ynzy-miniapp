const assert = require('assert')
const assistantService = require('../src/assistant-service')
const { containsSensitiveText } = require('../src/assistant/safety')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeListing(id, data) {
  const area = data.area
  const community = data.community
  const layout = data.layout
  const rentMode = data.rentMode || '整租'
  return {
    id,
    title: `杭州${area}${community}1栋1单元101室 · ${layout}`,
    shortTitle: community,
    uploaderId: 'U001',
    rent: data.rent,
    layout,
    city: '杭州',
    district: area,
    area,
    block: data.block || area,
    community,
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: `杭州${area}${community}1栋1单元101室`,
    landlordPhone: data.landlordPhone || '13900000001',
    commissionRate: 20,
    videoUrl: `https://example.com/${id}.mp4?OSSAccessKeyId=ak&Signature=raw`,
    videoKey: `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: rentMode,
    rentMode,
    room: data.room || '',
    hall: data.hall || '',
    bath: data.bath || '',
    features: data.features || [],
    source: '普通上传',
    companyListing: false,
    isCompanyListing: false,
    noCommission: false,
    mapLatitude: data.mapLatitude || 30.28,
    mapLongitude: data.mapLongitude || 120.18,
    coordinateSource: 'community-coordinate',
    createdAt: now,
    lastVerifiedAt: now
  }
}

function makeDb() {
  return {
    currentUserId: 'U001',
    users: [
      { id: 'U001', name: '测试中介', phone: '13800010001', role: '中介', authed: '手机号登录', isAdmin: false }
    ],
    listingMaintenanceRule: {
      enabled: false,
      remindDays: [3, 5],
      expireDays: 15
    },
    listings: [
      makeListing('L001', { area: '滨江', block: '西兴', community: '春波南苑', rent: 3900, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['燃气', '近地铁', '电梯'] }),
      makeListing('L002', { area: '滨江', block: '长河', community: '长河雅苑', rent: 4800, layout: '整租三室一厅一卫', rentMode: '整租', room: '三室', features: ['带阳台', '燃气'] }),
      makeListing('L003', { area: '拱墅', block: '东新', community: '东新园', rent: 2800, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['近地铁', '带阳台'] }),
      makeListing('L004', { area: '西湖', block: '古荡', community: '古荡新村', rent: 2200, layout: '合租单间', rentMode: '合租', room: '单间', features: ['独卫', '近地铁'] })
    ],
    footprints: []
  }
}

function returnedListings(result) {
  return []
    .concat(result.listings || [])
    .concat(result.exactListings || [])
    .concat(result.nearbyListings || [])
}

function assertKnownIds(result, db) {
  const ids = new Set((db.listings || []).map((listing) => listing.id))
  returnedListings(result).forEach((listing) => {
    assert(ids.has(listing.id), `返回了候选库之外的房源ID：${listing.id}`)
  })
}

function assertNoSensitiveKeys(result) {
  returnedListings(result).forEach((listing) => {
    ;['address', 'building', 'unit', 'roomNumber', 'landlordPhone', 'videoUrl', 'videoKey', 'videoSignedUrl'].forEach((key) => {
      assert(!Object.prototype.hasOwnProperty.call(listing, key), `assistant 返回了敏感字段：${key}`)
    })
  })
}

function assertNoSensitiveText(result) {
  assert(!containsSensitiveText(result), 'assistant 返回内容包含敏感原文')
}

async function main() {
  assistantService._internal.threadStore._internal.resetForTest()
  const db = makeDb()

  let result = await assistantService.chat(clone(db), {
    debugTrace: true,
    text: '客户13812345678想住滨江春波南苑1栋2单元301室，四千两室，微信号wxid_secret12345，OSSAccessKeyId=ak&Signature=rawsig'
  }, { userId: 'U001' })
  assert(result.threadId, '缺少 threadId')
  assert.strictEqual(result.mode, 'local-graph-assistant-v1', '模式标记不正确')
  assert.strictEqual(result.intent, 'rental_match', '找房意图识别失败')
  assert.strictEqual(result.need.area, '滨江', '区域合并失败')
  assert.strictEqual(result.need.community, '春波南苑', '小区合并失败')
  assert.strictEqual(result.need.maxBudget, 4000, '预算解析失败')
  assert.strictEqual(result.need.layout, '两室', '户型解析失败')
  assert((result.listings || []).length > 0, '完整条件未返回匹配房源')
  assert(result.traceSummary, '应返回 trace 摘要')
  assert(result.traceSummary.nodes.indexOf('sanitize_input') !== -1, 'trace 应包含输入清洗节点')
  assert(result.traceSummary.nodes.indexOf('normalize_asr') !== -1, 'trace 应包含 ASR 归一化节点')
  assert(result.traceSummary.nodes.indexOf('intent_router') !== -1, 'trace 应包含意图识别节点')
  assert(result.traceSummary.nodes.indexOf('llm_need_parser') !== -1, 'trace 应包含 LLM 需求解析节点')
  assert(result.traceSummary.nodes.indexOf('rule_need_validator') !== -1, 'trace 应包含规则需求校验节点')
  assert(result.traceSummary.nodes.indexOf('merge_rental_need') !== -1, 'trace 应包含需求合并节点')
  assert(result.traceSummary.nodes.indexOf('confidence_gate') !== -1, 'trace 应包含置信门禁节点')
  assert(result.traceSummary.nodes.indexOf('tool_planner') !== -1, 'trace 应包含工具规划节点')
  assert(result.traceSummary.nodes.indexOf('listing_search_tool') !== -1, 'trace 应包含房源搜索工具节点')
  assert(result.traceSummary.nodes.indexOf('geo_place_tool') !== -1, 'trace 应包含地点解析工具节点')
  assert(result.traceSummary.nodes.indexOf('ranking_tool') !== -1, 'trace 应包含排序工具节点')
  assert(result.traceSummary.nodes.indexOf('llm_reply_writer') !== -1, 'trace 应包含 LLM 话术写作节点')
  assert(result.traceSummary.nodes.indexOf('output_guard') !== -1, 'trace 应包含输出安全节点')
  assert(result.traceSummary.nodes.indexOf('generate_reply') !== -1, 'trace 应包含回复生成节点')
  assert(result.traceSummary.nodes.indexOf('trace_logger') !== -1, 'trace 应包含链路记录节点')
  assert(!JSON.stringify(result.traceSummary).includes('13900000001'), 'trace 摘要不应包含房东电话')
  assert(!JSON.stringify(result.traceSummary).includes('OSSAccessKeyId=ak'), 'trace 摘要不应包含视频签名')
  assertKnownIds(result, db)
  assertNoSensitiveKeys(result)
  assertNoSensitiveText(result)

  result = await assistantService.chat(clone(db), {
    threadId: result.threadId,
    text: '补充一下，必须有燃气'
  }, { userId: 'U001' })
  assert.strictEqual(result.need.area, '滨江', '多轮合并丢失区域')
  assert.strictEqual(result.need.maxBudget, 4000, '多轮合并丢失预算')
  assert((result.need.hardConstraints.features || []).indexOf('燃气') !== -1, '多轮硬性标签合并失败')
  assertKnownIds(result, db)
  assertNoSensitiveText(result)

  assistantService._internal.threadStore._internal.resetForTest()
  result = await assistantService.chat(clone(db), {
    debugTrace: true,
    text: '必须有阳台'
  }, { userId: 'U001' })
  assert(result.nextQuestion, '核心字段不足时应追问')
  assert.strictEqual((result.listings || []).length, 0, '追问阶段不应返回房源')
  assert(result.traceSummary.nodes.indexOf('ask_followup') !== -1, '追问阶段 trace 应包含追问节点')
  assert(result.traceSummary.nodes.indexOf('ranking_tool') === -1, '追问阶段不应进入排序工具节点')
  assertNoSensitiveText(result)

  result = await assistantService.chat(clone(db), {
    text: '地图为什么不能展示具体楼栋、单元、房号和房东电话？'
  }, { userId: 'U001' })
  assert.strictEqual(result.intent, 'business_faq', '地图说明应进入业务 FAQ')
  assert(result.reply.indexOf('小区级') !== -1, '地图 FAQ 文案不符合预期')
  assert(result.reply.indexOf('分级') !== -1, '地图 FAQ 应说明坐标分级标注规则')
  assert.strictEqual((result.listings || []).length, 0, 'FAQ 不应返回房源')
  assert(!result.traceSummary, '默认小程序响应不应返回 trace 摘要')
  assertNoSensitiveText(result)

  result = await assistantService.chat(clone(db), {
    text: '报备和签单怎么走？'
  }, { userId: 'U001' })
  assert.strictEqual(result.intent, 'business_faq', '报备签单说明应进入业务 FAQ')
  assert(result.reply.indexOf('报备') !== -1 || result.reply.indexOf('签单') !== -1, '业务 FAQ 文案不符合预期')
  assertNoSensitiveText(result)

  console.log('assistant-graph-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
