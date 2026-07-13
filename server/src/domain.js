const crypto = require('crypto')
const { clone } = require('./db')
const { hashPassword, verifyPassword, passwordIssue } = require('./auth-util')
const oss = require('./oss')
const config = require('./config')
const { coordinateByCommunity } = require('./community-coordinates')
const { isKnownCommunity, normalizeCommunityKey } = require('./community-library')
const locationMap = require('./location-map')
const needFunnel = require('./need-funnel')
const {
  refreshRecommendationProfile,
  clearRecommendationProfile
} = require('./listing-recommendation-profile')
const {
  NO_FEATURE,
  NO_COMMISSION_FEATURE,
  DEPOSIT_FREE_FEATURE,
  ELEVATOR_FEATURE,
  LISTING_FEATURE_OPTIONS,
  parseFeatureInput,
  normalizeListingFeatures,
  invalidListingFeatures,
  featureText
} = require('./listing-features')

const VERIFY_REMINDER_DAYS = [3, 5]
const VERIFY_STALE_DAYS = 7
const V1_MAP_STALE_DAYS = VERIFY_STALE_DAYS
const DAY_MS = 24 * 60 * 60 * 1000
const BROKER_FOOTPRINT_RETENTION_MS = 7 * DAY_MS
const ADMIN_FOOTPRINT_RETENTION_MS = 90 * DAY_MS
const CLIENT_FOOTPRINT_RATE_WINDOW_MS = 60 * 1000
const CLIENT_FOOTPRINT_RATE_LIMIT = 30
const NEARBY_RADIUS_KM = 3
const NEARBY_PREVIEW_LIMIT = 6
// 分佣默认比例（均可后台系统配置覆盖）。基数 = 成交总佣金 deal.landlordCommissionFen（带看中介实赚那笔）。
// 业主/二房东：上传人分 uploaderRate% + 平台抽 platformRate%，带看成交中介净留其余（默认 70%）；
// 公司房源恒 0（带看中介全佣）；自传自带（成交人 == 上传人）全免、带看中介 100%、不生成分佣记录。
const SECOND_LANDLORD_COMMISSION_RATE = 20 // 二房东房源 上传人默认分佣（由 15 统一为 20）
const OWNER_COMMISSION_RATE = 20 // 业主房源 上传人默认分佣
const PLATFORM_COMMISSION_RATE = 10 // 平台默认分佣（业主/二房东；公司恒 0）
const MAX_COMMISSION_RATE = 100 // 单档比例上限：任一比例不得超过 100%
const TOTAL_DEAL_COMMISSION_RATE = OWNER_COMMISSION_RATE + PLATFORM_COMMISSION_RATE // 默认总分出比例(30)，仅作展示兜底
const UPLOADER_COMMISSION_RATE = OWNER_COMMISSION_RATE // 兼容旧引用
const COMPANY_COMMISSION_TEXT = '公司房源成交不抽佣，带看中介全佣'
const COMPANY_SOURCE = '公司房源'
const OWNER_SOURCE = '业主房源'
const SECOND_LANDLORD_SOURCE = '二房东房源'
const OWNER_SOURCE_ALIASES = new Set([OWNER_SOURCE, '业主'])
const SECOND_LANDLORD_SOURCE_ALIASES = new Set([SECOND_LANDLORD_SOURCE, '二房东', '二房東', '普通上传', '合作房源'])
const BROKER_ROLE = '中介'
const BROKER_AUTHED = '手机号登录'
const OWNER_DAILY_VIEW_LIMIT = 3
const NORMAL_DAILY_VIEW_LIMIT = 15
const MAP_COORDINATE_LEVELS = ['verified', 'approximate', 'block-center']

const FEATURE_INFERENCE_RULES = [
  { name: '带阳台', pattern: /阳台/ },
  { name: '干湿分离', pattern: /干湿分离/ },
  { name: '燃气', pattern: /燃气|天然气|煤气/ },
  { name: '带露台（阁楼）', pattern: /带露台|带阁楼|阁楼|露台|带花园|有花园|花园房|带院子|有院子/ },
  // 近地铁（自动打标签）：「地铁+方位」强语境词，或「X号线」（description 里"紧邻2号线"等真写法）——
  // 但「X号线」后紧跟专名后缀(公寓/苑/园…)视为楼盘名(一号线公寓)不打标签。因本函数已不读 title/tags/community，仅从 description 等推断，安全。
  { name: '近地铁', pattern: /近地铁|地铁口|地铁站|地铁旁|地铁边|靠地铁|临地铁|挨地铁|[\d一二三四五六七八九十两]号线(?!公寓|公馆|花园|家园|苑|园|城|府|庄|阁|座|幢|邸|里|巷|弄|路|桥|楼|号|馆|居|庭|轩|湾|郡|墅|寓)/ },
  { name: '朝南', pattern: /朝南|南向/ },
  { name: 'Loft', pattern: /\bloft\b|挑高复式|复式挑高/i },
  { name: '落地窗', pattern: /落地窗/ },
  // 独卫：裸「独立卫」加负向前瞻，排除「独立卫星电视/独立卫视」等撞词。
  { name: '独卫', pattern: /独卫|独立卫生间|独立厨卫|独厨独卫|独立卫(?![星视])/ },
  { name: '电梯', pattern: /电梯/ },
  { name: '采光好', pattern: /采光好|采光佳|采光很好|光线好|南北通透|通透/ },
  // 可短租：要求「可/接受/支持/短住」等服务语境，去掉裸「短租」——否则地名（短租桥/短租弄/短租路）会被误打标签。宁可漏标不可错标。
  { name: '可短租', pattern: /可短租|接受短租|支持短租|短租可|可短住/ },
  { name: '可月付', pattern: /可月付|月付|押一付一/ },
  { name: '首次出租', pattern: /首次出租|首租|第一次出租/ },
  // 民水民电：只认完整「民水民电」，去掉裸「民水/民电」——否则撞「居民电梯/便民电话」等词。宁可漏标不可错标。
  { name: '民水民电', pattern: /民水民电/ },
  { name: '整租', pattern: /整租|（整）|\(整\)/ },
  { name: '合租', pattern: /合租|单间/ },
  { name: DEPOSIT_FREE_FEATURE, pattern: /免押金|无押金|零押金|押金0|押金为0/ }
]
const INFERABLE_LISTING_FEATURES = new Set(LISTING_FEATURE_OPTIONS.concat([DEPOSIT_FREE_FEATURE, '整租', '合租']))
const PERSISTABLE_INFERRED_FEATURES = new Set(LISTING_FEATURE_OPTIONS.concat([DEPOSIT_FREE_FEATURE]))

function defaultListingMaintenanceRule() {
  return {
    enabled: false,
    remindDays: VERIFY_REMINDER_DAYS.slice(),
    expireDays: VERIFY_STALE_DAYS,
    updatedAt: '',
    updatedBy: ''
  }
}

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

const FOOTPRINT_ACTION_TYPE_BY_TEXT = new Map([
  ['查看地址和电话', 'sensitive_view'],
  ['查看敏感信息', 'sensitive_view'],
  ['记录带看', 'showing_verified'],
  ['转发房间视频给租客', 'video_shared'],
  ['自动下架', 'listing_expired'],
  ['管理员下架', 'listing_expired'],
  ['重新上架', 'listing_restored'],
  ['修正地图坐标', 'listing_coordinate_updated'],
  ['调整分佣配置', 'commission_config_updated'],
  ['管理员调整状态', 'listing_status_updated'],
  ['房态核验', 'listing_verified']
])
const SYSTEM_FOOTPRINT_ACTION_TYPES = new Set(['listing_feishu_removed'])

function footprintTimestampMs(record = {}) {
  const legacyTime = String(record.time || '').trim()
  const raw = String(record.occurredAt || (legacyTime && legacyTime !== '刚刚' ? legacyTime : record.dateKey) || '').trim()
  if (!raw) return null
  const parsed = Date.parse(raw)
  if (Number.isFinite(parsed)) return parsed
  const normalized = raw.replace(/年|月/g, '/').replace(/日/g, '').replace(/-/g, '/')
  const fallback = new Date(normalized).getTime()
  return Number.isFinite(fallback) ? fallback : null
}

function footprintWithinRetention(record, retentionMs, nowMs = Date.now()) {
  const occurredAtMs = footprintTimestampMs(record)
  // 无法解析的历史记录不物理删除，后台继续保守可读；中介端无法证明其在最近 7 天内，故不下发。
  if (occurredAtMs === null) return retentionMs >= ADMIN_FOOTPRINT_RETENTION_MS
  return occurredAtMs <= nowMs && nowMs - occurredAtMs <= retentionMs
}

function pruneExpiredFootprints(db, nowMs = Date.now()) {
  const rows = Array.isArray(db.footprints) ? db.footprints : []
  const kept = rows.filter((record) => {
    const occurredAtMs = footprintTimestampMs(record)
    return occurredAtMs === null || occurredAtMs > nowMs || nowMs - occurredAtMs <= ADMIN_FOOTPRINT_RETENTION_MS
  })
  const removed = rows.length - kept.length
  if (removed > 0) db.footprints = kept
  else if (!Array.isArray(db.footprints)) db.footprints = []
  return removed
}

function expiredFootprintCount(db, nowMs = Date.now()) {
  return (Array.isArray(db.footprints) ? db.footprints : []).filter((record) => {
    const occurredAtMs = footprintTimestampMs(record)
    return occurredAtMs !== null && occurredAtMs <= nowMs && nowMs - occurredAtMs > ADMIN_FOOTPRINT_RETENTION_MS
  }).length
}

function assertClientFootprintRateLimit(db, viewerId, actionType, nowMs = Date.now()) {
  const recentCount = (Array.isArray(db.footprints) ? db.footprints : []).filter((record) => {
    if (String(record.viewerId || '') !== String(viewerId || '')) return false
    if (String(record.actionType || '') !== String(actionType || '')) return false
    const occurredAtMs = footprintTimestampMs(record)
    return occurredAtMs !== null && occurredAtMs <= nowMs && nowMs - occurredAtMs < CLIENT_FOOTPRINT_RATE_WINDOW_MS
  }).length
  if (recentCount < CLIENT_FOOTPRINT_RATE_LIMIT) return
  const error = new Error('操作过于频繁，请稍后再试')
  error.statusCode = 429
  error.data = {
    reason: 'FOOTPRINT_RATE_LIMITED',
    retryAfterSeconds: Math.ceil(CLIENT_FOOTPRINT_RATE_WINDOW_MS / 1000)
  }
  throw error
}

function footprintActionType(record = {}) {
  const explicit = String(record.actionType || '').trim()
  if (/^[a-z][a-z0-9_]{2,63}$/.test(explicit)) return explicit
  const actionText = String(record.action || '').trim()
  if (/下架|已出租|不租了/.test(actionText)) return 'listing_expired'
  return FOOTPRINT_ACTION_TYPE_BY_TEXT.get(actionText) || 'listing_activity'
}

// 所有新足迹统一收敛为六字段。客户端永远不能写操作者、动作、发生时间或敏感正文；
// 90 天内不再按数量截断，避免高访问量时提前销毁仍在审计期内的证据。
function pushFootprint(db, record = {}) {
  pruneExpiredFootprints(db)
  const footprintId = String(record.id || id('F'))
  const candidateKey = String(record.idempotencyKey || footprintId).trim()
  const normalized = {
    id: footprintId,
    viewerId: String(record.viewerId || 'system'),
    listingId: String(record.listingId || ''),
    actionType: footprintActionType(record),
    occurredAt: new Date().toISOString(),
    idempotencyKey: /^[A-Za-z0-9:_-]{8,128}$/.test(candidateKey) ? candidateKey : footprintId
  }
  db.footprints = db.footprints || []
  db.footprints.unshift(normalized)
  return normalized
}

function recordSystemFootprint(db, viewerId, listingId, actionType) {
  if (!SYSTEM_FOOTPRINT_ACTION_TYPES.has(actionType)) {
    const error = new Error('系统足迹动作类型无效')
    error.statusCode = 500
    throw error
  }
  return pushFootprint(db, {
    id: id('F'),
    viewerId: viewerId || 'system',
    listingId,
    actionType
  })
}

