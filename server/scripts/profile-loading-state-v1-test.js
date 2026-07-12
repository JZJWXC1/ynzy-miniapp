const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client.js'))
const profilePagePath = require.resolve(path.join(repoRoot, 'pages', 'profile', 'profile.js'))
const profileWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'profile', 'profile.wxml'), 'utf8')

let modals = []
let toasts = []
let authToken = 'TOKEN_A'

global.wx = {
  showModal(options) { modals.push(options) },
  showToast(options) { toasts.push(options) },
  navigateTo() {},
  switchTab() {}
}

global.getApp = () => ({ logout() {} })

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

function loadDefinition(apiStub) {
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: { getAuthToken: () => authToken }
  }
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[profilePagePath]
  require(profilePagePath)
  assert.ok(definition, '未捕获“我的”页面定义')
  return definition
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

function successApi(userName = '测试中介') {
  return {
    getProfileState() {
      return Promise.resolve({
        user: { id: `U-${userName}`, name: userName, role: '中介', authed: '已实名' },
        sourceStats: [{ label: '我的房源', value: 3 }],
        reminders: [{ title: '真实提醒', value: '来自服务端' }]
      })
    },
    getFootprintRecords() { return Promise.resolve([{ id: 'F1' }]) }
  }
}

async function run() {
  let shouldFail = false
  const api = successApi('可信账号')
  const wrappedApi = {}
  Object.keys(api).forEach((name) => {
    wrappedApi[name] = () => shouldFail
      ? Promise.reject(new Error('资料服务暂不可用'))
      : api[name]()
  })
  const definition = loadDefinition(wrappedApi)
  const page = makePage(definition)
  assert.deepStrictEqual(page.data.reminders, [], '资料成功前不得展示示例提醒')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(page.data, 'dealWorkbench'), false, '暂停期间不得生成报备/签单工作台状态')
  assert.strictEqual(typeof page.retryProfile, 'function', '“我的”页必须提供重试方法')

  page.refreshProfile()
  assert.strictEqual(page.data.profileLoading, true, '“我的”页完整请求周期必须进入加载态')
  await flushPromises()
  assert.strictEqual(page.data.profileReady, true, '资料与足迹两接口成功后才可展示业务区')
  assert.strictEqual(page.data.profileLoading, false, '成功后必须结束加载态')
  assert.strictEqual(page.data.profileLoadFailed, false, '成功后必须清除失败态')
  assert.strictEqual(page.data.user.name, '可信账号', '页面账号必须来自服务端成功响应')
  assert.strictEqual(page.data.reminders[0].title, '真实提醒', '页面提醒必须来自服务端成功响应')
  assert.ok(!page.data.workbench.some((item) => /报备|签单/.test(item.title)), '暂停期间工作台不得出现报备/签单入口')

  shouldFail = true
  page.refreshProfile()
  await flushPromises()
  assert.strictEqual(page.data.profileLoadFailed, true, '刷新失败必须进入持续故障态')
  assert.strictEqual(page.data.profileReady, true, '刷新失败必须保留上次可信业务区')
  assert.strictEqual(page.data.user.name, '可信账号', '刷新失败不得清空上次可信账号')
  assert.strictEqual(page.data.reminders[0].title, '真实提醒', '刷新失败不得回退示例提醒')

  const initialFailureDefinition = loadDefinition({
    getProfileState() { return Promise.reject(new Error('初次失败')) },
    getFootprintRecords() { return Promise.reject(new Error('初次失败')) }
  })
  const initialFailurePage = makePage(initialFailureDefinition)
  initialFailurePage.refreshProfile()
  await flushPromises()
  assert.strictEqual(initialFailurePage.data.profileReady, false, '初次失败不得展示业务区')
  assert.strictEqual(initialFailurePage.data.profileLoadFailed, true, '初次失败必须显示可重试故障态')
  assert.deepStrictEqual(initialFailurePage.data.reminders, [], '初次失败不得回退示例提醒')

  const authError = Object.assign(new Error('登录已失效'), { statusCode: 401 })
  const authDefinition = loadDefinition({
    getProfileState() { return Promise.reject(authError) },
    getFootprintRecords() { return Promise.reject(authError) }
  })
  const authPage = makePage(authDefinition)
  authPage.setData({
    profileReady: true,
    user: { id: 'U-OLD', name: '旧账号' },
    workbench: [{ title: '旧工作台' }],
    reminders: [{ title: '旧提醒' }]
  })
  authPage.refreshProfile()
  await flushPromises()
  assert.strictEqual(authPage.data.profileAccessRequired, true, '401/403 必须显示明确登录入口')
  assert.strictEqual(authPage.data.profileReady, false, '登录失效必须隐藏旧账号业务区')
  assert.deepStrictEqual(authPage.data.user, {}, '登录失效必须清除旧账号资料')
  assert.ok(modals.some((item) => /登录/.test(item.title)), '登录失效必须保留登录引导')

  let resolveStaleProfile = null
  let profileCalls = 0
  const raceApi = successApi('最新账号')
  raceApi.getProfileState = () => {
    profileCalls += 1
    if (profileCalls === 1) {
      return new Promise((resolve) => {
        resolveStaleProfile = resolve
      })
    }
    return Promise.resolve({
      user: { id: 'U-LATEST', name: '最新账号', role: '中介', authed: '已实名' },
      sourceStats: [],
      reminders: []
    })
  }
  const raceDefinition = loadDefinition(raceApi)
  const racePage = makePage(raceDefinition)
  racePage.refreshProfile()
  racePage.refreshProfile()
  await flushPromises()
  resolveStaleProfile({
    user: { id: 'U-STALE', name: '过期账号', role: '中介', authed: '已实名' },
    sourceStats: [],
    reminders: []
  })
  await flushPromises()
  assert.strictEqual(racePage.data.user.name, '最新账号', '过期资料响应不得覆盖最新账号')

  let resolveSwitchedProfile
  let resolveSwitchedFootprints
  const switchDefinition = loadDefinition({
    getProfileState() { return new Promise((resolve) => { resolveSwitchedProfile = resolve }) },
    getFootprintRecords() { return new Promise((resolve) => { resolveSwitchedFootprints = resolve }) }
  })
  const switchPage = makePage(switchDefinition)
  switchPage._profileAccountToken = 'TOKEN_A'
  switchPage.setData({
    profileReady: true,
    user: { id: 'U-A', name: '账号A' },
    workbench: [{ title: '我的收藏', value: '9 套' }],
    reminders: [{ title: 'A提醒' }],
    sourceStats: [{ label: 'A统计', value: '9' }],
    footprintCount: 9
  })
  authToken = 'TOKEN_B'
  switchPage.refreshProfile()
  assert.strictEqual(switchPage.data.profileReady, false, '换号请求发出时必须立即隐藏 A 的工作台')
  assert.deepStrictEqual(switchPage.data.user, {}, '换号请求发出时必须立即清空 A 资料')
  assert.deepStrictEqual(switchPage.data.workbench, [], '换号时不得短暂展示 A 的收藏数量')
  resolveSwitchedProfile({
    user: { id: 'U-B', name: '账号B', role: '中介', authed: '已实名' },
    favoriteCount: 1,
    sourceStats: [],
    reminders: []
  })
  resolveSwitchedFootprints([])
  await flushPromises()
  assert.strictEqual(switchPage.data.user.name, '账号B')
  assert.ok(switchPage.data.workbench.some((item) => item.title === '我的收藏' && item.value === '1 套'))

  authToken = 'TOKEN_B'
  switchPage.refreshProfile()
  authToken = 'TOKEN_C'
  resolveSwitchedProfile({
    user: { id: 'U-B-LATE', name: '迟到账号B', role: '中介', authed: '已实名' },
    favoriteCount: 99,
    sourceStats: [],
    reminders: []
  })
  resolveSwitchedFootprints([])
  await flushPromises()
  assert.deepStrictEqual(switchPage.data.user, {}, 'B 成功响应迟到时不得回填 C 页面')
  assert.deepStrictEqual(switchPage.data.workbench, [], 'B 的收藏数量不得回填 C 工作台')

  authToken = 'TOKEN_B'
  switchPage.refreshProfile()
  authToken = 'TOKEN_C'
  const toastBeforeStaleFailure = toasts.length
  resolveSwitchedProfile(Promise.reject(new Error('unused')))
  resolveSwitchedFootprints(Promise.reject(new Error('unused')))
  await flushPromises()
  assert.deepStrictEqual(switchPage.data.user, {}, 'B 失败响应迟到时不得污染 C 页面')
  assert.strictEqual(toasts.length, toastBeforeStaleFailure, 'B 失败迟到不得在 C 弹加载失败')

  assert.ok(/bindtap="retryProfile"/.test(profileWxml), '“我的”页模板必须绑定重试入口')
  assert.ok(/bindtap="goLogin"/.test(profileWxml), '未登录状态必须绑定登录入口')
  assert.ok(/wx:if="\{\{profileReady\}\}"/.test(profileWxml), '业务区必须在资料成功后才展示')
  assert.ok(toasts.some((item) => /加载失败/.test(item.title)), '资料网络失败必须有即时提示')

  console.log('profile-loading-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
