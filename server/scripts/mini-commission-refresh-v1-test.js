'use strict'

// P2③ 动态回归：后台改分佣配置后，上传页/详情页在生命周期以服务端为准刷新展示；且必须真正闭合异步竞态。
// 不做静态字符串断言（会被注释/字段名假绿），而是实例化 Page、用 deferred Promise 驱动 onLoad/onShow/
// refreshCommissionDisplay，验证：上传首屏不双拉；详情静默刷新在乱序、卸载、全量重载时作废，正常刷新只改
// 分佣字段且不重置敏感态。

const assert = require('assert')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const detailPagePath = require.resolve(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js'))
const uploadPagePath = require.resolve(path.join(repoRoot, 'pages', 'upload', 'upload.js'))

let authToken = ''
let authSessionKey = ''

global.getApp = () => ({ globalData: { authToken, authSessionKey } })
global.wx = {
  hideShareMenu() {}, showToast() {}, showModal() {}, showLoading() {}, hideLoading() {},
  navigateTo() {}, navigateBack() {}, redirectTo() {}, switchTab() {},
  chooseMedia() {}, getStorageSync() { return authToken }, setStorageSync() {}, removeStorageSync() {}
}

function setAtPath(target, key, value) {
  const parts = key.split('.')
  let current = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {}
    current = current[parts[i]]
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

function installApiStub(stub) {
  require.cache[apiServicePath] = { id: apiServicePath, filename: apiServicePath, loaded: true, exports: stub }
}

function loadPage(pagePath) {
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
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function validCommissionConfig() {
  return { secondLandlordRate: 20, ownerRate: 20, secondLandlordPlatformRate: 10, ownerPlatformRate: 10 }
}

// ---- P2③-a：详情静默刷新的异步门禁（乱序 / 卸载 / 全量重载 / 正常不重置敏感态）----
async function testDetailCommissionRefreshGuards() {
  authToken = 'TOKEN_X'
  authSessionKey = 'SESSION_X'
  const requests = []
  installApiStub({
    getListingDetail() { const d = deferred(); requests.push(d); return d.promise }
  })
  const page = makePage(loadPage(detailPagePath))
  page._pageActive = true
  page.listingId = 'L-1'
  page.listingLoadGeneration = 5
  page.data.listingLoading = false
  page.data.listing = { id: 'L-1', commissionBreakdown: { total: 'OLD' } }

  // 乱序：两次刷新，第二次(NEW)先回、第一次(STALE)后回不得覆盖 NEW。
  page.refreshCommissionDisplay() // seq=1 → requests[0]
  page.refreshCommissionDisplay() // seq=2 → requests[1]
  requests[1].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'NEW' } })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'NEW', '最新刷新应写入 NEW')
  requests[0].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'STALE' } })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'NEW', '迟到的旧刷新不得乱序覆盖 NEW')

  // 卸载：刷新后 _pageActive=false，响应到达不得 setData。
  page.data.listing = { id: 'L-1', commissionBreakdown: { total: 'BEFORE-UNLOAD' } }
  page.refreshCommissionDisplay() // seq=3 → requests[2]
  page._pageActive = false
  requests[2].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'AFTER-UNLOAD' } })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'BEFORE-UNLOAD', '卸载后不得写入')

  // 全量重载：刷新后 listingLoadGeneration 变化，响应不得写入半成品详情。
  page._pageActive = true
  page.data.listing = { id: 'L-1', commissionBreakdown: { total: 'BEFORE-RELOAD' } }
  page.refreshCommissionDisplay() // 捕获 loadGeneration=5 → requests[3]
  page.listingLoadGeneration = 6
  requests[3].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'AFTER-RELOAD' } })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'BEFORE-RELOAD', '全量重载期间旧刷新不得写半成品')

  // 正常：只更新分佣字段，不重置敏感展示态。
  page.listingLoadGeneration = 6
  page.data.listing = { id: 'L-1', commissionBreakdown: { total: 'D-OLD' } }
  page.data.sensitiveVisible = true
  page.data.isVerified = true
  page.refreshCommissionDisplay() // → requests[4]
  requests[4].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'D-NEW' }, sensitiveVisible: false, isVerified: false })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'D-NEW', '正常刷新应更新分佣明细')
  assert.strictEqual(page.data.sensitiveVisible, true, '刷新不得重置敏感展示态')
  assert.strictEqual(page.data.isVerified, true, '刷新不得重置已验证态')
}

// ---- P2③-b：上传页首屏不重复拉取（onLoad + 首次 onShow 合计 1 次），后续恢复显示再刷新 ----
async function testUploadFirstShowSkipsDuplicate() {
  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_A'
  let configLoads = 0
  installApiStub({
    getCurrentUser() { return Promise.resolve({ id: 'U-A', isAdmin: false }) },
    getCommissionConfig() { configLoads += 1; return Promise.resolve(validCommissionConfig()) },
    getEditableListing() { return Promise.reject(new Error('本用例不进入编辑态')) }
  })
  const uploadPage = makePage(loadPage(uploadPagePath))
  uploadPage.onLoad({})
  await flushPromises()
  const afterLoad = configLoads
  assert.ok(afterLoad >= 1, 'onLoad 应至少拉取一次分佣配置')

  uploadPage.onShow() // 首次 onShow：onLoad 已拉过，应跳过
  await flushPromises()
  assert.strictEqual(configLoads, afterLoad, '首次 onShow 不得重复拉取分佣配置（避免首屏固定双请求）')

  uploadPage.onShow() // 后续恢复显示：应刷新一次
  await flushPromises()
  assert.strictEqual(configLoads, afterLoad + 1, '后续恢复显示应重新拉取一次分佣配置')
}

async function run() {
  await testDetailCommissionRefreshGuards()
  await testUploadFirstShowSkipsDuplicate()
}

run().then(() => {
  console.log('mini-commission-refresh-v1-test passed')
}).catch((error) => {
  console.error(`mini-commission-refresh-v1-test failed: ${error.stack || error.message}`)
  process.exit(1)
})
