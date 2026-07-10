'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const assistantService = require('../src/assistant-service')

const MATCH_RESULT_VERSION = 'match-result-v1'
const THREAD_ID = 'AST-mre65mo0-abc123'
const RESULT_MESSAGE_ID = 'ATLMRE65MO0ABCDE'
const USER_ID = 'U-BROKER-1'
const NEED_ID = 'N-OWN-1'

function makeDb() {
  return {
    currentUserId: USER_ID,
    rentalNeeds: [
      { id: NEED_ID, brokerId: USER_ID, rawText: '测试需求原文不应进入反馈' },
      { id: 'N-OTHER-1', brokerId: 'U-BROKER-2', rawText: '其他中介需求' }
    ],
    assistantFeedbacks: [],
    assistantTraceLogs: [{
      id: RESULT_MESSAGE_ID,
      userId: USER_ID,
      threadId: THREAD_ID,
      createdAt: '2026-07-10T00:00:01.000Z',
      traceSummary: {
        version: 'assistant-trace-v1',
        eventCount: 3,
        startedAt: '2026-07-10T00:00:00.000Z',
        endedAt: '2026-07-10T00:00:01.000Z',
        nodes: ['listing_search_tool', 'ranking_tool', 'output_guard']
      }
    }]
  }
}

function resetThread() {
  assistantService._internal.threadStore._internal.resetForTest()
  assistantService._internal.threadStore.saveThread(THREAD_ID, {
    lastTraceSummary: {
      version: 'assistant-trace-v1',
      eventCount: 3,
      startedAt: '2026-07-10T00:00:00.000Z',
      endedAt: '2026-07-10T00:00:01.000Z',
      nodes: ['listing_search_tool', 'ranking_tool', 'output_guard', '13900000001', '测试客户甲'],
      timeline: '测试客户甲 13900000001 杭州市测试区测试路99号',
      readable: '测试客户甲的完整对话不应进入严格反馈',
      audit: {
        sourceText: '测试客户甲 13900000001',
        fullAddress: '杭州市测试区测试路99号'
      }
    }
  })
}

function strictPayload(overrides = {}) {
  return Object.assign({
    feedbackVersion: MATCH_RESULT_VERSION,
    userId: 'U-BROKER-2',
    needId: NEED_ID,
    threadId: THREAD_ID,
    messageId: RESULT_MESSAGE_ID,
    feedbackType: 'bad_recommendation',
    reasonCode: 'too_few',
    reason: '测试客户甲 13900000001 觉得结果少',
    sourceText: '测试客户甲想住杭州市测试区测试路99号',
    reply: '联系测试房东 13700000002',
    need: { customerName: '测试客户甲', phone: '13900000001', address: '杭州市测试区测试路99号' },
    listings: [{ id: 'L1', address: '杭州市测试区测试路99号', landlordPhone: '13700000002' }],
    selectedListingIds: ['L1'],
    expected: { customerName: '测试客户甲', phone: '13900000001' },
    placeResolution: { name: '测试地点', address: '杭州市测试区测试路99号' }
  }, overrides)
}

function expectStatus(fn, statusCode, message) {
  assert.throws(fn, (error) => error && error.statusCode === statusCode, message)
}

function createStrict(db, overrides = {}, userId = USER_ID) {
  return assistantService.feedback(db, strictPayload(overrides), { userId })
}

function assertNoProbe(value, message) {
  const json = JSON.stringify(value)
  ;[
    '测试客户甲',
    '13900000001',
    '13700000002',
    '杭州市测试区测试路99号'
  ].forEach((probe) => assert.strictEqual(json.includes(probe), false, `${message}：${probe}`))
}

