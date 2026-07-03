const apiService = require('../../utils/api-service')
const listingDisplay = require('../../utils/listing-display')

const PENDING_MAP_FILTERS_KEY = 'ynzy_pending_map_filters'
const PENDING_LISTING_FILTERS_KEY = 'ynzy_pending_listing_filters'
const LISTING_TAB_URL = '/pages/listings/listings'

const DEFAULT_CENTER = {
  latitude: 30.3192,
  longitude: 120.1694
}

const RENT_FILTERS = [
  { label: '全部', key: '', rentMin: '', rentMax: '' },
  { label: '2000内', key: '0-2000', rentMin: '', rentMax: 2000 },
  { label: '2-3千', key: '2000-3000', rentMin: 2000, rentMax: 3000 },
  { label: '3-5千', key: '3000-5000', rentMin: 3000, rentMax: 5000 },
  { label: '5千+', key: '5000-', rentMin: 5000, rentMax: '' }
]

const LAYOUT_FILTERS = ['全部', '一室', '两室', '三室']
const RENT_MODE_FILTERS = ['全部', '整租', '合租']
const SOURCE_TYPE_FILTERS = ['全部', '公司房源', '业主房源', '二房东房源']

function toArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return String(value)
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function numberValue(value) {
  if (value === undefined || value === null || value === '') return ''
  const number = Number(value)
  return Number.isFinite(number) ? number : ''
}

function parsePendingFilters(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (error) {
      return {}
    }
  }
  return value || {}
}

function parseBudget(value) {
  const text = String(value || '').replace(/\s+/g, '')
  if (!text) return {}
  const range = text.match(/(\d+)[-~至到](\d+)/)
  if (range) {
    return { rentMin: Number(range[1]), rentMax: Number(range[2]) }
  }
  const max = text.match(/(\d+).*(以内|以下|内|不超过|<=|≤)/)
  if (max) return { rentMax: Number(max[1]) }
  const min = text.match(/(\d+).*(以上|起|>=|≥)/)
  if (min) return { rentMin: Number(min[1]) }
  const direct = Number(text)
  return Number.isFinite(direct) ? { rentMax: direct } : {}
}

function rentKeyFromRange(rentMin, rentMax) {
  const matched = RENT_FILTERS.find((item) => String(item.rentMin) === String(rentMin || '') && String(item.rentMax) === String(rentMax || ''))
  return matched ? matched.key : 'custom'
}

function shortCommunityName(name) {
  const text = String(name || '小区').replace(/小区|公寓|花园|家园/g, '').trim() || String(name || '小区')
  return text.length > 6 ? `${text.slice(0, 6)}...` : text
}

function rentRangeText(community) {
  const minRent = Number(community && community.minRent)
  const maxRent = Number(community && community.maxRent)
  if (!Number.isFinite(minRent) || minRent <= 0) return '租金待补充'
  if (!Number.isFinite(maxRent) || maxRent <= 0 || maxRent === minRent) return `¥${minRent}/月`
  return `¥${minRent}-${maxRent}/月`
}

function normalizeListing(item) {
  const listing = listingDisplay.normalizeListing(item || {})
  return {
    id: listing.id,
    rent: Number(listing.rent || listing.price || 0),
    layout: listing.layout || '',
    rentMode: listing.rentMode || listing.type || '',
    sourceType: listing.sourceType || listing.sourceLabel || listing.source || '',
    maintenanceText: listing.maintenanceText || '',
    lastVerifiedAt: listing.lastVerifiedAt || '',
    hasVideo: Boolean(listing.hasVideo || listing.video || listing.videoUrl || listing.videoKey)
  }
}

