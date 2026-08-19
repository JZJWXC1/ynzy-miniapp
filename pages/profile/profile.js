// profile.js
const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')

const hiddenV1EntryKeywords = ['房源群', '换群', '积分', '充值', '微信支付', '报备', '签单']
const defaultReminders = [
  { title: '敏感信息查看', value: '今天有人查看了你上传房源的电话' },
  { title: '房态维护', value: '第3天提醒，第5天再次提醒，第7天未更新自动失效' }
]

function isV1VisibleText(value) {
  const text = String(value || '')
  return !hiddenV1EntryKeywords.some((keyword) => text.includes(keyword))
}

function filterVisibleStats(stats = []) {
  return stats.filter((item) => isV1VisibleText(item.label) && isV1VisibleText(item.value))
}

function filterVisibleReminders(reminders = []) {
  return reminders.filter((item) => isV1VisibleText(item.title) && isV1VisibleText(item.value))
}

function isAuthError(error) {
  return error && (error.statusCode === 401 || error.statusCode === 403)
}

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}

function findStatValue(stats = [], keywords = [], fallback = 0) {
  const item = stats.find((stat) => {
    const label = String(stat.label || stat.title || '')
    return keywords.some((keyword) => label.includes(keyword))
  })
  return item ? item.value : fallback
}

