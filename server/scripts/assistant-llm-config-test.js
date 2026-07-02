const assert = require('assert')
const assistantService = require('../src/assistant-service')
const llm = require('../src/llm')
const evalRunner = require('./assistant-eval-runner')
const { containsSensitiveText } = require('../src/assistant/safety')

async function main() {
  const db = evalRunner.makeDb()
  db.llmConfig = {
    enabled: true,
    provider: 'online-test-provider',
    protocol: 'openai-compatible',
    apiBaseUrl: 'https://example.test/v1/chat/completions',
    model: 'test-fallback-model',
    needParserModel: 'test-parser-model',
    complexNeedParserModel: 'test-complex-parser-model',
    replyModel: 'test-reply-model',
    secretName: 'TEST_LLM_KEY',
    systemPrompt: '测试 provider',
    needParserEnabled: true
  }

  const originalCallProvider = llm._internal.callProvider
  const prompts = []
  llm._internal.callProvider = async (config, prompt) => {
    prompts.push({ config, prompt })
    if (prompt.indexOf('只返回 JSON') !== -1 || prompt.indexOf('JSON') !== -1) {
      return JSON.stringify({
        searchMode: 'radius_around_place',
        anchorName: '拱墅万达',
        anchorRole: 'anchor',
        radiusKm: 3,
        maxBudget: 2000,
        budgetText: '2000左右',
        layout: '单间',
        preferences: {
          budgetTolerance: 300
        }
      })
    }
    return '这边先看 WD01 和 WD02，两套都在拱墅万达附近，预算和单间需求比较贴。'
  }

  try {
    assistantService._internal.threadStore._internal.resetForTest()
    const result = await assistantService.chat(db, {
      debugTrace: true,
      text: '拱墅万达附近有哪些2000左右的单间'
    }, {
      userId: 'ADMIN',
      debugTrace: true
    })

    assert.strictEqual(result.needParserMode, 'online-test-provider', 'LLM 需求解析没有使用 provider')
    assert.strictEqual(result.replyMode, 'online-test-provider', 'LLM 话术没有使用 provider')
    assert.strictEqual(prompts.length, 2, 'assistant LLM 联调应覆盖需求解析和话术两次 provider 调用')
    assert.strictEqual(prompts[0].config.model, 'test-parser-model', '需求解析应使用独立理解模型')
    assert.strictEqual(prompts[1].config.model, 'test-reply-model', '话术生成应使用独立回复模型')
    assert(result.traceSummary.nodes.includes('llm_need_parser'), 'trace 缺少 llm_need_parser')
    assert(result.traceSummary.nodes.includes('llm_reply_writer'), 'trace 缺少 llm_reply_writer')
    assert(result.traceSummary.nodes.includes('listing_search_tool'), 'trace 缺少房源查询工具')
    assert(result.traceSummary.nodes.includes('ranking_tool'), 'trace 缺少排序工具')
    assert((result.listings || []).some((item) => item.id === 'WD01'), '推荐结果没有来自真实候选房源')
    assert(!containsSensitiveText(result), 'assistant LLM 联调结果包含敏感信息')

    prompts.length = 0
    assistantService._internal.threadStore._internal.resetForTest()
    await assistantService.chat(db, {
      debugTrace: true,
      text: '租客在乐富智慧园上班，她住的两公里内有什么1500左右的一室整租'
    }, {
      userId: 'ADMIN',
      debugTrace: true
    })
    assert.strictEqual(prompts[0].config.model, 'test-complex-parser-model', '复杂通勤需求应升级使用复杂理解模型')
    assert.strictEqual(prompts[1].config.model, 'test-reply-model', '复杂通勤话术仍应使用独立回复模型')
  } finally {
    llm._internal.callProvider = originalCallProvider
  }

  console.log('assistant-llm-config-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
