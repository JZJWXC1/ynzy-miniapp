const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')
const { findFailedCoverIndex } = require('../../utils/listing-cover-state')
const { LISTING_FEATURE_OPTIONS, NO_FEATURE } = require('../../utils/listing-features')

const pendingListingFiltersKey = 'ynzy_pending_listing_filters'
// 顶部只保留房源来源分类（整租/合租已下移到筛选面板的「租赁方式」）。
const categories = ['全部', '公司房源', '业主房源', '二房东房源']
const partnerCategories = ['业主房源', '二房东房源']

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}
const regionOptions = [
  { name: '拱墅区', blocks: ['万达', '北部软件园', '城北万象城', '石桥', '华丰', '永佳', '半山', '东新园', '杭氧', '新天地'] },
  { name: '上城区', blocks: ['闸弄口', '新塘', '元宝塘', '东站'] },
  { name: '余杭区', blocks: [] }
]
const layoutOptions = ['不限', '一室', '两室', '三室', '三室以上']
const featureOptions = LISTING_FEATURE_OPTIONS.filter((item) => item !== NO_FEATURE)
const emptyFilters = {
  needId: '',
  district: '',
  block: '',
  community: '',
  layout: '',
  rentMode: '',
  rentMin: '',
  rentMax: '',
  features: ''
}

