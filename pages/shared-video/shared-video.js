const apiService = require('../../utils/api-service')

function decodeOption(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return value
  }
}

Page({
  data: {
    listing: {},
    broker: '',
    loading: false,
    loadFailed: false,
    accessRequired: false,
    unavailable: false
  },

  onLoad(options) {
    const id = options.id || ''
    this.setData({
      broker: decodeOption(options.broker)
    })
    if (!id) {
      wx.showToast({ title: '房源不存在或已下架', icon: 'none' })
      this.setData({ unavailable: true })
      return
    }
    this.listingId = id
    this.loadListing(id)
  },

  loadListing(id) {
    this.listingId = id
    this.setData({
      listing: {},
      loading: true,
      loadFailed: false,
      accessRequired: false,
      unavailable: false
    })
    apiService.getListingDetail(id).then((listing) => {
      if (listing && listing.unavailable) {
        this.setData({ listing: {}, loading: false, unavailable: true })
        return
      }
      this.setData({ listing, loading: false })
    }).catch((error) => {
      const statusCode = Number(error && error.statusCode)
      if (statusCode === 401 || statusCode === 403) {
        this.setData({ loading: false, accessRequired: true })
        return
      }
      if (statusCode === 404) {
        this.setData({ loading: false, unavailable: true })
        wx.showToast({ title: '房源不存在或已下架', icon: 'none' })
        return
      }
      this.setData({ loading: false, loadFailed: true })
      wx.showToast({ title: '视频加载失败，请重试', icon: 'none' })
    })
  },

  retryLoad() {
    if (this.listingId) this.loadListing(this.listingId)
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/auth/auth' })
  },

  onShareAppMessage() {
    const listing = this.data.listing || {}
    return {
      title: '房间视频',
      path: `/pages/shared-video/shared-video?id=${encodeURIComponent(listing.id || this.listingId || '')}&source=tenant-video-share${this.data.broker ? `&broker=${encodeURIComponent(this.data.broker)}` : ''}`,
      imageUrl: listing.shareImageUrl || ''
    }
  }
})
