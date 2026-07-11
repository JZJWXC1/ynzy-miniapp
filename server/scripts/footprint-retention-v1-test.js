'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const domain = require('../src/domain')

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

function isoDaysAgo(days) {
  return new Date(now - days * DAY).toISOString()
}

function exact(id, viewerId, listingId, actionType, days) {
  return {
    id,
    viewerId,
    listingId,
    actionType,
    occurredAt: isoDaysAgo(days),
    idempotencyKey: `${id}_idempotency`
  }
}

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '上传人', role: '中介', authed: '已实名' },
      { id: 'U2', name: '查看人', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', isAdmin: true }
    ],
    listings: [{
      id: 'L1', uploaderId: 'U1', ownerType: '二房东房源', source: '二房东房源',
      status: '在租', lifecycleStatus: 'active', reviewStatus: '无需审核',
      communityMatched: true, city: '杭州', area: '拱墅区', community: '测试小区',
      block: '测试板块', building: '1', unit: '1', roomNumber: '101',
      address: '测试地址', rent: 3000, rentMode: '整租', room: '一室', hall: '1厅', bath: '1卫',
      features: ['无'], viewingMethod: '联系房东', landlordCommissionPercent: 50,
      landlordPhone: '19900000001', videoKey: 'house-videos/test.mp4'
    }],
    footprints: [],
    pointLogs: []
  }
}

function sourceJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceJavaScriptFiles(entryPath)
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : []
  })
}

assert.strictEqual(typeof domain.pruneExpiredFootprints, 'function', '必须导出 90 天足迹清理函数供锁内路由与演练复用')
assert.strictEqual(typeof domain.expiredFootprintCount, 'function', '必须提供无副作用的过期检测，避免每次读取都整库落盘')

{
  const db = makeDb()
  db.footprints = [
    exact('F-6', 'U2', 'L1', 'sensitive_view', 6.9),
    exact('F-EXACT-7', 'U2', 'L1', 'sensitive_view', 7),
    exact('F-7', 'U2', 'L1', 'sensitive_view', 7.1),
    exact('F-89', 'U2', 'L1', 'phone_call_opened', 89.9),
    exact('F-EXACT-90', 'U2', 'L1', 'phone_call_opened', 90),
    exact('F-90', 'U2', 'L1', 'phone_call_opened', 90.1),
    { id: 'F-LEGACY-OLD', viewerId: 'U2', listingId: 'L1', action: '查看地址和电话', time: '刚刚', dateKey: new Date(now - 91 * DAY).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) },
    { id: 'F-LEGACY', viewerId: 'U2', listingId: 'L1', action: '查看地址和电话', time: '无法解析的历史时间' }
  ]

  const brokerIds = domain.footprintRecords(db, 'U2', now).map((item) => item.id)
  assert.ok(brokerIds.includes('F-6'), '中介应看到最近 7 天足迹')
  assert.ok(brokerIds.includes('F-EXACT-7'), '恰好第 7 天的足迹仍应包含在中介闭区间内')
  assert.ok(!brokerIds.includes('F-7'), '中介不应看到超过 7 天足迹')
  assert.ok(!brokerIds.includes('F-LEGACY'), '无法证明在最近 7 天内的旧足迹不得下发给中介')

  const adminActions = domain.adminLogs(db, now).map((item) => item.id)
  assert.ok(adminActions.includes('F-89'), '后台应看到未满 90 天足迹')
  assert.ok(adminActions.includes('F-EXACT-90'), '恰好第 90 天的足迹仍应包含在后台闭区间内')
  assert.ok(adminActions.includes('F-LEGACY'), '无法解析时间的历史足迹应由后台保守留存并可读')
  assert.ok(!adminActions.includes('F-90'), '后台不应返回超过 90 天足迹')

  const removed = domain.pruneExpiredFootprints(db, now)
  assert.strictEqual(removed, 2, '应物理清理 ISO 或旧 dateKey 可解析且超过 90 天的记录')
  assert.ok(db.footprints.some((item) => item.id === 'F-7'), '第 7 天记录不得物理删除')
  assert.ok(db.footprints.some((item) => item.id === 'F-89'), '90 天内审计证据不得物理删除')
  assert.ok(db.footprints.some((item) => item.id === 'F-EXACT-90'), '恰好第 90 天的审计证据不得物理删除')
  assert.ok(db.footprints.some((item) => item.id === 'F-LEGACY'), '无法解析时间的历史记录必须保守保留')
  assert.ok(!db.footprints.some((item) => item.id === 'F-90'), '超过 90 天记录应被物理清理')
  assert.ok(!db.footprints.some((item) => item.id === 'F-LEGACY-OLD'), 'time=刚刚 的旧记录必须回退 dateKey 判断，不得永久绕过清理')
}

