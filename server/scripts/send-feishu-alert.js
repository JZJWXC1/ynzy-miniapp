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
const crypto = require('crypto')
const { URL } = require('url')

const MAX_TEXT_LENGTH = 1800 // 飞书文本消息留余量截断，防超长被拒
const TIMEOUT_MS = 10000 // 必须小于两条调用链各自的 15s execSync 限时

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
  FEISHU_SYNC_FAILED: ['紧急', '飞书房源同步失败', '公司房源可能没有更新或只完成了部分步骤', '失败状态需以任务记录为准', '按追踪编号查看同步任务阶段、错误码和服务日志'],
  REGISTRATION_NOTIFY_DEAD_LETTER: ['警告', '注册申请通知多次发送失败', '管理员可能没有及时看到待审核事项', '通知已停止自动重试', '到管理后台人工检查待审核申请，并排查通知发送链'],
  HEALTH_CHECK_FAILED: ['紧急', '系统健康巡检发现异常', '受影响检查项对应的服务能力可能不可用', '异常是否持续需以下一次巡检为准', '按失败项检查服务状态和对应日志']
}

const KNOWN_REASONS = {
  FEISHU_API_1254072: '字段值格式不符合飞书表格要求',
  HTTP_401: '外部服务拒绝了身份校验',
  HTTP_403: '外部服务拒绝了当前权限',
  HTTP_429: '外部服务请求过于频繁',
  HTTP_500: '外部服务发生内部错误'
}

const SENSITIVE_KEY = /(?:token|secret|password|passwd|webhook|authorization|cookie|phone|mobile|response(?:body|text|raw)|rawresponse)/i
const SAFE_DETAIL_KEYS = new Set(['ok', 'code', 'errorCode', 'runId', 'taskId', 'state', 'stage', 'reason', 'notifyAttempts', 'deadLetterAt', 'registrationRequestTraceId', 'file', 'mismatches', 'newCounts', 'priorCounts'])

function truncate(text, max) {
  const value = String(text == null ? '' : text)
  return value.length > max ? `${value.slice(0, max)}…(截断)` : value
}

