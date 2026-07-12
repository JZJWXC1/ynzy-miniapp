'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const detailPagePath = path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js')
const detailWxmlPath = path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.wxml')
const nearbyPagePath = path.join(repoRoot, 'pages', 'nearby-listings', 'nearby-listings.js')
const nearbyJsonPath = path.join(repoRoot, 'pages', 'nearby-listings', 'nearby-listings.json')
const nearbyWxmlPath = path.join(repoRoot, 'pages', 'nearby-listings', 'nearby-listings.wxml')
const apiServicePath = require.resolve('../../utils/api-service')
const apiClientPath = require.resolve('../../utils/api-client')
const favoriteWxml = fs.readFileSync(path.join(repoRoot, 'components', 'favorite-toggle', 'favorite-toggle.wxml'), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function settle() {
  await tick()
  await tick()
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
    if (callback) callback()
  }
  return page
}

function loadPage(file, apiStub, apiClientStub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  if (apiClientStub) {
    require.cache[apiClientPath] = {
      id: apiClientPath,
      filename: apiClientPath,
      loaded: true,
      exports: apiClientStub
    }
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[require.resolve(file)]
  require(file)
  assert.ok(definition, `页面必须注册：${file}`)
  return definition
}

function nearbyRows(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    title: `${prefix}附近房源${index + 1}`,
    distanceKm: index / 10,
    distanceText: index ? `${index * 100}米` : '0米',
    sourceLabel: index % 2 ? '业主房源' : '公司房源',
    rentMode: '整租',
    layout: '整租一室一厅一卫',
    features: ['Loft'],
    price: `¥${3000 + index}/月`,
    coverUrl: ''
  }))
}

function detailApi(getListingDetail) {
  return {
    getListingDetail,
    getListingLogs: () => Promise.resolve([]),
    getProfileState: () => Promise.resolve({ user: {} }),
    addSensitiveFootprint: () => Promise.resolve({ sensitive: {} })
  }
}

async function runApiContract() {
  const calls = []
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      getAuthToken: () => 'TOKEN',
      call(options) {
        calls.push(options)
        if (/\/nearby/.test(options.path)) {
          return Promise.resolve({ radiusKm: 3, total: 1, hasMore: false, listings: nearbyRows('API', 1) })
        }
        return Promise.resolve({
          id: 'DETAIL',
          companyListing: true,
          nearby: {
            radiusKm: 3,
            total: 1,
            hasMore: false,
            listings: [{ id: 'RAW', source: '公司房源', features: ['Loft'], rent: 3000 }]
          }
        })
      }
    }
  }
  delete require.cache[apiServicePath]
  const apiService = require(apiServicePath)
  assert.strictEqual(typeof apiService.getNearbyListings, 'function', '客户端服务必须提供查看全部附近接口')
  const result = await apiService.getNearbyListings('L /%')
  assert.strictEqual(result.total, 1)
  const call = calls[calls.length - 1]
  assert.strictEqual(call.path, '/mini/listings/L%20%2F%25/nearby?all=1', '查看全部路由必须编码房源 ID 且只发送 all=1')
  assert.ok(!/radius|latitude|longitude|companyOnly|userId|role/i.test(call.path))

  const detail = await apiService.getListingDetail('DETAIL')
  assert.ok(detail.nearby && detail.nearby.listings[0].companyListing, '详情内嵌 nearby 行必须经过统一展示归一化')
  assert.ok(Array.isArray(detail.nearby.listings[0].features))
}

