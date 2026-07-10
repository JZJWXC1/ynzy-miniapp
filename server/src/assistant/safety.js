const llm = require('../llm')

const scrubByLlm = llm && llm._internal && llm._internal.scrubSensitiveText
  ? llm._internal.scrubSensitiveText
  : (value) => String(value || '')

const SENSITIVE_KEYS = new Set([
  'address',
  'building',
  'buildingNo',
  'buildingNumber',
  'unit',
  'unitNo',
  'unitNumber',
  'roomNumber',
  'roomNo',
  'houseNo',
  'doorNo',
  'contact',
  'phone',
  'mobile',
  'customerPhone',
  'landlordPhone',
  'viewingPassword',
  'showingPassword',
  'viewingKeyLocation',
  'keyLocation',
  'wechat',
  'wechatId',
  'wx',
  'idCard',
  'identityNo',
  'videoUrl',
  'videoKey',
  'videoSignedUrl',
  'signedUrl',
  'shareUrl',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'mapLatitude',
  'mapLongitude'
])

const SAFE_NEED_KEYS = [
  'budget',
  'budgetText',
  'minBudget',
  'maxBudget',
  'area',
  'community',
  'searchMode',
  'anchorName',
  'anchorRole',
  'radiusKm',
  'preferredAreas',
  'rentMode',
  'layout',
  'features'
]

const SAFE_LISTING_KEYS = [
  'id',
  'title',
  'cardTitle',
  'community',
  'area',
  'layout',
  'rentMode',
  'type',
  'rent',
  'price',
  'meta',
  'features',
  'maintenanceText',
  'matchGroup',
  'matchGroupText',
  'matchReason',
  'differenceText',
  'differences',
  'relevanceReasons',
  'relevanceScore',
  'relevancePercent',
  'matchScore',
  'displayRelevance',
  'distanceKm',
  'distanceText',
  'anchorName'
]

function scrubSensitiveText(value) {
  return scrubByLlm(value)
    .replace(/https?:\/\/[^\s"'，。；;]+/ig, '[链接已隐藏]')
    .replace(/\b(?:Signature|Expires|OSSAccessKeyId|security-token|x-oss-[^=\s&]+)=[^&\s"'，。；;]+/ig, '[签名参数已隐藏]')
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, '[身份证号已隐藏]')
    .replace(/(?:客户|租客|房东|联系人)?(?:手机号|手机|电话|联系电话|联系方式|号码)[:：\s]*\+?\d[\d\s-]{6,18}/g, '[电话已隐藏]')
    .replace(/1[3-9](?:[\s-]?\d){9}/g, '[手机号已隐藏]')
    .replace(/\b0\d{2,3}[-\s]?\d{7,8}\b/g, '[电话已隐藏]')
    .replace(/\b400[-\s]?\d{3}[-\s]?\d{4}\b/g, '[电话已隐藏]')
    .replace(/\bwxid_[A-Za-z0-9_-]{5,}\b/ig, '[微信号已隐藏]')
    .replace(/(?:微信号?|微信|VX|V信|weixin|wechat)[:：\s]*[A-Za-z][A-Za-z0-9_-]{4,19}/ig, '[微信号已隐藏]')
    .replace(/(?:\d{1,3}|[一二三四五六七八九十]{1,3})(?:栋|幢|号楼|座)(?:\d{1,3}|[一二三四五六七八九十]{1,3})?(?:单元)?[A-Za-z0-9一二三四五六七八九十-]{0,8}(?:室|房|房号)?/g, '[房号已隐藏]')
    .replace(/(?:房号|门牌|房间|室号)[:：\s]*[A-Za-z0-9-]{2,12}/g, '[房号已隐藏]')
    .replace(/(^|[^\d])\d{1,3}[-－]\d{1,3}[-－]\d{2,4}(?!\d)/g, '$1[房号已隐藏]')
    .replace(/\d{2,5}(?:室|房号)/g, '[房号已隐藏]')
}

function scrubDeep(value) {
  if (Array.isArray(value)) return value.map(scrubDeep)
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      if (SENSITIVE_KEYS.has(key)) return result
      result[key] = scrubDeep(value[key])
      return result
    }, {})
  }
  if (typeof value === 'string') return scrubSensitiveText(value).trim()
  return value
}

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