function normalizeCommunity(item, index) {
  const listings = (item.listings || []).map(normalizeListing)
  const fallbackListing = !listings.length && item.id
    ? [normalizeListing({
      id: item.id,
      rent: item.price || item.rent,
      layout: item.layout,
      rentMode: item.rentMode || item.type,
      sourceType: item.sourceType || item.sourceLabel || item.source,
      lastVerifiedAt: item.lastVerifiedAt,
      maintenanceText: item.maintenanceText,
      hasVideo: item.videoUrl || item.videoKey
    })]
    : listings
  const activeListingIds = item.activeListingIds || fallbackListing.map((listing) => listing.id).filter(Boolean)
  const rentValues = fallbackListing.map((listing) => Number(listing.rent || 0)).filter((rent) => rent > 0)
  const minRent = Number(item.minRent || (rentValues.length ? Math.min.apply(null, rentValues) : 0))
  const maxRent = Number(item.maxRent || (rentValues.length ? Math.max.apply(null, rentValues) : 0))
  return {
    id: item.community || item.id || `community-${index}`,
    community: item.community || '已确认小区',
    latitude: Number(item.latitude),
    longitude: Number(item.longitude),
    coordinateSource: item.coordinateSource || '',
    coordinateVerified: item.coordinateVerified !== false,
    listingCount: Number(item.listingCount || activeListingIds.length || fallbackListing.length || 0),
    minRent,
    maxRent,
    rentRangeText: rentRangeText({ minRent, maxRent }),
    activeListingIds,
    layouts: item.layouts || [],
    sourceTypes: item.sourceTypes || [],
    listings: fallbackListing
  }
}

function validCommunity(item) {
  return Number.isFinite(item.latitude) && Number.isFinite(item.longitude) && item.coordinateVerified && item.listingCount > 0
}

function emptyFilters() {
  return {
    needId: '',
    rentKey: '',
    rentMin: '',
    rentMax: '',
    layout: '',
    rentMode: '',
    sourceType: '',
    area: '',
    listingIds: []
  }
}

function listingCategoryFromMapFilters(filters) {
  const sourceType = filters && filters.sourceType
  const rentMode = filters && filters.rentMode
  if (sourceType === '业主房源') return sourceType
  if (rentMode === '整租' || rentMode === '合租') return rentMode
  return '全部'
}

