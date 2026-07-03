const apiService = require('../../utils/api-service')

const regionOptions = [
  { name: '拱墅区', blocks: ['万达', '北部软件园', '城北万象城', '石桥', '华丰', '永佳', '半山', '东新园', '杭氧', '新天地'] },
  { name: '上城区', blocks: ['闸弄口', '新塘', '元宝塘', '东站'] }
]
const layoutOptions = ['不限', '一室', '两室', '三室', '三室以上']
const defaultCompanyFilters = {
  district: '拱墅区',
  block: '',
  community: '',
  layout: '',
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

function blocksForDistrict(district) {
  if (!district) {
    return regionOptions.reduce((list, item) => list.concat(item.blocks), [])
  }
  const matched = regionOptions.find((item) => item.name === district)
  return matched ? matched.blocks : []
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

function visibleCommunityOptions(options, keyword) {
  const text = String(keyword || '').trim()
  const rows = text ? options.filter((item) => item.indexOf(text) !== -1) : options
  return rows.slice(0, 8)
}

Page({
  data: {
    stats: [],
    listings: [],
    isCompanyMode: false,
    regionOptions,
    layoutOptions,
    companyFilters: Object.assign({}, defaultCompanyFilters),
    companyBlockOptions: blocksForDistrict(defaultCompanyFilters.district),
    companyCommunityOptions: [],
    visibleCompanyCommunities: [],
    showCompanyCommunityOptions: false,
    pageTitle: '我的房源',
    ownerTitle: '我的上传房源',
    ownerDesc: '上传真实可租房源，视频必填；第 3/5/7 天按规则核验房态。',
    listTitle: '房源列表',
    emptyTitle: '暂无房源',
    emptyDesc: '上传真实可租房源后，这里会显示你的房源。'
  },

  onLoad(options = {}) {
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
    this.refresh();
  },

  onUnload() {
    if (this.companyFilterTimer) clearTimeout(this.companyFilterTimer)
  },

  refresh() {
    if (this.data.isCompanyMode) {
      this.refreshCompanyListings()
      return
    }
    Promise.all([
      apiService.getProfileState(),
      apiService.getOwnedListings()
    ]).then(([profile, listings]) => {
      this.setData({
        stats: [
          { label: '在租', value: profile.sourceStats[0].value },
          { label: '被查看', value: String(listings.reduce((total, item) => {
            return total + Number(item.views.replace(/[^0-9]/g, '') || 0);
          }, 0)) },
          { label: '待电话确认', value: String(listings.filter((item) => item.needsVerify || (item.verifyStatus && item.verifyStatus !== '正常')).length) }
        ],
        listings
      });
    }).catch(() => {
      wx.showToast({ title: '我的房源加载失败', icon: 'none' })
    });
  },

  refreshCompanyListings() {
    const filters = this.data.companyFilters || defaultCompanyFilters
    const query = {
      category: '公司房源',
      district: filters.district || '',
      block: filters.block || '',
      community: filters.community || '',
      layout: filters.layout || '',
      rentMin: filters.rentMin || '',
      rentMax: filters.rentMax || ''
    }
    const communityQuery = {
      category: '公司房源',
      district: filters.district || '',
      block: filters.block || ''
    }
    Promise.all([
      apiService.getListings(query),
      apiService.getListings(communityQuery)
    ]).then(([listings, communityRows]) => {
      const companyListings = formatCompanyListings(listings)
      const companyCommunityOptions = uniqueCommunities(communityRows)
      const maintenanceCount = companyListings.filter((item) => item.needsVerify || (item.verifyStatus && item.verifyStatus !== '正常')).length
      const videoCount = companyListings.filter((item) => item.videoUrl || item.videoKey || item.video).length
      this.setData({
        stats: [
          { label: '在租', value: String(companyListings.length) },
          { label: '待维护', value: String(maintenanceCount) },
          { label: '视频房源', value: String(videoCount) }
        ],
        listings: companyListings,
        companyCommunityOptions,
        visibleCompanyCommunities: visibleCommunityOptions(companyCommunityOptions, filters.community)
      })
    }).catch(() => {
      wx.showToast({ title: '公司房源加载失败', icon: 'none' })
    })
  },

  scheduleCompanyFilterRefresh() {
    if (this.companyFilterTimer) clearTimeout(this.companyFilterTimer)
    this.companyFilterTimer = setTimeout(() => {
      this.companyFilterTimer = null
      this.refreshCompanyListings()
    }, 320)
  },

  selectCompanyDistrict(event) {
    const district = event.currentTarget.dataset.district || ''
    this.setData({
      'companyFilters.district': district,
      'companyFilters.block': '',
      'companyFilters.community': '',
      companyBlockOptions: blocksForDistrict(district),
      showCompanyCommunityOptions: false
    }, () => this.refreshCompanyListings())
  },

  selectCompanyBlock(event) {
    const block = event.currentTarget.dataset.block || ''
    this.setData({
      'companyFilters.block': block,
      'companyFilters.community': '',
      showCompanyCommunityOptions: false
    }, () => this.refreshCompanyListings())
  },

  selectCompanyLayout(event) {
    const layout = event.currentTarget.dataset.layout || ''
    this.setData({
      'companyFilters.layout': layout === '不限' ? '' : layout
    }, () => this.refreshCompanyListings())
  },

  updateCompanyFilter(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    this.setData({
      [`companyFilters.${field}`]: value,
      showCompanyCommunityOptions: field === 'community',
      visibleCompanyCommunities: field === 'community'
        ? visibleCommunityOptions(this.data.companyCommunityOptions, value)
        : this.data.visibleCompanyCommunities
    }, () => this.scheduleCompanyFilterRefresh())
  },

  focusCompanyCommunity() {
    this.setData({
      showCompanyCommunityOptions: true,
      visibleCompanyCommunities: visibleCommunityOptions(this.data.companyCommunityOptions, this.data.companyFilters.community)
    })
  },

  selectCompanyCommunity(event) {
    const community = event.currentTarget.dataset.community || ''
    this.setData({
      'companyFilters.community': community,
      showCompanyCommunityOptions: false,
      visibleCompanyCommunities: visibleCommunityOptions(this.data.companyCommunityOptions, community)
    }, () => this.refreshCompanyListings())
  },

  resetCompanyFilters() {
    const filters = Object.assign({}, defaultCompanyFilters)
    this.setData({
      companyFilters: filters,
      companyBlockOptions: blocksForDistrict(filters.district),
      showCompanyCommunityOptions: false
    }, () => this.refreshCompanyListings())
  },

  openListing(event) {
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${event.currentTarget.dataset.id}`
    });
  },

  verifyListing(event) {
    if (this.data.isCompanyMode) return;
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '电话确认房态',
      content: '请先电话联系房东，确认该房源目前仍在租。确认后会更新核验时间。',
      confirmText: '已联系',
      success: (res) => {
        if (!res.confirm) return;
        apiService.verifyMyListing(id).then((listings) => {
          this.setData({ listings });
          wx.showToast({ title: '已更新房态', icon: 'success' });
          this.refresh();
        }).catch(() => {
          wx.showToast({ title: '房态更新失败', icon: 'none' });
        });
      }
    });
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
