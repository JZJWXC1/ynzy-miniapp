const apiService = require('../../utils/api-service')

function safeText(value) {
  return String(value || '').trim()
}

function maskPhone(phone) {
  const text = safeText(phone)
  return text.length >= 11 ? `${text.slice(0, 3)}****${text.slice(-4)}` : text
}

function normalizeReport(item = {}) {
  const dealId = safeText(item.dealId)
  const needId = safeText(item.needId || item.rentalNeedId)
  const status = safeText(item.status) || (dealId ? '已提交签单' : '已报备')
  return Object.assign({}, item, {
    needId,
    customerNameDisplay: safeText(item.customerName) || '未填写称呼',
    customerPhoneMasked: safeText(item.customerPhoneMasked) || maskPhone(item.customerPhone),
    createdAtDisplay: safeText(item.createdAt || item.time) || '-',
    status,
    canCreateDeal: !dealId
  })
}

Page({
  data: {
    reports: [],
    stats: [],
    loading: false,
    dealModalVisible: false,
    dealSubmitting: false,
    currentReport: {},
    dealForm: {
      monthlyRent: '',
      landlordCommission: '',
      remark: ''
    }
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({ loading: true })
    apiService.getClientReports().then((reports) => {
      const displayReports = (reports || []).map(normalizeReport)
      const waitingDealCount = displayReports.filter((item) => item.canCreateDeal).length
      const submittedDealCount = displayReports.length - waitingDealCount
      this.setData({
        loading: false,
        reports: displayReports,
        stats: [
          { label: '报备总数', value: String(displayReports.length) },
          { label: '待签单', value: String(waitingDealCount) },
          { label: '已提交', value: String(submittedDealCount) }
        ]
      })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '报备记录加载失败', icon: 'none' })
    })
  },

  noop() {},

  openListing(event) {
    const id = event.currentTarget.dataset.id
    const needId = event.currentTarget.dataset.needId || ''
    if (!id) return
    const query = needId ? `&needId=${encodeURIComponent(needId)}&source=report` : ''
    wx.navigateTo({ url: `/pages/listing-detail/listing-detail?id=${id}${query}` })
  },

  goFindListings() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goDealRecords() {
    wx.navigateTo({ url: '/pages/deal-records/deal-records' })
  },

  openDealModal(event) {
    const reportId = event.currentTarget.dataset.id
    const report = this.data.reports.find((item) => item.id === reportId)
    if (!report || !report.canCreateDeal) return
    this.setData({
      dealModalVisible: true,
      currentReport: report,
      dealForm: {
        monthlyRent: '',
        landlordCommission: '',
        remark: ''
      }
    })
  },

  closeDealModal() {
    if (this.data.dealSubmitting) return
    this.setData({ dealModalVisible: false, currentReport: {} })
  },

  updateDealField(event) {
    const field = event.currentTarget.dataset.field
    if (!field) return
    this.setData({ [`dealForm.${field}`]: event.detail.value })
  },

  submitDealFromReport() {
    const report = this.data.currentReport || {}
    const form = this.data.dealForm || {}
    const monthlyRent = Number(form.monthlyRent)
    const landlordCommission = Number(form.landlordCommission)

    if (!report.id) {
      wx.showToast({ title: '请选择报备记录', icon: 'none' })
      return
    }
    if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) {
      wx.showToast({ title: '请填写成交月租', icon: 'none' })
      return
    }
    if (!Number.isFinite(landlordCommission) || landlordCommission <= 0) {
      wx.showToast({ title: '请填写房东实付佣金', icon: 'none' })
      return
    }
    if (this.data.dealSubmitting) return

    this.setData({ dealSubmitting: true })
    apiService.createDealFromReport(report.id, {
      monthlyRent,
      landlordCommission,
      needId: report.needId || '',
      remark: safeText(form.remark)
    }).then((result) => {
      this.setData({
        dealSubmitting: false,
        dealModalVisible: false,
        currentReport: {}
      })
      wx.showModal({
        title: '签单已提交',
        content: (result && result.message) || '待管理员确认后生成正式分佣记录。',
        showCancel: false,
        success: () => {
          this.refresh()
        }
      })
    }).catch((error) => {
      this.setData({ dealSubmitting: false })
      wx.showModal({
        title: '签单失败',
        content: error && error.message ? error.message : '请稍后重试',
        showCancel: false
      })
    })
  }
})