function id(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`
}

function userById(db, userId) {
  return (db.users || []).find((user) => user.id === userId)
}

// 剥离密码哈希/明文密码：任何返回给客户端的 user 对象都必须先过这里，防止 passwordHash 顺对象外泄。
function withoutSecret(user) {
  if (!user) return user
  const copy = clone(user)
  delete copy.passwordHash
  delete copy.password
  // tokenVersion 是服务端会话撤销状态，只能进入签名 token，不能作为用户资料下发。
  delete copy.tokenVersion
  return copy
}

function userTokenVersion(user) {
  const value = Number(user && user.tokenVersion)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function revokeUserTokens(user) {
  const current = userTokenVersion(user)
  if (current >= Number.MAX_SAFE_INTEGER) {
    const error = new Error('账号会话版本异常，请联系管理员')
    error.statusCode = 500
    throw error
  }
  user.tokenVersion = current + 1
  return user.tokenVersion
}

function listingById(db, listingId) {
  return (db.listings || []).find((listing) => listing.id === listingId)
}

function reportById(db, reportId) {
  return (db.clientReports || []).find((report) => report.id === reportId)
}

function rentalNeedById(db, needId) {
  return (db.rentalNeeds || db.clientNeeds || []).find((need) => need.id === needId)
}

function dealById(db, dealId) {
  return (db.dealRecords || []).find((deal) => deal.id === dealId)
}

function looksLikeVideoPath(value = '') {
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(String(value || '').trim())
}

function hasListingVideo(listing = {}) {
  const videoKey = String(listing.videoKey || '').trim()
  const videoUrl = String(listing.videoUrl || '').trim()
  return looksLikeVideoPath(videoKey) || looksLikeVideoPath(videoUrl)
}

// 房源卡片封面：有视频的房源用 OSS 视频首帧（video/snapshot 实时截帧的签名 URL）。createVideoSnapshotUrl
// 是纯签名（无网络、无 OSS 配置时返空串），故放 domain 序列化层不影响可测性；无视频/非 OSS 对象返空，
// 前端退占位图兜底。列表/详情统一走这里，保证公司/合作/我的/全部房源封面口径一致。
function listingCoverUrl(listing = {}) {
  const videoKey = String(listing.videoKey || '').trim()
  return videoKey ? oss.createVideoSnapshotUrl(videoKey) : ''
}

function isCompanySheetListing(listing = {}) {
  return listing.externalSource === 'feishu-sheet-snapshot' || listing.source === COMPANY_SOURCE || isCompanyListing(listing)
}

function requiresListingVideo(listing = {}) {
  return !isCompanySheetListing(listing)
}

function isSoldListing(listing = {}) {
  const status = String(listing.status || '')
  return listing.lifecycleStatus === 'sold' || /\u6210\u4ea4|\u7b7e\u5355/.test(status)
}

function isFrontendEffectiveListing(listing = {}) {
  return !isExpiredListing(listing) &&
    !isSoldListing(listing) &&
    (!requiresListingVideo(listing) || hasListingVideo(listing)) &&
    !isPendingOwnerReview(listing)
}

function ownerTypeFromStructuredValue(value = '') {
  const text = String(value || '').trim()
  if (OWNER_SOURCE_ALIASES.has(text)) return OWNER_SOURCE
  if (SECOND_LANDLORD_SOURCE_ALIASES.has(text)) return SECOND_LANDLORD_SOURCE
  return ''
}

function normalizeOwnerType(value, fallback = SECOND_LANDLORD_SOURCE) {
  return ownerTypeFromStructuredValue(value) ||
    ownerTypeFromStructuredValue(fallback) ||
    SECOND_LANDLORD_SOURCE
}

function nonCompanyListingSourceType(listing = {}) {
  const structured = listing.ownerType || listing.houseSourceType || listing.source || ''
  return normalizeOwnerType(structured, SECOND_LANDLORD_SOURCE)
}

function listingSourceType(listing = {}) {
  return isCompanyListing(listing) ? COMPANY_SOURCE : nonCompanyListingSourceType(listing)
}

function isOwnerListing(listing = {}) {
  return listingSourceType(listing) === OWNER_SOURCE
}

function requiresListingReview(listing = {}) {
  return Boolean(
    isOwnerListing(listing) ||
    truthyFlag(listing.requiresManualReview) ||
    truthyFlag(listing.manualReviewRequired) ||
    listing.communityMatchStatus === '未匹配' ||
    listing.reviewStatus === '待审核' ||
    listing.status === '待审核'
  )
}

function ownerReviewStatus(listing = {}) {
  if (!requiresListingReview(listing)) return listing.reviewStatus || '无需审核'
  return listing.reviewStatus || (listing.status === '待审核' ? '待审核' : '已通过')
}

function isPendingOwnerReview(listing = {}) {
  return requiresListingReview(listing) && ownerReviewStatus(listing) !== '已通过'
}

function isExpiredListing(listing = {}) {
  return listing.lifecycleStatus === 'expired' || listing.status === '已失效' || listing.status === '已下架'
}

function listingUnavailableReason(listing = {}) {
  if (!listing || !listing.id) return { reason: 'not-found', reasonText: '房源不存在' }
  if (isSoldListing(listing)) {
    return { reason: 'down', reasonText: '该房源已成交或已下架，请返回重新找房。' }
  }
  if (isExpiredListing(listing)) {
    const expiredReason = String(listing.expiredReason || '')
    const reason = listing.expiredStaleDays !== undefined || /超过\s*\d+\s*天|未电话联系|房态/.test(expiredReason)
      ? 'expired'
      : 'down'
    return {
      reason,
      reasonText: reason === 'expired'
        ? '该房源已超过核验周期或已失效，请返回重新找房。'
        : '该房源已下架或已更新，请返回重新找房。'
    }
  }
  if (isPendingOwnerReview(listing)) {
    return { reason: 'pending', reasonText: '该房源正在审核，暂不能查看详情，请返回重新找房。' }
  }
  if (requiresListingVideo(listing) && !hasListingVideo(listing)) {
    return { reason: 'pending', reasonText: '该房源视频素材待补充，暂不能查看详情，请返回重新找房。' }
  }
  return { reason: '', reasonText: '' }
}

function rawActiveListings(db) {
  return (db.listings || []).filter((listing) => !isExpiredListing(listing) && !isSoldListing(listing))
}

function activeListings(db) {
  autoExpireOverdueListings(db)
  return rawActiveListings(db)
}

function snapshotCellText(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function snapshotHeaderIndex(rows = []) {
  return rows.findIndex((row) => {
    const text = (row || []).map(snapshotCellText).join('|')
    return /区域/.test(text) && /小区/.test(text)
  })
}

function snapshotColumnIndex(header = [], aliases = []) {
  const normalizedHeader = header.map((cell) => snapshotCellText(cell).replace(/\s+/g, ''))
  return aliases.reduce((matched, alias) => {
    if (matched !== -1) return matched
    const key = String(alias || '').replace(/\s+/g, '')
    return normalizedHeader.findIndex((cell) => cell === key || cell.indexOf(key) !== -1)
  }, -1)
}

function snapshotCell(row = [], index) {
  if (index < 0) return ''
  return snapshotCellText(row[index])
}

function numberFromSnapshot(value) {
  const matched = String(value || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/)
  return matched ? Number(matched[0]) : 0
}

function inferSnapshotRentMode(layout = '') {
  if (/合租|单间|主卧|次卧/.test(layout)) return '合租'
  return '整租'
}

function stableCompanySheetId(value = '') {
  const text = String(value || '')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 31) + text.charCodeAt(index)) >>> 0
  }
  return `CS${hash.toString(36)}`
}

function companySheetPublicListings(db = {}) {
  const snapshot = db.companySheetSnapshot || {}
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  const headerIndex = snapshotHeaderIndex(rows)
  if (headerIndex < 0) return []

  const header = rows[headerIndex] || []
  const areaIndex = snapshotColumnIndex(header, ['区域', '区', '片区', '商圈'])
  const communityIndex = snapshotColumnIndex(header, ['小区', '小区名称', '楼盘', '社区'])
  const layoutIndex = snapshotColumnIndex(header, ['户型描述', '描述', '房源描述', '户型信息'])
  const categoryIndex = snapshotColumnIndex(header, ['户型分类', '户型', '格局', '分类'])
  const rentIndex = snapshotColumnIndex(header, ['押一付一', '押一', '月租', '租金', '价格'])
  const fallbackRentIndex = snapshotColumnIndex(header, ['押二付一', '押二', '押二付一价格', '押二价格'])
  const roomIndex = snapshotColumnIndex(header, ['房号', '房间号', '门牌号', '室号', '房源房号'])
  const contactIndex = snapshotColumnIndex(header, ['联系方式', '联系电话', '房东联系方式', '房东电话', '联系人电话', '手机号', '手机', '电话', '微信'])
  const passwordIndex = snapshotColumnIndex(header, ['看房方式密码', '看房密码', '门锁密码', '密码'])
  const remarkIndex = snapshotColumnIndex(header, ['备注', '说明', '备注说明', '水电'])
  const updatedAt = snapshot.cachedAt || snapshot.updatedAt || nowText()
  const result = []
  let currentArea = ''
  let currentCommunity = ''

  rows.slice(headerIndex + 1).forEach((row, index) => {
    const cells = Array.isArray(row) ? row : []
    const area = snapshotCell(cells, areaIndex)
    const community = snapshotCell(cells, communityIndex)
    const layout = snapshotCell(cells, layoutIndex)
    const category = snapshotCell(cells, categoryIndex)
    const rent = numberFromSnapshot(snapshotCell(cells, rentIndex)) || numberFromSnapshot(snapshotCell(cells, fallbackRentIndex))
    const roomNumber = snapshotCell(cells, roomIndex)
    const contact = snapshotCell(cells, contactIndex)
    const viewingPassword = snapshotCell(cells, passwordIndex)
    const remark = snapshotCell(cells, remarkIndex)

    if (area && !community && !layout && !category && !rent) {
      currentArea = area
      return
    }
    if (area) currentArea = area
    if (community) currentCommunity = community
    if (!currentCommunity || !rent || !(layout || category)) return

    const listingKey = [
      currentArea,
      currentCommunity,
      layout,
      category,
      rent,
      index
    ].join('|')
    const block = currentArea || ''
    const safeArea = normalizeDistrict(locationMap.districtForBlock(block, currentArea || ''))
    const listing = {
      id: stableCompanySheetId(listingKey),
      title: `${currentCommunity} · ${layout || category}`,
      shortTitle: currentCommunity,
      uploaderId: '',
      rent,
      layout: layout || category,
      city: '杭州',
      district: safeArea,
      area: safeArea,
      block: block || safeArea,
      community: currentCommunity,
      roomNumber,
      roomAddress: roomNumber,
      address: `${safeArea}${currentCommunity}${roomNumber ? roomNumber : ''}`,
      landlordPhone: contact,
      contact,
      viewingPassword,
      showingPassword: viewingPassword,
      remark,
      note: remark,
      commissionRate: 0,
      videoLabel: '飞书房源表',
      videoUrl: '',
      videoKey: '',
      status: '在租',
      reviewStatus: '无需审核',
      communityMatched: true,
      communityMatchStatus: '已匹配',
      requiresManualReview: false,
      lifecycleStatus: 'active',
      ownerType: COMPANY_SOURCE,
      houseSourceType: COMPANY_SOURCE,
      type: inferSnapshotRentMode(`${layout}${category}`),
      rentMode: inferSnapshotRentMode(`${layout}${category}`),
      room: category || '',
      hall: '',
      bath: '',
      features: [COMPANY_SOURCE],
      source: COMPANY_SOURCE,
      companyListing: true,
      isCompanyListing: true,
      noCommission: true,
      externalSource: 'feishu-sheet-snapshot',
      createdAt: updatedAt,
      lastVerifiedAt: updatedAt
    }
    const coordinate = coordinateByCommunity(currentCommunity)
    if (coordinate) {
      listing.mapLatitude = coordinate.latitude
      listing.mapLongitude = coordinate.longitude
      listing.coordinateSource = coordinate.source || 'community-coordinate'
      listing.coordinateVerified = true
      listing.coordinateLevel = 'verified'
      listing.coordinateAccuracy = 'verified'
      listing.coordinateStatus = coordinateStatusText('verified')
    }
    result.push(listing)
  })

  return result
}

function publicListings(db) {
  return activeListings(db).filter(isFrontendEffectiveListing)
}

function assertListingActive(listing) {
  if (!isExpiredListing(listing)) return
  const error = new Error('该房源已下架，已进入后台资产池')
  error.statusCode = 410
  throw error
}

function assertFrontendListingAvailable(listing) {
  assertListingActive(listing)
  if (isSoldListing(listing)) {
    const error = new Error('该房源已签单或成交，不能继续在前台发起业务')
    error.statusCode = 410
    throw error
  }
  if (isPendingOwnerReview(listing)) {
    const error = new Error('该房源正在等待管理员审核，审核通过后才会上架')
    error.statusCode = 404
    throw error
  }
  if (requiresListingVideo(listing) && !hasListingVideo(listing)) {
    const error = new Error('该房源缺少真实视频，暂不能在前台展示或发起业务')
    error.statusCode = 404
    throw error
  }
}

function dateValue(text) {
  if (!text) return 0
  const value = Date.parse(String(text).replace(/\//g, '-'))
  return Number.isFinite(value) ? value : 0
}

function activeMaintenanceTime(listing = {}) {
  const last = listing.lastVerifiedAt || listing.updatedAt || listing.createdAt || ''
  if (last) return last
  const now = nowText()
  listing.createdAt = now
  listing.lastVerifiedAt = now
  return listing.lastVerifiedAt
}

function listingFreshness(listing) {
  if (isExpiredListing(listing)) {
    return {
      lastVerifiedAt: listing.lastVerifiedAt || '未核验',
      staleDays: listing.expiredStaleDays || 0,
      verifyStatus: '已下架',
      verifyTip: listing.expiredReason || `超过 ${VERIFY_STALE_DAYS} 天未电话联系房东确认房态`,
      needsVerify: false,
      reminderStage: 'expired'
    }
  }
  const last = activeMaintenanceTime(listing)
  const lastTime = dateValue(last)
  const staleDays = lastTime ? Math.max(0, Math.floor((Date.now() - lastTime) / 86400000)) : VERIFY_STALE_DAYS
  let verifyStatus = '正常'
  let verifyTip = `最近 ${staleDays} 天内已电话核验`
  let reminderStage = 'normal'
  if (!lastTime || staleDays >= VERIFY_STALE_DAYS) {
    verifyStatus = '需核验'
    verifyTip = !lastTime
      ? '未找到核验时间，请电话联系房东确认房态'
      : `已 ${staleDays} 天未电话联系房东确认房态，规则开启时会自动下架`
    reminderStage = 'expire'
  } else if (staleDays >= 5) {
    verifyStatus = '重点核验'
    verifyTip = `已 ${staleDays} 天未电话联系房东确认，5 天提醒，请尽快更新`
    reminderStage = 'day5'
  } else if (staleDays >= 3) {
    verifyStatus = '提醒核验'
    verifyTip = `已 ${staleDays} 天未电话联系房东确认，3 天提醒`
    reminderStage = 'day3'
  }
  return {
    lastVerifiedAt: last || '未核验',
    staleDays,
    verifyStatus,
    verifyTip,
    needsVerify: reminderStage !== 'normal',
    reminderStage
  }
}

function maintenanceText(freshness) {
  const days = Number(freshness && freshness.staleDays)
  if (!Number.isFinite(days) || days >= VERIFY_STALE_DAYS) return `${VERIFY_STALE_DAYS}天未维护`
  if (days <= 0) return '今日已维护'
  return `${days}天前维护`
}

function truthyFlag(value) {
  return value === true || value === 1 || ['true', '1', 'yes', '是'].indexOf(String(value || '').trim().toLowerCase()) !== -1
}

function companyListingFlag(value) {
  if (truthyFlag(value)) return true
  return ['y', '公司', COMPANY_SOURCE].indexOf(String(value || '').trim().toLowerCase()) !== -1
}

function isCompanyListing(listing = {}) {
  const sourceText = [
    listing.source,
    listing.sourceType,
    listing.listingType,
    listing.inventoryType
  ].map((item) => String(item || '')).join(' ')
  return Boolean(
    companyListingFlag(listing.companyListing) ||
    companyListingFlag(listing.isCompanyListing) ||
    truthyFlag(listing.companyOwned) ||
    /公司房源|company/.test(sourceText)
  )
}

function boundedRate(value, fallback, max = MAX_COMMISSION_RATE) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(0, Math.round(number * 100) / 100))
}

function defaultCommissionConfig() {
  return {
    uploaderRates: {
      [SECOND_LANDLORD_SOURCE]: SECOND_LANDLORD_COMMISSION_RATE,
      [OWNER_SOURCE]: OWNER_COMMISSION_RATE,
      [COMPANY_SOURCE]: 0
    },
    platformRates: {
      [SECOND_LANDLORD_SOURCE]: PLATFORM_COMMISSION_RATE,
      [OWNER_SOURCE]: PLATFORM_COMMISSION_RATE,
      [COMPANY_SOURCE]: 0
    },
    secondLandlordRate: SECOND_LANDLORD_COMMISSION_RATE,
    ownerRate: OWNER_COMMISSION_RATE,
    companyRate: 0,
    secondLandlordPlatformRate: PLATFORM_COMMISSION_RATE,
    ownerPlatformRate: PLATFORM_COMMISSION_RATE,
    totalRate: TOTAL_DEAL_COMMISSION_RATE, // 展示兜底：默认总分出比例（业主/二房东 20+10=30）
    updatedAt: '',
    updatedBy: ''
  }
}

function commissionConfig(db = {}) {
  const saved = db.commissionConfig || {}
  const savedUp = saved.uploaderRates || {}
  const savedPlat = saved.platformRates || {}
  const base = defaultCommissionConfig()
  const secondLandlordRate = boundedRate(saved.secondLandlordRate ?? savedUp[SECOND_LANDLORD_SOURCE], base.secondLandlordRate)
  const ownerRate = boundedRate(saved.ownerRate ?? savedUp[OWNER_SOURCE], base.ownerRate)
  const secondLandlordPlatformRate = boundedRate(saved.secondLandlordPlatformRate ?? savedPlat[SECOND_LANDLORD_SOURCE], base.secondLandlordPlatformRate)
  const ownerPlatformRate = boundedRate(saved.ownerPlatformRate ?? savedPlat[OWNER_SOURCE], base.ownerPlatformRate)
  return {
    uploaderRates: {
      [SECOND_LANDLORD_SOURCE]: secondLandlordRate,
      [OWNER_SOURCE]: ownerRate,
      [COMPANY_SOURCE]: 0
    },
    platformRates: {
      [SECOND_LANDLORD_SOURCE]: secondLandlordPlatformRate,
      [OWNER_SOURCE]: ownerPlatformRate,
      [COMPANY_SOURCE]: 0
    },
    secondLandlordRate,
    ownerRate,
    companyRate: 0,
    secondLandlordPlatformRate,
    ownerPlatformRate,
    totalRate: TOTAL_DEAL_COMMISSION_RATE,
    updatedAt: saved.updatedAt || '',
    updatedBy: saved.updatedBy || ''
  }
}

function commissionRateByOwnerType(ownerType = SECOND_LANDLORD_SOURCE, db = {}) {
  const normalized = normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE)
  const config = commissionConfig(db)
  return normalized === OWNER_SOURCE
    ? config.ownerRate
    : config.secondLandlordRate
}

function platformRateByOwnerType(ownerType = SECOND_LANDLORD_SOURCE, db = {}) {
  const normalized = normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE)
  const config = commissionConfig(db)
  return normalized === OWNER_SOURCE
    ? config.ownerPlatformRate
    : config.secondLandlordPlatformRate
}

function publicCommissionTextForOwnerType(ownerType = SECOND_LANDLORD_SOURCE, db = {}) {
  const config = commissionConfig(db)
  const normalized = normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE)
  const up = normalized === OWNER_SOURCE ? config.ownerRate : config.secondLandlordRate
  const plat = normalized === OWNER_SOURCE ? config.ownerPlatformRate : config.secondLandlordPlatformRate
  // 详情黄条只露"总分出比例"（上传+平台），不拆平台细项；带看成交中介净留其余。
  return `成交总比例按成交总佣金的 ${up + plat}% 计算`
}

function uploadCommissionTextForOwnerType(ownerType = SECOND_LANDLORD_SOURCE, db = {}) {
  const config = commissionConfig(db)
  const normalized = normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE)
  const up = normalized === OWNER_SOURCE ? config.ownerRate : config.secondLandlordRate
  return `别人带看成交你上传的这条房源，你按成交总佣金拿 ${up}% 收益`
}

function commissionRateForListing(listing = {}, db = {}) {
  if (isCompanyListing(listing)) return 0
  return commissionRateByOwnerType(listing.ownerType || listing.houseSourceType || listing.source || SECOND_LANDLORD_SOURCE, db)
}

function isAdminUser(user = {}) {
  return Boolean(user.isAdmin || /管理员/.test(String(user.role || '')))
}

// 分佣规则（基数=成交总佣金）。closerId=带看成交人，用于识别"自传自带"。
// rate = uploaderRate + platformRate = 分出去的总比例；rate<=0 表示不生成分佣记录（公司/自传自带）。
function commissionRuleForListing(listing = {}, db = {}, uploaderId = '', closerId = '') {
  // 公司房源：不分佣，带看中介全佣。（形状固定为 {rate,uploaderRate,platformRate}，rate<=0 即不生成分佣记录。）
  if (isCompanyListing(listing)) {
    return { rate: 0, uploaderRate: 0, platformRate: 0 }
  }
  const effectiveUploaderId = uploaderId || listing.uploaderId || ''
  // 自传自带：上传人即带看成交人 → 全免，带看中介净留 100%，不生成分佣记录。
  if (effectiveUploaderId && closerId && String(effectiveUploaderId) === String(closerId)) {
    return { rate: 0, uploaderRate: 0, platformRate: 0 }
  }
  const ownerType = listing.ownerType || listing.houseSourceType || listing.source || SECOND_LANDLORD_SOURCE
  const uploader = userById(db, effectiveUploaderId) || {}
  // 管理员上传（如公司代管的非公司房源）不给上传人分佣，但平台仍按配置抽成。
  const uploaderRate = isAdminUser(uploader) ? 0 : commissionRateByOwnerType(ownerType, db)
  const platformRate = platformRateByOwnerType(ownerType, db)
  return { rate: uploaderRate + platformRate, uploaderRate, platformRate }
}

// 结算端最后防线（money 守恒）：即使配置入口被绕过、db 里已有异常持久化配置、或 deal.commissionRule
// 冻结快照异常（历史脏数据/人工编辑/未审代码写入），确认签单也绝不生成超过成交总佣金的分佣记录。
// 校验：三项比例均为有限非负数；上传+平台 <= 100%；rate 与拆分一致。不符则 fail-loud（500，数据异常）。
function assertCommissionRuleConserved(rule) {
  const r = rule || {}
  // 历史 JSON 允许严格十进制数字字符串，但拒绝 JS 会隐式强转成 0 的 null/空串/布尔/数组/对象。
  // 否则一条三字段均为 null/false 的脏冻结规则会伪装成合法 0/0/0，并被确认成“不分佣”。
  const parseRate = (value) => {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const text = value.trim()
      if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return Number(text)
    }
    return Number.NaN
  }
  const uploaderRate = parseRate(r.uploaderRate)
  const platformRate = parseRate(r.platformRate)
  const rate = parseRate(r.rate)
  const finiteNonNeg = (n) => Number.isFinite(n) && n >= 0
  if (!finiteNonNeg(uploaderRate) || !finiteNonNeg(platformRate) || !finiteNonNeg(rate)) {
    const error = new Error('分佣规则异常：比例必须为有限非负数，拒绝结算以防超发')
    error.statusCode = 500
    throw error
  }
  if (uploaderRate + platformRate > MAX_COMMISSION_RATE) {
    const error = new Error('分佣规则异常：上传人比例 + 平台比例超过 100%，拒绝结算以防超发')
    error.statusCode = 500
    throw error
  }
  if (Math.abs(rate - (uploaderRate + platformRate)) > 0.001) {
    const error = new Error('分佣规则异常：总比例与上传/平台拆分不一致，拒绝结算')
    error.statusCode = 500
    throw error
  }
}

function commissionFenBreakdown(landlordCommissionFen, rule = {}) {
  assertCommissionRuleConserved(rule)
  const totalFen = Number(landlordCommissionFen)
  if (!Number.isSafeInteger(totalFen) || totalFen < 0) {
    const error = new Error('房东佣金金额异常，拒绝结算')
    error.statusCode = 500
    throw error
  }
  const distributedFen = Math.round(totalFen * Number(rule.rate) / 100)
  const uploaderCommissionFen = Math.min(
    distributedFen,
    Math.round(totalFen * Number(rule.uploaderRate) / 100)
  )
  // 总可分金额只四舍五入一次，平台取剩余值，避免极小金额两边各自进位后超发。
  const platformCommissionFen = distributedFen - uploaderCommissionFen
  return { distributedFen, uploaderCommissionFen, platformCommissionFen }
}

function roundCommissionPercent(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

// 将“房东总佣金占月租比例”换算为详情页和成交快照统一使用的月租占比。
// 维护人就是房源服务端记录的 uploader；带看人就是当前已验签用户/报备 broker，均不接受客户端传值。
function commissionBreakdownFromRule(landlordCommissionPercent, rule = {}) {
  assertCommissionRuleConserved(rule)
  const landlordPercentOfRent = Number(landlordCommissionPercent)
  if (!Number.isInteger(landlordPercentOfRent) || landlordPercentOfRent < 0 || landlordPercentOfRent > 100) {
    const error = new Error('房东佣金比例异常，无法计算分佣明细')
    error.statusCode = 500
    throw error
  }
  const maintainerRate = Number(rule.uploaderRate || 0)
  const platformRate = Number(rule.platformRate || 0)
  const viewingAgentRate = roundCommissionPercent(100 - maintainerRate - platformRate)
  const maintainerPercentOfRent = roundCommissionPercent(landlordPercentOfRent * maintainerRate / 100)
  const platformPercentOfRent = roundCommissionPercent(landlordPercentOfRent * platformRate / 100)
  // 用减法锁定最后一项，避免三项分别四舍五入后与总比例出现 0.01 的漂移。
  const viewingAgentPercentOfRent = roundCommissionPercent(
    landlordPercentOfRent - maintainerPercentOfRent - platformPercentOfRent
  )
  return {
    landlordPercentOfRent,
    viewingAgentPercentOfRent,
    maintainerPercentOfRent,
    platformPercentOfRent,
    split: {
      viewingAgentRate,
      maintainerRate,
      platformRate
    }
  }
}

function commissionBreakdownForListing(listing = {}, db = {}, viewerId = '') {
  const rule = commissionRuleForListing(listing, db, listing.uploaderId, viewerId)
  return commissionBreakdownFromRule(storedLandlordCommissionPercent(listing), rule)
}

function isLegacyRentInventory(listing = {}) {
  const sourceText = [
    listing.status,
    listing.source,
    listing.sourceType,
    listing.listingType,
    listing.inventoryType,
    listing.category
  ].map((item) => String(item || '')).join(' ')
  return /待租房源|待租/.test(sourceText)
}

function isNoCommissionListing(listing = {}) {
  return Boolean(
    isCompanyListing(listing) ||
    listing.noCommission ||
    Number(listing.commissionRate) === 0 ||
    parseFeatureInput(listing.features).indexOf(NO_COMMISSION_FEATURE) !== -1
  )
}

function uniqueTextList(values = []) {
  const seen = new Set()
  return values
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function featureSourceText(value) {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map(featureSourceText).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    return Object.keys(value)
      .map((key) => featureSourceText(value[key]))
      .filter(Boolean)
      .join(' ')
  }
  return String(value || '')
}

// 自由标签字段拆 token（数组或分隔串）。
function featureTagTokens(value) {
  if (Array.isArray(value)) return value.reduce((acc, item) => acc.concat(featureTagTokens(item)), [])
  return String(value || '').split(/[，,、|/\s]+/).map((token) => token.trim()).filter(Boolean)
}
// 收集本房源的自由标签 token（tags/rawFeatures 等，不含 canonical features），供『整词锚定』推断使用。
function listingFreeTagTokens(listing = {}) {
  return [listing.tags, listing.rawFeatures, listing.rawFeatureText, listing.featureText, listing.featureTags]
    .reduce((acc, field) => acc.concat(featureTagTokens(field)), [])
}

function listingTextForFeatures(listing = {}) {
  // 自动打标签的『描述性文本』= 真正的描述(description/detail/remark…) + 结构字段(整租/户型) + canonical features。
  // 走【非锚定+否定判定】的模糊推断（"精装带阳台"→带阳台，"无燃气"→不打燃气）。
  // 刻意排除：地名命名字段 community/locationSummary/address、标题 title/shortTitle（多为专名/营销名）；
  // 自由标签字段 tags/rawFeatures/featureText/featureTags 不进本 blob，改由 inferListingFeatures 走【整词锚定】——
  // 因为自由标签常被填进小区/楼盘名(阳台名邸/阳台山/电梯华都)或否定词(无电梯/非首次出租)，子串模糊匹配会撒谎。
  const descBlob = [
    listing.layout,
    listing.type,
    listing.rentMode,
    listing.room,
    listing.hall,
    listing.bath,
    listing.source,
    listing.status,
    listing.description,
    listing.desc,
    listing.detail,
    listing.detailText,
    listing.remark,
    listing.note,
    listing.memo,
    listing.features,
    listing.paymentMode,
    listing.payMode
  ].map(featureSourceText).join(' ')
  let text = descBlob
  const names = [listing.community, listing.block, listing.area, listing.district, listing.city]
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 2)
    .sort((left, right) => right.length - left.length)
  for (const name of names) {
    if (text.indexOf(name) !== -1) text = text.split(name).join(' ')
  }
  return text
}

// 否定判定＝「否定字捕获 + 少量褒义例外」，取代无穷尽的否定动词枚举：
//   「不X / 没X / 未X / 非X」几乎必为否定 → 按字捕获，自动覆盖 不接/不收/不考虑/不予/不租/概不/不做… 一切拒绝说法；
//   只需白名单化少数「含否定字却褒义」的口语例外（不错/没问题/少不了），维护成本从无穷否定词降为有限褒义词。
// 褒义「不X」例外——后置：燃气不错/采光不赖/位置不差/卖点不止/不仅；前置再加 不了（少不了/免不了为褒义，而后置的 短租不了＝否定，故前后置区别对待）。
// 褒义「没X」例外：没问题/没得说/没的说/没话说。
// 非否定字的拒绝词（字符级兜不住，显式列出，属有限小集）：谢绝/婉拒/停做/停止/取消/限制/暂停。
const NEG_AFTER_CORE = '不(?!错|赖|差|止|仅)|没(?!问题|得说|的说|话说)|无|未|非|禁|拒|谢绝|婉拒|停做|停止|取消|限制|暂停|免谈|勿扰'
const NEG_BEFORE_CORE = '不(?!错|赖|差|止|仅|了)|没(?!问题|得说|的说|话说)|无|未|非|禁|缺|拒|谢绝|婉拒|停做|停止|取消|限制|暂停|免谈|勿扰'
// 特征词与后置否定之间只允许副词/助词填充（目前暂不支持 / 也不通）——真实名词打断填充链，不误伤「燃气充足短租不支持」里的燃气
const NEG_AFTER_FILLER = '目前|暂时|暂|现在|当前|近期|临时|短期|一律|一概|统一|均|都|也|还|是|的|地|得|了'
// 特征词【前】：本子句内、词前一小段以否定收尾（无燃气 / 不能用燃气 / 不接短租 / 不予办理短租 …）。
// 允许否定字与特征词之间夹 ≤4 字（拒绝动词短语，如「不予办理/不予以受理」），跨子句已被 CLAUSE_SEP 挡住。
const NEGATION_BEFORE = new RegExp(`(?:${NEG_BEFORE_CORE}).{0,4}$`)
// 特征词【后】：本子句内、跳过副词/助词后紧接否定（燃气不通 / 短租不接 / 短租目前暂不支持 …）
const NEGATION_AFTER = new RegExp(`^(?:${NEG_AFTER_FILLER})*(?:${NEG_AFTER_CORE})`)
// 同子句/同字段边界：否定只在本子句内生效（空格也算边界，因为特征文本由多字段空格拼接，
// 避免下一子句或下一字段的否定误伤本特征，如「有燃气，阳台没有」不应抹掉燃气）
const CLAUSE_SEP = /[，。、；：！？,.;!?|/\s]/

function isNegatedFeatureMatch(text, index, matchLength = 0) {
  // 前置否定：只看本子句内、特征词前的一小段（遇分隔符即止，避免上一子句的否定跨句误伤，
  // 如「阳台没有，采光好」里的「没有」不应抹掉「采光好」）
  const beforeClause = text.slice(Math.max(0, index - 8), index).split(CLAUSE_SEP).pop()
  if (NEGATION_BEFORE.test(beforeClause)) return true
  // 后置否定：只看本子句内、特征词后的一小段
  const afterClause = text.slice(index + matchLength, index + matchLength + 12).split(CLAUSE_SEP)[0]
  return NEGATION_AFTER.test(afterClause)
}

function patternMatchesFeature(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matcher = new RegExp(pattern.source, flags)
  let match
  while ((match = matcher.exec(text))) {
    if (!isNegatedFeatureMatch(text, match.index, match[0].length)) return true
    if (!match[0]) matcher.lastIndex += 1
  }
  return false
}

// 自由标签 token 走整词锚定：token 必须整体是某特征词才算命中，杜绝「阳台山/电梯华都/免押金时代」(别名+任意后缀)
// 与「无电梯/非首次出租/不可短租」(否定形) 冒充特征——它们都不等于任何整词别名。
const ANCHORED_FEATURE_RES = FEATURE_INFERENCE_RULES.map((rule) => ({
  name: rule.name,
  anchored: new RegExp('^(?:' + rule.pattern.source + ')$', rule.pattern.flags.replace(/g/g, ''))
}))
function tagTokenMatchesFeature(token, ruleName) {
  const entry = ANCHORED_FEATURE_RES.find((item) => item.name === ruleName)
  if (!entry) return false
  if (entry.anchored.test(token)) return true
  // 安全正向前缀归一（与 match-service tokenHitsRule 同口径）：有阳台→阳台、带电梯→电梯；否定/专名后缀仍不命中。
  const core = token.replace(/^(有|带|自带|配|支持|接受|可)/, '')
  return core !== token && entry.anchored.test(core)
}

function inferListingFeatures(listing = {}) {
  const text = listingTextForFeatures(listing)
  const tagTokens = listingFreeTagTokens(listing)
  const inferred = FEATURE_INFERENCE_RULES
    .filter((rule) => patternMatchesFeature(text, rule.pattern) || tagTokens.some((token) => tagTokenMatchesFeature(token, rule.name)))
    .map((rule) => rule.name)
  if ((/合租/.test(text) || tagTokens.indexOf('合租') !== -1) && inferred.indexOf('整租') !== -1) {
    inferred.splice(inferred.indexOf('整租'), 1)
  }
  return uniqueTextList(normalizeListingFeatures(inferred))
    .filter((item) => item !== NO_FEATURE && INFERABLE_LISTING_FEATURES.has(item))
}

function featuresWithNoCommission(value, listing = {}) {
  const features = normalizeListingFeatures(value)
  if (!isNoCommissionListing(listing)) return features
  const next = features.filter((item) => item !== NO_FEATURE)
  if (next.indexOf(NO_COMMISSION_FEATURE) === -1) next.push(NO_COMMISSION_FEATURE)
  return next.length ? next : [NO_COMMISSION_FEATURE]
}

function featuresWithCompanyDefaults(value, listing = {}) {
  const companyListing = isCompanyListing(listing)
  const features = featuresWithNoCommission(value, listing).filter((item) => item !== NO_FEATURE)
  if (companyListing && features.indexOf(DEPOSIT_FREE_FEATURE) === -1) {
    features.push(DEPOSIT_FREE_FEATURE)
  }
  // 公司房源一律默认带电梯房：与免押金同为公司房源固定特点，含存量、编辑去掉也会被补回。
  if (companyListing && features.indexOf(ELEVATOR_FEATURE) === -1) {
    features.push(ELEVATOR_FEATURE)
  }
  return features.length ? features : [NO_FEATURE]
}

function listingSourceFields(listing = {}, db = {}) {
  const ownerType = listingSourceType(listing)
  const companyListing = ownerType === COMPANY_SOURCE
  const reviewStatus = ownerReviewStatus({ ...listing, ownerType })
  const sourceLabel = companyListing ? COMPANY_SOURCE : ownerType
  const noCommission = companyListing
  const commissionRate = noCommission ? 0 : commissionRateByOwnerType(ownerType, db)
  return {
    companyListing,
    isCompanyListing: companyListing,
    ownerType,
    isOwnerListing: !companyListing && ownerType === OWNER_SOURCE,
    reviewStatus,
    requiresManualReview: truthyFlag(listing.requiresManualReview),
    manualReviewReason: listing.manualReviewReason || '',
    communityMatched: listing.communityMatched !== undefined ? truthyFlag(listing.communityMatched) : listing.communityMatchStatus !== '未匹配',
    communityMatchStatus: listing.communityMatchStatus || (listing.communityMatched === false ? '未匹配' : '已匹配'),
    noCommission,
    sourceLabel,
    commissionText: noCommission ? COMPANY_COMMISSION_TEXT : publicCommissionTextForOwnerType(ownerType, db),
    commissionBadge: noCommission ? '带看全佣' : `分佣 ${commissionRate + platformRateByOwnerType(ownerType, db)}%`
  }
}

function migrateCompanyListings(db = {}) {
  let changed = false
  ;(db.listings || []).forEach((listing) => {
    const shouldBeCompany = isLegacyRentInventory(listing) || isCompanyListing(listing)
    const shouldNoCommission = shouldBeCompany || isNoCommissionListing(listing)
    if (shouldBeCompany) {
      if (listing.source !== COMPANY_SOURCE) {
        listing.source = COMPANY_SOURCE
        changed = true
      }
      if (listing.ownerType !== COMPANY_SOURCE) {
        listing.ownerType = COMPANY_SOURCE
        changed = true
      }
      if (listing.houseSourceType !== COMPANY_SOURCE) {
        listing.houseSourceType = COMPANY_SOURCE
        changed = true
      }
      if (!listing.companyListing) {
        listing.companyListing = true
        changed = true
      }
      if (!listing.isCompanyListing) {
        listing.isCompanyListing = true
        changed = true
      }
    }
    if (shouldNoCommission && Number(listing.commissionRate || 0) !== 0) {
      listing.commissionRate = 0
      changed = true
    }
    const nextFeatures = featuresWithCompanyDefaults(listing.features, listing)
    if (JSON.stringify(nextFeatures) !== JSON.stringify(normalizeListingFeatures(listing.features))) {
      listing.features = nextFeatures
      changed = true
    }
    if (shouldNoCommission && !listing.noCommission) {
      listing.noCommission = true
      changed = true
    }
  })
  return { changed }
}

function listingFeatureFields(listing = {}) {
  const rawFeatures = parseFeatureInput(listing.features)
  const shouldInfer = rawFeatures.indexOf(NO_FEATURE) === -1
  let features = featuresWithCompanyDefaults(listing.features, listing)
    .filter((item) => item !== NO_FEATURE)
    .concat(shouldInfer ? inferListingFeatures(listing) : [])
  if (isCompanyListing(listing) && features.indexOf(COMPANY_SOURCE) === -1) {
    features.unshift(COMPANY_SOURCE)
  }
  features = uniqueTextList(features)
  if (!features.length) features = [NO_FEATURE]
  return {
    features,
    featureText: featureText(features)
  }
}

function listingDisplayFields(listing = {}, db = {}) {
  const freshness = listingFreshness(listing)
  return {
    ...listingFeatureFields(listing),
    ...listingSourceFields(listing, db),
    lastVerifiedAt: freshness.lastVerifiedAt,
    staleDays: freshness.staleDays,
    verifyStatus: freshness.verifyStatus,
    verifyTip: freshness.verifyTip,
    needsVerify: freshness.needsVerify,
    maintenanceText: maintenanceText(freshness)
  }
}

function recommendationUnavailableReason(listing = {}, fallback = 'not_frontend_effective') {
  if (isExpiredListing(listing)) return 'expired'
  if (isSoldListing(listing)) return 'sold'
  if (isPendingOwnerReview(listing)) {
    if (listing.reviewStatus === '已驳回' || listing.status === '已驳回') return 'review_rejected'
    return 'pending_review'
  }
  if (!hasListingVideo(listing)) return 'missing_video'
  return fallback
}

function syncListingRecommendationProfile(listing, unavailableReason = '') {
  if (!listing) return null
  const generatedAt = nowText()
  if (isFrontendEffectiveListing(listing)) {
    return refreshRecommendationProfile(listing, { generatedAt })
  }
  return clearRecommendationProfile(
    listing,
    unavailableReason || recommendationUnavailableReason(listing),
    { generatedAt }
  )
}

function clearListingRecommendationProfile(listing, reason) {
  if (!listing) return null
  return clearRecommendationProfile(
    listing,
    reason || recommendationUnavailableReason(listing),
    { generatedAt: nowText() }
  )
}

function listingMatchFeatureSet(listing = {}) {
  return new Set(listingFeatureFields(listing).features
    .concat([listing.rentMode, listing.type])
    .filter(Boolean))
}

function relevanceLabel(score) {
  if (score >= 85) return '高相关'
  if (score >= 68) return '较相关'
  if (score >= 50) return '可参考'
  return '低相关'
}

function staleListings(db, userId) {
  return activeListings(db)
    .filter((listing) => !userId || listing.uploaderId === userId)
    .filter((listing) => listingFreshness(listing).needsVerify)
}

function listingMaintenanceRule(db) {
  const saved = db.listingMaintenanceRule || {}
  const rule = {
    ...defaultListingMaintenanceRule(),
    ...saved,
    remindDays: VERIFY_REMINDER_DAYS.slice(),
    expireDays: VERIFY_STALE_DAYS
  }
  return {
    ...rule,
    status: rule.enabled ? '已开启' : '已关闭',
    tip: rule.enabled
      ? `已开启：3 天、5 天提醒上传人电话联系房东；${VERIFY_STALE_DAYS} 天未更新固定自动下架并进入后台资产池。`
      : `已关闭提醒：${VERIFY_STALE_DAYS} 天未更新仍会固定自动下架并进入后台资产池。`
  }
}

function expireListing(db, listing, reason, options = {}) {
  if (!listing || isExpiredListing(listing)) return false
  const freshness = listingFreshness(listing)
  const now = nowText()
  listing.lifecycleStatus = 'expired'
  listing.status = '已下架'
  listing.expiredAt = now
  listing.expiredBy = options.by || 'system'
  listing.expiredPool = '后台资产池'
  listing.expiredReason = reason || `超过 ${VERIFY_STALE_DAYS} 天未电话联系房东确认房态`
  listing.expiredStaleDays = freshness.staleDays
  listing.updatedAt = now
  clearListingRecommendationProfile(listing, 'expired')
  pushFootprint(db, {
    id: id('F'),
    listingId: listing.id,
    viewerId: options.by || 'system',
    action: options.action || '自动下架',
    time: now,
    sync: listing.expiredReason
  })
  return true
}

function autoExpireOverdueListings(db) {
  if (!db || db.__autoExpiringListings) return { expiredCount: 0 }
  db.__autoExpiringListings = true
  let expiredCount = 0
  try {
    rawActiveListings(db).forEach((listing) => {
      const freshness = listingFreshness(listing)
      if (freshness.staleDays >= VERIFY_STALE_DAYS) {
        const expired = expireListing(db, listing, `超过 ${VERIFY_STALE_DAYS} 天未电话联系房东确认房态`)
        if (expired) expiredCount += 1
      }
    })
  } finally {
    delete db.__autoExpiringListings
  }
  return { expiredCount }
}

function enforceListingMaintenanceRule(db) {
  const rule = listingMaintenanceRule(db)
  const { expiredCount } = autoExpireOverdueListings(db)
  return { rule: listingMaintenanceRule(db), expiredCount }
}

function setListingMaintenanceRule(db, adminId, payload = {}) {
  const enabled = Boolean(payload.enabled)
  db.listingMaintenanceRule = {
    enabled,
    remindDays: VERIFY_REMINDER_DAYS.slice(),
    expireDays: VERIFY_STALE_DAYS,
    updatedAt: nowText(),
    updatedBy: adminId || ''
  }
  const result = enforceListingMaintenanceRule(db)
  return {
    ...result.rule,
    expiredCount: result.expiredCount
  }
}

function currentUser(db, userId) {
  const user = userById(db, userId)
  return user ? withoutSecret(user) : {}
}

function assertKnownUser(db, userId) {
  const user = userById(db, userId)
  if (user && !user.deleted && user.status !== '禁用' && user.status !== '已删除') return user
  const error = new Error('未登录或账号未开通，请先使用内部中介账号登录')
  error.statusCode = 403
  throw error
}

function backfillUniqueLinkedAdminPassword(db, user, password) {
  if (!user || user.passwordHash || !user.id) return false
  const linkedAccounts = (db.adminAccounts || []).filter((account) => (
    account &&
    !account.deleted &&
    account.status !== '禁用' &&
    String(account.userId || '').trim() === String(user.id) &&
    String(account.passwordHash || '').trim()
  ))
  if (linkedAccounts.length !== 1) return false
  const account = linkedAccounts[0]
  if (!verifyPassword(password, account.passwordHash)) return false
  return syncLinkedAdminUserPasswordHash(db, account, account.passwordHash, 'linked-admin-login')
}

function loginByPhone(db, phone, password) {
  const target = String(phone || '').trim()
  if (!/^1\d{10}$/.test(target)) {
    const error = new Error('请输入 11 位手机号')
    error.statusCode = 400
    throw error
  }
  const pass = String(password == null ? '' : password)
  if (!pass) {
    const error = new Error('请输入登录密码')
    error.statusCode = 400
    throw error
  }
  // 软删/停用账号禁止登录：与鉴权中间件 miniUserIdFromRequest 同口径排除 deleted 与 status==='禁用'，
  // 避免给停用账号发一个随即在鉴权处失效的无用 token。同号历史软删记录保留但不放行。
  const user = (db.users || []).find((item) => (
    String(item.phone || '') === target && !item.deleted && item.status !== '禁用' && item.status !== '已删除'
  ))
  if (!user) {
    const error = new Error('该手机号未开通内部中介账号，请联系管理员开通')
    error.statusCode = 403
    throw error
  }
  // 存量/后台新建但未设密码的账号：fail-closed 一律禁登，等管理员在后台设初始密码，绝不免密放行
  // （否则任何人凭手机号即可绕过密码登录）。唯一例外是服务端 userId 唯一绑定了一个有效管理账号，
  // 且本次输入已通过该管理账号的 scrypt 哈希验证：此时安全回填同一哈希，让已发生的后台改密立即生效。
  if (!user.passwordHash) backfillUniqueLinkedAdminPassword(db, user, pass)
  if (!user.passwordHash) {
    const error = new Error('账号尚未设置登录密码，请联系管理员开通或重置密码')
    error.statusCode = 403
    throw error
  }
  // 密码错误与账号不存在返回不同提示，是内部 B2B 工具的取舍：账号不存在需引导「联系管理员开通」，
  // 密码错则统一「手机号或密码不正确」不暴露命中与否。爆破由 index.js 登录路由 IP 限流兜。
  if (!verifyPassword(pass, user.passwordHash)) {
    const error = new Error('手机号或密码不正确')
    error.statusCode = 403
    throw error
  }
  return clone(user)
}

function registerUser(db, payload = {}) {
  const name = String(payload.name || '').trim()
  const phone = String(payload.phone || '').trim()
  const password = String(payload.password == null ? '' : payload.password)
  if (!phone) {
    const error = new Error('手机号必填')
    error.statusCode = 400
    throw error
  }
  if (!name) {
    const error = new Error('姓名必填')
    error.statusCode = 400
    throw error
  }
  // 姓名长度上限：既防超大 DB 行，也堵住「超长 name 经通知 argv 触发 execve E2BIG 打崩服务」的路径。
  if (name.length > 50) {
    const error = new Error('姓名过长')
    error.statusCode = 400
    throw error
  }
  if (!/^1\d{10}$/.test(phone)) {
    const error = new Error('请输入 11 位手机号')
    error.statusCode = 400
    throw error
  }
  const pwIssue = passwordIssue(password)
  if (pwIssue) {
    const error = new Error(pwIssue)
    error.statusCode = 400
    throw error
  }

  // 已开通且未删除的账号：不再免密发 token（堵后门——否则任意人凭已开通手机号 + 随便一个密码走注册
  // 就能拿到登录态）。改为引导：已设密码→直接登录；未设密码→联系管理员重置。一律 pendingReview 不发 token。
  const existed = (db.users || []).find((item) => String(item.phone || '') === phone && !item.deleted)
  if (existed) {
    return {
      pendingReview: true,
      statusCode: 409,
      status: '已开通',
      message: existed.passwordHash
        ? '该手机号已开通账号，请直接用手机号和密码登录'
        : '该手机号已开通但尚未设置登录密码，请联系管理员重置密码后登录'
    }
  }

  // 未开通：落库为“待审核”注册申请（含用户自设密码的哈希，审核通过时写入新账号）；此处不发 token，
  // 路由层据 pendingReview 返回待审核提示。手机号是申请归属凭据：待审核期间的同号重复提交必须严格幂等，
  // 绝不能覆盖先申请者的姓名或密码；只有已驳回/已通过（账号后来被删）才允许开启一轮重新申请。
  db.registrationRequests = db.registrationRequests || []
  const pendingExisted = db.registrationRequests.find((item) => String(item.phone || '') === phone)
  if (pendingExisted && pendingExisted.status === '待审核') {
    return {
      pendingReview: true,
      statusCode: 403,
      status: '待审核',
      notifyAdmin: false,
      registrationRequestId: pendingExisted.id,
      message: '已收到您的注册信息，期待和您的合作，请联系寓你住一起管理员开通账号权限'
    }
  }

  const createdAt = nowText()
  const passwordHash = hashPassword(password)
  let request
  if (pendingExisted) {
    request = pendingExisted
    request.name = name
    request.passwordHash = passwordHash
    request.status = '待审核'
    request.reAppliedAt = createdAt
    request.updatedAt = createdAt
    request.notifyStatus = 'pending'
    request.notifyAttempts = 0
    delete request.notifyLastAttemptAt
    delete request.notifySentAt
    delete request.notifyLastError
    delete request.notifyAttemptId
    delete request.notifyDeadLetterAt
    delete request.notifyDeadLetterReason
    delete request.notifyDeadLetterAlertAttemptedAt
    delete request.notifyDeadLetterAlertStatus
    delete request.notifyDeadLetterAlertSentAt
    delete request.notifyDeadLetterAlertLastError
    delete request.rejectReason
    delete request.reviewedAt
    delete request.reviewedBy
    delete request.approvedType
    delete request.userId
  } else {
    request = {
      id: id('R'),
      name,
      phone,
      passwordHash,
      status: '待审核',
      source: 'mini-register',
      notifyStatus: 'pending',
      notifyAttempts: 0,
      createdAt,
      updatedAt: createdAt
    }
    db.registrationRequests.unshift(request)
  }
  // registrationRequestId 仅供路由层排入通知任务，随 throw 丢弃、不进客户端响应。
  return {
    pendingReview: true,
    statusCode: 403,
    status: '待审核',
    notifyAdmin: true,
    registrationRequestId: request.id,
    message: '已收到您的注册信息，期待和您的合作，请联系寓你住一起管理员开通账号权限'
  }
}

// ---------- 账号类型与创建/删除（需求1：中介/员工账号 + 全类型软删） ----------
// 语义（与用户确认）：管理账号=后台账号(adminAccounts，走 /admin/accounts)；中介/员工=小程序用户
// (db.users，手机号登录)。中介 role=中介(有敏感查看额度)、员工 role=内部员工(内部上传/带看)。
const MANAGED_USER_TYPES = {
  broker: { role: BROKER_ROLE, authed: BROKER_AUTHED, label: '中介账号' },
  staff: { role: '内部员工', authed: BROKER_AUTHED, label: '员工账号' }
}

function normalizeManagedType(type) {
  const raw = String(type || '').trim()
  if (raw === 'broker' || raw === '中介' || raw === '中介账号') return 'broker'
  if (raw === 'staff' || raw === '员工' || raw === '内部员工' || raw === '员工账号') return 'staff'
  return ''
}

const STAFF_LISTING_AUTO_APPROVAL_NOTE = '内部员工上传，按员工权限自动通过'

function isStaffUser(user = {}) {
  if (!user || user.isAdmin) return false
  const accountTypeText = String(user.accountType || '').trim()
  const accountType = normalizeManagedType(accountTypeText)
  const roleText = String(user.role || '').trim()
  const roleType = normalizeManagedType(roleText)
  const legacyStaffRole = /^内部员工(?:\s*·.*)?$/.test(roleText)

  // 新账号以服务端 accountType 为主；若 accountType 与 role 冲突则收紧为非员工，避免脏数据放大权限。
  if (accountTypeText) {
    if (accountType !== 'staff') return false
    return !roleText || roleType === 'staff' || legacyStaffRole
  }
  return roleType === 'staff' || legacyStaffRole
}

function shouldAutoApproveStaffListing(user = {}, fields = {}) {
  if (!isStaffUser(user) || fields.companyListing) return false
  return fields.ownerType === OWNER_SOURCE || fields.ownerType === SECOND_LANDLORD_SOURCE
}

function isStaffAutoApprovedListing(listing = {}) {
  return listing.reviewStatus === '已通过' && listing.reviewNote === STAFF_LISTING_AUTO_APPROVAL_NOTE
}

function applyStaffListingAutoApproval(listing, userId, reviewedAt = nowText()) {
  listing.reviewStatus = '已通过'
  if (listing.status === '待审核' || listing.status === '已驳回') listing.status = '待确认'
  listing.reviewedAt = reviewedAt
  listing.reviewerId = userId
  listing.reviewNote = STAFF_LISTING_AUTO_APPROVAL_NOTE
}

function clearStaffListingAutoApproval(listing) {
  if (listing.reviewNote !== STAFF_LISTING_AUTO_APPROVAL_NOTE) return
  delete listing.reviewedAt
  delete listing.reviewerId
  delete listing.reviewNote
}

// 创建中介/员工账号（db.users）。后台“新增账号”与“注册审核开通”共用同一条创建路径，口径一致。
function createManagedUser(db, payload = {}) {
  const kind = normalizeManagedType(payload.type)
  if (!kind) {
    const error = new Error('账号类型只能是中介或员工')
    error.statusCode = 400
    throw error
  }
  const name = String(payload.name || '').trim()
  const phone = String(payload.phone || '').trim()
  if (!name) {
    const error = new Error('姓名必填')
    error.statusCode = 400
    throw error
  }
  if (!/^1\d{10}$/.test(phone)) {
    const error = new Error('请输入 11 位手机号')
    error.statusCode = 400
    throw error
  }
  db.users = db.users || []
  // 去重：同手机号已有未删除账号则拒绝（软删账号不占号，可重新开通）。
  const active = db.users.find((item) => String(item.phone || '') === phone && !item.deleted)
  if (active) {
    const error = new Error('该手机号已开通账号')
    error.statusCode = 400
    throw error
  }
  // 密码：审核开通透传注册时已哈希的 passwordHash；后台直接建号可给明文 password（此处校验强度后哈希）。
  // 两者都没有时账号无 passwordHash，登录 fail-closed 禁登，需管理员事后在后台设初始密码。
  let passwordHash = ''
  if (payload.passwordHash) {
    passwordHash = String(payload.passwordHash)
  } else if (payload.password) {
    const pwIssue = passwordIssue(payload.password)
    if (pwIssue) {
      const error = new Error(pwIssue)
      error.statusCode = 400
      throw error
    }
    passwordHash = hashPassword(payload.password)
  }
  const preset = MANAGED_USER_TYPES[kind]
  const nowText = new Date().toLocaleString('zh-CN', { hour12: false })
  const user = {
    id: id('U'),
    name,
    phone,
    role: preset.role,
    accountType: kind,
    isAdmin: false,
    authed: preset.authed,
    brokerStatus: '启用',
    tokenVersion: 0,
    points: 0,
    createdAt: nowText,
    createdBy: String(payload.operator || '') || 'admin',
    source: payload.source || 'admin-created'
  }
  if (passwordHash) user.passwordHash = passwordHash
  db.users.push(user)
  // 注意：返回的是含 passwordHash 的活对象，仅供内部调用者使用（reviewRegistration 会经 withoutSecret
  // 脱敏后才进响应；/admin/users 路由忽略此返回值改用 adminUsers）。禁止把此返回值直接 sendJson 下发。
  return user
}

// 软删中介/员工账号：禁止登录 + 从账号列表隐藏，但名下房源/报备/成交/分佣等历史数据原样保留，
// 避免悬挂引用（与 adminAccounts 软删一致）。管理员用户不在此删除（其后台账号走 /admin/accounts）。
function deleteManagedUser(db, payload = {}) {
  const targetId = String(payload.id || '').trim()
  db.users = db.users || []
  const user = db.users.find((item) => item.id === targetId && !item.deleted)
  if (!user) {
    const error = new Error('未找到该账号')
    error.statusCode = 404
    throw error
  }
  if (user.isAdmin || /管理员/.test(String(user.role || ''))) {
    const error = new Error('管理员账号请在后台账号列表删除')
    error.statusCode = 400
    throw error
  }
  const nowText = new Date().toLocaleString('zh-CN', { hour12: false })
  // 软删本身已会被鉴权层拒绝；仍提升版本，避免将来恢复/误改 deleted 状态时旧 token 复活。
  revokeUserTokens(user)
  user.deleted = true
  user.status = '已删除'
  user.brokerStatus = '已删除'
  user.deletedAt = nowText
  user.deletedBy = String(payload.operator || '') || 'admin'
  return clone(user)
}

// 主动退出采用现有账号级 tokenVersion 撤销全部设备。当前 token 身份只由路由层验签结果传入，
// 不读取客户端 body 里的 userId、版本、角色或权限字段。
function logoutUserSessions(db, userId) {
  db.users = db.users || []
  const user = db.users.find((item) => item.id === userId && !item.deleted && item.status !== '禁用' && item.status !== '已删除')
  if (!user) {
    const error = new Error('登录用户不存在或已停用')
    error.statusCode = 401
    throw error
  }
  revokeUserTokens(user)
  return { loggedOut: true, scope: 'all-devices' }
}

// 中介/员工账号状态与后台管理员账号状态是两套独立权限域。停用只接受严格动作，首次停用
// 提升 tokenVersion；重复停用幂等，恢复绝不回退版本，因此停用前 token 永远不能复活。
function setManagedUserStatus(db, payload = {}) {
  const targetId = String(payload.id || '').trim()
  const action = String(payload.action || '').trim().toLowerCase()
  if (action !== 'enable' && action !== 'disable') {
    const error = new Error('账号状态操作只允许 enable 或 disable')
    error.statusCode = 400
    throw error
  }
  db.users = db.users || []
  const user = db.users.find((item) => item.id === targetId && !item.deleted)
  if (!user) {
    const error = new Error('未找到该账号')
    error.statusCode = 404
    throw error
  }
  if (user.isAdmin || /管理员/.test(String(user.role || ''))) {
    const error = new Error('管理员账号请在后台账号列表调整状态')
    error.statusCode = 400
    throw error
  }

  const disabled = user.status === '禁用'
  if (action === 'disable' && !disabled) revokeUserTokens(user)
  const nextStatus = action === 'disable' ? '禁用' : '启用'
  user.status = nextStatus
  user.brokerStatus = nextStatus
  user.statusUpdatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  user.statusUpdatedBy = String(payload.operator || '') || 'admin'
  return withoutSecret(user)
}

// 注册申请里存了用户自设密码的哈希（审核通过时写入新账号），列表返回给后台前必须剥离，勿外泄。
function sanitizeRegistrationRequest(item) {
  const copy = clone(item)
  delete copy.passwordHash
  return copy
}

function registrationNotifyAttempts(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function sanitizeRegistrationNotifySummary(value, fallback = '通知发送失败') {
  const summary = String(value || fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return summary || fallback
}

// 通知发送前原子领取一次尝试。sending 也允许在进程重启后重新领取，提供至少一次送达语义；
// index.js 的进程内任务集合负责避免同一进程重复领取，持久化 attempts 负责封住最多三次的上限。
function beginRegistrationNotification(db, requestId, maxAttempts = 3) {
  const targetId = String(requestId || '').trim()
  const limit = Math.max(1, Number.parseInt(maxAttempts, 10) || 3)
  const request = (db.registrationRequests || []).find((item) => item.id === targetId)
  if (!request || request.status !== '待审核' || request.notifyStatus === 'sent' || request.notifyStatus === 'dead_letter') return null

  const attempts = registrationNotifyAttempts(request.notifyAttempts)
  if (attempts >= limit) return null

  request.notifyStatus = 'sending'
  request.notifyAttempts = attempts + 1
  request.notifyLastAttemptAt = nowText()
  request.notifyAttemptId = id('RN')
  delete request.notifyLastError
  return {
    id: request.id,
    name: request.name,
    phone: request.phone,
    notifyAttempts: request.notifyAttempts,
    notifyAttemptId: request.notifyAttemptId
  }
}

function finishRegistrationNotification(db, requestId, result = {}) {
  const targetId = String(requestId || '').trim()
  const limit = Math.max(1, Number.parseInt(result.maxAttempts, 10) || 3)
  const request = (db.registrationRequests || []).find((item) => item.id === targetId)
  if (!request) return null

  const attemptId = String(result.attemptId || '').trim()
  if (!attemptId || request.notifyAttemptId !== attemptId) {
    return {
      id: request.id,
      stale: true,
      notifyStatus: request.notifyStatus,
      notifyAttempts: registrationNotifyAttempts(request.notifyAttempts)
    }
  }
  delete request.notifyAttemptId

  if (result.ok) {
    request.notifyStatus = 'sent'
    request.notifySentAt = nowText()
    delete request.notifyLastError
    delete request.notifyDeadLetterAt
    delete request.notifyDeadLetterReason
  } else {
    const summary = sanitizeRegistrationNotifySummary(result.error, '通知发送失败')
    request.notifyLastError = summary
    if (registrationNotifyAttempts(request.notifyAttempts) >= limit) {
      request.notifyStatus = 'dead_letter'
      request.notifyDeadLetterAt = request.notifyDeadLetterAt || nowText()
      request.notifyDeadLetterReason = summary
    } else {
      request.notifyStatus = 'failed'
      delete request.notifyDeadLetterAt
      delete request.notifyDeadLetterReason
    }
  }
  return {
    id: request.id,
    stale: false,
    notifyStatus: request.notifyStatus,
    notifyAttempts: registrationNotifyAttempts(request.notifyAttempts),
    notifyLastError: request.notifyLastError || '',
    deadLetter: request.notifyStatus === 'dead_letter',
    notifyDeadLetterAt: request.notifyDeadLetterAt || '',
    notifyDeadLetterReason: request.notifyDeadLetterReason || ''
  }
}

function pendingRegistrationNotificationIds(db, maxAttempts = 3) {
  const limit = Math.max(1, Number.parseInt(maxAttempts, 10) || 3)
  return (db.registrationRequests || [])
    .filter((item) => item && item.id && item.status === '待审核')
    .filter((item) => item.notifyStatus !== 'sent' && item.notifyStatus !== 'dead_letter')
    .filter((item) => registrationNotifyAttempts(item.notifyAttempts) < limit)
    .map((item) => item.id)
}

function claimRegistrationNotifyDeadLetterAlert(db, requestId) {
  const targetId = String(requestId || '').trim()
  const request = (db.registrationRequests || []).find((item) => item.id === targetId)
  if (!request || request.status !== '待审核' || request.notifyStatus !== 'dead_letter') return null
  if (request.notifyDeadLetterAlertStatus === 'sent') return null
  request.notifyDeadLetterAlertAttemptedAt = nowText()
  request.notifyDeadLetterAlertStatus = 'sending'
  delete request.notifyDeadLetterAlertLastError
  return {
    id: request.id,
    notifyAttempts: registrationNotifyAttempts(request.notifyAttempts),
    notifyLastError: request.notifyLastError || '',
    notifyDeadLetterAt: request.notifyDeadLetterAt || '',
    notifyDeadLetterReason: request.notifyDeadLetterReason || ''
  }
}

function finishRegistrationNotifyDeadLetterAlert(db, requestId, result = {}) {
  const targetId = String(requestId || '').trim()
  const request = (db.registrationRequests || []).find((item) => item.id === targetId)
  if (!request || request.notifyStatus !== 'dead_letter' || !request.notifyDeadLetterAlertAttemptedAt) return null
  if (result.ok) {
    request.notifyDeadLetterAlertStatus = 'sent'
    request.notifyDeadLetterAlertSentAt = nowText()
    delete request.notifyDeadLetterAlertLastError
  } else {
    request.notifyDeadLetterAlertStatus = 'failed'
    request.notifyDeadLetterAlertLastError = sanitizeRegistrationNotifySummary(result.error, '死信告警发送失败')
  }
  return {
    id: request.id,
    notifyDeadLetterAlertStatus: request.notifyDeadLetterAlertStatus
  }
}

function pendingRegistrationNotifyDeadLetterAlertIds(db) {
  return (db.registrationRequests || [])
    .filter((item) => item && item.id && item.status === '待审核')
    .filter((item) => item.notifyStatus === 'dead_letter')
    .filter((item) => item.notifyDeadLetterAlertStatus !== 'sent')
    .map((item) => item.id)
}

// ---------- 注册审核（需求2） ----------
function listRegistrationRequests(db) {
  return (db.registrationRequests || []).map((item) => sanitizeRegistrationRequest(item))
}

// 后台设置/重置小程序用户（中介/员工）登录密码：存量或后台新建但未设密码的账号由管理员在此发初始密码。
function setManagedUserPassword(db, payload = {}) {
  const targetId = String(payload.id || '').trim()
  const password = String(payload.password == null ? '' : payload.password)
  const pwIssue = passwordIssue(password)
  if (pwIssue) {
    const error = new Error(pwIssue)
    error.statusCode = 400
    throw error
  }
  db.users = db.users || []
  const user = db.users.find((item) => item.id === targetId && !item.deleted)
  if (!user) {
    const error = new Error('未找到该账号')
    error.statusCode = 404
    throw error
  }
  if (user.isAdmin || /管理员/.test(String(user.role || ''))) {
    const error = new Error('管理员账号请在后台账号列表重置密码')
    error.statusCode = 400
    throw error
  }
  const nowText = new Date().toLocaleString('zh-CN', { hour12: false })
  user.passwordHash = hashPassword(password)
  delete user.password
  user.passwordUpdatedAt = nowText
  user.passwordUpdatedBy = String(payload.operator || '') || 'admin'
  // 管理员设密/重置后，所有已签发的小程序 token 立即失效。
  revokeUserTokens(user)
  return withoutSecret(user)
}

// 管理账号与小程序用户是两套鉴权记录，但可通过服务端 userId 显式绑定同一人。后台创建/重置
// 管理账号密码时，只沿这个持久绑定单向同步；绝不按账号文本或手机号猜测，避免串改他人密码。
function syncLinkedAdminUserPasswordHash(db, account = {}, passwordHash, operator) {
  const linkedUserId = String(account.userId || '').trim()
  const nextHash = String(passwordHash || '').trim()
  if (!linkedUserId || !nextHash) return false
  db.users = db.users || []
  const user = db.users.find((item) => item.id === linkedUserId && !item.deleted)
  if (!user) return false
  user.passwordHash = nextHash
  delete user.password
  user.passwordUpdatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  user.passwordUpdatedBy = String(operator || '') || 'admin'
  revokeUserTokens(user)
  return true
}

// 小程序用户登录后自助修改密码：userId 由服务端 token 解析（不信任客户端身份），校验原密码后写入新密码哈希。
function changeOwnPassword(db, userId, payload = {}) {
  const oldPassword = String(payload.oldPassword == null ? '' : payload.oldPassword)
  const newPassword = String(payload.newPassword == null ? '' : payload.newPassword)
  db.users = db.users || []
  const user = db.users.find((item) => item.id === userId && !item.deleted && item.status !== '禁用')
  if (!user) {
    const error = new Error('登录用户不存在或已停用')
    error.statusCode = 401
    throw error
  }
  if (!oldPassword) {
    const error = new Error('请输入原密码')
    error.statusCode = 400
    throw error
  }
  // 已登录用户必然已设密码；无 passwordHash 或原密码不对一律 403（不泄露是哪种）。
  if (!user.passwordHash || !verifyPassword(oldPassword, user.passwordHash)) {
    const error = new Error('原密码不正确')
    error.statusCode = 403
    throw error
  }
  const issue = passwordIssue(newPassword)
  if (issue) {
    const error = new Error(issue)
    error.statusCode = 400
    throw error
  }
  if (verifyPassword(newPassword, user.passwordHash)) {
    const error = new Error('新密码不能与原密码相同')
    error.statusCode = 400
    throw error
  }
  user.passwordHash = hashPassword(newPassword)
  delete user.password
  user.passwordUpdatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  user.passwordUpdatedBy = 'self'
  // 自助改密同样撤销全部旧会话；路由层会为当前设备签发新版本 token。
  revokeUserTokens(user)
  return withoutSecret(user)
}

// 审核注册申请：通过→按管理员选定类型(中介/员工)开通 db.users；驳回→标记拒绝 + 可留原因。
function reviewRegistration(db, payload = {}) {
  const targetId = String(payload.id || '').trim()
  const action = String(payload.action || '').trim()
  db.registrationRequests = db.registrationRequests || []
  const request = db.registrationRequests.find((item) => item.id === targetId)
  if (!request) {
    const error = new Error('未找到注册申请')
    error.statusCode = 404
    throw error
  }
  if (request.status !== '待审核') {
    const error = new Error('该申请已处理')
    error.statusCode = 400
    throw error
  }
  const nowText = new Date().toLocaleString('zh-CN', { hour12: false })
  if (action === 'approve') {
    // createManagedUser 内部会做手机号去重（若审核期间该号已被开通则拒绝，防重复建号）。
    // 透传注册时用户自设的密码哈希，开通后用户即可用注册密码登录，无需管理员再设初始密码。
    const user = createManagedUser(db, {
      type: payload.type || 'broker',
      name: request.name,
      phone: request.phone,
      passwordHash: request.passwordHash,
      operator: payload.operator,
      source: 'registration'
    })
    request.status = '已通过'
    request.reviewedAt = nowText
    request.reviewedBy = String(payload.operator || '') || 'admin'
    request.approvedType = normalizeManagedType(payload.type) || 'broker'
    request.userId = user.id
    return { request: sanitizeRegistrationRequest(request), user: withoutSecret(user) }
  }
  if (action === 'reject') {
    request.status = '已驳回'
    request.reviewedAt = nowText
    request.reviewedBy = String(payload.operator || '') || 'admin'
    request.rejectReason = String(payload.reason || '').trim()
    return { request: sanitizeRegistrationRequest(request) }
  }
  const error = new Error('审核操作只能是通过或驳回')
  error.statusCode = 400
  throw error
}

function pointBalance(db, userId) {
  return (db.pointLogs || []).reduce((total, log) => {
    if (log.userId !== userId) return total
    return total + Number(log.change || 0)
  }, 0)
}

function areaStats(db) {
  const map = new Map()
  publicListings(db).forEach((listing) => {
    const area = listing.area || '待分区'
    map.set(area, (map.get(area) || 0) + 1)
  })
  return Array.from(map.entries()).map(([area, count]) => ({ area, count }))
}

function dashboardSummary(db) {
  const areas = areaStats(db)
  const groups = db.groups || []
  const users = db.users || []
  const today = todayKey()
  return {
    listingCount: publicListings(db).length,
    areaStats: areas,
    staleListingCount: staleListings(db).length,
    expiredListingCount: (db.listings || []).filter(isExpiredListing).length,
    groupCount: groups.length,
    unlockedGroupCount: groups.filter((group) => group.unlocked).length,
    userCount: users.length,
    authedUsers: users.filter((user) => user.authed === '已实名').length,
    todaySensitiveViews: (db.footprints || []).filter((item) => (
      isSensitiveViewFootprint(item) && footprintDateKey(item) === today
    )).length,
    pendingShowingUploadCount: (db.showingUploads || []).filter((item) => item.status === '待审核').length
  }
}

function todayKey() {
  return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

function footprintDateKey(record = {}) {
  if (record.dateKey) return String(record.dateKey)
  if (record.time === '刚刚') return todayKey()
  const occurredAtMs = footprintTimestampMs(record)
  return occurredAtMs === null
    ? ''
    : new Date(occurredAtMs).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

function isSensitiveViewFootprint(record = {}) {
  if (/^sensitive_(?:view|info)$/i.test(String(record.actionType || ''))) return true
  if (record.quotaCategory) return true
  return /查看地址和电话|查看敏感信息/.test(String(record.action || ''))
}

function isPhoneViewFootprint(record = {}) {
  return String(record.actionType || '') === 'phone_call_opened' || /电话查看/.test(String(record.action || ''))
}

function isBrokerUser(user = {}) {
  return !user.isAdmin && String(user.role || '').indexOf(BROKER_ROLE) !== -1
}

function sensitiveQuotaCategory(listing = {}, userId = '') {
  if (listing.uploaderId === userId) return 'own'
  return isOwnerListing(listing) ? 'owner' : 'normal'
}

function brokerSensitiveUsage(db, userId, date = todayKey()) {
  const ownerIds = new Set()
  const normalIds = new Set()
  ;(db.footprints || []).forEach((record) => {
    if (record.viewerId !== userId) return
    if (!isSensitiveViewFootprint(record)) return
    if (footprintDateKey(record) !== date) return
    const category = record.quotaCategory || sensitiveQuotaCategory(listingById(db, record.listingId) || {}, userId)
    if (category === 'owner') ownerIds.add(record.listingId)
    if (category === 'normal') normalIds.add(record.listingId)
  })
  const normalBonus = (db.showingUploads || []).filter((item) => (
    item.userId === userId &&
    item.status === '已通过' &&
    item.rewardGranted &&
    (item.rewardDateKey || item.reviewedDateKey || item.dateKey) === date
  )).length
  const normalLimit = NORMAL_DAILY_VIEW_LIMIT + normalBonus
  return {
    date,
    ownerUsed: ownerIds.size,
    normalUsed: normalIds.size,
    ownerLimit: OWNER_DAILY_VIEW_LIMIT,
    normalLimit,
    normalBonus,
    ownerRemaining: Math.max(0, OWNER_DAILY_VIEW_LIMIT - ownerIds.size),
    normalRemaining: Math.max(0, normalLimit - normalIds.size)
  }
}

function normalizePurposePayload(payload = {}) {
  if (typeof payload === 'string') return { action: payload, purpose: '', needId: '' }
  return {
    action: payload.action || '',
    purpose: String(payload.purpose || payload.scene || payload.reason || '').trim(),
    needId: String(payload.needId || payload.rentalNeedId || payload.clientNeedId || '').trim()
  }
}

function assertUserNeed(db, userId, needId, fieldName = 'needId') {
  if (!needId) {
    const error = new Error(`${fieldName}必填`)
    error.statusCode = 400
    throw error
  }
  const need = rentalNeedById(db, needId)
  if (!need) {
    const error = new Error('未找到需求单')
    error.statusCode = 404
    throw error
  }
  if (need.brokerId !== userId) {
    const error = new Error('只能使用自己的需求单')
    error.statusCode = 403
    throw error
  }
  return need
}

function assertSensitiveViewerEligible(db, userId) {
  const viewer = assertKnownUser(db, userId)
  if (!isBrokerUser(viewer) && viewer.authed !== '已实名') {
    const error = new Error('查看地址和房东联系方式前需要先完成实名认证')
    error.statusCode = 403
    throw error
  }
  return viewer
}

function assertSensitiveViewQuotaAllowed(db, userId, listing) {
  const category = sensitiveQuotaCategory(listing, userId)
  const date = todayKey()
  const alreadyViewed = (db.footprints || []).some((record) => {
    if (record.viewerId !== userId || record.listingId !== listing.id) return false
    return isSensitiveViewFootprint(record) && footprintDateKey(record) === date
  })
  if (alreadyViewed) return { category, quota: brokerSensitiveUsage(db, userId, date) }

  const quota = brokerSensitiveUsage(db, userId, date)
  const limit = category === 'owner' ? quota.ownerLimit : quota.normalLimit
  const used = category === 'owner' ? quota.ownerUsed : quota.normalUsed
  if (used >= limit) {
    const error = new Error('今日可查看额度已用完，如需继续查看，请联系管理员帮忙联系房东。')
    error.statusCode = 403
    error.data = {
      quotaExceeded: true,
      quotaCategory: category,
      quota
    }
    throw error
  }
  return { category, quota }
}

function assertSensitiveViewAllowed(db, userId, listing) {
  assertSensitiveViewerEligible(db, userId)
  return assertSensitiveViewQuotaAllowed(db, userId, listing)
}

function adminUsers(db) {
  return (db.users || []).map((user) => {
    const quota = brokerSensitiveUsage(db, user.id)
    return {
      ...withoutSecret(user),
      hasPassword: Boolean(user.passwordHash),
      todayOwnerViews: quota.ownerUsed,
      todayNormalViews: quota.normalUsed,
      ownerViewLimit: quota.ownerLimit,
      normalViewLimit: quota.normalLimit
    }
  })
}

function formatHomeListing(db, listing) {
  const uploader = userById(db, listing.uploaderId) || {}
  const location = publicListingLocationFields(listing)
  const display = listingDisplayFields(listing, db)
  const companyPublic = companyPublicListingFields(listing)
  const publicTitle = publicListingTitle(listing, location)
  const companyListing = isCompanyListing(listing)
  const mediaText = hasListingVideo(listing) ? '仅视频' : (companyListing ? '公司房源表' : '待补视频')
  const commissionText = display.commissionText
  return {
    id: listing.id,
    title: publicTitle,
    meta: `${location.locationSummary || location.area} · ${listing.layout} · ${mediaText}`,
    sub: `${display.sourceLabel} · ${commissionText} · 上传人 ${uploader.name || '平台'}`,
    price: `¥${listing.rent}/月`,
    tag: companyListing ? '公司房源' : `${commissionRateForListing(listing, db)}%`,
    videoUrl: listing.videoUrl || '',
    hasVideo: hasListingVideo(listing),
    coverUrl: listingCoverUrl(listing),
    layout: listing.layout || '',
    rentMode: listing.rentMode || listing.type || '',
    type: listing.type || listing.rentMode || '',
    ...display,
    ...location,
    ...companyPublic
  }
}

function homeListings(db) {
  return publicListings(db).slice(0, 3).map((item) => formatHomeListing(db, item))
}

function matchesCategory(listing, category) {
  if (!category || category === '全部') return true
  if ([COMPANY_SOURCE, OWNER_SOURCE, SECOND_LANDLORD_SOURCE].indexOf(category) !== -1) {
    return listingSourceType(listing) === category
  }
  const display = listingDisplayFields(listing)
  const type = `${listing.type || ''}${listing.layout || ''}${listing.source || ''}${display.ownerType || ''}${display.sourceLabel || ''}`
  return type.indexOf(category) !== -1
}

function isCompanyOnlyFilter(filter = {}) {
  if (filter.companyOnly === true || filter.companyOnly === 'true' || filter.companyOnly === '1') return true
  const text = [
    filter.category,
    filter.sourceType,
    filter.ownerType,
    filter.source
  ].map((item) => String(item || '')).join(' ')
  return /公司房源|company/.test(text)
}

function roomCountFromLayoutText(value = '') {
  const text = String(value || '')
  const matched = text.match(/([一二两三四五六七八九]|\d+)\s*室/)
  if (!matched) return 0
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  return map[matched[1]] || Number(matched[1]) || 0
}

function matchesLayoutFilter(listing = {}, layoutFilter = '') {
  const filter = String(layoutFilter || '').trim()
  if (!filter || filter === '不限') return true
  const roomCount = roomCountFromLayoutText([listing.layout, listing.room, listing.type, listing.rentMode].join(' '))
  if (filter === '一室') return roomCount === 1
  if (filter === '两室' || filter === '二室') return roomCount === 2
  if (filter === '三室') return roomCount === 3
  if (filter === '三室以上') return roomCount >= 3
  return String(listing.layout || '').indexOf(filter) !== -1
}

function filterListings(db, filter = {}) {
  const companyOnly = isCompanyOnlyFilter(filter)
  const districtFilter = String(filter.district || '').trim()
  const requestedFeatures = parseFeatureInput(filter.features || filter.feature)
  return publicListings(db)
    .filter((listing) => {
      const locationText = publicLocationSearchText(listing)
      if (companyOnly && !isCompanyListing(listing)) return false
      if (!matchesCategory(listing, filter.category)) return false
      if (districtFilter && [listing.district, listing.area].map((item) => String(item || '')).join('').indexOf(districtFilter) === -1) return false
      if (filter.area && locationText.indexOf(filter.area) === -1) return false
      if (filter.block && locationText.indexOf(filter.block) === -1) return false
      if (filter.community && String(listing.community || '').indexOf(filter.community) === -1) return false
      if (!matchesLayoutFilter(listing, filter.layout)) return false
      if (filter.rentMode && (listing.rentMode || listing.type) !== filter.rentMode) return false
      if (filter.rentMin && Number(listing.rent || 0) < Number(filter.rentMin)) return false
      if (filter.rentMax && Number(listing.rent || 0) > Number(filter.rentMax)) return false
      if (requestedFeatures.length) {
        const featureSet = listingMatchFeatureSet(listing)
        if (!requestedFeatures.every((feature) => featureSet.has(feature))) return false
      }
      return true
    })
    .map((listing) => {
      const row = formatHomeListing(db, listing)
      return {
        ...row,
        layout: listing.layout || '',
        rent: Number(listing.rent || 0),
        type: listing.type || '',
        rentMode: listing.rentMode || listing.type || '',
        room: listing.room || '',
        hall: listing.hall || '',
        bath: listing.bath || '',
        source: listing.source || '',
        status: listing.status || '',
        companyListing: row.companyListing,
        noCommission: Boolean(row.noCommission),
        sourceLabel: row.sourceLabel,
        commissionText: row.commissionText
      }
    })
}

function favoriteRows(db, mutable = false) {
  const rows = db.favorites
  if (rows === undefined) {
    if (mutable) db.favorites = []
    return mutable ? db.favorites : []
  }
  const invalidStructure = !Array.isArray(rows) || rows.some((item) => (
    !item || typeof item !== 'object' || Array.isArray(item) ||
    !String(item.id || '').trim() || !String(item.userId || '').trim() ||
    !String(item.listingId || '').trim() || !Number.isFinite(Date.parse(String(item.createdAt || '')))
  ))
  const ids = Array.isArray(rows) ? rows.map((item) => item && String(item.id || '')).filter(Boolean) : []
  if (!invalidStructure && new Set(ids).size === ids.length) return rows
  const error = new Error('收藏关系数据结构异常，拒绝覆盖原数据')
  error.statusCode = 500
  throw error
}

function normalizedFavoriteListingId(listingId) {
  const value = String(listingId || '').trim()
  if (value) return value
  const error = new Error('缺少房源编号')
  error.statusCode = 400
  throw error
}

function favoriteRelationship(db, userId, listingId) {
  return favoriteRows(db).find((item) => (
    item && String(item.userId || '') === String(userId || '') &&
    String(item.listingId || '') === String(listingId || '')
  ))
}

function assertFavoriteUser(db, userId) {
  const user = assertKnownUser(db, userId)
  if (user.deleted || user.status === '禁用') {
    const error = new Error('登录用户不存在或已停用')
    error.statusCode = 403
    throw error
  }
  return user
}

function uniqueFavoriteId(rows) {
  const base = `FV${crypto.randomUUID().replace(/-/g, '')}`
  let candidate = base
  let suffix = 1
  const used = new Set((rows || []).map((item) => item && String(item.id || '')).filter(Boolean))
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

function favoriteListing(db, userId, listingId) {
  assertFavoriteUser(db, userId)
  const normalizedListingId = normalizedFavoriteListingId(listingId)
  // 幂等优先：房源在首次收藏后失效时，旧客户端或网络重试仍返回原关系，不新增、不反转。
  const existing = favoriteRelationship(db, userId, normalizedListingId)
  if (existing) {
    return {
      id: existing.id,
      listingId: normalizedListingId,
      favorited: true,
      isFavorited: true,
      favoritedAt: existing.createdAt || ''
    }
  }

  const listing = listingById(db, normalizedListingId)
  if (!listing) {
    const error = new Error('房源不存在，无法收藏')
    error.statusCode = 404
    throw error
  }
  assertFrontendListingAvailable(listing)

  const rows = favoriteRows(db, true)
  const record = {
    id: uniqueFavoriteId(rows),
    userId: String(userId),
    listingId: normalizedListingId,
    createdAt: new Date().toISOString()
  }
  rows.unshift(record)
  return {
    id: record.id,
    listingId: normalizedListingId,
    favorited: true,
    isFavorited: true,
    favoritedAt: record.createdAt
  }
}

function unfavoriteListing(db, userId, listingId) {
  assertFavoriteUser(db, userId)
  const normalizedListingId = normalizedFavoriteListingId(listingId)
  const rows = favoriteRows(db, true)
  // 删除同一业务键的全部存量重复关系，顺便自愈历史脏数据；其他账号不受影响。
  db.favorites = rows.filter((item) => !(
    item && String(item.userId || '') === String(userId || '') &&
    String(item.listingId || '') === normalizedListingId
  ))
  return {
    listingId: normalizedListingId,
    favorited: false,
    isFavorited: false
  }
}

function favoriteListingIds(db, userId) {
  assertFavoriteUser(db, userId)
  const seen = new Set()
  return favoriteRows(db)
    .filter((item) => item && String(item.userId || '') === String(userId || ''))
    .slice()
    .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))
    .map((item) => String(item.listingId || '').trim())
    .filter((listingId) => {
      if (!listingId || seen.has(listingId)) return false
      seen.add(listingId)
      return true
    })
}

function favoriteSafeListingRow(db, listing, relationship) {
  const favoritedAt = String((relationship && relationship.createdAt) || '')
  if (!listing) {
    return {
      id: String((relationship && relationship.listingId) || ''),
      title: '已删除房源',
      meta: '房源信息已移除',
      sub: '暂不可用',
      price: '',
      rent: 0,
      layout: '',
      rentMode: '',
      type: '',
      district: '',
      area: '',
      block: '',
      community: '',
      features: [],
      source: '',
      sourceLabel: '',
      status: '暂不可用',
      companyListing: false,
      hasVideo: false,
      coverUrl: '',
      isAvailable: false,
      unavailableCode: 'not-found',
      unavailableReason: '房源不存在或已删除',
      isFavorited: true,
      favoritedAt
    }
  }

  const location = publicListingLocationFields(listing)
  const display = listingDisplayFields(listing, db)
  const available = isFrontendEffectiveListing(listing)
  const unavailable = available ? { reason: '', reasonText: '' } : listingUnavailableReason(listing)
  const features = Array.from(listingMatchFeatureSet(listing))
  const rent = Number(listing.rent || 0)
  const rentMode = listing.rentMode || listing.type || ''
  const source = listing.source || listing.ownerType || listing.houseSourceType || ''
  const sourceLabel = display.sourceLabel || source
  return {
    id: listing.id,
    title: publicListingTitle(listing, location),
    meta: [location.locationSummary || location.area, listing.layout, sourceLabel].filter(Boolean).join(' · '),
    sub: available ? [listing.layout, sourceLabel, listing.status].filter(Boolean).join(' · ') : '暂不可用',
    price: rent ? `¥${rent}/月` : '',
    rent,
    layout: listing.layout || '',
    rentMode,
    type: rentMode,
    district: location.district,
    area: location.area,
    block: location.block,
    community: location.community,
    features,
    source,
    sourceLabel,
    status: listing.status || '',
    companyListing: isCompanyListing(listing),
    hasVideo: available && hasListingVideo(listing),
    coverUrl: available ? listingCoverUrl(listing) : '',
    isAvailable: available,
    unavailableCode: unavailable.reason || '',
    unavailableReason: unavailable.reasonText || '',
    isFavorited: true,
    favoritedAt
  }
}

function favoriteListings(db, userId, filter = {}) {
  assertFavoriteUser(db, userId)
  const seen = new Set()
  const requestedFeatures = parseFeatureInput(filter.features || filter.feature)
  const districtFilter = String(filter.district || filter.area || '').trim()
  const availability = String(filter.availability || '').trim().toLowerCase()
  const rows = favoriteRows(db)
    .filter((item) => item && String(item.userId || '') === String(userId || ''))
    .slice()
    .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))
    .filter((item) => {
      const listingId = String(item.listingId || '').trim()
      if (!listingId || seen.has(listingId)) return false
      seen.add(listingId)
      return true
    })
    .map((relationship) => ({
      relationship,
      listing: listingById(db, String(relationship.listingId || ''))
    }))
    .filter(({ listing }) => {
      const available = Boolean(listing && isFrontendEffectiveListing(listing))
      if (availability === 'available' && !available) return false
      if (availability === 'unavailable' && available) return false
      if (!listing) {
        return !filter.category && !districtFilter && !filter.block && !filter.community &&
          !filter.layout && !filter.rentMode && !filter.rentMin && !filter.rentMax && !requestedFeatures.length
      }
      if (filter.category && !matchesCategory(listing, filter.category)) return false
      if (districtFilter && [listing.district, listing.area].map((item) => String(item || '')).join('').indexOf(districtFilter) === -1) return false
      if (filter.block && String(listing.block || '').indexOf(String(filter.block)) === -1) return false
      if (filter.community && String(listing.community || '').indexOf(String(filter.community)) === -1) return false
      if (!matchesLayoutFilter(listing, filter.layout)) return false
      if (filter.rentMode && (listing.rentMode || listing.type) !== filter.rentMode) return false
      if (filter.rentMin !== undefined && String(filter.rentMin).trim() !== '' && Number(listing.rent || 0) < Number(filter.rentMin)) return false
      if (filter.rentMax !== undefined && String(filter.rentMax).trim() !== '' && Number(listing.rent || 0) > Number(filter.rentMax)) return false
      if (requestedFeatures.length) {
        const featureSet = listingMatchFeatureSet(listing)
        if (!requestedFeatures.every((feature) => featureSet.has(feature))) return false
      }
      return true
    })
    .map(({ listing, relationship }) => favoriteSafeListingRow(db, listing, relationship))
  return rows
}

function verifiedNearbyCoordinate(listing = {}) {
  const coordinate = mapCoordinateFromListing(listing)
  if (!coordinate) return null
  if (coordinate.level !== 'verified' || coordinate.coordinateVerified !== true) return null
  const source = String(coordinate.source || '').trim()
  // level/verified 可能来自旧数据或误标，M5 还要独立校验来源；近似地理编码和板块中心即使伪标
  // verified 也不能参与“精确 3 公里”计算。
  if (!/lianjia|amap|community-coordinate|admin-verified-coordinate|manual-confirmed/i.test(source)) return null
  if (/block-center|tencent-geocode|qq-map-geocode|geocoder|approx|default|pending|legacy|estimated/i.test(source)) return null
  const latitude = Number(coordinate.latitude)
  const longitude = Number(coordinate.longitude)
  if (!hasValidCoordinatePair(latitude, longitude)) return null
  return { latitude, longitude }
}

function nearbyDistanceKm(from, to) {
  const fromLatitude = Number(from && from.latitude)
  const fromLongitude = Number(from && from.longitude)
  const toLatitude = Number(to && to.latitude)
  const toLongitude = Number(to && to.longitude)
  if (![fromLatitude, fromLongitude, toLatitude, toLongitude].every(Number.isFinite)) return null
  const radians = (value) => value * Math.PI / 180
  const latitudeDelta = radians(toLatitude - fromLatitude)
  const longitudeDelta = radians(toLongitude - fromLongitude)
  const leftLatitude = radians(fromLatitude)
  const rightLatitude = radians(toLatitude)
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2
  const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)))
  return 6371.0088 * centralAngle
}

function nearbyDistanceText(distanceKm) {
  const meters = Math.max(0, Math.round(Number(distanceKm) * 1000))
  if (meters < 1000) return `${meters}米`
  return `${Number(distanceKm).toFixed(1)}公里`
}

function nearbyListingCard(db, listing, distanceKm) {
  const location = publicListingLocationFields(listing)
  const display = listingDisplayFields(listing, db)
  const sourceLabel = display.sourceLabel || listing.source || listing.ownerType || ''
  const rent = Number(listing.rent || 0)
  const rentMode = listing.rentMode || listing.type || ''
  return {
    id: listing.id,
    title: publicListingTitle(listing, location),
    meta: [location.community || location.area, listing.layout, sourceLabel].filter(Boolean).join(' · '),
    coverUrl: listingCoverUrl(listing),
    hasVideo: hasListingVideo(listing),
    distanceKm: Number(Number(distanceKm).toFixed(3)),
    distanceText: nearbyDistanceText(distanceKm),
    source: sourceLabel,
    sourceLabel,
    companyListing: isCompanyListing(listing),
    type: rentMode,
    rentMode,
    layout: listing.layout || '',
    features: Array.isArray(display.features) ? display.features.slice() : [],
    featureText: display.featureText || '',
    rent,
    price: rent ? `¥${rent}/月` : '',
    community: location.community || ''
  }
}

function emptyNearbyResult() {
  return {
    radiusKm: NEARBY_RADIUS_KM,
    total: 0,
    hasMore: false,
    listings: []
  }
}

function nearbyListings(db, anchorListingId, options = {}) {
  const anchorId = String(anchorListingId || '').trim()
  // 先走统一前台有效池，让 7 天自动过期等当前规则在锚点判定前生效；不能先拿陈旧锚点再触发过期。
  const effectiveListings = publicListings(db)
  const anchor = effectiveListings.find((listing) => String(listing.id || '') === anchorId)
  if (!anchor) return emptyNearbyResult()
  const anchorCoordinate = verifiedNearbyCoordinate(anchor)
  if (!anchorCoordinate) return emptyNearbyResult()
  const companyOnly = options.companyOnly === true

  const candidates = effectiveListings
    .filter((listing) => String(listing.id || '') !== anchorId)
    .filter((listing) => !companyOnly || isCompanyListing(listing))
    .map((listing) => {
      const coordinate = verifiedNearbyCoordinate(listing)
      if (!coordinate) return null
      const distanceKm = nearbyDistanceKm(anchorCoordinate, coordinate)
      if (!Number.isFinite(distanceKm) || distanceKm > NEARBY_RADIUS_KM) return null
      return { listing, distanceKm }
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.distanceKm !== right.distanceKm) return left.distanceKm - right.distanceKm
      return String(left.listing.id || '').localeCompare(String(right.listing.id || ''), 'zh-CN')
    })

  const total = candidates.length
  const selected = options.all === true ? candidates : candidates.slice(0, NEARBY_PREVIEW_LIMIT)
  const listings = selected.map((item) => nearbyListingCard(db, item.listing, item.distanceKm))
  return {
    radiusKm: NEARBY_RADIUS_KM,
    total,
    hasMore: options.all === true ? false : total > listings.length,
    listings
  }
}

function matchListings(db, condition = {}) {
  const budget = Number(condition.budget || 0)
  const area = String(condition.area || '').trim()
  const layout = String(condition.layout || '').trim()
  const requestedFeatures = parseFeatureInput(condition.features)
    .filter((item) => item !== NO_FEATURE)
  const hasCondition = Boolean(budget || area || layout || requestedFeatures.length)
  const companyOnly = isCompanyOnlyFilter(condition)

  const availableListings = publicListings(db)
    .filter((listing) => !companyOnly || isCompanyListing(listing))
  let scored = availableListings.map((listing) => {
    let score = 40
    const reasons = []
    const listingFeatures = listingMatchFeatureSet(listing)
    const matchedFeatureCount = requestedFeatures.filter((item) => listingFeatures.has(item)).length
    if (budget && Number(listing.rent) <= budget) {
      score += 24
      reasons.push('预算匹配')
    }
    if (budget && Number(listing.rent) > budget) {
      score -= Math.min(30, Math.ceil((Number(listing.rent) - budget) / 200))
    }
    if (
      area &&
      publicLocationSearchText(listing).indexOf(area) !== -1
    ) {
      score += 24
      reasons.push('区域匹配')
    }
    if (layout && String(listing.layout || '').indexOf(layout) !== -1) {
      score += 22
      reasons.push('户型匹配')
    }
    if (requestedFeatures.length) {
      score += Math.min(30, matchedFeatureCount * 14)
      if (matchedFeatureCount) reasons.push(`特点命中${matchedFeatureCount}项`)
      if (!matchedFeatureCount) score -= 12
    }
    if (listing.status === '在租') {
      score += 6
      reasons.push('房态可租')
    }

    const relevanceScore = Math.max(1, Math.min(99, score))
    return {
      score: relevanceScore,
      reasons: reasons.length ? reasons : ['基础条件相近'],
      listing
    }
  })

  scored = scored
    .filter((item) => !hasCondition || item.score >= 48)
    .sort((a, b) => b.score - a.score)

  if (!scored.length && hasCondition) {
    return {
      summary: '暂未匹配到符合条件的房源，可调整预算、区域、户型或特点后再试。',
      listings: []
    }
  }

  const rows = scored.slice(0, 3).map((item) => {
    const row = formatHomeListing(db, item.listing)
    row.relevanceScore = item.score
    row.relevancePercent = `${item.score}%`
    row.relevanceText = `相关性 ${item.score}%`
    row.relevanceLabel = relevanceLabel(item.score)
    row.relevanceReasons = item.reasons
    row.matchScore = row.relevancePercent
    row.tag = row.relevanceText
    return row
  })

  return {
    summary: `已从小程序房源库匹配到 ${rows.length} 套，按相关性评分从高到低排序。`,
    listings: rows
  }
}

function buildListingDetail(db, listing, viewerId = '') {
  const location = publicListingLocationFields(listing)
  const display = listingDisplayFields(listing, db)
  const {
    commissionText: _legacyCommissionText,
    commissionBadge: _legacyCommissionBadge,
    ...detailDisplay
  } = display
  const companyPublic = companyPublicListingFields(listing)
  return {
    id: listing.id,
    title: publicListingTitle(listing, location),
    rent: String(listing.rent),
    layout: listing.layout,
    ...location,
    areaText: `${location.city} · ${location.area}`,
    address: companyPublic.address || '确认留痕后可查看',
    sensitiveLocked: !display.companyListing,
    // 看房方式名不属敏感，直接下发；钥匙位置/密码/电话等敏感值仍走公司公开或留痕后 sensitive 下发
    ...listingViewingMethodFields(listing),
    landlordCommissionPercent: storedLandlordCommissionPercent(listing),
    commissionBreakdown: commissionBreakdownForListing(listing, db, viewerId),
    remark: safePublicListingRemark(listing),
    noCommission: display.noCommission,
    companyListing: display.companyListing,
    sourceLabel: display.sourceLabel,
    videoLabel: listing.videoLabel || '房源实拍视频',
    videoUrl: listing.videoUrl || '',
    videoKey: listing.videoKey || '',
    hasVideo: hasListingVideo(listing),
    coverUrl: listingCoverUrl(listing),
    type: listing.type || listing.rentMode || '',
    rentMode: listing.rentMode || listing.type || '',
    room: listing.room || '',
    hall: listing.hall || '',
    bath: listing.bath || '',
    status: listing.status,
    ...detailDisplay,
    ...companyPublic
  }
}

function unavailableListingDetail(listing, listingId) {
  const unavailable = listingUnavailableReason(listing)
  return {
    id: listing ? listing.id : listingId,
    unavailable: true,
    reason: unavailable.reason,
    reasonText: unavailable.reasonText,
    status: listing ? (listing.status || '') : '',
    updatedAt: listing ? (listing.updatedAt || '') : '',
    syncedAt: listing ? (listing.syncedAt || '') : '',
    feishuLastSyncAction: listing ? (listing.feishuLastSyncAction || '') : '',
    feishuLastSyncAt: listing ? (listing.feishuLastSyncAt || listing.syncedAt || '') : ''
  }
}

function listingDetailState(db, listingId, viewerId = '') {
  autoExpireOverdueListings(db)
  const listing = listingById(db, listingId)
  if (!listing) {
    return {
      status: 'not-found',
      listingId,
      rawFound: false,
      unavailable: unavailableListingDetail(null, listingId)
    }
  }
  if (!isFrontendEffectiveListing(listing)) {
    return {
      status: 'unavailable',
      listingId,
      rawFound: true,
      reason: listingUnavailableReason(listing).reason,
      listing,
      unavailable: unavailableListingDetail(listing, listingId)
    }
  }
  return {
    status: 'available',
    listingId,
    rawFound: true,
    listing,
    detail: buildListingDetail(db, listing, viewerId)
  }
}

// 当前登录用户是否为该房源上传人（用于详情页"上传人自查免留痕直接展示"，服务端判定，不外泄 uploaderId）。
function isOwnListing(db, listingId, userId) {
  if (!userId) return false
  const listing = listingById(db, listingId)
  return Boolean(listing && listing.uploaderId && String(listing.uploaderId) === String(userId))
}

function listingDetail(db, listingId, viewerId = '') {
  const state = listingDetailState(db, listingId, viewerId)
  return state.status === 'available' ? state.detail : null
}

function assertListingLogsReadable(db, userId, listing) {
  const user = userById(db, userId) || {}
  if (user.isAdmin || listing.uploaderId === userId) return
  const hasViewed = (db.footprints || []).some((item) => item.listingId === listing.id && item.viewerId === userId)
  if (hasViewed) return
  const error = new Error('只能查看自己上传或自己已留痕房源的足迹')
  error.statusCode = 403
  throw error
}

function listingLogs(db, listingId, userId, nowMs = Date.now()) {
  const listing = listingById(db, listingId)
  if (userId !== undefined) {
    if (!listing) {
      const error = new Error('未找到该房源')
      error.statusCode = 404
      throw error
    }
    assertListingLogsReadable(db, userId, listing)
  }
  return (db.footprints || [])
    .filter((item) => item.listingId === listingId && footprintWithinRetention(item, BROKER_FOOTPRINT_RETENTION_MS, nowMs))
    .map((item) => {
      const user = userById(db, item.viewerId) || {}
      return {
        user: user.name || '未知',
        action: footprintActionText(item),
        needId: item.needId || '',
        purpose: item.purpose || '',
        time: footprintOccurredAt(item)
      }
    })
}

function footprintActionText(record = {}) {
  if (record.action) return record.action
  if (record.actionType === 'phone_call_opened') return '电话查看（已打开系统拨号页）'
  const labels = {
    sensitive_view: '查看地址和电话',
    showing_verified: '记录带看',
    video_shared: '转发房间视频给租客',
    listing_expired: '自动下架',
    listing_restored: '重新上架',
    listing_coordinate_updated: '修正地图坐标',
    commission_config_updated: '调整分佣配置',
    listing_status_updated: '管理员调整状态',
    listing_verified: '房态核验',
    listing_feishu_removed: '飞书同步下架',
    listing_activity: '房源操作'
  }
  return labels[record.actionType] || String(record.actionType || '')
}

function footprintOccurredAt(record = {}) {
  return record.time || record.occurredAt || ''
}

function footprintRecords(db, userId, nowMs = Date.now()) {
  // 预建 id→实体索引，避免对每条足迹重复线性扫描 listings/users（原实现 filter+map 阶段
  // 各做一次 listingById、两次 userById，足迹量大时接近 O(n×listings)）。
  const listingsById = new Map((db.listings || []).map((listing) => [listing.id, listing]))
  const usersById = new Map((db.users || []).map((user) => [user.id, user]))
  return (db.footprints || [])
    .filter((record) => {
      const listing = listingsById.get(record.listingId) || {}
      const related = record.viewerId === userId || listing.uploaderId === userId
      const visibleAction = isSensitiveViewFootprint(record) || isPhoneViewFootprint(record)
      return related && visibleAction && footprintWithinRetention(record, BROKER_FOOTPRINT_RETENTION_MS, nowMs)
    })
    .map((record) => {
      const listing = listingsById.get(record.listingId) || {}
      const viewer = usersById.get(record.viewerId) || {}
      const uploader = usersById.get(listing.uploaderId) || {}
      const location = publicListingLocationFields(listing)
      const isMine = record.viewerId === userId
      const syncText = record.sync ? ` · ${record.sync}` : ''
      return {
        id: record.id,
        title: publicListingTitle(listing, location) || '未知房源',
        status: footprintActionText(record),
        customer: `查看人：${viewer.name || '未知'} · ${viewer.authed || '未实名'}`,
        time: footprintOccurredAt(record),
        price: listing.rent ? `¥${listing.rent}/月` : '',
        meta: `上传人：${uploader.name || '未知'}${syncText}`,
        needId: record.needId || '',
        purpose: record.purpose || '',
        direction: isMine ? '我查看的' : '我的房源被查看',
        raw: clone(record)
      }
    })
}

function formatRentalNeed(need = {}) {
  return {
    id: need.id,
    brokerId: need.brokerId,
    rawText: need.rawText || '',
    voiceText: need.voiceText || '',
    confirmedNeed: clone(need.confirmedNeed || need.form || {}),
    form: clone(need.form || need.confirmedNeed || {}),
    source: need.source || 'manual',
    status: need.status || 'active',
    createdAt: need.createdAt || '',
    updatedAt: need.updatedAt || ''
  }
}

function userRentalNeeds(db, userId) {
  return (db.rentalNeeds || [])
    .filter((need) => need.brokerId === userId)
    .map(formatRentalNeed)
}

function createRentalNeed(db, userId, payload = {}) {
  assertKnownUser(db, userId)
  const rawText = String(payload.rawText || payload.text || '').trim()
  const voiceText = String(payload.voiceText || payload.voice || '').trim()
  const confirmedNeed = clone(payload.confirmedNeed || payload.form || payload.confirmedForm || {})
  if (!rawText && !voiceText && !Object.keys(confirmedNeed).length) {
    const error = new Error('需求内容必填')
    error.statusCode = 400
    throw error
  }

  const now = nowText()
  const need = {
    id: id('N'),
    brokerId: userId,
    rawText,
    voiceText,
    confirmedNeed,
    form: clone(confirmedNeed),
    source: String(payload.source || 'manual').trim() || 'manual',
    status: String(payload.status || 'active').trim() || 'active',
    createdAt: now,
    updatedAt: now
  }
  db.rentalNeeds = db.rentalNeeds || []
  db.rentalNeeds.unshift(need)
  return {
    message: '需求单已创建',
    need: formatRentalNeed(need)
  }
}

function ownedListings(db, userId) {
  return activeListings(db)
    .filter((listing) => listing.uploaderId === userId)
    .map((listing) => {
      const location = publicListingLocationFields(listing)
      const display = listingDisplayFields(listing, db)
      return {
        id: listing.id,
        title: publicListingTitle(listing, location),
        ...location,
        rent: String(listing.rent),
        hasVideo: hasListingVideo(listing),
        coverUrl: listingCoverUrl(listing),
        commissionRate: display.noCommission ? '不分佣' : `${commissionRateForListing(listing, db)}%`,
        commissionText: display.commissionText,
        noCommission: display.noCommission,
        companyListing: display.companyListing,
        sourceLabel: display.sourceLabel,
        views: `${listing.sensitiveViews || 0} 次查看敏感信息`,
        ...display,
        // 上传人查看自己上传的房源直接展示地址/房东电话（不留痕、不耗额度）；电话确认房态时用来拨号。放 ...display 后确保不被脱敏值覆盖。
        address: listing.address || '',
        landlordPhone: listing.landlordPhone || '',
        // 我的房源新卡片样式与「整租/合租·租金·户型」筛选所需字段（放 ...display 后确保取房源真值）。
        rentMode: listing.rentMode || listing.type || '',
        type: listing.type || listing.rentMode || '',
        layout: listing.layout || '',
        status: listing.status || ''
      }
    })
}

function profileState(db, userId) {
  const user = currentUser(db, userId)
  const owned = ownedListings(db, userId)
  const points = pointBalance(db, userId)
  const pendingCommission = (db.commissionRecords || []).filter(
    (item) => item.uploaderId === userId && item.status !== '已确认'
  ).length
  const staleOwned = staleListings(db, userId)

  return {
    user: clone(user),
    points,
    favoriteCount: favoriteListingIds(db, userId).length,
    sourceStats: [
      { label: '已上架', value: String(owned.length) },
      { label: '积分', value: String(points) },
      { label: '待分佣', value: String(pendingCommission) }
    ],
    reminders: [
      staleOwned.length
        ? { title: '房态核验', value: `${staleOwned.length} 套房源已到 3/5/${VERIFY_STALE_DAYS} 天电话核验提醒` }
        : { title: '房态核验', value: '你上传的房源近期已核验' },
      { title: '敏感信息查看', value: `${footprintRecords(db, userId).filter((item) => item.direction === '我的房源被查看').length} 条最近 7 天地址或电话查看足迹` },
      { title: '历史分佣', value: `${pendingCommission} 单历史分佣待核对；报备与签单写入已暂停` }
    ],
    rechargeBills: (db.rechargeBills || [])
      .filter((bill) => bill.userId === userId)
      .slice(0, 3)
      .map((bill) => ({
        id: bill.id,
        points: `${bill.points} 分`,
        amount: `${bill.amount} 元`,
        status: bill.status,
        time: bill.time
      }))
  }
}

function todayTaskItem(type, title, count, unit, desc, url, tone) {
  return { type, title, count, unit, desc, url, tone }
}

function todayTasks(db, userId) {
  const owned = activeListings(db).filter((listing) => listing.uploaderId === userId)
  const staleOwned = owned.filter((listing) => listingFreshness(listing).needsVerify)
  const expiringOwned = owned.filter((listing) => {
    const freshness = listingFreshness(listing)
    return freshness.reminderStage === 'day5' || freshness.reminderStage === 'expire'
  })
  const commissions = userCommissionRows(db, userId)
  const footprints = footprintRecords(db, userId)
  const pendingCommissions = commissions.filter((record) => !/已确认/.test(String(record.status || ''))).length
  const confirmedCommissions = commissions.filter((record) => /已确认/.test(String(record.status || ''))).length
  const tasks = [
    todayTaskItem(
      'maintenance',
      '待维护房源',
      staleOwned.length,
      '套',
      staleOwned.length ? '按第 3 天、第 5 天提醒优先电话核验。' : '暂无需要维护的房源。',
      '/pages/my-listings/my-listings',
      'green'
    ),
    todayTaskItem(
      'expiring',
      '即将失效房源',
      expiringOwned.length,
      '套',
      expiringOwned.length ? `第 ${VERIFY_STALE_DAYS} 天未更新会自动失效，先处理临期房源。` : '暂无临期失效房源。',
      '/pages/my-listings/my-listings',
      'orange'
    ),
    todayTaskItem(
      'commissions',
      '分佣提醒',
      pendingCommissions,
      '笔',
      `待确认 ${pendingCommissions} 笔，已确认 ${confirmedCommissions} 笔。`,
      '/pages/commissions/commissions',
      'yellow'
    ),
    todayTaskItem(
      'footprints',
      '敏感查看留痕',
      footprints.length,
      '条',
      footprints.length ? '复盘地址、电话查看记录，防跳单留痕。' : '暂无新的敏感查看记录。',
      '/pages/footprint/footprint',
      'gray'
    )
  ]
  return {
    summary: {
      pendingCount: tasks.reduce((sum, item) => sum + Number(item.count || 0), 0),
      updatedAt: nowText()
    },
    tasks
  }
}

function groupState(db, userId) {
  const userUnlockedGroups = new Set((db.groupUnlocks || [])
    .filter((item) => item.userId === userId)
    .map((item) => item.groupId))
  return {
    points: pointBalance(db, userId),
    groups: (db.groups || []).map((group) => {
      const isDefaultJoined = group.unlocked === true && group.tag === '已加入'
      const unlocked = isDefaultJoined || userUnlockedGroups.has(group.id)
      return {
        id: group.id,
        name: group.name,
        count: `${group.count} 套`,
        tag: unlocked ? (isDefaultJoined ? group.tag : '本次已解锁') : '消耗 1 积分解锁',
        unlocked
      }
    }),
    listings: publicListings(db)
      .filter((listing) => listing.source === '群聊上传')
      .map((listing) => {
        const uploader = userById(db, listing.uploaderId) || {}
        const display = listingDisplayFields(listing, db)
        return {
          id: listing.id,
          title: `${listing.block || '待板块'} · ${listing.layout}`,
          price: `¥${listing.rent}/月`,
          rule: display.commissionText,
          publisher: `${uploader.name || '未知'} · 已认证`,
          status: listing.source === '群聊上传' ? '群聊上传房源' : '电话地址需实名查看',
          ...display
        }
      }),
    pointLogs: (db.pointLogs || [])
      .filter((log) => log.userId === userId || log.type === '群聊上传' || log.type === '换群')
      .slice(0, 5)
      .map((log) => `${log.type} ${log.change > 0 ? '+' : ''}${log.change} · ${log.note}`),
    groupUploads: (db.groupUploads || [])
      .filter((item) => item.userId === userId)
      .slice(0, 3)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status || '待审核',
        point: item.pointGranted ? '+1 已到账' : '审核通过后到账',
        time: item.time
      }))
  }
}

const defaultMapCenter = {
  name: '东新园地铁口',
  latitude: 30.3192,
  longitude: 120.1694
}

function isDefaultMapCoordinate(latitude, longitude) {
  return Math.abs(latitude - defaultMapCenter.latitude) < 0.000001 &&
    Math.abs(longitude - defaultMapCenter.longitude) < 0.000001
}

function numericCoordinate(value) {
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
    longitude <= 180 &&
    !isDefaultMapCoordinate(latitude, longitude)
}

function isReliableListingCoordinateSource(source) {
  const text = String(source || '').trim()
  if (!text) return false
  if (/^estimated-|^legacy-|default-center|listing-coordinate|area|hash|random|pending/i.test(text)) return false
  return /lianjia|amap|community-coordinate|admin-verified-coordinate|manual-confirmed|tencent-geocode|qq-map-geocode|block-center/i.test(text)
}

function isUnsafeCoordinateSource(source) {
  return !isReliableListingCoordinateSource(source)
}

function normalizeCoordinateLevel(value) {
  const text = String(value || '').trim().toLowerCase()
  return MAP_COORDINATE_LEVELS.indexOf(text) !== -1 ? text : ''
}

function coordinateLevelFromFields(fields = {}) {
  const explicit = normalizeCoordinateLevel(fields.coordinateLevel || fields.coordinateAccuracy)
  if (explicit) return explicit
  const source = String(fields.coordinateSource || fields.source || '').trim().toLowerCase()
  if (/block-center/.test(source)) return 'block-center'
  if (/tencent-geocode|qq-map-geocode|geocoder/.test(source)) return 'approximate'
  if (truthyFlag(fields.coordinateVerified)) return 'verified'
  return ''
}

function coordinateStatusText(level) {
  if (level === 'verified') return '已确认小区坐标'
  if (level === 'approximate') return '近似位置'
  if (level === 'block-center') return '板块中心近似位置'
  return '地图坐标待补充'
}

function coordinateSourceAllowedForLevel(source, level) {
  const text = String(source || '').trim()
  if (!level) return false
  if (level === 'verified') return !isUnsafeCoordinateSource(text)
  if (level === 'approximate') return /tencent-geocode|qq-map-geocode|geocoder/i.test(text)
  if (level === 'block-center') return /block-center/i.test(text)
  return false
}

function blockCenterForListing(listing = {}) {
  const centers = config.location && config.location.blockCenters ? config.location.blockCenters : {}
  const block = String(listing.block || '').trim()
  if (block && centers[block]) return { ...centers[block], block }
  const matchedBlock = Object.keys(centers).find((item) => {
    const text = [listing.block, listing.community, listing.address, listing.locationSummary]
      .map((value) => String(value || ''))
      .join('')
    return text.indexOf(item) !== -1
  })
  return matchedBlock ? { ...centers[matchedBlock], block: matchedBlock } : null
}

function pendingMapCoordinateFields() {
  return {
    mapLatitude: '',
    mapLongitude: '',
    coordinateSource: 'pending-map-coordinate',
    coordinateVerified: false,
    coordinateLevel: '',
    coordinateAccuracy: '',
    coordinateStatus: '地图坐标待补充'
  }
}

function mapCoordinateFromListing(listing = {}) {
  // 管理员人工修正过的坐标（admin-verified）优先于小区坐标库：后台已逐套核实的精确点位
  // 不应被小区级近似坐标覆盖，否则修正坐标永远不会真正上图。
  const manualLatitude = numericCoordinate(firstOwnValue(listing, ['mapLatitude', 'latitude']))
  const manualLongitude = numericCoordinate(firstOwnValue(listing, ['mapLongitude', 'longitude']))
  if (listing.coordinateSource === 'admin-verified-coordinate' && hasValidCoordinatePair(manualLatitude, manualLongitude)) {
    const community = String(listing.community || '').trim()
    if (community && community !== '待补充') {
      const level = coordinateLevelFromFields(listing)
      return {
        latitude: manualLatitude,
        longitude: manualLongitude,
        source: 'admin-verified-coordinate',
        community,
        coordinateVerified: level === 'verified',
        level,
        coordinateLevel: level,
        coordinateAccuracy: level,
        coordinateStatus: listing.coordinateStatus || coordinateStatusText(level)
      }
    }
  }

  const communityCoordinate = coordinateByCommunity(listing.community)
  if (communityCoordinate) {
    return {
      latitude: communityCoordinate.latitude,
      longitude: communityCoordinate.longitude,
      source: communityCoordinate.source || 'community-coordinate',
      community: communityCoordinate.community || listing.community,
      coordinateVerified: true,
      level: 'verified',
      coordinateLevel: 'verified',
      coordinateAccuracy: 'verified',
      coordinateStatus: coordinateStatusText('verified')
    }
  }

  const latitude = numericCoordinate(firstOwnValue(listing, ['mapLatitude', 'latitude']))
  const longitude = numericCoordinate(firstOwnValue(listing, ['mapLongitude', 'longitude']))
  const source = listing.coordinateSource || 'admin-verified-coordinate'
  if (!hasValidCoordinatePair(latitude, longitude)) return null
  const level = coordinateLevelFromFields(listing)
  if (!coordinateSourceAllowedForLevel(source, level)) return null
  const community = String(listing.community || '').trim()
  if (!community || community === '待补充') return null
  return {
    latitude,
    longitude,
    source,
    community,
    coordinateVerified: level === 'verified',
    level,
    coordinateLevel: level,
    coordinateAccuracy: level,
    coordinateStatus: listing.coordinateStatus || coordinateStatusText(level)
  }
}
// 注：MODEL-2 的 block-center 兜底仅接进「助手半径检索」路径(place-locator.listingCoordinate)——
// 地图页 mapCoordinateFromListing 维持「仅可靠/verified 坐标上图」不变量（防客户端伪造坐标进地图，见
// backend-contract-v1-test「客户端手填坐标不能进入地图」）。地图页是否也展示 block-center 属产品决策，待用户拍板。

function explicitCoordinateFromSource(source = {}) {
  const latitudeValue = firstOwnValue(source, ['mapLatitude', 'latitude'])
  const longitudeValue = firstOwnValue(source, ['mapLongitude', 'longitude'])
  const latitude = Number(latitudeValue)
  const longitude = Number(longitudeValue)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return {
    latitude,
    longitude,
    source: source.coordinateSource || ''
  }
}

function listingMapCoordinateFields(fields = {}, form = {}, current = {}, options = {}) {
  const communityCoordinate = coordinateByCommunity(fields.community || form.community || current.community)
  if (communityCoordinate) {
    return {
      mapLatitude: communityCoordinate.latitude,
      mapLongitude: communityCoordinate.longitude,
      coordinateSource: communityCoordinate.source || 'community-coordinate',
      coordinateVerified: true,
      coordinateLevel: 'verified',
      coordinateAccuracy: 'verified',
      coordinateStatus: coordinateStatusText('verified')
    }
  }

  const formCoordinate = explicitCoordinateFromSource(form)
  const formSource = formCoordinate ? (formCoordinate.source || 'admin-verified-coordinate') : ''
  if (
    formCoordinate &&
    options.admin &&
    truthyFlag(form.coordinateVerified) &&
    hasValidCoordinatePair(formCoordinate.latitude, formCoordinate.longitude) &&
    !isUnsafeCoordinateSource(formSource)
  ) {
    return {
      mapLatitude: formCoordinate.latitude,
      mapLongitude: formCoordinate.longitude,
      coordinateSource: formSource,
      coordinateVerified: true,
      coordinateLevel: 'verified',
      coordinateAccuracy: 'verified',
      coordinateStatus: coordinateStatusText('verified')
    }
  }

  const currentCoordinate = explicitCoordinateFromSource(current)
  const currentSource = currentCoordinate ? (currentCoordinate.source || 'admin-verified-coordinate') : ''
  const currentLevel = coordinateLevelFromFields(current)
  if (
    currentCoordinate &&
    hasValidCoordinatePair(currentCoordinate.latitude, currentCoordinate.longitude) &&
    coordinateSourceAllowedForLevel(currentSource, currentLevel)
  ) {
    return {
      mapLatitude: currentCoordinate.latitude,
      mapLongitude: currentCoordinate.longitude,
      coordinateSource: currentSource,
      coordinateVerified: currentLevel === 'verified',
      coordinateLevel: currentLevel,
      coordinateAccuracy: currentLevel,
      coordinateStatus: current.coordinateStatus || coordinateStatusText(currentLevel)
    }
  }

  return pendingMapCoordinateFields()
}

function applyCommunityMapCoordinate(listing = {}) {
  const coordinate = coordinateByCommunity(listing.community)
  if (!coordinate || !isReliableListingCoordinateSource(coordinate.source)) return null
  listing.mapLatitude = coordinate.latitude
  listing.mapLongitude = coordinate.longitude
  listing.coordinateSource = coordinate.source || 'community-coordinate'
  listing.coordinateVerified = true
  listing.coordinateLevel = 'verified'
  listing.coordinateAccuracy = 'verified'
  listing.coordinateStatus = coordinateStatusText('verified')
  return coordinate
}

function mapFilterList(value) {
  const values = Array.isArray(value) ? value : [value]
  return values
    .flatMap((item) => String(item || '').split(/[,，]/))
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeMapFilter(filter = {}) {
  const north = numericCoordinate(filter.north)
  const south = numericCoordinate(filter.south)
  const east = numericCoordinate(filter.east)
  const west = numericCoordinate(filter.west)
  const hasBounds = [north, south, east, west].every((item) => item !== null)
  return {
    north,
    south,
    east,
    west,
    hasBounds,
    rentMin: numericCoordinate(filter.rentMin),
    rentMax: numericCoordinate(filter.rentMax),
    layout: String(filter.layout || '').trim(),
    rentMode: String(filter.rentMode || '').trim(),
    sourceType: String(filter.sourceType || '').trim(),
    companyOnly: truthyFlag(filter.companyOnly),
    area: String(filter.area || filter.region || '').trim(),
    listingIds: new Set(mapFilterList(filter.listingIds))
  }
}

function coordinateInBounds(coordinate, filter) {
  if (!filter.hasBounds) return true
  return coordinate.latitude <= filter.north &&
    coordinate.latitude >= filter.south &&
    coordinate.longitude <= filter.east &&
    coordinate.longitude >= filter.west
}

function sourceTextForListing(listing = {}, display = {}) {
  return [
    listing.source,
    listing.sourceType,
    listing.listingType,
    listing.inventoryType,
    listing.category,
    listing.ownerType,
    listing.houseSourceType,
    display.ownerType,
    display.sourceLabel
  ].map((item) => String(item || '')).join(' ')
}

function listingMatchesMapFilter(listing = {}, filter, display = {}) {
  if (filter.listingIds.size && !filter.listingIds.has(String(listing.id || ''))) return false
  const sourceType = listingSourceType(listing)
  if (filter.companyOnly && sourceType !== COMPANY_SOURCE) return false
  const rent = Number(listing.rent || 0)
  if (filter.rentMin !== null && rent < filter.rentMin) return false
  if (filter.rentMax !== null && rent > filter.rentMax) return false
  if (filter.layout && String(listing.layout || '').indexOf(filter.layout) === -1) return false
  if (filter.rentMode && String(listing.rentMode || listing.type || listing.layout || '').indexOf(filter.rentMode) === -1) return false
  if (filter.sourceType && filter.sourceType !== '全部') {
    if ([COMPANY_SOURCE, OWNER_SOURCE, SECOND_LANDLORD_SOURCE].indexOf(filter.sourceType) !== -1) {
      if (sourceType !== filter.sourceType) return false
    } else if (sourceTextForListing(listing, display).indexOf(filter.sourceType) === -1) {
      return false
    }
  }
  if (filter.area) {
    const locationText = [
      listing.city,
      listing.district,
      listing.area,
      listing.block,
      listing.community
    ].map((item) => String(item || '')).join('')
    if (locationText.indexOf(filter.area) === -1) return false
  }
  return true
}

function safeMapListingSummary(listing = {}, display = {}) {
  return {
    id: listing.id,
    rent: Number(listing.rent || 0),
    layout: listing.layout || '',
    rentMode: listing.rentMode || listing.type || '',
    sourceType: display.sourceLabel || listing.source || '',
    lastVerifiedAt: display.lastVerifiedAt || listing.lastVerifiedAt || '',
    maintenanceText: display.maintenanceText || '',
    hasVideo: Boolean(listing.videoUrl || listing.videoKey),
    video: listing.videoUrl || listing.videoKey ? '已传视频' : ''
  }
}

function isV1MapActiveListing(listing = {}) {
  if (isExpiredListing(listing)) return false
  const freshness = listingFreshness(listing)
  return freshness.staleDays < V1_MAP_STALE_DAYS
}

function mapCommunities(db, filter = {}) {
  const normalizedFilter = normalizeMapFilter(filter)
  const groups = new Map()
  publicListings(db).forEach((listing) => {
    if (!isV1MapActiveListing(listing)) return
    const coordinate = mapCoordinateFromListing(listing)
    if (!coordinate) return
    if (!coordinateInBounds(coordinate, normalizedFilter)) return
    const display = listingDisplayFields(listing, db)
    if (!listingMatchesMapFilter(listing, normalizedFilter, display)) return
    const community = coordinate.community || listing.community
    const key = String(community || '').trim()
    if (!key) return
    if (!groups.has(key)) {
      groups.set(key, {
        community: key,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        coordinateSource: coordinate.source || '',
        coordinateVerified: coordinate.level === 'verified',
        coordinateLevel: coordinate.level || coordinate.coordinateLevel || 'verified',
        coordinateAccuracy: coordinate.coordinateAccuracy || coordinate.level || 'verified',
        coordinateStatus: coordinate.coordinateStatus || coordinateStatusText(coordinate.level || 'verified'),
        coordinateLabel: coordinate.coordinateStatus || coordinateStatusText(coordinate.level || 'verified'),
        coordinateCalloutNote: coordinate.level === 'approximate'
          ? '近似位置'
          : (coordinate.level === 'block-center' ? '板块中心近似位置' : ''),
        listingCount: 0,
        minRent: 0,
        maxRent: 0,
        activeListingIds: [],
        layouts: [],
        sourceTypes: [],
        listings: []
      })
    }
    const group = groups.get(key)
    // 管理员人工修正坐标优先：小区点先由最先命中的房源定坐标，但若后续房源带有后台已核实的
    // admin-verified 坐标，则升级该小区点位（让小区库近似坐标让位于人工修正的精确点位）。
    if (coordinate.source === 'admin-verified-coordinate' && group.coordinateSource !== 'admin-verified-coordinate') {
      group.latitude = coordinate.latitude
      group.longitude = coordinate.longitude
      group.coordinateSource = coordinate.source
      group.coordinateVerified = coordinate.level === 'verified'
      group.coordinateLevel = coordinate.level || 'verified'
      group.coordinateAccuracy = coordinate.coordinateAccuracy || coordinate.level || 'verified'
      group.coordinateStatus = coordinate.coordinateStatus || coordinateStatusText(coordinate.level || 'verified')
      group.coordinateLabel = group.coordinateStatus
      group.coordinateCalloutNote = coordinate.level === 'approximate'
        ? '近似位置'
        : (coordinate.level === 'block-center' ? '板块中心近似位置' : '')
    }
    const rent = Number(listing.rent || 0)
    group.listingCount += 1
    group.minRent = group.minRent ? Math.min(group.minRent, rent) : rent
    group.maxRent = Math.max(group.maxRent, rent)
    group.activeListingIds.push(listing.id)
    group.layouts = uniqueTextList(group.layouts.concat(listing.layout || ''))
    group.sourceTypes = uniqueTextList(group.sourceTypes.concat(display.sourceLabel || listing.source || ''))
    group.listings.push(safeMapListingSummary(listing, display))
  })
  return Array.from(groups.values()).sort((left, right) => {
    if (left.minRent !== right.minRent) return left.minRent - right.minRent
    return left.community.localeCompare(right.community, 'zh-CN')
  })
}

function mapPins(db, filter = {}) {
  return mapCommunities(db, filter)
}

function adminListingDetailFields(listing = {}, uploader = {}, location = listingLocationFields(listing), display = listingDisplayFields(listing)) {
  const contact = listing.landlordPhone || listing.contact || ''
  return {
    fullTitle: listing.title || listing.shortTitle || '',
    uploaderPhone: uploader.phone || '',
    address: listing.address || [location.locationSummary, location.roomAddress].filter(Boolean).join(''),
    landlordPhone: contact,
    contact,
    videoUrl: listing.videoUrl || '',
    videoKey: listing.videoKey || '',
    viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
    ...listingViewingMethodFields(listing),
    viewingKeyLocation: listingViewingKeyLocation(listing),
    videoLabel: listing.videoLabel || (hasListingVideo(listing) ? '房源视频' : ''),
    hasVideo: hasListingVideo(listing),
    missingVideoMaterial: Boolean(listing.missingVideoMaterial),
    videoMaterialStatus: listing.videoMaterialStatus || '',
    videoMaterialFailureReason: listing.videoMaterialFailureReason || '',
    sourceMaterialName: listing.sourceMaterialName || '',
    sourceMaterialPath: listing.sourceMaterialPath || '',
    sourceMaterialUrl: listing.sourceMaterialUrl || '',
    type: listing.type || listing.rentMode || '',
    rentMode: listing.rentMode || listing.type || '',
    room: listing.room || '',
    hall: listing.hall || '',
    bath: listing.bath || '',
    rawLayout: listing.layout || '',
    rentValue: Number(listing.rent || 0),
    commissionRate: Number(listing.commissionRate || 0),
    landlordCommissionPercent: storedLandlordCommissionPercent(listing),
    remark: safePublicListingRemark(listing),
    features: display.features || [],
    tags: display.features || [],
    featureText: display.featureText || '',
    createdAt: listing.createdAt || '',
    updatedAt: listing.updatedAt || '',
    reviewNote: listing.reviewNote || '',
    manualReviewReason: display.manualReviewReason || listing.manualReviewReason || '',
    communityMatchStatus: display.communityMatchStatus || listing.communityMatchStatus || '',
    expiredPool: listing.expiredPool || '',
    mapLatitude: listing.mapLatitude || '',
    mapLongitude: listing.mapLongitude || '',
    coordinateSource: listing.coordinateSource || '',
    coordinateVerified: truthyFlag(listing.coordinateVerified),
    coordinateLevel: coordinateLevelFromFields(listing),
    coordinateAccuracy: listing.coordinateAccuracy || coordinateLevelFromFields(listing),
    coordinateStatus: listing.coordinateStatus || coordinateStatusText(coordinateLevelFromFields(listing))
  }
}

function matchListingSourceFilter(listing, source) {
  if (!source) return true
  const requested = String(source || '').trim()
  const actual = listingSourceType(listing)
  if (requested === COMPANY_SOURCE || requested === '公司') return actual === COMPANY_SOURCE
  if (requested === OWNER_SOURCE || requested === '业主') return actual === OWNER_SOURCE
  if (requested === SECOND_LANDLORD_SOURCE || requested === '二房东') return actual === SECOND_LANDLORD_SOURCE
  return true
}

function matchListingStatusFilter(listing, status) {
  if (!status) return true
  if (/成交|签单/.test(status)) return isSoldListing(listing)
  return String(listing.status || '') === status
}

function matchListingVideoMaterialFilter(listing, status) {
  if (!status) return true
  const requested = String(status || '').trim().toLowerCase()
  const missing = Boolean(listing.missingVideoMaterial) ||
    listing.videoMaterialStatus === '缺视频素材' ||
    listing.syncStatus === '缺视频素材'
  if (['missing', 'true', '1', '缺视频素材', '缺视频'].indexOf(requested) !== -1) return missing
  if (['ready', 'hasVideo', 'has-video', '已配视频', '有视频'].map((item) => item.toLowerCase()).indexOf(requested) !== -1) {
    return hasListingVideo(listing) && !missing
  }
  return true
}

function adminListings(db, filter = {}) {
  return activeListings(db)
    .filter((listing) => {
      if (filter.area && String(listing.area || '').indexOf(filter.area) === -1) return false
      if (filter.block && String(listing.block || '').indexOf(filter.block) === -1) return false
      if (filter.community && String(listing.community || '').indexOf(filter.community) === -1) return false
      if (!matchListingSourceFilter(listing, filter.source)) return false
      if (!matchListingStatusFilter(listing, filter.status)) return false
      if (!matchListingVideoMaterialFilter(listing, filter.missingVideoMaterial || filter.videoMaterialStatus)) return false
      return true
    })
    .map((listing) => {
      const uploader = userById(db, listing.uploaderId) || {}
      const freshness = listingFreshness(listing)
      const location = listingLocationFields(listing)
      const display = listingDisplayFields(listing, db)
      return {
        id: listing.id,
        title: listing.shortTitle,
        ...location,
        ...display,
        ...adminListingDetailFields(listing, uploader, location, display),
        uploader: uploader.name,
        rent: `${listing.rent}/月`,
        layout: String(listing.layout || '').replace('整租', ''),
        commission: display.commissionText,
        source: listing.source || display.sourceLabel,
        video: hasListingVideo(listing)
          ? '已传'
          : (listing.videoMaterialStatus || (listing.missingVideoMaterial ? '缺视频素材' : '未传')),
        status: listing.status,
        lastVerifiedAt: freshness.lastVerifiedAt,
        verifyStatus: freshness.verifyStatus,
        verifyTip: freshness.verifyTip,
        staleDays: freshness.staleDays,
        needsVerify: freshness.needsVerify
      }
    })
}

function expiredListings(db, filter = {}) {
  autoExpireOverdueListings(db)
  return (db.listings || [])
    .filter(isExpiredListing)
    .filter((listing) => {
      if (filter.area && String(listing.area || '').indexOf(filter.area) === -1) return false
      if (filter.block && String(listing.block || '').indexOf(filter.block) === -1) return false
      if (filter.community && String(listing.community || '').indexOf(filter.community) === -1) return false
      if (!matchListingSourceFilter(listing, filter.source)) return false
      return true
    })
    .map((listing) => {
      const uploader = userById(db, listing.uploaderId) || {}
      const freshness = listingFreshness(listing)
      const location = listingLocationFields(listing)
      const display = listingDisplayFields(listing, db)
      return {
        id: listing.id,
        title: listing.shortTitle || listing.title,
        ...location,
        ...display,
        ...adminListingDetailFields(listing, uploader, location, display),
        uploader: uploader.name || '未知',
        uploaderPhone: uploader.phone || '',
        rent: `${listing.rent}/月`,
        layout: String(listing.layout || '').replace('整租', ''),
        commission: display.commissionText,
        source: listing.source || display.sourceLabel,
        video: listing.videoUrl ? '已传' : '未传',
        status: listing.status || '已下架',
        lastVerifiedAt: freshness.lastVerifiedAt,
        verifyStatus: freshness.verifyStatus,
        verifyTip: freshness.verifyTip,
        staleDays: freshness.staleDays,
        expiredAt: listing.expiredAt || '',
        expiredReason: listing.expiredReason || `超过 ${VERIFY_STALE_DAYS} 天未电话联系房东确认房态`,
        expiredPool: listing.expiredPool || '后台资产池'
      }
    })
}

function restoreExpiredListing(db, adminId, listingId) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  if (!isExpiredListing(listing)) {
    const error = new Error('该房源不在后台资产池')
    error.statusCode = 400
    throw error
  }

  const now = nowText()
  listing.lifecycleStatus = 'active'
  listing.status = '在租'
  listing.lastVerifiedAt = now
  listing.updatedAt = now
  listing.restoredAt = now
  listing.restoredBy = adminId || ''
  delete listing.expiredAt
  delete listing.expiredBy
  delete listing.expiredPool
  delete listing.expiredReason
  delete listing.expiredStaleDays
  syncListingRecommendationProfile(listing)

  pushFootprint(db, {
    id: id('F'),
    listingId,
    viewerId: adminId || 'system',
    action: '重新上架',
    time: now,
    sync: '管理员已从后台资产池重新上架'
  })
  return editableListingDetail(db, adminId, listingId, { admin: true })
}

function updateListingCoordinate(db, adminId, listingId, payload = {}) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  const latitude = numericCoordinate(payload.latitude !== undefined ? payload.latitude : payload.mapLatitude)
  const longitude = numericCoordinate(payload.longitude !== undefined ? payload.longitude : payload.mapLongitude)
  if (!hasValidCoordinatePair(latitude, longitude)) {
    const error = new Error('请填写有效经纬度')
    error.statusCode = 400
    throw error
  }

  const now = nowText()
  listing.mapLatitude = latitude
  listing.mapLongitude = longitude
  listing.coordinateSource = 'admin-verified-coordinate'
  listing.coordinateVerified = true
  listing.coordinateLevel = 'verified'
  listing.coordinateAccuracy = 'verified'
  listing.coordinateStatus = coordinateStatusText('verified')
  listing.coordinateUpdatedAt = now
  listing.coordinateUpdatedBy = adminId || ''
  listing.updatedAt = now
  syncListingRecommendationProfile(listing)

  pushFootprint(db, {
    id: id('F'),
    listingId,
    viewerId: adminId || 'system',
    action: '修正地图坐标',
    time: now,
    sync: `管理员已将地图坐标修正为 ${latitude}, ${longitude}`
  })
  return editableListingDetail(db, adminId, listingId, { admin: true })
}

function adminLogs(db, nowMs = Date.now()) {
  // 预建 id→实体索引，避免对每条足迹重复线性扫描 listings/users（后台足迹页无分页，
  // 90 天内记录不按行数截断，原实现每行三次线性查找会在高访问量时造成大量重复比较）。
  const listingsById = new Map((db.listings || []).map((listing) => [listing.id, listing]))
  const usersById = new Map((db.users || []).map((user) => [user.id, user]))
  return (db.footprints || [])
    .filter((item) => footprintWithinRetention(item, ADMIN_FOOTPRINT_RETENTION_MS, nowMs))
    .map((item) => {
    const listing = listingsById.get(item.listingId) || {}
    const viewer = usersById.get(item.viewerId) || {}
    const uploader = usersById.get(listing.uploaderId) || {}
    return {
      id: item.id,
      viewer: viewer.name,
      listing: listing.shortTitle,
      action: footprintActionText(item),
      needId: item.needId || '',
      purpose: item.purpose || '',
      uploader: uploader.name,
      sync: item.sync || '',
      time: footprintOccurredAt(item)
    }
    })
}

function commissionRows(db) {
  return (db.commissionRecords || []).map((item) => {
    const listing = listingById(db, item.listingId) || {}
    return {
      id: item.id,
      dealId: item.dealId || '',
      reportId: item.reportId || '',
      listingId: item.listingId,
      listing: listing.shortTitle,
      uploader: (userById(db, item.uploaderId) || {}).name,
      dealer: (userById(db, item.dealUserId) || {}).name,
      rate: `${item.rate || TOTAL_DEAL_COMMISSION_RATE}%`,
      uploaderRate: item.uploaderRate === undefined ? item.rate || UPLOADER_COMMISSION_RATE : item.uploaderRate,
      platformRate: item.platformRate === undefined ? 0 : item.platformRate,
      dealMonthlyRentFen: item.dealMonthlyRentFen || 0,
      landlordCommissionFen: item.landlordCommissionFen || 0,
      uploaderCommissionFen: item.uploaderCommissionFen || 0,
      platformCommissionFen: item.platformCommissionFen || 0,
      dealMonthlyRent: item.dealMonthlyRentFen ? fenToYuanText(item.dealMonthlyRentFen) : '',
      landlordCommission: item.landlordCommissionFen ? fenToYuanText(item.landlordCommissionFen) : '',
      uploaderCommission: fenToYuanText(item.uploaderCommissionFen || 0),
      platformCommission: fenToYuanText(item.platformCommissionFen || 0),
      status: item.status,
      time: item.time
    }
  })
}

function userCommissionRows(db, userId) {
  return (db.commissionRecords || [])
    .filter((item) => item.uploaderId === userId || item.dealUserId === userId)
    .map((item) => {
      const listing = listingById(db, item.listingId) || {}
      const location = publicListingLocationFields(listing)
      const uploader = userById(db, item.uploaderId) || {}
      const dealer = userById(db, item.dealUserId) || {}
      return {
        id: item.id,
        listingId: item.listingId,
        title: publicListingTitle(listing, location) || '未知房源',
        role: item.uploaderId === userId ? '我是上传人' : '我是成交人',
        uploader: uploader.name || '未知',
        dealer: dealer.name || '未知',
        rate: `${item.rate || TOTAL_DEAL_COMMISSION_RATE}%`,
        uploaderRate: item.uploaderRate === undefined ? item.rate || UPLOADER_COMMISSION_RATE : item.uploaderRate,
        platformRate: item.platformRate === undefined ? 0 : item.platformRate,
        dealMonthlyRentFen: item.dealMonthlyRentFen || 0,
        landlordCommissionFen: item.landlordCommissionFen || 0,
        uploaderCommissionFen: item.uploaderCommissionFen || 0,
        platformCommissionFen: item.platformCommissionFen || 0,
        dealMonthlyRent: item.dealMonthlyRentFen ? fenToYuanText(item.dealMonthlyRentFen) : '',
        landlordCommission: item.landlordCommissionFen ? fenToYuanText(item.landlordCommissionFen) : '',
        uploaderCommission: fenToYuanText(item.uploaderCommissionFen || 0),
        platformCommission: fenToYuanText(item.platformCommissionFen || 0),
        status: item.status,
        time: item.time
      }
    })
}

function pointLogs(db) {
  return (db.pointLogs || []).map((log) => ({
    user: (userById(db, log.userId) || {}).name,
    type: log.type,
    change: `${log.change > 0 ? '+' : ''}${log.change}`,
    note: log.note,
    time: log.time
  }))
}

function rechargeBills(db) {
  return (db.rechargeBills || []).map((bill) => ({
    id: bill.id,
    user: (userById(db, bill.userId) || {}).name,
    points: `${bill.points} 分`,
    amount: `${bill.amount} 元`,
    paymentMethod: bill.paymentMethod || (bill.status === '待确认' ? '后台人工确认' : '-'),
    outTradeNo: bill.outTradeNo || bill.id,
    status: bill.status,
    time: bill.time
  }))
}

function groupUploadRows(db) {
  return (db.groupUploads || []).map((item) => {
    const uploader = userById(db, item.userId) || {}
    return {
      id: item.id,
      title: item.title,
      area: item.area || '-',
      block: item.block || '-',
      uploader: uploader.name || '未知',
      uploaderPhone: uploader.phone || '-',
      screenshotUrl: item.screenshotUrl || '',
      screenshotKey: item.screenshotKey || '',
      contactStatus: item.contactStatus || '待联系核对',
      reviewNote: item.reviewNote || '',
      reviewer: item.reviewerId ? (userById(db, item.reviewerId) || {}).name : '',
      commission: item.commissionRate ? `${item.commissionRate}%` : '-',
      point: item.pointGranted ? '+1 已到账' : '审核通过后 +1',
      status: item.status || '待审核',
      time: item.time
    }
  })
}

function showingUploadRows(db) {
  return (db.showingUploads || []).map((item) => {
    const listing = listingById(db, item.listingId) || {}
    const viewer = userById(db, item.userId) || {}
    const reviewer = item.reviewerId ? userById(db, item.reviewerId) || {} : {}
    const room = [listing.building, listing.unit, listing.roomNumber].filter(Boolean).join('-')
    return {
      id: item.id,
      listingId: item.listingId,
      listing: listing.title || item.listingTitle || '未知房源',
      listingTitle: listing.title || item.listingTitle || '未知房源',
      community: listing.community || item.community || '',
      room: room || '-',
      user: viewer.name || '未知',
      userPhone: viewer.phone || '-',
      uploader: listing.uploaderId ? (userById(db, listing.uploaderId) || {}).name || '未知' : '-',
      photoUrl: item.photoUrl || '',
      photoKey: item.photoKey || '',
      watermarkText: item.watermarkText || '',
      locationText: item.locationText || '',
      latitude: item.latitude || '',
      longitude: item.longitude || '',
      contactStatus: item.contactStatus || (item.status === '待审核' ? '待审核' : '已审核'),
      reviewNote: item.reviewNote || '',
      reviewer: reviewer.name || '',
      reward: item.rewardGranted ? `普通房源额度 +${item.rewardCount || 1} 已增加` : `审核通过后普通房源额度 +${item.rewardCount || 1}`,
      rewardGranted: Boolean(item.rewardGranted),
      status: item.status || '待审核',
      time: item.time,
      reviewedAt: item.reviewedAt || ''
    }
  })
}

function addSensitiveFootprint(db, userId, listingId, payload = {}) {
  assertKnownUser(db, userId)
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertFrontendListingAvailable(listing)

  // 上传人查看自己上传的房源：直接展示地址/房东电话，不留痕、不耗每日额度、不计入敏感查看数。
  if (listing.uploaderId && String(listing.uploaderId) === String(userId)) {
    const ownLocation = listingLocationFields(listing)
    return {
      logs: listingLogs(db, listingId),
      quota: brokerSensitiveUsage(db, userId),
      sensitive: {
        ...ownLocation,
        areaText: `${ownLocation.city} · ${ownLocation.area}`,
        address: listing.address,
        landlordPhone: listing.landlordPhone,
        ...listingViewingMethodFields(listing),
        viewingKeyLocation: listingViewingKeyLocation(listing),
        viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
        sensitiveLocked: false,
        ownListing: true
      }
    }
  }
  const suppliedKey = String(payload && payload.idempotencyKey || '').trim()
  if (suppliedKey && (!/^[A-Za-z0-9:_-]{8,128}$/.test(suppliedKey) || /1[3-9]\d{9}/.test(suppliedKey))) {
    const error = new Error('敏感查看幂等标识无效')
    error.statusCode = 400
    throw error
  }
  const idempotencyKey = suppliedKey || id('SV')
  const date = todayKey()
  const sameKeyExisting = (db.footprints || []).find((item) => (
    item &&
    isSensitiveViewFootprint(item) &&
    String(item.viewerId || '') === String(userId) &&
    String(item.listingId || '') === String(listingId) &&
    item.idempotencyKey === idempotencyKey &&
    footprintDateKey(item) === date
  ))
  const dailyExisting = sameKeyExisting || (db.footprints || []).find((item) => (
    item &&
    isSensitiveViewFootprint(item) &&
    String(item.viewerId || '') === String(userId) &&
    String(item.listingId || '') === String(listingId) &&
    footprintDateKey(item) === date
  ))
  // 幂等键只在同一上海自然日代表同一次确认。跨日重放必须作为次日新查看重新走额度、限流和足迹，
  // 否则客户端可长期保存旧 key，免额度获取房源后来更新的地址和电话。
  assertSensitiveViewerEligible(db, userId)
  if (!sameKeyExisting) assertSensitiveViewQuotaAllowed(db, userId, listing)
  if (!dailyExisting) {
    assertClientFootprintRateLimit(db, userId, 'sensitive_view')
    pushFootprint(db, {
      id: id('F'),
      listingId,
      viewerId: userId,
      actionType: 'sensitive_view',
      idempotencyKey
    })
    listing.sensitiveViews = Number(listing.sensitiveViews || 0) + 1
  }
  const location = listingLocationFields(listing)
  const quota = brokerSensitiveUsage(db, userId)
  return {
    logs: listingLogs(db, listingId),
    quota,
    sensitive: {
      ...location,
      areaText: `${location.city} · ${location.area}`,
      address: listing.address,
      landlordPhone: listing.landlordPhone,
      ...listingViewingMethodFields(listing),
      viewingKeyLocation: listingViewingKeyLocation(listing),
      viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
      sensitiveLocked: false
    }
  }
}

function hasDialableListingPhone(listing = {}) {
  if (isCompanyListing(listing)) {
    return /^1[3-9]\d{9}$/.test(String(companyPublicListingFields(listing).landlordPhone || ''))
  }
  return /^1[3-9]\d{9}$/.test(String(listing.landlordPhone || '').trim())
}

function hasSensitiveListingAccess(db, userId, listing = {}) {
  if (isCompanyListing(listing)) return true
  if (listing.uploaderId && String(listing.uploaderId) === String(userId)) return true
  return (db.footprints || []).some((item) => (
    item &&
    String(item.viewerId || '') === String(userId) &&
    String(item.listingId || '') === String(listing.id || '') &&
    (
      Boolean(item.quotaCategory) ||
      /查看地址和电话|敏感信息/.test(String(item.action || '')) ||
      /sensitive_(?:view|info)/i.test(String(item.actionType || ''))
    )
  ))
}

function storeExactFootprint(db, record) {
  return pushFootprint(db, record)
}

// 只记录“系统拨号页已成功打开”。客户端只能提供不可读的幂等键；账号、房源、动作和时间全部由服务端决定。
function recordPhoneCallOpened(db, userId, listingId, payload = {}) {
  assertKnownUser(db, userId)
  const idempotencyKey = String(payload && payload.idempotencyKey || '').trim()
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey) || /1[3-9]\d{9}/.test(idempotencyKey)) {
    const error = new Error('拨号记录幂等标识无效')
    error.statusCode = 400
    throw error
  }
  // 幂等重试优先于可变房态、电话和授权门禁：首次写入成功后，即使房源随后成交/下架，重试也应
  // 返回原六字段记录并让客户端清空补发队列，不能把同一成功动作永久卡住。
  const existing = (db.footprints || []).find((item) => (
    item &&
    item.actionType === 'phone_call_opened' &&
    String(item.viewerId || '') === String(userId) &&
    String(item.listingId || '') === String(listingId) &&
    item.idempotencyKey === idempotencyKey
  ))
  if (existing) return clone(existing)

  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertFrontendListingAvailable(listing)
  if (!hasDialableListingPhone(listing)) {
    const error = new Error('该房源暂无可拨打电话')
    error.statusCode = 409
    throw error
  }
  if (!hasSensitiveListingAccess(db, userId, listing)) {
    const error = new Error('请先完成敏感信息查看确认')
    error.statusCode = 403
    throw error
  }
  assertClientFootprintRateLimit(db, userId, 'phone_call_opened')
  const record = {
    id: id('F'),
    viewerId: String(userId),
    listingId: String(listingId),
    actionType: 'phone_call_opened',
    occurredAt: new Date().toISOString(),
    idempotencyKey
  }
  return clone(storeExactFootprint(db, record))
}

function recordVideoShare(db, userId, listingId, payload = {}) {
  const user = assertKnownUser(db, userId)
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertFrontendListingAvailable(listing)
  if (!hasListingVideo(listing)) {
    const error = new Error('该房源暂无可转发视频')
    error.statusCode = 400
    throw error
  }

  assertClientFootprintRateLimit(db, userId, 'video_shared')

  const now = nowText()
  const location = publicListingLocationFields(listing)
  const title = publicListingTitle(listing, location) || listing.shortTitle || '房源视频'
  const sharePath = String(payload.sharePath || '').trim() || `/pages/shared-video/shared-video?id=${encodeURIComponent(listingId)}&source=tenant-video-share`
  const shareTitle = String(payload.shareTitle || '').trim() || `推荐你看这套房：${title}`
  pushFootprint(db, {
    id: id('F'),
    listingId,
    viewerId: userId,
    action: '转发房间视频给租客',
    needId: String(payload.needId || payload.rentalNeedId || '').trim(),
    purpose: String(payload.purpose || '推荐房源视频').trim(),
    time: '刚刚',
    dateKey: todayKey(),
    shareChannel: String(payload.channel || 'wechat').trim(),
    shareTarget: String(payload.target || 'tenant').trim(),
    sharePath,
    sync: '已记录视频转发，便于推荐追踪'
  })

  return {
    message: '视频转发已留痕',
    share: {
      listingId,
      title,
      shareTitle,
      sharePath,
      broker: user.name || '中介',
      time: now
    },
    logs: listingLogs(db, listingId, userId)
  }
}

function recordShowing(db, userId, listingId, payload = {}) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertFrontendListingAvailable(listing)
  if (!payload.photoUrl && !payload.photoKey) {
    const error = new Error('记录带看必须上传带时间地点水印的现场照片')
    error.statusCode = 400
    throw error
  }

  const needId = String(payload.needId || payload.rentalNeedId || payload.clientNeedId || '').trim()
  if (needId) assertUserNeed(db, userId, needId)

  db.showingUploads = db.showingUploads || []
  const location = publicListingLocationFields(listing)
  const showing = {
    id: id('SH'),
    listingId,
    userId,
    ...(needId ? { needId } : {}),
    listingTitle: publicListingTitle(listing, location),
    community: listing.community || '',
    photoUrl: payload.photoUrl || '',
    photoKey: payload.photoKey || '',
    watermarkText: payload.watermarkText || '',
    locationText: payload.locationText || '',
    latitude: payload.latitude || '',
    longitude: payload.longitude || '',
    status: '待审核',
    contactStatus: '待审核',
    reviewNote: '',
    rewardCategory: 'normal',
    rewardCount: 1,
    rewardGranted: false,
    time: nowText(),
    dateKey: todayKey()
  }
  db.showingUploads.unshift(showing)
  return {
    showing: clone(showing),
    logs: listingLogs(db, listingId),
    quota: brokerSensitiveUsage(db, userId),
    message: '带看水印照片已提交后台审核，审核通过后当天普通房源查看额度 +1'
  }
}

function reviewShowingUpload(db, adminId, showingId, payload = {}) {
  const showing = (db.showingUploads || []).find((item) => item.id === showingId)
  if (!showing) {
    const error = new Error('未找到带看审核记录')
    error.statusCode = 404
    throw error
  }

  const action = payload.action || payload.status
  const isApprove = action === 'approve' || action === '已通过'
  const isReject = action === 'reject' || action === '已驳回'
  if (!isApprove && !isReject) {
    const error = new Error('审核动作必须是 approve 或 reject')
    error.statusCode = 400
    throw error
  }
  if (isReject && showing.rewardGranted) {
    const error = new Error('已发放额度的带看记录不能直接驳回，请先人工处理额度')
    error.statusCode = 400
    throw error
  }

  showing.status = isApprove ? '已通过' : '已驳回'
  showing.contactStatus = isApprove ? '已审核通过' : '已审核驳回'
  showing.reviewNote = payload.note || (isApprove ? '水印照片核验通过，普通房源额度 +1' : '水印照片未通过核验')
  showing.reviewerId = adminId || 'admin'
  showing.reviewedAt = nowText()
  showing.reviewedDateKey = todayKey()

  if (isApprove && !showing.rewardGranted) {
    showing.rewardGranted = true
    showing.rewardDateKey = todayKey()
    showing.rewardCount = Number(showing.rewardCount || 1)
    pushFootprint(db, {
      id: id('F'),
      listingId: showing.listingId,
      viewerId: showing.userId,
      action: '记录带看',
      ...(showing.needId ? { needId: showing.needId } : {}),
      time: '刚刚',
      dateKey: todayKey(),
      showingUploadId: showing.id,
      proofStatus: '已通过',
      sync: '已同步上传人和管理员'
    })
  }
  if (isApprove && showing.needId) {
    needFunnel.markMilestone(db, showing.userId, showing.needId, 'showing')
  }

  db.pointLogs = db.pointLogs || []
  db.pointLogs.unshift({
    id: id('P'),
    userId: adminId || showing.userId,
    type: '带看审核',
    change: 0,
    note: `${showing.listingTitle || showing.listingId} ${showing.status}${isApprove ? '，普通房源额度 +1' : ''}`,
    time: '刚刚'
  })

  return showingUploadRows(db)
}

function maskPhone(phone) {
  const text = String(phone || '').trim()
  if (text.length < 7) return text
  return `${text.slice(0, 3)}****${text.slice(-4)}`
}

function fenToYuanText(fen) {
  return (Number(fen || 0) / 100).toFixed(2)
}

function normalizeMoneyToFen(value, fieldName, alreadyFen = false) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  const numeric = Number(raw.replace(/[^\d.-]/g, ''))
  if (!raw || !Number.isFinite(numeric) || numeric <= 0) {
    const error = new Error(`${fieldName}必须是大于 0 的金额`)
    error.statusCode = 400
    throw error
  }
  return Math.round(alreadyFen ? numeric : numeric * 100)
}

function amountFenFromPayload(payload = {}, yuanFields = [], fenFields = [], fieldName = '金额') {
  const fenField = fenFields.find((field) => Object.prototype.hasOwnProperty.call(payload, field))
  if (fenField) return normalizeMoneyToFen(payload[fenField], fieldName, true)
  const yuanField = yuanFields.find((field) => Object.prototype.hasOwnProperty.call(payload, field))
  if (yuanField) return normalizeMoneyToFen(payload[yuanField], fieldName, false)
  const error = new Error(`${fieldName}必填`)
  error.statusCode = 400
  throw error
}

function formatClientReport(db, report = {}) {
  const listing = listingById(db, report.listingId) || {}
  const location = publicListingLocationFields(listing)
  const broker = userById(db, report.brokerId) || {}
  const snapshot = report.reportSnapshot || {}
  return {
    id: report.id,
    needId: report.needId || '',
    listingId: report.listingId,
    listingTitle: report.listingTitle || snapshot.listingTitle || publicListingTitle(listing, location) || '未知房源',
    community: report.community || snapshot.community || location.community || '',
    broker: broker.name || '未知',
    customerName: report.customerName || '',
    customerPhoneMasked: maskPhone(report.customerPhone),
    reportSnapshot: clone(snapshot),
    snapshotAt: report.snapshotAt || snapshot.snapshotAt || '',
    status: report.status,
    dealId: report.dealId || '',
    time: report.createdAt || report.time || ''
  }
}

function userReportRows(db, userId) {
  return (db.clientReports || [])
    .filter((report) => report.brokerId === userId)
    .map((report) => formatClientReport(db, report))
}

function adminReportRows(db) {
  return (db.clientReports || []).map((report) => formatClientReport(db, report))
}

function assertReportDealWritesEnabled() {
  if (config.features && config.features.reportDealWritesEnabled === true) return
  const error = new Error('客户报备与签单功能已暂停')
  error.statusCode = 410
  error.data = { reason: 'REPORT_DEAL_PAUSED' }
  throw error
}

function createClientReport(db, userId, listingId, payload = {}) {
  assertReportDealWritesEnabled()
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertFrontendListingAvailable(listing)

  const customerPhone = String(payload.customerPhone || payload.phone || payload.mobile || '').trim()
  if (!customerPhone) {
    const error = new Error('客户手机号必填')
    error.statusCode = 400
    throw error
  }
  if (!/^1\d{10}$/.test(customerPhone)) {
    const error = new Error('请输入 11 位客户手机号')
    error.statusCode = 400
    throw error
  }

  const now = nowText()
  const needId = String(payload.needId || payload.rentalNeedId || payload.clientNeedId || '').trim()
  assertUserNeed(db, userId, needId)
  const location = publicListingLocationFields(listing)
  const listingTitle = publicListingTitle(listing, location) || listing.title || '未知房源'
  const reportSnapshot = {
    needId,
    listingId,
    brokerId: userId,
    uploaderId: listing.uploaderId,
    listingTitle,
    community: location.community || '',
    rentAtReport: listing.rent || '',
    rentFen: Math.round(Number(listing.rent || 0) * 100),
    source: listing.source || listingSourceFields(listing, db).sourceLabel || '',
    snapshotAt: now
  }
  const report = {
    id: id('R'),
    needId,
    listingId,
    brokerId: userId,
    uploaderId: listing.uploaderId,
    listingTitle,
    community: location.community || '',
    snapshotAt: now,
    reportSnapshot,
    customerName: String(payload.customerName || payload.customer || payload.name || '').trim(),
    customerPhone,
    status: '已报备',
    createdAt: now,
    updatedAt: now,
    dateKey: todayKey()
  }
  db.clientReports = db.clientReports || []
  db.clientReports.unshift(report)
  needFunnel.markMilestone(db, userId, needId, 'l2')
  return {
    message: '报备已创建',
    report: formatClientReport(db, report)
  }
}

function hasOwnCommissionRule(source) {
  return Boolean(
    source &&
    typeof source === 'object' &&
    Object.prototype.hasOwnProperty.call(source, 'commissionRule') &&
    source.commissionRule !== undefined
  )
}

function frozenCommissionRuleForDeal(deal = {}, fallbackRule = {}) {
  // 顶层冻结值是第一事实源；只要字段存在（即使 null/非对象/不完整）就交给守恒校验判脏，
  // 不能逐字段拿当前配置补齐。顶层真正缺失时才看 dealSnapshot；两处都缺失的真老记录才回退。
  if (hasOwnCommissionRule(deal)) return deal.commissionRule
  const snapshot = deal && deal.dealSnapshot
  if (hasOwnCommissionRule(snapshot)) return snapshot.commissionRule
  return fallbackRule
}

function formatDealRecord(db, deal = {}) {
  const listing = listingById(db, deal.listingId) || {}
  const location = publicListingLocationFields(listing)
  const report = reportById(db, deal.reportId) || {}
  const broker = userById(db, deal.brokerId) || {}
  const uploader = userById(db, deal.uploaderId) || {}
  const baseCommissionRule = commissionRuleForListing(listing, db, deal.uploaderId)
  const commissionRule = clone(frozenCommissionRuleForDeal(deal, baseCommissionRule))
  const savedLandlordCommissionPercent = Number(
    deal.landlordCommissionPercent ??
    (deal.dealSnapshot && deal.dealSnapshot.landlordCommissionPercent)
  )
  const landlordCommissionPercent = Number.isInteger(savedLandlordCommissionPercent) && savedLandlordCommissionPercent >= 0 && savedLandlordCommissionPercent <= 100
    ? savedLandlordCommissionPercent
    : storedLandlordCommissionPercent(listing)
  let commissionBreakdown = null
  let rate = null
  let uploaderRate = null
  let platformRate = null
  let expectedUploaderCommissionFen = null
  let expectedPlatformCommissionFen = null
  let commissionIntegrity = { valid: true, reason: '' }
  try {
    commissionBreakdown = clone(
      deal.commissionBreakdown ||
      (deal.dealSnapshot && deal.dealSnapshot.commissionBreakdown) ||
      commissionBreakdownFromRule(landlordCommissionPercent, commissionRule)
    )
    const expectedCommissionFen = commissionFenBreakdown(Number(deal.landlordCommissionFen || 0), commissionRule)
    rate = Number(commissionRule.rate)
    uploaderRate = Number(commissionRule.uploaderRate)
    platformRate = Number(commissionRule.platformRate)
    expectedUploaderCommissionFen = expectedCommissionFen.uploaderCommissionFen
    expectedPlatformCommissionFen = expectedCommissionFen.platformCommissionFen
  } catch (error) {
    const isHistoricalCommissionIntegrityError = error && error.statusCode === 500 &&
      /分佣规则异常|房东佣金金额异常|房东佣金比例异常/.test(String(error.message || ''))
    if (!isHistoricalCommissionIntegrityError) throw error
    // 历史列表是只读审计入口：单条脏快照只能降级派生展示，不能拖垮整页，也不能按当前配置伪算。
    // 原始金额、冻结规则、已落库结算值和关联 ID 仍在返回对象中保留，供管理员核对。
    commissionBreakdown = null
    expectedUploaderCommissionFen = null
    expectedPlatformCommissionFen = null
    commissionIntegrity = { valid: false, reason: 'INVALID_COMMISSION_SNAPSHOT' }
  }
  return {
    id: deal.id,
    reportId: deal.reportId,
    needId: deal.needId || '',
    listingId: deal.listingId,
    listingTitle: deal.listingTitle || publicListingTitle(listing, location) || '未知房源',
    community: deal.community || location.community || '',
    broker: broker.name || '未知',
    uploader: uploader.name || '未知',
    customerName: report.customerName || '',
    customerPhoneMasked: maskPhone(report.customerPhone),
    dealMonthlyRentFen: deal.dealMonthlyRentFen,
    dealMonthlyRent: fenToYuanText(deal.dealMonthlyRentFen),
    landlordCommissionFen: deal.landlordCommissionFen,
    landlordCommission: fenToYuanText(deal.landlordCommissionFen),
    landlordCommissionPercent,
    commissionBreakdown,
    commissionIntegrity,
    commissionIntegrityMessage: commissionIntegrity.valid ? '' : '历史分佣数据异常，派生金额待管理员核对',
    uploaderCommissionRate: rate,
    uploaderRate,
    platformRate,
    expectedUploaderCommissionFen,
    expectedUploaderCommission: commissionIntegrity.valid ? fenToYuanText(expectedUploaderCommissionFen) : '待核对',
    expectedPlatformCommissionFen,
    expectedPlatformCommission: commissionIntegrity.valid ? fenToYuanText(expectedPlatformCommissionFen) : '待核对',
    uploaderCommissionFen: deal.uploaderCommissionFen || 0,
    uploaderCommission: fenToYuanText(deal.uploaderCommissionFen || 0),
    platformCommissionFen: deal.platformCommissionFen || 0,
    platformCommission: fenToYuanText(deal.platformCommissionFen || 0),
    commissionRecordId: deal.commissionRecordId || '',
    rentFen: deal.rentFen || 0,
    rentAtDeal: deal.rentAtDeal || '',
    ownerType: deal.ownerType || '',
    source: deal.source || '',
    commissionRule: clone(commissionRule),
    snapshotAt: deal.snapshotAt || '',
    dealSnapshot: clone(deal.dealSnapshot || {}),
    status: deal.status,
    remark: deal.remark || '',
    time: deal.createdAt || deal.time || '',
    confirmedAt: deal.confirmedAt || ''
  }
}

function userDealRows(db, userId) {
  return (db.dealRecords || [])
    .filter((deal) => deal.brokerId === userId || deal.uploaderId === userId)
    .map((deal) => formatDealRecord(db, deal))
}

function adminDealRows(db) {
  return (db.dealRecords || []).map((deal) => formatDealRecord(db, deal))
}

function createDealFromReport(db, userId, reportId, payload = {}) {
  assertReportDealWritesEnabled()
  const report = reportById(db, reportId)
  if (!report) {
    const error = new Error('未找到报备记录')
    error.statusCode = 404
    throw error
  }
  if (report.brokerId !== userId) {
    const error = new Error('只能从自己的报备记录发起签单')
    error.statusCode = 403
    throw error
  }
  if (report.dealId) {
    const error = new Error('该报备已发起签单，不能重复提交')
    error.statusCode = 400
    throw error
  }

  const listing = listingById(db, report.listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertFrontendListingAvailable(listing)

  const dealMonthlyRentFen = amountFenFromPayload(
    payload,
    ['dealMonthlyRent', 'monthlyRent', 'rent'],
    ['dealMonthlyRentFen', 'monthlyRentFen', 'rentFen'],
    '成交月租'
  )
  // 房东实付总佣金只由“成交月租 × 房源已存比例”计算。客户端即使提交同名金额/比例也不会参与结果。
  const landlordCommissionPercent = storedLandlordCommissionPercent(listing)
  const landlordCommissionFen = Math.round(dealMonthlyRentFen * landlordCommissionPercent / 100)

  const now = nowText()
  const location = publicListingLocationFields(listing)
  const listingTitle = publicListingTitle(listing, location) || listing.title || '未知房源'
  const rentFen = Math.round(Number(listing.rent || 0) * 100)
  const sourceFields = listingSourceFields(listing, db)
  const ownerType = sourceFields.ownerType
  const source = listing.source || sourceFields.sourceLabel || ''
  const commissionRule = commissionRuleForListing({ ...listing, ownerType, source }, db, listing.uploaderId, report.brokerId)
  const commissionBreakdown = commissionBreakdownFromRule(landlordCommissionPercent, commissionRule)
  const dealSnapshot = {
    needId: report.needId || '',
    listingId: report.listingId,
    reportId,
    brokerId: report.brokerId,
    uploaderId: listing.uploaderId,
    listingTitle,
    community: location.community || '',
    rentAtDeal: listing.rent || '',
    rentFen,
    ownerType,
    source,
    landlordCommissionPercent,
    landlordCommissionFen,
    commissionRule,
    commissionBreakdown,
    snapshotAt: now
  }
  const deal = {
    id: id('D'),
    reportId,
    needId: report.needId || '',
    listingId: report.listingId,
    brokerId: report.brokerId,
    uploaderId: listing.uploaderId,
    listingTitle,
    community: location.community || '',
    rentAtDeal: listing.rent || '',
    rentFen,
    ownerType,
    source,
    landlordCommissionPercent,
    commissionRule,
    commissionBreakdown,
    snapshotAt: now,
    dealSnapshot,
    dealMonthlyRentFen,
    landlordCommissionFen,
    remark: String(payload.remark || payload.note || '').trim(),
    status: '待管理员确认',
    createdAt: now,
    updatedAt: now
  }
  db.dealRecords = db.dealRecords || []
  db.dealRecords.unshift(deal)
  needFunnel.markMilestone(db, report.brokerId, report.needId, 'l3Submitted')

  report.dealId = deal.id
  report.status = '待确认签单'
  report.updatedAt = now
  listing.status = '已签单待确认'
  listing.updatedAt = now
  clearListingRecommendationProfile(listing, 'deal_pending')

  return {
    message: commissionRule.rate <= 0 ? '签单已提交，公司房源成交不抽佣，等待管理员确认' : '签单已提交，等待管理员确认',
    deal: formatDealRecord(db, deal)
  }
}

function confirmDeal(db, adminId, dealId) {
  assertReportDealWritesEnabled()
  const deal = dealById(db, dealId)
  if (!deal) {
    const error = new Error('未找到签单记录')
    error.statusCode = 404
    throw error
  }

  const listing = listingById(db, deal.listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }

  const existingRecord = (db.commissionRecords || []).find((record) => record.dealId === deal.id)
  // 分佣规则以签单时冻结的快照为准，绝不按确认时刻的房源现状重算——否则待确认期间房源被
  // 编辑/迁移（ownerType/source/companyListing 变化，或上传人被提为管理员）会静默改变甚至
  // 清零上传人分佣。仅当历史签单缺少冻结值时才回退重算。
  const commissionRule = frozenCommissionRuleForDeal(
    deal,
    commissionRuleForListing(listing, db, deal.uploaderId, deal.brokerId)
  )
  // 写路径无论首次确认还是“已确认”幂等重试，都必须先校验冻结规则与金额；列表 formatter 的只读降级
  // 绝不能让脏已确认单借早退分支绕过 money 守恒，或在校验前写入漏斗里程碑。
  const settledCommissionFen = commissionFenBreakdown(Number(deal.landlordCommissionFen || 0), commissionRule)
  if (deal.status === '已确认') {
    needFunnel.markMilestone(db, deal.brokerId, deal.needId, 'l3Confirmed', deal.confirmedAt)
    return {
      message: '签单已确认',
      deal: formatDealRecord(db, deal),
      commissionRecord: existingRecord ? clone(existingRecord) : null,
      noCommission: commissionRule.rate === 0
    }
  }

  // 结算端最后防线已在早退分支之前完成，异常（sum>100/不一致/非数）直接 fail-loud、不生成分佣记录。
  const now = nowText()
  const uploaderCommissionFen = settledCommissionFen.uploaderCommissionFen
  const platformCommissionFen = settledCommissionFen.platformCommissionFen
  // 不再回写覆盖 deal.commissionRule / dealSnapshot.commissionRule：它们是签单时冻结的
  // 不可变证据。仅为缺失冻结值的历史签单补齐（不覆盖已有值）。
  if (!hasOwnCommissionRule(deal)) {
    deal.commissionRule = clone(commissionRule)
  }
  if (deal.dealSnapshot && typeof deal.dealSnapshot === 'object' && !hasOwnCommissionRule(deal.dealSnapshot)) {
    deal.dealSnapshot = {
      ...deal.dealSnapshot,
      commissionRule: clone(commissionRule)
    }
  }
  if (commissionRule.rate <= 0) {
    deal.status = '已确认'
    deal.confirmedAt = now
    deal.confirmedBy = adminId || 'admin'
    deal.uploaderCommissionFen = 0
    deal.platformCommissionFen = 0
    deal.commissionRecordId = ''
    deal.updatedAt = now

    const report = reportById(db, deal.reportId)
    if (report) {
      report.status = '已签单'
      report.commissionRecordId = ''
      report.updatedAt = now
    }

    listing.status = '已成交'
    listing.lifecycleStatus = 'sold'
    listing.updatedAt = now
    clearListingRecommendationProfile(listing, 'sold')
    needFunnel.markMilestone(db, deal.brokerId, deal.needId, 'l3Confirmed')

    return {
      message: '签单已确认，公司房源不生成分佣记录',
      deal: formatDealRecord(db, deal),
      commissionRecord: null,
      noCommission: true
    }
  }

  const record = {
    id: id('C'),
    dealId: deal.id,
    reportId: deal.reportId,
    needId: deal.needId || '',
    listingId: deal.listingId,
    uploaderId: deal.uploaderId,
    dealUserId: deal.brokerId,
    rate: commissionRule.rate,
    uploaderRate: commissionRule.uploaderRate,
    platformRate: commissionRule.platformRate,
    dealMonthlyRentFen: deal.dealMonthlyRentFen,
    landlordCommissionFen: deal.landlordCommissionFen,
    uploaderCommissionFen,
    platformCommissionFen,
    status: '已确认',
    confirmedBy: adminId || 'admin',
    confirmedAt: now,
    time: now
  }
  db.commissionRecords = db.commissionRecords || []
  db.commissionRecords.unshift(record)

  deal.status = '已确认'
  deal.confirmedAt = now
  deal.confirmedBy = adminId || 'admin'
  deal.uploaderCommissionFen = uploaderCommissionFen
  deal.platformCommissionFen = platformCommissionFen
  deal.commissionRecordId = record.id
  deal.updatedAt = now

  const report = reportById(db, deal.reportId)
  if (report) {
    report.status = '已签单'
    report.commissionRecordId = record.id
    report.updatedAt = now
  }

  listing.status = '已成交'
  listing.lifecycleStatus = 'sold'
  listing.updatedAt = now
  clearListingRecommendationProfile(listing, 'sold')
  needFunnel.markMilestone(db, deal.brokerId, deal.needId, 'l3Confirmed')

  return {
    message: '签单已确认，正式分佣记录已生成',
    deal: formatDealRecord(db, deal),
    commissionRecord: clone(record),
    noCommission: false
  }
}

function registerDeal(db, userId, listingId) {
  assertReportDealWritesEnabled()
  const error = new Error('签单只能从报备记录发起，请先创建报备后从报备记录提交签单')
  error.statusCode = 400
  throw error
}

function registerLegacyDeal(db, userId, listingId) {
  return registerDeal(db, userId, listingId)
}

function rechargePoints(db, userId, points) {
  const count = Math.max(1, Math.floor(Number(points) || 1))
  const amount = count * 20
  const time = '刚刚'
  db.rechargeBills = db.rechargeBills || []
  createRechargeBill(db, userId, {
    points: count,
    amount,
    status: '待确认',
    paymentMethod: '后台人工确认',
    time
  })
  return profileState(db, userId)
}

function createRechargeBill(db, userId, payload = {}) {
  const count = Math.max(1, Math.floor(Number(payload.points) || 1))
  const amount = Number(payload.amount || count * 20)
  const billId = payload.id || id('RC')
  db.rechargeBills = db.rechargeBills || []
  const bill = {
    id: billId,
    userId,
    points: count,
    amount,
    status: payload.status || '待支付',
    pointGranted: false,
    paymentMethod: payload.paymentMethod || '微信支付',
    outTradeNo: payload.outTradeNo || billId,
    prepayId: payload.prepayId || '',
    transactionId: payload.transactionId || '',
    time: payload.time || '刚刚'
  }
  db.rechargeBills.unshift(bill)
  return clone(bill)
}

function grantRechargePoints(db, bill, note) {
  db.pointLogs = db.pointLogs || []
  if (!bill.pointGranted) {
    bill.pointGranted = true
    db.pointLogs.unshift({
      id: id('P'),
      userId: bill.userId,
      type: '积分充值',
      change: Number(bill.points || 0),
      note,
      time: '刚刚'
    })
  }
}

function markRechargePaid(db, outTradeNo, payload = {}) {
  const bill = (db.rechargeBills || []).find((item) => item.outTradeNo === outTradeNo || item.id === outTradeNo)
  if (!bill) {
    const error = new Error('未找到充值账单')
    error.statusCode = 404
    throw error
  }

  if (bill.status === '已确认到账' && bill.pointGranted) {
    return clone(bill)
  }

  bill.status = '已确认到账'
  bill.paymentMethod = bill.paymentMethod || '微信支付'
  bill.transactionId = payload.transactionId || payload.transaction_id || bill.transactionId || ''
  bill.paidAt = nowText()
  bill.reviewNote = payload.reviewNote || '微信支付回调确认到账'
  grantRechargePoints(db, bill, payload.pointNote || `微信支付充值 ${bill.amount} 元到账`)
  return clone(bill)
}

function syncWechatRechargeBill(db, billId, transaction = {}) {
  const bill = (db.rechargeBills || []).find((item) => item.id === billId || item.outTradeNo === billId)
  if (!bill) {
    const error = new Error('未找到充值账单')
    error.statusCode = 404
    throw error
  }

  const tradeState = transaction.trade_state || ''
  const tradeDesc = transaction.trade_state_desc || ''
  bill.lastSyncedAt = nowText()
  bill.transactionId = transaction.transaction_id || bill.transactionId || ''
  bill.tradeState = tradeState

  if (tradeState === 'SUCCESS') {
    return markRechargePaid(db, bill.outTradeNo || bill.id, {
      ...transaction,
      reviewNote: '微信支付查单确认到账',
      pointNote: `微信支付查单确认 ${bill.amount} 元到账`
    })
  }

  if (['CLOSED', 'REVOKED', 'PAYERROR'].includes(tradeState)) {
    bill.status = '支付失败'
    bill.reviewNote = tradeDesc || '微信支付查单显示未支付成功'
    return clone(bill)
  }

  if (tradeState === 'REFUND') {
    bill.status = '已退款'
    bill.reviewNote = tradeDesc || '微信支付查单显示已退款'
    return clone(bill)
  }

  bill.status = bill.status || '待支付'
  bill.reviewNote = tradeDesc || (tradeState ? `微信支付查单状态：${tradeState}` : '微信支付查单未返回交易状态')
  return clone(bill)
}

function reviewRechargeBill(db, adminId, billId, payload = {}) {
  const bill = (db.rechargeBills || []).find((item) => item.id === billId)
  if (!bill) {
    const error = new Error('未找到充值账单')
    error.statusCode = 404
    throw error
  }

  const action = payload.action || payload.status
  const isApprove = action === 'approve' || action === '已确认到账'
  const isReject = action === 'reject' || action === '已驳回'
  if (!isApprove && !isReject) {
    const error = new Error('审核动作必须是 approve 或 reject')
    error.statusCode = 400
    throw error
  }

  if (bill.status !== '待确认') {
    const error = new Error('只有待确认充值账单可以审核')
    error.statusCode = 400
    throw error
  }

  bill.status = isApprove ? '已确认到账' : '已驳回'
  bill.reviewerId = adminId || 'admin'
  bill.reviewedAt = nowText()
  bill.reviewNote = payload.note || (isApprove ? '管理员确认收款，积分到账' : '管理员驳回充值申请')
  db.pointLogs = db.pointLogs || []

  if (isApprove && !bill.pointGranted) {
    grantRechargePoints(db, bill, `充值 ${bill.amount} 元管理员确认到账`)
  }

  if (isReject) {
    bill.pointGranted = false
    db.pointLogs.unshift({
      id: id('P'),
      userId: adminId || bill.userId,
      type: '充值审核',
      change: 0,
      note: `${bill.id} 已驳回，积分未到账`,
      time: '刚刚'
    })
  }

  return rechargeBills(db)
}

function uploadGroupListing(db, userId, payload = {}) {
  const time = '刚刚'
  if (!payload.title || (!payload.screenshotUrl && !payload.screenshotKey)) {
    const error = new Error('群聊名称和聊天信息截图必填')
    error.statusCode = 400
    throw error
  }

  db.groupUploads = db.groupUploads || []
  db.groupUploads.unshift({
    id: id('GU'),
    userId,
    groupId: payload.groupId || 'G1',
    title: payload.title,
    area: payload.area || '',
    block: payload.block || '',
    screenshotUrl: payload.screenshotUrl || '',
    screenshotKey: payload.screenshotKey || '',
    commissionRate: OWNER_COMMISSION_RATE,
    points: 1,
    pointGranted: false,
    status: '待审核',
    contactStatus: '待联系核对',
    time
  })
  return groupState(db, userId)
}

function reviewGroupUpload(db, adminId, uploadId, payload = {}) {
  const upload = (db.groupUploads || []).find((item) => item.id === uploadId)
  if (!upload) {
    const error = new Error('未找到群聊上传记录')
    error.statusCode = 404
    throw error
  }

  const action = payload.action || payload.status
  const isApprove = action === 'approve' || action === '已通过'
  const isReject = action === 'reject' || action === '已驳回'
  if (!isApprove && !isReject) {
    const error = new Error('审核动作必须是 approve 或 reject')
    error.statusCode = 400
    throw error
  }

  if (isReject && upload.pointGranted) {
    const error = new Error('已到账记录不能直接驳回，请先人工处理积分')
    error.statusCode = 400
    throw error
  }

  upload.status = isApprove ? '已通过' : '已驳回'
  upload.contactStatus = '已联系核对'
  upload.reviewNote = payload.note || (isApprove ? '已联系上传人核对，审核通过' : '已联系上传人核对，审核驳回')
  upload.reviewerId = adminId || 'admin'
  upload.reviewedAt = nowText()

  if (isApprove && !upload.pointGranted) {
    db.pointLogs = db.pointLogs || []
    upload.pointGranted = true
    db.pointLogs.unshift({
      id: id('P'),
      userId: upload.userId,
      type: '群聊审核通过',
      change: Number(upload.points || 1),
      note: `群聊「${upload.title}」核对通过，积分到账`,
      time: '刚刚'
    })
  }

  db.pointLogs.unshift({
    id: id('P'),
    userId: adminId || upload.userId,
    type: '群聊审核',
    change: 0,
    note: `${upload.title} ${upload.status}`,
    time: '刚刚'
  })
  return groupUploadRows(db)
}

function unlockGroup(db, userId, groupId) {
  const group = (db.groups || []).find((item) => item.id === groupId)
  if (!group) return { ok: false, message: '未找到该群', data: groupState(db, userId) }
  const isDefaultJoined = group.unlocked === true && group.tag === '已加入'
  const alreadyUnlocked = (db.groupUnlocks || []).some((item) => item.userId === userId && item.groupId === groupId)
  if (isDefaultJoined || alreadyUnlocked) return { ok: false, message: '该群已解锁', data: groupState(db, userId) }
  if (pointBalance(db, userId) <= 0) {
    return { ok: false, message: '积分不足，群聊审核通过或充值后可获得积分', data: groupState(db, userId) }
  }

  db.groupUnlocks = db.groupUnlocks || []
  db.groupUnlocks.unshift({
    id: id('GUO'),
    userId,
    groupId,
    groupName: group.name,
    time: '刚刚'
  })
  db.pointLogs = db.pointLogs || []
  db.pointLogs.unshift({
    id: id('P'),
    userId,
    type: '换群',
    change: -1,
    note: `解锁${group.name}一次`,
    time: '刚刚'
  })
  return { ok: true, message: '已消耗 1 积分换群', data: groupState(db, userId) }
}

function guessArea(address) {
  const areas = ['滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '滨江', '萧山', '上城', '西湖', '拱墅', '余杭', '临平', '钱塘']
  return areas.find((area) => String(address || '').indexOf(area) !== -1) || '待分区'
}

function firstText(...values) {
  const value = values.find((item) => String(item || '').trim())
  return String(value || '').trim()
}

function normalizeDistrict(value) {
  const text = firstText(value)
  if (!text || text === '待分区') return text || '待分区'
  return text
}

function normalizeHousePart(value, suffix) {
  const text = firstText(value)
  if (!text) return ''
  return text.endsWith(suffix) ? text : `${text}${suffix}`
}

function buildStructuredAddress(fields = {}) {
  return [
    fields.city,
    fields.area,
    fields.community,
    normalizeHousePart(fields.building, '栋'),
    normalizeHousePart(fields.unit, '单元'),
    normalizeHousePart(fields.roomNumber, '室')
  ].filter(Boolean).join('')
}

function buildLayoutFromFields(fields = {}) {
  return [fields.rentMode, fields.room, fields.hall, fields.bath].filter(Boolean).join('')
}

function structuredLocation(listing = {}) {
  const city = listing.city || '杭州'
  const area = normalizeDistrict(listing.district || listing.area || '待分区')
  const community = listing.community || ''
  return [city, area, community].filter(Boolean).join('')
}

function roomAddress(listing = {}) {
  return [
    normalizeHousePart(listing.building, '栋'),
    normalizeHousePart(listing.unit, '单元'),
    normalizeHousePart(listing.roomNumber, '室')
  ].filter(Boolean).join('')
}

function listingLocationFields(listing = {}) {
  const city = listing.city || '杭州'
  const area = normalizeDistrict(listing.district || listing.area || '待分区')
  return {
    city,
    district: area,
    area,
    block: listing.block || area || '待板块',
    community: listing.community || '',
    building: listing.building || '',
    unit: listing.unit || '',
    roomNumber: listing.roomNumber || '',
    locationSummary: structuredLocation({ ...listing, city, area }),
    roomAddress: roomAddress(listing)
  }
}

function publicListingLocationFields(listing = {}) {
  const city = listing.city || '杭州'
  const area = normalizeDistrict(listing.district || listing.area || '待分区')
  return {
    city,
    district: area,
    area,
    block: listing.block || area || '待板块',
    community: listing.community || '',
    locationSummary: structuredLocation({ ...listing, city, area })
  }
}

// 看房方式：钥匙 / 密码 / 联系房东；空 = 存量房源未显式指定（展示口径按已有信息推导）。
const VIEWING_METHOD_KEY = '钥匙'
const VIEWING_METHOD_PASSWORD = '密码'
const VIEWING_METHOD_LANDLORD = '联系房东'
const VIEWING_METHODS = [VIEWING_METHOD_KEY, VIEWING_METHOD_PASSWORD, VIEWING_METHOD_LANDLORD]

function normalizeViewingMethod(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (VIEWING_METHODS.indexOf(text) !== -1) return text
  if (/^key$/i.test(text)) return VIEWING_METHOD_KEY
  if (/^password$/i.test(text)) return VIEWING_METHOD_PASSWORD
  if (/^(landlord|contact)$/i.test(text)) return VIEWING_METHOD_LANDLORD
  return ''
}

// 飞书「看房方式密码」列有时填的不是门锁密码，而是「15号空出」这类腾房备注——
// 这类值不算密码，公司房源按「联系房东」处理（电话走公司统一看房电话）。
function isViewingVacancyNote(value) {
  return /空出/.test(String(value || ''))
}

function realViewingPassword(listing = {}) {
  const password = firstText(listing.viewingPassword, listing.showingPassword, listing.password)
  return isViewingVacancyNote(password) ? '' : password
}

// 存量兼容：未显式指定看房方式的老房源按已有信息推导。
// 公司房源跟飞书表走：密码列是真密码 → 密码看房；「几号空出」腾房备注或空 → 联系房东（打公司看房电话）。
// 非公司房源电话优先（旧详情页只展示房东电话、密码仅后台记录——电话+密码并存的存量必须继续展示电话）。
function effectiveViewingMethod(listing = {}) {
  const explicit = normalizeViewingMethod(firstText(listing.viewingMethod, listing.showingMethod))
  if (explicit) return explicit
  const hasPassword = Boolean(realViewingPassword(listing))
  const hasPhone = Boolean(firstText(listing.landlordPhone, listing.contact))
  if (isCompanyListing(listing)) {
    return hasPassword ? VIEWING_METHOD_PASSWORD : VIEWING_METHOD_LANDLORD
  }
  return hasPhone ? VIEWING_METHOD_LANDLORD : (hasPassword ? VIEWING_METHOD_PASSWORD : '')
}

// 详情/编辑展示口径：只含方式名与文案，不含钥匙位置/密码/电话等敏感值本身。
function listingViewingMethodFields(listing = {}) {
  const method = effectiveViewingMethod(listing)
  return {
    viewingMethod: method,
    viewingMethodText: method || VIEWING_METHOD_LANDLORD
  }
}

function listingViewingKeyLocation(listing = {}) {
  return firstText(listing.viewingKeyLocation, listing.keyLocation)
}

const DEFAULT_LANDLORD_COMMISSION_PERCENT = 50
const MAX_LISTING_REMARK_LENGTH = 200

function normalizeListingRemark(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function listingRemarkContainsContact(value) {
  const text = normalizeListingRemark(value).normalize('NFKC')
  if (!text) return false
  const compact = text.replace(/[\s\-—_()（）+.,，:：]/g, '')
  if (/1[3-9]\d{9}/.test(compact)) return true
  return /微信|微\s*信|wei\s*xin|we\s*chat|二维码|https?:\/\/|www\.|(?:^|[^a-z0-9])(?:wx|vx|v信|微号)(?:\s*[:：号]?)/i.test(text)
}

function safePublicListingRemark(listing = {}) {
  const remark = normalizeListingRemark(firstText(listing.remark, listing.note, listing.memo))
  if (!remark || Array.from(remark).length > MAX_LISTING_REMARK_LENGTH || listingRemarkContainsContact(remark)) return ''
  return remark
}

function storedLandlordCommissionPercent(listing = {}) {
  const raw = listing.landlordCommissionPercent
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_LANDLORD_COMMISSION_PERCENT
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_LANDLORD_COMMISSION_PERCENT
}

function companyPublicListingFields(listing = {}) {
  if (!isCompanyListing(listing)) return {}
  const location = listingLocationFields(listing)
  const companyPhones = ((config.company && config.company.contactPhones) || [])
    .map((item) => String(item || '').trim())
    .filter((item) => /^1[3-9]\d{9}$/.test(item))
  const contact = companyPhones[0] || ''
  const viewingPassword = firstText(listing.viewingPassword, listing.showingPassword, listing.password)
  const remark = safePublicListingRemark(listing)
  const room = firstText(listing.roomAddress, location.roomAddress)
  const address = firstText(listing.address, [location.city, location.area, location.community, room].filter(Boolean).join(''))
  return {
    building: location.building,
    unit: location.unit,
    roomNumber: location.roomNumber,
    roomAddress: room,
    address,
    contact,
    landlordPhone: contact,
    companyContactPhones: companyPhones,
    companyContactPhoneText: contact,
    viewingPassword,
    showingPassword: viewingPassword,
    viewingKeyLocation: listingViewingKeyLocation(listing),
    remark
  }
}

function publicListingTitle(listing = {}, location = publicListingLocationFields(listing)) {
  const community = location.community || listing.community || ''
  if (community) return community
  return `${location.area || '房源'}${listing.layout ? ` · ${listing.layout}` : ''}`
}

function publicLocationSearchText(listing = {}) {
  return [
    listing.city,
    listing.district,
    listing.area,
    listing.block,
    listing.community
  ].map((item) => String(item || '')).join('')
}

function hasAnyOwn(source = {}, fields = []) {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(source, field))
}

function firstOwnValue(source = {}, fields = []) {
  const field = fields.find((item) => Object.prototype.hasOwnProperty.call(source, item))
  return field ? source[field] : undefined
}

function normalizeListingForm(form = {}, current = {}, options = {}) {
  const locationFields = [
    'city',
    'district',
    'area',
    'block',
    'communityName',
    'community',
    'building',
    'buildingNo',
    'buildingNumber',
    'unit',
    'unitNo',
    'unitNumber',
    'roomNumber',
    'roomNo',
    'houseNo',
    'doorNo'
  ]
  const layoutFields = [
    'layout',
    'rentMode',
    'type',
    'room',
    'bedroom',
    'bedrooms',
    'hall',
    'livingRoom',
    'livingRooms',
    'bath',
    'bathroom',
    'bathrooms'
  ]
  const hasLocationInput = hasAnyOwn(form, locationFields)
  const hasLayoutInput = hasAnyOwn(form, layoutFields)
  const city = firstText(form.city, current.city, '杭州')
  const area = normalizeDistrict(firstText(form.district, form.area, current.district, current.area, guessArea(form.address || current.address)))
  const block = firstText(form.block, current.block, area)
  const rawCommunity = firstText(form.communityName, form.community, current.community)
  const community = rawCommunity || '待补充'
  const building = firstText(form.building, form.buildingNo, form.buildingNumber, current.building)
  const unit = firstText(form.unit, form.unitNo, form.unitNumber, current.unit)
  const roomNumber = firstText(form.roomNumber, form.roomNo, form.houseNo, form.doorNo, current.roomNumber)
  const rentMode = firstText(form.rentMode, form.type, current.rentMode, current.type, '整租')
  const room = firstText(form.room, form.bedroom, form.bedrooms, current.room)
  const hall = firstText(form.hall, form.livingRoom, form.livingRooms, current.hall)
  const bath = firstText(form.bath, form.bathroom, form.bathrooms, current.bath)
  const builtAddress = buildStructuredAddress({ city, area, community, building, unit, roomNumber })
  const builtLayout = buildLayoutFromFields({ rentMode, room, hall, bath })
  const address = firstText(form.address, hasLocationInput ? builtAddress : '', current.address, builtAddress)
  const layout = firstText(form.layout, hasLayoutInput ? builtLayout : '', current.layout, builtLayout)
  const contactInput = firstOwnValue(form, ['contact', 'landlordPhone'])
  // 普通编辑显式空值仍沿用旧号码，避免误清敏感联系方式；只有飞书内部缺号同步需要把
  // 已有非法占位值真正清空，否则 firstText 会回退到旧非法值并再次触发 400、冻结库存更新。
  const contact = options.allowMissingLandlordPhone && contactInput !== undefined
    ? String(contactInput === null || contactInput === undefined ? '' : contactInput).trim()
    : firstText(form.contact, form.landlordPhone, current.landlordPhone)
  const remarkInput = firstOwnValue(form, ['remark', 'note', 'memo'])
  const remark = remarkInput !== undefined
    ? normalizeListingRemark(remarkInput)
    : normalizeListingRemark(firstText(current.remark, current.note, current.memo))
  const landlordCommissionInput = firstOwnValue(form, ['landlordCommissionPercent'])
  const currentLandlordCommissionInput = firstOwnValue(current, ['landlordCommissionPercent'])
  const rawLandlordCommissionPercent = landlordCommissionInput !== undefined
    ? landlordCommissionInput
    : (currentLandlordCommissionInput !== undefined ? currentLandlordCommissionInput : DEFAULT_LANDLORD_COMMISSION_PERCENT)
  const landlordCommissionText = String(rawLandlordCommissionPercent === null || rawLandlordCommissionPercent === undefined ? '' : rawLandlordCommissionPercent).trim()
  const landlordCommissionInputTypeValid = typeof rawLandlordCommissionPercent === 'number' || typeof rawLandlordCommissionPercent === 'string'
  const landlordCommissionFormatValid = typeof rawLandlordCommissionPercent === 'number'
    ? Number.isInteger(rawLandlordCommissionPercent)
    : /^\d+$/.test(landlordCommissionText)
  const landlordCommissionPercent = landlordCommissionInputTypeValid && landlordCommissionFormatValid
    ? Number(landlordCommissionText)
    : Number.NaN
  const rent = firstText(form.rent, current.rent)
  const videoUrl = firstText(form.videoUrl, current.videoUrl)
  const videoKey = firstText(form.videoKey, current.videoKey)
  // 看房密码显式传空串表示清空，不传才沿用现值
  const viewingPasswordInput = firstOwnValue(form, ['viewingPassword', 'showingPassword'])
  const viewingPassword = viewingPasswordInput !== undefined
    ? String(viewingPasswordInput || '').trim()
    : firstText(current.viewingPassword, current.showingPassword)
  // 看房方式与钥匙位置同密码语义：显式传空串表示清空，不传才沿用现值
  const viewingMethodInput = firstOwnValue(form, ['viewingMethod', 'showingMethod'])
  let viewingMethod
  if (viewingMethodInput !== undefined) {
    const rawViewingMethod = String(viewingMethodInput === null || viewingMethodInput === undefined ? '' : viewingMethodInput).trim()
    viewingMethod = normalizeViewingMethod(rawViewingMethod)
    // 显式提交了非空但不在枚举/兼容别名内的方式：直接拒绝，不得静默归一成"未指定"混过条件校验
    if (rawViewingMethod && !viewingMethod) {
      const error = new Error('看房方式只能是钥匙、密码或联系房东')
      error.statusCode = 400
      throw error
    }
  } else {
    viewingMethod = normalizeViewingMethod(firstText(current.viewingMethod, current.showingMethod))
  }
  const viewingKeyLocationInput = firstOwnValue(form, ['viewingKeyLocation', 'keyLocation'])
  const viewingKeyLocation = viewingKeyLocationInput !== undefined
    ? String(viewingKeyLocationInput || '').trim()
    : firstText(current.viewingKeyLocation, current.keyLocation)
  // 调用方（如飞书同步、旧后台）只清空密码/钥匙位置而不带看房方式时，沿用的旧方式随之退掉，
  // 否则「方式=密码但密码已被清空」会把第三方全量更新卡成 400（回归：飞书表清空密码列 → 整行同步失败）
  if (viewingMethodInput === undefined) {
    if (viewingMethod === VIEWING_METHOD_PASSWORD && viewingPasswordInput !== undefined && !viewingPassword) viewingMethod = ''
    if (viewingMethod === VIEWING_METHOD_KEY && viewingKeyLocationInput !== undefined && !viewingKeyLocation) viewingMethod = ''
  }
  const companyFlagInput = firstOwnValue(form, ['companyListing', 'isCompanyListing', 'companyOwned'])
  const ownerTypeInput = firstText(form.ownerType, form.houseSourceType, form.landlordType, current.ownerType, current.houseSourceType)
  const normalizedOwnerType = normalizeOwnerType(ownerTypeInput, current.ownerType || SECOND_LANDLORD_SOURCE)
  const sourceInput = firstText(form.source, form.sourceType, form.listingType, form.inventoryType)
  const nonCompanySourceInput = sourceInput && !/公司房源|company/.test(sourceInput) ? sourceInput : ''
  const currentCompany = isCompanyListing(current)
  const companyListing = companyFlagInput !== undefined
    ? truthyFlag(companyFlagInput)
    : (sourceInput ? /公司房源|company/.test(sourceInput) : currentCompany)
  const ownerType = companyListing ? COMPANY_SOURCE : normalizedOwnerType
  const featureFields = ['features', 'featureTags', 'tags']
  const formFeatureInput = firstOwnValue(form, featureFields)
  const currentFeatureInput = firstOwnValue(current, featureFields)
  const featureInput = formFeatureInput !== undefined ? formFeatureInput : currentFeatureInput
  const explicitFeatures = normalizeListingFeatures(featureInput)
  const explicitNoFeature = formFeatureInput !== undefined &&
    explicitFeatures.length === 1 &&
    explicitFeatures[0] === NO_FEATURE
  const inferredFeatures = explicitNoFeature
    ? []
    : inferListingFeatures({
      ...current,
      ...form,
      city,
      district: area,
      area,
      community,
      address,
      layout,
      rentMode,
      type: rentMode,
      room,
      hall,
      bath,
      source: companyListing ? COMPANY_SOURCE : firstText(form.source, current.source, ownerType),
      features: featureInput
    }).filter((item) => PERSISTABLE_INFERRED_FEATURES.has(item))
  const mergedFeatureInput = explicitNoFeature
    ? explicitFeatures
    : uniqueTextList(explicitFeatures.filter((item) => item !== NO_FEATURE).concat(inferredFeatures))
  const explicitFeatureInputCount = parseFeatureInput(featureInput).filter((item) => item !== NO_COMMISSION_FEATURE).length
  const mergedFeatureInputCount = mergedFeatureInput.filter((item) => item !== NO_FEATURE && item !== NO_COMMISSION_FEATURE).length
  const featureInputCount = Math.max(explicitFeatureInputCount, mergedFeatureInputCount)
  const invalidFeatures = invalidListingFeatures(featureInput)
  const noCommission = companyListing
  const rate = noCommission ? 0 : commissionRateByOwnerType(ownerType, options.db || {})
  const features = featuresWithCompanyDefaults(mergedFeatureInput.length ? mergedFeatureInput : featureInput, {
    commissionRate: rate,
    companyListing,
    noCommission
  }).filter((item) => noCommission || item !== NO_COMMISSION_FEATURE)
  const communityMatchedInput = firstOwnValue(form, ['communityMatched', 'isCommunityMatched'])
  const manualReviewInput = firstOwnValue(form, ['requiresManualReview', 'manualReviewRequired'])
  const formMatchStatus = firstText(form.communityMatchStatus)
  const isAdminCaller = Boolean(options.admin || (options.user && options.user.isAdmin))
  const currentCommunityMatched = current.communityMatched !== undefined
    ? truthyFlag(current.communityMatched)
    : (current.communityMatchStatus ? current.communityMatchStatus !== '未匹配' : true)
  // 服务端复核：小区名未变更时沿用历史判定（兼容飞书导入等历史房源）
  const communityUnchanged = normalizeCommunityKey(community) === normalizeCommunityKey(current.community)
  const serverKnownCommunity = isKnownCommunity(community)
  const grandfatheredMatched = communityUnchanged && currentCommunityMatched
  const explicitMatchedClaim = communityMatchedInput !== undefined
  const clientClaimsUnmatched = (explicitMatchedClaim && !truthyFlag(communityMatchedInput)) || formMatchStatus === '未匹配'
  const clientClaimsMatched = (explicitMatchedClaim && truthyFlag(communityMatchedInput)) || (Boolean(formMatchStatus) && formMatchStatus !== '未匹配')
  let communityMatched
  if (clientClaimsUnmatched) {
    // 客户端主动申报未匹配：采纳（只允许收紧）
    communityMatched = false
  } else if (serverKnownCommunity) {
    // 命中服务端小区库：以服务端为准
    communityMatched = true
  } else if (clientClaimsMatched) {
    // 库外小区却声明“已匹配”：不采信，仅在小区名未变且历史已匹配时沿用
    communityMatched = grandfatheredMatched
  } else {
    // 无任何声明：以服务端小区库为权威。命中库即已匹配；
    // 编辑且小区名未变时沿用历史判定（兼容飞书导入存量）；
    // 其余（含新建库外小区）一律未匹配，进入人工审核后才能上架
    communityMatched = serverKnownCommunity || grandfatheredMatched
  }
  const hasCommunityReviewInput = explicitMatchedClaim || manualReviewInput !== undefined || Object.prototype.hasOwnProperty.call(form, 'communityMatchStatus')
  let requiresManualReview
  if (manualReviewInput !== undefined) {
    const requestedReview = truthyFlag(manualReviewInput)
    // 申请进入审核任何人可以；显式豁免审核只有管理员生效
    requiresManualReview = requestedReview
      ? true
      : (isAdminCaller ? false : (!communityMatched || truthyFlag(current.requiresManualReview)))
  } else if (hasCommunityReviewInput) {
    requiresManualReview = !communityMatched
  } else {
    requiresManualReview = !communityMatched ? true : truthyFlag(current.requiresManualReview)
  }
  const manualReviewReasonInput = firstText(form.manualReviewReason, current.manualReviewReason)
  const manualReviewReason = requiresManualReview
    ? (manualReviewReasonInput || (!communityMatched ? '小区名称未匹配小区库' : '房源信息需人工审核'))
    : ''

  return {
    city,
    area,
    block,
    rawCommunity,
    community,
    building,
    unit,
    roomNumber,
    rentMode,
    room,
    hall,
    bath,
    address,
    layout,
    contact,
    remark,
    validateRemark: remarkInput !== undefined || !current.id,
    landlordCommissionPercent,
    rent: Number(rent),
    videoUrl,
    videoKey,
    viewingPassword,
    viewingMethod,
    viewingKeyLocation,
    commissionRate: rate,
    features,
    hasFeatureInput: featureInputCount > 0 || noCommission,
    invalidFeatures,
    companyListing,
    ownerType,
    noCommission,
    communityMatched,
    communityMatchStatus: communityMatched ? '已匹配' : '未匹配',
    requiresManualReview,
    manualReviewReason,
    source: companyListing ? COMPANY_SOURCE : (nonCompanySourceInput || (currentCompany ? ownerType : (current.source || ownerType || '普通上传')))
  }
}

function setCommissionConfig(db = {}, adminId = '', payload = {}) {
  const current = commissionConfig(db)
  const upRates = payload.uploaderRates || {}
  const platRates = payload.platformRates || {}
  const secondLandlordRate = boundedRate(payload.secondLandlordRate ?? payload.secondLandlordUploaderRate ?? upRates[SECOND_LANDLORD_SOURCE], current.secondLandlordRate)
  const ownerRate = boundedRate(payload.ownerRate ?? payload.ownerUploaderRate ?? upRates[OWNER_SOURCE], current.ownerRate)
  const secondLandlordPlatformRate = boundedRate(payload.secondLandlordPlatformRate ?? platRates[SECOND_LANDLORD_SOURCE], current.secondLandlordPlatformRate)
  const ownerPlatformRate = boundedRate(payload.ownerPlatformRate ?? platRates[OWNER_SOURCE], current.ownerPlatformRate)
  // money 守恒：同一房源类型 上传人比例 + 平台比例 不得超过 100%，否则带看成交中介净留为负、
  // confirmDeal 会超发（uploaderCommissionFen + platformCommissionFen > landlordCommissionFen）。
  // 直接 400 拒绝，不静默改用户配置（若产品要自动压缩，需第三裁判/用户确认）。
  if (secondLandlordRate + secondLandlordPlatformRate > MAX_COMMISSION_RATE) {
    const error = new Error('二房东房源：上传人比例 + 平台比例不得超过 100%')
    error.statusCode = 400
    throw error
  }
  if (ownerRate + ownerPlatformRate > MAX_COMMISSION_RATE) {
    const error = new Error('业主房源：上传人比例 + 平台比例不得超过 100%')
    error.statusCode = 400
    throw error
  }
  const now = nowText()
  db.commissionConfig = {
    uploaderRates: {
      [SECOND_LANDLORD_SOURCE]: secondLandlordRate,
      [OWNER_SOURCE]: ownerRate,
      [COMPANY_SOURCE]: 0
    },
    platformRates: {
      [SECOND_LANDLORD_SOURCE]: secondLandlordPlatformRate,
      [OWNER_SOURCE]: ownerPlatformRate,
      [COMPANY_SOURCE]: 0
    },
    secondLandlordRate,
    ownerRate,
    companyRate: 0,
    secondLandlordPlatformRate,
    ownerPlatformRate,
    totalRate: TOTAL_DEAL_COMMISSION_RATE,
    updatedAt: now,
    updatedBy: adminId || 'admin'
  }
  pushFootprint(db, {
    id: id('F'),
    viewerId: adminId || 'admin',
    action: '调整分佣配置',
    time: now,
    sync: `业主上传人 ${ownerRate}%+平台 ${ownerPlatformRate}%，二房东上传人 ${secondLandlordRate}%+平台 ${secondLandlordPlatformRate}%，公司房源不抽佣`
  })
  return commissionConfig(db)
}

function validateListingFields(fields, user = {}, options = {}) {
  if (
    !fields.address ||
    !fields.rent ||
    !fields.layout ||
    !fields.rawCommunity ||
    !fields.building ||
    !fields.roomNumber
  ) {
    const error = new Error('城市、区域、小区、几栋、房间号、租金和户型必填')
    error.statusCode = 400
    throw error
  }
  // 房东手机号对所有客户端上传/编辑、后台人工上传/编辑及所有看房方式均为必填。
  // 唯一例外是服务端内部飞书公司库存同步：历史表可能暂缺电话，但公开租金/房态不能因此冻结。
  // 该例外必须同时具备 admin + 显式内部开关 + 公司房源三项，路由客户端无法提交 options。
  const allowMissingCompanyLandlordPhone = Boolean(
    options.admin && options.allowMissingLandlordPhone && fields.companyListing
  )
  if (!fields.contact && !allowMissingCompanyLandlordPhone) {
    const error = new Error('请填写房东手机号')
    error.statusCode = 400
    throw error
  }
  if (fields.contact && !/^1[3-9]\d{9}$/.test(fields.contact)) {
    const error = new Error('请输入 11 位房东手机号')
    error.statusCode = 400
    throw error
  }
  if (fields.viewingMethod === VIEWING_METHOD_KEY && !fields.viewingKeyLocation) {
    const error = new Error('看房方式为钥匙时，请填写钥匙在哪')
    error.statusCode = 400
    throw error
  }
  if (fields.viewingMethod === VIEWING_METHOD_PASSWORD && !fields.viewingPassword) {
    const error = new Error('看房方式为密码时，请填写看房密码')
    error.statusCode = 400
    throw error
  }
  if (fields.validateRemark && Array.from(fields.remark || '').length > MAX_LISTING_REMARK_LENGTH) {
    const error = new Error('房源备注最多 200 字')
    error.statusCode = 400
    throw error
  }
  if (fields.validateRemark && listingRemarkContainsContact(fields.remark)) {
    const error = new Error('房源备注不能包含手机号、微信号等联系方式')
    error.statusCode = 400
    throw error
  }
  if (!Number.isInteger(fields.landlordCommissionPercent) || fields.landlordCommissionPercent < 0 || fields.landlordCommissionPercent > 100) {
    const error = new Error('房东佣金占月租比例必须是 0 至 100 的整数')
    error.statusCode = 400
    throw error
  }
  if (requiresListingVideo(fields) && !hasListingVideo(fields)) {
    const error = new Error('二房东房源和业主房源必须上传真实视频，公司房源可不上传视频')
    error.statusCode = 400
    throw error
  }
  if (!Number.isFinite(fields.rent) || fields.rent <= 0) {
    const error = new Error('租金必须是有效数字')
    error.statusCode = 400
    throw error
  }
  // fields.commissionRate 现在代表"上传人比例"（后端按配置+房源类型派生），按单档上限 0..100 校验，
  // 不再拿默认总分出比例（30）卡死——否则后台把上传人比例配到 30% 以上就无法上传/编辑房源。
  if (!Number.isFinite(fields.commissionRate) || fields.commissionRate < 0 || fields.commissionRate > MAX_COMMISSION_RATE) {
    const error = new Error('分佣规则由后端按当前配置和房源类型派生，公司房源不分佣')
    error.statusCode = 400
    throw error
  }
  if (!fields.hasFeatureInput) {
    const error = new Error('请选择房源特点标签，若没有特点请选择“无”')
    error.statusCode = 400
    throw error
  }
  if (fields.invalidFeatures && fields.invalidFeatures.length) {
    const error = new Error(`房源特点标签无效：${fields.invalidFeatures.join('、')}`)
    error.statusCode = 400
    throw error
  }
  if (fields.companyListing && !options.admin && !user.isAdmin) {
    const error = new Error('只有管理员可以上传或标记公司房源')
    error.statusCode = 403
    throw error
  }
}

function duplicateListingValue(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase()
}

function duplicateListingPhone(value) {
  return String(value || '').replace(/\D/g, '')
}

function duplicateListingKey(fields = {}) {
  return [
    // 公司房源与合作房源分池判重：飞书公司房源电话是「公司统一维护」占位（无数字），
    // 若不分池，无手机号的钥匙/密码合作房源会与同房间公司房源互撞 409
    isCompanyListing(fields) ? '公司' : '合作',
    duplicateListingValue(fields.community),
    duplicateListingValue(fields.building),
    duplicateListingValue(fields.unit),
    duplicateListingValue(fields.roomNumber),
    duplicateListingPhone(fields.contact || fields.landlordPhone)
  ].join('|')
}

function assertNoDuplicateActiveListing(db, fields, currentListingId = '') {
  const targetKey = duplicateListingKey(fields)
  const duplicate = activeListings(db).find((listing) => (
    listing.id !== currentListingId &&
    duplicateListingKey(listing) === targetKey
  ))
  if (!duplicate) return
  const phoneDigits = duplicateListingPhone(fields.contact)
  const error = new Error(phoneDigits
    ? `已存在同一小区、楼栋、单元、房号和房东手机号的有效房源，请勿重复上传（房东手机号 ${maskPhone(fields.contact)}）`
    : '已存在同一小区、楼栋、单元、房号的有效房源，请勿重复上传')
  error.statusCode = 409
  throw error
}

function addNormalListing(db, userId, form = {}, options = {}) {
  const user = assertKnownUser(db, userId)
  const fields = normalizeListingForm(form, {}, {
    admin: options.admin,
    allowMissingLandlordPhone: options.allowMissingLandlordPhone,
    user,
    db
  })
  validateListingFields(fields, user, options)
  assertNoDuplicateActiveListing(db, fields)

  const listingId = id('L')
  const staffAutoApproved = shouldAutoApproveStaffListing(user, fields)
  const needsReview = !staffAutoApproved && (fields.ownerType === OWNER_SOURCE || fields.requiresManualReview)
  const mapCoordinate = listingMapCoordinateFields(fields, form, {}, options)
  const createdAt = nowText()
  const listing = {
    id: listingId,
    title: `${fields.address} · ${fields.layout}`,
    shortTitle: fields.community || fields.address,
    uploaderId: userId,
    rent: fields.rent,
    layout: fields.layout,
    city: fields.city,
    district: fields.area,
    area: fields.area,
    block: fields.block || fields.area || '待板块',
    community: fields.community,
    building: fields.building,
    unit: fields.unit,
    roomNumber: fields.roomNumber,
    address: fields.address,
    landlordPhone: fields.contact,
    remark: fields.remark,
    landlordCommissionPercent: fields.landlordCommissionPercent,
    viewingMethod: fields.viewingMethod,
    viewingKeyLocation: fields.viewingKeyLocation,
    viewingPassword: fields.viewingPassword,
    showingPassword: fields.viewingPassword,
    commissionRate: fields.commissionRate,
    videoLabel: '新上传房源视频',
    videoUrl: fields.videoUrl,
    videoKey: fields.videoKey || '',
    status: needsReview ? '待审核' : '待确认',
    reviewStatus: needsReview ? '待审核' : '无需审核',
    communityMatched: fields.communityMatched,
    communityMatchStatus: fields.communityMatchStatus,
    requiresManualReview: fields.requiresManualReview,
    manualReviewReason: fields.manualReviewReason,
    lifecycleStatus: 'active',
    ownerType: fields.ownerType,
    houseSourceType: fields.ownerType,
    type: fields.rentMode,
    rentMode: fields.rentMode,
    room: fields.room,
    hall: fields.hall,
    bath: fields.bath,
    features: fields.features,
    source: fields.source,
    companyListing: fields.companyListing,
    isCompanyListing: fields.companyListing,
    noCommission: fields.noCommission,
    sensitiveViews: 0,
    mapLeft: 50,
    mapTop: 50,
    mapLatitude: mapCoordinate.mapLatitude,
    mapLongitude: mapCoordinate.mapLongitude,
    coordinateSource: mapCoordinate.coordinateSource,
    coordinateVerified: mapCoordinate.coordinateVerified,
    coordinateLevel: mapCoordinate.coordinateLevel,
    coordinateAccuracy: mapCoordinate.coordinateAccuracy,
    coordinateStatus: mapCoordinate.coordinateStatus,
    createdAt,
    lastVerifiedAt: createdAt
  }
  if (staffAutoApproved) applyStaffListingAutoApproval(listing, userId, createdAt)

  db.listings = db.listings || []
  db.pointLogs = db.pointLogs || []
  db.listings.unshift(listing)
  syncListingRecommendationProfile(listing, needsReview ? 'pending_review' : '')
  if (!options.skipPointLog) {
    db.pointLogs.unshift({
      id: id('P'),
      userId,
      type: '普通上传',
      change: 0,
      note: '普通房源上传不加积分',
      time: '刚刚'
    })
  }
  return editableListingDetail(db, userId, listingId, { admin: true })
}

function editableListingDetail(db, userId, listingId, options = {}) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  // 管理员在编辑中把房源下架后仍需要拿到回包，此时跳过在架校验
  if (!options.includeExpired) assertListingActive(listing)
  const user = userById(db, userId) || {}
  if (!options.admin && listing.uploaderId !== userId && !user.isAdmin) {
    const error = new Error('只能修改自己上传的房源')
    error.statusCode = 403
    throw error
  }
  const location = listingLocationFields(listing)
  const display = listingDisplayFields(listing, db)
  return {
    id: listing.id,
    title: listing.title,
    rent: String(listing.rent || ''),
    layout: listing.layout || '',
    ...location,
    address: listing.address || '',
    contact: listing.landlordPhone || '',
    landlordPhone: listing.landlordPhone || '',
    remark: safePublicListingRemark(listing),
    landlordCommissionPercent: storedLandlordCommissionPercent(listing),
    commissionRate: listing.commissionRate,
    videoLabel: listing.videoLabel || '房源实拍视频',
    videoUrl: listing.videoUrl || '',
    videoKey: listing.videoKey || '',
    viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
    ...listingViewingMethodFields(listing),
    viewingKeyLocation: listingViewingKeyLocation(listing),
    status: listing.status || '',
    reviewStatus: listing.reviewStatus || '',
    communityMatched: listing.communityMatched !== undefined ? truthyFlag(listing.communityMatched) : listing.communityMatchStatus !== '未匹配',
    communityMatchStatus: listing.communityMatchStatus || (listing.communityMatched === false ? '未匹配' : '已匹配'),
    requiresManualReview: truthyFlag(listing.requiresManualReview),
    manualReviewReason: listing.manualReviewReason || '',
    type: listing.type || listing.rentMode || '',
    rentMode: listing.rentMode || listing.type || '',
    room: listing.room || '',
    hall: listing.hall || '',
    bath: listing.bath || '',
    ...display
  }
}

// 管理员编辑弹窗允许直接调整的状态；审核（待审核/已驳回）与成交（签单/成交）必须走各自流程
const ADMIN_EDIT_STATUS_OPTIONS = ['在租', '待确认', '已下架']

function updateNormalListing(db, userId, listingId, form = {}, options = {}) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertListingActive(listing)
  const user = userById(db, userId) || {}
  if (!options.admin && listing.uploaderId !== userId && !user.isAdmin) {
    const error = new Error('只能修改自己上传的房源')
    error.statusCode = 403
    throw error
  }

  const fields = normalizeListingForm(form, listing, {
    admin: options.admin,
    allowMissingLandlordPhone: options.allowMissingLandlordPhone,
    user,
    db
  })
  validateListingFields(fields, user, options)
  assertNoDuplicateActiveListing(db, fields, listingId)
  const mapCoordinate = listingMapCoordinateFields(fields, form, listing, options)

  // 状态编辑仅管理员可用，且只收敛到安全状态：
  // 上/下架走既有生命周期语义（下架进资产池可恢复），审核、成交状态必须走对应流程，不能在编辑里绕过护栏
  const statusBeforeEdit = String(listing.status || '')
  const requestedStatus = options.admin ? firstText(form.status) : ''
  const statusChangeRequested = Boolean(requestedStatus) && requestedStatus !== statusBeforeEdit
  if (statusChangeRequested) {
    if (ADMIN_EDIT_STATUS_OPTIONS.indexOf(requestedStatus) === -1) {
      const error = new Error('状态只能调整为在租、待确认或已下架；审核请走房源审核操作，成交请走签单流程')
      error.statusCode = 400
      throw error
    }
    if (isSoldListing(listing)) {
      const error = new Error('已签单/成交房源不能在编辑中调整状态，请走签单与成交流程处理')
      error.statusCode = 400
      throw error
    }
    const keepApproved = listing.reviewStatus === '已通过' && options.admin && !fields.requiresManualReview
    const willPendReview = (fields.ownerType === OWNER_SOURCE || fields.requiresManualReview) && !keepApproved
    if (willPendReview && requestedStatus !== '已下架') {
      const error = new Error('该房源需先通过人工审核，审核通过后才能调整为在租或待确认')
      error.statusCode = 400
      throw error
    }
  }

  listing.title = `${fields.address} · ${fields.layout}`
  listing.shortTitle = fields.community || fields.address
  listing.rent = fields.rent
  listing.layout = fields.layout
  listing.city = fields.city
  listing.district = fields.area
  listing.area = fields.area
  listing.block = fields.block || fields.area || '待板块'
  listing.community = fields.community
  listing.building = fields.building
  listing.unit = fields.unit
  listing.roomNumber = fields.roomNumber
  listing.address = fields.address
  listing.landlordPhone = fields.contact
  listing.remark = fields.remark
  listing.landlordCommissionPercent = fields.landlordCommissionPercent
  listing.commissionRate = fields.commissionRate
  listing.videoUrl = fields.videoUrl
  listing.videoKey = fields.videoKey || ''
  listing.viewingPassword = fields.viewingPassword
  listing.showingPassword = fields.viewingPassword
  listing.viewingMethod = fields.viewingMethod
  listing.viewingKeyLocation = fields.viewingKeyLocation
  listing.ownerType = fields.ownerType
  listing.houseSourceType = fields.ownerType
  listing.type = fields.rentMode
  listing.rentMode = fields.rentMode
  listing.room = fields.room
  listing.hall = fields.hall
  listing.bath = fields.bath
  listing.features = fields.features
  listing.source = fields.source
  listing.companyListing = fields.companyListing
  listing.isCompanyListing = fields.companyListing
  if (!fields.companyListing) {
    delete listing.sourceType
    delete listing.listingType
    delete listing.inventoryType
    delete listing.companyOwned
  }
  listing.noCommission = fields.noCommission
  listing.communityMatched = fields.communityMatched
  listing.communityMatchStatus = fields.communityMatchStatus
  listing.requiresManualReview = fields.requiresManualReview
  listing.manualReviewReason = fields.manualReviewReason
  listing.mapLatitude = mapCoordinate.mapLatitude
  listing.mapLongitude = mapCoordinate.mapLongitude
  listing.coordinateSource = mapCoordinate.coordinateSource
  listing.coordinateVerified = mapCoordinate.coordinateVerified
  listing.coordinateLevel = mapCoordinate.coordinateLevel
  listing.coordinateAccuracy = mapCoordinate.coordinateAccuracy
  listing.coordinateStatus = mapCoordinate.coordinateStatus
  const staffAutoApproved = shouldAutoApproveStaffListing(user, fields)
  const preserveStaffAutoApproval = Boolean(options.admin) && isStaffAutoApprovedListing(listing) && !fields.companyListing
  const autoApproved = staffAutoApproved || preserveStaffAutoApproval
  const needsReview = !autoApproved && (fields.ownerType === OWNER_SOURCE || fields.requiresManualReview)
  if (autoApproved) {
    if (staffAutoApproved) applyStaffListingAutoApproval(listing, userId)
    listing.reviewStatus = '已通过'
    if (listing.status === '待审核' || listing.status === '已驳回') listing.status = '待确认'
  } else if (needsReview) {
    clearStaffListingAutoApproval(listing)
    listing.reviewStatus = listing.reviewStatus === '已通过' && options.admin && !fields.requiresManualReview ? '已通过' : '待审核'
    if (listing.reviewStatus !== '已通过') listing.status = '待审核'
  } else {
    clearStaffListingAutoApproval(listing)
    listing.reviewStatus = '无需审核'
    if (listing.status === '待审核' || listing.status === '已驳回') listing.status = '待确认'
  }
  listing.updatedAt = nowText()
  syncListingRecommendationProfile(listing, needsReview && listing.reviewStatus !== '已通过' ? 'pending_review' : '')

  if (statusChangeRequested) {
    if (requestedStatus === '已下架') {
      expireListing(db, listing, firstText(form.statusReason, '管理员编辑房源时手动下架'), { by: userId, action: '管理员下架' })
    } else if (listing.status !== '待审核') {
      listing.status = requestedStatus
      if (requestedStatus === '在租') {
        listing.lifecycleStatus = 'active'
        listing.lastVerifiedAt = nowText()
      }
      syncListingRecommendationProfile(listing)
      pushFootprint(db, {
        id: id('F'),
        listingId,
        viewerId: userId,
        action: '管理员调整状态',
        time: nowText(),
        sync: `状态由「${statusBeforeEdit || '未知'}」调整为「${requestedStatus}」`
      })
    }
  }

  return editableListingDetail(db, userId, listingId, { admin: true, includeExpired: true })
}

function reviewOwnerListing(db, adminId, listingId, payload = {}) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  if (!requiresListingReview(listing)) {
    const error = new Error('只有业主房源或小区未匹配房源需要审核')
    error.statusCode = 400
    throw error
  }
  const approved = payload.action === 'approve' || payload.status === '已通过'
  listing.reviewStatus = approved ? '已通过' : '已驳回'
  listing.status = approved ? '待确认' : '已驳回'
  listing.reviewedAt = nowText()
  listing.reviewerId = adminId || 'admin'
  listing.reviewNote = payload.note || (approved ? '管理员审核通过，已上架' : '管理员审核驳回，暂不上架')
  if (approved) applyCommunityMapCoordinate(listing)
  listing.updatedAt = listing.reviewedAt
  if (approved) {
    syncListingRecommendationProfile(listing)
  } else {
    clearListingRecommendationProfile(listing, 'review_rejected')
  }
  return adminListings(db)
}

function verifyListingAvailability(db, userId, listingId, options = {}) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertListingActive(listing)

  const user = userById(db, userId) || {}
  if (!options.admin && listing.uploaderId !== userId && !user.isAdmin) {
    const error = new Error('只能核验自己上传的房源')
    error.statusCode = 403
    throw error
  }

  if (!options.admin) assertClientFootprintRateLimit(db, userId, 'listing_verified')

  listing.status = options.status || '在租'
  listing.lifecycleStatus = 'active'
  listing.lastVerifiedAt = nowText()
  listing.updatedAt = listing.lastVerifiedAt
  syncListingRecommendationProfile(listing)
  pushFootprint(db, {
    id: id('F'),
    listingId,
    viewerId: userId,
    action: '房态核验',
    time: '刚刚',
    sync: options.admin ? '管理员已核验房态' : '上传人已核验房态'
  })
  return listingFreshness(listing)
}

// 电话确认房态三选项：未出租=已维护（verifyListingAvailability 重置核验周期）；
// 已出租/不租了=自动下架进后台资产池（expireListing，下架原因分开记，管理员可恢复）。
function submitListingVerification(db, userId, listingId, outcome, options = {}) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  const user = userById(db, userId) || {}
  const isOwnerOrAdmin = options.admin || listing.uploaderId === userId || user.isAdmin
  if (!isOwnerOrAdmin) {
    const error = new Error('只能核验自己上传的房源')
    error.statusCode = 403
    throw error
  }
  const normalized = String(outcome == null ? '' : outcome).trim()
  // 未出租 / available（含缺省，兼容旧客户端只点确认）→ 已维护，重置核验周期。
  if (normalized === '' || normalized === '未出租' || normalized === 'available') {
    return { outcome: 'available', freshness: verifyListingAvailability(db, userId, listingId, options) }
  }
  assertListingActive(listing)
  if (normalized === '已出租' || normalized === 'rented') {
    if (!options.admin) assertClientFootprintRateLimit(db, userId, 'listing_expired')
    expireListing(db, listing, '房东反馈已出租', { by: userId, action: '上传人下架·已出租' })
    return { outcome: 'rented', status: listing.status, expiredReason: listing.expiredReason }
  }
  if (normalized === '不租了' || normalized === '不租' || normalized === 'withdrawn') {
    if (!options.admin) assertClientFootprintRateLimit(db, userId, 'listing_expired')
    expireListing(db, listing, '房东反馈不租了', { by: userId, action: '上传人下架·不租了' })
    return { outcome: 'withdrawn', status: listing.status, expiredReason: listing.expiredReason }
  }
  const error = new Error('无效的房态反馈')
  error.statusCode = 400
  throw error
}

module.exports = {
  currentUser,
  loginByPhone,
  registerUser,
  createManagedUser,
  deleteManagedUser,
  logoutUserSessions,
  setManagedUserStatus,
  setManagedUserPassword,
  syncLinkedAdminUserPasswordHash,
  changeOwnPassword,
  listRegistrationRequests,
  reviewRegistration,
  beginRegistrationNotification,
  finishRegistrationNotification,
  pendingRegistrationNotificationIds,
  claimRegistrationNotifyDeadLetterAlert,
  finishRegistrationNotifyDeadLetterAlert,
  pendingRegistrationNotifyDeadLetterAlertIds,
  migrateCompanyListings,
  listingMaintenanceRule,
  setListingMaintenanceRule,
  enforceListingMaintenanceRule,
  commissionConfig,
  setCommissionConfig,
  commissionRuleForListing,
  commissionBreakdownForListing,
  commissionRateByOwnerType,
  platformRateByOwnerType,
  dashboardSummary,
  formatHomeListing,
  homeListings,
  filterListings,
  favoriteListing,
  unfavoriteListing,
  favoriteListingIds,
  favoriteListings,
  nearbyListings,
  matchListings,
  listingDetail,
  listingDetailState,
  isCompanyListing,
  isNoCommissionListing,
  listingLogs,
  recordVideoShare,
  footprintRecords,
  pruneExpiredFootprints,
  expiredFootprintCount,
  recordSystemFootprint,
  userRentalNeeds,
  createRentalNeed,
  ownedListings,
  profileState,
  todayTasks,
  groupState,
  mapCommunities,
  mapPins,
  adminListings,
  adminUsers,
  expiredListings,
  restoreExpiredListing,
  updateListingCoordinate,
  blockCenterForListing,
  adminLogs,
  userReportRows,
  adminReportRows,
  createClientReport,
  userDealRows,
  adminDealRows,
  createDealFromReport,
  confirmDeal,
  commissionRows,
  userCommissionRows,
  pointLogs,
  rechargeBills,
  groupUploadRows,
  showingUploadRows,
  reviewGroupUpload,
  reviewShowingUpload,
  reviewRechargeBill,
  createRechargeBill,
  markRechargePaid,
  syncWechatRechargeBill,
  addSensitiveFootprint,
  recordPhoneCallOpened,
  recordShowing,
  registerDeal,
  rechargePoints,
  uploadGroupListing,
  unlockGroup,
  addNormalListing,
  editableListingDetail,
  updateNormalListing,
  reviewOwnerListing,
  verifyListingAvailability,
  submitListingVerification,
  isOwnListing
}
