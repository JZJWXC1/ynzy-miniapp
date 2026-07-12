'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const domain = require('../src/domain')

const repoRoot = path.resolve(__dirname, '..', '..')

function makeListing(overrides = {}) {
  return {
    id: 'L1',
    uploaderId: 'U1',
    ownerType: '二房东房源',
    source: '二房东房源',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    communityMatched: true,
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '测试板块',
    community: '测试小区',
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: '仅用于验证不得返回的合成地址',
    landlordPhone: '19900000001',
    viewingPassword: 'synthetic-password',
    rent: 3000,
    rentMode: '整租',
    type: '整租',
    room: '1',
    layout: '整租一室一厅一卫',
    features: ['Loft', '落地窗'],
    videoKey: 'house-videos/synthetic/favorite.mp4',
    landlordCommissionPercent: 50,
    ...overrides
  }
}

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '合成中介甲', role: '中介', authed: '手机号登录' },
      { id: 'U2', name: '合成中介乙', role: '中介', authed: '手机号登录' }
    ],
    listings: [
      makeListing(),
      makeListing({
        id: 'L2',
        uploaderId: 'U2',
        ownerType: '业主房源',
        source: '业主房源',
        reviewStatus: '已通过',
        district: '上城区',
        area: '上城区',
        block: '东站',
        community: '合成花园',
        rent: 4200,
        room: '2',
        layout: '整租两室一厅一卫',
        features: ['落地窗']
      }),
      makeListing({
        id: 'L3',
        source: '公司房源',
        ownerType: '公司房源',
        companyListing: true,
        isCompanyListing: true,
        externalSource: 'feishu-sheet-snapshot',
        videoKey: '',
        district: '余杭区',
        area: '余杭区',
        block: '未来科技城',
        community: '合成公寓',
        rent: 2600,
        lifecycleStatus: 'expired',
        status: '已下架',
        expiredReason: '合成测试：房态超期'
      }),
      makeListing({ id: 'L4', lifecycleStatus: 'sold', status: '已成交' }),
      makeListing({ id: 'L5', source: '业主房源', ownerType: '业主房源', reviewStatus: '待审核', status: '待审核' })
    ],
    favorites: []
  }
}

;['favoriteListing', 'unfavoriteListing', 'favoriteListingIds', 'favoriteListings'].forEach((name) => {
  assert.strictEqual(typeof domain[name], 'function', `领域层必须导出 ${name}`)
})

// 1) 收藏关系只绑定服务端传入的已知账号；重复 PUT 不得产生重复关系。
{
  const db = makeDb()
  const first = domain.favoriteListing(db, 'U1', 'L1')
  const second = domain.favoriteListing(db, 'U1', 'L1')
  assert.strictEqual(first.listingId, 'L1')
  assert.strictEqual(first.favorited, true)
  assert.strictEqual(second.id, first.id, '重复收藏必须返回同一关系')
  assert.strictEqual(db.favorites.length, 1, '重复收藏不得产生重复关系')
  assert.deepStrictEqual(Object.keys(db.favorites[0]).sort(), ['createdAt', 'id', 'listingId', 'userId'], '收藏关系只保存最小四字段')
  assert.ok(Number.isFinite(Date.parse(db.favorites[0].createdAt)), '收藏时间必须由服务端生成可解析 ISO 时间')
  assert.deepStrictEqual(domain.favoriteListingIds(db, 'U1'), ['L1'])
  assert.deepStrictEqual(domain.favoriteListingIds(db, 'U2'), [], '不同账号收藏必须隔离')
  assert.throws(
    () => domain.favoriteListing(db, 'EVIL_CLIENT_USER', 'L2'),
    (error) => error && error.statusCode === 403,
    '客户端伪造的未知身份不得创建收藏'
  )
}

// 1.1) 仅“键不存在”可惰性初始化；已存在的 null/对象/坏关系必须失败并保持原数据不变。
{
  const missingDb = makeDb()
  delete missingDb.favorites
  assert.deepStrictEqual(domain.favoriteListingIds(missingDb, 'U1'), [])
  assert.ok(!Object.prototype.hasOwnProperty.call(missingDb, 'favorites'), '纯读取不得偷偷初始化收藏键')
  domain.favoriteListing(missingDb, 'U1', 'L1')
  assert.ok(Array.isArray(missingDb.favorites), '首次写入可为旧库初始化收藏数组')

  ;[null, {}, 'bad-structure', [{ userId: 'U1', listingId: 'L1', createdAt: '2026-07-10T10:00:00.000Z' }]].forEach((invalid) => {
    const db = makeDb()
    db.favorites = invalid
    const before = JSON.stringify(db)
    assert.throws(
      () => domain.favoriteListing(db, 'U1', 'L1'),
      (error) => error && error.statusCode === 500,
      '已存在的非法收藏结构必须失败'
    )
    assert.strictEqual(JSON.stringify(db), before, '非法收藏结构失败后不得被覆盖或部分改写')
  })
}