function sanitizeText(value) {
  return String(value == null ? '' : value)
    .replace(/https?:\/\/[^\s]+/gi, '[链接已隐藏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]')
    .replace(/\b(?:token|secret|password|passwd|webhook|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
}

function parseSafeDetail(raw) {
  let detail = {}
  try { detail = raw ? JSON.parse(raw) : {} } catch (_error) { detail = {} }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {}
  return Object.keys(detail).reduce((safe, key) => {
    if (!SAFE_DETAIL_KEYS.has(key) || SENSITIVE_KEY.test(key)) return safe
    const value = detail[key]
    if (value == null || typeof value === 'boolean' || typeof value === 'number') safe[key] = value
    else if (typeof value === 'string') safe[key] = truncate(sanitizeText(value), 160)
    else if (Array.isArray(value)) safe[key] = value.slice(0, 8).map((item) => {
      if (typeof item === 'string') return truncate(sanitizeText(item), 80)
      if (item && typeof item === 'object') {
        return Object.fromEntries(Object.entries(item).filter(([childKey, childValue]) => (
          !SENSITIVE_KEY.test(childKey) && /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(childKey) &&
          (typeof childValue === 'number' || typeof childValue === 'boolean')
        )))
      }
      return null
    }).filter((item) => item != null)
    else safe[key] = Object.fromEntries(Object.entries(value).slice(0, 12).map(([k, v]) => [sanitizeText(k), Number(v) || 0]))
    return safe
  }, {})
}

function safeMachineCode(kind, detail) {
  const candidate = String(detail.code || detail.errorCode || '').toUpperCase()
  if (/^[A-Z][A-Z0-9_-]{2,63}$/.test(candidate)) return candidate
  return /^[A-Z][A-Z0-9_-]{2,63}$/.test(kind) ? kind : 'ALERT_UNCLASSIFIED'
}

function confirmedReason(message, code, detail) {
  if (KNOWN_REASONS[code]) return KNOWN_REASONS[code]
  const candidate = sanitizeText(detail.reason || message)
  if (!candidate || /^(?:unknown|未知|同步失败|失败)$/i.test(candidate)) return '原因尚未确认；请查看对应任务的服务日志并按追踪编号补齐阶段证据'
  return truncate(candidate, 240)
}

function traceId(kind, detail, env) {
  const supplied = sanitizeText(detail.runId || detail.taskId || detail.registrationRequestTraceId || env.ALERT_TRACE_ID || '')
  if (supplied && /^[A-Za-z0-9._:-]{4,128}$/.test(supplied)) return supplied
  return `AL-${crypto.createHash('sha256').update(`${kind}|${JSON.stringify(detail)}`).digest('hex').slice(0, 12).toUpperCase()}`
}

function healthAlert(env) {
  const failures = [...new Set(String(env.HEALTH_FAILURES || '').split(',').map((item) => item.trim()).filter(Boolean))]
  const labels = failures.map((item) => CHECK_LABELS[item] || sanitizeText(item))
  const detail = parseSafeDetail(env.HEALTH_SUMMARY)
  let summary = {}
  try { summary = JSON.parse(env.HEALTH_SUMMARY || '{}') } catch (_error) { summary = {} }
  const failedChecks = Array.isArray(summary.checks) ? summary.checks.filter((item) => item && item.ok === false) : []
  const reasonParts = failedChecks.map((item) => sanitizeText(item.detail || item.reason || '')).filter(Boolean)
  const reason = reasonParts.length ? [...new Set(reasonParts)].join('；') : '原因尚未确认；请查看对应任务的服务日志并按追踪编号补齐阶段证据'
  const syncOnly = failures.length === 1 && failures[0] === 'feishuSync'
  const syncCheck = failedChecks.find((item) => item && item.name === 'feishuSync')
  if (syncCheck) {
    detail.state = sanitizeText(syncCheck.lastState || '')
    const syncCode = String(syncCheck.errorCode || '').toUpperCase()
    if (/^[A-Z][A-Z0-9_-]{2,63}$/.test(syncCode)) detail.code = syncCode
  }
  return { kind: syncOnly ? 'FEISHU_SYNC_FAILED' : 'HEALTH_CHECK_FAILED', detail, message: reason, impact: labels.length ? `${labels.join('、')}对应的服务能力可能不可用` : undefined, happened: syncOnly ? '飞书房源同步失败' : (labels.length ? `系统健康巡检发现异常：${labels.join('、')}` : undefined) }
}

function renderAlert(env, argv) {
  const hasStructured = env.ALERT_KIND || env.ALERT_MESSAGE
  const health = !hasStructured && (env.HEALTH_FAILURES || env.HEALTH_SUMMARY) ? healthAlert(env) : null
  const kind = String((health && health.kind) || env.ALERT_KIND || 'MANUAL_ALERT').trim().toUpperCase()
  const detail = (health && health.detail) || parseSafeDetail(env.ALERT_DETAIL)
  const message = (health && health.message) || env.ALERT_MESSAGE || (argv || []).join(' ')
  const template = KIND_TEMPLATES[kind] || ['警告', '系统报告了一项异常', '影响范围尚未确认', '状态尚未确认', '查看对应任务的服务日志并按追踪编号补齐阶段证据']
  const code = safeMachineCode(kind, detail)
  const reason = confirmedReason(message, code, detail)
  const lines = [
    '【寓你住一起｜系统告警】',
    `严重程度：${template[0]}`,
    `发生时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `发生了什么：${health && health.happened ? health.happened : template[1]}`,
    `影响范围：${health && health.impact ? health.impact : template[2]}`,
    `当前状态：${template[3]}`,
    `真实原因：${reason}`,
    `建议处理：${template[4]}`,
    `追踪编号：${traceId(kind, detail, env)}`,
    `机器码：${code}`
  ]
  const safeDetail = Object.keys(detail).length ? JSON.stringify(detail) : ''
  if (safeDetail) lines.push(`安全明细：${truncate(safeDetail, 420)}`)
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

function sendAlert(options, callback) {
  const env = options && options.env ? options.env : {}
  const argv = options && options.argv ? options.argv : []
  const transport = options && options.transport ? options.transport : postJson
  const webhook = String(env.HEALTH_ALERT_WEBHOOK || '').trim()
  if (!webhook) return callback(new Error('未配置 HEALTH_ALERT_WEBHOOK'))
  transport(webhook, buildPayload(env, argv), callback)
}

function main() {
  const webhook = String(process.env.HEALTH_ALERT_WEBHOOK || '').trim()
  if (!webhook) {
    process.stderr.write('[feishu-alert] 未配置 HEALTH_ALERT_WEBHOOK，无法发送\n')
    process.exit(2)
  }
  sendAlert({ env: process.env, argv: process.argv.slice(2) }, (error) => {
    if (error) {
      process.stderr.write(`[feishu-alert] 发送失败：${error.message}\n`)
      process.exit(1)
    }
    process.stdout.write('[feishu-alert] 已发送\n')
  })
}

if (require.main === module) main()

module.exports = { buildText, buildPayload, signPayload, truncate, postJson, sendAlert, renderAlert, parseSafeDetail, sanitizeText }
