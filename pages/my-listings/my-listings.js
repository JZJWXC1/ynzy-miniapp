const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')
const { findFailedCoverIndex } = require('../../utils/listing-cover-state')
const {
  DEFAULT_LAYOUT_OPTIONS,
  normalizeListingFilterOptions,
  listingFilterOptionsFromListings,
  mergeListingFilterOptions
} = require('../../utils/listing-filter-options')

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}

const defaultCompanyFilters = {
  district: '',
  block: '',
  community: '',
  layout: '',
  rentMode: '',
  rentMin: '',
  rentMax: ''
}

function companyRentText(item) {
  if (item.price) return item.price
  if (item.rent) return `¥${item.rent}/月`
  return '租金待补充'
}

function formatCompanyListings(listings) {
  return (listings || []).map((item) => Object.assign({}, item, {
    displayRentText: companyRentText(item),
    displayLocationText: [
      item.locationSummary || item.community || item.area || '位置待补充',
      item.layout || item.rentMode || item.type || '户型待补充'
    ].join(' · ')
  }))
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

// 我的房源（owner）筛选默认全空——不像公司模式预设拱墅区，避免默认过滤掉自己名下其它区房源。
const defaultOwnerFilters = {
  district: '',
  block: '',
  community: '',
  layout: '',
  rentMode: '',
  rentMin: '',
  rentMax: ''
}

function ownerRentText(item) {
  if (item.price) return item.price
  if (item.rent) return `¥${item.rent}/月`
  return '租金待补充'
}

function formatOwnerListings(listings) {
  return (listings || []).map((item) => Object.assign({}, item, {
    displayRentText: ownerRentText(item)
  }))
}

function includesText(hay, needle) {
  const key = String(needle || '').trim()
  return !key || String(hay || '').indexOf(key) !== -1
}

function normalizedDistrict(value) {
  return String(value || '').normalize('NFKC').trim().replace(/区$/, '')
}

function normalizedBlock(value) {
  return String(value || '').normalize('NFKC').trim()
}

// 户型按室数比较，与后端 domain.matchesLayoutFilter 同口径：房源落库用「二室」，筛选栏用「两室」，
// 必须归一到室数否则「两室」永远匹配不到、「三室以上」漏掉四室以上。
function roomCountFromLayout(text) {
  const matched = String(text || '').match(/([一二两三四五六七八九]|\d+)\s*室/)
  if (!matched) return 0
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  return map[matched[1]] || Number(matched[1]) || 0
}

function matchLayoutFilter(item, layoutFilter) {
  const filter = String(layoutFilter || '').trim()
  if (!filter || filter === '不限') return true
  const roomCount = roomCountFromLayout([item.layout, item.room, item.type, item.rentMode].join(' '))
  if (filter === '一室') return roomCount === 1
  if (filter === '两室' || filter === '二室') return roomCount === 2
  if (filter === '三室') return roomCount === 3
  if (filter === '三室以上') return roomCount >= 3
  return String(item.layout || '').indexOf(filter) !== -1
}

// 本地过滤我的房源：复用公司房源那套筛选维度（整租合租/小区/租金为用户明确要求，另兼容区域/板块/户型）。
function matchOwnerFilter(item, filters) {
  const f = filters || {}
  const district = normalizedDistrict(f.district)
  if (district && ![item.district, item.area].map(normalizedDistrict).includes(district)) return false
  if (f.block && normalizedBlock(item.block) !== normalizedBlock(f.block)) return false
  if (f.community && !includesText(`${item.community || ''}${item.locationSummary || ''}${item.title || ''}`, f.community)) return false
  if (!matchLayoutFilter(item, f.layout)) return false
  if (f.rentMode && f.rentMode !== '不限' && String(item.rentMode || item.type || '') !== f.rentMode) return false
  const rent = Number(String(item.rent == null ? '' : item.rent).replace(/[^0-9.]/g, ''))
  if (f.rentMin && rent && rent < Number(f.rentMin)) return false
  if (f.rentMax && rent && rent > Number(f.rentMax)) return false
  return true
}

Page({
  data: {
    stats: [],
    listings: [],
    isCompanyMode: false,
    regionOptions: [],
    layoutOptions: DEFAULT_LAYOUT_OPTIONS.slice(),
    companyFilters: Object.assign({}, defaultCompanyFilters),
    companyLoading: false,
    companyCommunityOptions: [],
    ownerFilters: Object.assign({}, defaultOwnerFilters),
    ownerLoading: false,
    loadFailed: false,
    ownerCommunityOptions: [],
    pageTitle: '我的房源',
    ownerTitle: '我的上传房源',
    ownerDesc: '上传真实可租房源，视频必填；第 3/5/7 天按规则核验房态。',
    listTitle: '房源列表',
    emptyTitle: '暂无房源',
    emptyDesc: '上传真实可租房源后，这里会显示你的房源。'
  },

  onLoad(options = {}) {
    this._pageActive = true
    this.authSessionSnapshot = currentAuthSessionKey()
    const isCompanyMode = options.scope === 'company' || options.company === '1'
    if (!isCompanyMode) return
    this.setData({
      isCompanyMode: true,
      pageTitle: '寓你住一起房源',
      ownerTitle: '公司在租房源',
      ownerDesc: '单独展示寓你住一起当前可租的公司房源。',
      listTitle: '公司房源列表',
      emptyTitle: '暂无公司在租房源',
      emptyDesc: '公司房源同步后，这里会自动展示可租房源。'
    })
  },

  onShow() {
    this._pageActive = true
    this.syncAuthSession()
    this.loadListingFilterOptions()
    this.refresh();
  },

  syncAuthSession() {
    const nextSessionKey = currentAuthSessionKey()
    const changed = this.authSessionSnapshot !== undefined && this.authSessionSnapshot !== nextSessionKey
    this.authSessionSnapshot = nextSessionKey
    if (changed) {
      this._ownerRequestSeq = Number(this._ownerRequestSeq || 0) + 1
      this._ownerVerificationSeq = Number(this._ownerVerificationSeq || 0) + 1
      this.activeCompanyRequestId = `session-reset-${Date.now()}-${Math.floor(Math.random() * 10000)}`
      if (this.ownerFilterTimer) {
        clearTimeout(this.ownerFilterTimer)
        this.ownerFilterTimer = null
      }
      this.allOwnerListings = []
      if (!this.data.isCompanyMode) {
        this.setData({
          stats: [],
          listings: [],
          ownerCommunityOptions: [],
          ownerFilters: Object.assign({}, defaultOwnerFilters),
          ownerLoading: false,
          loadFailed: false
        })
      }
      // 账号私有地点必须在新账号请求返回前立即从筛选项移除；公司模式也只保留公共元数据。
      this.applyListingFilterOptions(this.listingFilterMetadata)
    }
    return { key: nextSessionKey, changed }
  },

  onUnload() {
    this._pageActive = false
    this._filterOptionsRequestSeq = Number(this._filterOptionsRequestSeq || 0) + 1
    this._ownerRequestSeq = Number(this._ownerRequestSeq || 0) + 1
    this._ownerVerificationSeq = Number(this._ownerVerificationSeq || 0) + 1
    this.activeCompanyRequestId = `unloaded-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    if (this.companyFilterTimer) clearTimeout(this.companyFilterTimer)
    if (this.ownerFilterTimer) clearTimeout(this.ownerFilterTimer)
  },

  refresh() {
    if (this.data.isCompanyMode) {
      this.refreshCompanyListings()
      return
    }
    const requestSessionKey = this.syncAuthSession().key
    this._ownerRequestSeq = (this._ownerRequestSeq || 0) + 1
    const requestSeq = this._ownerRequestSeq
    this.setData({ ownerLoading: true, loadFailed: false })
    Promise.all([
      apiService.getProfileState(),
      apiService.getOwnedListings()
    ]).then(([profile, listings]) => {
      if (this._pageActive === false || requestSeq !== this._ownerRequestSeq) return
      if (currentAuthSessionKey() !== requestSessionKey) {
        this.syncAuthSession()
        return
      }
      // 统计基于我的全部房源（不随筛选变化）；筛选只改变下方展示的列表。
      const all = formatOwnerListings(listings)
      const sourceStats = profile.sourceStats || []
      this.allOwnerListings = all
      this.applyListingFilterOptions(this.listingFilterMetadata)
      this.setData({
        loadFailed: false,
        stats: [
          { label: '在租', value: (sourceStats[0] || {}).value || String(all.length) },
          { label: '被查看', value: String(all.reduce((total, item) => {
            return total + Number(String(item.views || '').replace(/[^0-9]/g, '') || 0);
          }, 0)) },
          { label: '待电话确认', value: String(all.filter((item) => item.needsVerify || (item.verifyStatus && item.verifyStatus !== '正常')).length) }
        ],
        ownerCommunityOptions: uniqueCommunities(all)
      });
      this.applyOwnerFilters();
    }).catch(() => {
      if (this._pageActive === false || requestSeq !== this._ownerRequestSeq) return
      if (currentAuthSessionKey() !== requestSessionKey) {
        this.syncAuthSession()
        return
      }
      this.setData({ loadFailed: true })
      wx.showToast({ title: '我的房源加载失败', icon: 'none' })
    }).finally(() => {
      if (this._pageActive === false || requestSeq !== this._ownerRequestSeq) return
      if (currentAuthSessionKey() !== requestSessionKey) return
      this.setData({ ownerLoading: false })
    });
  },

  // 按当前 ownerFilters 本地过滤我的全部房源，更新展示列表。
  applyOwnerFilters() {
    const all = this.allOwnerListings || [];
    const filters = this.data.ownerFilters || {};
    this.setData({ listings: all.filter((item) => matchOwnerFilter(item, filters)) });
  },

  handleOwnerFilterChange(event) {
    const ownerFilters = Object.assign({}, this.data.ownerFilters, event.detail.filters || {})
    this.setData({ ownerFilters }, () => {
      if (event.detail.immediate) {
        this.applyOwnerFilters()
        return
      }
      if (this.ownerFilterTimer) clearTimeout(this.ownerFilterTimer)
      this.ownerFilterTimer = setTimeout(() => {
        this.ownerFilterTimer = null
        this.applyOwnerFilters()
      }, 320)
    })
  },

  handleOwnerFilterApply(event) {
    const ownerFilters = Object.assign({}, this.data.ownerFilters, event.detail.filters || {})
    this.setData({ ownerFilters }, () => this.applyOwnerFilters())
  },

  resetOwnerFilters() {
    this.setData({ ownerFilters: Object.assign({}, defaultOwnerFilters) }, () => this.applyOwnerFilters())
  },

  // 视频首帧封面加载失败时清掉该项 coverUrl，退回占位图。
  onCoverError(event) {
    const dataset = (event.currentTarget && event.currentTarget.dataset) || {}
    const index = findFailedCoverIndex(this.data.listings, dataset.id, dataset.cover)
    if (index < 0) return
    this.setData({ [`listings[${index}].coverUrl`]: '' })
  },

  refreshCompanyListings() {
    const requestId = `company-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    this.activeCompanyRequestId = requestId
    const filters = this.data.companyFilters || defaultCompanyFilters
    this.setData({ companyLoading: true, loadFailed: false })
    const query = {
      category: '公司房源',
      district: filters.district || '',
      block: filters.block || '',
      community: filters.community || '',
      layout: filters.layout || '',
      rentMode: filters.rentMode || '',
      rentMin: filters.rentMin || '',
      rentMax: filters.rentMax || ''
    }
    const communityQuery = {
      category: '公司房源',
      district: filters.district || '',
      block: filters.block || '',
      rentMode: filters.rentMode || ''
    }
    Promise.all([
      apiService.getListings(query),
      apiService.getListings(communityQuery)
    ]).then(([listings, communityRows]) => {
      if (this._pageActive === false || this.activeCompanyRequestId !== requestId) return
      const companyListings = formatCompanyListings(listings)
      const companyCommunityOptions = uniqueCommunities(communityRows)
      const maintenanceCount = companyListings.filter((item) => item.needsVerify || (item.verifyStatus && item.verifyStatus !== '正常')).length
      const videoCount = companyListings.filter((item) => item.videoUrl || item.videoKey || item.video).length
      this.setData({
        loadFailed: false,
        stats: [
          { label: '在租', value: String(companyListings.length) },
          { label: '待维护', value: String(maintenanceCount) },
          { label: '视频房源', value: String(videoCount) }
        ],
        listings: companyListings,
        companyCommunityOptions
      })
    }).catch(() => {
      if (this._pageActive === false || this.activeCompanyRequestId !== requestId) return
      this.setData({ loadFailed: true })
      wx.showToast({ title: '公司房源加载失败', icon: 'none' })
    }).finally(() => {
      if (this._pageActive === false || this.activeCompanyRequestId !== requestId) return
      this.setData({ companyLoading: false })
    })
  },

  retryListings() {
    this.refresh()
  },

  loadListingFilterOptions() {
    if (typeof apiService.getListingFilterOptions !== 'function') return Promise.resolve()
    this._filterOptionsRequestSeq = Number(this._filterOptionsRequestSeq || 0) + 1
    const requestSeq = this._filterOptionsRequestSeq
    return apiService.getListingFilterOptions().then((payload) => {
      if (this._pageActive === false || requestSeq !== this._filterOptionsRequestSeq) return
      const options = normalizeListingFilterOptions(payload)
      this.listingFilterMetadata = options
      this.applyListingFilterOptions(options)
    }).catch(() => {})
  },

  applyListingFilterOptions(payload) {
    const publicOptions = normalizeListingFilterOptions(payload || {})
    const options = this.data.isCompanyMode
      ? publicOptions
      : mergeListingFilterOptions(
          publicOptions,
          listingFilterOptionsFromListings(this.allOwnerListings || [])
        )
    this.setData({
      regionOptions: options.regionOptions,
      layoutOptions: options.layoutOptions
    })
  },

  scheduleCompanyFilterRefresh() {
    if (this.companyFilterTimer) clearTimeout(this.companyFilterTimer)
    this.companyFilterTimer = setTimeout(() => {
      this.companyFilterTimer = null
      this.refreshCompanyListings()
    }, 320)
  },

  handleCompanyFilterChange(event) {
    const companyFilters = Object.assign({}, this.data.companyFilters, event.detail.filters || {})
    this.setData({ companyFilters }, () => {
      if (event.detail.immediate) {
        this.refreshCompanyListings()
        return
      }
      this.scheduleCompanyFilterRefresh()
    })
  },

  handleCompanyFilterApply(event) {
    const companyFilters = Object.assign({}, this.data.companyFilters, event.detail.filters || {})
    this.setData({ companyFilters }, () => this.refreshCompanyListings())
  },

  resetCompanyFilters() {
    const filters = Object.assign({}, defaultCompanyFilters)
    this.setData({
      companyFilters: filters,
      companyCommunityOptions: []
    }, () => this.refreshCompanyListings())
  },

  openListing(event) {
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${event.currentTarget.dataset.id}`
    });
  },

  verifyListing(event) {
    if (this.data.isCompanyMode) return;
    const dataset = event.currentTarget.dataset || {};
    const id = dataset.id;
    if (!id) return;
    const item = (this.data.listings || []).find((row) => row.id === id) || {};
    const phone = dataset.phone || item.landlordPhone || '';
    const operation = this.beginOwnerVerification(id)

    const submitOutcome = (outcome) => {
      if (!this.isOwnerVerificationCurrent(operation)) return
      apiService.verifyMyListing(id, outcome).then(() => {
        if (!this.isOwnerVerificationCurrent(operation)) return
        wx.showToast({
          title: outcome === '未出租' ? '已更新·房态已维护' : '已下架该房源',
          icon: 'success'
        });
        // 重新拉取并按当前筛选重算，避免直接展示未过滤的全量列表。
        this.refresh();
      }).catch(() => {
        if (!this.isOwnerVerificationCurrent(operation)) return
        wx.showToast({ title: '房态更新失败', icon: 'none' });
      });
    };

    // 电话联系房东后，按结果三选一：未出租=已维护（重置核验周期）；已出租/不租了=自动下架进后台资产池。
    const askOutcome = () => {
      if (!this.isOwnerVerificationCurrent(operation)) return
      wx.showActionSheet({
        itemList: ['已出租', '未出租', '不租了'],
        success: (res) => {
          if (!this.isOwnerVerificationCurrent(operation)) return
          const outcome = ['已出租', '未出租', '不租了'][res.tapIndex];
          if (!outcome) return;
          submitOutcome(outcome);
        }
      });
    };

    // 自动弹出拨号，输入房源登记的房东号码；拨号结束/取消回来后再问房态结果。
    if (phone) {
      wx.makePhoneCall({
        phoneNumber: String(phone),
        complete: () => {
          if (this.isOwnerVerificationCurrent(operation)) askOutcome()
        }
      });
    } else {
      wx.showToast({ title: '未登记房东电话，请先补充', icon: 'none' });
      askOutcome();
    }
  },

  beginOwnerVerification(listingId) {
    const sequence = Number(this._ownerVerificationSeq || 0) + 1
    this._ownerVerificationSeq = sequence
    return {
      sequence,
      sessionKey: currentAuthSessionKey(),
      listingId: String(listingId || '')
    }
  },

  isOwnerVerificationCurrent(operation) {
    return Boolean(operation) &&
      this._pageActive !== false &&
      !this.data.isCompanyMode &&
      this._ownerVerificationSeq === operation.sequence &&
      currentAuthSessionKey() === operation.sessionKey &&
      (this.allOwnerListings || []).some((item) => String(item.id || '') === operation.listingId)
  },

  editListing(event) {
    if (this.data.isCompanyMode) return;
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/upload/upload?id=${id}`
    });
  },

  upload() {
    if (this.data.isCompanyMode) return;
    wx.navigateTo({
      url: '/pages/upload/upload'
    });
  }
})
