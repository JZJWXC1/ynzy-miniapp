const assert = require('assert')
const assistantService = require('../src/assistant-service')
const { containsSensitiveText } = require('../src/assistant/safety')
const { makeDb } = require('./assistant-eval-runner')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function ids(result) {
  return (result.listings || []).map((item) => item.id)
}

async function chat(db, payload, userId = 'real-need-probe') {
  return assistantService.chat(clone(db), { debugTrace: true, ...payload }, { userId })
}

function assertSafe(result, label) {
  assert(!containsSensitiveText(result), `${label} 不应输出敏感信息`)
}

function assertTrace(result, node, label) {
  const nodes = result.traceSummary && result.traceSummary.nodes
  assert(Array.isArray(nodes), `${label} 缺少 traceSummary.nodes`)
  assert(nodes.includes(node), `${label} trace 缺少 ${node}`)
}

function assertRental(result, label) {
  assert.strictEqual(result.intent, 'rental_match', `${label} 应进入找房链路`)
  assertSafe(result, label)
}

function assertFollowUp(result, label) {
  assertRental(result, label)
  assert(result.nextQuestion, `${label} 应追问澄清`)
  assert.strictEqual((result.listings || []).length, 0, `${label} 追问前不应推荐房源`)
}

function assertRecommendation(result, label) {
  assertRental(result, label)
  assert((result.listings || []).length > 0, `${label} 应返回房源`)
  assertTrace(result, 'ranking_tool', label)
}

function assertBusinessFaq(result, topic, label) {
  assert.strictEqual(result.intent, 'business_faq', `${label} 应进入业务 FAQ`)
  assert.strictEqual(result.intentTopic || topic, topic, `${label} FAQ 主题不正确`)
  assertSafe(result, label)
}

async function main() {
  const db = makeDb()
  assistantService._internal.threadStore._internal.resetForTest()

  let passed = 0
  async function runCase(label, fn) {
    await fn()
    passed += 1
  }

  await runCase('标准半径找房', async () => {
    const result = await chat(db, { text: '新天地3公里内有哪些整租的两室' }, 'probe-standard-1')
    assertRecommendation(result, '标准半径找房')
    assert(ids(result).includes('XTD01'), '标准半径找房应包含新天地房源')
  })

  await runCase('地标预算口语找房', async () => {
    const result = await chat(db, { text: '拱墅万达附近2000左右的单间' }, 'probe-standard-2')
    assertRecommendation(result, '地标预算口语找房')
    assert(ids(result).includes('WD01'), '地标预算口语找房应包含万达单间')
  })

  await runCase('小区两室找房', async () => {
    const result = await chat(db, { text: '东新园整租两室预算3500' }, 'probe-standard-3')
    assertRecommendation(result, '小区两室找房')
    assert(ids(result).includes('DXY01'), '小区两室找房应包含东新园房源')
  })

  await runCase('相近小区名不误纠', async () => {
    const result = await chat(db, { text: '杨乐府3600左右两室整租' }, 'probe-standard-4')
    assertRecommendation(result, '相近小区名不误纠')
    assert(ids(result).includes('XTD03'), '相近小区名不误纠应返回杨乐府房源')
  })

  await runCase('生活化安静诉求追问', async () => {
    const result = await chat(db, { text: '想找个安静点的房子' }, 'probe-fuzzy-1')
    assertFollowUp(result, '生活化安静诉求追问')
  })

  await runCase('带娃上学诉求追问', async () => {
    const result = await chat(db, { text: '带娃上学方便的' }, 'probe-fuzzy-2')
    assertFollowUp(result, '带娃上学诉求追问')
  })

  await runCase('女生安全诉求追问', async () => {
    const result = await chat(db, { text: '想找个安全点的女生住的房子' }, 'probe-fuzzy-3')
    assertFollowUp(result, '女生安全诉求追问')
  })

  await runCase('只有阳台硬条件追问', async () => {
    const result = await chat(db, { text: '必须有阳台' }, 'probe-fuzzy-4')
    assertFollowUp(result, '只有阳台硬条件追问')
  })

  await runCase('租法户型冲突追问', async () => {
    const result = await chat(db, { text: '拱墅万达附近2000左右整租单间' }, 'probe-guard-1')
    assertFollowUp(result, '租法户型冲突追问')
    assert(/合租单间|整租一室/.test(result.nextQuestion), '租法户型冲突应问清合租单间还是整租一室')
  })

  await runCase('万达多候选追问', async () => {
    const result = await chat(db, { text: '万达附近有哪些2000左右的单间' }, 'probe-guard-2')
    assertFollowUp(result, '万达多候选追问')
    assert(result.placeResolution && result.placeResolution.status === 'ambiguous', '万达多候选应返回 ambiguous')
  })

  await runCase('陌生小区坐标缺失追问', async () => {
    const result = await chat(db, { text: '想住陌生小区，1500左右的一室整租' }, 'probe-guard-3')
    assertFollowUp(result, '陌生小区坐标缺失追问')
    assert(result.placeResolution && result.placeResolution.status === 'missing', '陌生小区应返回 missing')
  })

  await runCase('续问换便宜房源不落 FAQ', async () => {
    assistantService._internal.threadStore._internal.resetForTest()
    const first = await chat(db, { text: '新天地3公里内有哪些4000以内整租的两室' }, 'probe-follow-1')
    const second = await chat(db, { threadId: first.threadId, text: '换一个便宜点的' }, 'probe-follow-1')
    assertRecommendation(second, '续问换便宜房源不落 FAQ')
  })

  await runCase('指代位置不落 FAQ', async () => {
    assistantService._internal.threadStore._internal.resetForTest()
    const first = await chat(db, { text: '东新园整租两室预算3500' }, 'probe-follow-2')
    const second = await chat(db, { threadId: first.threadId, text: '刚才那套的位置发我' }, 'probe-follow-2')
    assertRecommendation(second, '指代位置不落 FAQ')
  })

  await runCase('改看新小区继续找房', async () => {
    assistantService._internal.threadStore._internal.resetForTest()
    const first = await chat(db, { text: '新天地3公里内有哪些4000以内整租的两室' }, 'probe-follow-3')
    const second = await chat(db, { threadId: first.threadId, text: '改看东新园两室' }, 'probe-follow-3')
    assertRecommendation(second, '改看新小区继续找房')
    assert.strictEqual(second.need.community, '东新园', '改看新小区应更新小区')
  })

  await runCase('业务报备问题仍走 FAQ', async () => {
    const result = await chat(db, { text: '报备和签单怎么走？' }, 'probe-faq-1')
    assertBusinessFaq(result, 'report', '业务报备问题仍走 FAQ')
  })

  await runCase('地图使用问题仍走 FAQ', async () => {
    const result = await chat(db, { text: '为什么地图没有坐标' }, 'probe-faq-2')
    assertBusinessFaq(result, 'map', '地图使用问题仍走 FAQ')
  })

  console.log(`assistant-real-need-baseline-test passed: ${passed}/16`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
