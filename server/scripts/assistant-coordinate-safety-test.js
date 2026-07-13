const assert = require('assert')
const assistantService = require('../src/assistant-service')
const matchService = require('../src/match-service')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function listing(id, data) {
  return {
    id,
    title: `${data.community} · ${data.layout}`,
    shortTitle: data.community,
    uploaderId: 'U001',
    rent: data.rent,
    layout: data.layout,
    city: '杭州',
    district: data.area || '拱墅',
    area: data.area || '拱墅',
    block: data.block || '测试板块',
    community: data.community,
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: `杭州${data.community}1幢1单元101室`,
    landlordPhone: '13900000001',
    commissionRate: 20,
    videoUrl: `https://example.com/${id}.mp4?Signature=raw`,
    videoKey: `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: data.rentMode || '合租',
    rentMode: data.rentMode || '合租',
    room: data.room || '单间',
    hall: '',
    bath: '',
    features: data.features || ['电梯'],
    source: '普通上传',
    mapLatitude: data.latitude,
    mapLongitude: data.longitude,
    coordinateSource: data.coordinateSource,
    coordinateVerified: data.coordinateVerified,
    createdAt: now,
    lastVerifiedAt: now
  }
}

function makeDb() {
  return {
    currentUserId: 'U001',
    users: [
      { id: 'U001', name: '测试中介', phone: '13800010001', role: '中介', authed: '手机号登录' }
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 15 },
    placeCoordinates: {
      默认中心大厦: {
        latitude: 30.3192,
        longitude: 120.1694,
        source: 'default-center',
        coordinateVerified: true,
        area: '拱墅'
      },
      真实地标: {
        latitude: 30.3192,
        longitude: 120.1694,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅'
      }
    },
    listings: [
      listing('GOOD01', {
        community: '真实坐标测试公寓',
        rent: 1900,
        layout: '合租单间',
        latitude: 30.3194,
        longitude: 120.1696,
        coordinateSource: 'manual-confirmed-test-coordinate',
        coordinateVerified: true
      }),
      listing('BAD01', {
        community: '默认中心坏坐标公寓',
        rent: 1800,
        layout: '合租单间',
        latitude: 30.3192,
        longitude: 120.1694,
        coordinateSource: 'default-center',
        coordinateVerified: true
      })
    ],
    footprints: []
  }
}

function ids(result) {
  return (result.listings || []).map((item) => item.id)
}

async function chat(db, text) {
  return assistantService.chat(db, { text, debugTrace: true }, { userId: 'U001' })
}

async function main() {
  const candidateDb = makeDb()
  candidateDb.listings[0].recommendationProfile = {
    ready: true,
    qualityScore: 88,
    freshnessScore: 91,
    coordinateQuality: 'contact privateid 19900007777'
  }
  const publicCandidates = matchService._internal.candidateListings(candidateDb)
  const publicGood = publicCandidates.find((item) => item.id === 'GOOD01')
  assert.strictEqual(publicGood.mapLatitude, 30.32, '助手合作候选只能注入公开降精度纬度，不能复用逐套坐标')
  assert.strictEqual(publicGood.mapLongitude, 120.17, '助手合作候选只能注入公开降精度经度，不能复用逐套坐标')
  assert.notStrictEqual(publicGood.coordinateSource, 'manual-confirmed-test-coordinate', '助手合作候选不得携带逐套可信坐标来源')
  assert.strictEqual(publicGood.coordinateQuality, 'unverified', '助手坐标质量必须从公共坐标重新计算，不能信任存量 profile 文本')
  assert.ok(!JSON.stringify(publicCandidates).includes('privateid') && !JSON.stringify(publicCandidates).includes('19900007777'), '助手候选不得夹带 recommendationProfile 私号')
  const promptSafe = matchService.safeListingsForPrompt([{ ...publicGood, coordinateQuality: 'contact privateid 19900007777' }])
  assert.strictEqual(promptSafe[0].coordinateQuality, 'missing', 'LLM 提示词白名单还必须二次枚举 coordinateQuality')

  assistantService._internal.threadStore._internal.resetForTest()
  const badAnchor = await chat(makeDb(), '默认中心大厦附近2000左右的单间')
  assert.strictEqual(badAnchor.placeResolution.status, 'missing', '坏来源地点不能作为半径锚点')
  assert(badAnchor.nextQuestion, '坏来源地点必须追问确认附近地点')
  assert.strictEqual((badAnchor.listings || []).length, 0, '坏来源地点不能静默返回周边房源')

  assistantService._internal.threadStore._internal.resetForTest()
  const goodAnchor = await chat(makeDb(), '真实地标3公里内2000左右的单间')
  assert(ids(goodAnchor).includes('GOOD01'), '可靠坐标房源应能进入半径结果')
  assert(!ids(goodAnchor).includes('BAD01'), '坏来源房源坐标不能混入半径结果')
  assert(goodAnchor.traceSummary.nodes.includes('geo_place_tool'), '坐标安全场景应经过地点工具')
  assert(goodAnchor.traceSummary.nodes.includes('ranking_tool'), '可靠地点应进入排序工具')

  console.log('assistant-coordinate-safety-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
