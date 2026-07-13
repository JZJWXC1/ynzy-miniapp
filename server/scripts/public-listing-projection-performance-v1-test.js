'use strict'

const assert = require('assert')
const domain = require('../src/domain')
const mockData = require('../../utils/mock-data')

const LISTING_COUNT = 24

function elapsedMs(action) {
  const startedAt = process.hrtime.bigint()
  const value = action()
  return {
    value,
    milliseconds: Number(process.hrtime.bigint() - startedAt) / 1e6
  }
}

function partnerListing(index) {
  const suffix = String(index + 1).padStart(4, '0')
  const roomNumber = String(700 + index)
  const community = `性能门禁测试小区${index + 1}`
  return {
    id: `PERF-LISTING-${suffix}`,
    uploaderId: 'PERF-UPLOADER',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新',
    community,
    communityName: community,
    building: '1',
    unit: '2',
    roomNumber,
    address: `杭州拱墅区${community}1栋2单元${roomNumber}室`,
    landlordPhone: `1990000${suffix}`,
    contact: `1990000${suffix}`,
    rent: 3000 + index,
    rentMode: '整租',
    type: '整租',
    layout: '两室1厅1卫',
    room: '两室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯', '近地铁'],
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '已通过',
    communityMatched: true,
    lastVerifiedAt: new Date().toISOString(),
    videoKey: `house-videos/synthetic/performance-${suffix}.mp4`,
    landlordCommissionPercent: 50
  }
}

function assertWarmProjectionReused(label, action) {
  const cold = elapsedMs(action)
  const warm = elapsedMs(action)
  assert.strictEqual(cold.value.length, LISTING_COUNT, `${label} 冷启动必须返回完整房源`)
  assert.strictEqual(warm.value.length, LISTING_COUNT, `${label} 热路径必须返回完整房源`)
  // 使用相对门槛避免不同机器绝对速度造成假红；没有投影复用时两次耗时基本相同，
  // 有缓存时第二次只做轻量签名核对和 DTO 组装，应显著低于第一次。
  assert.ok(
    warm.milliseconds < cold.milliseconds * 0.65,
    `${label} 未复用同一安全投影：cold=${cold.milliseconds.toFixed(1)}ms warm=${warm.milliseconds.toFixed(1)}ms`
  )
  return { cold: cold.milliseconds, warm: warm.milliseconds }
}

function assertDomainProjection() {
  const listings = Array.from({ length: LISTING_COUNT }, (_, index) => partnerListing(index))
  const db = {
    listings,
    users: [{ id: 'PERF-UPLOADER', name: '性能测试账号', status: '正常', authed: '已实名' }],
    commissionConfig: {}
  }
  const timing = assertWarmProjectionReused('生产领域层', () => domain.filterListings(db, { publicGuest: true }))

  // 缓存必须跟随所有安全上下文字段变化失效；改变完整地址、电话及公开载体后，
  // 旧的“安全结果”绝不能复用到新原文。
  const target = listings[0]
  target.address = '杭州拱墅区性能变更测试小区9栋8单元701室'
  target.landlordPhone = '19900009999'
  target.contact = '19900009999'
  target.block = '东新 19900009999 9栋8单元701室'
  const changed = domain.filterListings(db, { publicGuest: true }).find((item) => item.id === target.id)
  const serialized = JSON.stringify(changed)
  assert.ok(!serialized.includes('19900009999'), '生产投影缓存失效后不得泄露新电话')
  assert.ok(!serialized.includes('9栋8单元701室'), '生产投影缓存失效后不得泄露新精确地址')
  return timing
}

function mockListingPayload(index) {
  const listing = partnerListing(index)
  return {
    city: listing.city,
    district: listing.district,
    area: listing.area,
    block: listing.block,
    communityName: listing.community,
    community: listing.community,
    building: listing.building,
    unit: listing.unit,
    roomNumber: listing.roomNumber,
    address: listing.address,
    contact: listing.contact,
    landlordPhone: listing.landlordPhone,
    rent: listing.rent,
    layout: listing.layout,
    rentMode: listing.rentMode,
    room: listing.room,
    hall: listing.hall,
    bath: listing.bath,
    features: listing.features,
    videoUrl: `https://example.com/synthetic/performance-${index + 1}.mp4`,
    videoKey: listing.videoKey,
    viewingMethod: '联系房东',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    landlordCommissionPercent: 50
  }
}

function assertMockProjection() {
  mockData.loginByPhone('13800010005')
  for (let index = 0; index < LISTING_COUNT; index += 1) {
    mockData.addNormalListing(mockListingPayload(index))
  }
  return assertWarmProjectionReused('Mock 预览层', () => mockData.getListings({ publicGuest: true }))
}

const domainTiming = assertDomainProjection()
const mockTiming = assertMockProjection()
console.log(`PUBLIC_LISTING_PROJECTION_PERFORMANCE PASS domain=${domainTiming.cold.toFixed(1)}→${domainTiming.warm.toFixed(1)}ms mock=${mockTiming.cold.toFixed(1)}→${mockTiming.warm.toFixed(1)}ms`)
