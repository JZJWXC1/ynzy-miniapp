'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const mockData = require('../../utils/mock-data')

function waitNextMillisecond() {
  const current = Date.now()
  while (Date.now() === current) {}
}

function payload(index, source, overrides = {}) {
  const roomNumber = String(9600 + index)
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新',
    communityName: '长木府',
    community: '长木府',
    building: '1',
    unit: '1',
    roomNumber,
    address: `SENTINEL_MOCK_NEARBY_ADDRESS_${roomNumber}`,
    contact: '19900000043',
    landlordPhone: '19900000043',
    rent: 3000 + index,
    layout: '整租一室1厅1卫',
    rentMode: '整租',
    room: '一室',
    hall: '1厅',
    bath: '1卫',
    features: ['Loft', '落地窗'],
    videoKey: `house-videos/synthetic/mock-nearby-${roomNumber}.mp4`,
    viewingMethod: '联系房东',
    viewingPassword: 'SENTINEL_MOCK_NEARBY_PASSWORD',
    viewingKeyLocation: 'SENTINEL_MOCK_NEARBY_KEY',
    ownerType: source,
    houseSourceType: source,
    source,
    landlordCommissionPercent: 50,
    ...overrides
  }
}

function add(index, source, overrides) {
  waitNextMillisecond()
  return mockData.addNormalListing(payload(index, source, overrides))
}

function assertSafe(result) {
  const text = JSON.stringify(result)
  ;[
    'SENTINEL_MOCK_NEARBY_ADDRESS',
    '19900000043',
    'SENTINEL_MOCK_NEARBY_PASSWORD',
    'SENTINEL_MOCK_NEARBY_KEY',
    'mapLatitude',
    'mapLongitude',
    'coordinateSource',
    'uploaderId'
  ].forEach((marker) => assert.ok(!text.includes(marker), `Mock 附近 DTO 不得包含 ${marker}`))
}

