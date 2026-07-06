const assert = require('assert')

global.getApp = () => ({
  globalData: {
    apiConfig: {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 1
    }
  }
})

const requestOptions = []

global.wx = {
  getStorageSync: () => '',
  request(options) {
    requestOptions.push(options)
    options.fail({ errMsg: 'mocked network failure' })
  }
}

const llmService = require('../../utils/llm-service')

function assertEmptyFailedResult(result, label) {
  assert.strictEqual(result.networkFailed, true, `${label} 应标记网络失败`)
  assert.strictEqual((result.listings || []).length, 0, `${label} 生产失败时不能返回本地推荐房源`)
  assert.strictEqual((result.exactListings || []).length, 0, `${label} 生产失败时不能返回符合房源`)
  assert.strictEqual((result.nearbyListings || []).length, 0, `${label} 生产失败时不能返回接近房源`)
  assert.notStrictEqual(result.mode, 'client-local-fallback', `${label} 生产失败时不能退回本地匹配模式`)
}

async function main() {
  const payload = { text: '拱墅万达附近2000左右的单间' }
  const assistantResult = await llmService.chatAssistant(payload)
  assertEmptyFailedResult(assistantResult, 'assistant chat')
  assert.strictEqual(assistantResult.reply, '网络连接失败，请点下方按钮重试。')

  const matchResult = await llmService.matchRentalNeed(payload)
  assertEmptyFailedResult(matchResult, 'match rental need')
  assert.strictEqual(matchResult.reply, '网络连接失败，请点下方按钮重试。')

  const recognitionResult = await llmService.recognizeRentalNeed(payload)
  assertEmptyFailedResult(recognitionResult, 'recognize rental need')
  assert.strictEqual(recognitionResult.stage, 'recognize')
  assert.strictEqual(recognitionResult.readyToConfirm, false)

  const matchRequests = requestOptions.filter((item) => /\/mini\/llm\/match$/.test(item.url || ''))
  assert.strictEqual(matchRequests.length, 2, '/mini/llm/match 应分别覆盖识别和确认匹配')
  matchRequests.forEach((item) => {
    assert.strictEqual(item.timeout, llmService.LLM_MATCH_TIMEOUT_MS, '/mini/llm/match 必须单独放宽到 60 秒')
  })
  const assistantChat = requestOptions.find((item) => /\/mini\/assistant\/chat$/.test(item.url || ''))
  assert.strictEqual(assistantChat.timeout, llmService.LLM_MATCH_TIMEOUT_MS, '/mini/assistant/chat 必须和找房 LLM 链路一样放宽到 60 秒')

  console.log('assistant-client-network-fallback-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
