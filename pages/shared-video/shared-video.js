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
    broker: ''
  },

  onLoad(options) {
    const id = options.id || ''
    this.setData({
      broker: decodeOption(options.broker)
    })
    if (!id) {
      wx.showToast({ title: '房源不存在或已下架', icon: 'none' })
      return
    }
    this.loadListing(id)
  },

  loadListing(id) {
    apiService.getListingDetail(id).then((listing) => {
      this.setData({ listing })
    }).catch(() => {
      wx.showToast({ title: '房源不存在或已下架', icon: 'none' })
    })
  },

  onShareAppMessage() {
    const listing = this.data.listing || {}
    return {
      title: '房间视频',
      path: `/pages/shared-video/shared-video?id=${encodeURIComponent(listing.id || '')}&source=tenant-video-share${this.data.broker ? `&broker=${encodeURIComponent(this.data.broker)}` : ''}`,
      imageUrl: listing.shareImageUrl || ''
    }
  }
})
