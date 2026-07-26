'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client'))
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service'))
const pagePaths = {
  listings: require.resolve(path.join(repoRoot, 'pages', 'listings', 'listings.js')),
  favorites: require.resolve(path.join(repoRoot, 'pages', 'favorites', 'favorites.js')),
  mine: require.resolve(path.join(repoRoot, 'pages', 'my-listings', 'my-listings.js')),
  map: require.resolve(path.join(repoRoot, 'pages', 'map', 'map.js'))
}

const payload = {
  regionOptions: [
    { name: '新区域', blocks: ['新板块B', '新板块A'] },
    { name: '另一区', blocks: ['另一板块'] }
  ],
  layoutOptions: ['不限', '一室', '两室', '三室', '三室以上'],
  rentModeOptions: ['全部', '整租', '合租']
}

function setAtPath(target, key, value) {
  const parts = String(key).split('.')
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
  page._pageActive = true
  return page
}

function loadPage(pagePath, apiStub, sessionKeyProvider = () => 'guest-dynamic-filter-test') {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      getAuthToken: () => '',
      getAuthSessionKey: () => sessionKeyProvider()
    }
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[pagePath]
  require(pagePath)
  assert.ok(definition, `必须捕获页面定义：${path.basename(pagePath)}`)
  return makePage(definition)
}

