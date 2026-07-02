const { Annotation, END, START, StateGraph } = require('@langchain/langgraph')
const { createTrace, appendTrace, summarizeTrace } = require('./trace-logger')

function replaceReducer(_oldValue, nextValue) {
  return nextValue
}

function createAssistantStateAnnotation() {
  const replace = { reducer: replaceReducer, default: () => undefined }
  const arrayReplace = { reducer: replaceReducer, default: () => [] }
  const objectReplace = { reducer: replaceReducer, default: () => ({}) }

  return Annotation.Root({
    db: Annotation(objectReplace),
    payload: Annotation(objectReplace),
    threadId: Annotation(replace),
    previousNeed: Annotation(objectReplace),
    rawPayload: Annotation(objectReplace),
    sanitizedText: Annotation(replace),
    sanitizedVoiceText: Annotation(replace),
    normalizedText: Annotation(replace),
    normalizedVoiceText: Annotation(replace),
    intent: Annotation(replace),
    intentTopic: Annotation(replace),
    candidates: Annotation(arrayReplace),
    ruleParsedNeed: Annotation(objectReplace),
    llmParsedNeed: Annotation(objectReplace),
    validatedNeed: Annotation(objectReplace),
    needParserMode: Annotation(replace),
    needParserWarnings: Annotation(arrayReplace),
    needValidation: Annotation(objectReplace),
    toolPlan: Annotation(objectReplace),
    listingSearchResult: Annotation(objectReplace),
    geoResult: Annotation(replace),
    rankingResult: Annotation(objectReplace),
    guardedOutput: Annotation(objectReplace),
    need: Annotation(objectReplace),
    hardConstraints: Annotation(objectReplace),
    preferences: Annotation(objectReplace),
    confidence: Annotation(replace),
    confidenceReasons: Annotation(arrayReplace),
    nextQuestion: Annotation(replace),
    readyToMatch: Annotation(replace),
    exactListings: Annotation(arrayReplace),
    nearbyListings: Annotation(arrayReplace),
    listings: Annotation(arrayReplace),
    reply: Annotation(replace),
    replyMode: Annotation(replace),
    llmWarning: Annotation(replace),
    placeResolution: Annotation(replace),
    response: Annotation(replace),
    structuredTrace: Annotation(replace),
    traceSummary: Annotation(replace),
    trace: Annotation({
      reducer: (oldValue, nextValue) => (oldValue || []).concat(nextValue || []),
      default: () => []
    })
  })
}

function endName(end) {
  return end || '__end__'
}

function langGraphTarget(target, end) {
  return target === endName(end) ? END : target
}

function countItems(value) {
  return Array.isArray(value) ? value.length : 0
}

function compactListing(listing = {}) {
  return {
    id: listing.id,
    community: listing.community || listing.shortTitle || '',
    area: listing.area || listing.district || '',
    rent: listing.rent,
    layout: listing.layout || listing.room || '',
    rentMode: listing.rentMode || listing.type || '',
    distanceText: listing.distanceText || '',
    matchReason: listing.matchReason || '',
    differenceText: listing.differenceText || '',
    matchGroup: listing.matchGroup || '',
    relevancePercent: listing.relevancePercent
  }
}

function compactListings(listings = []) {
  const items = Array.isArray(listings) ? listings : []
  return {
    count: items.length,
    sample: items.slice(0, 3).map(compactListing)
  }
}

function compactPlaceResolution(placeResolution) {
  if (!placeResolution || typeof placeResolution !== 'object') return placeResolution || null
  return {
    status: placeResolution.status || '',
    query: placeResolution.query || placeResolution.name || '',
    name: placeResolution.name || '',
    area: placeResolution.area || '',
    block: placeResolution.block || '',
    type: placeResolution.type || '',
    coordinateVerified: placeResolution.coordinateVerified,
    candidateCount: countItems(placeResolution.candidates),
    candidates: Array.isArray(placeResolution.candidates)
      ? placeResolution.candidates.slice(0, 3).map((candidate) => ({
        name: candidate.name || '',
        area: candidate.area || '',
        block: candidate.block || '',
        type: candidate.type || '',
        coordinateVerified: candidate.coordinateVerified
      }))
      : []
  }
}

function compactResponse(response) {
  if (!response || typeof response !== 'object') return response || null
  return {
    threadId: response.threadId,
    intent: response.intent,
    confidence: response.confidence,
    confidenceReasons: response.confidenceReasons || [],
    nextQuestion: response.nextQuestion || '',
    reply: response.reply || '',
    need: response.need || {},
    placeResolution: compactPlaceResolution(response.placeResolution),
    listings: compactListings(response.listings || []),
    exactListings: compactListings(response.exactListings || []),
    nearbyListings: compactListings(response.nearbyListings || []),
    mode: response.mode
  }
}