// 2) 新增收藏只接受当前可在前台使用的房源；既有收藏失效后仍保留且重复 PUT 继续幂等。
{
  const db = makeDb()
  assert.throws(
    () => domain.favoriteListing(db, 'U1', 'L3'),
    (error) => error && error.statusCode === 410,
    '不得新收藏已下架房源'
  )
  assert.throws(
    () => domain.favoriteListing(db, 'U1', 'L4'),
    (error) => error && error.statusCode === 410,
    '不得新收藏已成交房源'
  )
  assert.throws(
    () => domain.favoriteListing(db, 'U1', 'L5'),
    (error) => error && error.statusCode === 404,
    '不得新收藏待审核房源'
  )
  assert.throws(
    () => domain.favoriteListing(db, 'U1', 'NOT_FOUND'),
    (error) => error && error.statusCode === 404,
    '不得收藏不存在房源'
  )

  db.listings[0].lifecycleStatus = 'expired'
  db.listings[0].status = '已下架'
  db.favorites.push({ id: 'FV-OLD', userId: 'U1', listingId: 'L1', createdAt: '2026-07-10T10:00:00.000Z' })
  assert.strictEqual(domain.favoriteListing(db, 'U1', 'L1').id, 'FV-OLD', '失效后的重试仍应命中既有关系')
}

// 2.1) 不同收藏关系的数据库 id 必须自身唯一；即使旧的时间/随机源碰撞，也不能破坏按 id 增量合并。
{
  const db = makeDb()
  const originalNow = Date.now
  const originalRandom = Math.random
  const crypto = require('crypto')
  const originalRandomUuid = crypto.randomUUID
  try {
    Date.now = () => 1700000000000
    Math.random = () => 0
    crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000'
    const first = domain.favoriteListing(db, 'U1', 'L1')
    const second = domain.favoriteListing(db, 'U1', 'L2')
    assert.notStrictEqual(first.id, second.id, '不同收藏关系不得因时间/随机源碰撞而共用数据库 id')
    assert.ok(second.id.endsWith('-1'), 'UUID 碰撞时必须追加确定性安全后缀')
    assert.strictEqual(new Set(db.favorites.map((item) => item.id)).size, 2)
  } finally {
    Date.now = originalNow
    Math.random = originalRandom
    crypto.randomUUID = originalRandomUuid
  }
}

// 2.2) 领域层也要拒绝已停用/软删账号，防止路由初验后、数据库锁内写入前发生撤权竞态。
{
  const disabledDb = makeDb()
  disabledDb.users[0].status = '禁用'
  assert.throws(
    () => domain.favoriteListing(disabledDb, 'U1', 'L1'),
    (error) => error && error.statusCode === 403,
    '停用账号不得新增收藏'
  )
  assert.strictEqual(disabledDb.favorites.length, 0)

  const deletedDb = makeDb()
  deletedDb.users[0].deleted = true
  assert.throws(
    () => domain.unfavoriteListing(deletedDb, 'U1', 'L1'),
    (error) => error && error.statusCode === 403,
    '软删账号不得继续写收藏关系'
  )
}

// 3) 取消收藏幂等，且清除存量重复脏关系；不存在/已删除房源也能取消。
{
  const db = makeDb()
  db.favorites = [
    { id: 'FV1', userId: 'U1', listingId: 'L1', createdAt: '2026-07-10T10:00:00.000Z' },
    { id: 'FV2', userId: 'U1', listingId: 'L1', createdAt: '2026-07-10T10:00:01.000Z' },
    { id: 'FV3', userId: 'U1', listingId: 'DELETED', createdAt: '2026-07-10T10:00:02.000Z' },
    { id: 'FV4', userId: 'U2', listingId: 'L1', createdAt: '2026-07-10T10:00:03.000Z' }
  ]
  assert.strictEqual(domain.unfavoriteListing(db, 'U1', 'L1').favorited, false)
  assert.strictEqual(db.favorites.filter((item) => item.userId === 'U1' && item.listingId === 'L1').length, 0)
  assert.strictEqual(db.favorites.filter((item) => item.userId === 'U2' && item.listingId === 'L1').length, 1, '不得删除其他账号关系')
  assert.strictEqual(domain.unfavoriteListing(db, 'U1', 'L1').favorited, false, '重复取消必须成功')
  assert.strictEqual(domain.unfavoriteListing(db, 'U1', 'DELETED').favorited, false, '房源已删除仍必须可取消')
}

