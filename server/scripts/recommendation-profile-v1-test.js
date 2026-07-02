const assert = require('assert')
const domain = require('../src/domain')
const {
  buildRecommendationProfile
} = require('../src/listing-recommendation-profile')

function makeDb() {
  return {
    currentUserId: 'U001',
    users: [
      { id: 'U001', name: '测试中介A', phone: '13800010001', role: '中介', authed: '手机号登录', isAdmin: false },
      { id: 'ADMIN', name: '管理员', phone: '13800010002', role: '管理员', authed: '手机号登录', isAdmin: true }
    ],
    listings: [],
    pointLogs: [],
    footprints: [],
    rentalNeeds: [
      {
        id: 'N001',
        brokerId: 'U001',
        customerName: '客户A',
        customerPhone: '13822223333',
        status: 'active'
      }
    ],
    clientReports: [],
    dealRecords: [],
    commissionRecords: []
  }
}

function listingForm(overrides = {}) {
  return {
    city: '杭州',
    area: '拱墅区',
    community: '长木府',
    building: '9',
    unit: '2',
    roomNumber: '1801',
    contact: '13811112222',
    rent: 3100,
    rentMode: '整租',
    room: '一室',
    hall: '一厅',
    bath: '一卫',
    features: ['近地铁', '电梯'],
    videoUrl: 'https://video.example.com/listing.mp4?Signature=secret',
    videoKey: 'listing.mp4',
    ownerType: '二房东房源',
    ...overrides
  }
}

function assertProfileSafe(profile, fragments) {
  const serialized = JSON.stringify(profile)
  fragments.filter(Boolean).forEach((fragment) => {
    assert(!serialized.includes(fragment), `推荐资料包含敏感片段：${fragment}`)
    assert(!String(profile.searchText || '').includes(fragment), `搜索文本包含敏感片段：${fragment}`)
  })
}

function latestListing(db) {
  return db.listings[0]
}

