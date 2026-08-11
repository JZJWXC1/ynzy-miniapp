// 飞书告警脚本测试：本地 http 桩当假 webhook，不打真网。锁定两条告警契约的消息组装、签名、截断、
// 成功/失败退出码——告警链坏了没人会收到通知，必须由测试守住。
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const alert = require('./send-feishu-alert')
const scriptPath = path.join(__dirname, 'send-feishu-alert.js')

function assertReadableAlert(text, context) {
  ;['发生时间：', '问题：', '影响：', '系统已做：', '你要做：', '排查编号：'].forEach((label) => {
    assert.ok(text.includes(label), `${context} 必须包含 ${label}`)
  })
  ;['严重程度：', '发生了什么：', '影响范围：', '当前状态：', '真实原因：', '建议处理：', '机器码：', '安全明细：', '{', '}'].forEach((fragment) => {
    assert.ok(!text.includes(fragment), `${context} 不得继续外发技术字段或 JSON：${fragment}`)
  })
}

function assertReadableSuccess(text, context) {
  ;['完成时间：', '同步方式：', '发生了什么：', '结果与影响：', '变更汇总：', '当前状态：', '排查编号：'].forEach((label) => {
    assert.ok(text.includes(label), `${context} 必须包含 ${label}`)
  })
  ;['严重程度：', '真实原因：', '建议处理：', '安全明细：', '追踪编号：'].forEach((label) => {
    assert.ok(!text.includes(label), `${context} 不得套用故障字段 ${label}`)
  })
}

// ---------- 纯函数：消息组装 / 签名 / 截断 ----------

// 备份契约优先
const backupText = alert.buildText({ ALERT_KIND: 'BACKUP_FAILED', ALERT_MESSAGE: '生成加密备份失败：x', ALERT_DETAIL: '{"a":1}' }, [])
assert.ok(backupText.includes('【寓你住一起｜系统告警】⚠️'), '失败正文应带醒目的告警头')
assert.ok(backupText.includes('加密备份生成失败'), '备份契约应直接说明问题')
assert.ok(!backupText.includes('BACKUP_FAILED'), '机器码只用于本地分类，不得进群')
assert.ok(!backupText.includes('{"a":1}'), '不在安全白名单的任意明细不得透传')
assertReadableAlert(backupText, '备份告警')
assert.ok(backupText.includes('备份') && backupText.includes('原因尚未确认'), '备份告警应说清事件，未知底层原因不得原样外发')

// 巡检契约
const healthText = alert.buildText({ HEALTH_FAILURES: 'db,disk', HEALTH_SUMMARY: '{"ok":false}' }, [])
assert.ok(healthText.includes('数据库') && healthText.includes('磁盘'), '巡检契约应翻译失败项')
assert.ok(!healthText.includes('{"ok":false}'), '巡检原始摘要不得进群')
assertReadableAlert(healthText, '巡检告警')
assert.ok(healthText.includes('数据库') && healthText.includes('磁盘'), '巡检失败项应翻译为普通中文并合并重复项')

// 同步失败：机器码只参与本地分类，把可确认原因翻译为中文后不得再把码发到群里。
const syncText = alert.buildText({
  ALERT_KIND: 'FEISHU_SYNC_FAILED',
  ALERT_MESSAGE: '同步失败',
  ALERT_DETAIL: JSON.stringify({ code: 'FEISHU_API_1254072', traceId: 'SYNC-ABCDEF123456', state: 'failed' })
}, [])
assertReadableAlert(syncText, '同步告警')
assert.ok(syncText.includes('字段值格式不符合飞书表格要求'), '已知同步机器码必须显示受控中文原因')
assert.ok(!syncText.includes('FEISHU_API_1254072'), '同步告警不得外发机器码')
assert.ok(syncText.includes('你要做：把排查编号发给技术人员；在确认前不要重复点击同步'), '同步失败必须给业务人员可执行动作')

