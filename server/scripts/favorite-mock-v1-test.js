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
  let authToken = ''
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      getAuthToken() { return authToken },
      call(options) {
        captured.push(options)
        if (options.path.startsWith('/mini/auth/')) return Promise.resolve().then(() => options.mock())
        return Promise.resolve({ listingId: 'synthetic', isFavorited: options.method === 'PUT' })
      }
    }
  }
  delete require.cache[apiServicePath]
  const apiService = require(apiServicePath)
  const login = await apiService.loginByPhone('13800010005', 'synthetic-password')
  assert.ok(login.id)
  assert.ok(/^synthetic-mock-session-/.test(login.token), 'Mock 登录必须返回明显假且可验证的会话 token，供登录态收藏验收')
  assert.ok(Number.isFinite(login.tokenExpiresAt) && login.tokenExpiresAt > Date.now(), 'Mock 登录 expiry 必须与真实 DTO 同为 epoch ms number')
  const firstToken = login.token
  authToken = firstToken

  const secondLogin = await apiService.loginByPhone('13800010005', 'synthetic-password')
  assert.notStrictEqual(secondLogin.token, firstToken, 'Mock 同账号再次登录必须签发独立 token')
  const secondToken = secondLogin.token
  authToken = secondToken

  const changed = await apiService.changePassword('synthetic-old-password', 'synthetic-new-password')
  assert.ok(changed.id && /^synthetic-mock-session-/.test(changed.token), 'Mock 改密必须返回新会话 DTO')
  assert.ok(Number.isFinite(changed.tokenExpiresAt) && changed.tokenExpiresAt > Date.now(), 'Mock 改密 expiry 必须为 epoch ms number')
  authToken = firstToken
  await assert.rejects(
    apiService.getCurrentUser(),
    (error) => error && error.statusCode === 401,
    'Mock 改密必须撤销同账号第一台设备的旧 token'
  )
  authToken = secondToken
  await assert.rejects(
    apiService.getCurrentUser(),
    (error) => error && error.statusCode === 401,
    'Mock 改密必须撤销同账号当前设备的旧 token'
  )
  authToken = changed.token
  assert.strictEqual((await apiService.getCurrentUser()).id, changed.id, 'Mock 改密返回的新 token 必须立即可用')
  assert.deepStrictEqual(await apiService.logout(), { loggedOut: true, scope: 'all-devices' }, 'Mock 退出必须与真实全设备撤销 DTO 同形')
  await assert.rejects(
    apiService.getCurrentUser(),
    (error) => error && error.statusCode === 401,
    'Mock 主动退出后当前 token 必须立即失效'
  )
  authToken = ''
  await assert.rejects(
    apiService.registerUser({ name: '合成已开通用户', phone: '13800010005', password: 'synthetic-password' }),
    (error) => error && error.statusCode === 409,
    'Mock 已开通手机号注册必须与真实接口一致返回 409，不能伪造登录成功'
  )
  await assert.rejects(
    apiService.registerUser({ name: '合成待审核用户', phone: '19900009999', password: 'synthetic-password' }),
    (error) => error && error.statusCode === 403,
    'Mock 新手机号注册必须与真实接口一致进入待审核且不发 token'
  )

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
