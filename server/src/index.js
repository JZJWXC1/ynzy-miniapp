const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { URL } = require('url')
const config = require('./config')
const dbStore = require('./db')
const domain = require('./domain')
const feishuSync = require('./feishu-sync')
const llm = require('./llm')
const asrService = require('./asr-service')
const asrRealtime = require('./asr-realtime')
const assistantService = require('./assistant-service')
const oss = require('./oss')
const wxpay = require('./wxpay')
const { parseMultipartForm } = require('./multipart')

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
const MINI_AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
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
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  })
  res.end(JSON.stringify({ code: 0, message: 'ok', data }))
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  })
  res.end(JSON.stringify({ code: statusCode, message: error.message || '服务异常', data: error.data || null }))
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

function isGuestUser(userId) {
  return !String(userId || '').trim()
}

function guestListingFilter(filter = {}) {
  return {
    ...filter,
    category: COMPANY_SOURCE,
    sourceType: COMPANY_SOURCE,
    companyOnly: true
  }
}

function companyOnlyDb(db = {}) {
  return {
    ...db,
    listings: (db.listings || []).filter((listing) => domain.isCompanyListing(listing))
  }
}

function assertGuestListingAllowed(detail) {
  if (detail && detail.companyListing) return
  const error = new Error('游客仅可查看公司房源，请登录后查看合作房源')
  error.statusCode = 401
  throw error
}

