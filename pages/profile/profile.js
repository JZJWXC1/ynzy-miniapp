// profile.js
const apiService = require('../../utils/api-service')

const hiddenV1EntryKeywords = ['房源群', '换群', '积分', '充值', '微信支付']

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

function findStatValue(stats = [], keywords = [], fallback = 0) {
  const item = stats.find((stat) => {
    const label = String(stat.label || stat.title || '')
    return keywords.some((keyword) => label.includes(keyword))
  })
  return item ? item.value : fallback
}

function buildDealWorkbench(reportCount = 0, dealCount = 0) {
  return [
    {
      title: '我的报备',
      desc: '客户称呼可选，客户手机号必填',
      status: `${reportCount} 条`,
      url: '/pages/client-reports/client-reports'
    },
    {
      title: '我的签单',
      desc: '从报备记录发起签单，跟进管理员确认状态',
      status: `${dealCount} 单`,
      url: '/pages/deal-records/deal-records'
    }
  ]
}

Page({
  data: {
    user: {},
    workbench: [],
    dealWorkbench: buildDealWorkbench(),
    reminders: [
      { title: '敏感信息查看', value: '今天有人查看了你上传房源的电话' },
      { title: '待确认分佣', value: '有成交单待确认，签单后按配置快照结算' },
      { title: '房态维护', value: '第3天提醒，第5天再次提醒，第7天未更新自动失效' }
    ],
    sourceStats: [],
    footprintCount: 0
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    this.refreshProfile();
  },

  buildWorkbench(profile, footprintCount) {
    const sourceStats = profile.sourceStats || []
    const listingCount = findStatValue(sourceStats, ['房源', '上传'], sourceStats[0] ? sourceStats[0].value : 0)
    const commissionCount = findStatValue(sourceStats, ['分佣', '成交'], sourceStats[2] ? sourceStats[2].value : 0)
    // 工作台精简：只保留功能名称 + 数值徽标，去掉每项的说明文字（desc 已从卡片模板移除）。
    return [
      { title: '我的房源', value: `${listingCount} 套`, url: '/pages/my-listings/my-listings' },
      { title: '上传房源', value: '视频房源', url: '/pages/upload/upload' },
      { title: '房源足迹', value: `${footprintCount} 条`, url: '/pages/footprint/footprint' },
      { title: '分佣记录', value: `${commissionCount} 单`, url: '/pages/commissions/commissions' },
      { title: '房态维护', value: '3/5/7天', url: '/pages/my-listings/my-listings' },
      { title: '登录与账号信息', value: profile.user && profile.user.authed ? profile.user.authed : '账号', url: '/pages/auth/auth' }
    ];
  },

  refreshProfile() {
    Promise.all([
      apiService.getProfileState(),
      apiService.getFootprintRecords(),
      apiService.getClientReports(),
      apiService.getDealRecords()
    ]).then(([profile, footprints, reports, deals]) => {
      this.setData({
        user: profile.user,
        sourceStats: filterVisibleStats(profile.sourceStats || []),
        footprintCount: footprints.length,
        reminders: filterVisibleReminders(profile.reminders || this.data.reminders),
        workbench: this.buildWorkbench(profile, footprints.length),
        dealWorkbench: buildDealWorkbench((reports || []).length, (deals || []).length)
      });
    }).catch((error) => {
      if (isAuthError(error)) {
        this.promptLoginGuide()
        return
      }
      wx.showToast({ title: '我的信息加载失败', icon: 'none' })
    });
  },

  promptLoginGuide() {
    wx.showModal({
      title: '登录后进入我的',
      content: '我的房源、足迹、报备、签单和分佣记录需要登录内部中介账号后查看。',
      cancelText: '先看看',
      confirmText: '去登录',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/auth/auth' })
      }
    })
  },

  logout() {
    const app = typeof getApp === 'function' ? getApp() : null
    if (app && typeof app.logout === 'function') app.logout()
    wx.showToast({ title: '已退出登录', icon: 'none' })
    wx.switchTab({ url: '/pages/index/index' })
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
