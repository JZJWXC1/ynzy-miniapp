const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { URL } = require('url')
const config = require('./config')
const dbStore = require('./db')
const domain = require('./domain')
const feishuSync = require('./feishu-sync')
const llm = require('./llm')
const asrService = require('./asr-service')
const asrRealtime = require('./asr-realtime')
const assistantService = require('./assistant-service')
const backup = require('./backup')
const oss = require('./oss')
const {
  createPublicListingMediaService,
  resolveManagedVideoObjectKey,
  isSecureSameOrigin
} = require('./public-listing-media')
const adminVideoPreview = require('./admin-video-preview')
const wxpay = require('./wxpay')
const { hashPassword, verifyPassword } = require('./auth-util')
const { parseMultipartForm } = require('./multipart')
const requestLog = require('./request-log')
const appVersion = require('./version')

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const COMPANY_SOURCE = '公司房源'
const GUEST_RATE_WINDOW_MS = 60 * 1000
const GUEST_RATE_LIMIT = 80
const MINI_AUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ASSISTANT_CHAT_FALLBACK_TIMEOUT_MS = Number(process.env.ASSISTANT_CHAT_FALLBACK_TIMEOUT_MS) || 24000
const guestRateBuckets = new Map()
let lastGuestBucketSweep = 0

// 定期清理过期限流桶：Map 原先只增不删，长期运行内存无界增长（伪造 XFF 时每个 key 留一条）。
// 每个窗口最多全量清扫一次，删除已过窗的桶，成本可控。
function sweepGuestRateBuckets(now) {
  if (now - lastGuestBucketSweep < GUEST_RATE_WINDOW_MS) return
  lastGuestBucketSweep = now
  for (const [key, bucket] of guestRateBuckets) {
    if (now - bucket.startedAt >= GUEST_RATE_WINDOW_MS) {
      guestRateBuckets.delete(key)
    }
  }
}

function sendJson(res, data, statusCode = 200) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'X-Trace-Id, X-Auth-Token, X-Auth-Token-Expires-At'
  }
  if (res.noStore) headers['Cache-Control'] = 'no-store'
  if (res.varyAuthorization) headers.Vary = 'Authorization'
  // 只有最终成功的已验签小程序响应才滑动续签。登录/改密仍在 body 返回 token；退出必须禁用
  // 此处续签，避免刚提升 tokenVersion 又把旧版本 token 发回。错误响应统一走 sendError，不续签。
  if (statusCode >= 200 && statusCode < 300 && res.miniAuthRefresh && !res.disableMiniAuthRefresh) {
    const auth = issueMiniAuthToken(res.miniAuthRefresh.userId, res.miniAuthRefresh.tokenVersion)
    headers['X-Auth-Token'] = auth.token
    headers['X-Auth-Token-Expires-At'] = String(auth.tokenExpiresAt)
    headers['Cache-Control'] = 'no-store'
    headers.Vary = 'Authorization'
  }
  res.writeHead(statusCode, headers)
  res.end(JSON.stringify({ code: 0, message: 'ok', data }))
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'X-Trace-Id, X-Auth-Token, X-Auth-Token-Expires-At'
  }
  if (res.noStore) headers['Cache-Control'] = 'no-store'
  if (res.varyAuthorization) headers.Vary = 'Authorization'
  res.writeHead(statusCode, headers)
  res.end(JSON.stringify({ code: statusCode, message: error.message || '服务异常', data: error.data || null }))
}

function timeoutAfter(ms, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('assistant chat timeout')
      error.statusCode = 504
      error.code = code || 'TIMEOUT'
      reject(error)
    }, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
}

function safeLogError(error) {
  return String((error && (error.code || error.name || error.message)) || 'unknown')
    .replace(/\s+/g, '_')
    .slice(0, 120)
}

function safeLogValue(value) {
  return String(value || '-')
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fa5:./-]/g, '_')
    .slice(0, 120)
}

function logListingDetailState(listingId, state, queryId = '') {
  if (!state || state.status === 'available') return
  const listing = state.listing || {}
  const unavailable = state.unavailable || {}
  console.log([
    '[listing-detail]',
    `availability=${safeLogValue(state.status)}`,
    `queryId=${safeLogValue(queryId)}`,
    `listingId=${safeLogValue(listingId)}`,
    `rawFound=${Boolean(state.rawFound)}`,
    `reason=${safeLogValue(state.reason || unavailable.reason || 'not-found')}`,
    `status=${safeLogValue(listing.status)}`,
    `feishuAction=${safeLogValue(listing.feishuLastSyncAction)}`,
    `feishuAt=${safeLogValue(listing.feishuLastSyncAt || listing.syncedAt)}`,
    `feishuReason=${safeLogValue(listing.feishuLastSyncReason || listing.expiredReason)}`
  ].join(' '))
}

function sendJsonDownload(res, filename, data) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  })
  res.end(JSON.stringify(data, null, 2))
}

function sendWechatPayNotify(res, code, message) {
  res.writeHead(code === 'SUCCESS' ? 200 : 500, {
    'Content-Type': 'application/json; charset=utf-8'
  })
  res.end(JSON.stringify({ code, message }))
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let settled = false
    const fail = (error, statusCode) => {
      if (settled) return
      settled = true
      if (statusCode) error.statusCode = statusCode
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) {
        // 超限设 413（原先无 statusCode 会落到 500），且不再提前 req.destroy()，
        // 否则连接被撕毁、错误响应无法送达客户端。
        fail(new Error('请求内容过大'), 413)
      }
    })
    req.on('end', () => {
      if (settled) return
      if (!raw) {
        settled = true
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        settled = true
        resolve(parsed)
      } catch (error) {
        fail(error, 400)
      }
    })
    // 客户端中途断开（弱网小程序常见）时若不监听 error/aborted，'end' 不会触发，
    // Promise 永不 settle，await parseBody 之后的处理器会永久挂起、连接与闭包滞留。
    req.on('error', (error) => fail(error, 400))
    req.on('aborted', () => fail(new Error('请求连接已中断'), 400))
  })
}

function searchParamValues(searchParams, names) {
  const values = names.flatMap((name) => searchParams.getAll(name))
  searchParams.forEach((value, key) => {
    if (/^listingIds\[\d+\]$/.test(key)) values.push(value)
  })
  return values.filter((item) => item !== null && item !== undefined && item !== '')
}

function mapQueryFilter(searchParams) {
  return {
    north: searchParams.get('north') || '',
    south: searchParams.get('south') || '',
    east: searchParams.get('east') || '',
    west: searchParams.get('west') || '',
    rentMin: searchParams.get('rentMin') || '',
    rentMax: searchParams.get('rentMax') || '',
    layout: searchParams.get('layout') || '',
    rentMode: searchParams.get('rentMode') || '',
    sourceType: searchParams.get('sourceType') || '',
    area: searchParams.get('area') || searchParams.get('region') || '',
    community: searchParams.get('community') || '',
    listingIds: searchParamValues(searchParams, ['listingIds', 'listingIds[]'])
  }
}

function requestClientKey(req) {
  const socketAddr = (req.socket && req.socket.remoteAddress) || 'unknown'
  if (!config.trustProxy) return socketAddr
  // 部署于可信反向代理之后：nginx 用 $proxy_add_x_forwarded_for 把真实对端 IP 追加到
  // X-Forwarded-For 末段，取最后一段（代理追加、客户端无法伪造）而非可被伪造的首段，
  // 否则攻击者每请求换一个伪造 XFF 即可绕过游客限流。直连暴露时应设 TRUST_PROXY=0。
  const parts = String((req.headers && req.headers['x-forwarded-for']) || '')
    .split(',').map((item) => item.trim()).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : socketAddr
}

function assertGuestRateLimit(req, scope, limit = GUEST_RATE_LIMIT) {
  const now = Date.now()
  sweepGuestRateBuckets(now)
  const key = `${scope}:${requestClientKey(req)}`
  const bucket = guestRateBuckets.get(key) || { startedAt: now, count: 0 }
  if (now - bucket.startedAt >= GUEST_RATE_WINDOW_MS) {
    bucket.startedAt = now
    bucket.count = 0
  }
  bucket.count += 1
  guestRateBuckets.set(key, bucket)
  if (bucket.count <= limit) return
  const error = new Error('游客访问过于频繁，请稍后再试')
  error.statusCode = 429
  throw error
}

function assertMiniLogin(userId) {
  if (String(userId || '').trim()) return
  const error = new Error('请先登录内部中介账号')
  error.statusCode = 401
  throw error
}

function assertReportDealWritesEnabled() {
  if (config.features && config.features.reportDealWritesEnabled === true) return
  const error = new Error('客户报备与签单功能已暂停')
  error.statusCode = 410
  error.data = { reason: 'REPORT_DEAL_PAUSED' }
  throw error
}

function readFootprintsWithLockedPrune(snapshot, reader) {
  if (domain.expiredFootprintCount(snapshot) === 0) return reader(snapshot)
  return dbStore.updateDb((nextDb) => {
    domain.pruneExpiredFootprints(nextDb)
    return reader(nextDb)
  })
}

function readMiniFootprintsWithLockedPrune(req, snapshot, userId, reader) {
  if (domain.expiredFootprintCount(snapshot) === 0) return reader(snapshot, userId)
  return updateMiniDb(req, (nextDb, freshUserId) => {
    domain.pruneExpiredFootprints(nextDb)
    return reader(nextDb, freshUserId)
  })
}

function isGuestUser(userId) {
  return !String(userId || '').trim()
}

function guestListingFilter(filter = {}) {
  const {
    companyOnly: _clientCompanyOnly,
    publicGuest: _clientPublicGuest,
    userId: _clientUserId,
    viewerId: _clientViewerId,
    role: _clientRole,
    isAdmin: _clientIsAdmin,
    maintainerId: _clientMaintainerId,
    threadId: _clientThreadId,
    needId: _clientNeedId,
    rentalNeedId: _clientRentalNeedId,
    clientNeedId: _clientClientNeedId,
    needTemporary: _clientNeedTemporary,
    feedbackMessageId: _clientFeedbackMessageId,
    messageId: _clientMessageId,
    ...safeFilter
  } = filter || {}
  return {
    ...safeFilter,
    publicGuest: true
  }
}

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('请求内容过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function sendOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'X-Trace-Id, X-Auth-Token, X-Auth-Token-Expires-At'
  })
  res.end()
}

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function adminTokenSecret() {
  const secret = String(process.env.ADMIN_TOKEN_SECRET || '').trim()
  if (secret) return secret
  // 生产环境拒绝回退到硬编码密钥：否则任何读过源码的人都能自行加签，构造出通过 verifyAdminToken
  // 的合法后台 Token，进而获得全部 /admin/* 权限（整库导出、创建/禁用管理员、确认签单等）。
  // 对齐 miniAuthTokenSecret 的 fail-closed 取向；仅本地开发保留回退便于起服务。
  if (String(process.env.NODE_ENV || '').trim() === 'production') {
    const error = new Error('管理后台 Token 密钥未配置（生产环境必须设置 ADMIN_TOKEN_SECRET）')
    error.statusCode = 503
    throw error
  }
  return 'ynzy-admin-local-dev-secret'
}

// hashPassword / verifyPassword 已抽到 ./auth-util，与 domain.js（小程序用户密码）共用单一实现。
function adminPasswordMatches(account, password) {
  if (account.passwordHash && verifyPassword(password, account.passwordHash)) return true
  return !account.passwordHash && account.password === password
}

function signAdminPayload(payload) {
  const encoded = base64url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', adminTokenSecret()).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifyAdminToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return null
  const expected = crypto.createHmac('sha256', adminTokenSecret()).update(parts[0]).digest('base64url')
  if (parts[1].length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    if (payload.exp && payload.exp < Date.now()) return null
    return payload
  } catch (error) {
    return null
  }
}

function miniAuthTokenSecret() {
  const secret = String(process.env.AUTH_TOKEN_SECRET || '').trim()
  if (secret) return secret
  const error = new Error('小程序登录 Token 密钥未配置')
  error.statusCode = 503
  throw error
}

function signMiniAuthPayload(payload) {
  const encoded = base64url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', miniAuthTokenSecret()).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function miniAuthTokenVersion(user) {
  const value = Number(user && user.tokenVersion)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function issueMiniAuthToken(userId, tokenVersion = 0) {
  const tokenExpiresAt = Date.now() + MINI_AUTH_TOKEN_TTL_MS
  return {
    token: signMiniAuthPayload({ userId, exp: tokenExpiresAt, tokenVersion }),
    tokenExpiresAt
  }
}

function miniAuthError(message = '登录已过期，请重新登录') {
  const error = new Error(message)
  error.statusCode = 401
  return error
}

// ---------- 注册申请飞书提醒 ----------
// 注册响应与通知发送彻底解耦：请求只把持久化申请 ID 排入内存任务，发送结果再回写同一申请。
// 进程内 Set 防重复执行；DB 中 pending/sending/failed/dead_letter + attempts 支持进程重启续跑并封顶三次。
const NOTIFY_ENV_SYSTEM_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME',
  'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP'
]
const REGISTRATION_NOTIFY_MAX_ATTEMPTS = 3
const REGISTRATION_NOTIFY_DEFAULT_RETRY_DELAYS_MS = [1000, 5000]
const registrationNotifyJobs = new Set()

function buildNotifyEnv(sourceEnv) {
  const src = sourceEnv && typeof sourceEnv === 'object' ? sourceEnv : {}
  const out = {}
  for (const key of NOTIFY_ENV_SYSTEM_KEYS) {
    if (src[key] != null) out[key] = src[key]
  }
  for (const key of Object.keys(src)) {
    if (key.startsWith('HEALTH_ALERT_')) out[key] = src[key]
  }
  return out
}

// 手机号打码：保留前3后4、中间一律星号（星号数量=被挡位数，绝不因位数变化漏出中间位）。
// 早期「前3+****+后4」写法对 7 位输入会把全部位数原样拼出（等于不打码）；这里改为按实际中间长度打星，
// 短号（<7 位）整串打星，杜绝任何位数下的中间位泄露。到达通知路径的号恒为 11 位，此为防御性硬化。
function maskPhoneForNotify(phone) {
  const value = String(phone || '')
  if (value.length < 7) return value ? '*'.repeat(value.length) : '***'
  return `${value.slice(0, 3)}${'*'.repeat(value.length - 7)}${value.slice(-4)}`
}

function sanitizeRegistrationNotifyText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gi, ' ')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/&/g, '＆')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
}

