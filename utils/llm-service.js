const apiClient = require('./api-client')
const { getRuntimeConfig, shouldUseMock } = require('./api-config')
const dataCenter = require('./mock-data')
const listingDisplay = require('./listing-display')
const {
  NO_FEATURE,
  LISTING_FEATURE_OPTIONS,
  parseFeatureInput
} = require('./listing-features')

const MAX_RECOMMEND_COUNT = 5
const LLM_MATCH_TIMEOUT_MS = 60000
const AREA_WORDS = ['钱江新城', '上城区', '拱墅区', '西湖区', '滨江区', '萧山区', '余杭区', '临平区', '钱塘区', '上城', '拱墅', '西湖', '滨江', '萧山', '余杭', '临平', '钱塘', '西兴', '长河', '浦沿', '东新园', '建设路']
const CONFIRMATION_FIELD_CONFIG = [
  { key: 'budget', label: '预算', emptyText: '待补充' },
  { key: 'location', label: '区域/小区', emptyText: '待补充' },
  { key: 'layout', label: '户型/租法', emptyText: '待补充' },
  { key: 'features', label: '标签/偏好', emptyText: '不限' }
]
const CN_DIGITS = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}
const FEATURE_ALIASES = {
  带阳台: ['带阳台', '阳台'],
  燃气: ['燃气', '天然气', '煤气'],
  近地铁: ['近地铁', '地铁口', '地铁站', '地铁'],
  朝南: ['朝南', '南向'],
  独卫: ['独卫', '独立卫生间', '独立卫浴'],
  电梯: ['电梯'],
  整租: ['整租'],
  合租: ['合租', '单间'],
  免押金: ['免押金', '无押金', '零押金', '押金0', '押金为0']
}

function pickWord(text, words) {
  return words.find((word) => text.indexOf(word) !== -1) || ''
}

function cnDigit(value) {
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value)
  return CN_DIGITS[value] || 0
}

function chineseNumber(value) {
  const text = String(value || '').replace(/[块元左右上下以内以下内]/g, '')
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (text.indexOf('千') !== -1) {
    const parts = text.split('千')
    const left = chineseNumber(parts[0]) || 1
    const right = parts[1] ? chineseNumber(parts[1]) : 0
    return left * 1000 + (parts[1] && parts[1].length === 1 ? cnDigit(parts[1]) * 100 : right)
  }
  if (text.indexOf('百') !== -1) {
    const parts = text.split('百')
    return (chineseNumber(parts[0]) || 1) * 100 + (parts[1] ? chineseNumber(parts[1]) : 0)
  }
  if (text.indexOf('十') !== -1) {
    const parts = text.split('十')
    return (parts[0] ? chineseNumber(parts[0]) : 1) * 10 + (parts[1] ? chineseNumber(parts[1]) : 0)
  }
  return text.length === 1 ? cnDigit(text) : 0
}

function amountValue(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return chineseNumber(text)
}

function scrubDemandSource(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s，。；;]+/ig, '')
    .replace(/(?:Signature|Expires|OSSAccessKeyId|security-token|x-oss-[^=]+)=[^&\s"'，。；;]+/ig, '')
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, '')
    .replace(/(?:客户|租客|房东|联系人)?(?:手机号|手机|电话|联系电话|联系方式|号码)[:：\s]*\+?\d[\d\s-]{6,18}/g, '')
    .replace(/1[3-9](?:[\s-]?\d){9}/g, '')
    .replace(/\b0\d{2,3}[-\s]?\d{7,8}\b/g, '')
    .replace(/\b400[-\s]?\d{3}[-\s]?\d{4}\b/g, '')
    .replace(/\bwxid_[A-Za-z0-9_-]{5,}\b/ig, '')
    .replace(/(?:微信号?|微信|VX|V信|weixin|wechat)[:：\s]*[A-Za-z][A-Za-z0-9_-]{4,19}/ig, '')
    .replace(/(?:\d{1,3}|[一二三四五六七八九十]{1,3})(?:栋|幢|号楼|座)(?:\d{1,3}|[一二三四五六七八九十]{1,3})?(?:单元)?[A-Za-z0-9一二三四五六七八九十-]{0,8}(?:室|房|房号)?/g, '')
    .replace(/(?:房号|门牌|房间|室号)[:：\s]*[A-Za-z0-9-]{2,12}/g, '')
    .replace(/\d{1,3}[-－]\d{1,3}[-－]\d{2,4}/g, '')
    .replace(/\d{2,5}(?:室|房号)/g, '')
    .replace(/\d{1,3}(?:栋|幢|号楼|座|单元)/g, '')
    .replace(/[一二三四五六七八九十]{1,3}(?:栋|幢|号楼|座|单元)/g, '')
}