function testStrictRecordAndPiiBoundary() {
  resetThread()
  const db = makeDb()
  const feedback = createStrict(db)

  assert.strictEqual(feedback.feedbackVersion, MATCH_RESULT_VERSION, '严格反馈应记录契约版本')
  assert.strictEqual(feedback.needId, NEED_ID, '反馈必须关联 needId')
  assert.strictEqual(feedback.feedbackType, 'bad_recommendation', '反馈有用性应保留')
  assert.strictEqual(feedback.reasonCode, 'too_few', '反馈应保留固定原因码')
  assert.strictEqual(feedback.reason, '结果太少', '原因中文只能由服务端白名单生成')
  assert.strictEqual(feedback.userId, USER_ID, '反馈身份只能来自服务端上下文，忽略请求体伪造 userId')
  assert.strictEqual(db.assistantFeedbacks.length, 1, '严格反馈应落库一次')

  ;['threadId', 'sourceText', 'reply', 'need', 'listings', 'selectedListingIds', 'expected', 'placeResolution', 'operatorNote', 'resolution'].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(feedback, key), false, `严格反馈不得保存自由上下文字段：${key}`)
  })
  assert(feedback.traceSummary, '应保留最小服务端追踪元数据')
  assert.deepStrictEqual(feedback.traceSummary.nodes, ['listing_search_tool', 'ranking_tool', 'output_guard'])
  ;['timeline', 'readable', 'audit'].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(feedback.traceSummary, key), false, `最小追踪不得保存 ${key}`)
  })
  assertNoProbe(feedback, '严格反馈泄露自由文本 PII')
}

function testReasonWhitelistCoverage() {
  const negativeReasons = {
    price: '价格不合适',
    location: '位置不合适',
    layout: '户型不合适',
    availability: '房态不准',
    too_few: '结果太少',
    too_many: '结果太多'
  }
  const helpfulReasons = {
    price: '价格合适',
    location: '位置合适',
    layout: '户型合适',
    availability: '房态准确',
    result_count: '数量合适'
  }

  Object.entries(negativeReasons).forEach(([reasonCode, label], index) => {
    resetThread()
    const feedback = createStrict(makeDb(), { reasonCode })
    assert.strictEqual(feedback.reason, label, `没用原因映射错误：${reasonCode}`)
  })
  Object.entries(helpfulReasons).forEach(([reasonCode, label], index) => {
    resetThread()
    const feedback = createStrict(makeDb(), {
      feedbackType: 'helpful',
      reasonCode
    })
    assert.strictEqual(feedback.reason, label, `有用原因映射错误：${reasonCode}`)
  })
}

function testReasonWhitelistRejectsPrototypeKeys() {
  ;['__proto__', 'constructor', 'toString'].forEach((reasonCode, index) => {
    resetThread()
    const db = makeDb()
    expectStatus(
      () => createStrict(db, {
        reasonCode
      }),
      400,
      `原因白名单不得接受原型链键：${reasonCode}`
    )
    assert.strictEqual(db.assistantFeedbacks.length, 0, `原型链原因被拒后不得落库：${reasonCode}`)
  })

  ;[
    { feedbackType: '__proto__', reasonCode: 'constructor' },
    { feedbackType: 'constructor', reasonCode: 'prototype' },
    { feedbackType: 'toString', reasonCode: 'call' }
  ].forEach((payload, index) => {
    resetThread()
    const db = makeDb()
    expectStatus(
      () => createStrict(db, {
        ...payload
      }),
      400,
      `反馈类型白名单不得接受原型链组合：${payload.feedbackType}/${payload.reasonCode}`
    )
    assert.strictEqual(db.assistantFeedbacks.length, 0, '原型链反馈类型被拒后不得落库')
  })
}

