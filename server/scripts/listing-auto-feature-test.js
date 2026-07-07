const assert = require('assert')
const domain = require('../src/domain')
const feishuSync = require('../src/feishu-sync')
const { NO_FEATURE } = require('../src/listing-features')

function makeDb() {
  return {
    users: [
      { id: 'A1', name: '管理员', phone: '13900000001', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [],
    footprints: [],
    pointLogs: [],
    commissionRecords: [],
    clientReports: [],
    dealRecords: []
  }
}

let roomSeed = 1000

function listingPayload(overrides = {}) {
  roomSeed += 1
  const roomNumber = String(roomSeed)
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新园',
    communityName: '棠润府',
    community: '棠润府',
    building: '17',
    unit: '1',
    roomNumber,
    address: `杭州拱墅区棠润府17幢1单元${roomNumber}室`,
    contact: '13911112222',
    rent: 3200,
    layout: '整租一室一厅一卫',
    rentMode: '整租',
    room: '一室',
    hall: '1厅',
    bath: '1卫',
    videoKey: 'house-videos/listing-auto-feature-test.mp4',
    features: ['电梯'],
    companyListing: true,
    source: '公司房源',
    ...overrides
  }
}

function createListing(db, overrides = {}) {
  const detail = domain.addNormalListing(db, 'A1', listingPayload(overrides), { admin: true, skipPointLog: true })
  return db.listings.find((item) => item.id === detail.id)
}

function assertIncludesAll(features, expected, label) {
  expected.forEach((feature) => {
    assert.ok(features.includes(feature), `${label} 应包含 ${feature}`)
  })
}

function assertExcludesAll(features, expected, label) {
  expected.forEach((feature) => {
    assert.ok(!features.includes(feature), `${label} 不应包含 ${feature}`)
  })
}

function assertRejects(fn, pattern, label) {
  let rejected = false
  try {
    fn()
  } catch (error) {
    rejected = true
    assert.ok(pattern.test(error.message), `${label} 错误文案应匹配 ${pattern}，实际为 ${error.message}`)
  }
  if (!rejected) throw new Error(`${label} 应抛出错误`)
}

async function main() {
  const db = makeDb()

  const inferred = createListing(db, {
    features: ['朝南'],
    note: '南北通透，独立卫生间，可月付，首次出租，民水民电，带阁楼，可短租',
    rawFeatures: ['花园']
  })
  assertIncludesAll(
    inferred.features,
    ['朝南', '采光好', '独卫', '可月付', '首次出租', '民水民电', '带露台（阁楼）', '可短租'],
    '普通入库自动特色'
  )
  assertExcludesAll(
    inferred.features,
    ['南北通透', '独立卫生间', '带阁楼', '花园', '阁楼', '露台'],
    '普通入库自动特色'
  )

  const negated = createListing(db, {
    features: ['朝南'],
    note: '无燃气，不通煤气，非近地铁，没有阳台，缺独立卫生间',
    rawFeatures: '采光好'
  })
  assertIncludesAll(negated.features, ['朝南', '采光好'], '否定安全')
  assertExcludesAll(negated.features, ['燃气', '近地铁', '带阳台', '独卫'], '否定安全')

  const negatedAfter = createListing(db, {
    features: ['朝南'],
    note: '煤气没通，燃气未通，阳台没有，采光好',
    rawFeatures: '独立卫生间'
  })
  assertIncludesAll(negatedAfter.features, ['朝南', '采光好', '独卫'], '后置否定安全')
  assertExcludesAll(negatedAfter.features, ['燃气', '带阳台'], '后置否定安全')

  const negatedMixed = createListing(db, {
    features: ['朝南'],
    note: '有燃气，阳台没有'
  })
  assertIncludesAll(negatedMixed.features, ['朝南', '燃气'], '同句混合：本子句正例不被下一子句否定误伤')
  assertExcludesAll(negatedMixed.features, ['带阳台'], '同句混合：后置否定只作用于本子句')

  const negatedCannot = createListing(db, {
    features: ['朝南'],
    note: '不可短租，不能月付，不能用燃气'
  })
  assertExcludesAll(negatedCannot.features, ['可短租', '可月付', '燃气'], '不可/不能/不能用类否定')

  const positiveCan = createListing(db, {
    features: ['朝南'],
    note: '可短租，可月付，有燃气'
  })
  assertIncludesAll(positiveCan.features, ['朝南', '可短租', '可月付', '燃气'], '不可/不能修复未误伤正例')

  const negatedAfterCannot = createListing(db, {
    features: ['朝南'],
    note: '短租不支持，月付不允许'
  })
  assertExcludesAll(negatedAfterCannot.features, ['可短租', '可月付'], '后置不支持/不允许类否定')

  const positiveRobust = createListing(db, {
    features: ['朝南'],
    note: '燃气没问题，独卫少不了'
  })
  assertIncludesAll(positiveRobust.features, ['朝南', '燃气', '独卫'], '否定加固不误伤正向口语（没问题/少不了）')

  const explicitNone = createListing(db, {
    features: [NO_FEATURE],
    note: '采光好，独立卫生间，可月付'
  })
  assertExcludesAll(explicitNone.features, ['采光好', '独卫', '可月付'], '人工明确选择无特点时')

  const manualKept = createListing(db, {
    features: ['干湿分离'],
    note: '光线好，首租，民水民电'
  })
  assertIncludesAll(manualKept.features, ['干湿分离', '采光好', '首次出租', '民水民电'], '人工特色保留')

  assertRejects(
    () => domain.addNormalListing(db, 'A1', listingPayload({
      features: undefined,
      companyListing: false,
      source: '二房东房源',
      ownerType: '二房东房源',
      note: ''
    }), { admin: true, skipPointLog: true }),
    /请选择房源特点标签/,
    '只有租赁方式没有真实特色时'
  )

  const feishuDb = makeDb()
  await feishuSync.applySync(feishuDb, [
    {
      record_id: 'auto-feature-1',
      fields: {
        区域: '东新园',
        小区: '棠润府',
        几栋: '17',
        几单元: '1',
        房号: '1004A',
        户型: '一室一厅一卫',
        押一付一: '3200',
        标签: '南北通透 独立卫生间 可月付 首次出租 民水民电 带阁楼 可短租',
        备注: '无燃气，非近地铁'
      }
    }
  ], [], 'A1', { dryRun: true })
  assert.strictEqual(feishuDb.listings.length, 1, '飞书自由文本应可正常入库')
  const feishuListing = feishuDb.listings[0]
  assertIncludesAll(
    feishuListing.features,
    ['采光好', '独卫', '可月付', '首次出租', '民水民电', '带露台（阁楼）', '可短租'],
    '飞书自由文本自动特色'
  )
  assertExcludesAll(
    feishuListing.features,
    ['南北通透', '独立卫生间', '带阁楼', '燃气', '近地铁'],
    '飞书自由文本自动特色'
  )
}

main().then(() => {
  console.log('listing-auto-feature-test passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
