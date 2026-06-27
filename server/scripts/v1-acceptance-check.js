const assert = require('assert')
const fs = require('fs')
const path = require('path')

const domain = require('../src/domain')
const { NO_FEATURE } = require('../src/listing-features')
const matchService = require('../src/match-service')

const ROOT_DIR = path.resolve(__dirname, '..', '..')
const EXPECTED_TABS = [
  { text: '找房', pagePath: 'pages/index/index' },
  { text: '房源', pagePath: 'pages/listings/listings' },
  { text: '地图', pagePath: 'pages/map/map' },
  { text: '我的', pagePath: 'pages/profile/profile' }
]
const HIDDEN_V1_KEYWORDS = ['房源群', '换群', '积分', '充值', '微信支付']

const passed = []
const failed = []

function readFile(relativePath) {
  return fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8')
}

function assertIncludes(source, needle, message) {
  assert.ok(source.includes(needle), message || `缺少关键内容：${needle}`)
}

function assertMatches(source, pattern, message) {
  assert.ok(pattern.test(source), message || `缺少匹配内容：${pattern}`)
}

function assertNoHiddenKeyword(source, context) {
  HIDDEN_V1_KEYWORDS.forEach((keyword) => {
    assert.ok(!source.includes(keyword), `${context} 不能包含第一版隐藏入口：${keyword}`)
  })
}

function extractSingleQuotedValues(source, key) {
  const pattern = new RegExp(`${key}:\\s*'([^']+)'`, 'g')
  return Array.from(source.matchAll(pattern)).map((match) => match[1])
}

