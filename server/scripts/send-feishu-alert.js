// 飞书群机器人告警脚本（零依赖）：把巡检/备份链的失败信号推到飞书群，解决「告警只进 journald 没人看」。
//
// 同时服务两条既有告警契约（谁配了就从谁的环境变量取内容）：
// - HEALTH_ALERT_CMD（server/scripts/health-check.js）：子进程 env 走白名单，只透传 HEALTH_ALERT_* 前缀
//   与 HEALTH_FAILURES / HEALTH_SUMMARY —— 因此 webhook 必须命名为 HEALTH_ALERT_WEBHOOK 才能穿过白名单。
// - BACKUP_ALERT_CMD（server/src/backup.js defaultAlertSink）：全量 env + ALERT_KIND / ALERT_MESSAGE /
//   ALERT_DETAIL（备份失败/自检失败/异地上传失败/备份过期/恢复演练失败等）。
//
// 配置（/etc/default/ynzy-backup，chmod 600，webhook 属敏感配置，不进仓库不进聊天）：
//   HEALTH_ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx   # 必填
//   HEALTH_ALERT_SECRET=xxxx        # 可选：机器人开了「签名校验」才填
//   HEALTH_ALERT_CMD=node /opt/ynzy-miniapp/server/scripts/send-feishu-alert.js
//   BACKUP_ALERT_CMD=node /opt/ynzy-miniapp/server/scripts/send-feishu-alert.js
// 本地行为测试通过注入 transport 或本地桩完成；不要用真实机器人做连通性测试。
//
// 失败语义：发送失败（缺 webhook/超时/飞书返回非 0）→ stderr + 非零退出，由调用方记日志；绝不抛未捕获异常。

const https = require('https')
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { URL } = require('url')

const MAX_TEXT_LENGTH = 1800 // 飞书文本消息留余量截断，防超长被拒
const TIMEOUT_MS = 10000 // 必须小于两条调用链各自的 15s execSync 限时
const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const SERVER_DIR = path.join(__dirname, '..')
const DEFAULT_DEDUPE_DIR = path.join(SERVER_DIR, 'data', '.feishu-alert-dedupe')

const CHECK_LABELS = {
  db: '数据库', disk: '磁盘', backup: '备份', service: '应用服务', feishuSync: '飞书同步'
}

const KIND_TEMPLATES = {
  BACKUP_FAILED: ['紧急', '加密备份生成失败', '本轮没有生成可用的新备份', '失败，等待人工处理', '检查备份服务日志、磁盘空间、源数据文件权限和加密配置'],
  BACKUP_VERIFY_FAILED: ['紧急', '新备份自检失败', '新备份已判定不可用于恢复', '已停止外发并删除不可信备份', '检查恢复自检日志和备份文件完整性'],
  BACKUP_EMPTY_SOURCE: ['紧急', '备份源疑似被清空或截断', '本轮空备份已拦截，上一份可信备份仍保留', '已停止本轮备份', '立即核对数据库文件、最近写入记录和上一份备份计数'],
  BACKUP_BASELINE_UNREADABLE: ['警告', '上一份备份无法验证', '跨备份空源校验失去可信基线', '风险仍在继续', '核对密钥轮换记录、上一份备份完整性和恢复日志'],
  BACKUP_REMOTE_REQUIRED: ['警告', '异地备份目标未配置', '本地备份可能存在，但没有形成异地副本', '风险仍在继续', '检查服务器私有环境中的异地备份命令配置'],
  REMOTE_UPLOAD_FAILED: ['紧急', '备份上传到异地失败', '本地备份可能已生成，但异地副本未更新', '失败，等待下一次成功上传或人工处理', '检查异地存储权限、网络与上传任务日志'],
  RESTORE_MISMATCH: ['紧急', '恢复演练的数据校验不一致', '当前备份不能证明可完整恢复', '失败，等待人工处理', '对照演练计数和备份元数据，禁止直接用于生产恢复'],
  RESTORE_FAILED: ['紧急', '恢复演练失败', '当前备份的可恢复性尚未得到确认', '失败，等待人工处理', '查看恢复演练日志，核对备份文件、解密配置和临时空间'],
  BACKUP_STALE: ['警告', '备份长时间没有更新', '发生故障时可能只能恢复到较早数据', '风险仍在继续', '检查备份定时器、最近一次备份任务和异地上传状态'],
  FEISHU_SYNC_FAILED: ['紧急', '飞书房源同步失败', '公司房源可能没有更新或只完成了部分步骤', '失败状态需以任务记录为准', '把排查编号发给技术人员；在确认前不要重复点击同步'],
  FEISHU_SYNC_SUCCEEDED: ['通知', '飞书房源正式同步已完成', '小程序在租房源已按本轮结果更新', '已完成，无需处理', '无需处理'],
  REGISTRATION_NOTIFY_DEAD_LETTER: ['警告', '注册申请通知多次发送失败', '管理员可能没有及时看到待审核事项', '通知已停止自动重试', '到管理后台人工检查待审核申请，并排查通知发送链'],
  HEALTH_CHECK_FAILED: ['紧急', '系统健康巡检发现异常', '受影响检查项对应的服务能力可能不可用', '异常是否持续需以下一次巡检为准', '按失败项检查服务状态和对应日志']
}

