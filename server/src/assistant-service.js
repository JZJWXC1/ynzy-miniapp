const { runAssistantGraph } = require('./assistant/graph')
const threadStore = require('./assistant/state-store')
const assistantFeedback = require('./assistant-feedback')
const matchService = require('./match-service')
const {
  safeNeed,
  safeListings,
  safePlaceResolution,
  scrubSensitiveText
} = require('./assistant/safety')

async function chat(db, payload = {}, context = {}) {
  const threadId = context.threadId || threadStore.resolveThreadId(payload.threadId)
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

  const writeTraceLog = (targetDb) => assistantFeedback.createAssistantTraceLog(targetDb, context.userId, payload, result.response, {
    threadId,
    traceSummary: result.traceSummary
  })
  // 慢速 LLM 调用已在只读快照上跑完，留痕交由调用方在同步写事务里落到最新 db，
  // 避免 await 期间的并发写入被旧快照整库回写覆盖（见 db.js 写窗口竞态）。
  // 未提供 persistTrace 时（测试等直调场景）保持原语义：直接写进传入的 db。
  const traceLog = typeof context.persistTrace === 'function'
    ? context.persistTrace(writeTraceLog)
    : writeTraceLog(db)

  return {
    ...result.response,
    feedbackMessageId: traceLog && traceLog.id ? traceLog.id : ''
  }
}

function fallbackChat(db, payload = {}, context = {}, options = {}) {
  const threadId = context.threadId || threadStore.resolveThreadId(payload.threadId)
  const local = matchService.buildLocalMatch(db, payload)
  const response = {
    threadId,
    reply: scrubSensitiveText(local.reply || ''),
    nextQuestion: scrubSensitiveText(local.followUpQuestion || ''),
    intent: 'rental_match',
    need: safeNeed(local.need || {}),
    placeResolution: safePlaceResolution(local.placeResolution),
    listings: safeListings(local.listings || []),
    exactListings: safeListings(local.exactListings || []),
    nearbyListings: safeListings(local.nearbyListings || []),
    needParserMode: 'local-fallback',
    needParserWarnings: [],
    replyMode: 'local-fallback',
    llmWarning: scrubSensitiveText(options.reason || ''),
    mode: 'local-graph-assistant-v1',
    degraded: true,
    degradedNotice: '智能解读稍后重试',
    degradedReason: options.code || 'assistant_chat_fallback'
  }

  threadStore.saveThread(threadId, {
    need: response.need,
    lastIntent: response.intent,
    lastTraceSummary: null
  })

  const writeTraceLog = (targetDb) => assistantFeedback.createAssistantTraceLog(targetDb, context.userId, payload, response, {
    threadId,
    traceSummary: null
  })
  const traceLog = typeof context.persistTrace === 'function'
    ? context.persistTrace(writeTraceLog)
    : writeTraceLog(db)

  return {
    ...response,
    feedbackMessageId: traceLog && traceLog.id ? traceLog.id : ''
  }
}

function recordFeedbackResult(db, payload = {}, response = {}, context = {}) {
  const threadId = String(response.threadId || payload.threadId || '').trim() || threadStore.resolveThreadId('')
  const traceLog = assistantFeedback.createAssistantTraceLog(db, context.userId, payload, {
    ...response,
    threadId
  }, {
    threadId,
    traceSummary: context.traceSummary || null
  })
  return {
    ...response,
    threadId: traceLog.threadId || threadId,
    feedbackMessageId: traceLog.id
  }
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
  fallbackChat,
  recordFeedbackResult,
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
