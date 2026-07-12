'use strict'

const assert = require('assert')
const mockData = require('../../utils/mock-data')

function listingPayload(suffix, overrides = {}) {
  const roomNumber = String(suffix)
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '半山',
    communityName: '半山家苑',
    community: '半山家苑',
    building: '1',
    unit: '1',
    roomNumber,
    address: `杭州拱墅区半山家苑1栋1单元${roomNumber}室`,
    contact: '19900000031',
    landlordPhone: '19900000031',
    rent: 3200,
    layout: '整租两室1厅1卫',
    rentMode: '整租',
    room: '两室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯', 'Loft'],
    videoKey: `house-videos/synthetic/mock-favorite-${roomNumber}.mp4`,
    viewingMethod: '联系房东',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    landlordCommissionPercent: 50,
    ...overrides
  }
}

async function run() {
  mockData.loginByPhone('13800010005')
  const listing = mockData.addNormalListing(listingPayload('9401'))
  assert.ok(listing.id)

  const first = mockData.setFavorite(listing.id, true)
  const second = mockData.setFavorite(listing.id, true)
  assert.strictEqual(first.id, second.id, 'Mock 重复收藏必须幂等')
  assert.deepStrictEqual(mockData.getFavoriteIds(), [listing.id])

  const rows = mockData.getFavorites({
    district: '拱墅区',
    block: '半山',
    community: '半山家苑',
    layout: '两室',
    rentMode: '整租',
    rentMin: 3000,
    rentMax: 3500,
    features: '电梯,Loft',
    availability: 'available',
    category: '二房东房源'
  })
  assert.deepStrictEqual(rows.map((item) => item.id), [listing.id], 'Mock 必须执行与服务端同口径组合筛选')
  const safeText = JSON.stringify(rows)
  assert.ok(!safeText.includes('19900000031'), 'Mock 收藏 DTO 不得返回电话')
  assert.ok(!safeText.includes('1栋1单元9401室'), 'Mock 收藏 DTO 不得返回详细房号')

  mockData.verifyMyListing(listing.id, '已出租')
  const unavailable = mockData.getFavorites({ availability: 'unavailable' })
  assert.ok(unavailable.some((item) => item.id === listing.id && item.isAvailable === false), 'Mock 失效收藏必须灰态保留')
  assert.strictEqual(mockData.setFavorite(listing.id, false).isFavorited, false)
  assert.deepStrictEqual(mockData.getFavoriteIds(), [])
  assert.strictEqual(mockData.setFavorite(listing.id, false).isFavorited, false, 'Mock 重复取消必须幂等')

  // 切换账号后收藏隔离；开发者工具登录 API 返回与真实接口同形状的明显假 token。
  mockData.loginByPhone('13800010002')
  assert.deepStrictEqual(mockData.getFavoriteIds(), [])

  const apiClientPath = require.resolve('../../utils/api-client')
  const apiServicePath = require.resolve('../../utils/api-service')
  const captured = []
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      call(options) {
        captured.push(options)
        if (options.path === '/mini/auth/login') return Promise.resolve(options.mock())
        return Promise.resolve({ listingId: 'synthetic', isFavorited: options.method === 'PUT' })
      }
    }
  }
  delete require.cache[apiServicePath]
  const apiService = require(apiServicePath)
  const login = await apiService.loginByPhone('13800010005', 'synthetic-password')
  assert.ok(login.id)
  assert.ok(/^synthetic-mock-token-/.test(login.token), 'Mock 登录必须返回明显假 token，供登录态收藏验收')
  assert.ok(Number.isFinite(Date.parse(login.tokenExpiresAt)))

  await apiService.setFavorite('L% synthetic', true)
  const favoriteCall = captured[captured.length - 1]
  assert.strictEqual(favoriteCall.method, 'PUT')
  assert.ok(favoriteCall.path.includes('L%25%20synthetic'), '房源 id 必须 URL 编码')
  assert.ok(!Object.prototype.hasOwnProperty.call(favoriteCall, 'data'), '收藏写接口不得携带客户端身份正文')

  console.log('favorite-mock-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
