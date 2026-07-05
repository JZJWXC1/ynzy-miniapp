const config = require('./config')

function normalizeText(value) {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join(' ').trim()
  return String(value).trim()
}

function unique(values) {
  const seen = new Set()
  return (values || []).map(normalizeText).filter(Boolean).filter((item) => {
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
}

function splitLocationTokens(value) {
  const text = normalizeText(value)
  if (!text) return []
  return unique(text.split(/[\r\n、,，/／|｜;；\s]+/))
}

function configuredDistrictName(value) {
  const text = normalizeText(value)
  if (!text) return ''
  const districts = Object.keys((config.location && config.location.districtBlocks) || {})
  return districts.find((district) => district === text || district.replace(/区$/, '') === text.replace(/区$/, '')) || ''
}

function compactKey(value) {
  return normalizeText(value).replace(/\s+/g, '')
}

function communityOverride(community) {
  const text = compactKey(community)
  if (!text) return null
  const overrides = (config.location && config.location.communityLocationOverrides) || {}
  const matched = Object.keys(overrides).find((name) => compactKey(name) === text)
  if (matched) return overrides[matched] || null
  const districtOverrides = (config.location && config.location.communityDistrictOverrides) || {}
  const blockOverrides = (config.location && config.location.communityBlockOverrides) || {}
  const legacyMatched = unique(Object.keys(districtOverrides).concat(Object.keys(blockOverrides)))
    .find((name) => compactKey(name) === text)
  if (!legacyMatched) return null
  return {
    district: districtOverrides[legacyMatched] || '',
    block: blockOverrides[legacyMatched] || ''
  }
}

function districtForCommunity(community) {
  const override = communityOverride(community)
  return override ? normalizeText(override.district) : ''
}

function blockForCommunity(community) {
  const override = communityOverride(community)
  return override ? normalizeText(override.block) : ''
}

function blockForLocation(location = {}) {
  return blockForCommunity(location.community || location.communityName) ||
    normalizeText(location.block || location.area || location.fallback) ||
    '待板块'
}

function districtForBlock(block, fallback = '', options = {}) {
  const communityDistrict = districtForCommunity(options.community || options.communityName)
  if (communityDistrict) return communityDistrict

  const explicitDistrict = configuredDistrictName(fallback)
  if (explicitDistrict) return explicitDistrict

  const directDistrict = configuredDistrictName(block)
  if (directDistrict) return directDistrict

  const blockMap = (config.location && config.location.blockDistrictMap) || {}
  const tokens = unique(splitLocationTokens(block).concat(splitLocationTokens(fallback)))
  const matchedBlock = tokens.find((token) => blockMap[token] || configuredDistrictName(token))
  if (matchedBlock) return blockMap[matchedBlock] || configuredDistrictName(matchedBlock)

  return normalizeText(fallback) || '待分区'
}

function districtForLocation(location = {}) {
  const block = blockForLocation(location)
  return districtForBlock(block || location.area, location.district || location.fallback || location.area, {
    community: location.community || location.communityName
  })
}

module.exports = {
  splitLocationTokens,
  configuredDistrictName,
  districtForCommunity,
  blockForCommunity,
  blockForLocation,
  districtForBlock,
  districtForLocation
}
