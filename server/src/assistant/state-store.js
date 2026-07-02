const { safeNeed } = require('./safety')

const THREAD_TTL_MS = 2 * 60 * 60 * 1000
const threads = new Map()

function createThreadId() {
  const randomPart = Math.random().toString(36).slice(2, 8)
  return `AST-${Date.now().toString(36)}-${randomPart}`
}

function pruneExpired(now = Date.now()) {
  threads.forEach((value, key) => {
    if (!value || now - Number(value.updatedAt || 0) > THREAD_TTL_MS) {
      threads.delete(key)
    }
  })
}

function resolveThreadId(threadId) {
  pruneExpired()
  return String(threadId || '').trim() || createThreadId()
}

function getThread(threadId) {
  pruneExpired()
  return threads.get(threadId) || null
}

function saveThread(threadId, patch = {}) {
  const previous = threads.get(threadId) || {}
  const next = {
    ...previous,
    ...patch,
    need: patch.need ? safeNeed(patch.need) : previous.need,
    updatedAt: Date.now()
  }
  threads.set(threadId, next)
  return next
}

function resetForTest() {
  threads.clear()
}

module.exports = {
  resolveThreadId,
  getThread,
  saveThread,
  _internal: {
    createThreadId,
    resetForTest,
    threads
  }
}
