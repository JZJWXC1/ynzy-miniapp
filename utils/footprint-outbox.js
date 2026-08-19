const STORAGE_KEY = 'ynzy_phone_call_outbox_v1'
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,128}$/
let volatileEntries = []

function storageApi() {
  return typeof wx !== 'undefined' && wx && wx.getStorageSync && wx.setStorageSync ? wx : null
}

function safeText(value, maxLength) {
  const text = String(value || '').trim()
  return text && text.length <= maxLength ? text : ''
}

function normalizeEntry(value) {
  const item = value || {}
  const accountId = safeText(item.accountId, 128)
  const listingId = safeText(item.listingId, 128)
  const idempotencyKey = safeText(item.idempotencyKey, 128)
  if (!accountId || !listingId || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return null
  // 故意只挑选三个键，调用方误传的电话、地址、错误正文不会进入本地持久化。
  return { accountId, listingId, idempotencyKey }
}

function uniqueEntries(entries) {
  return (entries || []).reduce((result, item) => {
    const normalized = normalizeEntry(item)
    if (normalized && !result.some((saved) => sameEntry(saved, normalized))) result.push(normalized)
    return result
  }, [])
}

function readStoredEntries() {
  const storage = storageApi()
  if (!storage) return []
  try {
    const value = storage.getStorageSync(STORAGE_KEY)
    const rows = Array.isArray(value) ? value : []
    return rows.map(normalizeEntry).filter(Boolean)
  } catch (error) {
    return []
  }
}

function readEntries() {
  return uniqueEntries(readStoredEntries().concat(volatileEntries))
}

function writeStoredEntries(entries) {
  const storage = storageApi()
  if (!storage) return false
  const safeEntries = uniqueEntries(entries)
  try {
    storage.setStorageSync(STORAGE_KEY, safeEntries)
    return true
  } catch (error) {
    return false
  }
}

function sameEntry(left, right) {
  return left.accountId === right.accountId &&
    left.listingId === right.listingId &&
    left.idempotencyKey === right.idempotencyKey
}

function enqueuePhoneCall(payload) {
  const entry = normalizeEntry(payload)
  if (!entry) throw new Error('拨号补发信息无效')
  const entries = readEntries()
  if (!entries.some((item) => sameEntry(item, entry))) {
    entries.push(entry)
    if (writeStoredEntries(entries)) {
      // 本次已把内存兜底项一并持久化成功，避免后续重复维护两份队列。
      volatileEntries = []
    } else if (!volatileEntries.some((item) => sameEntry(item, entry))) {
      // 配额/存储异常时仍保留于本进程并立即走同一补发器，至少保证本次拨号会尝试服务端留痕。
      volatileEntries.push(entry)
    }
  }
  return { ...entry }
}

function pendingPhoneCalls(accountId) {
  const target = safeText(accountId, 128)
  if (!target) return []
  return readEntries()
    .filter((item) => item.accountId === target)
    .map((item) => ({ ...item }))
}

function removeEntry(entry) {
  volatileEntries = volatileEntries.filter((item) => !sameEntry(item, entry))
  const storedEntries = readStoredEntries().filter((item) => !sameEntry(item, entry))
  writeStoredEntries(storedEntries)
}

async function flushPhoneCalls(accountId, sender) {
  if (typeof sender !== 'function') return { sent: 0, failed: 0, pending: pendingPhoneCalls(accountId).length }
  const entries = pendingPhoneCalls(accountId)
  let sent = 0
  let failed = 0
  for (const entry of entries) {
    try {
      await sender(entry.listingId, entry.idempotencyKey)
      removeEntry(entry)
      sent += 1
    } catch (error) {
      // 网络或服务端暂时失败时保留原幂等键；不记录错误正文，避免第三方错误夹带敏感信息。
      failed += 1
      // 账号/token 已变化时停止本轮，防止继续用新会话发送旧账号分区；当前项和后续项全部保留。
      if (error && error.stopOutboxFlush) break
    }
  }
  return { sent, failed, pending: pendingPhoneCalls(accountId).length }
}

function createPhoneCallIdempotencyKey() {
  const random = Math.random().toString(36).slice(2, 12)
  return `call_${Date.now().toString(36)}_${random}`
}

module.exports = {
  enqueuePhoneCall,
  pendingPhoneCalls,
  flushPhoneCalls,
  createPhoneCallIdempotencyKey
}