function registrationNotifyRetryDelays() {
  const configured = String(process.env.REGISTRATION_NOTIFY_RETRY_DELAYS_MS || '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0)
  return configured.length >= REGISTRATION_NOTIFY_MAX_ATTEMPTS - 1
    ? configured.slice(0, REGISTRATION_NOTIFY_MAX_ATTEMPTS - 1)
    : REGISTRATION_NOTIFY_DEFAULT_RETRY_DELAYS_MS
}

function registrationNotifyErrorSummary(error, fallback) {
  const code = error && error.code ? String(error.code).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : ''
  return code ? `${fallback}(${code})` : fallback
}

function formatRegistrationAlertTraceId(id) {
  return String(id || '')
    .replace(/(\d{4})(?=\d)/g, '$1-')
    .slice(0, 80)
}

function scheduleRegistrationNotification(requestId, delayMs = 0) {
  const targetId = String(requestId || '').trim()
  if (!targetId || registrationNotifyJobs.has(targetId)) return false
  if (!String(process.env.HEALTH_ALERT_WEBHOOK || '').trim()) return false

  registrationNotifyJobs.add(targetId)
  const timer = setTimeout(() => runRegistrationNotification(targetId), Math.max(0, Number(delayMs) || 0))
  timer.unref()
  return true
}

function runRegistrationNotification(requestId) {
  let job
  try {
    job = dbStore.updateDb((db) => domain.beginRegistrationNotification(db, requestId, REGISTRATION_NOTIFY_MAX_ATTEMPTS))
  } catch (error) {
    registrationNotifyJobs.delete(requestId)
    process.stderr.write(`[register-notify] 领取通知任务失败 id=${requestId}：${(error && error.message) || error}\n`)
    return
  }
  if (!job) {
    registrationNotifyJobs.delete(requestId)
    return
  }

  let settled = false
  const settle = (ok, errorSummary = '') => {
    if (settled) return
    settled = true
    let state = null
    try {
      state = dbStore.updateDb((db) => domain.finishRegistrationNotification(db, requestId, {
        ok,
        error: errorSummary,
        attemptId: job.notifyAttemptId,
        maxAttempts: REGISTRATION_NOTIFY_MAX_ATTEMPTS
      }))
    } catch (error) {
      process.stderr.write(`[register-notify] 回写通知状态失败 id=${requestId}：${(error && error.message) || error}\n`)
    }

    registrationNotifyJobs.delete(requestId)
    if (state && state.stale) {
      scheduleRegistrationNotification(requestId)
      return
    }
    if (!ok && state && state.deadLetter) {
      sendRegistrationDeadLetterAlert(requestId)
      return
    }
    const attempts = Number((state && state.notifyAttempts) || job.notifyAttempts || 0)
    if (!ok && attempts < REGISTRATION_NOTIFY_MAX_ATTEMPTS) {
      const delays = registrationNotifyRetryDelays()
      scheduleRegistrationNotification(requestId, delays[Math.max(0, attempts - 1)] || 0)
    }
  }

  try {
    const safeName = sanitizeRegistrationNotifyText(job.name) || '(未填姓名)'
    const message = `新的注册申请：${safeName} ${maskPhoneForNotify(job.phone)}，请到管理后台「注册审核」处理，通过后请通知本人可登录`
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'send-feishu-alert.js'), message], {
      env: buildNotifyEnv(process.env),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', (error) => {
      process.stderr.write(`[register-notify] 通知子进程启动失败：${(error && error.message) || error}\n`)
      settle(false, registrationNotifyErrorSummary(error, '通知子进程启动失败'))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        settle(true)
        return
      }
      const detail = signal ? `通知子进程被信号终止(${String(signal).slice(0, 30)})` : `通知子进程退出码异常(${Number(code) || 1})`
      process.stderr.write(`[register-notify] ${detail} id=${requestId}\n`)
      settle(false, detail)
    })
    child.unref()
  } catch (error) {
    process.stderr.write(`[register-notify] 通知触发失败：${(error && error.message) || error}\n`)
    settle(false, registrationNotifyErrorSummary(error, '通知触发失败'))
  }
}

function finishRegistrationDeadLetterAlert(requestId, ok, errorSummary = '') {
  try {
    dbStore.updateDb((db) => domain.finishRegistrationNotifyDeadLetterAlert(db, requestId, {
      ok,
      error: errorSummary
    }))
  } catch (error) {
    process.stderr.write(`[register-notify] 回写死信告警状态失败 id=${requestId}：${(error && error.message) || error}\n`)
  }
}

function sendRegistrationDeadLetterAlert(requestId) {
  let alertJob
  try {
    alertJob = dbStore.updateDb((db) => domain.claimRegistrationNotifyDeadLetterAlert(db, requestId))
  } catch (error) {
    process.stderr.write(`[register-notify] 领取死信告警失败 id=${requestId}：${(error && error.message) || error}\n`)
    return false
  }
  if (!alertJob) return false

  const traceId = formatRegistrationAlertTraceId(alertJob.id)
  const detail = {
    registrationRequestTraceId: traceId,
    notifyAttempts: alertJob.notifyAttempts,
    deadLetterAt: alertJob.notifyDeadLetterAt || '',
    reason: alertJob.notifyDeadLetterReason || alertJob.notifyLastError || '通知重试耗尽'
  }
  const env = {
    ...buildNotifyEnv(process.env),
    ALERT_KIND: 'REGISTRATION_NOTIFY_DEAD_LETTER',
    ALERT_MESSAGE: `注册通知重试耗尽：申请 ${traceId} 已进入死信，请到后台注册审核人工处理`,
    ALERT_DETAIL: JSON.stringify(detail)
  }

  let settled = false
  const settle = (ok, errorSummary = '') => {
    if (settled) return
    settled = true
    finishRegistrationDeadLetterAlert(requestId, ok, errorSummary)
  }

  try {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'send-feishu-alert.js')], {
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', (error) => {
      process.stderr.write(`[register-notify] 死信告警子进程启动失败 id=${requestId}：${(error && error.message) || error}\n`)
      settle(false, registrationNotifyErrorSummary(error, '死信告警子进程启动失败'))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        settle(true)
        return
      }
      const detailText = signal ? `死信告警子进程被信号终止(${String(signal).slice(0, 30)})` : `死信告警子进程退出码异常(${Number(code) || 1})`
      process.stderr.write(`[register-notify] ${detailText} id=${requestId}\n`)
      settle(false, detailText)
    })
    child.unref()
    return true
  } catch (error) {
    process.stderr.write(`[register-notify] 死信告警触发失败 id=${requestId}：${(error && error.message) || error}\n`)
    settle(false, registrationNotifyErrorSummary(error, '死信告警触发失败'))
    return false
  }
}

function notifyRegistrationApplication(outcome) {
  if (!outcome || !outcome.notifyAdmin) return false
  return scheduleRegistrationNotification(outcome.registrationRequestId)
}

function resumePendingRegistrationNotifications() {
  if (!String(process.env.HEALTH_ALERT_WEBHOOK || '').trim()) return 0
  try {
    const db = dbStore.readDb()
    const ids = domain.pendingRegistrationNotificationIds(db, REGISTRATION_NOTIFY_MAX_ATTEMPTS)
    const deadLetterAlertIds = domain.pendingRegistrationNotifyDeadLetterAlertIds(db)
    ids.forEach((requestId) => scheduleRegistrationNotification(requestId))
    deadLetterAlertIds.forEach((requestId) => sendRegistrationDeadLetterAlert(requestId))
    if (ids.length || deadLetterAlertIds.length) {
      console.log(`[register-notify] 已恢复 ${ids.length} 个未完成通知任务、${deadLetterAlertIds.length} 个死信告警`)
    }
    return ids.length + deadLetterAlertIds.length
  } catch (error) {
    process.stderr.write(`[register-notify] 恢复未完成通知失败：${(error && error.message) || error}\n`)
    return 0
  }
}

function hasAuthorizationHeader(req) {
  return Boolean(req && req.headers && Object.prototype.hasOwnProperty.call(req.headers, 'authorization'))
}

function bearerTokenFromRequest(req) {
  if (!hasAuthorizationHeader(req)) return ''
  const duplicateCount = Array.isArray(req.rawHeaders)
    ? req.rawHeaders.filter((item, index) => index % 2 === 0 && String(item || '').toLowerCase() === 'authorization').length
    : 1
  const raw = req.headers.authorization
  const header = Array.isArray(raw) ? '' : String(raw === undefined || raw === null ? '' : raw).trim()
  const match = duplicateCount === 1 ? header.match(/^Bearer[\t ]+(\S+)$/i) : null
  if (!match) throw miniAuthError('登录凭据格式无效，请重新登录')
  return match[1]
}

function verifyMiniAuthToken(token) {
  const parts = String(token || '').trim().split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw miniAuthError()

  const expected = crypto.createHmac('sha256', miniAuthTokenSecret()).update(parts[0]).digest('base64url')
  const actualBuffer = Buffer.from(parts[1])
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw miniAuthError()
  }

  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch (error) {
    throw miniAuthError()
  }

  const userId = String(payload.userId || '').trim()
  const exp = Number(payload.exp || 0)
  if (!userId || !Number.isFinite(exp) || exp <= Date.now()) throw miniAuthError()
  // 上线前签发的存量 token 没有 tokenVersion，按 0 兼容；显式携带非法版本则拒绝。
  const hasTokenVersion = Object.prototype.hasOwnProperty.call(payload, 'tokenVersion')
  const tokenVersion = hasTokenVersion ? payload.tokenVersion : 0
  if (!Number.isSafeInteger(tokenVersion) || tokenVersion < 0) throw miniAuthError()
  return { userId, exp, tokenVersion }
}

function miniAuthContextFromRequest(req, db) {
  const token = bearerTokenFromRequest(req)
  if (!token) return null
  const payload = verifyMiniAuthToken(token)
  // 软删/停用账号的旧 token 立即失效：与后台账号鉴权（assertAdminRequest/登录）同口径排除 deleted，
  // 否则删除/停用无法即时踢掉已登录设备（旧 token 在过期前仍可访问登录态接口）。
  const user = (db.users || []).find((item) => (
    item.id === payload.userId && item.status !== '禁用' && item.status !== '已删除' && !item.deleted
  ))
  if (!user) throw miniAuthError('登录用户不存在或已停用')
  if (payload.tokenVersion !== miniAuthTokenVersion(user)) {
    throw miniAuthError('登录状态已失效，请使用新密码重新登录')
  }
  return {
    userId: user.id,
    tokenVersion: miniAuthTokenVersion(user),
    exp: payload.exp
  }
}

function miniUserIdFromRequest(req, db) {
  const context = miniAuthContextFromRequest(req, db)
  return context ? context.userId : ''
}

// 所有登录态数据库写都必须在 updateDb 持锁并从最新磁盘重读后重新验签。路由锁外的 userId 只可
// 用于同步纯读；不能跨 parseBody/await 后捕获进写事务，否则退出/停用后的在途请求仍可能落库。
function updateMiniDb(req, mutator) {
  return dbStore.updateDb((nextDb) => {
    const context = miniAuthContextFromRequest(req, nextDb)
    assertMiniLogin(context && context.userId)
    return mutator(nextDb, context.userId, context)
  })
}

// 外部付费/签名能力没有业务写入，但同样需要在真正调用前基于 fresh DB 重验。inspectDb
// 使用与写事务相同的跨进程锁完成只读线性化，不刷新文件时间、不制造无意义整库写入。
function assertFreshMiniSession(req, expectedUserId) {
  return dbStore.inspectDb((freshDb) => {
    const context = miniAuthContextFromRequest(req, freshDb)
    assertMiniLogin(context && context.userId)
    if (expectedUserId && context.userId !== expectedUserId) throw miniAuthError()
    return context.userId
  })
}

function clientUploadPolicyInput(body = {}) {
  // 对象键只能由服务端随机生成；客户端只可提供非敏感文件元数据。否则可指定已知 key，
  // 借同目录上传策略覆盖他人视频、群截图或带看证据。
  return {
    fileName: body.fileName,
    mimeType: body.mimeType,
    size: body.size
  }
}

function miniAuthResponse(user) {
  const auth = issueMiniAuthToken(user.id, miniAuthTokenVersion(user))
  // 剥离密码哈希/明文：登录响应平铺整个 user，绝不能把 passwordHash 顺出去。
  const safe = { ...user }
  delete safe.passwordHash
  delete safe.password
  delete safe.tokenVersion
  return {
    ...safe,
    token: auth.token,
    tokenExpiresAt: auth.tokenExpiresAt
  }
}

function defaultAdminAccounts(db) {
  const firstAdmin = (db.users || []).find((user) => user.isAdmin) || {}
  return [
    {
      id: 'A001',
      account: 'admin',
      password: 'admin123',
      name: '管理员',
      userId: firstAdmin.id || 'U004',
      permission: '全部后台权限',
      status: '启用'
    },
    {
      id: 'A002',
      account: 'manager01',
      password: 'manager123',
      name: firstAdmin.name || '区域主管',
      userId: firstAdmin.id || 'U004',
      permission: '区域查看权限',
      status: '启用'
    }
  ]
}

function publicAdminAccount(account) {
  const copy = { ...account }
  delete copy.password
  delete copy.passwordHash
  return copy
}

function assertAdminRequest(req, db) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const payload = verifyAdminToken(token)
  if (!payload) {
    const error = new Error('管理员登录已失效，请重新登录')
    error.statusCode = 401
    throw error
  }

  const accounts = db.adminAccounts || defaultAdminAccounts(db)
  const account = accounts.find((item) => item.id === payload.id && item.status !== '禁用' && !item.deleted)
  if (!account) {
    const error = new Error('无管理员权限')
    error.statusCode = 403
    throw error
  }
  return account
}

function isSuperAdmin(account) {
  // 超级管理员判定（与 assertAdminCapability 同源，避免两套口径漂移）：存量管理员账号历史上没有
  // permission/capabilities 字段，这类账号按超级管理员兼容；只把显式标为受限权限（如「区域查看权限」）
  // 的账号视为普通管理员，避免锁死老账号。
  if (!account) return false
  const permission = String(account.permission || '').trim()
  const capabilities = Array.isArray(account.capabilities)
    ? account.capabilities.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  const explicitlyRestricted = (
    permission && permission !== '全部后台权限'
  ) || (
    capabilities.length && capabilities.indexOf('*') === -1 && capabilities.indexOf('all') === -1
  )
  return !explicitlyRestricted
}

function assertAdminCapability(account) {
  // 高危写操作 + 「系统配置」整组（飞书同步/LLM配置/客服反馈/客服Trace/上线检查/账号管理/数据备份）
  // 只允许超级管理员访问；普通管理员一律 403。前端隐藏菜单只是体验，这里才是真正的安全边界。
  if (!isSuperAdmin(account)) {
    const error = new Error('当前管理员无权执行该操作')
    error.statusCode = 403
    throw error
  }
}

function assertFreshAdminCapability(req, freshDb) {
  const account = assertAdminRequest(req, freshDb)
  assertAdminCapability(account)
  return account
}

function updateAdminDb(req, mutator) {
  return dbStore.updateDb((nextDb) => {
    const account = assertFreshAdminCapability(req, nextDb)
    return mutator(nextDb, account)
  })
}

// ---------- 客服反馈完整对话重建（需求3） ----------
// 完整对话直接由既有 trace log（db.assistantTraceLogs）重建：旧反馈沿用 threadId，严格反馈先用
// 服务端结果 messageId 精确定位所属用户 trace，再取同用户同 threadId 的轮次。trace 落库时已脱敏、
// listing.id 原样保留，无需额外保存对话副本。
function buildFeedbackConversation(db, feedbackId) {
  const id = String(feedbackId || '').trim()
  const feedback = (db.assistantFeedbacks || []).find((item) => item.id === id)
  if (!feedback) {
    const error = new Error('assistant feedback not found')
    error.statusCode = 404
    throw error
  }
  const resultTrace = feedback.feedbackVersion === 'match-result-v1'
    ? (db.assistantTraceLogs || []).find((item) => (
      item &&
      item.id === feedback.messageId &&
      String(item.userId || '').trim() === String(feedback.userId || '').trim()
    ))
    : null
  const threadId = String((resultTrace && resultTrace.threadId) || feedback.threadId || '').trim()
  const rows = threadId
    ? assistantService.traceRows(db, {
      threadId,
      userId: resultTrace ? feedback.userId : '',
      limit: 200
    }).slice().reverse()
    : []
  const turns = rows.map((row, index) => ({
    round: index + 1,
    time: row.createdAt || '',
    intent: row.intent || '',
    userInput: row.sourceText || '',
    assistantReply: row.reply || '',
    nextQuestion: row.nextQuestion || '',
    need: row.need || {},
    listings: Array.isArray(row.listings) ? row.listings : [],
    replyMode: row.replyMode || ''
  }))
  return {
    feedbackId: feedback.id,
    threadId,
    status: feedback.status || '',
    feedbackType: feedback.feedbackType || '',
    createdAt: feedback.createdAt || '',
    turnCount: turns.length,
    // threadId 存在却取不到轮次：多为 trace log 达上限（500 条）被滚动清理，如实告知运营。
    truncated: (feedback.feedbackVersion === 'match-result-v1' && !resultTrace) || (Boolean(threadId) && turns.length === 0),
    turns
  }
}

// ---------- 数据备份/异地同步状态（需求1，只读非敏感元数据） ----------
function backupStageDir() {
  return process.env.BACKUP_STAGE_DIR
    ? path.resolve(process.env.BACKUP_STAGE_DIR)
    : path.join(config.rootDir, 'backups')
}

