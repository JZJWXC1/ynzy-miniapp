const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')
const { findFailedCoverIndex } = require('../../utils/listing-cover-state')
const { LISTING_FEATURE_OPTIONS, NO_FEATURE } = require('../../utils/listing-features')

const categories = ['全部', '公司房源', '业主房源', '二房东房源']
const availabilityOptions = [
  { label: '全部状态', value: '' },
  { label: '当前可用', value: 'available' },
  { label: '暂不可用', value: 'unavailable' }
]
const regionOptions = [
  { name: '拱墅区', blocks: ['万达', '北部软件园', '城北万象城', '石桥', '华丰', '永佳', '半山', '东新园', '杭氧', '新天地'] },
  { name: '上城区', blocks: ['闸弄口', '新塘', '元宝塘', '东站'] },
  { name: '余杭区', blocks: [] }
]
const layoutOptions = ['不限', '一室', '两室', '三室', '三室以上']
const featureOptions = LISTING_FEATURE_OPTIONS.filter((item) => item !== NO_FEATURE)
const emptyFilters = {
  district: '',
  block: '',
  community: '',
  layout: '',
  rentMode: '',
  rentMin: '',
  rentMax: '',
  features: ''
}

function uniqueCommunities(rows) {
  const seen = new Set()
  return (rows || []).map((item) => String(item.community || '').trim()).filter(Boolean).filter((item) => {
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
}

Page({
  data: {
    categories,
    availabilityOptions,
    regionOptions,
    layoutOptions,
    featureOptions,
    communityOptions: [],
    category: '全部',
    availability: '',
    filters: { ...emptyFilters },
    favorites: [],
    loading: false,
    loadFailed: false
  },

  onShow() {
    this.loadFavorites()
  },

  onUnload() {
    if (this.filterRefreshTimer) clearTimeout(this.filterRefreshTimer)
    this._favoriteRequestSeq = (this._favoriteRequestSeq || 0) + 1
  },

  buildQuery(extra = {}) {
    return {
      category: this.data.category === '全部' ? '' : this.data.category,
      availability: this.data.availability,
      ...this.data.filters,
      ...extra
    }
  },

  loadFavorites() {
    this._favoriteRequestSeq = (this._favoriteRequestSeq || 0) + 1
    const requestSeq = this._favoriteRequestSeq
    const requestToken = String(apiClient.getAuthToken() || '')
    if (this._favoriteAccountToken !== requestToken) {
      this._favoriteAccountToken = requestToken
      // 换号必须在新请求返回前立即清掉旧账号行，避免 B 误看/误操作 A 的收藏。
      this.setData({ favorites: [], communityOptions: [], loadFailed: false })
    }
    this.setData({ loading: true, loadFailed: false })
    const query = this.buildQuery()
    const communityQuery = this.buildQuery({ community: '' })
    Promise.all([
      apiService.getFavorites(query),
      apiService.getFavorites(communityQuery)
    ]).then(([favorites, communityRows]) => {
      if (this._favoriteRequestSeq !== requestSeq) return
      const currentToken = String(apiClient.getAuthToken() || '')
      if (currentToken !== requestToken) {
        this._favoriteAccountToken = currentToken
        this.setData({ favorites: [], communityOptions: [], loadFailed: false, loading: false })
        return
      }
      this.setData({
        favorites,
        communityOptions: uniqueCommunities(communityRows),
        loadFailed: false
      })
    }).catch(() => {
      if (this._favoriteRequestSeq !== requestSeq) return
      const currentToken = String(apiClient.getAuthToken() || '')
      if (currentToken !== requestToken) {
        this._favoriteAccountToken = currentToken
        this.setData({ favorites: [], communityOptions: [], loadFailed: false, loading: false })
        return
      }
      this.setData({ loadFailed: true })
      wx.showToast({ title: '收藏加载失败', icon: 'none' })
    }).finally(() => {
      if (this._favoriteRequestSeq === requestSeq) this.setData({ loading: false })
    })
  },

  switchCategory(event) {
    this.setData({ category: event.currentTarget.dataset.category || '全部' }, () => this.loadFavorites())
  },

  switchAvailability(event) {
    this.setData({ availability: event.currentTarget.dataset.value || '' }, () => this.loadFavorites())
  },

  handleListingFilterChange(event) {
    this.setData({ filters: { ...this.data.filters, ...(event.detail.filters || {}) } }, () => {
      if (event.detail.immediate) this.loadFavorites()
      else this.scheduleFilterRefresh()
    })
  },

  handleListingFilterApply(event) {
    this.setData({ filters: { ...this.data.filters, ...(event.detail.filters || {}) } }, () => this.loadFavorites())
  },

  scheduleFilterRefresh() {
    if (this.filterRefreshTimer) clearTimeout(this.filterRefreshTimer)
    this.filterRefreshTimer = setTimeout(() => {
      this.filterRefreshTimer = null
      this.loadFavorites()
    }, 320)
  },

  resetFilters() {
    this.setData({ filters: { ...emptyFilters } }, () => this.loadFavorites())
  },

  retryFavorites() {
    this.loadFavorites()
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    const listing = this.data.favorites.find((item) => String(item.id) === String(id))
    if (!listing || listing.isAvailable !== true) {
      wx.showToast({ title: '该房源暂不可用，可取消收藏', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/listing-detail/listing-detail?id=${encodeURIComponent(id)}&source=favorites` })
  },

  handleFavoriteChange(event) {
    const detail = event.detail || {}
    if (detail.favorited !== false) return
    this._favoriteRequestSeq = (this._favoriteRequestSeq || 0) + 1
    this.setData({
      favorites: this.data.favorites.filter((item) => String(item.id) !== String(detail.listingId)),
      loading: false
    }, () => this.loadFavorites())
  },

  onCoverError(event) {
    const dataset = (event.currentTarget && event.currentTarget.dataset) || {}
    const index = findFailedCoverIndex(this.data.favorites, dataset.id, dataset.cover)
    if (index >= 0) this.setData({ [`favorites[${index}].coverUrl`]: '' })
  }
})
