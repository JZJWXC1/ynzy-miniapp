'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const pagePath = require.resolve(path.join(repoRoot, 'pages', 'my-listings', 'my-listings.js'))
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client.js'))

let authToken = 'TOKEN-OWNER-A'
let authSessionKey = 'SESSION-OWNER-A'
let phoneCallback = null
let actionSheetCallback = null
const verifyCalls = []
let verifyImplementation = () => Promise.resolve({ ok: true })
let toastCalls = 0

require.cache[apiServicePath] = {
  id: apiServicePath,
  filename: apiServicePath,
  loaded: true,
  exports: {
    verifyMyListing(id, outcome) {
      verifyCalls.push({ id, outcome, sessionKey: authSessionKey })
      return verifyImplementation()
    }
  }
}
require.cache[apiClientPath] = {
  id: apiClientPath,
  filename: apiClientPath,
  loaded: true,
  exports: {
    getAuthToken() { return authToken },
    getAuthSessionKey() { return authSessionKey }
  }
}

global.wx = {
  navigateTo() {},
  showToast() { toastCalls += 1 },
  makePhoneCall(options) { phoneCallback = options.complete },
  showActionSheet(options) { actionSheetCallback = options.success }
}

let definition = null
global.Page = (value) => { definition = value }
require(pagePath)
assert.ok(definition, '未捕获我的房源页面定义')

function setAtPath(target, key, value) {
  const parts = String(key).replace(/\[(\d+)\]/g, '.$1').split('.')
  let current = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (!current[part] || typeof current[part] !== 'object') current[part] = /^\d+$/.test(parts[index + 1]) ? [] : {}
    current = current[part]
  }
  current[parts[parts.length - 1]] = value
}

function makePage() {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  page._pageActive = true
  page.authSessionSnapshot = authSessionKey
  page.data.isCompanyMode = false
  page.data.listings = [{ id: 'L-OWNER-A', landlordPhone: '13900000001' }]
  page.allOwnerListings = page.data.listings.slice()
  page.refreshCalls = 0
  page.refresh = () => { page.refreshCalls += 1 }
  return page
}

function openVerification(page) {
  phoneCallback = null
  actionSheetCallback = null
  page.verifyListing({ currentTarget: { dataset: { id: 'L-OWNER-A', phone: '13900000001' } } })
  assert.strictEqual(typeof phoneCallback, 'function', '房态核验必须先进入拨号完成回调')
  phoneCallback()
  assert.strictEqual(typeof actionSheetCallback, 'function', '拨号结束后必须显示三选一结果')
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function run() {
  verifyCalls.length = 0
  toastCalls = 0
  verifyImplementation = () => Promise.resolve({ ok: true })

  authToken = 'TOKEN-OWNER-PHONE-A'
  authSessionKey = 'SESSION-OWNER-PHONE-A'
  const phoneSwitchedPage = makePage()
  phoneCallback = null
  actionSheetCallback = null
  phoneSwitchedPage.verifyListing({ currentTarget: { dataset: { id: 'L-OWNER-A', phone: '13900000001' } } })
  authToken = 'TOKEN-OWNER-PHONE-B'
  authSessionKey = 'SESSION-OWNER-PHONE-B'
  phoneSwitchedPage.syncAuthSession()
  phoneCallback()
  assert.strictEqual(actionSheetCallback, null, 'A 的拨号尚未完成时切 B，不得再打开旧三选一')

  authToken = 'TOKEN-OWNER-PHONE-UNLOAD'
  authSessionKey = 'SESSION-OWNER-PHONE-UNLOAD'
  const phoneUnloadedPage = makePage()
  phoneCallback = null
  actionSheetCallback = null
  phoneUnloadedPage.verifyListing({ currentTarget: { dataset: { id: 'L-OWNER-A', phone: '13900000001' } } })
  phoneUnloadedPage.onUnload()
  phoneCallback()
  assert.strictEqual(actionSheetCallback, null, '拨号尚未完成时卸载页面，不得再打开三选一')

  authToken = 'TOKEN-OWNER-A'
  authSessionKey = 'SESSION-OWNER-A'
  const switchedPage = makePage()
  openVerification(switchedPage)
  authToken = 'TOKEN-OWNER-B'
  authSessionKey = 'SESSION-OWNER-B'
  switchedPage.syncAuthSession()
  actionSheetCallback({ tapIndex: 1 })
  await Promise.resolve()
  assert.strictEqual(verifyCalls.length, 0, 'A 打开的旧三选一不得以 B 会话核验房源')

  authToken = 'TOKEN-OWNER-UNLOAD'
  authSessionKey = 'SESSION-OWNER-UNLOAD'
  const unloadedPage = makePage()
  openVerification(unloadedPage)
  unloadedPage.onUnload()
  actionSheetCallback({ tapIndex: 0 })
  await Promise.resolve()
  assert.strictEqual(verifyCalls.length, 0, '我的房源页卸载后旧三选一不得继续核验房源')

  authToken = 'TOKEN-OWNER-API-A'
  authSessionKey = 'SESSION-OWNER-API-A'
  const apiWaiter = deferred()
  verifyImplementation = () => apiWaiter.promise
  const apiSwitchedPage = makePage()
  openVerification(apiSwitchedPage)
  actionSheetCallback({ tapIndex: 1 })
  assert.strictEqual(verifyCalls.length, 1, '同会话选择结果后必须发起一次核验请求')
  authToken = 'TOKEN-OWNER-API-B'
  authSessionKey = 'SESSION-OWNER-API-B'
  apiSwitchedPage.syncAuthSession()
  const toastBeforeLateSuccess = toastCalls
  apiWaiter.resolve({ ok: true })
  await flushPromises()
  assert.strictEqual(toastCalls, toastBeforeLateSuccess, '核验请求期间切 B 后，A 的迟到成功不得弹提示')
  assert.strictEqual(apiSwitchedPage.refreshCalls, 0, '核验请求期间切 B 后，A 的迟到成功不得刷新 B 页面')

  verifyCalls.length = 0
  authToken = 'TOKEN-OWNER-API-UNLOAD'
  authSessionKey = 'SESSION-OWNER-API-UNLOAD'
  const rejectWaiter = deferred()
  verifyImplementation = () => rejectWaiter.promise
  const apiUnloadedPage = makePage()
  openVerification(apiUnloadedPage)
  actionSheetCallback({ tapIndex: 0 })
  apiUnloadedPage.onUnload()
  const toastBeforeLateFailure = toastCalls
  rejectWaiter.reject(new Error('synthetic late failure'))
  await flushPromises()
  assert.strictEqual(toastCalls, toastBeforeLateFailure, '页面卸载后核验迟到失败不得弹提示')
  assert.strictEqual(apiUnloadedPage.refreshCalls, 0, '页面卸载后核验迟到失败不得刷新')

  verifyCalls.length = 0
  verifyImplementation = () => Promise.resolve({ ok: true })
  authToken = 'TOKEN-OWNER-CURRENT'
  authSessionKey = 'SESSION-OWNER-CURRENT'
  const currentPage = makePage()
  openVerification(currentPage)
  actionSheetCallback({ tapIndex: 2 })
  await Promise.resolve()
  assert.deepStrictEqual(verifyCalls, [{
    id: 'L-OWNER-A',
    outcome: '不租了',
    sessionKey: 'SESSION-OWNER-CURRENT'
  }], '同页面同会话的三选一仍必须正常提交一次')

  console.log('my-listings-operation-session-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
