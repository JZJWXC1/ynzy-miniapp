const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')
const { findFailedCoverIndex } = require('../../utils/listing-cover-state')

function decodeOption(value) {
  try {
    return decodeURIComponent(String(value || ''))
  } catch (error) {
    return String(value || '')
  }
}

function isAuthError(error) {
  return error && (Number(error.statusCode) === 401 || Number(error.statusCode) === 403)
}

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}

function navigateWithStackFallback(url) {
  wx.navigateTo({
    url,
    fail: () => {
      wx.redirectTo({
        url,
        fail: () => wx.showToast({ title: '页面打开失败，请重试', icon: 'none' })
      })
    }
  })
}

Page({
  data: {
    listings: [],
    total: 0,
    radiusKm: 3,
    loading: false,
    loadFailed: false
  },

  onLoad(options) {
    this.anchorId = decodeOption(options && options.id).trim()
    this._nearbyAccountToken = currentAuthSessionKey()
    this.bindAuthInvalidationListener()
    if (!this.anchorId) {
      wx.showToast({ title: '缺少当前房源编号', icon: 'none' })
    }
  },

  onShow() {
    if (this.anchorId) this.loadNearbyListings()
  },

  onUnload() {
    if (typeof this._unsubscribeAuthInvalidation === 'function') {
      this._unsubscribeAuthInvalidation()
      this._unsubscribeAuthInvalidation = null
    }
    this._nearbyRequestSeq = Number(this._nearbyRequestSeq || 0) + 1
  },

  bindAuthInvalidationListener() {
    if (this._unsubscribeAuthInvalidation || typeof apiClient.subscribeAuthInvalidation !== 'function') return
    this._unsubscribeAuthInvalidation = apiClient.subscribeAuthInvalidation((event) => {
      const fromSessionKey = String(event && event.fromSessionKey || '')
      if (!fromSessionKey || fromSessionKey !== String(this._nearbyAccountToken || '')) return
      const nextSessionKey = currentAuthSessionKey()
      if (event && event.toSessionKey && String(event.toSessionKey) !== nextSessionKey) return
      this._nearbyRequestSeq = Number(this._nearbyRequestSeq || 0) + 1
      this._nearbyAccountToken = nextSessionKey
      this.setData({ listings: [], total: 0, loading: false, loadFailed: false })
      if (this.anchorId) this.loadNearbyListings()
    })
  },

  loadNearbyListings() {
    const anchorId = String(this.anchorId || '')
    if (!anchorId) return Promise.resolve()
    const requestSeq = Number(this._nearbyRequestSeq || 0) + 1
    const requestSessionKey = currentAuthSessionKey()
    this._nearbyRequestSeq = requestSeq
    if (this._nearbyAccountToken !== requestSessionKey) {
      this._nearbyAccountToken = requestSessionKey
      // 换号/退出时先清旧账号结果，不能等新请求返回后再处理。
      this.setData({ listings: [], total: 0, loadFailed: false })
    }
    this.setData({ loading: true, loadFailed: false })

    return apiService.getNearbyListings(anchorId).then((result) => {
      if (this._nearbyRequestSeq !== requestSeq) return
      const currentSessionKey = currentAuthSessionKey()
      if (currentSessionKey !== requestSessionKey) {
        const shouldRecoverPublicRead = typeof apiClient.isPublicReadAuthFallbackContinuation === 'function' &&
          apiClient.isPublicReadAuthFallbackContinuation(requestSessionKey)
        this._nearbyAccountToken = currentSessionKey
        this.setData({ listings: [], total: 0, loading: false, loadFailed: false })
        if (shouldRecoverPublicRead) this.loadNearbyListings()
        return
      }
      const listings = Array.isArray(result && result.listings) ? result.listings : []
      this.setData({
        listings,
        total: Math.max(listings.length, Number(result && result.total) || 0),
        radiusKm: Number(result && result.radiusKm) || 3,
        loadFailed: false
      })
    }).catch((error) => {
      if (this._nearbyRequestSeq !== requestSeq) return
      const currentSessionKey = currentAuthSessionKey()
      if (currentSessionKey !== requestSessionKey) {
        const shouldRecoverPublicRead = typeof apiClient.isPublicReadAuthFallbackContinuation === 'function' &&
          apiClient.isPublicReadAuthFallbackContinuation(requestSessionKey)
        this._nearbyAccountToken = currentSessionKey
        this.setData({ listings: [], total: 0, loading: false, loadFailed: false })
        if (shouldRecoverPublicRead) this.loadNearbyListings()
        return
      }
      if (isAuthError(error)) {
        this.setData({ listings: [], total: 0, loadFailed: true })
        wx.showToast({ title: '附近房源读取失败，请重试', icon: 'none' })
        return
      }
      this.setData({ loadFailed: true })
      wx.showToast({ title: '附近房源加载失败', icon: 'none' })
    }).finally(() => {
      if (this._nearbyRequestSeq === requestSeq) this.setData({ loading: false })
    })
  },

  retryNearby() {
    this.loadNearbyListings()
  },

  openListing(event) {
    const id = String((event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id) || '')
    if (!id || !(this.data.listings || []).some((item) => String(item.id) === id)) return
    navigateWithStackFallback(`/pages/listing-detail/listing-detail?id=${encodeURIComponent(id)}&source=nearby-all`)
  },

  onCoverError(event) {
    const dataset = (event.currentTarget && event.currentTarget.dataset) || {}
    const index = findFailedCoverIndex(this.data.listings, dataset.id, dataset.cover)
    if (index >= 0) this.setData({ [`listings[${index}].coverUrl`]: '' })
  }
})
