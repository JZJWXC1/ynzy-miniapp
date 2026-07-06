const assert = require('assert')

const pageDefs = []
global.Page = (definition) => pageDefs.push(definition)
global.wx = {
  showToast() {},
  createSelectorQuery: () => ({
    select: () => ({
      boundingClientRect: () => ({
        exec: (callback) => callback([])
      })
    })
  })
}

const llmService = require('../../utils/llm-service')
const originalChatAssistant = llmService.chatAssistant
let calledPayload = null

llmService.chatAssistant = (payload) => {
  calledPayload = payload
  return Promise.resolve({
    threadId: 'T-TEXT-REQUEST',
    reply: '文字请求已到达',
    listings: [],
    exactListings: [],
    nearbyListings: []
  })
}

require('../../pages/match-chat/match-chat')

async function main() {
  const definition = pageDefs[0]
  assert(definition, '必须能加载 match-chat 页面配置')
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(patch, callback) {
      Object.keys(patch || {}).forEach((key) => {
        this.data[key] = patch[key]
      })
      if (typeof callback === 'function') callback()
    }
  })

  let releaseCalled = false
  let stopCalled = false
  page.voiceController = {
    isBusy: () => false,
    release: () => { releaseCalled = true },
    stop: () => { stopCalled = true },
    isErrored: () => false
  }

  page.cleanupVoiceInput()
  assert.strictEqual(releaseCalled, true, '无录音离页时应只释放本页回调')
  assert.strictEqual(stopCalled, false, '无录音离页时不得调用 recorder.stop')

  page.setData({ inputText: '新天地附近四千左右的两室。嗯。', loading: false })
  page.sendMessage()
  await Promise.resolve()

  assert(calledPayload, '文字找房必须直接发起 assistant chat 请求')
  assert.strictEqual(calledPayload.text, '新天地附近四千左右的两室。嗯。', '文字请求正文必须来自输入框')
  assert.strictEqual(calledPayload.voiceText, '', '文字请求不得依赖语音识别结果')

  llmService.chatAssistant = originalChatAssistant
  console.log('match-chat-request-voice-decoupling-test passed')
}

main().catch((error) => {
  llmService.chatAssistant = originalChatAssistant
  console.error(error)
  process.exit(1)
})
