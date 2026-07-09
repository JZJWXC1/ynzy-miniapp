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
// 手动测试：HEALTH_ALERT_WEBHOOK=... node send-feishu-alert.js "测试告警"
//
// 失败语义：发送失败（缺 webhook/超时/飞书返回非 0）→ stderr + 非零退出，由调用方记日志；绝不抛未捕获异常。

const https = require('https')
const http = require('http')
const os = require('os')
const crypto = require('crypto')
const { URL } = require('url')

const MAX_TEXT_LENGTH = 1800 // 飞书文本消息留余量截断，防超长被拒
const TIMEOUT_MS = 10000 // 必须小于两条调用链各自的 15s execSync 限时

function truncate(text, max) {
  const value = String(text == null ? '' : text)
  return value.length > max ? `${value.slice(0, max)}…(截断)` : value
}

// 组装告警正文：备份契约 > 巡检契约 > 命令行参数（手动测试）。
function buildText(env, argv) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const head = `【寓你告警】${os.hostname()} ${now}`
  if (env.ALERT_KIND || env.ALERT_MESSAGE) {
    const lines = [head, `类型：${env.ALERT_KIND || '(未知)'}`, `内容：${env.ALERT_MESSAGE || ''}`]
    if (env.ALERT_DETAIL && env.ALERT_DETAIL !== '{}') lines.push(`明细：${env.ALERT_DETAIL}`)
    return truncate(lines.join('\n'), MAX_TEXT_LENGTH)
  }
  if (env.HEALTH_FAILURES || env.HEALTH_SUMMARY) {
    const lines = [head, `巡检失败项：${env.HEALTH_FAILURES || '(未知)'}`]
    if (env.HEALTH_SUMMARY) lines.push(`摘要：${env.HEALTH_SUMMARY}`)
    return truncate(lines.join('\n'), MAX_TEXT_LENGTH)
  }
  const manual = (argv || []).join(' ').trim()
  return truncate(`${head}\n${manual || '(空告警：无 ALERT_*/HEALTH_* 内容)'}`, MAX_TEXT_LENGTH)
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
    callback(new Error(`webhook 不是合法 URL：${error.message}`))
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
        callback(new Error(`飞书 webhook HTTP ${res.statusCode}：${truncate(raw, 200)}`))
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
      callback(new Error(`飞书 webhook 返回失败：${truncate(raw, 200)}`))
    })
  })
  req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`发送超时(${TIMEOUT_MS}ms)`)))
  req.on('error', (error) => callback(error))
  req.end(body)
}

function main() {
  const webhook = String(process.env.HEALTH_ALERT_WEBHOOK || '').trim()
  if (!webhook) {
    process.stderr.write('[feishu-alert] 未配置 HEALTH_ALERT_WEBHOOK，无法发送\n')
    process.exit(2)
  }
  const payload = buildPayload(process.env, process.argv.slice(2))
  postJson(webhook, payload, (error) => {
    if (error) {
      process.stderr.write(`[feishu-alert] 发送失败：${error.message}\n`)
      process.exit(1)
    }
    process.stdout.write('[feishu-alert] 已发送\n')
  })
}

if (require.main === module) main()

module.exports = { buildText, buildPayload, signPayload, truncate }
