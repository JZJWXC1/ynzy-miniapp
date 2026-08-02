'use strict'

const assert = require('assert')
const domain = require('../src/domain')

function asset(id, order, sha, options = {}) {
  const kind = options.kind || 'video'
  const extension = options.extension || (kind === 'image' ? 'jpg' : 'mp4')
  const mimeType = options.mimeType || (kind === 'image' ? 'image/jpeg' : 'video/mp4')
  return {
    assetId: id,
    kind,
    objectKey: `house-videos/feishu-note-v1/record/${id}.${extension}`,
    contentSha256: sha.repeat(64),
    sourceFingerprint: String(order + 1).repeat(64),
    targetDriveFingerprint: String(order + 3).repeat(64),
    displayOrder: order,
    mimeType,
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
    missingVideoMaterial: true,
    videoMaterialStatus: '缺视频素材',
    syncStatus: '缺视频素材',
    videoMaterialFailureReason: 'synthetic-old-failure',
    videoKey: 'house-videos/legacy/old.mp4',
    videoUrl: 'https://example.invalid/legacy.mp4'
  }]
}

const incoming = [
  asset('MAT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, 'a', { kind: 'image' }),
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
  // 公开详情受真实 7 天维护窗口约束；夹具必须相对当前测试时钟保持新鲜，不能把某个
  // 日历日期永久写死后随时间自然过期，造成与媒体持久化无关的假红。
  updatedAt: new Date(Date.now() - 60 * 1000).toISOString()
})
assert.strictEqual(result.mediaAssetCount, 2)
assert.strictEqual(db.listings[0].videoKey, incoming[1].objectKey, '旧单视频索引必须只指向首个视频，不能把排在前面的图片伪装成视频')
assert.strictEqual(db.listings[0].videoUrl, '', '新清单落库后不得保留绕过代理的旧直链')
assert.deepStrictEqual(db.listings[0].mediaAssets, incoming, '私有清单必须完整持久化已校验摘要和对象键')
assert.strictEqual(db.listings[0].missingVideoMaterial, false, '已验证视频落库后必须清除旧缺视频标记')
assert.strictEqual(db.listings[0].videoMaterialStatus, '已匹配视频素材')
assert.strictEqual(db.listings[0].syncStatus, '已同步飞书')
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(db.listings[0], 'videoMaterialFailureReason'),
  false,
  '已验证素材必须清除上一轮搬运失败原因'
)

const detail = domain.listingDetail(db, 'L-MEDIA-PERSIST')
assert.strictEqual(detail.mediaAssets.length, 2)
assert.deepStrictEqual(detail.mediaAssets.map((item) => item.kind), ['image', 'video'], '公共安全骨架必须保留图片/视频类型')
assert.strictEqual(detail.hasVideo, true, '混合清单中存在视频时仍必须识别为有视频')
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
  () => domain.normalizePrivateListingMediaAssets([
    asset('MAT-cccccccccccccccccccccccccccccccc', 0, 'c', {
      kind: 'image',
      extension: 'jpg',
      mimeType: 'image/png'
    })
  ]),
  /类型|对象键|扩展名/,
  '图片 MIME 与对象扩展名不一致时必须 fail-closed'
)
;[
  ['jpg', 'image/jpeg', 'e'],
  ['jpeg', 'image/jpeg', 'f'],
  ['png', 'image/png', 'a'],
  ['webp', 'image/webp', 'b'],
  ['gif', 'image/gif', 'c']
].forEach(([extension, mimeType, sha], index) => {
  const normalized = domain.normalizePrivateListingMediaAssets([
    asset(`MAT-IMAGE-${String(index).padStart(28, '0')}`, 0, sha, {
      kind: 'image',
      extension,
      mimeType
    })
  ])
  assert.strictEqual(normalized[0].kind, 'image', `受支持图片 ${extension} 必须保留图片类型`)
  assert.strictEqual(normalized[0].mimeType, mimeType, `受支持图片 ${extension} 必须保留规范 MIME`)
})
assert.throws(
  () => domain.normalizePrivateListingMediaAssets([
    asset('MAT-svgsvgsvgsvgsvgsvgsvgsvgsvgsvgsv', 0, 'd', {
      kind: 'image',
      extension: 'svg',
      mimeType: 'image/svg+xml'
    })
  ]),
  /图片类型|扩展名/,
  '可执行或超出白名单的图片类型必须 fail-closed'
)
const imageOnly = {
  ...db.listings[0],
  mediaAssets: [asset('MAT-dddddddddddddddddddddddddddddddd', 0, 'd', { kind: 'image' })],
  videoKey: ''
}
assert.strictEqual(domain.hasListingVideo(imageOnly), false, '只有图片的清单不得被 hasListingVideo 误判为视频')
domain.replaceListingMediaAssets(db, 'L-MEDIA-PERSIST', imageOnly.mediaAssets)
assert.strictEqual(db.listings[0].videoKey, '', '纯图片清单不得把图片对象键写进旧单视频索引')
assert.strictEqual(db.listings[0].missingVideoMaterial, true, '纯图片清单必须恢复缺视频标记')
assert.strictEqual(db.listings[0].videoMaterialStatus, '缺视频素材')
assert.strictEqual(db.listings[0].syncStatus, '缺视频素材')
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
assert.strictEqual(db.listings[0].missingVideoMaterial, true, '显式清空素材后必须恢复缺视频标记')
assert.strictEqual(domain.listingDetail(db, 'L-MEDIA-PERSIST').hasVideo, false)

console.log('listing-media-persistence-v1-test: PASS')