// 4) 我的收藏由关系反查原始房源：失效/删除项保留灰态，输出不得带电话、地址、密码或上传人身份。
{
  const db = makeDb()
  db.favorites = [
    { id: 'FV1', userId: 'U1', listingId: 'L1', createdAt: '2026-07-10T10:00:00.000Z' },
    { id: 'FV2', userId: 'U1', listingId: 'L3', createdAt: '2026-07-10T11:00:00.000Z' },
    { id: 'FV3', userId: 'U1', listingId: 'DELETED', createdAt: '2026-07-10T12:00:00.000Z' }
  ]
  const rows = domain.favoriteListings(db, 'U1')
  assert.deepStrictEqual(rows.map((item) => item.id), ['DELETED', 'L3', 'L1'], '收藏按收藏时间倒序')
  assert.strictEqual(rows[0].isAvailable, false)
  assert.strictEqual(rows[0].unavailableReason, '房源不存在或已删除')
  assert.strictEqual(rows[1].isAvailable, false)
  assert.ok(rows[1].unavailableReason, '下架房源必须给出不可用原因')
  assert.strictEqual(rows[2].isAvailable, true)
  rows.forEach((row) => {
    ;['address', 'landlordPhone', 'contact', 'viewingPassword', 'showingPassword', 'uploaderId', 'uploader'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(row, field), `收藏输出不得包含 ${field}`)
    })
  })
  const text = JSON.stringify(rows)
  assert.ok(!text.includes('19900000001'), '收藏输出不得包含合成电话')
  assert.ok(!text.includes('synthetic-password'), '收藏输出不得包含看房密码')
  assert.ok(!text.includes('仅用于验证不得返回的合成地址'), '收藏输出不得包含详细地址')
}

// 4.1) 过期、成交、待审核、缺视频和硬删除的既有收藏都保留灰态、安全脱敏且可取消。
{
  const db = makeDb()
  db.listings[2] = makeListing({
    id: 'L3', lifecycleStatus: 'expired', status: '已下架', expiredReason: 'SENTINEL_EXPIRED_REASON',
    address: 'SENTINEL_ADDRESS_EXPIRED', landlordPhone: '19900000011', viewingPassword: 'SENTINEL_PASSWORD_EXPIRED',
    viewingKeyLocation: 'SENTINEL_KEY_EXPIRED', building: 'SENTINEL_BUILDING_EXPIRED', unit: 'SENTINEL_UNIT_EXPIRED', roomNumber: 'SENTINEL_ROOM_EXPIRED',
    remark: 'SENTINEL_REMARK_EXPIRED'
  })
  db.listings[3] = makeListing({
    id: 'L4', lifecycleStatus: 'sold', status: '已成交', address: 'SENTINEL_ADDRESS_SOLD', landlordPhone: '19900000012',
    viewingPassword: 'SENTINEL_PASSWORD_SOLD', viewingKeyLocation: 'SENTINEL_KEY_SOLD'
  })
  db.listings[4] = makeListing({
    id: 'L5', source: '业主房源', ownerType: '业主房源', reviewStatus: '待审核', status: '待审核',
    address: 'SENTINEL_ADDRESS_PENDING', landlordPhone: '19900000013', viewingPassword: 'SENTINEL_PASSWORD_PENDING'
  })
  db.listings.push(makeListing({
    id: 'L6', videoKey: '', videoUrl: '', address: 'SENTINEL_ADDRESS_NOVIDEO', landlordPhone: '19900000014',
    viewingPassword: 'SENTINEL_PASSWORD_NOVIDEO', viewingKeyLocation: 'SENTINEL_KEY_NOVIDEO'
  }))
  db.favorites = ['L3', 'L4', 'L5', 'L6', 'DELETED'].map((listingId, index) => ({
    id: `FV-${index}`,
    userId: 'U1',
    listingId,
    createdAt: `2026-07-10T1${index}:00:00.000Z`
  }))
  const rows = domain.favoriteListings(db, 'U1')
  assert.deepStrictEqual(new Set(rows.map((item) => item.id)), new Set(['L3', 'L4', 'L5', 'L6', 'DELETED']))
  rows.forEach((row) => {
    assert.strictEqual(row.isAvailable, false, `${row.id} 必须灰态保留`)
    assert.strictEqual(row.hasVideo, false, `${row.id} 不可下发视频能力`)
    assert.strictEqual(row.coverUrl, '', `${row.id} 不可下发封面签名`)
    ;['address', 'landlordPhone', 'contact', 'building', 'unit', 'roomNumber', 'roomAddress', 'viewingPassword', 'showingPassword', 'viewingKeyLocation', 'remark', 'note', 'uploaderId', 'uploader'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(row, field), `${row.id} 不得包含 ${field}`)
    })
  })
  const serialized = JSON.stringify(rows)
  ;['SENTINEL_ADDRESS_', 'SENTINEL_PASSWORD_', 'SENTINEL_KEY_', 'SENTINEL_BUILDING_', 'SENTINEL_UNIT_', 'SENTINEL_ROOM_', 'SENTINEL_REMARK_', 'SENTINEL_EXPIRED_', '1990000001'].forEach((sentinel) => {
    assert.ok(!serialized.includes(sentinel), `不可用收藏 DTO 不得包含哨兵 ${sentinel}`)
  })
  ;['L3', 'L4', 'L5', 'L6', 'DELETED'].forEach((listingId) => {
    assert.strictEqual(domain.unfavoriteListing(db, 'U1', listingId).isFavorited, false)
  })
  assert.deepStrictEqual(domain.favoriteListingIds(db, 'U1'), [], '全部不可用收藏都必须可取消')
}

