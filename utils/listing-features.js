const NO_FEATURE = '无'
const NO_COMMISSION_FEATURE = '不分佣'
const DEPOSIT_FREE_FEATURE = '免押金'

const LISTING_FEATURE_OPTIONS = [
  '带阳台',
  '干湿分离',
  '燃气',
  '阁楼',
  '露台',
  '花园',
  '近地铁',
  '朝南',
  '独卫',
  '电梯',
  '整租',
  '合租',
  DEPOSIT_FREE_FEATURE,
  NO_COMMISSION_FEATURE,
  NO_FEATURE
]

function parseFeatureInput(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[，,、|]/)
  const seen = {}
  return source
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen[item]) return false
      seen[item] = true
      return true
    })
}

function normalizeListingFeatures(value) {
  const selected = parseFeatureInput(value)
    .filter((item) => LISTING_FEATURE_OPTIONS.indexOf(item) !== -1)
  const hasNoCommission = selected.indexOf(NO_COMMISSION_FEATURE) !== -1
  const features = selected.filter((item) => item !== NO_FEATURE && item !== NO_COMMISSION_FEATURE)
  if (!features.length) return hasNoCommission ? [NO_COMMISSION_FEATURE] : [NO_FEATURE]
  return hasNoCommission ? features.concat(NO_COMMISSION_FEATURE) : features
}

function invalidListingFeatures(value) {
  return parseFeatureInput(value)
    .filter((item) => LISTING_FEATURE_OPTIONS.indexOf(item) === -1)
}

function featureText(value) {
  return normalizeListingFeatures(value).join(' · ')
}

module.exports = {
  NO_FEATURE,
  NO_COMMISSION_FEATURE,
  DEPOSIT_FREE_FEATURE,
  LISTING_FEATURE_OPTIONS,
  parseFeatureInput,
  normalizeListingFeatures,
  invalidListingFeatures,
  featureText
}
