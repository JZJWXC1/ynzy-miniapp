const { getRuntimeConfig, shouldUseMock } = require('./api-config')

function normalizeResponse(body) {
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'data')) {
    return body
  }
  return {
    code: 0,
    message: 'ok',
    data: body
  }
}

function buildUrl(baseUrl, path) {
  const base = (baseUrl || '').replace(/\/$/, '')
  const target = path.indexOf('/') === 0 ? path : `/${path}`
  return `${base}${target}`
}

function headerValue(response, name) {
  const headers = response && (response.header || response.headers)
  if (!headers || typeof headers !== 'object') return ''
  const expected = String(name || '').toLowerCase()
  const matched = Object.keys(headers).find((key) => String(key).toLowerCase() === expected)
  return matched ? String(headers[matched] || '') : ''
}

function authExpiryTimestamp(value) {
  if (value === undefined || value === null || value === '') return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function urlWithoutQuery(value) {
  const text = String(value || '')
  const queryAt = text.indexOf('?')
  const hashAt = text.indexOf('#')
  const cuts = [queryAt, hashAt].filter((index) => index >= 0)
  return cuts.length ? text.slice(0, Math.min(...cuts)) : text
}

function sanitizeDiagnosticText(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/ig, (url) => {
      const safeUrl = urlWithoutQuery(url)
      return safeUrl === url ? url : `${safeUrl}?[查询参数已隐藏]`
    })
    .replace(/([?&](?:Signature|OSSAccessKeyId|Expires|security-token|x-oss-security-token)=)[^&\s]+/ig, '$1[已隐藏]')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/ig, '$1[已隐藏]')
    // 诊断文本可能来自 URL path，不保证手机号有单词边界；允许 +86/86、空格/短横线，
    // 即使后面还粘着数字也优先过度脱敏，避免真实手机号成为长标识的一部分后漏出。
    .replace(/(?:(?:\+|%2b)?86[\s-]*)?1[3-9](?:[\s-]*\d){9}/ig, '[手机号已隐藏]')
    // URL path 中邮箱常把 @ / . 编成 %40 / %2E；不整体 decode，避免改变其余诊断语义。
    .replace(/[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9.%+-]+(?:\.|%2e)[A-Z]{2,}/ig, '[邮箱已隐藏]')
}

function createRequestError(message, context = {}) {
  const safeMessage = sanitizeDiagnosticText(message || '网络请求失败')
  const error = new Error(safeMessage)
  error.errMsg = sanitizeDiagnosticText(context.errMsg || safeMessage)
  error.requestType = context.requestType || 'request'
  error.requestMethod = String(context.method || '').toUpperCase()
  error.requestUrl = sanitizeDiagnosticText(urlWithoutQuery(context.url))
  error.timeout = Number(context.timeout) || 0
  error.durationMs = Math.max(0, Number(context.durationMs) || 0)
  error.traceId = String(context.traceId || '')
  error.networkError = Boolean(context.networkError)
  if (Number.isFinite(Number(context.statusCode))) error.statusCode = Number(context.statusCode)
  if (context.errorCode !== undefined && context.errorCode !== null) error.errorCode = context.errorCode
  return error
}

function reportRequestError(error) {
  try {
    if (typeof console === 'undefined' || typeof console.error !== 'function') return
    console.error('[api-request-fail]', JSON.stringify({
      type: error.requestType,
      method: error.requestMethod,
      url: sanitizeDiagnosticText(error.requestUrl),
      statusCode: error.statusCode,
      timeout: error.timeout,
      durationMs: error.durationMs,
      traceId: error.traceId,
      networkError: error.networkError,
      errorCode: error.errorCode,
      errMsg: sanitizeDiagnosticText(error.errMsg || error.message)
    }))
  } catch (logError) {}
}

let authRedirecting = false
const PUBLIC_READ_AUTH_FALLBACK_TTL_MS = 2 * 60 * 1000
let publicReadAuthFallbackBridge = null
const authInvalidationListeners = new Set()

function subscribeAuthInvalidation(listener) {
  if (typeof listener !== 'function') return () => {}
  authInvalidationListeners.add(listener)
  return () => authInvalidationListeners.delete(listener)
}

function notifyAuthInvalidated(fromSessionKey, options = {}) {
  const config = getRuntimeConfig()
  const event = {
    reason: 'unauthorized',
    fromSessionKey: String(fromSessionKey || ''),
    toSessionKey: String(getAuthSessionKey(config) || '')
  }
  const publicFallbackRequestId = String(options.publicFallbackRequestId || '')
  if (publicFallbackRequestId) event.publicFallbackRequestId = publicFallbackRequestId
  authInvalidationListeners.forEach((listener) => {
    try { listener(event) } catch (error) {}
  })
}

