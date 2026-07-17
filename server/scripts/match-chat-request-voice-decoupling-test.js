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
const originalDateNow = Date.now
const chatPayloads = []
const voiceSessions = []
let now = 1000

Date.now = () => now

llmService.chatAssistant = (payload) => {
  chatPayloads.push(payload)
  return Promise.resolve({
    threadId: 'T-VOICE-REQUEST',
    reply: '语音请求已到达',
    listings: [],
    exactListings: [],
    nearbyListings: []
  })
}

voiceInput.getSupportStatus = () => ({ ok: true })
voiceInput.createController = (callbacks) => {
  let busy = false
  const session = {
    callbacks,
    finalText: '',
    cancelCount: 0,
    stopCount: 0,
    controller: {
      isBusy: () => busy,
      isErrored: () => false,
      release() { busy = false },
      cancel() {
        session.cancelCount += 1
        busy = false
        callbacks.onCancel()
      },
      start() {
        busy = true
        callbacks.onStart()
      },
      stop() {
        session.stopCount += 1
        busy = false
        callbacks.onTranscribing()
        callbacks.onStop(session.finalText)
      }
    }
  }
  voiceSessions.push(session)
  return session.controller
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

function createVoicePage(definition) {
  const page = makePage(definition)
  page.initVoiceInput()
  return { page, session: voiceSessions[voiceSessions.length - 1] }
}

function touchStart(page, y = 300) {
  page.onVoiceTouchStart({ touches: [{ clientY: y }] })
}

function finishLongPress(page, session, text) {
  session.finalText = text
  now += 600
  page.onVoiceTouchEnd()
}

function finishShortPress(page, session, text) {
  session.finalText = text
  now += 599
  page.onVoiceTouchEnd()
}

async function main() {
  const matchDefinition = pageDefs[0]
  const indexDefinition = pageDefs[1]
  assert(matchDefinition, '必须能加载 match-chat 页面配置')
  assert(indexDefinition, '必须能加载首页配置')

  const validMatch = createVoicePage(matchDefinition)
  touchStart(validMatch.page)
  finishLongPress(validMatch.page, validMatch.session, '新天地附近四千左右的两室')
  assert.strictEqual(chatPayloads.length, 1, '找房页有效长按识别结束后必须自动且仅发起一次请求')
  assert.strictEqual(chatPayloads[0].text, '新天地附近四千左右的两室', '自动请求正文必须来自本次最终识别文字')
  assert.strictEqual(chatPayloads[0].voiceText, '', '后端文字请求不得依赖录音器或 ASR 会话状态')

  const validIndex = createVoicePage(indexDefinition)
  touchStart(validIndex.page)
  finishLongPress(validIndex.page, validIndex.session, '拱墅区三千左右的一室')
  assert.strictEqual(navigationUrls.length, 1, '首页有效长按识别结束后必须自动且仅进入一次找房页')
  assert.ok(navigationUrls[0].startsWith('/pages/match-chat/match-chat?'), '首页必须进入现有找房页')
  assert.ok(navigationUrls[0].includes(encodeURIComponent('拱墅区三千左右的一室')), '首页导航必须携带本次最终识别文字')

  validMatch.session.callbacks.onStop('重复到达的助手终态')
  validIndex.session.callbacks.onStop('重复到达的首页终态')
  assert.strictEqual(chatPayloads.length, 1, '同一次录音的重复终态不得重复请求')
  assert.strictEqual(navigationUrls.length, 1, '同一次录音的重复终态不得重复导航')

  const shortMatch = createVoicePage(matchDefinition)
  touchStart(shortMatch.page)
  finishShortPress(shortMatch.page, shortMatch.session, '短按误识别文字')
  const shortIndex = createVoicePage(indexDefinition)
  touchStart(shortIndex.page)
  finishShortPress(shortIndex.page, shortIndex.session, '短按误识别文字')
  assert.strictEqual(shortMatch.session.cancelCount, 1, '找房页短按必须取消录音')
  assert.strictEqual(shortIndex.session.cancelCount, 1, '首页短按必须取消录音')
  assert.strictEqual(chatPayloads.length, 1, '短按不得发起找房请求')
  assert.strictEqual(navigationUrls.length, 1, '短按不得进入找房页')

  const slideCancel = createVoicePage(indexDefinition)
  touchStart(slideCancel.page, 300)
  now += 600
  slideCancel.page.onVoiceTouchMove({ touches: [{ clientY: 100 }] })
  slideCancel.page.onVoiceTouchEnd()
  assert.strictEqual(slideCancel.session.cancelCount, 1, '上滑取消必须丢弃录音')
  assert.strictEqual(navigationUrls.length, 1, '上滑取消不得进入找房页')

  const systemCancel = createVoicePage(matchDefinition)
  touchStart(systemCancel.page)
  now += 600
  systemCancel.page.onVoiceTouchCancel()
  assert.strictEqual(systemCancel.session.cancelCount, 1, '系统 touchcancel 必须丢弃录音')
  assert.strictEqual(chatPayloads.length, 1, '系统 touchcancel 不得发起找房请求')

  const emptyResult = createVoicePage(indexDefinition)
  touchStart(emptyResult.page)
  finishLongPress(emptyResult.page, emptyResult.session, '   ')
  assert.strictEqual(navigationUrls.length, 1, '空识别结果不得进入找房页')

  const staleMatch = createVoicePage(matchDefinition)
  const staleIndex = createVoicePage(indexDefinition)
  staleMatch.session.callbacks.onStop('没有有效手势资格的助手语音')
  staleIndex.session.callbacks.onStop('没有有效手势资格的首页语音')
  assert.strictEqual(chatPayloads.length, 1, '没有有效长按资格的迟到回调不得发起请求')
  assert.strictEqual(navigationUrls.length, 1, '没有有效长按资格的迟到回调不得导航')

  const manualMatch = makePage(matchDefinition)
  manualMatch.data.inputText = '手动输入的找房需求'
  manualMatch.sendMessage()
  assert.strictEqual(chatPayloads.length, 2, '键盘输入必须仍可独立发起找房请求')
  assert.strictEqual(chatPayloads[1].text, '手动输入的找房需求', '手动请求必须使用当前输入框文字')
  assert.strictEqual(chatPayloads[1].voiceText, '', '手动请求不得依赖任何语音状态')

  const manualIndex = makePage(indexDefinition)
  manualIndex.data.assistantText = '首页手动输入的找房需求'
  manualIndex.data.voiceText = ''
  manualIndex.runTextMatch()
  assert.strictEqual(navigationUrls.length, 2, '首页找房按钮必须仍可独立进入找房页')
  assert.ok(navigationUrls[1].includes(encodeURIComponent('首页手动输入的找房需求')), '手动导航必须携带当前输入框文字')

  const unloadMatch = createVoicePage(matchDefinition)
  const unloadIndex = createVoicePage(indexDefinition)
  unloadMatch.page.data.isVoiceListening = true
  unloadIndex.page.data.isVoiceListening = true
  const requestCountBeforeUnload = chatPayloads.length
  const navigationCountBeforeUnload = navigationUrls.length
  const toastCountBeforeUnload = toastCount
  unloadMatch.page.onUnload()
  unloadIndex.page.onUnload()
  unloadMatch.session.callbacks.onStop('卸载后迟到的助手语音')
  unloadIndex.session.callbacks.onStop('卸载后迟到的首页语音')
  assert.strictEqual(unloadMatch.page._writesAfterUnload || 0, 0, '助手页卸载时取消及迟到回调不得写页面')
  assert.strictEqual(unloadIndex.page._writesAfterUnload || 0, 0, '首页卸载时取消及迟到回调不得写页面')
  assert.strictEqual(chatPayloads.length, requestCountBeforeUnload, '卸载后语音回调不得发助手请求')
  assert.strictEqual(navigationUrls.length, navigationCountBeforeUnload, '卸载后语音回调不得导航')
  assert.strictEqual(toastCount, toastCountBeforeUnload, '卸载后语音回调不得弹提示')

  await Promise.resolve()
  console.log('match-chat-request-voice-decoupling-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  Date.now = originalDateNow
  llmService.chatAssistant = originalChatAssistant
  voiceInput.createController = originalCreateController
  voiceInput.getSupportStatus = originalGetSupportStatus
})