function cleanFilterValue(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function normalizeRentModeFilter(value) {
  return value === '整租' || value === '合租' ? value : ''
}

function uniqueCommunities(listings) {
  const seen = new Set()
  return (listings || [])
    .map((item) => String(item.community || item.title || '').trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function normalizeListingState(input = {}) {
  const sourceFilters = input.filters && typeof input.filters === 'object' ? input.filters : input
  const rawCategory = input.category || sourceFilters.category || '全部'
  const category = categories.includes(rawCategory) ? rawCategory : '全部'

  return {
    category,
    filters: {
      district: cleanFilterValue(sourceFilters.district || sourceFilters.area),
      block: cleanFilterValue(sourceFilters.block),
      community: cleanFilterValue(sourceFilters.community),
      layout: cleanFilterValue(sourceFilters.layout),
      rentMode: normalizeRentModeFilter(sourceFilters.rentMode),
      rentMin: cleanFilterValue(sourceFilters.rentMin),
      rentMax: cleanFilterValue(sourceFilters.rentMax),
      features: cleanFilterValue(sourceFilters.features || sourceFilters.feature),
      needId: cleanFilterValue(sourceFilters.needId || sourceFilters.rentalNeedId || sourceFilters.clientNeedId)
    }
  }
}

function normalizeOptions(options = {}) {
  return normalizeListingState({
    category: options.category ? decodeURIComponent(options.category) : '全部',
    filters: {
      district: options.district ? decodeURIComponent(options.district) : (options.area ? decodeURIComponent(options.area) : ''),
      block: options.block ? decodeURIComponent(options.block) : '',
      community: options.community ? decodeURIComponent(options.community) : '',
      layout: options.layout ? decodeURIComponent(options.layout) : '',
      rentMode: options.rentMode ? decodeURIComponent(options.rentMode) : '',
      rentMin: options.rentMin || '',
      rentMax: options.rentMax || '',
      features: options.features ? decodeURIComponent(options.features) : '',
      needId: options.needId ? decodeURIComponent(options.needId) : ''
    }
  })
}

Page({
  data: {
    categories,
    regionOptions,
    layoutOptions,
    featureOptions,
    communityOptions: [],
    category: '全部',
    filters: {
      needId: '',
      district: '',
      block: '',
      community: '',
      layout: '',
      rentMode: '',
      rentMin: '',
      rentMax: '',
      features: ''
    },
    listings: [],
    loading: false,
    loadFailed: false,
    loginRequired: false,
    emptyText: '暂无符合条件的房源'
  },

  onLoad(options) {
    this._pageActive = true
    this.setListingState(normalizeOptions(options))
  },

  onShow() {
    this._pageActive = true
    const sessionState = this.syncAuthSession()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    if (sessionState.changed) {
      try { wx.removeStorageSync(pendingListingFiltersKey) } catch (error) {}
    }
    if (!sessionState.changed && this.applyPendingListingFilters()) return
    this.loadListings()
  },

  syncAuthSession() {
    const nextSessionKey = currentAuthSessionKey()
    const changed = this.authSessionSnapshot !== undefined && this.authSessionSnapshot !== nextSessionKey
    this.authSessionSnapshot = nextSessionKey
    if (changed) {
      this.activeListingRequestId = `session-reset-${Date.now()}-${Math.floor(Math.random() * 10000)}`
      const filters = Object.assign({}, this.data.filters || emptyFilters, { needId: '' })
      this.setData({
        listings: [],
        communityOptions: [],
        filters,
        loading: false,
        loadFailed: false,
        loginRequired: !apiClient.getAuthToken() && partnerCategories.includes(this.data.category)
      })
    }
    return { key: nextSessionKey, changed }
  },

  setListingState(nextState, callback) {
    const filters = Object.assign({}, emptyFilters, nextState.filters)
    this.setData({
      category: nextState.category,
      filters
    }, callback)
  },

  applyPendingListingFilters() {
    let pendingFilters = null
    try {
      pendingFilters = wx.getStorageSync(pendingListingFiltersKey)
    } catch (error) {
      pendingFilters = null
    }
    if (!pendingFilters || typeof pendingFilters !== 'object') return false

    this.setListingState(normalizeListingState(pendingFilters), () => {
      try {
        wx.removeStorageSync(pendingListingFiltersKey)
      } catch (error) {
        // 存储清理失败不阻断房源筛选展示。
      }
      this.loadListings()
    })
    return true
  },

  switchCategory(event) {
    const category = event.currentTarget.dataset.category || '全部'
    this.setData({ category }, () => this.loadListings())
  },

  onUnload() {
    this._pageActive = false
    this.activeListingRequestId = `unloaded-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    if (this.filterRefreshTimer) clearTimeout(this.filterRefreshTimer)
  },

  handleListingFilterChange(event) {
    const filters = Object.assign({}, this.data.filters, event.detail.filters || {})
    this.setData({ filters }, () => {
      if (event.detail.immediate) {
        this.loadListings()
        return
      }
      this.scheduleFilterRefresh()
    })
  },

  handleListingFilterApply(event) {
    const filters = Object.assign({}, this.data.filters, event.detail.filters || {})
    this.setData({ filters }, () => this.loadListings())
  },

  scheduleFilterRefresh() {
    if (this.filterRefreshTimer) clearTimeout(this.filterRefreshTimer)
    this.filterRefreshTimer = setTimeout(() => {
      this.filterRefreshTimer = null
      this.loadListings()
    }, 320)
  },

  resetFilters() {
    this.setData({
      filters: {
        needId: this.data.filters.needId || '',
        district: '',
        block: '',
        community: '',
        layout: '',
        rentMode: '',
        rentMin: '',
        rentMax: '',
        features: ''
      }
    }, () => this.loadListings())
  },

  loadListings() {
    const requestSessionKey = this.syncAuthSession().key
    const requestId = `listing-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    this.activeListingRequestId = requestId
    const loginRequired = !apiClient.getAuthToken() && partnerCategories.includes(this.data.category)
    this.setData({ loading: true, loadFailed: false, loginRequired })
    const query = {
      category: this.data.category === '全部' ? '' : this.data.category,
      ...this.data.filters
    }
    const communityQuery = {
      category: query.category,
      district: query.district || '',
      block: query.block || '',
      rentMode: query.rentMode || ''
    }
    Promise.all([
      apiService.getListings(query),
      apiService.getListings(communityQuery)
    ]).then(([listings, communityRows]) => {
      if (this.activeListingRequestId !== requestId) return
      if (currentAuthSessionKey() !== requestSessionKey) {
        this.syncAuthSession()
        return
      }
      this.setData({
        listings,
        communityOptions: uniqueCommunities(communityRows),
        loadFailed: false,
        emptyText: this.data.category === '全部' ? '暂无符合条件的房源' : `暂无${this.data.category}`
      })
    }).catch(() => {
      if (this.activeListingRequestId !== requestId) return
      if (currentAuthSessionKey() !== requestSessionKey) {
        this.syncAuthSession()
        return
      }
      this.setData({ loadFailed: true })
      wx.showToast({ title: '房源加载失败', icon: 'none' })
    }).finally(() => {
      if (this.activeListingRequestId !== requestId) return
      if (currentAuthSessionKey() !== requestSessionKey) return
      this.setData({ loading: false })
    })
  },

  retryListings() {
    this.loadListings()
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/auth/auth' })
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    const needId = this.data.filters && this.data.filters.needId ? this.data.filters.needId : ''
    const query = needId ? `&needId=${encodeURIComponent(needId)}&source=listings` : ''
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${id}${query}`
    })
  },

  // 视频首帧封面加载失败时清掉该项 coverUrl，退回占位图，避免裂图。
  onCoverError(event) {
    const dataset = (event.currentTarget && event.currentTarget.dataset) || {}
    const index = findFailedCoverIndex(this.data.listings, dataset.id, dataset.cover)
    if (index < 0) return
    this.setData({ [`listings[${index}].coverUrl`]: '' })
  }
})
