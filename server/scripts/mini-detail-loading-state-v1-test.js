const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client.js'))
const detailPagePath = require.resolve(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js'))
const sharedVideoPagePath = require.resolve(path.join(repoRoot, 'pages', 'shared-video', 'shared-video.js'))
const detailWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.wxml'), 'utf8')
const sharedVideoWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'shared-video', 'shared-video.wxml'), 'utf8')

let authToken = ''
let toasts = []
let modals = []

global.getApp = () => ({
  globalData: { authToken }
})

global.wx = {
  hideShareMenu() {},
  getStorageSync() { return authToken },
  showToast(options) { toasts.push(options) },
  showModal(options) { modals.push(options) },
  navigateTo() {},
  navigateBack() {},
  redirectTo() {},
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

function loadPage(pagePath, apiStub) {
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

function detailApi(overrides = {}) {
  return Object.assign({
    getListingDetail() {
      return Promise.resolve({ id: 'L-DETAIL', title: '详情状态测试房源', companyListing: true })
    },
    getListingLogs() { return Promise.resolve([]) },
    getProfileState() { return Promise.resolve({ user: {} }) },
    addSensitiveFootprint() { return Promise.resolve({ sensitive: {} }) }
  }, overrides)
}

function statusError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function settlePage() {
  await flushPromises()
  await flushPromises()
}

async function run() {
  authToken = ''
  toasts = []
  modals = []
  const networkDefinition = loadPage(detailPagePath, detailApi({
    getListingDetail() { return Promise.reject(statusError(503, '服务暂不可用')) }
  }))
  const networkPage = makePage(networkDefinition)
  networkPage.loadListing('L-NETWORK')
  await settlePage()
  assert.strictEqual(networkPage.data.listingLoadFailed, true, '详情网络/5xx 必须进入可重试失败态')
  assert.ok(!networkPage.data.unavailableListing.unavailable, '详情网络/5xx 不得伪装成房源失效')
  assert.ok(toasts.some((item) => /加载失败/.test(item.title)), '详情网络/5xx 必须提示加载失败')
  assert.ok(!toasts.some((item) => /不存在|已下架/.test(item.title)), '详情网络/5xx 不得提示不存在或已下架')
  assert.strictEqual(typeof networkPage.retryListing, 'function', '详情失败态必须提供重试方法')

  toasts = []
  const missingDefinition = loadPage(detailPagePath, detailApi({
    getListingDetail() { return Promise.reject(statusError(404, '房源不存在')) }
  }))
  const missingPage = makePage(missingDefinition)
  missingPage.loadListing('L-MISSING')
  await settlePage()
  assert.strictEqual(missingPage.data.unavailableListing.unavailable, true, '详情 404 必须进入真实失效态')
  assert.strictEqual(missingPage.data.listingLoadFailed, false, '详情 404 不应显示网络重试态')

  const authDefinition = loadPage(detailPagePath, detailApi({
    getListingDetail() { return Promise.reject(statusError(403, '请先登录')) }
  }))
  const authPage = makePage(authDefinition)
  authPage.loadListing('L-AUTH')
  await settlePage()
  assert.strictEqual(authPage.data.listingAccessRequired, true, '合作房源 403 必须保留明确登录入口')
  assert.strictEqual(authPage.data.listingLoadFailed, false, '合作房源 403 不应伪装成网络故障')

  let ownSensitiveShouldFail = true
  const ownApi = detailApi({
    getListingDetail() {
      return Promise.resolve({
        id: 'L-OWN',
        title: '我的房源',
        companyListing: false,
        ownListing: true
      })
    },
    getProfileState() {
      return Promise.resolve({ user: { id: 'U-OWN', role: '中介', authed: '已实名' } })
    },
    addSensitiveFootprint() {
      return ownSensitiveShouldFail
        ? Promise.reject(statusError(503, '敏感信息读取失败'))
        : Promise.resolve({ sensitive: { address: '测试地址', landlordPhone: '仅测试值' } })
    }
  })
  const ownDefinition = loadPage(detailPagePath, ownApi)
  const ownPage = makePage(ownDefinition)
  ownPage.loadListing('L-OWN')
  await settlePage()
  assert.strictEqual(ownPage.data.isOwnListing, true, '服务端上传人判定必须保留')
  assert.strictEqual(ownPage.data.sensitiveVisible, false, '上传人敏感信息读取失败不得标记已展示')
  assert.strictEqual(ownPage.data.ownSensitiveLoadFailed, true, '上传人读取失败必须提供可见重试态')
  assert.strictEqual(typeof ownPage.retryOwnSensitive, 'function', '上传人读取失败必须可重试')
  ownSensitiveShouldFail = false
  ownPage.retryOwnSensitive()
  await settlePage()
  assert.strictEqual(ownPage.data.sensitiveVisible, true, '上传人重试成功后才可展示敏感信息')
  assert.strictEqual(ownPage.data.listing.address, '测试地址', '上传人只能展示服务端成功返回的敏感字段')

  authToken = 'valid-local-token'
  const profileFailureDefinition = loadPage(detailPagePath, detailApi({
    getListingDetail() {
      return Promise.resolve({
        id: 'L-PROFILE',
        title: '登录态辅助请求测试',
        companyListing: false,
        ownListing: false,
        videoUrl: 'https://example.test/video.mp4'
      })
    },
    getProfileState() { return Promise.reject(statusError(503, '资料接口暂不可用')) }
  }))
  const profileFailurePage = makePage(profileFailureDefinition)
  profileFailurePage.loadListing('L-PROFILE')
  await settlePage()
  assert.strictEqual(profileFailurePage.data.isVerified, true, '有效 token 存在时 profile 辅助失败不得伪装退出登录')
  assert.strictEqual(profileFailurePage.data.canShareVideo, true, '有效 token 存在时视频转发能力不得被辅助请求误关')

  // 真实跨层回归曾是：游客公司详情主请求 200，但足迹/profile 两个辅助请求 401 后轮换 guest session。
  // 当前应只发送公开详情这一项；若以后误恢复辅助请求，下面仍返回 401，且请求清单断言会直接失败。
  authToken = ''
  const previousGetApp = global.getApp
  const previousRequest = global.wx.request
  let guestLogoutCount = 0
  const guestRequestPaths = []
  const guestApp = {
    globalData: {
      authToken: '',
      authSessionKey: 'guest-detail-session-1',
      apiConfig: {
        env: 'prod',
        baseUrl: 'https://api.example.test',
        timeout: 15000,
        token: ''
      }
    },
    logout() {
      guestLogoutCount += 1
      this.globalData.authToken = ''
      this.globalData.authSessionKey = `guest-detail-session-${guestLogoutCount + 1}`
      this.globalData.apiConfig.token = ''
    }
  }
  try {
    global.getApp = () => guestApp
    global.wx.request = (options) => {
      const url = String(options.url || '')
      guestRequestPaths.push(new URL(url).pathname)
      setImmediate(() => {
        if (/\/mini\/listings\/L-GUEST-COMPANY$/.test(url)) {
          options.success({
            statusCode: 200,
            header: {},
            data: {
              code: 0,
              data: {
                id: 'L-GUEST-COMPANY',
                title: '游客公司房源',
                companyListing: true,
                rent: '3000',
                layout: '整租一室',
                status: '在租',
                nearby: { listings: [], total: 0, hasMore: false }
              }
            }
          })
          return
        }
        if (/\/mini\/(?:profile|listings\/L-GUEST-COMPANY\/footprints)$/.test(url)) {
          options.success({ statusCode: 401, header: {}, data: { code: 401, message: '请先登录' } })
          return
        }
        options.fail({ errMsg: `unexpected request: ${url}` })
      })
    }
    delete require.cache[apiServicePath]
    delete require.cache[apiClientPath]
    delete require.cache[detailPagePath]
    let guestDetailDefinition = null
    global.Page = (value) => { guestDetailDefinition = value }
    require(detailPagePath)
    const guestDetailPage = makePage(guestDetailDefinition)
    guestDetailPage.loadListing('L-GUEST-COMPANY')
    await settlePage()
    await settlePage()
    assert.strictEqual(guestLogoutCount, 0, '游客辅助请求 401 不得调用 logout 轮换稳定 guest session')
    assert.strictEqual(guestApp.globalData.authSessionKey, 'guest-detail-session-1', '游客辅助 401 必须保持原 guest session')
    assert.deepStrictEqual(guestRequestPaths, ['/mini/listings/L-GUEST-COMPANY'], '游客公司详情只应请求公开详情，不得再请求受保护足迹或 profile')
    assert.strictEqual(guestDetailPage.data.listingLoading, false, '游客公司详情成功后必须结束加载态')
    assert.strictEqual(guestDetailPage.data.listing.id, 'L-GUEST-COMPANY', '游客公司详情 200 结果不得被误判为旧会话响应')
  } finally {
    global.getApp = previousGetApp
    global.wx.request = previousRequest
  }

  authToken = ''
  toasts = []
  const sharedNetworkDefinition = loadPage(sharedVideoPagePath, {
    getListingDetail() { return Promise.reject(statusError(503, '视频详情服务暂不可用')) }
  })
  const sharedNetworkPage = makePage(sharedNetworkDefinition)
  sharedNetworkPage.loadListing('L-SHARED')
  await settlePage()
  assert.strictEqual(sharedNetworkPage.data.loadFailed, true, '租客视频网络/5xx 必须进入可重试失败态')
  assert.strictEqual(sharedNetworkPage.data.unavailable, false, '租客视频网络/5xx 不得伪装成房源失效')
  assert.ok(!toasts.some((item) => /不存在|已下架/.test(item.title)), '租客视频网络/5xx 不得误报不存在或已下架')

  const sharedAuthDefinition = loadPage(sharedVideoPagePath, {
    getListingDetail() { return Promise.reject(statusError(403, '请先登录')) }
  })
  const sharedAuthPage = makePage(sharedAuthDefinition)
  sharedAuthPage.loadListing('L-SHARED-AUTH')
  await settlePage()
  assert.strictEqual(sharedAuthPage.data.accessRequired, true, '租客视频合作房源 403 必须保留登录入口')
  assert.strictEqual(sharedAuthPage.data.loadFailed, false, '租客视频合作房源 403 不得伪装成网络故障')

  const sharedMissingDefinition = loadPage(sharedVideoPagePath, {
    getListingDetail() { return Promise.reject(statusError(404, '房源不存在')) }
  })
  const sharedMissingPage = makePage(sharedMissingDefinition)
  sharedMissingPage.loadListing('L-SHARED-MISSING')
  await settlePage()
  assert.strictEqual(sharedMissingPage.data.unavailable, true, '租客视频 404 必须进入真实失效态')
  assert.strictEqual(sharedMissingPage.data.loadFailed, false, '租客视频 404 不应显示网络重试态')

  assert.ok(/bindtap="retryListing"/.test(detailWxml), '详情故障卡必须绑定重试入口')
  assert.ok(/bindtap="retryOwnSensitive"/.test(detailWxml), '上传人敏感信息故障必须绑定重试入口')
  assert.ok(/bindtap="retryLoad"/.test(sharedVideoWxml), '租客视频故障卡必须绑定重试入口')

  console.log('mini-detail-loading-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
