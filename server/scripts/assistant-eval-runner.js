const assistantService = require('../src/assistant-service')
const dbStore = require('../src/db')
const { containsSensitiveText } = require('../src/assistant/safety')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function listing(id, data) {
  return {
    id,
    title: `杭州${data.area}${data.community}1幢1单元101室 · ${data.layout}`,
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
    address: `杭州${data.area}${data.community}1幢1单元101室`,
    landlordPhone: '13900000001',
    commissionRate: 20,
    videoUrl: `https://example.com/${id}.mp4?OSSAccessKeyId=ak&Signature=raw`,
    videoKey: `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: data.rentMode,
    rentMode: data.rentMode,
    room: data.room || '',
    hall: data.hall || '',
    bath: data.bath || '',
    features: data.features || [],
    source: '普通上传',
    companyListing: false,
    isCompanyListing: false,
    noCommission: false,
    mapLatitude: data.latitude,
    mapLongitude: data.longitude,
    coordinateSource: 'manual-confirmed-test-coordinate',
    coordinateVerified: true,
    createdAt: now,
    lastVerifiedAt: now
  }
}

function makeDb() {
  return {
    currentUserId: 'U001',
    users: [
      { id: 'U001', name: '评估中介', phone: '13800010001', role: '中介', authed: '手机号登录' }
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 15 },
    placeCoordinates: {
      新天地: {
        latitude: 30.309,
        longitude: 120.181,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅'
      },
      拱墅万达: {
        latitude: 30.333,
        longitude: 120.128,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅',
        aliases: ['万达']
      },
      余杭万达: {
        latitude: 30.299,
        longitude: 120.041,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '余杭',
        aliases: ['万达']
      },
      乐富智慧园: {
        latitude: 30.335,
        longitude: 120.121,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅'
      },
      东新园: {
        latitude: 30.303,
        longitude: 120.168,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅',
        type: 'community'
      },
      祥符空小区: {
        latitude: 30.342,
        longitude: 120.116,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅',
        type: 'community'
      }
    },
    listings: [
      listing('XTD01', { area: '拱墅', block: '新天地', community: '新天地', rent: 4200, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.309, longitude: 120.181, features: ['电梯', '近地铁'] }),
      listing('XTD02', { area: '拱墅', block: '新天地', community: '长浜长龙苑', rent: 3900, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.309357, longitude: 120.184283, features: ['带阳台'] }),
      listing('XTD03', { area: '拱墅', block: '东新', community: '杨乐府', rent: 3600, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.303432, longitude: 120.168634, features: ['燃气'] }),
      listing('YJF01', { area: '拱墅', block: '石桥', community: '兴业杨家府', rent: 3500, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.32315, longitude: 120.198637, features: ['电梯'] }),
      listing('DXY01', { area: '拱墅', block: '东新', community: '东新园', rent: 3500, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.303, longitude: 120.168, features: ['燃气', '电梯'] }),
      listing('XTD04', { area: '拱墅', block: '华丰', community: '华丰欣苑', rent: 3300, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', latitude: 30.337823, longitude: 120.200076, features: ['电梯'] }),
      listing('WD01', { area: '拱墅', block: '万达', community: '拱墅万达公寓', rent: 1950, layout: '合租单间', rentMode: '合租', room: '单间', latitude: 30.333, longitude: 120.128, features: ['独卫'] }),
      listing('WD02', { area: '拱墅', block: '万达', community: '万融城', rent: 2100, layout: '合租单间', rentMode: '合租', room: '单间', latitude: 30.333846, longitude: 120.127299, features: ['电梯'] }),
      listing('LF01', { area: '拱墅', block: '祥符', community: '乐富智慧园公寓', rent: 1450, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', latitude: 30.335, longitude: 120.121, features: ['电梯'] }),
      listing('LF02', { area: '拱墅', block: '祥符', community: '小洋坝家园二区', rent: 1550, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', latitude: 30.342, longitude: 120.116, features: ['近地铁'] }),
      listing('LF03', { area: '拱墅', block: '祥符', community: '昌运里三区', rent: 1800, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', latitude: 30.36, longitude: 120.16, features: ['燃气'] })
    ],
    footprints: []
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function ids(result) {
  return (result.listings || []).map((item) => item.id)
}

function assertSafe(result) {
  assert(!containsSensitiveText(result), '返回内容包含敏感信息')
  if (result.placeResolution) {
    assert(!Object.prototype.hasOwnProperty.call(result.placeResolution, 'latitude'), '地点解析不应暴露纬度')
    assert(!Object.prototype.hasOwnProperty.call(result.placeResolution, 'longitude'), '地点解析不应暴露经度')
  }
}

function assertTrace(result, expectedNode) {
  const nodes = result.traceSummary && result.traceSummary.nodes
  assert(Array.isArray(nodes), 'debugTrace 应返回 traceSummary.nodes')
  ;[
    'sanitize_input',
    'normalize_asr',
    'intent_router',
    'llm_need_parser',
    'rule_need_validator',
    'confidence_gate',
    'tool_planner',
    'listing_search_tool',
    'geo_place_tool',
    'ranking_tool',
    'llm_reply_writer',
    'output_guard',
    'generate_reply',
    'trace_logger'
  ].forEach((node) => {
    assert(nodes.indexOf(node) !== -1, `trace 缺少节点：${node}`)
  })
  if (expectedNode) assert(nodes.indexOf(expectedNode) !== -1, `trace 缺少节点：${expectedNode}`)
}

function hasRequiredNode(nodes, node) {
  const aliases = {
    llm_reply: 'llm_reply_writer'
  }
  return nodes.includes(node) || (aliases[node] && nodes.includes(aliases[node]))
}

function assertReasons(result) {
  ;(result.listings || []).forEach((item) => {
    assert(item.matchReason, `房源 ${item.id} 缺少推荐理由`)
    assert(item.differenceText, `房源 ${item.id} 缺少差异说明`)
  })
}

function assertNeedSubset(actual = {}, expected = {}) {
  const keys = Object.keys(expected || {}).filter((key) => {
    const value = expected[key]
    if (value === undefined || value === null || value === '') return false
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'object') return Object.keys(value).length > 0
    return true
  })
  keys.forEach((key) => {
    const expectedValue = expected[key]
    const actualValue = actual[key]
    if (Array.isArray(expectedValue)) {
      expectedValue.forEach((item) => {
        assert((actualValue || []).includes(item), `动态评估 need 缺少 ${key}: ${item}`)
      })
      return
    }
    if (typeof expectedValue === 'object') {
      assertNeedSubset(actualValue || {}, expectedValue)
      return
    }
    assert(String(actualValue || '') === String(expectedValue), `动态评估 need ${key} 不匹配：${actualValue} !== ${expectedValue}`)
  })
}

function assertRequiredNodes(result, requiredNodes = []) {
  const nodes = result.traceSummary && result.traceSummary.nodes
  assert(Array.isArray(nodes), '动态评估缺少 traceSummary.nodes')
  ;(requiredNodes || []).forEach((node) => {
    assert(hasRequiredNode(nodes, node), `动态评估 trace 缺少节点：${node}`)
  })
}

function assertExpectedListings(result, expectedListingIds = []) {
  if (!expectedListingIds || !expectedListingIds.length) return
  const actualIds = new Set(ids(result))
  expectedListingIds.forEach((id) => {
    assert(actualIds.has(id), `动态评估缺少期望房源：${id}`)
  })
}

function assertDynamicBehavior(result, item = {}) {
  const behavior = item.behavior || 'recommend'
  if (behavior === 'ask_followup') {
    assert(result.nextQuestion, `动态评估 ${item.id || item.text} 应追问`)
    assert((result.listings || []).length === 0, `动态评估 ${item.id || item.text} 追问时不应返回房源`)
    return
  }
  if (behavior === 'no_result') {
    assert((result.listings || []).length === 0, `动态评估 ${item.id || item.text} 应无房源`)
    return
  }
  if (behavior === 'no_sensitive_output') {
    assertSafe(result)
    return
  }
  assert((result.listings || []).length > 0, `动态评估 ${item.id || item.text} 应返回推荐房源`)
  assertReasons(result)
}

async function chat(db, payload, userId = 'U001') {
  return assistantService.chat(clone(db), { debugTrace: true, ...payload }, { userId })
}

async function runCase(name, fn) {
  try {
    await fn()
    return { name, passed: true }
  } catch (error) {
    return { name, passed: false, error: error.message }
  }
}

function fixedCases() {
  return [
    runCase('新天地3公里内整租两室走半径找房', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '新天地3公里内有哪些整租的两室' })
      assert(result.need.searchMode === 'radius_around_place', '未进入半径找房')
      assert(result.need.anchorName === '新天地', '锚点识别错误')
      assert(result.need.radiusKm === 3, '半径识别错误')
      assert(ids(result).includes('XTD01') && ids(result).includes('XTD02'), '缺少新天地周边两室')
      assertTrace(result, 'ranking_tool')
      assertReasons(result)
      assertSafe(result)
    }),
    runCase('拱墅万达2000左右单间识别地标和预算浮动', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '拱墅万达附近有哪些2000左右的单间' })
      assert(result.need.anchorName === '拱墅万达', '地标识别错误')
      assert(result.need.preferences.budgetTolerance === 300, '左右预算未设置300浮动')
      assert(ids(result).includes('WD01') && ids(result).includes('WD02'), '缺少万达附近单间')
      assert(!ids(result).includes('LF01'), '单间问题混入一室整租')
      assertTrace(result, 'ranking_tool')
      assertSafe(result)
    }),
    runCase('乐富智慧园上班两公里内一室整租', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '租客在乐富智慧园上班，她住的两公里内有什么1500左右的一室整租' })
      assert(result.need.anchorName === '乐富智慧园', '工作地点识别错误')
      assert(result.need.anchorRole === 'workplace', '工作地点角色识别错误')
      assert(result.need.radiusKm === 2, '两公里半径识别错误')
      assert(ids(result).includes('LF01') && ids(result).includes('LF02'), '缺少乐富智慧园附近一室')
      assert(!ids(result).includes('LF03'), '返回了两公里外房源')
      assertTrace(result, 'ranking_tool')
      assertSafe(result)
    }),
    runCase('陌生小区不能静默全局推荐', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '想住陌生小区，1500左右的一室整租' })
      assert(result.nextQuestion, '未知小区应追问')
      assert((result.listings || []).length === 0, '未知小区无坐标时不应推荐房源')
      assert(result.placeResolution && result.placeResolution.status === 'missing', '未知小区应返回 missing 状态')
      assertTrace(result, 'ranking_tool')
      assertSafe(result)
    }),
    runCase('万达多候选地点必须追问不能静默推荐', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '万达附近有哪些2000左右的单间' })
      assert(result.need.searchMode === 'radius_around_place', '附近地名应进入半径找房')
      assert(result.placeResolution && result.placeResolution.status === 'ambiguous', '多候选地点应返回 ambiguous')
      assert(result.nextQuestion, '多候选地点应追问确认')
      assert((result.listings || []).length === 0, '地点未确认时不应推荐房源')
      assertTrace(result, 'geo_place_tool')
      assertSafe(result)
    }),
    runCase('租法户型冲突必须追问不能直接查房', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '拱墅万达附近2000左右整租单间' })
      const nodes = result.traceSummary && result.traceSummary.nodes
      assert(result.need.rentMode === '整租', '应识别整租')
      assert(result.need.layout === '单间', '应识别单间')
      assert(result.nextQuestion && /合租单间|整租一室/.test(result.nextQuestion), '租法户型冲突必须追问确认')
      assert((result.confidenceReasons || []).includes('租法和户型冲突'), '冲突原因应进入 confidenceReasons')
      assert(Array.isArray(nodes), '冲突场景应返回 trace 节点')
      assert(nodes.includes('confidence_gate'), '冲突场景应经过 confidence_gate')
      assert(nodes.includes('ask_followup'), '冲突场景应进入追问节点')
      assert(!nodes.includes('ranking_tool'), '冲突未确认前不应进入排序工具')
      assert((result.listings || []).length === 0, '冲突未确认前不应返回房源')
      assertSafe(result)
    }),
    runCase('硬性标签必须有燃气不能被接近房源软化', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '新天地3公里内有哪些整租两室，必须有燃气' })
      assert(result.need.searchMode === 'radius_around_place', '标签场景也应保留半径找房')
      assert((result.need.hardConstraints.features || []).includes('燃气'), '必须有燃气应进入硬性标签')
      assert(ids(result).includes('XTD03'), '应返回半径内带燃气的两室整租')
      ;(result.listings || []).forEach((item) => {
        assert((item.features || []).includes('燃气'), `硬性燃气场景不应返回缺燃气房源：${item.id}`)
        assert(!/没有燃气/.test(item.differenceText || ''), `硬性燃气不能作为接近差异返回：${item.id}`)
        assert(/有燃气/.test(item.matchReason || ''), `推荐理由应说明有燃气：${item.id}`)
      })
      assertTrace(result, 'ranking_tool')
      assertSafe(result)
    }),
    runCase('多轮改看东新园清掉上一轮半径锚点', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const first = await chat(makeDb(), { text: '新天地3公里内有哪些4000以内整租的两室' }, 'U002')
      const second = await chat(makeDb(), { threadId: first.threadId, text: '改看东新园两室' }, 'U002')
      assert(second.need.searchMode !== 'radius_around_place', '切到小区时不应保留半径模式')
      assert(!second.need.anchorName, '切到小区时不应保留旧锚点')
      assert(second.need.community === '东新园', '新小区未生效')
      assert(ids(second).includes('DXY01'), '未返回东新园两室')
      assertTrace(second, 'ranking_tool')
      assertSafe(second)
    }),
    runCase('相近小区杨乐府不能被纠成杨家府', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '杨乐府3600左右两室整租' })
      assert(result.need.community === '杨乐府', '原话小区杨乐府应被保留')
      assert(ids(result).includes('XTD03'), '应返回杨乐府房源')
      assert(!ids(result).includes('YJF01'), '不能把杨家府房源当作杨乐府结果')
      assert((result.listings || []).some((item) => item.community === '杨乐府'), '推荐结果应保留原话小区')
      assertTrace(result, 'ranking_tool')
      assertReasons(result)
      assertSafe(result)
    }),
    runCase('本小区无房但有可靠坐标时推荐相邻小区', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '想住祥符空小区，1500左右的一室整租' })
      assert(result.need.community === '祥符空小区', '应保留中介指定小区')
      assert(result.placeResolution && result.placeResolution.status === 'resolved', '可靠坐标小区应解析成功')
      assert((result.exactListings || []).length === 0, '本小区无房时不能伪造精确结果')
      assert(ids(result).includes('LF02'), '应推荐相邻小区房源')
      assert((result.listings || []).some((item) => item.distanceText), '相邻小区推荐应带距离')
      assert((result.listings || []).some((item) => /不在祥符空小区/.test(item.differenceText || '')), '相邻小区应说明不在目标小区')
      assertTrace(result, 'ranking_tool')
      assertReasons(result)
      assertSafe(result)
    }),
    runCase('预算4000内不返回低于75%的房源', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '新天地预算4000内，两室整租' })
      ;(result.listings || []).forEach((item) => {
        assert(Number(item.rent) >= 3000, `返回了低于3000的房源：${item.id}`)
        assert(Number(item.rent) <= 4000, `4000以内不应返回超预算房源：${item.id}`)
      })
      assertTrace(result, 'ranking_tool')
      assertSafe(result)
    }),
    runCase('已知地点完整条件无房时不能放宽乱推', async () => {
      assistantService._internal.threadStore._internal.resetForTest()
      const result = await chat(makeDb(), { text: '新天地3公里内有哪些整租四室，预算1000以内' })
      const audit = result.traceSummary && result.traceSummary.audit
      assert(result.need.searchMode === 'radius_around_place', '无房场景仍应进入半径找房')
      assert(result.need.anchorName === '新天地', '无房场景地点锚点识别错误')
      assert(result.need.radiusKm === 3, '无房场景半径识别错误')
      assert(!result.nextQuestion, '条件完整但无房时不应误判成追问')
      assert((result.listings || []).length === 0, '无合适房源时不能返回接近房源乱推')
      assert(/暂未找到|没有/.test(result.reply || ''), '无房回复应明确说明暂未找到')
      assert(audit && audit.toolInput && audit.toolInput.searchType === 'radius_around_place', '无房 trace 应保留半径工具输入')
      assert(audit.toolOutput && audit.toolOutput.rankingResult, '无房 trace 应保留排序结果')
      assert(audit.toolOutput.rankingResult.listingCount === 0, '无房 trace 排序结果应为 0')
      assert(audit.shouldAskFollowUp === false, '无房不应在 audit 中标记为追问')
      assertTrace(result, 'ranking_tool')
      assertSafe(result)
    })
  ]
}

async function runDynamicEvalCase(db, item) {
  assistantService._internal.threadStore._internal.resetForTest()
  const result = await chat(db, { text: item.text }, item.createdBy || 'assistant-eval')
  assertDynamicBehavior(result, item)
  assertNeedSubset(result.need || {}, item.expectedNeed || {})
  assertExpectedListings(result, item.expectedListingIds || [])
  assertRequiredNodes(result, item.requiredNodes || [])
  assertSafe(result)
  return result
}

function dynamicCasesFromDb(db) {
  return (db.assistantEvalCases || [])
    .filter((item) => item && item.status !== 'disabled' && item.status !== 'archived')
    .filter((item) => String(item.text || '').trim())
}

async function runFixedEvalCases() {
  return Promise.all(fixedCases())
}

async function runDynamicEvalCases(db) {
  const items = dynamicCasesFromDb(db)
  const results = []
  for (const item of items) {
    const result = await runCase(`dynamic:${item.id || item.text}`, async () => {
      await runDynamicEvalCase(db, item)
    })
    results.push(result)
  }
  return results
}

function printResults(results) {
  results.forEach((result) => {
    if (result.passed) {
      console.log(`通过：${result.name}`)
    } else {
      console.log(`失败：${result.name} - ${result.error}`)
    }
  })
}

function summarizeResults(results, label) {
  const passed = results.filter((result) => result.passed).length
  const failed = results.length - passed
  console.log(`${label}：通过 ${passed} 项，失败 ${failed} 项。`)
  return { passed, failed }
}

async function main() {
  const fixedResults = await runFixedEvalCases()
  printResults(fixedResults)
  const fixedSummary = summarizeResults(fixedResults, '固定评估完成')

  const liveDb = dbStore.readDb()
  const dynamicItems = dynamicCasesFromDb(liveDb)
  let dynamicSummary = { passed: 0, failed: 0 }
  if (dynamicItems.length) {
    const dynamicResults = await runDynamicEvalCases(liveDb)
    printResults(dynamicResults)
    dynamicSummary = summarizeResults(dynamicResults, '动态评估完成')
  } else {
    console.log('动态评估完成：暂无 active assistantEvalCases。')
  }

  const failed = fixedSummary.failed + dynamicSummary.failed
  if (failed) process.exit(1)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

module.exports = {
  makeDb,
  runDynamicEvalCase,
  runDynamicEvalCases,
  runFixedEvalCases,
  dynamicCasesFromDb,
  _internal: {
    assertNeedSubset,
    assertExpectedListings,
    assertRequiredNodes,
    assertDynamicBehavior
  }
}
