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
    communityName: '半山家苑',
    community: '半山家苑',
    buildingNo: '1',
    building: '1',
    unitNo: '1',
    unit: '1',
    roomNo: '101',
    roomNumber: '101',
    address: '杭州市滨江区半山家苑1幢1单元101室',
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

check('上传房源按类型执行视频要求和上传策略', () => {
  const uploadJs = readFile('pages/upload/upload.js')
  const uploadWxml = readFile('pages/upload/upload.wxml')
  assertMatches(uploadJs, /mediaType:\s*\[\s*['"]video['"]\s*\]/, '上传页必须只选择视频媒体')
  assert.ok(!/mediaType:\s*\[[^\]]*['"]image['"]/.test(uploadJs), '上传页不能选择图片作为房源素材')
  assertIncludes(uploadJs, 'createVideoUploadPolicy', '上传页必须申请视频上传策略')
  assertIncludes(uploadJs, '房源视频', '上传页校验必须包含房源视频必填')
  assertIncludes(uploadJs, 'requiresUploadVideo', '上传页必须按房源类型判断是否强制视频')
  assertIncludes(uploadWxml, '公司房源可不上传视频', '上传页必须提示公司房源视频可选')
  assertIncludes(uploadWxml, '仅允许视频，不支持图片上传。', '上传页需要明确展示仅允许视频')
})

check('找房助手走智能客服主链路并保留确认兜底', () => {
  const matchChat = readFile('pages/match-chat/match-chat.js')
  const matchChatWxml = readFile('pages/match-chat/match-chat.wxml')
  const llmService = readFile('utils/llm-service.js')
  const matchServiceSource = readFile('server/src/match-service.js')
  assertIncludes(matchChat, 'chatAssistant', '找房对话自然语言发送必须进入 assistant chat 主链路')
  assertIncludes(matchChat, 'currentThreadId', '找房对话必须携带 threadId 支持多轮上下文')
  assertIncludes(llmService, '/mini/assistant/chat', 'LLM 服务必须接入 assistant chat 接口')
  assertIncludes(llmService, 'chatAssistant', 'LLM 服务必须导出 assistant chat 方法')
  assertIncludes(matchChat, 'recognizeRentalNeed', '找房对话仍需保留识别确认兜底')
  assertIncludes(matchChat, 'canConfirm', '找房对话必须支持可编辑确认状态')
  assertIncludes(matchChat, 'canEditConfirmation', '找房对话必须在匹配前展示可编辑确认卡片')
  assertIncludes(matchChat, 'confirmForm', '找房对话必须展示可修正的结构化字段')
  assertIncludes(matchChat, 'nextQuestion', '找房对话必须支持 assistant 追问')
  assertIncludes(matchChatWxml, 'distanceText', '半径找房结果必须展示距离事实')
  assert.ok(matchChat.indexOf('debugTrace') === -1, '小程序找房对话不应主动请求 debugTrace')
  assert.ok(matchChatWxml.indexOf('traceSummary') === -1, '小程序找房对话不应渲染 traceSummary')
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
  ;['budget', 'location', 'layout', 'features'].forEach((key) => {
    assert.ok(fieldKeys.includes(key), `确认字段缺失：${key}`)
  })
  ;['moveIn', 'commute'].forEach((key) => {
    assert.ok(!fieldKeys.includes(key), `第一版找房表单不应包含低优先级字段：${key}`)
  })
})

check('找房助手生产网络失败不返回本地模拟房源', () => {
  const matchChat = readFile('pages/match-chat/match-chat.js')
  const llmService = readFile('utils/llm-service.js')
  const networkFallbackTestSource = readFile('server/scripts/assistant-client-network-fallback-test.js')

  assertIncludes(llmService, 'shouldUseLocalFallbackAfterError', 'LLM 服务必须区分 mock 演示和生产网络失败')
  assertIncludes(llmService, 'server-unavailable', '生产网络失败必须返回服务不可用模式')
  assertIncludes(llmService, 'emptyNetworkMatchResult', '生产网络失败必须构造空房源结果')
  assertIncludes(matchChat, 'matchResult && matchResult.networkFailed ? [] : buildListingSections', '小程序网络失败时不能渲染推荐卡片')
  assertIncludes(matchChat, '网络连接失败，请点下方按钮重试。', '小程序网络失败时必须提示重试')
  assertIncludes(matchChat, 'degradedNotice', '小程序必须展示供应商降级提示但继续渲染真实匹配结果')
  assertIncludes(matchChat, '智能解读稍后重试', '供应商降级提示文案必须写入页面数据')
  assert.ok(!matchChat.includes('先给你本地匹配结果'), '生产网络失败文案不能暗示本地推荐可用')
  assertIncludes(networkFallbackTestSource, '生产失败时不能返回本地推荐房源', '客户端网络失败测试必须阻止 mock 房源回退')
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

check('报备、签单、管理员确认和总比例拆分分佣契约正确', () => {
  const db = createDb()
  assertRejects(
    () => domain.addNormalListing(db, 'U1', listingPayload({
      ownerType: '二房东房源',
      houseSourceType: '二房东房源',
      source: '二房东房源',
      videoKey: '',
      videoUrl: ''
    })),
    (error) => error.statusCode === 400 && /视频/.test(error.message),
    '后端必须拒绝无视频二房东房源'
  )
  const companyNoVideo = domain.addNormalListing(db, 'ADMIN', listingPayload({
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    buildingNo: '8',
    building: '8',
    unitNo: '1',
    unit: '1',
    roomNo: '801',
    roomNumber: '801',
    address: '杭州市上城区京漾东韵府8幢1单元801室',
    source: '公司房源',
    companyListing: true,
    videoKey: '',
    videoUrl: ''
  }), { admin: true })
  assert.ok(domain.filterListings(db, { category: '公司房源' }).some((item) => item.id === companyNoVideo.id), '公司房源无视频必须进入公司房源列表')
  assert.ok(domain.mapCommunities(db, { sourceType: '公司房源' }).some((item) => item.activeListingIds.includes(companyNoVideo.id)), '地图必须纳入无视频公司房源')
  assert.ok(domain.matchListings(db, { area: '京漾东韵府' }).listings.some((item) => item.id === companyNoVideo.id), '公司房源无视频必须进入匹配候选')
  assert.ok(domain.listingDetail(db, companyNoVideo.id), '公司房源无视频必须可打开详情')

  const created = domain.addNormalListing(db, 'U1', listingPayload())
  const rawListing = db.listings.find((item) => item.id === created.id)
  assert.strictEqual(rawListing.uploaderId, 'U1', '上传人必须来自服务端当前用户')
  assert.strictEqual(rawListing.commissionRate, 15, '二房东房源分佣比例必须由后端固定为 15%')

  const listRow = domain.filterListings(db).find((item) => item.id === created.id)
  const detailRow = domain.listingDetail(db, created.id)
  assert.ok(listRow && detailRow, '有效且有视频房源必须进入前台列表和详情')
  assertNoPublicSensitiveFields(listRow, '前台列表')
  assertNoPublicSensitiveFields(detailRow, '前台详情')
  const needResult = domain.createRentalNeed(db, 'U2', {
    rawText: '客户找滨江两室，预算 4500',
    confirmedNeed: { area: '滨江区', layout: '两室', budgetMax: 4500 },
    source: 'acceptance'
  })
  const need = db.rentalNeeds.find((item) => item.id === needResult.need.id)

  assertRejects(
    () => domain.createClientReport(db, 'U2', created.id, { customerName: '王先生' }),
    (error) => error.statusCode === 400 && /手机号/.test(error.message),
    '报备客户手机号必须必填'
  )
  const reportResult = domain.createClientReport(db, 'U2', created.id, {
    needId: need.id,
    customerName: '',
    customerPhone: '13800001111',
    brokerId: 'CLIENT_BROKER'
  })
  const report = db.clientReports.find((item) => item.id === reportResult.report.id)
  assert.strictEqual(report.brokerId, 'U2', '报备 brokerId 必须来自服务端当前用户')
  assert.strictEqual(report.needId, need.id, '报备必须绑定需求单')
  assert.ok(report.reportSnapshot && report.reportSnapshot.uploaderId === 'U1', '报备必须冻结房源快照')

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
  assert.strictEqual(confirmResult.commissionRecord.rate, 20, '二房东房源成交总比例必须固定 20%')
  assert.strictEqual(confirmResult.commissionRecord.uploaderRate, 15, '二房东房源上传人到手比例必须固定 15%')
  assert.strictEqual(confirmResult.commissionRecord.platformRate, 5, '二房东房源平台留存比例必须固定 5%')
  assert.strictEqual(confirmResult.commissionRecord.uploaderCommissionFen, 75000, '二房东房源上传人分佣必须等于房东实付佣金的 15%')
  assert.strictEqual(confirmResult.commissionRecord.platformCommissionFen, 25000, '二房东房源平台留存必须等于房东实付佣金的 5%')

  const ownerListing = domain.addNormalListing(db, 'U1', listingPayload({
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    roomNo: '902',
    roomNumber: '902',
    address: '杭州市上城区京漾东韵府1幢1单元902室',
    ownerType: '业主房源',
    houseSourceType: '业主房源',
    source: '业主房源',
    videoKey: 'house-videos/v1-acceptance/owner.mp4',
    commissionRate: 99
  }))
  const ownerRaw = db.listings.find((item) => item.id === ownerListing.id)
  assert.strictEqual(ownerRaw.commissionRate, 20, '业主房源分佣比例必须由后端固定为 20%')
  domain.reviewOwnerListing(db, 'ADMIN', ownerListing.id, { action: 'approve' })
  const ownerReportResult = domain.createClientReport(db, 'U2', ownerListing.id, {
    needId: need.id,
    customerPhone: '13800002222'
  })
  const ownerReport = db.clientReports.find((item) => item.id === ownerReportResult.report.id)
  const ownerDealResult = domain.createDealFromReport(db, 'U2', ownerReport.id, {
    monthlyRent: 3500,
    landlordCommission: 5000,
    commissionRate: 99
  })
  const ownerDeal = db.dealRecords.find((item) => item.id === ownerDealResult.deal.id)
  assert.ok(!Object.prototype.hasOwnProperty.call(ownerDeal, 'commissionRate'), '业主签单不能保存客户端 commissionRate')
  const ownerConfirm = domain.confirmDeal(db, 'ADMIN', ownerDeal.id)
  assert.strictEqual(ownerConfirm.commissionRecord.rate, 20, '业主房源成交总比例必须固定 20%')
  assert.strictEqual(ownerConfirm.commissionRecord.uploaderRate, 20, '业主房源上传人到手比例必须固定 20%')
  assert.strictEqual(ownerConfirm.commissionRecord.platformRate, 0, '业主房源平台留存比例必须固定 0%')
  assert.strictEqual(ownerConfirm.commissionRecord.uploaderCommissionFen, 100000, '业主房源上传人分佣必须等于房东实付佣金的 20%')
  assert.strictEqual(ownerConfirm.commissionRecord.platformCommissionFen, 0, '业主房源平台留存必须为 0')

  const beforeCompanyCommissionCount = db.commissionRecords.length
  const companyReportResult = domain.createClientReport(db, 'U2', companyNoVideo.id, {
    needId: need.id,
    customerPhone: '13800003333'
  })
  const companyReport = db.clientReports.find((item) => item.id === companyReportResult.report.id)
  const companyDealResult = domain.createDealFromReport(db, 'U2', companyReport.id, {
    monthlyRent: 3500,
    landlordCommission: 5000,
    commissionRate: 99
  })
  const companyDeal = db.dealRecords.find((item) => item.id === companyDealResult.deal.id)
  assert.deepStrictEqual(companyDeal.commissionRule, { rate: 0, uploaderRate: 0, platformRate: 0 }, '公司房源签单快照必须记录不分佣')
  const companyConfirm = domain.confirmDeal(db, 'ADMIN', companyDeal.id)
  assert.strictEqual(companyConfirm.commissionRecord, null, '公司房源确认签单不能生成分佣记录')
  assert.strictEqual(db.commissionRecords.length, beforeCompanyCommissionCount, '公司房源确认签单不能增加分佣记录')
})

check('首页公司房源表按房源行展示套数', () => {
  const indexWxml = readFile('pages/index/index.wxml')
  assertIncludes(indexWxml, 'sheetPreview.listingCount', '首页房源表计数必须使用房源行 listingCount')
  assertIncludes(indexWxml, '套房源', '首页房源表计数文案必须使用套房源口径')
  assert.ok(!indexWxml.includes('companySheetSnapshot.rowCount || 0}} 行内容'), '首页不能用原始快照行数展示公司房源数量')
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
  assertIncludes(readFile('utils/listing-display.js'), 'VERIFY_STALE_DAYS = 7', '前端展示工具必须固定第 7 天自动失效')
  assertIncludes(readFile('utils/mock-data.js'), 'VERIFY_STALE_DAYS = 7', 'Mock 数据必须固定第 7 天自动失效')
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

check('assistant feedback loop contract', () => {
  const matchChat = readFile('pages/match-chat/match-chat.js')
  const matchChatWxml = readFile('pages/match-chat/match-chat.wxml')
  const llmService = readFile('utils/llm-service.js')
  const apiService = readFile('utils/api-service.js')
  const serverIndex = readFile('server/src/index.js')
  const assistantServiceSource = readFile('server/src/assistant-service.js')
  const assistantFeedbackSource = readFile('server/src/assistant-feedback.js')
  const assistantEvalRunnerSource = readFile('server/scripts/assistant-eval-runner.js')
  const assistantDynamicEvalTestSource = readFile('server/scripts/assistant-dynamic-eval-test.js')
  const adminWebSource = readFile('admin-web/index.html')

  assertIncludes(matchChat, 'submitAssistantFeedback', 'match-chat must submit assistant feedback')
  assertIncludes(matchChat, 'canFeedback', 'match-chat must gate feedback by assistant message state')
  assertIncludes(matchChatWxml, 'data-type="bad_recommendation"', 'match-chat must expose bad recommendation feedback')
  assertIncludes(matchChatWxml, 'data-type="helpful"', 'match-chat must expose helpful feedback')
  assertIncludes(llmService, '/mini/assistant/feedback', 'llm-service must call assistant feedback endpoint')
  assertIncludes(llmService, 'submitAssistantFeedback', 'llm-service must export submitAssistantFeedback')
  assertIncludes(apiService, 'submitAssistantFeedback', 'api-service must export submitAssistantFeedback')
  assertIncludes(serverIndex, '/mini/assistant/feedback', 'server must expose mini feedback endpoint')
  assertIncludes(serverIndex, '/admin/assistant/feedbacks', 'server must expose admin feedback list endpoint')
  assertIncludes(serverIndex, '/admin/assistant/eval-cases', 'server must expose assistant eval case list endpoint')
  assertIncludes(serverIndex, 'promote-eval', 'server must expose feedback to eval promotion endpoint')
  assertIncludes(assistantServiceSource, 'lastTraceSummary', 'feedback must attach server-side trace summary')
  assertIncludes(assistantServiceSource, 'promoteFeedbackToEvalCase', 'assistant service must support feedback to eval promotion')
  assertIncludes(assistantFeedbackSource, 'safeListings', 'feedback must whitelist listing fields')
  assertIncludes(assistantFeedbackSource, 'safePlaceResolution', 'feedback must whitelist place resolution fields')
  assertIncludes(assistantFeedbackSource, 'assistantEvalCases', 'feedback promotion must persist assistant eval cases')
  assertIncludes(assistantEvalRunnerSource, 'assistantEvalCases', 'eval runner must read assistant eval cases')
  assertIncludes(assistantEvalRunnerSource, 'runDynamicEvalCases', 'eval runner must execute dynamic eval cases')
  assertIncludes(assistantEvalRunnerSource, 'runDynamicEvalCase', 'eval runner must expose single dynamic eval execution')
  assertIncludes(assistantDynamicEvalTestSource, 'AEC-RECOMMEND-WANDA', 'dynamic eval test must cover recommendation sample')
  assertIncludes(assistantDynamicEvalTestSource, 'AEC-FOLLOWUP-MISSING-PLACE', 'dynamic eval test must cover follow-up sample')
  assertIncludes(adminWebSource, 'data-panel="assistantFeedback"', 'admin web must expose assistant feedback panel')
  assertIncludes(adminWebSource, 'assistant-feedback-eval-button', 'admin web must support promoting feedback to eval')
})

check('assistant llm config tests LangGraph chain', () => {
  const serverIndex = readFile('server/src/index.js')
  const llmSource = readFile('server/src/llm.js')
  const assistantGraphSource = readFile('server/src/assistant/graph.js')
  const needParserSource = readFile('server/src/assistant/need-parser.js')
  const llmReplySource = readFile('server/src/assistant/llm-reply.js')
  const adminWebSource = readFile('admin-web/index.html')
  const llmConfigTestSource = readFile('server/scripts/assistant-llm-config-test.js')

  assertIncludes(serverIndex, "pathname === '/admin/llm-config/test'", 'admin must expose LLM config test endpoint')
  assertIncludes(serverIndex, 'needParserModel', 'LLM config must persist parser model')
  assertIncludes(serverIndex, 'complexNeedParserModel', 'LLM config must persist complex parser model')
  assertIncludes(serverIndex, 'replyModel', 'LLM config must persist reply model')
  assertIncludes(llmSource, 'configForTask', 'LLM provider must support task-level model routing')
  assertIncludes(needParserSource, 'configForTask(config, parserTask)', 'need parser must use parser model routing')
  assertIncludes(needParserSource, 'shouldUseComplexNeedParser', 'need parser must detect complex intent cases')
  assertIncludes(llmReplySource, "configForTask(config, 'reply_writer')", 'reply writer must use reply model routing')
  assertIncludes(serverIndex, 'assistantService.chat(tempDb', 'LLM config test must call assistant LangGraph chain')
  assertIncludes(serverIndex, 'debugTrace: true', 'LLM config test must return trace summary')
  assertIncludes(assistantGraphSource, 'needParserMode', 'assistant response must expose parser mode for admin LLM test')
  assertIncludes(assistantGraphSource, 'llmWarning', 'assistant response must expose LLM warning for admin LLM test')
  assertIncludes(assistantGraphSource, 'llm_reply_writer', 'assistant graph must expose LLM reply writer node')
  assertIncludes(assistantGraphSource, 'trace_logger', 'assistant graph must expose trace logger node')
  assertIncludes(adminWebSource, '/mini/assistant/chat', 'admin LLM config must point mini program to assistant chat endpoint')
  assertIncludes(adminWebSource, 'llmNeedParserModel', 'admin LLM config must expose parser model field')
  assertIncludes(adminWebSource, 'llmComplexNeedParserModel', 'admin LLM config must expose complex parser model field')
  assertIncludes(adminWebSource, 'llmReplyModel', 'admin LLM config must expose reply model field')
  assertIncludes(adminWebSource, 'needParserMode', 'admin LLM config test must display need parser mode')
  assertIncludes(adminWebSource, 'replyMode', 'admin LLM config test must display reply mode')
  assertIncludes(llmConfigTestSource, 'online-test-provider', 'assistant LLM config test must simulate an online provider')
  assertIncludes(llmConfigTestSource, 'test-parser-model', 'assistant LLM config test must verify parser model routing')
  assertIncludes(llmConfigTestSource, 'test-complex-parser-model', 'assistant LLM config test must verify complex parser model routing')
  assertIncludes(llmConfigTestSource, 'test-reply-model', 'assistant LLM config test must verify reply model routing')
  assertIncludes(llmConfigTestSource, 'llm_need_parser', 'assistant LLM config test must assert parser trace node')
  assertIncludes(llmConfigTestSource, 'llm_reply_writer', 'assistant LLM config test must assert reply trace node')
})

check('mini program voice input uses Bailian ASR', () => {
  const voiceInputSource = readFile('utils/voice-input.js')
  const apiServiceSource = readFile('utils/api-service.js')
  const serverIndexSource = readFile('server/src/index.js')
  const asrServiceSource = readFile('server/src/asr-service.js')
  const asrRealtimeSource = readFile('server/src/asr-realtime.js')
  const multipartSource = readFile('server/src/multipart.js')
  const asrServiceTestSource = readFile('server/scripts/asr-service-test.js')
  const asrRealtimeTestSource = readFile('server/scripts/asr-realtime-proxy-test.js')
  const packageSource = readFile('server/package.json')

  assertIncludes(voiceInputSource, 'wx.getRecorderManager', 'mini voice input must use WeChat recorder')
  assertIncludes(voiceInputSource, 'onFrameRecorded', 'mini voice input must send realtime audio frames')
  assertIncludes(voiceInputSource, "format: 'PCM'", 'mini realtime ASR must record PCM frames')
  assertIncludes(voiceInputSource, 'frameSize', 'mini realtime ASR must enable recorder frame callback')
  assert.ok(!voiceInputSource.includes('WechatSI'), 'mini voice input must not depend on WechatSI')
  assert.ok(!voiceInputSource.includes('getRecordRecognitionManager'), 'mini voice input must remove old recognition manager')
  assertIncludes(voiceInputSource, 'createRealtimeAsrSocket', 'mini voice input must connect realtime ASR socket')
  assertIncludes(voiceInputSource, 'onRecognize', 'mini voice input must stream captions to page')
  assertIncludes(voiceInputSource, 'onTranscribing', 'mini voice input must expose transcribing state')
  assertIncludes(apiServiceSource, '/mini/asr/realtime', 'api service must expose realtime ASR socket url')
  assertIncludes(apiServiceSource, 'createRealtimeAsrSocket', 'api service must create realtime ASR socket')
  assertIncludes(apiServiceSource, '/mini/asr/transcribe', 'api service must call Bailian ASR backend proxy')
  assertIncludes(apiServiceSource, 'mock-qwen3-asr-flash', 'api service mock must preserve ASR contract')
  assertIncludes(serverIndexSource, 'attachRealtimeAsr', 'server must attach realtime ASR websocket proxy')
  assertIncludes(serverIndexSource, "pathname === '/mini/asr/transcribe'", 'server must expose mini ASR endpoint')
  assertIncludes(serverIndexSource, 'parseMultipartForm', 'server ASR endpoint must parse uploadFile multipart body')
  assertIncludes(serverIndexSource, 'asrService.transcribeAudio', 'server ASR endpoint must call ASR service')
  assertIncludes(serverIndexSource, '百炼 ASR 语音识别', 'launch check must expose Bailian ASR status')
  assertIncludes(serverIndexSource, 'asrStatus.secretName', 'env template must include ASR server-side secret')
  assertIncludes(asrRealtimeSource, 'qwen3-asr-flash-realtime', 'realtime ASR proxy must use Bailian realtime model')
  assertIncludes(asrRealtimeSource, 'input_audio_buffer.append', 'realtime ASR proxy must append audio frames')
  assertIncludes(asrRealtimeSource, 'session.update', 'realtime ASR proxy must configure transcription session')
  assertIncludes(asrRealtimeSource, 'Authorization', 'realtime ASR key must stay server side')
  assertIncludes(asrServiceSource, 'qwen3-asr-flash', 'ASR service must use Bailian qwen3-asr-flash by default')
  assertIncludes(asrServiceSource, 'input_audio', 'ASR service must send OpenAI compatible audio content')
  assertIncludes(asrServiceSource, 'data:${audio.mimeType};base64', 'ASR service must send local audio as Data URL')
  assertIncludes(asrServiceSource, 'ASR_API_KEY', 'ASR key must stay server side')
  assertIncludes(asrServiceSource, 'LLM_API_KEY', 'ASR service must be able to reuse existing Bailian LLM key')
  assertIncludes(multipartSource, 'parseMultipartForm', 'multipart upload parser must exist without adding production dependencies')
  assertIncludes(asrServiceTestSource, 'Bearer test-asr-key', 'ASR service test must verify server-side authorization header')
  assertIncludes(asrRealtimeTestSource, 'qwen3-asr-flash-realtime', 'realtime ASR proxy test must verify realtime model')
  assertIncludes(packageSource, '"ws"', 'server must include websocket dependency for realtime ASR proxy')
})

check('assistant provider protocol contract', () => {
  const llmSource = readFile('server/src/llm.js')
  const providerProtocolTestSource = readFile('server/scripts/llm-provider-protocol-test.js')

  assertIncludes(llmSource, 'buildProviderRequestBody', 'LLM provider must build request body by protocol')
  assertIncludes(llmSource, "protocol === 'responses-compatible'", 'LLM provider must support responses-compatible')
  assertIncludes(llmSource, "protocol === 'custom-json'", 'LLM provider must support custom-json')
  assertIncludes(llmSource, 'extractProviderText', 'LLM provider must expose response text extraction')
  assertIncludes(providerProtocolTestSource, 'openai-compatible', 'provider protocol test must cover openai-compatible')
  assertIncludes(providerProtocolTestSource, 'responses-compatible', 'provider protocol test must cover responses-compatible')
  assertIncludes(providerProtocolTestSource, 'custom-json', 'provider protocol test must cover custom-json')
  assertIncludes(providerProtocolTestSource, 'Authorization', 'provider protocol test must verify server-side key header')
})

check('assistant trace audit contract', () => {
  const traceLoggerSource = readFile('server/src/assistant/trace-logger.js')
  const assistantFeedbackSource = readFile('server/src/assistant-feedback.js')
  const assistantServiceSource = readFile('server/src/assistant-service.js')
  const serverIndexSource = readFile('server/src/index.js')
  const adminWebSource = readFile('admin-web/index.html')
  const traceAuditTestSource = readFile('server/scripts/assistant-trace-audit-test.js')
  const traceLogTestSource = readFile('server/scripts/assistant-trace-log-test.js')

  assertIncludes(traceLoggerSource, 'buildTraceAudit', 'trace summary must build audit fields')
  assertIncludes(traceLoggerSource, 'toolInput', 'trace audit must include tool input')
  assertIncludes(traceLoggerSource, 'toolOutput', 'trace audit must include tool output')
  assertIncludes(traceLoggerSource, 'shouldAskFollowUp', 'trace audit must include follow-up decision')
  assertIncludes(traceLoggerSource, 'finalReply', 'trace audit must include final reply')
  assertIncludes(assistantFeedbackSource, 'traceSummary.audit', 'feedback must preserve trace audit')
  assertIncludes(assistantFeedbackSource, 'assistantTraceLogs', 'assistant must persist every chat trace log')
  assertIncludes(assistantServiceSource, 'createAssistantTraceLog', 'assistant service must record trace logs after chat')
  assertIncludes(assistantServiceSource, 'traceRows', 'assistant service must expose trace log rows')
  assertIncludes(assistantServiceSource, 'traceSummaryForFeedback', 'feedback must fall back to persisted trace logs')
  assertIncludes(serverIndexSource, 'persistTrace', 'assistant chat endpoint must persist trace logs via a synchronous write outside the LLM await window')
  assertIncludes(serverIndexSource, '/admin/assistant/traces', 'admin must expose assistant trace logs')
  assertIncludes(adminWebSource, 'data-panel="assistantTraces"', 'admin web must expose assistant trace panel')
  assertIncludes(adminWebSource, '/admin/assistant/traces', 'admin web must load assistant trace logs')
  assertIncludes(adminWebSource, 'assistantTraceRows', 'admin web must render assistant trace rows')
  assertIncludes(adminWebSource, 'renderAssistantTraces', 'admin web must implement assistant trace renderer')
  assertIncludes(traceAuditTestSource, 'recommendText', 'trace audit test must cover recommendation query')
  assertIncludes(traceAuditTestSource, 'followUpText', 'trace audit test must cover follow-up query')
  assertIncludes(traceLogTestSource, '非 debug 小程序响应不应返回 traceSummary', 'trace log test must keep mini response clean')
  assertIncludes(traceLogTestSource, 'assistantTraceLogs', 'trace log test must assert persistent logs')
  assertIncludes(traceLogTestSource, '内存线程丢失后反馈仍应从持久 trace log 关联 trace audit', 'trace log test must cover feedback fallback after restart')
})

check('assistant ambiguous place gate contract', () => {
  const placeLocatorSource = readFile('server/src/place-locator.js')
  const matchServiceSource = readFile('server/src/match-service.js')
  const ambiguityTestSource = readFile('server/scripts/assistant-place-ambiguity-test.js')
  const assistantEvalRunnerSource = readFile('server/scripts/assistant-eval-runner.js')

  assertIncludes(placeLocatorSource, "status: 'ambiguous'", 'place locator must expose ambiguous status')
  assertIncludes(matchServiceSource, 'buildPlaceFollowUp', 'match service must build follow-up for unresolved places')
  assertIncludes(matchServiceSource, "resolution.status !== 'resolved'", 'match service must stop recommendation when place is not resolved')
  assertIncludes(ambiguityTestSource, "resolvePlace(db, '万达'", 'ambiguity test must cover direct place resolution')
  assertIncludes(ambiguityTestSource, '万达附近有哪些2000左右的单间', 'ambiguity test must cover natural language query')
  assertIncludes(ambiguityTestSource, "result.placeResolution.status, 'ambiguous'", 'ambiguity test must assert ambiguous chain state')
  assertIncludes(ambiguityTestSource, '地点歧义时不能静默推荐房源', 'ambiguity test must assert no silent recommendation')
  assertIncludes(assistantEvalRunnerSource, '万达多候选地点必须追问不能静默推荐', 'fixed eval must cover ambiguous place gate')
})

check('assistant coordinate safety contract', () => {
  const placeLocatorSource = readFile('server/src/place-locator.js')
  const coordinateSafetyTestSource = readFile('server/scripts/assistant-coordinate-safety-test.js')

  assertIncludes(placeLocatorSource, 'if (!isReliableCoordinateSource(source)) return null', 'assistant place locator must reject unreliable coordinate sources')
  assertIncludes(placeLocatorSource, 'if (verified === false) return null', 'assistant place locator must reject explicitly unverified coordinates')
  assertIncludes(coordinateSafetyTestSource, '默认中心大厦', 'coordinate safety test must cover default-center place anchor')
  assertIncludes(coordinateSafetyTestSource, '坏来源地点不能作为半径锚点', 'coordinate safety test must assert unsafe place anchors stop recommendation')
  assertIncludes(coordinateSafetyTestSource, '坏来源房源坐标不能混入半径结果', 'coordinate safety test must assert unsafe listing coordinates are excluded')
})

check('assistant conflict gate contract', () => {
  const confidenceGateSource = readFile('server/src/assistant/confidence-gate.js')
  const assistantEvalRunnerSource = readFile('server/scripts/assistant-eval-runner.js')

  assertIncludes(confidenceGateSource, '租法和户型冲突', 'confidence gate must detect rent mode and layout conflicts')
  assertIncludes(confidenceGateSource, '合租单间，还是整租一室', 'confidence gate must ask a precise conflict follow-up')
  assertIncludes(assistantEvalRunnerSource, '租法户型冲突必须追问不能直接查房', 'fixed eval must cover conflict follow-up gate')
  assertIncludes(assistantEvalRunnerSource, "!nodes.includes('ranking_tool')", 'conflict eval must assert no ranking before clarification')
})

check('assistant hard feature ranking contract', () => {
  const matchServiceSource = readFile('server/src/match-service.js')
  const assistantEvalRunnerSource = readFile('server/scripts/assistant-eval-runner.js')

  assertIncludes(matchServiceSource, 'hasHardFeatureMismatch', 'ranking must detect hard feature mismatches')
  assertIncludes(matchServiceSource, 'hardFeatureReasons.concat', 'ranking reasons must prioritize hard feature matches')
  assertIncludes(matchServiceSource, 'getFeatureRule(feature).missing', 'ranking must use feature missing facts')
  assertIncludes(assistantEvalRunnerSource, '硬性标签必须有燃气不能被接近房源软化', 'fixed eval must cover hard feature constraints')
  assertIncludes(assistantEvalRunnerSource, '有燃气', 'fixed eval must require feature reason in recommendation')
})

check('assistant budget boundary contract', () => {
  const matchServiceSource = readFile('server/src/match-service.js')
  const assistantEvalRunnerSource = readFile('server/scripts/assistant-eval-runner.js')

  assertIncludes(matchServiceSource, 'allowedBudgetOverage', 'ranking must only allow over-budget listings when budget tolerance exists')
  assertIncludes(matchServiceSource, 'exceedsBudgetOverage', 'ranking must block over-budget nearby listings for strict within-budget asks')
  assertIncludes(assistantEvalRunnerSource, '预算4000内不返回低于75%的房源', 'fixed eval must cover strict budget lower bound')
  assertIncludes(assistantEvalRunnerSource, '4000以内不应返回超预算房源', 'fixed eval must cover strict budget upper bound')
})

check('assistant community fallback boundary contract', () => {
  const matchServiceSource = readFile('server/src/match-service.js')
  const assistantEvalRunnerSource = readFile('server/scripts/assistant-eval-runner.js')

  assertIncludes(matchServiceSource, 'explicitCommunity && exact.length', 'ranking must not mix nearby communities when explicit community has exact results')
  assertIncludes(matchServiceSource, 'shouldUseCommunityAdjacentFallback', 'ranking must still support adjacent fallback when explicit community has no exact result')
  assertIncludes(assistantEvalRunnerSource, '相近小区杨乐府不能被纠成杨家府', 'fixed eval must cover similar community boundary')
  assertIncludes(assistantEvalRunnerSource, '不能把杨家府房源当作杨乐府结果', 'similar community eval must reject nearby wrong community result')
  assertIncludes(assistantEvalRunnerSource, '本小区无房但有可靠坐标时推荐相邻小区', 'fixed eval must cover community adjacent fallback')
  assertIncludes(assistantEvalRunnerSource, '相邻小区应说明不在目标小区', 'community fallback eval must require difference explanation')
})

check('assistant listing explanation contract', () => {
  const matchServiceSource = readFile('server/src/match-service.js')
  const assistantEvalRunnerSource = readFile('server/scripts/assistant-eval-runner.js')
  const matchChatWxml = readFile('pages/match-chat/match-chat.wxml')

  assertIncludes(matchServiceSource, '无明显差异', 'exact listings must still expose a difference explanation')
  assertIncludes(assistantEvalRunnerSource, '缺少推荐理由', 'fixed eval must require listing match reason')
  assertIncludes(assistantEvalRunnerSource, '缺少差异说明', 'fixed eval must require listing difference explanation')
  assertIncludes(matchChatWxml, 'listing.matchReason', 'mini program must render recommendation reason')
  assertIncludes(matchChatWxml, 'listing.differenceText', 'mini program must render difference explanation')
})

check('assistant output guard whitelist contract', () => {
  const safetySource = readFile('server/src/assistant/safety.js')
  const outputGuardTestSource = readFile('server/scripts/assistant-output-guard-test.js')

  assertIncludes(safetySource, 'safeTextArray', 'assistant safety must scrub array values recursively')
  assertIncludes(safetySource, "'latitude'", 'assistant safety must treat raw coordinates as sensitive')
  assertIncludes(outputGuardTestSource, 'assistant-output-guard-test passed', 'output guard test must exist')
  assertIncludes(outputGuardTestSource, 'landlordPhone', 'output guard test must cover landlord phone leakage')
  assertIncludes(outputGuardTestSource, 'videoSignedUrl', 'output guard test must cover signed video leakage')
  assertIncludes(outputGuardTestSource, 'latitude', 'output guard test must cover raw coordinate leakage')
  assertIncludes(outputGuardTestSource, 'features', 'output guard test must cover nested array values')
})

check('assistant no-result eval contract', () => {
  const assistantEvalRunnerSource = readFile('server/scripts/assistant-eval-runner.js')

  assertIncludes(assistantEvalRunnerSource, '已知地点完整条件无房时不能放宽乱推', 'fixed eval must cover complete no-result search')
  assertIncludes(assistantEvalRunnerSource, 'listingCount === 0', 'no-result eval must assert ranking output is empty')
  assertIncludes(assistantEvalRunnerSource, '条件完整但无房时不应误判成追问', 'no-result eval must distinguish no-result from follow-up')
  assertIncludes(assistantEvalRunnerSource, '无合适房源时不能返回接近房源乱推', 'no-result eval must prevent unsafe relaxed recommendation')
})

check('游客模式仅开放公司房源脱敏浏览', () => {
  const appSource = readFile('app.js')
  const dbSource = readFile('server/src/db.js')
  const domainSource = readFile('server/src/domain.js')
  const serverIndex = readFile('server/src/index.js')
  const apiClientSource = readFile('utils/api-client.js')
  const detailPageSource = readFile('pages/listing-detail/listing-detail.js')
  const finalAuditSource = readFile('server/scripts/v1-final-audit.js')
  const guestModeTestSource = readFile('server/scripts/guest-mode-v1-test.js')
  const authTokenTestSource = readFile('server/scripts/auth-token-v1-test.js')

  assert.ok(!appSource.includes("storedUserId || 'U001'"), '小程序启动不能给游客默认塞入 U001')
  assert.ok(!dbSource.includes('getCurrentUserId'), '服务端不能继续从 X-User-Id 或 db.currentUserId 推导小程序用户')
  assert.ok(!domainSource.includes('db.currentUserId ='), '服务端登录/注册不能继续写入旧 currentUserId 会话字段')
  assert.ok(!apiClientSource.includes('X-User-Id'), '小程序请求层不能继续发送 X-User-Id')
  assertIncludes(serverIndex, 'AUTH_TOKEN_SECRET', '小程序登录 token 必须使用服务端环境变量密钥')
  assertIncludes(serverIndex, 'function verifyMiniAuthToken', '服务端必须校验小程序 token 签名和过期时间')
  assertIncludes(serverIndex, 'function miniUserIdFromRequest', '服务端必须从 Authorization Bearer token 解析小程序用户')
  assertIncludes(serverIndex, 'bearerTokenFromRequest(req)', '小程序鉴权必须读取 Authorization Bearer token')
  assertIncludes(domainSource, 'function isCompanyOnlyFilter', '领域层必须支持公司房源专用过滤')
  assertIncludes(domainSource, 'companyOnly && !isCompanyListing', '匿名过滤必须排除非公司房源')
  assertIncludes(serverIndex, 'function assertMiniLogin', '受保护接口必须有统一登录拦截')
  assertIncludes(serverIndex, 'function assertGuestRateLimit', '匿名 GET/助手接口必须限频')
  assertIncludes(serverIndex, 'function guestListingFilter', '匿名列表和地图必须强制公司房源过滤')
  assertIncludes(serverIndex, 'function guestCompanySheetSnapshot', '匿名飞书快照必须返回脱敏版本')
  assertIncludes(serverIndex, 'assistantService.chat(companyOnlyDb(snapshot)', '匿名找房助手候选必须只来自公司房源（在 clone 的私有快照上）')
  assertIncludes(serverIndex, 'assertGuestListingAllowed(detail)', '匿名详情必须拦截合作房源')
  assertIncludes(detailPageSource, "promptLoginGuide('登录后查看合作房源'", '前端触碰合作房源详情必须弹登录引导')
  assertIncludes(guestModeTestSource, '匿名列表接口应返回 200', '游客模式测试必须覆盖匿名列表')
  assertIncludes(guestModeTestSource, '匿名飞书快照应返回看房密码', '游客模式测试必须覆盖公司房源快照对游客完整开放（公司房源完整字段公开，含看房密码/电话）')
  assertIncludes(guestModeTestSource, '匿名请求合作房源详情必须返回 401', '游客模式测试必须覆盖合作房源详情 401')
  assertIncludes(guestModeTestSource, '匿名不可调用敏感查看', '游客模式测试必须覆盖匿名敏感查看 401')
  assertIncludes(guestModeTestSource, '登录必须返回小程序 token', '游客模式测试必须改为 token 登录后访问合作房源')
  assertIncludes(authTokenTestSource, '伪造 X-User-Id 访问需登录接口必须返回 401', '鉴权测试必须覆盖伪造 X-User-Id 失效')
  assertIncludes(authTokenTestSource, '无 token 请求合作房源详情必须返回 401', '鉴权测试必须覆盖合作房源详情匿名 401')
  assertIncludes(authTokenTestSource, '有效 token 可访问需登录接口', '鉴权测试必须覆盖有效 token 正常访问')
  assertIncludes(authTokenTestSource, '过期 token 必须返回 401', '鉴权测试必须覆盖过期 token 401')
  assertIncludes(finalAuditSource, 'server/scripts/guest-mode-v1-test.js', '终审脚本必须运行游客模式真实路由测试')
  assertIncludes(finalAuditSource, 'server/scripts/auth-token-v1-test.js', '终审脚本必须运行小程序 token 鉴权测试')
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
