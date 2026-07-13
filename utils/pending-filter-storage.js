const PENDING_FILTER_VERSION = 1

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseStoredValue(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (error) {
    return null
  }
}

function createPendingFilterEnvelope(payload, ownerSessionKey = '') {
  const normalizedPayload = isPlainRecord(payload) ? payload : {}
  const normalizedOwner = String(ownerSessionKey || '')
  if (!normalizedOwner && legacyValueContainsAccountScope(normalizedPayload)) {
    throw new Error('携带需求单或房源 ID 的筛选必须绑定当前会话')
  }
  return {
    pendingFilterVersion: PENDING_FILTER_VERSION,
    ownerSessionKey: normalizedOwner,
    payload: normalizedPayload
  }
}

function legacyValueContainsAccountScope(value) {
  if (!isPlainRecord(value)) return false
  const filters = isPlainRecord(value.filters) ? value.filters : value
  const needId = String(filters.needId || filters.rentalNeedId || filters.clientNeedId || '').trim()
  const listingIds = Array.isArray(filters.listingIds)
    ? filters.listingIds.filter(Boolean)
    : String(filters.listingIds || '').trim()
  return Boolean(needId || (Array.isArray(listingIds) ? listingIds.length : listingIds))
}

function consumePendingFilterEnvelope(rawValue, currentSessionKey) {
  const value = parseStoredValue(rawValue)
  if (!isPlainRecord(value)) return null
  if (Object.prototype.hasOwnProperty.call(value, 'pendingFilterVersion')) {
    if (value.pendingFilterVersion !== PENDING_FILTER_VERSION || !isPlainRecord(value.payload)) return null
    const ownerSessionKey = String(value.ownerSessionKey || '')
    if (!ownerSessionKey && legacyValueContainsAccountScope(value.payload)) return null
    if (ownerSessionKey && ownerSessionKey !== String(currentSessionKey || '')) return null
    return value.payload
  }
  // 兼容旧版本留下的公开分类/区域筛选；携带需求单或房源 ID 的旧值没有 owner，必须丢弃。
  return legacyValueContainsAccountScope(value) ? null : value
}

module.exports = {
  createPendingFilterEnvelope,
  consumePendingFilterEnvelope
}
