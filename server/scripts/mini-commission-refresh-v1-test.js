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

// ---- P2③-a：详情静默刷新的异步门禁——全部经真实 onLoad/onShow/onUnload 生命周期入口 + A→B 换号驱动。----
async function testDetailCommissionRefreshGuards() {
  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_A'
  const detailReqs = []
  installApiStub({
    getListingDetail() { const d = deferred(); detailReqs.push(d); return d.promise },
    getListingLogs() { return Promise.resolve([]) },
    // 无 id 的空 user：避开足迹补发机制，聚焦分佣刷新门禁。
    getProfileState() { return Promise.resolve({ user: {} }) }
  })
  const page = makePage(loadPage(detailPagePath))

  // 真实 onLoad → loadListing 首屏加载（detailReqs[0]，listingLoadGeneration 前进）。
  page.onLoad({ id: 'L-1' })
  detailReqs[0].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'INIT' }, videoUrl: '' })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'INIT', '首屏加载分佣应为 INIT')

  // 真实 onShow（同会话）触发 refreshCommissionDisplay；两次 onShow 造乱序，第二次先回不得被第一次迟到覆盖。
  page.onShow() // refresh#1 → detailReqs[1]
  page.onShow() // refresh#2 → detailReqs[2]
  detailReqs[2].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'NEW' } })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'NEW', '最新 onShow 刷新应写入 NEW')
  detailReqs[1].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'STALE' } })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'NEW', '迟到的旧刷新不得乱序覆盖 NEW')

  // 真实 onUnload：刷新在途、页面卸载后响应到达不得 setData。
  page.onShow() // refresh → detailReqs[3]
  page.onUnload()
  detailReqs[3].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'AFTER-UNLOAD' } })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'NEW', '卸载后刷新响应不得写入')

  // 真实 A→B 换号：刷新在途时会话变为 B，旧会话响应（requestSessionKey=A）须被 sessionKey 校验作废。
  page.onShow() // 恢复显示（_pageActive=true，同会话）→ refresh → detailReqs[4]，requestSessionKey=SESSION_A
  authToken = 'TOKEN_B'
  authSessionKey = 'SESSION_B'
  detailReqs[4].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'CROSS-ACCOUNT' } })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'NEW', '换号后旧会话刷新响应不得写入（sessionKey 校验）')

  // 换号后真实 onShow 走全量重载而非静默刷新：detailReqs[5] 为 B 的全量重载（重载会正确重置敏感态）。
  page.onShow() // 会话已变 → reloadForAuthSessionChange → loadListing(B) → detailReqs[5]
  detailReqs[5].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'B-INIT' }, videoUrl: '' })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'B-INIT', '换号后应重载出 B 的详情')

  // 用户在 B 详情页解锁敏感信息后，同会话 onShow 走静默刷新：只改分佣、不得重置敏感态。
  page.data.sensitiveVisible = true
  page.data.isVerified = true
  page.onShow() // 同为 B 会话 → 静默刷新 → detailReqs[6]
  detailReqs[6].resolve({ id: 'L-1', unavailable: false, commissionBreakdown: { total: 'B-NEW' }, sensitiveVisible: false, isVerified: false })
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'B-NEW', '正常静默刷新应更新分佣明细')
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
  assert.strictEqual(configLoads, 1, 'onLoad 应恰好拉取 1 次分佣配置（onLoad 本身不得双拉）')

  uploadPage.onShow() // 首次 onShow：onLoad 已拉过，应跳过
  await flushPromises()
  assert.strictEqual(configLoads, 1, '首次 onShow 不得重复拉取（onLoad + 首次 onShow 合计恰好 1 次）')

  uploadPage.onShow() // 后续恢复显示：应刷新一次
  await flushPromises()
  assert.strictEqual(configLoads, 2, '后续恢复显示应再拉 1 次分佣配置')
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