function sheetCellText(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function findCompanySheetHeaderIndex(rows = []) {
  return rows.findIndex((row) => {
    const text = (row || []).map(sheetCellText).join('|')
    return /区域/.test(text) && /小区/.test(text)
  })
}

function sheetColumnIndex(header = [], aliases = []) {
  const normalizedHeader = header.map((cell) => sheetCellText(cell).replace(/\s+/g, ''))
  return aliases.reduce((matched, alias) => {
    if (matched !== -1) return matched
    const key = String(alias || '').replace(/\s+/g, '')
    return normalizedHeader.findIndex((cell) => cell === key || cell.indexOf(key) !== -1)
  }, -1)
}

function guestCompanySheetSnapshot(snapshot = {}) {
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  const headerIndex = findCompanySheetHeaderIndex(rows)
  if (headerIndex < 0) {
    return {
      ...snapshot,
      rows: [],
      rowCount: 0,
      columnCount: 0,
      guestSanitized: true
    }
  }

  const sourceHeader = rows[headerIndex] || []
  const columns = [
    { title: '区域', aliases: ['区域', '区', '片区', '商圈', 'district', 'area'] },
    { title: '小区', aliases: ['小区', '小区名称', '楼盘', '社区', 'community', 'sourceCommunity'] },
    { title: '户型描述', aliases: ['户型描述', '描述', '房源描述', '户型信息', '房源信息', '房源详情', 'layoutDescription', 'description'] },
    { title: '户型分类', aliases: ['户型分类', '户型', '格局', '分类', 'category', 'layoutCategory'] },
    { title: '押一付一', aliases: ['押一付一', '押一', '月租', '租金', '价格', 'rent', 'price'] },
    { title: '押二付一', aliases: ['押二付一', '押二', '押二付一价格', '押二价格'] }
  ].map((column) => ({
    ...column,
    index: sheetColumnIndex(sourceHeader, column.aliases)
  }))

  const sanitizedRows = [
    columns.map((column) => column.title),
    ...rows.slice(headerIndex + 1)
      .map((row) => columns.map((column) => (column.index >= 0 ? sheetCellText((row || [])[column.index]) : '')))
      .filter((row) => row.some(Boolean))
  ]

  return {
    ...snapshot,
    rows: sanitizedRows,
    rowCount: Math.max(0, sanitizedRows.length - 1),
    columnCount: columns.length,
    guestSanitized: true
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
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
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

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('base64url')
  return `scrypt$${salt}$${hash}`
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const expected = Buffer.from(parts[2], 'base64url')
  const actual = crypto.scryptSync(String(password), parts[1], expected.length)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

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

function issueMiniAuthToken(userId) {
  const tokenExpiresAt = Date.now() + MINI_AUTH_TOKEN_TTL_MS
  return {
    token: signMiniAuthPayload({ userId, exp: tokenExpiresAt }),
    tokenExpiresAt
  }
}

function miniAuthError(message = '登录已过期，请重新登录') {
  const error = new Error(message)
  error.statusCode = 401
  return error
}

function bearerTokenFromRequest(req) {
  const header = String((req.headers && req.headers.authorization) || '').trim()
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
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
  return { userId, exp }
}

function miniUserIdFromRequest(req, db) {
  const token = bearerTokenFromRequest(req)
  if (!token) return ''
  const payload = verifyMiniAuthToken(token)
  const user = (db.users || []).find((item) => item.id === payload.userId && item.status !== '禁用')
  if (!user) throw miniAuthError('登录用户不存在或已停用')
  return user.id
}

function miniAuthResponse(user) {
  const auth = issueMiniAuthToken(user.id)
  return {
    ...user,
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
  const account = accounts.find((item) => item.id === payload.id && item.status !== '禁用')
  if (!account) {
    const error = new Error('无管理员权限')
    error.statusCode = 403
    throw error
  }
  return account
}

function assertAdminCapability(account) {
  // 高危操作（创建/禁用管理员、整库导出）仅限“全部后台权限”账号。permission 字段原先从不参与
  // 鉴权，任何持有效 token 的受限账号（区域查看/后台查看）都能自我提权或导出全量数据。
  if (account && account.permission === '全部后台权限') return
  const error = new Error('当前管理员无权执行该操作')
  error.statusCode = 403
  throw error
}

function serveAdminWeb(req, res, pathname) {
  const relativePath = pathname === '/admin-web' || pathname === '/admin-web/' ? 'index.html' : pathname.replace('/admin-web/', '')
  const filePath = path.resolve(config.adminWebDir, relativePath)

  if (!filePath.startsWith(config.adminWebDir)) {
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

function buildLaunchCheck(db) {
  const accounts = db.adminAccounts || defaultAdminAccounts(db)
  const llmConfig = db.llmConfig || {}
  const llmSecretName = llmConfig.secretName || 'LLM_API_KEY'
  const asrStatus = asrService.configStatus(db)
  const defaultPasswords = new Set(['admin123', 'manager123'])
  const weakAdmins = accounts.filter((account) => account.password || defaultPasswords.has(String(account.password || '')))
  const ossMissing = []
  if (!config.oss.bucket) ossMissing.push('ALI_OSS_BUCKET')
  if (!config.oss.region) ossMissing.push('ALI_OSS_REGION')
  if (!config.oss.accessKeyId) ossMissing.push('ALI_OSS_ACCESS_KEY_ID')
  if (!config.oss.accessKeySecret) ossMissing.push('ALI_OSS_ACCESS_KEY_SECRET')
  if (!config.oss.publicBaseUrl) ossMissing.push('ALI_OSS_PUBLIC_BASE_URL')
  const wxPayMissing = config.wechatPay.enabled ? wxpay.requiredMissing() : []
  const feishuStatus = feishuSync.status(db)
  const miniProgram = config.miniProgram || {}
  const userCount = (db.users || []).length
  const listingCount = (db.listings || []).length
  const groupCount = (db.groups || []).length
  const baseStatus = userCount && groupCount ? (listingCount ? '通过' : '待确认') : '需处理'

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
      '微信合法域名',
      '待确认',
      `request ${miniProgram.requestDomain || '未配置'}；uploadFile ${miniProgram.uploadDomain || '未配置'}；downloadFile ${miniProgram.downloadDomain || '未配置'}`,
      '在微信小程序后台核对 request、uploadFile、downloadFile 合法域名与这里一致'
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
  const db = dbStore.readDb()
  const companyMigration = domain.migrateCompanyListings(db)
  const maintenance = domain.enforceListingMaintenanceRule(db)
  if (companyMigration.changed || maintenance.expiredCount > 0) {
    dbStore.writeDb(db)
  }
  return db
}

async function handleMini(req, res, pathname, searchParams) {
  const method = req.method
  const db = readDbForRequest()

  if (method === 'POST' && pathname === '/mini/auth/login') {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => miniAuthResponse(domain.loginByPhone(nextDb, body.phone))))
  }

  if (method === 'POST' && pathname === '/mini/auth/register') {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => miniAuthResponse(domain.registerUser(nextDb, body))))
  }

  const userId = miniUserIdFromRequest(req, db)

  if (method === 'GET' && pathname === '/mini/auth/me') {
    assertMiniLogin(userId)
    return sendJson(res, domain.currentUser(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/auth/wechat-openid') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    if (!body.code) {
      const error = new Error('缺少微信登录 code')
      error.statusCode = 400
      throw error
    }
    const session = await fetchWechatOpenid(body.code)
    return sendJson(res, dbStore.updateDb((nextDb) => {
      const user = (nextDb.users || []).find((item) => item.id === userId)
      if (!user) {
        const error = new Error('未找到当前用户')
        error.statusCode = 404
        throw error
      }
      user.openid = session.openid
      if (session.unionid) user.unionid = session.unionid
      user.wechatBoundAt = new Date().toLocaleString('zh-CN', { hour12: false })
      return domain.currentUser(nextDb, userId)
    }))
  }

  if (method === 'GET' && pathname === '/mini/home/listings') {
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-home-listings')
      return sendJson(res, domain.filterListings(db, guestListingFilter()).slice(0, 3))
    }
    return sendJson(res, domain.homeListings(db))
  }

  if (method === 'GET' && pathname === '/mini/company-sheet-snapshot') {
    const guest = isGuestUser(userId)
    if (guest) assertGuestRateLimit(req, 'mini-company-sheet-snapshot', 30)
    const cached = feishuSync.cachedSheetSnapshot(db)
    if (cached) return sendJson(res, cached)
    const nextDb = dbStore.readDb()
    const snapshot = await feishuSync.refreshSheetSnapshot(nextDb, { reason: 'mini-request' })
    dbStore.writeDb(nextDb)
    return sendJson(res, snapshot)
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
      rentMax: searchParams.get('rentMax') || ''
    }
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-listings')
      return sendJson(res, domain.filterListings(db, guestListingFilter(filter)))
    }
    return sendJson(res, domain.filterListings(db, filter))
  }

  if (method === 'POST' && pathname === '/mini/listings/match') {
    const body = await parseBody(req)
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-listings-match')
      return sendJson(res, domain.matchListings(db, guestListingFilter(body)))
    }
    return sendJson(res, domain.matchListings(db, body))
  }

  if (method === 'POST' && pathname === '/mini/llm/match') {
    const body = await parseBody(req)
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-llm-match')
      return sendJson(res, await llm.matchRentalNeed(companyOnlyDb(db), guestListingFilter(body)))
    }
    return sendJson(res, await llm.matchRentalNeed(db, body))
  }

  if (method === 'POST' && pathname === '/mini/assistant/chat') {
    const body = await parseBody(req)
    // 助手对话的慢速 LLM 调用只在请求快照 db 上只读执行，不再用 updateDbAsync 把整个
    // await 窗口罩进写事务；留痕通过 persistTrace 在 await 之后用同步 updateDb 落到最新 db，
    // 消除“读快照→await 数秒→整库回写覆盖并发写入”的丢数据竞态。
    const persistTrace = (writeTraceLog) => dbStore.updateDb((freshDb) => writeTraceLog(freshDb))
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-assistant-chat', 30)
      return sendJson(res, await assistantService.chat(companyOnlyDb(db), body, { userId: '', persistTrace }))
    }
    return sendJson(res, await assistantService.chat(db, body, { userId, persistTrace }))
  }

  if (method === 'POST' && pathname === '/mini/asr/transcribe') {
    if (isGuestUser(userId)) assertGuestRateLimit(req, 'mini-asr-transcribe', 20)
    const form = await parseMultipartForm(req, { maxBytes: asrService.MAX_AUDIO_BYTES })
    const file = (form.files || []).find((item) => item.name === 'file' || item.name === 'audio') || form.file
    return sendJson(res, await asrService.transcribeAudio(db, file, {
      fields: form.fields || {},
      userId
    }))
  }

  if (method === 'POST' && pathname === '/mini/assistant/feedback') {
    const body = await parseBody(req)
    if (isGuestUser(userId)) assertGuestRateLimit(req, 'mini-assistant-feedback', 30)
    return sendJson(res, dbStore.updateDb((nextDb) => assistantService.feedback(nextDb, body, { userId })))
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

  if (method === 'GET' && pathname === '/mini/footprints') {
    assertMiniLogin(userId)
    return sendJson(res, domain.footprintRecords(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/rental-needs') {
    assertMiniLogin(userId)
    return sendJson(res, domain.userRentalNeeds(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/rental-needs') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.createRentalNeed(nextDb, userId, body)))
  }

  if (method === 'GET' && pathname === '/mini/my/listings') {
    assertMiniLogin(userId)
    return sendJson(res, domain.ownedListings(db, userId))
  }

  const myListingEditMatch = pathname.match(/^\/mini\/my\/listings\/([^/]+)$/)
  if (method === 'GET' && myListingEditMatch) {
    assertMiniLogin(userId)
    return sendJson(res, withSignedVideoUrl(domain.editableListingDetail(db, userId, myListingEditMatch[1])))
  }

  if (method === 'PUT' && myListingEditMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, withSignedVideoUrl(dbStore.updateDb((nextDb) => domain.updateNormalListing(nextDb, userId, myListingEditMatch[1], body))))
  }

  const myListingVerifyMatch = pathname.match(/^\/mini\/my\/listings\/([^/]+)\/verify$/)
  if (method === 'POST' && myListingVerifyMatch) {
    assertMiniLogin(userId)
    return sendJson(res, dbStore.updateDb((nextDb) => {
      domain.verifyListingAvailability(nextDb, userId, myListingVerifyMatch[1])
      return domain.ownedListings(nextDb, userId)
    }))
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
      return sendJson(res, dbStore.updateDb((nextDb) => {
        const bill = domain.createRechargeBill(nextDb, userId, {
          id: billId,
          outTradeNo: billId,
          points: count,
          amount,
          status: '待确认',
          paymentMethod: '后台人工确认',
          time: '刚刚'
        })
        return {
          profile: domain.profileState(nextDb, userId),
          bill,
          paymentMode: config.rechargePaymentMode || 'manual',
          message: '充值申请已提交，管理员确认到账后积分生效'
        }
      }))
    }
    const user = (db.users || []).find((item) => item.id === userId) || {}
    const openid = body.openid || user.openid || user.openId || config.wechatPay.testOpenid
    const payOrder = await wxpay.createJsapiOrder({
      outTradeNo: billId,
      amountFen: amount * 100,
      description: `寓你住一起积分充值${count}分`,
      openid
    })
    return sendJson(res, dbStore.updateDb((nextDb) => {
      const bill = domain.createRechargeBill(nextDb, userId, {
        id: billId,
        outTradeNo: billId,
        points: count,
        amount,
        status: '待支付',
        paymentMethod: '微信支付',
        prepayId: payOrder.prepayId
      })
      return {
        profile: domain.profileState(nextDb, userId),
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
    return sendJson(res, dbStore.updateDb((nextDb) => domain.uploadGroupListing(nextDb, userId, body)))
  }

  const unlockMatch = pathname.match(/^\/mini\/groups\/([^/]+)\/unlock$/)
  if (method === 'POST' && unlockMatch) {
    assertMiniLogin(userId)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.unlockGroup(nextDb, userId, unlockMatch[1])))
  }

  if (method === 'POST' && pathname === '/mini/uploads/video-policy') {
    assertMiniLogin(userId)
    return sendJson(res, oss.createVideoUploadPolicy(await parseBody(req)))
  }

  if (method === 'POST' && pathname === '/mini/uploads/group-screenshot-policy') {
    assertMiniLogin(userId)
    return sendJson(res, oss.createGroupScreenshotUploadPolicy(await parseBody(req)))
  }

  if (method === 'POST' && pathname === '/mini/uploads/showing-photo-policy') {
    assertMiniLogin(userId)
    return sendJson(res, oss.createShowingPhotoUploadPolicy(await parseBody(req)))
  }

  if (method === 'POST' && pathname === '/mini/listings') {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.addNormalListing(nextDb, userId, body)))
  }

  const listingMatch = pathname.match(/^\/mini\/listings\/([^/]+)$/)
  if (method === 'GET' && listingMatch) {
    const detail = domain.listingDetail(db, listingMatch[1])
    if (!detail) {
      const error = new Error('房源不存在或已下架')
      error.statusCode = 404
      throw error
    }
    if (isGuestUser(userId)) {
      assertGuestRateLimit(req, 'mini-listing-detail')
      assertGuestListingAllowed(detail)
    }
    return sendJson(res, withSignedVideoUrl(detail))
  }

  const listingLogsMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/footprints$/)
  if (method === 'GET' && listingLogsMatch) {
    assertMiniLogin(userId)
    return sendJson(res, domain.listingLogs(db, listingLogsMatch[1], userId))
  }

  const videoShareMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/video-share$/)
  if (method === 'POST' && videoShareMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.recordVideoShare(nextDb, userId, videoShareMatch[1], {
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
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.createClientReport(nextDb, userId, reportMatch[1], body)))
  }

  const reportDealMatch = pathname.match(/^\/mini\/reports\/([^/]+)\/deals$/)
  if (method === 'POST' && reportDealMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.createDealFromReport(nextDb, userId, reportDealMatch[1], body)))
  }

  const showingMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/showings$/)
  if (method === 'POST' && showingMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.recordShowing(nextDb, userId, showingMatch[1], body)))
  }

  const dealMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/deals$/)
  if (method === 'POST' && dealMatch) {
    assertMiniLogin(userId)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.registerDeal(nextDb, userId, dealMatch[1])))
  }

  const sensitiveMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/sensitive-view$/)
  if (method === 'POST' && sensitiveMatch) {
    assertMiniLogin(userId)
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.addSensitiveFootprint(nextDb, userId, sensitiveMatch[1], {
      action: body.action,
      needId: body.needId,
      rentalNeedId: body.rentalNeedId,
      clientNeedId: body.clientNeedId,
      purpose: body.purpose,
      scene: body.scene,
      reason: body.reason
    })))
  }

  const error = new Error(`接口不存在：${method} ${pathname}`)
  error.statusCode = 404
  throw error
}

