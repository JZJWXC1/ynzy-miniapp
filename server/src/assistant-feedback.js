const {
  scrubSensitiveText,
  scrubDeep,
  safeNeed,
  safeListings,
  safePlaceResolution
} = require('./assistant/safety')

const FEEDBACK_TYPES = new Set([
  'helpful',
  'bad_recommendation',
  'wrong_intent',
  'wrong_location',
  'budget_mismatch',
  'missing_listing',
  'other'
])

const FEEDBACK_STATUSES = new Set([
  'open',
  'triaged',
  'in_eval',
  'resolved',
  'ignored'
])

const EVAL_BEHAVIORS = new Set([
  'recommend',
  'ask_followup',
  'no_sensitive_output',
  'no_result'
])

const MAX_FEEDBACK_ROWS = 200
const MAX_EVAL_ROWS = 300
const MAX_TRACE_ROWS = 500
const MAX_TEXT_LENGTH = 500
const MAX_LISTINGS = 8
const MATCH_RESULT_FEEDBACK_VERSION = 'match-result-v1'
const MATCH_RESULT_THREAD_ID_PATTERN = /^(?:AST-[a-z0-9]+-[a-z0-9]{6}|LOCAL-AST-\d{10,16}(?:-\d{1,5})?)$/i
const MATCH_RESULT_MESSAGE_ID_PATTERN = /^assistant-\d{10,16}-\d{1,5}$/
const MATCH_RESULT_FEEDBACK_REASONS = {
  helpful: {
    price: '价格合适',
    location: '位置合适',
    layout: '户型合适',
    availability: '房态准确',
    result_count: '数量合适'
  },
  bad_recommendation: {
    price: '价格不合适',
    location: '位置不合适',
    layout: '户型不合适',
    availability: '房态不准',
    too_few: '结果太少',
    too_many: '结果太多'
  }
}

function nowIso() {
  return new Date().toISOString()
}

function createTraceLogId() {
  const random = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `ATL${Date.now().toString(36).toUpperCase()}${random}`
}

function createFeedbackId() {
  const random = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `AF${Date.now().toString(36).toUpperCase()}${random}`
}

