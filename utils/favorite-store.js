const apiClient = require('./api-client')
const apiService = require('./api-service')

let activeToken = ''
let loaded = false
let favoriteIds = new Set()
let loadPromise = null
let sessionVersion = 0
let mutationRevision = 0
let operationVersion = 0
let confirmedStates = new Map()
let mutationRevisions = new Map()
const listeners = new Set()
const operations = new Map()
const queues = new Map()

function currentToken() {
  return String(apiClient.getAuthToken() || '')
}

function emit() {
  const snapshot = {
    token: activeToken,
    ids: Array.from(favoriteIds)
  }
  listeners.forEach((listener) => {
    try {
      listener(snapshot)
    } catch (error) {}
  })
}

function bindCurrentToken() {
  const token = currentToken()
  if (token === activeToken) return token
  activeToken = token
  loaded = false
  favoriteIds = new Set()
  confirmedStates = new Map()
  mutationRevisions = new Map()
  loadPromise = null
  sessionVersion += 1
  mutationRevision = 0
  operations.clear()
  queues.clear()
  emit()
  return token
}

function hasLogin() {
  return Boolean(bindCurrentToken())
}

function sessionToken() {
  return bindCurrentToken()
}

function isFavorite(listingId) {
  bindCurrentToken()
  return favoriteIds.has(String(listingId || ''))
}

function load(options = {}) {
  const token = bindCurrentToken()
  if (!token) return Promise.resolve([])
  if (loadPromise) return loadPromise
  if (loaded && !options.force) return Promise.resolve(Array.from(favoriteIds))

  const requestToken = token
  const requestSession = sessionVersion
  const requestMutationRevision = mutationRevision
  const request = apiService.getFavoriteIds().then((ids) => {
    if (bindCurrentToken() !== requestToken || sessionVersion !== requestSession) throw staleSessionError()
    const serverIds = new Set((ids || []).map((id) => String(id || '')).filter(Boolean))
    const nextConfirmedStates = new Map(Array.from(serverIds).map((id) => [id, true]))
    // GET 在途期间或仍在排队的显式 PUT/DELETE 只覆盖对应房源；服务端返回的其他既有收藏必须合并保留。
    mutationRevisions.forEach((revision, id) => {
      if (revision <= requestMutationRevision && !operations.has(id)) return
      if (favoriteIds.has(id)) serverIds.add(id)
      else serverIds.delete(id)
      nextConfirmedStates.set(id, confirmedStates.get(id) === true)
    })
    favoriteIds = serverIds
    confirmedStates = nextConfirmedStates
    mutationRevisions.forEach((revision, id) => {
      if (revision <= requestMutationRevision && !operations.has(id)) mutationRevisions.delete(id)
    })
    loaded = true
    emit()
    return Array.from(favoriteIds)
  })
  loadPromise = request.finally(() => {
    if (loadPromise === request || loadPromise === wrapped) loadPromise = null
  })
  const wrapped = loadPromise
  return wrapped
}

function applyFavoriteState(listingId, desired) {
  mutationRevision += 1
  mutationRevisions.set(listingId, mutationRevision)
  if (desired) favoriteIds.add(listingId)
  else favoriteIds.delete(listingId)
  loaded = true
  emit()
}

function authRequiredError() {
  const error = new Error('请先登录内部中介账号')
  error.statusCode = 401
  return error
}

function staleSessionError() {
  const error = new Error('登录账号已切换')
  error.staleSession = true
  return error
}

function setFavorite(listingId, desired) {
  const id = String(listingId || '').trim()
  if (!id) return Promise.reject(new Error('缺少房源编号'))
  const token = bindCurrentToken()
  if (!token) return Promise.reject(authRequiredError())
  const target = Boolean(desired)
  const current = operations.get(id)
  if (current && current.token === token && current.desired === target) return current.promise

  const requestSession = sessionVersion
  const version = ++operationVersion
  if (!confirmedStates.has(id)) confirmedStates.set(id, favoriteIds.has(id))
  applyFavoriteState(id, target)

  const queueKey = `${requestSession}:${id}`
  const previousQueue = queues.get(queueKey) || Promise.resolve()
  const request = previousQueue.catch(() => undefined).then(() => {
    if (bindCurrentToken() !== token || sessionVersion !== requestSession) {
      throw staleSessionError()
    }
    return apiService.setFavorite(id, target)
  })

  const publicPromise = request.then((result) => {
    if (bindCurrentToken() !== token || sessionVersion !== requestSession) throw staleSessionError()
    confirmedStates.set(id, target)
    const latest = operations.get(id)
    if (latest && latest.version === version) {
      applyFavoriteState(id, target)
    }
    return result
  }).catch((error) => {
    if (bindCurrentToken() !== token || sessionVersion !== requestSession) throw staleSessionError()
    const latest = operations.get(id)
    if (latest && latest.version === version) {
      applyFavoriteState(id, confirmedStates.get(id) === true)
    }
    throw error
  }).finally(() => {
    const latest = operations.get(id)
    if (latest && latest.version === version) operations.delete(id)
    if (queues.get(queueKey) === publicPromise) queues.delete(queueKey)
  })

  operations.set(id, { token, desired: target, version, promise: publicPromise })
  queues.set(queueKey, publicPromise)
  return publicPromise
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function reset() {
  activeToken = currentToken()
  loaded = false
  favoriteIds = new Set()
  confirmedStates = new Map()
  mutationRevisions = new Map()
  loadPromise = null
  sessionVersion += 1
  mutationRevision = 0
  operations.clear()
  queues.clear()
  emit()
}

module.exports = {
  hasLogin,
  sessionToken,
  isFavorite,
  load,
  setFavorite,
  subscribe,
  reset
}