async function handleAdmin(req, res, pathname, searchParams) {
  const method = req.method
  const db = readDbForRequest()

  if (method === 'POST' && pathname === '/admin/auth/login') {
    const body = await parseBody(req)
    const account = String(body.account || '').trim()
    const password = String(body.password || '')
    const accounts = db.adminAccounts || defaultAdminAccounts(db)
    const admin = accounts.find((item) => item.account === account && adminPasswordMatches(item, password) && item.status !== '禁用')
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
    return sendJson(res, publicAdminAccount(adminAccount))
  }

  if (method === 'GET' && pathname === '/admin/dashboard') {
    return sendJson(res, domain.dashboardSummary(db))
  }
  if (method === 'GET' && pathname === '/admin/listing-maintenance-rule') {
    return sendJson(res, domain.listingMaintenanceRule(db))
  }
  if (method === 'PUT' && pathname === '/admin/listing-maintenance-rule') {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => (
      domain.setListingMaintenanceRule(nextDb, adminAccount.userId || adminAccount.id, body)
    )))
  }
  if (method === 'GET' && pathname === '/admin/launch-check') {
    return sendJson(res, buildLaunchCheck(db))
  }
  if (method === 'GET' && pathname === '/admin/assistant/feedbacks') {
    return sendJson(res, assistantService.feedbackRows(db, {
      status: searchParams.get('status') || '',
      feedbackType: searchParams.get('feedbackType') || searchParams.get('type') || '',
      limit: searchParams.get('limit') || ''
    }))
  }
  if (method === 'GET' && pathname === '/admin/assistant/eval-cases') {
    return sendJson(res, assistantService.evalCaseRows(db, {
      status: searchParams.get('status') || '',
      limit: searchParams.get('limit') || ''
    }))
  }
  if (method === 'GET' && pathname === '/admin/assistant/traces') {
    return sendJson(res, assistantService.traceRows(db, {
      threadId: searchParams.get('threadId') || '',
      intent: searchParams.get('intent') || '',
      limit: searchParams.get('limit') || ''
    }))
  }
  const assistantFeedbackReviewMatch = pathname.match(/^\/admin\/assistant\/feedbacks\/([^/]+)\/review$/)
  if (method === 'POST' && assistantFeedbackReviewMatch) {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => (
      assistantService.reviewFeedback(nextDb, assistantFeedbackReviewMatch[1], body, {
        userId: adminAccount.userId || adminAccount.id
      })
    )))
  }
  const assistantFeedbackEvalMatch = pathname.match(/^\/admin\/assistant\/feedbacks\/([^/]+)\/promote-eval$/)
  if (method === 'POST' && assistantFeedbackEvalMatch) {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => (
      assistantService.promoteFeedbackToEvalCase(nextDb, assistantFeedbackEvalMatch[1], body, {
        userId: adminAccount.userId || adminAccount.id
      })
    )))
  }
  if (method === 'GET' && pathname === '/admin/env-template') {
    return sendJson(res, {
      template: buildMissingEnvTemplate(db)
    })
  }
  if (method === 'GET' && pathname === '/admin/feishu-sync/status') {
    return sendJson(res, feishuSync.status(db))
  }
  if (method === 'POST' && pathname === '/admin/feishu-sync/run') {
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
    const nextDb = dbStore.readDb()
    const result = await feishuSync.sync(nextDb, adminAccount.userId || adminAccount.id, body)
    dbStore.writeDb(nextDb)
    return sendJson(res, {
      result,
      status: feishuSync.status(nextDb)
    })
  }
  if (method === 'GET' && pathname === '/admin/listings') {
    return sendJson(res, withSignedListingVideoUrls(domain.adminListings(db, {
      area: searchParams.get('area') || '',
      block: searchParams.get('block') || '',
      community: searchParams.get('community') || ''
    })))
  }
  if (method === 'GET' && pathname === '/admin/expired-listings') {
    return sendJson(res, withSignedListingVideoUrls(domain.expiredListings(db, {
      area: searchParams.get('area') || '',
      block: searchParams.get('block') || '',
      community: searchParams.get('community') || ''
    })))
  }
  const adminExpiredRestoreMatch = pathname.match(/^\/admin\/expired-listings\/([^/]+)\/restore$/)
  if (method === 'POST' && adminExpiredRestoreMatch) {
    return sendJson(res, dbStore.updateDb((nextDb) => {
      domain.restoreExpiredListing(nextDb, adminAccount.userId || adminAccount.id, adminExpiredRestoreMatch[1])
      return withSignedListingVideoUrls(domain.expiredListings(nextDb, {
        area: searchParams.get('area') || '',
        block: searchParams.get('block') || '',
        community: searchParams.get('community') || ''
      }))
    }))
  }
  const adminListingEditMatch = pathname.match(/^\/admin\/listings\/([^/]+)$/)
  if (method === 'PUT' && adminListingEditMatch) {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.updateNormalListing(nextDb, adminAccount.userId || adminAccount.id, adminListingEditMatch[1], body, { admin: true })))
  }
  const adminListingCoordinateMatch = pathname.match(/^\/admin\/listings\/([^/]+)\/coordinate$/)
  if (method === 'POST' && adminListingCoordinateMatch) {
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
  const adminListingVerifyMatch = pathname.match(/^\/admin\/listings\/([^/]+)\/verify$/)
  if (method === 'POST' && adminListingVerifyMatch) {
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
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => (
      withSignedListingVideoUrls(domain.reviewOwnerListing(nextDb, adminAccount.userId || adminAccount.id, adminListingReviewMatch[1], body))
    )))
  }
  if (method === 'GET' && pathname === '/admin/footprints') {
    return sendJson(res, domain.adminLogs(db))
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
    const body = await parseBody(req)
    return sendJson(res, withSignedShowingPhotoUrls(dbStore.updateDb((nextDb) => domain.reviewShowingUpload(nextDb, adminAccount.userId || adminAccount.id, showingReviewMatch[1], body))))
  }
  const groupReviewMatch = pathname.match(/^\/admin\/groups\/uploads\/([^/]+)\/review$/)
  if (method === 'POST' && groupReviewMatch) {
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
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.reviewRechargeBill(nextDb, adminAccount.userId || adminAccount.id, rechargeReviewMatch[1], body)))
  }
  const rechargeSyncMatch = pathname.match(/^\/admin\/recharges\/([^/]+)\/sync$/)
  if (method === 'POST' && rechargeSyncMatch) {
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
    return sendJson(res, {
      users: domain.adminUsers(db),
      admins: (db.adminAccounts || defaultAdminAccounts(db)).map(publicAdminAccount)
    })
  }
  if (method === 'GET' && pathname === '/admin/data/export') {
    assertAdminCapability(adminAccount)
    const date = new Date().toISOString().slice(0, 10)
    return sendJsonDownload(res, `ynzy-backup-${date}.json`, db)
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
    return sendJson(res, dbStore.updateDb((nextDb) => {
      nextDb.adminAccounts = nextDb.adminAccounts || defaultAdminAccounts(nextDb)
      if (nextDb.adminAccounts.some((item) => item.account === accountName)) {
        const error = new Error('后台账号已存在')
        error.statusCode = 400
        throw error
      }
      const user = (nextDb.users || []).find((item) => item.id === body.userId)
      nextDb.adminAccounts.unshift({
        id: `A${Date.now()}`,
        account: accountName,
        passwordHash: hashPassword(password),
        name: String(body.name || (user && user.name) || accountName).trim(),
        userId: body.userId || (user && user.id) || '',
        permission: body.permission || '后台查看权限',
        status: '启用',
        createdAt: new Date().toLocaleString('zh-CN', { hour12: false })
      })
      return {
        users: domain.adminUsers(nextDb),
        admins: nextDb.adminAccounts.map(publicAdminAccount)
      }
    }))
  }
  const adminStatusMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/status$/)
  if (method === 'POST' && adminStatusMatch) {
    assertAdminCapability(adminAccount)
    const body = await parseBody(req)
    const action = body.action || body.status
    const nextStatus = action === 'disable' || action === 'disabled' || action === '禁用' ? '禁用' : '启用'
    return sendJson(res, dbStore.updateDb((nextDb) => {
      nextDb.adminAccounts = nextDb.adminAccounts || defaultAdminAccounts(nextDb)
      const account = nextDb.adminAccounts.find((item) => item.id === adminStatusMatch[1] || item.account === adminStatusMatch[1])
      if (!account) {
        const error = new Error('未找到管理员账号')
        error.statusCode = 404
        throw error
      }
      if (account.id === adminAccount.id && nextStatus === '禁用') {
        const error = new Error('不能禁用当前登录账号')
        error.statusCode = 400
        throw error
      }
      account.status = nextStatus
      account.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      return {
        users: domain.adminUsers(nextDb),
        admins: nextDb.adminAccounts.map(publicAdminAccount)
      }
    }))
  }
  const adminPasswordMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/password$/)
  if (method === 'POST' && adminPasswordMatch) {
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
    return sendJson(res, dbStore.updateDb((nextDb) => {
      nextDb.adminAccounts = nextDb.adminAccounts || defaultAdminAccounts(nextDb)
      const account = nextDb.adminAccounts.find((item) => item.id === adminPasswordMatch[1] || item.account === adminPasswordMatch[1])
      if (!account) {
        const error = new Error('未找到管理员账号')
        error.statusCode = 404
        throw error
      }
      account.passwordHash = hashPassword(nextPassword)
      delete account.password
      account.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      return {
        users: domain.adminUsers(nextDb),
        admins: nextDb.adminAccounts.map(publicAdminAccount)
      }
    }))
  }
  if (method === 'GET' && pathname === '/admin/llm-config') {
    return sendJson(res, normalizeLlmConfig(db.llmConfig || {}))
  }
  if (method === 'PUT' && pathname === '/admin/llm-config') {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => saveLlmConfig(nextDb, body)))
  }
  if (method === 'POST' && pathname === '/admin/llm-config/test') {
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
  if (req.method === 'OPTIONS') {
    sendOptions(res)
    return
  }

  // URL 解析放在独立 try 内：畸形百分号转义（如 /%zz）会让 decodeURIComponent 抛
  // URIError，畸形 Host 头会让 new URL 抛 TypeError。逃逸到 async router 之外会变成
  // unhandledRejection 使进程退出（Node>=15 默认），任意游客一条 curl 即可打死服务。
  let url
  let pathname
  try {
    url = new URL(req.url, `http://${req.headers.host}`)
    pathname = decodeURIComponent(url.pathname)
  } catch (error) {
    error.statusCode = 400
    sendError(res, error)
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
        service: 'ynzy-house-miniapp'
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
    const nextDb = dbStore.readDb()
    await feishuSync.sync(nextDb, 'system-feishu-sync', { scheduled: true })
    dbStore.writeDb(nextDb)
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

// 最后防线：单个请求处理器里逃逸的异步异常，或第三方回调（如静态文件读流）里的
// 异常，不应拖垮整个进程；记录后继续服务其余请求，避免单点故障放大为服务不可用。
process.on('unhandledRejection', (reason) => {
  console.error(`未处理的 Promise 拒绝：${reason && reason.stack ? reason.stack : reason}`)
})
process.on('uncaughtException', (error) => {
  console.error(`未捕获异常：${error && error.stack ? error.stack : error}`)
})

const server = http.createServer(router)
asrRealtime.attachRealtimeAsr(server, {
  getDb: dbStore.readDb
})

server.listen(config.port, () => {
  console.log(`寓你住一起后端已启动：http://127.0.0.1:${config.port}`)
  console.log(`管理后台：http://127.0.0.1:${config.port}/admin-web/`)
  startFeishuSyncTimer()
})
