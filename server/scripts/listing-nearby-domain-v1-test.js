'use strict'

const assert = require('assert')
const domain = require('../src/domain')

const NOW = new Date().toISOString()

function listing(id, latitude, longitude, overrides = {}) {
  return {
    id,
    uploaderId: 'U1',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    communityMatched: true,
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '合成板块',
    community: `合成小区-${id}`,
    address: `SENTINEL_NEARBY_ADDRESS_${id}`,
    building: 'SENTINEL_BUILDING',
    unit: 'SENTINEL_UNIT',
    roomNumber: 'SENTINEL_ROOM',
    landlordPhone: '19900000041',
    contact: '19900000041',
    viewingPassword: 'SENTINEL_NEARBY_PASSWORD',
    viewingKeyLocation: 'SENTINEL_NEARBY_KEY',
    uploader: 'SENTINEL_NEARBY_UPLOADER',
    rent: 3000,
    rentMode: '整租',
    type: '整租',
    layout: '整租一室一厅一卫',
    features: ['Loft', '落地窗'],
    videoKey: `house-videos/synthetic/${id}.mp4`,
    mapLatitude: latitude,
    mapLongitude: longitude,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    coordinateLevel: 'verified',
    coordinateAccuracy: 'verified',
    landlordCommissionPercent: 50,
    lastVerifiedAt: NOW,
    updatedAt: NOW,
    createdAt: NOW,
    ...overrides
  }
}

function company(id, latitude, longitude, overrides = {}) {
  return listing(id, latitude, longitude, {
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    companyListing: true,
    reviewStatus: '无需审核',
    ...overrides
  })
}

function owner(id, latitude, longitude, overrides = {}) {
  return listing(id, latitude, longitude, {
    ownerType: '业主房源',
    houseSourceType: '业主房源',
    source: '业主房源',
    requiresManualReview: true,
    reviewStatus: '已通过',
    ...overrides
  })
}

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '合成上传人', role: '中介', authed: '已实名' },
      { id: 'U2', name: '合成查看人', role: '中介', authed: '已实名' }
    ],
    listings: [
      company('ANCHOR', 30.3, 120.1),
      company('N1', 30.3045, 120.1, { rent: 3100 }),
      owner('N2', 30.309, 120.1, { rent: 3200, layout: '整租两室一厅一卫' }),
      listing('N3', 30.3135, 120.1, { rent: 3300, rentMode: '合租', type: '合租' }),
      company('N4', 30.318, 120.1, { rent: 3400, videoKey: '' }),
      owner('N5', 30.3225, 120.1, { rent: 3500 }),
      listing('N6', 30.325, 120.1, { rent: 3600 }),
      company('N7', 30.3265, 120.1, { rent: 3700 }),
      company('OUTSIDE', 30.34, 120.1),
      owner('PENDING', 30.302, 120.1, { reviewStatus: '待审核', status: '待审核' }),
      listing('EXPIRED', 30.3025, 120.1, { lifecycleStatus: 'expired', status: '已下架' }),
      listing('SOLD', 30.303, 120.1, { lifecycleStatus: 'sold', status: '已成交' }),
      listing('NO_VIDEO', 30.3035, 120.1, { videoKey: '' }),
      listing('DEFAULT_CENTER', 30.304, 120.1, {
        coordinateSource: 'default-center',
        coordinateVerified: true,
        coordinateLevel: 'verified'
      }),
      listing('UNVERIFIED', 30.304, 120.1, {
        coordinateSource: 'admin-verified-coordinate',
        coordinateVerified: false,
        coordinateLevel: '',
        coordinateAccuracy: ''
      }),
      listing('APPROXIMATE', 30.304, 120.1, {
        coordinateSource: 'tencent-geocode',
        coordinateVerified: false,
        coordinateLevel: 'approximate',
        coordinateAccuracy: 'approximate'
      }),
      listing('BLOCK_CENTER', 30.304, 120.1, {
        coordinateSource: 'block-center:合成板块',
        coordinateVerified: false,
        coordinateLevel: 'block-center',
        coordinateAccuracy: 'block-center'
      }),
      listing('SPOOFED_BLOCK_CENTER', 30.304, 120.1, {
        coordinateSource: 'block-center:合成板块',
        coordinateVerified: true,
        coordinateLevel: 'verified',
        coordinateAccuracy: 'verified'
      }),
      listing('SPOOFED_APPROXIMATE', 30.304, 120.1, {
        coordinateSource: 'tencent-geocode',
        coordinateVerified: true,
        coordinateLevel: 'verified',
        coordinateAccuracy: 'verified'
      })
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 7 },
    commissionRecords: [],
    footprints: []
  }
}

function assertSafeRows(rows) {
  const text = JSON.stringify(rows)
  ;[
    'SENTINEL_NEARBY_ADDRESS',
    '19900000041',
    'SENTINEL_BUILDING',
    'SENTINEL_UNIT',
    'SENTINEL_ROOM',
    'SENTINEL_NEARBY_PASSWORD',
    'SENTINEL_NEARBY_KEY',
    'SENTINEL_NEARBY_UPLOADER',
    'mapLatitude',
    'mapLongitude',
    'coordinateSource',
    'uploaderId',
    'commissionBreakdown'
  ].forEach((marker) => assert.ok(!text.includes(marker), `附近推荐不得包含敏感/内部字段：${marker}`))
}

