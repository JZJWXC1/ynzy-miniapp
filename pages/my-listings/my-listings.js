const apiService = require('../../utils/api-service')

Page({
  data: {
    stats: [],
    listings: []
  },

  onShow() {
    this.refresh();
  },

  refresh() {
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
          { label: '待电话确认', value: String(listings.filter((item) => item.needsVerify || item.verifyStatus !== '正常').length) }
        ],
        listings
      });
    }).catch(() => {
      wx.showToast({ title: '我的房源加载失败', icon: 'none' })
    });
  },

  openListing(event) {
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${event.currentTarget.dataset.id}`
    });
  },

  verifyListing(event) {
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
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/upload/upload?id=${id}`
    });
  },

  upload() {
    wx.navigateTo({
      url: '/pages/upload/upload'
    });
  }
})
