const {
  NO_FEATURE,
  NO_COMMISSION_FEATURE,
  DEPOSIT_FREE_FEATURE,
  parseFeatureInput
} = require('./listing-features')

const COMPANY_SOURCE = '公司房源'
const VERIFY_STALE_DAYS = 15

const FEATURE_RULES = [
  { name: '带阳台', pattern: /阳台/ },
  { name: '干湿分离', pattern: /干湿分离/ },
  { name: '燃气', pattern: /燃气|天然气|煤气/ },
  { name: '阁楼', pattern: /阁楼/ },
  { name: '露台', pattern: /露台/ },
  { name: '花园', pattern: /花园/ },
  { name: '近地铁', pattern: /近地铁|地铁口|地铁站|号线/ },
  { name: '朝南', pattern: /朝南|南向/ },
  { name: '独卫', pattern: /独卫|独立卫|独立厨卫|独厨独卫/ },
  { name: '电梯', pattern: /电梯/ },
  { name: '整租', pattern: /整租|（整）|\(整\)/ },
  { name: '合租', pattern: /合租|单间/ },
  { name: DEPOSIT_FREE_FEATURE, pattern: /免押金|无押金|零押金|押金0|押金为0/ }
]

function unique(values) {
  const seen = {}
  return (values || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen[item]) return false
      seen[item] = true
      return true
    })
}

function listingText(listing) {
  const data = listing || {}
  return [
    data.title,
    data.meta,
    data.sub,
    data.tag,
    data.layout,
    data.type,
    data.rentMode,
    data.room,
    data.hall,
    data.bath,
    data.source,
    data.sourceLabel,
    data.status,
    data.community,
    data.locationSummary,
    data.roomAddress,
    data.commission,
    data.commissionText,
    data.commissionRate,
    data.companyListing ? COMPANY_SOURCE : ''
  ].map((item) => String(item || '')).join(' ')
}

function truthyFlag(value) {
  if (value === true || value === 1) return true
  if (value === false || value === 0 || value === undefined || value === null) return false
  return /^(true|1|yes|y|是|公司|公司房源)$/i.test(String(value).trim())
}

function numberFrom(value) {
  if (value === undefined || value === null || value === '') return null
  const direct = Number(value)
  if (Number.isFinite(direct)) return direct
  const matched = String(value).match(/(\d+(?:\.\d+)?)/)
  return matched ? Number(matched[1]) : null
}

function isCompanyListing(listing, options) {
  const data = listing || {}
  const text = listingText(data)
  return Boolean(
    options && options.forceCompany ||
    truthyFlag(data.companyListing) ||
    truthyFlag(data.isCompanyListing) ||
    truthyFlag(data.companyOwned) ||
    /公司房源|公司自营|company/i.test(text)
  )
}

function isNoCommission(listing, companyListing) {
  const data = listing || {}
  const text = listingText(data)
  return Boolean(
    companyListing ||
    truthyFlag(data.noCommission) ||
    /不分佣|(^|[^\d])0(?:\.0+)?\s*%|分佣\s*0(?:\.0+)?/.test(text) ||
    numberFrom(data.commissionRate) === 0 ||
    numberFrom(data.commission) === 0 ||
    parseFeatureInput(data.features).indexOf(NO_COMMISSION_FEATURE) !== -1
  )
}

function inferFeatures(listing, options) {
  const data = listing || {}
  const text = listingText(data)
  const companyListing = isCompanyListing(data, options)
  const noCommission = isNoCommission(data, companyListing)
  const rawFeatures = parseFeatureInput(data.features)
  const explicitNoFeature = rawFeatures.indexOf(NO_FEATURE) !== -1
  const explicit = rawFeatures.filter((item) => item && item !== NO_FEATURE)
  const inferred = explicitNoFeature
    ? []
    : FEATURE_RULES
      .filter((rule) => rule.pattern.test(text))
      .map((rule) => rule.name)
  if (/合租/.test(text) && inferred.indexOf('整租') !== -1) {
    inferred.splice(inferred.indexOf('整租'), 1)
  }
  if (companyListing) {
    inferred.unshift(COMPANY_SOURCE)
    inferred.push(DEPOSIT_FREE_FEATURE)
  }
  if (noCommission) inferred.push(NO_COMMISSION_FEATURE)
  const result = unique(explicit.concat(inferred))
  return result.length ? result : [NO_FEATURE]
}

