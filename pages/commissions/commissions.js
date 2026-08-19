const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}

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
    stats: [],
    loading: false,
    loadFailed: false
  },

  onShow() {
    this._pageActive = true
    this.syncAuthSession()
    this.refresh()
  },

  onUnload() {
    this._pageActive = false
    this._recordsRequestSeq = Number(this._recordsRequestSeq || 0) + 1
  },

  syncAuthSession() {
    const nextSessionKey = currentAuthSessionKey()
    const changed = this.authSessionSnapshot !== undefined && this.authSessionSnapshot !== nextSessionKey
    this.authSessionSnapshot = nextSessionKey
    if (changed) {
      this._recordsRequestSeq = Number(this._recordsRequestSeq || 0) + 1
      this.setData({ records: [], stats: [], loading: false, loadFailed: false })
    }
    return { key: nextSessionKey, changed }
  },

  refresh() {
    const requestSessionKey = this.syncAuthSession().key
    this._recordsRequestSeq = (this._recordsRequestSeq || 0) + 1
    const requestSeq = this._recordsRequestSeq
    this.setData({ loading: true, loadFailed: false })
    apiService.getCommissionRecords().then((records) => {
      if (requestSeq !== this._recordsRequestSeq) return
      if (currentAuthSessionKey() !== requestSessionKey) {
        this.syncAuthSession()
        return
      }
      const displayRecords = (records || []).map(normalizeCommission)
      const uploadCount = displayRecords.filter((item) => item.role === '我是上传人').length
      const dealCount = displayRecords.filter((item) => item.role === '我是成交人').length
      const pendingCount = displayRecords.filter((item) => item.status !== '已确认').length
      this.setData({
        loading: false,
        loadFailed: false,
        records: displayRecords,
        stats: [
          { label: '我上传', value: String(uploadCount) },
          { label: '我成交', value: String(dealCount) },
          { label: '待确认', value: String(pendingCount) }
        ]
      })
    }).catch(() => {
      if (requestSeq !== this._recordsRequestSeq) return
      if (currentAuthSessionKey() !== requestSessionKey) {
        this.syncAuthSession()
        return
      }
      this.setData({ loading: false, loadFailed: true })
      wx.showToast({ title: '分佣记录加载失败', icon: 'none' })
    })
  },

  retryRecords() {
    this.refresh()
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/listing-detail/listing-detail?id=${id}` })
  }
})
