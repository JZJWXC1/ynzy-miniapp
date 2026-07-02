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
const oss = require('./oss')
const wxpay = require('./wxpay')

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

function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  })
  res.end(JSON.stringify({ code: 0, message: 'ok', data }))
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  })
  res.end(JSON.stringify({ code: statusCode, message: error.message || '服务异常', data: error.data || null }))
}

function sendJsonDownload(res, filename, data) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
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
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('请求内容过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        error.statusCode = 400
        reject(error)
      }
    })
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  })
  res.end()
}

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function adminTokenSecret() {
  return process.env.ADMIN_TOKEN_SECRET || 'ynzy-admin-local-dev-secret'
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
  fs.createReadStream(filePath).pipe(res)
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
  fs.createReadStream(filePath).pipe(res)
}

const DEFAULT_LLM_SYSTEM_PROMPT = '你是寓你配房小帮手。根据租客预算、区域、户型、入住时间、通勤位置，从内部房源库候选房源中返回推荐理由；不能编造不存在的房源，不能输出详细地址、房东联系方式、房间号或视频签名链接。'

function looksBrokenPrompt(value) {
  const text = String(value || '').trim()
  if (!text) return true
  const questionCount = (text.match(/\?/g) || []).length
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length
  return text.indexOf('\uFFFD') !== -1 || (text.length >= 8 && questionCount / text.length > 0.25 && cjkCount === 0)
}