function activePublicReadAuthFallbackBridge() {
  const bridge = publicReadAuthFallbackBridge
  if (!bridge || Date.now() - bridge.createdAt > PUBLIC_READ_AUTH_FALLBACK_TTL_MS) {
    publicReadAuthFallbackBridge = null
    return null
  }
  return bridge
}

function recordPublicReadAuthFallbackBridge(fromSessionKey, fromToken) {
  const config = getRuntimeConfig()
  const toSessionKey = String(getAuthSessionKey(config) || '')
  if (!fromSessionKey || !fromToken || !toSessionKey || getAuthToken(config)) return
  publicReadAuthFallbackBridge = {
    fromSessionKey: String(fromSessionKey),
    fromToken: String(fromToken),
    toSessionKey,
    createdAt: Date.now()
  }
}

function matchesPublicReadAuthFallbackBridge(requestSessionKey, requestToken) {
  const bridge = activePublicReadAuthFallbackBridge()
  if (!bridge) return false
  const config = getRuntimeConfig()
  return !getAuthToken(config) &&
    String(getAuthSessionKey(config) || '') === bridge.toSessionKey &&
    String(requestSessionKey || '') === bridge.fromSessionKey &&
    String(requestToken || '') === bridge.fromToken
}

// 页面只能在自身发起的“公共读取”成功回调里使用此判断。它只承认刚刚因同一失效 token
// 从旧登录会话切到当前游客会话的单向接力；一旦用户登录新账号，会话键或 token 不符即失效。
function isPublicReadAuthFallbackContinuation(requestSessionKey) {
  const bridge = activePublicReadAuthFallbackBridge()
  if (!bridge) return false
  const config = getRuntimeConfig()
  return !getAuthToken(config) &&
    String(requestSessionKey || '') === bridge.fromSessionKey &&
    String(getAuthSessionKey(config) || '') === bridge.toSessionKey
}

function getAuthToken(config) {
  try {
    if (typeof getApp === 'function') {
      const app = getApp()
      if (app && app.globalData && app.globalData.authToken) {
        return app.globalData.authToken
      }
    }
    if (config && config.token) return config.token
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      return wx.getStorageSync('ynzy_auth_token') || ''
    }
  } catch (error) {
    return ''
  }
  return ''
}

function getAuthSessionKey(config) {
  try {
    if (typeof getApp === 'function') {
      const app = getApp()
      if (app && app.globalData && app.globalData.authSessionKey) {
        return String(app.globalData.authSessionKey)
      }
    }
  } catch (error) {}
  // 兼容单元测试或极早启动阶段；真实小程序 onLaunch 会始终生成稳定会话键。
  const token = getAuthToken(config)
  return token ? `legacy:${token}` : 'guest'
}

function applyAuthRefresh(response, requestToken, requestSessionKey) {
  const nextToken = headerValue(response, 'X-Auth-Token')
  const nextExpiresAt = authExpiryTimestamp(headerValue(response, 'X-Auth-Token-Expires-At'))
  if (!nextToken || nextToken.length > 4096 || !nextExpiresAt || nextExpiresAt <= Date.now()) return false
  const config = getRuntimeConfig()
  if (String(getAuthToken(config) || '') !== String(requestToken || '')) return false
  if (String(getAuthSessionKey(config) || '') !== String(requestSessionKey || '')) return false

  try {
    const app = typeof getApp === 'function' ? getApp() : null
    // 续签只能由 App 的事务式持久化方法落地；缺少该方法时 fail-closed，禁止在这里先改内存、
    // 再逐键写 storage 形成 token/expiry/userId 半更新。
    if (!app || typeof app.refreshAuthToken !== 'function') return false
    return app.refreshAuthToken(nextToken, nextExpiresAt, requestToken) === true
  } catch (error) {
    return false
  }
}

