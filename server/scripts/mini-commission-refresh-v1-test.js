'use strict'

// P2③ 动态回归：后台改分佣配置后，上传页/详情页在生命周期以服务端为准刷新展示；且必须真正闭合异步竞态。
// 不做静态字符串断言（会被注释/字段名假绿），而是实例化 Page、用 deferred Promise 驱动 onLoad/onShow/
// refreshCommissionDisplay，验证：上传首屏不双拉；详情静默刷新在乱序、卸载、全量重载时作废，正常刷新只改
// 分佣字段且不重置敏感态。

const assert = require('assert')
const fs = require('fs')
const Module = require('module')
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
  const mutant = String(process.env.YNZY_TEST_COMMISSION_MUTANT || '')
  if (pagePath === detailPagePath && mutant) {
    const original = fs.readFileSync(pagePath, 'utf8')
    let source = original
    if (mutant === 'drop-load-generation') {
      source = source.replace(/\n\s*if \(this\.listingLoadGeneration !== loadGeneration\) return[^\n]*/, '\n      // 审计变异：删除全量加载代次门')
    } else if (mutant === 'replace-partial-patch') {
      source = source.replace(/\s*const patch = \{\}[\s\S]*?if \(Object\.keys\(patch\)\.length > 0\) this\.setData\(patch\)/, '\n      this.setData({ listing })')
    } else if (mutant === 'write-non-commission-field') {
      source = source.replace(/if \(Object\.keys\(patch\)\.length > 0\) this\.setData\(patch\)/, "patch['listing.coverUrl'] = 'MUTATED-NON-COMMISSION-COVER'\n      if (Object.keys(patch).length > 0) this.setData(patch)")
    } else if (mutant === 'session-change-silent-only') {
      source = source.replace(
        'if (this.reloadForAuthSessionChange(nextToken)) return',
        "if (nextToken !== String(this.authTokenSnapshot || '')) { this.authTokenSnapshot = nextToken; this.refreshCommissionDisplay(); return }"
      )
    }
    assert.notStrictEqual(source, original, `未知或未命中的详情变异：${mutant}`)
    const compiled = new Module(pagePath, module)
    compiled.filename = pagePath
    compiled.paths = Module._nodeModulePaths(path.dirname(pagePath))
    compiled._compile(source, pagePath)
  } else {
    require(pagePath)
  }
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

function listingResult(total, overrides = {}) {
  return {
    id: 'L-1',
    unavailable: false,
    title: '稳定标题',
    videoUrl: 'https://media.example/stable.mp4',
    coverUrl: 'https://media.example/stable.jpg',
    commissionBreakdown: { total },
    nearby: {
      listings: [{ id: 'N-1', title: '附近稳定房源' }],
      total: 1,
      hasMore: false
    },
    ...overrides
  }
}

const COMMISSION_LISTING_KEYS = [
  'commissionBreakdown',
  'commissionText',
  'commission',
  'commissionBadge',
  'commissionRate'
]

function pageDataWithoutCommissionFields(data) {
  const copy = JSON.parse(JSON.stringify(data || {}))
  if (copy.listing && typeof copy.listing === 'object') {
    COMMISSION_LISTING_KEYS.forEach((key) => { delete copy.listing[key] })
  }
  return copy
}

function makeDetailHarness() {
  const detailReqs = []
  installApiStub({
    getListingDetail() { const d = deferred(); detailReqs.push(d); return d.promise },
    getListingLogs() { return Promise.resolve([{ time: 'SYNTHETIC-TIME', action: '稳定足迹' }]) },
    // 无 id 的空 user：避开足迹补发机制，聚焦分佣刷新门禁。
    getProfileState() { return Promise.resolve({ user: {} }) }
  })
  return { page: makePage(loadPage(detailPagePath)), detailReqs }
}

async function loadInitialDetail(harness, total = 'INIT') {
  harness.page.onLoad({ id: 'L-1' })
  assert.strictEqual(harness.detailReqs.length, 1, 'onLoad 应发起首个完整详情请求')
  harness.detailReqs[0].resolve(listingResult(total))
  await flushPromises()
  assert.strictEqual(harness.page.data.listing.commissionBreakdown.total, total, '首屏完整详情应落库')
}