// 演练/上传脚本可选写入的状态文件；只按白名单透出非敏感字段——即便文件里混入了别的键，
// 也不会被返回。缺失/损坏一律降级为 null，不抛错、不泄露路径。
function readSafeStatusFile(dir, name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const at = typeof parsed.at === 'string' ? parsed.at
      : (Number.isFinite(parsed.atMs) ? new Date(parsed.atMs).toISOString() : '')
    return {
      ok: Boolean(parsed.ok),
      at,
      kind: typeof parsed.kind === 'string' ? parsed.kind.slice(0, 40) : '',
      fileName: typeof parsed.fileName === 'string' ? parsed.fileName.slice(0, 120) : '',
      countsMatch: parsed.countsMatch === undefined ? null : Boolean(parsed.countsMatch),
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : ''
    }
  } catch (error) {
    return null
  }
}

function buildBackupStatus() {
  // 全程不解密备份、不联网、不读取任何凭据。绝不返回 BACKUP_ENCRYPTION_KEY / FEISHU_BACKUP_* / token。
  const dir = backupStageDir()
  const maxAgeHours = Number(process.env.BACKUP_MAX_AGE_HOURS) > 0 ? Number(process.env.BACKUP_MAX_AGE_HOURS) : 24
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS) > 0 ? Number(process.env.BACKUP_RETENTION_DAYS) : 30
  let backupCount = 0
  let fresh = { ok: false, latest: null, latestMs: null, ageMs: null, reason: '备份目录不可读或为空' }
  try {
    backupCount = backup.listBackups(dir).length
    fresh = backup.checkFreshness({ dir, maxAgeHours })
  } catch (error) {
    // 目录不存在等：保持默认「无备份」结论，不抛错。
  }
  return {
    now: new Date().toISOString(),
    offsite: {
      encryptionConfigured: Boolean(process.env.BACKUP_ENCRYPTION_KEY),
      remoteConfigured: Boolean(process.env.BACKUP_REMOTE_CMD),
      backupCount,
      latestFile: fresh.latest || null,
      latestAt: Number.isFinite(fresh.latestMs) ? new Date(fresh.latestMs).toISOString() : null,
      ageHours: Number.isFinite(fresh.ageMs) ? Math.round((fresh.ageMs / 3600000) * 10) / 10 : null,
      maxAgeHours,
      retentionDays,
      fresh: Boolean(fresh.ok),
      stale: !fresh.ok,
      reason: fresh.reason || ''
    },
    feishu: {
      configured: Boolean(
        process.env.FEISHU_BACKUP_APP_ID &&
        process.env.FEISHU_BACKUP_APP_SECRET &&
        process.env.FEISHU_BACKUP_FOLDER_TOKEN
      ),
      lastUpload: readSafeStatusFile(dir, 'feishu-upload-status.json'),
      lastDrill: readSafeStatusFile(dir, 'feishu-drill-status.json')
    },
    localDrill: readSafeStatusFile(dir, 'restore-drill-status.json')
  }
}

// ---------- 敏感查看足迹筛选 + 分页（需求4） ----------
// 无任何查询参数时返回旧的完整数组，保 smoke-test 与旧调用兼容；带参数时返回
// { rows, total, page, pageSize, totalPages, actions } 分页对象。筛选在 index.js 层对
// domain.adminLogs 的输出做，不改与 Yooni 争用的 domain.js。
const FOOTPRINT_QUERY_KEYS = ['viewer', 'keyword', 'action', 'startDate', 'endDate', 'page', 'pageSize']

function parseFootprintTimeMs(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  // 足迹时间是 zh-CN 本地串（如「2026/7/4 23:17:24」），日期筛选参数是「YYYY-MM-DD」；统一把
  // 短横替换成斜杠再交给 Date 解析，两种格式 V8 都能按本地时区解析。
  const ms = new Date(raw.replace(/-/g, '/')).getTime()
  return Number.isFinite(ms) ? ms : null
}

function filterAdminFootprints(rows, searchParams) {
  const all = Array.isArray(rows) ? rows : []
  const hasQuery = FOOTPRINT_QUERY_KEYS.some((key) => (
    searchParams.has(key) && String(searchParams.get(key) || '').trim() !== ''
  ))
  // 内容类型候选值（去重）基于全量算，方便前端渲染筛选下拉，无论是否分页都返回。
  const actions = Array.from(new Set(all.map((item) => String(item.action || '').trim()).filter(Boolean)))
  if (!hasQuery) return all

  const viewer = String(searchParams.get('viewer') || '').trim().toLowerCase()
  const keyword = String(searchParams.get('keyword') || '').trim().toLowerCase()
  const action = String(searchParams.get('action') || '').trim()
  const startMs = parseFootprintTimeMs(searchParams.get('startDate'))
  let endMs = parseFootprintTimeMs(searchParams.get('endDate'))
  // 结束日期若是纯日期，按当天 23:59:59.999 闭区间，避免把当天记录漏掉。
  if (endMs != null && /^\d{4}-\d{2}-\d{2}$/.test(String(searchParams.get('endDate') || '').trim())) {
    endMs += 86400000 - 1
  }

  const filtered = all.filter((item) => {
    if (viewer && !String(item.viewer || '').toLowerCase().includes(viewer)) return false
    if (action && String(item.action || '').trim() !== action) return false
    if (keyword) {
      const hay = `${item.listing || ''} ${item.uploader || ''} ${item.needId || ''} ${item.purpose || ''}`.toLowerCase()
      if (!hay.includes(keyword)) return false
    }
    if (startMs != null || endMs != null) {
      const t = parseFootprintTimeMs(item.time)
      if (t == null) return false
      if (startMs != null && t < startMs) return false
      if (endMs != null && t > endMs) return false
    }
    return true
  })

  const total = filtered.length
  const pageSize = Math.min(Math.max(Number(searchParams.get('pageSize')) || 50, 1), 500)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(Number(searchParams.get('page')) || 1, 1), totalPages)
  const startIndex = (page - 1) * pageSize
  return {
    rows: filtered.slice(startIndex, startIndex + pageSize),
    total,
    page,
    pageSize,
    totalPages,
    actions
  }
}

function serveAdminWeb(req, res, pathname) {
  const relativePath = pathname === '/admin-web' || pathname === '/admin-web/' ? 'index.html' : pathname.replace('/admin-web/', '')
  const filePath = path.resolve(config.adminWebDir, relativePath)

  // 目录边界比较必须带分隔符：裸 startsWith(adminWebDir) 会把 admin-web-backup、admin-website
  // 等同前缀的兄弟目录误判为「在目录内」，被 ../admin-web-backup/x 之类路径整目录暴露。
  if (filePath !== config.adminWebDir && !filePath.startsWith(config.adminWebDir + path.sep)) {
    const error = new Error('非法路径')
    error.statusCode = 403
    throw error
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const error = new Error('页面不存在')
    error.statusCode = 404
    throw error
  }

  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    'Content-Type': contentTypes[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  })
  const stream = fs.createReadStream(filePath)
  stream.on('error', (error) => {
    // statSync 通过后文件被删/被独占锁定等会让读流触发 error；pipe 不转发源流错误，
    // 无 error 监听会成为 uncaughtException 使进程退出。响应头通常已发出，只能断开连接。
    if (res.headersSent) {
      res.destroy(error)
    } else {
      sendError(res, error)
    }
  })
  stream.pipe(res)
}

function serveUtilityScript(req, res, pathname) {
  if (pathname !== '/utils/mock-data.js') {
    const error = new Error('页面不存在')
    error.statusCode = 404
    throw error
  }

  const filePath = path.resolve(config.rootDir, '..', 'utils', 'mock-data.js')
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  })
  const stream = fs.createReadStream(filePath)
  stream.on('error', (error) => {
    // statSync 通过后文件被删/被独占锁定等会让读流触发 error；pipe 不转发源流错误，
    // 无 error 监听会成为 uncaughtException 使进程退出。响应头通常已发出，只能断开连接。
    if (res.headersSent) {
      res.destroy(error)
    } else {
      sendError(res, error)
    }
  })
  stream.pipe(res)
}

const DEFAULT_LLM_SYSTEM_PROMPT = '你是寓你配房小帮手。根据租客预算、区域、户型和标签偏好，从内部房源库候选房源中返回推荐理由；不能编造不存在的房源，不能输出详细地址、房东联系方式、房间号或视频签名链接。'
const DEFAULT_QWEN_NEED_PARSER_MODEL = 'qwen3.5-plus'
const DEFAULT_QWEN_COMPLEX_NEED_PARSER_MODEL = 'qwen3.7-plus'
const DEFAULT_QWEN_REPLY_MODEL = 'qwen-turbo'

function looksBrokenPrompt(value) {
  const text = String(value || '').trim()
  if (!text) return true
  const questionCount = (text.match(/\?/g) || []).length
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length
  return text.indexOf('\uFFFD') !== -1 || (text.length >= 8 && questionCount / text.length > 0.25 && cjkCount === 0)
}

function normalizeLlmConfig(raw = {}) {
  const provider = raw.provider || 'local'
  const defaultModel = provider === 'qwen' ? DEFAULT_QWEN_NEED_PARSER_MODEL : 'local-match-v1'
  const model = String(raw.model || defaultModel).trim() || defaultModel
  const systemPrompt = String(raw.systemPrompt || '').trim()
  return {
    provider,
    protocol: raw.protocol || 'openai-compatible',
    apiBaseUrl: raw.apiBaseUrl || '',
    model,
    needParserModel: String(raw.needParserModel || (provider === 'qwen' ? DEFAULT_QWEN_NEED_PARSER_MODEL : model)).trim() || model,
    complexNeedParserModel: String(raw.complexNeedParserModel || (provider === 'qwen' ? DEFAULT_QWEN_COMPLEX_NEED_PARSER_MODEL : model)).trim() || model,
    replyModel: String(raw.replyModel || (provider === 'qwen' ? DEFAULT_QWEN_REPLY_MODEL : model)).trim() || model,
    secretName: raw.secretName || 'LLM_API_KEY',
    systemPrompt: looksBrokenPrompt(systemPrompt) ? DEFAULT_LLM_SYSTEM_PROMPT : systemPrompt,
    enabled: Boolean(raw.enabled),
    updatedAt: raw.updatedAt || ''
  }
}

function saveLlmConfig(db, body) {
  const next = normalizeLlmConfig(body)
  next.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  db.llmConfig = next
  return next
}

