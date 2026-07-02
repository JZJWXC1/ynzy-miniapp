const apiClient = require('./api-client')
const { getRuntimeConfig, shouldUseMock } = require('./api-config')
const mockData = require('./mock-data')
const listingDisplay = require('./listing-display')

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
  const reports = listFromProfile(profile, ['reports', 'clientReports'])
  const deals = listFromProfile(profile, ['deals', 'dealRecords'])
  const commissions = listFromProfile(profile, ['commissions', 'commissionRecords'])
  const footprints = listFromProfile(profile, ['footprints', 'sensitiveFootprints'])

  const pendingReports = reports.filter((item) => {
    const status = String(item.status || '')
    return !item.dealId && status.indexOf('失效') === -1 && status.indexOf('取消') === -1
  }).length
  const pendingDeals = deals.filter((item) => {
    const status = String(item.status || '')
    return status.indexOf('已确认') === -1 && status.indexOf('已驳回') === -1
  }).length
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
      type: 'reports',
      title: '待跟进报备',
      count: pendingReports,
      unit: '条',
      desc: pendingReports ? '从报备记录继续发起签单或补充跟进。' : '暂无待跟进报备。',
      url: '/pages/client-reports/client-reports',
      tone: 'blue'
    },
    {
      type: 'deals',
      title: '待确认签单',
      count: pendingDeals,
      unit: '单',
      desc: pendingDeals ? '已提交签单等待管理员确认分佣。' : '暂无待确认签单。',
      url: '/pages/deal-records/deal-records',
      tone: 'red'
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
    area: String(filter.area || filter.region || '').trim(),
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
  return {
    id: listing.id,
    rent: mapRent(listing.rent || listing.price || item.price),
    layout: listing.layout || '',
    rentMode: listing.rentMode || listing.type || item.type || '',
    sourceType: listing.sourceType || listing.sourceLabel || listing.source || item.source || '',
    maintenanceText: listing.maintenanceText || item.maintenanceText || '',
    lastVerifiedAt: listing.lastVerifiedAt || item.lastVerifiedAt || '',
    hasVideo: Boolean(listing.hasVideo || listing.video || listing.videoUrl || listing.videoKey || item.videoUrl || item.videoKey)
  }
}

function mapMockMatchesFilter(item = {}, listing = {}, filter) {
  if (filter.listingIds.length && filter.listingIds.indexOf(String(listing.id || item.id || '')) === -1) return false
  const rent = mapRent(listing.rent || item.rent || item.price)
  if (filter.rentMin !== null && rent < filter.rentMin) return false
  if (filter.rentMax !== null && rent > filter.rentMax) return false
  if (filter.layout && String(listing.layout || item.layout || '').indexOf(filter.layout) === -1) return false
  if (filter.rentMode && String(listing.rentMode || item.rentMode || item.type || item.layout || '').indexOf(filter.rentMode) === -1) return false
  if (filter.sourceType && mapMockSourceText(item, listing).indexOf(filter.sourceType) === -1) return false
  if (filter.area && mapMockLocationText(item).indexOf(filter.area) === -1) return false
  return true
}

function pushUnique(list, value) {
  const text = String(value || '').trim()
  if (text && list.indexOf(text) === -1) list.push(text)
}