// 5) 区域、板块、小区、户型、租赁方式、租金、特点、可用状态和来源全部由服务端筛选。
{
  const db = makeDb()
  db.favorites = [
    { id: 'FV1', userId: 'U1', listingId: 'L1', createdAt: '2026-07-10T10:00:00.000Z' },
    { id: 'FV2', userId: 'U1', listingId: 'L2', createdAt: '2026-07-10T11:00:00.000Z' },
    { id: 'FV3', userId: 'U1', listingId: 'L3', createdAt: '2026-07-10T12:00:00.000Z' }
  ]
  const only = (filter) => domain.favoriteListings(db, 'U1', filter).map((item) => item.id)
  assert.deepStrictEqual(only({ district: '上城区' }), ['L2'])
  assert.deepStrictEqual(only({ block: '东站' }), ['L2'])
  assert.deepStrictEqual(only({ community: '合成花园' }), ['L2'])
  assert.deepStrictEqual(only({ layout: '两室' }), ['L2'])
  assert.deepStrictEqual(only({ rentMode: '整租' }), ['L3', 'L2', 'L1'])
  assert.deepStrictEqual(only({ rentMin: 4000, rentMax: 4500 }), ['L2'])
  assert.deepStrictEqual(only({ features: 'Loft,落地窗' }), ['L3', 'L1'])
  assert.deepStrictEqual(only({ availability: 'available' }), ['L2', 'L1'])
  assert.deepStrictEqual(only({ availability: 'unavailable' }), ['L3'])
  assert.deepStrictEqual(only({ category: '公司房源' }), ['L3'])
  assert.deepStrictEqual(only({ category: '业主房源' }), ['L2'])
  assert.deepStrictEqual(only({ category: '二房东房源' }), ['L1'])
}

// 5.1) 板块、小区、区域必须各自匹配对应字段，不能因其他地名字段含同词而误收。
{
  const db = makeDb()
  db.listings.push(makeListing({ id: 'L6', block: '城东', community: '东站花园' }))
  db.favorites = [
    { id: 'FV1', userId: 'U1', listingId: 'L2', createdAt: '2026-07-10T10:00:00.000Z' },
    { id: 'FV2', userId: 'U1', listingId: 'L6', createdAt: '2026-07-10T11:00:00.000Z' }
  ]
  assert.deepStrictEqual(
    domain.favoriteListings(db, 'U1', { block: '东站' }).map((item) => item.id),
    ['L2'],
    '板块筛选不得把小区名含“东站”的其他板块误收'
  )
}

// 6) 路由身份必须来自 token；收藏 PUT/DELETE 不解析或信任客户端身份正文。
{
  const source = fs.readFileSync(path.join(repoRoot, 'server/src/index.js'), 'utf8')
  assert.ok(source.includes("pathname === '/mini/favorites'"), '必须提供我的收藏读取路由')
  assert.ok(source.includes("pathname === '/mini/favorites/ids'"), '必须提供星标状态读取路由')
  const matchAt = source.indexOf("pathname.match(/^\\/mini\\/favorites\\/([^/]+)$/)")
  assert.ok(matchAt >= 0, '必须提供收藏项 PUT/DELETE 路由')
  const nextRouteAt = source.indexOf("if (method === 'GET' && pathname === '/mini/footprints')", matchAt)
  const routeBlock = source.slice(matchAt, nextRouteAt)
  assert.ok(routeBlock.includes('assertMiniLogin(userId)'), '收藏写路由必须要求已验签账号')
  assert.ok((routeBlock.match(/miniUserIdFromRequest\(req, nextDb\)/g) || []).length >= 2, '收藏 PUT/DELETE 必须在数据库写锁内基于最新账号状态重新验签')
  assert.ok(routeBlock.includes('domain.favoriteListing(nextDb, freshUserId'), '收藏写入必须使用锁内重新验签的 userId')
  assert.ok(routeBlock.includes('domain.unfavoriteListing(nextDb, freshUserId'), '取消收藏必须使用锁内重新验签的 userId')
  assert.ok(!/parseBody\s*\(/.test(routeBlock), '收藏写路由不得解析客户端身份正文')
}

console.log('favorite-domain-v1-test passed')
