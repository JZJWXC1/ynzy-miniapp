const { DEFAULT_API_CONFIG } = require('./utils/api-config')
const deployConfig = require('./utils/deploy-config')
const apiService = require('./utils/api-service')

function resolveRuntimeApiConfig() {
  const next = Object.assign({}, DEFAULT_API_CONFIG, deployConfig)
  try {
    const systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    if (systemInfo.platform === 'devtools') {
      next.env = 'local'
      next.baseUrl = 'http://127.0.0.1:3000'
    }
  } catch (error) {}
  return next
}

const runtimeApiConfig = resolveRuntimeApiConfig()

App({
  onLaunch() {
    const storedUserId = wx.getStorageSync('ynzy_user_id')
    const storedToken = wx.getStorageSync('ynzy_auth_token')
    this.globalData.userId = storedUserId || ''
    this.globalData.authToken = storedToken || ''
    this.globalData.apiConfig.token = storedToken || ''
    if (storedToken && this.globalData.apiConfig.paymentMode === 'wechat') {
      this.bindWechatOpenid()
    }
  },

  setCurrentUser(user) {
    if (!user || !user.id) return
    const profile = Object.assign({}, user)
    const token = profile.token || ''
    const tokenExpiresAt = profile.tokenExpiresAt || ''
    delete profile.token
    delete profile.tokenExpiresAt
    this.globalData.user = profile
    this.globalData.userId = user.id
    if (token) {
      this.globalData.authToken = token
      this.globalData.apiConfig.token = token
      wx.setStorageSync('ynzy_auth_token', token)
      if (tokenExpiresAt) wx.setStorageSync('ynzy_auth_token_expires_at', tokenExpiresAt)
    }
    wx.setStorageSync('ynzy_user_id', user.id)
  },

  bindWechatOpenid() {
    if (!wx.login) return
    if (!this.globalData.authToken) return
    wx.login({
      success: (res) => {
        if (!res.code) return
        apiService.bindWechatOpenid(res.code).then((user) => {
          if (user && user.id) {
            this.globalData.user = user
          }
        }).catch(() => {})
      }
    })
  },

  logout() {
    this.globalData.user = null
    this.globalData.userId = ''
    this.globalData.authToken = ''
    this.globalData.apiConfig.token = ''
    wx.removeStorageSync('ynzy_user_id')
    wx.removeStorageSync('ynzy_auth_token')
    wx.removeStorageSync('ynzy_auth_token_expires_at')
  },

  globalData: {
    apiConfig: runtimeApiConfig,
    userId: '',
    authToken: '',
    user: null
  }
})
