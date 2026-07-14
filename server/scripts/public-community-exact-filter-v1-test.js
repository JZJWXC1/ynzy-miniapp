'use strict'

const assert = require('assert')
const domain = require('../src/domain')
const matchService = require('../src/match-service')
const { GONGSHU_COMMUNITIES, normalizeCommunityKey } = require('../src/community-library')
const { communityCoordinates } = require('../src/community-coordinates')
const mockData = require('../../utils/mock-data')

const OFFICIAL_COMMUNITIES = Array.from(new Map(
  GONGSHU_COMMUNITIES.concat(Object.keys(communityCoordinates || {}))
    .map((name) => [normalizeCommunityKey(name), String(name || '').trim()])
).values())

function productionListing(name, index) {
  return {
    id: `OFFICIAL-COMMUNITY-${String(index + 1).padStart(3, '0')}`,
    uploaderId: 'OFFICIAL-UPLOADER',
    title: `${name}公开房源`,
    shortTitle: name,
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '官方小区测试板块',
    community: name,
    communityName: name,
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: `杭州拱墅区${name}1栋1单元101室`,
    landlordPhone: '13900000001',
    rent: 3000 + index,
    rentMode: '整租',
    type: '整租',
    layout: '一室一厅',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '普通上传',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '已通过',
    requiresManualReview: true,
    communityMatched: true,
    communityMatchStatus: '已匹配',
    videoKey: `house-videos/synthetic/official-community-${index + 1}.mp4`,
    lastVerifiedAt: new Date().toISOString()
  }
}

function assertProductionOfficialCommunities() {
  const listings = OFFICIAL_COMMUNITIES.map(productionListing)
  const db = {
    listings,
    users: [{ id: 'OFFICIAL-UPLOADER', name: '官方小区测试账号', status: '正常', authed: '已实名' }],
    favorites: listings.map((listing, index) => ({
      id: `OFFICIAL-FAVORITE-${index + 1}`,
      userId: 'OFFICIAL-UPLOADER',
      listingId: listing.id,
      createdAt: new Date(Date.UTC(2026, 6, 14, 0, index % 60, 0)).toISOString()
    }))
  }
  const rows = domain.filterListings(db, { publicGuest: true })
  assert.strictEqual(rows.length, OFFICIAL_COMMUNITIES.length, '生产游客列表必须完整返回官方小区样本')
  listings.forEach((listing) => {
    const row = rows.find((item) => item.id === listing.id)
    assert.ok(row, `生产游客列表缺少官方小区 ${listing.community}`)
    assert.strictEqual(row.community, listing.community, `生产公共投影不得改写官方小区 ${listing.community}`)
  })
  listings.forEach((listing) => {
    const matchingIds = domain.filterListings(db, { publicGuest: true, community: listing.community })
      .map((item) => item.id)
    assert.deepStrictEqual(matchingIds, [listing.id], `生产官方小区筛选必须精确互斥：${listing.community}`)
  })
  const target = listings.find((item) => item.community === '城发天地')
  const longer = listings.find((item) => item.community === '城发天地大厦')
  assert.ok(target && longer, '官方小区前缀碰撞样本必须存在')
  ;[target, longer].forEach((listing, index) => {
    listing.mapLatitude = 30.31 + index * 0.001
    listing.mapLongitude = 120.18 + index * 0.001
    listing.coordinateSource = 'admin-verified-coordinate'
    listing.coordinateVerified = true
  })
  assert.deepStrictEqual(
    domain.favoriteListings(db, 'OFFICIAL-UPLOADER', { community: target.community }).map((item) => item.id),
    [target.id],
    '生产收藏页按官方小区筛选必须精确互斥'
  )
  assert.deepStrictEqual(
    Array.from(new Set(domain.mapPins(db, { community: target.community }).flatMap((item) => item.activeListingIds || []))),
    [target.id],
    '生产地图按官方小区筛选必须精确互斥'
  )
  assert.deepStrictEqual(
    (domain.matchListings(db, { publicGuest: true, area: target.community }).listings || []).map((item) => item.id),
    [target.id],
    '生产简易匹配把官方小区放在 area 槽时也必须精确互斥'
  )
  const assistantCandidates = matchService._internal.candidateListings(db)
  const assistantNeed = { hardConstraints: { community: target.community }, preferences: {} }
  assert.strictEqual(
    matchService._internal.evaluateListing(assistantCandidates.find((item) => item.id === target.id), assistantNeed).exact,
    true,
    '找房助手必须把完整官方小区判为精确命中'
  )
  assert.strictEqual(
    matchService._internal.evaluateListing(assistantCandidates.find((item) => item.id === longer.id), assistantNeed).exact,
    false,
    '找房助手不得把官方小区前缀房源判为精确命中'
  )
  assert.ok(domain.filterListings(db, { publicGuest: true, community: '天地' }).length >= 2, '库外自由文本仍须保留模糊搜索')
}

