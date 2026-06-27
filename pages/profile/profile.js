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
    dealWorkbench: [
      { title: '我的报备', desc: '客户称呼可选，客户手机号必填', status: '报备记录' },
      { title: '我的签单', desc: '从报备记录发起签单，签单后按平台规则计算', status: '签单入口' }
    ],
    reminders: [
      { title: '敏感信息查看', value: '今天有人查看了你上传房源的电话' },
      { title: '待确认分佣', value: '有成交单待确认，签单后按平台规则计算' },
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
    return [
      { title: '我的房源', value: `${listingCount} 套`, desc: '查看自己上传的房源', url: '/pages/my-listings/my-listings' },
      { title: '上传房源', value: '视频房源', desc: '上传真实可租房源', url: '/pages/upload/upload' },
      { title: '房源足迹', value: `${footprintCount} 条`, desc: '查看地址电话访问记录', url: '/pages/footprint/footprint' },
      { title: '分佣记录', value: `${commissionCount} 单`, desc: '查看已确认的分佣记录', url: '/pages/commissions/commissions' },
      { title: '房态维护', value: '3/5/7天', desc: '维护在租状态和失效提醒', url: '/pages/my-listings/my-listings' },
      { title: '登录与账号信息', value: profile.user && profile.user.authed ? profile.user.authed : '账号', desc: '查看或切换当前登录账号', url: '/pages/auth/auth' }
    ];
  },

  refreshProfile() {
    Promise.all([
      apiService.getProfileState(),
      apiService.getFootprintRecords()
    ]).then(([profile, footprints]) => {
      this.setData({
        user: profile.user,
        sourceStats: filterVisibleStats(profile.sourceStats || []),
        footprintCount: footprints.length,
        reminders: filterVisibleReminders(profile.reminders || this.data.reminders),
        workbench: this.buildWorkbench(profile, footprints.length)
      });
    }).catch(() => {
      wx.showToast({ title: '我的信息加载失败', icon: 'none' })
    });
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
    if (name === '我的报备') {
      wx.showModal({
        title: '我的报备',
        content: '第一版报备保持轻量：客户称呼可选，客户手机号必填，用于沉淀中介客户跟进记录。',
        showCancel: false
      });
      return;
    }
    if (name === '我的签单') {
      wx.showModal({
        title: '我的签单',
        content: '签单从报备记录发起，只记录成交月租、房东实际支付佣金和可选备注，签单后按平台规则计算。',
        showCancel: false
      });
      return;
    }
    wx.showModal({
      title: name,
      content: '该模块已接入当前账号数据，会随房源、足迹和分佣记录自动更新。',
      showCancel: false
    });
  }
})
