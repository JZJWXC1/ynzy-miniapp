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

function handleUnauthorized(error) {
  if (!error || Number(error.statusCode) !== 401) return
  // 游客（从未登录、无 token）浏览时，不要因为某个后台请求 401（如详情页的 getProfileState、
  // 或点到非公司房源）就被强制弹去登录页——那正是「一直跳转登录」的根源。只有原本已登录、
  // token 失效的用户才自动跳登录重新认证；游客只清理状态、不跳转，敏感操作各页面会显式引导登录。
  const hadToken = Boolean(getAuthToken())
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
    wx.request({
      url: buildUrl(config.baseUrl, options.path),
      method,
      data,
      timeout: options.timeout || config.timeout,
      header: {
        'content-type': 'application/json',
        ...authHeader(config)
      },
      success(res) {
        const body = normalizeResponse(res.data)
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(body.message || `接口请求失败：${res.statusCode}`)
          error.statusCode = res.statusCode
          error.data = body.data || null
          handleUnauthorized(error)
          reject(error)
          return
        }
        if (body.code && body.code !== 0) {
          const error = new Error(body.message || '接口业务失败')
          error.statusCode = res.statusCode
          error.data = body.data || null
          handleUnauthorized(error)
          reject(error)
          return
        }
        resolve(body)
      },
      fail(error) {
        reject(new Error(error.errMsg || '网络请求失败'))
      }
    })
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
    // 大文件上传允许调用方覆盖超时（默认沿用全局 15s 会导致视频弱网必超时）
    const uploadTask = wx.uploadFile({
      url: options.url,
      filePath: options.filePath,
      name: options.name || 'file',
      formData: options.formData || {},
      header: options.header || {},
      timeout: options.timeout || config.timeout,
      success(res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`文件上传失败：${res.statusCode}`))
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
        reject(new Error(error.errMsg || '文件上传失败'))
      }
    })
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
  handleUnauthorized
}