function testValidationAndOwnership() {
  resetThread()
  expectStatus(() => createStrict(makeDb(), { needId: '' }), 400, 'needId 缺失必须拒绝')
  expectStatus(() => createStrict(makeDb(), { needId: 'N-NOT-FOUND' }), 404, '未知 needId 必须拒绝')
  expectStatus(() => createStrict(makeDb(), { needId: 'N-OTHER-1' }), 403, '不能给其他中介需求写反馈')
  expectStatus(() => createStrict(makeDb(), {}, ''), 401, '未登录访客不能写严格结果反馈')
  expectStatus(() => createStrict(makeDb(), { threadId: '' }), 400, 'threadId 缺失必须拒绝')
  expectStatus(() => createStrict(makeDb(), { messageId: '' }), 400, 'messageId 缺失必须拒绝')
  expectStatus(
    () => createStrict(makeDb(), { threadId: '测试客户甲-13900000001' }),
    400,
    'threadId 只能接受系统生成格式，不能夹带自由文本 PII'
  )
  expectStatus(
    () => createStrict(makeDb(), { messageId: '13900000001' }),
    400,
    'messageId 只能接受系统生成格式，不能伪装成手机号'
  )
  expectStatus(
    () => createStrict(makeDb(), { threadId: 'LOCAL-AST-13900000001-1' }),
    400,
    '系统格式外壳不得让手机号形态 threadId 进入严格记录'
  )
  expectStatus(
    () => createStrict(makeDb(), { messageId: 'assistant-13900000001-1' }),
    400,
    '系统格式外壳不得让手机号形态 messageId 进入严格记录'
  )
  expectStatus(
    () => createStrict(makeDb(), { threadId: 'AST-mre65mo0-def456' }),
    400,
    '严格反馈 threadId 必须存在当前登录用户的服务端追踪记录'
  )
  expectStatus(() => createStrict(makeDb(), { feedbackType: 'other' }), 400, '严格反馈只允许有用或没用')
  expectStatus(() => createStrict(makeDb(), { reasonCode: 'free_text_other' }), 400, '非白名单原因必须拒绝')
  expectStatus(() => createStrict(makeDb(), { feedbackType: 'helpful', reasonCode: 'too_few' }), 400, '原因码必须与有用性匹配')

  const unknownVersionDb = makeDb()
  expectStatus(
    () => assistantService.feedback(unknownVersionDb, strictPayload({ feedbackVersion: 'match-result-v2' }), { userId: USER_ID }),
    400,
    '未知非空反馈版本不得回退到可写自由文本的旧通用反馈'
  )
  assert.strictEqual(unknownVersionDb.assistantFeedbacks.length, 0, '未知版本被拒后不得落库')

  ;['   ', false, 0, null, undefined].forEach((feedbackVersion) => {
    const explicitVersionDb = makeDb()
    expectStatus(
      () => assistantService.feedback(explicitVersionDb, strictPayload({
        feedbackVersion,
        reason: '显式非法版本不得进入旧自由文本反馈'
      }), { userId: USER_ID }),
      400,
      `显式非法 feedbackVersion 不得降级旧通道：${String(feedbackVersion)}`
    )
    assert.strictEqual(explicitVersionDb.assistantFeedbacks.length, 0, '显式非法版本被拒后不得落库')
  })
}

function testIdempotency() {
  resetThread()
  const db = makeDb()
  const first = createStrict(db, { reasonCode: 'price' })
  const second = createStrict(db, { reasonCode: 'price', reason: '任意新自由文本也不得改变记录' })
  assert.strictEqual(second.id, first.id, '同一结果相同反馈重试应返回原记录')
  assert.strictEqual(db.assistantFeedbacks.length, 1, '幂等重试不得新增第二条记录')
  expectStatus(
    () => createStrict(db, { reasonCode: 'location' }),
    409,
    '同一结果的冲突反馈不得生成第二条记录'
  )
  assert.strictEqual(db.assistantFeedbacks.length, 1, '冲突反馈后记录数不得变化')
}

function testIdempotencySurvivesLegacyRetentionLimit() {
  resetThread()
  const db = makeDb()
  const first = createStrict(db, { reasonCode: 'price' })

  for (let index = 0; index < 200; index += 1) {
    assistantService.feedback(db, {
      threadId: `legacy-thread-${index}`,
      messageId: `legacy-message-${index}`,
      feedbackType: 'other',
      reason: `legacy-${index}`
    }, { userId: USER_ID })
  }

  assert(
    db.assistantFeedbacks.some((item) => item.id === first.id),
    '结构化找房反馈不得被旧通道 200 条滚动上限淘汰'
  )
  expectStatus(
    () => createStrict(db, { reasonCode: 'location' }),
    409,
    '超过旧通道保留上限后，同一结果的冲突反馈仍必须返回 409'
  )
}

function testIdempotencySurvivesTraceRetentionLimit() {
  resetThread()
  const db = makeDb()
  const first = createStrict(db, { reasonCode: 'price' })
  db.assistantTraceLogs = []

  const repeated = createStrict(db, { reasonCode: 'price' })
  assert.strictEqual(repeated.id, first.id, '结果 trace 滚动清理后，相同反馈重试仍须返回原记录')
  expectStatus(
    () => createStrict(db, { reasonCode: 'location' }),
    409,
    '结果 trace 滚动清理后，冲突反馈仍须返回 409'
  )
}

