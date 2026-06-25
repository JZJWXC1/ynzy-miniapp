// groups.js
const apiService = require('../../utils/api-service')

Page({
  data: {
    points: 0,
    groups: [],
    listings: [],
    allListings: [],
    actions: ['查看详情', '记录带看', '登记成交', '联系上传人'],
    pointLogs: [],
    groupUploads: [],
    screenshotPath: '',
    screenshotFile: null,
    submitting: false,
    groupForm: {
      title: '',
      area: '',
      block: ''
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.refresh();
  },

  refresh() {
    apiService.getGroupState().then((state) => {
      this.setData(Object.assign({}, state, { allListings: state.listings || [] }));
    }).catch(() => {
      wx.showToast({ title: '房源群加载失败', icon: 'none' })
    });
  },

  handleTap(event) {
    const name = event.currentTarget.dataset.name || '操作';
    if (name === '筛选房源群') {
      wx.showActionSheet({
        itemList: ['全部共享房源', '群聊上传房源', '电话地址需实名查看'],
        success: (res) => {
          const items = this.data.allListings || [];
          const listings = res.tapIndex === 0
            ? items
            : items.filter((item) => {
                if (res.tapIndex === 1) return item.status === '群聊上传房源';
                return item.status === '电话地址需实名查看';
              });
          this.setData({ listings });
          wx.showToast({ title: `已筛选${listings.length}套`, icon: 'none' });
        }
      });
      return;
    }
    wx.showModal({
      title: name,
      content: '该操作已纳入房源群协作流程，群聊上传审核通过后积分到账，换群会消耗 1 积分。',
      showCancel: false
    });
  },

  updateGroupField(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({
      [`groupForm.${field}`]: event.detail.value
    });
  },

  chooseGroupScreenshot() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        const tempFilePath = file ? file.tempFilePath : '';
        const rawName = tempFilePath ? tempFilePath.split('/').pop() : '';
        const fileName = rawName && rawName.indexOf('.') !== -1 ? rawName : 'group-chat.jpg';
        this.setData({
          screenshotPath: tempFilePath,
          screenshotFile: file
            ? {
                tempFilePath,
                fileName,
                size: file.size || 0,
                mimeType: 'image/jpeg'
              }
            : null
        });
      }
    });
  },

  handleAction(event) {
    const name = event.currentTarget.dataset.name || '操作';
    const id = event.currentTarget.dataset.id;
    if (name === '查看详情' && id) {
      wx.navigateTo({
        url: `/pages/listing-detail/listing-detail?id=${id}`
      });
      return;
    }
    if (name === '记录带看' && id) {
      wx.navigateTo({
        url: `/pages/listing-detail/listing-detail?id=${id}`
      });
      wx.showToast({ title: '请在详情页拍水印照片', icon: 'none' });
      return;
    }
    if (name === '登记成交' && id) {
      wx.showModal({
        title: '登记成交',
        content: '成交记录会同步到管理员后台，并按上传人设置比例分佣。',
        confirmText: '登记',
        success: (res) => {
          if (!res.confirm) return;
          apiService.registerDeal(id).then((result) => {
            wx.showToast({ title: result.message || '成交已登记', icon: 'none' });
            this.refresh();
          }).catch(() => {
            wx.showToast({ title: '成交登记失败', icon: 'none' })
          });
        }
      });
      return;
    }
    if (name === '联系上传人' && id) {
      apiService.getListingDetail(id).then((listing) => {
        wx.showModal({
          title: '上传人联系方式',
          content: `${listing.uploader || '上传人'} ${listing.uploaderPhone || '暂无电话'}`,
          showCancel: false
        });
      }).catch(() => {
        wx.showToast({ title: '联系人加载失败', icon: 'none' })
      });
      return;
    }
    wx.showModal({
      title: name,
      content: '该操作已接入内部协作记录，查看详情、带看、成交和联系上传人会同步到对应房源流程。',
      showCancel: false
    });
  },

  async uploadGroupListing() {
    if (this.data.submitting) return;
    const { title, area, block } = this.data.groupForm;
    if (!title || !this.data.screenshotPath) {
      wx.showToast({ title: '请填写群名并上传截图', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '正在上传截图' });

    try {
      const policy = await apiService.createGroupScreenshotUploadPolicy(this.data.screenshotFile);
      const screenshot = await apiService.uploadGroupScreenshot(this.data.screenshotPath, policy);
      wx.showLoading({ title: '正在提交审核' });
      const state = await apiService.uploadGroupListing({
        title,
        area,
        block,
        screenshotUrl: screenshot.fileUrl,
        screenshotKey: screenshot.objectKey
      });
      this.setData(Object.assign({}, state, { allListings: state.listings || [] }));
      this.setData({
        groupForm: {
          title: '',
          area: '',
          block: ''
        },
        screenshotPath: '',
        screenshotFile: null
      });
      wx.hideLoading();
      wx.showToast({
        title: '已提交审核',
        icon: 'none'
      });
    } catch (error) {
      wx.hideLoading();
      wx.showModal({
        title: '提交失败',
        content: error.message || '请检查截图和网络后重试',
        showCancel: false
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  unlockGroup(event) {
    const id = event.currentTarget.dataset.id;
    apiService.unlockGroup(id).then((result) => {
      this.setData(Object.assign({}, result.data, { allListings: result.data.listings || [] }));
      wx.showToast({
        title: result.message,
        icon: 'none'
      });
    }).catch(() => {
      wx.showToast({ title: '换群失败', icon: 'none' })
    });
  }
})
