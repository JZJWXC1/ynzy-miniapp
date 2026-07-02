const assert = require('assert')
const assistantService = require('../src/assistant-service')
const { containsSensitiveText } = require('../src/assistant/safety')
const { _internal: llmReplyInternal } = require('../src/assistant/llm-reply')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeListing(id, data) {
  return {
    id,
    title: `杭州${data.area}${data.community}1栋1单元101室 · ${data.layout}`,
    shortTitle: data.community,
    uploaderId: 'U001',
    rent: data.rent,
    layout: data.layout,
    city: '杭州',
    district: data.area,
    area: data.area,
    block: data.block || data.area,
    community: data.community,
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: `杭州${data.area}${data.community}1栋1单元101室`,
    landlordPhone: '13900000001',
    commissionRate: 20,
    videoUrl: `https://example.com/${id}.mp4?OSSAccessKeyId=ak&Signature=raw`,
    videoKey: `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: data.rentMode || '整租',
    rentMode: data.rentMode || '整租',
    room: data.room || '',
    hall: data.hall || '',
    bath: data.bath || '',
    features: data.features || [],
    source: '普通上传',
    mapLatitude: 30.28,
    mapLongitude: 120.18,
    coordinateSource: 'community-coordinate',
    coordinateVerified: true,
    createdAt: now,
    lastVerifiedAt: now
  }
}

function makeDb(extra) {
  return Object.assign({
    currentUserId: 'U001',
    users: [
      { id: 'U001', name: '测试中介', phone: '13800010001', role: '中介', authed: '手机号登录' }
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 15 },
    listings: [
      makeListing('L001', {
        area: '滨江',
        block: '西兴',
        community: '春波南苑',
        rent: 3900,
        layout: '整租两室一厅一卫',
        rentMode: '整租',
        room: '两室',
        features: ['燃气', '近地铁']
      })
    ],
    footprints: []
  }, extra || {})
}

function assertPromptClean(prompt, fragments) {
  fragments.forEach((fragment) => {
    assert(!prompt.includes(fragment), `发给 LLM 的内容包含敏感原文：${fragment}`)
  })
}

async function main() {
  assert.deepStrictEqual(
    llmReplyInternal.findUnknownListingIds('可以先推 L999，再看 L001', [{ id: 'L001' }]),
    ['L999'],
    '候选外房源编号应被识别'
  )

  const originalFetch = global.fetch
  const replies = [
    '{"maxBudget":4000,"community":"春波南苑","layout":"两室"}',
    '这组里我建议先看 L001：预算压得住，春波南苑位置也对，两室带燃气，适合先约看。',
    '{"maxBudget":4000,"area":"滨江","layout":"两室"}',
    '我觉得 L999 更好，直接推这套。'
  ]
  const capturedPrompts = []
  let callCount = 0
  process.env.ASSISTANT_REPLY_TEST_KEY = 'test-key'
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    capturedPrompts.push(JSON.stringify(body.messages))
    callCount += 1
    return {
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: replies.shift() || '本地结果可以先发客户看看。' } }
        ]
      })
    }
  }

  try {
    const db = makeDb({
      llmConfig: {
        enabled: true,
        provider: 'test-provider',
        apiBaseUrl: 'https://llm.test/v1/chat/completions',
        model: 'test',
        secretName: 'ASSISTANT_REPLY_TEST_KEY'
      }
    })

    assistantService._internal.threadStore._internal.resetForTest()
    let result = await assistantService.chat(clone(db), {
      debugTrace: true,
      text: '客户13812345678想住滨江春波南苑1栋2单元301室，四千两室，微信号wxid_secret12345，OSSAccessKeyId=ak&Signature=rawsig'
    }, { userId: 'U001' })

    assert.strictEqual(result.replyMode, 'test-provider', 'LLM 话术成功时应标记 provider')
    assert(result.reply.indexOf('L001') !== -1, '应使用 provider 返回的话术')
    assert(result.traceSummary.nodes.indexOf('llm_need_parser') !== -1, 'trace 应包含 LLM 需求解析节点')
    assert(result.traceSummary.nodes.indexOf('rule_need_validator') !== -1, 'trace 应包含规则校验节点')
    assert(result.traceSummary.nodes.indexOf('llm_reply_writer') !== -1, 'trace 应包含 LLM 话术写作节点')
    assert.strictEqual((result.listings || [])[0].id, 'L001', 'LLM 话术不应改变房源排序或 ID')
    assert(!containsSensitiveText(result), 'LLM 话术结果不应包含敏感内容')
    assertPromptClean(capturedPrompts[0], [
      '13812345678',
      '13900000001',
      'wxid_secret12345',
      '1栋',
      '2单元',
      '301室',
      'OSSAccessKeyId=ak',
      'Signature=rawsig',
      'videoUrl',
      'landlordPhone'
    ])
    assertPromptClean(capturedPrompts[1], [
      '13812345678',
      '13900000001',
      'wxid_secret12345',
      '1栋',
      '2单元',
      '301室',
      'OSSAccessKeyId=ak',
      'Signature=rawsig',
      'videoUrl',
      'landlordPhone'
    ])

    result = await assistantService.chat(clone(db), {
      text: '滨江四千两室'
    }, { userId: 'U002' })
    assert.strictEqual(result.replyMode, 'local-fallback', '候选外 ID 应触发本地兜底')
    assert(result.reply.indexOf('L999') === -1, '候选外房源编号不应进入最终回复')
    assert(!containsSensitiveText(result), 'LLM 兜底结果不应包含敏感内容')

    const beforeFaqCalls = callCount
    result = await assistantService.chat(clone(db), {
      text: '报备和签单怎么走？'
    }, { userId: 'U003' })
    assert.strictEqual(callCount, beforeFaqCalls, '业务 FAQ 不应调用 LLM 话术')
    assert.strictEqual(result.replyMode, 'local', '业务 FAQ 应保留本地话术模式')
  } finally {
    global.fetch = originalFetch
    delete process.env.ASSISTANT_REPLY_TEST_KEY
  }

  console.log('assistant-llm-reply-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
