const apiService = require('../../utils/api-service')

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

Page({
  data: {
    stats: [],
    listings: [],
    isCompanyMode: false,
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
    apiService.getCompanyListings().then((listings) => {
      const companyListings = formatCompanyListings(listings)
      const maintenanceCount = companyListings.filter((item) => item.needsVerify || (item.verifyStatus && item.verifyStatus !== '正常')).length
      const videoCount = companyListings.filter((item) => item.videoUrl || item.videoKey || item.video).length
      this.setData({
        stats: [
          { label: '在租', value: String(companyListings.length) },
          { label: '待维护', value: String(maintenanceCount) },
          { label: '视频房源', value: String(videoCount) }
        ],
        listings: companyListings
      })
    }).catch(() => {
      wx.showToast({ title: '公司房源加载失败', icon: 'none' })
    })
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