// 正式同步成功使用独立通知模板，不冒充故障告警，也不展示任何 raw JSON。
const syncSuccessText = alert.buildText({
  ALERT_KIND: 'FEISHU_SYNC_SUCCEEDED',
  ALERT_DETAIL: JSON.stringify({
    traceId: 'SYNC-123456ABCDEF',
    trigger: 'manual',
    finishedAt: Date.parse('2026-08-11T12:00:00.000Z'),
    created: 2,
    updated: 3,
    down: 1,
    runId: 'raw-run-id-must-not-appear',
    recordId: 'raw-record-id-must-not-appear',
    url: 'https://example.invalid/private',
    phone: '13800138000'
  })
}, [])
assert.ok(syncSuccessText.includes('【寓你住一起｜同步成功】✅'), '成功通知必须使用醒目的独立标题')
assertReadableSuccess(syncSuccessText, '同步成功通知')
assert.ok(syncSuccessText.includes('手工同步'), 'manual 必须翻译为手工同步')
assert.ok(syncSuccessText.includes('新增 2 套、更新 3 套、下架 1 套'), '变更汇总必须说人话')
assert.ok(syncSuccessText.includes('已完成，无需处理'), '成功通知必须明确无需人工处理')
assert.ok(syncSuccessText.includes('SYNC-123456ABCDEF'), '成功通知必须包含脱敏追踪号')
;['系统告警', 'raw-run-id', 'raw-record-id', 'example.invalid', '13800138000', '{"'].forEach((secret) => {
  assert.ok(!syncSuccessText.includes(secret), `成功通知不得包含故障标题、原始标识或 raw JSON：${secret}`)
})

const scheduledSuccessText = alert.buildText({
  ALERT_KIND: 'FEISHU_SYNC_SUCCEEDED',
  ALERT_DETAIL: JSON.stringify({
    traceId: 'SYNC-ABCDEF123456',
    trigger: 'scheduled',
    finishedAt: Date.parse('2026-08-11T13:00:00.000Z'),
    created: 0,
    updated: 4,
    down: 0
  })
}, [])
assert.ok(scheduledSuccessText.includes('定时同步'), 'scheduled 必须翻译为定时同步')

const unsafeSuccessCounts = alert.buildText({
  ALERT_KIND: 'FEISHU_SYNC_SUCCEEDED',
  ALERT_DETAIL: JSON.stringify({
    traceId: 'SYNC-ABCDEF123456',
    trigger: 'manual',
    finishedAt: Date.parse('2026-08-11T13:00:00.000Z'),
    created: '9',
    updated: 1.5,
    down: -7
  })
}, [])
assert.ok(unsafeSuccessCounts.includes('新增 未确认、更新 未确认、下架 未确认'), '非安全整数必须拒绝显示，不得强转或夹成 0')
;['新增 9', '更新 1.5', '下架 -7'].forEach((raw) => assert.ok(!unsafeSuccessCounts.includes(raw), `不得显示不安全计数：${raw}`))

// 原因确实未知时必须明确未确认与取证动作，不得编造。
const unknownText = alert.buildText({ ALERT_KIND: 'RESTORE_FAILED', ALERT_MESSAGE: 'UNKNOWN', ALERT_DETAIL: '{}' }, [])
assertReadableAlert(unknownText, '未知原因告警')
assert.ok(unknownText.includes('原因尚未确认'), '未知原因必须明确尚未确认')
assert.ok(unknownText.includes('查看恢复演练日志'), '未知原因必须给出下一步取证方式')

// 敏感字段与原始响应正文必须剥离；手机号、token、webhook、密钥均不得进入正文。
const sensitiveText = alert.buildText({
  ALERT_KIND: 'REMOTE_UPLOAD_FAILED',
  ALERT_MESSAGE: '上传失败 token=very-secret 13800138000',
  ALERT_DETAIL: JSON.stringify({ webhook: 'https://example.invalid/private-hook', responseBody: 'raw production body', phone: '13800138000', file: 'db-backup-safe.ygbak', code: 'HTTP_500' })
}, [])
assertReadableAlert(sensitiveText, '脱敏告警')
;['very-secret', '13800138000', 'private-hook', 'raw production body'].forEach((secret) => {
  assert.ok(!sensitiveText.includes(secret), `告警不得泄露敏感内容：${secret}`)
})
assert.ok(!sensitiveText.includes('HTTP_500'), '机器码仅留本地分类，不得进群')

const arbitrarySensitive = alert.buildText({
  ALERT_KIND: 'REMOTE_UPLOAD_FAILED',
  ALERT_MESSAGE: '上游异常：客户甲，固定电话 0571-81234567，证件 330106199001011234，邮箱 owner@example.test，住址 湖滨路88号，文件 C:\\production\\customer-a.json',
  ALERT_DETAIL: JSON.stringify({ reason: '{"tenantName":"客户甲","address":"湖滨路88号"}', code: 'REMOTE_UPLOAD_FAILED' })
}, [])
;['客户甲', '0571-81234567', '330106199001011234', 'owner@example.test', '湖滨路88号', 'production', 'customer-a.json'].forEach((secret) => {
  assert.ok(!arbitrarySensitive.includes(secret), `自由错误正文不得进入告警：${secret}`)
})
assert.ok(arbitrarySensitive.includes('原因尚未确认'), '未命中受控原因规则时必须进入未知原因取证路径')