function authHeader(config) {
  const token = getAuthToken(config)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function clearAuthState() {
  try {
    if (typeof getApp === 'function') {
      const app = getApp()
      if (app && typeof app.logout === 'function') {
        app.logout({ silent: true })
        return
      }
      if (app && app.globalData) {
        app.globalData.user = null
        app.globalData.userId = ''
        app.globalData.authToken = ''
        app.globalData.authTokenExpiresAt = ''
        if (app.globalData.apiConfig) app.globalData.apiConfig.token = ''
      }
    }
    if (typeof wx !== 'undefined') {
      if (wx.removeStorageSync) wx.removeStorageSync('ynzy_auth_token')
      if (wx.removeStorageSync) wx.removeStorageSync('ynzy_auth_token_expires_at')
      if (wx.removeStorageSync) wx.removeStorageSync('ynzy_user_id')
    }
  } catch (error) {}
}

function redirectToAuth() {
  if (typeof wx === 'undefined' || !wx.navigateTo || authRedirecting) return
  let currentRoute = ''
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const current = pages[pages.length - 1]
    currentRoute = current && current.route ? current.route : ''
  } catch (error) {}
  if (currentRoute === 'pages/auth/auth') return
  authRedirecting = true
  wx.navigateTo({
    url: '/pages/auth/auth',
    complete() {
      setTimeout(() => {
        authRedirecting = false
      }, 500)
    }
  })
}

function handleUnauthorized(error, requestToken, requestSessionKey, options = {}) {
  if (!error || Number(error.statusCode) !== 401) return false
  const config = getRuntimeConfig()
  const currentToken = String(getAuthToken(config) || '')
  const currentSessionKey = String(getAuthSessionKey(config) || '')
  // bearer A 滑动续签成 A′ 时稳定 session 不变。旧 A 的迟到 401 只说明旧请求已陈旧，不能
  // 撤销 A′；标记后仅允许幂等 GET 由 request 层自动重试一次，写请求交给页面提示人工重试。
  if (requestSessionKey !== undefined && currentSessionKey !== String(requestSessionKey || '')) {
    return options.publicReadAuthFallback === true &&
      matchesPublicReadAuthFallbackBridge(requestSessionKey, requestToken)
  }
  if (requestToken !== undefined && currentToken !== String(requestToken || '')) {
    if (currentToken && requestToken) error.authResponseStale = true
    return false
  }
  // 当前本来就是游客时没有任何登录态可撤销。调用 app.logout() 反而会轮换稳定 guest session，
  // 让同批已成功的公开请求被页面代次门禁误判为旧响应。匿名 401 交给具体页面显示登录引导即可。
  if (!currentToken) return false
  // 401 只能撤销发出该请求的同一会话。A 请求迟到时若用户已切到 B、刚从游客登录或主动退出，
  // 页面级序号还来不及拦住这里的全局副作用，因此必须先比较实际 Authorization token 快照。
  // 游客（从未登录、无 token）浏览时，不要因为某个后台请求 401（如详情页的 getProfileState、
  // 或点到非公司房源）就被强制弹去登录页——那正是「一直跳转登录」的根源。只有原本已登录、
  // token 失效的用户才自动跳登录重新认证；游客保持当前匿名会话、不跳转，敏感操作各页面会显式引导登录。
  clearAuthState()
  if (options.publicReadAuthFallback === true) {
    recordPublicReadAuthFallbackBridge(requestSessionKey, requestToken)
  }
  notifyAuthInvalidated(requestSessionKey, {
    publicFallbackRequestId: options.publicFallbackRequestId
  })
  if (options.publicFallbackRequestId) error.publicFallbackRequestNotified = true
  // 公开视频已经发送成功后的留痕只是尽力审计：仍须撤销当前失效身份，但不得以跳登录
  // 破坏“视频播放/转发/保存免登录”的产品边界。该开关只由调用方逐请求显式启用。
  if (options.silentAuthFailure !== true) redirectToAuth()
  return true
}

function isStaleUnauthorized(error) {
  return Boolean(error && Number(error.statusCode) === 401 && error.authResponseStale === true)
}