function testServerResultIdSelectsOwnedTrace() {
  resetThread()
  const db = makeDb()
  db.assistantTraceLogs.unshift({
    id: 'ATLMRE65MO0OTHER',
    userId: 'U-BROKER-2',
    threadId: THREAD_ID,
    createdAt: '2026-07-10T00:00:02.000Z',
    traceSummary: {
      version: 'assistant-trace-v1',
      eventCount: 1,
      startedAt: '2026-07-10T00:00:01.000Z',
      endedAt: '2026-07-10T00:00:02.000Z',
      nodes: ['other_user_trace_node']
    }
  })

  const feedback = createStrict(db)
  assert.deepStrictEqual(feedback.traceSummary.nodes, ['listing_search_tool', 'ranking_tool', 'output_guard'], '严格反馈必须使用结果 ID 精确命中的本人 trace 摘要')
  assert.strictEqual(feedback.traceSummary.nodes.includes('other_user_trace_node'), false, '不得按同 threadId 误取其他用户摘要')

  expectStatus(
    () => createStrict(makeDb(), { messageId: 'ATLMRE65MO0NOLOG' }),
    400,
    '客户端伪造的服务端结果 ID 没有精确 trace 时必须拒绝'
  )
}

function testServerIssuesResultIdForMatchResponse() {
  resetThread()
  const db = makeDb()
  db.assistantTraceLogs = []
  const response = assistantService.recordFeedbackResult(db, {
    threadId: THREAD_ID,
    needId: NEED_ID,
    text: '合成找房条件'
  }, {
    reply: '合成找房结果',
    listings: []
  }, { userId: USER_ID })

  assert(response.feedbackMessageId, '服务端匹配结果必须签发反馈结果 ID')
  assert.strictEqual(db.assistantTraceLogs.length, 1, '服务端匹配结果必须持久化一条结果 trace')
  assert.strictEqual(response.feedbackMessageId, db.assistantTraceLogs[0].id, '反馈结果 ID 必须等于持久 trace ID')
  assert.strictEqual(response.threadId, db.assistantTraceLogs[0].threadId, '响应 threadId 必须与持久 trace 一致')
}

function testPaddedPhoneThreadIsNotPersisted() {
  resetThread()
  const paddedThreadId = 'LOCAL-AST-1390000000100-1'
  const paddedResultId = 'ATLMRE65MO0PAD01'
  const db = makeDb()
  db.assistantTraceLogs.unshift({
    id: paddedResultId,
    userId: USER_ID,
    threadId: paddedThreadId,
    createdAt: '2026-07-10T00:00:01.000Z',
    traceSummary: {
      version: 'assistant-trace-v1',
      eventCount: 1,
      startedAt: '2026-07-10T00:00:00.000Z',
      endedAt: '2026-07-10T00:00:01.000Z',
      nodes: ['listing_search_tool']
    }
  })

  const feedback = createStrict(db, {
    threadId: paddedThreadId,
    messageId: paddedResultId
  })
  assert.strictEqual(Object.prototype.hasOwnProperty.call(feedback, 'threadId'), false, '严格记录不得保存客户端线程 ID')
  assert.strictEqual(JSON.stringify(feedback).includes('13900000001'), false, '13 位填充线程不得把手机号序列带入严格记录')
}

function testStrictReviewKeepsUserFeedbackImmutable() {
  resetThread()
  const db = makeDb()
  const feedback = createStrict(db, { reasonCode: 'price' })
  const reviewed = assistantService.reviewFeedback(db, feedback.id, {
    status: 'triaged',
    feedbackType: 'helpful',
    operatorNote: '测试客户甲 13900000001',
    resolution: '杭州市测试区测试路99号',
    expected: { customerName: '测试客户甲', phone: '13900000001' }
  }, { userId: 'U-ADMIN-1' })

  assert.strictEqual(reviewed.status, 'triaged', '严格反馈仍应支持后台状态流转')
  assert.strictEqual(reviewed.feedbackType, 'bad_recommendation', '后台不得改写用户提交的严格反馈类型')
  ;['operatorNote', 'resolution', 'expected'].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(reviewed, key), false, `严格反馈不得追加自由字段：${key}`)
  })
  assertNoProbe(reviewed, '严格反馈分诊后泄露自由文本 PII')

  const repeated = createStrict(db, { reasonCode: 'price' })
  assert.strictEqual(repeated.id, feedback.id, '后台分诊后相同反馈重试仍须幂等返回原记录')
}