const safeDetailBypass = alert.buildText({
  ALERT_KIND: 'BACKUP_FAILED',
  ALERT_MESSAGE: '任意失败 permission denied',
  ALERT_TRACE_ID: '客户甲-owner@example.test',
  HEALTH_INCIDENT_ID: 'INC-湖滨路88号',
  ALERT_DETAIL: JSON.stringify({
    code: 'FEISHU_API_1254072',
    traceId: '客户甲-owner@example.test',
    state: '<xml>湖滨路88号</xml>',
    stage: 'C:\\production\\customer.json',
    newCounts: { listings: 3, '客户甲': 99 }
  })
}, [])
;['客户甲', 'owner@example.test', '湖滨路88号', 'production', 'customer.json', '字段值格式不符合飞书表格要求', '服务器文件权限不足'].forEach((secret) => {
  assert.ok(!safeDetailBypass.includes(secret), `安全明细或跨类型原因不得绕过白名单：${secret}`)
})
assert.ok(!/[{}]/.test(safeDetailBypass), '即使字段安全也不得把 JSON 明细发到群里')

// 重复失败项只展示一次。
const duplicateText = alert.buildText({ HEALTH_FAILURES: 'db,db,disk,disk', HEALTH_SUMMARY: '{"ok":false}' }, [])
assert.ok(!duplicateText.includes('数据库、数据库') && !duplicateText.includes('磁盘、磁盘'), '重复巡检项必须合并')

const healthReasonText = alert.buildText({
  HEALTH_FAILURES: 'service',
  HEALTH_SUMMARY: JSON.stringify({ ok: false, checks: [{ name: 'service', ok: false, detail: 'healthz 不可达' }], failures: ['service'] })
}, [])
assert.ok(healthReasonText.includes('问题：') && healthReasonText.includes('应用健康接口当前不可达'), '巡检拿得到真实原因时必须在人话问题中说明')

const syncHealthText = alert.buildText({
  HEALTH_FAILURES: 'feishuSync',
  HEALTH_SUMMARY: JSON.stringify({ ok: false, checks: [{ name: 'feishuSync', ok: false, detail: '同步存在未处置的未知或阻断任务', lastState: 'unknown' }], failures: ['feishuSync'] })
}, [])
assert.ok(syncHealthText.includes('飞书房源同步失败'), '同步巡检失败必须使用同步专用模板')
assert.ok(syncHealthText.includes('同步存在未处置的未知或阻断任务'), '同步巡检必须保留真实受控原因')

const maliciousHealthText = alert.buildText({
  HEALTH_FAILURES: 'feishuSync,owner@example.test',
  HEALTH_SUMMARY: JSON.stringify({
    ok: false,
    checks: [{
      name: 'feishuSync',
      ok: false,
      detail: '任意未知正文 owner@example.test 湖滨路88号',
      lastState: '<xml>secret-address</xml>',
      traceId: 'evil-trace owner@example.test',
      errorCode: 'FEISHU_API_1254072'
    }]
  })
}, [])
;['owner@example.test', '湖滨路88号', 'secret-address', 'evil-trace'].forEach((secret) => {
  assert.ok(!maliciousHealthText.includes(secret), `巡检摘要与未知失败项不得绕过白名单：${secret}`)
})
assert.ok(!maliciousHealthText.includes('FEISHU_API_1254072'), '巡检链机器码只用于本地分类，不得进群')

const fakeMachineCodeText = alert.buildText({
  HEALTH_FAILURES: 'feishuSync',
  HEALTH_SUMMARY: JSON.stringify({
    ok: false,
    checks: [{ name: 'feishuSync', ok: false, errorCode: 'OWNER_EMAIL_EXAMPLE_TEST' }]
  })
}, [])
assert.ok(!fakeMachineCodeText.includes('OWNER_EMAIL_EXAMPLE_TEST'), '仅形态合法但未列入该告警类型白名单的机器码不得外发')
assert.ok(!fakeMachineCodeText.includes('FEISHU_SYNC_FAILED') && !fakeMachineCodeText.includes('机器码：'), '未知机器码及归一类型均不得外发')

