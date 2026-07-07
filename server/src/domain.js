const { clone } = require('./db')
const config = require('./config')
const { coordinateByCommunity } = require('./community-coordinates')
const { isKnownCommunity, normalizeCommunityKey } = require('./community-library')
const locationMap = require('./location-map')
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
// 足迹留痕保留上限：可用环境变量 FOOTPRINT_MAX_ROWS 按审计留存要求调整；生产长期运行建议迁移真实数据库
const MAX_FOOTPRINT_ROWS = Math.max(1000, Number(process.env.FOOTPRINT_MAX_ROWS) || 5000)
const SECOND_LANDLORD_COMMISSION_RATE = 15
const OWNER_COMMISSION_RATE = 20
const TOTAL_DEAL_COMMISSION_RATE = 20
const UPLOADER_COMMISSION_RATE = OWNER_COMMISSION_RATE
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
  { name: '带露台（阁楼）', pattern: /阁楼|露台|花园/ },
  { name: '近地铁', pattern: /近地铁|地铁口|地铁站|号线/ },
  { name: '朝南', pattern: /朝南|南向/ },
  { name: '独卫', pattern: /独卫|独立卫|独立卫生间|独立厨卫|独厨独卫/ },
  { name: '电梯', pattern: /电梯/ },
  { name: '采光好', pattern: /采光好|采光佳|采光很好|光线好|南北通透|通透/ },
  { name: '可短租', pattern: /可短租|短租/ },
  { name: '可月付', pattern: /可月付|月付|押一付一/ },
  { name: '首次出租', pattern: /首次出租|首租|第一次出租/ },
  { name: '民水民电', pattern: /民水民电|民水|民电/ },
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

// 统一的足迹写入入口：unshift 后按上限截断，防止 db.json 无限膨胀
function pushFootprint(db, record) {
  // 统一补 dateKey：dashboardSummary 与敏感查看额度判定均以 dateKey 为准，仅在缺失时才回退
  // 到 time 文本。历史上部分足迹（如房态核验）只写 time:'刚刚' 不写 dateKey，会被日期匹配
  // 逻辑永久判定为“今天”，导致今日统计与额度计数长期失真；写入时补当天 dateKey 从源头消除。
  const normalized = record.dateKey ? record : { ...record, dateKey: todayKey() }
  db.footprints = db.footprints || []
  db.footprints.unshift(normalized)
  if (db.footprints.length > MAX_FOOTPRINT_ROWS) {
    db.footprints = db.footprints.slice(0, MAX_FOOTPRINT_ROWS)
  }
  return normalized
}