function safeArrayText(item) {
  if (item === undefined || item === null || item === '') return ''
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
    return scrubSensitiveText(item).trim()
  }
  if (item && typeof item === 'object') {
    const cleaned = scrubDeep(item)
    const displayText = cleaned.name || cleaned.text || cleaned.label || cleaned.note || JSON.stringify(cleaned)
    return scrubSensitiveText(displayText).trim()
  }
  return scrubSensitiveText(String(item)).trim()
}

function safeTextArray(values) {
  return unique((values || []).map(safeArrayText))
}

function safeConstraintObject(source = {}) {
  return {
    minBudget: source.minBudget || '',
    maxBudget: source.maxBudget || '',
    area: source.area ? scrubSensitiveText(source.area) : '',
    community: source.community ? scrubSensitiveText(source.community) : '',
    rentMode: source.rentMode ? scrubSensitiveText(source.rentMode) : '',
    layout: source.layout ? scrubSensitiveText(source.layout) : '',
    features: safeTextArray(source.features || [])
  }
}

function safePreferences(source = {}) {
  return {
    budgetTolerance: source.budgetTolerance || '',
    features: safeTextArray(source.features || [])
  }
}

function safeNeed(source = {}) {
  const need = {}
  SAFE_NEED_KEYS.forEach((key) => {
    const value = source[key]
    if (Array.isArray(value)) {
      need[key] = safeTextArray(value)
      return
    }
    if (value !== undefined && value !== null && value !== '') {
      need[key] = typeof value === 'string' ? scrubSensitiveText(value) : value
    }
  })
  need.hardConstraints = safeConstraintObject(source.hardConstraints || source)
  need.preferences = safePreferences(source.preferences || {})
  return need
}

// 标识符字段必须原样透传，绝不能过 scrubSensitiveText：listing.id 形如 L1783427664217530，
// 其数字子串会命中手机号正则 1[3-9]\d{9} 被脱敏成 L[手机号已隐藏]17530，导致前端拿到坏 id ——
// 聊天/助手推荐卡「看详情」404、「地图查看」的 listingIds 匹配不到 → 空。id 非敏感信息，不脱敏。
const RAW_LISTING_KEYS = new Set(['id'])

function safeListing(listing = {}) {
  return SAFE_LISTING_KEYS.reduce((result, key) => {
    if (!Object.prototype.hasOwnProperty.call(listing, key)) return result
    const value = listing[key]
    if (RAW_LISTING_KEYS.has(key)) {
      result[key] = value
      return result
    }
    if (Array.isArray(value)) {
      result[key] = safeTextArray(value)
      return result
    }
    result[key] = typeof value === 'string' ? scrubSensitiveText(value) : value
    return result
  }, {})
}

function safeListings(listings) {
  return (listings || []).map(safeListing)
}

function safePlaceResolution(source) {
  if (!source || typeof source !== 'object') return null
  const result = {}
  ;['status', 'query', 'name', 'area', 'type', 'source'].forEach((key) => {
    const value = source[key]
    if (value === undefined || value === null || value === '') return
    result[key] = typeof value === 'string' ? scrubSensitiveText(value) : value
  })
  if (Array.isArray(source.candidates)) {
    result.candidates = source.candidates.slice(0, 5).map((item) => {
      const candidate = {}
      ;['name', 'area', 'type', 'source'].forEach((key) => {
        const value = item && item[key]
        if (value === undefined || value === null || value === '') return
        candidate[key] = typeof value === 'string' ? scrubSensitiveText(value) : value
      })
      return candidate
    })
  }
  return Object.keys(result).length ? result : null
}

function containsSensitiveText(value) {
  const text = JSON.stringify(value || {})
  return /1[3-9](?:[\s-]?\d){9}|Signature=|OSSAccessKeyId=|wxid_|微信号[:：]|VX[:：]|(?:^|[^\d])\d{1,3}[-－]\d{1,3}[-－]\d{2,4}(?!\d)|(?:\d{1,3}|[一二三四五六七八九十]{1,3})(?:栋|幢|号楼|座)(?:\d{1,3}|[一二三四五六七八九十]{1,3})?(?:单元)?|(?:房东|客户|租客).{0,8}(?:电话|手机)[:：\s]*\d/.test(text)
}

module.exports = {
  scrubSensitiveText,
  scrubDeep,
  safeNeed,
  safeListing,
  safeListings,
  safePlaceResolution,
  containsSensitiveText,
  _internal: {
    SENSITIVE_KEYS,
    SAFE_LISTING_KEYS,
    safeTextArray
  }
}