const registrationTraceBypass = alert.buildText({
  ALERT_KIND: 'REGISTRATION_NOTIFY_DEAD_LETTER',
  ALERT_DETAIL: JSON.stringify({ registrationRequestTraceId: 'CUSTOMER-JOHN-SMITH' })
}, [])
assert.ok(!registrationTraceBypass.includes('CUSTOMER-JOHN-SMITH'), '注册追踪编号不得接受任意字母数字自由文本')
const registrationTraceSafe = alert.buildText({
  ALERT_KIND: 'REGISTRATION_NOTIFY_DEAD_LETTER',
  ALERT_DETAIL: JSON.stringify({ registrationRequestTraceId: 'REQ-ABCDEF1234567890' })
}, [])
assert.ok(registrationTraceSafe.includes('排查编号：REQ-ABCDEF1234567890'), '服务端不可逆注册追踪编号必须可用于排查')

const unknownKindText = alert.buildText({ ALERT_KIND: 'OWNER_EMAIL_EXAMPLE_TEST' }, [])
assert.ok(!unknownKindText.includes('OWNER_EMAIL_EXAMPLE_TEST'), '未知告警类型不得作为机器码自由文本外发')
assert.ok(!unknownKindText.includes('ALERT_UNCLASSIFIED') && !unknownKindText.includes('机器码：'), '未知告警类型只能留在本地分类，不得外发')

const traceA = alert.buildText({ ALERT_KIND: 'BACKUP_FAILED', ALERT_TRACE_ID: 'AL-AAAAAAAAAAAAAAAA' }, [])
const traceB = alert.buildText({ ALERT_KIND: 'BACKUP_FAILED', ALERT_TRACE_ID: 'AL-BBBBBBBBBBBBBBBB' }, [])
const extractTrace = (text) => (text.match(/排查编号：([^\n]+)/) || [])[1]
assert.notStrictEqual(extractTrace(traceA), extractTrace(traceB), '不同发生实例不得复用同一追踪编号')
const stableTraceEnv = { ALERT_KIND: 'BACKUP_FAILED', ALERT_TRACE_ID: 'AL-ABCDEF1234567890' }
assert.strictEqual(extractTrace(alert.buildText(stableTraceEnv, [])), extractTrace(alert.buildText(stableTraceEnv, [])), '同一事件重试必须沿用同一追踪编号')

const syncHealthFingerprint = (traceId, incidentId) => alert.alertFingerprint({
  HEALTH_FAILURES: 'feishuSync',
  HEALTH_INCIDENT_ID: incidentId,
  HEALTH_SUMMARY: JSON.stringify({
    ok: false,
    checks: [{ name: 'feishuSync', ok: false, detail: '同步前检查没有通过，本次没有更新小程序房源', traceId }]
  })
})
const firstSyncFailureFingerprint = syncHealthFingerprint('SYNC-AAAAAAAAAAAA', 'INC-1111111111111111')
assert.notStrictEqual(
  firstSyncFailureFingerprint,
  syncHealthFingerprint('SYNC-BBBBBBBBBBBB', 'INC-1111111111111111'),
  '同一健康事故号下的新同步任务必须生成新指纹，不能被旧事故去重吞掉'
)
assert.strictEqual(
  firstSyncFailureFingerprint,
  syncHealthFingerprint('SYNC-AAAAAAAAAAAA', 'INC-2222222222222222'),
  '同一同步追踪号重试必须保持同一指纹，即使健康事故号变化'
)

// 真实外发无需 webhook：transport 可注入，测试只验证本地行为。
let fakeDelivery = null
alert.sendAlert({
  env: { HEALTH_ALERT_WEBHOOK: 'http://local.invalid/fake', ALERT_KIND: 'BACKUP_STALE', ALERT_MESSAGE: '最近备份超过阈值' },
  dedupeStore: { claim: () => ({ duplicate: false, markSent() {}, release() {} }) },
  transport: (target, payload, callback) => {
    fakeDelivery = { target, payload }
    callback(null)
  }
}, (error) => assert.ifError(error))
assert.ok(fakeDelivery && fakeDelivery.payload.content.text.includes('备份长时间没有更新'), '可注入 fake transport 必须收到完整可读模板')

let dedupeDeliveries = 0
const claimed = new Set()
const fakeDedupeStore = {
  claim(key) {
    if (claimed.has(key)) return { duplicate: true, release() {} }
    claimed.add(key)
    return { duplicate: false, markSent() {}, release() { claimed.delete(key) } }
  }
}
const dedupeOptions = {
  env: { HEALTH_ALERT_WEBHOOK: 'http://local.invalid/fake', ALERT_KIND: 'BACKUP_STALE', ALERT_MESSAGE: '最近备份超过阈值' },
  dedupeStore: fakeDedupeStore,
  transport: (_target, _payload, callback) => { dedupeDeliveries += 1; callback(null) }
}
alert.sendAlert(dedupeOptions, (error) => assert.ifError(error))
alert.sendAlert(dedupeOptions, (error, result) => {
  assert.ifError(error)
  assert.strictEqual(result && result.deduplicated, true, '重复告警应返回已合并状态')
})
assert.strictEqual(dedupeDeliveries, 1, '同一告警在时间窗内只允许外发一次')