async function fetchWechatOpenid(code) {
  if (!config.wechatPay.appId || !config.wechatPay.appSecret) {
    const error = new Error('缺少 WECHAT_APP_ID 或 WECHAT_APP_SECRET，无法绑定微信 openid')
    error.statusCode = 503
    throw error
  }
  const query = new URLSearchParams({
    appid: config.wechatPay.appId,
    secret: config.wechatPay.appSecret,
    js_code: code,
    grant_type: 'authorization_code'
  })
  const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${query.toString()}`)
  const body = await response.json()
  if (!response.ok || !body.openid) {
    const error = new Error(body.errmsg || '微信登录凭证换取 openid 失败')
    error.statusCode = 502
    throw error
  }
  return body
}

function launchCheckItem(title, status, detail, action) {
  return { title, status, detail, action }
}

function markMiniAuthFailureBeforeExecution(error) {
  if (!error || Number(error.statusCode) !== 401) throw error
  error.data = {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    authFailurePhase: 'pre_execution'
  }
  throw error
}

function initialMiniAuthContextFromRequest(req, db) {
  try {
    return miniAuthContextFromRequest(req, db)
  } catch (error) {
    return markMiniAuthFailureBeforeExecution(error)
  }
}

function assertFreshMiniSessionBeforeExecution(req, expectedUserId) {
  try {
    return assertFreshMiniSession(req, expectedUserId)
  } catch (error) {
    return markMiniAuthFailureBeforeExecution(error)
  }
}

function buildLaunchCheck(db) {
  const accounts = db.adminAccounts || defaultAdminAccounts(db)
  const llmConfig = db.llmConfig || {}
  const llmSecretName = llmConfig.secretName || 'LLM_API_KEY'
  const asrStatus = asrService.configStatus(db)
  // 后台账号一旦存明文 password 字段即视为弱（内置默认账号 admin123/manager123 即如此；正式
  // 账号应只保存加密 passwordHash）。原写法的 defaultPasswords 分支永不触发——account.password
  // 为真时前一分支已短路命中，为假时 String('') 又不在集合内，属死代码，去掉以免误导。
  const weakAdmins = accounts.filter((account) => Boolean(account.password))
  const ossMissing = []
  if (!config.oss.bucket) ossMissing.push('ALI_OSS_BUCKET')
  if (!config.oss.region) ossMissing.push('ALI_OSS_REGION')
  if (!config.oss.accessKeyId) ossMissing.push('ALI_OSS_ACCESS_KEY_ID')
  if (!config.oss.accessKeySecret) ossMissing.push('ALI_OSS_ACCESS_KEY_SECRET')
  if (!config.oss.publicBaseUrl) ossMissing.push('ALI_OSS_PUBLIC_BASE_URL')
  const wxPayMissing = config.wechatPay.enabled ? wxpay.requiredMissing() : []
  const feishuStatus = feishuSync.status(db)
  const miniProgram = config.miniProgram || {}
  const publicMediaDownloadReady = isSecureSameOrigin(miniProgram.requestDomain, miniProgram.downloadDomain)
  const userCount = (db.users || []).length
  const listingCount = (db.listings || []).length
  const groupCount = (db.groups || []).length
  const baseStatus = userCount && groupCount ? (listingCount ? '通过' : '待确认') : '需处理'
  const registrationDeadLetterCount = (db.registrationRequests || [])
    .filter((request) => request && request.status === '待审核' && request.notifyStatus === 'dead_letter')
    .length

  const items = [
    launchCheckItem(
      '百炼 ASR 语音识别',
      asrStatus.ready ? '通过' : '需处理',
      asrStatus.ready ? `${asrStatus.model} 已配置，音频由后端代理转写` : `缺少服务端密钥环境变量 ${asrStatus.secretName}`,
      '在服务端环境变量中设置 ASR_API_KEY、DASHSCOPE_API_KEY，或复用 LLM_API_KEY；微信小程序 uploadFile 合法域名也要指向后端'
    ),
    launchCheckItem(
      'OSS/RAM 最小权限',
      ossMissing.length ? '需处理' : '通过',
      ossMissing.length ? `缺少 ${ossMissing.join('、')}` : `Bucket ${config.oss.bucket} 已配置，服务端使用 RAM 子账号生成 OSS 直传和短期读取签名`,
      ossMissing.length ? '在 server/.env 补齐 OSS/RAM 子账号参数，Bucket 建议保持私有读' : '上线前确认 RAM Policy 仅允许 house-videos/*、group-screenshots/*、showing-photos/*'
    ),
    launchCheckItem(
      '后台 Token 密钥',
      process.env.ADMIN_TOKEN_SECRET ? '通过' : '需处理',
      process.env.ADMIN_TOKEN_SECRET ? 'ADMIN_TOKEN_SECRET 已由服务端环境变量提供' : '当前使用本地开发默认密钥',
      process.env.ADMIN_TOKEN_SECRET ? '上线后定期轮换密钥' : '在服务器环境变量中设置强随机 ADMIN_TOKEN_SECRET'
    ),
    launchCheckItem(
      '小程序登录 Token 密钥',
      process.env.AUTH_TOKEN_SECRET ? '通过' : '需处理',
      process.env.AUTH_TOKEN_SECRET ? 'AUTH_TOKEN_SECRET 已由服务端环境变量提供' : '缺少小程序登录签名密钥',
      process.env.AUTH_TOKEN_SECRET ? '上线后定期轮换密钥' : '在服务器环境变量中设置强随机 AUTH_TOKEN_SECRET'
    ),
    launchCheckItem(
      '管理员初始密码',
      weakAdmins.length ? '需处理' : '通过',
      weakAdmins.length ? `${weakAdmins.length} 个管理员仍使用内测默认密码或明文密码` : '管理员账号已使用加密密码',
      weakAdmins.length ? '在后台账号管理中修改默认密码，系统会加密保存新密码' : '保留最小管理员权限'
    ),
    launchCheckItem(
      'LLM 配房助手',
      llmConfig.enabled && llmConfig.provider !== 'local' && llmConfig.apiBaseUrl && process.env[llmSecretName] ? '通过' : '需处理',
      llmConfig.enabled && llmConfig.provider !== 'local'
        ? (process.env[llmSecretName] ? `${llmConfig.provider} / ${llmConfig.model} 已配置` : `缺少服务端密钥环境变量 ${llmSecretName}`)
        : '当前仍是本地模拟或未启用真实 LLM',
      '在后台 LLM 配置中选择供应商，并在服务端环境变量保存对应密钥'
    ),
    launchCheckItem(
      '基础数据',
      baseStatus,
      `用户 ${userCount} 个，房源 ${listingCount} 套，历史群素材 ${groupCount} 个`,
      listingCount ? '上线后持续核验房源状态' : '当前没有真实房源时小程序展示空状态，员工上传后会自动显示'
    ),
    launchCheckItem(
      `注册通知死信 ${registrationDeadLetterCount} 条`,
      registrationDeadLetterCount ? '需处理' : '通过',
      registrationDeadLetterCount ? '存在通知重试耗尽的注册申请，已通过健康告警通道通知管理员' : '当前没有注册通知死信',
      registrationDeadLetterCount ? '在后台核对待审核申请并人工联系，处理后由申请人重新提交或完成审核' : '持续保留死信告警与重启补发巡检'
    ),
    launchCheckItem(
      '微信合法域名',
      publicMediaDownloadReady ? '待确认' : '需处理',
      `request ${miniProgram.requestDomain || '未配置'}；uploadFile ${miniProgram.uploadDomain || '未配置'}；downloadFile ${miniProgram.downloadDomain || '未配置'}；公开视频播放/保存统一走 request API 域`,
      publicMediaDownloadReady
        ? '在微信小程序后台确认该 API 域同时加入 request、downloadFile 与 video 媒体合法域名'
        : '把 MINI_DOWNLOAD_DOMAIN 改为 request API 域，并在微信后台同时加入 request、downloadFile 与 video 媒体合法域名'
    ),
    launchCheckItem(
      '第一版隐藏功能',
      '通过',
      '房源群、积分、充值、换群、微信支付作为历史能力保留，第一版前台不作为验收入口',
      '保持入口隐藏，后端历史代码仅用于后续版本灰度'
    ),
    launchCheckItem(
      '飞书房源同步',
      feishuStatus.ready ? '通过' : '需处理',
      feishuStatus.ready
        ? `${feishuStatus.mode} 已配置，当前同步公司房源 ${feishuStatus.feishuListingCount} 套，自动同步周期 ${feishuStatus.syncIntervalMinutes} 分钟`
        : '缺少飞书应用、房源表或素材库配置，暂不能自动同步公司房源',
      feishuStatus.ready
        ? '后台可在“飞书同步”里手动执行；服务启动后会按配置周期自动刷新房态'
        : '补齐 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_BITABLE_APP_TOKEN、FEISHU_BITABLE_TABLE_ID 和素材库 Folder Token'
    )
  ]

  return {
    summary: {
      pass: items.filter((item) => item.status === '通过').length,
      todo: items.filter((item) => item.status === '需处理').length,
      pending: items.filter((item) => item.status === '待确认').length
    },
    items,
    requiredInputs: items
      .filter((item) => item.status !== '通过')
      .map((item) => `${item.title}：${item.action}`)
  }
}

function buildMissingEnvTemplate(db) {
  const llmConfig = db.llmConfig || {}
  const llmSecretName = llmConfig.secretName || 'LLM_API_KEY'
  const asrStatus = asrService.configStatus(db)
  const names = []
  if (!process.env.ADMIN_TOKEN_SECRET) names.push('ADMIN_TOKEN_SECRET')
  if (!process.env.AUTH_TOKEN_SECRET) names.push('AUTH_TOKEN_SECRET')
  if (!config.oss.bucket) names.push('ALI_OSS_BUCKET')
  if (!config.oss.region) names.push('ALI_OSS_REGION')
  if (!config.oss.accessKeyId) names.push('ALI_OSS_ACCESS_KEY_ID')
  if (!config.oss.accessKeySecret) names.push('ALI_OSS_ACCESS_KEY_SECRET')
  if (!config.oss.publicBaseUrl) names.push('ALI_OSS_PUBLIC_BASE_URL')
  if (llmConfig.enabled && llmConfig.provider !== 'local' && !process.env[llmSecretName]) names.push(llmSecretName)
  if (!asrStatus.ready) names.push(asrStatus.secretName || 'ASR_API_KEY')
  if (config.wechatPay.enabled) {
    wxpay.requiredMissing().forEach((name) => names.push(name))
  }
  const feishuMissing = []
  if (!config.feishu.recordsFile && !config.feishu.sheetToken) {
    if (!config.feishu.appId) feishuMissing.push('FEISHU_APP_ID')
    if (!config.feishu.appSecret) feishuMissing.push('FEISHU_APP_SECRET')
    if (!config.feishu.bitableAppToken) feishuMissing.push('FEISHU_BITABLE_APP_TOKEN')
    if (!config.feishu.bitableTableId) feishuMissing.push('FEISHU_BITABLE_TABLE_ID')
  }
  if (config.feishu.sheetToken) {
    if (!config.feishu.appId) feishuMissing.push('FEISHU_APP_ID')
    if (!config.feishu.appSecret) feishuMissing.push('FEISHU_APP_SECRET')
  }
  if (!config.feishu.folderToken && !config.feishu.materialsFile) feishuMissing.push('FEISHU_MATERIAL_FOLDER_TOKEN')
  feishuMissing.forEach((name) => names.push(name))

  const uniqueNames = Array.from(new Set(names))
  if (!uniqueNames.length) {
    return '# 当前自动检查项没有缺失的服务端环境变量'
  }
  return uniqueNames.map((name) => `${name}=`).join('\n')
}

function buildHealth(db) {
  const launch = buildLaunchCheck(db)
  return {
    ok: launch.summary.todo === 0,
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    service: 'ynzy-house-miniapp',
    version: appVersion.getVersion(), // 版本追溯：/readyz 也带上当前版本
    checks: launch.summary,
    pending: launch.items
      .filter((item) => item.status !== '通过')
      .map((item) => ({ title: item.title, status: item.status }))
  }
}

function withSignedVideoUrl(detail) {
  if (!detail || !detail.videoKey) return detail
  return {
    ...detail,
    videoUrl: oss.createSignedReadUrl(detail.videoKey)
  }
}

function videoUploadTicketSignature(userId, objectKey, expiresAt) {
  const payload = ['v1', String(userId || ''), String(objectKey || ''), String(expiresAt || '')].join('\n')
  const key = crypto.createHmac('sha256', miniAuthTokenSecret()).update('ynzy-video-upload-ticket-v1').digest()
  return crypto.createHmac('sha256', key).update(payload).digest('base64url')
}

const VIDEO_UPLOAD_TICKET_QUERY = 'ynzyUploadTicket'

function withVideoUploadTicket(policy, userId) {
  const result = { ...(policy || {}) }
  const objectKey = String(result.objectKey || '').trim()
  const expiresAt = Math.floor(Date.parse(result.expiresAt || '') / 1000)
  if (!objectKey || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return result
  result.uploadTicket = `v1.${expiresAt}.${videoUploadTicketSignature(userId, objectKey, expiresAt)}`
  try {
    const fileUrl = new URL(String(result.fileUrl || ''))
    const sourceOptions = {
      uploadDir: config.oss.uploadDir,
      allowedOrigins: oss.readSourceOrigins()
    }
    if (!fileUrl.username && !fileUrl.password && !fileUrl.hash &&
      resolveManagedVideoObjectKey({ videoUrl: fileUrl.toString() }, sourceOptions) === objectKey) {
      fileUrl.searchParams.set(VIDEO_UPLOAD_TICKET_QUERY, result.uploadTicket)
      result.fileUrl = fileUrl.toString()
    }
  } catch (error) {}
  return result
}

function validVideoUploadTicket(ticket, userId, objectKey) {
  const matched = String(ticket || '').match(/^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/)
  if (!matched) return false
  const expiresAt = Number(matched[1])
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false
  const expected = videoUploadTicketSignature(userId, objectKey, expiresAt)
  const actual = matched[2]
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

function submittedVideoUploadUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.username || url.password || url.hash) return null
    const embeddedTickets = url.searchParams.getAll(VIDEO_UPLOAD_TICKET_QUERY)
    if (embeddedTickets.length > 1) return null
    const embeddedTicket = embeddedTickets[0] || ''
    url.searchParams.delete(VIDEO_UPLOAD_TICKET_QUERY)
    if (Array.from(url.searchParams.keys()).length) return null
    url.search = ''
    return { canonicalUrl: url.toString(), embeddedTicket }
  } catch (error) {
    return null
  }
}

function validatedListingVideoBody(body = {}, userId, currentListing = null) {
  const result = { ...(body || {}) }
  const hasVideoKey = Object.prototype.hasOwnProperty.call(result, 'videoKey')
  const hasVideoUrl = Object.prototype.hasOwnProperty.call(result, 'videoUrl')
  delete result.videoUploadTicket
  if (!hasVideoKey && !hasVideoUrl) return result

  const videoKey = String(body.videoKey || '').trim()
  const videoUrl = String(body.videoUrl || '').trim()
  const unchanged = Boolean(currentListing) &&
    videoKey === String(currentListing.videoKey || '').trim() &&
    videoUrl === String(currentListing.videoUrl || '').trim()
  if (unchanged) return result

  const sourceOptions = {
    uploadDir: config.oss.uploadDir,
    allowedOrigins: oss.readSourceOrigins()
  }
  const submittedUrl = submittedVideoUploadUrl(videoUrl)
  const explicitTicket = String(body.videoUploadTicket || '').trim()
  const embeddedTicket = submittedUrl ? String(submittedUrl.embeddedTicket || '').trim() : ''
  const uploadTicket = explicitTicket || embeddedTicket
  const normalizedKey = resolveManagedVideoObjectKey({ videoKey }, sourceOptions)
  const urlKey = submittedUrl
    ? resolveManagedVideoObjectKey({ videoUrl: submittedUrl.canonicalUrl }, sourceOptions)
    : ''
  if (!videoKey || !videoUrl || !submittedUrl || (explicitTicket && embeddedTicket && explicitTicket !== embeddedTicket) ||
    normalizedKey !== videoKey || urlKey !== videoKey || !validVideoUploadTicket(uploadTicket, userId, videoKey)) {
    const error = new Error('视频上传凭证无效或已过期，请重新选择视频上传')
    error.statusCode = 400
    throw error
  }
  result.videoUrl = submittedUrl.canonicalUrl
  return result
}

let publicListingMediaServiceInstance = null

function publicListingMediaService() {
  if (publicListingMediaServiceInstance) return publicListingMediaServiceInstance
  publicListingMediaServiceInstance = createPublicListingMediaService({
    secret: miniAuthTokenSecret(),
    baseUrl: config.miniProgram.requestDomain,
    uploadDir: config.oss.uploadDir,
    maxBytes: config.oss.maxVideoSize,
    allowedOrigins: oss.readSourceOrigins(),
    signVideoUrl(objectKey, method) {
      if (!oss.hasReadConfig()) throw Object.assign(new Error('媒体读取配置不完整'), { statusCode: 503 })
      return oss.createSignedReadUrl(objectKey, config.oss.readUrlExpireSeconds, method)
    },
    signCoverUrl(objectKey, method) {
      if (!oss.hasReadConfig()) throw Object.assign(new Error('媒体读取配置不完整'), { statusCode: 503 })
      return oss.createVideoSnapshotUrl(objectKey, config.oss.readUrlExpireSeconds, method)
    }
  })
  return publicListingMediaServiceInstance
}

function ownerListingMediaStateKey(listing = {}) {
  return [
    'owner-media-v1',
    String(listing.uploaderId || ''),
    String(listing.lifecycleStatus || ''),
    String(listing.status || ''),
    String(listing.reviewStatus || ''),
    String(listing.updatedAt || ''),
    String(listing.lastVerifiedAt || '')
  ].join('\n')
}

function ownerListingMediaEligible(db, listing = {}) {
  const uploaderId = String(listing.uploaderId || '').trim()
  const listingId = String(listing.id || '').trim()
  if (!uploaderId || !listingId) return false
  return domain.ownedListings(db, uploaderId).some((row) => String(row.id || '') === listingId)
}

function createUniqueListingIndex(listings = []) {
  const byId = new Map()
  const duplicateIds = new Set()
  ;(Array.isArray(listings) ? listings : []).forEach((listing) => {
    const listingId = String(listing && listing.id || '').trim()
    if (!listingId || duplicateIds.has(listingId)) return
    if (byId.has(listingId)) {
      byId.delete(listingId)
      duplicateIds.add(listingId)
      return
    }
    byId.set(listingId, listing)
  })
  return { byId, duplicateIds }
}

function uniqueListingFromIndex(index, listingId) {
  const normalizedId = String(listingId || '').trim()
  if (!normalizedId || !index || index.duplicateIds.has(normalizedId)) return null
  return index.byId.get(normalizedId) || null
}

function scrubAmbiguousListingMedia(result) {
  result.videoUrl = ''
  result.coverUrl = ''
  result.video = ''
  result.hasVideo = false
  delete result.videoKey
  return result
}

function withPublicListingMedia(value, db, eligibleListingIds, capabilityOptionsForListing, listingIndex) {
  const sourceListingIndex = listingIndex && listingIndex.byId instanceof Map && listingIndex.duplicateIds instanceof Set
    ? listingIndex
    : createUniqueListingIndex(db.listings || [])
  if (Array.isArray(value)) {
    return value.map((item) => withPublicListingMedia(item, db, eligibleListingIds, capabilityOptionsForListing, sourceListingIndex))
  }
  if (!value || typeof value !== 'object') return value
  const result = {}
  Object.keys(value).forEach((key) => {
    result[key] = withPublicListingMedia(value[key], db, eligibleListingIds, capabilityOptionsForListing, sourceListingIndex)
  })
  const listingId = String(value.id || '').trim()
  if (listingId && sourceListingIndex.duplicateIds.has(listingId)) return scrubAmbiguousListingMedia(result)
  const listing = uniqueListingFromIndex(sourceListingIndex, listingId)
  if (!listing) return result
  const mediaEligible = eligibleListingIds instanceof Set && eligibleListingIds.has(listingId) &&
    value.unavailable !== true && value.isAvailable !== false && value.hasVideo !== false
  if (!mediaEligible) {
    if (Object.prototype.hasOwnProperty.call(value, 'videoUrl')) result.videoUrl = ''
    if (Object.prototype.hasOwnProperty.call(value, 'coverUrl')) result.coverUrl = ''
    if (Object.prototype.hasOwnProperty.call(value, 'hasVideo')) result.hasVideo = false
    delete result.videoKey
    return result
  }
  const capabilityOptions = typeof capabilityOptionsForListing === 'function'
    ? capabilityOptionsForListing(listing)
    : {}
  const media = publicListingMediaService().urlsForListing(listing, capabilityOptions)
  if (Object.prototype.hasOwnProperty.call(value, 'videoUrl')) result.videoUrl = media.videoUrl
  if (Object.prototype.hasOwnProperty.call(value, 'coverUrl')) result.coverUrl = media.coverUrl
  if (Object.prototype.hasOwnProperty.call(value, 'hasVideo')) result.hasVideo = Boolean(media.videoUrl)
  if (!media.videoUrl && Object.prototype.hasOwnProperty.call(value, 'video')) result.video = ''
  delete result.videoKey
  return result
}

function sendPublicListingJson(res, db, data, statusCode = 200) {
  // 能力 URL 短时有效且每次访问都会重验房源状态；JSON 本身不得被共享缓存长期持有。
  res.noStore = true
  const listingIndex = createUniqueListingIndex(db.listings || [])
  const eligibleListingIds = new Set(domain.publicListingIds(db).filter((listingId) => (
    Boolean(uniqueListingFromIndex(listingIndex, listingId))
  )))
  return sendJson(res, withPublicListingMedia(data, db, eligibleListingIds, null, listingIndex), statusCode)
}

function sendOwnedListingJson(res, db, data, userId, statusCode = 200) {
  const trustedUserId = String(userId || '').trim()
  const listingIndex = createUniqueListingIndex(db.listings || [])
  const eligibleListingIds = new Set(
    domain.ownedListings(db, trustedUserId)
      .map((listing) => String(listing.id || '').trim())
      .filter((listingId) => Boolean(uniqueListingFromIndex(listingIndex, listingId)))
  )
  res.noStore = true
  return sendJson(res, withPublicListingMedia(data, db, eligibleListingIds, (listing) => ({
    scope: 'owner',
    audience: trustedUserId,
    stateKey: ownerListingMediaStateKey(listing)
  }), listingIndex), statusCode)
}

function withSignedListingVideoUrls(rows) {
  return (rows || []).map((row) => ({
    ...row,
    videoPreviewUrl: row.videoKey ? oss.createSignedReadUrl(row.videoKey) : row.videoUrl
  }))
}

function withSignedScreenshotUrls(rows) {
  return (rows || []).map((row) => ({
    ...row,
    screenshotUrl: row.screenshotKey ? oss.createSignedReadUrl(row.screenshotKey) : row.screenshotUrl
  }))
}

function withSignedShowingPhotoUrls(rows) {
  return (rows || []).map((row) => ({
    ...row,
    photoUrl: row.photoKey ? oss.createSignedReadUrl(row.photoKey) : row.photoUrl
  }))
}

function readDbForRequest() {
  const snapshot = dbStore.readDb()
  const probe = dbStore.clone(snapshot)
  const companyMigration = domain.migrateCompanyListings(probe)
  const maintenance = domain.enforceListingMaintenanceRule(probe)
  if (!companyMigration.changed && maintenance.expiredCount === 0) return snapshot

  // 自动迁移/过期必须在 updateDb 的跨进程锁内基于最新磁盘状态重做。旧实现会把锁外读到的陈旧整库
  // writeDb 回去，覆盖读写窗口内刚提交的收藏/足迹等关系。
  return dbStore.updateDb((nextDb) => {
    domain.migrateCompanyListings(nextDb)
    domain.enforceListingMaintenanceRule(nextDb)
    return dbStore.clone(nextDb)
  })
}

async function handleMini(req, res, pathname, searchParams) {
  const method = req.method
  // 所有鉴权入口（含登录失败、解析失败、过期 token）都可能携带或推断敏感会话状态。
  // 必须在读库、验签和解析请求体之前标记，确保成功与错误响应统一禁止缓存并按 Authorization 隔离。
  if (pathname.startsWith('/mini/auth/') || hasAuthorizationHeader(req)) {
    res.noStore = true
    res.varyAuthorization = true
  }
  const db = readDbForRequest()
  // 登录、注册虽不要求已有会话，但只要客户端主动携带 Authorization，就必须先完整校验。
  // 否则畸形、伪造或已撤销 token 会在两个免登录路由被静默忽略，形成同一请求头在不同端点语义分叉。
  const authContext = initialMiniAuthContextFromRequest(req, db)

  const publicMediaMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/media\/(video|cover)$/)
  if ((method === 'GET' || method === 'HEAD') && publicMediaMatch) {
    const listingId = publicMediaMatch[1]
    // 媒体本来就是公开素材，登录身份不应获得带宽限流豁免；否则单个被盗账号可无限
    // Range/HEAD/GET 占满全局并发和 OSS 出口，反而让所有游客视频 503。
    assertGuestRateLimit(req, 'mini-public-listing-media', 180)
    res.noStore = true
    const capabilityScope = searchParams.get('scope') === 'owner' ? 'owner' : 'public'
    const listingIndex = createUniqueListingIndex(db.listings || [])
    let listing = uniqueListingFromIndex(listingIndex, listingId)
    let capabilityOptions = { scope: 'public', audience: '', stateKey: '' }
    if (!listing) {
      const error = new Error('媒体不存在')
      error.statusCode = 404
      throw error
    }
    if (capabilityScope === 'owner') {
      if (!ownerListingMediaEligible(db, listing)) {
        const error = new Error('媒体不存在')
        error.statusCode = 404
        throw error
      }
      capabilityOptions = {
        scope: 'owner',
        audience: String(listing.uploaderId || ''),
        stateKey: ownerListingMediaStateKey(listing)
      }
    } else {
      const publicListingIdSet = new Set(domain.publicListingIds(db))
      if (!publicListingIdSet.has(String(listingId || '').trim())) {
        const error = new Error('媒体不存在')
        error.statusCode = 404
        throw error
      }
    }
    await publicListingMediaService().serve(req, res, {
      listing,
      listingId,
      kind: publicMediaMatch[2],
      token: searchParams.get('token') || '',
      clientKey: requestClientKey(req),
      ...capabilityOptions
    })
    return
  }

  if (method === 'POST' && pathname === '/mini/auth/login') {
    // 登录是免鉴权入口：按客户端 IP 限流防暴力破解。20/min 兼顾防爆破（scrypt 本就让在线爆破不可行）
    // 与中介共享办公室 IP 的场景；登录后 token 采用 30 天滑动续期，正常登录频次很低。值可按需调整。
    assertGuestRateLimit(req, 'mini-login', 20)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => miniAuthResponse(domain.loginByPhone(nextDb, body.phone, body.password))))
  }

  if (method === 'POST' && pathname === '/mini/auth/register') {
    // 注册是免鉴权入口；新申请/重新申请会跑一次较贵的 scrypt 哈希（待审核同号重复提交不再哈希）：
    // 按 IP 限流，既防 CPU/内存放大，也压制按 409/403 差异批量枚举内部账号。
    assertGuestRateLimit(req, 'mini-register', 10)
    const body = await parseBody(req)
    // 注册一律不发 token：registerUser 把申请落库（含用户自设密码哈希）后返回 pendingReview，此处据此
    // 返回提示。新号→待审核；已开通号→引导直接登录；已开通未设密码号→引导联系管理员重置。
    const outcome = dbStore.updateDb((nextDb) => domain.registerUser(nextDb, body))
    // 新申请/重新申请已落库：只排入异步通知任务，飞书成败绝不影响注册响应。
    notifyRegistrationApplication(outcome)
    const error = new Error((outcome && outcome.message) || '注册申请已提交，请等待管理员审核开通账号')
    error.statusCode = (outcome && outcome.statusCode) || 403
    throw error
  }

  const userId = authContext ? authContext.userId : ''
  if (authContext) {
    res.miniAuthRefresh = {
      userId: authContext.userId,
      tokenVersion: authContext.tokenVersion
    }
  }

  if (method === 'GET' && pathname === '/mini/auth/me') {
    assertMiniLogin(userId)
    return sendJson(res, domain.currentUser(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/auth/logout') {
    assertMiniLogin(userId)
    // 主动退出提升账号 tokenVersion，撤销全部设备；请求体中的任何身份/权限字段都不会读取。
    res.disableMiniAuthRefresh = true
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => (
      domain.logoutUserSessions(nextDb, freshUserId)
    )))
  }

  if (method === 'POST' && pathname === '/mini/auth/password') {
    // 登录后自助修改密码：userId 来自已验签 token，忽略请求体里的任何身份字段。
    assertMiniLogin(userId)
    // 已登录端点也按 IP 限流：防持有效 token 但不知原密码者在线爆破原密码、以及每次 scrypt 的 CPU 放大。
    assertGuestRateLimit(req, 'mini-change-password', 10)
    const body = await parseBody(req)
    res.disableMiniAuthRefresh = true
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => {
      domain.changeOwnPassword(nextDb, freshUserId, body)
      const changedUser = (nextDb.users || []).find((item) => item.id === freshUserId)
      if (!changedUser) throw miniAuthError('登录用户不存在或已停用')
      // 当前设备拿到新版本 token 后继续登录；其他设备仍持有旧版本 token，会在下一次请求时 401。
      return miniAuthResponse(changedUser)
    }))
  }

  if (method === 'POST' && pathname === '/mini/auth/wechat-openid') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    if (!body.code) {
      const error = new Error('缺少微信登录 code')
      error.statusCode = 400
      throw error
    }
    assertFreshMiniSession(req, userId)
    const session = await fetchWechatOpenid(body.code)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => {
      const user = (nextDb.users || []).find((item) => item.id === freshUserId)
      if (!user) {
        const error = new Error('未找到当前用户')
        error.statusCode = 404
        throw error
      }
      user.openid = session.openid
      if (session.unionid) user.unionid = session.unionid
      user.wechatBoundAt = new Date().toLocaleString('zh-CN', { hour12: false })
      return domain.currentUser(nextDb, freshUserId)
    }))
  }

  if (method === 'GET' && pathname === '/mini/home/listings') {
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-home-listings')
      return sendPublicListingJson(res, db, domain.filterListings(db, guestListingFilter()).slice(0, 3))
    }
    return sendPublicListingJson(res, db, domain.homeListings(db))
  }

  if (method === 'GET' && pathname === '/mini/company-sheet-snapshot') {
    const guest = isGuestUser(userId)
    if (guest) assertGuestRateLimit(req, 'mini-company-sheet-snapshot', 30)
    const cached = feishuSync.cachedSheetSnapshot(db)
    if (cached) return sendJson(res, cached)
    // 已有全量/快照同步在跑：两者都写 companySheetSnapshot，并发起第二份会互相覆盖。无缓存时
    // 返回空快照占位，等运行中的同步落库后下次请求即命中缓存，不与其争抢。
    if (feishuSyncRunning) {
      return sendJson(res, feishuSync.sanitizeSheetSnapshot({ rows: [] }))
    }
    feishuSyncRunning = true
    try {
      // clone 私有副本 + commitDelta 增量回写：readDb 命中缓存返回共享对象，直接交给跨长 await 的
      // refreshSheetSnapshot 就地改会让并发读看到半成品；commitDelta 只回写快照键，保住并发写。
      const baseSnapshot = dbStore.clone(dbStore.readDb())
      const nextDb = dbStore.clone(baseSnapshot)
      const snapshot = await feishuSync.refreshSheetSnapshot(nextDb, { reason: 'mini-request' })
      dbStore.commitDelta(baseSnapshot, nextDb)
      return sendJson(res, snapshot)
    } finally {
      feishuSyncRunning = false
    }
  }

  if (method === 'GET' && pathname === '/mini/listings') {
    const filter = {
      category: searchParams.get('category') || '',
      district: searchParams.get('district') || '',
      area: searchParams.get('area') || '',
      block: searchParams.get('block') || '',
      community: searchParams.get('community') || '',
      layout: searchParams.get('layout') || '',
      rentMode: searchParams.get('rentMode') || '',
      rentMin: searchParams.get('rentMin') || '',
      rentMax: searchParams.get('rentMax') || '',
      features: searchParams.get('features') || ''
    }
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-listings')
      return sendPublicListingJson(res, db, domain.filterListings(db, guestListingFilter(filter)))
    }
    return sendPublicListingJson(res, db, domain.filterListings(db, filter))
  }

  if (method === 'GET' && pathname === '/mini/commission-config') {
    if (isGuestUser(userId)) assertGuestRateLimit(req, 'mini-commission-config', 30)
    return sendJson(res, domain.publicCommissionConfig(db))
  }

  if (method === 'POST' && pathname === '/mini/listings/match') {
    const body = await parseBody(req)
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-listings-match')
      return sendPublicListingJson(res, db, domain.matchListings(db, guestListingFilter(body)))
    }
    assertFreshMiniSessionBeforeExecution(req, userId)
    return sendPublicListingJson(res, db, domain.matchListings(db, body))
  }

  if (method === 'POST' && pathname === '/mini/llm/match') {
    const startedAt = Date.now()
    const body = await parseBody(req)
    const guest = isGuestUser(userId)
    try {
      const resultDb = db
      const resultBody = guest ? guestListingFilter(body) : body
      if (guest) assertGuestRateLimit(req, 'mini-llm-match')
      else assertFreshMiniSessionBeforeExecution(req, userId)
      const result = await llm.matchRentalNeed(resultDb, resultBody)
      if (!guest) assertFreshMiniSession(req, userId)
      let response = { ...result }
      delete response.feedbackMessageId
      if (!guest && resultBody.stage === 'match' && resultBody.needId) {
        response = updateMiniDb(req, (nextDb, freshUserId) => (
          assistantService.recordFeedbackResult(nextDb, resultBody, response, { userId: freshUserId })
        ))
      }
      console.log(`[llm-match] status=200 durationMs=${Date.now() - startedAt} guest=${guest}`)
      return sendPublicListingJson(res, db, response)
    } catch (error) {
      console.log(`[llm-match] status=${error.statusCode || 500} durationMs=${Date.now() - startedAt} guest=${guest}`)
      throw error
    }
  }

  if (method === 'POST' && pathname === '/mini/assistant/chat') {
    const startedAt = Date.now()
    const body = await parseBody(req)
    const guest = isGuestUser(userId)
    try {
      // 慢速 LLM 调用在一份 clone 的私有请求快照上只读执行：readDb 命中缓存返回共享对象，直接
      // 交给数秒级 await 的 graph 会让期间的并发写在共享对象上被这次请求读到（半成品状态）；
      // clone 隔离之。留痕通过 persistTrace 在 await 之后用同步 updateDb 落到最新 db，
      // 消除“读快照→await 数秒→整库回写覆盖并发写入”的丢数据竞态。
      const snapshot = dbStore.clone(db)
      const resultDb = snapshot
      const resultBody = guest ? guestListingFilter(body) : body
      const persistTrace = guest
        ? (writeTraceLog) => dbStore.updateDb((freshDb) => writeTraceLog(freshDb))
        : (writeTraceLog) => updateMiniDb(req, (freshDb) => writeTraceLog(freshDb))
      if (guest) assertGuestRateLimit(req, 'mini-assistant-chat', 30)
      else assertFreshMiniSessionBeforeExecution(req, userId)
      const context = { userId: guest ? '' : userId, persistTrace }
      const result = await Promise.race([
        assistantService.chat(resultDb, resultBody, context),
        timeoutAfter(ASSISTANT_CHAT_FALLBACK_TIMEOUT_MS, 'ASSISTANT_CHAT_TIMEOUT')
      ]).catch((error) => {
        if (error && error.code === 'ASSISTANT_CHAT_TIMEOUT') {
          return assistantService.fallbackChat(resultDb, resultBody, context, {
            code: 'assistant_chat_timeout',
            reason: error.message
          })
        }
        throw error
      })
      if (!guest) assertFreshMiniSession(req, userId)
      console.log(`[assistant-chat] status=200 durationMs=${Date.now() - startedAt} guest=${guest} degraded=${Boolean(result && result.degraded)}`)
      return sendPublicListingJson(res, db, result)
    } catch (error) {
      console.log(`[assistant-chat] status=${error.statusCode || 500} durationMs=${Date.now() - startedAt} guest=${guest} error=${safeLogError(error)}`)
      throw error
    }
  }

  if (method === 'POST' && pathname === '/mini/asr/transcribe') {
    if (isGuestUser(userId)) assertGuestRateLimit(req, 'mini-asr-transcribe', 20)
    const form = await parseMultipartForm(req, { maxBytes: asrService.MAX_AUDIO_BYTES })
    if (!isGuestUser(userId)) assertFreshMiniSession(req, userId)
    const file = (form.files || []).find((item) => item.name === 'file' || item.name === 'audio') || form.file
    return sendJson(res, await asrService.transcribeAudio(db, file, {
      fields: form.fields || {},
      userId
    }))
  }

  if (method === 'POST' && pathname === '/mini/assistant/feedback') {
    const body = await parseBody(req)
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-assistant-feedback', 30)
      return sendJson(res, dbStore.updateDb((nextDb) => assistantService.feedback(nextDb, body, { userId: '' })))
    }
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => (
      assistantService.feedback(nextDb, body, { userId: freshUserId })
    )))
  }

  if (method === 'GET' && pathname === '/mini/map/communities') {
    const filter = mapQueryFilter(searchParams)
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-map-communities')
      return sendJson(res, domain.mapCommunities(db, guestListingFilter(filter)))
    }
    return sendJson(res, domain.mapCommunities(db, filter))
  }

  if (method === 'GET' && pathname === '/mini/map/pins') {
    const filter = mapQueryFilter(searchParams)
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-map-pins')
      return sendJson(res, domain.mapPins(db, guestListingFilter(filter)))
    }
    return sendJson(res, domain.mapPins(db, filter))
  }

  if (method === 'GET' && pathname === '/mini/favorites/ids') {
    assertMiniLogin(userId)
    return sendJson(res, domain.favoriteListingIds(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/favorites') {
    assertMiniLogin(userId)
    const filter = {
      category: searchParams.get('category') || '',
      district: searchParams.get('district') || '',
      area: searchParams.get('area') || '',
      block: searchParams.get('block') || '',
      community: searchParams.get('community') || '',
      layout: searchParams.get('layout') || '',
      rentMode: searchParams.get('rentMode') || '',
      rentMin: searchParams.get('rentMin') || '',
      rentMax: searchParams.get('rentMax') || '',
      features: searchParams.get('features') || '',
      availability: searchParams.get('availability') || ''
    }
    return sendPublicListingJson(res, db, domain.favoriteListings(db, userId, filter))
  }

  const favoriteMatch = pathname.match(/^\/mini\/favorites\/([^/]+)$/)
  if (method === 'PUT' && favoriteMatch) {
    assertMiniLogin(userId)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => {
      return domain.favoriteListing(nextDb, freshUserId, favoriteMatch[1])
    }))
  }

  if (method === 'DELETE' && favoriteMatch) {
    assertMiniLogin(userId)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => {
      return domain.unfavoriteListing(nextDb, freshUserId, favoriteMatch[1])
    }))
  }

  if (method === 'GET' && pathname === '/mini/footprints') {
    assertMiniLogin(userId)
    return sendJson(res, readMiniFootprintsWithLockedPrune(req, db, userId, (sourceDb, freshUserId) => (
      domain.footprintRecords(sourceDb, freshUserId)
    )))
  }

  if (method === 'GET' && pathname === '/mini/rental-needs') {
    assertMiniLogin(userId)
    return sendJson(res, domain.userRentalNeeds(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/rental-needs') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.createRentalNeed(nextDb, freshUserId, body)))
  }

  if (method === 'GET' && pathname === '/mini/my/listings') {
    assertMiniLogin(userId)
    return sendOwnedListingJson(res, db, domain.ownedListings(db, userId), userId)
  }

  const myListingEditMatch = pathname.match(/^\/mini\/my\/listings\/([^/]+)$/)
  if (method === 'GET' && myListingEditMatch) {
    assertMiniLogin(userId)
    return sendJson(res, withSignedVideoUrl(domain.editableListingDetail(db, userId, myListingEditMatch[1])))
  }

  if (method === 'PUT' && myListingEditMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, withSignedVideoUrl(updateMiniDb(req, (nextDb, freshUserId) => (
      domain.updateNormalListing(
        nextDb,
        freshUserId,
        myListingEditMatch[1],
        validatedListingVideoBody(
          body,
          freshUserId,
          (nextDb.listings || []).find((item) => String(item.id || '') === myListingEditMatch[1]) || null
        )
      )
    ))))
  }

  const myListingVerifyMatch = pathname.match(/^\/mini\/my\/listings\/([^/]+)\/verify$/)
  if (method === 'POST' && myListingVerifyMatch) {
    assertMiniLogin(userId)
    const verifyBody = await parseBody(req)
    const verifiedListings = updateMiniDb(req, (nextDb, freshUserId) => {
      // outcome: 未出租=已维护；已出租/不租了=下架进后台资产池。缺省兼容旧客户端=已维护。
      domain.submitListingVerification(nextDb, freshUserId, myListingVerifyMatch[1], verifyBody && verifyBody.outcome)
      return domain.ownedListings(nextDb, freshUserId)
    })
    return sendOwnedListingJson(res, readDbForRequest(), verifiedListings, userId)
  }

  if (method === 'GET' && pathname === '/mini/profile') {
    assertMiniLogin(userId)
    return sendJson(res, domain.profileState(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/today-tasks') {
    assertMiniLogin(userId)
    return sendJson(res, domain.todayTasks(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/commissions') {
    assertMiniLogin(userId)
    return sendJson(res, domain.userCommissionRows(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/reports') {
    assertMiniLogin(userId)
    return sendJson(res, domain.userReportRows(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/deals') {
    assertMiniLogin(userId)
    return sendJson(res, domain.userDealRows(db, userId))
  }

  // 第一版历史接口拦截：开启 V1_DISABLE_LEGACY_ROUTES 后，积分/房源群等历史能力统一下线
  const legacyMiniRoute =
    pathname === '/mini/points/recharge' ||
    pathname === '/mini/groups' ||
    /^\/mini\/groups\//.test(pathname) ||
    pathname === '/mini/uploads/group-screenshot-policy'
  if (config.disableLegacyRoutes && legacyMiniRoute) {
    const legacyError = new Error('该历史功能已在第一版下线')
    legacyError.statusCode = 404
    return sendError(res, legacyError)
  }

  if (method === 'POST' && pathname === '/mini/points/recharge') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    const count = Math.max(1, Math.floor(Number(body.points) || 1))
    const amount = count * 20
    const billId = `RC${Date.now()}`
    if (!config.wechatPay.enabled) {
      return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => {
        const bill = domain.createRechargeBill(nextDb, freshUserId, {
          id: billId,
          outTradeNo: billId,
          points: count,
          amount,
          status: '待确认',
          paymentMethod: '后台人工确认',
          time: '刚刚'
        })
        return {
          profile: domain.profileState(nextDb, freshUserId),
          bill,
          paymentMode: config.rechargePaymentMode || 'manual',
          message: '充值申请已提交，管理员确认到账后积分生效'
        }
      }))
    }
    const paymentIdentity = updateMiniDb(req, (nextDb, freshUserId) => {
      const user = (nextDb.users || []).find((item) => item.id === freshUserId) || {}
      return { userId: freshUserId, openid: user.openid || user.openId || config.wechatPay.testOpenid }
    })
    const payOrder = await wxpay.createJsapiOrder({
      outTradeNo: billId,
      amountFen: amount * 100,
      description: `寓你住一起积分充值${count}分`,
      // 支付身份只取验签账号在服务端绑定的 openid；忽略客户端 body.openid。
      openid: paymentIdentity.openid
    })
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => {
      const bill = domain.createRechargeBill(nextDb, freshUserId, {
        id: billId,
        outTradeNo: billId,
        points: count,
        amount,
        status: '待支付',
        paymentMethod: '微信支付',
        prepayId: payOrder.prepayId
      })
      return {
        profile: domain.profileState(nextDb, freshUserId),
        bill,
        payment: payOrder.paymentParams
      }
    }))
  }

  if (method === 'GET' && pathname === '/mini/groups') {
    assertMiniLogin(userId)
    return sendJson(res, domain.groupState(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/groups/listings') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.uploadGroupListing(nextDb, freshUserId, body)))
  }

  const unlockMatch = pathname.match(/^\/mini\/groups\/([^/]+)\/unlock$/)
  if (method === 'POST' && unlockMatch) {
    assertMiniLogin(userId)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.unlockGroup(nextDb, freshUserId, unlockMatch[1])))
  }

  if (method === 'POST' && pathname === '/mini/uploads/video-policy') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    assertFreshMiniSession(req, userId)
    return sendJson(res, withVideoUploadTicket(oss.createVideoUploadPolicy(clientUploadPolicyInput(body)), userId))
  }

  if (method === 'POST' && pathname === '/mini/uploads/group-screenshot-policy') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    assertFreshMiniSession(req, userId)
    return sendJson(res, oss.createGroupScreenshotUploadPolicy(clientUploadPolicyInput(body)))
  }

  if (method === 'POST' && pathname === '/mini/uploads/showing-photo-policy') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    assertFreshMiniSession(req, userId)
    return sendJson(res, oss.createShowingPhotoUploadPolicy(clientUploadPolicyInput(body)))
  }

  if (method === 'POST' && pathname === '/mini/listings') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => (
      domain.addNormalListing(nextDb, freshUserId, validatedListingVideoBody(body, freshUserId))
    )))
  }

  const nearbyListingMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/nearby$/)
  if (method === 'GET' && nearbyListingMatch) {
    const listingId = nearbyListingMatch[1]
    const guest = isGuestUser(userId)
    if (guest) assertGuestRateLimit(req, 'mini-listing-nearby')
    const detailState = domain.listingDetailState(db, listingId, userId)
    if (detailState.status === 'not-found') {
      const error = new Error('房源不存在')
      error.statusCode = 404
      throw error
    }
    if (detailState.status === 'unavailable') {
      if (guest && !domain.isCompanyListing(detailState.listing)) {
        const error = new Error('房源不存在')
        error.statusCode = 404
        throw error
      }
      return sendPublicListingJson(res, db, domain.nearbyListings(db, listingId))
    }
    return sendPublicListingJson(res, db, domain.nearbyListings(db, listingId, {
      all: searchParams.get('all') === '1',
      publicGuest: guest
    }))
  }

  const listingMatch = pathname.match(/^\/mini\/listings\/([^/]+)$/)
  if (method === 'GET' && listingMatch) {
    const listingId = listingMatch[1]
    const guest = isGuestUser(userId)
    if (guest) assertGuestRateLimit(req, 'mini-listing-detail')
    const detailState = domain.listingDetailState(db, listingId, userId)
    if (detailState.status === 'not-found') {
      logListingDetailState(listingId, detailState, searchParams.get('queryId') || searchParams.get('traceId') || '')
      const error = new Error('房源不存在')
      error.statusCode = 404
      throw error
    }
    if (detailState.status === 'unavailable') {
      if (guest && !domain.isCompanyListing(detailState.listing)) {
        const error = new Error('房源不存在')
        error.statusCode = 404
        throw error
      }
      logListingDetailState(listingId, detailState, searchParams.get('queryId') || searchParams.get('traceId') || '')
      return sendJson(res, detailState.unavailable)
    }
    const detail = detailState.detail
    // 标记是否为上传人自查（服务端判定），供详情页免留痕直接展示地址/房东电话。
    detail.ownListing = domain.isOwnListing(db, listingId, userId)
    // 附近预览随详情一次返回，最多 6 条；游客与登录用户都使用完整的前台有效池，
    // 但游客拿到的详情、附近卡片和地图点位始终是服务端公共白名单投影。
    detail.nearby = domain.nearbyListings(db, listingId, { publicGuest: guest })
    return sendPublicListingJson(res, db, detail)
  }

  const listingLogsMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/footprints$/)
  if (method === 'GET' && listingLogsMatch) {
    assertMiniLogin(userId)
    return sendJson(res, readMiniFootprintsWithLockedPrune(req, db, userId, (sourceDb, freshUserId) => (
      domain.listingLogs(sourceDb, listingLogsMatch[1], freshUserId)
    )))
  }

  const videoShareMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/video-share$/)
  if (method === 'POST' && videoShareMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.recordVideoShare(nextDb, freshUserId, videoShareMatch[1], {
      channel: body.channel,
      target: body.target,
      purpose: body.purpose,
      needId: body.needId,
      rentalNeedId: body.rentalNeedId,
      sharePath: body.sharePath,
      shareTitle: body.shareTitle
    })))
  }

  const reportMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/reports$/)
  if (method === 'POST' && reportMatch) {
    assertMiniLogin(userId)
    assertReportDealWritesEnabled()
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.createClientReport(nextDb, freshUserId, reportMatch[1], body)))
  }

  const reportDealMatch = pathname.match(/^\/mini\/reports\/([^/]+)\/deals$/)
  if (method === 'POST' && reportDealMatch) {
    assertMiniLogin(userId)
    assertReportDealWritesEnabled()
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.createDealFromReport(nextDb, freshUserId, reportDealMatch[1], body)))
  }

  const showingMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/showings$/)
  if (method === 'POST' && showingMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.recordShowing(nextDb, freshUserId, showingMatch[1], body)))
  }

  const dealMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/deals$/)
  if (method === 'POST' && dealMatch) {
    assertMiniLogin(userId)
    assertReportDealWritesEnabled()
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.registerDeal(nextDb, freshUserId, dealMatch[1])))
  }

  const sensitiveMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/sensitive-view$/)
  if (method === 'POST' && sensitiveMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.addSensitiveFootprint(nextDb, freshUserId, sensitiveMatch[1], {
      idempotencyKey: body.idempotencyKey
    })))
  }

  const phoneCallOpenedMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/phone-call-opened$/)
  if (method === 'POST' && phoneCallOpenedMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, updateMiniDb(req, (nextDb, freshUserId) => domain.recordPhoneCallOpened(
      nextDb,
      freshUserId,
      phoneCallOpenedMatch[1],
      { idempotencyKey: body.idempotencyKey }
    )))
  }

  const error = new Error(`接口不存在：${method} ${pathname}`)
  error.statusCode = 404
  throw error
}

async function handleAdmin(req, res, pathname, searchParams) {
  const method = req.method
  const db = readDbForRequest()

  if (method === 'POST' && pathname === '/admin/auth/login') {
    // 登录是唯一免鉴权入口。按客户端 IP 限流，防止对后台口令（含内置默认账号）无限暴力破解。
    // requestClientKey 在可信代理下取 XFF 末段，客户端无法伪造。
    assertGuestRateLimit(req, 'admin-login', 10)
    const body = await parseBody(req)
    const account = String(body.account || '').trim()
    const password = String(body.password || '')
    const accounts = db.adminAccounts || defaultAdminAccounts(db)
    const admin = accounts.find((item) => item.account === account && adminPasswordMatches(item, password) && item.status !== '禁用' && !item.deleted)
    if (!admin) {
      const error = new Error('账号或密码错误，或无管理员权限')
      error.statusCode = 403
      throw error
    }
    const token = signAdminPayload({
      id: admin.id,
      account: admin.account,
      userId: admin.userId,
      exp: Date.now() + 8 * 60 * 60 * 1000
    })
    return sendJson(res, {
      token,
      admin: publicAdminAccount(admin)
    })
  }

  const adminAccount = assertAdminRequest(req, db)

  if (method === 'GET' && pathname === '/admin/auth/me') {
    return sendJson(res, { ...publicAdminAccount(adminAccount), isSuperAdmin: isSuperAdmin(adminAccount) })
  }

  if (method === 'GET' && pathname === '/admin/dashboard') {
    return sendJson(res, domain.dashboardSummary(db))
  }
  if (method === 'GET' && pathname === '/admin/listing-maintenance-rule') {
    return sendJson(res, domain.listingMaintenanceRule(db))
  }
  if (method === 'PUT' && pathname === '/admin/listing-maintenance-rule') {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => (
      domain.setListingMaintenanceRule(nextDb, adminAccount.userId || adminAccount.id, body)
    )))
  }
  if (method === 'GET' && pathname === '/admin/commission-config') {
    // 分佣配置只允许超级管理员查看（PUT 已有超管门）；中介端读取走 /mini/commission-config，不受此门影响。
    assertAdminCapability(adminAccount)
    return sendJson(res, domain.commissionConfig(db))
  }
  if (method === 'PUT' && pathname === '/admin/commission-config') {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    // 资损向高危写：读 body 期间发起管理员可能被降权/禁用，必须在写锁内用最新数据库重新核验超管身份，
    // 并以复验后的身份作为 updatedBy，避免已失权账号越过锁外快照改动全站分佣。
    return sendJson(res, updateAdminDb(req, (nextDb, freshAccount) => (
      domain.setCommissionConfig(nextDb, freshAccount.userId || freshAccount.id, body)
    )))
  }
  if (method === 'GET' && pathname === '/admin/launch-check') {
    assertAdminCapability(adminAccount)
    return sendJson(res, buildLaunchCheck(db))
  }
  if (method === 'GET' && pathname === '/admin/assistant/feedbacks') {
    assertAdminCapability(adminAccount)
    return sendJson(res, assistantService.feedbackRows(db, {
      status: searchParams.get('status') || '',
      feedbackType: searchParams.get('feedbackType') || searchParams.get('type') || '',
      limit: searchParams.get('limit') || ''
    }))
  }
  if (method === 'GET' && pathname === '/admin/assistant/eval-cases') {
    assertAdminCapability(adminAccount)
    return sendJson(res, assistantService.evalCaseRows(db, {
      status: searchParams.get('status') || '',
      limit: searchParams.get('limit') || ''
    }))
  }
  if (method === 'GET' && pathname === '/admin/assistant/traces') {
    assertAdminCapability(adminAccount)
    return sendJson(res, assistantService.traceRows(db, {
      threadId: searchParams.get('threadId') || '',
      intent: searchParams.get('intent') || '',
      limit: searchParams.get('limit') || ''
    }))
  }
  const assistantFeedbackConversationMatch = pathname.match(/^\/admin\/assistant\/feedbacks\/([^/]+)\/conversation$/)
  if (method === 'GET' && assistantFeedbackConversationMatch) {
    assertAdminCapability(adminAccount)
    return sendJson(res, buildFeedbackConversation(db, assistantFeedbackConversationMatch[1]))
  }
  const assistantFeedbackReviewMatch = pathname.match(/^\/admin\/assistant\/feedbacks\/([^/]+)\/review$/)
  if (method === 'POST' && assistantFeedbackReviewMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => (
      assistantService.reviewFeedback(nextDb, assistantFeedbackReviewMatch[1], body, {
        userId: adminAccount.userId || adminAccount.id
      })
    )))
  }
  const assistantFeedbackEvalMatch = pathname.match(/^\/admin\/assistant\/feedbacks\/([^/]+)\/promote-eval$/)
  if (method === 'POST' && assistantFeedbackEvalMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => (
      assistantService.promoteFeedbackToEvalCase(nextDb, assistantFeedbackEvalMatch[1], body, {
        userId: adminAccount.userId || adminAccount.id
      })
    )))
  }
  if (method === 'GET' && pathname === '/admin/env-template') {
    assertAdminCapability(adminAccount)
    return sendJson(res, {
      template: buildMissingEnvTemplate(db)
    })
  }
  if (method === 'GET' && pathname === '/admin/feishu-sync/status') {
    assertAdminCapability(adminAccount)
    return sendJson(res, feishuSync.status(db))
  }
  if (method === 'POST' && pathname === '/admin/feishu-sync/run') {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    if (body.dryRun) {
      const previewDb = dbStore.clone(db)
      const result = await feishuSync.sync(previewDb, adminAccount.userId || adminAccount.id, {
        ...body,
        dryRun: true
      })
      return sendJson(res, {
        result,
        status: feishuSync.status(previewDb)
      })
    }
    // 与定时同步共用互斥锁：两条全量同步（定时/手动）并发会各自 clone 基线、先后落盘互相覆盖。
    if (feishuSyncRunning) {
      const busy = new Error('已有飞书同步任务进行中，请稍候再试')
      busy.statusCode = 409
      throw busy
    }
    feishuSyncRunning = true
    try {
      // clone 私有副本 + commitDelta 增量回写：见 runScheduledFeishuSync 注释。
      const baseSnapshot = dbStore.clone(dbStore.readDb())
      const nextDb = dbStore.clone(baseSnapshot)
      const result = await feishuSync.sync(nextDb, adminAccount.userId || adminAccount.id, body)
      dbStore.commitDelta(baseSnapshot, nextDb)
      return sendJson(res, {
        result,
        status: feishuSync.status(nextDb)
      })
    } finally {
      feishuSyncRunning = false
    }
  }
  if (method === 'GET' && pathname === '/admin/listings') {
    return sendJson(res, withSignedListingVideoUrls(domain.adminListings(db, {
      area: searchParams.get('area') || '',
      block: searchParams.get('block') || '',
      community: searchParams.get('community') || '',
      source: searchParams.get('source') || '',
      status: searchParams.get('status') || '',
      missingVideoMaterial: searchParams.get('missingVideoMaterial') || searchParams.get('videoMaterialStatus') || ''
    })))
  }
  if (method === 'GET' && pathname === '/admin/expired-listings') {
    return sendJson(res, withSignedListingVideoUrls(domain.expiredListings(db, {
      area: searchParams.get('area') || '',
      block: searchParams.get('block') || '',
      community: searchParams.get('community') || '',
      source: searchParams.get('source') || ''
    })))
  }
  const adminVideoPreviewMatch = pathname.match(/^\/admin\/listings\/([^/]+)\/video-compatible-preview$/)
  if (method === 'GET' && adminVideoPreviewMatch) {
    let listingId = ''
    try {
      listingId = decodeURIComponent(adminVideoPreviewMatch[1])
    } catch (error) {
      const invalidIdError = new Error('房源编号无效')
      invalidIdError.statusCode = 400
      throw invalidIdError
    }
    const listing = (db.listings || []).find((item) => (
      item && !item.deleted && String(item.id) === listingId
    ))
    if (!listing || !adminVideoPreview.isManagedVideoObjectKey(listing.videoKey)) {
      const error = new Error('房源没有可生成兼容预览的视频')
      error.statusCode = 404
      throw error
    }
    // 源对象只取服务端持久、且仍符合受控上传目录规则的 videoKey；不接受客户端 URL/Key。
    return adminVideoPreview.streamCompatiblePreview({
      request: req,
      response: res,
      objectKey: listing.videoKey
    })
  }
  const adminExpiredRestoreMatch = pathname.match(/^\/admin\/expired-listings\/([^/]+)\/restore$/)
  if (method === 'POST' && adminExpiredRestoreMatch) {
    assertAdminCapability(adminAccount)
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      domain.restoreExpiredListing(nextDb, freshAdminAccount.userId || freshAdminAccount.id, adminExpiredRestoreMatch[1])
      return withSignedListingVideoUrls(domain.expiredListings(nextDb, {
        area: searchParams.get('area') || '',
        block: searchParams.get('block') || '',
        community: searchParams.get('community') || ''
      }))
    }))
  }
  const adminListingEditMatch = pathname.match(/^\/admin\/listings\/([^/]+)$/)
  if (method === 'PUT' && adminListingEditMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.updateNormalListing(
      nextDb,
      adminAccount.userId || adminAccount.id,
      adminListingEditMatch[1],
      validatedListingVideoBody(
        body,
        adminAccount.userId || adminAccount.id,
        (nextDb.listings || []).find((item) => String(item.id || '') === adminListingEditMatch[1]) || null
      ),
      { admin: true }
    )))
  }
  const adminListingCoordinateMatch = pathname.match(/^\/admin\/listings\/([^/]+)\/coordinate$/)
  if (method === 'POST' && adminListingCoordinateMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => {
      domain.updateListingCoordinate(nextDb, adminAccount.userId || adminAccount.id, adminListingCoordinateMatch[1], body)
      return withSignedListingVideoUrls(domain.adminListings(nextDb, {
        area: searchParams.get('area') || '',
        block: searchParams.get('block') || '',
        community: searchParams.get('community') || ''
      }))
    }))
  }
  if (method === 'GET' && pathname === '/admin/map-config') {
    assertAdminCapability(adminAccount)
    // 坐标点选地图配置：JS-API key（前端加载地图 SDK 用）+ 默认初始中心（东新园地铁口）。
    // 只暴露 jsApiKey（域名白名单限制的公开 key），绝不下发 webserviceKey。
    return sendJson(res, {
      jsApiKey: (config.qqMap && config.qqMap.jsApiKey) || '',
      defaultCenter: (config.qqMap && config.qqMap.defaultMapCenter) || { latitude: 30.306628, longitude: 120.173407, label: '拱墅区5号线东新园地铁口' }
    })
  }
  const adminListingVerifyMatch = pathname.match(/^\/admin\/listings\/([^/]+)\/verify$/)
  if (method === 'POST' && adminListingVerifyMatch) {
    assertAdminCapability(adminAccount)
    return sendJson(res, dbStore.updateDb((nextDb) => {
      domain.verifyListingAvailability(nextDb, adminAccount.userId || adminAccount.id, adminListingVerifyMatch[1], { admin: true })
      return withSignedListingVideoUrls(domain.adminListings(nextDb, {
        area: searchParams.get('area') || '',
        block: searchParams.get('block') || '',
        community: searchParams.get('community') || ''
      }))
    }))
  }
  const adminListingReviewMatch = pathname.match(/^\/admin\/listings\/([^/]+)\/review$/)
  if (method === 'POST' && adminListingReviewMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => (
      withSignedListingVideoUrls(domain.reviewOwnerListing(nextDb, adminAccount.userId || adminAccount.id, adminListingReviewMatch[1], body))
    )))
  }
  if (method === 'GET' && pathname === '/admin/footprints') {
    return sendJson(res, readFootprintsWithLockedPrune(db, (sourceDb) => (
      filterAdminFootprints(domain.adminLogs(sourceDb), searchParams)
    )))
  }
  if (method === 'GET' && pathname === '/admin/commissions') {
    return sendJson(res, domain.commissionRows(db))
  }
  if (method === 'GET' && pathname === '/admin/reports') {
    return sendJson(res, domain.adminReportRows(db))
  }
  if (method === 'GET' && pathname === '/admin/deals') {
    return sendJson(res, domain.adminDealRows(db))
  }
  const adminDealConfirmMatch = pathname.match(/^\/admin\/deals\/([^/]+)\/confirm$/)
  if (method === 'POST' && adminDealConfirmMatch) {
    assertAdminCapability(adminAccount)
    assertReportDealWritesEnabled()
    return sendJson(res, dbStore.updateDb((nextDb) => (
      domain.confirmDeal(nextDb, adminAccount.userId || adminAccount.id, adminDealConfirmMatch[1])
    )))
  }
  if (method === 'GET' && pathname === '/admin/groups/uploads') {
    return sendJson(res, withSignedScreenshotUrls(domain.groupUploadRows(db)))
  }
  if (method === 'GET' && pathname === '/admin/showings') {
    return sendJson(res, withSignedShowingPhotoUrls(domain.showingUploadRows(db)))
  }
  const showingReviewMatch = pathname.match(/^\/admin\/showings\/([^/]+)\/review$/)
  if (method === 'POST' && showingReviewMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, withSignedShowingPhotoUrls(dbStore.updateDb((nextDb) => domain.reviewShowingUpload(nextDb, adminAccount.userId || adminAccount.id, showingReviewMatch[1], body))))
  }
  const groupReviewMatch = pathname.match(/^\/admin\/groups\/uploads\/([^/]+)\/review$/)
  if (method === 'POST' && groupReviewMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, withSignedScreenshotUrls(dbStore.updateDb((nextDb) => domain.reviewGroupUpload(nextDb, adminAccount.userId || adminAccount.id, groupReviewMatch[1], body))))
  }
  if (method === 'GET' && pathname === '/admin/points') {
    return sendJson(res, domain.pointLogs(db))
  }
  if (method === 'GET' && pathname === '/admin/recharges') {
    return sendJson(res, domain.rechargeBills(db))
  }
  const rechargeReviewMatch = pathname.match(/^\/admin\/recharges\/([^/]+)\/review$/)
  if (method === 'POST' && rechargeReviewMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.reviewRechargeBill(nextDb, adminAccount.userId || adminAccount.id, rechargeReviewMatch[1], body)))
  }
  const rechargeSyncMatch = pathname.match(/^\/admin\/recharges\/([^/]+)\/sync$/)
  if (method === 'POST' && rechargeSyncMatch) {
    assertAdminCapability(adminAccount)
    const bill = (db.rechargeBills || []).find((item) => item.id === rechargeSyncMatch[1] || item.outTradeNo === rechargeSyncMatch[1])
    if (!bill) {
      const error = new Error('未找到充值账单')
      error.statusCode = 404
      throw error
    }
    if (String(bill.paymentMethod || '').indexOf('微信') === -1) {
      return sendJson(res, {
        message: '人工确认充值无需同步微信支付',
        bill,
        rows: domain.rechargeBills(db)
      })
    }
    const transaction = await wxpay.queryJsapiOrder(bill.outTradeNo || bill.id)
    return sendJson(res, dbStore.updateDb((nextDb) => {
      const syncedBill = domain.syncWechatRechargeBill(nextDb, rechargeSyncMatch[1], transaction)
      return {
        message: '已同步微信支付订单状态',
        bill: syncedBill,
        transaction,
        rows: domain.rechargeBills(nextDb)
      }
    }))
  }
  if (method === 'GET' && pathname === '/admin/users') {
    // users 列表保持对所有已登录管理员开放（smoke-test、带看审核额度核对等依赖）；admins 账号清单
    // 属敏感，仅超级管理员可见，普通管理员拿到空数组（账号管理页对普通管理员本就隐藏）。
    return sendJson(res, {
      users: domain.adminUsers(db),
      admins: isSuperAdmin(adminAccount)
        ? (db.adminAccounts || defaultAdminAccounts(db)).filter((item) => !item.deleted).map(publicAdminAccount)
        : []
    })
  }
  if (method === 'GET' && pathname === '/admin/data/export') {
    assertAdminCapability(adminAccount)
    const date = new Date().toISOString().slice(0, 10)
    return sendJsonDownload(res, `ynzy-backup-${date}.json`, db)
  }
  if (method === 'GET' && pathname === '/admin/backup/status') {
    assertAdminCapability(adminAccount)
    return sendJson(res, buildBackupStatus())
  }
  if (method === 'GET' && pathname === '/admin/accounts') {
    assertAdminCapability(adminAccount)
    return sendJson(res, {
      users: domain.adminUsers(db),
      admins: (db.adminAccounts || defaultAdminAccounts(db)).filter((item) => !item.deleted).map(publicAdminAccount)
    })
  }
  if (method === 'POST' && pathname === '/admin/accounts') {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    const accountName = String(body.account || '').trim()
    const password = String(body.password || '').trim()
    if (!/^[a-zA-Z0-9_-]{3,24}$/.test(accountName)) {
      const error = new Error('后台账号需为 3-24 位字母、数字、下划线或横线')
      error.statusCode = 400
      throw error
    }
    if (password.length < 8) {
      const error = new Error('管理员密码至少 8 位')
      error.statusCode = 400
      throw error
    }
    if (new Set(['admin123', 'manager123']).has(password)) {
      const error = new Error('不能使用内测默认密码')
      error.statusCode = 400
      throw error
    }
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      nextDb.adminAccounts = nextDb.adminAccounts || defaultAdminAccounts(nextDb)
      if (nextDb.adminAccounts.some((item) => item.account === accountName)) {
        const error = new Error('后台账号已存在')
        error.statusCode = 400
        throw error
      }
      const user = (nextDb.users || []).find((item) => item.id === body.userId)
      const passwordHash = hashPassword(password)
      const account = {
        id: `A${Date.now()}`,
        account: accountName,
        passwordHash,
        name: String(body.name || (user && user.name) || accountName).trim(),
        userId: body.userId || (user && user.id) || '',
        permission: body.permission || '后台查看权限',
        status: '启用',
        createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
      }
      nextDb.adminAccounts.unshift(account)
      const miniLoginSynced = domain.syncLinkedAdminUserPasswordHash(
        nextDb,
        account,
        passwordHash,
        freshAdminAccount.id || freshAdminAccount.account
      )
      return {
        miniLoginSynced,
        users: domain.adminUsers(nextDb),
        admins: nextDb.adminAccounts.filter((item) => !item.deleted).map(publicAdminAccount)
      }
    }))
  }
  const adminStatusMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/status$/)
  if (method === 'POST' && adminStatusMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    const action = body.action || body.status
    const nextStatus = action === 'disable' || action === 'disabled' || action === '禁用' ? '禁用' : '启用'
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      nextDb.adminAccounts = nextDb.adminAccounts || defaultAdminAccounts(nextDb)
      const account = nextDb.adminAccounts.find((item) => item.id === adminStatusMatch[1] || item.account === adminStatusMatch[1])
      if (!account) {
        const error = new Error('未找到管理员账号')
        error.statusCode = 404
        throw error
      }
      if (account.id === freshAdminAccount.id && nextStatus === '禁用') {
        const error = new Error('不能禁用当前登录账号')
        error.statusCode = 400
        throw error
      }
      account.status = nextStatus
      account.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      return {
        users: domain.adminUsers(nextDb),
        admins: nextDb.adminAccounts.filter((item) => !item.deleted).map(publicAdminAccount)
      }
    }))
  }
  const adminPasswordMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/password$/)
  if (method === 'POST' && adminPasswordMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    const nextPassword = String(body.password || '').trim()
    if (nextPassword.length < 8) {
      const error = new Error('管理员密码至少 8 位')
      error.statusCode = 400
      throw error
    }
    if (new Set(['admin123', 'manager123']).has(nextPassword)) {
      const error = new Error('不能继续使用内测默认密码')
      error.statusCode = 400
      throw error
    }
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      nextDb.adminAccounts = nextDb.adminAccounts || defaultAdminAccounts(nextDb)
      const account = nextDb.adminAccounts.find((item) => item.id === adminPasswordMatch[1] || item.account === adminPasswordMatch[1])
      if (!account) {
        const error = new Error('未找到管理员账号')
        error.statusCode = 404
        throw error
      }
      const passwordHash = hashPassword(nextPassword)
      account.passwordHash = passwordHash
      delete account.password
      account.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      const miniLoginSynced = domain.syncLinkedAdminUserPasswordHash(
        nextDb,
        account,
        passwordHash,
        freshAdminAccount.id || freshAdminAccount.account
      )
      return {
        miniLoginSynced,
        users: domain.adminUsers(nextDb),
        admins: nextDb.adminAccounts.filter((item) => !item.deleted).map(publicAdminAccount)
      }
    }))
  }
  const adminDeleteMatch = pathname.match(/^\/admin\/accounts\/([^/]+)$/)
  if (method === 'DELETE' && adminDeleteMatch) {
    assertAdminCapability(adminAccount)
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      nextDb.adminAccounts = nextDb.adminAccounts || defaultAdminAccounts(nextDb)
      const target = nextDb.adminAccounts.find((item) => (
        (item.id === adminDeleteMatch[1] || item.account === adminDeleteMatch[1]) && !item.deleted
      ))
      if (!target) {
        const error = new Error('未找到管理员账号')
        error.statusCode = 404
        throw error
      }
      // 红线①：不能删除当前登录账号（防误删自己 + 防自锁）。
      if (target.id === freshAdminAccount.id) {
        const error = new Error('不能删除当前登录账号')
        error.statusCode = 400
        throw error
      }
      // 红线②：不能删到零个可用超级管理员（可用 = 未删除且未禁用）。
      const targetIsActiveSuper = target.status !== '禁用' && isSuperAdmin(target)
      const activeSuperCount = nextDb.adminAccounts.filter((item) => (
        !item.deleted && item.status !== '禁用' && isSuperAdmin(item)
      )).length
      if (targetIsActiveSuper && activeSuperCount <= 1) {
        const error = new Error('至少保留一个可用的超级管理员，不能删除最后一个')
        error.statusCode = 400
        throw error
      }
      // 软删归档：保留记录留痕（deletedAt/deletedBy），登录与列表都会排除已删除账号。
      target.deleted = true
      target.status = '已删除'
      target.deletedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      target.deletedBy = freshAdminAccount.account || freshAdminAccount.id
      return {
        users: domain.adminUsers(nextDb),
        admins: nextDb.adminAccounts.filter((item) => !item.deleted).map(publicAdminAccount)
      }
    }))
  }
  // ---------- 中介/员工账号（db.users）：后台创建 + 软删（需求1） ----------
  if (method === 'POST' && pathname === '/admin/users') {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      domain.createManagedUser(nextDb, {
        type: body.type,
        name: body.name,
        phone: body.phone,
        // 后台建号可给可选初始密码（domain 内校验强度并哈希）；不给则账号无密码、fail-closed 禁登，
        // 需管理员事后走 /admin/users/:id/password 设初始密码。
        password: body.password,
        operator: freshAdminAccount.account || freshAdminAccount.id
      })
      return {
        users: domain.adminUsers(nextDb),
        admins: (nextDb.adminAccounts || defaultAdminAccounts(nextDb)).filter((item) => !item.deleted).map(publicAdminAccount)
      }
    }))
  }
  const managedUserStatusMatch = pathname.match(/^\/admin\/users\/([^/]+)\/status$/)
  if (method === 'POST' && managedUserStatusMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      // 请求体读取期间管理员可能已被禁用或降权；真正写入前必须在同一写锁内重验最新账号，
      // 且审计操作者也必须取 fresh 记录，不能沿用请求开始时的客户端可竞态快照。
      domain.setManagedUserStatus(nextDb, {
        id: decodeURIComponent(managedUserStatusMatch[1]),
        action: body.action,
        operator: freshAdminAccount.account || freshAdminAccount.id
      })
      return {
        users: domain.adminUsers(nextDb),
        admins: (nextDb.adminAccounts || defaultAdminAccounts(nextDb)).filter((item) => !item.deleted).map(publicAdminAccount)
      }
    }))
  }
  // 后台设置/重置小程序用户（中介/员工）登录密码：仅超管（assertAdminCapability），存量/新建账号发初始密码。
  const managedUserPasswordMatch = pathname.match(/^\/admin\/users\/([^/]+)\/password$/)
  if (method === 'POST' && managedUserPasswordMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      domain.setManagedUserPassword(nextDb, {
        id: decodeURIComponent(managedUserPasswordMatch[1]),
        password: body.password,
        operator: freshAdminAccount.account || freshAdminAccount.id
      })
      return {
        users: domain.adminUsers(nextDb),
        admins: (nextDb.adminAccounts || defaultAdminAccounts(nextDb)).filter((item) => !item.deleted).map(publicAdminAccount)
      }
    }))
  }
  const managedUserDeleteMatch = pathname.match(/^\/admin\/users\/([^/]+)$/)
  if (method === 'DELETE' && managedUserDeleteMatch) {
    assertAdminCapability(adminAccount)
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      // 软删：禁止登录 + 列表隐藏，名下房源/成交/分佣历史数据保留（domain 层处理，无悬挂引用）。
      domain.deleteManagedUser(nextDb, {
        id: decodeURIComponent(managedUserDeleteMatch[1]),
        operator: freshAdminAccount.account || freshAdminAccount.id
      })
      return {
        users: domain.adminUsers(nextDb),
        admins: (nextDb.adminAccounts || defaultAdminAccounts(nextDb)).filter((item) => !item.deleted).map(publicAdminAccount)
      }
    }))
  }
  // ---------- 注册审核（需求2） ----------
  if (method === 'GET' && pathname === '/admin/registrations') {
    assertAdminCapability(adminAccount)
    return sendJson(res, { requests: domain.listRegistrationRequests(db) })
  }
  const registrationReviewMatch = pathname.match(/^\/admin\/registrations\/([^/]+)\/review$/)
  if (method === 'POST' && registrationReviewMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, updateAdminDb(req, (nextDb, freshAdminAccount) => {
      const result = domain.reviewRegistration(nextDb, {
        id: decodeURIComponent(registrationReviewMatch[1]),
        action: body.action,
        type: body.type,
        reason: body.reason,
        operator: freshAdminAccount.account || freshAdminAccount.id
      })
      return {
        request: result.request,
        requests: domain.listRegistrationRequests(nextDb),
        users: domain.adminUsers(nextDb)
      }
    }))
  }
  if (method === 'GET' && pathname === '/admin/llm-config') {
    assertAdminCapability(adminAccount)
    return sendJson(res, normalizeLlmConfig(db.llmConfig || {}))
  }
  if (method === 'PUT' && pathname === '/admin/llm-config') {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => saveLlmConfig(nextDb, body)))
  }
  if (method === 'POST' && pathname === '/admin/llm-config/test') {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    const tempDb = { ...db, llmConfig: { ...normalizeLlmConfig({ ...(db.llmConfig || {}), ...body }), enabled: body.enabled !== false } }
    return sendJson(res, await assistantService.chat(tempDb, {
      debugTrace: true,
      text: body.testText || '\u62f1\u5885\u4e07\u8fbe\u9644\u8fd1\u6709\u54ea\u4e9b2000\u5de6\u53f3\u7684\u5355\u95f4'
    }, {
      userId: adminAccount.userId || adminAccount.id,
      debugTrace: true
    }))
  }
  const error = new Error(`后台接口不存在：${method} ${pathname}`)
  error.statusCode = 404
  throw error
}

async function handleWechatPayNotify(req, res) {
  const rawBody = await parseRawBody(req)
  wxpay.verifyNotifySignature(req.headers, rawBody)
  const body = rawBody ? JSON.parse(rawBody) : {}
  const transaction = wxpay.decryptNotifyResource(body.resource || {})
  if (transaction.trade_state === 'SUCCESS') {
    dbStore.updateDb((nextDb) => {
      domain.markRechargePaid(nextDb, transaction.out_trade_no, transaction)
      return null
    })
  }
  sendWechatPayNotify(res, 'SUCCESS', '成功')
}

async function router(req, res) {
  // 请求链路日志放在最开头：确保所有进入应用的请求——含 OPTIONS 预检、以及畸形 URL 走 400 的分支——
  // 都能拿到 X-Trace-Id 响应头并打一行 [req] 日志。CORS 预检失败本身就是「前端报网络错、后端查无请求」
  // 的重要来源，若漏掉 OPTIONS，本功能的核心目标（对齐定位）就有缺口。
  const reqLog = requestLog.startRequestLog(req, res, { trustProxy: config.trustProxy })

  // URL 解析放在独立 try 内：畸形百分号转义（如 /%zz）会让 decodeURIComponent 抛
  // URIError，畸形 Host 头会让 new URL 抛 TypeError。逃逸到 async router 之外会变成
  // unhandledRejection 使进程退出（Node>=15 默认），任意游客一条 curl 即可打死服务。
  let url
  let pathname
  try {
    url = new URL(req.url, `http://${req.headers.host}`)
    pathname = decodeURIComponent(url.pathname)
    reqLog.path = pathname // 回填路径到链路日志（只记 pathname，不记 query，避免 PII）
  } catch (error) {
    error.statusCode = 400
    sendError(res, error)
    return
  }

  // OPTIONS 预检移到 URL 解析之后：此时 reqLog.path 已回填 pathname（仍不含 query/body），
  // 预检响应带 X-Trace-Id 头、finish 时打一行 [req] 日志，覆盖 CORS 定位场景。
  if (req.method === 'OPTIONS') {
    sendOptions(res)
    return
  }

  try {
    if (pathname === '/') {
      res.writeHead(302, { Location: '/admin-web/' })
      res.end()
      return
    }
    if (pathname === '/healthz') {
      sendJson(res, {
        ok: true,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        service: 'ynzy-house-miniapp',
        version: appVersion.getVersion() // 版本追溯：现网跑的是哪版代码，供 curl / 巡检直接看到
      })
      return
    }
    if (pathname === '/readyz') {
      const health = buildHealth(dbStore.readDb())
      sendJson(res, health, health.ok ? 200 : 503)
      return
    }
    if (pathname.startsWith('/admin-web')) {
      serveAdminWeb(req, res, pathname)
      return
    }
    if (pathname.startsWith('/utils/')) {
      serveUtilityScript(req, res, pathname)
      return
    }
    if (req.method === 'POST' && pathname === '/wechat/pay/notify') {
      await handleWechatPayNotify(req, res)
      return
    }
    if (pathname.startsWith('/mini/')) {
      await handleMini(req, res, pathname, url.searchParams)
      return
    }
    if (pathname.startsWith('/admin/')) {
      await handleAdmin(req, res, pathname, url.searchParams)
      return
    }

    const error = new Error(`路径不存在：${pathname}`)
    error.statusCode = 404
    throw error
  } catch (error) {
    // 流式媒体可能已发出 200/206 头后才发现上游少字节或连接中断。此时只能断开当前响应，
    // 绝不能再 sendError/writeHead，否则会触发 ERR_HTTP_HEADERS_SENT 并把单请求故障放大为进程异常。
    if (res.headersSent || res.destroyed) {
      if (!res.writableEnded) res.destroy()
      return
    }
    sendError(res, error)
  }
}

