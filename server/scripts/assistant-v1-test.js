const assert = require('assert')
const matchService = require('../src/match-service')
const llm = require('../src/llm')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeListing(id, data) {
  const area = data.area
  const community = data.community
  const layout = data.layout
  const rentMode = data.rentMode || '整租'
  return {
    id,
    title: `杭州${area}${community}1栋1单元101室 · ${layout}`,
    shortTitle: community,
    uploaderId: 'U001',
    rent: data.rent,
    layout,
    city: '杭州',
    district: area,
    area,
    block: data.block || area,
    community,
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: `杭州${area}${community}1栋1单元101室`,
    landlordPhone: data.landlordPhone || '13900000001',
    commissionRate: 20,
    videoLabel: '房源实拍视频',
    videoUrl: data.videoUrl || `https://example.com/${id}.mp4`,
    videoKey: data.videoKey || `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: rentMode,
    rentMode,
    room: data.room || '',
    hall: data.hall || '',
    bath: data.bath || '',
    features: data.features || [],
    source: '普通上传',
    companyListing: false,
    isCompanyListing: false,
    noCommission: false,
    mapLatitude: data.mapLatitude || 30.28,
    mapLongitude: data.mapLongitude || 120.18,
    coordinateSource: 'community-coordinate',
    createdAt: now,
    lastVerifiedAt: now
  }
}

function makeDb(extra) {
  const base = {
    currentUserId: 'U001',
    users: [
      { id: 'U001', name: '测试中介', phone: '13800010001', role: '中介', authed: '手机号登录', isAdmin: false }
    ],
    listingMaintenanceRule: {
      enabled: false,
      remindDays: [3, 5],
      expireDays: 15
    },
    listings: [
      makeListing('L001', { area: '拱墅', block: '东新', community: '东新园', rent: 2800, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['近地铁', '带阳台', '电梯'] }),
      makeListing('L002', { area: '拱墅', block: '东新', community: '东新园', rent: 3500, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['带阳台', '燃气', '电梯', '可养宠'] }),
      makeListing('L003', { area: '滨江', block: '西兴', community: '春波南苑', rent: 3900, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['燃气', '近地铁', '电梯'], landlordPhone: '13900000002' }),
      makeListing('L004', { area: '滨江', block: '西兴', community: '滨江花园', rent: 4200, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['带阳台', '近地铁', '可养宠'] }),
      makeListing('L005', { area: '西湖', block: '文三', community: '嘉绿西苑', rent: 2500, layout: '合租单间', rentMode: '合租', room: '单间', features: ['独卫', '近地铁'] }),
      makeListing('L006', { area: '西湖', block: '古荡', community: '古荡新村', rent: 2200, layout: '合租单间', rentMode: '合租', room: '单间', features: ['近地铁'] }),
      makeListing('L007', { area: '上城', block: '近江', community: '近江家园', rent: 3000, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['朝南', '电梯'] }),
      makeListing('L008', { area: '上城', block: '钱江新城', community: '钱江苑', rent: 3300, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['燃气', '近地铁'] }),
      makeListing('L009', { area: '拱墅', block: '武林', community: '长木新村', rent: 3700, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['带阳台', '燃气'] }),
      makeListing('L010', { area: '萧山', block: '建设路', community: '建设家园', rent: 3200, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['电梯', '近地铁'] }),
      makeListing('L011', { area: '钱塘', block: '下沙', community: '金沙湖公寓', rent: 2600, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['免押金', '近地铁'] }),
      makeListing('L012', { area: '滨江', block: '长河', community: '长河雅苑', rent: 4800, layout: '整租三室一厅一卫', rentMode: '整租', room: '三室', features: ['朝南', '带阳台', '燃气'] }),
      makeListing('L013', { area: '滨江', block: '浦沿', community: '浦沿新苑', rent: 3600, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['近地铁', '电梯'] }),
      makeListing('L014', { area: '拱墅', block: '东新', community: '香积寺东苑', rent: 2600, layout: '合租单间', rentMode: '合租', room: '单间', features: ['独卫', '可养宠'] })
    ],
    footprints: []
  }
  return Object.assign(base, extra || {})
}

function run(text, db = makeDb()) {
  return matchService.buildLocalMatch(clone(db), { text })
}

function candidateIds(db) {
  return new Set((db.listings || []).map((listing) => listing.id))
}

function returnedListings(result) {
  return []
    .concat(result.listings || [])
    .concat(result.exactListings || [])
    .concat(result.nearbyListings || [])
}

function assertKnownIds(result, db) {
  const ids = candidateIds(db)
  returnedListings(result).forEach((listing) => {
    assert(ids.has(listing.id), `返回了候选外房源ID：${listing.id}`)
  })
}

function assertMaxFive(result) {
  assert((result.listings || []).length <= 5, '最终展示房源超过5套')
}

function assertNoListings(result) {
  assert.strictEqual((result.listings || []).length, 0, '识别阶段不应返回推荐房源')
  assert.strictEqual((result.exactListings || []).length, 0, '识别阶段不应返回严格匹配房源')
  assert.strictEqual((result.nearbyListings || []).length, 0, '识别阶段不应返回接近匹配房源')
}

function assertConfirmationFields(result) {
  const keys = (result.confirmationFields || []).map((field) => field.key)
  ;['budget', 'location', 'layout', 'moveIn', 'commute', 'features'].forEach((key) => {
    assert(keys.includes(key), `确认字段缺失：${key}`)
  })
}

function assertPromptClean(prompt, fragments) {
  fragments.forEach((fragment) => {
    assert(!prompt.includes(fragment), `发给LLM的内容包含敏感原文：${fragment}`)
  })
}

function hasFeature(listing, feature) {
  return (listing.features || []).indexOf(feature) !== -1
}

async function main() {
  const db = makeDb()
  const samples = [
    '拱墅三千以内一室近地铁',
    '滨江四千左右两室，必须有燃气',
    '西湖合租单间，最好独卫',
    '预算三千五，月底入住，通勤到武林广场',
    '两室，阳台是必须的，电梯可有可无',
    '预算可以多两百，但必须能养猫',
    '想住东新园附近，两室，3500以内',
    '预算2500，合租，最好独卫',
    '上城区整租一室，下周入住',
    '滨江两室，通勤西兴半小时以内',
    '预算3000到4000，滨江两室',
    '钱塘一室免押金，三千以内',
    '西湖古荡单间，最好近地铁',
    '萧山建设路两室三千二以内',
    '拱墅武林两室，必须有阳台',
    '滨江三室朝南，五千以内',
    '上城一室，最好燃气',
    '拱墅合租单间，必须能养猫',
    '东新园整租两室，预算3500',
    '滨江浦沿一室，近地铁'
  ]

  assert(samples.length >= 20, '口语样例不足20条')
  samples.forEach((text) => {
    const result = run(text, db)
    assert(result.reply.length <= 100, `助手正文超过100字：${text}`)
    assertMaxFive(result)
    assertKnownIds(result, db)
  })

  let result = run('拱墅三千以内一室近地铁', db)
  assert.strictEqual(result.need.maxBudget, 3000, '最高预算解析失败')
  assert.strictEqual(result.need.area, '拱墅', '区域解析失败')
  assert.strictEqual(result.need.layout, '一室', '户型解析失败')
  assert((result.preferences.features || []).indexOf('近地铁') !== -1, '默认特点偏好解析失败')

  result = matchService.recognizeNeed(clone(db), { text: '拱墅三千以内一室近地铁' })
  assert.strictEqual(result.stage, 'recognize', '识别阶段标记缺失')
  assert.strictEqual(result.readyToConfirm, true, '条件足够时应允许确认')
  assertNoListings(result)
  assertConfirmationFields(result)
  assert((result.confirmationFields || []).some((field) => field.key === 'budget' && field.filled), '预算确认字段未填充')

  result = matchService.recognizeNeed(clone(db), { voiceText: '西湖合租单间，预算2500，最好独卫' })
  assert.strictEqual(result.readyToConfirm, true, 'voiceText 已转写文本应进入字段确认')
  assert.strictEqual(result.need.area, '西湖', 'voiceText 区域解析失败')
  assert.strictEqual(result.need.rentMode, '合租', 'voiceText 租法解析失败')
  assert.strictEqual(result.need.layout, '单间', 'voiceText 户型解析失败')
  assertNoListings(result)
  assertConfirmationFields(result)

  result = matchService.recognizeNeed(clone(db), { text: '必须有阳台' })
  assert.strictEqual(result.readyToConfirm, false, '核心信息不足时不应允许确认')
  assert(result.followUpQuestion, '识别阶段缺少追问')
  assert((result.followUpQuestion.match(/[？?]/g) || []).length <= 1, '识别阶段追问超过一个问题')
  assertNoListings(result)

  result = matchService.recognizeNeed(clone(db), {
    text: '必须有阳台',
    form: {
      budget: '3000以内',
      area: '拱墅'
    }
  })
  assert.strictEqual(result.readyToConfirm, true, '字段补全核心条件后应关闭追问')
  assert.strictEqual(result.followUpQuestion, '', '字段补全后不应继续追问')
  assert.strictEqual(result.need.maxBudget, 3000, '确认字段预算未进入识别结果')
  assert.strictEqual(result.need.area, '拱墅', '确认字段区域未进入识别结果')
  assertNoListings(result)

  result = matchService.recognizeNeed(clone(db), { text: '必须有阳台，补充：预算三千，拱墅一室' })
  assert.strictEqual(result.readyToConfirm, true, '后续补充后应允许确认')
  assert((result.hardConstraints.features || []).indexOf('带阳台') !== -1, '后续补充时必须类偏好丢失')

  result = matchService.buildLocalMatch(clone(db), {
    text: '滨江四千以内两室',
    stage: 'match',
    confirmed: true,
    form: {
      budget: '3500以内',
      area: '拱墅',
      community: '东新园',
      rentMode: '整租',
      layout: '一室',
      moveIn: '下周入住',
      commuteLocation: '武林广场',
      maxCommuteMinutes: '30',
      features: '近地铁、带阳台'
    }
  })
  assert.strictEqual(result.need.maxBudget, 3500, '确认字段预算应覆盖原文预算')
  assert.strictEqual(result.need.area, '拱墅', '确认字段区域应覆盖原文区域')
  assert.strictEqual(result.need.community, '东新园', '确认字段小区/板块应进入匹配')
  assert.strictEqual(result.need.rentMode, '整租', '确认字段租法应进入匹配')
  assert.strictEqual(result.need.layout, '一室', '确认字段户型应覆盖原文户型')
  assert.strictEqual(result.need.moveIn, '下周入住', '确认字段入住时间应进入匹配')
  assert.strictEqual(result.need.commuteLocation, '武林广场', '确认字段通勤地点应进入匹配')
  assert.strictEqual(result.need.maxCommuteMinutes, 30, '确认字段通勤时间应进入匹配')
  assert((result.preferences.features || []).indexOf('近地铁') !== -1, '确认字段偏好标签未进入偏好')
  assert((result.preferences.features || []).indexOf('带阳台') !== -1, '确认字段偏好标签未完整进入偏好')
  assert.strictEqual(result.followUpQuestion, '', '确认字段完整时不应继续追问')

  result = matchService.buildLocalMatch(clone(db), {
    text: '滨江四千以内两室，必须有阳台',
    stage: 'match',
    confirmed: true,
    form: {
      budget: '',
      area: '',
      community: '',
      rentMode: '',
      layout: '',
      moveIn: '',
      commuteLocation: '',
      maxCommuteMinutes: '',
      features: ''
    }
  })
  assert.strictEqual(result.need.maxBudget, '', '确认表单清空预算后不应从原文带回最高预算')
  assert.strictEqual(result.need.area, '', '确认表单清空区域后不应从原文带回区域')
  assert.strictEqual(result.need.layout, '', '确认表单清空户型后不应从原文带回户型')
  assert.strictEqual((result.need.features || []).indexOf('带阳台'), -1, '确认表单清空标签后不应从原文带回阳台标签')
  assert.strictEqual((result.hardConstraints.features || []).indexOf('带阳台'), -1, '确认表单清空标签后不应从原文带回阳台硬条件')

  result = matchService.recognizeNeed(clone(db), {
    text: '客户13812345678想住滨江春波南苑1栋2单元301室，四千两室'
  })
  assert.strictEqual(result.need.area, '滨江', '详细地址脱敏后区域不应丢失')
  assert.strictEqual(result.need.community, '春波南苑', '详细地址脱敏后小区不应丢失')
  assert.strictEqual(result.need.maxBudget, 4000, '详细地址脱敏后预算不应丢失')
  assert.strictEqual(result.need.layout, '两室', '详细地址脱敏后户型不应丢失')

  result = run('预算3000到4000，滨江两室', db)
  assert.strictEqual(result.need.minBudget, 3000, '最低预算解析失败')
  assert.strictEqual(result.need.maxBudget, 4000, '预算区间最高值解析失败')

  result = run('想住东新园附近，两室，3500以内', db)
  assert.strictEqual(result.need.community, '东新园', '小区解析失败')
  assert((result.listings || []).some((listing) => listing.community === '东新园'), '小区匹配结果缺失')

  result = run('西湖合租单间，最好独卫', db)
  assert.strictEqual(result.need.rentMode, '合租', '合租解析失败')
  assert.strictEqual(result.need.layout, '单间', '单间解析失败')
  assert((result.preferences.features || []).indexOf('独卫') !== -1, '最好类条件未进入偏好')

  result = run('上城区整租一室，下周入住', db)
  assert.strictEqual(result.need.area, '上城', '上城区解析失败')
  assert.strictEqual(result.need.rentMode, '整租', '整租解析失败')
  assert(result.need.moveIn.indexOf('下周') !== -1, '入住时间解析失败')

  result = run('滨江两室，通勤西兴半小时以内', db)
  assert.strictEqual(result.need.commuteLocation, '西兴', '通勤地点解析失败')
  assert.strictEqual(result.need.maxCommuteMinutes, 30, '最长通勤时间解析失败')

  result = run('滨江四千左右两室，必须有燃气', db)
  assert((result.hardConstraints.features || []).indexOf('燃气') !== -1, '必须类条件未进入硬条件')
  result.exactListings.forEach((listing) => {
    assert(listing.rent <= 4000, '严格匹配违反预算硬条件')
    assert(hasFeature(listing, '燃气'), '严格匹配违反燃气硬条件')
  })

  result = run('预算可以多两百，但必须能养猫', db)
  assert(!result.need.maxBudget, '预算浮动被误识别为最高预算')
  assert.strictEqual(result.preferences.budgetTolerance, 200, '预算浮动解析失败')
  assert((result.hardConstraints.features || []).indexOf('可养宠') !== -1, '养宠硬条件解析失败')

  result = run('必须有阳台', db)
  assert(result.followUpQuestion, '缺少核心条件时没有追问')
  assert((result.followUpQuestion.match(/[？?]/g) || []).length <= 1, '追问超过一个问题')

  result = run('滨江四千以内两室，必须有阳台', db)
  assert(result.nearbyListings.length > 0, '接近匹配缺失')
  assert(result.nearbyListings.some((listing) => listing.differenceText), '接近匹配没有差异说明')
  assert(result.nearbyListings.some((listing) => /超预算|没有阳台|户型|区域/.test(listing.differenceText)), '接近匹配差异不明确')

  result = run('滨江五千以内两室', db)
  assertMaxFive(result)
  assertKnownIds(result, db)

  const failDb = makeDb({
    llmConfig: {
      enabled: true,
      provider: 'test-provider',
      apiBaseUrl: 'https://llm.invalid/v1/chat/completions',
      model: 'test',
      secretName: 'MISSING_ASSISTANT_TEST_KEY'
    }
  })
  result = await llm.matchRentalNeed(clone(failDb), { text: '滨江四千左右两室，必须有燃气' })
  assert.strictEqual(result.mode, 'local-fallback', 'LLM失败时没有本地降级')
  assert(result.listings.length > 0, 'LLM失败后没有返回本地匹配结果')

  result = await llm.matchRentalNeed(clone(db), { stage: 'recognize', text: '滨江四千左右两室，必须有燃气' })
  assert.strictEqual(result.stage, 'recognize', 'LLM入口未返回识别阶段')
  assertNoListings(result)

  const originalFetch = global.fetch
  let capturedPrompt = ''
  process.env.ASSISTANT_TEST_KEY = 'test-key'
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    capturedPrompt = JSON.stringify(body.messages)
    return {
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: '先看预算内的真实房源，接近项已标出。' } }
        ]
      })
    }
  }
  try {
    const promptDb = makeDb({
      llmConfig: {
        enabled: true,
        provider: 'test-provider',
        apiBaseUrl: 'https://llm.test/v1/chat/completions',
        model: 'test',
        secretName: 'ASSISTANT_TEST_KEY'
      }
    })
    result = await llm.matchRentalNeed(clone(promptDb), {
      text: '客户138 1234 5678，身份证330106199001011234，微信号wxid_secret12345，想住滨江春波南苑1栋2单元301室，四千两室，OSSAccessKeyId=ak&Signature=rawsig',
      voiceText: '房东电话0571-88888888，备用400-800-1234，门牌1-2-301，VX: zhangsan888',
      form: {
        address: '杭州滨江春波南苑1栋2单元301室',
        contact: '138-1234-5678',
        landlordPhone: '13900000002',
        idCard: '330106199001011234',
        wechat: 'wechat_secret_888',
        videoUrl: 'https://oss.example.com/house.mp4?Expires=1&Signature=abc',
        videoSignedUrl: 'https://oss.example.com/house2.mp4?OSSAccessKeyId=ak&Signature=form'
      }
    })
    assert.strictEqual(result.mode, 'test-provider', 'LLM成功时模式未透传')
    assertPromptClean(capturedPrompt, [
      '138 1234 5678',
      '13812345678',
      '138-1234-5678',
      '13900000002',
      '13900000001',
      '0571-88888888',
      '400-800-1234',
      '330106199001011234',
      'wxid_secret12345',
      'zhangsan888',
      'wechat_secret_888',
      '1栋',
      '2单元',
      '301室',
      '1-2-301',
      'https://oss.example.com',
      'OSSAccessKeyId=ak',
      'Signature=rawsig',
      'Signature=abc',
      'Signature=form',
      'landlordPhone',
      'videoUrl',
      'videoSignedUrl',
      'idCard'
    ])
    assertKnownIds(result, promptDb)
  } finally {
    global.fetch = originalFetch
    delete process.env.ASSISTANT_TEST_KEY
  }

  console.log('assistant-v1-test passed')
  console.log(`samples: ${samples.length}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
