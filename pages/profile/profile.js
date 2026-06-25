// profile.js
const apiService = require('../../utils/api-service')

Page({
  data: {
    user: {},
    points: 0,
    rechargeCount: 1,
    rechargeUnitPrice: 20,
    rechargeAmount: 20,
    workbench: [],
    reminders: [
      { title: '敏感信息查看', value: '今天有人查看了你上传房源的电话' },
      { title: '待确认分佣', value: '有成交单待确认，按上传人设置比例结算' },
      { title: '后台登录提示', value: '管理员请打开 admin-web/index.html' }
    ],
    sourceStats: [],
    rechargeBills: [],
    footprintCount: 0
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    this.refreshProfile();
  },

  buildWorkbench(profile, footprintCount) {
    return [
      { title: '我的房源', value: `${profile.sourceStats[0].value} 套`, desc: '查看上传房源和访问足迹', url: '/pages/my-listings/my-listings' },
      { title: '上传房源', value: '普通', desc: '只传视频，不增加积分', url: '/pages/upload/upload' },
      { title: '积分充值', value: '20元/分', desc: '后台确认后到账' },
      { title: '我的积分', value: `${profile.points} 分`, desc: '群聊审核通过或充值确认后获得' },
      { title: '查看足迹', value: `${footprintCount} 条`, desc: '地址电话查看记录', url: '/pages/footprint/footprint' },
      { title: '分佣记录', value: `${profile.sourceStats[2].value} 单`, desc: '按上传人设置比例结算', url: '/pages/commissions/commissions' },
      { title: '管理后台', value: 'WEB', desc: '管理员电脑端登录查看' }
    ];
  },

  refreshProfile() {
    Promise.all([
      apiService.getProfileState(),
      apiService.getFootprintRecords()
    ]).then(([profile, footprints]) => {
      this.setData({
        user: profile.user,
        points: profile.points,
        sourceStats: profile.sourceStats,
        rechargeBills: profile.rechargeBills,
        footprintCount: footprints.length,
        reminders: profile.reminders || this.data.reminders,
        workbench: this.buildWorkbench(profile, footprints.length)
      });
    }).catch(() => {
      wx.showToast({ title: '我的信息加载失败', icon: 'none' })
    });
  },

  updateRechargeCount(count) {
    const next = Math.max(1, Math.floor(Number(count) || 1));
    this.setData({
      rechargeCount: next,
      rechargeAmount: next * this.data.rechargeUnitPrice
    });
  },

  decreaseRecharge() {
    this.updateRechargeCount(Number(this.data.rechargeCount) - 1);
  },

  increaseRecharge() {
    this.updateRechargeCount(Number(this.data.rechargeCount) + 1);
  },

  handleRechargeInput(event) {
    this.updateRechargeCount(event.detail.value);
  },

  submitRecharge() {
    const count = Math.max(1, Number(this.data.rechargeCount) || 1);
    apiService.rechargePoints(count).then((result) => {
      const profile = result.profile || result;
      this.setData({
        rechargeCount: 1,
        rechargeAmount: this.data.rechargeUnitPrice,
        user: profile.user,
        points: profile.points,
        sourceStats: profile.sourceStats,
        rechargeBills: profile.rechargeBills,
        reminders: profile.reminders || this.data.reminders,
        workbench: this.buildWorkbench(profile, this.data.footprintCount)
      });

      if (result.payment && wx.requestPayment) {
        wx.requestPayment(Object.assign({}, result.payment, {
          success: () => {
            wx.showToast({ title: '支付成功，等待到账', icon: 'success' });
            setTimeout(() => this.refreshProfile(), 1200);
          },
          fail: () => {
            wx.showToast({ title: '支付未完成', icon: 'none' });
          }
        }));
        return;
      }

      wx.showToast({
        title: `已提交${count}分申请`,
        icon: 'none'
      });
    }).catch(() => {
      wx.showToast({ title: '充值申请失败', icon: 'none' })
    });
  },

  handleTap(event) {
    const name = event.currentTarget.dataset.name || '功能';
    const url = event.currentTarget.dataset.url;
    if (url) {
      wx.navigateTo({ url });
      return;
    }
    if (name === 'WEB管理后台' || name === '管理后台') {
      wx.showModal({
        title: 'WEB管理后台',
        content: '请在电脑浏览器打开 https://zf-api.ynzyqbot.cn/admin-web/，使用管理员账号登录查看全公司数据。',
        showCancel: false
      });
      return;
    }
    if (name === '积分充值') {
      wx.showToast({ title: '后台确认收款后积分到账', icon: 'none' });
      return;
    }
    if (name === '我的积分') {
      wx.switchTab({ url: '/pages/groups/groups' });
      return;
    }
    if (name === '查看全部提醒') {
      wx.switchTab({ url: '/pages/footprint/footprint' });
      return;
    }
    wx.showModal({
      title: name,
      content: '该模块已接入当前账号数据，会随房源、足迹、积分和分佣记录自动更新。',
      showCancel: false
    });
  }
})
