const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client.js'))
const mapPagePath = require.resolve(path.join(repoRoot, 'pages', 'map', 'map.js'))
const mapWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'map', 'map.wxml'), 'utf8')
const { createPendingFilterEnvelope } = require(path.join(repoRoot, 'utils', 'pending-filter-storage.js'))

let storageShouldThrow = false
let authToken = ''
let authSessionKey = 'guest-map-start'
let toasts = []
let storageValues = {}
let publicReadFallbackSessionKey = ''
const authInvalidationListeners = new Set()

const apiClient = require(apiClientPath)
apiClient.isPublicReadAuthFallbackContinuation = (requestSessionKey) => (
  Boolean(publicReadFallbackSessionKey) && requestSessionKey === publicReadFallbackSessionKey
)
apiClient.subscribeAuthInvalidation = (listener) => {
  authInvalidationListeners.add(listener)
  return () => authInvalidationListeners.delete(listener)
}

function emitAuthInvalidation(event) {
  Array.from(authInvalidationListeners).forEach((listener) => listener(event))
}

global.getApp = () => ({ globalData: { authToken, authSessionKey } })

global.wx = {
  getStorageSync(key) {
    if (storageShouldThrow) throw new Error('模拟存储读取失败')
    return storageValues[key] || ''
  },
  removeStorageSync(key) { delete storageValues[key] },
  showToast(options) { toasts.push(options) },
  createMapContext() { return {} },
  navigateTo() {},
  switchTab() {}
}

function setAtPath(target, key, value) {
  const parts = key.split('.')
  let current = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current[parts[index]] || typeof current[parts[index]] !== 'object') current[parts[index]] = {}
    current = current[parts[index]]
  }
  current[parts[parts.length - 1]] = value
}

function makePage(definition) {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  return page
}

