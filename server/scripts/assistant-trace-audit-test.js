const assert = require('assert')
const assistantService = require('../src/assistant-service')
const evalRunner = require('./assistant-eval-runner')
const { containsSensitiveText } = require('../src/assistant/safety')

function assertHasValue(value, message) {
  if (value === undefined || value === null || value === '') {
    throw new Error(message)
  }
}

async function main() {
  const db = evalRunner.makeDb()
  const wandaPlaceName = Object.keys(db.placeCoordinates || {}).find((name) => {
    const item = db.placeCoordinates[name]
    return item && Array.isArray(item.aliases) && item.aliases.length
  })
  assert(wandaPlaceName, '测试库缺少带别名的已确认地名')
  const recommendText = `${wandaPlaceName}附近有哪些2000左右的单间`
  const followUpText = '必须有阳台'
  assistantService._internal.threadStore._internal.resetForTest()

  const recommendResult = await assistantService.chat(db, {
    debugTrace: true,
    text: recommendText
  }, {
    userId: 'U001',
    debugTrace: true
  })

  const audit = recommendResult.traceSummary && recommendResult.traceSummary.audit
  assert(audit, '推荐链路缺少 traceSummary.audit')
  assert.strictEqual(audit.intent, 'rental_match', 'audit 应记录找房意图')
  assert(audit.slots, 'audit 应记录结构化槽位')
  assertHasValue(audit.slots.maxBudget || audit.slots.budget || audit.slots.budgetText, 'audit 槽位缺少预算')
  assertHasValue(audit.slots.layout || audit.slots.rentMode, 'audit 槽位缺少户型或租法')
  assert(audit.toolInput && audit.toolInput.toolPlan, 'audit 应记录工具输入计划')
  assert.strictEqual(audit.toolInput.searchType, 'radius_around_place', 'audit 工具计划应保留半径找房类型')
  assert(audit.toolOutput && audit.toolOutput.listingSearchResult, 'audit 应记录房源搜索工具输出')
  assert(audit.toolOutput.rankingResult, 'audit 应记录排序工具输出')
  assert(audit.toolOutput.rankingResult.listingCount > 0, 'audit 排序结果应记录推荐套数')
  assertHasValue(audit.finalReply, 'audit 应记录最终回复')
  assert.strictEqual(audit.shouldAskFollowUp, false, '完整找房推荐不应标记为追问')
  assert(!containsSensitiveText(audit), 'audit 不能包含敏感信息')

  const feedback = assistantService.feedback(db, {
    threadId: recommendResult.threadId,
    messageId: 'assistant-audit-test',
    feedbackType: 'bad_recommendation',
    sourceText: recommendText,
    reply: recommendResult.reply,
    need: recommendResult.need,
    listings: recommendResult.listings,
    placeResolution: recommendResult.placeResolution
  }, {
    userId: 'U001'
  })
  assert(feedback.traceSummary && feedback.traceSummary.audit, '反馈记录应保留 trace audit')
  assert.strictEqual(feedback.traceSummary.audit.intent, 'rental_match', '反馈 trace audit 应保留意图')
  assert(feedback.traceSummary.audit.toolOutput.rankingResult, '反馈 trace audit 应保留排序结果')
  assert(!containsSensitiveText(feedback.traceSummary.audit), '反馈 trace audit 不能包含敏感信息')

  assistantService._internal.threadStore._internal.resetForTest()
  const followUpResult = await assistantService.chat(db, {
    debugTrace: true,
    text: followUpText
  }, {
    userId: 'U001',
    debugTrace: true
  })
  const followUpAudit = followUpResult.traceSummary && followUpResult.traceSummary.audit
  assert(followUpAudit, '追问链路缺少 traceSummary.audit')
  assert.strictEqual(followUpAudit.shouldAskFollowUp, true, '低置信地点必须在 audit 中标记为追问')
  assertHasValue(followUpAudit.nextQuestion, '追问链路 audit 应记录追问话术')
  assert(!followUpResult.traceSummary.nodes.includes('ranking_tool'), '追问链路不应进入排序工具')
  assert(!containsSensitiveText(followUpAudit), '追问 audit 不能包含敏感信息')

  console.log('assistant-trace-audit-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