function buildNodeInputSummary(name, state = {}) {
  return {
    node: name,
    threadId: state.threadId,
    text: state.sanitizedText || '',
    voiceText: state.sanitizedVoiceText || '',
    normalizedText: state.normalizedText || '',
    normalizedVoiceText: state.normalizedVoiceText || '',
    intent: state.intent,
    intentTopic: state.intentTopic,
    ruleParsedNeed: state.ruleParsedNeed || {},
    llmParsedNeed: state.llmParsedNeed || {},
    validatedNeed: state.validatedNeed || {},
    needParserMode: state.needParserMode,
    needParserWarnings: state.needParserWarnings || [],
    needValidation: state.needValidation || {},
    toolPlan: state.toolPlan || {},
    listingSearchResult: state.listingSearchResult || {},
    geoResult: compactPlaceResolution(state.geoResult),
    rankingResult: state.rankingResult || {},
    guardedOutput: state.guardedOutput || {},
    need: state.need || {},
    hardConstraints: state.hardConstraints || {},
    preferences: state.preferences || {},
    confidence: state.confidence,
    confidenceReasons: state.confidenceReasons || [],
    nextQuestion: state.nextQuestion || '',
    readyToMatch: state.readyToMatch,
    replyMode: state.replyMode,
    llmWarning: state.llmWarning,
    placeResolution: compactPlaceResolution(state.placeResolution),
    counts: {
      candidates: countItems(state.candidates),
      exactListings: countItems(state.exactListings),
      nearbyListings: countItems(state.nearbyListings),
      listings: countItems(state.listings)
    }
  }
}

function buildNodeOutputSummary(name, partial = {}) {
  const output = partial || {}
  return {
    node: name,
    changedFields: Object.keys(output),
    normalizedText: output.normalizedText,
    normalizedVoiceText: output.normalizedVoiceText,
    intent: output.intent,
    intentTopic: output.intentTopic,
    ruleParsedNeed: output.ruleParsedNeed,
    llmParsedNeed: output.llmParsedNeed,
    validatedNeed: output.validatedNeed,
    needParserMode: output.needParserMode,
    needParserWarnings: output.needParserWarnings,
    needValidation: output.needValidation,
    toolPlan: output.toolPlan,
    listingSearchResult: output.listingSearchResult,
    geoResult: compactPlaceResolution(output.geoResult),
    rankingResult: output.rankingResult,
    guardedOutput: output.guardedOutput,
    need: output.need,
    hardConstraints: output.hardConstraints,
    preferences: output.preferences,
    confidence: output.confidence,
    confidenceReasons: output.confidenceReasons,
    nextQuestion: output.nextQuestion,
    readyToMatch: output.readyToMatch,
    reply: output.reply,
    replyMode: output.replyMode,
    llmWarning: output.llmWarning,
    placeResolution: compactPlaceResolution(output.placeResolution),
    listings: compactListings(output.listings || []),
    exactListings: compactListings(output.exactListings || []),
    nearbyListings: compactListings(output.nearbyListings || []),
    response: compactResponse(output.response)
  }
}

function createInitialTrace(initialState = {}) {
  return createTrace({
    threadId: initialState.threadId || '',
    graph: 'assistant-langgraph',
    source: 'mini-program-assistant'
  })
}

function wrapNode(name, node) {
  return async function runAssistantNode(state) {
    const previousTrace = state.structuredTrace || createInitialTrace(state)
    const partial = await node(state)
    const structuredTrace = appendTrace(
      previousTrace,
      name,
      buildNodeInputSummary(name, state),
      buildNodeOutputSummary(name, partial)
    )
    const nodeTrace = partial && Array.isArray(partial.trace) ? partial.trace : []
    return {
      ...(partial || {}),
      trace: nodeTrace.concat(name),
      structuredTrace,
      traceSummary: summarizeTrace(structuredTrace)
    }
  }
}

function createLangGraph(config = {}) {
  const nodes = config.nodes || {}
  const edges = config.edges || {}
  const start = config.start
  const end = config.end || '__end__'
  const graph = new StateGraph(createAssistantStateAnnotation())

  Object.keys(nodes).forEach((name) => {
    graph.addNode(name, wrapNode(name, nodes[name]))
  })

  graph.addEdge(START, start)

  Object.keys(edges).forEach((source) => {
    const edge = edges[source]
    if (typeof edge === 'function') {
      graph.addConditionalEdges(source, (state) => langGraphTarget(edge(state), end))
      return
    }
    graph.addEdge(source, langGraphTarget(edge, end))
  })

  const compiled = graph.compile()

  async function run(initialState = {}) {
    return compiled.invoke({
      ...initialState,
      structuredTrace: initialState.structuredTrace || createInitialTrace(initialState),
      traceSummary: undefined,
      trace: []
    })
  }

  return { run, graph: compiled }
}

module.exports = {
  createLangGraph,
  createLocalGraph: createLangGraph,
  _internal: {
    createAssistantStateAnnotation,
    langGraphTarget,
    buildNodeInputSummary,
    buildNodeOutputSummary
  }
}
