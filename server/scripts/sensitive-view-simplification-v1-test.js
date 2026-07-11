'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const domain = require('../src/domain')

const rootDir = path.resolve(__dirname, '..', '..')

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '上传人', role: '中介', authed: '已实名' },
      { id: 'U2', name: '查看人', role: '中介', authed: '已实名' }
    ],
    listings: [{
      id: 'L1', uploaderId: 'U1', ownerType: '二房东房源', source: '二房东房源',
      status: '在租', lifecycleStatus: 'active', reviewStatus: '无需审核',
      communityMatched: true, city: '杭州', area: '拱墅区', community: '测试小区',
      building: '1', unit: '1', roomNumber: '101', address: '测试地址', rent: 3000,
      landlordPhone: '19900000001', viewingMethod: '联系房东', videoKey: 'house-videos/test.mp4'
    }],
    rentalNeeds: [],
    footprints: [],
    pointLogs: []
  }
}

{
  const db = makeDb()
  domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey: 'sensitive_yesterday_01' })
  db.footprints[0].occurredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey: 'sensitive_today_0001' })
  assert.strictEqual(db.footprints.length, 2, '跨上海自然日后同一房源应允许新增一条当天审计足迹')
  assert.strictEqual(db.listings[0].sensitiveViews, 2, '跨自然日的新查看应正常累计一次查看次数')
}

{
  const db = makeDb()
  const idempotencyKey = 'sensitive_midnight_retry'
  const first = domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey })
  db.footprints[0].occurredAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  for (let index = 0; index < 30; index += 1) {
    db.footprints.push({
      id: `F-RATE-${index}`,
      viewerId: 'U2',
      listingId: `L-RATE-${index}`,
      actionType: 'sensitive_view',
      occurredAt: new Date().toISOString(),
      idempotencyKey: `sensitive_rate_${String(index).padStart(4, '0')}`
    })
  }
  const before = db.footprints.length
  const retry = domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey })
  assert.deepStrictEqual(retry.sensitive, first.sensitive, '服务端已写但响应跨午夜丢失时，同键重试应返回原成功结果')
  assert.strictEqual(db.footprints.length, before, '跨自然日同键重试必须优先于当日额度和速率限制且不得新增记录')
  assert.strictEqual(db.footprints.filter((item) => item.idempotencyKey === idempotencyKey).length, 1, '同一敏感查看幂等键全局只能保存一条')
  assert.strictEqual(db.listings[0].sensitiveViews, 1, '跨自然日同键重试不得重复增加查看次数')
}

{
  const db = makeDb()
  const idempotencyKey = 'sensitive_revoked_retry'
  domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey })
  const viewer = db.users.find((item) => item.id === 'U2')
  viewer.role = '访客'
  viewer.authed = '未实名'
  const before = db.footprints.length
  assert.throws(
    () => domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey }),
    (error) => error && error.statusCode === 403 && /实名/.test(error.message),
    '同键重试仍必须按服务端当前账号角色与实名状态重新校验资格'
  )
  assert.strictEqual(db.footprints.length, before, '资格撤销后的同键重试不得修改足迹')
}

{
  const db = makeDb()
  const result = domain.addSensitiveFootprint(db, 'U2', 'L1', {
    idempotencyKey: 'sensitive_view_0001',
    needId: 'EVIL-NEED',
    purpose: '不应保存的用途',
    viewerId: 'EVIL-VIEWER',
    actionType: 'EVIL-ACTION'
  })
  assert.strictEqual(result.sensitive.address, '测试地址', '有效账号二次确认后应直接获得敏感信息')
  assert.strictEqual(db.footprints.length, 1, '他人首次查看应留一条足迹')
  const record = db.footprints[0]
  assert.deepStrictEqual(
    Object.keys(record).sort(),
    ['id', 'viewerId', 'listingId', 'actionType', 'occurredAt', 'idempotencyKey'].sort(),
    '新敏感查看足迹必须严格只有六个字段'
  )
  assert.strictEqual(record.viewerId, 'U2', '查看人只能来自服务端验签身份')
  assert.strictEqual(record.actionType, 'sensitive_view', '动作只能由服务端固定')
  assert.strictEqual(record.idempotencyKey, 'sensitive_view_0001')
  assert.ok(Number.isFinite(Date.parse(record.occurredAt)), '发生时间必须为服务端 ISO 时间')
  assert.ok(!JSON.stringify(record).includes('EVIL-NEED'), '新足迹不得保存 needId')
  assert.ok(!JSON.stringify(record).includes('不应保存的用途'), '新足迹不得保存 purpose')

  const duplicate = domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey: 'sensitive_view_0001' })
  assert.strictEqual(db.footprints.length, 1, '同一幂等键重试不得重复计数')
  assert.deepStrictEqual(duplicate.sensitive, result.sensitive, '幂等重试应返回同一敏感信息结果')

  const duplicateWithNewKey = domain.addSensitiveFootprint(db, 'U2', 'L1', { idempotencyKey: 'sensitive_view_0002' })
  assert.strictEqual(db.footprints.length, 1, '同一账号同一房源同一自然日更换幂等键也不得重复写足迹')
  assert.strictEqual(db.listings[0].sensitiveViews, 1, '同一自然日重复确认不得放大敏感查看次数')
  assert.deepStrictEqual(duplicateWithNewKey.sensitive, result.sensitive, '自然日去重仍应返回同一套敏感信息')

  const beforeOwn = db.footprints.length
  const own = domain.addSensitiveFootprint(db, 'U1', 'L1', { idempotencyKey: 'sensitive_view_own1' })
  assert.strictEqual(own.sensitive.ownListing, true, '上传人自查应由服务端直接判定')
  assert.strictEqual(db.footprints.length, beforeOwn, '上传人自查不得留痕')
}