function parseBudget(source) {
  const text = String(source || '').replace(/\s+/g, '')
  const range = text.match(/(?:预算|租金)?([一二两三四五六七八九十百千万\d.]+)(?:元|块)?(?:到|至|-|~)([一二两三四五六七八九十百千万\d.]+)(?:元|块)?/)
  if (range) {
    return {
      minBudget: amountValue(range[1]),
      maxBudget: amountValue(range[2]),
      budget: String(amountValue(range[2]) || '')
    }
  }
  const budgetBeforeLayout = text.match(/([一二两三四五六七八九十]+千[一二三四五六七八九十]?)(?=[一二两三四五六七八九\d](?:室|房))/)
  if (budgetBeforeLayout) {
    const value = amountValue(budgetBeforeLayout[1])
    return value >= 1000 ? { minBudget: '', maxBudget: value, budget: String(value) } : { minBudget: '', maxBudget: '', budget: '' }
  }
  const matched = text.match(/(?:预算|租金)?(?:大概|约|差不多)?([一二两三四五六七八九十百千万\d.]+)(?:元|块)?(?:以内|以下|内|左右|上下)?/)
  if (!matched) return { minBudget: '', maxBudget: '', budget: '' }
  const value = amountValue(matched[1])
  return value >= 1000 ? { minBudget: '', maxBudget: value, budget: String(value) } : { minBudget: '', maxBudget: '', budget: '' }
}

function parseNeedText(text) {
  const source = scrubDemandSource(text).replace(/\s+/g, '')
  const budget = parseBudget(source)
  const layoutMatch = source.match(/单间|[一二两三四五六七八九\d](?:室|房)/)
  const features = LISTING_FEATURE_OPTIONS
    .filter((feature) => feature !== NO_FEATURE)
    .filter((feature) => (FEATURE_ALIASES[feature] || [feature]).some((word) => source.indexOf(word) !== -1))

  return {
    budget: budget.budget,
    minBudget: budget.minBudget,
    maxBudget: budget.maxBudget,
    area: pickWord(source, AREA_WORDS),
    community: source.indexOf('东新园') !== -1 ? '东新园' : '',
    rentMode: source.indexOf('合租') !== -1 || source.indexOf('单间') !== -1
      ? '合租'
      : (source.indexOf('整租') !== -1 ? '整租' : ''),
    layout: layoutMatch ? layoutMatch[0].replace('房', '室') : '',
    features
  }
}

function numberFrom(value) {
  if (value === undefined || value === null || value === '') return 0
  const direct = Number(value)
  if (Number.isFinite(direct)) return direct
  const matched = String(value).match(/(\d+(?:\.\d+)?)/)
  return matched ? Number(matched[1]) : 0
}

function shouldUseConfirmedFormOnly(payload = {}) {
  return payload.confirmed === true && payload.form && typeof payload.form === 'object'
}

function budgetFromForm(formNeed = {}, textNeed = {}) {
  const parsedFormBudget = parseBudget([formNeed.budget, formNeed.budgetText].filter(Boolean).join('，'))
  const minBudget = numberFrom(formNeed.minBudget) || parsedFormBudget.minBudget || textNeed.minBudget || ''
  const maxBudget = numberFrom(formNeed.maxBudget) ||
    parsedFormBudget.maxBudget ||
    numberFrom(formNeed.budget) ||
    textNeed.maxBudget ||
    textNeed.budget ||
    ''
  return {
    budget: formNeed.budget || parsedFormBudget.budget || textNeed.budget || '',
    minBudget,
    maxBudget
  }
}

function mergeNeed(textNeed, formNeed = {}) {
  const rawFormFeatures = parseFeatureInput(formNeed.features)
  const formFeatures = rawFormFeatures.filter((item) => item !== NO_FEATURE)
  const budget = budgetFromForm(formNeed, textNeed)
  return {
    budget: budget.budget,
    minBudget: budget.minBudget,
    maxBudget: budget.maxBudget,
    area: formNeed.area || textNeed.area || '',
    community: formNeed.community || textNeed.community || '',
    rentMode: formNeed.rentMode || textNeed.rentMode || '',
    layout: formNeed.layout || textNeed.layout || '',
    features: rawFormFeatures.length ? formFeatures : (textNeed.features || [])
  }
}

function needFromPayload(payload = {}) {
  const textNeed = shouldUseConfirmedFormOnly(payload)
    ? {}
    : parseNeedText([payload.text, payload.voiceText].filter(Boolean).join('，'))
  return mergeNeed(textNeed, payload.form || {})
}

