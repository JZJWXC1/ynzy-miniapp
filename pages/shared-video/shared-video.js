const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}

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
    unavailable: false
  },

  onLoad(options) {
    const id = options.id || ''
    this._pageActive = true
    this.authSessionSnapshot = currentAuthSessionKey()
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

  onShow() {
    const nextSessionKey = currentAuthSessionKey()
    if (this.authSessionSnapshot === undefined) {
      this.authSessionSnapshot = nextSessionKey
      return
    }
    if (nextSessionKey === this.authSessionSnapshot) return
    this.authSessionSnapshot = nextSessionKey
    if (this.listingId) this.loadListing(this.listingId)
  },

  onUnload() {
    this._pageActive = false
    this._listingRequestSeq = Number(this._listingRequestSeq || 0) + 1
  },

  loadListing(id) {
    this.listingId = id
    this._videoPlaybackRefreshCount = 0
    this._mediaRefreshPromise = null
    const requestSeq = Number(this._listingRequestSeq || 0) + 1
    const requestListingId = String(id || '')
    this._listingRequestSeq = requestSeq
    const requestIsCurrent = () => (
      this._pageActive !== false &&
      this._listingRequestSeq === requestSeq &&
      String(this.listingId || '') === requestListingId
    )
    this.setData({
      listing: {},
      loading: true,
      loadFailed: false,
      unavailable: false
    })
    // 分享页只消费公共视频投影，始终省略 Authorization；残留过期 token 不能破坏游客播放。
    return apiService.getListingDetail(id, { anonymous: true }).then((listing) => {
      if (!requestIsCurrent()) return
      if (listing && listing.unavailable) {
        this.setData({ listing: {}, loading: false, unavailable: true })
        return
      }
      this.setData({ listing, loading: false })
    }).catch((error) => {
      if (!requestIsCurrent()) return
      const statusCode = Number(error && error.statusCode)
      if (statusCode === 401 || statusCode === 403) {
        this.setData({ loading: false, loadFailed: true })
        wx.showToast({ title: '视频读取失败，请重试', icon: 'none' })
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

  refreshListingMedia() {
    const listingId = String((this.data.listing && this.data.listing.id) || this.listingId || '')
    if (!listingId) return Promise.reject(new Error('房源不存在或已下架'))
    if (this._mediaRefreshPromise) return this._mediaRefreshPromise
    const requestSeq = Number(this._listingRequestSeq || 0)
    const isCurrentRequest = () => (
      this._pageActive !== false &&
      Number(this._listingRequestSeq || 0) === requestSeq &&
      String((this.data.listing && this.data.listing.id) || '') === listingId
    )
    const request = apiService.getListingDetail(listingId, { anonymous: true }).then((fresh) => {
      if (!isCurrentRequest()) {
        const error = new Error('页面状态已变化，忽略旧媒体地址')
        error.staleMediaRefresh = true
        throw error
      }
      if (!fresh || fresh.unavailable || !fresh.videoUrl) {
        const error = new Error('房源视频不存在或已下架')
        error.statusCode = 404
        throw error
      }
      const merged = Object.assign({}, this.data.listing || {}, {
        videoUrl: fresh.videoUrl,
        coverUrl: fresh.coverUrl || (this.data.listing && this.data.listing.coverUrl) || '',
        hasVideo: true
      })
      this.setData({ listing: merged })
      return merged
    }).finally(() => {
      if (this._mediaRefreshPromise === request) this._mediaRefreshPromise = null
    })
    this._mediaRefreshPromise = request
    return request
  },

  onVideoPlaybackError() {
    if (Number(this._videoPlaybackRefreshCount || 0) >= 1) return
    this._videoPlaybackRefreshCount = Number(this._videoPlaybackRefreshCount || 0) + 1
    const requestSeq = Number(this._listingRequestSeq || 0)
    this.refreshListingMedia().catch((error) => {
      if (error && error.staleMediaRefresh) return
      if (this._pageActive === false || Number(this._listingRequestSeq || 0) !== requestSeq) return
      wx.showToast({ title: '视频加载失败，请重试', icon: 'none' })
    })
  },

  retryLoad() {
    if (this.listingId) this.loadListing(this.listingId)
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
