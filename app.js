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
    this.globalData.userId = storedUserId || 'U001'
    if (this.globalData.apiConfig.paymentMode === 'wechat') {
      this.bindWechatOpenid()
    }
  },

  setCurrentUser(user) {
    if (!user || !user.id) return
    this.globalData.user = user
    this.globalData.userId = user.id
    wx.setStorageSync('ynzy_user_id', user.id)
  },

  bindWechatOpenid() {
    if (!wx.login) return
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
    wx.removeStorageSync('ynzy_user_id')
  },

  globalData: {
    apiConfig: runtimeApiConfig,
    userId: '',
    user: null
  }
})
