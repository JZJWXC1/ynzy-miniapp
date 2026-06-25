const apiService = require('../../utils/api-service')
const listingDisplay = require('../../utils/listing-display')

const DEFAULT_CENTER = {
  name: '东新园地铁口',
  latitude: 30.3192,
  longitude: 120.1694
}

function numberOrFallback(value, fallback) {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function featureList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item))
  if (!value) return []
  return String(value)
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function truthyFlag(value) {
  if (value === true) return true
  if (value === false || value === undefined || value === null) return false
  return /^(1|true|yes|y|是|公司|公司房源)$/i.test(String(value).trim())
}

function commissionRate(value) {
  if (value === undefined || value === null || value === '') return null
  const direct = Number(value)
  if (Number.isFinite(direct)) return direct
  const matched = String(value).match(/(\d+(?:\.\d+)?)/)
  return matched ? Number(matched[1]) : null
}

function pinText(pin) {
  const features = featureList(pin.features)
  return [
    pin.source,
    pin.sourceLabel,
    pin.sourceType,
    pin.listingType,
    pin.inventoryType,
    pin.category,
    pin.status,
    pin.commission,
    pin.commissionText
  ].concat(features).map((item) => String(item || '')).join(' ')
}

function isNoCommissionPin(pin) {
  const text = pinText(pin)
  return Boolean(
    truthyFlag(pin.noCommission) ||
    /不分佣|(^|[^\d])0(?:\.0+)?\s*%|分佣\s*0(?:\.0+)?/.test(text) ||
    commissionRate(pin.commissionRate) === 0 ||
    commissionRate(pin.commission) === 0
  )
}

function isCompanyPin(pin) {
  const text = pinText(pin)
  if (truthyFlag(pin.companyListing) || truthyFlag(pin.isCompanyListing) || truthyFlag(pin.companyOwned)) return true
  if (/公司房源|公司自营|待租房源|待租|company/i.test(text)) return true
  if (/普通上传|业主房源|二房东房源|个人房源/.test(text)) return false

  // 线上旧地图接口暂时没有来源字段；这些旧的待租数据按本次规则统一视作公司房源。
  return true
}

function uniqueFeatures(features) {
  const seen = {}
  return features.filter((item) => {
    const key = String(item || '').trim()
    if (!key || seen[key] || key === '无') return false
    seen[key] = true
    return true
  })
}

function normalizeMapPin(pin) {
  const current = listingDisplay.normalizeListing(pin || {}, { forceCompany: true })
  const companyListing = isCompanyPin(current)
  const noCommission = companyListing || isNoCommissionPin(current)
  const features = uniqueFeatures(featureList(current.features)
    .concat(companyListing ? ['公司房源'] : [])
    .concat(companyListing ? ['免押金'] : [])
    .concat(noCommission ? ['不分佣'] : []))

  return {
    ...current,
    companyListing,
    isCompanyListing: companyListing,
    noCommission,
    sourceLabel: companyListing ? '公司房源' : (current.sourceLabel || current.source || ''),
    commissionText: noCommission ? '不分佣' : (current.commissionText || current.commission || ''),
    commission: noCommission ? '不分佣' : (current.commission || current.commissionText || ''),
    features
  }
}

function pinCoordinate(pin) {
  const latitude = Number(pin.latitude)
  const longitude = Number(pin.longitude)
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return { latitude, longitude }
  }

  const left = numberOrFallback(pin.left, 50)
  const top = numberOrFallback(pin.top, 50)
  return {
    latitude: Number((DEFAULT_CENTER.latitude + ((50 - top) / 50) * 0.035).toFixed(6)),
    longitude: Number((DEFAULT_CENTER.longitude + ((left - 50) / 50) * 0.045).toFixed(6))
  }
}

