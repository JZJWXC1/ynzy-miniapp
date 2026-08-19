const apiClient = require('./api-client')
const { getRuntimeConfig, shouldUseMock } = require('./api-config')
const mockData = require('./mock-data')
const listingDisplay = require('./listing-display')
const listingFilterOptions = require('./listing-filter-options')
const companySheetSnapshotContract = require('./company-sheet-snapshot-contract')
const { anonymousPublicRequestData } = require('./public-request-safety')
const OFFICIAL_COMMUNITY_KEYS = new Set(require('./gongshu-communities')
  .map((name) => String(name || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase())
  .filter(Boolean))

const ASSISTANT_CHAT_TIMEOUT_MS = 60000
const LISTING_SOURCE_TYPES = ['公司房源', '业主房源', '二房东房源']

function mockListingAccessFilter(filter) {
  const viewer = assertMockOptionalAuthorization()
  return Object.assign({}, filter || {}, {
    publicGuest: !viewer,
    viewerId: viewer && viewer.id ? viewer.id : ''
  })
}

function currentMockToken() {
  return String(typeof apiClient.getAuthToken === 'function' ? (apiClient.getAuthToken() || '') : '').trim()
}

function resolveMockViewer() {
  const token = currentMockToken()
  if (typeof mockData.resolveAuthSession !== 'function') return null
  return mockData.resolveAuthSession(token)
}

function mockUnauthorizedError() {
  const error = new Error('请先登录内部中介账号')
  error.statusCode = 401
  error.data = { authFailurePhase: 'pre_execution' }
  return error
}

function requireMockLogin() {
  const currentUser = resolveMockViewer()
  if (currentUser && currentUser.id) return currentUser
  throw mockUnauthorizedError()
}

function runAuthenticatedMock(action) {
  const user = requireMockLogin()
  return action(user)
}

function assertMockOptionalAuthorization() {
  const token = currentMockToken()
  const viewer = resolveMockViewer()
  if (token && !viewer) throw mockUnauthorizedError()
  return viewer
}

function isMissingEndpoint(error) {
  const message = error && error.message ? error.message : ''
  return Boolean(error && (error.statusCode === 404 || message.indexOf('接口不存在') !== -1 || message.indexOf('404') !== -1))
}

const MAP_DEFAULT_CENTER = {
  latitude: 30.3192,
  longitude: 120.1694
}

function mapNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function mapRent(value) {
  const number = Number(value)
  if (Number.isFinite(number)) return number
  const matched = String(value || '').match(/(\d+(?:\.\d+)?)/)
  return matched ? Number(matched[1]) : 0
}

function firstNumber(value) {
  const matched = String(value || '').match(/\d+/)
  return matched ? Number(matched[0]) : 0
}

function makeTempNeedId() {
  return `TMP-NEED-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

function makeTempThreadId() {
  return `LOCAL-AST-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

function createSensitiveViewIdempotencyKey() {
  const random = [Math.random(), Math.random(), Math.random()]
    .map((value) => value.toString(36).slice(2, 12))
    .join('')
  return `sensitive_${Date.now().toString(36)}_${random}`.slice(0, 128)
}

function normalizeNeedResponse(result, payload, temporary) {
  const data = result || {}
  const need = data.need || data.rentalNeed || payload || {}
  const needId = data.needId || data.id || need.id || makeTempNeedId()
  return Object.assign({}, data, {
    id: needId,
    needId,
    temporary: Boolean(temporary || data.temporary),
    need: Object.assign({}, need, { id: needId, needId })
  })
}

function listFromProfile(profile, keys) {
  const data = profile || {}
  for (let i = 0; i < keys.length; i += 1) {
    if (Array.isArray(data[keys[i]])) return data[keys[i]]
  }
  return []
}

function findReminderCount(profile, patterns) {
  const reminders = listFromProfile(profile, ['reminders'])
  const row = reminders.find((item) => {
    const text = `${item.title || ''}${item.value || ''}${item.desc || ''}`
    return patterns.some((pattern) => pattern.test(text))
  })
  return row ? firstNumber(row.value || row.desc || row.title) : 0
}

function findSourceStatCount(profile, patterns) {
  const stats = listFromProfile(profile, ['sourceStats'])
  const row = stats.find((item) => {
    const text = `${item.label || ''}${item.title || ''}`
    return patterns.some((pattern) => pattern.test(text))
  })
  return row ? firstNumber(row.value) : 0
}

function buildTodayTasksFromProfile(profile) {
  const commissions = listFromProfile(profile, ['commissions', 'commissionRecords'])
  const footprints = listFromProfile(profile, ['footprints', 'sensitiveFootprints'])

  const pendingCommissions = commissions.filter((item) => String(item.status || '').indexOf('已确认') === -1).length ||
    findSourceStatCount(profile, [/待分佣/, /待确认分佣/])
  const confirmedCommissions = commissions.filter((item) => String(item.status || '').indexOf('已确认') !== -1).length
  const maintenanceCount = findReminderCount(profile, [/房态/, /维护/, /核验/])
  const expiringCount = findReminderCount(profile, [/即将失效/, /失效/, /第\s*7\s*天/, /7\s*天/])

  const tasks = [
    {
      type: 'maintenance',
      title: '待维护房源',
      count: maintenanceCount,
      unit: '套',
      desc: maintenanceCount ? '按第 3 天、第 5 天提醒优先电话核验。' : '暂无需要维护的房源。',
      url: '/pages/my-listings/my-listings',
      tone: 'green'
    },
    {
      type: 'expiring',
      title: '即将失效房源',
      count: expiringCount,
      unit: '套',
      desc: expiringCount ? '第 7 天未更新会自动失效，先处理临期房源。' : '暂无临期失效房源。',
      url: '/pages/my-listings/my-listings',
      tone: 'orange'
    },
    {
      type: 'commissions',
      title: '分佣提醒',
      count: pendingCommissions,
      unit: '笔',
      desc: `待确认 ${pendingCommissions} 笔，已确认 ${confirmedCommissions} 笔。`,
      url: '/pages/commissions/commissions',
      tone: 'yellow'
    },
    {
      type: 'footprints',
      title: '敏感查看留痕',
      count: footprints.length,
      unit: '条',
      desc: footprints.length ? '复盘地址、电话查看记录，防跳单留痕。' : '暂无新的敏感查看记录。',
      url: '/pages/footprint/footprint',
      tone: 'gray'
    }
  ]

  return {
    summary: {
      pendingCount: tasks.reduce((sum, item) => sum + Number(item.count || 0), 0),
      updatedAt: profile && profile.updatedAt ? profile.updatedAt : ''
    },
    tasks,
    profile
  }
}

function truthyMapFlag(value) {
  if (value === true) return true
  if (value === false || value === undefined || value === null) return false
  return /^(1|true|yes|y|是|已确认|已验证)$/i.test(String(value).trim())
}

function isDefaultMapCoordinate(latitude, longitude) {
  return Math.abs(latitude - MAP_DEFAULT_CENTER.latitude) < 0.000001 &&
    Math.abs(longitude - MAP_DEFAULT_CENTER.longitude) < 0.000001
}

function isReliableMapCoordinateSource(source) {
  const text = String(source || '').trim().toLowerCase()
  if (!text) return false
  return !/estimated|estimate|hash|random|default|offset|scatter|legacy|area|pending/.test(text)
}

function mapMockCoordinate(item = {}) {
  const latitude = mapNumber(item.latitude)
  const longitude = mapNumber(item.longitude)
  const source = item.coordinateSource || ''
  if (latitude === null || longitude === null) return null
  if (isDefaultMapCoordinate(latitude, longitude)) return null
  if (!isReliableMapCoordinateSource(source)) return null
  if (/listing-coordinate|manual|hand|手填/.test(String(source).toLowerCase()) && !truthyMapFlag(item.coordinateVerified)) return null
  return { latitude, longitude, source }
}

function mapFilterList(value) {
  const values = Array.isArray(value) ? value : [value]
  return values
    .reduce((list, item) => list.concat(String(item || '').split(/[,，]/)), [])
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeMapMockFilter(filter = {}) {
  const north = mapNumber(filter.north)
  const south = mapNumber(filter.south)
  const east = mapNumber(filter.east)
  const west = mapNumber(filter.west)
  return {
    north,
    south,
    east,
    west,
    hasBounds: [north, south, east, west].every((item) => item !== null),
    rentMin: mapNumber(filter.rentMin),
    rentMax: mapNumber(filter.rentMax),
    layout: String(filter.layout || '').trim(),
    rentMode: String(filter.rentMode || '').trim(),
    sourceType: String(filter.sourceType || '').trim(),
    companyOnly: filter.companyOnly === true || filter.companyOnly === 'true' || filter.companyOnly === 1 || filter.companyOnly === '1',
    district: String(filter.district || '').trim(),
    block: String(filter.block || '').trim(),
    area: String(filter.area || filter.region || '').trim(),
    community: String(filter.community || '').trim(),
    listingIds: mapFilterList(filter.listingIds)
  }
}

function mapMockCoordinateInBounds(coordinate, filter) {
  if (!filter.hasBounds) return true
  return coordinate.latitude <= filter.north &&
    coordinate.latitude >= filter.south &&
    coordinate.longitude <= filter.east &&
    coordinate.longitude >= filter.west
}

function mapMockSourceText(item = {}, listing = {}) {
  return [
    item.source,
    item.sourceType,
    item.sourceLabel,
    item.listingType,
    item.inventoryType,
    item.category,
    item.ownerType,
    item.houseSourceType,
    listing.sourceType,
    listing.sourceLabel,
    listing.source
  ].map((part) => String(part || '')).join(' ')
}

function mapMockLocationText(item = {}) {
  return [
    item.city,
    item.district,
    item.area,
    item.block,
    item.community
  ].map((part) => String(part || '')).join('')
}

function normalizedPublicCommunityKey(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

function normalizedStructuredDistrict(value) {
  return String(value || '').normalize('NFKC').trim().replace(/区$/, '')
}

function normalizedStructuredBlock(value) {
  return String(value || '').normalize('NFKC').trim()
}

function mapMockStructuredDistrictMatches(item = {}, requested = '') {
  const expected = normalizedStructuredDistrict(requested)
  if (!expected) return true
  return [item.district, item.area]
    .map(normalizedStructuredDistrict)
    .filter(Boolean)
    .indexOf(expected) !== -1
}

function mapMockStructuredBlockMatches(item = {}, requested = '') {
  const expected = normalizedStructuredBlock(requested)
  if (!expected) return true
  return normalizedStructuredBlock(item.block) === expected
}

function mapMockLocationMatches(item = {}, requested = '') {
  const expected = String(requested || '').trim()
  if (!expected) return true
  const expectedKey = normalizedPublicCommunityKey(expected)
  if (OFFICIAL_COMMUNITY_KEYS.has(expectedKey)) {
    return normalizedPublicCommunityKey(item.community) === expectedKey
  }
  return mapMockLocationText(item).indexOf(expected) !== -1
}

function mapMockCommunityMatches(actual, requested = '') {
  const expected = String(requested || '').trim()
  if (!expected) return true
  const expectedKey = normalizedPublicCommunityKey(expected)
  const actualKey = normalizedPublicCommunityKey(actual)
  return OFFICIAL_COMMUNITY_KEYS.has(expectedKey)
    ? actualKey === expectedKey
    : String(actual || '').indexOf(expected) !== -1
}

function mapMockStaleDays(item = {}, listing = {}) {
  const direct = Number(item.staleDays !== undefined ? item.staleDays : listing.staleDays)
  if (Number.isFinite(direct)) return direct
  const text = item.lastVerifiedAt || item.updatedAt || item.createdAt || listing.lastVerifiedAt || ''
  const time = Date.parse(String(text || '').replace(/\//g, '-'))
  return Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 86400000)) : 0
}

function isMapMockActive(item = {}, listing = {}) {
  const statusText = [item.lifecycleStatus, item.status, listing.lifecycleStatus, listing.status].map((part) => String(part || '')).join(' ')
  if (/expired|已失效|已下架/.test(statusText)) return false
  return mapMockStaleDays(item, listing) < 7
}

function safeMapMockListing(item = {}) {
  const listing = listingDisplay.normalizeListing(item || {})
  const hasVideo = Boolean(listing.hasVideo || listing.video || listing.videoUrl || listing.videoKey || item.videoUrl || item.videoKey)
  return {
    id: listing.id,
    rent: mapRent(listing.rent || listing.price || item.price),
    layout: listing.layout || '',
    rentMode: listing.rentMode || listing.type || item.type || '',
    sourceType: listing.sourceType || listing.sourceLabel || listing.source || item.source || '',
    companyListing: Boolean(listing.companyListing),
    maintenanceText: listing.maintenanceText || item.maintenanceText || '',
    lastVerifiedAt: listing.lastVerifiedAt || item.lastVerifiedAt || '',
    hasVideo,
    video: hasVideo ? '已传视频' : ''
  }
}

function publicMapMockListing(listing = {}) {
  return {
    id: listing.id,
    rent: listing.rent,
    layout: listing.layout || '',
    rentMode: listing.rentMode || '',
    sourceType: listing.sourceType || '',
    lastVerifiedAt: listing.lastVerifiedAt || '',
    maintenanceText: listing.maintenanceText || '',
    hasVideo: Boolean(listing.hasVideo),
    video: listing.video || ''
  }
}

function mapMockRoomCount(value = '') {
  const matched = String(value || '').match(/([一二两三四五六七八九]|\d+)\s*室/)
  if (!matched) return 0
  const numbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  return numbers[matched[1]] || Number(matched[1]) || 0
}

function mapMockMatchesLayout(item = {}, listing = {}, requested = '') {
  const filter = String(requested || '').trim()
  if (!filter || filter === '不限') return true
  const roomCount = mapMockRoomCount([
    listing.layout,
    item.layout,
    item.room,
    item.type,
    item.rentMode
  ].map((part) => String(part || '')).join(' '))
  if (filter === '一室') return roomCount === 1
  if (filter === '两室' || filter === '二室') return roomCount === 2
  if (filter === '三室') return roomCount === 3
  if (filter === '三室以上') return roomCount >= 3
  return String(listing.layout || item.layout || '').indexOf(filter) !== -1
}

function mapMockMatchesFilter(item = {}, listing = {}, filter) {
  if (filter.listingIds.length && filter.listingIds.indexOf(String(listing.id || item.id || '')) === -1) return false
  if (filter.companyOnly && !listing.companyListing) return false
  const rent = mapRent(listing.rent || item.rent || item.price)
  if (filter.rentMin !== null && rent < filter.rentMin) return false
  if (filter.rentMax !== null && rent > filter.rentMax) return false
  if (!mapMockMatchesLayout(item, listing, filter.layout)) return false
  if (filter.rentMode && String(listing.rentMode || item.rentMode || item.type || item.layout || '').indexOf(filter.rentMode) === -1) return false
  if (filter.sourceType && filter.sourceType !== '全部') {
    if (LISTING_SOURCE_TYPES.indexOf(filter.sourceType) !== -1) {
      if (listing.sourceType !== filter.sourceType) return false
    } else if (mapMockSourceText(item, listing).indexOf(filter.sourceType) === -1) {
      return false
    }
  }
  if (!mapMockStructuredDistrictMatches(item, filter.district)) return false
  if (!mapMockStructuredBlockMatches(item, filter.block)) return false
  if (!mapMockLocationMatches(item, filter.area)) return false
  if (!mapMockCommunityMatches(item.community, filter.community)) return false
  return true
}

function pushUnique(list, value) {
  const text = String(value || '').trim()
  if (text && list.indexOf(text) === -1) list.push(text)
}

function mockMapCommunities(filter = {}) {
  const normalizedFilter = normalizeMapMockFilter(filter)
  const groups = {}
  ;(mockData.getMapPins(filter) || []).forEach((item) => {
    const coordinate = mapMockCoordinate(item)
    if (!coordinate) return
    if (!mapMockCoordinateInBounds(coordinate, normalizedFilter)) return
    const listing = safeMapMockListing(item)
    if (!isMapMockActive(item, listing)) return
    if (!mapMockMatchesFilter(item, listing, normalizedFilter)) return
    const community = String(item.community || '').trim()
    if (!community) return
    const district = String(item.district || item.area || '').normalize('NFKC').trim()
    const block = String(item.block || '').normalize('NFKC').trim()
    const groupKey = JSON.stringify([district, block, community])
    if (!groups[groupKey]) {
      const approximate = /guest-community-approximate|block-center|approximate/i.test(String(coordinate.source || ''))
      groups[groupKey] = {
        groupId: `MAP-MOCK-${encodeURIComponent(groupKey)}`,
        district,
        block,
        community,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        coordinateSource: coordinate.source,
        coordinateVerified: !approximate,
        coordinateLevel: approximate ? 'approximate' : 'verified',
        coordinateAccuracy: approximate ? 'approximate' : 'verified',
        coordinateStatus: approximate ? '小区位置' : '已确认小区坐标',
        coordinateLabel: approximate ? '小区位置' : '已确认小区坐标',
        coordinateCalloutNote: approximate ? '近似位置' : '',
        listingCount: 0,
        minRent: 0,
        maxRent: 0,
        activeListingIds: [],
        layouts: [],
        sourceTypes: [],
        listings: []
      }
    }
    const group = groups[groupKey]
    const rent = mapRent(listing.rent)
    group.listingCount += 1
    group.minRent = group.minRent ? Math.min(group.minRent, rent) : rent
    group.maxRent = Math.max(group.maxRent, rent)
    group.activeListingIds.push(listing.id)
    pushUnique(group.layouts, listing.layout)
    pushUnique(group.sourceTypes, listing.sourceType)
    group.listings.push(publicMapMockListing(listing))
  })
  return Object.keys(groups)
    .map((key) => groups[key])
    .sort((left, right) => {
      if (left.minRent !== right.minRent) return left.minRent - right.minRent
      return left.community.localeCompare(right.community, 'zh-CN')
    })
}

function getHomeListings() {
  return apiClient.call({
    path: '/mini/home/listings',
    publicReadAuthFallback: true,
    mock: () => mockData.getHomeListings(mockListingAccessFilter())
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function buildQuery(params) {
  const query = Object.keys(params || {})
    .filter((key) => {
      if (Array.isArray(params[key])) return params[key].filter(Boolean).length > 0
      return params[key] !== undefined && params[key] !== null && params[key] !== ''
    })
    .map((key) => {
      const value = Array.isArray(params[key]) ? params[key].filter(Boolean).join(',') : params[key]
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
  return query ? `?${query}` : ''
}

function getListings(filter) {
  const query = buildQuery(filter || {})
  return apiClient.call({
    path: `/mini/listings${query}`,
    publicReadAuthFallback: true,
    mock: () => mockData.getListings(mockListingAccessFilter(filter))
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function listingFilterOptionsFromListings(listings) {
  const regions = new Map()
  ;(listings || []).forEach((listing) => {
    const district = String(listing && (listing.district || listing.area) || '').trim()
    const block = String(listing && listing.block || '').trim()
    if (!district) return
    if (!regions.has(district)) regions.set(district, new Set())
    if (block) regions.get(district).add(block)
  })
  return listingFilterOptions.normalizeListingFilterOptions({
    regionOptions: Array.from(regions.entries()).map(([name, blocks]) => ({
      name,
      blocks: Array.from(blocks)
    }))
  })
}

function getListingFilterOptions() {
  return apiClient.call({
    path: '/mini/listing-filter-options',
    publicReadAuthFallback: true,
    // Mock 也必须从当前公开有效房源派生，避免新增行政区或板块后仅真机接口生效。
    mock: () => listingFilterOptionsFromListings(mockData.getListings(mockListingAccessFilter({})))
  }).then((payload) => listingFilterOptions.normalizeListingFilterOptions(payload))
}

function getCompanyListings() {
  return getListings({ category: '公司房源' })
}

function getFavoriteIds() {
  return apiClient.call({
    path: '/mini/favorites/ids',
    // 首页/列表卡片只把收藏态作为可选个性化；失效 token 不得阻断公共房源渲染。
    publicReadAuthFallback: true,
    mock: () => {
      requireMockLogin()
      return mockData.getFavoriteIds()
    }
  }).then((ids) => (ids || []).map((id) => String(id || '')).filter(Boolean)).catch((error) => {
    // 公开读取降级完成后，匿名访问收藏端点仍会收到 401。仅在当前已无登录态时回退空集合；
    // 若用户已切换到另一账号，则保留错误，禁止旧响应吞掉新会话异常。
    if (error && Number(error.statusCode) === 401 && !currentMockToken()) return []
    throw error
  })
}

function getFavorites(filter) {
  const query = buildQuery(filter || {})
  return apiClient.call({
    path: `/mini/favorites${query}`,
    mock: () => {
      requireMockLogin()
      return mockData.getFavorites(filter || {})
    }
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function setFavorite(listingId, desired) {
  const id = String(listingId || '').trim()
  return apiClient.call({
    path: `/mini/favorites/${encodeURIComponent(id)}`,
    method: desired ? 'PUT' : 'DELETE',
    mock: () => {
      requireMockLogin()
      return mockData.setFavorite(id, Boolean(desired))
    }
  })
}

function buildMockCompanySheetSnapshotV1() {
  return {
    title: '寓你住一起房源表',
    updatedAt: '',
    rows: [[
      '行政区',
      '板块/商圈',
      '小区',
      '小区+房号',
      '户型描述',
      '户型分类',
      '月租金',
      '看房方式',
      '备注',
      '房源状态'
    ]],
    rowCount: 1,
    columnCount: 10,
    unavailable: true,
    sensitiveStripped: true,
    sourceMode: 'feishu-mini-mirror-v1',
    schemaVersion: 1
  }
}

function buildMockCompanySheetSnapshotV2() {
  const snapshot = {
    contract: companySheetSnapshotContract.CONTRACT,
    sourceMode: companySheetSnapshotContract.SOURCE_MODE,
    schemaVersion: companySheetSnapshotContract.SCHEMA_VERSION,
    minReaderVersion: companySheetSnapshotContract.MIN_READER_VERSION,
    columnKeys: companySheetSnapshotContract.COLUMN_KEYS.slice(),
    title: '寓你住一起房源表',
    updatedAt: '',
    unavailable: true,
    rows: [],
    dataRowCount: 0,
    columnCount: 10,
    contentSha256: '',
    snapshotId: '',
    sensitiveStripped: true
  }
  snapshot.contentSha256 = companySheetSnapshotContract.contentSha256Of(snapshot)
  snapshot.snapshotId = `company-sheet-v2:${snapshot.contentSha256}`
  return snapshot
}

function getLegacyCompanySheetSnapshot() {
  return apiClient.call({
    path: '/mini/company-sheet-snapshot',
    publicReadAuthFallback: true,
    mock: () => {
      assertMockOptionalAuthorization()
      return buildMockCompanySheetSnapshotV1()
    }
  })
}

function getCompanySheetSnapshot() {
  return apiClient.call({
    path: '/mini/v2/company-sheet-snapshot',
    publicReadAuthFallback: true,
    mock: () => {
      assertMockOptionalAuthorization()
      return buildMockCompanySheetSnapshotV2()
    }
  }).then((snapshot) => {
    const parsed = companySheetSnapshotContract.parseCompanySheetSnapshotV2(snapshot)
    if (parsed) return parsed
    const error = new Error('房源表 v2 数据契约校验失败')
    error.code = 'INVALID_COMPANY_SHEET_SNAPSHOT_V2'
    throw error
  }).catch((error) => {
    // 仅“服务器明确返回 HTTP 404”代表旧版本尚未提供 v2 路由；网络错误、5xx 与坏契约
    // 都可能是发布链路异常，必须原样失败，不能回退旧快照掩盖数据错位。
    if (!error || Number(error.statusCode) !== 404) throw error
    return getLegacyCompanySheetSnapshot()
  })
}

function normalizeAuthUser(result) {
  if (!result || !result.user) return result
  return Object.assign({}, result.user, {
    token: result.token,
    tokenExpiresAt: result.tokenExpiresAt
  })
}

function mockAuthPayload(user) {
  if (!user || !user.id || typeof mockData.issueAuthSession !== 'function') throw mockUnauthorizedError()
  const session = mockData.issueAuthSession(user.id)
  return Object.assign({ user }, session)
}

function loginByPhone(phone, password) {
  return apiClient.call({
    path: '/mini/auth/login',
    method: 'POST',
    data: { phone, password },
    mock: () => {
      assertMockOptionalAuthorization()
      return mockAuthPayload(mockData.loginByPhone(phone))
    }
  }).then(normalizeAuthUser)
}

function logout() {
  return apiClient.call({
    path: '/mini/auth/logout',
    method: 'POST',
    mock: () => {
      requireMockLogin()
      return mockData.logout(currentMockToken())
    }
  })
}

function registerUser(form) {
  return apiClient.call({
    path: '/mini/auth/register',
    method: 'POST',
    data: form,
    mock: () => {
      assertMockOptionalAuthorization()
      return mockData.registerUser(form)
    }
  }).then(normalizeAuthUser)
}

function getCurrentUser() {
  return apiClient.call({
    path: '/mini/auth/me',
    mock: () => requireMockLogin()
  })
}

function bindWechatOpenid(code) {
  return apiClient.call({
    path: '/mini/auth/wechat-openid',
    method: 'POST',
    data: { code },
    mock: () => requireMockLogin()
  })
}

function changePassword(oldPassword, newPassword) {
  return apiClient.call({
    path: '/mini/auth/password',
    method: 'POST',
    data: { oldPassword, newPassword },
    mock: () => {
      const user = requireMockLogin()
      mockData.revokeAuthSessionsForUser(user.id)
      return mockAuthPayload(user)
    }
  }).then(normalizeAuthUser)
}

function matchListings(condition) {
  return apiClient.call({
    path: '/mini/listings/match',
    method: 'POST',
    data: condition,
    publicReadAuthFallback: true,
    retryAnonymousOnAuthFailure: true,
    buildAnonymousRetryData: anonymousPublicRequestData,
    mock: (requestData) => mockData.matchListings(mockListingAccessFilter(requestData || condition))
  }).then((result) => Object.assign({}, result, {
    listings: listingDisplay.normalizeListings((result && result.listings) || [])
  }))
}

function chatAssistant(payload) {
  const data = payload || {}
  return apiClient.call({
    path: '/mini/assistant/chat',
    method: 'POST',
    data,
    timeout: ASSISTANT_CHAT_TIMEOUT_MS,
    publicReadAuthFallback: true,
    retryAnonymousOnAuthFailure: true,
    buildAnonymousRetryData: anonymousPublicRequestData,
    mock: (requestData) => {
      assertMockOptionalAuthorization()
      const safeData = requestData || data
      const need = safeData.need || safeData.form || {}
      // 助手结果始终使用公共投影：登录只影响写操作和后续敏感查看，不能让
      // 本地 Mock 在普通对话中提前下发合作房源精确地址或内部审核字段。
      const result = mockData.matchListings(Object.assign({}, need, { publicGuest: true }))
      const listings = listingDisplay.normalizeListings((result && result.listings) || [])
      const nextQuestion = listings.length ? '' : '预算、区域和户型里先补充两个条件？'
      return {
        threadId: safeData.threadId || makeTempThreadId(),
        reply: listings.length ? `先看这${listings.length}套真实房源。` : nextQuestion,
        nextQuestion,
        intent: 'rental_match',
        need,
        listings,
        exactListings: listings,
        nearbyListings: [],
        mode: 'local-graph-assistant-v1'
      }
    }
  }).then((result) => Object.assign({}, result, {
    listings: listingDisplay.normalizeListings((result && result.listings) || []),
    exactListings: listingDisplay.normalizeListings((result && result.exactListings) || []),
    nearbyListings: listingDisplay.normalizeListings((result && result.nearbyListings) || [])
  }))
}

function submitAssistantFeedback(payload) {
  const data = payload || {}
  return apiClient.call({
    path: '/mini/assistant/feedback',
    method: 'POST',
    data,
    publicReadAuthFallback: true,
    retryAnonymousOnAuthFailure: true,
    buildAnonymousRetryData: anonymousPublicRequestData,
    mock: (requestData) => {
      assertMockOptionalAuthorization()
      const currentData = requestData || {}
      return ({
      id: makeTempThreadId().replace('LOCAL-AST', 'LOCAL-AF'),
      status: 'open',
        feedbackType: currentData.feedbackType || 'other'
      })
    }
  })
}

function getMapCommunities(filter) {
  const query = buildQuery(filter || {})
  return apiClient.call({
    path: `/mini/map/communities${query}`,
    publicReadAuthFallback: true,
    mock: () => mockMapCommunities(mockListingAccessFilter(filter))
  })
}

function getMapPins(filter) {
  const query = buildQuery(filter || {})
  return apiClient.call({
    path: `/mini/map/pins${query}`,
    publicReadAuthFallback: true,
    mock: () => mockMapCommunities(mockListingAccessFilter(filter))
  })
}

function normalizeNearbyResult(result) {
  const source = result && typeof result === 'object' ? result : {}
  const listings = listingDisplay.normalizeListings(Array.isArray(source.listings) ? source.listings : [])
  const total = Math.max(listings.length, Number(source.total) || 0)
  return {
    radiusKm: Number(source.radiusKm) || 3,
    total,
    hasMore: Boolean(source.hasMore || total > listings.length),
    listings
  }
}

function getListingDetail(id, options = {}) {
  return apiClient.call({
    path: `/mini/listings/${id}`,
    omitAuth: options.anonymous === true,
    publicReadAuthFallback: true,
    mock: () => mockData.getListingDetail(
      id,
      options.anonymous === true
        ? { publicGuest: true, viewerId: '' }
        : mockListingAccessFilter()
    )
  }).then((listing) => {
    if (listing && listing.unavailable) return listing
    const normalized = listingDisplay.normalizeListing(listing)
    if (normalized) normalized.nearby = normalizeNearbyResult(listing && listing.nearby)
    return normalized
  })
}

function getNearbyListings(id) {
  const listingId = String(id || '').trim()
  return apiClient.call({
    path: `/mini/listings/${encodeURIComponent(listingId)}/nearby?all=1`,
    publicReadAuthFallback: true,
    mock: () => mockData.getNearbyListings(listingId, mockListingAccessFilter({ all: true }))
  }).then(normalizeNearbyResult)
}

function getListingLogs(id) {
  return apiClient.call({
    path: `/mini/listings/${id}/footprints`,
    mock: () => {
      requireMockLogin()
      return mockData.getListingLogs(id)
    }
  })
}

function addSensitiveFootprint(listingId, idempotencyKey) {
  const key = String(idempotencyKey || '').trim() || createSensitiveViewIdempotencyKey()
  const payload = { idempotencyKey: key }
  return apiClient.call({
    path: `/mini/listings/${listingId}/sensitive-view`,
    method: 'POST',
    data: payload,
    mock: () => {
      requireMockLogin()
      return mockData.addSensitiveFootprint(listingId, payload)
    }
  })
}

function recordPhoneCallOpened(listingId, idempotencyKey) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/phone-call-opened`,
    method: 'POST',
    data: { idempotencyKey },
    mock: () => {
      requireMockLogin()
      return mockData.recordPhoneCallOpened(listingId, { idempotencyKey })
    }
  })
}

function recordVideoShare(listingId, payload, options = {}) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/video-share`,
    method: 'POST',
    data: payload || {},
    silentAuthFailure: options.silentAuthFailure === true,
    mock: () => {
      requireMockLogin()
      return mockData.recordVideoShare(listingId, payload || {})
    }
  })
}

function recordShowing(listingId, payload) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/showings`,
    method: 'POST',
    data: payload || {},
    mock: () => {
      requireMockLogin()
      return mockData.recordShowing(listingId, payload || {})
    }
  }).catch((error) => {
    if (isMissingEndpoint(error)) {
      throw new Error('线上后端还没有水印带看审核接口，请先发布或重启后端服务。')
    }
    throw error
  })
}

function getClientReports() {
  return apiClient.call({
    path: '/mini/reports',
    mock: () => runAuthenticatedMock(() => mockData.getClientReports())
  })
}

function createClientReport(listingId, payload) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/reports`,
    method: 'POST',
    data: payload || {},
    mock: () => runAuthenticatedMock(() => mockData.createClientReport(listingId, payload || {}))
  })
}

function getDealRecords() {
  return apiClient.call({
    path: '/mini/deals',
    mock: () => runAuthenticatedMock(() => mockData.getDealRecords())
  })
}

function createDealFromReport(reportId, payload) {
  return apiClient.call({
    path: `/mini/reports/${reportId}/deals`,
    method: 'POST',
    data: payload || {},
    mock: () => runAuthenticatedMock(() => mockData.createDealFromReport(reportId, payload || {}))
  })
}

function registerDeal(listingId) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/deals`,
    method: 'POST',
    data: {},
    mock: () => {
      requireMockLogin()
      const error = new Error('客户报备与签单功能已暂停')
      error.statusCode = 410
      error.data = { reason: 'REPORT_DEAL_PAUSED' }
      throw error
    }
  })
}

function getFootprintRecords() {
  return apiClient.call({
    path: '/mini/footprints',
    mock: () => runAuthenticatedMock(() => mockData.getFootprintRecords())
  })
}

function getOwnedListings() {
  return apiClient.call({
    path: '/mini/my/listings',
    mock: () => runAuthenticatedMock(() => mockData.getOwnedListings())
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function verifyMyListing(id, outcome) {
  return apiClient.call({
    path: `/mini/my/listings/${id}/verify`,
    method: 'POST',
    data: outcome ? { outcome: outcome } : {},
    mock: () => runAuthenticatedMock(() => mockData.verifyMyListing(id, outcome))
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function getEditableListing(id) {
  return apiClient.call({
    path: `/mini/my/listings/${id}`,
    mock: () => runAuthenticatedMock(() => mockData.getEditableListing(id))
  })
}

function updateNormalListing(id, form) {
  return apiClient.call({
    path: `/mini/my/listings/${id}`,
    method: 'PUT',
    data: form,
    mock: () => runAuthenticatedMock(() => mockData.updateNormalListing(id, form))
  })
}

function getProfileState() {
  return apiClient.call({
    path: '/mini/profile',
    mock: () => runAuthenticatedMock(() => mockData.getProfileState())
  })
}

function getTodayTasks() {
  if (!apiClient.getAuthToken()) {
    return Promise.resolve(buildTodayTasksFromProfile({}))
  }
  return apiClient.call({
    path: '/mini/today-tasks',
    mock: () => runAuthenticatedMock(() => buildTodayTasksFromProfile(mockData.getProfileState()))
  }).then((result) => {
    if (result && result.tasks) return result
    return buildTodayTasksFromProfile(result || {})
  }).catch(() => getProfileState().then(buildTodayTasksFromProfile))
}

function createRentalNeed(payload) {
  const data = payload || {}
  return apiClient.call({
    path: '/mini/rental-needs',
    method: 'POST',
    data,
    mock: () => runAuthenticatedMock(() => normalizeNeedResponse({
      message: '本地临时需求单已创建',
      temporary: true
    }, data, true))
  }).then((result) => normalizeNeedResponse(result, data, false)).catch((error) => {
    if (error && (error.statusCode === 401 || error.statusCode === 403)) throw error
    if (!shouldUseMock(getRuntimeConfig())) {
      throw error
    }
    const message = error && error.message ? error.message : '需求单接口暂不可用'
    return normalizeNeedResponse({
      message: `${message}，已使用临时需求单继续验证。`,
      temporary: true,
      warning: message
    }, data, true)
  })
}

function rechargePoints(points) {
  return apiClient.call({
    path: '/mini/points/recharge',
    method: 'POST',
    data: { points },
    mock: () => runAuthenticatedMock(() => mockData.rechargePoints(points))
  })
}

function getCommissionRecords() {
  return apiClient.call({
    path: '/mini/commissions',
    mock: () => runAuthenticatedMock(() => mockData.getCommissionRecords())
  })
}

function publicCommissionConfigMock(config) {
  const source = config || {}
  return {
    uploaderRates: Object.assign({}, source.uploaderRates || {}),
    platformRates: Object.assign({}, source.platformRates || {}),
    secondLandlordRate: source.secondLandlordRate,
    ownerRate: source.ownerRate,
    companyRate: 0,
    secondLandlordPlatformRate: source.secondLandlordPlatformRate,
    ownerPlatformRate: source.ownerPlatformRate,
    totalRate: Number.isFinite(Number(source.totalRate)) ? Number(source.totalRate) : 30
  }
}

function getCommissionConfig() {
  return apiClient.call({
    path: '/mini/commission-config',
    publicReadAuthFallback: true,
    mock: () => {
      assertMockOptionalAuthorization()
      return publicCommissionConfigMock(mockData.getCommissionConfig ? mockData.getCommissionConfig() : {
        secondLandlordRate: 20,
        ownerRate: 20,
        companyRate: 0,
        secondLandlordPlatformRate: 10,
        ownerPlatformRate: 10,
        uploaderRates: {
          '二房东房源': 20,
          '业主房源': 20,
          '公司房源': 0
        },
        platformRates: {
          '二房东房源': 10,
          '业主房源': 10,
          '公司房源': 0
        }
      })
    }
  })
}

function getGroupState() {
  return apiClient.call({
    path: '/mini/groups',
    mock: () => runAuthenticatedMock(() => mockData.getGroupState())
  }).then((state) => listingDisplay.normalizeGroupState(state))
}

function uploadGroupListing(form) {
  return apiClient.call({
    path: '/mini/groups/listings',
    method: 'POST',
    data: form || {},
    mock: () => runAuthenticatedMock(() => mockData.uploadGroupListing(form))
  }).then((state) => listingDisplay.normalizeGroupState(state))
}

function createGroupScreenshotUploadPolicy(fileInfo) {
  const info = fileInfo || {}
  return apiClient.call({
    path: '/mini/uploads/group-screenshot-policy',
    method: 'POST',
    data: {
      fileName: info.fileName || 'group-chat.jpg',
      mimeType: info.mimeType || 'image/jpeg',
      size: info.size || 0
    },
    mock: () => runAuthenticatedMock(() => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-group-screenshots/${Date.now()}.jpg`,
      fileUrl: info.tempFilePath || '',
      maxSize: 20 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回 OSS 截图直传凭证。'
    }))
  })
}

function createShowingPhotoUploadPolicy(fileInfo) {
  const info = fileInfo || {}
  return apiClient.call({
    path: '/mini/uploads/showing-photo-policy',
    method: 'POST',
    data: {
      fileName: info.fileName || 'showing-proof.jpg',
      mimeType: info.mimeType || 'image/jpeg',
      size: info.size || 0
    },
    mock: () => runAuthenticatedMock(() => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-showing-photos/${Date.now()}.jpg`,
      fileUrl: info.tempFilePath || '',
      maxSize: 20 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回带看水印照片直传凭证。'
    }))
  }).catch((error) => {
    if (!isMissingEndpoint(error)) throw error
    return createGroupScreenshotUploadPolicy({
      fileName: info.fileName || 'showing-proof.jpg',
      mimeType: info.mimeType || 'image/jpeg',
      size: info.size || 0,
      tempFilePath: info.tempFilePath || ''
    }).then((policy) => Object.assign({}, policy, {
      note: '后端带看专用上传接口尚未发布，已临时使用图片上传通道提交水印照片。'
    })).catch(() => {
      throw new Error('线上后端还没有水印照片上传接口，请先发布或重启后端服务。')
    })
  })
}

function createVideoUploadPolicy(fileInfo) {
  const info = fileInfo || {}
  return apiClient.call({
    path: '/mini/uploads/video-policy',
    method: 'POST',
    data: {
      fileName: info.fileName || 'listing-video.mp4',
      mimeType: info.mimeType || 'video/mp4',
      size: info.size || 0
    },
    mock: () => runAuthenticatedMock(() => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-videos/${Date.now()}.mp4`,
      fileUrl: info.tempFilePath || '',
      uploadTicket: `mock-video-upload-ticket-${Date.now()}`,
      maxSize: 300 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回 OSS 直传凭证。'
    }))
  })
}

function transcribeVoice(filePath, metadata) {
  const info = metadata || {}
  const config = getRuntimeConfig()
  return apiClient.uploadFile({
    url: apiClient.buildUrl(config.baseUrl, '/mini/asr/transcribe'),
    filePath,
    name: 'file',
    formData: {
      duration: info.duration || 0,
      fileSize: info.fileSize || info.size || 0,
      format: info.format || 'mp3',
      context: info.context || '找房小程序中介语音输入'
    },
    header: apiClient.authHeader(config),
    mock: () => {
      assertMockOptionalAuthorization()
      return {
        text: info.mockText || '拱墅万达附近2000左右的单间',
        provider: 'mock-asr',
        model: 'mock-qwen3-asr-flash',
        mode: 'mock'
      }
    }
  }).then((result) => result && result.data ? result.data : result)
}

function buildRealtimeAsrUrl() {
  const config = getRuntimeConfig()
  const httpUrl = apiClient.buildUrl(config.baseUrl, '/mini/asr/realtime')
  return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
}

function createRealtimeAsrSocket() {
  const config = getRuntimeConfig()
  if (shouldUseMock(config) || typeof wx === 'undefined' || !wx.connectSocket) return null
  const url = buildRealtimeAsrUrl()
  const socketTask = wx.connectSocket({
    url,
    header: apiClient.authHeader(config)
  })
  if (socketTask) socketTask.realtimeAsrUrl = url
  return socketTask
}

function uploadVideo(filePath, policy, options) {
  // 视频体积大，默认放宽到 5 分钟超时，避免弱网 15 秒必超时
  return uploadOssFile(filePath, policy, '视频上传配置不完整', Object.assign({ timeout: 300000 }, options || {}))
}

function uploadGroupScreenshot(filePath, policy) {
  return uploadOssFile(filePath, policy, '截图上传配置不完整')
}

function uploadShowingPhoto(filePath, policy) {
  return uploadOssFile(filePath, policy, '带看照片上传配置不完整')
}

function uploadOssFile(filePath, policy, missingMessage, options) {
  const uploadPolicy = policy || {}
  if (uploadPolicy.uploadMode === 'mock') {
    return Promise.resolve({
      fileUrl: uploadPolicy.fileUrl || filePath,
      objectKey: uploadPolicy.objectKey || '',
      uploadTicket: uploadPolicy.uploadTicket || ''
    })
  }

  if (!uploadPolicy.uploadUrl) {
    return Promise.reject(new Error(uploadPolicy.note || missingMessage || '文件上传配置不完整'))
  }

  const uploadOptions = options || {}
  return apiClient.uploadFile({
    url: uploadPolicy.uploadUrl,
    filePath,
    name: 'file',
    formData: uploadPolicy.formData || {},
    header: uploadPolicy.headers || {},
    timeout: uploadOptions.timeout,
    onProgress: uploadOptions.onProgress,
    mock: () => ({
      fileUrl: uploadPolicy.fileUrl || filePath,
      objectKey: uploadPolicy.objectKey || ''
    })
  }).then(() => ({
    fileUrl: uploadPolicy.fileUrl,
    objectKey: uploadPolicy.objectKey,
    uploadTicket: uploadPolicy.uploadTicket || ''
  }))
}

function unlockGroup(id) {
  return apiClient.call({
    path: `/mini/groups/${id}/unlock`,
    method: 'POST',
    data: {},
    mock: () => runAuthenticatedMock(() => mockData.unlockGroup(id))
  }).then((result) => result && result.data
    ? Object.assign({}, result, { data: listingDisplay.normalizeGroupState(result.data) })
    : result)
}

function addNormalListing(form) {
  return apiClient.call({
    path: '/mini/listings',
    method: 'POST',
    data: form,
    mock: () => runAuthenticatedMock(() => mockData.addNormalListing(form))
  })
}

module.exports = {
  getHomeListings,
  getListings,
  getListingFilterOptions,
  getCompanyListings,
  getFavoriteIds,
  getFavorites,
  setFavorite,
  getCompanySheetSnapshot,
  loginByPhone,
  logout,
  registerUser,
  getCurrentUser,
  bindWechatOpenid,
  changePassword,
  matchListings,
  chatAssistant,
  submitAssistantFeedback,
  transcribeVoice,
  buildRealtimeAsrUrl,
  createRealtimeAsrSocket,
  getMapCommunities,
  getMapPins,
  getListingDetail,
  getNearbyListings,
  getListingLogs,
  createSensitiveViewIdempotencyKey,
  addSensitiveFootprint,
  recordPhoneCallOpened,
  recordVideoShare,
  recordShowing,
  getClientReports,
  createClientReport,
  getDealRecords,
  createDealFromReport,
  registerDeal,
  getFootprintRecords,
  getOwnedListings,
  verifyMyListing,
  getEditableListing,
  updateNormalListing,
  getProfileState,
  getTodayTasks,
  createRentalNeed,
  rechargePoints,
  getCommissionRecords,
  getCommissionConfig,
  getGroupState,
  uploadGroupListing,
  createGroupScreenshotUploadPolicy,
  uploadGroupScreenshot,
  createShowingPhotoUploadPolicy,
  uploadShowingPhoto,
  createVideoUploadPolicy,
  uploadVideo,
  unlockGroup,
  addNormalListing,
  _internal: {
    mapMockRoomCount,
    mapMockMatchesLayout,
    mapMockMatchesFilter,
    mockMapCommunities
  }
}
