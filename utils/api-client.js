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
        if (app.globalData.apiConfig) app.globalData.apiConfig.token = ''
      }
    }
    if (typeof wx !== 'undefined') {
      if (wx.removeStorageSync) wx.removeStorageSync('ynzy_auth_token')
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

function handleUnauthorized(error, requestToken) {
  if (!error || Number(error.statusCode) !== 401) return
  const currentToken = String(getAuthToken(getRuntimeConfig()) || '')
  // 401 只能撤销发出该请求的同一会话。A 请求迟到时若用户已切到 B、刚从游客登录或主动退出，
  // 页面级序号还来不及拦住这里的全局副作用，因此必须先比较实际 Authorization token 快照。
  if (requestToken !== undefined && currentToken !== String(requestToken || '')) return
  // 游客（从未登录、无 token）浏览时，不要因为某个后台请求 401（如详情页的 getProfileState、
  // 或点到非公司房源）就被强制弹去登录页——那正是「一直跳转登录」的根源。只有原本已登录、
  // token 失效的用户才自动跳登录重新认证；游客只清理状态、不跳转，敏感操作各页面会显式引导登录。
  const hadToken = Boolean(currentToken)
  clearAuthState()
  if (hadToken) redirectToAuth()
}

function request(options) {
  const config = getRuntimeConfig()
  const method = options.method || 'GET'
  const data = options.data || {}

  if (shouldUseMock(config)) {
    try {
      const mockData = typeof options.mock === 'function' ? options.mock(data) : null
      return Promise.resolve({
        code: 0,
        message: 'mock',
        data: mockData
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  return new Promise((resolve, reject) => {
    const url = buildUrl(config.baseUrl, options.path)
    const timeout = options.timeout || config.timeout
    const requestAuthToken = String(getAuthToken(config) || '')
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
          reportRequestError(error)
          handleUnauthorized(error, requestAuthToken)
          reject(error)
          return
        }
        if (body.code && body.code !== 0) {
          const error = createRequestError(body.message || '接口业务失败', context({
            statusCode: res.statusCode,
            traceId
          }))
          error.data = body.data || null
          reportRequestError(error)
          handleUnauthorized(error, requestAuthToken)
          reject(error)
          return
        }
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
    try {
      const mockData = typeof options.mock === 'function' ? options.mock() : null
      return Promise.resolve({
        code: 0,
        message: 'mock',
        data: mockData
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  return new Promise((resolve, reject) => {
    const method = 'UPLOAD'
    const url = options.url
    const timeout = options.timeout || config.timeout
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
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = createRequestError(`文件上传失败：${res.statusCode}`, context({
            statusCode: res.statusCode,
            traceId: headerValue(res, 'X-Trace-Id')
          }))
          reportRequestError(error)
          reject(error)
          return
        }

        let body = {}
        try {
          body = res.data ? JSON.parse(res.data) : {}
        } catch (error) {
          body = {}
        }
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
  authHeader,
  handleUnauthorized,
  headerValue,
  urlWithoutQuery,
  sanitizeDiagnosticText,
  createRequestError
}
