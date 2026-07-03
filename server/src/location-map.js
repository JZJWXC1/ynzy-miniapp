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

function districtForBlock(block, fallback = '') {
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

module.exports = {
  splitLocationTokens,
  configuredDistrictName,
  districtForBlock
}
