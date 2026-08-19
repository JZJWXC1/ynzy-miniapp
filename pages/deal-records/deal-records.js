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
  const commissionIntegrityValid = !item.commissionIntegrity || item.commissionIntegrity.valid !== false
  return Object.assign({}, item, {
    listingTitle: safeText(item.listingTitle) || '未命名房源',
    community: safeText(item.community) || '未填写小区',
    status: safeText(item.status) || '待管理员确认',
    createdAtDisplay: safeText(item.createdAt || item.time) || '-',
    monthlyRentText: formatFen(item.dealMonthlyRentFen),
    landlordCommissionText: formatFen(item.landlordCommissionFen),
    commissionRateText: commissionIntegrityValid ? `成交总比例 ${totalRate}%` : '分佣数据待复核',
    remarkDisplay: safeText(item.remark) || '无备注'
  })
}

Page({
  data: {
    deals: [],
    stats: [],
    loading: false,
    loadFailed: false
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this._recordsRequestSeq = (this._recordsRequestSeq || 0) + 1
    const requestSeq = this._recordsRequestSeq
    this.setData({ loading: true, loadFailed: false })
    apiService.getDealRecords().then((deals) => {
      if (requestSeq !== this._recordsRequestSeq) return
      const displayDeals = (deals || []).map(normalizeDeal)
      const pendingCount = displayDeals.filter((item) => item.status !== '已确认').length
      const confirmedCount = displayDeals.length - pendingCount
      this.setData({
        loading: false,
        loadFailed: false,
        deals: displayDeals,
        stats: [
          { label: '签单总数', value: String(displayDeals.length) },
          { label: '待确认', value: String(pendingCount) },
          { label: '已确认', value: String(confirmedCount) }
        ]
      })
    }).catch(() => {
      if (requestSeq !== this._recordsRequestSeq) return
      this.setData({ loading: false, loadFailed: true })
      wx.showToast({ title: '签单记录加载失败', icon: 'none' })
    })
  },

  retryRecords() {
    this.refresh()
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
