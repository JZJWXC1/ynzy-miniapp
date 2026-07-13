'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const mockData = require(path.join(repoRoot, 'utils', 'mock-data'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client'))
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service'))
const llmServicePath = require.resolve(path.join(repoRoot, 'utils', 'llm-service'))

function listingPayload(roomNumber, source, overrides = {}) {
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新',
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    building: '1',
    unit: '1',
    roomNumber,
    address: `杭州拱墅区京漾东韵府1栋1单元${roomNumber}室`,
    contact: '19900000061',
    landlordPhone: '19900000061',
    rent: 3200,
    layout: '整租两室1厅1卫',
    rentMode: '整租',
    room: '两室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯'],
    videoKey: `house-videos/synthetic/mock-preview-${roomNumber}.mp4`,
    viewingMethod: '联系房东',
    ownerType: source,
    houseSourceType: source,
    source,
    landlordCommissionPercent: 50,
    ...overrides
  }
}

function addListing(roomNumber, source, overrides) {
  const current = Date.now()
  while (Date.now() === current) {}
  return mockData.addNormalListing(listingPayload(roomNumber, source, overrides))
}

function ids(rows) {
  return (rows || []).map((item) => item.id).sort()
}

function mapIds(rows) {
  return Array.from(new Set((rows || []).flatMap((item) => item.activeListingIds || []))).sort()
}