const SYSTEM_ACTIONS = {
  BACKUP_FAILED: '已把本轮标记为失败，不会把不完整文件当成可用备份',
  BACKUP_VERIFY_FAILED: '已停止本轮备份，不会把未通过校验的文件当成可用备份',
  BACKUP_EMPTY_SOURCE: '已阻止本轮空备份继续进入异地存储',
  BACKUP_BASELINE_UNREADABLE: '已记录基线异常，并保留现有备份供人工核对',
  BACKUP_REMOTE_REQUIRED: '已把本轮标记为失败，不会把仅本机文件当成异地备份',
  REMOTE_UPLOAD_FAILED: '已保留本机加密备份和失败记录，等待下次任务或人工处理',
  RESTORE_MISMATCH: '已停止恢复演练，不会把不一致的结果用于生产恢复',
  RESTORE_FAILED: '已停止恢复演练，不会把未验证的备份用于生产恢复',
  BACKUP_STALE: '已发出提醒并保留现有备份，未删除任何备份文件',
  FEISHU_SYNC_FAILED: '已记录同步异常并保留任务状态，没有把失败任务当成成功',
  REGISTRATION_NOTIFY_DEAD_LETTER: '已停止本次通知的自动重试，并保留待审核记录',
  HEALTH_CHECK_FAILED: '已记录本次异常并保留巡检日志，等待下一次巡检复核',
  ALERT_UNCLASSIFIED: '已记录本次异常并保留日志，没有自动执行高风险处理'
}

const KNOWN_REASONS = {
  FEISHU_SYNC_FAILED: {
    FEISHU_API_1254072: '字段值格式不符合飞书表格要求'
  },
  BACKUP_FAILED: {
    ENOSPC: '服务器磁盘空间不足', EACCES: '服务器文件权限不足', EPERM: '服务器文件权限不足'
  },
  REMOTE_UPLOAD_FAILED: {
    ETIMEDOUT: '异地上传执行超时', EACCES: '异地上传权限不足', EPERM: '异地上传权限不足',
    HTTP_401: '异地服务拒绝了身份校验', HTTP_403: '异地服务拒绝了当前权限',
    HTTP_429: '异地服务请求过于频繁', HTTP_500: '异地服务发生内部错误'
  }
}

const SENSITIVE_KEY = /(?:token|secret|password|passwd|webhook|authorization|cookie|phone|mobile|response(?:body|text|raw)|rawresponse)/i
const SAFE_DETAIL_KEYS = new Set([
  'ok', 'code', 'errorCode', 'traceId', 'state', 'stage', 'notifyAttempts', 'deadLetterAt',
  'registrationRequestTraceId', 'newCounts', 'priorCounts',
  'trigger', 'finishedAt', 'created', 'updated', 'down'
])

