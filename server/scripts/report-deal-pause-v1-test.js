'use strict'

process.env.REPORT_DEAL_WRITES_ENABLED = '0'

const assert = require('assert')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const config = require('../src/config')
const domain = require('../src/domain')
const apiService = require('../../utils/api-service')
const mockData = require('../../utils/mock-data')

const rootDir = path.resolve(__dirname, '..', '..')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '上传人', role: '中介', authed: '已实名' },
      { id: 'U2', name: '带看人', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', role: '管理员', authed: '已实名', isAdmin: true }
    ],
    listings: [{
      id: 'L1',
      uploaderId: 'U1',
      ownerType: '二房东房源',
      source: '二房东房源',
      status: '在租',
      lifecycleStatus: 'active',
      reviewStatus: '无需审核',
      communityMatched: true,
      community: '测试小区',
      rent: 3000,
      landlordCommissionPercent: 50,
      landlordPhone: '19900000001',
      videoKey: 'house-videos/test.mp4'
    }],
    rentalNeeds: [{ id: 'N1', brokerId: 'U2', status: 'active', confirmedNeed: {} }],
    clientReports: [{
      id: 'R-HISTORY', listingId: 'L1', brokerId: 'U2', needId: 'N1',
      customerName: '历史客户', customerPhone: '19900000002', status: '待跟进'
    }],
    dealRecords: [{
      id: 'D-HISTORY', reportId: 'R-HISTORY', listingId: 'L1', brokerId: 'U2',
      uploaderId: 'U1', status: '待管理员确认', landlordCommissionFen: 150000,
      commissionRule: { rate: 30, uploaderRate: 20, platformRate: 10 }
    }, {
      id: 'D-DIRTY-HISTORY', reportId: 'R-HISTORY', listingId: 'L1', brokerId: 'U2',
      uploaderId: 'U1', status: '待管理员确认', landlordCommissionFen: 150000,
      commissionRule: { rate: null, uploaderRate: null, platformRate: null },
      commissionBreakdown: { landlordPercentOfRent: 50, viewingAgentPercentOfRent: 0, maintainerPercentOfRent: 30, platformPercentOfRent: 30 }
    }],
    commissionRecords: [{
      id: 'C-HISTORY', dealId: 'D-OLD', listingId: 'L1', dealUserId: 'U2',
      uploaderId: 'U1', status: '已确认'
    }],
    footprints: [],
    pointLogs: []
  }
}

function assertPaused(fn, db, message) {
  const before = JSON.stringify(db)
  assert.throws(
    fn,
    (error) => error && error.statusCode === 410 && error.data && error.data.reason === 'REPORT_DEAL_PAUSED',
    message
  )
  assert.strictEqual(JSON.stringify(db), before, `${message}，且数据库不得变化`)
}

assert.ok(config.features, '配置必须提供仅由服务端读取的 features 对象')
assert.strictEqual(config.features.reportDealWritesEnabled, false, '报备/签单写入必须默认关闭')
assert.throws(
  () => mockData.createClientReport('L1', { reportDealWritesEnabled: true }),
  (error) => error && error.statusCode === 410 && error.data && error.data.reason === 'REPORT_DEAL_PAUSED',
  '开发者工具 Mock 也不得绕过暂停开关'
)
assert.throws(
  () => mockData.createDealFromReport('R-HISTORY', { reportDealWritesEnabled: true }),
  (error) => error && error.statusCode === 410 && error.data && error.data.reason === 'REPORT_DEAL_PAUSED',
  '开发者工具 Mock 的报备转签单入口也必须保持暂停'
)

async function assertMockDirectDealPaused() {
  const previousGetApp = global.getApp
  const mockUser = mockData.loginByPhone('13800010005')
  const session = mockData.issueAuthSession(mockUser.id)
  global.getApp = () => ({ globalData: { authToken: session.token } })
  try {
    await assert.rejects(
      apiService.registerDeal('L1'),
      (error) => error && error.statusCode === 410 && error.data && error.data.reason === 'REPORT_DEAL_PAUSED',
      '开发者工具 Mock 的旧直签入口必须在可信会话下稳定命中业务暂停门'
    )
  } finally {
    mockData.revokeAuthSession(session.token)
    if (previousGetApp === undefined) delete global.getApp
    else global.getApp = previousGetApp
  }
}