function run() {
  assert.strictEqual(typeof domain.nearbyListings, 'function', '必须提供服务端附近推荐领域函数')

  const db = makeDb()
  const before = JSON.stringify(db)
  const preview = domain.nearbyListings(db, 'ANCHOR', {
    radiusKm: 999,
    latitude: 0,
    longitude: 0,
    companyOnly: false
  })

  assert.strictEqual(preview.radiusKm, 3, '半径必须由服务端固定为 3 公里')
  assert.strictEqual(preview.total, 7, '三类当前有效房源均应参与，失效/越界/不可靠坐标必须排除')
  assert.strictEqual(preview.listings.length, 6, '详情预览最多返回 6 套')
  assert.strictEqual(preview.hasMore, true, '第 7 套应触发查看全部入口')
  assert.deepStrictEqual(preview.listings.map((item) => item.id), ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'], '必须按距离由近到远')
  const publicOwnerDistance = preview.listings.find((item) => item.id === 'N2').distanceKm
  assert.ok(publicOwnerDistance >= 1.1 && publicOwnerDistance <= 1.12, '合作房源附近距离必须按公开约一公里粒度坐标计算，不能使用逐套精确点')
  assert.ok(preview.listings.every((item) => Number(item.distanceKm) <= 3), '不得返回 3 公里外房源')
  assert.ok(preview.listings.every((item) => item.distanceText), '卡片必须有服务端距离文案')
  assert.ok(preview.listings.every((item) => item.sourceLabel && item.layout && item.features && item.price), '卡片必须包含来源、户型、特点与租金')
  assertSafeRows(preview.listings)
  assert.strictEqual(JSON.stringify(db), before, '附近推荐是纯读计算，不得把距离或推荐 ID 写回数据库')

  const all = domain.nearbyListings(db, 'ANCHOR', { all: true, radiusKm: 0.1 })
  assert.strictEqual(all.radiusKm, 3, '客户端不能缩放固定半径')
  assert.strictEqual(all.total, 7)
  assert.strictEqual(all.listings.length, 7, '查看全部应返回权限内全部 3 公里候选')
  assert.strictEqual(all.hasMore, false)
  assert.deepStrictEqual(all.listings.map((item) => item.id), ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7'])

  const explicitCompanyOnly = domain.nearbyListings(db, 'ANCHOR', { all: true, companyOnly: true })
  assert.deepStrictEqual(explicitCompanyOnly.listings.map((item) => item.id), ['N1', 'N4', 'N7'], '显式 companyOnly 候选池只能保留公司房源')
  assert.strictEqual(explicitCompanyOnly.total, 3, '显式 companyOnly 的 total 必须只统计公司房源')
  assert.strictEqual(explicitCompanyOnly.hasMore, false)

  const sameCoordinateDb = {
    ...makeDb(),
    listings: [
      company('ANCHOR', 30.3, 120.1),
      company('TIE-B', 30.3, 120.1),
      company('TIE-A', 30.3, 120.1)
    ]
  }
  const tied = domain.nearbyListings(sameCoordinateDb, 'ANCHOR', { all: true })
  assert.deepStrictEqual(tied.listings.map((item) => item.id), ['TIE-A', 'TIE-B'], '同坐标距离 0 合法，平距时按 ID 稳定排序')
  assert.ok(tied.listings.every((item) => item.distanceKm === 0))

  const unsafeAnchorDb = makeDb()
  const unsafeAnchor = unsafeAnchorDb.listings.find((item) => item.id === 'ANCHOR')
  unsafeAnchor.coordinateSource = 'default-center'
  unsafeAnchor.coordinateVerified = false
  unsafeAnchor.coordinateLevel = ''
  unsafeAnchor.coordinateAccuracy = ''
  const hidden = domain.nearbyListings(unsafeAnchorDb, 'ANCHOR', { all: true })
  assert.deepStrictEqual(hidden, { radiusKm: 3, total: 0, hasMore: false, listings: [] }, '锚点无可靠坐标时返回空结构，由详情完全隐藏板块')

  const staleAnchorDb = makeDb()
  staleAnchorDb.listingMaintenanceRule.enabled = true
  const staleAnchor = staleAnchorDb.listings.find((item) => item.id === 'ANCHOR')
  staleAnchor.lastVerifiedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  staleAnchor.updatedAt = staleAnchor.lastVerifiedAt
  staleAnchor.createdAt = staleAnchor.lastVerifiedAt
  const staleResult = domain.nearbyListings(staleAnchorDb, 'ANCHOR', { all: true })
  assert.deepStrictEqual(staleResult, { radiusKm: 3, total: 0, hasMore: false, listings: [] }, '超过核验周期的锚点必须先按当前房态失效，不能继续产生附近推荐')

  console.log('listing-nearby-domain-v1-test passed')
}

run()
