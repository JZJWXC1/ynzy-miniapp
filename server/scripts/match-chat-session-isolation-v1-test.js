'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const pagePath = require.resolve(path.join(repoRoot, 'pages', 'match-chat', 'match-chat.js'))
const llmService = require(path.join(repoRoot, 'utils', 'llm-service.js'))
const apiService = require(path.join(repoRoot, 'utils', 'api-service.js'))

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
    createRentalNeed: apiService.createRentalNeed
  }

  try {
    const definition = loadDefinition()

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
    createWaiter.resolve({ needId: 'NEED-A-LATE' })
    await flushPromises()
    assert.strictEqual(matchCalls, 0, '会话变化后迟到的账号A需求单不得继续触发匹配')
    assertReset(createPage, 'createNeedAndMatch 迟到响应')

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

    console.log('match-chat-session-isolation-v1-test passed')
  } finally {
    llmService.chatAssistant = originals.chatAssistant
    llmService.recognizeRentalNeed = originals.recognizeRentalNeed
    llmService.matchRentalNeed = originals.matchRentalNeed
    llmService.submitAssistantFeedback = originals.submitAssistantFeedback
    apiService.createRentalNeed = originals.createRentalNeed
  }
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