{
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
  const helperStart = indexSource.indexOf('function readFootprintsWithLockedPrune')
  const helperBlock = indexSource.slice(helperStart, helperStart + 500)
  assert.ok(/expiredFootprintCount\(snapshot\)\s*===\s*0/.test(helperBlock), '无过期足迹时必须走纯读路径')
  assert.ok(/dbStore\.updateDb/.test(helperBlock) && /pruneExpiredFootprints\(nextDb\)/.test(helperBlock), '命中过期足迹时必须在数据库写锁内物理清理')
}

{
  const sourceDir = path.join(__dirname, '..', 'src')
  const sourceFiles = sourceJavaScriptFiles(sourceDir)
  const directWrites = sourceFiles.flatMap((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8')
    return (source.match(/\.footprints\.(?:unshift|push)\(/g) || []).map((match) => ({ filePath, match }))
  })
  assert.strictEqual(directWrites.length, 1, 'server/src 全局只能由 domain 统一入口直接写 footprints 数组')
  assert.strictEqual(path.basename(directWrites[0].filePath), 'domain.js', '任何同步模块都不得旁路写足迹')
  const domainSource = fs.readFileSync(directWrites[0].filePath, 'utf8')
  const writerStart = domainSource.indexOf('function pushFootprint')
  const writerEnd = domainSource.indexOf('\n}', writerStart)
  const directWriteAt = domainSource.search(/\.footprints\.(?:unshift|push)\(/)
  assert.ok(writerStart >= 0 && writerEnd > writerStart && directWriteAt > writerStart && directWriteAt < writerEnd, '唯一数组写点必须位于 pushFootprint 统一函数体内')
}

{
  const db = makeDb()
  db.showingUploads = []
  domain.verifyListingAvailability(db, 'U1', 'L1')
  domain.updateListingCoordinate(db, 'ADMIN', 'L1', { latitude: 30.3, longitude: 120.2 })
  domain.setCommissionConfig(db, 'ADMIN', { secondLandlordRate: 20, ownerRate: 20 })
  domain.recordVideoShare(db, 'U2', 'L1', {})
  const showing = domain.recordShowing(db, 'U2', 'L1', { photoKey: 'showing-proof/synthetic.jpg' }).showing
  domain.reviewShowingUpload(db, 'ADMIN', showing.id, { action: 'approve' })
  domain.submitListingVerification(db, 'U1', 'L1', '已出租')
  domain.restoreExpiredListing(db, 'ADMIN', 'L1')
  domain.updateNormalListing(db, 'ADMIN', 'L1', { status: '待确认' }, { admin: true })
  domain.recordSystemFootprint(db, 'ADMIN', 'L1', 'listing_feishu_removed')

  const exactKeys = ['id', 'viewerId', 'listingId', 'actionType', 'occurredAt', 'idempotencyKey'].sort()
  db.footprints.forEach((record) => {
    assert.deepStrictEqual(Object.keys(record).sort(), exactKeys, `${record.actionType} 必须严格六字段`)
    assert.ok(Number.isFinite(Date.parse(record.occurredAt)), `${record.actionType} 必须使用服务端 ISO 时间`)
    assert.notStrictEqual(record.actionType, 'listing_activity', '核心业务动作不得退化为泛化 actionType')
  })
  const actionTypes = new Set(db.footprints.map((item) => item.actionType))
  ;[
    'listing_verified',
    'listing_coordinate_updated',
    'commission_config_updated',
    'video_shared',
    'showing_verified',
    'listing_expired',
    'listing_restored',
    'listing_status_updated',
    'listing_feishu_removed'
  ].forEach((actionType) => assert.ok(actionTypes.has(actionType), `缺少 ${actionType} 六字段行为回归`))
}

{
  const db = makeDb()
  for (let index = 0; index < 5105; index += 1) {
    db.footprints.push(exact(`F-BULK-${index}`, 'U2', 'L1', 'sensitive_view', 1))
  }
  domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey: 'sensitive_bulk_new1' })
  assert.strictEqual(db.footprints.length, 5106, '90 天内足迹不得再按旧行数上限截断')
}

console.log('footprint-retention-v1-test: ok')
