// 注册申请安全与通知可靠性端到端回归：
// 1. 待审核同号重复提交不得覆盖原姓名/密码；2. 飞书文本不得注入 at/换行；
// 3. 通知失败最多重试 3 次并落库状态；4. 进程重启后恢复未完成通知。
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')
const domain = require('../src/domain')

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-reg-notify-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 45200 + Math.floor(Math.random() * 300)
const baseUrl = `http://127.0.0.1:${port}`

const EXISTING_PHONE = '13900000061'
const EXISTING_PASSWORD = 'exist-pass-123'
const APPLY_PHONE = '13900000062'
const APPLY_NAME = '通知测试申请人'
const NOHOOK_PHONE = '13900000063'
const TAKEOVER_PHONE = '13900000064'
const TAKEOVER_NAME = '原申请人'
const TAKEOVER_PASSWORD = 'original-pass-123'
const ATTACKER_PASSWORD = 'attacker-pass-456'
const INJECTION_PHONE = '13900000065'
const RETRY_PHONE = '13900000066'
const EXHAUST_PHONE = '13900000067'
const RECOVERY_PHONE = '13900000068'
const DEAD_FAILED_PHONE = '13900000072'
const DEAD_SENDING_PHONE = '13900000073'
const DEAD_SENT_PHONE = '13900000074'

function seedDb() {
  const db = {
    users: [
      { id: 'U-ADMIN', name: '超管员工', phone: '13900000069', isAdmin: true },
      { id: 'U-EXIST', name: '既有中介', phone: EXISTING_PHONE, role: '中介', isAdmin: false, authed: '手机号登录', passwordHash: hashPassword(EXISTING_PASSWORD) }
    ],
    listings: [],
    footprints: [],
    registrationRequests: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'super1', password: 'super1pass', name: '超管', userId: 'U-ADMIN', permission: '全部后台权限', status: '启用' }
    ]
  }
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function request(method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let parsed = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch (error) { parsed = { raw } }
        resolve({ statusCode: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitFor(check, ms = 8000, intervalMs = 80) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < ms) {
    const value = await check()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

async function waitForServer() {
  return Boolean(await waitFor(async () => {
    try {
      const res = await request('GET', '/healthz')
      return res.statusCode === 200
    } catch (error) {
      return false
    }
  }, 12000, 150))
}

async function waitForHits(hits, count, ms = 8000) {
  return Boolean(await waitFor(() => hits.length >= count, ms, 80))
}

function spawnServer(extraEnv) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: 'reg-notify-secret',
      ADMIN_TOKEN_SECRET: 'reg-notify-admin',
      V1_DISABLE_LEGACY_ROUTES: '1',
      REGISTRATION_NOTIFY_RETRY_DELAYS_MS: '40,80',
      HEALTH_ALERT_DEDUPE_DIR: path.join(tempDir, 'alert-dedupe'),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  return { child, outputRef: () => output }
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return
  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, 2500)
    server.child.once('exit', finish)
    server.child.kill()
  })
}

async function adminLogin() {
  const login = await request('POST', '/admin/auth/login', { account: 'super1', password: 'super1pass' })
  assert.strictEqual(login.statusCode, 200, '超管应能登录')
  return { Authorization: `Bearer ${login.body.data.token}` }
}

async function registrationByPhone(superAuth, phone) {
  const list = await request('GET', '/admin/registrations', null, superAuth)
  assert.strictEqual(list.statusCode, 200, '超管应能读取注册审核列表')
  return (list.body.data.requests || []).find((item) => item.phone === phone)
}

async function waitForRegistration(superAuth, phone, predicate, ms = 8000) {
  return waitFor(async () => {
    const item = await registrationByPhone(superAuth, phone)
    return item && predicate(item) ? item : null
  }, ms, 100)
}

function notificationText(hit) {
  return String((hit && hit.content && hit.content.text) || '')
}

