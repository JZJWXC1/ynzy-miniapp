const apiService = require('../../utils/api-service')

const regionOptions = [
  { name: '拱墅区', blocks: ['万达', '北部软件园', '城北万象城', '石桥', '华丰', '永佳', '半山', '东新园', '杭氧', '新天地'] },
  { name: '上城区', blocks: ['闸弄口', '新塘', '元宝塘', '东站'] },
  { name: '余杭区', blocks: [] }
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

Page({
  data: {
    stats: [],
    listings: [],
    isCompanyMode: false,
    regionOptions,
    layoutOptions,
    companyFilters: Object.assign({}, defaultCompanyFilters),
    companyLoading: false,
    companyCommunityOptions: [],
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
    const requestId = `company-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    this.activeCompanyRequestId = requestId
    const filters = this.data.companyFilters || defaultCompanyFilters
    this.setData({ companyLoading: true })
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
      if (this.activeCompanyRequestId !== requestId) return
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
        companyCommunityOptions
      })
    }).catch(() => {
      if (this.activeCompanyRequestId !== requestId) return
      wx.showToast({ title: '公司房源加载失败', icon: 'none' })
    }).finally(() => {
      if (this.activeCompanyRequestId !== requestId) return
      this.setData({ companyLoading: false })
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

    const submitOutcome = (outcome) => {
      apiService.verifyMyListing(id, outcome).then((listings) => {
        this.setData({ listings });
        wx.showToast({
          title: outcome === '未出租' ? '已更新·房态已维护' : '已下架该房源',
          icon: 'success'
        });
        this.refresh();
      }).catch(() => {
        wx.showToast({ title: '房态更新失败', icon: 'none' });
      });
    };

    // 电话联系房东后，按结果三选一：未出租=已维护（重置核验周期）；已出租/不租了=自动下架进后台资产池。
    const askOutcome = () => {
      wx.showActionSheet({
        itemList: ['已出租', '未出租', '不租了'],
        success: (res) => {
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
        complete: () => askOutcome()
      });
    } else {
      wx.showToast({ title: '未登记房东电话，请先补充', icon: 'none' });
      askOutcome();
    }
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
