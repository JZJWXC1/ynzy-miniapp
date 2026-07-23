const assert = require('assert')

const {
  buildCompanySheetSnapshot,
  publishCompanySnapshot
} = require('../src/feishu-source-mirror')
const feishuSync = require('../src/feishu-sync')

const HEADERS = [
  '行政区',
  '板块/商圈',
  '小区',
  '小区+房号',
  '户型描述',
  '户型分类',
  '月租金',
  '看房方式',
  '备注',
  '房源状态'
]

function canonicalRecord(overrides = {}) {
  return {
    enabled: true,
    published: true,
    canonical: true,
    district: '拱墅区',
    block: '城北万象城',
    community: '瑷颐湾',
    roomLabel: '瑷颐湾 8幢1单元802',
    layoutDescription: '两室一厅整租',
    layoutCategory: '两室',
    monthlyRent: 4200,
    viewingMethod: '预约看房',
    remark: '近地铁',
    listingStatus: '在租',
    ...overrides
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function main() {
  const safeA = canonicalRecord({
    sourceRecordId: 'rec_private_source_a',
    sourceTableId: 'tbl_private_source',
    landlordPhone: '18700001111',
    contactName: 'PRIVATE_CONTACT_A',
    internalBottomPrice: 'PRIVATE_BOTTOM_PRICE_A',
    viewingPassword: 'PRIVATE_PASSWORD_A',
    materialToken: 'PRIVATE_MATERIAL_TOKEN_A',
    materialUrl: 'https://private.invalid/material-a',
    futureMysteryField: 'PRIVATE_FUTURE_VALUE_A'
  })
  const safeB = canonicalRecord({
    district: '上城区',
    block: '闸弄口',
    community: '皋塘运郡',
    roomLabel: '皋塘运郡 1幢1单元701',
    layoutDescription: '一室一厅整租',
    layoutCategory: '一室',
    monthlyRent: 3500,
    viewingMethod: '提前联系',
    remark: '采光好',
    listingStatus: '在租',
    sourceRecordId: 'rec_private_source_b'
  })

  const blockedRows = [
    canonicalRecord({ enabled: false, roomLabel: 'DISABLED_ROW_SENTINEL' }),
    canonicalRecord({ published: false, roomLabel: 'UNPUBLISHED_ROW_SENTINEL' }),
    canonicalRecord({ canonical: false, roomLabel: 'NON_CANONICAL_ROW_SENTINEL' })
  ]

  const first = buildCompanySheetSnapshot([safeA, ...blockedRows, safeB], {})
  const second = buildCompanySheetSnapshot([safeB, ...blockedRows.slice().reverse(), safeA], {})

  assert.strictEqual(first.title, '寓你住一起房源表', '待租表标题必须固定，不能沿用员工源表标题')
  assert.deepStrictEqual(first.rows[0], HEADERS, '待租表只允许固定的十列公开白名单')
  assert.strictEqual(first.rows.length, 3, '只能输出 enabled=true 且已发布的 canonical 镜像记录')
  assert.deepStrictEqual(second, first, '待租表排序必须与输入顺序无关，重复生成结果必须确定')

  const rowByRoom = new Map(first.rows.slice(1).map((row) => [row[3], row]))
  assert.deepStrictEqual(rowByRoom.get('瑷颐湾 8幢1单元802'), [
    '拱墅区',
    '城北万象城',
    '瑷颐湾',
    '瑷颐湾 8幢1单元802',
    '两室一厅整租',
    '两室',
    4200,
    '预约看房',
    '近地铁',
    '在租'
  ], '待租表必须按 canonical 镜像字段投影，不得回读员工源表的漂移列名')
  assert.deepStrictEqual(rowByRoom.get('皋塘运郡 1幢1单元701'), [
    '上城区',
    '闸弄口',
    '皋塘运郡',
    '皋塘运郡 1幢1单元701',
    '一室一厅整租',
    '一室',
    3500,
    '提前联系',
    '采光好',
    '在租'
  ], '第二条 canonical 镜像也必须完整映射到固定白名单')

  const serialized = JSON.stringify(first)
  ;[
    'sourceRecordId',
    'sourceTableId',
    'landlordPhone',
    'contactName',
    'internalBottomPrice',
    'viewingPassword',
    'materialToken',
    'materialUrl',
    'futureMysteryField',
    'rec_private_source_a',
    'rec_private_source_b',
    'tbl_private_source',
    '18700001111',
    'PRIVATE_CONTACT_A',
    'PRIVATE_BOTTOM_PRICE_A',
    'PRIVATE_PASSWORD_A',
    'PRIVATE_MATERIAL_TOKEN_A',
    'https://private.invalid/material-a',
    'PRIVATE_FUTURE_VALUE_A',
    'DISABLED_ROW_SENTINEL',
    'UNPUBLISHED_ROW_SENTINEL',
    'NON_CANONICAL_ROW_SENTINEL'
  ].forEach((forbidden) => {
    assert.ok(!serialized.includes(forbidden), `待租表键或值不得泄露非白名单内容：${forbidden}`)
  })

  const db = {
    companySheetSnapshot: {
      title: '上一份有效快照',
      rows: [['旧数据']]
    },
    unrelatedState: { keep: true }
  }
  const beforeIncomplete = clone(db)
  await assert.rejects(
    async () => publishCompanySnapshot(db, [safeA], { complete: false })
  )
  assert.deepStrictEqual(db, beforeIncomplete, '本轮不完整时数据库必须保持逐字段不变')

  const beforeEmpty = clone(db)
  await assert.rejects(
    async () => publishCompanySnapshot(db, [], { complete: true })
  )
  assert.deepStrictEqual(db, beforeEmpty, '空记录发布失败后数据库必须保持逐字段不变')

  const explicitlyInactive = canonicalRecord({ published: false, listingStatus: '已租' })
  const emptyPublic = await publishCompanySnapshot(db, [explicitlyInactive], {
    complete: true,
    allowEmptyPublic: true
  })
  assert.deepStrictEqual(emptyPublic.rows, [HEADERS], '完整镜像明确全部下架且已过撤下熔断时，必须发布仅表头快照，不能让旧房源继续公开')

  const published = await publishCompanySnapshot(db, [safeA, safeB], { complete: true })
  assert.deepStrictEqual(db.companySheetSnapshot, buildCompanySheetSnapshot([safeA, safeB], {}), '完整非空数据才能原子替换上一份快照')
  assert.deepStrictEqual(published, db.companySheetSnapshot, '发布函数应返回实际落库的同一份快照内容')
  assert.strictEqual(db.unrelatedState.keep, true, '发布待租表不得改写无关数据库状态')

  const sensitiveInAllowedColumns = canonicalRecord({
    roomLabel: '安全投影测试 1幢1单元101',
    viewingMethod: '门锁密码 12345678',
    remark: '联系 13900001234，微信 test_account_123，素材 https://private.invalid/video.mp4，文件 file://server/private.mp4，飞书 feishu://secret/path，内嵌 data:text/plain,private'
  })
  const rawSensitiveSnapshot = buildCompanySheetSnapshot([sensitiveInAllowedColumns])
  const publicSnapshot = feishuSync.sanitizeSheetSnapshot({
    ...rawSensitiveSnapshot,
    sourceMode: 'feishu-mini-mirror-v1',
    schemaVersion: 1,
    updatedAt: '2026-07-23 16:30:00'
  }, { contactPhones: [] })
  const publicText = JSON.stringify(publicSnapshot)
  ;[
    '12345678',
    '13900001234',
    'test_account_123',
    'https://private.invalid/video.mp4',
    'file://server/private.mp4',
    'feishu://secret/path',
    'data:text/plain,private'
  ].forEach((secret) => {
    assert.ok(!publicText.includes(secret), `白名单列的值仍必须二次脱敏：${secret}`)
  })
  assert.strictEqual(publicSnapshot.sourceMode, 'feishu-mini-mirror-v1', '公开快照必须带 canonical 来源标记，旧普通 Sheet 缓存不能冒充')
  assert.strictEqual(publicSnapshot.schemaVersion, 1, '公开快照必须带固定 schemaVersion')
}

main().then(() => {
  console.log('company-source-snapshot-v1-test passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