let feishuSyncRunning = false

async function runScheduledFeishuSync() {
  if (feishuSyncRunning) return
  const currentDb = dbStore.readDb()
  if (!feishuSync.status(currentDb).ready) return
  feishuSyncRunning = true
  try {
    // 在 clone 的私有副本上跑同步：baseSnapshot 是同步开始前的不可变基线，nextDb 是同步就地改动
    // 的私有副本，共享缓存对象在长 await 期间零写入。落盘用 commitDelta 只回写同步真正改动的键，
    // 保住 await 窗口内并发 updateDb 落盘的成交/反馈/留痕，避免整库回写把它们静默覆盖。
    const baseSnapshot = dbStore.clone(currentDb)
    const nextDb = dbStore.clone(baseSnapshot)
    await feishuSync.sync(nextDb, 'system-feishu-sync', { scheduled: true })
    dbStore.commitDelta(baseSnapshot, nextDb)
    console.log('飞书房源自动同步完成')
  } catch (error) {
    console.error(`飞书房源自动同步失败：${error.message}`)
  } finally {
    feishuSyncRunning = false
  }
}

function startFeishuSyncTimer() {
  const minutes = Number(config.feishu.syncIntervalMinutes || 0)
  if (!Number.isFinite(minutes) || minutes <= 0) return
  const interval = minutes * 60 * 1000
  setInterval(runScheduledFeishuSync, interval)
  console.log(`飞书房源自动同步已开启：每 ${minutes} 分钟执行一次`)
}