Page({
  data: {
    user: {},
    workbench: [],
    reminders: [],
    sourceStats: [],
    footprintCount: 0,
    profileReady: false,
    profileLoading: false,
    profileLoadFailed: false,
    profileAccessRequired: false,
    logoutSubmitting: false
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    this.refreshProfile();
  },

  onUnload() {
    this._profileRequestSeq = (this._profileRequestSeq || 0) + 1
    this._logoutRequestSeq = (this._logoutRequestSeq || 0) + 1
  },

  resetProfileForAccount(token) {
    if (this._profileAccountToken !== token) {
      // A 的退出仍在途时切到 B：立即作废旧退出代次并释放按钮，B 不必等待 A 的网络结果。
      this._logoutRequestSeq = (this._logoutRequestSeq || 0) + 1
    }
    this._profileAccountToken = token
    this.setData({
      user: {},
      workbench: [],
      reminders: [],
      sourceStats: [],
      footprintCount: 0,
      profileReady: false,
      profileLoadFailed: false,
      profileAccessRequired: false,
      logoutSubmitting: false
    })
  },

  buildWorkbench(profile, footprintCount) {
    const sourceStats = profile.sourceStats || []
    const listingCount = findStatValue(sourceStats, ['房源', '上传'], sourceStats[0] ? sourceStats[0].value : 0)
    const commissionCount = findStatValue(sourceStats, ['分佣', '成交'], 0)
    // 工作台精简：只保留功能名称 + 数值徽标，去掉每项的说明文字（desc 已从卡片模板移除）。
    return [
      { title: '我的房源', value: `${listingCount} 套`, url: '/pages/my-listings/my-listings' },
      { title: '我的收藏', value: `${Number(profile.favoriteCount || 0)} 套`, url: '/pages/favorites/favorites' },
      { title: '上传房源', value: '视频房源', url: '/pages/upload/upload' },
      { title: '房源足迹', value: `${footprintCount} 条`, url: '/pages/footprint/footprint' },
      { title: '分佣记录', value: `${commissionCount} 单`, url: '/pages/commissions/commissions' },
      { title: '房态维护', value: '3/5/7天', url: '/pages/my-listings/my-listings' },
      { title: '登录与账号信息', value: profile.user && profile.user.authed ? profile.user.authed : '账号', url: '/pages/auth/auth' }
    ];
  },

  refreshProfile() {
    this._profileRequestSeq = (this._profileRequestSeq || 0) + 1
    const requestSeq = this._profileRequestSeq
    const requestToken = String(apiClient.getAuthToken() || '')
    const requestSessionKey = currentAuthSessionKey()
    if (this._profileAccountToken !== requestSessionKey) this.resetProfileForAccount(requestSessionKey)
    // “我的”包含公开 FAQ。游客无需先打两个受保护接口，更不能因预期 401 弹窗挡住帮助入口。
    if (!requestToken) {
      this.setData({
        profileLoading: false,
        profileLoadFailed: false,
        profileAccessRequired: true
      })
      return Promise.resolve()
    }
    this.setData({
      profileLoading: true,
      profileLoadFailed: false,
      profileAccessRequired: false
    })
    Promise.all([
      apiService.getProfileState(),
      apiService.getFootprintRecords()
    ]).then(([profile, footprints]) => {
      if (requestSeq !== this._profileRequestSeq) return
      const currentSessionKey = currentAuthSessionKey()
      if (currentSessionKey !== requestSessionKey) {
        this.resetProfileForAccount(currentSessionKey)
        this.setData({
          profileLoading: false,
          profileAccessRequired: !apiClient.getAuthToken()
        })
        return
      }
      this.setData({
        profileReady: true,
        profileLoading: false,
        profileLoadFailed: false,
        profileAccessRequired: false,
        user: profile.user,
        sourceStats: filterVisibleStats(profile.sourceStats || []),
        footprintCount: footprints.length,
        reminders: filterVisibleReminders(profile.reminders || defaultReminders),
        workbench: this.buildWorkbench(profile, footprints.length)
      });
    }).catch((error) => {
      if (requestSeq !== this._profileRequestSeq) return
      const currentSessionKey = currentAuthSessionKey()
      if (currentSessionKey !== requestSessionKey) {
        this.resetProfileForAccount(currentSessionKey)
        this.setData({
          profileLoading: false,
          profileAccessRequired: !apiClient.getAuthToken()
        })
        return
      }
      const currentToken = String(apiClient.getAuthToken() || '')
      if (isAuthError(error) && currentToken && currentToken !== requestToken) {
        // 同一账号已由 A 滑动续签成 A′，旧 A 的迟到鉴权错误不能把 A′ 页面改成未登录。
        // 读取接口由当前 token 重拉；写接口不在这里自动重放。
        this.refreshProfile()
        return
      }
      if (isAuthError(error)) {
        this.setData({
          user: {},
          workbench: [],
          reminders: [],
          sourceStats: [],
          footprintCount: 0,
          profileReady: false,
          profileLoading: false,
          profileLoadFailed: false,
          profileAccessRequired: true
        })
        return
      }
      this.setData({
        profileLoading: false,
        profileLoadFailed: true,
        profileAccessRequired: false
      })
      wx.showToast({ title: '我的信息加载失败', icon: 'none' })
    });
  },

  retryProfile() {
    this.refreshProfile()
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/auth/auth' })
  },

  promptLoginGuide() {
    wx.showModal({
      title: '登录后进入我的',
      content: '我的房源、收藏、足迹和分佣记录需要登录内部中介账号后查看。',
      cancelText: '先看看',
      confirmText: '去登录',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/auth/auth' })
      }
    })
  },

  logout() {
    if (this.data.logoutSubmitting) return
    wx.showModal({
      title: '退出全部设备？',
      content: '退出后，本账号在其他设备也需要重新登录。',
      confirmText: '确认退出',
      success: (modal) => {
        if (!modal.confirm) return
        const requestSessionKey = currentAuthSessionKey()
        const requestSeq = (this._logoutRequestSeq || 0) + 1
        this._logoutRequestSeq = requestSeq
        const isCurrentRequest = () => (
          requestSeq === this._logoutRequestSeq && currentAuthSessionKey() === requestSessionKey
        )
        this.setData({ logoutSubmitting: true })
        apiService.logout().then(() => {
          if (!isCurrentRequest()) return
          const app = typeof getApp === 'function' ? getApp() : null
          if (app && typeof app.logout === 'function') app.logout()
          wx.showToast({ title: '所有设备已退出', icon: 'none' })
          wx.switchTab({ url: '/pages/index/index' })
        }).catch((error) => {
          if (!isCurrentRequest()) return
          if (typeof apiClient.isStaleUnauthorized === 'function' && apiClient.isStaleUnauthorized(error)) {
            wx.showToast({ title: '登录状态已更新，请重新退出', icon: 'none' })
            return
          }
          if (Number(error && error.statusCode) === 401) {
            const app = typeof getApp === 'function' ? getApp() : null
            if (app && typeof app.logout === 'function') app.logout()
            wx.showToast({ title: '登录已失效，已退出', icon: 'none' })
            wx.switchTab({ url: '/pages/index/index' })
            return
          }
          wx.showModal({
            title: '退出失败',
            content: (error && error.message) || '网络异常，服务端尚未确认退出，请检查网络后重试。',
            showCancel: false
          })
        }).finally(() => {
          if (requestSeq === this._logoutRequestSeq) this.setData({ logoutSubmitting: false })
        })
      }
    })
  },

  handleTap(event) {
    const name = event.currentTarget.dataset.name || '功能';
    const url = event.currentTarget.dataset.url;
    if (url) {
      wx.navigateTo({ url });
      return;
    }
    if (name === '查看全部提醒') {
      wx.navigateTo({ url: '/pages/footprint/footprint' });
      return;
    }
    wx.showModal({
      title: name,
      content: '该模块已接入当前账号数据，会随房源、足迹和分佣记录自动更新。',
      showCancel: false
    });
  }
})