function main() {
  const sensitiveListing = {
    id: 'L-SAFE',
    city: '杭州',
    area: '拱墅区',
    district: '拱墅区',
    block: '东新',
    community: '公开小区',
    address: '杭州市拱墅区公开小区隐私楼栋隐私单元1801室',
    building: '隐私楼栋',
    unit: '隐私单元',
    roomNumber: '1801室',
    landlordPhone: '13811112222',
    wechat: 'wx_secret888',
    idCard: '330106199001011234',
    rent: 3100,
    layout: '整租一室一厅一卫',
    rentMode: '整租',
    room: '一室',
    hall: '一厅',
    bath: '一卫',
    features: ['近地铁', '电梯'],
    videoUrl: 'https://video.example.com/private.mp4?Signature=secret',
    videoKey: 'private.mp4',
    mapLatitude: 30.304535,
    mapLongitude: 120.177467,
    coordinateSource: 'lianjia-bd09-to-gcj02',
    coordinateVerified: true,
    lifecycleStatus: 'active',
    status: '在租',
    reviewStatus: '无需审核',
    lastVerifiedAt: new Date().toLocaleString('zh-CN', { hour12: false })
  }
  const directProfile = buildRecommendationProfile(sensitiveListing)
  assert.strictEqual(directProfile.ready, true, '直接生成的推荐资料应 ready')
  assertProfileSafe(directProfile, [
    sensitiveListing.address,
    sensitiveListing.building,
    sensitiveListing.unit,
    sensitiveListing.roomNumber,
    sensitiveListing.landlordPhone,
    sensitiveListing.wechat,
    sensitiveListing.idCard,
    'Signature=secret'
  ])

  const db = makeDb()
  domain.addNormalListing(db, 'U001', listingForm(), { skipPointLog: true })
  const normal = latestListing(db)
  assert.strictEqual(normal.recommendationProfile.ready, true, '无需审核且前台有效的房源应生成 ready=true')
  assert.strictEqual(normal.recommendationProfile.listingId, normal.id, '推荐资料 listingId 应回写房源ID')
  assert(normal.recommendationProfile.searchText.includes('长木府'), '搜索文本应包含公开小区')
  assertProfileSafe(normal.recommendationProfile, [
    normal.address,
    normal.landlordPhone,
    'Signature=secret'
  ])

  domain.addNormalListing(db, 'U001', listingForm({
    roomNumber: '1802',
    contact: '13811112223',
    ownerType: '业主房源',
    videoKey: 'owner-approve.mp4'
  }), { skipPointLog: true })
  const ownerApprove = latestListing(db)
  assert.strictEqual(ownerApprove.recommendationProfile.ready, false, '待审核房源应 ready=false')
  assert.strictEqual(ownerApprove.recommendationProfile.unavailableReason, 'pending_review', '待审核原因应为 pending_review')
  domain.reviewOwnerListing(db, 'ADMIN', ownerApprove.id, { action: 'approve' })
  assert.strictEqual(ownerApprove.recommendationProfile.ready, true, '审核通过后应刷新推荐资料')
  assert.strictEqual(ownerApprove.recommendationProfile.coordinateQuality, 'community_verified', '审核通过后应应用小区坐标')

  domain.addNormalListing(db, 'U001', listingForm({
    roomNumber: '1803',
    contact: '13811112224',
    ownerType: '业主房源',
    videoKey: 'owner-reject.mp4'
  }), { skipPointLog: true })
  const ownerReject = latestListing(db)
  domain.reviewOwnerListing(db, 'ADMIN', ownerReject.id, { action: 'reject' })
  assert.strictEqual(ownerReject.recommendationProfile.ready, false, '审核驳回后应 ready=false')
  assert.strictEqual(ownerReject.recommendationProfile.unavailableReason, 'review_rejected', '审核驳回原因应为 review_rejected')

  domain.updateNormalListing(db, 'U001', normal.id, { requiresManualReview: true })
  assert.strictEqual(normal.recommendationProfile.ready, false, '编辑后重新待审核应 ready=false')
  assert.strictEqual(normal.recommendationProfile.unavailableReason, 'pending_review', '编辑待审原因应为 pending_review')
  domain.updateNormalListing(db, 'ADMIN', normal.id, { requiresManualReview: false }, { admin: true })
  assert.strictEqual(normal.recommendationProfile.ready, true, '编辑后恢复前台展示应刷新 ready=true')

  const reportResult = domain.createClientReport(db, 'U001', normal.id, {
    needId: 'N001',
    customerName: '客户A',
    customerPhone: '13822223333'
  })
  domain.createDealFromReport(db, 'U001', reportResult.report.id, {
    dealMonthlyRent: 3100,
    landlordCommission: 3100
  })
  assert.strictEqual(normal.recommendationProfile.ready, false, '提交签单后推荐资料应下线')
  assert.strictEqual(normal.recommendationProfile.unavailableReason, 'deal_pending', '提交签单原因应为 deal_pending')

  const deal = db.dealRecords[0]
  domain.confirmDeal(db, 'ADMIN', deal.id)
  assert.strictEqual(normal.recommendationProfile.ready, false, '确认成交后推荐资料仍应下线')
  assert.strictEqual(normal.recommendationProfile.unavailableReason, 'sold', '确认成交原因应为 sold')

  ownerApprove.lastVerifiedAt = '2026-01-01 00:00:00'
  const expireResult = domain.enforceListingMaintenanceRule(db)
  assert(expireResult.expiredCount >= 1, '应自动过期至少一套超期房源')
  assert.strictEqual(ownerApprove.recommendationProfile.ready, false, '自动过期后推荐资料应下线')
  assert.strictEqual(ownerApprove.recommendationProfile.unavailableReason, 'expired', '自动过期原因应为 expired')

  console.log('recommendation-profile-v1-test passed')
}

main()
