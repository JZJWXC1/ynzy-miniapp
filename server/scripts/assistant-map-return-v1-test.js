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
  mapFilters: { area: '拱墅', community: '新天地', budget: 4000, layout: '两室' },
  listings: [{ id: 'LISTING-NEARBY-A' }, { id: 'LISTING-NEARBY-B' }]
})
matchPage.openMapForListing({ currentTarget: { dataset: { messageId: 'result-message' } } })
assert.strictEqual(switchedUrl, '/pages/map/map', '推荐卡仍应进入底部地图页')
assert.deepStrictEqual(storedEnvelope.payload.listingIds, ['LISTING-NEARBY-A', 'LISTING-NEARBY-B'], '必须精确携带推荐房源 ID')
assert.ok(!Object.prototype.hasOwnProperty.call(storedEnvelope.payload, 'area'), '明确推荐 ID 上图不得再携带附近锚点 area')
assert.ok(!Object.prototype.hasOwnProperty.call(storedEnvelope.payload, 'community'), '明确推荐 ID 上图不得再携带附近锚点 community')
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

console.log('assistant-map-return-v1-test passed')