let retryDeliveries = 0
const retryClaims = new Set()
const retryStore = {
  claim(key) {
    if (retryClaims.has(key)) return { duplicate: true, markSent() {}, release() {} }
    retryClaims.add(key)
    return { duplicate: false, markSent() {}, release() { retryClaims.delete(key) } }
  }
}
const retryOptions = {
  env: { HEALTH_ALERT_WEBHOOK: 'http://local.invalid/fake', ALERT_KIND: 'RESTORE_FAILED' },
  dedupeStore: retryStore,
  transport: (_target, _payload, callback) => {
    retryDeliveries += 1
    callback(retryDeliveries === 1 ? new Error('本地失败桩') : null)
  }
}
alert.sendAlert(retryOptions, (error) => assert.ok(error, '首次失败必须返回错误'))
alert.sendAlert(retryOptions, (error) => assert.ifError(error))
assert.strictEqual(retryDeliveries, 2, '外发失败必须释放去重占位并允许重试')

alert.sendAlert({
  env: { HEALTH_ALERT_WEBHOOK: 'http://local.invalid/fake', ALERT_KIND: 'BACKUP_FAILED' },
  dedupeStore: { claim: () => ({ duplicate: false, markSent() {}, release() { throw Object.assign(new Error('local state failure'), { code: 'EIO' }) } }) },
  transport: (_target, _payload, callback) => callback(new Error('local transport failure'))
}, (error) => assert.ok(error && error.message.includes('占位释放失败') && error.message.includes('EIO'), 'release 异常必须受控回调，不得逃成未捕获异常'))

alert.sendAlert({
  env: { HEALTH_ALERT_WEBHOOK: 'http://local.invalid/fake', ALERT_KIND: 'BACKUP_FAILED' },
  dedupeStore: { claim: () => ({ duplicate: false, markSent() { throw Object.assign(new Error('local state failure'), { code: 'EIO' }) }, release() {} }) },
  transport: (_target, _payload, callback) => callback(null)
}, (error) => assert.ok(error && error.message.includes('持久去重状态写入失败') && error.message.includes('EIO'), 'markSent 异常必须受控回调并声明送达状态不确定'))

let firstTransportCallback
let raceClaims = 0
const raceStore = {
  claim() {
    raceClaims += 1
    return raceClaims === 1
      ? { duplicate: false, markSent() {}, release() {} }
      : { duplicate: true, inFlight: true, markSent() {}, release() {} }
  }
}
alert.sendAlert({
  env: { HEALTH_ALERT_WEBHOOK: 'http://local.invalid/fake', ALERT_KIND: 'BACKUP_FAILED', ALERT_TRACE_ID: 'AL-1111111111111111' },
  dedupeStore: raceStore,
  transport: (_target, _payload, callback) => { firstTransportCallback = callback }
}, (error) => assert.ok(error, '首个在途失败应反馈给首调用方'))
alert.sendAlert({
  env: { HEALTH_ALERT_WEBHOOK: 'http://local.invalid/fake', ALERT_KIND: 'BACKUP_FAILED', ALERT_TRACE_ID: 'AL-1111111111111111' },
  dedupeStore: raceStore,
  transport: () => { throw new Error('在途重复不得进入 transport') }
}, (error) => assert.ok(error && error.message.includes('正在发送'), '在途重复不得提前报告发送成功'))
firstTransportCallback(new Error('首发失败'))

assert.strictEqual(
  alert.resolveAlertDedupeDir({}),
  path.join(__dirname, '..', 'data', '.feishu-alert-dedupe'),
  '默认去重目录必须位于部署保留的 server/data，不能再依赖系统临时目录'
)
assert.strictEqual(
  alert.resolveAlertDedupeDir({ HEALTH_ALERT_DEDUPE_DIR: '/private/custom-alert-state' }),
  '/private/custom-alert-state',
  '服务器私有 HEALTH_ALERT_DEDUPE_DIR 必须仍可覆盖默认目录'
)