function loadDefinition(apiStub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[mapPagePath]
  require(mapPagePath)
  assert.ok(definition, '未捕获地图页面定义')
  return definition
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function mapCommunity(id = '可信小区') {
  return {
    id,
    community: id,
    latitude: 30.31,
    longitude: 120.17,
    coordinateLevel: 'verified',
    coordinateVerified: true,
    listingCount: 1,
    activeListingIds: [`${id}-L1`],
    listings: [{ id: `${id}-L1`, rent: 2800 }]
  }
}

async function run() {
  let requestShouldFail = true
  let requestCount = 0
  const apiStub = {
    getMapCommunities() {
      requestCount += 1
      return requestShouldFail
        ? Promise.reject(Object.assign(new Error('地图服务暂不可用'), { statusCode: 503 }))
        : Promise.resolve([mapCommunity('恢复小区')])
    }
  }
  const definition = loadDefinition(apiStub)
  const page = makePage(definition)
  const trusted = mapCommunity('上次可信小区')
  page.applyCommunities([trusted], true)
  const previousCommunities = JSON.parse(JSON.stringify(page.data.communities))
  const previousMarkers = JSON.parse(JSON.stringify(page.data.markers))
  const previousSummary = page.data.summaryText

  page.loadCommunities({ recenter: false })
  await flushPromises()
  assert.strictEqual(page.data.loadFailed, true, '地图网络/5xx 必须进入持续失败态')
  assert.strictEqual(page.data.loading, false, '地图失败后必须结束加载态')
  assert.deepStrictEqual(page.data.communities, previousCommunities, '地图刷新失败不得清空上次可信小区')
  assert.deepStrictEqual(page.data.markers, previousMarkers, '地图刷新失败不得清空上次可信点位')
  assert.strictEqual(page.data.summaryText, previousSummary, '地图刷新失败不得把可信统计改写成零房源')
  assert.ok(toasts.some((item) => /加载失败/.test(item.title)), '地图失败必须给出即时提示')
  assert.strictEqual(typeof page.retryMap, 'function', '地图失败态必须提供重试方法')

  requestShouldFail = false
  page.retryMap()
  await flushPromises()
  assert.strictEqual(requestCount, 2, '地图重试必须重新请求服务端')
  assert.strictEqual(page.data.loadFailed, false, '地图重试成功必须清除失败态')
  assert.strictEqual(page.data.communities[0].community, '恢复小区', '地图重试成功必须采用最新服务端结果')

  const initialFailureDefinition = loadDefinition({
    getMapCommunities() { return Promise.reject(new Error('初次加载失败')) }
  })
  const initialFailurePage = makePage(initialFailureDefinition)
  initialFailurePage.loadCommunities({ recenter: false })
  await flushPromises()
  assert.strictEqual(initialFailurePage.data.loadFailed, true, '地图初次失败必须显示失败态')
  assert.strictEqual(initialFailurePage.data.communities.length, 0, '地图初次失败可以保持无点位')
  assert.ok(!/暂无可上图/.test(initialFailurePage.data.summaryText), '地图初次失败不得把故障描述成零房源')

  let rejectStaleRequest = null
  let raceRequestCount = 0
  const raceDefinition = loadDefinition({
    getMapCommunities() {
      raceRequestCount += 1
      if (raceRequestCount === 1) {
        return new Promise((resolve, reject) => {
          rejectStaleRequest = reject
        })
      }
      return Promise.resolve([mapCommunity('最新筛选小区')])
    }
  })
  const racePage = makePage(raceDefinition)
  racePage.loadCommunities({ recenter: false })
  racePage.loadCommunities({ recenter: false })
  await flushPromises()
  rejectStaleRequest(new Error('过期请求失败'))
  await flushPromises()
  assert.strictEqual(racePage.data.loadFailed, false, '过期请求失败不得覆盖最新成功状态')
  assert.strictEqual(racePage.data.communities[0].community, '最新筛选小区', '竞态下必须保留最新请求结果')

  for (const target of [
    { token: '', sessionKey: 'guest-map-after-a', label: '退出到游客' },
    { token: 'TOKEN-MAP-B', sessionKey: 'auth-map-b', label: '切换到账号B' }
  ]) {
    authToken = 'TOKEN-MAP-A'
    authSessionKey = `auth-map-a-${target.label}`
    const sessionDefinition = loadDefinition({
      getMapCommunities() { return Promise.reject(new Error('新会话地图请求失败')) }
    })
    const sessionPage = makePage(sessionDefinition)
    sessionPage.setData({ 'filters.sourceType': '业主房源' })
    sessionPage.applyCommunities([mapCommunity('账号A合作小区')], true)
    sessionPage.loadCommunities({ recenter: false })
    await flushPromises()
    assert.strictEqual(sessionPage.data.communities.length, 1, '同一会话失败仍应保留账号A可信缓存，作为切换前提')

    authToken = target.token
    authSessionKey = target.sessionKey
    sessionPage.onShow()
    assert.strictEqual(sessionPage.data.communities.length, 0, `${target.label}时必须在请求返回前清空旧账号小区`)
    assert.strictEqual(sessionPage.data.markers.length, 0, `${target.label}时必须在请求返回前清空旧账号点位`)
    assert.strictEqual(sessionPage.data.selectedCommunity, null, `${target.label}时必须清空旧账号选中小区`)
    await flushPromises()
    assert.strictEqual(sessionPage.data.communities.length, 0, `${target.label}后的失败请求不得恢复旧账号缓存`)
  }

  authToken = 'TOKEN-MAP-LATE-A'
  authSessionKey = 'auth-map-late-a'
  let resolveLateMap = null
  const lateDefinition = loadDefinition({
    getMapCommunities() {
      return new Promise((resolve) => { resolveLateMap = resolve })
    }
  })
  const latePage = makePage(lateDefinition)
  latePage.loadCommunities({ recenter: false })
  authToken = ''
  authSessionKey = 'guest-map-late'
  resolveLateMap([mapCommunity('迟到的账号A小区')])
  await flushPromises()
  assert.strictEqual(latePage.data.communities.length, 0, '会话变化后迟到的账号A地图响应不得被采纳')

  authToken = 'TOKEN-MAP-EXPIRED'
  authSessionKey = 'auth-map-expired'
  const expiredMap = deferred()
  let expiredMapCalls = 0
  const expiredMapDefinition = loadDefinition({
    getMapCommunities() {
      expiredMapCalls += 1
      return expiredMapCalls === 1
        ? expiredMap.promise
        : Promise.resolve([mapCommunity('游客恢复地图小区')])
    }
  })
  const expiredMapPage = makePage(expiredMapDefinition)
  expiredMapPage.authSessionSnapshot = authSessionKey
  expiredMapPage.loadCommunities({ recenter: false })
  authToken = ''
  authSessionKey = 'guest-map-after-expiry'
  publicReadFallbackSessionKey = 'auth-map-expired'
  expiredMap.resolve([mapCommunity('旧会话匿名返回小区')])
  await flushPromises()
  await flushPromises()
  assert.strictEqual(expiredMapCalls, 2, '地图公共读取静默清态后必须用当前游客会话重新请求')
  assert.strictEqual(expiredMapPage.data.communities[0].community, '游客恢复地图小区', '地图不得因失效 token 清态而停留空白')
  assert.strictEqual(expiredMapPage.data.loading, false, '游客地图恢复请求完成后必须退出 loading')
  publicReadFallbackSessionKey = ''

  authToken = 'TOKEN-MAP-CHILD-REVOKE'
  authSessionKey = 'auth-map-child-revoke'
  let childRevokeMapCalls = 0
  const childRevokeMapDefinition = loadDefinition({
    getMapCommunities() {
      childRevokeMapCalls += 1
      return Promise.resolve([mapCommunity('公共地图恢复小区')])
    }
  })
  const childRevokeMapPage = makePage(childRevokeMapDefinition)
  childRevokeMapPage.authSessionSnapshot = authSessionKey
  childRevokeMapPage.setData({
    communities: [mapCommunity('旧账号地图小区')],
    filters: Object.assign({}, childRevokeMapPage.data.filters, {
      needId: 'NEED-MAP-OLD',
      listingIds: ['LISTING-MAP-OLD']
    })
  })
  childRevokeMapPage.bindAuthInvalidationListener()
  authToken = ''
  authSessionKey = 'guest-map-child-revoke'
  emitAuthInvalidation({
    reason: 'unauthorized',
    fromSessionKey: 'auth-map-child-revoke',
    toSessionKey: authSessionKey
  })
  assert.strictEqual(childRevokeMapPage.data.filters.needId, '', '收藏子组件 401 清态后地图必须立即移除旧账号 needId')
  assert.deepStrictEqual(childRevokeMapPage.data.filters.listingIds, [], '地图不得保留旧账号房源 ID 范围')
  await flushPromises()
  assert.strictEqual(childRevokeMapCalls, 1)
  assert.strictEqual(childRevokeMapPage.data.communities[0].community, '公共地图恢复小区')
  childRevokeMapPage.onUnload()

  authToken = 'TOKEN-MAP-UNLOAD'
  authSessionKey = 'auth-map-unload'
  const unloadMap = deferred()
  const unloadDefinition = loadDefinition({
    getMapCommunities() { return unloadMap.promise }
  })
  const unloadPage = makePage(unloadDefinition)
  const unloadToastCount = toasts.length
  unloadPage.loadCommunities({ recenter: false })
  assert.strictEqual(typeof unloadPage.onUnload, 'function', '地图页卸载时必须作废在途请求')
  unloadPage.onUnload()
  unloadMap.resolve([mapCommunity('卸载后迟到小区')])
  await flushPromises()
  assert.strictEqual(unloadPage.data.communities.length, 0, '地图页卸载后的迟到响应不得回写')
  assert.strictEqual(toasts.length, unloadToastCount, '地图页卸载后的迟到失败不得弹提示')

  let regionSuccess = null
  let nativeRequestCalls = 0
  const originalCreateMapContext = wx.createMapContext
  const originalGetLocation = wx.getLocation
  wx.createMapContext = () => ({
    getRegion(options) { regionSuccess = options.success }
  })
  const nativeDefinition = loadDefinition({
    getMapCommunities() {
      nativeRequestCalls += 1
      return Promise.resolve([mapCommunity('不应加载的小区')])
    }
  })
  const nativePage = makePage(nativeDefinition)
  nativePage._pageActive = true
  nativePage.searchCurrentRegion()
  nativePage.onUnload()
  regionSuccess({
    northeast: { latitude: 31, longitude: 121 },
    southwest: { latitude: 30, longitude: 120 }
  })
  await flushPromises()
  assert.strictEqual(nativeRequestCalls, 0, '地图页卸载后的 getRegion 回调不得重新发请求')

  let locationOptions = null
  wx.getLocation = (options) => { locationOptions = options }
  const locationPage = makePage(nativeDefinition)
  locationPage._pageActive = true
  const centerBeforeUnload = JSON.parse(JSON.stringify(locationPage.data.mapCenter))
  const locationToastCount = toasts.length
  locationPage.locateToMe()
  locationPage.onUnload()
  locationOptions.success({ latitude: 30.99, longitude: 120.99 })
  assert.deepStrictEqual(locationPage.data.mapCenter, centerBeforeUnload, '地图页卸载后的定位成功不得写回中心点')
  locationOptions.fail()
  assert.deepStrictEqual(locationPage.data.mapCenter, centerBeforeUnload, '地图页卸载后的定位失败不得写回默认中心点')
  assert.strictEqual(toasts.length, locationToastCount, '地图页卸载后的定位失败不得弹提示')
  wx.createMapContext = originalCreateMapContext
  wx.getLocation = originalGetLocation

  const pendingMapKey = 'ynzy_pending_map_filters'
  authToken = 'TOKEN-PENDING-MAP-B'
  authSessionKey = 'SESSION-PENDING-MAP-B'
  storageValues[pendingMapKey] = createPendingFilterEnvelope({
    needId: 'NEED-MAP-A',
    listingIds: ['LISTING-MAP-A'],
    sourceType: '业主房源'
  }, 'SESSION-PENDING-MAP-A')
  const pendingMapQueries = []
  const pendingMapDefinition = loadDefinition({
    getMapCommunities(query) {
      pendingMapQueries.push(query || {})
      return Promise.resolve([])
    }
  })
  const pendingMapPage = makePage(pendingMapDefinition)
  pendingMapPage.onShow()
  await flushPromises()
  assert.strictEqual(pendingMapPage.data.filters.needId, '', '账号B首次创建地图页不得消费账号A遗留 needId')
  assert.deepStrictEqual(pendingMapPage.data.filters.listingIds, [], '账号B不得消费账号A遗留房源 ID')
  assert.ok(pendingMapQueries.every((query) => !query.listingIds || !query.listingIds.length), '账号A房源 ID 不得进入账号B地图请求')
  assert.strictEqual(storageValues[pendingMapKey], undefined, 'owner 不匹配的地图筛选也必须一次性清理')

  authToken = 'TOKEN-PENDING-MAP-A'
  authSessionKey = 'SESSION-PENDING-MAP-A'
  storageValues[pendingMapKey] = createPendingFilterEnvelope({
    needId: 'NEED-MAP-A',
    listingIds: ['LISTING-MAP-A'],
    sourceType: '业主房源'
  }, 'SESSION-PENDING-MAP-A')
  const ownPendingMapPage = makePage(pendingMapDefinition)
  ownPendingMapPage.onShow()
  await flushPromises()
  assert.strictEqual(ownPendingMapPage.data.filters.needId, 'NEED-MAP-A', '同会话地图必须消费自己的 needId')
  assert.deepStrictEqual(ownPendingMapPage.data.filters.listingIds, ['LISTING-MAP-A'], '同会话地图必须消费自己的房源 ID')

  authToken = 'TOKEN-PENDING-MAP-SWITCH-A'
  authSessionKey = 'SESSION-PENDING-MAP-SWITCH-A'
  const switchedPendingMapPage = makePage(pendingMapDefinition)
  switchedPendingMapPage.authSessionSnapshot = authSessionKey
  authToken = 'TOKEN-PENDING-MAP-SWITCH-B'
  authSessionKey = 'SESSION-PENDING-MAP-SWITCH-B'
  storageValues[pendingMapKey] = createPendingFilterEnvelope({
    needId: 'NEED-MAP-B-FIRST',
    listingIds: ['LISTING-MAP-B-FIRST'],
    sourceType: '二房东房源'
  }, authSessionKey)
  switchedPendingMapPage.onShow()
  await flushPromises()
  assert.strictEqual(switchedPendingMapPage.data.filters.needId, 'NEED-MAP-B-FIRST', '换号后必须按当前会话 owner 消费账号B首次合法地图筛选')
  assert.deepStrictEqual(switchedPendingMapPage.data.filters.listingIds, ['LISTING-MAP-B-FIRST'], '助手换号后首次跳地图不得退化为全量地图')
  assert.strictEqual(storageValues[pendingMapKey], undefined, '换号后的合法地图筛选消费后必须一次性清理')

  storageShouldThrow = true
  const storageDefinition = loadDefinition({
    getMapCommunities() { return Promise.resolve([]) }
  })
  const storagePage = makePage(storageDefinition)
  assert.doesNotThrow(() => storagePage.onShow(), '待处理筛选存储异常不得中断地图页面展示')
  storageShouldThrow = false
  await flushPromises()

  for (const sourceType of ['业主房源', '二房东房源']) {
    authToken = ''
    authSessionKey = `guest-${sourceType}`
    const guestDefinition = loadDefinition({
      getMapCommunities() { return Promise.resolve([]) }
    })
    const guestPage = makePage(guestDefinition)
    guestPage.setData({ 'filters.sourceType': sourceType })
    guestPage.loadCommunities({ recenter: false })
    await flushPromises()
    assert.strictEqual(guestPage.data.loginRequired, undefined, `游客筛选${sourceType}不得出现登录门槛`)

    authToken = 'TOKEN-MAP-LOGIN'
    authSessionKey = `auth-${sourceType}`
    guestPage.onShow()
    await flushPromises()
    assert.strictEqual(guestPage.data.loginRequired, undefined, `登录前后${sourceType}筛选都只展示真实结果`)
  }

  assert.ok(/wx:if="\{\{loadFailed\}\}"/.test(mapWxml), '地图模板必须持续显示加载失败状态')
  assert.ok(/bindtap="retryMap"/.test(mapWxml), '地图模板必须绑定重试入口')
  assert.ok(/!loading && !loadFailed && !communities\.length/.test(mapWxml), '地图故障时不得显示零房源空态')
  assert.ok(!/loginRequired|bindtap="goLogin"|登录后查看业主和二房东/.test(mapWxml), '地图合作房源筛选不得保留登录空态')

  console.log('map-loading-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
