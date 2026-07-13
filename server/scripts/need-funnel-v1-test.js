'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

process.env.REPORT_DEAL_WRITES_ENABLED = '1' // 历史漏斗回归只在显式恢复模式下演练。
const domain = require('../src/domain')
const assistantService = require('../src/assistant-service')
const metricReadout = require('./metric-readout')
const { NO_FEATURE } = require('../src/listing-features')

function makeDb() {
  return {
    users: [
      { id: 'U-UPLOADER', name: '上传中介', role: '中介', authed: '已实名' },
      { id: 'U-BROKER', name: '成交中介', role: '中介', authed: '已实名' },
      { id: 'U-OTHER', name: '其他中介', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [],
    footprints: [],
    showingUploads: [],
    pointLogs: [],
    clientReports: [],
    dealRecords: [],
    commissionRecords: [],
    rentalNeeds: [],
    assistantTraceLogs: [],
    registrationRequests: []
  }
}

function listingPayload() {
  return {
    city: '杭州',
    district: '滨江区',
    area: '滨江区',
    block: '长河',
    community: '城北天邑国际',
    communityName: '城北天邑国际',
    buildingNo: '1',
    unitNo: '2',
    roomNo: '301',
    address: '合成测试地址',
    contact: '13900009001',
    rent: 4200,
    layout: '整租两室一厅一卫',
    features: [NO_FEATURE],
    videoKey: 'house-videos/need-funnel/test.mp4'
  }
}

function assertIso(value, message) {
  assert.strictEqual(typeof value, 'string', message)
  assert.ok(Number.isFinite(Date.parse(value)), message)
}

function expectStatus(fn, statusCode, message) {
  assert.throws(fn, (error) => error && error.statusCode === statusCode, message)
}

function createNeed(db, userId, source = 'match-chat') {
  const created = domain.createRentalNeed(db, userId, {
    rawText: '合成找房需求',
    confirmedNeed: { area: '滨江区', layout: '两室', budgetMax: 4500 },
    source
  }).need
  return db.rentalNeeds.find((item) => item.id === created.id)
}

function testTrustedMilestones() {
  const emptyResultDb = makeDb()
  const emptyResultNeed = createNeed(emptyResultDb, 'U-BROKER')
  assistantService.recordFeedbackResult(emptyResultDb, { needId: emptyResultNeed.id }, {
    threadId: 'AST-NEED-FUNNEL-EMPTY',
    intent: 'rental_match',
    reply: '暂未找到房源',
    listings: []
  }, { userId: 'U-BROKER' })
  assert.strictEqual(emptyResultNeed.funnel, undefined, '空结果不得冒充首次有效推荐')

  const db = makeDb()
  const need = createNeed(db, 'U-BROKER')
  const otherNeed = createNeed(db, 'U-OTHER')
  const listing = domain.addNormalListing(db, 'U-UPLOADER', listingPayload())

  const result = assistantService.recordFeedbackResult(db, {
    needId: need.id,
    text: '合成需求文本'
  }, {
    threadId: 'AST-NEED-FUNNEL-1',
    intent: 'rental_match',
    reply: '找到一套合成房源',
    listings: [{ id: listing.id, title: '合成房源', rent: 4200 }]
  }, { userId: 'U-BROKER' })

  assert.ok(result.feedbackMessageId, '有效推荐必须先生成服务端结果 ID')
  assert.ok(need.funnel, '需求应固化 funnel 里程碑对象')
  assert.strictEqual(need.funnel.version, 'need-funnel-v1', '漏斗版本应固定')
  assertIso(need.funnel.firstRecommendedAt, '首次有效推荐应保存服务端 ISO 时间')
  const firstRecommendedAt = need.funnel.firstRecommendedAt

  assistantService.recordFeedbackResult(db, { needId: need.id }, {
    threadId: 'AST-NEED-FUNNEL-2',
    intent: 'rental_match',
    listings: [{ id: listing.id, title: '第二次推荐' }]
  }, { userId: 'U-BROKER' })
  assert.strictEqual(need.funnel.firstRecommendedAt, firstRecommendedAt, '重复推荐不得覆盖首次推荐时间')

  assistantService.recordFeedbackResult(db, { needId: otherNeed.id }, {
    threadId: 'AST-NEED-FUNNEL-FORGED',
    intent: 'rental_match',
    listings: [{ id: listing.id, title: '伪造串绑' }]
  }, { userId: 'U-BROKER' })
  assert.strictEqual(otherNeed.funnel, undefined, '其他用户需求不得被当前用户推荐事件写入里程碑')

  domain.addSensitiveFootprint(db, 'U-BROKER', listing.id, {
    idempotencyKey: 'sensitive_funnel_0001',
    needId: need.id,
    purpose: '客户端旧字段不得进入足迹'
  })
  assert.strictEqual(need.funnel.l1SensitiveViewedAt, undefined, '新敏感查看不再绑定需求单或制造 L1 里程碑')
  domain.addSensitiveFootprint(db, 'U-BROKER', listing.id, {
    idempotencyKey: 'sensitive_funnel_0002',
    needId: need.id,
    purpose: '再次核对也不得归因'
  })
  assert.strictEqual(need.funnel.l1SensitiveViewedAt, undefined, '重复敏感查看仍不得写 L1 需求里程碑')
  const sensitiveFootprint = db.footprints.find((item) => item.idempotencyKey === 'sensitive_funnel_0001')
  assert.deepStrictEqual(Object.keys(sensitiveFootprint).sort(), ['id', 'viewerId', 'listingId', 'actionType', 'occurredAt', 'idempotencyKey'].sort(), '敏感查看足迹只保留六字段')

  const report = domain.createClientReport(db, 'U-BROKER', listing.id, {
    needId: need.id,
    customerName: '合成客户',
    customerPhone: '13800009002'
  }).report
  assertIso(need.funnel.l2ReportedAt, 'L2 报备应保存首次服务端时间')

  expectStatus(() => domain.recordShowing(db, 'U-BROKER', listing.id, {
    needId: otherNeed.id,
    photoKey: 'showing-proof/forged.jpg'
  }), 403, '带看 needId 必须属于当前用户')

  const showing = domain.recordShowing(db, 'U-BROKER', listing.id, {
    needId: need.id,
    photoKey: 'showing-proof/valid.jpg',
    watermarkText: '合成水印'
  }).showing
  assert.strictEqual(showing.needId, need.id, '带看记录必须保存已验证 needId')
  assert.strictEqual(need.funnel.showingAt, undefined, '带看提交尚未审核通过时不得计入带看率')
  domain.reviewShowingUpload(db, 'ADMIN', showing.id, { action: 'approve' })
  assertIso(need.funnel.showingAt, '带看审核通过后应保存首次时间')
  const approvedShowingAt = need.funnel.showingAt
  domain.reviewShowingUpload(db, 'ADMIN', showing.id, { action: 'approve' })
  assert.strictEqual(need.funnel.showingAt, approvedShowingAt, '重复审核不得覆盖首次带看时间')
  const showingFootprint = db.footprints.find((item) => item.actionType === 'showing_verified' && item.viewerId === 'U-BROKER' && item.listingId === listing.id)
  assert.deepStrictEqual(Object.keys(showingFootprint).sort(), ['id', 'viewerId', 'listingId', 'actionType', 'occurredAt', 'idempotencyKey'].sort(), '审核通过足迹也必须收敛为六字段，需求归因只留在带看记录')

  const legacyShowing = domain.recordShowing(db, 'U-BROKER', listing.id, {
    photoKey: 'showing-proof/legacy-client.jpg'
  }).showing
  assert.strictEqual(legacyShowing.needId, undefined, '旧客户端缺 needId 时保持兼容且不得伪造归因')

  const deal = domain.createDealFromReport(db, 'U-BROKER', report.id, {
    monthlyRent: 4200,
    landlordCommission: 6000
  }).deal
  assertIso(need.funnel.l3DealSubmittedAt, 'L3 成交提交应保存首次服务端时间')
  assert.strictEqual(need.funnel.l3DealConfirmedAt, undefined, '提交动作不得冒充管理员确认')

  domain.confirmDeal(db, 'ADMIN', deal.id)
  assertIso(need.funnel.l3DealConfirmedAt, '管理员确认后应保存成交确认时间')
  const firstConfirmedAt = need.funnel.l3DealConfirmedAt
  domain.confirmDeal(db, 'ADMIN', deal.id)
  assert.strictEqual(need.funnel.l3DealConfirmedAt, firstConfirmedAt, '重复确认不得覆盖首次确认时间')

  const snapshot = metricReadout.buildSnapshot(db, {})
  assert.strictEqual(snapshot.fillRate.fillL1_viewPct, 0, '敏感查看取消需求绑定后不得再抬高 L1 漏斗')
  assert.strictEqual(snapshot.fillRate.fillL2_reportPct, 50, '两个真实需求中一个达到 L2')
  assert.strictEqual(snapshot.fillRate.fillL3_dealSubmitPct, 50, '两个真实需求中一个提交成交')
  assert.strictEqual(snapshot.fillRate.fillL3_dealConfirmedPct, 50, '两个真实需求中一个确认成交')
  assert.strictEqual(snapshot.funnel.showingRatePct, 100, '带看率按 L2 需求到审核通过带看计算')
  assert.strictEqual(snapshot.funnel.dealConfirmationRatePct, 100, '成交确认率按 L3 提交到确认计算')
  assert.strictEqual(snapshot.funnel.firstRecommendationMeasuredCount, 1, '首次推荐耗时只统计可归因且有房源结果的需求')
  const serialized = JSON.stringify(snapshot)
  assert.strictEqual(serialized.includes(need.id), false, '聚合快照不得泄露 needId')
  assert.strictEqual(serialized.includes('合成客户'), false, '聚合快照不得泄露客户姓名')
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(raw) })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${child.exitCode}`)
    try {
      await requestJson(port, '/healthz')
      return
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('等待测试服务启动超时')
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function testReadyzDeadLetterSummary() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-need-funnel-'))
  const dataFile = path.join(tempDir, 'db.json')
  const db = makeDb()
  db.registrationRequests.push({
    id: 'REG-DEAD-1',
    name: '合成申请人',
    phone: '13700009003',
    status: '待审核',
    notifyStatus: 'dead_letter',
    notifyDeadLetterAlertStatus: 'sent'
  })
  db.registrationRequests.push({
    id: 'REG-DEAD-RESOLVED',
    status: '已通过',
    notifyStatus: 'dead_letter',
    notifyDeadLetterAlertStatus: 'sent'
  })
  fs.writeFileSync(dataFile, JSON.stringify(db), 'utf8')
  const port = await getFreePort()
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      ADMIN_TOKEN_SECRET: 'need-funnel-admin-test',
      AUTH_TOKEN_SECRET: 'need-funnel-mini-test',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  try {
    await waitForServer(port, child)
    const ready = await requestJson(port, '/readyz')
    assert.strictEqual(ready.statusCode, 503, '存在待审核注册通知死信时 readyz 必须 fail-loud')
    const data = ready.body && ready.body.data ? ready.body.data : {}
    const pending = Array.isArray(data.pending) ? data.pending : []
    const item = pending.find((row) => /注册通知死信 1 条/.test(String(row && row.title)))
    assert.ok(item, 'readyz 应显示仅含数量的注册通知死信待办')
    assert.strictEqual(item.status, '需处理', '存在死信时应进入需处理口径')
    assert.ok(Number(data.checks && data.checks.todo) >= 1, '死信应计入 readyz todo')
    const serialized = JSON.stringify(ready.body)
    assert.strictEqual(serialized.includes('合成申请人'), false, 'readyz 不得泄露申请姓名')
    assert.strictEqual(serialized.includes('13700009003'), false, 'readyz 不得泄露申请手机号')
  } finally {
    await stopChild(child)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  assert.strictEqual(stderr.includes('13700009003'), false, '测试服务日志不得输出申请手机号')
}

function testClientAndAuditContracts() {
  const root = path.join(__dirname, '..', '..')
  const pageSource = fs.readFileSync(path.join(root, 'pages', 'listing-detail', 'listing-detail.js'), 'utf8')
  const recordStart = pageSource.indexOf('const showingPayload =')
  const recordBlock = pageSource.slice(recordStart, recordStart + 800)
  assert.ok(
    /relatedNeedId\s*=\s*operation\.needTemporary\s*\?\s*['"]{2}\s*:\s*operation\.needId/.test(recordBlock) &&
      /if\s*\(relatedNeedId\)\s*showingPayload\.needId\s*=\s*relatedNeedId/.test(recordBlock),
    '客户端带看只允许携带操作发起会话冻结的持久 needId，临时需求保持兼容但不计漏斗'
  )

  const auditSource = fs.readFileSync(path.join(__dirname, 'v1-final-audit.js'), 'utf8')
  assert.ok(auditSource.includes('need-funnel-v1-test.js'), '最终审计必须纳入 P1.3 核心行为测试')
}

async function main() {
  testTrustedMilestones()
  testClientAndAuditContracts()
  await testReadyzDeadLetterSummary()
  console.log('need-funnel-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
