'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const assistantService = require('../src/assistant-service')

const MATCH_RESULT_VERSION = 'match-result-v1'
const THREAD_ID = 'AST-m123abc-abc123'
const USER_ID = 'U-BROKER-1'
const NEED_ID = 'N-OWN-1'

function makeDb() {
  return {
    currentUserId: USER_ID,
    rentalNeeds: [
      { id: NEED_ID, brokerId: USER_ID, rawText: '测试需求原文不应进入反馈' },
      { id: 'N-OTHER-1', brokerId: 'U-BROKER-2', rawText: '其他中介需求' }
    ],
    assistantFeedbacks: []
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
    messageId: 'assistant-1783670000000-1',
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

  ;['sourceText', 'reply', 'need', 'listings', 'selectedListingIds', 'expected', 'placeResolution'].forEach((key) => {
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
    const feedback = createStrict(makeDb(), { messageId: `assistant-${1783670000100 + index}-1`, reasonCode })
    assert.strictEqual(feedback.reason, label, `没用原因映射错误：${reasonCode}`)
  })
  Object.entries(helpfulReasons).forEach(([reasonCode, label], index) => {
    resetThread()
    const feedback = createStrict(makeDb(), {
      messageId: `assistant-${1783670000200 + index}-1`,
      feedbackType: 'helpful',
      reasonCode
    })
    assert.strictEqual(feedback.reason, label, `有用原因映射错误：${reasonCode}`)
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
  ;['有用', '没用', '价格不合适', '位置不合适', '户型不合适', '房态不准', '结果太少', '结果太多'].forEach((label) => {
    assert(js.includes(label) || wxml.includes(label), `反馈界面缺少固定选项：${label}`)
  })
  const feedbackMarkup = wxml.slice(wxml.indexOf('class="assistant-feedback"'), wxml.indexOf('class="feedback-done"'))
  assert.strictEqual(/<textarea|<input/i.test(feedbackMarkup), false, '结果反馈区域不得提供自由文本输入')
}

testStrictRecordAndPiiBoundary()
testReasonWhitelistCoverage()
testValidationAndOwnership()
testIdempotency()
testLegacyFeedbackCompatibility()
testFrontendContract()

console.log('match-result-feedback-v1-test passed')