// 实时 ASR 升级鉴权：每条连接都用服务端密钥开一路付费 DashScope 上游。与 HTTP
// /mini/asr/transcribe 对齐——登录用户放行，游客按 IP 限流——避免未认证客户端白嫖付费
// 语音识别并放大成本/资源 DoS。无 token 的游客 miniUserIdFromRequest 返回 ''，无效/过期/
// 停用 token 抛错即拒绝升级。
function authorizeRealtimeAsrUpgrade(req) {
  try {
    const userId = dbStore.inspectDb((freshDb) => miniUserIdFromRequest(req, freshDb))
    if (!userId) assertGuestRateLimit(req, 'asr-realtime', 20)
    return true
  } catch (error) {
    return false
  }
}

const server = http.createServer(router)
asrRealtime.attachRealtimeAsr(server, {
  getDb: dbStore.readDb,
  authorizeUpgrade: authorizeRealtimeAsrUpgrade
})

// 游离的 Promise 拒绝：请求内的异步错误已被 router 的 try/catch 兜住并返回错误响应，逃逸到
// 这里的多是后台/游离 promise 拒绝；只记录不退出，避免个别良性拒绝触发整进程重启。
process.on('unhandledRejection', (reason) => {
  console.error(`未处理的 Promise 拒绝：${reason && reason.stack ? reason.stack : reason}`)
})
// 未捕获异常意味着进程状态未知，继续运行不安全（可能带着损坏的状态硬撑）。记录后优雅关闭并
// 退出，由 systemd（ynzy-miniapp.service，Restart=always/RestartSec=3）在数秒内拉起干净实例。
// 请求级错误已被 router 的 try/catch 兜住，不会到这里，故单个坏请求不会导致整进程重启。
let uncaughtShuttingDown = false
process.on('uncaughtException', (error) => {
  console.error(`未捕获异常，进程即将退出并由 systemd 拉起：${error && error.stack ? error.stack : error}`)
  if (uncaughtShuttingDown) return
  uncaughtShuttingDown = true
  try {
    server.close(() => process.exit(1))
  } catch (closeError) {
    process.exit(1)
  }
  // 兜底：server.close 迟迟不回调时强制退出，不阻塞 systemd 重启。
  setTimeout(() => process.exit(1), 3000).unref()
})

server.listen(config.port, config.host, () => {
  const v = appVersion.getVersion()
  console.log(`寓你住一起后端已启动：http://${config.host}:${config.port}`)
  console.log(`版本 ${v.version} commit ${v.shortCommit}${v.branch ? ` (${v.branch})` : ''} built ${v.builtAt || '-'} [来源 ${v.source}]`)
  console.log(`管理后台：http://${config.host}:${config.port}/admin-web/`)
  resumePendingRegistrationNotifications()
  startFeishuSyncTimer()
})