const SAFE_STATES = new Set(['unknown', 'blocked', 'failed', 'failed-before-write', 'succeeded', 'dry-succeeded', 'dead_letter'])
const SAFE_STAGES = new Set(['backup', 'verify', 'upload', 'restore', 'health', 'sync', 'notify'])
const SAFE_SYNC_TRIGGERS = new Set(['manual', 'scheduled'])
const SAFE_COUNT_KEYS = new Set(['listings', 'users', 'reports', 'deals', 'commissionRecords', 'footprints', 'favorites'])
const HEALTH_REASON_MAP = new Map([
  ['healthz 不可达', '应用健康接口当前不可达'],
  ['同步存在未处置的未知或阻断任务', '同步存在未处置的未知或阻断任务'],
  ['同步控制器租约完整性异常', '同步控制器租约状态异常'],
  ['同步控制器活动租约不一致', '同步控制器租约状态异常'],
  ['自动同步尚无受信成功记录', '自动同步尚无受信成功记录'],
  ['自动同步成功记录已超过健康窗口', '自动同步成功记录已超过健康窗口'],
  ['最近一次正式同步的素材处理没有完整完成', '最近一次正式同步的素材处理没有完整完成'],
  ['同步前检查没有通过，本次没有更新小程序房源', '同步前检查没有通过，本次没有更新小程序房源'],
  ['最近一次正式同步的完成记录未通过完整性校验', '最近一次同步的完成记录未通过系统完整性校验']
])

function truncate(text, max) {
  const value = String(text == null ? '' : text)
  return value.length > max ? `${value.slice(0, max)}…(截断)` : value
}

