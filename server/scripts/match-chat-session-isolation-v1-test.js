'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const pagePath = require.resolve(path.join(repoRoot, 'pages', 'match-chat', 'match-chat.js'))
const llmService = require(path.join(repoRoot, 'utils', 'llm-service.js'))
const apiService = require(path.join(repoRoot, 'utils', 'api-service.js'))
const apiClient = require(path.join(repoRoot, 'utils', 'api-client.js'))

let authToken = 'TOKEN-MATCH-A'
let authSessionKey = 'auth-match-a'

global.getApp = () => ({ globalData: { authToken, authSessionKey } })
global.wx = {
  showToast() {},
  navigateTo() {},
  setStorageSync() {},
  switchTab() {},
  hideKeyboard() {},
  getStorageSync() { return '' }
}

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

function loadDefinition() {
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[pagePath]
  require(pagePath)
  assert.ok(definition, '未捕获找房助手页面定义')
  return definition
}

function makePage(definition) {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  page._pageActive = true
  page.authSessionSnapshot = authSessionKey
  return page
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

function assertReset(page, label) {
  assert.strictEqual(page.data.messages.length, 1, `${label}必须清除上一账号对话和房源卡`)
  assert.strictEqual(page.data.messages[0].id, 'welcome', `${label}只保留初始提示`)
  assert.deepStrictEqual(page.data.needHistory, [], `${label}必须清除需求历史`)
  assert.strictEqual(page.data.loading, false, `${label}必须结束旧请求加载态`)
  assert.strictEqual(page.currentThreadId || '', '', `${label}必须清除 threadId`)
  assert.strictEqual(page.lastNeedContext, undefined, `${label}必须清除 needId 上下文`)
}

async function run() {
  const originals = {
    chatAssistant: llmService.chatAssistant,
    recognizeRentalNeed: llmService.recognizeRentalNeed,
    matchRentalNeed: llmService.matchRentalNeed,
    submitAssistantFeedback: llmService.submitAssistantFeedback,
    createRentalNeed: apiService.createRentalNeed,
    publicContinuation: apiClient.isPublicReadAuthFallbackContinuation,
    subscribeInvalidation: apiClient.subscribeAuthInvalidation
  }

  try {
    let publicReadFallbackSessionKey = ''
    let authInvalidationListener = null
    let authInvalidationUnsubscribed = false
    apiClient.isPublicReadAuthFallbackContinuation = (requestSessionKey) => (
      Boolean(publicReadFallbackSessionKey) && requestSessionKey === publicReadFallbackSessionKey
    )
    apiClient.subscribeAuthInvalidation = (listener) => {
      authInvalidationListener = listener
      return () => { authInvalidationUnsubscribed = true }
    }
    const definition = loadDefinition()

    authToken = 'TOKEN-MATCH-FALLBACK-A'
    authSessionKey = 'auth-match-fallback-a'
    const fallbackPage = makePage(definition)
    fallbackPage.bindAuthInvalidationListener()
    fallbackPage.currentThreadId = 'THREAD-ACCOUNT-A'
    fallbackPage.lastNeedContext = { needId: 'NEED-ACCOUNT-A' }
    fallbackPage.setData({
      messages: fallbackPage.data.messages.concat(
        { id: 'assistant-old-a', role: 'assistant', text: '账号A旧对话', threadId: 'THREAD-ACCOUNT-A', needId: 'NEED-ACCOUNT-A' },
        { id: 'user-current', role: 'user', text: '当前公开找房问题' }
      ),
      needHistory: ['账号A旧需求', '当前公开找房问题'],
      loading: true
    })
    const fallbackWaiter = deferred()
    let fallbackRequestContext = null
    llmService.chatAssistant = (payload, requestContext) => {
      fallbackRequestContext = requestContext
      return fallbackWaiter.promise
    }
    fallbackPage.executeAssistantChat({
      text: '当前公开找房问题',
      threadId: 'THREAD-ACCOUNT-A',
      needId: 'NEED-ACCOUNT-A'
    })
    authToken = ''
    authSessionKey = 'guest-match-after-fallback'
    publicReadFallbackSessionKey = 'auth-match-fallback-a'
    assert.strictEqual(
      fallbackRequestContext && fallbackRequestContext.authFallbackRequestId,
      fallbackPage.activeRequestId,
      '找房助手必须把当前 Promise 的请求标识透传到认证降级层'
    )
    authInvalidationListener({
      reason: 'unauthorized',
      fromSessionKey: 'auth-match-fallback-a',
      toSessionKey: authSessionKey,
      publicFallbackRequestId: fallbackRequestContext.authFallbackRequestId
    })
    assert.strictEqual(fallbackPage.currentThreadId || '', '', '助手静默降级时必须立即清旧账号 threadId')
    assert.strictEqual(fallbackPage.lastNeedContext, undefined, '助手静默降级时必须立即清旧账号 needId 上下文')
    assert.ok(!JSON.stringify(fallbackPage.data.messages).includes('账号A旧对话'), '助手静默降级时不得保留旧账号消息')
    assert.ok(JSON.stringify(fallbackPage.data.messages).includes('当前公开找房问题'), '助手静默降级时必须保留当前用户查询')
    fallbackWaiter.resolve({
      threadId: 'THREAD-GUEST-NEW',
      reply: '游客公开匹配完成',
      listings: [{ id: 'PUBLIC-GUEST-LISTING', source: '业主房源' }]
    })
    await flushPromises()
    assert.strictEqual(fallbackPage.data.loading, false, '助手匿名重试结果不得因会话键轮换而卡住 loading')
    assert.ok(JSON.stringify(fallbackPage.data.messages).includes('PUBLIC-GUEST-LISTING'), '助手必须接收同一请求的匿名公开结果')
    assert.ok(!JSON.stringify(fallbackPage.data.messages).includes('NEED-ACCOUNT-A'), '助手匿名结果不得复活旧账号 needId')
    fallbackPage.onUnload()

    // 并发时，收藏等其他请求的 401 可能建立同一会话桥，但绝不能作为这一个助手 Promise 确已匿名重试的证明。
    authToken = 'TOKEN-MATCH-UNRELATED-A'
    authSessionKey = 'auth-match-unrelated-a'
    const unrelatedPage = makePage(definition)
    unrelatedPage.bindAuthInvalidationListener()
    unrelatedPage.currentThreadId = 'THREAD-UNRELATED-A'
    unrelatedPage.setData({
      messages: unrelatedPage.data.messages.concat({ id: 'user-unrelated', role: 'user', text: '并发公开找房' }),
      needHistory: ['并发公开找房'],
      loading: true
    })
    const unrelatedWaiter = deferred()
    let unrelatedRequestContext = null
    llmService.chatAssistant = (payload, requestContext) => {
      unrelatedRequestContext = requestContext
      return unrelatedWaiter.promise
    }
    unrelatedPage.executeAssistantChat({ text: '并发公开找房', threadId: 'THREAD-UNRELATED-A' })
    authToken = ''
    authSessionKey = 'guest-match-after-unrelated-favorite'
    publicReadFallbackSessionKey = 'auth-match-unrelated-a'
    authInvalidationListener({
      reason: 'unauthorized',
      fromSessionKey: 'auth-match-unrelated-a',
      toSessionKey: authSessionKey
    })
    assert.ok(unrelatedRequestContext && unrelatedRequestContext.authFallbackRequestId, '公开助手请求应有自己的请求级降级标识')
    unrelatedWaiter.resolve({
      threadId: 'THREAD-UNRELATED-A-LATE',
      needId: 'NEED-UNRELATED-A-LATE',
      reply: '旧账号请求迟到',
      listings: [{ id: 'OLD-ACCOUNT-LATE-LISTING' }]
    })
    await flushPromises()
    assertReset(unrelatedPage, '其他请求建桥后的助手迟到成功')
    assert.ok(!JSON.stringify(unrelatedPage.data.messages).includes('OLD-ACCOUNT-LATE-LISTING'), '助手 Promise 不得借用收藏等其他请求的会话桥接纳旧账号结果')
    unrelatedPage.onUnload()
    publicReadFallbackSessionKey = ''
    assert.strictEqual(authInvalidationUnsubscribed, true, '助手卸载必须取消鉴权撤销订阅')
    publicReadFallbackSessionKey = ''

    authToken = 'TOKEN-MATCH-A'
    authSessionKey = 'auth-match-a-visible'
    const visiblePage = makePage(definition)
    visiblePage.currentThreadId = 'THREAD-A'
    visiblePage.lastNeedContext = { needId: 'NEED-A' }
    visiblePage.setData({
      messages: visiblePage.data.messages.concat({
        id: 'assistant-a',
        role: 'assistant',
        needId: 'NEED-A',
        threadId: 'THREAD-A',
        listings: [{ id: 'PARTNER-A', source: '业主房源' }]
      }),
      needHistory: ['账号A需求']
    })
    authToken = 'TOKEN-MATCH-B'
    authSessionKey = 'auth-match-b-visible'
    assert.strictEqual(typeof visiblePage.onShow, 'function', '找房助手必须监听登录会话变化')
    visiblePage.onShow()
    assertReset(visiblePage, 'A→B 会话变化')

    const requestCases = [
      {
        label: 'assistant chat',
        install(waiter) { llmService.chatAssistant = () => waiter.promise },
        start(page) { page.setData({ loading: true }); page.executeAssistantChat({ text: '账号A需求' }) },
        result: { threadId: 'THREAD-A-LATE', needId: 'NEED-A-LATE', listings: [{ id: 'PARTNER-A-LATE', source: '二房东房源' }] }
      },
      {
        label: 'recognize',
        install(waiter) { llmService.recognizeRentalNeed = () => waiter.promise },
        start(page) { page.setData({ loading: true }); page.executeRecognize({ text: '账号A需求' }) },
        result: { need: { area: '账号A区域', layout: '两室' }, listings: [{ id: 'PARTNER-A-LATE' }] }
      },
      {
        label: 'match',
        install(waiter) { llmService.matchRentalNeed = () => waiter.promise },
        start(page) { page.setData({ loading: true }); page.executeMatch({ text: '账号A需求' }) },
        result: { threadId: 'THREAD-A-LATE', needId: 'NEED-A-LATE', listings: [{ id: 'PARTNER-A-LATE', source: '业主房源' }] }
      }
    ]

    for (const requestCase of requestCases) {
      authToken = 'TOKEN-MATCH-A'
      authSessionKey = `auth-match-a-${requestCase.label}`
      const page = makePage(definition)
      const waiter = deferred()
      requestCase.install(waiter)
      requestCase.start(page)
      authToken = ''
      authSessionKey = `guest-match-${requestCase.label}`
      waiter.resolve(requestCase.result)
      await flushPromises()
      assertReset(page, `${requestCase.label} 迟到响应`)
    }

    authToken = 'TOKEN-MATCH-A-CREATE'
    authSessionKey = 'auth-match-a-create'
    const createPage = makePage(definition)
    const createWaiter = deferred()
    let matchCalls = 0
    apiService.createRentalNeed = () => createWaiter.promise
    llmService.matchRentalNeed = () => {
      matchCalls += 1
      return Promise.resolve({ listings: [] })
    }
    createPage.setData({ loading: true })
    createPage.createNeedAndMatch(
      { text: '账号A需求', form: {}, confirmed: true },
      { confirmForm: { budget: '4000', area: '拱墅区', layout: '两室' }, need: {}, threadId: 'THREAD-A' }
    )
    authToken = 'TOKEN-MATCH-B-CREATE'
    authSessionKey = 'auth-match-b-create'
    publicReadFallbackSessionKey = 'auth-match-a-create'
    createWaiter.resolve({ needId: 'NEED-A-LATE' })
    await flushPromises()
    assert.strictEqual(matchCalls, 0, '会话变化后迟到的账号A需求单不得继续触发匹配')
    assertReset(createPage, 'createNeedAndMatch 迟到响应')
    publicReadFallbackSessionKey = ''

    authToken = ''
    authSessionKey = 'guest-match-confirm'
    const guestConfirmPage = makePage(definition)
    guestConfirmPage.setData({
      messages: guestConfirmPage.data.messages.concat({
        id: 'assistant-guest-confirm',
        role: 'assistant',
        canConfirm: true,
        confirmText: '拱墅区两室四千元',
        confirmForm: { budget: '4000', area: '拱墅区', layout: '两室' },
        need: { maxBudget: 4000, area: '拱墅区', layout: '两室' }
      })
    })
    let guestCreateNeedCalls = 0
    let guestMatchCalls = 0
    let guestFailureToast = ''
    apiService.createRentalNeed = () => {
      guestCreateNeedCalls += 1
      return Promise.reject(new Error('游客不应请求受保护的需求单接口'))
    }
    llmService.matchRentalNeed = () => {
      guestMatchCalls += 1
      return Promise.resolve({ listings: [] })
    }
    const originalGuestShowToast = wx.showToast
    wx.showToast = (options) => {
      if (options && options.title === '需求单保存失败，继续本地匹配') guestFailureToast = options.title
    }
    guestConfirmPage.confirmNeedFromMessage({
      currentTarget: { dataset: { messageId: 'assistant-guest-confirm' } }
    })
    await flushPromises()
    assert.strictEqual(guestCreateNeedCalls, 0, '游客确认需求不得调用受保护的需求单写接口')
    assert.strictEqual(guestMatchCalls, 1, '游客确认需求应直接执行匹配')
    assert.strictEqual(guestFailureToast, '', '游客正常匹配不得弹需求单保存失败')
    wx.showToast = originalGuestShowToast

    authToken = 'TOKEN-MATCH-LOGGED-CONFIRM'
    authSessionKey = 'auth-match-logged-confirm'
    const loggedConfirmPage = makePage(definition)
    loggedConfirmPage.setData({
      messages: loggedConfirmPage.data.messages.concat({
        id: 'assistant-logged-confirm',
        role: 'assistant',
        canConfirm: true,
        confirmText: '拱墅区两室四千元',
        confirmForm: { budget: '4000', area: '拱墅区', layout: '两室' },
        need: { maxBudget: 4000, area: '拱墅区', layout: '两室' }
      })
    })
    let loggedCreateNeedCalls = 0
    let loggedMatchPayload = null
    apiService.createRentalNeed = () => {
      loggedCreateNeedCalls += 1
      return Promise.resolve({ needId: 'NEED-LOGGED-CONFIRM' })
    }
    llmService.matchRentalNeed = (payload) => {
      loggedMatchPayload = payload
      return Promise.resolve({ listings: [] })
    }
    loggedConfirmPage.confirmNeedFromMessage({
      currentTarget: { dataset: { messageId: 'assistant-logged-confirm' } }
    })
    await flushPromises()
    await flushPromises()
    assert.strictEqual(loggedCreateNeedCalls, 1, '已登录用户确认需求仍必须保存需求单')
    assert.strictEqual(loggedMatchPayload && loggedMatchPayload.needId, 'NEED-LOGGED-CONFIRM', '已登录用户应带服务端需求单 ID 继续匹配')

    authToken = 'TOKEN-MATCH-FEEDBACK'
    authSessionKey = 'auth-match-feedback'
    const feedbackPage = makePage(definition)
    const feedbackWaiter = deferred()
    let feedbackToasts = 0
    const originalShowToast = wx.showToast
    wx.showToast = () => { feedbackToasts += 1 }
    llmService.submitAssistantFeedback = () => feedbackWaiter.promise
    feedbackPage.setData({
      messages: feedbackPage.data.messages.concat({
        id: 'assistant-feedback',
        role: 'assistant',
        canFeedback: true,
        feedbackLoading: false,
        feedbackSent: false,
        feedbackType: 'helpful',
        feedbackMessageId: 'MESSAGE-FEEDBACK',
        needId: 'NEED-FEEDBACK',
        threadId: 'THREAD-FEEDBACK'
      })
    })
    feedbackPage.submitAssistantFeedback({
      currentTarget: { dataset: { messageId: 'assistant-feedback', reasonCode: 'price' } }
    })
    feedbackPage.onUnload()
    feedbackWaiter.resolve({ ok: true })
    await flushPromises()
    const lateFeedbackMessage = feedbackPage.findMessage('assistant-feedback') || {}
    assert.strictEqual(lateFeedbackMessage.feedbackSent, false, '找房助手卸载后迟到反馈不得回写已销毁页面')
    assert.strictEqual(feedbackToasts, 0, '找房助手卸载后迟到反馈不得弹成功提示')
    wx.showToast = originalShowToast

    authToken = 'TOKEN-MATCH-MAP'
    authSessionKey = 'auth-match-map'
    const storagePage = makePage(definition)
    storagePage.setData({
      messages: storagePage.data.messages.concat({
        id: 'assistant-map-storage',
        role: 'assistant',
        needId: 'NEED-MAP-STORAGE',
        listings: [{ id: 'LISTING-MAP-STORAGE' }],
        mapFilters: { sourceType: '二房东房源' }
      })
    })
    let storageFailureToast = ''
    let switchTabCalls = 0
    wx.setStorageSync = () => { throw new Error('模拟本地存储写满') }
    wx.showToast = (options) => { storageFailureToast = options && options.title }
    wx.switchTab = () => { switchTabCalls += 1 }
    assert.doesNotThrow(() => storagePage.openMapForListing({
      currentTarget: { dataset: { messageId: 'assistant-map-storage' } }
    }), '找房助手筛选 envelope 写入失败不得把异常抛出到事件线程')
    assert.strictEqual(storageFailureToast, '筛选条件保存失败', '找房助手存储写失败必须明确提示用户')
    assert.strictEqual(switchTabCalls, 0, '筛选未保存时不得打开失去条件的全量地图')

    console.log('match-chat-session-isolation-v1-test passed')
  } finally {
    llmService.chatAssistant = originals.chatAssistant
    llmService.recognizeRentalNeed = originals.recognizeRentalNeed
    llmService.matchRentalNeed = originals.matchRentalNeed
    llmService.submitAssistantFeedback = originals.submitAssistantFeedback
    apiService.createRentalNeed = originals.createRentalNeed
    apiClient.isPublicReadAuthFallbackContinuation = originals.publicContinuation
    apiClient.subscribeAuthInvalidation = originals.subscribeInvalidation
  }
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
