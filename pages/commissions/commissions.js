const apiService = require('../../utils/api-service')

Page({
  data: {
    records: [],
    stats: []
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    apiService.getCommissionRecords().then((records) => {
      const uploadCount = records.filter((item) => item.role === '我是上传人').length
      const dealCount = records.filter((item) => item.role === '我是成交人').length
      const pendingCount = records.filter((item) => item.status !== '已确认').length
      this.setData({
        records,
        stats: [
          { label: '我上传', value: String(uploadCount) },
          { label: '我成交', value: String(dealCount) },
          { label: '待确认', value: String(pendingCount) }
        ]
      })
    }).catch(() => {
      wx.showToast({ title: '分佣记录加载失败', icon: 'none' })
    })
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/listing-detail/listing-detail?id=${id}` })
  }
})
