const { clone } = require('./db')
const { coordinateByCommunity } = require('./community-coordinates')
const {
  NO_FEATURE,
  NO_COMMISSION_FEATURE,
  DEPOSIT_FREE_FEATURE,
  parseFeatureInput,
  normalizeListingFeatures,
  invalidListingFeatures,
  featureText
} = require('./listing-features')

const VERIFY_REMINDER_DAYS = [3, 5]
const VERIFY_STALE_DAYS = 15
const COMPANY_SOURCE = '公司房源'
const OWNER_SOURCE = '业主房源'
const SECOND_LANDLORD_SOURCE = '二房东房源'
const BROKER_ROLE = '中介'
const BROKER_AUTHED = '手机号登录'
const OWNER_DAILY_VIEW_LIMIT = 3
const NORMAL_DAILY_VIEW_LIMIT = 15

const FEATURE_INFERENCE_RULES = [
  { name: '带阳台', pattern: /阳台/ },
  { name: '干湿分离', pattern: /干湿分离/ },
  { name: '燃气', pattern: /燃气|天然气|煤气/ },
  { name: '阁楼', pattern: /阁楼/ },
  { name: '露台', pattern: /露台/ },
  { name: '花园', pattern: /花园/ },
  { name: '近地铁', pattern: /近地铁|地铁口|地铁站|号线/ },
  { name: '朝南', pattern: /朝南|南向/ },
  { name: '独卫', pattern: /独卫|独立卫|独立厨卫|独厨独卫/ },
  { name: '电梯', pattern: /电梯/ },
  { name: '整租', pattern: /整租|（整）|\(整\)/ },
  { name: '合租', pattern: /合租|单间/ },
  { name: DEPOSIT_FREE_FEATURE, pattern: /免押金|无押金|零押金|押金0|押金为0/ }
]

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

function normalizeOwnerType(value, fallback = SECOND_LANDLORD_SOURCE) {
  const text = String(value || '').trim()
  if (/业主/.test(text)) return OWNER_SOURCE
  if (/二房东|二房東/.test(text)) return SECOND_LANDLORD_SOURCE
  return fallback || SECOND_LANDLORD_SOURCE
}

function isOwnerListing(listing = {}) {
  const sourceText = [
    listing.ownerType,
    listing.houseSourceType,
    listing.source,
    listing.sourceType,
    listing.listingType,
    listing.category
  ].map((item) => String(item || '')).join(' ')
  return normalizeOwnerType(listing.ownerType || '') === OWNER_SOURCE || /业主/.test(sourceText)
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

function rawActiveListings(db) {
  return (db.listings || []).filter((listing) => !isExpiredListing(listing))
}

function activeListings(db) {
  autoExpireOverdueListings(db)
  return rawActiveListings(db)
}

function publicListings(db) {
  return activeListings(db).filter((listing) => !isPendingOwnerReview(listing))
}

function assertListingActive(listing) {
  if (!isExpiredListing(listing)) return
  const error = new Error('该房源已下架，已进入后台废房源池')
  error.statusCode = 410
  throw error
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
    listing.address
  ].map((item) => String(item || '')).join(' ')
}

function inferListingFeatures(listing = {}) {
  const text = listingTextForFeatures(listing)
  const inferred = FEATURE_INFERENCE_RULES
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.name)
  if (/合租/.test(text) && inferred.indexOf('整租') !== -1) {
    inferred.splice(inferred.indexOf('整租'), 1)
  }
  return inferred
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
  return features.length ? features : [NO_FEATURE]
}

