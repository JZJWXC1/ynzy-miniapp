'use strict'

const assert = require('assert')
const domain = require('../src/domain')

function asset(id, order, sha) {
  return {
    assetId: id,
    kind: 'video',
    objectKey: `house-videos/feishu-note-v1/record/${id}.mp4`,
    contentSha256: sha.repeat(64),
    sourceFingerprint: String(order + 1).repeat(64),
    targetDriveFingerprint: String(order + 3).repeat(64),
    displayOrder: order,
    mimeType: 'video/mp4',
    size: 1024 + order,
    verified: true
  }
}

const db = {
  users: [],
  listings: [{
    id: 'L-MEDIA-PERSIST',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '祥符',
    community: '合成小区',
    rent: 3000,
    layout: '2室1厅',
    room: '两室',
    rentMode: '整租',
    type: '整租',
    source: '公司房源',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    communityMatched: true,
    videoKey: 'house-videos/legacy/old.mp4',
    videoUrl: 'https://example.invalid/legacy.mp4'
  }]
}

const incoming = [
  asset('MAT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, 'a'),
  asset('MAT-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 'b')
]

const emptyCasDb = {
  users: [],
  listings: [{ ...db.listings[0], id: 'L-MEDIA-EMPTY-CAS' }]
}
const emptyStateKey = domain.listingMediaAssetsStateKey(emptyCasDb.listings[0])
assert.strictEqual(emptyStateKey, '', '从未建立素材清单的房源状态键应为空')
domain.replaceListingMediaAssets(emptyCasDb, 'L-MEDIA-EMPTY-CAS', [incoming[0]])
assert.throws(
  () => domain.replaceListingMediaAssets(emptyCasDb, 'L-MEDIA-EMPTY-CAS', [], {
    expectedStateKey: emptyStateKey
  }),
  /最新状态重试/,
  '空基线同样必须参与 CAS，不能覆盖另一任务刚建立的第一套素材'
)

const result = domain.replaceListingMediaAssets(db, 'L-MEDIA-PERSIST', incoming, {
  updatedAt: '2026-07-26 03:00:00'
})
assert.strictEqual(result.mediaAssetCount, 2)
assert.strictEqual(db.listings[0].videoKey, incoming[0].objectKey, '旧单视频索引必须指向第一项，兼容已有管理链路')
assert.strictEqual(db.listings[0].videoUrl, '', '新清单落库后不得保留绕过代理的旧直链')
assert.deepStrictEqual(db.listings[0].mediaAssets, incoming, '私有清单必须完整持久化已校验摘要和对象键')

const detail = domain.listingDetail(db, 'L-MEDIA-PERSIST')
assert.strictEqual(detail.mediaAssets.length, 2)
assert.ok(!JSON.stringify(detail).includes('objectKey'), '公共详情不得泄露对象键')
assert.ok(!JSON.stringify(detail).includes('contentSha256'), '公共详情不得泄露内容摘要')
assert.ok(!JSON.stringify(detail).includes('sourceFingerprint'), '公共详情不得泄露来源摘要')

assert.throws(
  () => domain.replaceListingMediaAssets(db, 'L-MEDIA-PERSIST', [{ ...incoming[0], verified: false }]),
  /尚未通过写后回读/,
  '未完成 Drive/OSS 写后回读的素材不得落库'
)
assert.strictEqual(db.listings[0].mediaAssets.length, 2, '非法替换必须保持原清单不变')
assert.throws(
  () => domain.replaceListingMediaAssets(db, 'L-MEDIA-PERSIST', incoming, { expectedStateKey: 'stale-state' }),
  /最新状态重试/,
  '并发同步必须用状态键阻断陈旧覆盖'
)
const persistedStateKey = domain.listingMediaAssetsStateKey(db.listings[0])
assert.notStrictEqual(
  domain.listingMediaAssetsStateKey({
    ...db.listings[0],
    mediaAssets: db.listings[0].mediaAssets.map((item, index) => (
      index === 0 ? { ...item, sourceFingerprint: 'f'.repeat(64) } : item
    ))
  }),
  persistedStateKey,
  '并发状态键必须绑定来源验证摘要，不能让旧同步静默覆盖新来源版本'
)
assert.notStrictEqual(
  domain.listingMediaAssetsStateKey({
    ...db.listings[0],
    mediaAssets: db.listings[0].mediaAssets.map((item, index) => (
      index === 0 ? { ...item, targetDriveFingerprint: 'e'.repeat(64) } : item
    ))
  }),
  persistedStateKey,
  '并发状态键必须绑定飞书目标回读摘要'
)

domain.replaceListingMediaAssets(db, 'L-MEDIA-PERSIST', [])
assert.deepStrictEqual(db.listings[0].mediaAssets, [], '显式空清单必须真正清空素材')
assert.strictEqual(db.listings[0].videoKey, '', '显式清空不得继续暴露旧单视频')
assert.strictEqual(domain.listingDetail(db, 'L-MEDIA-PERSIST').hasVideo, false)

console.log('listing-media-persistence-v1-test: PASS')