function parseDateValue(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  if (/刚刚|今天/.test(text)) return Date.now()
  if (/昨天/.test(text)) return Date.now() - 86400000
  const normalized = text
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/\//g, '-')
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function maintenanceText(listing) {
  const data = listing || {}
  if (data.maintenanceText) return data.maintenanceText
  const rawDays = Number(data.staleDays)
  if (Number.isFinite(rawDays)) {
    if (rawDays <= 0) return '今日已维护'
    if (rawDays >= VERIFY_STALE_DAYS) return `${VERIFY_STALE_DAYS}天未维护`
    return `${rawDays}天前维护`
  }

  const lastTime = parseDateValue(data.lastVerifiedAt || data.updatedAt || data.createdAt || data.time)
  if (!lastTime) return `${VERIFY_STALE_DAYS}天未维护`
  const days = Math.max(0, Math.floor((Date.now() - lastTime) / 86400000))
  if (days <= 0) return '今日已维护'
  if (days >= VERIFY_STALE_DAYS) return `${VERIFY_STALE_DAYS}天未维护`
  return `${days}天前维护`
}

function formatRelevance(value) {
  const raw = value === undefined || value === null || value === ''
    ? ''
    : String(value)
  if (!raw) return ''
  if (raw.indexOf('%') !== -1) {
    const matched = raw.match(/(\d+(?:\.\d+)?)%/)
    return matched ? `${Math.round(Number(matched[1]))}%` : raw
  }
  const number = Number(raw)
  if (!Number.isFinite(number)) return raw
  return `${Math.round(number <= 1 ? number * 100 : number)}%`
}

function extractCommissionText(data) {
  if (data.commissionText) return data.commissionText
  if (data.commission) return `分佣 ${data.commission}`
  const matched = [data.tag, data.sub]
    .map((item) => String(item || ''))
    .join(' ')
    .match(/分佣\s*(\d+(?:\.\d+)?\s*%?)/)
  return matched ? `分佣 ${matched[1].replace(/\s+/g, '')}` : ''
}

function normalizeListing(listing, options) {
  const data = listing || {}
  const companyListing = isCompanyListing(data, options)
  const noCommission = isNoCommission(data, companyListing)
  const features = inferFeatures(data, options)
  const tagText = String(data.tag || '')
  const relevanceSource = data.relevancePercent || data.matchScore || data.relevanceScore || (/匹配|相关性/.test(tagText) ? tagText : '')
  const relevance = formatRelevance(relevanceSource)
  const commissionText = noCommission
    ? '不分佣'
    : extractCommissionText(data)
  return {
    ...data,
    features,
    maintenanceText: maintenanceText(data),
    companyListing,
    isCompanyListing: companyListing,
    noCommission,
    sourceLabel: companyListing ? COMPANY_SOURCE : (data.sourceLabel || data.source || ''),
    commissionText,
    commission: noCommission ? '不分佣' : (data.commission || data.commissionText || ''),
    displayRelevance: relevance,
    relevancePercent: data.relevancePercent || relevance,
    matchScore: data.matchScore || relevance,
    tag: relevance && /匹配|相关性/.test(String(data.tag || '')) ? `相关性 ${relevance}` : data.tag
  }
}

function normalizeListings(listings, options) {
  return (listings || []).map((item) => normalizeListing(item, options))
}

function normalizeGroupState(state) {
  const next = state || {}
  const listings = normalizeListings(next.listings || [])
  return {
    ...next,
    listings,
    allListings: normalizeListings(next.allListings || next.listings || [])
  }
}

module.exports = {
  COMPANY_SOURCE,
  normalizeListing,
  normalizeListings,
  normalizeGroupState,
  formatRelevance
}