function testStrictFeedbackEvalRequiresExplicitText() {
  resetThread()
  const db = makeDb()
  const feedback = createStrict(db)

  expectStatus(
    () => assistantService.promoteFeedbackToEvalCase(db, feedback.id, {}, { userId: 'U-ADMIN-1' }),
    400,
    '严格反馈不得把固定原因标签当作完整评估输入'
  )
  assert.strictEqual((db.assistantEvalCases || []).length, 0, '缺少明确评估文本时不得生成评估样本')
  assert.strictEqual(feedback.status, 'open', '提升失败后严格反馈状态不得改变')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(feedback, 'evalCaseId'), false, '提升失败后不得写入 evalCaseId')

  const promoted = assistantService.promoteFeedbackToEvalCase(db, feedback.id, {
    text: '客户电话 13900000001，预算筛选结果与预期不一致'
  }, { userId: 'U-ADMIN-1' })
  assert(promoted.evalCase.text.includes('预算筛选结果与预期不一致'), '明确脱敏文本应作为评估输入')
  assert.strictEqual(promoted.evalCase.text.includes('13900000001'), false, '明确评估文本仍须经过服务端脱敏')
}

function testLegacyFeedbackCompatibility() {
  resetThread()
  const db = makeDb()
  const legacy = assistantService.feedback(db, {
    threadId: THREAD_ID,
    messageId: 'legacy-1',
    feedbackType: 'budget_mismatch',
    reason: '旧版通用反馈继续兼容'
  }, { userId: USER_ID })
  assert.strictEqual(legacy.feedbackType, 'budget_mismatch')
  assert.strictEqual(legacy.reason, '旧版通用反馈继续兼容')
}

