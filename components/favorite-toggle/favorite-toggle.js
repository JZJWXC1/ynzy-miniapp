const favoriteStore = require('../../utils/favorite-store')

Component({
  properties: {
    listingId: {
      type: String,
      value: '',
      observer() {
        this._favoriteOperationVersion = (this._favoriteOperationVersion || 0) + 1
        this._favoriteLoadVersion = (this._favoriteLoadVersion || 0) + 1
        this._pendingFavoriteToggle = null
        this._favoriteStateReady = false
        this._favoriteReadyToken = ''
        this.setData({ busy: false })
        this.syncFavoriteState()
        if (this._favoriteAttached) this.prepareFavoriteState()
      }
    },
    compact: {
      type: Boolean,
      value: false
    }
  },

  data: {
    favorited: false,
    busy: false,
    syncing: false
  },

  lifetimes: {
    attached() {
      this._favoriteAttached = true
      this._unsubscribeFavorite = favoriteStore.subscribe(() => this.syncFavoriteState())
      this.prepareFavoriteState()
    },
    detached() {
      this._favoriteAttached = false
      this._favoriteLoadVersion = (this._favoriteLoadVersion || 0) + 1
      this._favoriteOperationVersion = (this._favoriteOperationVersion || 0) + 1
      this._pendingFavoriteToggle = null
      this._favoriteStateReady = false
      this._favoriteReadyToken = ''
      if (this._unsubscribeFavorite) this._unsubscribeFavorite()
      this._unsubscribeFavorite = null
    }
  },

  pageLifetimes: {
    show() {
      this.prepareFavoriteState(true)
    }
  },

  methods: {
    syncFavoriteState() {
      const listingId = String(this.properties.listingId || '')
      this.setData({ favorited: listingId ? favoriteStore.isFavorite(listingId) : false })
    },

    prepareFavoriteState(force = false) {
      const listingId = String(this.properties.listingId || '')
      const loadVersion = (this._favoriteLoadVersion || 0) + 1
      const requestToken = favoriteStore.sessionToken()
      this._favoriteLoadVersion = loadVersion
      this._favoriteStateReady = false
      this.setData({ syncing: true })
      favoriteStore.load(force ? { force: true } : {}).then(() => {
        if (!this._favoriteAttached || this._favoriteLoadVersion !== loadVersion || String(this.properties.listingId || '') !== listingId) return
        if (favoriteStore.sessionToken() !== requestToken) {
          this._favoriteReadyToken = ''
          this.setData({ syncing: false })
          this._pendingFavoriteToggle = null
          return
        }
        this.syncFavoriteState()
        this._favoriteStateReady = true
        this._favoriteReadyToken = requestToken
        this.setData({ syncing: false })
        const pendingToggle = this._pendingFavoriteToggle
        this._pendingFavoriteToggle = null
        if (pendingToggle && pendingToggle.listingId === listingId && pendingToggle.token === favoriteStore.sessionToken()) {
          this.toggleFavorite()
        }
      }).catch((error) => {
        if (!this._favoriteAttached || this._favoriteLoadVersion !== loadVersion || String(this.properties.listingId || '') !== listingId) return
        const hadPendingToggle = Boolean(
          this._pendingFavoriteToggle &&
          this._pendingFavoriteToggle.listingId === listingId &&
          this._pendingFavoriteToggle.token === requestToken
        )
        const accountChanged = favoriteStore.sessionToken() !== requestToken
        this._pendingFavoriteToggle = null
        this._favoriteStateReady = false
        this._favoriteReadyToken = ''
        this.setData({ syncing: false })
        if (hadPendingToggle && !accountChanged && !(error && error.staleSession)) {
          wx.showToast({ title: '收藏状态同步失败，请重试', icon: 'none' })
        }
      })
    },

    promptLogin() {
      wx.showModal({
        title: '登录后收藏',
        content: '收藏会绑定内部中介账号，并在多设备间同步。',
        cancelText: '先看看',
        confirmText: '去登录',
        success(res) {
          if (res.confirm) wx.navigateTo({ url: '/pages/auth/auth' })
        }
      })
    },

    toggleFavorite() {
      const listingId = String(this.properties.listingId || '')
      if (!listingId || this.data.busy) return
      const currentToken = favoriteStore.sessionToken()
      if (this.data.syncing || !this._favoriteStateReady || this._favoriteReadyToken !== currentToken) {
        this._pendingFavoriteToggle = {
          listingId,
          token: currentToken
        }
        if (!this.data.syncing) this.prepareFavoriteState(true)
        return
      }
      if (!favoriteStore.hasLogin()) {
        this.promptLogin()
        return
      }

      const desired = !this.data.favorited
      const operationVersion = (this._favoriteOperationVersion || 0) + 1
      this._favoriteOperationVersion = operationVersion
      this.setData({ busy: true })
      favoriteStore.setFavorite(listingId, desired).then(() => {
        if (this._favoriteOperationVersion !== operationVersion || String(this.properties.listingId || '') !== listingId) return
        this.triggerEvent('favoritechange', { listingId, favorited: desired })
        wx.showToast({ title: desired ? '已收藏' : '已取消收藏', icon: 'none' })
      }).catch((error) => {
        if (this._favoriteOperationVersion !== operationVersion || String(this.properties.listingId || '') !== listingId) return
        if (!(error && error.staleSession)) {
          wx.showToast({ title: '收藏状态更新失败，请重试', icon: 'none' })
        }
      }).finally(() => {
        if (this._favoriteOperationVersion === operationVersion && String(this.properties.listingId || '') === listingId) this.setData({ busy: false })
      })
    }
  }
})
