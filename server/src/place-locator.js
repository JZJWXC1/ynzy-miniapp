const {
  communityCoordinates,
  coordinateByCommunity,
  isReliableCoordinateSource,
  normalizeCommunityName
} = require('./community-coordinates')
const config = require('./config')

const DEFAULT_RADIUS_KM = 3
const SERVICE_AREAS = ['拱墅', '余杭', '上城']

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

function numberFrom(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function normalizePlaceName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(杭州市?|杭州)?(拱墅区|余杭区|上城区|西湖区|滨江区|萧山区|临平区|钱塘区)/, '')
    .replace(/附近|周边|旁边|边上|一带|这边|那边/g, '')
}

function reliableCoordinate(latitude, longitude, source, verified) {
  const lat = numberFrom(latitude)
  const lng = numberFrom(longitude)
  if (!lat || !lng) return null
  if (!isReliableCoordinateSource(source)) return null
  if (verified === false) return null
  return { latitude: lat, longitude: lng, source: source || 'verified-coordinate' }
}

function entryFromRawPlace(place = {}) {
  const name = place.name || place.title || place.community || place.placeName
  const coordinate = reliableCoordinate(
    place.latitude || place.mapLatitude,
    place.longitude || place.mapLongitude,
    place.source || place.coordinateSource,
    place.coordinateVerified
  )
  if (!name || !coordinate) return null
  return {
    name,
    aliases: unique(place.aliases || []),
    area: place.area || place.district || '',
    type: place.type || place.placeType || 'place',
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    source: coordinate.source
  }
}

function entriesFromObjectMap(source = {}, type) {
  return Object.keys(source || {}).map((name) => {
    const raw = source[name] || {}
    return entryFromRawPlace({
      ...raw,
      name,
      type: raw.type || type
    })
  }).filter(Boolean)
}

function entriesFromConfiguredBlockCenters() {
  const location = (config && config.location) || {}
  const blockCenters = location.blockCenters || {}
  const blockDistrictMap = location.blockDistrictMap || {}
  return Object.keys(blockCenters).map((name) => {
    const center = blockCenters[name] || {}
    return entryFromRawPlace({
      name,
      type: 'block',
      area: blockDistrictMap[name] || '',
      latitude: center.latitude,
      longitude: center.longitude,
      source: `block-center:${name}`,
      coordinateVerified: true
    })
  }).filter(Boolean)
}

// 板块中心兜底（与 domain.blockCenterForListing 同口径；本地实现避免 place-locator↔domain 循环依赖）：
// 小区坐标库覆盖不到时，用房源所在板块的中心近似坐标，让库外小区房源不被半径检索静默过滤（漏推）。
function blockCenterCoordinate(listing = {}) {
  const centers = (config.location && config.location.blockCenters) || {}
  const block = String(listing.block || '').trim()
  if (block && centers[block]) return { ...centers[block], block }
  const text = [listing.block, listing.community, listing.address, listing.locationSummary]
    .map((value) => String(value || '')).join('')
  const matched = Object.keys(centers).find((item) => item && text.indexOf(item) !== -1)
  return matched ? { ...centers[matched], block: matched } : null
}

function listingCoordinate(listing = {}) {
  const direct = reliableCoordinate(
    listing.mapLatitude || listing.latitude,
    listing.mapLongitude || listing.longitude,
    listing.coordinateSource,
    listing.coordinateVerified
  )
  if (direct) return direct

  const byCommunity = coordinateByCommunity(listing.community)
  if (byCommunity) {
    return {
      latitude: byCommunity.latitude,
      longitude: byCommunity.longitude,
      source: byCommunity.source
    }
  }

  // MODEL-2 兜底：库外小区用板块中心近似坐标（level=block-center，不冒充精确点位）。
  const blockCenter = blockCenterCoordinate(listing)
  if (blockCenter && Number.isFinite(Number(blockCenter.latitude)) && Number.isFinite(Number(blockCenter.longitude))) {
    return {
      latitude: Number(blockCenter.latitude),
      longitude: Number(blockCenter.longitude),
      source: `block-center:${blockCenter.block}`,
      level: 'block-center',
      coordinateVerified: false
    }
  }
  return null
}

function entriesFromListings(listings = []) {
  const byCommunity = new Map()
  ;(listings || []).forEach((listing) => {
    const community = listing.community || ''
    const key = normalizeCommunityName(community)
    if (!key || byCommunity.has(key)) return
    const coordinate = listingCoordinate(listing)
    if (!coordinate) return
    byCommunity.set(key, {
      name: community,
      aliases: [],
      area: listing.area || listing.district || '',
      type: 'community',
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      source: coordinate.source
    })
  })
  return Array.from(byCommunity.values())
}