function request(options) {
  const config = getRuntimeConfig()
  const method = String(options.method || 'GET').toUpperCase()
  const data = options.data || {}
  const publicReadAuthFallback = options.publicReadAuthFallback === true
  // GET 天然幂等；公共 POST 只有在调用方额外确认“401 发生在业务执行前”后才允许重放。
  // PUT/DELETE/PATCH 等写语义即使误传两个开关也绝不自动匿名重试。
  const canRetryAnonymousOnAuthFailure = (error) => method === 'GET' || (
    method === 'POST' &&
    publicReadAuthFallback &&
    options.retryAnonymousOnAuthFailure === true &&
    error && error.data && error.data.authFailurePhase === 'pre_execution'
  )
  const publicReadAuthFallbackCount = Number(options._publicReadAuthFallbackCount || 0)
  const anonymousRetryData = () => {
    if (typeof options.buildAnonymousRetryData !== 'function') return data
    return options.buildAnonymousRetryData(data)
  }
  const publicFallbackRequestIdFor = (error) => (
    canRetryAnonymousOnAuthFailure(error)
      ? String(options.authFallbackRequestId || '')
      : ''
  )
  const notifyRequestSpecificFallbackIfNeeded = (error, requestSessionKey) => {
    const publicFallbackRequestId = publicFallbackRequestIdFor(error)
    if (!publicFallbackRequestId || (error && error.publicFallbackRequestNotified === true)) return
    notifyAuthInvalidated(requestSessionKey, { publicFallbackRequestId })
    if (error) error.publicFallbackRequestNotified = true
  }

  if (shouldUseMock(config)) {
    const requestAuthToken = options.omitAuth === true ? '' : String(getAuthToken(config) || '')
    const requestAuthSessionKey = String(getAuthSessionKey(config) || '')
    try {
      const mockData = typeof options.mock === 'function' ? options.mock(data) : null
      return Promise.resolve({
        code: 0,
        message: 'mock',
        data: mockData
      })
    } catch (error) {
      const authStateCleared = handleUnauthorized(
        error,
        requestAuthToken,
        requestAuthSessionKey,
        {
          silentAuthFailure: options.silentAuthFailure === true || publicReadAuthFallback,
          publicReadAuthFallback,
          publicFallbackRequestId: publicFallbackRequestIdFor(error)
        }
      )
      if (
        canRetryAnonymousOnAuthFailure(error) &&
        requestAuthToken &&
        authStateCleared &&
        publicReadAuthFallbackCount < 1
      ) {
        notifyRequestSpecificFallbackIfNeeded(error, requestAuthSessionKey)
        return request({
          ...options,
          data: anonymousRetryData(),
          omitAuth: true,
          silentAuthFailure: true,
          _publicReadAuthFallbackCount: publicReadAuthFallbackCount + 1
        })
      }
      return Promise.reject(error)
    }
  }

  return new Promise((resolve, reject) => {
    const url = buildUrl(config.baseUrl, options.path)
    const timeout = options.timeout || config.timeout
    const requestAuthToken = options.omitAuth === true ? '' : String(getAuthToken(config) || '')
    const requestAuthSessionKey = String(getAuthSessionKey(config) || '')
    const startedAt = Date.now()
    const context = (extra = {}) => ({
      requestType: 'request',
      method,
      url,
      timeout,
      durationMs: Date.now() - startedAt,
      ...extra
    })
    const rejectNetwork = (rawError) => {
      const errMsg = (rawError && (rawError.errMsg || rawError.message)) || '网络请求失败'
      const error = createRequestError(errMsg, context({
        errMsg,
        errorCode: rawError && (rawError.errno !== undefined ? rawError.errno : rawError.errorCode),
        networkError: true
      }))
      reportRequestError(error)
      reject(error)
    }
    const rejectOrRetryAuth = (error) => {
      const authStateCleared = handleUnauthorized(error, requestAuthToken, requestAuthSessionKey, {
        silentAuthFailure: options.silentAuthFailure === true || publicReadAuthFallback,
        publicReadAuthFallback,
        publicFallbackRequestId: publicFallbackRequestIdFor(error)
      })
      const authRetryCount = Number(options._authRetryCount || 0)
      if (method === 'GET' && isStaleUnauthorized(error) && authRetryCount < 1) {
        request({ ...options, _authRetryCount: authRetryCount + 1 }).then(resolve, reject)
        return
      }
      if (
        canRetryAnonymousOnAuthFailure(error) &&
        requestAuthToken &&
        authStateCleared &&
        publicReadAuthFallback &&
        publicReadAuthFallbackCount < 1
      ) {
        notifyRequestSpecificFallbackIfNeeded(error, requestAuthSessionKey)
        request({
          ...options,
          data: anonymousRetryData(),
          omitAuth: true,
          silentAuthFailure: true,
          _publicReadAuthFallbackCount: publicReadAuthFallbackCount + 1
        }).then(resolve, reject)
        return
      }
      reportRequestError(error)
      reject(error)
    }
    const requestOptions = {
      url,
      method,
      data,
      timeout,
      header: {
        'content-type': 'application/json',
        ...(requestAuthToken ? { Authorization: `Bearer ${requestAuthToken}` } : {})
      },
      success(res) {
        const body = normalizeResponse(res.data)
        const traceId = headerValue(res, 'X-Trace-Id')
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = createRequestError(body.message || `接口请求失败：${res.statusCode}`, context({
            statusCode: res.statusCode,
            traceId
          }))
          error.data = body.data || null
          rejectOrRetryAuth(error)
          return
        }
        if (body.code && body.code !== 0) {
          const error = createRequestError(body.message || '接口业务失败', context({
            statusCode: res.statusCode,
            traceId
          }))
          error.data = body.data || null
          rejectOrRetryAuth(error)
          return
        }
        // 滑动续签只能延长一个确实随请求发出的已登录会话。匿名请求（含公共读取的 401 降级）
        // 即使异常响应夹带续签头，也不得凭空创建客户端登录态。
        if (requestAuthToken) applyAuthRefresh(res, requestAuthToken, requestAuthSessionKey)
        resolve(body)
      },
      fail(error) {
        rejectNetwork(error)
      }
    }
    try {
      wx.request(requestOptions)
    } catch (error) {
      rejectNetwork(error)
    }
  })
}

