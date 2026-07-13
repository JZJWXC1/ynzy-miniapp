'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const listingDisplay = require(path.join(repoRoot, 'utils', 'listing-display'))
const mockData = require(path.join(repoRoot, 'utils', 'mock-data'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client'))
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service'))
const mapPagePath = require.resolve(path.join(repoRoot, 'pages', 'map', 'map.js'))
const listingsPagePath = require.resolve(path.join(repoRoot, 'pages', 'listings', 'listings.js'))

let listingsPageAuthToken = ''

function listingPayload(roomNumber, ownerType, overrides = {}) {
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '测试板块',
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    building: '1',
    unit: '1',
    roomNumber,
    address: `杭州拱墅区京漾东韵府1栋1单元${roomNumber}室`,
    contact: '19900000051',
    landlordPhone: '19900000051',
    rent: 3200,
    layout: '整租两室1厅1卫',
    rentMode: '整租',
    room: '两室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯'],
    videoKey: `house-videos/synthetic/source-filter-${roomNumber}.mp4`,
    viewingMethod: '联系房东',
    ownerType,
    houseSourceType: ownerType,
    source: ownerType,
    landlordCommissionPercent: 50,
    ...overrides
  }
}

function makePage(definition) {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.assign(page.data, patch || {})
    if (typeof callback === 'function') callback()
  }
  return page
}

function loadMapDefinition() {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: { getMapCommunities: () => Promise.resolve([]) }
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[mapPagePath]
  require(mapPagePath)
  assert.ok(definition, '必须能捕获地图页面定义')
  return definition
}

function loadListingsDefinition() {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: { getListings: () => Promise.resolve([]) }
  }
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: { getAuthToken: () => listingsPageAuthToken }
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[listingsPagePath]
  require(listingsPagePath)
  assert.ok(definition, '必须能捕获房源列表页面定义')
  return definition
}

function ids(rows) {
  return (rows || []).map((item) => item.id).sort()
}

function mapIds(rows) {
  return Array.from(new Set((rows || []).flatMap((item) => item.activeListingIds || []))).sort()
}

