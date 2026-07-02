const assert = require('assert')
const assistantService = require('../src/assistant-service')
const { containsSensitiveText } = require('../src/assistant/safety')

function makeDb() {
  return {
    currentUserId: 'U001',
    assistantFeedbacks: []
  }
}

function main() {
  assistantService._internal.threadStore._internal.resetForTest()
  const db = makeDb()
  const threadId = 'AST-feedback-test'

  assistantService._internal.threadStore.saveThread(threadId, {
    need: {
      area: '拱墅',
      anchorName: '乐富智慧园',
      radiusKm: 2,
      maxBudget: 1500,
      layout: '一室',
      rentMode: '整租'
    },
    lastTraceSummary: {
      version: 'assistant-trace-v1',
      eventCount: 6,
      startedAt: '2026-07-02T00:00:00.000Z',
      endedAt: '2026-07-02T00:00:01.000Z',
      nodes: [
        'sanitize_input',
        'llm_need_parser',
        'confidence_gate',
        'listing_search_tool',
        'ranking_tool',
        'output_guard'
      ],
      timeline: 'sanitize_input -> llm_need_parser -> confidence_gate -> listing_search_tool -> ranking_tool -> output_guard',
      readable: '执行了 6 个节点'
    }
  })

  const feedback = assistantService.feedback(db, {
    threadId,
    messageId: 'assistant-001',
    feedbackType: 'budget_mismatch',
    reason: '客户电话13812345678，微信wxid_secret12345，觉得这套不符合预算',
    sourceText: '租客在乐富智慧园上班，电话13812345678，找1500左右一室整租',
    reply: '给你看 2 套真实房源，联系房东13900000001',
    need: {
      area: '拱墅',
      anchorName: '乐富智慧园',
      radiusKm: 2,
      maxBudget: 1500,
      landlordPhone: '13900000001'
    },
    listings: [
      {
        id: 'L001',
        title: '乐富智慧园附近 1 幢 2 单元 301',
        community: '祥符小区',
        rent: 1600,
        layout: '一室',
        rentMode: '整租',
        matchReason: '距离工作地点约1.2公里',
        landlordPhone: '13900000001',
        address: '杭州市拱墅区祥符小区1幢2单元301室',
        videoUrl: 'https://example.com/a.mp4?OSSAccessKeyId=ak&Signature=raw'
      }
    ],
    selectedListingIds: ['L001', 'L001', ''],
    expected: {
      note: '希望不要出现手机号13812345678',
      landlordPhone: '13900000001'
    },
    placeResolution: {
      status: 'resolved',
      query: '乐富智慧园',
      name: '乐富智慧园',
      area: '拱墅',
      type: 'place',
      address: '不应保存的详细地址'
    },
    traceSummary: {
      nodes: ['frontend_fake_trace']
    }
  }, { userId: 'U001' })

  assert.strictEqual(db.assistantFeedbacks.length, 1, '反馈没有写入数据库')
  assert.strictEqual(feedback.threadId, threadId, '反馈没有关联原 threadId')
  assert.strictEqual(feedback.feedbackType, 'budget_mismatch', '反馈类型没有保留')
  assert.deepStrictEqual(feedback.selectedListingIds, ['L001'], '选中房源 ID 应去重并过滤空值')
  assert(feedback.traceSummary, '反馈应关联服务端 trace 摘要')
  assert(feedback.traceSummary.nodes.includes('listing_search_tool'), '反馈 trace 应来自服务端 threadStore')
  assert(!feedback.traceSummary.nodes.includes('frontend_fake_trace'), '反馈不能信任前端上传的 trace')
  assert.strictEqual(feedback.need.anchorName, '乐富智慧园', '反馈需求字段丢失')
  assert.strictEqual(feedback.listings.length, 1, '反馈房源摘要丢失')
  ;['address', 'landlordPhone', 'videoUrl'].forEach((key) => {
    assert(!Object.prototype.hasOwnProperty.call(feedback.listings[0], key), `反馈房源泄露敏感字段：${key}`)
  })
  assert.strictEqual(feedback.placeResolution.name, '乐富智慧园', '地点解析摘要丢失')
  assert(!Object.prototype.hasOwnProperty.call(feedback.placeResolution, 'address'), '地点解析不能保存详细地址')
  assert(!Object.prototype.hasOwnProperty.call(feedback.expected, 'landlordPhone'), '期望字段不能保存房东电话')
  assert(!containsSensitiveText(feedback), '反馈记录包含敏感文本')

  const rows = assistantService.feedbackRows(db, { feedbackType: 'budget_mismatch' })
  assert.strictEqual(rows.length, 1, '反馈列表筛选失败')
  assert.strictEqual(rows[0].id, feedback.id, '反馈列表返回了错误记录')

  const reviewed = assistantService.reviewFeedback(db, feedback.id, {
    status: 'triaged',
    operatorNote: '运营确认：客户13812345678反馈预算不准',
    resolution: '加入回归评估',
    expected: {
      need: {
        anchorName: '乐富智慧园',
        maxBudget: 1500
      },
      phone: '13812345678'
    }
  }, { userId: 'ADMIN' })
  assert.strictEqual(reviewed.status, 'triaged', '反馈状态没有流转')
  assert.strictEqual(reviewed.handledBy, 'ADMIN', '反馈处理人没有记录')
  assert(!containsSensitiveText(reviewed), '反馈标注后包含敏感文本')
  assert(!Object.prototype.hasOwnProperty.call(reviewed.expected, 'phone'), '反馈期望不能保存电话字段')

  const promoted = assistantService.promoteFeedbackToEvalCase(db, feedback.id, {
    behavior: 'recommend',
    expectedListingIds: ['L001'],
    expectedNeed: {
      anchorName: '乐富智慧园',
      radiusKm: 2,
      maxBudget: 1500,
      rentMode: '整租',
      layout: '一室'
    },
    requiredNodes: ['sanitize_input', 'geo_place_tool', 'ranking_tool'],
    operatorNote: '典型预算不准 bad case'
  }, { userId: 'ADMIN' })
  assert.strictEqual(promoted.feedback.status, 'in_eval', '反馈转评估后状态应为 in_eval')
  assert(promoted.evalCase.id, '评估样本缺少 id')
  assert.strictEqual(promoted.evalCase.sourceFeedbackId, feedback.id, '评估样本没有关联反馈')
  assert.strictEqual(promoted.evalCase.text.indexOf('13812345678'), -1, '评估样本文本泄露手机号')
  assert.deepStrictEqual(promoted.evalCase.expectedListingIds, ['L001'], '评估样本房源期望错误')
  assert(promoted.evalCase.requiredNodes.includes('geo_place_tool'), '评估样本缺少关键节点约束')
  assert(!containsSensitiveText(promoted), '评估样本包含敏感文本')

  const evalRows = assistantService.evalCaseRows(db, { status: 'active' })
  assert.strictEqual(evalRows.length, 1, '评估样本列表筛选失败')
  assert.strictEqual(evalRows[0].id, promoted.evalCase.id, '评估样本列表返回了错误记录')

  console.log('assistant-feedback-test passed')
}

main()