function mockMapCommunities(filter = {}) {
  const normalizedFilter = normalizeMapMockFilter(filter)
  const groups = {}
  ;(mockData.getMapPins() || []).forEach((item) => {
    const coordinate = mapMockCoordinate(item)
    if (!coordinate) return
    if (!mapMockCoordinateInBounds(coordinate, normalizedFilter)) return
    const listing = safeMapMockListing(item)
    if (!isMapMockActive(item, listing)) return
    if (!mapMockMatchesFilter(item, listing, normalizedFilter)) return
    const community = String(item.community || '').trim()
    if (!community) return
    if (!groups[community]) {
      groups[community] = {
        community,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        coordinateSource: coordinate.source,
        coordinateVerified: true,
        listingCount: 0,
        minRent: 0,
        maxRent: 0,
        activeListingIds: [],
        layouts: [],
        sourceTypes: [],
        listings: []
      }
    }
    const group = groups[community]
    const rent = mapRent(listing.rent)
    group.listingCount += 1
    group.minRent = group.minRent ? Math.min(group.minRent, rent) : rent
    group.maxRent = Math.max(group.maxRent, rent)
    group.activeListingIds.push(listing.id)
    pushUnique(group.layouts, listing.layout)
    pushUnique(group.sourceTypes, listing.sourceType)
    group.listings.push(listing)
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
    mock: () => mockData.getHomeListings()
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
    mock: () => mockData.getListings(filter || {})
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function getCompanyListings() {
  return getListings({ category: '公司房源' })
}

function buildMockCompanySheetSnapshot() {
  return {
    title: '寓你住一起房源表',
    sheetUrl: 'https://ccn9urs7d60k.feishu.cn/sheets/H7f8sxOrUhYCK8tev29cwSimnsl',
    range: '',
    updatedAt: '未连接真实飞书',
    rows: [],
    rowCount: 0,
    columnCount: 9,
    startRow: 1,
    startCol: 1,
    unavailable: true
  }
}

function getCompanySheetSnapshot() {
  return apiClient.call({
    path: '/mini/company-sheet-snapshot',
    mock: () => buildMockCompanySheetSnapshot()
  })
}

function loginByPhone(phone) {
  return apiClient.call({
    path: '/mini/auth/login',
    method: 'POST',
    data: { phone },
    mock: () => mockData.loginByPhone(phone)
  })
}

function registerUser(form) {
  return apiClient.call({
    path: '/mini/auth/register',
    method: 'POST',
    data: form,
    mock: () => mockData.loginByPhone(form && form.phone)
  })
}

function getCurrentUser() {
  return apiClient.call({
    path: '/mini/auth/me',
    mock: () => mockData.getCurrentUser()
  })
}

function bindWechatOpenid(code) {
  return apiClient.call({
    path: '/mini/auth/wechat-openid',
    method: 'POST',
    data: { code },
    mock: () => mockData.getCurrentUser()
  })
}

function matchListings(condition) {
  return apiClient.call({
    path: '/mini/listings/match',
    method: 'POST',
    data: condition,
    mock: () => mockData.matchListings(condition)
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
    mock: () => {
      const need = data.need || data.form || {}
      const result = mockData.matchListings(need)
      const listings = listingDisplay.normalizeListings((result && result.listings) || [])
      const nextQuestion = listings.length ? '' : '预算、区域和户型里先补充两个条件？'
      return {
        threadId: data.threadId || makeTempThreadId(),
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
    mock: () => ({
      id: makeTempThreadId().replace('LOCAL-AST', 'LOCAL-AF'),
      status: 'open',
      feedbackType: data.feedbackType || 'other'
    })
  })
}

function getMapCommunities(filter) {
  const query = buildQuery(filter || {})
  return apiClient.call({
    path: `/mini/map/communities${query}`,
    mock: () => mockMapCommunities(filter || {})
  })
}

function getMapPins(filter) {
  const query = buildQuery(filter || {})
  return apiClient.call({
    path: `/mini/map/pins${query}`,
    mock: () => mockData.getMapPins()
  })
}

function getListingDetail(id) {
  return apiClient.call({
    path: `/mini/listings/${id}`,
    mock: () => mockData.getListingDetail(id)
  }).then((listing) => listingDisplay.normalizeListing(listing))
}

function getListingLogs(id) {
  return apiClient.call({
    path: `/mini/listings/${id}/footprints`,
    mock: () => mockData.getListingLogs(id)
  })
}

function addSensitiveFootprint(listingId, action) {
  const payload = typeof action === 'object'
    ? action
    : { action }
  return apiClient.call({
    path: `/mini/listings/${listingId}/sensitive-view`,
    method: 'POST',
    data: payload,
    mock: () => mockData.addSensitiveFootprint(listingId, payload)
  })
}

function recordVideoShare(listingId, payload) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/video-share`,
    method: 'POST',
    data: payload || {},
    mock: () => mockData.recordVideoShare(listingId, payload || {})
  })
}

function recordShowing(listingId, payload) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/showings`,
    method: 'POST',
    data: payload || {},
    mock: () => mockData.recordShowing(listingId, payload || {})
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
    mock: () => mockData.getClientReports()
  })
}

function createClientReport(listingId, payload) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/reports`,
    method: 'POST',
    data: payload || {},
    mock: () => mockData.createClientReport(listingId, payload || {})
  })
}

function getDealRecords() {
  return apiClient.call({
    path: '/mini/deals',
    mock: () => mockData.getDealRecords()
  })
}

function createDealFromReport(reportId, payload) {
  return apiClient.call({
    path: `/mini/reports/${reportId}/deals`,
    method: 'POST',
    data: payload || {},
    mock: () => mockData.createDealFromReport(reportId, payload || {})
  })
}

function registerDeal(listingId) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/deals`,
    method: 'POST',
    data: {},
    mock: () => ({
      message: '成交已登记'
    })
  })
}