Page({
  data: {
    communities: [],
    markers: [],
    markerCommunityMap: {},
    selectedCommunityId: '',
    selectedCommunity: null,
    mapCenter: DEFAULT_CENTER,
    mapScale: 13,
    loading: false,
    showSearchCurrentArea: false,
    emptyText: '当前区域暂无已确认坐标的有效房源，可切换列表找房。',
    summaryText: '正在加载已确认坐标房源',
    filters: emptyFilters(),
    rentFilters: RENT_FILTERS,
    layoutFilters: LAYOUT_FILTERS,
    rentModeFilters: RENT_MODE_FILTERS,
    sourceTypeFilters: SOURCE_TYPE_FILTERS
  },

  onShow() {
    this.setTabBarSelected()
    const pending = parsePendingFilters(wx.getStorageSync(PENDING_MAP_FILTERS_KEY))
    if (Object.keys(pending).length) {
      wx.removeStorageSync(PENDING_MAP_FILTERS_KEY)
      const filters = this.mergePendingFilters(this.data.filters, pending)
      this.setData({ filters, selectedCommunityId: '', selectedCommunity: null })
      this.loadCommunities({ recenter: true })
      return
    }
    this.loadCommunities({ recenter: !this.data.communities.length })
  },

  setTabBarSelected() {
    if (typeof this.getTabBar !== 'function') return
    const tabBar = this.getTabBar()
    if (tabBar && typeof tabBar.setData === 'function') {
      tabBar.setData({ selected: 2 })
    }
  },

  mergePendingFilters(baseFilters, pendingFilters) {
    const pending = pendingFilters || {}
    const budget = parseBudget(pending.budget || pending.budgetText || pending.rent || pending.rentRange)
    const rentMin = numberValue(pending.rentMin !== undefined ? pending.rentMin : budget.rentMin)
    const rentMax = numberValue(pending.rentMax !== undefined ? pending.rentMax : budget.rentMax)
    const layout = pending.layout || pending.houseType || ''
    const rentMode = pending.rentMode || pending.mode || pending.type || ''
    const sourceType = pending.sourceType || pending.houseSourceType || pending.category || ''
    const area = pending.area || pending.region || pending.district || pending.block || pending.community || ''
    const listingIds = toArray(pending.listingIds || pending.ids || pending.listingId)
    const needId = pending.needId || pending.rentalNeedId || pending.clientNeedId || ''
    return {
      ...baseFilters,
      needId,
      rentMin,
      rentMax,
      rentKey: rentKeyFromRange(rentMin, rentMax),
      layout: layout === '全部' ? '' : layout,
      rentMode: rentMode === '全部' ? '' : rentMode,
      sourceType: sourceType === '全部' ? '' : sourceType,
      area,
      listingIds
    }
  },

  buildQuery(bounds) {
    const filters = this.data.filters || emptyFilters()
    return {
      north: bounds && bounds.north,
      south: bounds && bounds.south,
      east: bounds && bounds.east,
      west: bounds && bounds.west,
      rentMin: filters.rentMin,
      rentMax: filters.rentMax,
      layout: filters.layout,
      rentMode: filters.rentMode,
      sourceType: filters.sourceType,
      area: filters.area,
      listingIds: filters.listingIds
    }
  },

  loadCommunities(options) {
    const loadOptions = options || {}
    // 请求竞态守卫：快速连续切换筛选时，只采纳最后一次请求的响应
    this._mapRequestSeq = (this._mapRequestSeq || 0) + 1
    const requestSeq = this._mapRequestSeq
    this.setData({ loading: true })
    apiService.getMapCommunities(this.buildQuery(loadOptions.bounds)).then((items) => {
      if (requestSeq !== this._mapRequestSeq) return
      const communities = (items || []).map(normalizeCommunity).filter(validCommunity)
      this.applyCommunities(communities, loadOptions.recenter)
      this.setData({ loading: false })
    }).catch(() => {
      if (requestSeq !== this._mapRequestSeq) return
      wx.showToast({ title: '地图房源加载失败', icon: 'none' })
      this.applyCommunities([], false)
      this.setData({ loading: false })
    })
  },

  buildMarkers(communities) {
    const markerCommunityMap = {}
    const markers = (communities || []).map((community, index) => {
      const markerId = index + 1
      markerCommunityMap[markerId] = community.id
      return {
        id: markerId,
        latitude: community.latitude,
        longitude: community.longitude,
        width: 28,
        height: 28,
        zIndex: 20,
        callout: {
          content: `${shortCommunityName(community.community)}\n${community.listingCount}套 | ${rentRangeText(community)}`,
          color: '#153f36',
          fontSize: 12,
          borderRadius: 8,
          bgColor: '#ffffff',
          borderColor: '#2f6f60',
          borderWidth: 1,
          padding: 8,
          display: 'ALWAYS'
        }
      }
    })
    return { markers, markerCommunityMap }
  },

  applyCommunities(communities, recenter) {
    const markerState = this.buildMarkers(communities)
    const selectedCommunity = communities.find((item) => item.id === this.data.selectedCommunityId) || null
    const nextCenter = recenter && communities.length
      ? { latitude: communities[0].latitude, longitude: communities[0].longitude }
      : this.data.mapCenter
    this.setData({
      communities,
      markers: markerState.markers,
      markerCommunityMap: markerState.markerCommunityMap,
      selectedCommunityId: selectedCommunity ? selectedCommunity.id : '',
      selectedCommunity,
      mapCenter: nextCenter,
      mapScale: recenter && communities.length ? 14 : this.data.mapScale,
      showSearchCurrentArea: false,
      summaryText: communities.length
        ? `共 ${communities.length} 个已确认坐标小区，筛选后 ${communities.reduce((sum, item) => sum + item.listingCount, 0)} 套有效房源`
        : '当前区域暂无已确认坐标的有效房源'
    })
  },

  changeRentFilter(event) {
    const key = event.currentTarget.dataset.key || ''
    const option = RENT_FILTERS.find((item) => item.key === key) || RENT_FILTERS[0]
    const filters = {
      ...this.data.filters,
      rentKey: option.key,
      rentMin: option.rentMin,
      rentMax: option.rentMax
    }
    this.setData({ filters, selectedCommunityId: '', selectedCommunity: null })
    // 保持用户当前视野，只刷新点位与套数，不再跳回第一个小区
    this.loadCommunities({ recenter: false })
  },

  changeFilter(event) {
    const type = event.currentTarget.dataset.type
    const value = event.currentTarget.dataset.value || ''
    const filters = {
      ...this.data.filters,
      [type]: value === '全部' ? '' : value
    }
    this.setData({ filters, selectedCommunityId: '', selectedCommunity: null })
    this.loadCommunities({ recenter: false })
  },

  updateRentInput(event) {
    const field = event.currentTarget.dataset.field
    const value = numberValue(event.detail.value)
    this.setData({
      [`filters.${field}`]: value,
      'filters.rentKey': 'custom'
    })
  },

  applyCustomRentRange() {
    this.setData({
      selectedCommunityId: '',
      selectedCommunity: null
    })
    this.loadCommunities({ recenter: false })
  },

  handleRegionChange(event) {
    if (event.type !== 'end') return
    this.setData({ showSearchCurrentArea: true })
  },

  searchCurrentRegion() {
    const mapContext = wx.createMapContext('houseMap', this)
    mapContext.getRegion({
      success: (region) => {
        const northeast = region.northeast || {}
        const southwest = region.southwest || {}
        this.loadCommunities({
          recenter: false,
          bounds: {
            north: northeast.latitude,
            south: southwest.latitude,
            east: northeast.longitude,
            west: southwest.longitude
          }
        })
      },
      fail: () => {
        wx.showToast({ title: '获取当前地图范围失败', icon: 'none' })
      }
    })
  },

  handleMarkerTap(event) {
    const markerId = event.detail.markerId
    const communityId = this.data.markerCommunityMap[markerId]
    const community = this.data.communities.find((item) => item.id === communityId)
    if (!community) return
    this.setData({
      selectedCommunityId: community.id,
      selectedCommunity: community,
      mapCenter: {
        latitude: community.latitude,
        longitude: community.longitude
      },
      mapScale: 15
    })
  },

  resetCenter() {
    const center = this.data.communities.length
      ? { latitude: this.data.communities[0].latitude, longitude: this.data.communities[0].longitude }
      : DEFAULT_CENTER
    this.setData({
      selectedCommunityId: '',
      selectedCommunity: null,
      mapCenter: center,
      mapScale: this.data.communities.length ? 14 : 13,
      showSearchCurrentArea: false
    })
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    const needId = this.data.filters && this.data.filters.needId ? this.data.filters.needId : ''
    const query = needId ? `&needId=${encodeURIComponent(needId)}&source=map` : ''
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${id}${query}`
    })
  },

  openAreaListings() {
    const filters = this.data.filters || emptyFilters()
    const selectedCommunity = this.data.selectedCommunity
    const listingFilters = {
      category: listingCategoryFromMapFilters(filters),
      filters: {
        needId: filters.needId || '',
        area: selectedCommunity ? '' : (filters.area || ''),
        block: '',
        community: selectedCommunity ? selectedCommunity.community : '',
        layout: filters.layout || '',
        rentMode: filters.rentMode || '',
        rentMin: filters.rentMin || '',
        rentMax: filters.rentMax || ''
      }
    }
    try {
      wx.setStorageSync(PENDING_LISTING_FILTERS_KEY, listingFilters)
    } catch (error) {
      wx.showToast({ title: '筛选条件保存失败', icon: 'none' })
      return
    }
    wx.switchTab({
      url: LISTING_TAB_URL,
      fail: () => {
        wx.showToast({ title: '房源页打开失败', icon: 'none' })
      }
    })
  }
})