async function run() {
  mockData.loginByPhone('13800010004')
  mockData.updateCommissionConfig({
    secondLandlordRate: 12,
    ownerRate: 18,
    secondLandlordPlatformRate: 10,
    ownerPlatformRate: 10
  })
  const company = addListing('9811', '公司房源', {
    companyListing: true,
    isCompanyListing: true
  })
  const otherDistrictCompany = addListing('9812', '公司房源', {
    companyListing: true,
    isCompanyListing: true,
    district: '上城区',
    area: '上城区',
    block: '闸弄口',
    communityName: '长木府',
    community: '长木府',
    address: '杭州上城区长木府1栋1单元9812室'
  })

  mockData.loginByPhone('13800010005')
  const owner = addListing('9813', '业主房源')
  const secondLandlord = addListing('9814', '二房东房源')

  const failures = []
  async function check(name, assertion) {
    try {
      await assertion()
    } catch (error) {
      failures.push({ name, error })
      console.error(`[RED] ${name}: ${error.message}`)
    }
  }

  await check('Mock 列表 district 与服务端一致', () => {
    const districtRows = mockData.getListings({ district: '拱墅区' })
    assert.deepStrictEqual(ids(districtRows), [company.id, owner.id, secondLandlord.id].sort())
    assert.ok(!ids(districtRows).includes(otherDistrictCompany.id), 'district 不得被忽略')
  })

  await check('Mock 卡片动态佣金、媒体字段与服务端一致', () => {
    const rows = mockData.getListings({})
    const companyRow = rows.find((item) => item.id === company.id)
    const ownerRow = rows.find((item) => item.id === owner.id)
    const secondLandlordRow = rows.find((item) => item.id === secondLandlord.id)
    assert.ok(companyRow && ownerRow && secondLandlordRow)
    assert.strictEqual(companyRow.tag, '公司房源')
    assert.ok(companyRow.sub.includes('公司房源成交不抽佣，带看中介全佣'))
    assert.ok(!companyRow.sub.includes('30%'), '公司房源不得显示历史 30%')
    assert.strictEqual(ownerRow.tag, '18%')
    assert.ok(ownerRow.sub.includes('28%'))
    assert.strictEqual(secondLandlordRow.tag, '12%')
    assert.ok(secondLandlordRow.sub.includes('22%'))
    ;[companyRow, ownerRow, secondLandlordRow].forEach((row) => {
      assert.strictEqual(row.hasVideo, true, '列表必须返回 hasVideo')
      assert.ok(Object.prototype.hasOwnProperty.call(row, 'coverUrl'), '列表必须返回 coverUrl')
    })
  })

  await check('Mock 不存在详情抛出 404', () => {
    assert.throws(
      () => mockData.getListingDetail('MOCK-MISSING-LISTING', { companyOnly: false }),
      (error) => error && error.statusCode === 404
    )
  })

  let authToken = ''
  const calls = []
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      getAuthToken: () => authToken,
      call(options) {
        calls.push(options)
        return Promise.resolve().then(() => options.mock())
      }
    }
  }
  delete require.cache[apiServicePath]
  delete require.cache[llmServicePath]
  const apiService = require(apiServicePath)
  const llmService = require(llmServicePath)

  const matchPayload = {
    confirmed: true,
    form: {
      budget: 4000,
      area: '拱墅区',
      layout: '两室'
    }
  }
  await check('游客 Mock 找房助手只匹配公司房源', () => {
    authToken = ''
    const guestMatch = llmService.buildLocalMatch(matchPayload)
    assert.ok(guestMatch.listings.length > 0)
    assert.ok(guestMatch.listings.every((item) => item.companyListing), '游客本地兜底不得泄露合作房源')
    authToken = 'synthetic-preview-token'
    const brokerMatch = llmService.buildLocalMatch(matchPayload)
    assert.ok(brokerMatch.listings.some((item) => !item.companyListing), '登录后仍应匹配业主/二房东房源')
  })

  await check('游客今日任务不发登录接口请求', async () => {
    authToken = ''
    const before = calls.length
    const result = await apiService.getTodayTasks()
    assert.strictEqual(calls.length, before, '游客首页不得请求 /mini/today-tasks 或 /mini/profile')
    assert.strictEqual(result.summary.pendingCount, 0)
    assert.ok(result.tasks.every((item) => Number(item.count || 0) === 0))
  })

  await check('Mock 分佣记录必须走数据层而非硬编码空数组', async () => {
    authToken = 'synthetic-preview-token'
    const fixture = [{ id: 'MOCK-COMMISSION-1', role: '我是上传人', status: '待确认' }]
    const original = mockData.getCommissionRecords
    mockData.getCommissionRecords = () => fixture
    try {
      assert.deepStrictEqual(await apiService.getCommissionRecords(), fixture)
    } finally {
      if (original) mockData.getCommissionRecords = original
      else delete mockData.getCommissionRecords
    }
  })

  await check('Mock map pins 与服务端同为小区聚合 DTO', async () => {
    authToken = 'synthetic-preview-token'
    const pins = await apiService.getMapPins({ sourceType: '业主房源', area: '拱墅区' })
    assert.deepStrictEqual(mapIds(pins), [owner.id])
    assert.ok(pins.every((item) => Array.isArray(item.listings) && Array.isArray(item.activeListingIds)))
    assert.ok(pins.every((item) => item.coordinateLevel && item.coordinateStatus), '小区点必须带坐标可信度口径')
    assert.ok(!JSON.stringify(pins).includes('19900000061'), '地图聚合 DTO 不得包含联系方式')
  })

  await check('Mock 已下架详情返回结构化且脱敏的 unavailable', async () => {
    mockData.verifyMyListing(secondLandlord.id, '已出租')
    const unavailable = mockData.getListingDetail(secondLandlord.id, { companyOnly: false })
    assert.strictEqual(unavailable.unavailable, true)
    assert.strictEqual(unavailable.id, secondLandlord.id)
    assert.strictEqual(unavailable.reason, 'down')
    assert.ok(unavailable.reasonText)
    ;['address', 'landlordPhone', 'contact', 'videoUrl', 'videoKey', 'uploaderId'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(unavailable, field), `unavailable 不得包含 ${field}`)
    })
  })

  await check('API Mock 不存在详情继续抛出 404', async () => {
    authToken = 'synthetic-preview-token'
    await assert.rejects(
      apiService.getListingDetail('MOCK-MISSING-LISTING'),
      (error) => error && error.statusCode === 404
    )
  })

  if (failures.length) {
    const error = new Error(`Mock/预览契约仍有 ${failures.length} 项未满足：${failures.map((item) => item.name).join('；')}`)
    error.failures = failures
    throw error
  }

  console.log('mock-preview-parity-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