let expiryRaceReads = 0
let expiryRaceUnlinks = 0
const expiryRaceFs = {
  mkdirSync() {},
  openSync() {
    const error = new Error('exists')
    error.code = 'EEXIST'
    throw error
  },
  readFileSync() {
    expiryRaceReads += 1
    return expiryRaceReads === 1 ? 'sent:0:old-owner-token' : 'sent:1:new-owner-token'
  },
  unlinkSync() { expiryRaceUnlinks += 1 }
}
const expiryRaceClaim = alert.createFileDedupeStore({
  dir: '/persistent/alerts',
  fsOps: expiryRaceFs,
  now: () => 8 * 24 * 60 * 60 * 1000
}).claim('f'.repeat(64))
assert.strictEqual(expiryRaceClaim.duplicate, true, '过期判断后 marker 内容变化时必须保守视为已有新 owner')
assert.strictEqual(expiryRaceClaim.inFlight, true, '竞态中的新 owner 必须按仍在派发处理')
assert.strictEqual(expiryRaceUnlinks, 0, '过期清理不得删除二次确认时已变化的 marker')

const durableCalls = []
let durableFd = 20
const durableFs = {
  mkdirSync: (_dir, options) => durableCalls.push(['mkdir', options.mode]),
  openSync: (target, flags, mode) => { const fd = durableFd++; durableCalls.push(['open', path.basename(target), flags, mode, fd]); return fd },
  writeFileSync: (fd) => durableCalls.push(['write', fd]),
  fsyncSync: (fd) => durableCalls.push(['fsync', fd]),
  closeSync: (fd) => durableCalls.push(['close', fd]),
  renameSync: (from, to) => durableCalls.push(['rename', path.basename(from), path.basename(to)]),
  unlinkSync: (target) => durableCalls.push(['unlink', path.basename(target)])
}
alert.createPendingDedupeMarker('/persistent/alerts/pending.sent', 'pending:1:token', { fsOps: durableFs, platform: 'linux' })
const pendingMarkerOpen = durableCalls.find((call) => call[0] === 'open' && call[2] === 'wx')
const pendingDirOpen = durableCalls.find((call) => call[0] === 'open' && call[2] === 'r')
assert.ok(pendingMarkerOpen && pendingMarkerOpen[3] === 0o600, 'pending 必须以 0600 O_EXCL 创建')
assert.ok(
  durableCalls.findIndex((call) => call[0] === 'fsync' && call[1] === pendingMarkerOpen[4]) <
  durableCalls.findIndex((call) => call[0] === 'fsync' && call[1] === pendingDirOpen[4]),
  'pending 必须先 fsync 文件、再 fsync 父目录'
)
durableCalls.length = 0
alert.replaceDedupeMarker('/persistent/alerts/pending.sent', 'sent:2:token', { fsOps: durableFs, platform: 'linux' })
const sentTempOpen = durableCalls.find((call) => call[0] === 'open' && call[2] === 'wx')
const sentRenameIndex = durableCalls.findIndex((call) => call[0] === 'rename')
const sentFsyncIndexes = durableCalls.map((call, index) => call[0] === 'fsync' ? index : -1).filter((index) => index >= 0)
assert.ok(sentTempOpen && sentTempOpen[3] === 0o600, 'sent 必须先写 0600 临时文件')
assert.ok(sentFsyncIndexes.length === 2 && sentFsyncIndexes[0] < sentRenameIndex && sentRenameIndex < sentFsyncIndexes[1], 'sent 必须按文件 fsync→rename→父目录 fsync 落盘')

const dedupeDir = path.join(os.tmpdir(), `ynzy-alert-store-test-${process.pid}-${Date.now()}`)
let dedupeNow = 1_000_000
try {
  const fileStore = alert.createFileDedupeStore({ dir: dedupeDir, windowMs: 1000, now: () => dedupeNow })
  const firstClaim = fileStore.claim('a'.repeat(64))
  assert.strictEqual(firstClaim.duplicate, false, '首次跨进程去重占位必须成功')
  firstClaim.markSent()
  assert.strictEqual(fileStore.claim('a'.repeat(64)).duplicate, true, '时间窗内相同指纹必须判重复')
  dedupeNow += 1001
  assert.strictEqual(fileStore.claim('a'.repeat(64)).duplicate, false, '时间窗过后允许再次告警')

  const releasedClaim = fileStore.claim('c'.repeat(64))
  releasedClaim.release()
  assert.strictEqual(fileStore.claim('c'.repeat(64)).duplicate, false, '发送失败释放持久占位后必须允许重试')

  let sevenDayNow = 2_000_000
  const sevenDayStore = alert.createFileDedupeStore({ dir: dedupeDir, now: () => sevenDayNow })
  const sevenDayClaim = sevenDayStore.claim('d'.repeat(64))
  sevenDayClaim.markSent()
  sevenDayNow += 6 * 24 * 60 * 60 * 1000
  assert.strictEqual(sevenDayStore.claim('d'.repeat(64)).duplicate, true, '稳定事故六天内仍不得重复刷群')
  sevenDayNow += 24 * 60 * 60 * 1000 + 1
  assert.strictEqual(sevenDayStore.claim('d'.repeat(64)).duplicate, false, '稳定事故满七天后才允许再次提醒')
} finally {
  fs.rmSync(dedupeDir, { recursive: true, force: true })
}

