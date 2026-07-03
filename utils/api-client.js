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

function getCurrentUserId() {
  try {
    if (typeof getApp === 'function') {
      const app = getApp()
      if (app && app.globalData && app.globalData.userId) {
        return app.globalData.userId
      }
    }
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      return wx.getStorageSync('ynzy_user_id') || ''
    }
  } catch (error) {
    return ''
  }
  return ''
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
      timeout: config.timeout,
      header: {
        'content-type': 'application/json',
        Authorization: config.token ? `Bearer ${config.token}` : '',
        'X-User-Id': getCurrentUserId()
      },
      success(res) {
        const body = normalizeResponse(res.data)
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(body.message || `接口请求失败：${res.statusCode}`)
          error.statusCode = res.statusCode
          error.data = body.data || null
          reject(error)
          return
        }
        if (body.code && body.code !== 0) {
          const error = new Error(body.message || '接口业务失败')
          error.statusCode = res.statusCode
          error.data = body.data || null
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
  uploadFile
}
