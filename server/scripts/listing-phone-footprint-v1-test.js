'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const config = require('../src/config')
const domain = require('../src/domain')

const rootDir = path.resolve(__dirname, '..', '..')

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '维护中介', role: '中介', authed: '手机号登录' },
      { id: 'U2', name: '查看中介', role: '中介', authed: '手机号登录' }
    ],
    listings: [],
    rentalNeeds: [{ id: 'N1', brokerId: 'U2', status: 'active', confirmedNeed: {} }],
    footprints: [],
    pointLogs: []
  }
}

function activeListing(overrides = {}) {
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
    area: '拱墅区',
    community: '测试小区',
    building: '1',
    unit: '1',
    roomNumber: '101',
    address: '测试地址',
    rent: 3000,
    layout: '整租一室一厅一卫',
    videoKey: 'house-videos/test/phone.mp4',
    landlordPhone: '19900000001',
    viewingMethod: '联系房东',
    landlordCommissionPercent: 50,
    ...overrides
  }
}

async function run() {
  // 1) 公司房源只下发环境配置中的第一个合法号码，绝不拼接多个号码或回退房源原始电话。
  const originalPhones = config.company.contactPhones
  config.company.contactPhones = ['invalid', '19900000001', '19900000002']
  try {
    const db = makeDb()
    db.listings.push(activeListing({
      companyListing: true,
      isCompanyListing: true,
      ownerType: '公司房源',
      source: '公司房源',
      videoKey: '',
      landlordPhone: '19900000003'
    }))
    const detail = domain.listingDetail(db, 'L1', 'U2')
    assert.deepStrictEqual(detail.companyContactPhones, ['19900000001'], '只允许返回第一个合法环境配置号码')
    assert.strictEqual(detail.companyContactPhoneText, '19900000001')
    assert.strictEqual(detail.landlordPhone, '19900000001')
    assert.ok(!JSON.stringify(detail).includes('19900000002'), '详情不得下发第二个公司号码')
    assert.ok(!JSON.stringify(detail).includes('19900000003'), '公司详情不得回退房源原始电话')
  } finally {
    config.company.contactPhones = originalPhones
  }

  // 2) 别人的合作房源必须先完成敏感查看；自己上传和公司房源可直接拨号，但都由服务端身份判定。
  const db = makeDb()
  db.listings.push(activeListing())
  assert.throws(
    () => domain.recordPhoneCallOpened(db, 'U2', 'L1', { idempotencyKey: 'call_denied_0001' }),
    (error) => error && error.statusCode === 403,
    '未获敏感信息权限的其他中介不得伪造拨号足迹'
  )

  domain.addSensitiveFootprint(db, 'U2', 'L1', { needId: 'N1', purpose: '带客户看房' })
  const first = domain.recordPhoneCallOpened(db, 'U2', 'L1', {
    idempotencyKey: 'call_allowed_0001',
    viewerId: 'EVIL_VIEWER',
    actionType: 'EVIL_ACTION',
    phone: '19900000009',
    address: '不应进入足迹'
  })
  assert.deepStrictEqual(Object.keys(first).sort(), ['actionType', 'id', 'idempotencyKey', 'listingId', 'occurredAt', 'viewerId'].sort(), '拨号足迹只能有六个最小字段')
  assert.strictEqual(first.viewerId, 'U2', '操作者只能来自服务端验签身份')
  assert.strictEqual(first.listingId, 'L1')
  assert.strictEqual(first.actionType, 'phone_call_opened')
  assert.strictEqual(first.idempotencyKey, 'call_allowed_0001')
  assert.ok(Number.isFinite(Date.parse(first.occurredAt)), '发生时间必须由服务端生成 ISO 时间')
  assert.ok(!JSON.stringify(first).includes('19900000009'), '足迹不得包含客户端号码')
  assert.ok(!JSON.stringify(first).includes('不应进入足迹'), '足迹不得包含地址')

  const personalRow = domain.footprintRecords(db, 'U2').find((item) => item.id === first.id)
  const adminRow = domain.adminLogs(db).find((item) => item.action === '电话查看（已打开系统拨号页）')
  assert.strictEqual(personalRow.status, '电话查看（已打开系统拨号页）', '中介足迹读取端必须识别六字段拨号动作')
  assert.strictEqual(personalRow.time, first.occurredAt, '中介足迹读取端必须展示服务端 ISO 时间')
  assert.ok(!personalRow.meta.includes('undefined'), '缺少旧 sync 字段时不得显示 undefined')
  assert.ok(adminRow, '后台足迹读取端必须识别六字段拨号动作')
  assert.strictEqual(adminRow.time, first.occurredAt, '后台足迹读取端必须展示服务端 ISO 时间')

  const duplicate = domain.recordPhoneCallOpened(db, 'U2', 'L1', { idempotencyKey: 'call_allowed_0001' })
  assert.deepStrictEqual(duplicate, first, '相同账号、房源、动作和幂等键必须返回同一足迹')
  assert.strictEqual(db.footprints.filter((item) => item.idempotencyKey === 'call_allowed_0001').length, 1, '重试不得重复写入')

  const own = domain.recordPhoneCallOpened(db, 'U1', 'L1', { idempotencyKey: 'call_own_0000001' })
  assert.strictEqual(own.viewerId, 'U1', '上传人可记录自己的拨号动作')

  assert.throws(
    () => domain.recordPhoneCallOpened(db, 'U1', 'L1', { idempotencyKey: '19900000009' }),
    (error) => error && error.statusCode === 400 && !String(error.message).includes('19900000009'),
    '幂等键不得把纯手机号伪装成不可读标识，错误消息也不得回显原文'
  )

  ;['钥匙', '密码', '联系房东'].forEach((viewingMethod, index) => {
    const listingId = `L-METHOD-${index}`
    db.listings.push(activeListing({ id: listingId, viewingMethod }))
    const record = domain.recordPhoneCallOpened(db, 'U1', listingId, { idempotencyKey: `call_method_000${index}` })
    assert.strictEqual(record.listingId, listingId, `${viewingMethod}方式也必须允许上传人拨号留痕`)
  })

  db.listings.push(activeListing({
    id: 'LC',
    companyListing: true,
    isCompanyListing: true,
    ownerType: '公司房源',
    source: '公司房源',
    videoKey: ''
  }))
  const beforeCompanyCallPhones = config.company.contactPhones
  config.company.contactPhones = ['19900000001']
  try {
    const company = domain.recordPhoneCallOpened(db, 'U2', 'LC', { idempotencyKey: 'call_company_001' })
    assert.strictEqual(company.listingId, 'LC', '公司房源无需先写敏感查看足迹')
  } finally {
    config.company.contactPhones = beforeCompanyCallPhones
  }

  const rawListing = db.listings.find((item) => item.id === 'L1')
  rawListing.lifecycleStatus = 'sold'
  rawListing.status = '已成交'
  const retryAfterSold = domain.recordPhoneCallOpened(db, 'U2', 'L1', { idempotencyKey: 'call_allowed_0001' })
  assert.deepStrictEqual(retryAfterSold, first, '首次成功后房态变化，相同幂等键仍必须返回原记录')
  assert.strictEqual(db.footprints.filter((item) => item.idempotencyKey === 'call_allowed_0001').length, 1, '房态变化后的重试不得重复写入')

  const secretKey = 'secret raw phone 19900000009'
  assert.throws(
    () => domain.recordPhoneCallOpened(db, 'U2', 'L1', { idempotencyKey: secretKey }),
    (error) => error && error.statusCode === 400 && !String(error.message).includes(secretKey),
    '非法幂等键应 fail-closed 且错误消息不得回显原文'
  )

  // 3) 客户端只在 wx.makePhoneCall.success 后入队；补发请求只含幂等键，本地队列也不保存电话/地址。
  const outbox = require('../../utils/footprint-outbox')
  const storage = {}
  global.wx = {
    getStorageSync(key) { return storage[key] },
    setStorageSync(key, value) { storage[key] = value }
  }
  const entry = outbox.enqueuePhoneCall({
    accountId: 'U2',
    listingId: 'L1',
    idempotencyKey: 'call_outbox_0001',
    phone: '19900000009',
    address: '不应保存'
  })
  assert.deepStrictEqual(Object.keys(entry).sort(), ['accountId', 'idempotencyKey', 'listingId'].sort(), '本地补发项只保留账号分区、房源和幂等键')
  assert.ok(!JSON.stringify(storage).includes('19900000009'), '本地队列不得保存号码')
  assert.ok(!JSON.stringify(storage).includes('不应保存'), '本地队列不得保存地址')

  let sent = null
  await outbox.flushPhoneCalls('U2', (listingId, idempotencyKey) => {
    sent = { listingId, idempotencyKey }
    return Promise.resolve({ ok: true })
  })
  assert.deepStrictEqual(sent, { listingId: 'L1', idempotencyKey: 'call_outbox_0001' }, '补发器只传房源 ID 和幂等键')
  assert.deepStrictEqual(outbox.pendingPhoneCalls('U2'), [], '发送成功后移除队列项')

  outbox.enqueuePhoneCall({ accountId: 'U2', listingId: 'L1', idempotencyKey: 'call_outbox_0002' })
  await outbox.flushPhoneCalls('U2', () => Promise.reject(new Error('network failed')))
  assert.strictEqual(outbox.pendingPhoneCalls('U2').length, 1, '网络失败必须保留同一幂等键等待重试')

  outbox.enqueuePhoneCall({ accountId: 'U1', listingId: 'L1', idempotencyKey: 'call_account_u1' })
  const u2PendingBefore = outbox.pendingPhoneCalls('U2').length
  const accountSends = []
  await outbox.flushPhoneCalls('U1', (listingId, idempotencyKey) => {
    accountSends.push({ listingId, idempotencyKey })
    return Promise.resolve()
  })
  assert.deepStrictEqual(accountSends, [{ listingId: 'L1', idempotencyKey: 'call_account_u1' }], '补发只能发送当前账号分区')
  assert.strictEqual(outbox.pendingPhoneCalls('U2').length, u2PendingBefore, '补发 U1 不得发送或删除 U2 队列')

  let quotaSendCount = 0
  global.wx = {
    getStorageSync() { return undefined },
    setStorageSync() { throw new Error('quota exceeded') }
  }
  outbox.enqueuePhoneCall({ accountId: 'U-QUOTA', listingId: 'L1', idempotencyKey: 'call_quota_0001' })
  assert.strictEqual(outbox.pendingPhoneCalls('U-QUOTA').length, 1, '持久化失败时必须保留进程内待发送项')
  await outbox.flushPhoneCalls('U-QUOTA', () => {
    quotaSendCount += 1
    return Promise.resolve()
  })
  assert.strictEqual(quotaSendCount, 1, '持久化失败后仍必须至少尝试一次服务端留痕')
  assert.strictEqual(outbox.pendingPhoneCalls('U-QUOTA').length, 0, '直接补发成功后应清理进程内兜底项')

  // 4) 行为化装载详情页：游客不拨号；三种方式均能打开拨号；fail/complete 不入队，只有 success 入队。
  const pageStorage = {}
  let makePhoneCallOptions = null
  let pageDefinition = null
  global.wx = {
    getStorageSync(key) { return pageStorage[key] },
    setStorageSync(key, value) { pageStorage[key] = value },
    hideShareMenu() {},
    makePhoneCall(options) { makePhoneCallOptions = options },
    showToast() {},
    showModal() {}
  }
  pageStorage.ynzy_auth_token = 'token-page-default'
  global.Page = (definition) => { pageDefinition = definition }
  const pageModulePath = require.resolve('../../pages/listing-detail/listing-detail')
  delete require.cache[pageModulePath]
  require(pageModulePath)
  delete global.Page
  assert.ok(pageDefinition && typeof pageDefinition.callLandlord === 'function', '必须能行为化装载详情页拨号处理器')

  function makePage(overrides = {}) {
    const page = Object.assign({}, pageDefinition)
    page.data = Object.assign({}, JSON.parse(JSON.stringify(pageDefinition.data)), {
      listing: { id: 'L-PAGE', landlordPhone: '19900000001', viewingMethod: '联系房东' },
      sensitiveVisible: true,
      currentUserId: 'U-PAGE',
      phoneCallBusy: false
    }, overrides)
    page.setData = function (next) { Object.assign(this.data, next) }
    page.promptLoginGuide = function () { this.loginPrompted = true }
    page.flushPhoneFootprints = function () { return Promise.resolve() }
    page.profileAuthToken = pageStorage.ynzy_auth_token
    return page
  }

  const guestPage = makePage({ currentUserId: '' })
  makePhoneCallOptions = null
  guestPage.callLandlord()
  assert.strictEqual(guestPage.loginPrompted, true, '游客点击公司/合作房源电话必须先引导登录')
  assert.strictEqual(makePhoneCallOptions, null, '游客不得直接打开系统拨号页')

  ;['钥匙', '密码', '联系房东'].forEach((viewingMethod, index) => {
    const accountId = `U-PAGE-${index}`
    const page = makePage({
      currentUserId: accountId,
      listing: { id: `L-PAGE-${index}`, landlordPhone: '19900000001', viewingMethod }
    })
    makePhoneCallOptions = null
    page.callLandlord()
    assert.ok(makePhoneCallOptions, `${viewingMethod}方式解锁电话后必须可打开系统拨号页`)
    const before = outbox.pendingPhoneCalls(accountId).length
    if (viewingMethod === '钥匙') makePhoneCallOptions.fail({ errMsg: 'cancel' })
    if (viewingMethod === '密码') makePhoneCallOptions.complete()
    if (viewingMethod === '联系房东') makePhoneCallOptions.success()
    if (viewingMethod !== '联系房东') {
      assert.strictEqual(outbox.pendingPhoneCalls(accountId).length, before, `${viewingMethod} fail/complete 不能产生拨号成功足迹`)
    } else {
      assert.strictEqual(outbox.pendingPhoneCalls(accountId).length, before + 1, '只有 success 回调可以入队拨号成功足迹')
    }
  })

  const switchedPage = makePage({ currentUserId: 'U-OLD' })
  switchedPage.authTokenSnapshot = 'old-token'
  switchedPage.listingId = 'L-PAGE'
  pageStorage.ynzy_auth_token = 'new-token'
  const switchedFlushes = []
  const switchedLoads = []
  switchedPage.flushPhoneFootprints = (accountId) => { switchedFlushes.push(accountId); return Promise.resolve() }
  switchedPage.loadListing = (listingId) => { switchedLoads.push(listingId) }
  switchedPage.onShow()
  assert.deepStrictEqual(switchedLoads, ['L-PAGE'], 'token 变化时必须先重新读取可信 profile')
  assert.deepStrictEqual(switchedFlushes, [], 'token 变化时不得用旧账号队列配新 token 补发')

  const dialSwitchAccount = 'U-DIAL-SWITCH'
  const dialSwitchPage = makePage({
    currentUserId: dialSwitchAccount,
    listing: { id: 'L-DIAL-SWITCH', landlordPhone: '19900000001', viewingMethod: '联系房东' }
  })
  dialSwitchPage.profileAuthToken = 'token-dial-old'
  pageStorage.ynzy_auth_token = 'token-dial-old'
  const dialSwitchFlushes = []
  dialSwitchPage.flushPhoneFootprints = (accountId) => {
    dialSwitchFlushes.push({ accountId, token: pageStorage.ynzy_auth_token })
    return Promise.resolve()
  }
  const dialSwitchBefore = outbox.pendingPhoneCalls(dialSwitchAccount).length
  makePhoneCallOptions = null
  dialSwitchPage.callLandlord()
  assert.ok(makePhoneCallOptions, '旧账号已验证资料应能发起系统拨号')
  pageStorage.ynzy_auth_token = 'token-dial-new'
  makePhoneCallOptions.success()
  assert.strictEqual(outbox.pendingPhoneCalls(dialSwitchAccount).length, dialSwitchBefore + 1, '换号前已成功打开的拨号必须留在旧账号补发分区')
  assert.deepStrictEqual(dialSwitchFlushes, [], '拨号 success 前换号时不得用新 token 立即补发旧账号足迹')

  const pageApiService = require('../../utils/api-service')
  const originalPageApi = {
    getListingDetail: pageApiService.getListingDetail,
    getListingLogs: pageApiService.getListingLogs,
    getProfileState: pageApiService.getProfileState
  }
  function deferred() {
    let resolve
    let reject
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    return { promise, resolve, reject }
  }
  const detailRequests = [deferred(), deferred()]
  const profileRequests = [deferred(), deferred()]
  let detailRequestIndex = 0
  let profileRequestIndex = 0
  pageApiService.getListingDetail = () => detailRequests[detailRequestIndex++].promise
  pageApiService.getListingLogs = () => Promise.resolve([])
  pageApiService.getProfileState = () => profileRequests[profileRequestIndex++].promise
  try {
    const racePage = makePage({ currentUserId: '' })
    const raceFlushes = []
    racePage.flushPhoneFootprints = (accountId) => {
      raceFlushes.push({ accountId, token: pageStorage.ynzy_auth_token })
      return Promise.resolve()
    }

    pageStorage.ynzy_auth_token = 'token-a'
    const loadA = racePage.loadListing('L-PAGE')
    pageStorage.ynzy_auth_token = 'token-b'
    const loadB = racePage.loadListing('L-PAGE')

    detailRequests[1].resolve({ id: 'L-PAGE', companyListing: true, videoUrl: '' })
    profileRequests[1].resolve({ user: { id: 'U-B', name: '账号B' } })
    await loadB
    detailRequests[0].resolve({ id: 'L-PAGE', companyListing: true, videoUrl: '' })
    profileRequests[0].resolve({ user: { id: 'U-A', name: '账号A' } })
    await loadA

    assert.strictEqual(racePage.data.currentUserId, 'U-B', '旧账号迟到响应不得覆盖新账号 profile')
    assert.deepStrictEqual(raceFlushes, [{ accountId: 'U-B', token: 'token-b' }], '乱序响应只能用最新账号与最新 token 补发一次')
  } finally {
    Object.assign(pageApiService, originalPageApi)
  }

  outbox.enqueuePhoneCall({ accountId: 'U-MID', listingId: 'L-MID-1', idempotencyKey: 'call_mid_flush_01' })
  outbox.enqueuePhoneCall({ accountId: 'U-MID', listingId: 'L-MID-2', idempotencyKey: 'call_mid_flush_02' })
  const firstMidRequest = deferred()
  const midCalls = []
  const originalRecordPhoneCallOpened = pageApiService.recordPhoneCallOpened
  pageApiService.recordPhoneCallOpened = (listingId, idempotencyKey) => {
    midCalls.push({ listingId, idempotencyKey, token: pageStorage.ynzy_auth_token })
    return midCalls.length === 1 ? firstMidRequest.promise : Promise.resolve()
  }
  try {
    const midPage = makePage({ currentUserId: 'U-MID' })
    midPage.flushPhoneFootprints = pageDefinition.flushPhoneFootprints
    pageStorage.ynzy_auth_token = 'token-mid-a'
    midPage.profileAuthToken = 'token-mid-a'
    const midFlush = midPage.flushPhoneFootprints('U-MID')
    assert.strictEqual(midCalls.length, 1, '第一项补发应立即使用启动账号 token')
    midPage.data.currentUserId = 'U-OTHER'
    pageStorage.ynzy_auth_token = 'token-mid-b'
    firstMidRequest.resolve({ ok: true })
    await midFlush
    assert.deepStrictEqual(midCalls, [{
      listingId: 'L-MID-1',
      idempotencyKey: 'call_mid_flush_01',
      token: 'token-mid-a'
    }], '首项等待期间换号后不得继续用新 token 发送旧账号第二项')
    assert.deepStrictEqual(outbox.pendingPhoneCalls('U-MID').map((item) => item.idempotencyKey), ['call_mid_flush_02'], '换号时未发送的旧账号项必须留在原分区')
  } finally {
    pageApiService.recordPhoneCallOpened = originalRecordPhoneCallOpened
  }

  const rateDb = makeDb()
  rateDb.listings.push(activeListing())
  domain.addSensitiveFootprint(rateDb, 'U2', 'L1', { idempotencyKey: 'sensitive_rate_seed' })
  for (let index = 0; index < 30; index += 1) {
    domain.recordPhoneCallOpened(rateDb, 'U2', 'L1', { idempotencyKey: `call_rate_${String(index).padStart(4, '0')}` })
  }
  const rowsBeforeRateLimit = rateDb.footprints.length
  assert.throws(
    () => domain.recordPhoneCallOpened(rateDb, 'U2', 'L1', { idempotencyKey: 'call_rate_blocked' }),
    (error) => error && error.statusCode === 429 && error.data && error.data.reason === 'FOOTPRINT_RATE_LIMITED',
    '同一已验签账号高频生成唯一拨号幂等键时必须由服务端限流'
  )
  assert.strictEqual(rateDb.footprints.length, rowsBeforeRateLimit, '限流请求不得继续扩大数据库')
  const retryAtLimit = domain.recordPhoneCallOpened(rateDb, 'U2', 'L1', { idempotencyKey: 'call_rate_0029' })
  assert.strictEqual(retryAtLimit.idempotencyKey, 'call_rate_0029', '达到上限后同幂等键重试仍应返回原记录')
  assert.strictEqual(rateDb.footprints.length, rowsBeforeRateLimit, '幂等重试不得因限流新增或丢失记录')

  const otherAccount = domain.recordPhoneCallOpened(rateDb, 'U1', 'L1', { idempotencyKey: 'call_rate_other_01' })
  assert.strictEqual(otherAccount.viewerId, 'U1', '一个账号达到上限不得连带封禁另一个已验签账号')
  const otherAction = domain.recordVideoShare(rateDb, 'U2', 'L1', {})
  assert.strictEqual(otherAction.message, '视频转发已留痕', '拨号动作达到上限不得连带封禁同账号的其他动作')

  rateDb.footprints.forEach((record) => {
    if (record.viewerId === 'U2' && record.actionType === 'phone_call_opened') {
      record.occurredAt = new Date(Date.now() - 61 * 1000).toISOString()
    }
  })
  const afterWindow = domain.recordPhoneCallOpened(rateDb, 'U2', 'L1', { idempotencyKey: 'call_rate_after_window' })
  assert.strictEqual(afterWindow.actionType, 'phone_call_opened', '一分钟窗口结束后必须自动恢复写入，不能退化为 90 天累计配额')

  delete global.wx

  const pageJs = fs.readFileSync(path.join(rootDir, 'pages/listing-detail/listing-detail.js'), 'utf8')
  const pageWxml = fs.readFileSync(path.join(rootDir, 'pages/listing-detail/listing-detail.wxml'), 'utf8')
  const apiSource = fs.readFileSync(path.join(rootDir, 'utils/api-service.js'), 'utf8')
  const serverSource = fs.readFileSync(path.join(rootDir, 'server/src/index.js'), 'utf8')
  assert.ok(pageJs.includes('wx.makePhoneCall'), '详情页必须调用微信拨号能力')
  assert.ok(/makePhoneCall[\s\S]*success[\s\S]*enqueuePhoneCall/.test(pageJs), '只有拨号 success 回调可以入队足迹')
  assert.ok(pageWxml.includes('bindtap="callLandlord"'), '详情页必须提供联系房东按钮')
  assert.ok(apiSource.includes('/phone-call-opened'), '客户端必须调用专用拨号成功接口')
  assert.ok(/recordPhoneCallOpened[\s\S]*data:\s*\{\s*idempotencyKey\s*\}/.test(apiSource), '拨号成功请求体只能包含幂等键')
  assert.ok(/phone-call-opened[\s\S]*assertMiniLogin\(userId\)[\s\S]*recordPhoneCallOpened/.test(serverSource), '拨号成功接口必须先强制验签登录')
  const routeBlock = serverSource.match(/const phoneCallOpenedMatch[\s\S]*?\n  }\n\n  const error =/)
  assert.ok(routeBlock, '服务端必须注册拨号成功路由')
  assert.ok(/\{\s*idempotencyKey:\s*body\.idempotencyKey\s*\}/.test(routeBlock[0]), '路由只允许把幂等键交给领域层')
  assert.ok(!/body\.(?:viewerId|userId|phone|landlordPhone|address|actionType|occurredAt)/.test(routeBlock[0]), '路由不得信任客户端身份、号码、地址、动作或时间')

  console.log('listing phone footprint v1 test passed')
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
