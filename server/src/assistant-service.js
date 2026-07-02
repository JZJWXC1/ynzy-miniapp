const { runAssistantGraph } = require('./assistant/graph')
const threadStore = require('./assistant/state-store')
const assistantFeedback = require('./assistant-feedback')

async function chat(db, payload = {}, context = {}) {
  const threadId = threadStore.resolveThreadId(payload.threadId)
  const previous = threadStore.getThread(threadId) || {}
  const result = await runAssistantGraph(db, payload, {
    ...context,
    threadId,
    previousNeed: previous.need || {},
    debugTrace: Boolean(context.debugTrace || payload.debugTrace)
  })

  threadStore.saveThread(threadId, {
    need: result.need,
    lastIntent: result.response.intent,
    lastTraceSummary: result.traceSummary || null
  })
  assistantFeedback.createAssistantTraceLog(db, context.userId, payload, result.response, {
    threadId,
    traceSummary: result.traceSummary
  })

  return result.response
}

function feedback(db, payload = {}, context = {}) {
  const threadId = String(payload.threadId || '').trim()
  const previous = threadId ? threadStore.getThread(threadId) : null
  const traceSummary = traceSummaryForFeedback(db, threadId, previous)
  return assistantFeedback.createAssistantFeedback(db, context.userId, {
    ...payload,
    threadId
  }, {
    traceSummary
  })
}

function traceSummaryForFeedback(db, threadId, previous) {
  if (previous && previous.lastTraceSummary) return previous.lastTraceSummary
  if (!threadId) return null
  const rows = assistantFeedback.assistantTraceRows(db, { threadId, limit: 1 })
  return rows[0] && rows[0].traceSummary ? rows[0].traceSummary : null
}

function feedbackRows(db, options = {}) {
  return assistantFeedback.assistantFeedbackRows(db, options)
}

function reviewFeedback(db, feedbackId, payload = {}, context = {}) {
  return assistantFeedback.reviewAssistantFeedback(db, feedbackId, context.userId, payload)
}

function promoteFeedbackToEvalCase(db, feedbackId, payload = {}, context = {}) {
  return assistantFeedback.promoteFeedbackToEvalCase(db, feedbackId, context.userId, payload)
}

function evalCaseRows(db, options = {}) {
  return assistantFeedback.assistantEvalCaseRows(db, options)
}

function traceRows(db, options = {}) {
  return assistantFeedback.assistantTraceRows(db, options)
}

module.exports = {
  chat,
  feedback,
  feedbackRows,
  reviewFeedback,
  promoteFeedbackToEvalCase,
  evalCaseRows,
  traceRows,
  _internal: {
    assistantFeedback,
    threadStore,
    traceSummaryForFeedback
  }
}
