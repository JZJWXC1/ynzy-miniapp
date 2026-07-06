const assert = require('assert')
const assistantService = require('../src/assistant-service')
const { containsSensitiveText } = require('../src/assistant/safety')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function listing(id, data) {
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
    videoUrl: `https://example.com/${id}.mp4`,
    videoKey: `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: data.rentMode,
    rentMode: data.rentMode,
    room: data.room || '',
    hall: data.hall || '',
    bath: data.bath || '',
    features: data.features || [],
    source: '普通上传',
    companyListing: false,
    isCompanyListing: false,
    noCommission: false,
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
      { id: 'U001', name: '测试中介', phone: '13800010001', role: '中介', authed: '手机号登录', isAdmin: false }
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 15 },
    placeCoordinates: {
      新天地: {
        latitude: 30.309,
        longitude: 120.181,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅'
      },
      拱墅万达: {
        latitude: 30.333,
        longitude: 120.128,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅',
        aliases: ['万达']
      },
      乐富智慧园: {
        latitude: 30.335,
        longitude: 120.121,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅'
      },
      祥符空小区: {
        latitude: 30.342,
        longitude: 120.116,
        source: 'manual-confirmed-test-coordinate',
        coordinateVerified: true,
        area: '拱墅',
        type: 'community'
      }
    },
    listings: [
      listing('XTD01', { area: '拱墅', block: '新天地', community: '新天地', rent: 4200, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.309, longitude: 120.181, features: ['电梯', '近地铁'] }),
      listing('XTD02', { area: '拱墅', block: '新天地', community: '长浜龙吟轩', rent: 3900, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.309357, longitude: 120.184283, features: ['带阳台'] }),
      listing('XTD03', { area: '拱墅', block: '东新', community: '杨乐府', rent: 3600, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.303432, longitude: 120.168634, features: ['燃气'] }),
      listing('XTD04', { area: '拱墅', block: '华丰', community: '华丰欣苑', rent: 3300, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', latitude: 30.337823, longitude: 120.200076, features: ['电梯'] }),
      listing('WD01', { area: '拱墅', block: '万达', community: '拱墅万达公寓', rent: 1950, layout: '合租单间', rentMode: '合租', room: '单间', latitude: 30.333, longitude: 120.128, features: ['独卫'] }),
      listing('WD02', { area: '拱墅', block: '万达', community: '万融城', rent: 2100, layout: '合租单间', rentMode: '合租', room: '单间', latitude: 30.333846, longitude: 120.127299, features: ['电梯'] }),
      listing('WD03', { area: '拱墅', block: '万达', community: '吉如家园', rent: 2500, layout: '合租单间', rentMode: '合租', room: '单间', latitude: 30.31814, longitude: 120.129706, features: ['独卫'] }),
      listing('DXY01', { area: '拱墅', block: '东新园', community: '东新园', rent: 3800, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', latitude: 30.303, longitude: 120.168, features: ['燃气', '电梯'] }),
      listing('LF01', { area: '拱墅', block: '祥符', community: '乐富智慧园公寓', rent: 1450, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', latitude: 30.335, longitude: 120.121, features: ['电梯'] }),
      listing('LF02', { area: '拱墅', block: '祥符', community: '小洋坝家园二区', rent: 1550, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', latitude: 30.342, longitude: 120.116, features: ['近地铁'] }),
      listing('LF03', { area: '拱墅', block: '祥符', community: '昌运里三区', rent: 1800, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', latitude: 30.36, longitude: 120.16, features: ['燃气'] })
    ],
    footprints: []
  }
}

function ids(result) {
  return (result.listings || []).map((item) => item.id)
}

function assertSafe(result) {
  assert(!containsSensitiveText(result), '返回结果包含敏感内容')
  ;(result.listings || []).forEach((listing) => {
    assert(listing.distanceText, `半径结果缺少距离：${listing.id}`)
    assert(!Object.prototype.hasOwnProperty.call(listing, 'address'), '不应返回完整地址')
    assert(!Object.prototype.hasOwnProperty.call(listing, 'landlordPhone'), '不应返回房东电话')
  })
}

async function ask(db, text) {
  assistantService._internal.threadStore._internal.resetForTest()
  return assistantService.chat(db, { text }, { userId: 'U001' })
}

async function main() {
  const db = makeDb()

  let result = await ask(db, '新天地3公里内有哪些整租的两室')
  assert.strictEqual(result.intent, 'rental_match')
  assert.strictEqual(result.need.searchMode, 'radius_around_place')
  assert.strictEqual(result.need.anchorName, '新天地')
  assert.strictEqual(result.need.radiusKm, 3)
  assert(ids(result).includes('XTD01'), '应返回新天地内两室整租')
  assert(ids(result).includes('XTD02'), '应返回新天地周边两室整租')
  assert(ids(result).includes('XTD03'), '应返回3公里内两室整租')
  assert(!ids(result).includes('XTD04'), '不应返回一室整租')
  assert.strictEqual(result.placeResolution.status, 'resolved', '半径找房应返回地点解析状态')
  assert(!Object.prototype.hasOwnProperty.call(result.placeResolution, 'latitude'), '地点解析结果不应暴露纬度')
  assert(!Object.prototype.hasOwnProperty.call(result.placeResolution, 'longitude'), '地点解析结果不应暴露经度')
  assertSafe(result)

  result = await ask(db, '拱墅万达附近有哪些2000左右的单间')
  assert.strictEqual(result.need.searchMode, 'radius_around_place')
  assert.strictEqual(result.need.anchorName, '拱墅万达')
  assert.strictEqual(result.need.preferences.budgetTolerance, 300, '左右类预算默认应允许300元浮动')
  assert(ids(result).includes('WD01'), '应返回2000左右单间')
  assert(ids(result).includes('WD02'), '应返回略超预算但接近的单间')
  assert(!ids(result).includes('LF01'), '单间问题不应混入一室整租')
  assert(!ids(result).includes('LF02'), '单间问题不应混入一室整租')
  assertSafe(result)

  result = await ask(db, '东新园附近两室4000以内')
  assert(!result.need.searchMode, '已知板块附近问法不应进入坐标半径分支')
  assert.strictEqual(result.need.community, '东新园', '已知板块应直接落入小区/板块筛选槽位')
  assert.strictEqual(result.nextQuestion || '', '', '东新园是已知板块，不应追问坐标或地址')
  assert(ids(result).includes('DXY01'), '应返回东新园板块两室房源')
  assert(!/没确认坐标|附近的地点|具体地址/.test(result.reply || ''), '已知板块命中后不得出现坐标未确认话术')

  result = await ask(db, '想住新天地，三千七以内，两室')
  assert.strictEqual(result.need.community, '新天地')
  assert.strictEqual((result.exactListings || []).length, 0, '小区内无完全符合时不应硬造精确结果')
  assert(ids(result).includes('XTD03'), '小区无精确结果时应按坐标推荐相邻小区')
  assert((result.listings || []).some((item) => item.distanceText), '相邻小区推荐应带距离')
  assert((result.listings || []).some((item) => /不在新天地/.test(item.differenceText || '')), '相邻小区应说明不在目标小区')
  assertSafe(result)

  result = await ask(db, '想住祥符空小区，1500左右的一室整租')
  assert.strictEqual(result.need.community, '祥符空小区')
  assert.strictEqual(result.placeResolution.status, 'resolved', '坐标库里有的小区应能解析坐标')
  assert.strictEqual((result.exactListings || []).length, 0, '无本小区房源时不应伪造精确匹配')
  assert(ids(result).includes('LF02'), '坐标库有小区但当前无本小区房源时应推荐相邻小区')
  assert((result.listings || []).some((item) => item.distanceText), '相邻推荐应带距离说明')
  assertSafe(result)

  result = await ask(db, '租客在乐富智慧园上班，她住的两公里内有什么1500左右的一室整租')
  assert.strictEqual(result.need.searchMode, 'radius_around_place')
  assert.strictEqual(result.need.anchorName, '乐富智慧园')
  assert.strictEqual(result.need.anchorRole, 'workplace')
  assert.strictEqual(result.need.radiusKm, 2)
  assert(ids(result).includes('LF01'), '应返回乐富智慧园附近一室整租')
  assert(ids(result).includes('LF02'), '应返回两公里内略超预算的一室整租')
  assert(!ids(result).includes('LF03'), '不应返回两公里外房源')
  assertSafe(result)

  result = await ask(db, '陌生产业园2公里内有什么一室整租')
  assert(result.nextQuestion, '查不到地点坐标时应追问')
  assert.strictEqual((result.listings || []).length, 0, '坐标未确认时不应返回半径房源')
  assert.strictEqual(result.placeResolution.status, 'missing', '坐标缺失时应返回 missing 解析状态')

  result = await ask(db, '想住陌生小区，1500左右的一室整租')
  assert.strictEqual(result.need.community, '陌生小区', '未知小区也应保留为待定位槽位')
  assert(result.nextQuestion, '未知小区无坐标时应追问')
  assert.strictEqual((result.listings || []).length, 0, '未知小区无坐标时不应返回全局推荐')
  assert.strictEqual(result.placeResolution.status, 'missing', '未知小区应返回 missing 解析状态')

  console.log('assistant-radius-search-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
