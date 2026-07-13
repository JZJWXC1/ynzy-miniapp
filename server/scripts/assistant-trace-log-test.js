const assert = require('assert')
const assistantService = require('../src/assistant-service')
const evalRunner = require('./assistant-eval-runner')
const { containsSensitiveText, scrubSensitiveText } = require('../src/assistant/safety')

async function main() {
  assert.strictEqual(
    scrubSensitiveText('AST-mrjlvxwn-4nreg2'),
    'AST-mrjlvxwn-4nreg2',
    '无联系方式语义的随机 threadId 中 vx 子串不得被误脱敏'
  )
  assert.ok(!scrubSensitiveText('微信 VX:private_contact_01').includes('private_contact_01'), '有明确联系方式语义的 VX 号必须继续脱敏')
  assistantService._internal.threadStore._internal.resetForTest()
  const db = evalRunner.makeDb()
  db.rentalNeeds = [{ id: 'N-TRACE-1', brokerId: 'U001' }]

  const result = await assistantService.chat(db, {
    needId: 'N-TRACE-1',
    text: '客户13812345678想看新天地3公里内整租两室，微信wxid_secret12345，1栋2单元301室'
  }, {
    userId: 'U001'
  })

  assert(result.threadId, '普通聊天响应应返回 threadId')
  assert(!result.traceSummary, '非 debug 小程序响应不应返回 traceSummary')
  assert(Array.isArray(db.assistantTraceLogs), '每轮对话应写入 assistantTraceLogs')
  assert.strictEqual(db.assistantTraceLogs.length, 1, '应记录一条 trace log')

  const log = db.assistantTraceLogs[0]
  assert.strictEqual(result.feedbackMessageId, log.id, '普通聊天响应必须返回持久 trace 的服务端结果 ID')
  assert.strictEqual(log.feedbackNeedId, 'N-TRACE-1', '结果 trace 必须绑定服务端验证后的持久 needId')
  assert.strictEqual(log.threadId, result.threadId, 'trace log 应关联 threadId')
  assert.strictEqual(log.userId, 'U001', 'trace log 应记录用户')
  assert.strictEqual(log.intent, 'rental_match', 'trace log 应记录意图')
  assert(log.traceSummary && log.traceSummary.audit, 'trace log 应保留 trace audit')
  assert(log.traceSummary.nodes.includes('sanitize_input'), 'trace log 应保留节点链路')
  assert(log.traceSummary.nodes.includes('ranking_tool'), 'trace log 应保留排序节点')
  assert(log.traceSummary.nodes.includes('trace_logger'), 'trace log 应保留 trace_logger 节点')
  assert(log.traceSummary.audit.toolInput, 'trace log audit 应保留工具输入')
  assert(log.traceSummary.audit.toolOutput, 'trace log audit 应保留工具输出')
  assert(log.traceSummary.audit.finalReply, 'trace log audit 应保留最终回复')
  assert(!containsSensitiveText(log), 'trace log 不能包含敏感信息')

  const rows = assistantService.traceRows(db, { threadId: result.threadId })
  assert.strictEqual(rows.length, 1, 'traceRows 应支持按 threadId 查询')
  assert.strictEqual(rows[0].id, log.id, 'traceRows 返回了错误记录')

  assistantService._internal.threadStore._internal.resetForTest()
  const feedback = assistantService.feedback(db, {
    threadId: result.threadId,
    messageId: 'assistant-trace-log-message',
    feedbackType: 'helpful',
    sourceText: '客户觉得推荐可用',
    reply: result.reply,
    need: result.need,
    listings: result.listings
  }, {
    userId: 'U001'
  })
  assert(feedback.traceSummary && feedback.traceSummary.audit, '内存线程丢失后反馈仍应从持久 trace log 关联 trace audit')
  assert(feedback.traceSummary.nodes.includes('ranking_tool'), '反馈 trace 不应因持久日志丢失节点')
  assert(!containsSensitiveText(feedback), '反馈记录不能包含敏感信息')

  console.log('assistant-trace-log-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