function assertOldAttemptCannotFinishNewApplicationCycle() {
  const db = { users: [], registrationRequests: [] }
  const first = domain.registerUser(db, {
    name: '第一轮申请人',
    phone: '13900000071',
    password: 'first-cycle-pass'
  })
  const oldJob = domain.beginRegistrationNotification(db, first.registrationRequestId, 3)
  assert.ok(oldJob && oldJob.notifyAttemptId, '第一轮通知应领取独立 attemptId')
  domain.reviewRegistration(db, { id: first.registrationRequestId, action: 'reject', reason: '竞态测试' })
  domain.registerUser(db, {
    name: '第二轮申请人',
    phone: '13900000071',
    password: 'second-cycle-pass'
  })

  const staleFinish = domain.finishRegistrationNotification(db, first.registrationRequestId, {
    ok: true,
    attemptId: oldJob.notifyAttemptId
  })
  const current = db.registrationRequests.find((item) => item.id === first.registrationRequestId)
  assert.strictEqual(staleFinish.stale, true, '旧发送回调必须被识别为过期')
  assert.strictEqual(current.notifyStatus, 'pending', '旧发送成功不得把新申请轮次误标为 sent')
  assert.strictEqual(current.notifyAttempts, 0, '旧发送回调不得污染新轮次尝试次数')
}