function listingSourceFields(listing = {}) {
  const companyListing = isCompanyListing(listing)
  const noCommission = isNoCommissionListing(listing)
  const ownerType = normalizeOwnerType(listing.ownerType || listing.houseSourceType || '', SECOND_LANDLORD_SOURCE)
  const reviewStatus = ownerReviewStatus({ ...listing, ownerType })
  const sourceLabel = companyListing ? COMPANY_SOURCE : ownerType
  return {
    companyListing,
    isCompanyListing: companyListing,
    ownerType,
    isOwnerListing: ownerType === OWNER_SOURCE,
    reviewStatus,
    requiresManualReview: truthyFlag(listing.requiresManualReview),
    manualReviewReason: listing.manualReviewReason || '',
    communityMatched: listing.communityMatched !== undefined ? truthyFlag(listing.communityMatched) : listing.communityMatchStatus !== '未匹配',
    communityMatchStatus: listing.communityMatchStatus || (listing.communityMatched === false ? '未匹配' : '已匹配'),
    noCommission,
    sourceLabel,
    commissionText: noCommission ? '不分佣' : `分佣 ${Number(listing.commissionRate || 0)}%`,
    commissionBadge: noCommission ? '不分佣' : `${Number(listing.commissionRate || 0)}%`
  }
}