async function runDetailBehavior() {
  let token = 'TOKEN_A'
  global.getApp = () => ({ globalData: { authToken: token } })
  global.wx = {
    hideShareMenu() {},
    getStorageSync() { return token },
    showToast() {},
    showModal() {},
    navigateTo() {},
    navigateBack() {},
    redirectTo() {},
    switchTab() {}
  }

  const rows = nearbyRows('DETAIL', 7)
  const definition = loadPage(detailPagePath, detailApi(() => Promise.resolve({
    id: 'ANCHOR',
    title: '锚点房源',
    companyListing: true,
    nearby: { radiusKm: 3, total: 7, hasMore: true, listings: rows }
  })))
  const page = makePage(definition)
  page.loadListing('ANCHOR')
  await settle()
  assert.strictEqual(page.data.nearbyListings.length, 6, '详情 UI 必须二次限制最多 6 条')
  assert.strictEqual(page.data.nearbyHasMore, true)
  assert.strictEqual(page.data.nearbyTotal, 7)

  const emptyDefinition = loadPage(detailPagePath, detailApi(() => Promise.resolve({
    id: 'NO-COORDINATE',
    title: '无可靠坐标',
    companyListing: true,
    nearby: { radiusKm: 3, total: 0, hasMore: false, listings: [] }
  })))
  const emptyPage = makePage(emptyDefinition)
  emptyPage.loadListing('NO-COORDINATE')
  await settle()
  assert.deepStrictEqual(emptyPage.data.nearbyListings, [], '无坐标/无结果必须保持隐藏所需空数组')
  assert.strictEqual(emptyPage.data.nearbyHasMore, false)

  const first = deferred()
  const second = deferred()
  let callCount = 0
  const switchDefinition = loadPage(detailPagePath, detailApi(() => {
    callCount += 1
    return callCount === 1 ? first.promise : second.promise
  }))
  const switchPage = makePage(switchDefinition)
  switchPage.loadListing('ANCHOR')
  token = 'TOKEN_B'
  switchPage.loadListing('ANCHOR')
  assert.deepStrictEqual(switchPage.data.nearbyListings, [], '换号新请求发出时必须立刻清空旧附近行')
  second.resolve({
    id: 'ANCHOR',
    companyListing: true,
    nearby: { radiusKm: 3, total: 1, hasMore: false, listings: nearbyRows('B', 1) }
  })
  await settle()
  first.resolve({
    id: 'ANCHOR',
    companyListing: true,
    nearby: { radiusKm: 3, total: 1, hasMore: false, listings: nearbyRows('A', 1) }
  })
  await settle()
  assert.deepStrictEqual(switchPage.data.nearbyListings.map((item) => item.id), ['B-1'], '旧 token 详情迟到不得覆盖新账号附近行')

  const late = deferred()
  const unloadDefinition = loadPage(detailPagePath, detailApi(() => late.promise))
  const unloadPage = makePage(unloadDefinition)
  unloadPage.loadListing('ANCHOR')
  assert.strictEqual(typeof unloadPage.onUnload, 'function', '详情必须有卸载迟到响应门禁')
  unloadPage.onUnload()
  late.resolve({
    id: 'ANCHOR',
    companyListing: true,
    nearby: { radiusKm: 3, total: 1, hasMore: false, listings: nearbyRows('LATE', 1) }
  })
  await settle()
  assert.deepStrictEqual(unloadPage.data.nearbyListings, [], '卸载后迟到详情不得更新附近行')
}