function call(options) {
  return request(options).then((res) => res.data)
}

function uploadFile(options) {
  const config = getRuntimeConfig()

  if (shouldUseMock(config)) {
    const authorization = headerValue({ header: options.header || {} }, 'Authorization')
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i)
    const requestAuthToken = bearerMatch ? String(bearerMatch[1] || '') : ''
    const requestAuthSessionKey = requestAuthToken ? String(getAuthSessionKey(config) || '') : ''
    try {
      const mockData = typeof options.mock === 'function' ? options.mock() : null
      return Promise.resolve({
        code: 0,
        message: 'mock',
        data: mockData
      })
    } catch (error) {
      if (requestAuthToken) handleUnauthorized(error, requestAuthToken, requestAuthSessionKey)
      return Promise.reject(error)
    }
  }

  return new Promise((resolve, reject) => {
    const method = 'UPLOAD'
    const url = options.url
    const timeout = options.timeout || config.timeout
    const authorization = headerValue({ header: options.header || {} }, 'Authorization')
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i)
    const requestAuthToken = bearerMatch ? String(bearerMatch[1] || '') : ''
    const requestAuthSessionKey = requestAuthToken ? String(getAuthSessionKey(config) || '') : ''
    const startedAt = Date.now()
    const context = (extra = {}) => ({
      requestType: 'upload',
      method,
      url,
      timeout,
      durationMs: Date.now() - startedAt,
      ...extra
    })
    const rejectNetwork = (rawError) => {
      const errMsg = (rawError && (rawError.errMsg || rawError.message)) || '文件上传失败'
      const error = createRequestError(errMsg, context({
        errMsg,
        errorCode: rawError && (rawError.errno !== undefined ? rawError.errno : rawError.errorCode),
        networkError: true
      }))
      reportRequestError(error)
      reject(error)
    }
    // 大文件上传允许调用方覆盖超时（默认沿用全局 15s 会导致视频弱网必超时）
    let uploadTask
    const uploadOptions = {
      url,
      filePath: options.filePath,
      name: options.name || 'file',
      formData: options.formData || {},
      header: options.header || {},
      timeout,
      success(res) {
        let body = {}
        try {
          body = res.data ? JSON.parse(res.data) : {}
        } catch (error) {
          body = {}
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const normalized = normalizeResponse(body)
          const error = createRequestError(normalized.message || `文件上传失败：${res.statusCode}`, context({
            statusCode: res.statusCode,
            traceId: headerValue(res, 'X-Trace-Id')
          }))
          error.data = normalized.data || null
          if (requestAuthToken) handleUnauthorized(error, requestAuthToken, requestAuthSessionKey)
          reportRequestError(error)
          reject(error)
          return
        }

        if (requestAuthToken) applyAuthRefresh(res, requestAuthToken, requestAuthSessionKey)
        resolve(normalizeResponse(body))
      },
      fail(error) {
        rejectNetwork(error)
      }
    }
    try {
      uploadTask = wx.uploadFile(uploadOptions)
    } catch (error) {
      rejectNetwork(error)
      return
    }
    // 透传上传进度（0-100），供页面展示百分比
    if (typeof options.onProgress === 'function' && uploadTask && uploadTask.onProgressUpdate) {
      uploadTask.onProgressUpdate((event) => {
        options.onProgress(event.progress || 0, event)
      })
    }
  })
}

module.exports = {
  request,
  call,
  buildUrl,
  uploadFile,
  getAuthToken,
  getAuthSessionKey,
  authHeader,
  applyAuthRefresh,
  handleUnauthorized,
  isPublicReadAuthFallbackContinuation,
  subscribeAuthInvalidation,
  isStaleUnauthorized,
  headerValue,
  urlWithoutQuery,
  sanitizeDiagnosticText,
  createRequestError
}
