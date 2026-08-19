'use strict'

// 游客公开投影的跨请求上下文缓存。调用方仍须用完整敏感字段生成 contextKey；
// 本模块只负责有界复用和容量边界，绝不判断哪些字段可以公开。
function createGuestPublicContextCache(options = {}) {
  const requestedLimit = Number(options.limit)
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 8192
  const createEntry = typeof options.createEntry === 'function'
    ? options.createEntry
    : (contextKey) => ({ contextKey })
  let objectCache = new WeakMap()
  const fingerprintCache = new Map()
  const counters = {
    contextHits: 0,
    contextMisses: 0,
    objectHits: 0,
    overflowMisses: 0,
    admissions: 0,
    evictions: 0,
    preparations: 0
  }

  function resetStats() {
    Object.keys(counters).forEach((key) => {
      counters[key] = 0
    })
  }

  function stats() {
    return {
      ...counters,
      cacheSize: fingerprintCache.size,
      limit
    }
  }

  function prepare(contextKeys) {
    const activeKeys = new Set(Array.from(contextKeys || [], (item) => String(item || '')))
    counters.preparations += 1
    fingerprintCache.forEach((cachedEntry, contextKey) => {
      if (activeKeys.has(contextKey)) return
      fingerprintCache.delete(contextKey)
      if (cachedEntry && typeof cachedEntry === 'object') cachedEntry.admitted = false
      counters.evictions += 1
    })
    return activeKeys.size
  }

  function admit(entryValue, contextKey) {
    if (fingerprintCache.size >= limit) {
      if (entryValue && typeof entryValue === 'object') entryValue.admitted = false
      counters.overflowMisses += 1
      return entryValue
    }
    if (entryValue && typeof entryValue === 'object') entryValue.admitted = true
    fingerprintCache.set(contextKey, entryValue)
    counters.admissions += 1
    return entryValue
  }

  function entry(listing, contextKey) {
    const key = String(contextKey || '')
    const objectListing = listing && typeof listing === 'object' ? listing : null
    const objectEntry = objectListing ? objectCache.get(objectListing) : null
    if (objectEntry && objectEntry.contextKey === key) {
      counters.objectHits += 1
      counters.contextHits += 1
      const fingerprintEntry = fingerprintCache.get(key)
      if (fingerprintEntry && fingerprintEntry !== objectEntry) {
        objectCache.set(objectListing, fingerprintEntry)
        return fingerprintEntry
      }
      if (!fingerprintEntry) admit(objectEntry, key)
      return objectEntry
    }

    const fingerprintEntry = fingerprintCache.get(key)
    if (fingerprintEntry) {
      counters.contextHits += 1
      if (objectListing) objectCache.set(objectListing, fingerprintEntry)
      return fingerprintEntry
    }

    counters.contextMisses += 1
    let created = createEntry(key)
    if (!created || typeof created !== 'object') created = { value: created }
    created.contextKey = key
    admit(created, key)
    if (objectListing) objectCache.set(objectListing, created)
    return created
  }

  function clear() {
    fingerprintCache.clear()
    objectCache = new WeakMap()
    resetStats()
  }

  return {
    entry,
    prepare,
    stats,
    resetStats,
    clear
  }
}

module.exports = {
  createGuestPublicContextCache
}
