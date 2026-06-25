const apiClient = require('./api-client')
const dataCenter = require('./mock-data')
const listingDisplay = require('./listing-display')
const {
  NO_FEATURE,
  LISTING_FEATURE_OPTIONS,
  parseFeatureInput
} = require('./listing-features')

const AREA_WORDS = ['滨江', '西兴', '长河', '浦沿', '萧山', '建设路', '上城区', '上城', '拱墅区', '拱墅', '西湖区', '西湖', '余杭', '临平', '钱塘', '钱江新城']
const LAYOUT_WORDS = ['一室', '两室', '二室', '三室', '四室', '整租', '合租', '公寓', '单间']
const FEATURE_ALIASES = {
  带阳台: ['带阳台', '阳台'],
  干湿分离: ['干湿分离'],
  燃气: ['燃气', '天然气', '煤气'],
  阁楼: ['阁楼', '带阁楼'],
  露台: ['露台', '带露台'],
  花园: ['花园', '带花园'],
  近地铁: ['近地铁', '地铁口', '地铁'],
  朝南: ['朝南', '南向'],
  独卫: ['独卫', '独立卫生间', '独立卫浴'],
  电梯: ['电梯'],
  整租: ['整租'],
  合租: ['合租'],
  免押金: ['免押金', '无押金', '零押金', '押金0', '押金为0']
}

function pickWord(text, words) {
  return words.find((word) => text.indexOf(word) !== -1) || ''
}

