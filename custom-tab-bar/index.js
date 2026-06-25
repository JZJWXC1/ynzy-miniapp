// index.js
Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: '/pages/index/index',
        text: '首页',
        icon: '⌂'
      },
      {
        pagePath: '/pages/footprint/footprint',
        text: '房源足迹',
        icon: '◷'
      },
      {
        pagePath: '/pages/groups/groups',
        text: '房源群',
        icon: '▣'
      },
      {
        pagePath: '/pages/profile/profile',
        text: '我的',
        icon: '●'
      }
    ]
  },

  methods: {
    switchTab(event) {
      const { path, index } = event.currentTarget.dataset;
      wx.switchTab({
        url: path
      });
      this.setData({
        selected: index
      });
    }
  }
})