function mergeServerNeed(clientNeed, serverNeed, options = {}) {
  const server = serverNeed || {}
  if (options.formOnly) {
    return {
      ...server,
      budget: clientNeed.budget || '',
      budgetText: clientNeed.budgetText || '',
      minBudget: clientNeed.minBudget || '',
      maxBudget: clientNeed.maxBudget || '',
      area: clientNeed.area || '',
      community: clientNeed.community || '',
      rentMode: clientNeed.rentMode || '',
      layout: clientNeed.layout || '',
      features: clientNeed.features || [],
      hardConstraints: hardConstraintsFromNeed(clientNeed),
      preferences: { features: clientNeed.features || [] }
    }
  }
  return {
    ...server,
    budget: server.budget || clientNeed.budget || '',
    budgetText: server.budgetText || clientNeed.budgetText || '',
    minBudget: server.minBudget || clientNeed.minBudget || '',
    maxBudget: server.maxBudget || clientNeed.maxBudget || '',
    area: server.area || clientNeed.area || '',
    community: server.community || clientNeed.community || '',
    rentMode: server.rentMode || clientNeed.rentMode || '',
    layout: server.layout || clientNeed.layout || '',
    features: server.features && server.features.length ? server.features : (clientNeed.features || [])
  }
}

function coreConditionCount(need) {
  return [
    Boolean(need.maxBudget || need.budget),
    Boolean(need.area || need.community),
    Boolean(need.layout || need.rentMode)
  ].filter(Boolean).length
}

function followUpForNeed(need) {
  if (coreConditionCount(need) >= 2) return ''
  if (!need.maxBudget && !need.budget) return '预算大概多少？'
  if (!need.area && !need.community) return '想看哪个区域或小区？'
  if (!need.layout && !need.rentMode) return '客户想要几室或单间？'
  return ''
}

function confirmationFieldValue(need = {}, key) {
  if (key === 'budget') return need.budgetText || (need.maxBudget ? `${need.maxBudget}以内` : '')
  if (key === 'location') return [need.area, need.community].filter(Boolean).join(' · ')
  if (key === 'layout') return [need.rentMode, need.layout].filter(Boolean).join(' · ')
  if (key === 'features') return (need.features || []).join('、')
  return ''
}

function buildConfirmationFields(need = {}) {
  return CONFIRMATION_FIELD_CONFIG.map((field) => {
    const value = confirmationFieldValue(need, field.key)
    return {
      key: field.key,
      label: field.label,
      value: value || field.emptyText,
      filled: Boolean(value)
    }
  })
}

function buildRecognitionReply(followUpQuestion) {
  if (followUpQuestion) return `我先整理了已识别条件，还差一个关键问题：${followUpQuestion}`
  return '请确认这些找房条件，确认后我再匹配本地房源。'
}

function normalizeListing(listing, group) {
  const item = listingDisplay.normalizeListing(listing || {})
  const rent = numberFrom(item.rent || item.price)
  const score = numberFrom(item.relevanceScore || item.relevancePercent || item.matchScore) || 50
  return {
    ...item,
    title: item.community && item.layout ? `${item.community} · ${item.layout}` : (item.community || item.title || '可租房源'),
    cardTitle: item.community && item.layout ? `${item.community} · ${item.layout}` : (item.community || item.title || '可租房源'),
    rent,
    price: rent ? `¥${rent}/月` : item.price,
    matchGroup: item.matchGroup || group || 'exact',
    matchGroupText: item.matchGroupText || (group === 'nearby' ? '接近要求' : '符合要求'),
    matchReason: item.matchReason || (item.relevanceReasons && item.relevanceReasons.join('、')) || '基础条件相近',
    differenceText: item.differenceText || '',
    displayRelevance: item.displayRelevance || `${score}%`
  }
}

function normalizeListings(listings, group) {
  return (listings || []).slice(0, MAX_RECOMMEND_COUNT).map((listing) => normalizeListing(listing, group))
}

function hardConstraintsFromNeed(need) {
  return {
    maxBudget: need.maxBudget || '',
    minBudget: need.minBudget || '',
    area: need.area || '',
    community: need.community || '',
    rentMode: need.rentMode || '',
    layout: need.layout || '',
    features: []
  }
}

function buildReply(need, listings, followUpQuestion) {
  if (followUpQuestion) return followUpQuestion
  if (!listings.length) return '暂未找到合适房源，建议放宽预算、区域或户型。'
  return `先看这${listings.length}套真实房源，已按预算、位置和偏好排序。`
}

