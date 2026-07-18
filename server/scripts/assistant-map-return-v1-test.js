'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const matchChatPath = path.join(repoRoot, 'pages', 'match-chat', 'match-chat.js')
const mapPath = path.join(repoRoot, 'pages', 'map', 'map.js')
const mapWxmlPath = path.join(repoRoot, 'pages', 'map', 'map.wxml')
const navigationBarPath = path.join(repoRoot, 'components', 'navigation-bar', 'navigation-bar.js')
const returnStatePath = path.join(repoRoot, 'utils', 'assistant-map-return-state.js')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const pendingFilterStorage = require(path.join(repoRoot, 'utils', 'pending-filter-storage.js'))

const matchChatSource = fs.readFileSync(matchChatPath, 'utf8')
const mapSource = fs.readFileSync(mapPath, 'utf8')
const mapWxml = fs.readFileSync(mapWxmlPath, 'utf8')
const navigationBarSource = fs.readFileSync(navigationBarPath, 'utf8')

assert.ok(fs.existsSync(returnStatePath), '必须提供只驻留内存的找房助手地图返回状态模块')
assert.match(matchChatSource, /delete filters\.area/, '明确推荐 listingIds 上图时必须移除附近锚点 area，不能叠加后误筛空')
assert.match(matchChatSource, /delete filters\.community/, '明确推荐 listingIds 上图时必须移除附近锚点 community，不能叠加后误筛空')
assert.match(matchChatSource, /saveAssistantMapReturnState\s*\(/, '离开找房助手前必须保存可返回的会话内页面状态')
assert.match(matchChatSource, /restoreAssistantMapReturnState\s*\(/, '从地图返回时必须恢复原找房对话和推荐卡')
assert.match(matchChatSource, /returnFromMap/, '找房助手必须只在地图返回入口恢复状态')
assert.match(mapSource, /returnToAssistant\s*\(/, '地图页必须提供返回找房助手的方法')
assert.match(mapSource, /\/pages\/match-chat\/match-chat\?returnFromMap=1/, '地图返回必须进入找房助手恢复入口')
assert.match(mapWxml, /back="\{\{assistantReturnAvailable\}\}"[\s\S]*custom-back="\{\{assistantReturnAvailable\}\}"[\s\S]*bind:back="returnToAssistant"/, '仅从找房助手进入地图时显示顶部返回箭头')
assert.match(navigationBarSource, /if \(data\.customBack\)[\s\S]*triggerEvent\('back'/, '自定义返回必须先交给页面处理，不能把 tab 页错误送回首页')

delete require.cache[require.resolve(returnStatePath)]
const returnState = require(returnStatePath)
let storedEnvelope = null
let switchedUrl = ''
global.getApp = () => ({ globalData: { authToken: 'TOKEN-A', authSessionKey: 'SESSION-A' } })
global.wx = {
  setStorageSync(key, value) {
    if (key === 'ynzy_pending_map_filters') storedEnvelope = value
  },
  switchTab(options) { switchedUrl = options.url },
  showToast() {}
}
let matchDefinition = null
global.Page = (definition) => { matchDefinition = definition }
delete require.cache[require.resolve(matchChatPath)]
require(matchChatPath)
assert.ok(matchDefinition, '必须能加载找房助手页面配置')
const matchPage = Object.assign({}, matchDefinition, {
  data: {
    messages: [{ id: 'result-message', role: 'assistant', text: '推荐结果' }],
    inputText: '',
    needHistory: ['新天地附近两室'],
    voiceMode: false,
    voiceText: '',
    scrollTarget: 'result-message'
  }
})
matchPage.findMessage = () => ({
  needId: 'NEED-A',
  mapFilters: { area: '拱墅', community: '新天地', budget: 4000, layout: '两室', rentMode: '整租' },
  listings: [{ id: 'LISTING-NEARBY-A' }, { id: 'LISTING-NEARBY-B' }]
})
matchPage.openMapForListing({ currentTarget: { dataset: { messageId: 'result-message' } } })
assert.strictEqual(switchedUrl, '/pages/map/map', '推荐卡仍应进入底部地图页')
assert.deepStrictEqual(storedEnvelope.payload.listingIds, ['LISTING-NEARBY-A', 'LISTING-NEARBY-B'], '必须精确携带推荐房源 ID')
assert.ok(!Object.prototype.hasOwnProperty.call(storedEnvelope.payload, 'area'), '明确推荐 ID 上图不得再携带附近锚点 area')
assert.ok(!Object.prototype.hasOwnProperty.call(storedEnvelope.payload, 'community'), '明确推荐 ID 上图不得再携带附近锚点 community')
assert.ok(!Object.prototype.hasOwnProperty.call(storedEnvelope.payload, 'budget'), '明确推荐 ID 上图不得再携带预算轴')
assert.ok(!Object.prototype.hasOwnProperty.call(storedEnvelope.payload, 'layout'), '明确推荐 ID 上图不得再携带户型轴')
assert.ok(!Object.prototype.hasOwnProperty.call(storedEnvelope.payload, 'rentMode'), '明确推荐 ID 上图不得再携带租法轴')
assert.strictEqual(storedEnvelope.payload.returnToAssistant, true, '地图必须知道本次可返回找房助手')

const snapshot = {
  sessionKey: 'SESSION-A',
  data: {
    messages: [{ id: 'assistant-result', role: 'assistant', text: '推荐结果' }],
    needHistory: ['新天地附近两室'],
    inputText: ''
  },
  context: { currentThreadId: 'THREAD-A' }
}
returnState.saveAssistantMapReturnState(snapshot)
assert.strictEqual(returnState.restoreAssistantMapReturnState('SESSION-B'), null, '其他账号不得恢复上一账号找房对话')
returnState.saveAssistantMapReturnState(snapshot)
const restored = returnState.restoreAssistantMapReturnState('SESSION-A')
assert.deepStrictEqual(restored, snapshot, '同一账号从地图返回必须完整恢复找房对话上下文')
assert.strictEqual(returnState.restoreAssistantMapReturnState('SESSION-A'), null, '返回状态必须单次消费，避免旧对话反复复活')

function setAtPath(target, key, value) {
  const parts = String(key).replace(/\[(\d+)\]/g, '.$1').split('.')
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
  page.setData = (patch) => Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
  return page
}

// 行为门禁 1：pending 助手入口置真；下一次普通 tab onShow 必须立即重置，不能残留箭头。
let mapStoredValue = pendingFilterStorage.createPendingFilterEnvelope({
  listingIds: ['LISTING-NEARBY-A'],
  returnToAssistant: true
}, 'SESSION-A')
global.wx.getStorageSync = () => mapStoredValue
global.wx.removeStorageSync = () => { mapStoredValue = '' }
require.cache[apiServicePath] = {
  id: apiServicePath,
  filename: apiServicePath,
  loaded: true,
  exports: { getMapCommunities: () => Promise.resolve([]) }
}
let mapDefinition = null
global.Page = (definition) => { mapDefinition = definition }
delete require.cache[require.resolve(mapPath)]
require(mapPath)
const mapPage = makePage(mapDefinition)
mapPage.bindAuthInvalidationListener = () => {}
mapPage.syncAuthSession = () => ({ key: 'SESSION-A', changed: false })
mapPage.setTabBarSelected = () => {}
mapPage.loadCommunities = () => {}
mapPage.onShow()
assert.strictEqual(mapPage.data.assistantReturnAvailable, true, '助手 pending 入口必须行为级显示返回箭头')
mapPage.onShow()
assert.strictEqual(mapPage.data.assistantReturnAvailable, false, '普通 tab 再进地图必须行为级清除返回箭头')

// 行为门禁 2：恢复分支必须真正写回页面 data 与实例上下文，不能只保留函数调用字符串。
returnState.saveAssistantMapReturnState(snapshot)
const restoredPage = makePage(matchDefinition)
restoredPage.bindAuthInvalidationListener = () => {}
restoredPage.initVoiceInput = () => {}
restoredPage.onLoad({ returnFromMap: '1' })
assert.deepStrictEqual(restoredPage.data.messages, snapshot.data.messages, '地图返回必须真正恢复原推荐消息')
assert.deepStrictEqual(restoredPage.data.needHistory, snapshot.data.needHistory, '地图返回必须真正恢复需求历史')
assert.strictEqual(restoredPage.currentThreadId, 'THREAD-A', '地图返回必须真正恢复 thread 上下文')

// 行为门禁 3：customBack 只能发出页面事件，绝不能继续执行导航栏默认回首页逻辑。
let navigationDefinition = null
global.Component = (definition) => { navigationDefinition = definition }
delete require.cache[require.resolve(navigationBarPath)]
require(navigationBarPath)
let defaultNavigationCount = 0
let backEventCount = 0
global.getCurrentPages = () => [{ route: 'pages/map/map' }]
global.wx.switchTab = () => { defaultNavigationCount += 1 }
global.wx.reLaunch = () => { defaultNavigationCount += 1 }
global.wx.navigateBack = () => { defaultNavigationCount += 1 }
navigationDefinition.methods.back.call({
  data: { customBack: true, delta: 1 },
  triggerEvent(name) { if (name === 'back') backEventCount += 1 }
})
assert.strictEqual(backEventCount, 1, 'customBack 必须只触发一次页面返回事件')
assert.strictEqual(defaultNavigationCount, 0, 'customBack 不得继续默认导航造成双重跳转')

console.log('assistant-map-return-v1-test passed')