async function run() {
  assertOldAttemptCannotFinishNewApplicationCycle()
  const hits = []
  let failResponsesRemaining = 0
  let failAllResponses = false
  const isDeadLetterAlert = (hit) => notificationText(hit).includes('注册申请通知多次发送失败')
  const alertTraceId = (id) => `REQ-${crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 16).toUpperCase()}`
  const stub = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let payload
      try { payload = JSON.parse(raw) } catch (error) { payload = { raw } }
      const text = notificationText(payload)
      const isRegistrationNotice = text.includes('新的注册申请')
      const shouldFail = isRegistrationNotice && (failAllResponses || failResponsesRemaining > 0)
      if (isRegistrationNotice && failResponsesRemaining > 0) failResponsesRemaining -= 1
      payload.__responseStatus = shouldFail ? 500 : 200
      hits.push(payload)
      res.writeHead(shouldFail ? 500 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(shouldFail ? { code: 1, msg: 'test failure' } : { code: 0 }))
    })
  })
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const webhook = `http://127.0.0.1:${stub.address().port}/hook`

  seedDb()
  let server = spawnServer({ HEALTH_ALERT_WEBHOOK: webhook })

  try {
    assert.ok(await waitForServer(), `注册提醒测试服务未启动：${server.outputRef()}`)
    const superAuth = await adminLogin()

    // 新申请通知成功，且持久化为 sent。
    const apply = await request('POST', '/mini/auth/register', { name: APPLY_NAME, phone: APPLY_PHONE, password: 'apply-pass-123' })
    assert.strictEqual(apply.statusCode, 403, '新申请应 403 待审核')
    assert.ok(await waitForHits(hits, 1), '新申请应触发 1 条飞书通知')
    const text1 = notificationText(hits[0])
    assert.ok(text1.includes(APPLY_NAME), '通知应含申请人姓名')
    assert.ok(text1.includes('139****0062'), '通知手机号应打码为 139****0062')
    assert.ok(!text1.includes(APPLY_PHONE), '通知绝不能含完整手机号')
    assert.ok(text1.includes('注册审核'), '通知应指引到后台注册审核')
    const sent = await waitForRegistration(superAuth, APPLY_PHONE, (item) => item.notifyStatus === 'sent')
    assert.ok(sent, '通知成功后申请应持久化 notifyStatus=sent')
    assert.strictEqual(sent.notifyAttempts, 1, '首次发送成功只应尝试 1 次')

    // 待审核期重复提交不重复通知。
    await request('POST', '/mini/auth/register', { name: APPLY_NAME, phone: APPLY_PHONE, password: 'apply-pass-123' })
    await sleep(300)
    assert.strictEqual(hits.length, 1, `待审核重复提交不应再通知（实收 ${hits.length} 条）`)

    // 驳回后重新申请属于新一轮审核，应重置通知状态并再发一条。
    const target = await registrationByPhone(superAuth, APPLY_PHONE)
    const reject = await request('POST', `/admin/registrations/${target.id}/review`, { action: 'reject', reason: '通知测试' }, superAuth)
    assert.strictEqual(reject.statusCode, 200, '驳回应 200')
    const reApply = await request('POST', '/mini/auth/register', { name: APPLY_NAME, phone: APPLY_PHONE, password: 'apply-pass-456' })
    assert.strictEqual(reApply.statusCode, 403, '重新申请应 403 回待审核')
    assert.ok(await waitForHits(hits, 2), '驳回后重新申请应再触发 1 条通知')
    const resent = await waitForRegistration(superAuth, APPLY_PHONE, (item) => item.notifyStatus === 'sent' && item.notifyAttempts === 1)
    assert.ok(resent, '重新申请的新通知轮次应成功并从第 1 次重新计数')

    // 已开通号再注册只引导登录，不发通知。
    const existed = await request('POST', '/mini/auth/register', { name: '既有中介', phone: EXISTING_PHONE, password: 'whatever-123' })
    assert.strictEqual(existed.statusCode, 409, '已开通号应 409')
    await sleep(300)
    assert.strictEqual(hits.length, 2, `已开通号注册不应通知（实收 ${hits.length} 条）`)

    // P1：同号待审核申请必须严格幂等，后来的姓名和密码都不能接管原申请。
    const takeoverApply = await request('POST', '/mini/auth/register', {
      name: TAKEOVER_NAME,
      phone: TAKEOVER_PHONE,
      password: TAKEOVER_PASSWORD
    })
    assert.strictEqual(takeoverApply.statusCode, 403, '原申请应进入待审核')
    assert.ok(await waitForHits(hits, 3), '原申请应发送通知')
    const takeoverDuplicate = await request('POST', '/mini/auth/register', {
      name: '冒名覆盖者',
      phone: TAKEOVER_PHONE,
      password: ATTACKER_PASSWORD
    })
    assert.strictEqual(takeoverDuplicate.statusCode, 403, '同号重复提交仍返回待审核')
    await sleep(300)
    assert.strictEqual(hits.length, 3, '同号重复提交不得再次通知')
    const protectedRequest = await registrationByPhone(superAuth, TAKEOVER_PHONE)
    assert.strictEqual(protectedRequest.name, TAKEOVER_NAME, '待审核申请姓名不得被后来同号请求覆盖')
    const approve = await request('POST', `/admin/registrations/${protectedRequest.id}/review`, { action: 'approve', type: 'broker' }, superAuth)
    assert.strictEqual(approve.statusCode, 200, '原申请应能审核通过')
    const originalLogin = await request('POST', '/mini/auth/login', { phone: TAKEOVER_PHONE, password: TAKEOVER_PASSWORD })
    assert.strictEqual(originalLogin.statusCode, 200, '审核后必须仍由原申请密码登录')
    const attackerLogin = await request('POST', '/mini/auth/login', { phone: TAKEOVER_PHONE, password: ATTACKER_PASSWORD })
    assert.strictEqual(attackerLogin.statusCode, 403, '后来提交的攻击者密码绝不能生效')

    // P1：用户姓名不能构造飞书 <at>、换行或控制字符来伪造系统消息。
    const injectedName = '正常申请人<at user_id="all">所有人</at>\n伪造通知\r下一行'
    const injectionApply = await request('POST', '/mini/auth/register', {
      name: injectedName,
      phone: INJECTION_PHONE,
      password: 'injection-pass-123'
    })
    assert.strictEqual(injectionApply.statusCode, 403, '含特殊字符的合法长度姓名仍可提交')
    assert.ok(await waitForHits(hits, 4), '特殊字符申请应正常通知')
    const injectionText = notificationText(hits[3])
    assert.ok(!injectionText.includes('<at'), '通知正文不得保留可执行的飞书 <at> 标签')
    assert.ok(!injectionText.includes('<') && !injectionText.includes('>'), '通知正文不得保留标签边界字符')
    assert.ok(!injectionText.includes('\r'), '通知正文不得含回车控制字符')
    assert.strictEqual((injectionText.match(/\n/g) || []).length, 1, '除告警头固定分隔外，用户输入不得新增通知行')
    assert.ok(!injectionText.includes(INJECTION_PHONE), '注入场景也不得泄露完整手机号')

    // P2：webhook 首次 500 后自动重试，第二次成功并落库 attempts=2/sent。
    failResponsesRemaining = 1
    const retryStart = hits.length
    const retryApply = await request('POST', '/mini/auth/register', {
      name: '重试成功申请人',
      phone: RETRY_PHONE,
      password: 'retry-pass-123'
    })
    assert.strictEqual(retryApply.statusCode, 403, '通知失败不得影响注册响应')
    assert.ok(await waitForHits(hits, retryStart + 2), '首次失败后应自动发起第二次通知')
    assert.strictEqual(hits[retryStart].__responseStatus, 500, '第一次通知应命中测试桩 500')
    assert.strictEqual(hits[retryStart + 1].__responseStatus, 200, '第二次通知应成功')
    const retried = await waitForRegistration(superAuth, RETRY_PHONE, (item) => item.notifyStatus === 'sent')
    assert.ok(retried, '重试成功后应落库 sent')
    assert.strictEqual(retried.notifyAttempts, 2, '首败后成功应记录 2 次尝试')

    // P2：连续失败最多 3 次，最终进入死信，并且只发一次脱敏升级告警。
    failAllResponses = true
    const exhaustStart = hits.length
    const exhaustApply = await request('POST', '/mini/auth/register', {
      name: '连续失败申请人',
      phone: EXHAUST_PHONE,
      password: 'exhaust-pass-123'
    })
    assert.strictEqual(exhaustApply.statusCode, 403, '连续通知失败也不得影响注册响应')
    assert.ok(await waitForHits(hits, exhaustStart + 4), '连续失败应尝试满 3 次并追加 1 次死信告警')
    const exhausted = await waitForRegistration(
      superAuth,
      EXHAUST_PHONE,
      (item) => item.notifyStatus === 'dead_letter' && item.notifyAttempts === 3 && item.notifyDeadLetterAlertStatus === 'sent'
    )
    assert.ok(exhausted, '达到上限后应落库 dead_letter/attempts=3，并记录死信告警已发送')
    assert.ok(exhausted.notifyDeadLetterAt, '死信状态应记录进入死信时间')
    assert.ok(exhausted.notifyDeadLetterAlertAttemptedAt, '死信状态应记录升级告警尝试时间')
    assert.ok(String(exhausted.notifyLastError || '').length > 0, '最终失败应留下不含密钥的错误摘要')
    const deadLetterAlerts = hits.slice(exhaustStart).filter(isDeadLetterAlert)
    assert.strictEqual(deadLetterAlerts.length, 1, '同一申请重试耗尽只允许发 1 次死信升级告警')
    const deadLetterText = notificationText(deadLetterAlerts[0])
    assert.ok(!deadLetterText.includes('REGISTRATION_NOTIFY_DEAD_LETTER'), '死信升级告警不得把内部机器码发到群里')
    assert.ok(deadLetterText.includes(alertTraceId(exhausted.id)), '死信告警应带可追踪申请 id')
    assert.ok(!deadLetterText.includes(EXHAUST_PHONE), '死信告警不得含完整手机号')
    assert.ok(!deadLetterText.includes('139****0067'), '死信告警不得含打码手机号，避免和个人身份绑定')
    assert.ok(!deadLetterText.includes('连续失败申请人'), '死信告警不得含申请人姓名')
    assert.ok(!deadLetterText.includes('exhaust-pass-123'), '死信告警不得含注册密码或凭据')
    await sleep(250)
    assert.strictEqual(hits.length, exhaustStart + 4, '达到 3 次上限并告警一次后不得继续发送')
    failAllResponses = false

    // 全程 PII 复查：所有通知都不含任何完整 11 位手机号。
    hits.forEach((hit, index) => {
      const text = notificationText(hit)
      assert.ok(!/1\d{10}/.test(text), `通知#${index} 不得含完整手机号：${text}`)
    })

    // 长姓名在通知链前被拒，服务保持健康。
    const beforeLongName = hits.length
    const longApply = await request('POST', '/mini/auth/register', {
      name: 'x'.repeat(200000),
      phone: '13900000070',
      password: 'longname-pass-123'
    })
    assert.strictEqual(longApply.statusCode, 400, '超长 name 应被 400 拦截')
    await sleep(200)
    assert.strictEqual(hits.length, beforeLongName, '被拦的注册不应触发通知')
    const alive = await request('GET', '/healthz')
    assert.strictEqual(alive.statusCode, 200, '超长 name 注册后服务必须仍健康')
  } finally {
    await stopServer(server)
  }

  // P2：进程重启后扫描并恢复待发送任务，不依赖内存队列。
  const recoveryDb = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  recoveryDb.registrationRequests.unshift({
    id: 'R-RECOVERY',
    name: '重启恢复申请人',
    phone: RECOVERY_PHONE,
    passwordHash: hashPassword('recovery-pass-123'),
    status: '待审核',
    source: 'mini-register',
    notifyStatus: 'pending',
    notifyAttempts: 0,
    createdAt: '2026/7/10 01:00:00',
    updatedAt: '2026/7/10 01:00:00'
  })
  fs.writeFileSync(dataFile, JSON.stringify(recoveryDb, null, 2), 'utf8')
  const recoveryStart = hits.length
  server = spawnServer({ HEALTH_ALERT_WEBHOOK: webhook })
  try {
    assert.ok(await waitForServer(), `重启恢复测试服务未启动：${server.outputRef()}`)
    assert.ok(await waitForHits(hits, recoveryStart + 1), '重启后应恢复未完成的注册通知')
    const superAuth = await adminLogin()
    const recovered = await waitForRegistration(superAuth, RECOVERY_PHONE, (item) => item.notifyStatus === 'sent')
    assert.ok(recovered, '重启恢复任务发送成功后应持久化 sent')
    assert.strictEqual(recovered.notifyAttempts, 1, '恢复任务首次发送成功应记录 1 次')
    assert.strictEqual(hits.filter(isDeadLetterAlert).length, 1, '重启恢复不得重复发送已告警的注册通知死信')
  } finally {
    await stopServer(server)
  }

  // 返修：死信告警失败/进程中断后，重启应补发；已成功告警的死信不重复。
  const deadLetterReplayDb = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  deadLetterReplayDb.registrationRequests.unshift(
    {
      id: 'R-DEAD-FAILED',
      name: '死信失败补发申请',
      phone: DEAD_FAILED_PHONE,
      passwordHash: hashPassword('dead-failed-pass-123'),
      status: '待审核',
      source: 'mini-register',
      notifyStatus: 'dead_letter',
      notifyAttempts: 3,
      notifyLastError: '通知子进程退出码异常(1)',
      notifyDeadLetterAt: '2026/7/10 02:00:00',
      notifyDeadLetterReason: '通知子进程退出码异常(1)',
      notifyDeadLetterAlertAttemptedAt: '2026/7/10 02:00:01',
      notifyDeadLetterAlertStatus: 'failed',
      notifyDeadLetterAlertLastError: '死信告警子进程退出码异常(1)',
      createdAt: '2026/7/10 02:00:00',
      updatedAt: '2026/7/10 02:00:00'
    },
    {
      id: 'R-DEAD-SENDING',
      name: '死信中断补发申请',
      phone: DEAD_SENDING_PHONE,
      passwordHash: hashPassword('dead-sending-pass-123'),
      status: '待审核',
      source: 'mini-register',
      notifyStatus: 'dead_letter',
      notifyAttempts: 3,
      notifyLastError: '通知子进程退出码异常(1)',
      notifyDeadLetterAt: '2026/7/10 02:10:00',
      notifyDeadLetterReason: '通知子进程退出码异常(1)',
      notifyDeadLetterAlertAttemptedAt: '2026/7/10 02:10:01',
      notifyDeadLetterAlertStatus: 'sending',
      createdAt: '2026/7/10 02:10:00',
      updatedAt: '2026/7/10 02:10:00'
    },
    {
      id: 'R-DEAD-SENT',
      name: '死信已告警申请',
      phone: DEAD_SENT_PHONE,
      passwordHash: hashPassword('dead-sent-pass-123'),
      status: '待审核',
      source: 'mini-register',
      notifyStatus: 'dead_letter',
      notifyAttempts: 3,
      notifyLastError: '通知子进程退出码异常(1)',
      notifyDeadLetterAt: '2026/7/10 02:20:00',
      notifyDeadLetterReason: '通知子进程退出码异常(1)',
      notifyDeadLetterAlertAttemptedAt: '2026/7/10 02:20:01',
      notifyDeadLetterAlertStatus: 'sent',
      notifyDeadLetterAlertSentAt: '2026/7/10 02:20:02',
      createdAt: '2026/7/10 02:20:00',
      updatedAt: '2026/7/10 02:20:00'
    }
  )
  fs.writeFileSync(dataFile, JSON.stringify(deadLetterReplayDb, null, 2), 'utf8')
  const replayDeadLetterStart = hits.filter(isDeadLetterAlert).length
  server = spawnServer({ HEALTH_ALERT_WEBHOOK: webhook })
  try {
    assert.ok(await waitForServer(), `死信补发测试服务未启动：${server.outputRef()}`)
    assert.ok(await waitFor(() => hits.filter(isDeadLetterAlert).length >= replayDeadLetterStart + 2), '重启后应补发 failed/sending 两条死信告警')
    const superAuth = await adminLogin()
    const failedReplay = await waitForRegistration(superAuth, DEAD_FAILED_PHONE, (item) => item.notifyDeadLetterAlertStatus === 'sent')
    assert.ok(failedReplay, 'failed 死信告警补发成功后应转 sent')
    const sendingReplay = await waitForRegistration(superAuth, DEAD_SENDING_PHONE, (item) => item.notifyDeadLetterAlertStatus === 'sent')
    assert.ok(sendingReplay, 'sending 遗留死信告警补发成功后应转 sent')
    const sentReplay = await registrationByPhone(superAuth, DEAD_SENT_PHONE)
    assert.strictEqual(sentReplay.notifyDeadLetterAlertStatus, 'sent', '已 sent 的死信告警仍保持 sent')
    await sleep(250)
    assert.strictEqual(hits.filter(isDeadLetterAlert).length, replayDeadLetterStart + 2, '已 sent 的死信告警重启后不得重复发送')
  } finally {
    await stopServer(server)
  }

  // 未配 webhook：注册主流程完全不受影响，也不误发通知。
  server = spawnServer({ HEALTH_ALERT_WEBHOOK: '' })
  try {
    assert.ok(await waitForServer(), `无 webhook 服务未启动：${server.outputRef()}`)
    const before = hits.length
    const apply = await request('POST', '/mini/auth/register', {
      name: '无钩子申请人',
      phone: NOHOOK_PHONE,
      password: 'nohook-pass-123'
    })
    assert.strictEqual(apply.statusCode, 403, '无 webhook 时新申请仍应 403 待审核')
    await sleep(300)
    assert.strictEqual(hits.length, before, '无 webhook 不应有任何通知')
    const health = await request('GET', '/healthz')
    assert.strictEqual(health.statusCode, 200, '服务应保持健康')
  } finally {
    await stopServer(server)
    await new Promise((resolve) => stub.close(resolve))
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('registration-notify-v1-test passed')
}).catch((error) => {
  console.error(`registration-notify-v1-test failed: ${error.stack || error.message}`)
  process.exit(1)
})