function normalizeLlmConfig(raw = {}) {
  const systemPrompt = String(raw.systemPrompt || '').trim()
  return {
    provider: raw.provider || 'local',
    protocol: raw.protocol || 'openai-compatible',
    apiBaseUrl: raw.apiBaseUrl || '',
    model: raw.model || 'local-match-v1',
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
  const names = []
  if (!process.env.ADMIN_TOKEN_SECRET) names.push('ADMIN_TOKEN_SECRET')
  if (!config.oss.bucket) names.push('ALI_OSS_BUCKET')
  if (!config.oss.region) names.push('ALI_OSS_REGION')
  if (!config.oss.accessKeyId) names.push('ALI_OSS_ACCESS_KEY_ID')
  if (!config.oss.accessKeySecret) names.push('ALI_OSS_ACCESS_KEY_SECRET')
  if (!config.oss.publicBaseUrl) names.push('ALI_OSS_PUBLIC_BASE_URL')
  if (llmConfig.enabled && llmConfig.provider !== 'local' && !process.env[llmSecretName]) names.push(llmSecretName)
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
  const userId = dbStore.getCurrentUserId(req, db)

  if (method === 'GET' && pathname === '/mini/auth/me') {
    return sendJson(res, domain.currentUser(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/auth/login') {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.loginByPhone(nextDb, body.phone)))
  }

  if (method === 'POST' && pathname === '/mini/auth/register') {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.registerUser(nextDb, body)))
  }

  if (method === 'POST' && pathname === '/mini/auth/wechat-openid') {
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
    return sendJson(res, domain.homeListings(db))
  }

  if (method === 'GET' && pathname === '/mini/company-sheet-snapshot') {
    const cached = feishuSync.cachedSheetSnapshot(db)
    if (cached) return sendJson(res, cached)
    const nextDb = dbStore.readDb()
    const snapshot = await feishuSync.refreshSheetSnapshot(nextDb, { reason: 'mini-request' })
    dbStore.writeDb(nextDb)
    return sendJson(res, snapshot)
  }

  if (method === 'GET' && pathname === '/mini/listings') {
    return sendJson(res, domain.filterListings(db, {
      category: searchParams.get('category') || '',
      area: searchParams.get('area') || '',
      block: searchParams.get('block') || '',
      community: searchParams.get('community') || '',
      layout: searchParams.get('layout') || '',
      rentMax: searchParams.get('rentMax') || ''
    }))
  }

  if (method === 'POST' && pathname === '/mini/listings/match') {
    return sendJson(res, domain.matchListings(db, await parseBody(req)))
  }

  if (method === 'POST' && pathname === '/mini/llm/match') {
    return sendJson(res, await llm.matchRentalNeed(db, await parseBody(req)))
  }

  if (method === 'GET' && pathname === '/mini/map/communities') {
    return sendJson(res, domain.mapCommunities(db, mapQueryFilter(searchParams)))
  }

  if (method === 'GET' && pathname === '/mini/map/pins') {
    return sendJson(res, domain.mapPins(db, mapQueryFilter(searchParams)))
  }

  if (method === 'GET' && pathname === '/mini/footprints') {
    return sendJson(res, domain.footprintRecords(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/rental-needs') {
    return sendJson(res, domain.userRentalNeeds(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/rental-needs') {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.createRentalNeed(nextDb, userId, body)))
  }

  if (method === 'GET' && pathname === '/mini/my/listings') {
    return sendJson(res, domain.ownedListings(db, userId))
  }

  const myListingEditMatch = pathname.match(/^\/mini\/my\/listings\/([^/]+)$/)
  if (method === 'GET' && myListingEditMatch) {
    return sendJson(res, withSignedVideoUrl(domain.editableListingDetail(db, userId, myListingEditMatch[1])))
  }

  if (method === 'PUT' && myListingEditMatch) {
    const body = await parseBody(req)
    return sendJson(res, withSignedVideoUrl(dbStore.updateDb((nextDb) => domain.updateNormalListing(nextDb, userId, myListingEditMatch[1], body))))
  }

  const myListingVerifyMatch = pathname.match(/^\/mini\/my\/listings\/([^/]+)\/verify$/)
  if (method === 'POST' && myListingVerifyMatch) {
    return sendJson(res, dbStore.updateDb((nextDb) => {
      domain.verifyListingAvailability(nextDb, userId, myListingVerifyMatch[1])
      return domain.ownedListings(nextDb, userId)
    }))
  }

  if (method === 'GET' && pathname === '/mini/profile') {
    return sendJson(res, domain.profileState(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/today-tasks') {
    return sendJson(res, domain.todayTasks(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/commissions') {
    return sendJson(res, domain.userCommissionRows(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/reports') {
    return sendJson(res, domain.userReportRows(db, userId))
  }

  if (method === 'GET' && pathname === '/mini/deals') {
    return sendJson(res, domain.userDealRows(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/points/recharge') {
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
    return sendJson(res, domain.groupState(db, userId))
  }

  if (method === 'POST' && pathname === '/mini/groups/listings') {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.uploadGroupListing(nextDb, userId, body)))
  }

  const unlockMatch = pathname.match(/^\/mini\/groups\/([^/]+)\/unlock$/)
  if (method === 'POST' && unlockMatch) {
    return sendJson(res, dbStore.updateDb((nextDb) => domain.unlockGroup(nextDb, userId, unlockMatch[1])))
  }

  if (method === 'POST' && pathname === '/mini/uploads/video-policy') {
    return sendJson(res, oss.createVideoUploadPolicy(await parseBody(req)))
  }

  if (method === 'POST' && pathname === '/mini/uploads/group-screenshot-policy') {
    return sendJson(res, oss.createGroupScreenshotUploadPolicy(await parseBody(req)))
  }

  if (method === 'POST' && pathname === '/mini/uploads/showing-photo-policy') {
    return sendJson(res, oss.createShowingPhotoUploadPolicy(await parseBody(req)))
  }

  if (method === 'POST' && pathname === '/mini/listings') {
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
    return sendJson(res, withSignedVideoUrl(detail))
  }

  const listingLogsMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/footprints$/)
  if (method === 'GET' && listingLogsMatch) {
    return sendJson(res, domain.listingLogs(db, listingLogsMatch[1], userId))
  }

  const reportMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/reports$/)
  if (method === 'POST' && reportMatch) {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.createClientReport(nextDb, userId, reportMatch[1], body)))
  }

  const reportDealMatch = pathname.match(/^\/mini\/reports\/([^/]+)\/deals$/)
  if (method === 'POST' && reportDealMatch) {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.createDealFromReport(nextDb, userId, reportDealMatch[1], body)))
  }

  const showingMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/showings$/)
  if (method === 'POST' && showingMatch) {
    const body = await parseBody(req)
    return sendJson(res, dbStore.updateDb((nextDb) => domain.recordShowing(nextDb, userId, showingMatch[1], body)))
  }

  const dealMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/deals$/)
  if (method === 'POST' && dealMatch) {
    return sendJson(res, dbStore.updateDb((nextDb) => domain.registerDeal(nextDb, userId, dealMatch[1])))
  }

  const sensitiveMatch = pathname.match(/^\/mini\/listings\/([^/]+)\/sensitive-view$/)
  if (method === 'POST' && sensitiveMatch) {
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
    const date = new Date().toISOString().slice(0, 10)
    return sendJsonDownload(res, `ynzy-backup-${date}.json`, db)
  }
  if (method === 'POST' && pathname === '/admin/accounts') {
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
    return sendJson(res, await llm.matchRentalNeed(tempDb, { text: '预算3000，滨江两室，月底入住' }))
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

  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = decodeURIComponent(url.pathname)

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

http.createServer(router).listen(config.port, () => {
  console.log(`寓你住一起后端已启动：http://127.0.0.1:${config.port}`)
  console.log(`管理后台：http://127.0.0.1:${config.port}/admin-web/`)
  startFeishuSyncTimer()
})
