const assert = require('assert')
const llm = require('../src/llm')

function makeDb() {
  return {
    users: [{ id: 'U1', name: '测试中介', role: '中介', authed: '手机号登录' }],
    listings: [
      {
        id: 'L-TIMEOUT-1',
        title: '杭州滨江春波南苑1栋1单元101室',
        shortTitle: '春波南苑',
        uploaderId: 'U1',
        rent: 3900,
        layout: '整租两室一厅一卫',
        city: '杭州',
        district: '滨江区',
        area: '滨江区',
        block: '西兴',
        community: '春波南苑',
        building: '1',
        unit: '1',
        roomNumber: '101',
        address: '杭州滨江区春波南苑1栋1单元101室',
        landlordPhone: '13900000001',
        commissionRate: 20,
        videoUrl: 'https://example.com/timeout.mp4',
        videoKey: 'house-videos/timeout.mp4',
        status: '在租',
        reviewStatus: '无需审核',
        lifecycleStatus: 'active',
        ownerType: '二房东房源',
        source: '普通上传',
        features: ['燃气', '近地铁']
      }
    ],
    llmConfig: {
      enabled: true,
      provider: 'timeout-test-provider',
      apiBaseUrl: 'https://llm-timeout.test/v1/chat/completions',
      model: 'test',
      secretName: 'TEST_LLM_TIMEOUT_KEY',
      providerTimeoutMs: 40
    }
  }
}

async function main() {
  assert.strictEqual(llm._internal.LLM_PROVIDER_TIMEOUT_MS, 20000, '供应商级默认超时必须是 20 秒')

  const originalFetch = global.fetch
  const originalKey = process.env.TEST_LLM_TIMEOUT_KEY
  let abortSeen = false
  process.env.TEST_LLM_TIMEOUT_KEY = 'test-secret'
  global.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        abortSeen = true
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }
  })

  try {
    const startedAt = Date.now()
    const result = await llm.matchRentalNeed(makeDb(), { text: '滨江四千左右两室，必须有燃气' })
    const durationMs = Date.now() - startedAt
    assert(durationMs < 25000, `供应商挂起时接口必须 25 秒内返回，实际 ${durationMs}ms`)
    assert(durationMs < 1000, `测试用 providerTimeoutMs 应快速触发，实际 ${durationMs}ms`)
    assert.strictEqual(abortSeen, true, '超时时必须主动中断供应商请求')
    assert.strictEqual(result.degraded, true, '供应商挂起后必须标记 degraded=true')
    assert.strictEqual(result.degradedNotice, '智能解读稍后重试', '客户端提示文案必须稳定')
    assert.strictEqual(result.mode, 'local-fallback', '供应商失败应回本地真实匹配')
    assert.ok((result.listings || []).some((item) => item.id === 'L-TIMEOUT-1'), '降级结果必须返回本地真实房源匹配')
    assert.ok(!result.networkFailed, '供应商降级不是客户端网络失败')
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) {
      delete process.env.TEST_LLM_TIMEOUT_KEY
    } else {
      process.env.TEST_LLM_TIMEOUT_KEY = originalKey
    }
  }

  console.log('llm-provider-timeout-fallback-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