function check(name, fn) {
  try {
    fn()
    passed.push(name)
    console.log(`通过：${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.error(`失败：${name}`)
    console.error(`  ${error.message}`)
  }
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function createDb() {
  return {
    users: [
      { id: 'U1', name: '上传中介', phone: '13900000001', role: '中介', authed: '已实名' },
      { id: 'U2', name: '成交中介', phone: '13900000002', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', phone: '13900000003', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [],
    footprints: [],
    pointLogs: [],
    commissionRecords: [],
    clientReports: [],
    dealRecords: []
  }
}

function listingPayload(overrides = {}) {
  return {
    city: '杭州',
    district: '滨江区',
    area: '滨江区',
    block: '滨江区',
    communityName: '第一版验收无坐标小区',
    community: '第一版验收无坐标小区',
    buildingNo: '1',
    building: '1',
    unitNo: '1',
    unit: '1',
    roomNo: '101',
    roomNumber: '101',
    address: '杭州市滨江区第一版验收无坐标小区1幢1单元101室',
    contact: '13911112222',
    rent: 3500,
    layout: '整租两室一厅一卫',
    features: [NO_FEATURE],
    videoKey: 'house-videos/v1-acceptance/test.mp4',
    commissionRate: 99,
    brokerId: 'CLIENT_BROKER',
    uploaderId: 'CLIENT_UPLOADER',
    ...overrides
  }
}

function assertRejects(fn, matcher, message) {
  let rejected = false
  try {
    fn()
  } catch (error) {
    rejected = true
    assert.ok(matcher(error), message || error.message)
  }
  if (!rejected) throw new Error(message || '预期操作被拒绝')
}

function assertNoPublicSensitiveFields(row, context) {
  const forbiddenKeys = ['building', 'unit', 'roomNumber', 'roomAddress', 'uploaderPhone', 'landlordPhone']
  forbiddenKeys.forEach((key) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, key), `${context} 不能返回 ${key}`)
  })
  const text = JSON.stringify(row)
  ;['1幢', '1单元', '101室', '13911112222', '13900000001'].forEach((fragment) => {
    assert.ok(!text.includes(fragment), `${context} 不能返回敏感片段：${fragment}`)
  })
}

function makeMatchDb() {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  return {
    users: [{ id: 'U1', name: '测试中介', role: '中介' }],
    listings: [
      {
        id: 'M1',
        title: '滨江春波南苑两室',
        shortTitle: '春波南苑',
        uploaderId: 'U1',
        rent: 3900,
        layout: '整租两室一厅一卫',
        city: '杭州',
        district: '滨江',
        area: '滨江',
        block: '西兴',
        community: '春波南苑',
        commissionRate: 20,
        videoUrl: 'https://example.com/m1.mp4',
        videoKey: 'm1.mp4',
        status: '在租',
        reviewStatus: '无需审核',
        lifecycleStatus: 'active',
        rentMode: '整租',
        room: '两室',
        features: ['燃气', '近地铁'],
        source: '普通上传',
        coordinateSource: 'community-coordinate',
        createdAt: now,
        lastVerifiedAt: now
      }
    ],
    footprints: []
  }
}

check('底部导航固定为找房/房源/地图/我的', () => {
  const appJson = JSON.parse(readFile('app.json'))
  assert.deepStrictEqual(appJson.tabBar.list.map((item) => item.text), EXPECTED_TABS.map((item) => item.text))
  assert.deepStrictEqual(appJson.tabBar.list.map((item) => item.pagePath), EXPECTED_TABS.map((item) => item.pagePath))
  assert.ok(!(appJson.pages || []).includes('pages/groups/groups'), '第一版 app.json pages 不能注册房源群页面直达路径')
  assertNoHiddenKeyword(JSON.stringify(appJson.tabBar.list), 'app.json tabBar')

  const customTab = readFile('custom-tab-bar/index.js')
  assert.deepStrictEqual(extractSingleQuotedValues(customTab, 'text'), EXPECTED_TABS.map((item) => item.text))
  assert.deepStrictEqual(
    extractSingleQuotedValues(customTab, 'pagePath'),
    EXPECTED_TABS.map((item) => `/${item.pagePath}`)
  )
  assertNoHiddenKeyword(customTab, 'custom-tab-bar/index.js')
})

check('第一版隐藏入口不在可见工作台', () => {
  const profile = readFile('pages/profile/profile.js')
  assertIncludes(profile, 'hiddenV1EntryKeywords', '我的页需要保留第一版隐藏入口过滤关键词')
  assertIncludes(profile, 'filterVisibleStats', '我的页统计需要过滤第一版隐藏入口')
  assertIncludes(profile, 'filterVisibleReminders', '我的页提醒需要过滤第一版隐藏入口')
  const visibleUrls = extractSingleQuotedValues(profile, 'url')
  assert.ok(!visibleUrls.includes('/pages/groups/groups'), '我的页工作台不能露出房源群入口')
  assertNoHiddenKeyword(readFile('pages/my-listings/my-listings.wxml'), '我的房源页')
})

check('上传房源必须走视频选择和视频上传策略', () => {
  const uploadJs = readFile('pages/upload/upload.js')
  const uploadWxml = readFile('pages/upload/upload.wxml')
  assertMatches(uploadJs, /mediaType:\s*\[\s*['"]video['"]\s*\]/, '上传页必须只选择视频媒体')
  assert.ok(!/mediaType:\s*\[[^\]]*['"]image['"]/.test(uploadJs), '上传页不能选择图片作为房源素材')
  assertIncludes(uploadJs, 'createVideoUploadPolicy', '上传页必须申请视频上传策略')
  assertIncludes(uploadJs, '房源视频', '上传页校验必须包含房源视频必填')
  assertIncludes(uploadWxml, '仅允许视频，不支持图片上传。', '上传页需要明确展示仅允许视频')
})

check('找房助手先识别确认，再匹配和跳转地图', () => {
  const matchChat = readFile('pages/match-chat/match-chat.js')
  const llmService = readFile('utils/llm-service.js')
  const matchServiceSource = readFile('server/src/match-service.js')
  assertIncludes(matchChat, 'recognizeRentalNeed', '找房对话必须先进入识别阶段')
  assertIncludes(matchChat, 'canConfirm', '找房对话必须支持可编辑确认状态')
  assertIncludes(matchChat, 'canEditConfirmation', '找房对话必须在匹配前展示可编辑确认卡片')
  assertIncludes(matchChat, 'confirmForm', '找房对话必须展示可修正的结构化字段')
  assertIncludes(matchChat, 'followUpQuestion', '找房对话必须支持追问')
  assertIncludes(matchChat, 'ynzy_pending_map_filters', '找房结果进入地图时必须携带筛选条件')
  assertIncludes(matchChat, "wx.switchTab({ url: '/pages/map/map' })", '找房结果应通过底部导航进入地图')
  assertIncludes(llmService, "stage: 'recognize'", 'LLM 服务必须支持识别阶段')
  assertIncludes(matchServiceSource, 'readyToConfirm', '服务端识别结果必须保留确认状态')

  const incomplete = matchService.recognizeNeed(makeMatchDb(), { text: '必须有阳台' })
  assert.strictEqual(incomplete.stage, 'recognize')
  assert.strictEqual(incomplete.readyToConfirm, false)
  assert.ok(incomplete.followUpQuestion, '条件不足时必须追问')
  assert.strictEqual((incomplete.listings || []).length, 0, '识别阶段不能返回房源')

  const complete = matchService.recognizeNeed(makeMatchDb(), { text: '滨江四千以内两室，必须有燃气' })
  assert.strictEqual(complete.stage, 'recognize')
  assert.strictEqual(complete.readyToConfirm, true)
  const fieldKeys = (complete.confirmationFields || []).map((field) => field.key)
  ;['budget', 'location', 'layout', 'moveIn', 'commute', 'features'].forEach((key) => {
    assert.ok(fieldKeys.includes(key), `确认字段缺失：${key}`)
  })
})

check('地图只展示确认小区坐标并显示筛选后套数', () => {
  const mapJs = readFile('pages/map/map.js')
  assertIncludes(mapJs, 'ynzy_pending_map_filters', '地图页必须读取找房助手筛选条件')
  assertIncludes(mapJs, 'wx.removeStorageSync(PENDING_MAP_FILTERS_KEY)', '地图页读取后必须清理待处理筛选条件')
  assertIncludes(mapJs, 'getMapCommunities', '地图页必须读取小区聚合接口')
  assertIncludes(mapJs, 'coordinateVerified', '地图页必须过滤已确认坐标')
  assertIncludes(mapJs, 'listingCount', '地图页必须展示小区套数')
  assertIncludes(mapJs, '筛选后', '地图摘要必须说明筛选后套数')

  const db = createDb()
  const noCoordinateListing = domain.addNormalListing(db, 'U1', listingPayload())
  const reliableListing = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    address: '杭州市上城区京漾东韵府1幢1单元101室',
    videoKey: 'house-videos/v1-acceptance/map-real.mp4'
  }))
  const mapRows = domain.mapCommunities(db)
  assert.ok(mapRows.some((item) => item.activeListingIds.includes(reliableListing.id)), '可靠小区坐标必须进入地图')
  assert.ok(!mapRows.some((item) => item.activeListingIds.includes(noCoordinateListing.id)), '无可靠坐标房源不能进入地图')
  const realPin = mapRows.find((item) => item.activeListingIds.includes(reliableListing.id))
  assert.strictEqual(realPin.coordinateVerified, true)
  assert.ok(realPin.listingCount >= 1, '地图小区点必须包含筛选后套数')
  assertNoPublicSensitiveFields(realPin, '地图小区点')
})

check('报备、签单、管理员确认和 20% 分佣契约正确', () => {
  const db = createDb()
  assertRejects(
    () => domain.addNormalListing(db, 'U1', listingPayload({ videoKey: '', videoUrl: '' })),
    (error) => error.statusCode === 400 && /视频/.test(error.message),
    '后端必须拒绝无视频房源'
  )
  const created = domain.addNormalListing(db, 'U1', listingPayload())
  const rawListing = db.listings.find((item) => item.id === created.id)
  assert.strictEqual(rawListing.uploaderId, 'U1', '上传人必须来自服务端当前用户')
  assert.strictEqual(rawListing.commissionRate, 20, '普通房源分佣比例必须由后端固定为 20%')

  const listRow = domain.filterListings(db).find((item) => item.id === created.id)
  const detailRow = domain.listingDetail(db, created.id)
  assert.ok(listRow && detailRow, '有效且有视频房源必须进入前台列表和详情')
  assertNoPublicSensitiveFields(listRow, '前台列表')
  assertNoPublicSensitiveFields(detailRow, '前台详情')

  assertRejects(
    () => domain.createClientReport(db, 'U2', created.id, { customerName: '王先生' }),
    (error) => error.statusCode === 400 && /手机号/.test(error.message),
    '报备客户手机号必须必填'
  )
  const reportResult = domain.createClientReport(db, 'U2', created.id, {
    customerName: '',
    customerPhone: '13800001111',
    brokerId: 'CLIENT_BROKER'
  })
  const report = db.clientReports.find((item) => item.id === reportResult.report.id)
  assert.strictEqual(report.brokerId, 'U2', '报备 brokerId 必须来自服务端当前用户')

  assertRejects(
    () => domain.registerDeal(db, 'U2', created.id),
    (error) => error.statusCode === 400 && /报备/.test(error.message),
    '签单不能绕过报备直接从房源发起'
  )
  const dealResult = domain.createDealFromReport(db, 'U2', report.id, {
    monthlyRent: 3500,
    landlordCommission: 5000,
    remark: '第一版验收',
    commissionRate: 99,
    uploaderId: 'CLIENT_UPLOADER'
  })
  const deal = db.dealRecords.find((item) => item.id === dealResult.deal.id)
  assert.strictEqual(deal.dealMonthlyRentFen, 350000, '成交月租必须按分存储')
  assert.strictEqual(deal.landlordCommissionFen, 500000, '房东实际支付佣金必须按分存储')
  assert.strictEqual(db.commissionRecords.length, 0, '管理员确认前不能生成正式分佣记录')

  const confirmResult = domain.confirmDeal(db, 'ADMIN', deal.id)
  assert.strictEqual(db.commissionRecords.length, 1, '管理员确认后必须生成正式分佣记录')
  assert.strictEqual(confirmResult.commissionRecord.rate, 20, '正式分佣比例必须固定 20%')
  assert.strictEqual(confirmResult.commissionRecord.uploaderCommissionFen, 100000, '上传人分佣必须等于房东实付佣金的 20%')
})

check('接口路径覆盖第一版验收闭环', () => {
  const apiService = readFile('utils/api-service.js')
  const serverIndex = readFile('server/src/index.js')
  assertIncludes(apiService, '/mini/uploads/video-policy', '前端必须调用视频上传策略接口')
  assertIncludes(apiService, '/mini/map/communities', '前端必须调用地图小区聚合接口')
  assertIncludes(apiService, '/mini/listings/${listingId}/reports', '前端必须从房源创建报备')
  assertIncludes(apiService, '/mini/reports/${reportId}/deals', '前端必须从报备创建签单')
  assertIncludes(serverIndex, "pathname === '/mini/uploads/video-policy'", '后端必须提供视频上传策略接口')
  assertIncludes(serverIndex, "pathname === '/mini/map/communities'", '后端必须提供地图小区聚合接口')
  assertIncludes(serverIndex, 'domain.createClientReport', '后端必须创建报备')
  assertIncludes(serverIndex, 'domain.createDealFromReport', '后端必须从报备创建签单')
  assertIncludes(serverIndex, 'domain.confirmDeal', '后端必须支持管理员确认签单')
})

check('敏感信息脱敏和提示词约束存在', () => {
  const domainSource = readFile('server/src/domain.js')
  const llmSource = readFile('server/src/llm.js')
  assertIncludes(domainSource, 'function maskPhone', '后端必须有手机号脱敏函数')
  assertIncludes(domainSource, 'customerPhoneMasked', '报备输出必须使用脱敏手机号字段')
  assertIncludes(llmSource, '不能输出完整地址、楼栋房号、房东电话、客户手机号、微信号、身份证信息或视频签名链接。', 'LLM 提示词必须限制敏感信息输出')
})

check('3/5/7 天房态规则保持固定', () => {
  const db = createDb()
  const rule = domain.listingMaintenanceRule(db)
  assert.deepStrictEqual(rule.remindDays, [3, 5], '房态提醒必须是第 3 天和第 5 天')
  assert.strictEqual(rule.expireDays, 7, '房态自动失效必须是第 7 天')

  db.listings.unshift({
    id: 'STALE_7',
    title: '七天失效房源',
    shortTitle: '七天失效房源',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租一室',
    area: '滨江区',
    community: '失效小区',
    address: '失效地址',
    landlordPhone: '13911115555',
    commissionRate: 20,
    videoUrl: 'https://example.com/stale-7.mp4',
    status: '在租',
    lifecycleStatus: 'active',
    lastVerifiedAt: daysAgo(7),
    createdAt: daysAgo(7)
  })
  domain.enforceListingMaintenanceRule(db)
  const stale = db.listings.find((item) => item.id === 'STALE_7')
  assert.strictEqual(stale.lifecycleStatus, 'expired', '第 7 天未更新必须自动失效')
  assert.ok(stale.expiredPool, '失效房源必须保留后台资产池标记')
  assert.ok(!domain.filterListings(db).some((item) => item.id === 'STALE_7'), '失效房源不能进入前台列表')
})

console.log('')
console.log(`第一版微信开发者工具轻量验收检查完成：通过 ${passed.length} 项，失败 ${failed.length} 项。`)

if (failed.length) {
  console.error('')
  console.error('失败项：')
  failed.forEach((item) => {
    console.error(`- ${item.name}: ${item.error.message}`)
  })
  process.exit(1)
}