async function run() {
  let requestedPath = ''
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      getAuthToken: () => '',
      call(options) {
        requestedPath = options.path
        return Promise.resolve(payload)
      }
    }
  }
  delete require.cache[apiServicePath]
  const realApiService = require(apiServicePath)
  const normalized = await realApiService.getListingFilterOptions()
  assert.strictEqual(requestedPath, '/mini/listing-filter-options', '小程序必须读取服务端动态筛选元数据接口')
  assert.deepStrictEqual(normalized.regionOptions, [
    { name: '另一区', blocks: ['另一板块'] },
    { name: '新区域', blocks: ['新板块A', '新板块B'] }
  ], '接口响应必须在客户端清洗、去重并稳定排序')

  const apiStub = {
    getListingFilterOptions: () => Promise.resolve(payload),
    getListings: () => Promise.resolve([])
  }
  for (const name of ['listings', 'favorites', 'mine']) {
    const page = loadPage(pagePaths[name], apiStub)
    await page.loadListingFilterOptions()
    assert.deepStrictEqual(
      page.data.regionOptions.find((item) => item.name === '新区域').blocks,
      ['新板块A', '新板块B'],
      `${name} 页面必须消费动态区域和板块，不能继续依赖静态常量`
    )
  }

  let listingsSessionKey = 'listings-account-a'
  const listingsQueries = []
  const switchedListingsPage = loadPage(pagePaths.listings, {
    getListings: (query) => {
      listingsQueries.push(Object.assign({}, query))
      return Promise.resolve([])
    }
  }, () => listingsSessionKey)
  switchedListingsPage.authSessionSnapshot = listingsSessionKey
  switchedListingsPage.setData({
    category: '业主房源',
    filters: {
      ...switchedListingsPage.data.filters,
      needId: 'NEED-A',
      district: '账号A私有区',
      block: '账号A私有板块',
      community: '账号A私有小区',
      layout: '两室',
      rentMode: '整租',
      rentMin: 2800,
      rentMax: 3200,
      features: '免押金'
    }
  })
  listingsSessionKey = 'listings-account-b'
  assert.strictEqual(switchedListingsPage.syncAuthSession().changed, true)
  assert.strictEqual(switchedListingsPage.data.category, '全部', '房源列表换号后必须重置 A 的来源分类')
  assert.deepStrictEqual(
    switchedListingsPage.data.filters,
    {
      needId: '',
      district: '',
      block: '',
      community: '',
      layout: '',
      rentMode: '',
      rentMin: '',
      rentMax: '',
      features: ''
    },
    '房源列表换号后必须清空 A 的全部需求和筛选条件'
  )
  switchedListingsPage.loadListings()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(
    listingsQueries.every((query) => !JSON.stringify(query).includes('账号A') && !JSON.stringify(query).includes('NEED-A')),
    '房源列表换号后的 B 请求不得包含 A 的私有筛选词'
  )

  const favoriteLocationPage = loadPage(pagePaths.favorites, {
    getListingFilterOptions: () => Promise.resolve(payload),
    getFavorites: (query = {}) => {
      const isUnfilteredLocationRead = !query.category && !query.availability &&
        !query.district && !query.block && !query.community && !query.layout &&
        !query.rentMode && !query.rentMin && !query.rentMax && !query.features
      return Promise.resolve(isUnfilteredLocationRead
        ? [{
            id: 'F-UNAVAILABLE-ONLY',
            district: '仅失效收藏区',
            area: '仅失效收藏区',
            block: '仅失效收藏板块',
            community: '仅失效收藏小区',
            isAvailable: false
          }]
        : [])
    }
  })
  await favoriteLocationPage.loadListingFilterOptions()
  favoriteLocationPage.setData({
    category: '公司房源',
    availability: 'unavailable',
    filters: {
      ...favoriteLocationPage.data.filters,
      district: '新区域',
      block: '新板块A'
    }
  })
  await favoriteLocationPage.loadFavorites()
  assert.deepStrictEqual(
    favoriteLocationPage.data.regionOptions.find((item) => item.name === '仅失效收藏区'),
    { name: '仅失效收藏区', blocks: ['仅失效收藏板块'] },
    '收藏筛选必须合并本账号暂不可用收藏的位置，不能只依赖当前有效公开房源元数据'
  )

  let favoriteSessionKey = 'favorite-account-a'
  let favoriteRequestsPending = false
  const favoriteSwitchPage = loadPage(pagePaths.favorites, {
    getListingFilterOptions: () => Promise.resolve(payload),
    getFavorites: () => favoriteRequestsPending
      ? new Promise(() => {})
      : Promise.resolve([{
          id: 'F-ACCOUNT-A',
          district: '账号A私有区',
          area: '账号A私有区',
          block: '账号A私有板块',
          community: '账号A私有小区',
          isAvailable: false
        }])
  }, () => favoriteSessionKey)
  await favoriteSwitchPage.loadListingFilterOptions()
  await favoriteSwitchPage.loadFavorites()
  favoriteSwitchPage.setData({
    category: '业主房源',
    availability: 'unavailable',
    filters: {
      ...favoriteSwitchPage.data.filters,
      district: '账号A私有区',
      block: '账号A私有板块',
      community: '账号A私有小区',
      layout: '两室',
      rentMode: '整租',
      rentMin: 2800,
      rentMax: 3200,
      features: '免押金'
    }
  })
  favoriteSessionKey = 'favorite-account-b'
  favoriteRequestsPending = true
  favoriteSwitchPage.loadFavorites()
  assert.strictEqual(
    favoriteSwitchPage.data.regionOptions.some((item) => item.name === '账号A私有区'),
    false,
    '收藏换号后必须在 B 的请求返回前立即移除 A 的私有行政区和板块'
  )
  assert.deepStrictEqual(
    {
      category: favoriteSwitchPage.data.category,
      availability: favoriteSwitchPage.data.availability,
      filters: favoriteSwitchPage.data.filters
    },
    {
      category: '全部',
      availability: '',
      filters: {
        district: '',
        block: '',
        community: '',
        layout: '',
        rentMode: '',
        rentMin: '',
        rentMax: '',
        features: ''
      }
    },
    '收藏换号后必须立即清除 A 的全部筛选状态，不能继续带入 B 的请求'
  )

  const minePage = loadPage(pagePaths.mine, apiStub)
  assert.strictEqual(minePage.data.companyFilters.district, '', '寓你住一起房源筛选不得默认锁定拱墅区')
  assert.strictEqual(minePage.data.companyFilters.rentMode, '', '寓你住一起房源必须默认支持整租/合租筛选')
  minePage.data.companyFilters.district = '新区域'
  minePage.resetCompanyFilters()
  assert.strictEqual(minePage.data.companyFilters.district, '', '寓你住一起房源重置后必须恢复全部区域')
  const companyQueries = []
  const companyFilterPage = loadPage(pagePaths.mine, {
    getListings: (query) => {
      companyQueries.push(Object.assign({}, query))
      return Promise.resolve([])
    }
  })
  companyFilterPage.setData({
    companyFilters: {
      ...companyFilterPage.data.companyFilters,
      district: '拱墅区',
      block: '新天地',
      rentMode: '合租'
    }
  })
  companyFilterPage.refreshCompanyListings()
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(companyQueries.length, 2, '寓你住一起房源刷新必须同时读取结果和小区候选')
  assert.strictEqual(companyQueries[0].rentMode, '合租', '寓你住一起房源主查询不得丢失整租/合租筛选')
  assert.strictEqual(companyQueries[1].rentMode, '合租', '寓你住一起房源小区候选查询不得混入其他租赁方式')
  minePage.allOwnerListings = [{
    district: '自有新区',
    area: '自有新区',
    block: '自有板块',
    community: '自有花苑'
  }]
  await minePage.loadListingFilterOptions()
  assert.deepStrictEqual(
    minePage.data.regionOptions.find((item) => item.name === '自有新区'),
    { name: '自有新区', blocks: ['自有板块'] },
    '我的上传必须把本人全量房源位置与公开元数据合并，不能漏掉尚未公开的新区域'
  )
  minePage.allOwnerListings = [
    { id: 'OWNER-EXACT-A', district: '甲区', area: '甲区', block: '东新', community: '甲花苑' },
    { id: 'OWNER-EXACT-B', district: '甲区', area: '甲区', block: '东新园', community: '乙花苑' }
  ]
  minePage.setData({
    ownerFilters: {
      ...minePage.data.ownerFilters,
      district: '甲',
      block: '东新'
    }
  })
  minePage.applyOwnerFilters()
  assert.deepStrictEqual(
    minePage.data.listings.map((item) => item.id),
    ['OWNER-EXACT-A'],
    '我的上传结构化行政区和板块必须等值匹配，不能把东新园混入东新'
  )

  let mineSessionKey = 'mine-account-a'
  const mineSwitchPage = loadPage(pagePaths.mine, apiStub, () => mineSessionKey)
  mineSwitchPage.authSessionSnapshot = mineSessionKey
  mineSwitchPage.listingFilterMetadata = payload
  mineSwitchPage.allOwnerListings = [{
    district: '账号A上传区',
    area: '账号A上传区',
    block: '账号A上传板块',
    community: '账号A上传小区'
  }]
  mineSwitchPage.applyListingFilterOptions(payload)
  mineSwitchPage.setData({
    ownerFilters: {
      ...mineSwitchPage.data.ownerFilters,
      district: '账号A上传区',
      block: '账号A上传板块',
      community: '账号A上传小区'
    }
  })
  mineSessionKey = 'mine-account-b'
  mineSwitchPage.syncAuthSession()
  assert.strictEqual(
    mineSwitchPage.data.regionOptions.some((item) => item.name === '账号A上传区'),
    false,
    '我的上传换号后必须在 B 的请求返回前立即移除 A 的私有行政区和板块'
  )
  assert.deepStrictEqual(
    mineSwitchPage.data.ownerFilters,
    {
      district: '',
      block: '',
      community: '',
      layout: '',
      rentMode: '',
      rentMin: '',
      rentMax: ''
    },
    '我的上传换号后必须立即重置 A 的筛选状态'
  )

  const mapPage = loadPage(pagePaths.map, apiStub)
  const mapLoadOptions = []
  mapPage.loadCommunities = (options) => { mapLoadOptions.push(options) }
  await mapPage.loadListingFilterOptions()
  mapPage.changeLocationFilter({
    currentTarget: { dataset: { type: 'district', value: '新区域' } }
  })
  assert.deepStrictEqual(mapLoadOptions.pop(), { recenter: true }, '地图主动选择行政区后必须把新点位移入当前视野')
  assert.deepStrictEqual(mapPage.data.blockOptions, ['新板块A', '新板块B'], '地图选择行政区后只能显示其所属板块')
  mapPage.changeLocationFilter({
    currentTarget: { dataset: { type: 'block', value: '新板块A' } }
  })
  assert.deepStrictEqual(mapLoadOptions.pop(), { recenter: true }, '地图主动选择板块后必须把新点位移入当前视野')
  assert.strictEqual(mapPage.buildQuery().district, '新区域', '地图请求不得丢失行政区')
  assert.strictEqual(mapPage.buildQuery().block, '新板块A', '地图请求不得丢失板块')
  assert.ok(mapPage.data.layoutFilters.includes('三室以上'), '地图户型筛选必须补齐三室以上')
  mapPage.changeRentFilter({
    currentTarget: { dataset: { key: '2000-3000' } }
  })
  assert.deepStrictEqual(mapLoadOptions.pop(), { recenter: false }, '地图只切换租金时必须保留用户当前视野')

  const pending = mapPage.mergePendingFilters(mapPage.data.filters, {
    district: '另一区',
    block: '另一板块'
  })
  assert.strictEqual(pending.district, '另一区', '跨页地图筛选必须保留结构化行政区')
  assert.strictEqual(pending.block, '另一板块', '跨页地图筛选必须保留结构化板块')
  assert.strictEqual(pending.area, '', '结构化行政区和板块不得再次折叠成模糊 area')

  const sameNameMapPage = loadPage(pagePaths.map, {
    getMapCommunities: () => Promise.resolve([
      {
        groupId: 'MAP-GROUP-A',
        district: '甲区',
        block: '甲板块',
        community: '同名花苑',
        latitude: 30.1,
        longitude: 120.1,
        coordinateLevel: 'verified',
        listingCount: 1,
        activeListingIds: ['MAP-A'],
        listings: [{ id: 'MAP-A', rent: 3000 }]
      },
      {
        groupId: 'MAP-GROUP-B',
        district: '乙区',
        block: '乙板块',
        community: '同名花苑',
        latitude: 30.5,
        longitude: 120.5,
        coordinateLevel: 'verified',
        listingCount: 1,
        activeListingIds: ['MAP-B'],
        listings: [{ id: 'MAP-B', rent: 3200 }]
      }
    ])
  })
  sameNameMapPage.loadCommunities({ recenter: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(
    sameNameMapPage.data.communities.map((item) => item.id),
    ['MAP-GROUP-A', 'MAP-GROUP-B'],
    '地图客户端必须优先使用服务端稳定分组 ID，不能把同名小区重新折叠'
  )
  sameNameMapPage.handleMarkerTap({ detail: { markerId: 2 } })
  assert.strictEqual(sameNameMapPage.data.selectedCommunity.id, 'MAP-GROUP-B', '点击第二个同名小区 marker 必须选中第二组')
  let storedSameNameFilters = null
  global.wx = {
    setStorageSync(key, value) {
      assert.strictEqual(key, 'ynzy_pending_listing_filters')
      storedSameNameFilters = value
    },
    switchTab() {},
    showToast() {}
  }
  sameNameMapPage.openAreaListings()
  assert.deepStrictEqual(
    {
      district: storedSameNameFilters.payload.filters.district,
      block: storedSameNameFilters.payload.filters.block,
      community: storedSameNameFilters.payload.filters.community
    },
    { district: '乙区', block: '乙板块', community: '同名花苑' },
    '从同名小区 marker 进入列表时必须保留所点分组的行政区、板块和小区'
  )

  let mapSessionKey = 'map-account-a'
  const switchedMapPage = loadPage(pagePaths.map, apiStub, () => mapSessionKey)
  switchedMapPage.authSessionSnapshot = mapSessionKey
  switchedMapPage.setData({
    filters: {
      ...switchedMapPage.data.filters,
      needId: 'NEED-A',
      district: '账号A私有区',
      block: '账号A私有板块',
      area: '账号A私有地点',
      community: '账号A私有小区',
      layout: '两室',
      rentMode: '整租',
      rentMin: 2000,
      rentMax: 3000,
      sourceType: '业主房源',
      listingIds: ['A-PRIVATE-LISTING']
    }
  })
  mapSessionKey = 'map-account-b'
  assert.strictEqual(switchedMapPage.syncAuthSession().changed, true)
  assert.deepStrictEqual(
    switchedMapPage.data.filters,
    {
      needId: '',
      rentKey: '',
      rentMin: '',
      rentMax: '',
      layout: '',
      rentMode: '',
      sourceType: '',
      district: '',
      block: '',
      area: '',
      community: '',
      listingIds: []
    },
    '地图换号后必须清空 A 的全部需求和地点筛选，不能继续带入 B 的请求'
  )
  assert.ok(!JSON.stringify(switchedMapPage.buildQuery()).includes('账号A'), '地图换号后的查询不得包含 A 的私有地点词')

  const mapWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'map', 'map.wxml'), 'utf8')
  assert.ok(mapWxml.includes('data-type="district"'), '地图必须渲染行政区选项')
  assert.ok(mapWxml.includes('data-type="block"'), '地图必须渲染从属板块选项')

  console.log('dynamic-listing-filter-client-v1-test: PASS')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