function getFootprintRecords() {
  return apiClient.call({
    path: '/mini/footprints',
    mock: () => mockData.getFootprintRecords()
  })
}

function getOwnedListings() {
  return apiClient.call({
    path: '/mini/my/listings',
    mock: () => mockData.getOwnedListings()
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function verifyMyListing(id) {
  return apiClient.call({
    path: `/mini/my/listings/${id}/verify`,
    method: 'POST',
    data: {},
    mock: () => mockData.verifyMyListing(id)
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function getEditableListing(id) {
  return apiClient.call({
    path: `/mini/my/listings/${id}`,
    mock: () => mockData.getEditableListing(id)
  })
}

function updateNormalListing(id, form) {
  return apiClient.call({
    path: `/mini/my/listings/${id}`,
    method: 'PUT',
    data: form,
    mock: () => mockData.updateNormalListing(id, form)
  })
}

function getProfileState() {
  return apiClient.call({
    path: '/mini/profile',
    mock: () => mockData.getProfileState()
  })
}

function getTodayTasks() {
  return apiClient.call({
    path: '/mini/today-tasks',
    mock: () => buildTodayTasksFromProfile(mockData.getProfileState())
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
    mock: () => normalizeNeedResponse({
      message: '本地临时需求单已创建',
      temporary: true
    }, data, true)
  }).then((result) => normalizeNeedResponse(result, data, false)).catch((error) => {
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
    mock: () => mockData.rechargePoints(points)
  })
}

function getCommissionRecords() {
  return apiClient.call({
    path: '/mini/commissions',
    mock: () => []
  })
}

function getGroupState() {
  return apiClient.call({
    path: '/mini/groups',
    mock: () => mockData.getGroupState()
  }).then((state) => listingDisplay.normalizeGroupState(state))
}

function uploadGroupListing(form) {
  return apiClient.call({
    path: '/mini/groups/listings',
    method: 'POST',
    data: form || {},
    mock: () => mockData.uploadGroupListing(form)
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
    mock: () => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-group-screenshots/${Date.now()}.jpg`,
      fileUrl: info.tempFilePath || '',
      maxSize: 20 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回 OSS 截图直传凭证。'
    })
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
    mock: () => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-showing-photos/${Date.now()}.jpg`,
      fileUrl: info.tempFilePath || '',
      maxSize: 20 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回带看水印照片直传凭证。'
    })
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
    mock: () => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-videos/${Date.now()}.mp4`,
      fileUrl: info.tempFilePath || '',
      maxSize: 300 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回 OSS 直传凭证。'
    })
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
    header: {
      Authorization: config.token ? `Bearer ${config.token}` : '',
      'X-User-Id': (typeof wx !== 'undefined' && wx.getStorageSync) ? (wx.getStorageSync('ynzy_user_id') || '') : ''
    },
    mock: () => ({
      text: info.mockText || '拱墅万达附近2000左右的单间',
      provider: 'mock-asr',
      model: 'mock-qwen3-asr-flash',
      mode: 'mock'
    })
  }).then((result) => result && result.data ? result.data : result)
}

function buildRealtimeAsrUrl() {
  const config = getRuntimeConfig()
  const httpUrl = apiClient.buildUrl(config.baseUrl, '/mini/asr/realtime')
  return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
}

function currentUserId() {
  try {
    return (typeof wx !== 'undefined' && wx.getStorageSync) ? (wx.getStorageSync('ynzy_user_id') || '') : ''
  } catch (error) {
    return ''
  }
}

function createRealtimeAsrSocket() {
  const config = getRuntimeConfig()
  if (shouldUseMock(config) || typeof wx === 'undefined' || !wx.connectSocket) return null
  return wx.connectSocket({
    url: buildRealtimeAsrUrl(),
    header: {
      Authorization: config.token ? `Bearer ${config.token}` : '',
      'X-User-Id': currentUserId()
    }
  })
}

function uploadVideo(filePath, policy) {
  return uploadOssFile(filePath, policy, '视频上传配置不完整')
}

function uploadGroupScreenshot(filePath, policy) {
  return uploadOssFile(filePath, policy, '截图上传配置不完整')
}

function uploadShowingPhoto(filePath, policy) {
  return uploadOssFile(filePath, policy, '带看照片上传配置不完整')
}

function uploadOssFile(filePath, policy, missingMessage) {
  const uploadPolicy = policy || {}
  if (uploadPolicy.uploadMode === 'mock') {
    return Promise.resolve({
      fileUrl: uploadPolicy.fileUrl || filePath,
      objectKey: uploadPolicy.objectKey || ''
    })
  }

  if (!uploadPolicy.uploadUrl) {
    return Promise.reject(new Error(uploadPolicy.note || missingMessage || '文件上传配置不完整'))
  }

  return apiClient.uploadFile({
    url: uploadPolicy.uploadUrl,
    filePath,
    name: 'file',
    formData: uploadPolicy.formData || {},
    header: uploadPolicy.headers || {},
    mock: () => ({
      fileUrl: uploadPolicy.fileUrl || filePath,
      objectKey: uploadPolicy.objectKey || ''
    })
  }).then(() => ({
    fileUrl: uploadPolicy.fileUrl,
    objectKey: uploadPolicy.objectKey
  }))
}

function unlockGroup(id) {
  return apiClient.call({
    path: `/mini/groups/${id}/unlock`,
    method: 'POST',
    data: {},
    mock: () => mockData.unlockGroup(id)
  }).then((result) => result && result.data
    ? Object.assign({}, result, { data: listingDisplay.normalizeGroupState(result.data) })
    : result)
}

function addNormalListing(form) {
  return apiClient.call({
    path: '/mini/listings',
    method: 'POST',
    data: form,
    mock: () => mockData.addNormalListing(form)
  })
}

module.exports = {
  getHomeListings,
  getListings,
  getCompanyListings,
  getCompanySheetSnapshot,
  loginByPhone,
  registerUser,
  getCurrentUser,
  bindWechatOpenid,
  matchListings,
  chatAssistant,
  submitAssistantFeedback,
  transcribeVoice,
  buildRealtimeAsrUrl,
  createRealtimeAsrSocket,
  getMapCommunities,
  getMapPins,
  getListingDetail,
  getListingLogs,
  addSensitiveFootprint,
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
  getGroupState,
  uploadGroupListing,
  createGroupScreenshotUploadPolicy,
  uploadGroupScreenshot,
  createShowingPhotoUploadPolicy,
  uploadShowingPhoto,
  createVideoUploadPolicy,
  uploadVideo,
  unlockGroup,
  addNormalListing
}