// ---- P2③-a：详情静默刷新必须只更新分佣，并覆盖真实“静默刷新在途→全量加载先完成→旧刷新迟到”竞争。----
async function testDetailCommissionRefreshGuards() {
  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_A'
  const normal = makeDetailHarness()
  await loadInitialDetail(normal)
  const page = normal.page
  const detailReqs = normal.detailReqs

  // 正常静默刷新只能改分佣字段；响应即使夹带标题、视频、附近等内容，也不得覆盖完整详情和足迹。
  page.data.sensitiveVisible = true
  page.data.isVerified = true
  const beforeNormalRefresh = pageDataWithoutCommissionFields(page.data)
  page.onShow()
  detailReqs[1].resolve(listingResult('NEW', {
    title: '不得覆盖标题',
    videoUrl: 'https://media.example/should-not-replace.mp4',
    nearby: { listings: [{ id: 'N-BAD' }], total: 99, hasMore: true }
  }))
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'NEW', '正常静默刷新应更新分佣明细')
  assert.deepStrictEqual(
    pageDataWithoutCommissionFields(page.data),
    beforeNormalRefresh,
    '静默刷新只能改五个佣金展示字段；标题、封面、视频、附近、足迹、敏感态和全部其它页面状态必须逐项不变'
  )

  // 两次同会话 onShow 造乱序，第二次先回不得被第一次迟到覆盖。
  page.onShow() // refresh#2 → detailReqs[2]
  page.onShow() // refresh#3 → detailReqs[3]
  detailReqs[3].resolve(listingResult('LATEST'))
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'LATEST', '最新 onShow 刷新应写入')
  detailReqs[2].resolve(listingResult('STALE'))
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'LATEST', '迟到的旧刷新不得乱序覆盖最新值')

  // 同一活跃页面：静默刷新在途时发起真实全量 loadListing；全量响应先完成，旧静默响应后到。
  // 删除 listingLoadGeneration 响应门后，本断言必须稳定失败。
  page.onShow() // refresh#4 → detailReqs[4]
  page.loadListing('L-1') // full#2 → detailReqs[5]，listingLoadGeneration 前进
  detailReqs[5].resolve(listingResult('FULL-NEW', {
    title: '全量新标题',
    videoUrl: 'https://media.example/full-new.mp4',
    nearby: { listings: [{ id: 'N-2', title: '全量附近房源' }], total: 1, hasMore: false }
  }))
  await flushPromises()
  detailReqs[4].resolve(listingResult('STALE-AFTER-FULL'))
  await flushPromises()
  assert.strictEqual(page.data.listing.commissionBreakdown.total, 'FULL-NEW', '旧静默刷新不得覆盖后来完成的全量详情分佣')
  assert.strictEqual(page.data.listing.title, '全量新标题', '全量详情的标题必须保持')
  assert.strictEqual(page.data.listing.videoUrl, 'https://media.example/full-new.mp4', '全量详情的视频必须保持')
  assert.deepStrictEqual(page.data.nearbyListings.map((item) => item.id), ['N-2'], '全量详情的附近房源必须保持')

  // 卸载是页面实例终点：单独实例验证，禁止像旧测试那样 onUnload 后复用同一实例 onShow。
  const unloaded = makeDetailHarness()
  await loadInitialDetail(unloaded, 'UNLOAD-INIT')
  unloaded.page.onShow()
  unloaded.page.onUnload()
  unloaded.detailReqs[1].resolve(listingResult('AFTER-UNLOAD'))
  await flushPromises()
  assert.strictEqual(unloaded.page.data.listing.commissionBreakdown.total, 'UNLOAD-INIT', '卸载后刷新响应不得写入')

  // A→B 换号使用另一个仍存活的页面实例；旧 A 响应必须被会话键作废，B 的 onShow 走全量重载。
  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_A'
  const crossAccount = makeDetailHarness()
  await loadInitialDetail(crossAccount, 'A-INIT')
  crossAccount.page.setData({
    'listing.title': 'A-旧标题',
    'listing.coverUrl': 'https://media.example/a-old.jpg',
    'listing.videoUrl': 'https://media.example/a-old.mp4',
    'listing.exactAddress': 'SYNTHETIC-A-PRIVATE-ADDRESS',
    'listing.landlordPhone': 'SYNTHETIC-A-PRIVATE-PHONE',
    nearbyListings: [{ id: 'A-NEARBY' }],
    logs: [{ time: 'A-OLD-TIME', action: 'A-旧足迹' }],
    currentUserId: 'USER-A',
    isVerified: true,
    sensitiveVisible: true
  })
  crossAccount.page.onShow()
  authToken = 'TOKEN_B'
  authSessionKey = 'SESSION_B'
  crossAccount.detailReqs[1].resolve(listingResult('CROSS-ACCOUNT'))
  await flushPromises()
  assert.strictEqual(crossAccount.page.data.listing.commissionBreakdown.total, 'A-INIT', '换号后旧会话刷新响应不得写入')
  assert.strictEqual(crossAccount.page.data.listing.exactAddress, 'SYNTHETIC-A-PRIVATE-ADDRESS', 'B 的 onShow 前测试前置应保留 A 的敏感详情，以验证同步清屏')

  crossAccount.page.onShow()
  assert.deepStrictEqual(crossAccount.page.data.listing, {}, '检测到换号后必须立即清空 A 的整份房源详情')
  assert.deepStrictEqual(crossAccount.page.data.logs, [], '检测到换号后必须立即清空 A 的足迹')
  assert.deepStrictEqual(crossAccount.page.data.nearbyListings, [], '检测到换号后必须立即清空 A 的附近房源')
  assert.strictEqual(crossAccount.page.data.sensitiveVisible, false, '检测到换号后必须立即关闭 A 的敏感信息展示态')
  assert.strictEqual(crossAccount.page.data.currentUserId, '', '检测到换号后必须立即清空 A 的用户身份')
  assert.strictEqual(crossAccount.page.data.isVerified, false, '检测到换号后必须立即清空 A 的实名状态')
  assert.strictEqual(crossAccount.page.data.listingLoading, true, '换号后必须进入 B 的完整详情加载态，而不是仅静默刷新佣金')
  crossAccount.detailReqs[2].resolve(listingResult('B-INIT', {
    title: 'B-新标题',
    coverUrl: 'https://media.example/b-new.jpg',
    videoUrl: 'https://media.example/b-new.mp4',
    nearby: { listings: [{ id: 'B-NEARBY', title: 'B-附近房源' }], total: 1, hasMore: false }
  }))
  await flushPromises()
  assert.strictEqual(crossAccount.page.data.listing.commissionBreakdown.total, 'B-INIT', '换号后应重载出 B 的详情')
  assert.strictEqual(crossAccount.page.data.listing.title, 'B-新标题', '换号后必须完整落地 B 的标题')
  assert.strictEqual(crossAccount.page.data.listing.coverUrl, 'https://media.example/b-new.jpg', '换号后必须完整落地 B 的封面')
  assert.strictEqual(crossAccount.page.data.listing.videoUrl, 'https://media.example/b-new.mp4', '换号后必须完整落地 B 的视频')
  assert.deepStrictEqual(crossAccount.page.data.nearbyListings.map((item) => item.id), ['B-NEARBY'], '换号后必须完整落地 B 的附近房源')
  assert.strictEqual('exactAddress' in crossAccount.page.data.listing, false, 'B 的完整 DTO 不得残留 A 的精确地址')
  assert.strictEqual('landlordPhone' in crossAccount.page.data.listing, false, 'B 的完整 DTO 不得残留 A 的房东电话')
  assert.strictEqual(crossAccount.page.data.sensitiveVisible, false, 'B 的公开详情加载完成后不得复活 A 的敏感展示态')
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
