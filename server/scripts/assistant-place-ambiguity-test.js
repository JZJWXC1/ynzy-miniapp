const assert = require('assert')
const assistantService = require('../src/assistant-service')
const { resolvePlace } = require('../src/place-locator')
const { containsSensitiveText } = require('../src/assistant/safety')

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
    district: data.area,
    area: data.area,
    block: data.block || data.area,
    community: data.community,
    commissionRate: 20,
    videoUrl: `https://example.com/${id}.mp4?OSSAccessKeyId=ak&Signature=raw`,
    videoKey: `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    type: data.rentMode,
    rentMode: data.rentMode,
    room: data.room || '',
    features: data.features || [],
    source: '普通上传',
    mapLatitude: data.latitude,
    mapLongitude: data.longitude,
    coordinateSource: 'manual-confirmed-test-coordinate',
    coordinateVerified: true,
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
      拱墅万达: {
        latitude: 30.333,
        longitude: 120.128,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅',
        aliases: ['万达']
      },
      余杭万达: {
        latitude: 30.299,
        longitude: 120.041,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '余杭',
        aliases: ['万达']
      }
    },
    listings: [
      listing('GSD01', {
        area: '拱墅',
        block: '万达',
        community: '拱墅万达公寓',
        rent: 1950,
        layout: '合租单间',
        rentMode: '合租',
        room: '单间',
        latitude: 30.333,
        longitude: 120.128
      }),
      listing('YHWD01', {
        area: '余杭',
        block: '万达',
        community: '余杭万达公寓',
        rent: 1980,
        layout: '合租单间',
        rentMode: '合租',
        room: '单间',
        latitude: 30.299,
        longitude: 120.041
      })
    ],
    footprints: []
  }
}

async function main() {
  const db = makeDb()
  const direct = resolvePlace(db, '万达', db.listings)
  assert.strictEqual(direct.status, 'ambiguous', '同名/同别名地点必须返回 ambiguous')
  assert.strictEqual((direct.candidates || []).length, 2, '歧义地点应返回多个候选')

  assistantService._internal.threadStore._internal.resetForTest()
  const result = await assistantService.chat(db, {
    debugTrace: true,
    text: '万达附近有哪些2000左右的单间'
  }, {
    userId: 'U001',
    debugTrace: true
  })

  assert.strictEqual(result.intent, 'rental_match', '万达附近找房应识别为找房意图')
  assert.strictEqual(result.need.searchMode, 'radius_around_place', '附近地名应进入半径找房模式')
  assert.strictEqual(result.placeResolution.status, 'ambiguous', '完整链路应保留地点歧义状态')
  assert(result.nextQuestion, '地点歧义时必须追问中介确认')
  assert(result.nextQuestion.indexOf('拱墅万达') !== -1, '追问应展示候选地点')
  assert(result.nextQuestion.indexOf('余杭万达') !== -1, '追问应展示候选地点')
  assert.strictEqual((result.listings || []).length, 0, '地点歧义时不能静默推荐房源')
  assert(result.traceSummary.nodes.includes('geo_place_tool'), '歧义地点也必须经过地点工具')
  assert(result.traceSummary.audit.shouldAskFollowUp, 'trace audit 应标记地点歧义追问')
  assert(!containsSensitiveText(result), '地点歧义结果不能包含敏感信息')

  console.log('assistant-place-ambiguity-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