async function run() {
  ;[true, 1, 'true', '1', 'yes', 'y', '是', '公司', '公司房源'].forEach((value) => {
    assert.strictEqual(listingDisplay.normalizeListing({ companyListing: value }).companyListing, true, `客户端必须兼容公司真值 ${String(value)}`)
  })
  ;[false, 0, 'false', '0', 'no', '', null, undefined].forEach((value) => {
    assert.strictEqual(listingDisplay.normalizeListing({ companyListing: value }).companyListing, false, `客户端不得把公司假值 ${String(value)} 当真`)
  })
  assert.strictEqual(listingDisplay.normalizeListing({
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    companyListing: false,
    isCompanyListing: false
  }).companyListing, false, '客户端不得用服务端未采信的 ownerType/houseSourceType 把房源二次改成公司')
  assert.strictEqual(listingDisplay.normalizeListing({ source: '公司房源' }).companyListing, true, '客户端必须保留服务端 canonical 公司来源兼容')
  assert.strictEqual(listingDisplay.normalizeListing({ source: '公司自营' }).companyListing, false, '客户端不得额外接受服务端未采信的公司近义词')
  assert.strictEqual(listingDisplay.normalizeListing({ source: 'COMPANY' }).companyListing, false, '客户端 company 来源大小写口径必须与服务端一致')
  assert.strictEqual(listingDisplay.normalizeListing({ source: 'company' }).companyListing, true, '客户端必须保留服务端既有小写 company 兼容')
  ;['y', '公司', '公司房源'].forEach((value) => {
    assert.strictEqual(listingDisplay.normalizeListing({ companyOwned: value }).companyListing, false, `客户端 companyOwned=${value} 不得超出服务端通用真值口径`)
  })
  ;[true, 1, 'true', '1', 'yes', '是'].forEach((value) => {
    assert.strictEqual(listingDisplay.normalizeListing({ companyOwned: value }).companyListing, true, `客户端 companyOwned=${String(value)} 必须与服务端通用真值一致`)
  })

  const ownerWithCompanyWords = listingDisplay.normalizeListing({
    id: 'CLIENT-OWNER',
    title: '公司房源花园旁业主直租',
    community: '公司房源花园',
    meta: '公司房源字样只是小区名称',
    source: '业主房源',
    sourceLabel: '业主房源',
    sourceType: '业主房源',
    ownerType: '业主房源',
    houseSourceType: '业主房源',
    companyListing: false,
    isCompanyListing: 'false',
    companyOwned: '0'
  })
  assert.strictEqual(ownerWithCompanyWords.companyListing, false, '客户端不得从标题、小区或说明文字猜测公司来源')
  assert.strictEqual(ownerWithCompanyWords.sourceLabel, '业主房源', '客户端必须保留服务端返回的结构化业主来源')

  let storedListingFilters = null
  let switchedTab = ''
  let navigatedUrl = ''
  global.wx = {
    setStorageSync(key, value) {
      assert.strictEqual(key, 'ynzy_pending_listing_filters')
      storedListingFilters = value
    },
    showToast() {},
    switchTab(options) { switchedTab = options.url },
    navigateTo(options) { navigatedUrl = options.url }
  }
  const mapDefinition = loadMapDefinition()
  const mapPage = makePage(mapDefinition)
  ;['公司房源', '业主房源', '二房东房源'].forEach((sourceType) => {
    storedListingFilters = null
    switchedTab = ''
    mapPage.data.selectedCommunity = null
    mapPage.data.filters = {
      needId: '',
      area: '拱墅区',
      block: '',
      community: '',
      layout: '两室',
      rentMode: '整租',
      rentMin: 2000,
      rentMax: 4000,
      sourceType
    }
    mapPage.openAreaListings()
    assert.ok(storedListingFilters, `地图 ${sourceType} 必须把筛选条件写给列表页`)
    assert.strictEqual(storedListingFilters.category, sourceType, `地图 ${sourceType} 返回列表时不得丢失来源`)
    assert.strictEqual(storedListingFilters.filters.rentMode, '整租', '整租/合租必须继续放在筛选面板，不得冒充顶部来源分类')
    assert.strictEqual(switchedTab, '/pages/listings/listings')
  })

  const listingWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'listings', 'listings.wxml'), 'utf8')
  assert.ok(!listingWxml.includes('title="{{category}}房源"'), '来源本身已含“房源”，导航标题不得显示“公司房源房源”')
  assert.ok(listingWxml.includes('loginRequired'), '游客选择合作来源时必须渲染明确登录空态')
  assert.ok(listingWxml.includes('bindtap="goLogin"'), '游客合作来源空态必须提供去登录按钮')

  const listingsDefinition = loadListingsDefinition()
  const listingsPage = makePage(listingsDefinition)
  listingsPageAuthToken = ''
  listingsPage.data.category = '业主房源'
  listingsPage.loadListings()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(listingsPage.data.loginRequired, true, '游客选择业主房源必须出现登录引导')
  listingsPage.data.category = '二房东房源'
  listingsPage.loadListings()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(listingsPage.data.loginRequired, true, '游客选择二房东房源必须出现登录引导')
  listingsPage.data.category = '公司房源'
  listingsPage.loadListings()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(listingsPage.data.loginRequired, false, '游客选择公司房源不得误提示登录')
  listingsPageAuthToken = 'synthetic-listings-page-token'
  listingsPage.data.category = '业主房源'
  listingsPage.loadListings()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(listingsPage.data.loginRequired, false, '登录用户选择合作来源不得误提示登录')
  navigatedUrl = ''
  listingsPage.goLogin()
  assert.strictEqual(navigatedUrl, '/pages/auth/auth', '登录引导按钮必须进入现有登录页')

  mockData.loginByPhone('13800010004')
  const company = mockData.addNormalListing(listingPayload('9511', '公司房源', {
    companyListing: true,
    isCompanyListing: true
  }))
  await new Promise((resolve) => setTimeout(resolve, 2))
  mockData.loginByPhone('13800010005')
  const owner = mockData.addNormalListing(listingPayload('9512', '业主房源'))
  await new Promise((resolve) => setTimeout(resolve, 2))
  const secondLandlord = mockData.addNormalListing(listingPayload('9513', '二房东房源'))

  let authToken = ''
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      getAuthToken() { return authToken },
      call(options) { return Promise.resolve().then(() => options.mock()) }
    }
  }
  delete require.cache[apiServicePath]
  const apiService = require(apiServicePath)

  assert.deepStrictEqual(ids(await apiService.getListings({})), [company.id], 'Mock 游客“全部”只能看到公司房源')
  assert.deepStrictEqual(ids(await apiService.getListings({ category: '公司房源' })), [company.id], 'Mock 游客公司筛选必须准确')
  assert.deepStrictEqual(await apiService.getListings({ category: '业主房源' }), [], 'Mock 游客业主筛选必须与权限取交集为空')
  assert.deepStrictEqual(await apiService.getListings({ category: '二房东房源' }), [], 'Mock 游客二房东筛选必须与权限取交集为空')
  assert.deepStrictEqual(await apiService.getMapCommunities({ sourceType: '业主房源' }), [], 'Mock 游客地图业主筛选不得泄露合作房源')
  assert.deepStrictEqual(await apiService.getMapCommunities({ sourceType: '二房东房源' }), [], 'Mock 游客地图二房东筛选不得泄露合作房源')

  authToken = 'synthetic-source-filter-token'
  assert.deepStrictEqual(ids(await apiService.getListings({ category: '公司房源' })), [company.id], 'Mock 登录公司筛选必须互斥')
  assert.deepStrictEqual(ids(await apiService.getListings({ category: '业主房源' })), [owner.id], 'Mock 登录业主筛选必须互斥')
  assert.deepStrictEqual(ids(await apiService.getListings({ category: '二房东房源' })), [secondLandlord.id], 'Mock 登录二房东筛选必须互斥')
  assert.deepStrictEqual(mapIds(await apiService.getMapCommunities({ sourceType: '公司房源' })), [company.id], 'Mock 登录地图公司筛选必须互斥')
  assert.deepStrictEqual(mapIds(await apiService.getMapCommunities({ sourceType: '业主房源' })), [owner.id], 'Mock 登录地图业主筛选必须互斥')
  assert.deepStrictEqual(mapIds(await apiService.getMapCommunities({ sourceType: '二房东房源' })), [secondLandlord.id], 'Mock 登录地图二房东筛选必须互斥')

  console.log('listing-source-filter-client-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