function id(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`
}

function userById(db, userId) {
  return (db.users || []).find((user) => user.id === userId)
}

function userByPhone(db, phone) {
  const target = String(phone || '').trim()
  return (db.users || []).find((user) => String(user.phone || '') === target)
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

function isOwnerListing(listing = {}) {
  if (isCompanyListing(listing)) return false
  return [
    listing.ownerType,
    listing.houseSourceType,
    listing.source
  ].some((item) => normalizeOwnerType(item || '', '') === OWNER_SOURCE)
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

function isCompanyListing(listing = {}) {
  const sourceText = [
    listing.source,
    listing.sourceType,
    listing.listingType,
    listing.inventoryType
  ].map((item) => String(item || '')).join(' ')
  return Boolean(
    listing.companyListing ||
    listing.isCompanyListing ||
    truthyFlag(listing.companyOwned) ||
    /公司房源|company/.test(sourceText)
  )
}

function boundedRate(value, fallback, max = TOTAL_DEAL_COMMISSION_RATE) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(0, Math.round(number * 100) / 100))
}

function defaultCommissionConfig() {
  return {
    totalRate: TOTAL_DEAL_COMMISSION_RATE,
    uploaderRates: {
      [SECOND_LANDLORD_SOURCE]: SECOND_LANDLORD_COMMISSION_RATE,
      [OWNER_SOURCE]: OWNER_COMMISSION_RATE,
      [COMPANY_SOURCE]: 0
    },
    secondLandlordRate: SECOND_LANDLORD_COMMISSION_RATE,
    ownerRate: OWNER_COMMISSION_RATE,
    companyRate: 0,
    updatedAt: '',
    updatedBy: ''
  }
}

function commissionConfig(db = {}) {
  const saved = db.commissionConfig || {}
  const savedRates = saved.uploaderRates || {}
  const base = defaultCommissionConfig()
  const totalRate = TOTAL_DEAL_COMMISSION_RATE
  const secondLandlordRate = boundedRate(
    saved.secondLandlordRate ?? savedRates[SECOND_LANDLORD_SOURCE],
    base.secondLandlordRate,
    totalRate
  )
  const ownerRate = boundedRate(
    saved.ownerRate ?? savedRates[OWNER_SOURCE],
    base.ownerRate,
    totalRate
  )
  return {
    totalRate,
    uploaderRates: {
      [SECOND_LANDLORD_SOURCE]: secondLandlordRate,
      [OWNER_SOURCE]: ownerRate,
      [COMPANY_SOURCE]: 0
    },
    secondLandlordRate,
    ownerRate,
    companyRate: 0,
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

function publicCommissionTextForOwnerType(ownerType = SECOND_LANDLORD_SOURCE, db = {}) {
  const config = commissionConfig(db)
  const normalized = normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE)
  if (normalized === OWNER_SOURCE) {
    return `管理员确认签单后，上传人按房东实付佣金的 ${config.ownerRate}% 结算`
  }
  return `成交总比例按房东实付佣金的 ${config.totalRate}% 计算`
}

function uploadCommissionTextForOwnerType(ownerType = SECOND_LANDLORD_SOURCE, db = {}) {
  const config = commissionConfig(db)
  const normalized = normalizeOwnerType(ownerType, SECOND_LANDLORD_SOURCE)
  if (normalized === OWNER_SOURCE) {
    return `上传人按房东实付佣金的 ${config.ownerRate}% 结算`
  }
  return `上传人最高 ${config.secondLandlordRate}%`
}

function commissionRateForListing(listing = {}, db = {}) {
  if (isCompanyListing(listing)) return 0
  return commissionRateByOwnerType(listing.ownerType || listing.houseSourceType || listing.source || SECOND_LANDLORD_SOURCE, db)
}

function isAdminUser(user = {}) {
  return Boolean(user.isAdmin || /管理员/.test(String(user.role || '')))
}

function commissionRuleForListing(listing = {}, db = {}, uploaderId = '') {
  if (isCompanyListing(listing)) {
    return {
      rate: 0,
      uploaderRate: 0,
      platformRate: 0
    }
  }
  const uploader = userById(db, uploaderId || listing.uploaderId) || {}
  const uploaderRate = isAdminUser(uploader)
    ? 0
    : commissionRateByOwnerType(listing.ownerType || listing.houseSourceType || listing.source || SECOND_LANDLORD_SOURCE, db)
  const platformRate = Math.max(0, TOTAL_DEAL_COMMISSION_RATE - uploaderRate)
  return {
    rate: TOTAL_DEAL_COMMISSION_RATE,
    uploaderRate,
    platformRate
  }
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

function listingTextForFeatures(listing = {}) {
  return [
    listing.title,
    listing.shortTitle,
    listing.layout,
    listing.type,
    listing.rentMode,
    listing.room,
    listing.hall,
    listing.bath,
    listing.source,
    listing.status,
    listing.community,
    listing.locationSummary,
    listing.address,
    listing.description,
    listing.desc,
    listing.detail,
    listing.detailText,
    listing.remark,
    listing.note,
    listing.memo,
    listing.rawFeatures,
    listing.rawFeatureText,
    listing.featureText,
    listing.featureTags,
    listing.tags,
    listing.features,
    listing.paymentMode,
    listing.payMode
  ].map(featureSourceText).join(' ')
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

function inferListingFeatures(listing = {}) {
  const text = listingTextForFeatures(listing)
  const inferred = FEATURE_INFERENCE_RULES
    .filter((rule) => patternMatchesFeature(text, rule.pattern))
    .map((rule) => rule.name)
  if (/合租/.test(text) && inferred.indexOf('整租') !== -1) {
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
  const companyListing = isCompanyListing(listing) || listing.companyListing
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
  const companyListing = isCompanyListing(listing)
  const ownerType = companyListing
    ? COMPANY_SOURCE
    : normalizeOwnerType(listing.ownerType || listing.houseSourceType || listing.source || '', SECOND_LANDLORD_SOURCE)
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
    commissionBadge: noCommission ? '公司房源' : `${commissionRate}%`
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
  return userById(db, userId) || {}
}

function assertKnownUser(db, userId) {
  const user = userById(db, userId)
  if (user) return user
  const error = new Error('未登录或账号未开通，请先使用内部中介账号登录')
  error.statusCode = 403
  throw error
}

function loginByPhone(db, phone) {
  const target = String(phone || '').trim()
  if (!/^1\d{10}$/.test(target)) {
    const error = new Error('请输入 11 位手机号')
    error.statusCode = 400
    throw error
  }
  const user = userByPhone(db, target)
  if (!user) {
    const error = new Error('该手机号未开通内部中介账号，请联系管理员开通')
    error.statusCode = 403
    throw error
  }
  return clone(user)
}

function registerUser(db, payload = {}) {
  const name = String(payload.name || '').trim()
  const phone = String(payload.phone || '').trim()
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
  if (!/^1\d{10}$/.test(phone)) {
    const error = new Error('请输入 11 位手机号')
    error.statusCode = 400
    throw error
  }

  const existed = userByPhone(db, phone)
  if (existed) {
    return clone(existed)
  }

  const error = new Error('第一版仅支持内部邀请开通账号，请联系管理员添加中介账号')
  error.statusCode = 403
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
    todaySensitiveViews: (db.footprints || []).filter((item) => {
      if (item.action === '记录带看') return false
      if (item.dateKey) return item.dateKey === today
      return item.time === '刚刚' || String(item.time || '').indexOf(today) !== -1
    }).length,
    pendingShowingUploadCount: (db.showingUploads || []).filter((item) => item.status === '待审核').length
  }
}

function todayKey() {
  return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
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
    if (record.action === '记录带看') return
    if (record.dateKey && record.dateKey !== date) return
    if (!record.dateKey && record.time && record.time !== '刚刚' && String(record.time).indexOf(date) === -1) return
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

function assertSensitiveViewAllowed(db, userId, listing, payload = {}) {
  const viewer = userById(db, userId) || {}
  const category = sensitiveQuotaCategory(listing, userId)
  if (!isBrokerUser(viewer) && viewer.authed !== '已实名') {
    const error = new Error('查看地址和房东联系方式前需要先完成实名认证')
    error.statusCode = 403
    throw error
  }

  const purpose = normalizePurposePayload(payload)
  assertUserNeed(db, userId, purpose.needId)
  if (!purpose.purpose) {
    const error = new Error('查看房源敏感信息必须填写查看用途')
    error.statusCode = 400
    throw error
  }

  const date = todayKey()
  const alreadyViewed = (db.footprints || []).some((record) => {
    if (record.viewerId !== userId || record.listingId !== listing.id) return false
    if (record.action === '记录带看') return false
    if (record.dateKey) return record.dateKey === date
    return record.time === '刚刚' || String(record.time || '').indexOf(date) !== -1
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

function adminUsers(db) {
  return (db.users || []).map((user) => {
    const quota = brokerSensitiveUsage(db, user.id)
    return {
      ...clone(user),
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
  if (category === OWNER_SOURCE) return isOwnerListing(listing)
  if (category === COMPANY_SOURCE) return isCompanyListing(listing)
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

function buildListingDetail(db, listing) {
  const uploader = userById(db, listing.uploaderId) || {}
  const location = publicListingLocationFields(listing)
  const display = listingDisplayFields(listing, db)
  const companyPublic = companyPublicListingFields(listing)
  return {
    id: listing.id,
    title: publicListingTitle(listing, location),
    uploader: uploader.name || '未知',
    rent: String(listing.rent),
    layout: listing.layout,
    ...location,
    areaText: `${location.city} · ${location.area}`,
    address: companyPublic.address || '确认留痕后可查看',
    sensitiveLocked: !display.companyListing,
    commissionRate: display.noCommission ? 0 : commissionRateForListing(listing, db),
    commissionText: display.commissionText,
    noCommission: display.noCommission,
    companyListing: display.companyListing,
    sourceLabel: display.sourceLabel,
    videoLabel: listing.videoLabel || '房源实拍视频',
    videoUrl: listing.videoUrl || '',
    videoKey: listing.videoKey || '',
    type: listing.type || listing.rentMode || '',
    rentMode: listing.rentMode || listing.type || '',
    room: listing.room || '',
    hall: listing.hall || '',
    bath: listing.bath || '',
    status: listing.status,
    ...display,
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

function listingDetailState(db, listingId) {
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
    detail: buildListingDetail(db, listing)
  }
}

function listingDetail(db, listingId) {
  const state = listingDetailState(db, listingId)
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

function listingLogs(db, listingId, userId) {
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
    .filter((item) => item.listingId === listingId)
    .map((item) => {
      const user = userById(db, item.viewerId) || {}
      return {
        user: user.name || '未知',
        action: item.action,
        needId: item.needId || '',
        purpose: item.purpose || '',
        time: item.time
      }
    })
}

function footprintRecords(db, userId) {
  // 预建 id→实体索引，避免对每条足迹重复线性扫描 listings/users（原实现 filter+map 阶段
  // 各做一次 listingById、两次 userById，足迹量大时接近 O(n×listings)）。
  const listingsById = new Map((db.listings || []).map((listing) => [listing.id, listing]))
  const usersById = new Map((db.users || []).map((user) => [user.id, user]))
  return (db.footprints || [])
    .filter((record) => {
      const listing = listingsById.get(record.listingId) || {}
      return record.viewerId === userId || listing.uploaderId === userId
    })
    .map((record) => {
      const listing = listingsById.get(record.listingId) || {}
      const viewer = usersById.get(record.viewerId) || {}
      const uploader = usersById.get(listing.uploaderId) || {}
      const location = publicListingLocationFields(listing)
      const isMine = record.viewerId === userId
      return {
        id: record.id,
        title: publicListingTitle(listing, location) || '未知房源',
        status: record.action,
        customer: `查看人：${viewer.name || '未知'} · ${viewer.authed || '未实名'}`,
        time: record.time,
        price: listing.rent ? `¥${listing.rent}/月` : '',
        meta: `上传人：${uploader.name || '未知'} · ${record.sync}`,
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
        commissionRate: display.noCommission ? '不分佣' : `${commissionRateForListing(listing, db)}%`,
        commissionText: display.commissionText,
        noCommission: display.noCommission,
        companyListing: display.companyListing,
        sourceLabel: display.sourceLabel,
        views: `${listing.sensitiveViews || 0} 次查看敏感信息`,
        ...display
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
    sourceStats: [
      { label: '已上架', value: String(owned.length) },
      { label: '积分', value: String(points) },
      { label: '待分佣', value: String(pendingCommission) }
    ],
    reminders: [
      staleOwned.length
        ? { title: '房态核验', value: `${staleOwned.length} 套房源已到 3/5/${VERIFY_STALE_DAYS} 天电话核验提醒` }
        : { title: '房态核验', value: '你上传的房源近期已核验' },
      { title: '敏感信息查看', value: `${(db.footprints || []).filter((item) => (listingById(db, item.listingId) || {}).uploaderId === userId).length} 条地址或电话查看足迹` },
      { title: '待确认分佣', value: `${pendingCommission} 单成交分佣待确认` }
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
  const reports = userReportRows(db, userId)
  const deals = userDealRows(db, userId)
  const commissions = userCommissionRows(db, userId)
  const footprints = footprintRecords(db, userId)
  const pendingReports = reports.filter((report) => !report.dealId && !/失效|取消/.test(String(report.status || ''))).length
  const pendingDeals = deals.filter((deal) => !/已确认|已驳回/.test(String(deal.status || ''))).length
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
      'reports',
      '待跟进报备',
      pendingReports,
      '条',
      pendingReports ? '从报备记录继续发起签单或补充跟进。' : '暂无待跟进报备。',
      '/pages/client-reports/client-reports',
      'blue'
    ),
    todayTaskItem(
      'deals',
      '待确认签单',
      pendingDeals,
      '单',
      pendingDeals ? '已提交签单等待管理员确认分佣。' : '暂无待确认签单。',
      '/pages/deal-records/deal-records',
      'red'
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
  const rent = Number(listing.rent || 0)
  if (filter.rentMin !== null && rent < filter.rentMin) return false
  if (filter.rentMax !== null && rent > filter.rentMax) return false
  if (filter.layout && String(listing.layout || '').indexOf(filter.layout) === -1) return false
  if (filter.rentMode && String(listing.rentMode || listing.type || listing.layout || '').indexOf(filter.rentMode) === -1) return false
  if (filter.sourceType && sourceTextForListing(listing, display).indexOf(filter.sourceType) === -1) return false
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
  const company = isCompanyListing(listing)
  const owner = isOwnerListing(listing)
  if (requested === COMPANY_SOURCE || requested === '公司') return company
  if (requested === OWNER_SOURCE || requested === '业主') return owner
  if (requested === SECOND_LANDLORD_SOURCE || requested === '二房东') return !company && !owner
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

function adminLogs(db) {
  // 预建 id→实体索引，避免对每条足迹重复线性扫描 listings/users（后台足迹页无分页，
  // 足迹上限可达 30000，原实现每行三次线性查找造成数百万次比较）。
  const listingsById = new Map((db.listings || []).map((listing) => [listing.id, listing]))
  const usersById = new Map((db.users || []).map((user) => [user.id, user]))
  return (db.footprints || []).map((item) => {
    const listing = listingsById.get(item.listingId) || {}
    const viewer = usersById.get(item.viewerId) || {}
    const uploader = usersById.get(listing.uploaderId) || {}
    return {
      viewer: viewer.name,
      listing: listing.shortTitle,
      action: item.action,
      needId: item.needId || '',
      purpose: item.purpose || '',
      uploader: uploader.name,
      sync: item.sync,
      time: item.time
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
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertFrontendListingAvailable(listing)
  const purposePayload = normalizePurposePayload(payload)
  const access = assertSensitiveViewAllowed(db, userId, listing, purposePayload)

  pushFootprint(db, {
    id: id('F'),
    listingId,
    viewerId: userId,
    action: purposePayload.action || '查看地址和电话',
    needId: purposePayload.needId || '',
    purpose: purposePayload.purpose || '',
    time: '刚刚',
    dateKey: todayKey(),
    quotaCategory: access.category,
    sync: '已同步上传人和管理员'
  })
  listing.sensitiveViews = Number(listing.sensitiveViews || 0) + 1
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
      sensitiveLocked: false
    }
  }
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

  db.showingUploads = db.showingUploads || []
  const location = publicListingLocationFields(listing)
  const showing = {
    id: id('SH'),
    listingId,
    userId,
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
      time: '刚刚',
      dateKey: todayKey(),
      showingUploadId: showing.id,
      proofStatus: '已通过',
      sync: '已同步上传人和管理员'
    })
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

function createClientReport(db, userId, listingId, payload = {}) {
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
  return {
    message: '报备已创建',
    report: formatClientReport(db, report)
  }
}

function formatDealRecord(db, deal = {}) {
  const listing = listingById(db, deal.listingId) || {}
  const location = publicListingLocationFields(listing)
  const report = reportById(db, deal.reportId) || {}
  const broker = userById(db, deal.brokerId) || {}
  const uploader = userById(db, deal.uploaderId) || {}
  const baseCommissionRule = commissionRuleForListing(listing, db, deal.uploaderId)
  const savedCommissionRule = deal.commissionRule || {}
  // 展示总比例与 confirmDeal 结算口径一致：优先取签单冻结的 commissionRule.rate，仅历史缺失时
  // 才回退按当前 listing 重算。否则签单后房源被改为公司房源等情况下，rate 会取现状 0 而
  // uploaderRate/platformRate 仍是冻结拆分，形成“总佣 0% 却拆出比例”且与实付分佣冲突的矛盾对象。
  const rate = Number(savedCommissionRule.rate ?? baseCommissionRule.rate ?? 0)
  const uploaderRate = Number(savedCommissionRule.uploaderRate ?? (rate ? (savedCommissionRule.rate ?? baseCommissionRule.uploaderRate) : 0))
  const platformRate = Number(savedCommissionRule.platformRate ?? Math.max(0, rate - uploaderRate))
  const commissionRule = { rate, uploaderRate, platformRate }
  const expectedUploaderCommissionFen = Math.round(Number(deal.landlordCommissionFen || 0) * uploaderRate / 100)
  const expectedPlatformCommissionFen = Math.round(Number(deal.landlordCommissionFen || 0) * platformRate / 100)
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
    uploaderCommissionRate: rate,
    uploaderRate,
    platformRate,
    expectedUploaderCommissionFen,
    expectedUploaderCommission: fenToYuanText(expectedUploaderCommissionFen),
    expectedPlatformCommissionFen,
    expectedPlatformCommission: fenToYuanText(expectedPlatformCommissionFen),
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
  const landlordCommissionFen = amountFenFromPayload(
    payload,
    ['landlordCommission', 'landlordPaidCommission', 'landlordActualCommission', 'ownerCommission', 'commissionAmount'],
    ['landlordCommissionFen', 'landlordPaidCommissionFen', 'landlordActualCommissionFen', 'ownerCommissionFen', 'commissionAmountFen'],
    '房东实际支付佣金'
  )

  const now = nowText()
  const location = publicListingLocationFields(listing)
  const listingTitle = publicListingTitle(listing, location) || listing.title || '未知房源'
  const rentFen = Math.round(Number(listing.rent || 0) * 100)
  const sourceFields = listingSourceFields(listing, db)
  const ownerType = sourceFields.ownerType
  const source = listing.source || sourceFields.sourceLabel || ''
  const commissionRule = commissionRuleForListing({ ...listing, ownerType, source }, db, listing.uploaderId)
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
    commissionRule,
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
    commissionRule,
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
  const commissionRule = deal.commissionRule
    || (deal.dealSnapshot && deal.dealSnapshot.commissionRule)
    || commissionRuleForListing(listing, db, deal.uploaderId)
  if (deal.status === '已确认') {
    return {
      message: '签单已确认',
      deal: formatDealRecord(db, deal),
      commissionRecord: existingRecord ? clone(existingRecord) : null,
      noCommission: commissionRule.rate === 0
    }
  }

  const now = nowText()
  const uploaderCommissionFen = Math.round(Number(deal.landlordCommissionFen || 0) * commissionRule.uploaderRate / 100)
  const platformCommissionFen = Math.round(Number(deal.landlordCommissionFen || 0) * commissionRule.platformRate / 100)
  // 不再回写覆盖 deal.commissionRule / dealSnapshot.commissionRule：它们是签单时冻结的
  // 不可变证据。仅为缺失冻结值的历史签单补齐（不覆盖已有值）。
  if (!deal.commissionRule) {
    deal.commissionRule = clone(commissionRule)
  }
  if (deal.dealSnapshot && !deal.dealSnapshot.commissionRule) {
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

  return {
    message: '签单已确认，正式分佣记录已生成',
    deal: formatDealRecord(db, deal),
    commissionRecord: clone(record),
    noCommission: false
  }
}

function registerDeal(db, userId, listingId) {
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

function companyPublicListingFields(listing = {}) {
  if (!isCompanyListing(listing)) return {}
  const location = listingLocationFields(listing)
  const companyPhones = ((config.company && config.company.contactPhones) || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  const companyPhoneText = companyPhones.join('/')
  const contact = companyPhoneText || firstText(listing.contact, listing.feishuContact, listing.landlordPhone)
  const viewingPassword = firstText(listing.viewingPassword, listing.showingPassword, listing.password)
  const remark = firstText(listing.remark, listing.note, listing.memo)
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
  const contact = firstText(form.contact, form.landlordPhone, current.landlordPhone)
  const rent = firstText(form.rent, current.rent)
  const videoUrl = firstText(form.videoUrl, current.videoUrl)
  const videoKey = firstText(form.videoKey, current.videoKey)
  // 看房密码显式传空串表示清空，不传才沿用现值
  const viewingPasswordInput = firstOwnValue(form, ['viewingPassword', 'showingPassword'])
  const viewingPassword = viewingPasswordInput !== undefined
    ? String(viewingPasswordInput || '').trim()
    : firstText(current.viewingPassword, current.showingPassword)
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
    rent: Number(rent),
    videoUrl,
    videoKey,
    viewingPassword,
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
  const rates = payload.uploaderRates || {}
  const secondLandlordRate = boundedRate(
    payload.secondLandlordRate ?? payload.secondLandlordUploaderRate ?? rates[SECOND_LANDLORD_SOURCE],
    current.secondLandlordRate,
    current.totalRate
  )
  const ownerRate = boundedRate(
    payload.ownerRate ?? payload.ownerUploaderRate ?? rates[OWNER_SOURCE],
    current.ownerRate,
    current.totalRate
  )
  const now = nowText()
  db.commissionConfig = {
    totalRate: TOTAL_DEAL_COMMISSION_RATE,
    uploaderRates: {
      [SECOND_LANDLORD_SOURCE]: secondLandlordRate,
      [OWNER_SOURCE]: ownerRate,
      [COMPANY_SOURCE]: 0
    },
    secondLandlordRate,
    ownerRate,
    companyRate: 0,
    updatedAt: now,
    updatedBy: adminId || 'admin'
  }
  pushFootprint(db, {
    id: id('F'),
    viewerId: adminId || 'admin',
    action: '调整分佣配置',
    time: now,
    sync: `二房东上传人 ${secondLandlordRate}%，业主上传人 ${ownerRate}%，公司房源不抽佣`
  })
  return commissionConfig(db)
}

function validateListingFields(fields, user = {}, options = {}) {
  if (
    !fields.address ||
    !fields.contact ||
    !fields.rent ||
    !fields.layout ||
    !fields.rawCommunity ||
    !fields.building ||
    !fields.roomNumber
  ) {
    const error = new Error('城市、区域、小区、几栋、房间号、联系方式、租金和户型必填')
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
  if (!Number.isFinite(fields.commissionRate) || fields.commissionRate < 0 || fields.commissionRate > TOTAL_DEAL_COMMISSION_RATE) {
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
  const error = new Error(`已存在同一小区、楼栋、单元、房号和房东手机号的有效房源，请勿重复上传（房东手机号 ${maskPhone(fields.contact)}）`)
  error.statusCode = 409
  throw error
}

function addNormalListing(db, userId, form = {}, options = {}) {
  const user = assertKnownUser(db, userId)
  const fields = normalizeListingForm(form, {}, { admin: options.admin, user, db })
  validateListingFields(fields, user, options)
  assertNoDuplicateActiveListing(db, fields)

  const listingId = id('L')
  const needsReview = fields.ownerType === OWNER_SOURCE || fields.requiresManualReview
  const mapCoordinate = listingMapCoordinateFields(fields, form, {}, options)
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
    block: form.block || fields.area || '待板块',
    community: fields.community,
    building: fields.building,
    unit: fields.unit,
    roomNumber: fields.roomNumber,
    address: fields.address,
    landlordPhone: fields.contact,
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
    createdAt: nowText(),
    lastVerifiedAt: nowText()
  }

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
    commissionRate: listing.commissionRate,
    videoLabel: listing.videoLabel || '房源实拍视频',
    videoUrl: listing.videoUrl || '',
    videoKey: listing.videoKey || '',
    viewingPassword: firstText(listing.viewingPassword, listing.showingPassword),
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

  const fields = normalizeListingForm(form, listing, { admin: options.admin, user, db })
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
  listing.block = Object.prototype.hasOwnProperty.call(form, 'block') ? form.block : (listing.block || fields.area || '待板块')
  listing.community = fields.community
  listing.building = fields.building
  listing.unit = fields.unit
  listing.roomNumber = fields.roomNumber
  listing.address = fields.address
  listing.landlordPhone = fields.contact
  listing.commissionRate = fields.commissionRate
  listing.videoUrl = fields.videoUrl
  listing.videoKey = fields.videoKey || ''
  listing.viewingPassword = fields.viewingPassword
  listing.showingPassword = fields.viewingPassword
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
  const needsReview = fields.ownerType === OWNER_SOURCE || fields.requiresManualReview
  if (needsReview) {
    listing.reviewStatus = listing.reviewStatus === '已通过' && options.admin && !fields.requiresManualReview ? '已通过' : '待审核'
    if (listing.reviewStatus !== '已通过') listing.status = '待审核'
  } else {
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

module.exports = {
  currentUser,
  loginByPhone,
  registerUser,
  migrateCompanyListings,
  listingMaintenanceRule,
  setListingMaintenanceRule,
  enforceListingMaintenanceRule,
  commissionConfig,
  setCommissionConfig,
  dashboardSummary,
  formatHomeListing,
  homeListings,
  filterListings,
  matchListings,
  listingDetail,
  listingDetailState,
  isCompanyListing,
  isNoCommissionListing,
  listingLogs,
  recordVideoShare,
  footprintRecords,
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
  recordShowing,
  registerDeal,
  rechargePoints,
  uploadGroupListing,
  unlockGroup,
  addNormalListing,
  editableListingDetail,
  updateNormalListing,
  reviewOwnerListing,
  verifyListingAvailability
}