const durableRestartDir = path.join(os.tmpdir(), `ynzy-alert-durable-restart-${process.pid}-${Date.now()}`)
try {
  const restartKey = 'e'.repeat(64)
  const child = spawnSync(process.execPath, ['-e', [
    `const alert=require(${JSON.stringify(scriptPath)})`,
    `const store=alert.createFileDedupeStore({dir:process.env.TEST_DIR})`,
    `store.claim('${restartKey}',{neverExpireSent:true}).markSent()`
  ].join(';')], { env: { ...process.env, TEST_DIR: durableRestartDir }, encoding: 'utf8' })
  assert.strictEqual(child.status, 0, `子进程持久 sent 必须成功：${child.stderr}`)
  const restartedStore = alert.createFileDedupeStore({ dir: durableRestartDir })
  assert.strictEqual(restartedStore.claim(restartKey, { neverExpireSent: true }).duplicate, true, '进程重启后成功通知 sent 身份必须继续去重')
  assert.deepStrictEqual(fs.readdirSync(durableRestartDir), [`${restartKey}.sent`], '原子 sent 落盘后不得遗留临时文件')
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(durableRestartDir, `${restartKey}.sent`)).mode & 0o777, 0o600, 'sent 文件权限必须为 0600')

  let longTermNow = 10_000
  const longTermKey = 'f'.repeat(64)
  const longTermStore = alert.createFileDedupeStore({ dir: durableRestartDir, windowMs: 1000, now: () => longTermNow })
  const longTermClaim = longTermStore.claim(longTermKey, { neverExpireSent: true })
  longTermClaim.markSent()
  longTermNow += 10 * 365 * 24 * 60 * 60 * 1000
  assert.strictEqual(longTermStore.claim(longTermKey, { neverExpireSent: true }).duplicate, true, '同步成功 sent 身份不得随普通七天窗口自动过期')
} finally {
  fs.rmSync(durableRestartDir, { recursive: true, force: true })
}

const crashDir = path.join(os.tmpdir(), `ynzy-alert-crash-test-${process.pid}-${Date.now()}`)
try {
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(scriptPath)}).createFileDedupeStore({dir:process.env.TEST_DIR,pendingMs:50}).claim('${'b'.repeat(64)}')`], {
    env: { ...process.env, TEST_DIR: crashDir }, encoding: 'utf8'
  })
  assert.strictEqual(child.status, 0, `崩溃模拟子进程应成功占位：${child.stderr}`)
  const crashStore = alert.createFileDedupeStore({ dir: crashDir, pendingMs: 50 })
  const duringCrashLease = crashStore.claim('b'.repeat(64))
  assert.strictEqual(duringCrashLease.inFlight, true, '崩溃后的短租约内必须报告在途而非成功')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80)
  assert.strictEqual(crashStore.claim('b'.repeat(64)).duplicate, false, '崩溃租约过期后必须允许其他进程接管发送')
} finally {
  fs.rmSync(crashDir, { recursive: true, force: true })
}

// 手动参数兜底
assert.ok(alert.buildText({}, ['测试', '消息']).includes('测试 消息'), '无契约变量时用命令行参数')
assert.ok(!/[{}]/.test(alert.buildText({}, ['测试', '{"raw":1}'])), '手动通知也不得把 JSON 花括号发到群里')

// 超长截断
const longText = alert.truncate('y'.repeat(5000), 1800)
assert.ok(longText.length <= 1800 + 8, `超长必须截断，实际 ${longText.length}`)
assert.ok(longText.includes('(截断)'), '截断需有标记')

// 签名算法：sign = base64(HMAC-SHA256(key=`${ts}\n${secret}`, ""))
const sign = alert.signPayload('mysecret', '1700000000')
const expectSign = crypto.createHmac('sha256', '1700000000\nmysecret').update('').digest('base64')
assert.strictEqual(sign, expectSign, '签名算法必须符合飞书规范')

const signedPayload = alert.buildPayload({ HEALTH_ALERT_SECRET: 'mysecret', ALERT_KIND: 'K', ALERT_MESSAGE: 'm' }, [])
assert.ok(signedPayload.timestamp && signedPayload.sign, '配了 secret 必须带 timestamp+sign')
assert.strictEqual(alert.signPayload('mysecret', signedPayload.timestamp), signedPayload.sign, 'payload 签名可复算')
const plainPayload = alert.buildPayload({ ALERT_KIND: 'K', ALERT_MESSAGE: 'm' }, [])
assert.ok(!plainPayload.timestamp && !plainPayload.sign, '未配 secret 不带签名字段')
assert.strictEqual(plainPayload.msg_type, 'text', 'msg_type 应为 text')

// ---------- 端到端：真起子进程打本地假 webhook ----------

// 必须用异步 spawn：spawnSync 会阻塞父进程事件循环，本测试的 http 桩就在父进程里，
// 同步等子进程 = 桩永远无法响应 = 子进程干等超时（死锁）。
function runScript(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...(args || [])], {
      env: { ...process.env, HEALTH_ALERT_DEDUPE_DIR: path.join(os.tmpdir(), `ynzy-alert-test-${process.pid}-${Date.now()}-${Math.random()}`), ...env }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const killer = setTimeout(() => child.kill(), 20000)
    child.on('close', (status) => {
      clearTimeout(killer)
      resolve({ status, stdout, stderr })
    })
  })
}

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/hook`
  try {
    return await fn(url)
  } finally {
    server.close()
  }
}

