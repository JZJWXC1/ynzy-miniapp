const TRACE_VERSION = 'assistant-trace-v1'
const MAX_TEXT_LENGTH = 160
const MAX_ARRAY_ITEMS = 3
const MAX_OBJECT_KEYS = 16

const SENSITIVE_KEYS = new Set([
  'address',
  'fullAddress',
  'detailAddress',
  'building',
  'buildingNo',
  'buildingNumber',
  'unit',
  'unitNo',
  'unitNumber',
  'roomNo',
  'roomNumber',
  'houseNo',
  'doorNo',
  'contact',
  'contactPhone',
  'phone',
  'mobile',
  'customerPhone',
  'tenantPhone',
  'landlordPhone',
  'ownerPhone',
  'wechat',
  'wechatId',
  'wx',
  'vx',
  'idCard',
  'identityNo',
  'videoUrl',
  'videoKey',
  'videoSignedUrl',
  'signedUrl',
  'shareUrl'
])

function nowIso() {
  return new Date().toISOString()
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function truncateText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value || '').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...`
}

function scrubUrlSignatureParams(text) {
  return text
    .replace(/\b(?:Signature|OSSAccessKeyId|Expires|security-token|SecurityToken)=[^&\s"'<>，。；;]+/ig, '[签名参数已隐藏]')
    .replace(/\bx-oss-[^=\s&]+=[^&\s"'<>，。；;]+/ig, '[签名参数已隐藏]')
}

function scrubSensitiveText(value) {
  return truncateText(scrubUrlSignatureParams(String(value || ''))
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, '[身份证号已隐藏]')
    .replace(/1[3-9](?:[\s-]?\d){9}/g, '[手机号已隐藏]')
    .replace(/\b0\d{2,3}[-\s]?\d{7,8}\b/g, '[电话已隐藏]')
    .replace(/\b400[-\s]?\d{3}[-\s]?\d{4}\b/g, '[电话已隐藏]')
    .replace(/\bwxid_[A-Za-z0-9_-]{5,}\b/ig, '[微信号已隐藏]')
    .replace(/(?:微信号?|微信|VX|V信|weixin|wechat)[:：\s]*[A-Za-z][A-Za-z0-9_-]{4,19}/ig, '[微信号已隐藏]')
    .replace(/(?:房号|门牌|房间|室号)[:：\s]*[A-Za-z0-9-]{2,12}/g, '[房号已隐藏]')
    .replace(/(^|[^\d])\d{1,3}[-－]\d{1,3}[-－]\d{2,4}(?!\d)/g, '$1[房号已隐藏]')
    .replace(/\d{1,3}(?:幢|栋|号楼|楼)\s*(?:\d{1,3})?(?:单元)?\s*[A-Za-z0-9一二三四五六七八九十零〇百]{1,8}(?:室|房|房号)?/g, '[房号已隐藏]')
    .replace(/\d{2,5}(?:室|房号)/g, '[房号已隐藏]'))
}

function summarizeArray(value, depth) {
  return {
    type: 'array',
    length: value.length,
    sample: value.slice(0, MAX_ARRAY_ITEMS).map((item) => summarizeValue(item, depth + 1))
  }
}

function summarizeObject(value, depth) {
  const result = {}
  const allKeys = Object.keys(value).filter((key) => value[key] !== undefined)
  const keys = allKeys.slice(0, MAX_OBJECT_KEYS)
  keys.forEach((key) => {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = '[敏感字段已隐藏]'
      return
    }
    result[key] = summarizeValue(value[key], depth + 1)
  })

  const omitted = allKeys.length - keys.length
  if (omitted > 0) result._omittedKeys = omitted
  return result
}

function summarizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubSensitiveText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return summarizeArray(value, depth)
  if (isPlainObject(value)) {
    if (depth >= 4) return '[对象摘要已截断]'
    return summarizeObject(value, depth)
  }
  return scrubSensitiveText(String(value))
}

function createTrace(meta = {}) {
  return {
    version: TRACE_VERSION,
    createdAt: nowIso(),
    meta: summarizeValue(meta),
    events: []
  }
}

function appendTrace(trace, node, input, output) {
  const base = trace && typeof trace === 'object' ? trace : createTrace()
  const events = Array.isArray(base.events) ? base.events : []
  const event = {
    index: events.length,
    node: scrubSensitiveText(node || 'unknown_node'),
    timestamp: nowIso(),
    inputSummary: summarizeValue(input),
    outputSummary: summarizeValue(output)
  }

  return {
    ...base,
    events: events.concat(event)
  }
}

function hasAuditValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return true
}

function valueAtPath(source, path) {
  const keys = String(path || '').split('.').filter(Boolean)
  let value = source
  for (const key of keys) {
    if (!value || typeof value !== 'object') return undefined
    value = value[key]
  }
  return value
}

function lastTraceValue(events, paths) {
  const keys = Array.isArray(paths) ? paths : [paths]
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] || {}
    for (const side of ['outputSummary', 'inputSummary']) {
      for (const path of keys) {
        const value = valueAtPath(event[side], path)
        if (hasAuditValue(value)) return value
      }
    }
  }
  return undefined
}

function traceEventValue(events, node, paths, side = 'outputSummary') {
  const keys = Array.isArray(paths) ? paths : [paths]
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] || {}
    if (event.node !== node) continue
    for (const path of keys) {
      const value = valueAtPath(event[side], path)
      if (hasAuditValue(value)) return value
    }
  }
  return undefined
}

function buildTraceAudit(events, nodes) {
  const finalReply = lastTraceValue(events, ['response.reply', 'guardedOutput.reply', 'reply'])
  const nextQuestion = lastTraceValue(events, ['response.nextQuestion', 'guardedOutput.nextQuestion', 'nextQuestion'])
  const readyToMatch = lastTraceValue(events, ['readyToMatch', 'response.readyToMatch'])
  const shouldAskFollowUp = Boolean(nextQuestion) || nodes.indexOf('ask_followup') !== -1 || readyToMatch === false
  const toolPlan = traceEventValue(events, 'tool_planner', 'toolPlan') || lastTraceValue(events, 'toolPlan')
  const listingSearchResult = traceEventValue(events, 'listing_search_tool', 'listingSearchResult')
  const geoResult = traceEventValue(events, 'geo_place_tool', ['geoResult', 'placeResolution'])
  const rankingResult = traceEventValue(events, 'ranking_tool', 'rankingResult')

  return summarizeValue({
    intent: lastTraceValue(events, ['response.intent', 'intent']),
    slots: lastTraceValue(events, ['response.need', 'need', 'validatedNeed', 'llmParsedNeed', 'ruleParsedNeed']),
    parser: {
      mode: lastTraceValue(events, ['response.needParserMode', 'needParserMode']),
      warnings: lastTraceValue(events, ['response.needParserWarnings', 'needParserWarnings'])
    },
    toolInput: {
      toolPlan,
      placeQuery: toolPlan && (toolPlan.anchorName || toolPlan.community || ''),
      searchType: toolPlan && toolPlan.searchType
    },
    toolOutput: {
      listingSearchResult,
      placeResolution: lastTraceValue(events, ['response.placeResolution', 'placeResolution']) || geoResult,
      rankingResult,
      listings: lastTraceValue(events, ['response.listings', 'listings']),
      exactListings: lastTraceValue(events, ['response.exactListings', 'exactListings']),
      nearbyListings: lastTraceValue(events, ['response.nearbyListings', 'nearbyListings'])
    },
    finalReply,
    nextQuestion,
    shouldAskFollowUp,
    replyMode: lastTraceValue(events, ['response.replyMode', 'replyMode']),
    llmWarning: lastTraceValue(events, ['response.llmWarning', 'llmWarning'])
  })
}

function summarizeTrace(trace) {
  const events = Array.isArray(trace && trace.events) ? trace.events : []
  const nodes = events.map((event) => event.node)
  return {
    version: trace && trace.version ? trace.version : TRACE_VERSION,
    eventCount: events.length,
    startedAt: events[0] ? events[0].timestamp : (trace && trace.createdAt) || '',
    endedAt: events[events.length - 1] ? events[events.length - 1].timestamp : '',
    nodes,
    timeline: nodes.join(' -> '),
    readable: events.length ? `执行了${events.length}个节点：${nodes.join(' -> ')}` : '暂无 trace 节点',
    audit: buildTraceAudit(events, nodes),
    steps: events.map((event) => ({
      index: event.index,
      node: event.node,
      inputSummary: event.inputSummary,
      outputSummary: event.outputSummary
    }))
  }
}

module.exports = {
  createTrace,
  appendTrace,
  summarizeTrace,
  _internal: {
    scrubSensitiveText,
    summarizeValue,
    SENSITIVE_KEYS
  }
}