{
  const indexSource = fs.readFileSync(path.join(rootDir, 'server/src/index.js'), 'utf8')
  const start = indexSource.indexOf("if (method === 'POST' && sensitiveMatch)")
  const block = indexSource.slice(start, start + 600)
  assert.ok(block.includes('idempotencyKey: body.idempotencyKey'), '敏感查看路由只应透传幂等键')
  ;['needId:', 'rentalNeedId:', 'clientNeedId:', 'purpose:', 'scene:', 'reason:', 'viewerId:', 'actionType:'].forEach((field) => {
    assert.ok(!block.includes(field), `敏感查看路由不得透传客户端 ${field}`)
  })

  const wxml = fs.readFileSync(path.join(rootDir, 'pages/listing-detail/listing-detail.wxml'), 'utf8')
  assert.ok(wxml.includes('确认查看'), '详情页必须保留二次确认')
  assert.ok(!/sensitivePurpose|purpose-options|need-bind-row/.test(wxml), '二次确认不得再要求需求单或查看用途')
}

async function verifyClientRetryIdempotency() {
  const apiService = require('../../utils/api-service')
  assert.strictEqual(typeof apiService.createSensitiveViewIdempotencyKey, 'function', '客户端必须暴露不可读幂等键生成器供确认会话复用')

  const originalAddSensitiveFootprint = apiService.addSensitiveFootprint
  const storage = { ynzy_auth_token: 'token-sensitive-retry' }
  let pageDefinition = null
  global.wx = {
    getStorageSync(key) { return storage[key] },
    setStorageSync(key, value) { storage[key] = value },
    hideShareMenu() {},
    showToast() {},
    showModal() {}
  }
  global.Page = (definition) => { pageDefinition = definition }
  const pageModulePath = require.resolve('../../pages/listing-detail/listing-detail')
  delete require.cache[pageModulePath]
  require(pageModulePath)
  delete global.Page

  const requestKeys = []
  let requestCount = 0
  apiService.addSensitiveFootprint = (listingId, idempotencyKey) => {
    requestKeys.push({ listingId, idempotencyKey })
    requestCount += 1
    if (requestCount === 1) return Promise.reject(new Error('服务端已写但响应丢失'))
    return Promise.resolve({
      sensitive: { address: '重试测试地址', landlordPhone: '19900000001' },
      logs: []
    })
  }

  try {
    const page = Object.assign({}, pageDefinition)
    page.data = Object.assign({}, JSON.parse(JSON.stringify(pageDefinition.data)), {
      listing: { id: 'L-RETRY' },
      isVerified: true,
      sensitiveVisible: false,
      sensitiveSubmitting: false,
      currentUserId: 'U-RETRY'
    })
    page.setData = function (next) { Object.assign(this.data, next) }
    page.listingLoadGeneration = 1
    page.profileAuthToken = storage.ynzy_auth_token

    page.revealSensitive()
    const firstKey = page.sensitiveViewIdempotencyKey
    assert.ok(firstKey, '打开二次确认时必须为本次确认会话固定幂等键')
    const firstRequest = page.confirmRevealSensitive()
    assert.ok(firstRequest && typeof firstRequest.then === 'function', '敏感查看提交必须返回请求 Promise 供行为测试和调用方观察')
    await firstRequest
    assert.strictEqual(page.sensitiveViewIdempotencyKey, firstKey, '响应丢失后必须保留原幂等键供重试')

    await page.confirmRevealSensitive()
    assert.strictEqual(requestKeys.length, 2, '丢响应后应允许用户重试同一确认会话')
    assert.strictEqual(requestKeys[0].idempotencyKey, requestKeys[1].idempotencyKey, '失败重试必须复用同一幂等键')
    assert.strictEqual(page.sensitiveViewIdempotencyKey, '', '成功后必须清除已完成确认会话的幂等键')
    assert.strictEqual(page.data.sensitiveVisible, true, '幂等重试成功后应正常展示敏感信息')
  } finally {
    apiService.addSensitiveFootprint = originalAddSensitiveFootprint
    delete global.wx
  }
}

verifyClientRetryIdempotency().then(() => {
  console.log('sensitive-view-simplification-v1-test: ok')
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
