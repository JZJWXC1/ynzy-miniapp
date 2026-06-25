// index.js
const apiService = require('../../utils/api-service')
const voiceInput = require('../../utils/voice-input')

Page({
  data: {
    assistantText: '',
    isVoiceListening: false,
    voiceText: '',
    voiceTip: '说出预算、区域、户型和特点',
    categories: [
      { name: '整租', icon: '整', desc: '内部可带看' },
      { name: '合租', icon: '合', desc: '同事共享' },
      { name: '业主房源', icon: '业', desc: '查看会留痕' },
      { name: '公寓', icon: '寓', desc: '视频优先' }
    ],
    quickActions: [
      {
        title: '地图找房',
        desc: '按区域、商圈和通勤位置快速看公司共享房源',
        icon: '图',
        url: '/pages/map/map'
      },
      {
        title: '我的房源',
        desc: '管理自己上传的房源、查看敏感信息访问足迹',
        icon: '房',
        url: '/pages/my-listings/my-listings'
      }
    ],
    listings: [],
    workbench: [
      { title: '实名查看留痕', value: '地址和电话查看同步上传人和管理员' },
      { title: '分佣比例', value: '上传人自设，默认20%，最高20%' },
      { title: '视频房源', value: '普通房源上传只允许视频' },
      { title: '群聊积分', value: '群聊截图审核通过后得1积分，可换群一次' }
    ]
  },

  onLoad() {
    this.initVoiceInput();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    apiService.getHomeListings().then((listings) => {
      this.setData({ listings })
    }).catch(() => {
      wx.showToast({ title: '首页房源加载失败', icon: 'none' })
    });
  },

  onUnload() {
    if (this.voiceController && this.data.isVoiceListening) {
      this.voiceController.stop();
    }
  },

  initVoiceInput() {
    this.voiceController = voiceInput.createController({
      onStart: () => {
        this.setData({
          isVoiceListening: true,
          voiceTip: '正在听，请说出租客需求'
        });
      },
      onRecognize: (text) => {
        this.applyVoiceText(text, false);
      },
      onStop: (text) => {
        this.setData({ isVoiceListening: false });
        if (!text) {
          wx.showToast({ title: '没有识别到内容', icon: 'none' });
          return;
        }
        this.applyVoiceText(text, true);
      },
      onError: () => {
        this.setData({
          isVoiceListening: false,
          voiceTip: '语音识别失败，请重试或手动输入'
        });
        wx.showToast({ title: '语音识别失败', icon: 'none' });
      }
    });
  },

  toggleVoiceInput() {
    if (!this.voiceController) {
      wx.showToast({ title: '当前环境暂不支持语音输入', icon: 'none' });
      return;
    }
    try {
      if (this.data.isVoiceListening) {
        this.voiceController.stop();
        return;
      }
      this.voiceController.start();
    } catch (error) {
      this.setData({ isVoiceListening: false });
      wx.showToast({ title: '语音输入启动失败', icon: 'none' });
    }
  },

  applyVoiceText(text, shouldMatch) {
    const nextData = {
      assistantText: text,
      voiceText: text,
      voiceTip: '已识别，可继续修改'
    };
    this.setData(nextData, () => {
      if (shouldMatch) this.runTextMatch();
    });
  },

  handleAssistantInput(event) {
    this.setData({
      assistantText: event.detail.value
    });
  },

  runTextMatch() {
    const text = String(this.data.assistantText || '').trim();
    if (!text) {
      wx.showToast({ title: '请输入租客需求', icon: 'none' });
      return;
    }
    const voiceText = String(this.data.voiceText || '').trim();
    wx.navigateTo({
      url: `/pages/match-chat/match-chat?text=${encodeURIComponent(text)}&voiceText=${encodeURIComponent(voiceText)}`,
      fail: () => {
        wx.showToast({ title: '配房客服打开失败', icon: 'none' });
      }
    });
  },

  handleTap(event) {
    const name = event.currentTarget.dataset.name || '功能';
    if (name === '我的工作台') {
      wx.switchTab({
        url: '/pages/profile/profile'
      });
      return;
    }
    wx.showModal({
      title: name,
      content: '该标签用于提示内部协作规则：查看地址和电话会实名留痕，分佣按上传人设置比例执行。',
      showCancel: false
    });
  },

  openPage(event) {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    wx.navigateTo({
      url,
      fail: () => {
        wx.showToast({ title: '页面打开失败', icon: 'none' });
      }
    });
  },

  openCategory(event) {
    const name = event.currentTarget.dataset.name || '全部';
    wx.navigateTo({
      url: `/pages/listings/listings?category=${encodeURIComponent(name)}`
    });
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) {
      wx.showToast({ title: '房源不存在或已下架', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${id}`
    });
  }
})
