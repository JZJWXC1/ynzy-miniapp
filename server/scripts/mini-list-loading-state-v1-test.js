const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const indexPagePath = require.resolve(path.join(repoRoot, 'pages', 'index', 'index.js'))
const listingsPagePath = require.resolve(path.join(repoRoot, 'pages', 'listings', 'listings.js'))
const myListingsPagePath = require.resolve(path.join(repoRoot, 'pages', 'my-listings', 'my-listings.js'))
const listingDisplay = require(path.join(repoRoot, 'utils', 'listing-display.js'))
const { createPendingFilterEnvelope } = require(path.join(repoRoot, 'utils', 'pending-filter-storage.js'))

const indexWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'index', 'index.wxml'), 'utf8')
const listingsWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'listings', 'listings.wxml'), 'utf8')
const myListingsWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'my-listings', 'my-listings.wxml'), 'utf8')

let toasts = []
let authToken = 'TOKEN-LIST-BASE'
let authSessionKey = 'auth-list-base'
let storageValues = {}

global.getApp = () => ({ globalData: { authToken, authSessionKey } })

global.wx = {
  showToast(options) { toasts.push(options) },
  getStorageSync(key) { return storageValues[key] || '' },
  removeStorageSync(key) { delete storageValues[key] },
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

function loadDefinition(pagePath, apiStub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[pagePath]
  require(pagePath)
  assert.ok(definition, `未捕获页面定义：${pagePath}`)
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

async function run() {
  let homeShouldFail = true
  const homeApi = {
    getHomeListings() {
      return homeShouldFail
        ? Promise.reject(new Error('首页房源服务失败'))
        : Promise.resolve([{ id: 'HOME-NEW', title: '最新首页房源' }])
    }
  }
  const indexDefinition = loadDefinition(indexPagePath, homeApi)
  const indexPage = makePage(indexDefinition)
  indexPage.setData({ listings: [{ id: 'HOME-OLD', title: '上次可信首页房源' }] })
  assert.strictEqual(typeof indexPage.loadHomeListings, 'function', '首页必须有独立可重试的房源加载方法')
  indexPage.loadHomeListings()
  assert.strictEqual(indexPage.data.listingsLoading, true, '首页请求周期必须立即进入加载态')
  await flushPromises()
  assert.strictEqual(indexPage.data.listingsLoadFailed, true, '首页请求失败必须进入持续失败态')
  assert.deepStrictEqual(indexPage.data.listings.map((item) => item.id), ['HOME-OLD'], '首页刷新失败必须保留上次可信房源')
  assert.strictEqual(typeof indexPage.retryHomeListings, 'function', '首页失败态必须提供重试方法')
  homeShouldFail = false
  indexPage.retryHomeListings()
  await flushPromises()
  assert.strictEqual(indexPage.data.listingsLoadFailed, false, '首页重试成功必须清除失败态')
  assert.deepStrictEqual(indexPage.data.listings.map((item) => item.id), ['HOME-NEW'], '首页重试成功必须采用最新结果')

  let resolveOldHome = null
  let homeRaceCount = 0
  const raceDefinition = loadDefinition(indexPagePath, {
    getHomeListings() {
      homeRaceCount += 1
      if (homeRaceCount === 1) {
        return new Promise((resolve) => {
          resolveOldHome = resolve
        })
      }
      return Promise.resolve([{ id: 'HOME-LATEST' }])
    }
  })
  const racePage = makePage(raceDefinition)
  racePage.loadHomeListings()
  racePage.loadHomeListings()
  await flushPromises()
  resolveOldHome([{ id: 'HOME-STALE' }])
  await flushPromises()
  assert.strictEqual(racePage.data.listings[0].id, 'HOME-LATEST', '首页过期响应不得覆盖最新刷新结果')

  for (const target of [
    { token: '', sessionKey: 'guest-home-after-a', label: '退出到游客' },
    { token: 'TOKEN-HOME-B', sessionKey: 'auth-home-b', label: '切换到账号B' }
  ]) {
    authToken = 'TOKEN-HOME-A'
    authSessionKey = `auth-home-a-${target.label}`
    let mode = 'success'
    const homeSessionDefinition = loadDefinition(indexPagePath, {
      getHomeListings() {
        return mode === 'success'
          ? Promise.resolve([{ id: 'HOME-A-PRIVATE' }])
          : Promise.reject(new Error('新会话首页请求失败'))
      },
      getTodayTasks() {
        return mode === 'success'
          ? Promise.resolve({
            tasks: [{ type: 'maintenance', title: '账号A维护任务', count: 1 }],
            summary: { pendingCount: 1, updatedAt: 'synthetic' }
          })
          : Promise.reject(new Error('新会话任务请求失败'))
      },
      getCompanySheetSnapshot() { return Promise.resolve({ rows: [] }) }
    })
    const homeSessionPage = makePage(homeSessionDefinition)
    homeSessionPage.authSessionSnapshot = authSessionKey
    homeSessionPage.loadHomeListings()
    homeSessionPage.loadTodayTasks()
    await flushPromises()
    assert.deepStrictEqual(homeSessionPage.data.listings.map((item) => item.id), ['HOME-A-PRIVATE'])
    assert.strictEqual(homeSessionPage.data.todayTasks.length, 1, '账号A任务应先成功落地')

    mode = 'fail'
    homeSessionPage._heavyLoadedAt = Date.now()
    authToken = target.token
    authSessionKey = target.sessionKey
    homeSessionPage.onShow()
    assert.strictEqual(homeSessionPage.data.listings.length, 0, `${target.label}时必须立即清空账号A首页合作房源`)
    assert.strictEqual(homeSessionPage.data.todayTasks.length, 0, `${target.label}时必须绕过60秒缓存并立即清空账号A任务`)
    assert.strictEqual(homeSessionPage.data.visibleTodayTasks.length, 0, `${target.label}时不得保留账号A任务视图`)
    assert.strictEqual(homeSessionPage.data.taskSummary.pendingCount, 0, `${target.label}时不得保留账号A任务统计`)
    await flushPromises()
    assert.strictEqual(homeSessionPage.data.listings.length, 0, `${target.label}后的失败请求不得恢复账号A首页房源`)
    assert.strictEqual(homeSessionPage.data.todayTasks.length, 0, `${target.label}后的失败请求不得恢复账号A任务`)
  }

  authToken = 'TOKEN-HOME-LATE-A'
  authSessionKey = 'auth-home-late-a'
  const lateHome = deferred()
  const lateTasks = deferred()
  const lateHomeDefinition = loadDefinition(indexPagePath, {
    getHomeListings() { return lateHome.promise },
    getTodayTasks() { return lateTasks.promise },
    getCompanySheetSnapshot() { return Promise.resolve({ rows: [] }) }
  })
  const lateHomePage = makePage(lateHomeDefinition)
  lateHomePage.authSessionSnapshot = authSessionKey
  lateHomePage.loadHomeListings()
  lateHomePage.loadTodayTasks()
  authToken = 'TOKEN-HOME-LATE-B'
  authSessionKey = 'auth-home-late-b'
  lateHome.resolve([{ id: 'HOME-A-LATE' }])
  lateTasks.resolve({
    tasks: [{ type: 'maintenance', title: '迟到的账号A任务', count: 1 }],
    summary: { pendingCount: 1, updatedAt: 'synthetic' }
  })
  await flushPromises()
  assert.strictEqual(lateHomePage.data.listings.length, 0, '账号变化后迟到的首页房源不得落地')
  assert.strictEqual(lateHomePage.data.todayTasks.length, 0, '账号变化后迟到的首页任务不得落地')

  authToken = 'TOKEN-HOME-UNLOAD'
  authSessionKey = 'auth-home-unload'
  const unloadHome = deferred()
  const unloadTasks = deferred()
  const unloadHomeDefinition = loadDefinition(indexPagePath, {
    getHomeListings() { return unloadHome.promise },
    getTodayTasks() { return unloadTasks.promise },
    getCompanySheetSnapshot() { return Promise.resolve({ rows: [] }) }
  })
  const unloadHomePage = makePage(unloadHomeDefinition)
  unloadHomePage.authSessionSnapshot = authSessionKey
  unloadHomePage.loadHomeListings()
  unloadHomePage.loadTodayTasks()
  unloadHomePage.onUnload()
  unloadHome.resolve([{ id: 'HOME-UNLOAD-LATE' }])
  unloadTasks.resolve({ tasks: [{ type: 'maintenance', title: '卸载后任务' }], summary: { pendingCount: 1 } })
  await flushPromises()
  assert.strictEqual(unloadHomePage.data.listings.length, 0, '首页卸载后的迟到房源不得回写')
  assert.strictEqual(unloadHomePage.data.todayTasks.length, 0, '首页卸载后的迟到任务不得回写')

  let listingShouldFail = true
  const listingsDefinition = loadDefinition(listingsPagePath, {
    getListings() {
      return listingShouldFail
        ? Promise.reject(new Error('列表服务失败'))
        : Promise.resolve([])
    }
  })
  const listingsPage = makePage(listingsDefinition)
  listingsPage.setData({ listings: [{ id: 'LIST-OLD' }] })
  listingsPage.loadListings()
  assert.strictEqual(listingsPage.data.loading, true, '全部房源请求周期必须进入加载态')
  await flushPromises()
  assert.strictEqual(listingsPage.data.loadFailed, true, '全部房源失败必须进入持续失败态')
  assert.deepStrictEqual(listingsPage.data.listings.map((item) => item.id), ['LIST-OLD'], '全部房源刷新失败必须保留上次可信结果')
  assert.strictEqual(typeof listingsPage.retryListings, 'function', '全部房源失败态必须提供重试方法')
  listingShouldFail = false
  listingsPage.retryListings()
  await flushPromises()
  assert.strictEqual(listingsPage.data.loadFailed, false, '全部房源真实空结果必须清除失败态')
  assert.strictEqual(listingsPage.data.listings.length, 0, '服务端成功返回空数组时才允许显示真实空结果')

  const pendingListingKey = 'ynzy_pending_listing_filters'
  authToken = 'TOKEN-PENDING-B'
  authSessionKey = 'SESSION-PENDING-B'
  storageValues[pendingListingKey] = createPendingFilterEnvelope({
    category: '业主房源',
    filters: { needId: 'NEED-ACCOUNT-A', community: '账号A私有小区' }
  }, 'SESSION-PENDING-A')
  const pendingQueries = []
  const pendingDefinition = loadDefinition(listingsPagePath, {
    getListings(query) {
      pendingQueries.push(query || {})
      return Promise.resolve([])
    }
  })
  const pendingPage = makePage(pendingDefinition)
  pendingPage.onLoad({})
  pendingPage.onShow()
  await flushPromises()
  assert.strictEqual(pendingPage.data.filters.needId, '', '账号B首次创建列表页不得消费账号A遗留 needId')
  assert.ok(pendingQueries.every((query) => !query.needId), '账号A遗留 needId 不得进入账号B列表请求')
  assert.strictEqual(storageValues[pendingListingKey], undefined, 'owner 不匹配的待处理筛选也必须一次性清理')

  authToken = 'TOKEN-PENDING-A'
  authSessionKey = 'SESSION-PENDING-A'
  storageValues[pendingListingKey] = createPendingFilterEnvelope({
    category: '业主房源',
    filters: { needId: 'NEED-ACCOUNT-A', community: '账号A私有小区' }
  }, 'SESSION-PENDING-A')
  const ownPendingPage = makePage(pendingDefinition)
  ownPendingPage.onLoad({})
  ownPendingPage.onShow()
  await flushPromises()
  assert.strictEqual(ownPendingPage.data.filters.needId, 'NEED-ACCOUNT-A', '同一会话仍必须消费自己的待处理筛选')

  for (const target of [
    { token: '', sessionKey: 'guest-list-after-a', label: '退出到游客' },
    { token: 'TOKEN-LIST-B', sessionKey: 'auth-list-b', label: '切换到账号B' }
  ]) {
    authToken = 'TOKEN-LIST-A'
    authSessionKey = `auth-list-a-${target.label}`
    let listMode = 'success'
    const sessionDefinition = loadDefinition(listingsPagePath, {
      getListings() {
        if (listMode === 'fail') return Promise.reject(new Error('新会话列表请求失败'))
        return Promise.resolve([{ id: 'LIST-A-PRIVATE', community: '账号A合作小区', source: '业主房源' }])
      }
    })
    const sessionPage = makePage(sessionDefinition)
    sessionPage.loadListings()
    await flushPromises()
    assert.deepStrictEqual(sessionPage.data.listings.map((item) => item.id), ['LIST-A-PRIVATE'], '账号A可信列表应先成功落地')
    assert.deepStrictEqual(sessionPage.data.communityOptions, ['账号A合作小区'])

    listMode = 'fail'
    authToken = target.token
    authSessionKey = target.sessionKey
    sessionPage.onShow()
    assert.strictEqual(sessionPage.data.listings.length, 0, `${target.label}时必须在请求返回前清空旧账号房源卡`)
    assert.strictEqual(sessionPage.data.communityOptions.length, 0, `${target.label}时必须清空旧账号小区选项`)
    await flushPromises()
    assert.strictEqual(sessionPage.data.listings.length, 0, `${target.label}后的失败请求不得恢复账号A列表`)
  }

  authToken = 'TOKEN-LIST-LATE-A'
  authSessionKey = 'auth-list-late-a'
  const lateListResolvers = []
  const lateListDefinition = loadDefinition(listingsPagePath, {
    getListings() {
      return new Promise((resolve) => { lateListResolvers.push(resolve) })
    }
  })
  const lateListPage = makePage(lateListDefinition)
  lateListPage.loadListings()
  authToken = ''
  authSessionKey = 'guest-list-late'
  lateListResolvers.forEach((resolve) => resolve([{ id: 'LIST-A-LATE', community: '迟到账号A小区', source: '二房东房源' }]))
  await flushPromises()
  assert.strictEqual(lateListPage.data.listings.length, 0, '会话变化后迟到的账号A列表响应不得被采纳')
  assert.strictEqual(lateListPage.data.communityOptions.length, 0, '迟到响应不得写入旧账号小区选项')

  authToken = 'TOKEN-LIST-UNLOAD'
  authSessionKey = 'auth-list-unload'
  const unloadListingResolvers = []
  const unloadListingDefinition = loadDefinition(listingsPagePath, {
    getListings() { return new Promise((resolve) => { unloadListingResolvers.push(resolve) }) }
  })
  const unloadListingPage = makePage(unloadListingDefinition)
  unloadListingPage.loadListings()
  unloadListingPage.onUnload()
  unloadListingResolvers.forEach((resolve) => resolve([{ id: 'LIST-UNLOAD-LATE' }]))
  await flushPromises()
  assert.strictEqual(unloadListingPage.data.listings.length, 0, '房源列表卸载后的迟到响应不得回写')

  let ownerShouldFail = true
  const ownerDefinition = loadDefinition(myListingsPagePath, {
    getProfileState() {
      return ownerShouldFail
        ? Promise.reject(new Error('我的资料失败'))
        : Promise.resolve({ sourceStats: [] })
    },
    getOwnedListings() {
      return ownerShouldFail
        ? Promise.reject(new Error('我的房源失败'))
        : Promise.resolve([])
    },
    getListings() { return Promise.resolve([]) }
  })
  const ownerPage = makePage(ownerDefinition)
  ownerPage.setData({ listings: [{ id: 'OWNER-OLD' }] })
  ownerPage.refresh()
  assert.strictEqual(ownerPage.data.ownerLoading, true, '我的房源请求周期必须真正进入加载态')
  await flushPromises()
  assert.strictEqual(ownerPage.data.ownerLoading, false, '我的房源失败后必须结束加载态')
  assert.strictEqual(ownerPage.data.loadFailed, true, '我的房源失败必须进入持续失败态')
  assert.deepStrictEqual(ownerPage.data.listings.map((item) => item.id), ['OWNER-OLD'], '我的房源刷新失败必须保留上次可信结果')
  assert.strictEqual(typeof ownerPage.retryListings, 'function', '我的房源失败态必须提供重试方法')
  ownerShouldFail = false
  ownerPage.retryListings()
  await flushPromises()
  assert.strictEqual(ownerPage.data.loadFailed, false, '我的房源真实空结果必须清除失败态')
  assert.strictEqual(ownerPage.data.listings.length, 0, '我的房源成功空数组才允许显示暂无')

  for (const target of [
    { token: '', sessionKey: 'guest-owner-after-a', label: '退出到游客' },
    { token: 'TOKEN-OWNER-B', sessionKey: 'auth-owner-b', label: '切换到账号B' }
  ]) {
    authToken = 'TOKEN-OWNER-A'
    authSessionKey = `auth-owner-a-${target.label}`
    let ownerMode = 'success'
    const ownerSessionDefinition = loadDefinition(myListingsPagePath, {
      getProfileState() {
        return ownerMode === 'success'
          ? Promise.resolve({ sourceStats: [{ value: '1' }] })
          : Promise.reject(new Error('新会话资料失败'))
      },
      getOwnedListings() {
        return ownerMode === 'success'
          ? Promise.resolve([{ id: 'OWNER-A-PRIVATE', community: '账号A小区', landlordPhone: '13900000001' }])
          : Promise.reject(new Error('新会话我的房源失败'))
      },
      getListings() { return Promise.resolve([]) }
    })
    const ownerSessionPage = makePage(ownerSessionDefinition)
    ownerSessionPage.refresh()
    await flushPromises()
    assert.deepStrictEqual(ownerSessionPage.data.listings.map((item) => item.id), ['OWNER-A-PRIVATE'])
    assert.deepStrictEqual(ownerSessionPage.data.ownerCommunityOptions, ['账号A小区'])

    ownerMode = 'fail'
    authToken = target.token
    authSessionKey = target.sessionKey
    ownerSessionPage.onShow()
    assert.strictEqual(ownerSessionPage.data.listings.length, 0, `${target.label}时必须立即清空账号A我的房源`)
    assert.strictEqual(ownerSessionPage.data.stats.length, 0, `${target.label}时必须清空账号A统计`)
    assert.strictEqual(ownerSessionPage.data.ownerCommunityOptions.length, 0, `${target.label}时必须清空账号A小区选项`)
    assert.deepStrictEqual(ownerSessionPage.allOwnerListings || [], [], `${target.label}时必须清空账号A未筛选原始房源`)
    await flushPromises()
    assert.strictEqual(ownerSessionPage.data.listings.length, 0, `${target.label}后的失败请求不得恢复账号A我的房源`)
  }

  authToken = 'TOKEN-OWNER-LATE-A'
  authSessionKey = 'auth-owner-late-a'
  const lateOwnerProfile = deferred()
  const lateOwnerListings = deferred()
  const lateOwnerDefinition = loadDefinition(myListingsPagePath, {
    getProfileState() { return lateOwnerProfile.promise },
    getOwnedListings() { return lateOwnerListings.promise },
    getListings() { return Promise.resolve([]) }
  })
  const lateOwnerPage = makePage(lateOwnerDefinition)
  lateOwnerPage.refresh()
  authToken = 'TOKEN-OWNER-LATE-B'
  authSessionKey = 'auth-owner-late-b'
  lateOwnerProfile.resolve({ sourceStats: [{ value: '1' }] })
  lateOwnerListings.resolve([{ id: 'OWNER-A-LATE', community: '迟到账号A小区', landlordPhone: '13900000001' }])
  await flushPromises()
  assert.strictEqual(lateOwnerPage.data.listings.length, 0, '账号变化后迟到的我的房源不得落地')
  assert.deepStrictEqual(lateOwnerPage.allOwnerListings || [], [], '迟到响应不得写入账号A原始房源缓存')

  authToken = 'TOKEN-OWNER-UNLOAD'
  authSessionKey = 'auth-owner-unload'
  const unloadOwnerProfile = deferred()
  const unloadOwnerListings = deferred()
  const unloadOwnerDefinition = loadDefinition(myListingsPagePath, {
    getProfileState() { return unloadOwnerProfile.promise },
    getOwnedListings() { return unloadOwnerListings.promise },
    getListings() { return Promise.resolve([]) }
  })
  const unloadOwnerPage = makePage(unloadOwnerDefinition)
  unloadOwnerPage.refresh()
  unloadOwnerPage.onUnload()
  unloadOwnerProfile.resolve({ sourceStats: [{ value: '1' }] })
  unloadOwnerListings.resolve([{ id: 'OWNER-UNLOAD-LATE' }])
  await flushPromises()
  assert.strictEqual(unloadOwnerPage.data.listings.length, 0, '我的房源卸载后的迟到响应不得回写')

  let companyShouldFail = true
  const companyDefinition = loadDefinition(myListingsPagePath, {
    getProfileState() { return Promise.resolve({ sourceStats: [] }) },
    getOwnedListings() { return Promise.resolve([]) },
    getListings() {
      return companyShouldFail
        ? Promise.reject(new Error('公司房源失败'))
        : Promise.resolve([])
    }
  })
  const companyPage = makePage(companyDefinition)
  companyPage.setData({ isCompanyMode: true, listings: [{ id: 'COMPANY-OLD' }] })
  companyPage.refresh()
  assert.strictEqual(companyPage.data.companyLoading, true, '公司房源请求周期必须进入加载态')
  await flushPromises()
  assert.strictEqual(companyPage.data.companyLoading, false, '公司房源失败后必须结束加载态')
  assert.strictEqual(companyPage.data.loadFailed, true, '公司房源失败必须进入持续失败态')
  assert.deepStrictEqual(companyPage.data.listings.map((item) => item.id), ['COMPANY-OLD'], '公司房源刷新失败必须保留上次可信结果')
  companyShouldFail = false
  companyPage.retryListings()
  await flushPromises()
  assert.strictEqual(companyPage.data.loadFailed, false, '公司房源重试成功必须清除失败态')
  assert.strictEqual(companyPage.data.listings.length, 0, '公司房源成功空数组才允许显示暂无')

  assert.ok(/bindtap="retryHomeListings"/.test(indexWxml), '首页模板必须绑定房源重试入口')
  assert.ok(/!listings\.length && !listingsLoading && !listingsLoadFailed/.test(indexWxml), '首页只有成功空结果才可显示暂无')
  assert.ok(/bindtap="retryListings"/.test(listingsWxml), '全部房源模板必须绑定重试入口')
  assert.ok(/!loading && !loadFailed/.test(listingsWxml), '全部房源加载或故障时不得显示暂无')
  const sparseListing = listingDisplay.normalizeListing({
    id: 'LIST-SPARSE',
    locationSummary: '测试小区',
    roomAddress: '',
    layout: '',
    source: '公司房源',
    status: ''
  })
  assert.strictEqual(sparseListing.listingMetaText, '测试小区', '卡片位置行缺字段时不得留下悬空分隔点')
  assert.strictEqual(sparseListing.listingSubText, '公司房源', '卡片来源行缺字段时不得留下首尾分隔点')
  assert.ok(/\{\{item\.listingMetaText\}\}/.test(listingsWxml), '全部房源卡必须使用紧凑位置展示字段')
  assert.ok(/\{\{item\.listingSubText\}\}/.test(listingsWxml), '全部房源卡必须使用紧凑来源展示字段')
  assert.ok(!/\}\}\s*·\s*\{\{/.test(listingsWxml), '全部房源卡模板不得再硬编码可能悬空的分隔点')
  assert.ok(/bindtap="retryListings"/.test(myListingsWxml), '我的房源模板必须绑定重试入口')
  assert.ok(/!companyLoading && !ownerLoading && !loadFailed/.test(myListingsWxml), '我的房源加载或故障时不得显示暂无')

  assert.ok(toasts.some((item) => /加载失败/.test(item.title)), '核心房源入口请求失败必须有即时提示')
  console.log('mini-list-loading-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
