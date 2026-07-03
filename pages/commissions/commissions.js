const apiService = require('../../utils/api-service')

function formatFen(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '¥0'
  const yuan = number / 100
  return `¥${yuan.toFixed(yuan % 1 === 0 ? 0 : 2)}`
}

function normalizeCommission(item = {}) {
  const uploaderRate = Number(item.uploaderRate === undefined ? 20 : item.uploaderRate)
  return Object.assign({}, item, {
    settlementRule: `上传人到手 ${uploaderRate}%`,
    uploaderCommissionText: item.uploaderCommission || formatFen(item.uploaderCommissionFen || 0),
    platformCommissionText: item.platformCommission || formatFen(item.platformCommissionFen || 0)
  })
}

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
      const displayRecords = (records || []).map(normalizeCommission)
      const uploadCount = displayRecords.filter((item) => item.role === '我是上传人').length
      const dealCount = displayRecords.filter((item) => item.role === '我是成交人').length
      const pendingCount = displayRecords.filter((item) => item.status !== '已确认').length
      this.setData({
        records: displayRecords,
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
