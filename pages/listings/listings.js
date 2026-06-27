const apiService = require('../../utils/api-service')

const pendingListingFiltersKey = 'ynzy_pending_listing_filters'
const categories = ['全部', '整租', '合租', '业主房源', '公寓']
const emptyFilters = {
  area: '',
  block: '',
  community: '',
  layout: '',
  rentMax: ''
}

function cleanFilterValue(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function normalizeListingState(input = {}) {
  const sourceFilters = input.filters && typeof input.filters === 'object' ? input.filters : input
  const rawCategory = input.category || sourceFilters.category || '全部'
  const category = categories.includes(rawCategory) ? rawCategory : '全部'

  return {
    category,
    filters: {
      area: cleanFilterValue(sourceFilters.area),
      block: cleanFilterValue(sourceFilters.block),
      community: cleanFilterValue(sourceFilters.community),
      layout: cleanFilterValue(sourceFilters.layout),
      rentMax: cleanFilterValue(sourceFilters.rentMax)
    }
  }
}

function normalizeOptions(options = {}) {
  return normalizeListingState({
    category: options.category ? decodeURIComponent(options.category) : '全部',
    filters: {
      area: options.area ? decodeURIComponent(options.area) : '',
      block: options.block ? decodeURIComponent(options.block) : '',
      community: options.community ? decodeURIComponent(options.community) : '',
      layout: options.layout ? decodeURIComponent(options.layout) : '',
      rentMax: options.rentMax || ''
    }
  })
}

Page({
  data: {
    categories,
    category: '全部',
    filters: {
      area: '',
      block: '',
      community: '',
      layout: '',
      rentMax: ''
    },
    listings: [],
    loading: false,
    emptyText: '暂无符合条件的房源'
  },

  onLoad(options) {
    this.setListingState(normalizeOptions(options))
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    if (this.applyPendingListingFilters()) return
    this.loadListings()
  },

  setListingState(nextState, callback) {
    this.setData({
      category: nextState.category,
      filters: Object.assign({}, emptyFilters, nextState.filters)
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

  updateFilter(event) {
    const field = event.currentTarget.dataset.field
    this.setData({
      [`filters.${field}`]: event.detail.value
    })
  },

  switchCategory(event) {
    const category = event.currentTarget.dataset.category || '全部'
    this.setData({ category }, () => this.loadListings())
  },

  applyFilters() {
    this.loadListings()
  },

  resetFilters() {
    this.setData({
      filters: {
        area: '',
        block: '',
        community: '',
        layout: '',
        rentMax: ''
      }
    }, () => this.loadListings())
  },

  loadListings() {
    if (this.data.loading) return
    this.setData({ loading: true })
    apiService.getListings({
      category: this.data.category === '全部' ? '' : this.data.category,
      ...this.data.filters
    }).then((listings) => {
      this.setData({
        listings,
        emptyText: this.data.category === '全部' ? '暂无符合条件的房源' : `暂无${this.data.category}房源`
      })
    }).catch(() => {
      wx.showToast({ title: '房源加载失败', icon: 'none' })
    }).finally(() => {
      this.setData({ loading: false })
    })
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${id}`
    })
  }
})