function truncateText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = scrubSensitiveText(value).trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...`
}

function normalizeFeedbackType(value) {
  const type = String(value || '').trim()
  return FEEDBACK_TYPES.has(type) ? type : 'other'
}

function matchResultFeedbackError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function requiredCorrelationId(value, fieldName, pattern = null) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (!text) throw matchResultFeedbackError(`${fieldName}必填`)
  if (text.length > 120 || /[\u0000-\u001f\u007f]/.test(text) || (pattern && !pattern.test(text))) {
    throw matchResultFeedbackError(`${fieldName}格式无效`)
  }
  return text
}

function assertMatchResultNeed(db, userId, needId) {
  if (!userId) throw matchResultFeedbackError('请先登录后再提交反馈', 401)
  const needs = Array.isArray(db.rentalNeeds)
    ? db.rentalNeeds
    : (Array.isArray(db.clientNeeds) ? db.clientNeeds : [])
  const need = needs.find((item) => item && item.id === needId)
  if (!need) throw matchResultFeedbackError('未找到需求单', 404)
  if (String(need.brokerId || '') !== userId) {
    throw matchResultFeedbackError('只能反馈自己的需求单', 403)
  }
  return need
}

function safeTraceIdentifier(value, fallback = '') {
  const text = String(value || '').trim()
  return text && text.length <= 120 && /^[A-Za-z0-9._:-]+$/.test(text) ? text : fallback
}

function safeTraceNode(value) {
  const text = safeTraceIdentifier(value)
  if (!text || !/[A-Za-z_]/.test(text) || /1[3-9]\d{9}/.test(text)) return ''
  return text
}

function safeTraceTimestamp(value) {
  const text = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) ? text : ''
}

function compactMatchResultTraceSummary(traceSummary) {
  if (!traceSummary || typeof traceSummary !== 'object') return null
  const nodes = (Array.isArray(traceSummary.nodes) ? traceSummary.nodes : [])
    .map((node) => safeTraceNode(node))
    .filter(Boolean)
    .slice(0, 20)
  const eventCount = Number(traceSummary.eventCount)
  return {
    version: safeTraceIdentifier(traceSummary.version, 'assistant-trace-v1'),
    eventCount: Number.isSafeInteger(eventCount) && eventCount >= 0 ? eventCount : nodes.length,
    startedAt: safeTraceTimestamp(traceSummary.startedAt),
    endedAt: safeTraceTimestamp(traceSummary.endedAt),
    nodes
  }
}

function createMatchResultFeedback(db, userId, payload = {}, context = {}) {
  const normalizedUserId = String(userId || '').trim()
  if (!normalizedUserId) throw matchResultFeedbackError('请先登录后再提交反馈', 401)
  const needId = requiredCorrelationId(payload.needId, 'needId')
  assertMatchResultNeed(db, normalizedUserId, needId)
  const threadId = requiredCorrelationId(payload.threadId, 'threadId', MATCH_RESULT_THREAD_ID_PATTERN)
  const messageId = requiredCorrelationId(payload.messageId, 'messageId', MATCH_RESULT_MESSAGE_ID_PATTERN)
  const feedbackType = String(payload.feedbackType || '').trim()
  const reasons = MATCH_RESULT_FEEDBACK_REASONS[feedbackType]
  if (!reasons) throw matchResultFeedbackError('反馈类型只能是有用或没用')
  const reasonCode = String(payload.reasonCode || '').trim()
  const reason = reasons[reasonCode]
  if (!reason) throw matchResultFeedbackError('请选择有效的固定反馈原因')

  const existing = db.assistantFeedbacks.find((item) => (
    item &&
    item.feedbackVersion === MATCH_RESULT_FEEDBACK_VERSION &&
    item.userId === normalizedUserId &&
    item.needId === needId &&
    item.threadId === threadId &&
    item.messageId === messageId
  ))
  if (existing) {
    if (existing.feedbackType === feedbackType && existing.reasonCode === reasonCode) return existing
    throw matchResultFeedbackError('该找房结果已提交过不同反馈', 409)
  }

  const feedback = {
    id: createFeedbackId(),
    createdAt: nowIso(),
    updatedAt: '',
    status: 'open',
    userId: normalizedUserId,
    needId,
    threadId,
    messageId,
    feedbackVersion: MATCH_RESULT_FEEDBACK_VERSION,
    feedbackType,
    reasonCode,
    reason,
    traceSummary: compactMatchResultTraceSummary(context.traceSummary),
    operatorNote: '',
    resolution: ''
  }

  db.assistantFeedbacks.unshift(feedback)
  if (db.assistantFeedbacks.length > MAX_FEEDBACK_ROWS) {
    db.assistantFeedbacks = db.assistantFeedbacks.slice(0, MAX_FEEDBACK_ROWS)
  }
  return feedback
}

function normalizeFeedbackStatus(value, fallback = 'open') {
  const status = String(value || '').trim()
  return FEEDBACK_STATUSES.has(status) ? status : fallback
}

function normalizeEvalBehavior(value) {
  const behavior = String(value || '').trim()
  return EVAL_BEHAVIORS.has(behavior) ? behavior : 'recommend'
}

function createEvalCaseId() {
  const random = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `AEC${Date.now().toString(36).toUpperCase()}${random}`
}

function normalizeSelectedListingIds(value) {
  const ids = Array.isArray(value) ? value : []
  const seen = new Set()
  return ids
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
    .slice(0, MAX_LISTINGS)
}

function listingIdsFromFeedback(feedback = {}) {
  const fromSelected = normalizeSelectedListingIds(feedback.selectedListingIds || [])
  if (fromSelected.length) return fromSelected
  return normalizeSelectedListingIds((feedback.listings || []).map((listing) => listing && listing.id))
}

function findFeedback(db, feedbackId) {
  const id = String(feedbackId || '').trim()
  const feedback = (db.assistantFeedbacks || []).find((item) => item.id === id)
  if (!feedback) {
    const error = new Error('assistant feedback not found')
    error.statusCode = 404
    throw error
  }
  return feedback
}

function compactRequiredNodes(value) {
  const nodes = Array.isArray(value) ? value : []
  return nodes
    .map((node) => truncateText(node, 80))
    .filter(Boolean)
    .slice(0, 20)
}

function compactTraceSummary(traceSummary) {
  if (!traceSummary || typeof traceSummary !== 'object') return null
  const nodes = Array.isArray(traceSummary.nodes)
    ? traceSummary.nodes.map((node) => truncateText(node, 80)).filter(Boolean)
    : []
  return {
    version: traceSummary.version || 'assistant-trace-v1',
    eventCount: Number(traceSummary.eventCount || nodes.length || 0),
    startedAt: traceSummary.startedAt || '',
    endedAt: traceSummary.endedAt || '',
    nodes,
    timeline: truncateText(traceSummary.timeline || nodes.join(' -> '), 1000),
    readable: truncateText(traceSummary.readable || '', 1000),
    audit: scrubDeep(traceSummary.audit || {})
  }
}

function sourceTextFromPayload(payload = {}) {
  return [
    payload.text,
    payload.message,
    payload.content,
    payload.voiceText
  ].filter(Boolean).join('，')
}

function createAssistantTraceLog(db, userId, payload = {}, response = {}, context = {}) {
  db.assistantTraceLogs = Array.isArray(db.assistantTraceLogs) ? db.assistantTraceLogs : []
  const traceSummary = compactTraceSummary(context.traceSummary)
  const audit = (traceSummary && traceSummary.audit) || {}
  const toolOutput = (audit && audit.toolOutput) || {}
  const traceLog = {
    id: createTraceLogId(),
    createdAt: nowIso(),
    userId: String(userId || '').trim(),
    threadId: truncateText(response.threadId || context.threadId || payload.threadId || '', 120),
    intent: truncateText(response.intent || audit.intent || '', 80),
    sourceText: truncateText(sourceTextFromPayload(payload), 1000),
    reply: truncateText(response.reply || audit.finalReply || '', 1000),
    nextQuestion: truncateText(response.nextQuestion || audit.nextQuestion || '', 500),
    shouldAskFollowUp: Boolean(audit.shouldAskFollowUp || response.nextQuestion),
    replyMode: truncateText(response.replyMode || audit.replyMode || '', 80),
    need: safeNeed(response.need || audit.slots || {}),
    listings: safeListings(response.listings || []).slice(0, MAX_LISTINGS),
    placeResolution: safePlaceResolution(response.placeResolution || toolOutput.placeResolution),
    traceSummary
  }

  db.assistantTraceLogs.unshift(traceLog)
  if (db.assistantTraceLogs.length > MAX_TRACE_ROWS) {
    db.assistantTraceLogs = db.assistantTraceLogs.slice(0, MAX_TRACE_ROWS)
  }
  return traceLog
}

function assistantTraceRows(db, options = {}) {
  const threadId = String(options.threadId || '').trim()
  const intent = String(options.intent || '').trim()
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), MAX_TRACE_ROWS)
  return (db.assistantTraceLogs || [])
    .filter((item) => !threadId || item.threadId === threadId)
    .filter((item) => !intent || item.intent === intent)
    .slice(0, limit)
}

function createAssistantFeedback(db, userId, payload = {}, context = {}) {
  db.assistantFeedbacks = Array.isArray(db.assistantFeedbacks) ? db.assistantFeedbacks : []

  const feedbackVersion = String(payload.feedbackVersion || '').trim()
  if (feedbackVersion && feedbackVersion !== MATCH_RESULT_FEEDBACK_VERSION) {
    throw matchResultFeedbackError('不支持的反馈版本')
  }
  if (feedbackVersion === MATCH_RESULT_FEEDBACK_VERSION) {
    return createMatchResultFeedback(db, userId, payload, context)
  }

  const feedback = {
    id: createFeedbackId(),
    createdAt: nowIso(),
    updatedAt: '',
    status: 'open',
    userId: String(userId || '').trim(),
    threadId: truncateText(payload.threadId || '', 120),
    messageId: truncateText(payload.messageId || '', 120),
    feedbackType: normalizeFeedbackType(payload.feedbackType),
    reason: truncateText(payload.reason || ''),
    sourceText: truncateText(payload.sourceText || ''),
    reply: truncateText(payload.reply || '', 1000),
    need: safeNeed(payload.need || {}),
    listings: safeListings(payload.listings || []).slice(0, MAX_LISTINGS),
    selectedListingIds: normalizeSelectedListingIds(payload.selectedListingIds),
    expected: scrubDeep(payload.expected || {}),
    placeResolution: safePlaceResolution(payload.placeResolution),
    traceSummary: compactTraceSummary(context.traceSummary),
    operatorNote: '',
    resolution: ''
  }

  db.assistantFeedbacks.unshift(feedback)
  if (db.assistantFeedbacks.length > MAX_FEEDBACK_ROWS) {
    db.assistantFeedbacks = db.assistantFeedbacks.slice(0, MAX_FEEDBACK_ROWS)
  }

  return feedback
}

function assistantFeedbackRows(db, options = {}) {
  const status = String(options.status || '').trim()
  const type = String(options.feedbackType || options.type || '').trim()
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), MAX_FEEDBACK_ROWS)
  return (db.assistantFeedbacks || [])
    .filter((item) => !status || item.status === status)
    .filter((item) => !type || item.feedbackType === type)
    .slice(0, limit)
}

function reviewAssistantFeedback(db, feedbackId, userId, payload = {}) {
  const feedback = findFeedback(db, feedbackId)
  const status = normalizeFeedbackStatus(payload.status, feedback.status || 'open')
  feedback.status = status
  feedback.feedbackType = payload.feedbackType ? normalizeFeedbackType(payload.feedbackType) : feedback.feedbackType
  feedback.operatorNote = truncateText(payload.operatorNote || feedback.operatorNote || '', 1000)
  feedback.resolution = truncateText(payload.resolution || feedback.resolution || '', 1000)
  if (payload.expected) feedback.expected = scrubDeep(payload.expected)
  feedback.updatedAt = nowIso()
  feedback.handledBy = String(userId || '').trim()
  return feedback
}

function promoteFeedbackToEvalCase(db, feedbackId, userId, payload = {}) {
  const feedback = findFeedback(db, feedbackId)
  db.assistantEvalCases = Array.isArray(db.assistantEvalCases) ? db.assistantEvalCases : []
  const text = truncateText(payload.text || payload.sourceText || feedback.sourceText || feedback.reason || '')
  if (!text) {
    const error = new Error('assistant eval case text required')
    error.statusCode = 400
    throw error
  }

  const expectedNeed = safeNeed(payload.expectedNeed || (payload.expected && payload.expected.need) || feedback.need || {})
  const expectedListingIds = normalizeSelectedListingIds(
    payload.expectedListingIds || payload.selectedListingIds || listingIdsFromFeedback(feedback)
  )
  const requiredNodes = compactRequiredNodes(payload.requiredNodes || (feedback.traceSummary && feedback.traceSummary.nodes) || [])
  const evalCase = {
    id: createEvalCaseId(),
    sourceFeedbackId: feedback.id,
    createdAt: nowIso(),
    createdBy: String(userId || '').trim(),
    status: 'active',
    feedbackType: feedback.feedbackType || 'other',
    behavior: normalizeEvalBehavior(payload.behavior),
    text,
    expectedNeed,
    expectedListingIds,
    expectedFollowUp: truncateText(payload.expectedFollowUp || '', 500),
    requiredNodes,
    operatorNote: truncateText(payload.operatorNote || feedback.operatorNote || '', 1000)
  }

  db.assistantEvalCases.unshift(evalCase)
  if (db.assistantEvalCases.length > MAX_EVAL_ROWS) {
    db.assistantEvalCases = db.assistantEvalCases.slice(0, MAX_EVAL_ROWS)
  }

  feedback.status = 'in_eval'
  feedback.evalCaseId = evalCase.id
  feedback.updatedAt = nowIso()
  feedback.handledBy = String(userId || '').trim()
  return {
    feedback,
    evalCase
  }
}

function assistantEvalCaseRows(db, options = {}) {
  const status = String(options.status || '').trim()
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), MAX_EVAL_ROWS)
  return (db.assistantEvalCases || [])
    .filter((item) => !status || item.status === status)
    .slice(0, limit)
}

module.exports = {
  createAssistantTraceLog,
  assistantTraceRows,
  createAssistantFeedback,
  assistantFeedbackRows,
  reviewAssistantFeedback,
  promoteFeedbackToEvalCase,
  assistantEvalCaseRows,
  _internal: {
    compactTraceSummary,
    sourceTextFromPayload,
    normalizeFeedbackType,
    normalizeFeedbackStatus,
    normalizeEvalBehavior,
    normalizeSelectedListingIds,
    listingIdsFromFeedback,
    compactMatchResultTraceSummary,
    MATCH_RESULT_FEEDBACK_VERSION,
    MATCH_RESULT_FEEDBACK_REASONS
  }
}
