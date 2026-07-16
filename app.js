const { DEFAULT_API_CONFIG } = require('./utils/api-config')
const deployConfig = require('./utils/deploy-config')
const apiService = require('./utils/api-service')

function authExpiryTimestamp(value) {
  if (value === undefined || value === null || value === '') return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

// 仅用于客户端异步结果隔离，不参与服务端身份或权限判定。
function makeAuthSessionKey(prefix) {
  const random = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  return `${prefix || 'session'}_${Date.now().toString(36)}_${random}`
}

function persistAuthStorageAtomically({ token, expiresAt, userId }) {
  const writes = [
    ['ynzy_auth_token_expires_at', expiresAt],
    ...(userId === undefined ? [] : [['ynzy_user_id', userId]]),
    // bearer 最后写，作为这组本地凭证的提交标志；此前任一步失败都仍保留旧 token。
    ['ynzy_auth_token', token]
  ]
  const snapshots = new Map()
  const touched = []
  try {
    writes.forEach(([key]) => {
      const value = wx.getStorageSync(key)
      snapshots.set(key, { present: value !== undefined && value !== null && value !== '', value })
    })
    writes.forEach(([key, value]) => {
      // 先登记再写，兼容“底层已落值后才抛错”的实现；回滚会覆盖这一键。
      touched.push(key)
      wx.setStorageSync(key, value)
    })
    return true
  } catch (error) {
    touched.reverse().forEach((key) => {
      const snapshot = snapshots.get(key)
      try {
        if (snapshot && snapshot.present) wx.setStorageSync(key, snapshot.value)
        else wx.removeStorageSync(key)
      } catch (rollbackError) {}
    })
    return false
  }
}

function resolveRuntimeApiConfig() {
  const next = Object.assign({}, DEFAULT_API_CONFIG, deployConfig)
  try {
    const systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    if (systemInfo.platform === 'devtools' && deployConfig.useLocalInDevtools) {
      next.env = deployConfig.devtoolsEnv || 'local'
      next.baseUrl = deployConfig.devtoolsBaseUrl || 'http://127.0.0.1:3000'
    }
  } catch (error) {}
  return next
}

const runtimeApiConfig = resolveRuntimeApiConfig()

App({
  onLaunch() {
    const storedUserId = wx.getStorageSync('ynzy_user_id')
    const storedToken = wx.getStorageSync('ynzy_auth_token')
    const storedExpiryRaw = wx.getStorageSync('ynzy_auth_token_expires_at')
    const storedExpiry = authExpiryTimestamp(storedExpiryRaw)
    const explicitlyInvalidOrExpired = Boolean(storedToken && storedExpiryRaw && (!storedExpiry || storedExpiry <= Date.now()))
    if (explicitlyInvalidOrExpired) {
      this.logout({ silent: true })
      return
    }
    this.globalData.userId = storedToken ? (storedUserId || '') : ''
    this.globalData.authToken = storedToken || ''
    this.globalData.authTokenExpiresAt = storedExpiry || ''
    this.globalData.authSessionKey = makeAuthSessionKey(storedToken ? 'auth' : 'guest')
    this.globalData.apiConfig.token = storedToken || ''
    if (!storedToken) {
      wx.removeStorageSync('ynzy_user_id')
      wx.removeStorageSync('ynzy_auth_token_expires_at')
    }
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
    const expiresAt = authExpiryTimestamp(tokenExpiresAt)
    if (!token || !expiresAt || expiresAt <= Date.now()) return false
    if (!persistAuthStorageAtomically({ token, expiresAt, userId: user.id })) return false
    this.globalData.user = profile
    this.globalData.userId = user.id
    this.globalData.authToken = token
    this.globalData.authTokenExpiresAt = expiresAt
    this.globalData.authSessionKey = makeAuthSessionKey('auth')
    this.globalData.apiConfig.token = token
    return true
  },

  refreshAuthToken(token, tokenExpiresAt, expectedToken) {
    const nextToken = String(token || '')
    const currentToken = String(this.globalData.authToken || '')
    const expiresAt = authExpiryTimestamp(tokenExpiresAt)
    const currentExpiresAt = authExpiryTimestamp(this.globalData.authTokenExpiresAt || wx.getStorageSync('ynzy_auth_token_expires_at'))
    if (!nextToken || !currentToken || currentToken !== String(expectedToken || '')) return false
    if (!expiresAt || expiresAt <= Date.now() || expiresAt <= currentExpiresAt) return false
    if (!persistAuthStorageAtomically({ token: nextToken, expiresAt })) return false
    this.globalData.authToken = nextToken
    this.globalData.authTokenExpiresAt = expiresAt
    if (!this.globalData.authSessionKey) this.globalData.authSessionKey = makeAuthSessionKey('auth')
    this.globalData.apiConfig.token = nextToken
    return true
  },

  bindWechatOpenid() {
    // 第一版为人工支付，OpenID 绑定只属于未来微信支付模式。把门禁放在方法本身，
    // 确保登录页及后续任何调用者都不会在 manual 模式误发预留接口请求。
    if (this.globalData.apiConfig.paymentMode !== 'wechat') return
    if (!wx.login) return
    if (!this.globalData.authToken) return
    const sessionKey = this.globalData.authSessionKey
    wx.login({
      success: (res) => {
        if (!res.code || this.globalData.authSessionKey !== sessionKey || !this.globalData.authToken) return
        apiService.bindWechatOpenid(res.code).then((user) => {
          if (this.globalData.authSessionKey === sessionKey && user && user.id) {
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
    this.globalData.authTokenExpiresAt = ''
    this.globalData.authSessionKey = makeAuthSessionKey('guest')
    this.globalData.apiConfig.token = ''
    wx.removeStorageSync('ynzy_user_id')
    wx.removeStorageSync('ynzy_auth_token')
    wx.removeStorageSync('ynzy_auth_token_expires_at')
  },

  globalData: {
    apiConfig: runtimeApiConfig,
    userId: '',
    authToken: '',
    authTokenExpiresAt: '',
    authSessionKey: '',
    user: null
  }
})
