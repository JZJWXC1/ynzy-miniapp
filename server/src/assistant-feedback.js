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
    listingIdsFromFeedback
  }
}