function parseNeedText(text) {
  const source = (text || '').replace(/\s+/g, '')
  const budgetMatch = source.match(/预算?(\d{3,5})|(\d{3,5})(元|块|左右|以内)?/)
  const commuteMatch = source.match(/(?:通勤到|通勤|上班到|上班|公司到|公司|到)([^，。,.；;]{2,12})/)
  const moveInMatch = source.match(/(?:入住|搬入|起租|月底|月初|下周|今天|明天|周末)[^，。,.；;]{0,8}/)
  const features = LISTING_FEATURE_OPTIONS
    .filter((feature) => feature !== NO_FEATURE)
    .filter((feature) => (FEATURE_ALIASES[feature] || [feature]).some((word) => source.indexOf(word) !== -1))

  return {
    budget: budgetMatch ? (budgetMatch[1] || budgetMatch[2]) : '',
    area: pickWord(source, AREA_WORDS),
    layout: pickWord(source, LAYOUT_WORDS),
    moveIn: moveInMatch ? moveInMatch[0] : '',
    commute: commuteMatch ? commuteMatch[1].replace(/^到/, '') : '',
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

function mergeNeed(textNeed, formNeed) {
  const rawFormFeatures = parseFeatureInput(formNeed.features)
  const formFeatures = rawFormFeatures.filter((item) => item !== NO_FEATURE)
  return {
    budget: formNeed.budget || textNeed.budget || '',
    area: formNeed.area || textNeed.area || '',
    layout: formNeed.layout || textNeed.layout || '',
    moveIn: formNeed.moveIn || textNeed.moveIn || '',
    commute: formNeed.commute || textNeed.commute || '',
    features: rawFormFeatures.length ? formFeatures : (textNeed.features || [])
  }
}

function needFromPayload(payload) {
  const textNeed = parseNeedText([payload.text, payload.voiceText].filter(Boolean).join('，'))
  return mergeNeed(textNeed, payload.form || {})
}

function mergeServerNeed(clientNeed, serverNeed) {
  const server = serverNeed || {}
  return {
    budget: clientNeed.budget || server.budget || '',
    area: clientNeed.area || server.area || '',
    layout: clientNeed.layout || server.layout || '',
    moveIn: clientNeed.moveIn || server.moveIn || '',
    commute: clientNeed.commute || server.commute || '',
    features: clientNeed.features && clientNeed.features.length
      ? clientNeed.features
      : (server.features || [])
  }
}

function listingSearchText(listing) {
  const item = listing || {}
  return [
    item.title,
    item.meta,
    item.sub,
    item.locationSummary,
    item.community,
    item.roomAddress,
    item.area,
    item.block,
    item.layout,
    item.type,
    item.rentMode,
    item.sourceLabel,
    item.source,
    item.status,
    (item.features || []).join(' ')
  ].map((value) => String(value || '')).join(' ')
}

function relevanceLabel(score) {
  if (score >= 85) return '高相关'
  if (score >= 68) return '较相关'
  if (score >= 50) return '可参考'
  return '低相关'
}

function scoreListing(listing, need) {
  const item = listingDisplay.normalizeListing(listing)
  const budget = numberFrom(need.budget)
  const rent = numberFrom(item.rent || item.price)
  const area = String(need.area || '').trim()
  const layout = String(need.layout || '').trim()
  const requestedFeatures = parseFeatureInput(need.features).filter((name) => name !== NO_FEATURE)
  const text = listingSearchText(item)
  const featureSet = new Set((item.features || []).concat([item.type, item.rentMode]).filter(Boolean))
  let score = 40
  const reasons = []

  if (budget && rent && rent <= budget) {
    score += 24
    reasons.push('预算匹配')
  }
  if (budget && rent && rent > budget) {
    score -= Math.min(30, Math.ceil((rent - budget) / 200))
  }
  if (area && text.indexOf(area) !== -1) {
    score += 24
    reasons.push('区域匹配')
  }
  if (layout && text.indexOf(layout) !== -1) {
    score += 22
    reasons.push('户型匹配')
  }
  if (requestedFeatures.length) {
    const matched = requestedFeatures.filter((name) => featureSet.has(name))
    score += Math.min(30, matched.length * 14)
    if (matched.length) reasons.push(`特点命中${matched.length}项`)
    if (!matched.length) score -= 12
  }
  if (/在租|待确认/.test(String(item.status || ''))) {
    score += 4
  }

  const relevanceScore = Math.max(1, Math.min(99, score))
  return Object.assign({}, item, {
    relevanceScore,
    relevancePercent: `${relevanceScore}%`,
    matchScore: `${relevanceScore}%`,
    displayRelevance: `${relevanceScore}%`,
    relevanceText: `相关性 ${relevanceScore}%`,
    relevanceLabel: relevanceLabel(relevanceScore),
    relevanceReasons: reasons.length ? reasons : ['基础条件相近'],
    tag: `相关性 ${relevanceScore}%`
  })
}

function scoreListings(listings, need) {
  const budget = numberFrom(need.budget)
  const hasCondition = Boolean(
    budget ||
    need.area ||
    need.layout ||
    (need.features && need.features.length)
  )
  const scored = (listings || [])
    .map((listing) => scoreListing(listing, need))
    .filter((listing) => !hasCondition || listing.relevanceScore >= 48)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 6)
  return scored
}

function buildReply(need, result) {
  const parts = []
  if (need.budget) parts.push(`预算 ${need.budget}`)
  if (need.area) parts.push(`区域 ${need.area}`)
  if (need.layout) parts.push(`户型 ${need.layout}`)
  if (need.moveIn) parts.push(need.moveIn)
  if (need.commute) parts.push(`通勤到 ${need.commute}`)
  if (need.features && need.features.length) parts.push(`特点 ${need.features.join('、')}`)

  const conditionText = parts.length ? parts.join(' · ') : '当前需求'
  const top = result.listings[0]
  if (!top) {
    return `${conditionText} 暂时没有高匹配房源，我会优先建议放宽区域或预算。`
  }
  return `${conditionText} 已匹配到 ${result.listings.length} 套，已按相关性评分排序；优先看 ${top.title}，相关性 ${top.relevancePercent || top.matchScore}。`
}

function buildLocalMatch(payload) {
  const need = needFromPayload(payload)
  const result = dataCenter.matchListings(need)
  return {
    need,
    reply: buildReply(need, result),
    listings: listingDisplay.normalizeListings(result.listings),
    mode: 'local-llm-adapter'
  }
}

function matchRentalNeed(payload) {
  const localResult = buildLocalMatch(payload)
  const requestPayload = payload || {}
  return apiClient.call({
    path: '/mini/llm/match',
    method: 'POST',
    data: requestPayload,
    mock: () => localResult
  }).then((serverResult) => {
    const clientNeed = needFromPayload(requestPayload)
    const need = mergeServerNeed(clientNeed, (serverResult && serverResult.need) || {})
    return apiClient.call({
      path: '/mini/listings',
      mock: () => dataCenter.getListings({})
    }).then((allListings) => {
      const listings = scoreListings(allListings, need)
      return {
        ...serverResult,
        need,
        reply: (serverResult && serverResult.reply) || buildReply(need, { listings }),
        listings,
        mode: (serverResult && serverResult.mode) || 'client-ranked'
      }
    }).catch(() => {
      const listings = scoreListings((serverResult && serverResult.listings) || [], need)
      return {
        ...serverResult,
        need,
        reply: (serverResult && serverResult.reply) || buildReply(need, { listings }),
        listings,
        mode: (serverResult && serverResult.mode) || 'client-ranked'
      }
    })
  }).catch(() => {
    return localResult
  })
}

module.exports = {
  parseNeedText,
  buildLocalMatch,
  matchRentalNeed
}