function testFrontendContract() {
  const root = path.join(__dirname, '..', '..')
  const js = fs.readFileSync(path.join(root, 'pages', 'match-chat', 'match-chat.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages', 'match-chat', 'match-chat.wxml'), 'utf8')
  const start = js.indexOf('submitAssistantFeedback(event)')
  const end = js.indexOf('handleConfirmFieldInput(event)', start)
  const submitBlock = js.slice(start, end)

  assert(start >= 0 && end > start, '找不到结果反馈提交函数')
  ;['feedbackVersion', 'needId', 'reasonCode'].forEach((field) => {
    assert(submitBlock.includes(field), `前端严格反馈载荷缺少 ${field}`)
  })
  ;['sourceText:', 'reply:', 'need:', 'listings:', 'selectedListingIds:', 'placeResolution:'].forEach((field) => {
    assert.strictEqual(submitBlock.includes(field), false, `前端严格反馈不得上传自由上下文：${field}`)
  })
  assert(/Boolean\([^\n]*needId/.test(js) && /!needTemporary/.test(js), '只有真实 needId 的结果才应开放反馈')
  assert(/Boolean\([^\n]*feedbackMessageId/.test(js), '只有服务端签发结果 ID 的消息才应开放反馈')
  assert(submitBlock.includes('messageId: message.feedbackMessageId'), '前端严格反馈必须提交服务端签发的结果 ID')
  ;['有用', '没用', '价格不合适', '位置不合适', '户型不合适', '房态不准', '结果太少', '结果太多'].forEach((label) => {
    assert(js.includes(label) || wxml.includes(label), `反馈界面缺少固定选项：${label}`)
  })
  const feedbackMarkup = wxml.slice(wxml.indexOf('class="assistant-feedback"'), wxml.indexOf('class="feedback-done"'))
  assert.strictEqual(/<textarea|<input/i.test(feedbackMarkup), false, '结果反馈区域不得提供自由文本输入')
}

function testAdminEvalContract() {
  const root = path.join(__dirname, '..', '..')
  const adminHtml = fs.readFileSync(path.join(root, 'admin-web', 'index.html'), 'utf8')
  const start = adminHtml.indexOf('async function promoteAssistantFeedbackToEval')
  const end = adminHtml.indexOf('async function getShowingUploadData()', start)
  const promoteBlock = adminHtml.slice(start, end)

  assert(start >= 0 && end > start, '找不到后台反馈提升评估函数')
  assert(adminHtml.includes('data-version="${safeAttr(item.feedbackVersion || \'\')}"'), '后台评估按钮必须携带反馈契约版本')
  assert(adminHtml.includes('assistant-feedback-review-button" data-id="${safeAttr(item.id)}" data-version="${safeAttr(item.feedbackVersion || \'\')}"'), '后台分诊按钮必须携带反馈契约版本')
  assert(adminHtml.includes("feedbackVersion === 'match-result-v1' ? ''"), '严格反馈分诊不得收集自由备注')
  assert(promoteBlock.includes("feedbackVersion === 'match-result-v1'"), '严格反馈提升前必须识别 match-result-v1')
  assert(promoteBlock.includes('evalText'), '严格反馈提升必须收集明确评估文本')
  assert(/body:\s*JSON\.stringify\([^)]*evalText/s.test(promoteBlock), '严格反馈提升请求必须提交明确评估文本')
  assert(adminHtml.includes('assistantFeedbackEvalButton.dataset.version'), '后台点击事件必须把反馈版本传给提升函数')
  assert(adminHtml.includes('assistantFeedbackReviewButton.dataset.version'), '后台分诊点击事件必须把反馈版本传给分诊函数')
}

function testServerConversationUsesResultId() {
  const root = path.join(__dirname, '..', '..')
  const serverIndex = fs.readFileSync(path.join(root, 'server', 'src', 'index.js'), 'utf8')
  const start = serverIndex.indexOf('function buildFeedbackConversation')
  const end = serverIndex.indexOf('// ---------- 数据备份', start)
  const conversationBlock = serverIndex.slice(start, end)

  assert(start >= 0 && end > start, '找不到后台反馈完整对话重建函数')
  assert(conversationBlock.includes('feedback.messageId'), '严格反馈完整对话必须由服务端结果 ID 反查 trace')
  assert(conversationBlock.includes('assistantTraceLogs'), '严格反馈完整对话必须从持久 trace 解析真实 threadId')
}

function testMatchRouteIssuesResultId() {
  const root = path.join(__dirname, '..', '..')
  const serverIndex = fs.readFileSync(path.join(root, 'server', 'src', 'index.js'), 'utf8')
  const start = serverIndex.indexOf("if (method === 'POST' && pathname === '/mini/llm/match')")
  const end = serverIndex.indexOf("if (method === 'POST' && pathname === '/mini/assistant/chat')", start)
  const routeBlock = serverIndex.slice(start, end)

  assert(start >= 0 && end > start, '找不到 /mini/llm/match 路由')
  assert(routeBlock.includes('assistantService.recordFeedbackResult'), '持久需求的确认匹配结果必须签发服务端结果 ID')
  assert(routeBlock.includes('!guest') && routeBlock.includes('resultBody.needId') && routeBlock.includes('!resultBody.needTemporary'), '游客或临时需求不得签发可写严格反馈的结果 ID')
}

testStrictRecordAndPiiBoundary()
testReasonWhitelistCoverage()
testReasonWhitelistRejectsPrototypeKeys()
testValidationAndOwnership()
testIdempotency()
testIdempotencySurvivesLegacyRetentionLimit()
testIdempotencySurvivesTraceRetentionLimit()
testServerResultIdSelectsOwnedTrace()
testServerIssuesResultIdForMatchResponse()
testPaddedPhoneThreadIsNotPersisted()
testStrictReviewKeepsUserFeedbackImmutable()
testStrictFeedbackEvalRequiresExplicitText()
testLegacyFeedbackCompatibility()
testFrontendContract()
testAdminEvalContract()
testServerConversationUsesResultId()
testMatchRouteIssuesResultId()

console.log('match-result-feedback-v1-test passed')
