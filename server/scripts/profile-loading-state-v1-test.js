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
let switchedTabs = []
let authToken = 'TOKEN_A'
let authSessionKey = 'SESSION_A'
let appLogoutCalls = 0

const appState = {
  logout() {
    appLogoutCalls += 1
    authToken = ''
    authSessionKey = `GUEST_${appLogoutCalls}`
  }
}

global.wx = {
  showModal(options) { modals.push(options) },
  showToast(options) { toasts.push(options) },
  navigateTo() {},
  switchTab(options) { switchedTabs.push(options && options.url) }
}

global.getApp = () => appState

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
    exports: {
      getAuthToken: () => authToken,
      getAuthSessionKey: () => authSessionKey,
      isStaleUnauthorized: (error) => Boolean(error && error.authResponseStale)
    }
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
  let guestProtectedCalls = 0
  authToken = ''
  authSessionKey = 'GUEST_INITIAL'
  const guestDefinition = loadDefinition({
    getProfileState() { guestProtectedCalls += 1; return Promise.reject(new Error('游客不应调用')) },
    getFootprintRecords() { guestProtectedCalls += 1; return Promise.reject(new Error('游客不应调用')) }
  })
  const guestPage = makePage(guestDefinition)
  await guestPage.refreshProfile()
  assert.strictEqual(guestProtectedCalls, 0, '游客打开“我的”不得先请求受保护工作台接口')
  assert.strictEqual(guestPage.data.profileAccessRequired, true, '游客必须直接看到登录卡和公开 FAQ')

  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_A'
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
  authToken = 'TOKEN_AUTH_EXPIRED'
  authSessionKey = 'SESSION_AUTH_EXPIRED'
  const authDefinition = loadDefinition({
    getProfileState() { authToken = ''; authSessionKey = 'GUEST_AUTH_EXPIRED'; return Promise.reject(authError) },
    getFootprintRecords() { authToken = ''; authSessionKey = 'GUEST_AUTH_EXPIRED'; return Promise.reject(authError) }
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
  assert.ok(!modals.some((item) => /登录后进入我的/.test(item.title)), '登录失效后应直接显示登录卡与 FAQ，不得强弹窗遮挡')

  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_RACE_A'
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
  switchPage._profileAccountToken = 'SESSION_RACE_A'
  switchPage.setData({
    profileReady: true,
    user: { id: 'U-A', name: '账号A' },
    workbench: [{ title: '我的收藏', value: '9 套' }],
    reminders: [{ title: 'A提醒' }],
    sourceStats: [{ label: 'A统计', value: '9' }],
    footprintCount: 9
  })
  authToken = 'TOKEN_B'
  authSessionKey = 'SESSION_B'
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
  authSessionKey = 'SESSION_B'
  switchPage.refreshProfile()
  authToken = 'TOKEN_C'
  authSessionKey = 'SESSION_C'
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
  authSessionKey = 'SESSION_B'
  switchPage.refreshProfile()
  authToken = 'TOKEN_C'
  authSessionKey = 'SESSION_C'
  const toastBeforeStaleFailure = toasts.length
  resolveSwitchedProfile(Promise.reject(new Error('unused')))
  resolveSwitchedFootprints(Promise.reject(new Error('unused')))
  await flushPromises()
  assert.deepStrictEqual(switchPage.data.user, {}, 'B 失败响应迟到时不得污染 C 页面')
  assert.strictEqual(toasts.length, toastBeforeStaleFailure, 'B 失败迟到不得在 C 弹加载失败')
  assert.ok(toasts.some((item) => /加载失败/.test(item.title)), '资料网络失败必须有即时提示')

  // 同账号滑动续签不改变稳定 session：旧 token 的迟到鉴权错误不得把新 token 会话误判为未登录。
  authToken = 'TOKEN_OLD'
  authSessionKey = 'SESSION_SLIDING'
  let rejectOldProfile
  let rejectOldFootprints
  let slidingProfileCalls = 0
  let slidingFootprintCalls = 0
  const slidingDefinition = loadDefinition({
    getProfileState() {
      slidingProfileCalls += 1
      if (slidingProfileCalls === 1) return new Promise((resolve, reject) => { rejectOldProfile = reject })
      return Promise.resolve({
        user: { id: 'U-SLIDING', name: '续签后账号', role: '中介', authed: '已实名' },
        sourceStats: [],
        reminders: []
      })
    },
    getFootprintRecords() {
      slidingFootprintCalls += 1
      if (slidingFootprintCalls === 1) return new Promise((resolve, reject) => { rejectOldFootprints = reject })
      return Promise.resolve([])
    }
  })
  const slidingPage = makePage(slidingDefinition)
  slidingPage.refreshProfile()
  authToken = 'TOKEN_REFRESHED'
  const staleAuthError = Object.assign(new Error('旧 token 迟到 401'), { statusCode: 401, authResponseStale: true })
  rejectOldProfile(staleAuthError)
  rejectOldFootprints(staleAuthError)
  await flushPromises()
  await flushPromises()
  assert.strictEqual(slidingPage.data.profileAccessRequired, false, '同 session 续签后的旧 401 不得显示登录卡')
  assert.strictEqual(slidingPage.data.user.name, '续签后账号', '旧 401 应触发当前 token 的资料重读')

  // 主动退出只允许当前会话消费结果：A 请求在途切到 B 后，A 的 200/401 都必须静默丢弃。
  for (const lateStatus of [200, 401]) {
    modals = []
    toasts = []
    switchedTabs = []
    appLogoutCalls = 0
    authToken = 'TOKEN_LOGOUT_A'
    authSessionKey = 'SESSION_LOGOUT_A'
    let resolveLogout
    let rejectLogout
    const logoutDefinition = loadDefinition({
      logout() { return new Promise((resolve, reject) => { resolveLogout = resolve; rejectLogout = reject }) },
      getProfileState() { return Promise.resolve({ user: { id: 'U-B', name: '账号B' }, sourceStats: [], reminders: [] }) },
      getFootprintRecords() { return Promise.resolve([]) }
    })
    const logoutPage = makePage(logoutDefinition)
    logoutPage.logout()
    const confirmModal = modals[modals.length - 1]
    assert.ok(confirmModal && typeof confirmModal.success === 'function', '退出必须先显示确认框')
    confirmModal.success({ confirm: true })
    authToken = 'TOKEN_LOGOUT_B'
    authSessionKey = 'SESSION_LOGOUT_B'
    logoutPage.refreshProfile()
    assert.strictEqual(logoutPage.data.logoutSubmitting, false, '切到 B 时必须立即解除 A 的退出 busy，允许 B 独立操作')
    if (lateStatus === 200) resolveLogout({ revoked: true })
    else rejectLogout(Object.assign(new Error('A 已失效'), { statusCode: 401 }))
    await flushPromises()
    await flushPromises()
    assert.strictEqual(appLogoutCalls, 0, `切到 B 后 A 的迟到 ${lateStatus} 不得清除 B`)
    assert.strictEqual(authToken, 'TOKEN_LOGOUT_B')
    assert.strictEqual(toasts.length, 0, `切到 B 后 A 的迟到 ${lateStatus} 不得显示退出提示`)
    assert.strictEqual(switchedTabs.length, 0, `切到 B 后 A 的迟到 ${lateStatus} 不得跳首页`)
  }

  // 当前会话的成功才真正清本地；普通网络失败保留 token 并明确提示失败。
  modals = []
  toasts = []
  switchedTabs = []
  appLogoutCalls = 0
  authToken = 'TOKEN_LOGOUT_CURRENT'
  authSessionKey = 'SESSION_LOGOUT_CURRENT'
  const logoutSuccessDefinition = loadDefinition({ logout: () => Promise.resolve({ revoked: true }) })
  const logoutSuccessPage = makePage(logoutSuccessDefinition)
  logoutSuccessPage.logout()
  modals[modals.length - 1].success({ confirm: true })
  await flushPromises()
  assert.strictEqual(appLogoutCalls, 1, '当前会话退出成功必须清除本地登录态')
  assert.ok(toasts.some((item) => /所有设备已退出/.test(item.title)))

  modals = []
  toasts = []
  switchedTabs = []
  appLogoutCalls = 0
  authToken = 'TOKEN_LOGOUT_FAIL'
  authSessionKey = 'SESSION_LOGOUT_FAIL'
  const logoutFailureDefinition = loadDefinition({ logout: () => Promise.reject(new Error('合成网络失败')) })
  const logoutFailurePage = makePage(logoutFailureDefinition)
  logoutFailurePage.logout()
  modals[modals.length - 1].success({ confirm: true })
  await flushPromises()
  assert.strictEqual(appLogoutCalls, 0, '服务端未确认退出时不得清本地')
  assert.strictEqual(authToken, 'TOKEN_LOGOUT_FAIL')
  assert.ok(modals.some((item) => item.title === '退出失败'), '网络失败必须明确提示退出失败')

  assert.ok(/bindtap="retryProfile"/.test(profileWxml), '“我的”页模板必须绑定重试入口')
  assert.ok(/bindtap="goLogin"/.test(profileWxml), '未登录状态必须绑定登录入口')
  assert.ok(/wx:if="\{\{profileReady\}\}"/.test(profileWxml), '业务区必须在资料成功后才展示')
  console.log('profile-loading-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
