const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const uploadPagePath = require.resolve(path.join(repoRoot, 'pages', 'upload', 'upload.js'))
const uploadWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'upload', 'upload.wxml'), 'utf8')

let toasts = []
let modals = []
let authToken = 'test-token'
let authSessionKey = 'test-session'

global.getApp = () => ({ globalData: { authToken, authSessionKey } })
global.wx = {
  getStorageSync() { return authToken },
  showToast(options) { toasts.push(options) },
  showModal(options) { modals.push(options) },
  showLoading() {},
  hideLoading() {},
  navigateTo() {}
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

function loadDefinition(apiStub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[uploadPagePath]
  require(uploadPagePath)
  assert.ok(definition, '未捕获上传页面定义')
  return definition
}

function validConfig(secondLandlordRate = 37) {
  return {
    secondLandlordRate,
    ownerRate: 26,
    secondLandlordPlatformRate: 9,
    ownerPlatformRate: 11,
    companyRate: 0
  }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
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

async function run() {
  const successDefinition = loadDefinition({
    getCommissionConfig() { return Promise.resolve(validConfig(37)) }
  })
  const successPage = makePage(successDefinition)
  successPage.loadCommissionConfig()
  await flushPromises()
  assert.strictEqual(successPage.data.commissionConfigReady, true, '服务端分佣配置成功后才可标记就绪')
  assert.strictEqual(successPage.data.commissionConfigFailed, false, '分佣配置成功必须清除失败态')
  assert.ok(successPage.data.commissionRuleText.includes('37%'), '上传页必须原样展示服务端当前二房东比例')

  let requestShouldFail = true
  const retryApi = {
    getCommissionConfig() {
      return requestShouldFail
        ? Promise.reject(Object.assign(new Error('配置服务暂不可用'), { statusCode: 503 }))
        : Promise.resolve(validConfig(28))
    }
  }
  const failureDefinition = loadDefinition(retryApi)
  const failurePage = makePage(failureDefinition)
  failurePage.loadCommissionConfig()
  await flushPromises()
  assert.strictEqual(failurePage.data.commissionConfigReady, false, '分佣配置失败不得沿用前端默认值冒充就绪')
  assert.strictEqual(failurePage.data.commissionConfigFailed, true, '分佣配置失败必须有持续可见状态')
  assert.ok(!failurePage.data.commissionRuleText.includes('20%'), '分佣配置失败不得展示写死默认比例')
  assert.ok(!failurePage.data.commissionRuleText.includes('NaN'), '分佣配置失败不得展示非法比例')
  assert.strictEqual(typeof failurePage.ensureCommissionConfigReady, 'function', '合作房源提交前必须检查服务端分佣配置')
  assert.strictEqual(failurePage.ensureCommissionConfigReady(), false, '分佣配置失败必须阻止合作房源提交')
  assert.ok(modals.some((item) => /分佣规则/.test(item.title)), '阻止提交时必须解释分佣规则尚未同步')
  assert.strictEqual(typeof failurePage.retryCommissionConfig, 'function', '分佣配置失败必须提供重试方法')

  requestShouldFail = false
  failurePage.retryCommissionConfig()
  await flushPromises()
  assert.strictEqual(failurePage.data.commissionConfigReady, true, '分佣配置重试成功后必须解锁提交')
  assert.ok(failurePage.data.commissionRuleText.includes('28%'), '重试成功必须刷新为最新服务端比例')
  assert.strictEqual(failurePage.ensureCommissionConfigReady(), true, '配置就绪后合作房源才可继续提交')

  const malformedDefinition = loadDefinition({
    getCommissionConfig() {
      return Promise.resolve({
        secondLandlordRate: 'not-a-number',
        ownerRate: 20,
        secondLandlordPlatformRate: 10,
        ownerPlatformRate: 10
      })
    }
  })
  const malformedPage = makePage(malformedDefinition)
  malformedPage.loadCommissionConfig()
  await flushPromises()
  assert.strictEqual(malformedPage.data.commissionConfigReady, false, '非法服务端比例不得标记就绪')
  assert.strictEqual(malformedPage.data.commissionConfigFailed, true, '非法服务端比例必须进入失败态')
  assert.ok(!malformedPage.data.commissionRuleText.includes('NaN'), '非法服务端比例不得渲染 NaN')

  malformedPage.setData({ 'form.companyListing': true })
  assert.strictEqual(malformedPage.ensureCommissionConfigReady(), true, '公司房源固定零抽佣不应受远端合作比例门禁')

  let resolveStaleConfig = null
  let configRequestCount = 0
  const raceDefinition = loadDefinition({
    getCommissionConfig() {
      configRequestCount += 1
      if (configRequestCount === 1) {
        return new Promise((resolve) => {
          resolveStaleConfig = resolve
        })
      }
      return Promise.resolve(validConfig(33))
    }
  })
  const racePage = makePage(raceDefinition)
  racePage.loadCommissionConfig()
  racePage.loadCommissionConfig()
  await flushPromises()
  resolveStaleConfig(validConfig(44))
  await flushPromises()
  assert.ok(racePage.data.commissionRuleText.includes('33%'), '过期配置响应不得覆盖最新服务端比例')

  const unloadConfig = deferred()
  const unloadDefinition = loadDefinition({
    getCommissionConfig() { return unloadConfig.promise }
  })
  const unloadPage = makePage(unloadDefinition)
  unloadPage.loadCommissionConfig()
  unloadPage.onUnload()
  unloadConfig.resolve(validConfig(41))
  await flushPromises()
  assert.strictEqual(unloadPage.data.commissionConfigReady, false, '上传页卸载后迟到配置不得写回已销毁页面')
  assert.ok(!unloadPage.data.commissionRuleText.includes('41%'), '上传页卸载后迟到配置不得覆盖页面状态')

  let retryRequestCalls = 0
  const retryPromptDefinition = loadDefinition({
    getCommissionConfig() {
      retryRequestCalls += 1
      return Promise.resolve(validConfig(32))
    }
  })
  authToken = 'TOKEN-RETRY-A'
  authSessionKey = 'SESSION-RETRY-A'
  const switchedRetryPage = makePage(retryPromptDefinition)
  switchedRetryPage._pageActive = true
  switchedRetryPage.setData({ commissionConfigReady: false, commissionConfigLoading: false, commissionConfigFailed: true })
  switchedRetryPage.ensureCommissionConfigReady()
  const switchedRetryModal = modals.pop()
  authToken = 'TOKEN-RETRY-B'
  authSessionKey = 'SESSION-RETRY-B'
  switchedRetryModal.success({ confirm: true })
  assert.strictEqual(retryRequestCalls, 0, 'A 打开的分佣重试框不得在 B 会话发请求')

  authToken = 'TOKEN-RETRY-UNLOAD'
  authSessionKey = 'SESSION-RETRY-UNLOAD'
  const unloadedRetryPage = makePage(retryPromptDefinition)
  unloadedRetryPage._pageActive = true
  unloadedRetryPage.setData({ commissionConfigReady: false, commissionConfigLoading: false, commissionConfigFailed: true })
  unloadedRetryPage.ensureCommissionConfigReady()
  const unloadedRetryModal = modals.pop()
  unloadedRetryPage.onUnload()
  unloadedRetryModal.success({ confirm: true })
  assert.strictEqual(retryRequestCalls, 0, '上传页卸载后旧分佣重试框不得发请求')

  authToken = 'TOKEN-RETRY-CURRENT'
  authSessionKey = 'SESSION-RETRY-CURRENT'
  const currentRetryPage = makePage(retryPromptDefinition)
  currentRetryPage._pageActive = true
  currentRetryPage.setData({ commissionConfigReady: false, commissionConfigLoading: false, commissionConfigFailed: true })
  currentRetryPage.ensureCommissionConfigReady()
  modals.pop().success({ confirm: true })
  await flushPromises()
  assert.strictEqual(retryRequestCalls, 1, '同页面同会话确认重试仍必须请求一次')

  const payload = successPage.buildSubmitPayload({
    address: '测试地址',
    layout: '整租一室0厅公卫',
    communityMatched: true,
    communityMatchStatus: '已匹配',
    needsManualReview: false,
    manualReviewReason: ''
  }, null)
  ;['commissionRate', 'uploaderRate', 'platformRate', 'secondLandlordRate', 'ownerRate'].forEach((field) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, field), `客户端提交不得携带分佣字段：${field}`)
  })

  assert.ok(/bindtap="retryCommissionConfig"/.test(uploadWxml), '上传页必须绑定分佣配置重试入口')
  assert.ok(/!form\.companyListing && !commissionConfigReady/.test(uploadWxml), '合作房源提交按钮必须受服务端分佣配置就绪状态约束')

  console.log('upload-commission-sync-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