async function run() {
  const mockSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'utils', 'mock-data.js'), 'utf8')
  const coordinateStart = mockSource.indexOf('function nearbyReliableCoordinate')
  const coordinateEnd = mockSource.indexOf('function nearbyDistanceKm', coordinateStart)
  const coordinateBlock = mockSource.slice(coordinateStart, coordinateEnd)
  const rejectSourceAt = coordinateBlock.indexOf('block-center|tencent-geocode')
  const allowSourceAt = coordinateBlock.indexOf('admin-verified-coordinate|community-coordinate|manual-confirmed|lianjia|amap')
  assert.ok(rejectSourceAt >= 0 && allowSourceAt > rejectSourceAt, 'Mock 必须先拒绝伪标 verified 的近似/板块来源，再判断可信来源白名单')

  // 用明显合成的预置管理员账号创建三类夹具；失败必须来自附近功能缺失，而不是公司来源上传权限。
  mockData.loginByPhone('13800010004')
  const anchor = add(0, '公司房源')
  const company = add(1, '公司房源')
  const owner = add(2, '业主房源')
  const secondLandlord = add(3, '二房东房源')
  const more = [
    add(4, '二房东房源'),
    add(5, '业主房源'),
    add(6, '二房东房源'),
    add(7, '公司房源')
  ]
  const noCoordinate = add(8, '二房东房源', {
    block: '合成未知板块',
    communityName: '合成未知坐标小区',
    community: '合成未知坐标小区'
  })
  const expiredPartner = add(9, '业主房源')
  mockData.reviewOwnerListing(owner.id, 'approve')
  mockData.reviewOwnerListing(more[1].id, 'approve')
  mockData.reviewOwnerListing(expiredPartner.id, 'approve')
  mockData.verifyMyListing(expiredPartner.id, '已出租')

  assert.strictEqual(typeof mockData.getNearbyListings, 'function', 'Mock 必须提供同形附近推荐')
  const preview = mockData.getNearbyListings(anchor.id, { companyOnly: false })
  assert.strictEqual(preview.radiusKm, 3)
  assert.strictEqual(preview.listings.length, 6, 'Mock 详情预览最多 6 套')
  assert.strictEqual(preview.total, 7, 'Mock 应返回同小区的七个有效候选')
  assert.strictEqual(preview.hasMore, true)
  assert.ok(!preview.listings.some((item) => item.id === anchor.id || item.id === noCoordinate.id), 'Mock 必须排除当前房源与无可靠坐标房源')
  assert.ok(preview.listings.every((item) => item.distanceKm === 0), '同小区可信坐标距离应为 0')
  assertSafe(preview)

  const all = mockData.getNearbyListings(anchor.id, { all: true, companyOnly: false })
  assert.deepStrictEqual(
    new Set(all.listings.map((item) => item.id)),
    new Set([company.id, owner.id, secondLandlord.id].concat(more.map((item) => item.id))),
    'Mock 全量应包含三类来源的全部有效候选'
  )
  assert.strictEqual(all.hasMore, false)

  const guest = mockData.getNearbyListings(anchor.id, { all: true, publicGuest: true })
  assert.strictEqual(guest.total, 7, 'Mock 游客附近结果必须统计三类有效房源')
  assert.ok(guest.listings.some((item) => !item.companyListing), 'Mock 游客必须拿到公开的业主/二房东附近房源')
  const ownerGuest = mockData.getNearbyListings(owner.id, { all: true, publicGuest: true })
  assert.ok(ownerGuest.listings.length > 0, 'Mock 游客可用有效业主房源作为附近锚点')
  assertSafe(ownerGuest)
  assert.throws(
    () => mockData.getNearbyListings(expiredPartner.id, { all: true, publicGuest: true }),
    (error) => error && error.statusCode === 404,
    'Mock 游客对已失效合作锚点必须返回 404'
  )

  const detail = mockData.getListingDetail(anchor.id, { publicGuest: true })
  assert.ok(detail.nearby)
  assert.strictEqual(detail.nearby.listings.length, 6, 'Mock 详情必须内嵌同形预览')

  const apiClientPath = require.resolve('../../utils/api-client')
  const apiServicePath = require.resolve('../../utils/api-service')
  const calls = []
  let token = ''
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      getAuthToken: () => token,
      call(options) {
        calls.push(options)
        const executeMock = (requestData) => Promise.resolve().then(() => options.mock(requestData))
        return executeMock(options.data).catch((error) => {
          if (!error || error.statusCode !== 401 || options.publicReadAuthFallback !== true || !token) throw error
          token = ''
          const method = String(options.method || 'GET').toUpperCase()
          const mayReplayAnonymous = method === 'GET' || (
            method === 'POST' &&
            options.retryAnonymousOnAuthFailure === true &&
            error.data &&
            error.data.authFailurePhase === 'pre_execution'
          )
          if (!mayReplayAnonymous) throw error
          const anonymousData = typeof options.buildAnonymousRetryData === 'function'
            ? options.buildAnonymousRetryData(options.data)
            : options.data
          return executeMock(anonymousData)
        })
      }
    }
  }
  delete require.cache[apiServicePath]
  const apiService = require(apiServicePath)

  const guestApi = await apiService.getNearbyListings(anchor.id)
  assert.ok(guestApi.listings.some((item) => !item.companyListing), 'API Mock 游客分支必须返回三类公开附近房源')
  const guestCall = calls[calls.length - 1]
  assert.ok(guestCall.path.endsWith(`/mini/listings/${encodeURIComponent(anchor.id)}/nearby?all=1`))
  assert.ok(!/radius|latitude|longitude|companyOnly|userId|role/i.test(guestCall.path), '客户端附近请求不得发送权限、半径或坐标字段')

  token = 'synthetic-mock-login-token'
  const brokerApi = await apiService.getNearbyListings(anchor.id)
  assert.strictEqual(brokerApi.total, 7, '无效 token 的 Mock 公开 GET 应撤销伪身份并以游客返回三类来源')
  assert.strictEqual(token, '', 'Mock 公开 GET 遇到伪 token 必须先撤销本地伪身份再匿名重试')

  console.log('listing-nearby-mock-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