function buildLocalMatch(payload) {
  const need = needFromPayload(payload)
  const followUpQuestion = followUpForNeed(need)
  // 本地 Mock/网络兜底同样只能从可信会话派生游客边界，不能接受页面透传的 companyOnly。
  const localMatchNeed = Object.assign({}, need, {
    companyOnly: !apiClient.getAuthToken()
  })
  const rawResult = followUpQuestion ? { listings: [] } : dataCenter.matchListings(localMatchNeed)
  const listings = normalizeListings(rawResult.listings || [], 'exact')
  return {
    need,
    hardConstraints: hardConstraintsFromNeed(need),
    preferences: { features: need.features || [] },
    exactListings: listings,
    nearbyListings: [],
    followUpQuestion,
    listings,
    reply: buildReply(need, listings, followUpQuestion),
    mode: 'client-local-fallback'
  }
}

function buildLocalRecognition(payload) {
  const need = needFromPayload(payload)
  const followUpQuestion = followUpForNeed(need)
  return {
    stage: 'recognize',
    mode: 'client-recognize-v1',
    need,
    hardConstraints: hardConstraintsFromNeed(need),
    preferences: { features: need.features || [] },
    confirmationFields: buildConfirmationFields(need),
    readyToConfirm: !followUpQuestion,
    followUpQuestion,
    exactListings: [],
    nearbyListings: [],
    listings: [],
    reply: buildRecognitionReply(followUpQuestion)
  }
}

function networkWarning(error) {
  return (error && error.message) || '网络请求失败'
}

function shouldUseLocalFallbackAfterError() {
  return shouldUseMock(getRuntimeConfig())
}

function emptyNetworkMatchResult(requestPayload, error, extra) {
  const need = needFromPayload(requestPayload)
  return {
    ...(extra || {}),
    need,
    hardConstraints: hardConstraintsFromNeed(need),
    preferences: { features: need.features || [] },
    exactListings: [],
    nearbyListings: [],
    listings: [],
    reply: '网络连接失败，请点下方按钮重试。',
    followUpQuestion: '',
    nextQuestion: '',
    warning: networkWarning(error),
    networkFailed: true,
    mode: 'server-unavailable'
  }
}

function emptyNetworkRecognitionResult(requestPayload, error) {
  const need = needFromPayload(requestPayload)
  return {
    stage: 'recognize',
    need,
    hardConstraints: hardConstraintsFromNeed(need),
    preferences: { features: need.features || [] },
    confirmationFields: buildConfirmationFields(need),
    readyToConfirm: false,
    followUpQuestion: '',
    exactListings: [],
    nearbyListings: [],
    listings: [],
    reply: '网络连接失败，请补充条件后重试。',
    warning: networkWarning(error),
    networkFailed: true,
    mode: 'server-unavailable'
  }
}

function normalizeServerResult(serverResult, requestPayload) {
  const result = serverResult || {}
  const clientNeed = needFromPayload(requestPayload)
  const useConfirmedFormOnly = shouldUseConfirmedFormOnly(requestPayload)
  const need = mergeServerNeed(clientNeed, result.need || {}, { formOnly: useConfirmedFormOnly })
  const exactListings = normalizeListings(result.exactListings || [], 'exact')
  const nearbyListings = normalizeListings(result.nearbyListings || [], 'nearby')
  const listings = normalizeListings(result.listings && result.listings.length
    ? result.listings
    : exactListings.concat(nearbyListings), '')
  const hardConstraints = useConfirmedFormOnly
    ? hardConstraintsFromNeed(need)
    : (result.hardConstraints || need.hardConstraints || hardConstraintsFromNeed(need))
  const preferences = useConfirmedFormOnly
    ? { features: need.features || [] }
    : (result.preferences || need.preferences || { features: need.features || [] })
  return {
    ...result,
    need,
    hardConstraints,
    preferences,
    exactListings,
    nearbyListings,
    followUpQuestion: result.followUpQuestion || '',
    listings,
    reply: result.reply || buildReply(need, listings, result.followUpQuestion || ''),
    mode: result.mode || 'server-match-v1'
  }
}