Page({
  data: {
    pins: [],
    filteredPins: [],
    markers: [],
    markerListingMap: {},
    areaFilters: ['全部'],
    activeArea: '全部',
    selectedListingId: '',
    selectedPin: null,
    mapCenter: DEFAULT_CENTER,
    mapScale: 13,
    defaultCenterName: DEFAULT_CENTER.name,
    summaryText: '正在加载内部共享房源'
  },

  onShow() {
    apiService.getMapPins().then((pins) => {
      this.applyPins(pins || [], this.data.activeArea)
    }).catch(() => {
      wx.showToast({ title: '地图房源加载失败', icon: 'none' })
    })
  },

  buildMarkers(pins) {
    const markerListingMap = {}
    const markers = [
      {
        id: 1,
        latitude: DEFAULT_CENTER.latitude,
        longitude: DEFAULT_CENTER.longitude,
        width: 28,
        height: 28,
        callout: {
          content: DEFAULT_CENTER.name,
          color: '#153f36',
          fontSize: 12,
          borderRadius: 8,
          bgColor: '#fff4ce',
          padding: 8,
          display: 'ALWAYS'
        }
      }
    ]

    pins.forEach((pin, index) => {
      const markerId = index + 2
      const coordinate = pinCoordinate(pin)
      const isCompany = Boolean(pin.companyListing)
      const locationLabel = [
        pin.community || pin.block || pin.area || '房源',
        pin.roomAddress || pin.layout || ''
      ].filter(Boolean).join(' ')
      markerListingMap[markerId] = pin.id
      markers.push({
        id: markerId,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        width: 26,
        height: 26,
        zIndex: isCompany ? 20 : 10,
        callout: {
          content: `${isCompany ? '公司房源｜' : ''}${locationLabel}\n¥${pin.price || '-'} · ${pin.commissionText || pin.commission || ''}`,
          color: isCompany ? '#ffffff' : '#153f36',
          fontSize: 12,
          borderRadius: 8,
          bgColor: isCompany ? '#2f6f60' : '#ffffff',
          borderColor: isCompany ? '#f6bd36' : '#dce9e3',
          borderWidth: isCompany ? 2 : 1,
          padding: 8,
          display: 'ALWAYS'
        }
      })
    })

    return { markers, markerListingMap }
  },

  applyPins(pins, activeArea) {
    const normalizedPins = (pins || []).map(normalizeMapPin)
    const areaFilters = ['全部'].concat(Array.from(new Set(normalizedPins.map((item) => item.area).filter(Boolean))))
    const nextArea = areaFilters.indexOf(activeArea) === -1 ? '全部' : activeArea
    const filteredPins = nextArea === '全部'
      ? normalizedPins
      : normalizedPins.filter((item) => item.area === nextArea)
    const markerState = this.buildMarkers(filteredPins)
    const selectedPin = filteredPins.find((item) => item.id === this.data.selectedListingId) || null

    this.setData({
      pins: normalizedPins,
      filteredPins,
      markers: markerState.markers,
      markerListingMap: markerState.markerListingMap,
      areaFilters,
      activeArea: nextArea,
      selectedListingId: selectedPin ? selectedPin.id : '',
      selectedPin,
      mapCenter: selectedPin ? pinCoordinate(selectedPin) : DEFAULT_CENTER,
      mapScale: selectedPin ? 15 : 13,
      summaryText: `${nextArea === '全部' ? '全公司' : nextArea}共 ${filteredPins.length} 套可配房源`
    })
  },

  changeArea(event) {
    const area = event.currentTarget.dataset.area || '全部'
    this.setData({ selectedListingId: '', selectedPin: null })
    this.applyPins(this.data.pins, area)
  },

  handleMarkerTap(event) {
    const markerId = event.detail.markerId
    if (markerId === 1) {
      this.resetCenter()
      return
    }

    const listingId = this.data.markerListingMap[markerId]
    const pin = this.data.filteredPins.find((item) => item.id === listingId)
    if (!pin) return

    this.setData({
      selectedListingId: pin.id,
      selectedPin: pin,
      mapCenter: pinCoordinate(pin),
      mapScale: 15
    })
  },

  focusPin(event) {
    const id = event.currentTarget.dataset.id
    const pin = this.data.filteredPins.find((item) => item.id === id)
    if (!pin) return

    this.setData({
      selectedListingId: pin.id,
      selectedPin: pin,
      mapCenter: pinCoordinate(pin),
      mapScale: 15
    })
  },

  resetCenter() {
    this.setData({
      selectedListingId: '',
      selectedPin: null,
      mapCenter: DEFAULT_CENTER,
      mapScale: 13
    })
  },

  openSelectedListing() {
    if (!this.data.selectedListingId) return
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${this.data.selectedListingId}`
    })
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${id}`
    })
  },

  openAreaListings() {
    const area = this.data.activeArea === '全部' ? '' : this.data.activeArea
    const params = []
    if (area) params.push(`area=${encodeURIComponent(area)}`)
    if (this.data.selectedPin && this.data.selectedPin.community) {
      params.push(`community=${encodeURIComponent(this.data.selectedPin.community)}`)
    }
    const query = params.length ? `?${params.join('&')}` : ''
    wx.navigateTo({
      url: `/pages/listings/listings${query}`
    })
  }
})
