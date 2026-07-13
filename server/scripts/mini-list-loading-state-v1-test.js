const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const indexPagePath = require.resolve(path.join(repoRoot, 'pages', 'index', 'index.js'))
const listingsPagePath = require.resolve(path.join(repoRoot, 'pages', 'listings', 'listings.js'))
const myListingsPagePath = require.resolve(path.join(repoRoot, 'pages', 'my-listings', 'my-listings.js'))
const listingDisplay = require(path.join(repoRoot, 'utils', 'listing-display.js'))

const indexWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'index', 'index.wxml'), 'utf8')
const listingsWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'listings', 'listings.wxml'), 'utf8')
const myListingsWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'my-listings', 'my-listings.wxml'), 'utf8')

let toasts = []

global.wx = {
  showToast(options) { toasts.push(options) },
  getStorageSync() { return '' },
  removeStorageSync() {},
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
