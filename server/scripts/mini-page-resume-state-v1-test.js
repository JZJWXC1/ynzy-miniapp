const assert = require('assert')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const detailPagePath = require.resolve(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js'))
const uploadPagePath = require.resolve(path.join(repoRoot, 'pages', 'upload', 'upload.js'))

let authToken = ''

global.getApp = () => ({
  globalData: { authToken }
})

global.wx = {
  hideShareMenu() {},
  showToast() {},
  showModal() {},
  showLoading() {},
  hideLoading() {},
  navigateTo() {},
  navigateBack() {},
  redirectTo() {},
  switchTab() {},
  chooseMedia() {},
  getStorageSync() { return authToken }
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

function installApiStub(stub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: stub
  }
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

async function run() {
  let detailLoads = 0
  let profileLoads = 0
  authToken = ''
  installApiStub({
    getListingDetail() {
      detailLoads += 1
      return Promise.resolve({
        id: 'L-RESUME',
        title: '恢复态测试房源',
        videoUrl: 'https://example.test/resume.mp4',
        companyListing: false,
        ownListing: false
      })
    },
    getListingLogs() { return Promise.resolve([]) },
    getProfileState() {
      profileLoads += 1
      return Promise.resolve({
        user: authToken
          ? { id: 'U-RESUME', name: '恢复态中介', role: '中介', authed: '已实名' }
          : {}
      })
    }
  })
  const detailDefinition = loadPage(detailPagePath)
  const detailPage = makePage(detailDefinition)
  detailPage.onLoad({ id: 'L-RESUME' })
  await flushPromises()
  assert.strictEqual(detailLoads, 1, '详情页首次展示只应加载一次')
  assert.strictEqual(profileLoads, 1, '详情页首次展示只应读取一次登录态')
  assert.strictEqual(detailPage.data.isVerified, false, '游客首次进入应保持未登录状态')

  authToken = 'token-after-login'
  detailPage.onShow()
  await flushPromises()
  assert.strictEqual(detailLoads, 2, '登录返回详情页必须重新读取房源和登录态')
  assert.strictEqual(profileLoads, 2, '登录返回详情页必须重新读取当前用户')
  assert.strictEqual(detailPage.data.isVerified, true, '登录返回后敏感查看、带看和报备能力必须立即解锁')
  assert.strictEqual(detailPage.data.canShareVideo, true, '登录返回后视频转发能力必须立即更新')

  let currentUserLoads = 0
  authToken = ''
  installApiStub({
    getCurrentUser() {
      currentUserLoads += 1
      if (!authToken) {
        const error = new Error('未登录')
        error.statusCode = 401
        return Promise.reject(error)
      }
      return Promise.resolve({ id: 'U-ADMIN', name: '管理员', isAdmin: true })
    },
    getCommissionConfig() { return Promise.resolve({}) },
    getEditableListing() { return Promise.reject(new Error('本用例不进入编辑态')) }
  })
  const uploadDefinition = loadPage(uploadPagePath)
  const uploadPage = makePage(uploadDefinition)
  uploadPage.promptLoginGuide = () => {}
  uploadPage.onLoad({})
  await flushPromises()
  assert.strictEqual(currentUserLoads, 1, '上传页首次展示只应读取一次当前用户')
  assert.strictEqual(uploadPage.data.isAdmin, false, '游客首次进入上传页不应拥有管理员能力')

  authToken = 'admin-token-after-login'
  assert.strictEqual(typeof uploadPage.onShow, 'function', '上传页必须在返回前台时检查登录态变化')
  uploadPage.onShow()
  await flushPromises()
  assert.strictEqual(currentUserLoads, 2, '登录返回上传页必须重新读取当前用户')
  assert.strictEqual(uploadPage.data.isAdmin, true, '管理员登录返回后必须能选择公司房源')

  const reportPage = makePage(detailDefinition)
  reportPage.setData({
    isVerified: true,
    listing: { id: 'L-RESUME', rent: 3200 },
    reportForm: { customerName: '上一位客户', customerPhone: '13900000001' }
  })
  reportPage.startReportDeal()
  assert.deepStrictEqual(reportPage.data.reportForm, { customerName: '', customerPhone: '' }, '每次打开报备必须清空上一位客户信息')

  console.log('mini-page-resume-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
