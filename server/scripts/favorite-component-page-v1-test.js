'use strict'

const assert = require('assert')

const storePath = require.resolve('../../utils/favorite-store')
const componentPath = require.resolve('../../components/favorite-toggle/favorite-toggle.js')
const apiServicePath = require.resolve('../../utils/api-service')
const apiClientPath = require.resolve('../../utils/api-client')
const favoritesPagePath = require.resolve('../../pages/favorites/favorites.js')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

function instantiate(definition, properties = {}) {
  const instance = {
    properties: { ...properties },
    data: JSON.parse(JSON.stringify(definition.data || {})),
    events: [],
    setData(patch, callback) {
      Object.keys(patch || {}).forEach((key) => {
        if (!key.includes('[')) this.data[key] = patch[key]
      })
      if (callback) callback()
    },
    triggerEvent(name, detail) {
      this.events.push({ name, detail })
    }
  }
  Object.entries(definition.methods || {}).forEach(([name, method]) => {
    instance[name] = method.bind(instance)
  })
  return instance
}

async function runComponentBehavior() {
  const write = deferred()
  let setCalls = 0
  let modalCalls = 0
  let toastCalls = 0
  let fakeToken = 'TOKEN_A'
  const fakeStore = {
    hasLogin: () => true,
    isFavorite: () => false,
    load: () => Promise.resolve([]),
    subscribe: () => () => {},
    sessionToken: () => fakeToken,
    setFavorite: () => {
      setCalls += 1
      return write.promise
    }
  }
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore }
  delete require.cache[componentPath]
  let definition
  global.Component = (value) => { definition = value }
  global.wx = {
    showModal: () => { modalCalls += 1 },
    showToast: () => { toastCalls += 1 },
    navigateTo: () => {}
  }
  require(componentPath)
  assert.ok(definition, '星标组件必须注册')

  const component = instantiate(definition, { listingId: 'L1', compact: false })
  definition.lifetimes.attached.call(component)
  await tick()
  component.toggleFavorite()
  component.toggleFavorite()
  assert.strictEqual(setCalls, 1, 'busy 期间重复点击只能发一个请求')
  assert.strictEqual(component.data.busy, true)

  // 组件被列表复用到另一房源时必须立即解除旧 busy，旧请求完成不得向新房源发事件。
  component.properties.listingId = 'L2'
  definition.properties.listingId.observer.call(component, 'L2', 'L1')
  assert.strictEqual(component.data.busy, false, 'listingId 复用后新房源不能被旧请求永久禁用')
  write.resolve({ listingId: 'L1', isFavorited: true })
  await tick()
  assert.deepStrictEqual(component.events, [], '旧房源迟到成功不得向复用后的组件发事件')
  assert.strictEqual(toastCalls, 0, '旧房源迟到成功不得显示新房源成功提示')
  definition.lifetimes.detached.call(component)

  fakeStore.hasLogin = () => false
  fakeToken = ''
  const guest = instantiate(definition, { listingId: 'L3', compact: false })
  definition.lifetimes.attached.call(guest)
  await tick()
  guest.toggleFavorite()
  assert.strictEqual(modalCalls, 1, '游客点击只弹登录引导')
  assert.strictEqual(setCalls, 1, '游客不得产生收藏写请求')
  definition.lifetimes.detached.call(guest)

  // 首次收藏 ID 尚未加载时，点击意图必须等同步完成后按真实状态计算；原本已收藏应发 DELETE。
  const initialLoad = deferred()
  const delayedCalls = []
  let existingFavorite = false
  fakeStore.hasLogin = () => true
  fakeStore.load = () => initialLoad.promise
  fakeStore.isFavorite = () => existingFavorite
  fakeStore.setFavorite = (listingId, desired) => {
    delayedCalls.push({ listingId, desired })
    return Promise.resolve({ listingId, isFavorited: desired })
  }
  const delayed = instantiate(definition, { listingId: 'EXISTING', compact: false })
  definition.lifetimes.attached.call(delayed)
  delayed.toggleFavorite()
  existingFavorite = true
  initialLoad.resolve(['EXISTING'])
  await tick()
  await tick()
  assert.deepStrictEqual(delayedCalls, [{ listingId: 'EXISTING', desired: false }], '首次同步完成后必须执行用户原本的取消意图')
  definition.lifetimes.detached.call(delayed)

  // 同步期缓存的点击必须绑定点击时账号；A 点击后切 B，A 的迟到同步不得替 B 写收藏。
  const switchedLoad = deferred()
  const switchedCalls = []
  fakeToken = 'TOKEN_A'
  existingFavorite = false
  fakeStore.load = () => switchedLoad.promise
  fakeStore.isFavorite = () => false
  fakeStore.setFavorite = (listingId, desired) => {
    switchedCalls.push({ token: fakeToken, listingId, desired })
    return Promise.resolve({ listingId, isFavorited: desired })
  }
  const switched = instantiate(definition, { listingId: 'SWITCHED', compact: false })
  definition.lifetimes.attached.call(switched)
  switched.toggleFavorite()
  const toastBeforeAccountSwitch = toastCalls
  fakeToken = 'TOKEN_B'
  switchedLoad.reject(Object.assign(new Error('stale account'), { staleSession: true }))
  await tick()
  await tick()
  assert.deepStrictEqual(switchedCalls, [], 'A 同步期点击不得在切到 B 后落库')
  assert.strictEqual(toastCalls, toastBeforeAccountSwitch, 'A 的同步失败不得在 B 显示提示')
  definition.lifetimes.detached.call(switched)

  // 组件卸载后写请求迟到，不得再触发父页事件或全局成功提示。
  const detachedWrite = deferred()
  fakeStore.load = () => Promise.resolve([])
  fakeStore.setFavorite = () => detachedWrite.promise
  fakeStore.isFavorite = () => false
  const detached = instantiate(definition, { listingId: 'DETACHED', compact: false })
  definition.lifetimes.attached.call(detached)
  await tick()
  const toastBeforeDetach = toastCalls
  detached.toggleFavorite()
  definition.lifetimes.detached.call(detached)
  detachedWrite.resolve({ listingId: 'DETACHED', isFavorited: true })
  await tick()
  assert.deepStrictEqual(detached.events, [], '卸载组件不得接收旧写请求事件')
  assert.strictEqual(toastCalls, toastBeforeDetach, '卸载组件不得显示旧写请求成功提示')

  // 首次同步失败后，下一次点击必须先重试 GET；恢复后按服务端已收藏状态发 DELETE。
  const recoveredLoad = deferred()
  const recoveryCalls = []
  let recoveryLoadCount = 0
  let recoveredFavorite = false
  fakeToken = 'TOKEN_RECOVERY'
  fakeStore.load = () => {
    recoveryLoadCount += 1
    return recoveryLoadCount === 1 ? Promise.reject(new Error('first-load-failure')) : recoveredLoad.promise
  }
  fakeStore.isFavorite = () => recoveredFavorite
  fakeStore.setFavorite = (listingId, desired) => {
    recoveryCalls.push({ listingId, desired })
    return Promise.resolve({ listingId, isFavorited: desired })
  }
  const recovery = instantiate(definition, { listingId: 'RECOVERY', compact: false })
  definition.lifetimes.attached.call(recovery)
  await tick()
  recovery.toggleFavorite()
  assert.strictEqual(recoveryLoadCount, 2, '首次失败后的点击必须先重试同步')
  assert.deepStrictEqual(recoveryCalls, [], '状态未知时不得直接写收藏')
  recoveredFavorite = true
  recoveredLoad.resolve(['RECOVERY'])
  await tick()
  await tick()
  assert.deepStrictEqual(recoveryCalls, [{ listingId: 'RECOVERY', desired: false }])
  definition.lifetimes.detached.call(recovery)

  // 重试 GET 仍失败时保持零写入。
  const failedRecoveryCalls = []
  fakeToken = 'TOKEN_FAIL_AGAIN'
  fakeStore.load = () => Promise.reject(new Error('still-failing'))
  fakeStore.isFavorite = () => false
  fakeStore.setFavorite = (listingId, desired) => {
    failedRecoveryCalls.push({ listingId, desired })
    return Promise.resolve({ listingId, isFavorited: desired })
  }
  const failedRecovery = instantiate(definition, { listingId: 'FAIL_AGAIN', compact: false })
  definition.lifetimes.attached.call(failedRecovery)
  await tick()
  failedRecovery.toggleFavorite()
  await tick()
  assert.deepStrictEqual(failedRecoveryCalls, [], '同步持续失败时不得按默认空星写入')
  definition.lifetimes.detached.call(failedRecovery)

  // A 已同步后直接切 B 并点击，也必须先拉 B 状态。
  const loadB = deferred()
  let accountLoadCount = 0
  const accountCalls = []
  fakeToken = 'TOKEN_READY_A'
  fakeStore.load = () => {
    accountLoadCount += 1
    return accountLoadCount === 1 ? Promise.resolve([]) : loadB.promise
  }
  fakeStore.isFavorite = () => false
  fakeStore.setFavorite = (listingId, desired) => {
    accountCalls.push({ token: fakeToken, listingId, desired })
    return Promise.resolve({ listingId, isFavorited: desired })
  }
  const accountSwitch = instantiate(definition, { listingId: 'ACCOUNT_SWITCH', compact: false })
  definition.lifetimes.attached.call(accountSwitch)
  await tick()
  fakeToken = 'TOKEN_READY_B'
  accountSwitch.toggleFavorite()
  assert.strictEqual(accountLoadCount, 2, '切 B 后点击必须先拉 B 收藏状态')
  assert.deepStrictEqual(accountCalls, [])
  loadB.resolve([])
  await tick()
  await tick()
  assert.deepStrictEqual(accountCalls, [{ token: 'TOKEN_READY_B', listingId: 'ACCOUNT_SWITCH', desired: true }])
  definition.lifetimes.detached.call(accountSwitch)
}