function migrateCompanyListings(db = {}) {
  let changed = false
  ;(db.listings || []).forEach((listing) => {
    const shouldBeCompany = isLegacyRentInventory(listing) || isCompanyListing(listing)
    const shouldNoCommission = shouldBeCompany || isNoCommissionListing(listing)
    if (shouldBeCompany && !isCompanyListing(listing)) {
      listing.source = COMPANY_SOURCE
      listing.companyListing = true
      listing.isCompanyListing = true
      changed = true
    }
    if (shouldBeCompany && listing.source !== COMPANY_SOURCE) {
      listing.source = COMPANY_SOURCE
      changed = true
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

function listingDisplayFields(listing = {}) {
  const freshness = listingFreshness(listing)
  return {
    ...listingFeatureFields(listing),
    ...listingSourceFields(listing),
    lastVerifiedAt: freshness.lastVerifiedAt,
    staleDays: freshness.staleDays,
    verifyStatus: freshness.verifyStatus,
    verifyTip: freshness.verifyTip,
    needsVerify: freshness.needsVerify,
    maintenanceText: maintenanceText(freshness)
  }
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
      ? `已开启：3 天、5 天提醒上传人电话联系房东；${VERIFY_STALE_DAYS} 天未更新固定自动下架并进入后台废房源池。`
      : `已关闭提醒：${VERIFY_STALE_DAYS} 天未更新仍会固定自动下架并进入后台废房源池。`
  }
}

function expireListing(db, listing, reason) {
  if (!listing || isExpiredListing(listing)) return false
  const freshness = listingFreshness(listing)
  const now = nowText()
  listing.lifecycleStatus = 'expired'
  listing.status = '已下架'
  listing.expiredAt = now
  listing.expiredBy = 'system'
  listing.expiredPool = '后台废房源池'
  listing.expiredReason = reason || `超过 ${VERIFY_STALE_DAYS} 天未电话联系房东确认房态`
  listing.expiredStaleDays = freshness.staleDays
  listing.updatedAt = now
  db.footprints = db.footprints || []
  db.footprints.unshift({
    id: id('F'),
    listingId: listing.id,
    viewerId: 'system',
    action: '自动下架',
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
  return userById(db, userId) || (db.users || [])[0] || {}
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
    db.users = db.users || []
    const broker = {
      id: id('U'),
      name: `中介${target.slice(-4)}`,
      phone: target,
      role: BROKER_ROLE,
      authed: BROKER_AUTHED,
      isAdmin: false,
      brokerStatus: '未开通',
      createdAt: nowText()
    }
    db.users.push(broker)
    db.currentUserId = broker.id
    return clone(broker)
  }
  db.currentUserId = user.id
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
    db.currentUserId = existed.id
    return clone(existed)
  }

  db.users = db.users || []
  const user = {
    id: id('U'),
    name,
    phone,
    role: payload.role || '内部员工',
    authed: '已实名',
    isAdmin: false,
    createdAt: nowText()
  }
  db.users.push(user)
  db.currentUserId = user.id
  return clone(user)
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
  return {
    listingCount: publicListings(db).length,
    areaStats: areas,
    staleListingCount: staleListings(db).length,
    expiredListingCount: (db.listings || []).filter(isExpiredListing).length,
    groupCount: groups.length,
    unlockedGroupCount: groups.filter((group) => group.unlocked).length,
    userCount: users.length,
    authedUsers: users.filter((user) => user.authed === '已实名').length,
    todaySensitiveViews: (db.footprints || []).filter((item) => item.action !== '记录带看').length,
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

function assertSensitiveViewAllowed(db, userId, listing) {
  const viewer = userById(db, userId) || {}
  const category = sensitiveQuotaCategory(listing, userId)
  if (category === 'own') {
    return { category, quota: brokerSensitiveUsage(db, userId) }
  }
  if (!isBrokerUser(viewer)) {
    if (viewer.authed !== '已实名' && !viewer.isAdmin) {
      const error = new Error('查看地址和房东联系方式前需要先完成实名认证')
      error.statusCode = 403
      throw error
    }
    return { category, quota: brokerSensitiveUsage(db, userId) }
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
  const location = listingLocationFields(listing)
  const display = listingDisplayFields(listing)
  const publicTitle = listing.shortTitle || location.community || listing.community || `${location.area || '房源'}${listing.layout ? ` · ${listing.layout}` : ''}`
  return {
    id: listing.id,
    title: publicTitle,
    meta: `${location.locationSummary || location.area} · ${listing.layout} · 仅视频`,
    sub: display.noCommission ? `${display.sourceLabel} · 不分佣` : `分佣 ${listing.commissionRate}% · 上传人 ${uploader.name || '未知'}`,
    price: `¥${listing.rent}/月`,
    tag: display.noCommission ? '不分佣' : (Number(listing.commissionRate) >= 20 ? '分佣20%' : '实名留痕'),
    videoUrl: listing.videoUrl || '',
    ...display,
    ...location
  }
}

function homeListings(db) {
  return publicListings(db).slice(0, 3).map((item) => formatHomeListing(db, item))
}

function matchesCategory(listing, category) {
  if (!category || category === '全部') return true
  const display = listingDisplayFields(listing)
  const type = `${listing.type || ''}${listing.layout || ''}${listing.source || ''}${display.ownerType || ''}${display.sourceLabel || ''}`
  if (category === '业主房源') return type.indexOf('业主') !== -1
  return type.indexOf(category) !== -1
}

function filterListings(db, filter = {}) {
  return publicListings(db)
    .filter((listing) => {
      const locationText = `${listing.city || ''}${listing.district || ''}${listing.area || ''}${listing.block || ''}${listing.community || ''}${listing.building || ''}${listing.unit || ''}${listing.roomNumber || ''}${listing.address || ''}`
      if (!matchesCategory(listing, filter.category)) return false
      if (filter.area && locationText.indexOf(filter.area) === -1) return false
      if (filter.block && locationText.indexOf(filter.block) === -1) return false
      if (filter.community && String(listing.community || '').indexOf(filter.community) === -1) return false
      if (filter.layout && String(listing.layout || '').indexOf(filter.layout) === -1) return false
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
        noCommission: row.noCommission,
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

  const availableListings = publicListings(db)
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
      `${listing.city || ''}${listing.district || ''}${listing.area || ''}${listing.block || ''}${listing.community || ''}${listing.building || ''}${listing.unit || ''}${listing.roomNumber || ''}${listing.address || ''}`.indexOf(area) !== -1
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

function listingDetail(db, listingId) {
  autoExpireOverdueListings(db)
  const listing = listingById(db, listingId)
  if (!listing) return null
  if (isExpiredListing(listing) || isPendingOwnerReview(listing)) return null
  const uploader = userById(db, listing.uploaderId) || {}
  const location = listingLocationFields(listing)
  const display = listingDisplayFields(listing)
  return {
    id: listing.id,
    title: listing.title,
    uploader: uploader.name || '未知',
    uploaderPhone: uploader.phone || '',
    rent: String(listing.rent),
    layout: listing.layout,
    ...location,
    areaText: `${location.city} · ${location.area}`,
    address: '确认留痕后可查看',
    landlordPhone: '确认留痕后可查看',
    sensitiveLocked: true,
    commissionRate: listing.commissionRate,
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
    ...display
  }
}

function listingLogs(db, listingId) {
  return (db.footprints || [])
    .filter((item) => item.listingId === listingId)
    .map((item) => {
      const user = userById(db, item.viewerId) || {}
      return {
        user: user.name || '未知',
        action: item.action,
        time: item.time
      }
    })
}

function footprintRecords(db, userId) {
  return (db.footprints || [])
    .filter((record) => {
      const listing = listingById(db, record.listingId) || {}
      return record.viewerId === userId || listing.uploaderId === userId
    })
    .map((record) => {
      const listing = listingById(db, record.listingId) || {}
      const viewer = userById(db, record.viewerId) || {}
      const uploader = userById(db, listing.uploaderId) || {}
      const isMine = record.viewerId === userId
      return {
        id: record.id,
        title: listing.title || '未知房源',
        status: record.action,
        customer: `查看人：${viewer.name || '未知'} · ${viewer.authed || '未实名'}`,
        time: record.time,
        price: listing.rent ? `¥${listing.rent}/月` : '',
        meta: `上传人：${uploader.name || '未知'} · ${record.sync}`,
        direction: isMine ? '我查看的' : '我的房源被查看',
        raw: clone(record)
      }
    })
}

function ownedListings(db, userId) {
  return activeListings(db)
    .filter((listing) => listing.uploaderId === userId)
    .map((listing) => {
      const location = listingLocationFields(listing)
      const display = listingDisplayFields(listing)
      return {
        id: listing.id,
        title: listing.title,
        ...location,
        rent: String(listing.rent),
        commissionRate: display.noCommission ? '不分佣' : `${listing.commissionRate}%`,
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
        const display = listingDisplayFields(listing)
        return {
          id: listing.id,
          title: `${listing.block || '待板块'} · ${listing.layout}`,
          price: `¥${listing.rent}/月`,
          rule: `分佣 ${listing.commissionRate}%`,
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

const districtMapCenters = {
  '拱墅': { latitude: 30.3192, longitude: 120.1694 },
  '拱墅区': { latitude: 30.3192, longitude: 120.1694 },
  '上城区': { latitude: 30.2962, longitude: 120.2076 },
  '西湖区': { latitude: 30.2877, longitude: 120.1264 }
}

function stableHash(text = '') {
  let hash = 2166136261
  const source = String(text)
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function isDefaultMapCoordinate(latitude, longitude) {
  return Math.abs(latitude - defaultMapCenter.latitude) < 0.000001 &&
    Math.abs(longitude - defaultMapCenter.longitude) < 0.000001
}

function baseMapCenterFromListing(listing = {}) {
  const locationText = `${listing.area || ''}${listing.district || ''}${listing.block || ''}`
  const matched = Object.keys(districtMapCenters).find((name) => locationText.indexOf(name) !== -1)
  return matched ? districtMapCenters[matched] : defaultMapCenter
}

function scatteredCoordinateFromListing(listing = {}) {
  const base = baseMapCenterFromListing(listing)
  const seed = stableHash([
    listing.area,
    listing.district,
    listing.block,
    listing.community
  ].filter(Boolean).join('|'))
  const angle = ((seed % 360) * Math.PI) / 180
  const radiusStep = ((seed >>> 9) % 7) + 1
  const radius = 0.004 + radiusStep * 0.0024
  const latitude = base.latitude + Math.sin(angle) * radius
  const longitude = base.longitude + Math.cos(angle) * radius * 1.18
  return {
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6))
  }
}

function mapCoordinateFromListing(listing = {}) {
  const communityCoordinate = coordinateByCommunity(listing.community)
  if (communityCoordinate) return communityCoordinate

  const latitude = Number(listing.mapLatitude || listing.latitude)
  const longitude = Number(listing.mapLongitude || listing.longitude)
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    if (isDefaultMapCoordinate(latitude, longitude)) {
      return {
        ...scatteredCoordinateFromListing(listing),
        source: 'estimated-by-area'
      }
    }
    return { latitude, longitude, source: 'listing-coordinate' }
  }

  const left = Number.isFinite(Number(listing.mapLeft)) ? Number(listing.mapLeft) : 50
  const top = Number.isFinite(Number(listing.mapTop)) ? Number(listing.mapTop) : 50
  if (left === 50 && top === 50) {
    return {
      ...scatteredCoordinateFromListing(listing),
      source: 'estimated-by-area'
    }
  }
  return {
    latitude: Number((defaultMapCenter.latitude + ((50 - top) / 50) * 0.035).toFixed(6)),
    longitude: Number((defaultMapCenter.longitude + ((left - 50) / 50) * 0.045).toFixed(6)),
    source: 'legacy-map-offset'
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
    source: source.coordinateSource || 'listing-coordinate'
  }
}

function listingMapCoordinateFields(fields = {}, form = {}, current = {}) {
  const communityCoordinate = coordinateByCommunity(fields.community || form.community || current.community)
  if (communityCoordinate) {
    return {
      mapLatitude: communityCoordinate.latitude,
      mapLongitude: communityCoordinate.longitude,
      coordinateSource: communityCoordinate.source || 'community-coordinate'
    }
  }

  const formCoordinate = explicitCoordinateFromSource(form)
  if (formCoordinate) {
    return {
      mapLatitude: formCoordinate.latitude,
      mapLongitude: formCoordinate.longitude,
      coordinateSource: formCoordinate.source
    }
  }

  const currentCoordinate = explicitCoordinateFromSource(current)
  if (currentCoordinate && !isDefaultMapCoordinate(currentCoordinate.latitude, currentCoordinate.longitude)) {
    return {
      mapLatitude: currentCoordinate.latitude,
      mapLongitude: currentCoordinate.longitude,
      coordinateSource: currentCoordinate.source
    }
  }

  return {
    mapLatitude: defaultMapCenter.latitude,
    mapLongitude: defaultMapCenter.longitude,
    coordinateSource: 'default-center'
  }
}

function applyCommunityMapCoordinate(listing = {}) {
  const coordinate = coordinateByCommunity(listing.community)
  if (!coordinate) return null
  listing.mapLatitude = coordinate.latitude
  listing.mapLongitude = coordinate.longitude
  listing.coordinateSource = coordinate.source || 'community-coordinate'
  return coordinate
}

function mapPins(db) {
  return publicListings(db).map((listing) => {
    const coordinate = mapCoordinateFromListing(listing)
    const location = listingLocationFields(listing)
    const display = listingDisplayFields(listing)
    return {
      id: listing.id,
      title: listing.shortTitle || listing.title,
      ...location,
      layout: listing.layout || '',
      type: listing.type || '',
      status: listing.status || '',
      price: String(listing.rent),
      commission: display.noCommission ? '不分佣' : `${listing.commissionRate}%`,
      source: listing.source || '',
      companyListing: display.companyListing,
      noCommission: display.noCommission,
      sourceLabel: display.sourceLabel,
      commissionText: display.commissionText,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      coordinateSource: coordinate.source || '',
      left: listing.mapLeft || 50,
      top: listing.mapTop || 50,
      ...display
    }
  })
}

function adminListings(db, filter = {}) {
  return activeListings(db)
    .filter((listing) => {
      if (filter.area && String(listing.area || '').indexOf(filter.area) === -1) return false
      if (filter.block && String(listing.block || '').indexOf(filter.block) === -1) return false
      if (filter.community && String(listing.community || '').indexOf(filter.community) === -1) return false
      return true
    })
    .map((listing) => {
      const uploader = userById(db, listing.uploaderId) || {}
      const freshness = listingFreshness(listing)
      const location = listingLocationFields(listing)
      const display = listingDisplayFields(listing)
      return {
        id: listing.id,
        title: listing.shortTitle,
        ...location,
        ...display,
        uploader: uploader.name,
        rent: `${listing.rent}/月`,
        layout: String(listing.layout || '').replace('整租', ''),
        commission: display.noCommission ? '不分佣' : `${listing.commissionRate}%`,
        source: listing.source || display.sourceLabel,
        video: listing.videoUrl ? '已传' : '未传',
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
      return true
    })
    .map((listing) => {
      const uploader = userById(db, listing.uploaderId) || {}
      const freshness = listingFreshness(listing)
      const location = listingLocationFields(listing)
      const display = listingDisplayFields(listing)
      return {
        id: listing.id,
        title: listing.shortTitle || listing.title,
        ...location,
        ...display,
        uploader: uploader.name || '未知',
        uploaderPhone: uploader.phone || '',
        rent: `${listing.rent}/月`,
        layout: String(listing.layout || '').replace('整租', ''),
        commission: display.noCommission ? '不分佣' : `${listing.commissionRate}%`,
        source: listing.source || display.sourceLabel,
        video: listing.videoUrl ? '已传' : '未传',
        status: listing.status || '已下架',
        lastVerifiedAt: freshness.lastVerifiedAt,
        verifyStatus: freshness.verifyStatus,
        verifyTip: freshness.verifyTip,
        staleDays: freshness.staleDays,
        expiredAt: listing.expiredAt || '',
        expiredReason: listing.expiredReason || `超过 ${VERIFY_STALE_DAYS} 天未电话联系房东确认房态`,
        expiredPool: listing.expiredPool || '后台废房源池'
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
    const error = new Error('该房源不在废房源池')
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

  db.footprints = db.footprints || []
  db.footprints.unshift({
    id: id('F'),
    listingId,
    viewerId: adminId || 'system',
    action: '重新上架',
    time: now,
    sync: '管理员已从后台废房源池重新上架'
  })
  return editableListingDetail(db, adminId, listingId, { admin: true })
}

function adminLogs(db) {
  return (db.footprints || []).map((item) => {
    const listing = listingById(db, item.listingId) || {}
    const viewer = userById(db, item.viewerId) || {}
    const uploader = userById(db, listing.uploaderId) || {}
    return {
      viewer: viewer.name,
      listing: listing.shortTitle,
      action: item.action,
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
      listing: listing.shortTitle,
      uploader: (userById(db, item.uploaderId) || {}).name,
      dealer: (userById(db, item.dealUserId) || {}).name,
      rate: `${item.rate}%`,
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
      const uploader = userById(db, item.uploaderId) || {}
      const dealer = userById(db, item.dealUserId) || {}
      return {
        id: item.id,
        listingId: item.listingId,
        title: listing.shortTitle || listing.title || '未知房源',
        role: item.uploaderId === userId ? '我是上传人' : '我是成交人',
        uploader: uploader.name || '未知',
        dealer: dealer.name || '未知',
        rate: `${item.rate}%`,
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

function addSensitiveFootprint(db, userId, listingId, action) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertListingActive(listing)
  if (isPendingOwnerReview(listing)) {
    const error = new Error('该房源正在等待管理员审核，审核通过后才会上架')
    error.statusCode = 404
    throw error
  }
  const access = assertSensitiveViewAllowed(db, userId, listing)

  db.footprints = db.footprints || []
  db.footprints.unshift({
    id: id('F'),
    listingId,
    viewerId: userId,
    action: action || '查看地址和电话',
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

function recordShowing(db, userId, listingId, payload = {}) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertListingActive(listing)
  if (isPendingOwnerReview(listing)) {
    const error = new Error('该房源正在等待管理员审核，审核通过后才会上架')
    error.statusCode = 404
    throw error
  }
  if (!payload.photoUrl && !payload.photoKey) {
    const error = new Error('记录带看必须上传带时间地点水印的现场照片')
    error.statusCode = 400
    throw error
  }

  db.showingUploads = db.showingUploads || []
  const showing = {
    id: id('SH'),
    listingId,
    userId,
    listingTitle: listing.title || listing.shortTitle || '',
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
    db.footprints = db.footprints || []
    db.footprints.unshift({
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

function registerDeal(db, userId, listingId) {
  const listing = listingById(db, listingId)
  if (!listing) {
    const error = new Error('未找到该房源')
    error.statusCode = 404
    throw error
  }
  assertListingActive(listing)
  if (isPendingOwnerReview(listing)) {
    const error = new Error('该房源正在等待管理员审核，审核通过后才会上架')
    error.statusCode = 404
    throw error
  }

  if (isNoCommissionListing(listing)) {
    listing.status = '已成交'
    listing.updatedAt = nowText()
    return {
      message: '成交已登记，该房源不分佣',
      record: null,
      noCommission: true
    }
  }

  db.commissionRecords = db.commissionRecords || []
  const record = {
    id: id('C'),
    listingId,
    uploaderId: listing.uploaderId,
    dealUserId: userId,
    rate: Number(listing.commissionRate || 0),
    status: '待确认',
    time: '刚刚'
  }
  db.commissionRecords.unshift(record)
  listing.status = '已成交待确认'
  return {
    message: `成交已登记，待确认分佣 ${record.rate}%`,
    record: clone(record)
  }
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
    commissionRate: payload.commissionRate || '',
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

function hasAnyOwn(source = {}, fields = []) {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(source, field))
}

function firstOwnValue(source = {}, fields = []) {
  const field = fields.find((item) => Object.prototype.hasOwnProperty.call(source, item))
  return field ? source[field] : undefined
}

function normalizeListingForm(form = {}, current = {}) {
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
  const rateText = Object.prototype.hasOwnProperty.call(form, 'commissionRate')
    ? form.commissionRate
    : current.commissionRate
  const rate = rateText === '' || rateText === undefined ? 20 : Number(rateText)
  const companyFlagInput = firstOwnValue(form, ['companyListing', 'isCompanyListing', 'companyOwned'])
  const ownerTypeInput = firstText(form.ownerType, form.houseSourceType, form.landlordType, current.ownerType, current.houseSourceType)
  const ownerType = normalizeOwnerType(ownerTypeInput, current.ownerType || SECOND_LANDLORD_SOURCE)
  const sourceInput = firstText(form.source, form.sourceType, form.listingType, form.inventoryType)
  const currentCompany = isCompanyListing(current)
  const companyListing = companyFlagInput !== undefined
    ? truthyFlag(companyFlagInput)
    : (sourceInput ? /公司房源|company/.test(sourceInput) : currentCompany)
  const featureFields = ['features', 'featureTags', 'tags']
  const formFeatureInput = firstOwnValue(form, featureFields)
  const currentFeatureInput = firstOwnValue(current, featureFields)
  const featureInput = formFeatureInput !== undefined ? formFeatureInput : currentFeatureInput
  const featureInputCount = parseFeatureInput(featureInput).length
  const invalidFeatures = invalidListingFeatures(featureInput)
  const noCommission = companyListing || rate === 0 || parseFeatureInput(featureInput).indexOf(NO_COMMISSION_FEATURE) !== -1
  const communityMatchedInput = firstOwnValue(form, ['communityMatched', 'isCommunityMatched'])
  const manualReviewInput = firstOwnValue(form, ['requiresManualReview', 'manualReviewRequired'])
  const communityMatchStatusInput = firstText(form.communityMatchStatus, current.communityMatchStatus)
  const hasCommunityReviewInput = communityMatchedInput !== undefined || manualReviewInput !== undefined || Object.prototype.hasOwnProperty.call(form, 'communityMatchStatus')
  const currentCommunityMatched = current.communityMatched !== undefined
    ? truthyFlag(current.communityMatched)
    : (current.communityMatchStatus ? current.communityMatchStatus !== '未匹配' : true)
  const communityMatched = communityMatchedInput !== undefined
    ? truthyFlag(communityMatchedInput)
    : (communityMatchStatusInput ? communityMatchStatusInput !== '未匹配' : currentCommunityMatched)
  const requiresManualReview = manualReviewInput !== undefined
    ? truthyFlag(manualReviewInput)
    : (hasCommunityReviewInput ? !communityMatched : truthyFlag(current.requiresManualReview))
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
    commissionRate: noCommission ? 0 : rate,
    features: featuresWithCompanyDefaults(featureInput, {
      commissionRate: noCommission ? 0 : rate,
      companyListing,
      noCommission
    }),
    hasFeatureInput: featureInputCount > 0 || noCommission,
    invalidFeatures,
    companyListing,
    ownerType,
    noCommission,
    communityMatched,
    communityMatchStatus: communityMatched ? '已匹配' : '未匹配',
    requiresManualReview,
    manualReviewReason,
    source: companyListing ? COMPANY_SOURCE : (sourceInput || current.source || ownerType || '普通上传')
  }
}

function validateListingFields(fields, user = {}, options = {}) {
  if (
    !fields.address ||
    !fields.contact ||
    !fields.rent ||
    !fields.layout ||
    !fields.videoUrl ||
    !fields.rawCommunity ||
    !fields.building ||
    !fields.roomNumber
  ) {
    const error = new Error('城市、区域、小区、几栋、房间号、联系方式、租金、户型和视频必填')
    error.statusCode = 400
    throw error
  }
  if (!Number.isFinite(fields.rent) || fields.rent <= 0) {
    const error = new Error('租金必须是有效数字')
    error.statusCode = 400
    throw error
  }
  if (!Number.isFinite(fields.commissionRate) || fields.commissionRate < 0 || fields.commissionRate > 20) {
    const error = new Error('分佣比例必须在 0-20%')
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

function addNormalListing(db, userId, form = {}, options = {}) {
  const fields = normalizeListingForm(form)
  const user = currentUser(db, userId)
  validateListingFields(fields, user, options)

  const listingId = id('L')
  const needsReview = fields.ownerType === OWNER_SOURCE || fields.requiresManualReview
  const mapCoordinate = listingMapCoordinateFields(fields, form)
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
    createdAt: nowText(),
    lastVerifiedAt: nowText()
  }

  db.listings = db.listings || []
  db.pointLogs = db.pointLogs || []
  db.listings.unshift(listing)
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
  assertListingActive(listing)
  const user = userById(db, userId) || {}
  if (!options.admin && listing.uploaderId !== userId && !user.isAdmin) {
    const error = new Error('只能修改自己上传的房源')
    error.statusCode = 403
    throw error
  }
  const location = listingLocationFields(listing)
  const display = listingDisplayFields(listing)
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

  const fields = normalizeListingForm(form, listing)
  validateListingFields(fields, user, options)
  const mapCoordinate = listingMapCoordinateFields(fields, form, listing)

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
  listing.noCommission = fields.noCommission
  listing.communityMatched = fields.communityMatched
  listing.communityMatchStatus = fields.communityMatchStatus
  listing.requiresManualReview = fields.requiresManualReview
  listing.manualReviewReason = fields.manualReviewReason
  listing.mapLatitude = mapCoordinate.mapLatitude
  listing.mapLongitude = mapCoordinate.mapLongitude
  listing.coordinateSource = mapCoordinate.coordinateSource
  const needsReview = fields.ownerType === OWNER_SOURCE || fields.requiresManualReview
  if (needsReview) {
    listing.reviewStatus = listing.reviewStatus === '已通过' && options.admin && !fields.requiresManualReview ? '已通过' : '待审核'
    if (listing.reviewStatus !== '已通过') listing.status = '待审核'
  } else {
    listing.reviewStatus = '无需审核'
    if (listing.status === '待审核' || listing.status === '已驳回') listing.status = '待确认'
  }
  listing.updatedAt = nowText()

  return editableListingDetail(db, userId, listingId, { admin: true })
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
  db.footprints = db.footprints || []
  db.footprints.unshift({
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
  dashboardSummary,
  formatHomeListing,
  homeListings,
  filterListings,
  matchListings,
  listingDetail,
  listingLogs,
  footprintRecords,
  ownedListings,
  profileState,
  groupState,
  mapPins,
  adminListings,
  adminUsers,
  expiredListings,
  restoreExpiredListing,
  adminLogs,
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
