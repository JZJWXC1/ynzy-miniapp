const apiService = require('../../utils/api-service')

const categories = ['全部', '整租', '合租', '业主房源', '公寓']

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
    const category = options.category ? decodeURIComponent(options.category) : '全部'
    this.setData({
      category,
      filters: {
        area: options.area ? decodeURIComponent(options.area) : '',
        block: options.block ? decodeURIComponent(options.block) : '',
        community: options.community ? decodeURIComponent(options.community) : '',
        layout: options.layout ? decodeURIComponent(options.layout) : '',
        rentMax: options.rentMax || ''
      }
    })
    this.loadListings()
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