function instantiatePage(definition, data) {
  const page = {
    data: JSON.parse(JSON.stringify(data || definition.data || {})),
    setData(patch, callback) {
      Object.keys(patch || {}).forEach((key) => {
        const arrayMatch = key.match(/^(\w+)\[(\d+)\]\.(\w+)$/)
        if (arrayMatch) {
          this.data[arrayMatch[1]][Number(arrayMatch[2])][arrayMatch[3]] = patch[key]
        } else {
          this.data[key] = patch[key]
        }
      })
      if (callback) callback()
    }
  }
  Object.entries(definition).forEach(([name, value]) => {
    if (typeof value === 'function') page[name] = value.bind(page)
  })
  return page
}

async function runPageBehavior() {
  let pageToken = 'TOKEN_A'
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: { getAuthToken: () => pageToken }
  }
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: { getFavorites: () => Promise.resolve([]) }
  }
  delete require.cache[favoritesPagePath]
  let definition
  global.Page = (value) => { definition = value }
  let navigated = ''
  let toastCount = 0
  global.wx = {
    navigateTo: ({ url }) => { navigated = url },
    showToast: () => { toastCount += 1 }
  }
  require(favoritesPagePath)
  const page = instantiatePage(definition, {
    ...definition.data,
    favorites: [
      { id: 'DOWN', isAvailable: false, coverUrl: 'old-cover' },
      { id: 'UP', isAvailable: true, coverUrl: 'new-cover' }
    ]
  })

  page.openListing({ currentTarget: { dataset: { id: 'DOWN', available: true } } })
  assert.strictEqual(navigated, '', '不可用状态必须来自服务端行，不能信任 dataset.available')
  assert.strictEqual(toastCount, 1)
  page.openListing({ currentTarget: { dataset: { id: 'UP', available: false } } })
  assert.ok(navigated.includes('id=UP'), '服务端可用行才允许进入详情')

  page.onCoverError({ currentTarget: { dataset: { id: 'UP', cover: 'stale-cover' } } })
  assert.strictEqual(page.data.favorites[1].coverUrl, 'new-cover', '旧封面迟到错误不得清掉新 URL')
  page.onCoverError({ currentTarget: { dataset: { id: 'UP', cover: 'new-cover' } } })
  assert.strictEqual(page.data.favorites[1].coverUrl, '', '当前封面真实失败才清空')

  // 即使 Date.now/Math.random 碰撞，快速连续筛选也只能采纳最后一次请求。
  const pending = [deferred(), deferred(), deferred(), deferred()]
  let callIndex = 0
  require.cache[apiServicePath].exports.getFavorites = () => pending[callIndex++].promise
  const originalNow = Date.now
  const originalRandom = Math.random
  Date.now = () => 1700000000000
  Math.random = () => 0
  try {
    page.loadFavorites()
    page.loadFavorites()
    pending[2].resolve([{ id: 'NEW', isAvailable: true }])
    pending[3].resolve([{ id: 'NEW', isAvailable: true }])
    await tick()
    pending[0].resolve([{ id: 'OLD', isAvailable: true }])
    pending[1].resolve([{ id: 'OLD', isAvailable: true }])
    await tick()
    assert.deepStrictEqual(page.data.favorites.map((item) => item.id), ['NEW'], '旧筛选响应不得覆盖新结果')
  } finally {
    Date.now = originalNow
    Math.random = originalRandom
  }

  // token A 的列表成功/失败迟到都不能写入 token B 页面；B 的新请求可以正常落地。
  const tokenA = [deferred(), deferred()]
  callIndex = 0
  require.cache[apiServicePath].exports.getFavorites = () => tokenA[callIndex++].promise
  pageToken = 'TOKEN_A'
  page.loadFavorites()
  pageToken = 'TOKEN_B'
  tokenA[0].resolve([{ id: 'TOKEN_A_ROW', isAvailable: true }])
  tokenA[1].resolve([{ id: 'TOKEN_A_ROW', isAvailable: true }])
  await tick()
  assert.deepStrictEqual(page.data.favorites, [], 'A 成功迟到时必须清掉页面残留的 A 账号行')

  const tokenB = [deferred(), deferred()]
  callIndex = 0
  require.cache[apiServicePath].exports.getFavorites = () => tokenB[callIndex++].promise
  page.loadFavorites()
  tokenB[0].resolve([{ id: 'TOKEN_B_ROW', isAvailable: true }])
  tokenB[1].resolve([{ id: 'TOKEN_B_ROW', isAvailable: true }])
  await tick()
  assert.deepStrictEqual(page.data.favorites.map((item) => item.id), ['TOKEN_B_ROW'])

  const tokenC = [deferred(), deferred()]
  callIndex = 0
  require.cache[apiServicePath].exports.getFavorites = () => tokenC[callIndex++].promise
  pageToken = 'TOKEN_C'
  page.loadFavorites()
  assert.deepStrictEqual(page.data.favorites, [], '换号发请求时必须立即清空旧账号收藏')
  assert.deepStrictEqual(page.data.communityOptions, [], '换号发请求时必须立即清空旧账号小区选项')
  tokenC[0].resolve([{ id: 'TOKEN_C_ROW', isAvailable: true }])
  tokenC[1].resolve([{ id: 'TOKEN_C_ROW', isAvailable: true }])
  await tick()
  assert.deepStrictEqual(page.data.favorites.map((item) => item.id), ['TOKEN_C_ROW'])

  const toastBeforeOldFailure = toastCount
  const oldFailure = [deferred(), deferred()]
  callIndex = 0
  require.cache[apiServicePath].exports.getFavorites = () => oldFailure[callIndex++].promise
  pageToken = 'TOKEN_A'
  page.loadFavorites()
  pageToken = 'TOKEN_B'
  oldFailure[0].reject(new Error('old-token-failure'))
  oldFailure[1].reject(new Error('old-token-failure'))
  await tick()
  assert.strictEqual(page.data.loadFailed, false, 'A 失败迟到不得污染 B 的失败态')
  assert.strictEqual(toastCount, toastBeforeOldFailure, 'A 失败迟到不得在 B 显示提示')

  // 取消成功必须使在途旧列表失效，旧 GET 不得把刚取消的卡片加回来。
  pageToken = 'TOKEN_B'
  page._favoriteAccountToken = 'TOKEN_B'
  page.setData({ favorites: [{ id: 'CANCELLED', isAvailable: true }] })
  const cancelPending = [deferred(), deferred(), deferred(), deferred()]
  callIndex = 0
  require.cache[apiServicePath].exports.getFavorites = () => cancelPending[callIndex++].promise
  page.loadFavorites()
  page.handleFavoriteChange({ detail: { listingId: 'CANCELLED', favorited: false } })
  cancelPending[2].resolve([{ id: 'CURRENT', isAvailable: true }])
  cancelPending[3].resolve([{ id: 'CURRENT', isAvailable: true }])
  await tick()
  cancelPending[0].resolve([{ id: 'CANCELLED', isAvailable: true }])
  cancelPending[1].resolve([{ id: 'CANCELLED', isAvailable: true }])
  await tick()
  assert.deepStrictEqual(page.data.favorites.map((item) => item.id), ['CURRENT'], '取消成功后必须重拉当前筛选且旧列表不得回填')

  // 页面卸载必须使当前代次失效，迟到成功不能再 setData。
  const unloadPending = [deferred(), deferred()]
  callIndex = 0
  require.cache[apiServicePath].exports.getFavorites = () => unloadPending[callIndex++].promise
  page.loadFavorites()
  page.onUnload()
  unloadPending[0].resolve([{ id: 'AFTER_UNLOAD', isAvailable: true }])
  unloadPending[1].resolve([{ id: 'AFTER_UNLOAD', isAvailable: true }])
  await tick()
  assert.deepStrictEqual(page.data.favorites.map((item) => item.id), ['CURRENT'], '卸载后迟到响应不得更新页面')
}

async function run() {
  await runComponentBehavior()
  await runPageBehavior()
  console.log('favorite-component-page-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
