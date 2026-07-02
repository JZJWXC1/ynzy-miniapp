const assert = require('assert')
const llm = require('../src/llm')

async function main() {
  const originalFetch = global.fetch
  const originalKey = process.env.TEST_LLM_KEY
  const calls = []

  process.env.TEST_LLM_KEY = 'test-secret'
  global.fetch = async (url, options = {}) => {
    const requestBody = JSON.parse(options.body || '{}')
    calls.push({ url, options, requestBody })
    const protocol = requestBody.input
      ? 'responses-compatible'
      : (requestBody.prompt ? 'custom-json' : 'openai-compatible')
    const responseByProtocol = {
      'openai-compatible': {
        choices: [{ message: { content: [{ type: 'text', text: 'chat ok' }] } }]
      },
      'responses-compatible': {
        output_text: 'responses ok'
      },
      'custom-json': {
        data: { text: 'custom ok' }
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => responseByProtocol[protocol]
    }
  }

  try {
    const baseConfig = {
      enabled: true,
      provider: 'protocol-test-provider',
      apiBaseUrl: 'https://llm.test/generate',
      model: 'test-model',
      secretName: 'TEST_LLM_KEY',
      systemPrompt: '测试系统提示词'
    }

    const chatText = await llm._internal.callProvider({
      ...baseConfig,
      protocol: 'openai-compatible'
    }, '找房需求')
    assert.strictEqual(chatText, 'chat ok', 'openai-compatible 响应解析失败')
    assert.deepStrictEqual(calls[0].requestBody.messages.map((item) => item.role), ['system', 'user'])
    assert.strictEqual(calls[0].requestBody.messages[1].content, '找房需求')
    assert.strictEqual(calls[0].requestBody.input, undefined, 'chat 协议不应发送 input')
    assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer test-secret')
    assert.strictEqual(
      llm._internal.configForTask({ ...baseConfig, needParserModel: 'parser-model', replyModel: 'reply-model' }, 'need_parser').model,
      'parser-model',
      '需求解析任务应选择 needParserModel'
    )
    assert.strictEqual(
      llm._internal.configForTask({ ...baseConfig, needParserModel: 'parser-model', replyModel: 'reply-model' }, 'reply_writer').model,
      'reply-model',
      '话术任务应选择 replyModel'
    )
    assert.strictEqual(
      llm._internal.configForTask({ ...baseConfig, provider: 'qwen', model: 'qwen-plus' }, 'need_parser').model,
      'qwen3.5-plus',
      '百炼旧单模型配置应默认把普通理解任务路由到 qwen3.5-plus'
    )
    assert.strictEqual(
      llm._internal.configForTask({ ...baseConfig, provider: 'qwen', model: 'qwen-plus' }, 'complex_need_parser').model,
      'qwen3.7-plus',
      '百炼旧单模型配置应默认把复杂理解任务路由到 qwen3.7-plus'
    )
    assert.strictEqual(
      llm._internal.configForTask({ ...baseConfig, provider: 'qwen', model: 'qwen-plus' }, 'reply_writer').model,
      'qwen-turbo',
      '百炼旧单模型配置应默认把话术任务路由到 qwen-turbo'
    )

    const responsesText = await llm._internal.callProvider({
      ...baseConfig,
      protocol: 'responses-compatible'
    }, '半径找房')
    assert.strictEqual(responsesText, 'responses ok', 'responses-compatible 响应解析失败')
    assert.deepStrictEqual(calls[1].requestBody.input.map((item) => item.role), ['system', 'user'])
    assert.strictEqual(calls[1].requestBody.input[1].content, '半径找房')
    assert.strictEqual(calls[1].requestBody.messages, undefined, 'responses 协议不应发送 messages')

    const customText = await llm._internal.callProvider({
      ...baseConfig,
      protocol: 'custom-json'
    }, '自定义协议')
    assert.strictEqual(customText, 'custom ok', 'custom-json 响应解析失败')
    assert.strictEqual(calls[2].requestBody.system, '测试系统提示词')
    assert.strictEqual(calls[2].requestBody.prompt, '自定义协议')
    assert.strictEqual(calls[2].requestBody.messages, undefined, 'custom-json 协议不应发送 messages')

    assert.strictEqual(
      llm._internal.extractProviderText({
        output: [
          { content: [{ type: 'output_text', text: { value: 'nested responses ok' } }] }
        ]
      }),
      'nested responses ok',
      '嵌套 responses output 文本解析失败'
    )
    assert.strictEqual(
      llm._internal.extractProviderText({
        choices: [{ message: { content: [{ type: 'text', text: 'array content ok' }] } }]
      }),
      'array content ok',
      '数组 message content 文本解析失败'
    )
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) {
      delete process.env.TEST_LLM_KEY
    } else {
      process.env.TEST_LLM_KEY = originalKey
    }
  }

  console.log('llm-provider-protocol-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
