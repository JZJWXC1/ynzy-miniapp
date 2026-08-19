const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')
const { findFailedCoverIndex } = require('../../utils/listing-cover-state')
const { LISTING_FEATURE_OPTIONS, NO_FEATURE } = require('../../utils/listing-features')
const {
  DEFAULT_LAYOUT_OPTIONS,
  normalizeListingFilterOptions,
  listingFilterOptionsFromListings,
  mergeListingFilterOptions
} = require('../../utils/listing-filter-options')

const categories = ['全部', '公司房源', '业主房源', '二房东房源']
const availabilityOptions = [
  { label: '全部状态', value: '' },
  { label: '当前可用', value: 'available' },
  { label: '暂不可用', value: 'unavailable' }
]
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

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
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
    regionOptions: [],
    layoutOptions: DEFAULT_LAYOUT_OPTIONS.slice(),
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
    this._pageActive = true
    this.loadListingFilterOptions()
    this.loadFavorites()
  },

  onUnload() {
    this._pageActive = false
    this._filterOptionsRequestSeq = Number(this._filterOptionsRequestSeq || 0) + 1
    if (this.filterRefreshTimer) clearTimeout(this.filterRefreshTimer)
    this._favoriteRequestSeq = (this._favoriteRequestSeq || 0) + 1
  },

  resetFavoriteAccountState(nextSessionKey) {
    this._favoriteAccountToken = nextSessionKey
    this._favoriteFilterOptions = null
    this.setData({
      favorites: [],
      communityOptions: [],
      loadFailed: false,
      loading: false,
      category: '全部',
      availability: '',
      filters: { ...emptyFilters }
    })
    this.applyListingFilterOptions()
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
    const requestSessionKey = currentAuthSessionKey()
    if (this._favoriteAccountToken !== requestSessionKey) {
      // 换号必须在新请求返回前立即清掉旧账号行，避免 B 误看/误操作 A 的收藏。
      // 私有地点选项和位置筛选也属于账号态；不能等待 B 的网络请求成功后才移除 A 的名称。
      this.resetFavoriteAccountState(requestSessionKey)
    }
    this.setData({ loading: true, loadFailed: false })
    const query = this.buildQuery()
    const communityQuery = this.buildQuery({ community: '' })
    // 地区元数据读取本账号全部安全收藏行，不受当前筛选限制；否则只剩失效收藏的新地区
    // 永远不会出现在选项里。服务端收藏 DTO 已剥离地址、电话、房号等敏感字段。
    const locationQuery = {
      category: '',
      availability: '',
      ...emptyFilters
    }
    return Promise.all([
      apiService.getFavorites(query),
      apiService.getFavorites(communityQuery),
      apiService.getFavorites(locationQuery)
    ]).then(([favorites, communityRows, locationRows]) => {
      if (this._favoriteRequestSeq !== requestSeq) return
      const currentSessionKey = currentAuthSessionKey()
      if (currentSessionKey !== requestSessionKey) {
        this.resetFavoriteAccountState(currentSessionKey)
        return
      }
      this._favoriteFilterOptions = listingFilterOptionsFromListings(locationRows)
      this.setData({
        favorites,
        communityOptions: uniqueCommunities(communityRows),
        loadFailed: false
      })
      this.applyListingFilterOptions()
    }).catch(() => {
      if (this._favoriteRequestSeq !== requestSeq) return
      const currentSessionKey = currentAuthSessionKey()
      if (currentSessionKey !== requestSessionKey) {
        this.resetFavoriteAccountState(currentSessionKey)
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

  applyListingFilterOptions() {
    const options = mergeListingFilterOptions(
      this._publicFilterOptions || {},
      this._favoriteFilterOptions || {}
    )
    this.setData({
      regionOptions: options.regionOptions,
      layoutOptions: options.layoutOptions
    })
  },

  loadListingFilterOptions() {
    if (typeof apiService.getListingFilterOptions !== 'function') return Promise.resolve()
    this._filterOptionsRequestSeq = Number(this._filterOptionsRequestSeq || 0) + 1
    const requestSeq = this._filterOptionsRequestSeq
    return apiService.getListingFilterOptions().then((payload) => {
      if (this._pageActive === false || requestSeq !== this._filterOptionsRequestSeq) return
      const options = normalizeListingFilterOptions(payload)
      this._publicFilterOptions = options
      this.applyListingFilterOptions()
    }).catch(() => {})
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
