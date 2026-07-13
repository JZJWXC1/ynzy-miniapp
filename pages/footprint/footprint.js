// footprint.js
const apiService = require('../../utils/api-service')

Page({
  data: {
    stats: [],
    filters: ['我的房源被查看', '电话查看'],
    activeFilter: '我的房源被查看',
    records: [],
    allRecords: [],
    loading: false,
    loadFailed: false,
    tasks: [
      '已登录账号查看敏感信息会由服务端留痕',
      '上传人可以查看自己房源的地址和电话访问记录',
      '管理员后台可查看全公司敏感信息访问记录'
    ]
  },

  onShow() {
    this.refreshRecords();
  },

  refreshRecords() {
    this._recordsRequestSeq = (this._recordsRequestSeq || 0) + 1
    const requestSeq = this._recordsRequestSeq
    this.setData({ loading: true, loadFailed: false })
    apiService.getFootprintRecords().then((records) => {
      if (requestSeq !== this._recordsRequestSeq) return
      const phoneCount = records.filter((item) => String(item.status || '').indexOf('电话') !== -1).length;
      const addressCount = records.filter((item) => String(item.status || '').indexOf('地址') !== -1).length;
      const myViewCount = records.filter((item) => item.direction === '我查看的').length;
      const viewMineCount = records.filter((item) => item.direction === '我的房源被查看').length;
      this.setData({
        loading: false,
        loadFailed: false,
        allRecords: records,
        stats: [
          { label: '我查看', value: String(myViewCount) },
          { label: '看我房', value: String(viewMineCount) },
          { label: '电话查看', value: String(phoneCount) },
          { label: '地址查看', value: String(addressCount) }
        ]
      });
      this.applyFilter(this.data.activeFilter);
    }).catch(() => {
      if (requestSeq !== this._recordsRequestSeq) return
      this.setData({ loading: false, loadFailed: true })
      wx.showToast({ title: '足迹加载失败', icon: 'none' })
    });
  },

  retryRecords() {
    this.refreshRecords()
  },

  applyFilter(name) {
    const records = this.data.allRecords.filter((item) => {
      if (name === '电话查看') return String(item.status || '').indexOf('电话') !== -1;
      return item.direction === '我的房源被查看';
    });
    this.setData({ records });
  },

  switchFilter(event) {
    const activeFilter = event.currentTarget.dataset.name;
    this.setData({ activeFilter });
    this.applyFilter(activeFilter);
  },

  handleTap(event) {
    const name = event.currentTarget.dataset.name || '操作';
    if (name === '按房源查看') {
      this.setData({ activeFilter: '我的房源被查看' });
      this.applyFilter('我的房源被查看');
      wx.showToast({ title: '已筛选我的房源', icon: 'none' });
      return;
    }
    if (name === '新增提醒') {
      wx.showModal({
        title: '自动提醒',
        content: '第一版会根据敏感信息查看、带看、分佣和房态核验自动生成提醒，暂不需要手动新增。',
        showCancel: false
      });
    }
  }
})