{
  const db = makeDb()
  assertPaused(
    () => domain.createClientReport(db, 'U2', 'L1', {
      needId: 'N1',
      customerName: '新客户',
      customerPhone: '19900000003',
      reportDealWritesEnabled: true
    }),
    db,
    '创建报备必须被领域层封堵'
  )
  assertPaused(
    () => domain.createDealFromReport(db, 'U2', 'R-HISTORY', { reportDealWritesEnabled: true }),
    db,
    '从历史报备创建签单必须被领域层封堵'
  )
  assertPaused(
    () => domain.registerDeal(db, 'U2', 'L1', { reportDealWritesEnabled: true }),
    db,
    '旧客户端直接签单必须被领域层封堵'
  )
  assertPaused(
    () => domain.confirmDeal(db, 'ADMIN', 'D-HISTORY', { reportDealWritesEnabled: true }),
    db,
    '管理员确认签单必须被领域层封堵'
  )

  assert.strictEqual(domain.userReportRows(db, 'U2').length, 1, '历史报备必须继续可读')
  assert.strictEqual(domain.adminReportRows(db).length, 1, '后台历史报备必须继续可读')
  assert.strictEqual(domain.userDealRows(db, 'U2').length, 2, '正常与脏历史签单都必须继续可读')
  assert.strictEqual(domain.adminDealRows(db).length, 2, '后台不得因单条脏历史签单丢整页')
  assert.strictEqual(domain.commissionRows(db).length, 1, '历史分佣必须继续可读')
}

{
  const indexSource = fs.readFileSync(path.join(rootDir, 'server/src/index.js'), 'utf8')
  const routeNames = [
    'reportMatch',
    'reportDealMatch',
    'dealMatch',
    'adminDealConfirmMatch'
  ]
  routeNames.forEach((routeName) => {
    const start = indexSource.indexOf(`if (method === 'POST' && ${routeName})`)
    assert.ok(start >= 0, `必须保留 ${routeName} 兼容路由`)
    const block = indexSource.slice(start, start + 700)
    const guardAt = block.indexOf('assertReportDealWritesEnabled')
    const parseAt = block.indexOf('parseBody')
    const updateAt = block.indexOf('updateDb')
    assert.ok(guardAt >= 0, `${routeName} 必须在路由层封堵旧客户端`)
    assert.ok(parseAt < 0 || guardAt < parseAt, `${routeName} 必须在解析客户端正文前封堵`)
    assert.ok(updateAt < 0 || guardAt < updateAt, `${routeName} 必须在数据库写锁前封堵`)
  })
}

{
  const configPath = path.join(rootDir, 'server/src/config.js')
  const domainPath = path.join(rootDir, 'server/src/domain.js')
  const recoveryDb = JSON.stringify(makeDb())
  const probe = `
    const config = require(${JSON.stringify(configPath)});
    const domain = require(${JSON.stringify(domainPath)});
    if (!config.features || config.features.reportDealWritesEnabled !== true) process.exit(21);
    const db = ${recoveryDb};
    const before = { reports: db.clientReports.length, deals: db.dealRecords.length, commissions: db.commissionRecords.length };
    const report = domain.createClientReport(db, 'U2', 'L1', { needId: 'N1', customerPhone: '19900000004' }).report;
    const deal = domain.createDealFromReport(db, 'U2', report.id, { monthlyRent: 3000, landlordCommissionFen: 1 }).deal;
    const confirmed = domain.confirmDeal(db, 'ADMIN', deal.id);
    if (db.clientReports.length !== before.reports + 1) process.exit(22);
    if (db.dealRecords.length !== before.deals + 1) process.exit(23);
    if (db.commissionRecords.length !== before.commissions + 1) process.exit(24);
    if (!confirmed.commissionRecord || confirmed.deal.status !== '已确认') process.exit(25);
  `
  execFileSync(process.execPath, ['-e', probe], {
    env: { ...process.env, REPORT_DEAL_WRITES_ENABLED: '1' },
    stdio: 'pipe'
  })
}

function signToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function requestJson(port, method, pathname, body, token) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : {} })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.once('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`暂停路由测试服务提前退出：${child.exitCode}`)
    try {
      const response = await requestJson(port, 'GET', '/healthz')
      if (response.statusCode === 200) return
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error('暂停路由测试服务启动超时')
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function runHttpPauseIntegration() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-report-pause-'))
  const dataFile = path.join(tempDir, 'db.json')
  const miniSecret = 'synthetic-mini-pause-secret'
  const adminSecret = 'synthetic-admin-pause-secret'
  const db = makeDb()
  db.listings[0].lastVerifiedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  db.listings[0].updatedAt = db.listings[0].lastVerifiedAt
  db.adminAccounts = [{
    id: 'A1', account: 'synthetic-admin', name: '合成管理员', userId: 'ADMIN',
    permission: '全部后台权限', status: '启用'
  }]
  fs.writeFileSync(dataFile, JSON.stringify(db), 'utf8')
  const port = await freePort()
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(rootDir, 'server'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: miniSecret,
      ADMIN_TOKEN_SECRET: adminSecret,
      REPORT_DEAL_WRITES_ENABLED: '0',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  try {
    await waitForServer(port, child)
    const miniToken = signToken({ userId: 'U2', exp: Date.now() + 60000, tokenVersion: 0 }, miniSecret)
    const adminToken = signToken({ id: 'A1', account: 'synthetic-admin', userId: 'ADMIN', exp: Date.now() + 60000 }, adminSecret)
    for (const [pathname, token] of [['/mini/deals', miniToken], ['/admin/deals', adminToken]]) {
      const response = await requestJson(port, 'GET', pathname, undefined, token)
      assert.strictEqual(response.statusCode, 200, `${pathname} 遇到单条脏历史签单仍必须返回完整列表`)
      const rows = response.body && response.body.data
      assert.ok(Array.isArray(rows) && rows.length === 2, `${pathname} 不得过滤脏行或丢正常行`)
      const dirty = rows.find((item) => item.id === 'D-DIRTY-HISTORY')
      assert.deepStrictEqual(dirty && dirty.commissionIntegrity, { valid: false, reason: 'INVALID_COMMISSION_SNAPSHOT' }, `${pathname} 脏行必须显式标记待核对`)
    }
    const before = fs.readFileSync(dataFile)
    const requests = [
      ['POST', '/mini/listings/L1/reports', { reportDealWritesEnabled: true }, miniToken],
      ['POST', '/mini/reports/R-HISTORY/deals', { reportDealWritesEnabled: true }, miniToken],
      ['POST', '/mini/listings/L1/deals?reportDealWritesEnabled=true', { reportDealWritesEnabled: true }, miniToken],
      ['POST', '/admin/deals/D-HISTORY/confirm?reportDealWritesEnabled=true', { reportDealWritesEnabled: true }, adminToken]
    ]
    for (const [method, pathname, body, token] of requests) {
      const response = await requestJson(port, method, pathname, body, token)
      assert.strictEqual(response.statusCode, 410, `${pathname} 必须返回 410`)
      assert.strictEqual(response.body && response.body.data && response.body.data.reason, 'REPORT_DEAL_PAUSED', `${pathname} 必须返回稳定暂停原因`)
      assert.ok(fs.readFileSync(dataFile).equals(before), `${pathname} 被拒后数据库文件必须逐字节不变`)
    }
  } finally {
    await stopChild(child)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  assert.strictEqual(/1990000000[1-4]/.test(stderr), false, '暂停路由测试服务日志不得输出假手机号')
}

async function runHttpRecoveryIntegration() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-report-recovery-'))
  const dataFile = path.join(tempDir, 'db.json')
  const miniSecret = 'synthetic-mini-recovery-secret'
  const adminSecret = 'synthetic-admin-recovery-secret'
  const db = makeDb()
  db.listings[0].lastVerifiedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  db.listings[0].updatedAt = db.listings[0].lastVerifiedAt
  db.adminAccounts = [{
    id: 'A1', account: 'synthetic-admin', name: '合成管理员', userId: 'ADMIN',
    permission: '全部后台权限', status: '启用'
  }]
  const before = {
    reports: db.clientReports.length,
    deals: db.dealRecords.length,
    commissions: db.commissionRecords.length
  }
  fs.writeFileSync(dataFile, JSON.stringify(db), 'utf8')
  const port = await freePort()
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(rootDir, 'server'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: miniSecret,
      ADMIN_TOKEN_SECRET: adminSecret,
      REPORT_DEAL_WRITES_ENABLED: '1',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  try {
    await waitForServer(port, child)
    const miniToken = signToken({ userId: 'U2', exp: Date.now() + 60000, tokenVersion: 0 }, miniSecret)
    const adminToken = signToken({ id: 'A1', account: 'synthetic-admin', userId: 'ADMIN', exp: Date.now() + 60000 }, adminSecret)
    const reportResponse = await requestJson(port, 'POST', '/mini/listings/L1/reports', {
      needId: 'N1', customerName: '合成客户', customerPhone: '19900000004'
    }, miniToken)
    assert.strictEqual(reportResponse.statusCode, 200, '显式恢复后真实 HTTP 报备应成功')
    const reportId = reportResponse.body && reportResponse.body.data && reportResponse.body.data.report && reportResponse.body.data.report.id
    assert.ok(reportId, '显式恢复后的报备响应必须返回服务端 reportId')

    const dealResponse = await requestJson(port, 'POST', `/mini/reports/${encodeURIComponent(reportId)}/deals`, {
      monthlyRent: 3000,
      landlordCommissionFen: 1,
      uploaderId: 'EVIL-UPLOADER'
    }, miniToken)
    assert.strictEqual(dealResponse.statusCode, 200, '显式恢复后真实 HTTP 报备转签单应成功')
    const dealId = dealResponse.body && dealResponse.body.data && dealResponse.body.data.deal && dealResponse.body.data.deal.id
    assert.ok(dealId, '显式恢复后的签单响应必须返回服务端 dealId')

    const confirmResponse = await requestJson(port, 'POST', `/admin/deals/${encodeURIComponent(dealId)}/confirm`, {
      landlordCommissionFen: 1,
      uploaderId: 'EVIL-UPLOADER',
      platformAmount: 1
    }, adminToken)
    assert.strictEqual(confirmResponse.statusCode, 200, '显式恢复后真实 HTTP 管理员确认应成功')

    const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assert.strictEqual(persisted.clientReports.length, before.reports + 1, '真实 HTTP 恢复链必须新增一条报备')
    assert.strictEqual(persisted.dealRecords.length, before.deals + 1, '真实 HTTP 恢复链必须新增一条签单')
    assert.strictEqual(persisted.commissionRecords.length, before.commissions + 1, '真实 HTTP 恢复链必须新增一条分佣记录')
    const storedDeal = persisted.dealRecords.find((item) => item.id === dealId)
    assert.ok(storedDeal && storedDeal.status === '已确认', '真实 HTTP 恢复链必须完成管理员确认')
    assert.notStrictEqual(storedDeal.uploaderId, 'EVIL-UPLOADER', '恢复链也不得信任客户端上传人字段')
    assert.notStrictEqual(storedDeal.landlordCommissionFen, 1, '恢复链也不得信任客户端最终佣金金额')
  } finally {
    await stopChild(child)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  assert.strictEqual(/1990000000[1-4]/.test(stderr), false, '恢复路由测试服务日志不得输出假手机号')
}

assertMockDirectDealPaused().then(runHttpPauseIntegration).then(runHttpRecoveryIntegration).then(() => {
  console.log('report-deal-pause-v1-test: ok')
}).catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
