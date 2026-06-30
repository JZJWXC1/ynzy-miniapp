// index.js
const tabList = [
  {
    pagePath: '/pages/index/index',
    text: '找房',
    icon: '⌂'
  },
  {
    pagePath: '/pages/listings/listings',
    text: '房源',
    icon: '房'
  },
  {
    pagePath: '/pages/map/map',
    text: '地图',
    icon: '图'
  },
  {
    pagePath: '/pages/profile/profile',
    text: '我的',
    icon: '●'
  }
]

Component({
  data: {
    selected: 0,
    list: tabList
  },

  lifetimes: {
    attached() {
      this.syncSelected();
    }
  },

  pageLifetimes: {
    show() {
      this.syncSelected();
    }
  },

  methods: {
    syncSelected() {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const currentPage = pages[pages.length - 1];
      const currentPath = currentPage && currentPage.route ? `/${currentPage.route}` : '';
      const selected = this.data.list.findIndex((item) => item.pagePath === currentPath);
      if (selected >= 0 && selected !== this.data.selected) {
        this.setData({ selected });
      }
    },

    switchTab(event) {
      const { path, index } = event.currentTarget.dataset;
      if (!path) {
        wx.showToast({ title: '页面入口异常', icon: 'none' });
        return;
      }
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const currentPage = pages[pages.length - 1];
      const currentPath = currentPage && currentPage.route ? `/${currentPage.route}` : '';
      if (currentPath === path) {
        this.setData({ selected: index });
        return;
      }
      wx.switchTab({
        url: path,
        success: () => {
          this.setData({ selected: index });
        },
        fail: () => {
          wx.showToast({ title: '页面切换失败', icon: 'none' });
        }
      });
    }
  }
})
