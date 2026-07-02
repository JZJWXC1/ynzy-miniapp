const assert = require('assert')
const assistantService = require('../src/assistant-service')
const { containsSensitiveText } = require('../src/assistant/safety')
const { buildNeedParserPrompt, parseProviderJson, validateRentalNeed } = require('../src/assistant/need-parser')

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
    mapLatitude: data.mapLatitude || 30.31,
    mapLongitude: data.mapLongitude || 120.16,
    coordinateSource: 'manual-confirmed-test-coordinate',
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
      makeListing('S001', {
        area: '拱墅',
        block: '万达',
        community: '万融城',
        rent: 1980,
        layout: '合租单间',
        rentMode: '合租',
        room: '单间',
        features: ['独卫']
      }),
      makeListing('YLF01', {
        area: '拱墅',
        block: '东新',
        community: '杨乐府',
        rent: 3600,
        layout: '整租两室一厅一卫',
        rentMode: '整租',
        room: '两室',
        features: ['燃气']
      }),
      makeListing('YJF01', {
        area: '拱墅',
        block: '东新',
        community: '杨家府',
        rent: 3500,
        layout: '整租两室一厅一卫',
        rentMode: '整租',
        room: '两室',
        features: ['带阳台']
      })
    ],
    footprints: []
  }, extra || {})
}

function assertPromptClean(prompt) {
  ;[
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
  ].forEach((fragment) => {
    assert(!prompt.includes(fragment), `LLM 需求解析提示词包含敏感原文：${fragment}`)
  })
}

async function main() {
  assert.deepStrictEqual(parseProviderJson('```json\n{"layout":"单间"}\n```'), { layout: '单间' }, '应解析 fenced JSON')

  const validation = validateRentalNeed({
    ruleNeed: {
      maxBudget: 3600,
      community: '杨乐府',
      hardConstraints: { maxBudget: 3600, community: '杨乐府', features: [] },
      preferences: {}
    },
    llmNeed: {
      maxBudget: 9999,
      community: '杨家府',
      hardConstraints: { features: ['带阳台'] }
    },
    state: {
      sanitizedText: '杨乐府三千六两室',
      candidates: makeDb().listings,
      db: makeDb()
    }
  })
  assert.strictEqual(validation.validatedNeed.community, '杨乐府', 'LLM 不能把相近小区改成另一个小区')
  assert.strictEqual(validation.validatedNeed.maxBudget, 3600, 'LLM 不能覆盖规则已识别预算')
  assert(validation.needValidation.rejectedFields.some((item) => item.field === 'community'), '应记录被拒绝的小区字段')

  const originalFetch = global.fetch
  const capturedPrompts = []
  const replies = [
    '{"rentMode":"合租","layout":"单间","preferences":{"budgetTolerance":300}}',
    '这套可以先推，预算和单间诉求比较贴。',
    '{"community":"杨家府","maxBudget":9999,"hardConstraints":{"features":["带阳台"]}}',
    '按系统结果先看预算内房源。'
  ]
  process.env.ASSISTANT_NEED_TEST_KEY = 'test-key'
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    capturedPrompts.push(JSON.stringify(body.messages))
    return {
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: replies.shift() || '{}' } }
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
        secretName: 'ASSISTANT_NEED_TEST_KEY'
      }
    })

    assistantService._internal.threadStore._internal.resetForTest()
    let result = await assistantService.chat(clone(db), {
      debugTrace: true,
      text: '客户13812345678要个小单房，拱墅2000左右，微信号wxid_secret12345，OSSAccessKeyId=ak&Signature=rawsig'
    }, { userId: 'U001' })
    assert.strictEqual(result.need.layout, '单间', 'LLM 需求解析应能补足规则没识别出的单间')
    assert.strictEqual(result.need.rentMode, '合租', 'LLM 需求解析应能补足租法')
    assert.strictEqual(result.need.preferences.budgetTolerance, 300, 'LLM 需求解析应能补足预算浮动')
    assert(result.traceSummary.nodes.indexOf('llm_need_parser') !== -1, 'trace 应包含 LLM 需求解析节点')
    assert(result.traceSummary.nodes.indexOf('rule_need_validator') !== -1, 'trace 应包含规则校验节点')
    assert(!containsSensitiveText(result), '结果不应包含敏感内容')
    assertPromptClean(capturedPrompts[0])

    assistantService._internal.threadStore._internal.resetForTest()
    result = await assistantService.chat(clone(db), {
      debugTrace: true,
      text: '杨乐府三千六两室'
    }, { userId: 'U002' })
    assert.strictEqual(result.need.community, '杨乐府', '相近小区不能被 LLM 改成杨家府')
    assert.strictEqual(result.need.maxBudget, 3600, '规则预算不能被 LLM 覆盖')
    assert((result.listings || []).some((listing) => listing.community === '杨乐府'), '应优先返回原话小区房源')
  } finally {
    global.fetch = originalFetch
    delete process.env.ASSISTANT_NEED_TEST_KEY
  }

  assert(buildNeedParserPrompt({ sanitizedText: '测试', candidates: [], db: {} }, {}).includes('只返回一个 JSON'), '提示词应约束只返回 JSON')
  console.log('assistant-llm-need-parser-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