function assertMockOfficialCommunities() {
  mockData.loginByPhone('13800010005')
  const added = OFFICIAL_COMMUNITIES.map((name, index) => mockData.addNormalListing({
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: 'Mock官方小区测试板块',
    community: name,
    communityName: name,
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: `杭州拱墅区${name}1栋1单元101室`,
    landlordPhone: '13900000001',
    contact: '13900000001',
    rent: 3300 + index,
    rentMode: '整租',
    type: '整租',
    layout: '一室一厅',
    features: ['无'],
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '普通上传',
    videoUrl: `https://example.invalid/synthetic/official-community-${index + 1}.mp4`,
    videoKey: `house-videos/synthetic/official-community-${index + 1}.mp4`
  }))
  const addedIds = new Set(added.map((item) => item.id))
  const rows = mockData.getListings({ publicGuest: true }).filter((item) => addedIds.has(item.id))
  assert.strictEqual(rows.length, OFFICIAL_COMMUNITIES.length, 'Mock 游客列表必须完整返回官方小区样本')
  added.forEach((listing, index) => {
    const expected = OFFICIAL_COMMUNITIES[index]
    const row = rows.find((item) => item.id === listing.id)
    assert.strictEqual(row && row.community, expected, `Mock 公共投影不得改写官方小区 ${expected}`)
    const matchingAddedIds = mockData.getListings({ publicGuest: true, community: expected })
      .filter((item) => addedIds.has(item.id))
      .map((item) => item.id)
    assert.deepStrictEqual(matchingAddedIds, [listing.id], `Mock 官方小区筛选必须精确互斥：${expected}`)
  })
  const targetIndex = OFFICIAL_COMMUNITIES.indexOf('城发天地')
  const longerIndex = OFFICIAL_COMMUNITIES.indexOf('城发天地大厦')
  assert.ok(targetIndex >= 0 && longerIndex >= 0, 'Mock 官方小区前缀碰撞样本必须存在')
  mockData.setFavorite(added[targetIndex].id, true)
  mockData.setFavorite(added[longerIndex].id, true)
  const favoriteAddedIds = mockData.getFavorites({ community: '城发天地' })
    .filter((item) => addedIds.has(item.id))
    .map((item) => item.id)
  assert.deepStrictEqual(favoriteAddedIds, [added[targetIndex].id], 'Mock 收藏页按官方小区筛选必须精确互斥')
  assert.deepStrictEqual(
    mockData.getMapPins({ community: '城发天地' }).filter((item) => addedIds.has(item.id)).map((item) => item.id),
    [added[targetIndex].id],
    'Mock 地图按官方小区筛选必须精确互斥'
  )
  assert.deepStrictEqual(
    (mockData.matchListings({ publicGuest: true, area: '城发天地' }).listings || [])
      .filter((item) => addedIds.has(item.id))
      .map((item) => item.id),
    [added[targetIndex].id],
    'Mock 简易匹配把官方小区放在 area 槽时也必须精确互斥'
  )
  assert.ok(
    mockData.getListings({ publicGuest: true, community: '天地' }).filter((item) => addedIds.has(item.id)).length >= 2,
    'Mock 库外自由文本仍须保留模糊搜索'
  )
}

assert.strictEqual(OFFICIAL_COMMUNITIES.length, 265, '官方小区并集数量变化时必须人工复核本门禁')
assertProductionOfficialCommunities()
assertMockOfficialCommunities()
console.log(`PUBLIC_COMMUNITY_EXACT_FILTER PASS ${OFFICIAL_COMMUNITIES.length}/${OFFICIAL_COMMUNITIES.length}`)
