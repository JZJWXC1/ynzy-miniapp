const assert = require('assert')

const pageDefs = []
const navigationUrls = []
let toastCount = 0
global.Page = (definition) => pageDefs.push(definition)
global.wx = {
  showToast() { toastCount += 1 },
  navigateTo(options) { navigationUrls.push(options.url) },
  getStorageSync() { return '' },
  createSelectorQuery: () => ({
    select: () => ({
      boundingClientRect: () => ({
        exec: (callback) => callback([])
      })
    })
  })
}

const llmService = require('../../utils/llm-service')
const voiceInput = require('../../utils/voice-input')
const originalChatAssistant = llmService.chatAssistant
const originalCreateController = voiceInput.createController
const originalGetSupportStatus = voiceInput.getSupportStatus
const chatPayloads = []
const voiceCallbacks = []

llmService.chatAssistant = (payload) => {
  chatPayloads.push(payload)
  return Promise.resolve({
    threadId: 'T-TEXT-REQUEST',
    reply: '文字请求已到达',
    listings: [],
    exactListings: [],
    nearbyListings: []
  })
}

voiceInput.getSupportStatus = () => ({ ok: true })
voiceInput.createController = (callbacks) => {
  voiceCallbacks.push(callbacks)
  return {
    isBusy: () => false,
    isErrored: () => false,
    release() {},
    cancel() {},
    start() {},
    stop() {}
  }
}

require('../../pages/match-chat/match-chat')
require('../../pages/index/index')

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

function makePage(definition) {
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(patch, callback) {
      if (this._pageActive === false) this._writesAfterUnload = Number(this._writesAfterUnload || 0) + 1
      Object.keys(patch || {}).forEach((key) => setAtPath(this.data, key, patch[key]))
      if (typeof callback === 'function') callback()
    }
  })
  page._pageActive = true
  return page
}

async function main() {
  const matchDefinition = pageDefs[0]
  const indexDefinition = pageDefs[1]
  assert(matchDefinition, '必须能加载 match-chat 页面配置')
  assert(indexDefinition, '必须能加载首页配置')

  const matchPage = makePage(matchDefinition)
  matchPage.initVoiceInput()
  const matchVoice = voiceCallbacks[voiceCallbacks.length - 1]
  matchVoice.onStop('新天地附近四千左右的两室')

  const indexPage = makePage(indexDefinition)
  indexPage.initVoiceInput()
  const indexVoice = voiceCallbacks[voiceCallbacks.length - 1]
  indexVoice.onStop('拱墅区三千左右的一室')

  assert.deepStrictEqual(
    { chatRequests: chatPayloads.length, navigations: navigationUrls.length },
    { chatRequests: 0, navigations: 0 },
    '两页语音识别结束都只能填文字，不得自动请求或导航'
  )
  assert.strictEqual(matchPage.data.inputText, '新天地附近四千左右的两室', '助手语音结果必须填入可编辑输入框')
  assert.strictEqual(indexPage.data.assistantText, '拱墅区三千左右的一室', '首页语音结果必须填入可编辑输入框')

  matchPage.sendMessage()
  indexPage.runTextMatch()
  await Promise.resolve()

  assert.strictEqual(chatPayloads.length, 1, '用户手动发送后助手才恰好发起一次请求')
  assert.strictEqual(chatPayloads[0].text, '新天地附近四千左右的两室', '助手请求正文必须来自用户确认后的输入框')
  assert.strictEqual(chatPayloads[0].voiceText, '', '文字找房请求不得依赖录音或 ASR 回调状态')
  assert.strictEqual(navigationUrls.length, 1, '用户点击首页找房后才恰好导航一次')
  assert.ok(navigationUrls[0].includes(encodeURIComponent('拱墅区三千左右的一室')), '首页导航必须携带用户确认后的文字')

  matchPage.data.isVoiceListening = true
  matchPage.voiceController = {
    isBusy: () => true,
    cancel: () => matchVoice.onCancel()
  }
  indexPage.data.isVoiceListening = true
  indexPage.voiceController = {
    isBusy: () => true,
    cancel: () => indexVoice.onCancel()
  }
  const requestCountBeforeUnload = chatPayloads.length
  const navigationCountBeforeUnload = navigationUrls.length
  const toastCountBeforeUnload = toastCount
  matchPage.onUnload()
  indexPage.onUnload()
  matchVoice.onStop('卸载后迟到的助手语音')
  indexVoice.onStop('卸载后迟到的首页语音')
  assert.strictEqual(matchPage._writesAfterUnload || 0, 0, '助手页卸载时 cancel 及迟到语音回调不得写页面')
  assert.strictEqual(indexPage._writesAfterUnload || 0, 0, '首页卸载时 cancel 及迟到语音回调不得写页面')
  assert.strictEqual(chatPayloads.length, requestCountBeforeUnload, '卸载后语音回调不得发助手请求')
  assert.strictEqual(navigationUrls.length, navigationCountBeforeUnload, '卸载后语音回调不得导航')
  assert.strictEqual(toastCount, toastCountBeforeUnload, '卸载后语音回调不得弹提示')

  console.log('match-chat-request-voice-decoupling-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  llmService.chatAssistant = originalChatAssistant
  voiceInput.createController = originalCreateController
  voiceInput.getSupportStatus = originalGetSupportStatus
})