async function runNearbyPageBehavior() {
  let token = 'TOKEN_A'
  const requests = []
  const toasts = []
  const navigations = []
  global.wx = {
    showToast(options) { toasts.push(options) },
    showModal() {},
    navigateTo(options) { navigations.push(options.url) },
    navigateBack() {}
  }
  const apiClient = { getAuthToken: () => token }
  const api = {
    getNearbyListings(id) {
      const request = deferred()
      requests.push({ id, token, request })
      return request.promise
    }
  }
  const definition = loadPage(nearbyPagePath, api, apiClient)
  const page = makePage(definition)
  page.onLoad({ id: 'ANCHOR' })
  page.onShow()
  assert.strictEqual(requests.length, 1)

  token = 'TOKEN_B'
  page.onShow()
  assert.strictEqual(requests.length, 2)
  assert.deepStrictEqual(page.data.listings, [], '换号时必须立即清空旧账号附近行')
  requests[0].request.resolve({ radiusKm: 3, total: 1, hasMore: false, listings: nearbyRows('A', 1) })
  await settle()
  assert.deepStrictEqual(page.data.listings, [], 'A 账号迟到成功不能污染 B')
  requests[1].request.resolve({ radiusKm: 3, total: 1, hasMore: false, listings: nearbyRows('B', 1) })
  await settle()
  assert.deepStrictEqual(page.data.listings.map((item) => item.id), ['B-1'])

  page.openListing({ currentTarget: { dataset: { id: 'MISSING' } } })
  assert.deepStrictEqual(navigations, [], '不得信任数据集导航到服务端结果外的房源')
  page.openListing({ currentTarget: { dataset: { id: 'B-1' } } })
  assert.ok(navigations[0].includes('B-1'))

  page.onShow()
  const lateRequest = requests[2].request
  page.onUnload()
  lateRequest.reject(new Error('迟到失败'))
  await settle()
  assert.ok(!toasts.some((item) => /加载失败/.test(item.title || '')), '卸载后迟到失败不得 toast')
}

async function run() {
  ;[nearbyPagePath, nearbyJsonPath, nearbyWxmlPath].forEach((file) => {
    assert.ok(fs.existsSync(file), `必须新增全部附近房源页：${path.relative(repoRoot, file)}`)
  })

  const app = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'))
  assert.ok(app.pages.includes('pages/nearby-listings/nearby-listings'), 'app.json 必须注册全部附近房源页')

  await runApiContract()
  await runDetailBehavior()
  await runNearbyPageBehavior()

  const detailWxml = fs.readFileSync(detailWxmlPath, 'utf8')
  const nearbyWxml = fs.readFileSync(nearbyWxmlPath, 'utf8')
  const nearbyJson = JSON.parse(fs.readFileSync(nearbyJsonPath, 'utf8'))
  assert.ok(/wx:if="\{\{nearbyListings\.length\}\}"/.test(detailWxml), '详情附近板块必须只在真实有结果时渲染')
  assert.ok(!/暂无附近|附近暂无|没有附近房源/.test(detailWxml), '详情不得渲染误导性附近空板块')
  assert.ok(/nearbyHasMore/.test(detailWxml) && /goNearbyListings/.test(detailWxml), '超过 6 套必须提供查看全部入口')
  assert.ok(/binderror="onNearbyCoverError"/.test(detailWxml) && /data-cover="\{\{item\.coverUrl\}\}"/.test(detailWxml), '详情附近封面失败必须按房源 ID 与原 URL 安全降级')
  const detailWxss = fs.readFileSync(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.wxss'), 'utf8')
  assert.ok(/\.nearby-all-button\s*\{[\s\S]*?min-height:\s*88rpx/.test(detailWxss), '查看全部按钮触控高度至少 88rpx')
  assert.ok(/favorite-toggle[^>]+listing-id="\{\{item\.id\}\}"/.test(detailWxml), '详情附近卡必须绑定当前推荐行的星标')
  assert.ok(/favorite-toggle[^>]+listing-id="\{\{item\.id\}\}"/.test(nearbyWxml), '全部附近页必须绑定当前行星标')
  assert.strictEqual(nearbyJson.usingComponents['favorite-toggle'], '/components/favorite-toggle/favorite-toggle')
  ;['distanceText', 'sourceLabel', 'rentMode', 'layout', 'features', 'price'].forEach((field) => {
    assert.ok(detailWxml.includes(`item.${field}`), `详情附近卡必须展示 ${field}`)
    assert.ok(nearbyWxml.includes(`item.${field}`), `全部附近卡必须展示 ${field}`)
  })
  assert.ok(/catchtap="toggleFavorite"/.test(favoriteWxml), '共享星标必须继续阻止卡片点击冒泡')

  console.log('listing-nearby-page-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
