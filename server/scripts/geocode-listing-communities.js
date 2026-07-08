const https = require('https')
const config = require('../src/config')
const dbStore = require('../src/db')
const domain = require('../src/domain')
const locationMap = require('../src/location-map')
const { coordinateByCommunity } = require('../src/community-coordinates')

const ALLOWED_LEVELS = new Set(['verified', 'approximate', 'block-center'])

function text(value) {
  return String(value || '').trim()
}

function numberValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function coordinateLevel(listing = {}) {
  const explicit = text(listing.coordinateLevel || listing.coordinateAccuracy).toLowerCase()
  if (ALLOWED_LEVELS.has(explicit)) return explicit
  const source = text(listing.coordinateSource).toLowerCase()
  if (/block-center/.test(source)) return 'block-center'
  if (/tencent-geocode|qq-map-geocode|geocoder/.test(source)) return 'approximate'
  if (listing.coordinateVerified === true) return 'verified'
  return ''
}

function hasUsableCoordinate(listing = {}) {
  const latitude = numberValue(listing.mapLatitude || listing.latitude)
  const longitude = numberValue(listing.mapLongitude || listing.longitude)
  return latitude !== null && longitude !== null && ALLOWED_LEVELS.has(coordinateLevel(listing))
}

function isActiveListing(listing = {}) {
  const statusText = [listing.lifecycleStatus, listing.status, listing.reviewStatus]
    .map(text)
    .join(' ')
  return !/expired|sold|已下架|已失效|成交|签单|待审核|已驳回/.test(statusText)
}

function groupActiveListingsByCommunity(db = {}, options = {}) {
  const groups = new Map()
  ;(db.listings || [])
    .filter(isActiveListing)
    .filter((listing) => options.refresh || !hasUsableCoordinate(listing))
    .forEach((listing) => {
      const community = text(listing.community || listing.shortTitle)
      if (!community) return
      if (!groups.has(community)) groups.set(community, [])
      groups.get(community).push(listing)
    })
  return groups
}

function addressForListing(listing = {}) {
  const district = locationMap.districtForLocation({
    community: listing.community,
    block: listing.block,
    district: listing.district || listing.area
  })
  return [
    '杭州市',
    district && district !== '待分区' ? district : '',
    text(listing.community || listing.shortTitle)
  ].filter(Boolean).join('')
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

async function geocodeByTencent(address, key) {
  if (!key) return null
  const url = new URL('https://apis.map.qq.com/ws/geocoder/v1/')
  url.searchParams.set('address', address)
  url.searchParams.set('key', key)
  const result = await requestJson(url)
  const location = result && result.status === 0 && result.result && result.result.location
  if (!location) return null
  const latitude = numberValue(location.lat)
  const longitude = numberValue(location.lng)
  if (latitude === null || longitude === null) return null
  return {
    latitude,
    longitude,
    source: 'tencent-geocode',
    level: 'approximate',
    status: '近似位置',
    reliability: result.result.reliability,
    geocodeLevel: result.result.level || ''
  }
}

function blockCenterCoordinate(listing = {}) {
  const center = domain.blockCenterForListing(listing)
  if (!center) return null
  return {
    latitude: center.latitude,
    longitude: center.longitude,
    source: `block-center:${center.block}`,
    level: 'block-center',
    status: '板块中心近似位置'
  }
}

function applyCoordinate(listings, coordinate) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  listings.forEach((listing) => {
    listing.mapLatitude = coordinate.latitude
    listing.mapLongitude = coordinate.longitude
    listing.coordinateSource = coordinate.source
    listing.coordinateVerified = coordinate.level === 'verified'
    listing.coordinateLevel = coordinate.level
    listing.coordinateAccuracy = coordinate.level
    listing.coordinateStatus = coordinate.status
    listing.coordinateUpdatedAt = now
  })
}

async function backfill(db = {}, options = {}) {
  const key = config.qqMap && config.qqMap.webserviceKey
  const dryRun = Boolean(options.dryRun)
  const refresh = Boolean(options.refresh)
  const blockCenterOnly = Boolean(options.blockCenterOnly)
  // --geocode-only：只持久化『真地理编码(approximate)』结果，跳过 block-center 兜底写库。
  // 因为持久化的 block-center 坐标会经 mapCoordinateFromListing 上地图，违反「地图页只展可靠坐标」的决定；
  // 库外小区的 block-center 助手半径召回已由运行时 place-locator.listingCoordinate 兜底(无需写库)。
  const geocodeOnly = Boolean(options.geocodeOnly)
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Number(options.limit) : Infinity
  const groups = groupActiveListingsByCommunity(db, { refresh })
  const rows = []
  let changedListings = 0

  for (const [community, listings] of groups) {
    if (rows.length >= limit) break
    const sample = listings[0] || {}
    let coordinate = null
    const verified = coordinateByCommunity(community)
    if (verified) {
      coordinate = {
        latitude: verified.latitude,
        longitude: verified.longitude,
        source: verified.source || 'community-coordinate',
        level: 'verified',
        status: '已确认小区坐标'
      }
    }
    if (!coordinate && !blockCenterOnly) {
      coordinate = await geocodeByTencent(addressForListing(sample), key)
    }
    if (!coordinate && !geocodeOnly) coordinate = blockCenterCoordinate(sample)
    if (!coordinate) {
      rows.push({ community, count: listings.length, level: 'missing', source: '', changed: 0 })
      continue
    }
    if (!dryRun) applyCoordinate(listings, coordinate)
    changedListings += listings.length
    rows.push({
      community,
      count: listings.length,
      level: coordinate.level,
      source: coordinate.source,
      changed: listings.length
    })
  }

  return {
    dryRun,
    refresh,
    totalCommunities: groups.size,
    processedCommunities: rows.length,
    changedListings,
    hasTencentKey: Boolean(key),
    rows
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const refresh = args.includes('--refresh')
  const blockCenterOnly = args.includes('--block-center-only')
  const geocodeOnly = args.includes('--geocode-only')
  const limitArg = args.find((item) => item.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity
  const db = dbStore.readDb()
  const result = await backfill(db, { dryRun, refresh, blockCenterOnly, geocodeOnly, limit })
  if (!dryRun) dbStore.writeDb(db)
  console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error)
    process.exit(1)
  })
}

module.exports = {
  backfill,
  groupActiveListingsByCommunity,
  geocodeByTencent,
  blockCenterCoordinate
}
