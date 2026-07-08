const apiService = require('../../utils/api-service')

function safeText(value) {
  return String(value || '').trim()
}

function formatFen(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '-'
  const yuan = number / 100
  return `¥${yuan.toFixed(yuan % 1 === 0 ? 0 : 2)}`
}

function normalizeDeal(item = {}) {
  const rule = item.commissionRule || {}
  const totalRate = Number(item.uploaderCommissionRate || item.rate || rule.rate || 30)
  return Object.assign({}, item, {
    listingTitle: safeText(item.listingTitle) || '未命名房源',
    community: safeText(item.community) || '未填写小区',
    status: safeText(item.status) || '待管理员确认',
    createdAtDisplay: safeText(item.createdAt || item.time) || '-',
    monthlyRentText: formatFen(item.dealMonthlyRentFen),
    landlordCommissionText: formatFen(item.landlordCommissionFen),
    commissionRateText: `成交总比例 ${totalRate}%`,
    remarkDisplay: safeText(item.remark) || '无备注'
  })
}

Page({
  data: {
    deals: [],
    stats: [],
    loading: false
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({ loading: true })
    apiService.getDealRecords().then((deals) => {
      const displayDeals = (deals || []).map(normalizeDeal)
      const pendingCount = displayDeals.filter((item) => item.status !== '已确认').length
      const confirmedCount = displayDeals.length - pendingCount
      this.setData({
        loading: false,
        deals: displayDeals,
        stats: [
          { label: '签单总数', value: String(displayDeals.length) },
          { label: '待确认', value: String(pendingCount) },
          { label: '已确认', value: String(confirmedCount) }
        ]
      })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '签单记录加载失败', icon: 'none' })
    })
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/listing-detail/listing-detail?id=${id}` })
  },

  goReports() {
    wx.navigateTo({ url: '/pages/client-reports/client-reports' })
  }
})