function placeEntries(db = {}, listings = []) {
  return []
    .concat(entriesFromObjectMap(db.placeCoordinates || {}, 'place'))
    .concat(entriesFromObjectMap(db.poiCoordinates || {}, 'poi'))
    .concat((db.places || db.pois || []).map(entryFromRawPlace).filter(Boolean))
    .concat(entriesFromObjectMap(communityCoordinates, 'community'))
    .concat(entriesFromConfiguredBlockCenters())
    .concat(entriesFromListings(listings))
}

function placeNames(db = {}, listings = [], options = {}) {
  const allowedTypes = options.types && options.types.length
    ? new Set(options.types)
    : null
  return unique(placeEntries(db, listings)
    .filter((entry) => !allowedTypes || allowedTypes.has(entry.type))
    .flatMap(entryNames))
}

function entryNames(entry = {}) {
  return unique([entry.name].concat(entry.aliases || []))
}

function entryMatches(entry, query) {
  const normalizedQuery = normalizePlaceName(query)
  if (!normalizedQuery) return false
  return entryNames(entry).some((name) => {
    const normalizedName = normalizePlaceName(name)
    return normalizedName &&
      (normalizedName === normalizedQuery ||
        normalizedQuery.indexOf(normalizedName) !== -1 ||
        normalizedName.indexOf(normalizedQuery) !== -1)
  })
}

function isBlockCenterEntry(entry = {}) {
  return /^block-center:/i.test(String(entry.source || ''))
}

function sameCoordinate(left = {}, right = {}) {
  return numberFrom(left.latitude).toFixed(6) === numberFrom(right.latitude).toFixed(6) &&
    numberFrom(left.longitude).toFixed(6) === numberFrom(right.longitude).toFixed(6)
}

function dropDuplicateBlockCenterEntries(entries = []) {
  return entries.filter((entry) => {
    if (!isBlockCenterEntry(entry)) return true
    return !entries.some((other) => other !== entry && !isBlockCenterEntry(other) && sameCoordinate(entry, other))
  })
}

function resolvePlace(db = {}, query = '', listings = []) {
  const text = normalizePlaceName(query)
  if (!text) {
    return {
      status: 'missing',
      query: '',
      candidates: []
    }
  }

  const matched = placeEntries(db, listings).filter((entry) => entryMatches(entry, text))
  const exact = matched.filter((entry) => entryNames(entry).some((name) => normalizePlaceName(name) === text))
  const candidates = dropDuplicateBlockCenterEntries(exact.length ? exact : matched)
  const deduped = []
  const seen = new Set()
  candidates.forEach((entry) => {
    const key = `${normalizePlaceName(entry.name)}:${entry.latitude}:${entry.longitude}`
    if (seen.has(key)) return
    seen.add(key)
    deduped.push(entry)
  })

  if (!deduped.length) {
    return {
      status: 'missing',
      query: text,
      candidates: []
    }
  }

  if (deduped.length > 1) {
    return {
      status: 'ambiguous',
      query: text,
      candidates: deduped.slice(0, 5).map((entry) => ({
        name: entry.name,
        area: entry.area || '',
        type: entry.type || '',
        source: entry.source || ''
      }))
    }
  }

  const entry = deduped[0]
  return {
    status: 'resolved',
    query: text,
    name: entry.name,
    area: entry.area || '',
    type: entry.type || '',
    latitude: entry.latitude,
    longitude: entry.longitude,
    source: entry.source || ''
  }
}

function toRadians(value) {
  return Number(value) * Math.PI / 180
}

function distanceKm(from, to) {
  if (!from || !to) return 0
  const fromLat = numberFrom(from.latitude)
  const fromLng = numberFrom(from.longitude)
  const toLat = numberFrom(to.latitude)
  const toLng = numberFrom(to.longitude)
  if (!fromLat || !fromLng || !toLat || !toLng) return 0

  const earthRadiusKm = 6371
  const latDiff = toRadians(toLat - fromLat)
  const lngDiff = toRadians(toLng - fromLng)
  const a = Math.sin(latDiff / 2) * Math.sin(latDiff / 2) +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) *
    Math.sin(lngDiff / 2) * Math.sin(lngDiff / 2)
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

module.exports = {
  DEFAULT_RADIUS_KM,
  SERVICE_AREAS,
  normalizePlaceName,
  listingCoordinate,
  resolvePlace,
  placeNames,
  distanceKm,
  _internal: {
    placeEntries,
    reliableCoordinate
  }
}