async function run() {
  // 1. 成功：接收体是合法 JSON、含契约内容，脚本退出 0
  let received = null
  await withServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      received = JSON.parse(raw)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, msg: 'success' }))
    })
  }, async (url) => {
    const result = await runScript({ HEALTH_ALERT_WEBHOOK: url, ALERT_KIND: 'BACKUP_STALE', ALERT_MESSAGE: '最近备份超过 24 小时' })
    assert.strictEqual(result.status, 0, `成功场景应退出 0：${result.stderr}`)
    assert.strictEqual(received.msg_type, 'text', '发送体 msg_type=text')
    assert.ok(received.content.text.includes('备份长时间没有更新'), '发送体应含中文问题而不是机器类型')
    assert.ok(!received.content.text.includes('BACKUP_STALE'), '真实发送体不得含机器码')
  })

  // 2. 飞书返回业务失败（code!=0）→ 退出非零
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 19001, msg: 'param invalid' }))
  }, async (url) => {
    const result = await runScript({ HEALTH_ALERT_WEBHOOK: url, HEALTH_FAILURES: 'service' })
    assert.notStrictEqual(result.status, 0, '飞书返回失败必须非零退出')
    assert.ok(result.stderr.includes('19001'), 'stderr 应含飞书错误')
  })

  // 3. HTTP 非 2xx → 退出非零
  await withServer((req, res) => {
    res.writeHead(500)
    res.end('boom')
  }, async (url) => {
    const result = await runScript({ HEALTH_ALERT_WEBHOOK: url, HEALTH_FAILURES: 'db' })
    assert.notStrictEqual(result.status, 0, 'HTTP 500 必须非零退出')
  })

  // 4. 未配 webhook → 退出 2，stderr 有指引
  const noHook = await runScript({ HEALTH_ALERT_WEBHOOK: '' }, ['手动测试'])
  assert.strictEqual(noHook.status, 2, '缺 webhook 应退出 2')
  assert.ok(noHook.stderr.includes('HEALTH_ALERT_WEBHOOK'), '应提示缺哪个变量')

  // 5. 带签名端到端：服务端复算签名一致
  let signedBody = null
  await withServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      signedBody = JSON.parse(raw)
      res.writeHead(200)
      res.end(JSON.stringify({ code: 0 }))
    })
  }, async (url) => {
    const result = await runScript({ HEALTH_ALERT_WEBHOOK: url, HEALTH_ALERT_SECRET: 's3cret', ALERT_KIND: 'RESTORE_FAILED', ALERT_MESSAGE: '演练失败' })
    assert.strictEqual(result.status, 0, `签名场景应成功：${result.stderr}`)
    const expect = crypto.createHmac('sha256', `${signedBody.timestamp}\ns3cret`).update('').digest('base64')
    assert.strictEqual(signedBody.sign, expect, '服务端复算签名必须一致')
  })
}

run().then(() => {
  console.log('send-feishu-alert-v1-test passed')
}).catch((error) => {
  console.error(`send-feishu-alert-v1-test failed: ${error.message}`)
  process.exit(1)
})
