const matchService = require('../match-service')
const { normalizeAsrText } = require('../asr-normalizer')
const { placeNames, resolvePlace } = require('../place-locator')
const { buildBusinessFaq } = require('./business-faq')
const { evaluateConfidence } = require('./confidence-gate')
const { createLangGraph } = require('./graph-runner')
const { routeIntent } = require('./intents')
const { generateControlledReply } = require('./llm-reply')
const { parseRentalNeedWithLlm, validateRentalNeed } = require('./need-parser')
const {
  scrubDeep,
  scrubSensitiveText,
  safeNeed,
  safeListings,
  safePlaceResolution
} = require('./safety')

const MODE = 'local-graph-assistant-v1'

function unique(values) {
  const seen = new Set()
  return (values || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && value !== ''
}

function getCandidates(db) {
  if (matchService._internal && typeof matchService._internal.candidateListings === 'function') {
    return matchService._internal.candidateListings(db || {})
  }
  return []
}

function getFormPayload(payload = {}) {
  if (payload.form && typeof payload.form === 'object') return payload.form
  if (payload.need && typeof payload.need === 'object') return payload.need
  if (payload.rentalNeed && typeof payload.rentalNeed === 'object') return payload.rentalNeed
  return {}
}

function firstFilled(key, latest, previous) {
  return hasValue(latest[key]) ? latest[key] : (previous[key] || '')
}

function latestHasNonRadiusLocation(latestNeed = {}) {
  return latestNeed.searchMode !== 'radius_around_place' &&
    (hasValue(latestNeed.area) || hasValue(latestNeed.community))
}

function mergeRentalNeed(previousNeed = {}, latestNeed = {}) {
  const previousHard = previousNeed.hardConstraints || {}
  const latestHard = latestNeed.hardConstraints || {}
  const previousPreferences = previousNeed.preferences || {}
  const latestPreferences = latestNeed.preferences || {}
  const hardFeatures = unique((previousHard.features || []).concat(latestHard.features || []))
  const preferenceFeatures = unique((previousPreferences.features || [])
    .concat(latestPreferences.features || [])
    .filter((item) => hardFeatures.indexOf(item) === -1))
  const allFeatures = unique((previousNeed.features || [])
    .concat(latestNeed.features || [])
    .concat(hardFeatures)
    .concat(preferenceFeatures))
  const latestRadius = latestNeed.searchMode === 'radius_around_place'
  const resetRadius = latestHasNonRadiusLocation(latestNeed)
  const resetLocation = latestRadius || resetRadius

  const need = {
    budget: firstFilled('budget', latestNeed, previousNeed),
    budgetText: firstFilled('budgetText', latestNeed, previousNeed),
    minBudget: firstFilled('minBudget', latestNeed, previousNeed) || latestHard.minBudget || previousHard.minBudget || '',
    maxBudget: firstFilled('maxBudget', latestNeed, previousNeed) || latestHard.maxBudget || previousHard.maxBudget || '',
    area: resetLocation ? (latestNeed.area || '') : firstFilled('area', latestNeed, previousNeed),
    community: resetLocation ? (latestRadius ? '' : (latestNeed.community || '')) : firstFilled('community', latestNeed, previousNeed),
    searchMode: resetRadius ? '' : firstFilled('searchMode', latestNeed, previousNeed),
    anchorName: resetRadius ? '' : firstFilled('anchorName', latestNeed, previousNeed),
    anchorRole: resetRadius ? '' : firstFilled('anchorRole', latestNeed, previousNeed),
    radiusKm: resetRadius ? '' : firstFilled('radiusKm', latestNeed, previousNeed),
    preferredAreas: resetRadius ? [] : (hasValue(latestNeed.preferredAreas) ? latestNeed.preferredAreas : (previousNeed.preferredAreas || [])),
    rentMode: firstFilled('rentMode', latestNeed, previousNeed),
    layout: firstFilled('layout', latestNeed, previousNeed),
    features: allFeatures
  }

  need.hardConstraints = {
    minBudget: need.minBudget || latestHard.minBudget || previousHard.minBudget || '',
    maxBudget: need.maxBudget || latestHard.maxBudget || previousHard.maxBudget || '',
    area: need.searchMode === 'radius_around_place' ? '' : (need.area || ''),
    community: need.searchMode === 'radius_around_place' ? '' : (need.community || ''),
    rentMode: need.rentMode || '',
    layout: need.layout || '',
    features: hardFeatures
  }
  need.preferences = {
    budgetTolerance: latestPreferences.budgetTolerance || previousPreferences.budgetTolerance || '',
    features: preferenceFeatures
  }
  return need
}

function requiredCoreCount(need = {}) {
  return [
    Boolean(need.maxBudget || need.minBudget || need.budget),
    Boolean(need.area || need.community || need.anchorName),
    Boolean(need.layout || need.rentMode)
  ].filter(Boolean).length
}

function buildFollowUpQuestion(need = {}) {
  if (requiredCoreCount(need) >= 2) return ''
  if (matchService._internal && typeof matchService._internal.buildFollowUpQuestion === 'function') {
    return matchService._internal.buildFollowUpQuestion(need)
  }
  if (!need.maxBudget && !need.minBudget && !need.budget) return '预算大概多少？'
  if (!need.area && !need.community && !need.anchorName) return '想看哪个区域、小区或地点周边？'
  if (!need.layout && !need.rentMode) return '客户想要几室或单间？'
  return ''
}

function buildNeedSummary(need = {}) {
  return [
    need.budgetText || (need.maxBudget ? `${need.maxBudget}以内` : ''),
    need.searchMode === 'radius_around_place'
      ? [need.anchorName, need.radiusKm ? `${need.radiusKm}公里内` : '附近'].filter(Boolean).join('')
      : (need.community || need.area),
    [need.rentMode, need.layout].filter(Boolean).join(''),
    (need.features || []).slice(0, 2).join('、')
  ].filter(Boolean).join('，')
}

function buildMatchReply(groups = {}) {
  if (groups.reply) return groups.reply
  const exactCount = (groups.exactListings || []).length
  const nearbyCount = (groups.nearbyListings || []).length
  if (exactCount && nearbyCount) {
    return `找到${exactCount}套符合要求，另有${nearbyCount}套接近房源，差异已标出。`
  }
  if (exactCount) return `找到${exactCount}套符合要求，已按本地规则排序。`
  if (nearbyCount) return `没有完全符合的，先看${nearbyCount}套接近房源，差异已标出。`
  return '暂未找到合适房源，建议放宽预算、区域或户型。'
}

async function sanitizeInputNode(state) {
  const rawPayload = state.payload || {}
  const payload = scrubDeep(rawPayload)
  const text = scrubSensitiveText([
    payload.text,
    payload.message,
    payload.content
  ].filter(Boolean).join('，'))
  const voiceText = scrubSensitiveText(payload.voiceText || '')
  return {
    rawPayload,
    payload,
    sanitizedText: text,
    sanitizedVoiceText: voiceText
  }
}

async function intentRouterNode(state) {
  const routed = routeIntent(state.payload || {}, [
    state.normalizedText || state.sanitizedText,
    state.normalizedVoiceText || state.sanitizedVoiceText
  ].filter(Boolean).join('，'), {
    previousNeed: state.previousNeed || {}
  })
  return {
    intent: routed.intent,
    intentTopic: routed.topic
  }
}

async function normalizeAsrNode(state) {
  const candidates = getCandidates(state.db)
  const extraTerms = placeNames(state.db || {}, candidates)
  const vocabulary = matchService._internal && typeof matchService._internal.asrVocabularyFromCandidates === 'function'
    ? matchService._internal.asrVocabularyFromCandidates(candidates, extraTerms)
    : extraTerms
  const normalizedText = normalizeAsrText(state.sanitizedText || '', { vocabulary })
  const normalizedVoiceText = normalizeAsrText(state.sanitizedVoiceText || '', { vocabulary })
  return {
    candidates,
    normalizedText,
    normalizedVoiceText,
    sanitizedText: normalizedText || state.sanitizedText,
    sanitizedVoiceText: normalizedVoiceText || state.sanitizedVoiceText
  }
}

async function mergeRentalNeedNode(state) {
  const candidates = state.candidates && state.candidates.length ? state.candidates : getCandidates(state.db)
  const rawPayload = state.rawPayload || {}
  const latestNeed = state.validatedNeed && Object.keys(state.validatedNeed).length
    ? state.validatedNeed
    : matchService.parseNeed({
      text: rawPayload.text || rawPayload.message || rawPayload.content || state.sanitizedText,
      voiceText: rawPayload.voiceText || state.sanitizedVoiceText,
      form: getFormPayload(state.payload)
    }, candidates, { db: state.db })
  const need = mergeRentalNeed(state.previousNeed || {}, latestNeed)
  return {
    candidates,
    need,
    hardConstraints: need.hardConstraints,
    preferences: need.preferences
  }
}

async function llmNeedParserNode(state) {
  const candidates = getCandidates(state.db)
  const rawPayload = state.rawPayload || {}
  const ruleParsedNeed = matchService.parseNeed({
    text: rawPayload.text || rawPayload.message || rawPayload.content || state.sanitizedText,
    voiceText: rawPayload.voiceText || state.sanitizedVoiceText,
    form: getFormPayload(state.payload)
  }, candidates, { db: state.db })
  const parsed = await parseRentalNeedWithLlm({
    ...state,
    candidates
  }, ruleParsedNeed)
  return {
    candidates,
    ruleParsedNeed,
    llmParsedNeed: parsed.llmParsedNeed || {},
    needParserMode: parsed.needParserMode || 'local-rule',
    needParserWarnings: parsed.needParserWarnings || []
  }
}

async function ruleNeedValidatorNode(state) {
  const result = validateRentalNeed({
    ruleNeed: state.ruleParsedNeed || {},
    llmNeed: state.llmParsedNeed || {},
    state
  })
  return {
    validatedNeed: result.validatedNeed,
    needValidation: result.needValidation,
    needParserWarnings: unique((state.needParserWarnings || []).concat(result.needValidation.warnings || []))
  }
}

async function checkRequiredFieldsNode(state) {
  if (state.nextQuestion) {
    return {
      readyToMatch: false
    }
  }
  const nextQuestion = buildFollowUpQuestion(state.need)
  return {
    nextQuestion,
    readyToMatch: !nextQuestion
  }
}

async function confidenceGateNode(state) {
  const gate = evaluateConfidence(state.need || {})
  return {
    confidence: gate.confidence,
    confidenceReasons: gate.reasons,
    nextQuestion: gate.nextQuestion || state.nextQuestion || '',
    readyToMatch: gate.readyToContinue
  }
}

async function askFollowupNode(state) {
  const summary = buildNeedSummary(state.need)
  return {
    exactListings: [],
    nearbyListings: [],
    listings: [],
    reply: summary
      ? `我先记下：${summary}。${state.nextQuestion}`
      : state.nextQuestion
  }
}

async function toolPlannerNode(state) {
  const need = state.need || {}
  const hasCommunity = Boolean(need.community || (need.hardConstraints && need.hardConstraints.community))
  const searchType = need.searchMode === 'radius_around_place'
    ? 'radius_around_place'
    : (hasCommunity ? 'community_or_adjacent' : 'standard')
  return {
    toolPlan: {
      searchType,
      requiresGeo: searchType === 'radius_around_place' || searchType === 'community_or_adjacent',
      anchorName: need.anchorName || '',
      community: need.community || (need.hardConstraints && need.hardConstraints.community) || '',
      radiusKm: need.radiusKm || ''
    }
  }
}

async function listingSearchToolNode(state) {
  const candidates = state.candidates && state.candidates.length ? state.candidates : getCandidates(state.db)
  return {
    candidates,
    listingSearchResult: {
      source: 'domain.filterListings',
      candidateCount: candidates.length,
      searchType: state.toolPlan && state.toolPlan.searchType
    }
  }
}

async function geoPlaceToolNode(state) {
  const plan = state.toolPlan || {}
  const candidates = state.candidates || []
  const query = plan.searchType === 'radius_around_place'
    ? plan.anchorName
    : (plan.searchType === 'community_or_adjacent' ? plan.community : '')
  if (!query) {
    return {
      geoResult: null
    }
  }
  const resolution = resolvePlace(state.db || {}, query, candidates)
  return {
    geoResult: resolution,
    placeResolution: resolution
  }
}

async function rankingToolNode(state) {
  const groups = matchService._internal && typeof matchService._internal.groupListings === 'function'
    ? matchService._internal.groupListings(state.candidates || [], state.need, { db: state.db })
    : matchService.buildLocalMatch(state.db || {}, { confirmed: true, form: state.need })
  return {
    exactListings: groups.exactListings || [],
    nearbyListings: groups.nearbyListings || [],
    listings: groups.listings || [],
    nextQuestion: groups.nextQuestion || '',
    placeResolution: groups.placeResolution || null,
    reply: buildMatchReply(groups),
    rankingResult: {
      exactCount: (groups.exactListings || []).length,
      nearbyCount: (groups.nearbyListings || []).length,
      listingCount: (groups.listings || []).length,
      hasFollowUp: Boolean(groups.nextQuestion),
      searchType: state.toolPlan && state.toolPlan.searchType
    }
  }
}

async function businessFaqNode(state) {
  const faq = buildBusinessFaq(state.intentTopic)
  return {
    reply: faq.reply,
    nextQuestion: faq.nextQuestion,
    intentTopic: faq.topic,
    exactListings: [],
    nearbyListings: [],
    listings: []
  }
}

async function llmReplyNode(state) {
  return generateControlledReply(state)
}

async function traceLoggerNode() {
  return {}
}

async function outputGuardNode(state) {
  const exactListings = safeListings(state.exactListings || [])
  const nearbyListings = safeListings(state.nearbyListings || [])
  const listings = safeListings((state.listings && state.listings.length)
    ? state.listings
    : exactListings.concat(nearbyListings))
  const guardedOutput = {
    reply: scrubSensitiveText(state.reply || ''),
    nextQuestion: scrubSensitiveText(state.nextQuestion || ''),
    need: safeNeed(state.need || state.previousNeed || {}),
    placeResolution: safePlaceResolution(state.placeResolution),
    listings,
    exactListings,
    nearbyListings
  }
  return {
    guardedOutput,
    reply: guardedOutput.reply,
    nextQuestion: guardedOutput.nextQuestion,
    listings,
    exactListings,
    nearbyListings,
    placeResolution: guardedOutput.placeResolution
  }
}

async function generateReplyNode(state) {
  const guarded = state.guardedOutput || {}
  const exactListings = guarded.exactListings || safeListings(state.exactListings || [])
  const nearbyListings = guarded.nearbyListings || safeListings(state.nearbyListings || [])
  const listings = guarded.listings || safeListings((state.listings && state.listings.length)
    ? state.listings
    : exactListings.concat(nearbyListings))
  return {
    response: {
      threadId: state.threadId,
      reply: guarded.reply || scrubSensitiveText(state.reply || ''),
      nextQuestion: guarded.nextQuestion || scrubSensitiveText(state.nextQuestion || ''),
      intent: state.intent || 'fallback',
      confidence: state.confidence || '',
      confidenceReasons: state.confidenceReasons || [],
      need: guarded.need || safeNeed(state.need || state.previousNeed || {}),
      placeResolution: guarded.placeResolution || safePlaceResolution(state.placeResolution),
      listings,
      exactListings,
      nearbyListings,
      needParserMode: state.needParserMode || 'local-rule',
      needParserWarnings: state.needParserWarnings || [],
      replyMode: state.replyMode || 'local',
      llmWarning: state.llmWarning || '',
      mode: MODE
    }
  }
}

const assistantGraph = createLangGraph({
  start: 'sanitize_input',
  nodes: {
    sanitize_input: sanitizeInputNode,
    normalize_asr: normalizeAsrNode,
    intent_router: intentRouterNode,
    llm_need_parser: llmNeedParserNode,
    rule_need_validator: ruleNeedValidatorNode,
    merge_rental_need: mergeRentalNeedNode,
    confidence_gate: confidenceGateNode,
    check_required_fields: checkRequiredFieldsNode,
    ask_followup: askFollowupNode,
    tool_planner: toolPlannerNode,
    listing_search_tool: listingSearchToolNode,
    geo_place_tool: geoPlaceToolNode,
    ranking_tool: rankingToolNode,
    business_faq: businessFaqNode,
    llm_reply_writer: llmReplyNode,
    output_guard: outputGuardNode,
    generate_reply: generateReplyNode,
    trace_logger: traceLoggerNode
  },
  edges: {
    sanitize_input: 'normalize_asr',
    normalize_asr: 'intent_router',
    intent_router: (state) => state.intent === 'rental_match' ? 'llm_need_parser' : 'business_faq',
    llm_need_parser: 'rule_need_validator',
    rule_need_validator: 'merge_rental_need',
    merge_rental_need: 'confidence_gate',
    confidence_gate: 'check_required_fields',
    check_required_fields: (state) => state.readyToMatch ? 'tool_planner' : 'ask_followup',
    tool_planner: 'listing_search_tool',
    listing_search_tool: 'geo_place_tool',
    geo_place_tool: 'ranking_tool',
    ask_followup: 'llm_reply_writer',
    ranking_tool: 'llm_reply_writer',
    business_faq: 'llm_reply_writer',
    llm_reply_writer: 'output_guard',
    output_guard: 'generate_reply',
    generate_reply: 'trace_logger',
    trace_logger: '__end__'
  }
})

async function runAssistantGraph(db, payload = {}, context = {}) {
  const state = await assistantGraph.run({
    db,
    payload,
    threadId: context.threadId,
    previousNeed: context.previousNeed || {}
  })
  const includeTrace = Boolean(context.debugTrace || payload.debugTrace)
  const response = {
    ...(state.response || {})
  }
  if (includeTrace) response.traceSummary = state.traceSummary || null
  return {
    response,
    need: state.intent === 'rental_match' ? safeNeed(state.need || {}) : context.previousNeed || {},
    trace: state.trace,
    traceSummary: state.traceSummary || null,
    traceDetails: state.structuredTrace || null
  }
}

module.exports = {
  runAssistantGraph,
  MODE,
  _internal: {
    mergeRentalNeed,
    latestHasNonRadiusLocation,
    normalizeAsrNode,
    llmNeedParserNode,
    ruleNeedValidatorNode,
    toolPlannerNode,
    listingSearchToolNode,
    geoPlaceToolNode,
    rankingToolNode,
    outputGuardNode,
    traceLoggerNode,
    confidenceGateNode,
    buildFollowUpQuestion,
    requiredCoreCount
  }
}