function normalizeRecognitionResult(serverResult, requestPayload) {
  const result = serverResult || {}
  const clientNeed = needFromPayload(requestPayload)
  const useConfirmedFormOnly = shouldUseConfirmedFormOnly(requestPayload)
  const need = mergeServerNeed(clientNeed, result.need || {}, { formOnly: useConfirmedFormOnly })
  const followUpQuestion = result.followUpQuestion || followUpForNeed(need)
  const hardConstraints = useConfirmedFormOnly
    ? hardConstraintsFromNeed(need)
    : (result.hardConstraints || hardConstraintsFromNeed(need))
  const preferences = useConfirmedFormOnly
    ? { features: need.features || [] }
    : (result.preferences || { features: need.features || [] })
  return {
    ...result,
    stage: 'recognize',
    need,
    hardConstraints,
    preferences,
    confirmationFields: result.confirmationFields || buildConfirmationFields(need),
    readyToConfirm: result.readyToConfirm !== undefined ? Boolean(result.readyToConfirm) : !followUpQuestion,
    followUpQuestion,
    exactListings: [],
    nearbyListings: [],
    listings: [],
    reply: result.reply || buildRecognitionReply(followUpQuestion),
    mode: result.mode || 'recognize-v1'
  }
}

function recognizeRentalNeed(payload) {
  const requestPayload = Object.assign({}, payload || {}, { stage: 'recognize' })
  const localResult = buildLocalRecognition(requestPayload)
  return apiClient.call({
    path: '/mini/llm/match',
    method: 'POST',
    data: requestPayload,
    timeout: LLM_MATCH_TIMEOUT_MS,
    mock: () => localResult
  }).then((serverResult) => normalizeRecognitionResult(serverResult, requestPayload)).catch((error) => {
    if (shouldUseLocalFallbackAfterError()) {
      return {
        ...localResult,
        warning: networkWarning(error),
        networkFailed: true
      }
    }
    return emptyNetworkRecognitionResult(requestPayload, error)
  })
}

function matchRentalNeed(payload) {
  const requestPayload = Object.assign({}, payload || {}, { stage: 'match', confirmed: true })
  const localResult = buildLocalMatch(requestPayload)
  return apiClient.call({
    path: '/mini/llm/match',
    method: 'POST',
    data: requestPayload,
    timeout: LLM_MATCH_TIMEOUT_MS,
    mock: () => localResult
  }).then((serverResult) => normalizeServerResult(serverResult, requestPayload)).catch((error) => {
    if (shouldUseLocalFallbackAfterError()) {
      return {
        ...localResult,
        warning: networkWarning(error),
        networkFailed: true
      }
    }
    return emptyNetworkMatchResult(requestPayload, error)
  })
}

function normalizeAssistantResult(serverResult, requestPayload, localResult) {
  const result = serverResult || localResult || {}
  const normalized = normalizeServerResult(result, requestPayload)
  return {
    ...result,
    ...normalized,
    threadId: result.threadId || requestPayload.threadId || `LOCAL-AST-${Date.now()}`,
    nextQuestion: result.nextQuestion || result.followUpQuestion || normalized.followUpQuestion || '',
    intent: result.intent || 'rental_match',
    mode: result.mode || 'local-graph-assistant-v1'
  }
}

function chatAssistant(payload) {
  const requestPayload = Object.assign({}, payload || {})
  const localMatch = buildLocalMatch(requestPayload)
  const localResult = {
    ...localMatch,
    threadId: requestPayload.threadId || `LOCAL-AST-${Date.now()}`,
    nextQuestion: localMatch.followUpQuestion || '',
    intent: 'rental_match',
    mode: 'local-graph-assistant-v1'
  }
  return apiClient.call({
    path: '/mini/assistant/chat',
    method: 'POST',
    data: requestPayload,
    timeout: LLM_MATCH_TIMEOUT_MS,
    mock: () => localResult
  }).then((serverResult) => normalizeAssistantResult(serverResult, requestPayload, localResult)).catch((error) => {
    if (shouldUseLocalFallbackAfterError()) {
      return {
        ...normalizeAssistantResult(localResult, requestPayload, localResult),
        warning: networkWarning(error),
        networkFailed: true
      }
    }
    return emptyNetworkMatchResult(requestPayload, error, {
      threadId: requestPayload.threadId || `LOCAL-AST-${Date.now()}`,
      intent: 'rental_match'
    })
  })
}

function submitAssistantFeedback(payload) {
  const requestPayload = Object.assign({}, payload || {})
  return apiClient.call({
    path: '/mini/assistant/feedback',
    method: 'POST',
    data: requestPayload,
    mock: () => ({
      id: `LOCAL-AF-${Date.now()}`,
      status: 'open',
      feedbackType: requestPayload.feedbackType || 'other'
    })
  })
}

module.exports = {
  parseNeedText,
  buildLocalRecognition,
  buildLocalMatch,
  LLM_MATCH_TIMEOUT_MS,
  recognizeRentalNeed,
  matchRentalNeed,
  chatAssistant,
  submitAssistantFeedback
}