function sanitizeText(value) {
  return String(value == null ? '' : value)
    .replace(/https?:\/\/[^\s]+/gi, '[链接已隐藏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]')
    .replace(/\b(?:token|secret|password|passwd|webhook|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/[{}]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
}

function parseSafeDetail(raw) {
  let detail = {}
  try { detail = raw ? JSON.parse(raw) : {} } catch (_error) { detail = {} }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {}
  const safe = {}
  for (const key of Object.keys(detail)) {
    if (!SAFE_DETAIL_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue
    const value = detail[key]
    if (key === 'ok' && typeof value === 'boolean') safe[key] = value
    else if (['code', 'errorCode'].includes(key) && /^[A-Z][A-Z0-9_-]{2,63}$/.test(String(value || '').toUpperCase())) safe[key] = String(value).toUpperCase()
    else if (key === 'traceId' && /^(?:SYNC|INC|AL)-[A-F0-9]{12,64}$/.test(String(value || '').toUpperCase())) safe[key] = String(value).toUpperCase()
    else if (key === 'registrationRequestTraceId' && /^REQ-[A-F0-9]{16}$/.test(String(value || '').toUpperCase())) safe[key] = String(value).toUpperCase()
    else if (key === 'state' && SAFE_STATES.has(String(value || ''))) safe[key] = String(value)
    else if (key === 'stage' && SAFE_STAGES.has(String(value || ''))) safe[key] = String(value)
    else if (key === 'notifyAttempts' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100) safe[key] = Number(value)
    else if (key === 'deadLetterAt' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(value || ''))) safe[key] = String(value)
    else if (key === 'trigger' && SAFE_SYNC_TRIGGERS.has(String(value || ''))) safe[key] = String(value)
    else if (key === 'finishedAt' && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) safe[key] = value
    else if (['created', 'updated', 'down'].includes(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[key] = value
    else if (['newCounts', 'priorCounts'].includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      safe[key] = Object.fromEntries(Object.entries(value).filter(([countKey, countValue]) => (
        SAFE_COUNT_KEYS.has(countKey) && Number.isSafeInteger(Number(countValue)) && Number(countValue) >= 0
      )).map(([countKey, countValue]) => [countKey, Number(countValue)]))
    }
  }
  return safe
}

function safeMachineCode(kind, detail) {
  const candidate = String(detail.code || detail.errorCode || '').toUpperCase()
  if (KNOWN_REASONS[kind] && Object.prototype.hasOwnProperty.call(KNOWN_REASONS[kind], candidate)) return candidate
  return Object.prototype.hasOwnProperty.call(KIND_TEMPLATES, kind) ? kind : 'ALERT_UNCLASSIFIED'
}

function confirmedReason(message, code, kind) {
  if (KNOWN_REASONS[kind] && KNOWN_REASONS[kind][code]) return KNOWN_REASONS[kind][code]
  if (kind === 'BACKUP_REMOTE_REQUIRED') return '服务器没有配置有效的异地备份目标'
  if (kind === 'BACKUP_EMPTY_SOURCE') return '本次备份计数全为零，但上一份可信备份仍有数据'
  if (kind === 'BACKUP_BASELINE_UNREADABLE') return '上一份备份无法通过完整性验证'
  if (kind === 'BACKUP_STALE') return '最近一次成功备份已经超过允许时间窗口'
  if (kind === 'RESTORE_MISMATCH') return '恢复结果与备份元数据计数不一致'
  return '原因尚未确认'
}

function traceId(kind, detail, env) {
  const machineTrace = String(detail.traceId || '').toUpperCase()
  if (/^(?:SYNC|INC|AL)-[A-F0-9]{12,64}$/.test(machineTrace)) return machineTrace
  const registrationTrace = String(detail.registrationRequestTraceId || '')
  if (/^REQ-[A-F0-9]{16}$/.test(registrationTrace)) return registrationTrace
  const alertTrace = String(env.ALERT_TRACE_ID || '').toUpperCase()
  if (/^AL-[A-F0-9]{16}$/.test(alertTrace)) return alertTrace
  const healthIncident = String(env.HEALTH_INCIDENT_ID || '').toUpperCase()
  if (/^INC-[A-F0-9]{16}$/.test(healthIncident)) return healthIncident
  return `AL-${alertFingerprint(env).slice(0, 12).toUpperCase()}`
}

function healthAlert(env) {
  const failures = [...new Set(String(env.HEALTH_FAILURES || '').split(',').map((item) => item.trim()).filter((item) => Object.prototype.hasOwnProperty.call(CHECK_LABELS, item)))]
  const labels = failures.map((item) => CHECK_LABELS[item])
  const detail = parseSafeDetail(env.HEALTH_SUMMARY)
  let summary = {}
  try { summary = JSON.parse(env.HEALTH_SUMMARY || '{}') } catch (_error) { summary = {} }
  const failedChecks = Array.isArray(summary.checks) ? summary.checks.filter((item) => item && item.ok === false) : []
  const reasonParts = failedChecks.map((item) => {
    const raw = String(item && item.detail || '')
    if (HEALTH_REASON_MAP.has(raw)) return HEALTH_REASON_MAP.get(raw)
    if (raw.startsWith('db.json 不可解析：') || raw === 'db.json 缺 listings 数组' || raw.startsWith('db.json 读取失败：')) return '数据库文件读取或结构校验失败'
    if (item && item.name === 'disk' && item.ok === false) return '服务器磁盘可用空间低于安全阈值'
    if (item && item.name === 'backup' && item.ok === false) return '最近备份未达到新鲜度要求'
    return ''
  }).filter(Boolean)
  const reason = reasonParts.length ? [...new Set(reasonParts)].join('；') : '原因尚未确认'
  const syncOnly = failures.length === 1 && failures[0] === 'feishuSync'
  const syncCheck = failedChecks.find((item) => item && item.name === 'feishuSync')
  if (syncCheck) {
    Object.assign(detail, parseSafeDetail(JSON.stringify({
      state: syncCheck.lastState,
      traceId: syncCheck.traceId,
      code: syncCheck.errorCode
    })))
  }
  return {
    kind: syncOnly ? 'FEISHU_SYNC_FAILED' : 'HEALTH_CHECK_FAILED',
    detail,
    message: reason,
    impact: syncOnly
      ? '本次小程序房源可能还不是最新；安排带看前请先向管家确认房态'
      : (labels.length ? `${labels.join('、')}对应的服务能力可能不可用` : undefined),
    happened: syncOnly ? '飞书房源同步失败' : (labels.length ? `系统健康巡检发现异常：${labels.join('、')}` : undefined)
  }
}

function renderSyncSuccess(env, detail) {
  const countText = (key) => Object.prototype.hasOwnProperty.call(detail, key) ? String(detail[key]) : '未确认'
  const trigger = detail.trigger === 'manual'
    ? '手工同步'
    : (detail.trigger === 'scheduled' ? '定时同步' : '未确认')
  const finishedAt = Number.isSafeInteger(detail.finishedAt) && detail.finishedAt > 0
    ? new Date(detail.finishedAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    : '未确认'
  const lines = [
    '【寓你住一起｜同步成功】✅',
    `完成时间：${finishedAt}`,
    `同步方式：${trigger}`,
    '发生了什么：飞书房源正式同步已完成',
    '结果与影响：小程序在租房源已按本轮同步结果更新',
    `变更汇总：新增 ${countText('created')}${countText('created') === '未确认' ? '' : ' 套'}、更新 ${countText('updated')}${countText('updated') === '未确认' ? '' : ' 套'}、下架 ${countText('down')}${countText('down') === '未确认' ? '' : ' 套'}`,
    '当前状态：已完成，无需处理',
    `排查编号：${traceId('FEISHU_SYNC_SUCCEEDED', detail, env)}`
  ]
  return truncate(lines.join('\n'), MAX_TEXT_LENGTH)
}

function renderAlert(env, argv) {
  const hasStructured = env.ALERT_KIND || env.ALERT_MESSAGE
  const health = !hasStructured && (env.HEALTH_FAILURES || env.HEALTH_SUMMARY) ? healthAlert(env) : null
  const rawKind = String((health && health.kind) || env.ALERT_KIND || 'MANUAL_ALERT').trim().toUpperCase()
  const kind = Object.prototype.hasOwnProperty.call(KIND_TEMPLATES, rawKind) ? rawKind : 'ALERT_UNCLASSIFIED'
  const detail = (health && health.detail) || parseSafeDetail(env.ALERT_DETAIL)
  if (kind === 'FEISHU_SYNC_SUCCEEDED') return renderSyncSuccess(env, detail)
  const message = (health && health.message) || env.ALERT_MESSAGE || (argv || []).join(' ')
  const template = KIND_TEMPLATES[kind] || ['警告', '系统报告了一项异常', '影响范围尚未确认', '状态尚未确认', '查看对应任务的服务日志并按排查编号补齐阶段证据']
  const code = safeMachineCode(kind, detail)
  const reason = (KNOWN_REASONS[kind] && KNOWN_REASONS[kind][code]) ||
    (health ? health.message : confirmedReason(message, code, kind))
  const problem = `${health && health.happened ? health.happened : template[1]}：${reason}`
  const lines = [
    '【寓你住一起｜系统告警】⚠️',
    `发生时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `问题：${problem}`,
    `影响：${health && health.impact ? health.impact : template[2]}`,
    `系统已做：${SYSTEM_ACTIONS[kind] || SYSTEM_ACTIONS.ALERT_UNCLASSIFIED}`,
    `你要做：${template[4]}`,
    `排查编号：${traceId(kind, detail, env)}`
  ]
  return truncate(lines.join('\n'), MAX_TEXT_LENGTH)
}

// 组装告警正文：备份契约 > 巡检契约 > 命令行参数（手动测试）。
function buildText(env, argv) {
  if (!env.ALERT_KIND && !env.ALERT_MESSAGE && !env.HEALTH_FAILURES && !env.HEALTH_SUMMARY) {
    const manual = sanitizeText((argv || []).join(' '))
    const now = new Date().toLocaleString('zh-CN', { hour12: false })
    return truncate(`【寓你通知】${os.hostname()} ${now}\n${manual || '通知内容为空'}`, MAX_TEXT_LENGTH)
  }
  return renderAlert(env || {}, argv || [])
}

// 飞书机器人签名校验（机器人安全设置开了「签名校验」时必带）：
// sign = base64( HMAC-SHA256( key = `${timestamp}\n${secret}`, message = "" ) )
function signPayload(secret, timestampSec) {
  const stringToSign = `${timestampSec}\n${secret}`
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64')
}

function buildPayload(env, argv) {
  const payload = { msg_type: 'text', content: { text: buildText(env, argv) } }
  const secret = String(env.HEALTH_ALERT_SECRET || '').trim()
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    payload.timestamp = timestamp
    payload.sign = signPayload(secret, timestamp)
  }
  return payload
}

function postJson(webhook, payload, callback) {
  let target
  try {
    target = new URL(webhook)
  } catch (error) {
    callback(new Error('webhook 不是合法 URL'))
    return
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const lib = target.protocol === 'http:' ? http : https // http 仅供本地测试桩
  const req = lib.request(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
  }, (res) => {
    let raw = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { raw += chunk })
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        callback(new Error(`飞书 webhook HTTP ${res.statusCode}`))
        return
      }
      let parsed = {}
      try { parsed = raw ? JSON.parse(raw) : {} } catch (error) { parsed = {} }
      // 新版返回 {code:0}；旧版返回 {StatusCode:0, ok:true}。任一为 0/true 即成功。
      const okNew = parsed.code === 0
      const okLegacy = parsed.StatusCode === 0 || parsed.ok === true
      if (okNew || okLegacy) {
        callback(null)
        return
      }
      const responseCode = /^[A-Za-z0-9_-]{1,40}$/.test(String(parsed.code || parsed.StatusCode || '')) ? String(parsed.code || parsed.StatusCode) : 'UNKNOWN'
      callback(new Error(`飞书 webhook 返回失败，机器码=${responseCode}`))
    })
  })
  req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`发送超时(${TIMEOUT_MS}ms)`)))
  req.on('error', (error) => callback(error))
  req.end(body)
}

function alertFingerprint(env) {
  const detail = parseSafeDetail(env.ALERT_DETAIL)
  let rawDetail = {}
  try { rawDetail = JSON.parse(env.ALERT_DETAIL || '{}') } catch (_error) { rawDetail = {} }
  let healthSummary = {}
  try { healthSummary = JSON.parse(env.HEALTH_SUMMARY || '{}') } catch (_error) { healthSummary = {} }
  const healthChecks = Array.isArray(healthSummary.checks) ? healthSummary.checks : []
  const syncCheck = healthChecks.find((item) => item && item.name === 'feishuSync') || {}
  const kind = String(env.ALERT_KIND || (String(env.HEALTH_FAILURES || '').split(',').filter(Boolean).length === 1 && String(env.HEALTH_FAILURES).includes('feishuSync') ? 'FEISHU_SYNC_FAILED' : 'HEALTH_CHECK_FAILED')).toUpperCase()
  const code = safeMachineCode(kind, { ...detail, code: detail.code || syncCheck.errorCode })
  const rawIdentity = rawDetail && typeof rawDetail === 'object'
    ? [rawDetail.traceId, rawDetail.runId, rawDetail.taskId, rawDetail.registrationRequestTraceId, rawDetail.file, rawDetail.dataFile].filter(Boolean).join('|')
    : ''
  const safeSyncTrace = /^(?:SYNC|INC|AL)-[A-F0-9]{12,64}$/.test(String(detail.traceId || syncCheck.traceId || '').toUpperCase())
    ? String(detail.traceId || syncCheck.traceId).toUpperCase()
    : ''
  // 同步事故按脱敏任务追踪号区分。全局健康事故号可能跨多次同步失败复用，不能吞掉后续新任务的告警。
  const identity = env.ALERT_DEDUPE_KEY ||
    (kind === 'FEISHU_SYNC_FAILED' ? safeSyncTrace : '') ||
    env.HEALTH_INCIDENT_ID || rawIdentity || detail.traceId || detail.registrationRequestTraceId || syncCheck.traceId || ''
  const failures = [...new Set(String(env.HEALTH_FAILURES || '').split(',').map((item) => item.trim()).filter(Boolean))].sort().join(',')
  const reason = confirmedReason(env.ALERT_MESSAGE || healthChecks.map((item) => item && item.detail).filter(Boolean).join('|'), code, kind)
  return crypto.createHash('sha256').update(`${kind}|${code}|${identity}|${failures}|${reason}`).digest('hex')
}

function resolveAlertDedupeDir(env = {}) {
  const configured = String(env.HEALTH_ALERT_DEDUPE_DIR || '').trim()
  return configured || DEFAULT_DEDUPE_DIR
}

function fsyncAlertDirectory(io, dir, platform) {
  if (platform === 'win32') return
  const dirFd = io.openSync(dir, 'r')
  try { io.fsyncSync(dirFd) } finally { io.closeSync(dirFd) }
}

function createPendingDedupeMarker(marker, content, options = {}) {
  const io = options.fsOps || fs
  const platform = options.platform || process.platform
  const dir = path.dirname(marker)
  io.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let fd = null
  try {
    fd = io.openSync(marker, 'wx', 0o600)
    io.writeFileSync(fd, content, 'utf8')
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = null
    fsyncAlertDirectory(io, dir, platform)
  } finally {
    if (fd != null) {
      try { io.closeSync(fd) } catch (_error) {}
    }
  }
}

function replaceDedupeMarker(marker, content, options = {}) {
  const io = options.fsOps || fs
  const platform = options.platform || process.platform
  const dir = path.dirname(marker)
  const temp = `${marker}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let fd = null
  try {
    fd = io.openSync(temp, 'wx', 0o600)
    io.writeFileSync(fd, content, 'utf8')
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = null
    io.renameSync(temp, marker)
    fsyncAlertDirectory(io, dir, platform)
  } finally {
    if (fd != null) {
      try { io.closeSync(fd) } catch (_error) {}
    }
    try { io.unlinkSync(temp) } catch (_error) {}
  }
}

function createFileDedupeStore(options = {}) {
  const dir = options.dir || DEFAULT_DEDUPE_DIR
  const io = options.fsOps || fs
  const platform = options.platform || process.platform
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEDUPE_WINDOW_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const pendingMs = Math.min(windowMs, Number(options.pendingMs) > 0 ? Number(options.pendingMs) : 30 * 1000)
  return {
    claim(key, claimOptions = {}) {
      io.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const marker = path.join(dir, `${key}.sent`)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const token = crypto.randomBytes(12).toString('hex')
          const pendingContent = `pending:${now()}:${token}`
          createPendingDedupeMarker(marker, pendingContent, { fsOps: io, platform })
          return {
            duplicate: false,
            markSent: () => {
              if (io.readFileSync(marker, 'utf8') !== pendingContent) {
                const error = new Error('告警去重占位已失效')
                error.code = 'DEDUPE_CLAIM_LOST'
                throw error
              }
              replaceDedupeMarker(marker, `sent:${now()}:${token}`, { fsOps: io, platform })
            },
            release: () => {
              if (io.readFileSync(marker, 'utf8') !== pendingContent) return
              io.unlinkSync(marker)
              fsyncAlertDirectory(io, dir, platform)
            }
          }
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          let markerContent = ''
          let state = 'pending'
          let timestamp = now()
          try {
            markerContent = String(io.readFileSync(marker, 'utf8'))
            const parts = markerContent.split(':')
            state = parts[0]
            timestamp = Number(parts[1])
          } catch (readError) {
            const error = new Error('告警去重状态无法读取')
            error.code = readError && readError.code || 'DEDUPE_STATE_UNREADABLE'
            throw error
          }
          if (!['pending', 'sent'].includes(state) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
            const error = new Error('告警去重状态无效')
            error.code = 'DEDUPE_STATE_INVALID'
            throw error
          }
          const ageMs = now() - timestamp
          const activeWindow = state === 'sent' && claimOptions.neverExpireSent === true
            ? Number.POSITIVE_INFINITY
            : (state === 'sent' ? windowMs : pendingMs)
          if (ageMs < 0 || ageMs < activeWindow) return { duplicate: true, inFlight: state !== 'sent', markSent() {}, release() {} }
          try {
            // 读取后到清理前可能已有另一进程接管；只删除仍与本次观察完全一致的旧占位。
            if (String(io.readFileSync(marker, 'utf8')) !== markerContent) {
              return { duplicate: true, inFlight: true, markSent() {}, release() {} }
            }
            io.unlinkSync(marker)
            fsyncAlertDirectory(io, dir, platform)
          } catch (_unlinkError) {
            return { duplicate: true, inFlight: true, markSent() {}, release() {} }
          }
        }
      }
      return { duplicate: true, inFlight: true, markSent() {}, release() {} }
    }
  }
}

function sendAlert(options, callback) {
  const env = options && options.env ? options.env : {}
  const argv = options && options.argv ? options.argv : []
  const transport = options && options.transport ? options.transport : postJson
  const webhook = String(env.HEALTH_ALERT_WEBHOOK || '').trim()
  if (!webhook) return callback(new Error('未配置 HEALTH_ALERT_WEBHOOK'))
  const structured = Boolean(env.ALERT_KIND || env.ALERT_MESSAGE || env.HEALTH_FAILURES || env.HEALTH_SUMMARY)
  let claim = { duplicate: false, markSent() {}, release() {} }
  try {
    if (structured) claim = (options.dedupeStore || createFileDedupeStore({ dir: resolveAlertDedupeDir(env) })).claim(
      alertFingerprint(env),
      { neverExpireSent: String(env.ALERT_KIND || '').trim().toUpperCase() === 'FEISHU_SYNC_SUCCEEDED' }
    )
  } catch (error) {
    return callback(new Error(`告警去重状态不可用：${error.code || 'UNKNOWN'}`))
  }
  if (claim.duplicate && claim.inFlight) return callback(new Error('相同告警正在发送，请稍后重试'))
  if (claim.duplicate) return callback(null, { deduplicated: true })
  transport(webhook, buildPayload(env, argv), (error) => {
    if (error) {
      try { claim.release() } catch (stateError) {
        const code = /^[A-Z][A-Z0-9_-]{1,63}$/.test(String(stateError && stateError.code || '').toUpperCase())
          ? String(stateError.code).toUpperCase()
          : 'UNKNOWN'
        return callback(new Error(`告警发送失败且去重占位释放失败，机器码=${code}`), { deduplicated: false })
      }
      return callback(error, { deduplicated: false })
    }
    try { claim.markSent() } catch (stateError) {
      const code = /^[A-Z][A-Z0-9_-]{1,63}$/.test(String(stateError && stateError.code || '').toUpperCase())
        ? String(stateError.code).toUpperCase()
        : 'UNKNOWN'
      return callback(new Error(`消息可能已送达，但持久去重状态写入失败，机器码=${code}`), { deduplicated: false })
    }
    callback(null, { deduplicated: false })
  })
}

function main() {
  const webhook = String(process.env.HEALTH_ALERT_WEBHOOK || '').trim()
  if (!webhook) {
    process.stderr.write('[feishu-alert] 未配置 HEALTH_ALERT_WEBHOOK，无法发送\n')
    process.exit(2)
  }
  sendAlert({ env: process.env, argv: process.argv.slice(2) }, (error, result) => {
    if (error) {
      process.stderr.write(`[feishu-alert] 发送失败：${error.message}\n`)
      process.exit(1)
    }
    process.stdout.write(result && result.deduplicated ? '[feishu-alert] 重复告警已合并\n' : '[feishu-alert] 已发送\n')
  })
}

if (require.main === module) main()

module.exports = {
  buildText, buildPayload, signPayload, truncate, postJson, sendAlert, renderAlert, parseSafeDetail, sanitizeText,
  alertFingerprint, resolveAlertDedupeDir, createFileDedupeStore, createPendingDedupeMarker, replaceDedupeMarker
}
