const { normalizeListingFeatures, featureText } = require('./listing-features')

const SAFETY_VERSION = 'recommendation-profile-v1'
const DAY_MS = 24 * 60 * 60 * 1000

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function text(value) {
  return String(value || '').trim()
}

function uniq(values) {
  const seen = {}
  return values.filter((value) => {
    const item = text(value)
    if (!item || seen[item]) return false
    seen[item] = true
    return true
  })
}

function sensitiveFragments(listing = {}) {
  return [
    listing.address,
    listing.landlordPhone,
    listing.contact,
    listing.customerPhone,
    listing.clientPhone,
    listing.idCard,
    listing.identityNo,
    listing.wechat,
    listing.weixin,
    listing.wx,
    listing.videoUrl,
    listing.videoSignedUrl,
    listing.signedVideoUrl
  ].map(text).filter((item) => item.length >= 4)
}

function cleanText(value, fragments = []) {
  let result = text(value)
  fragments.forEach((fragment) => {
    result = result.split(fragment).join('')
  })
  return result
    .replace(/https?:\/\/\S+/ig, '')
    .replace(/(?:微信|微 信|wx|wechat)[号號\s:：-]*[A-Za-z0-9_-]{4,}/ig, '')
    .replace(/1[3-9]\d{9}/g, '')
    .replace(/\b\d{17}[\dXx]\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function publicLocation(listing = {}, fragments = sensitiveFragments(listing)) {
  const city = cleanText(listing.city || '杭州', fragments)
  const district = cleanText(listing.district || listing.area || '待分区', fragments)
  const area = cleanText(listing.area || listing.district || '待分区', fragments)
  const block = cleanText(listing.block || area || '待板块', fragments)
  const community = cleanText(listing.community || '', fragments)
  const locationSummary = cleanText([city, area, community].filter(Boolean).join(''), fragments)
  const coordinate = reliableCoordinate(listing)

  return {
    city,
    district,
    area,
    block,
    community,
    locationSummary,
    coordinate: coordinate
      ? {
          latitude: coordinate.latitude,
          longitude: coordinate.longitude,
          source: cleanText(coordinate.source, fragments)
        }
      : null
  }
}

function looksLikeVideoPath(value = '') {
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(text(value))
}

function hasVideo(listing = {}) {
  return looksLikeVideoPath(listing.videoKey) || looksLikeVideoPath(listing.videoUrl)
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function hasValidCoordinatePair(latitude, longitude) {
  return Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
}

function isReliableCoordinateSource(source) {
  const value = text(source)
  if (!value) return false
  if (/^estimated-|^legacy-|default-center|listing-coordinate|area|hash|random|pending/i.test(value)) return false
  return /lianjia|amap|community-coordinate|admin-verified-coordinate/i.test(value)
}

function reliableCoordinate(listing = {}) {
  const latitude = numberOrNull(listing.mapLatitude !== undefined ? listing.mapLatitude : listing.latitude)
  const longitude = numberOrNull(listing.mapLongitude !== undefined ? listing.mapLongitude : listing.longitude)
  const source = listing.coordinateSource || ''
  if (!hasValidCoordinatePair(latitude, longitude)) return null
  if (!listing.coordinateVerified) return null
  if (!isReliableCoordinateSource(source)) return null
  return { latitude, longitude, source }
}

function coordinateQuality(listing = {}) {
  const latitude = numberOrNull(listing.mapLatitude !== undefined ? listing.mapLatitude : listing.latitude)
  const longitude = numberOrNull(listing.mapLongitude !== undefined ? listing.mapLongitude : listing.longitude)
  const source = listing.coordinateSource || ''
  if (!hasValidCoordinatePair(latitude, longitude)) return 'missing'
  if (!listing.coordinateVerified) return 'unverified'
  if (!isReliableCoordinateSource(source)) return 'unsafe_source'
  if (/community-coordinate|lianjia|amap/i.test(source)) return 'community_verified'
  return 'admin_verified'
}

function freshnessScore(listing = {}, generatedAt = new Date()) {
  const status = text(listing.status)
  if (listing.lifecycleStatus === 'expired' || listing.lifecycleStatus === 'sold' || /已下架|已失效|已成交|签单/.test(status)) return 0

  const source = text(listing.lastVerifiedAt || listing.updatedAt || listing.createdAt)
  if (!source || source === '刚刚') return 100

  const timestamp = Date.parse(source)
  if (!Number.isFinite(timestamp)) return 80

  const now = generatedAt instanceof Date ? generatedAt.getTime() : Date.parse(generatedAt)
  if (!Number.isFinite(now)) return 80

  const days = Math.max(0, Math.floor((now - timestamp) / DAY_MS))
  return Math.max(0, Math.min(100, 100 - days * 14))
}

function qualityScore(listing = {}, profile = {}) {
  let score = 20
  if (profile.publicLocation && profile.publicLocation.community) score += 15
  if (Number(profile.rent || 0) > 0) score += 10
  if (profile.layout || profile.room) score += 10
  if ((profile.features || []).filter((item) => item !== '无').length) score += 10
  if (profile.hasVideo) score += 15
  if (/verified/.test(profile.coordinateQuality || '')) score += 20
  return Math.max(0, Math.min(100, score))
}

function publicFields(listing = {}, fragments = sensitiveFragments(listing)) {
  const features = normalizeListingFeatures(listing.features)
    .map((item) => cleanText(item, fragments))
    .filter(Boolean)
  const location = publicLocation(listing, fragments)
  const safeFeatureText = cleanText(featureText(features), fragments)
  const rent = Number(listing.rent || 0)
  const fields = {
    publicLocation: location,
    rent: Number.isFinite(rent) ? rent : 0,
    layout: cleanText(listing.layout || '', fragments),
    rentMode: cleanText(listing.rentMode || listing.type || '', fragments),
    room: cleanText(listing.room || '', fragments),
    hall: cleanText(listing.hall || '', fragments),
    bath: cleanText(listing.bath || '', fragments),
    features,
    featureText: safeFeatureText,
    coordinateQuality: coordinateQuality(listing),
    hasVideo: hasVideo(listing)
  }
  return fields
}

function searchTextForProfile(profile = {}, fragments = []) {
  const location = profile.publicLocation || {}
  return cleanText(uniq([
    location.city,
    location.district,
    location.area,
    location.block,
    location.community,
    location.locationSummary,
    profile.rent ? `${profile.rent}元` : '',
    profile.layout,
    profile.rentMode,
    profile.room,
    profile.hall,
    profile.bath,
    profile.featureText,
    profile.hasVideo ? '有视频' : ''
  ]).join(' '), fragments)
}

function buildRecommendationProfile(listing = {}, options = {}) {
  const generatedAt = options.generatedAt || nowText()
  const fragments = sensitiveFragments(listing)
  const fields = publicFields(listing, fragments)
  const profile = {
    ready: true,
    listingId: text(listing.id),
    generatedAt,
    ...fields,
    searchText: '',
    qualityScore: 0,
    freshnessScore: freshnessScore(listing, generatedAt),
    safetyVersion: SAFETY_VERSION,
    unavailableReason: ''
  }
  profile.searchText = searchTextForProfile(profile, fragments)
  profile.qualityScore = qualityScore(listing, profile)
  return profile
}

function buildUnavailableRecommendationProfile(listing = {}, reason = 'not_frontend_effective', options = {}) {
  const generatedAt = options.generatedAt || nowText()
  const fragments = sensitiveFragments(listing)
  const fields = publicFields(listing, fragments)
  return {
    ready: false,
    listingId: text(listing.id),
    generatedAt,
    ...fields,
    searchText: '',
    qualityScore: 0,
    freshnessScore: 0,
    safetyVersion: SAFETY_VERSION,
    unavailableReason: cleanText(reason || 'not_frontend_effective', fragments)
  }
}

function refreshRecommendationProfile(listing = {}, options = {}) {
  listing.recommendationProfile = buildRecommendationProfile(listing, options)
  return listing.recommendationProfile
}

function clearRecommendationProfile(listing = {}, reason = 'not_frontend_effective', options = {}) {
  listing.recommendationProfile = buildUnavailableRecommendationProfile(listing, reason, options)
  return listing.recommendationProfile
}

module.exports = {
  SAFETY_VERSION,
  buildRecommendationProfile,
  buildUnavailableRecommendationProfile,
  refreshRecommendationProfile,
  clearRecommendationProfile
}
