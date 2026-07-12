const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')
const phoneFootprintOutbox = require('../../utils/footprint-outbox')
const { findFailedCoverIndex } = require('../../utils/listing-cover-state')

const SHOWING_CANVAS_WIDTH = 900
const SHOWING_CANVAS_HEIGHT = 1200

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDateTime(date) {
  const d = date || new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function safeText(value) {
  return String(value || '').trim()
}

function isAlbumAuthError(error) {
  const message = String((error && (error.errMsg || error.message)) || '')
  return /auth|authorize|permission|deny|denied|scope\.writePhotosAlbum/i.test(message)
}

function isAuthError(error) {
  return error && (error.statusCode === 401 || error.statusCode === 403)
}

function currentAuthToken() {
  return String(apiClient.getAuthToken() || '')
}

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}

function profileSessionMatches(value, sessionKey) {
  const stored = String(value || '')
  return stored === String(sessionKey || '') || stored === currentAuthToken()
}

function decodeOption(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return value
  }
}

function compactText(value, maxLength) {
  const text = safeText(value)
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

function splitText(value, maxLength) {
  const text = safeText(value)
  if (!text) return []
  const lines = []
  for (let i = 0; i < text.length; i += maxLength) {
    lines.push(text.slice(i, i + maxLength))
  }
  return lines
}

function chooseCameraImage() {
  return new Promise((resolve, reject) => {
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera'],
        success: (res) => {
          const file = res.tempFiles && res.tempFiles[0]
          if (!file || !file.tempFilePath) {
            reject(new Error('未获取到带看照片'))
            return
          }
          resolve(file)
        },
        fail: reject
      })
      return
    }

    wx.chooseImage({
      count: 1,
      sourceType: ['camera'],
      success: (res) => {
        const tempFilePath = res.tempFilePaths && res.tempFilePaths[0]
        if (!tempFilePath) {
          reject(new Error('未获取到带看照片'))
          return
        }
        resolve({ tempFilePath, size: 0 })
      },
      fail: reject
    })
  })
}

function getImageInfo(filePath) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src: filePath, success: resolve, fail: reject })
  })
}

Page({
  data: {
    isVerified: false,
    sensitiveAuthLabel: '可查看',
    sensitiveVisible: false,
    sensitivePlaceholder: '完成确认后可查看',
    listing: {},
    unavailableListing: {},
    listingLoading: false,
    listingLoadFailed: false,
    listingLoadErrorText: '',
    listingAccessRequired: false,
    logs: [],
    ownSensitiveLoading: false,
    ownSensitiveLoadFailed: false,
    showingSubmitting: false,
    showingPhotoPath: '',
    showingCanvasWidth: SHOWING_CANVAS_WIDTH,
    showingCanvasHeight: SHOWING_CANVAS_HEIGHT,
    sensitiveConfirmVisible: false,
    sensitiveSubmitting: false,
    canShareVideo: false,
    shareVideoBusy: false,
    shareStateText: '登录中介账号后，可把原视频文件发送给租客。',
    shareBrokerName: '',
    needId: '',
    needTemporary: false,
    currentUserId: '',
    phoneCallBusy: false,
    nearbyListings: [],
    nearbyTotal: 0,
    nearbyHasMore: false
  },

  onLoad(options) {
    this.hideNativeShareMenu()
    const id = options.id;
    const needId = decodeOption(options.needId)
    if (!id) {
      wx.showToast({ title: '请选择房源', icon: 'none' });
      return;
    }
    this.authTokenSnapshot = currentAuthSessionKey()
    this.listingId = id
    this.setData({
      needId,
      needTemporary: /^TMP-NEED-/.test(needId)
    })
    this.loadListing(id);
  },

  onShow() {
    this.hideNativeShareMenu()
    const nextToken = currentAuthSessionKey()
    if (this.authTokenSnapshot === undefined) {
      this.authTokenSnapshot = nextToken
      return
    }
    if (nextToken !== this.authTokenSnapshot) {
      // 换号后先以新 token 重新读取可信 profile；禁止用旧 currentUserId 队列配新 token 补发，避免串账号归属。
      this.authTokenSnapshot = nextToken
      if (this.listingId) this.loadListing(this.listingId)
      return
    }
    if (this.data.currentUserId) this.flushPhoneFootprints(this.data.currentUserId)
  },

  onUnload() {
    // 整份详情（含服务端内嵌 nearby）共用同一代次；卸载后任何迟到响应都不得再写页面。
    this.listingLoadGeneration = Number(this.listingLoadGeneration || 0) + 1
  },

  hideNativeShareMenu() {
    if (!wx.hideShareMenu) return
    wx.hideShareMenu({
      menus: ['shareAppMessage', 'shareTimeline']
    })
  },

  loadListing(id) {
    this.listingId = id
    const requestGeneration = Number(this.listingLoadGeneration || 0) + 1
    const requestSessionKey = currentAuthSessionKey()
    this.listingLoadGeneration = requestGeneration
    this.profileAuthToken = '' // 实际保存稳定会话键；保留属性名兼容既有页面测试与运行态对象
    this.sensitiveViewIdempotencyKey = ''
    const isCurrentRequest = () => (
      this.listingLoadGeneration === requestGeneration && currentAuthSessionKey() === requestSessionKey
    )
    this.setData({
      listing: {},
      unavailableListing: {},
      listingLoading: true,
      listingLoadFailed: false,
      listingLoadErrorText: '',
      listingAccessRequired: false,
      logs: [],
      nearbyListings: [],
      nearbyTotal: 0,
      nearbyHasMore: false,
      sensitiveVisible: false,
      sensitiveConfirmVisible: false,
      sensitiveSubmitting: false,
      sensitivePlaceholder: '完成确认后可查看',
      ownSensitiveLoading: false,
      ownSensitiveLoadFailed: false
    })
    return Promise.all([
      apiService.getListingDetail(id),
      apiService.getListingLogs(id).catch(() => []),
      // profile 只影响“可查看敏感信息”按钮态，属辅助请求：任何失败（鉴权或网络/5xx）都降级为
      // 未登录空用户，不能因它 fail-fast 拖垮整个 Promise.all，否则公司房源在弱网下会误报
      // “房源不存在或已下架”（此时 getListingDetail 往往已成功）。
      apiService.getProfileState()
        .then((profile) => ({ profile }))
        .catch(() => ({ profile: { user: {} } }))
    ]).then(([listing, logs, profileState]) => {
      // 同页重载或换号后，较早请求即使更晚返回也不得覆盖新账号状态或触发旧账号队列补发。
      if (!isCurrentRequest()) return
      if (listing && listing.unavailable) {
        this.setData({
          listing: {},
          unavailableListing: listing,
          listingLoading: false,
          listingLoadFailed: false,
          listingAccessRequired: false,
          logs: [],
          sensitiveVisible: false,
          sensitivePlaceholder: '完成确认后可查看',
          isVerified: false,
          isOwnListing: false,
          ownSensitiveLoading: false,
          ownSensitiveLoadFailed: false,
          canShareVideo: false,
          shareBrokerName: '',
          currentUserId: '',
          phoneCallBusy: false,
          shareStateText: '这套房源已更新，请重新找房。'
        })
        return
      }
      const profile = profileState.profile || {}
      const user = profile && profile.user ? profile.user : {}
      const canTrySensitive = Boolean(
        currentAuthToken() ||
        user.isAdmin ||
        user.authed === '已实名' ||
        user.authed === '手机号登录' ||
        String(user.role || '').indexOf('中介') !== -1
      )
      const canShareVideo = Boolean(listing && listing.videoUrl && (user.id || canTrySensitive))
      const companyListing = Boolean(listing && listing.companyListing)
      const ownListing = Boolean(listing && listing.ownListing)
      const nearby = listing && listing.nearby && typeof listing.nearby === 'object' ? listing.nearby : {}
      const nearbySourceRows = Array.isArray(nearby.listings) ? nearby.listings : []
      const nearbyListings = nearbySourceRows.slice(0, 6)
      const nearbyTotal = Math.max(nearbyListings.length, Number(nearby.total) || 0)
      const nearbyHasMore = nearbyListings.length > 0 && Boolean(
        nearby.hasMore || nearbyTotal > nearbyListings.length || nearbySourceRows.length > nearbyListings.length
      )
      this.profileAuthToken = requestSessionKey
      this.setData({
        listing,
        unavailableListing: {},
        listingLoading: false,
        listingLoadFailed: false,
        listingLoadErrorText: '',
        listingAccessRequired: false,
        logs,
        nearbyListings,
        nearbyTotal,
        nearbyHasMore,
        isOwnListing: ownListing,
        sensitiveVisible: companyListing,
        sensitivePlaceholder: ownListing ? '正在读取' : '完成确认后可查看',
        ownSensitiveLoading: false,
        ownSensitiveLoadFailed: false,
        isVerified: canTrySensitive,
        sensitiveAuthLabel: ownListing ? '自己上传·免留痕直接展示' : (companyListing ? '直接公开' : (canTrySensitive ? '可查看' : '需实名')),
        canShareVideo,
        shareBrokerName: user.name || '',
        currentUserId: user.id || '',
        phoneCallBusy: false,
        shareStateText: canShareVideo
          ? '只转发原视频文件，不包含地址、房东电话、楼栋单元房号。'
          : (listing && listing.videoUrl ? '请先登录内部中介账号后再转发。' : '这套房源暂无可转发视频。')
      });
      if (user.id) this.flushPhoneFootprints(user.id)
      // 上传人自查自己上传的房源：直接拉取地址/房东电话填充，后端免留痕且不耗额度。
      if (ownListing && !companyListing) {
        this.loadOwnSensitive(listing.id, { requestGeneration, requestSessionKey })
      }
    }).catch((error) => {
      if (!isCurrentRequest()) return
      if (isAuthError(error)) {
        this.setData({
          listing: {},
          unavailableListing: {},
          listingLoading: false,
          listingLoadFailed: false,
          listingAccessRequired: true,
          isVerified: false,
          sensitiveVisible: false,
          canShareVideo: false
        })
        if (Number(error.statusCode) === 403) {
          this.promptLoginGuide('登录后查看合作房源', '公司房源可直接浏览；二房东和业主合作房源需要登录内部中介账号后查看。')
        }
        return
      }
      if (Number(error && error.statusCode) === 404) {
        wx.showToast({ title: '房源不存在或已下架', icon: 'none' })
        this.setData({
          listing: {},
          listingLoading: false,
          listingLoadFailed: false,
          listingAccessRequired: false,
          unavailableListing: {
            unavailable: true,
            reason: 'not-found',
            reasonText: '这套房源不存在或已下架，请返回重新找房。'
          }
        })
        return
      }
      wx.showToast({ title: '房源加载失败，请重试', icon: 'none' })
      this.setData({
        listing: {},
        unavailableListing: {},
        listingLoading: false,
        listingLoadFailed: true,
        listingLoadErrorText: '暂时无法读取这套房源，请检查网络后重试。',
        listingAccessRequired: false,
        sensitiveVisible: false,
        canShareVideo: false
      })
    });
  },

  retryListing() {
    if (this.listingId) this.loadListing(this.listingId)
  },

  openNearbyListing(event) {
    const id = String((event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id) || '')
    if (!id || !(this.data.nearbyListings || []).some((item) => String(item.id) === id)) return
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${encodeURIComponent(id)}&source=nearby`
    })
  },

  goNearbyListings() {
    const anchorId = String((this.data.listing && this.data.listing.id) || '')
    if (!anchorId || !this.data.nearbyHasMore) return
    wx.navigateTo({
      url: `/pages/nearby-listings/nearby-listings?id=${encodeURIComponent(anchorId)}`
    })
  },

  onNearbyCoverError(event) {
    const dataset = (event.currentTarget && event.currentTarget.dataset) || {}
    const index = findFailedCoverIndex(this.data.nearbyListings, dataset.id, dataset.cover)
    if (index >= 0) this.setData({ [`nearbyListings[${index}].coverUrl`]: '' })
  },

  goLoginFromListing() {
    wx.navigateTo({ url: '/pages/auth/auth' })
  },

  noop() {},

  goBackFromUnavailable() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/index/index' })
  },

  goFindHouseFromUnavailable() {
    wx.redirectTo({
      url: '/pages/match-chat/match-chat',
      fail: () => wx.switchTab({ url: '/pages/index/index' })
    })
  },

  promptLoginGuide(title, content) {
    wx.showModal({
      title: title || '需要登录',
      content: content || '该操作需要登录内部中介账号后继续。',
      cancelText: '先看看',
      confirmText: '去登录',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/auth/auth' })
      }
    })
  },

  downloadShareVideo(videoUrl) {
    return new Promise((resolve, reject) => {
      if (!wx.downloadFile) {
        reject(new Error('当前微信版本暂不支持下载视频文件'))
        return
      }
      wx.downloadFile({
        url: videoUrl,
        timeout: 60000,
        success: (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`视频下载失败：${res.statusCode}`))
            return
          }
          if (!res.tempFilePath) {
            reject(new Error('未获取到视频临时文件'))
            return
          }
          resolve(res.tempFilePath)
        },
        fail: reject
      })
    })
  },

  shareVideoFile(filePath) {
    return new Promise((resolve, reject) => {
      if (!wx.shareFileMessage) {
        reject(new Error('当前微信版本暂不支持直接发送视频文件'))
        return
      }
      wx.shareFileMessage({
        filePath,
        success: resolve,
        fail: reject
      })
    })
  },

  shareVideoMessage(filePath) {
    return new Promise((resolve, reject) => {
      if (!wx.shareVideoMessage) {
        reject(new Error('当前微信版本暂不支持直接发送视频气泡'))
        return
      }
      wx.shareVideoMessage({
        videoPath: filePath,
        success: resolve,
        fail: reject
      })
    })
  },

  saveVideoForManualShare(filePath) {
    return new Promise((resolve, reject) => {
      if (!wx.saveVideoToPhotosAlbum) {
        reject(new Error('当前微信版本暂不支持保存视频到相册'))
        return
      }
      wx.saveVideoToPhotosAlbum({
        filePath,
        success: resolve,
        fail: reject
      })
    })
  },

  recordVideoFileShare(channel) {
    const listing = this.data.listing || {}
    return apiService.recordVideoShare(listing.id, {
      channel: channel || 'wechat-file',
      target: 'tenant',
      sharePath: '',
      shareTitle: '原视频文件'
    }).then((result) => {
      if (result && result.logs) {
        this.setData({ logs: result.logs })
      }
      return result
    })
  },

  async fallbackSaveVideo(filePath) {
    try {
      await this.saveVideoForManualShare(filePath)
      await this.recordVideoFileShare('wechat-album-fallback')
      wx.showModal({
        title: '视频已保存',
        content: '当前微信版本暂不支持直接发送文件，请从相册手动发送给租客。',
        showCancel: false
      })
    } catch (error) {
      if (isAlbumAuthError(error)) {
        wx.showModal({
          title: '需要相册权限',
          content: '请允许保存视频到相册后，再手动发送给租客。',
          cancelText: '取消',
          confirmText: '去设置',
          success: (res) => {
            if (res.confirm && wx.openSetting) wx.openSetting({})
          }
        })
        return
      }
      throw error
    }
  },

  async prepareVideoShare() {
    if (!this.data.canShareVideo) {
      wx.showToast({ title: this.data.shareStateText || '暂不可转发', icon: 'none' })
      return
    }
    if (this.data.shareVideoBusy) return
    const listing = this.data.listing || {}
    if (!listing.videoUrl) {
      wx.showToast({ title: '这套房源暂无可转发视频', icon: 'none' })
      return
    }
    this.setData({
      shareVideoBusy: true,
      shareStateText: '正在准备原视频文件'
    })
    wx.showLoading({ title: '准备视频' })
    try {
      const filePath = await this.downloadShareVideo(listing.videoUrl)
      wx.hideLoading()
      try {
        await this.shareVideoMessage(filePath)
        await this.recordVideoFileShare('wechat-video')
        wx.showToast({ title: '视频已发送', icon: 'none' })
      } catch (videoShareError) {
        try {
          await this.shareVideoFile(filePath)
          await this.recordVideoFileShare('wechat-file')
          wx.showToast({ title: '视频已发送', icon: 'none' })
        } catch (fileShareError) {
          await this.fallbackSaveVideo(filePath)
        }
      }
    } catch (error) {
      wx.hideLoading()
      wx.showToast({
        title: error && (error.message || error.errMsg) ? (error.message || error.errMsg) : '视频转发未完成',
        icon: 'none'
      })
    } finally {
      this.setData({
        shareVideoBusy: false,
        shareStateText: '只转发原视频文件，不包含地址、房东电话、楼栋单元房号。'
      })
    }
  },

  // 上传人自查：调后端免留痕分支直接取地址/房东电话，不留痕、不耗额度。
  loadOwnSensitive(listingId, requestContext = {}) {
    if (!listingId) return
    const requestGeneration = requestContext.requestGeneration === undefined
      ? this.listingLoadGeneration
      : requestContext.requestGeneration
    const requestSessionKey = requestContext.requestSessionKey === undefined
      ? currentAuthSessionKey()
      : requestContext.requestSessionKey
    const isCurrentRequest = () => (
      this.listingLoadGeneration === requestGeneration && currentAuthSessionKey() === requestSessionKey
    )
    this.setData({
      ownSensitiveLoading: true,
      ownSensitiveLoadFailed: false,
      sensitiveVisible: false,
      sensitivePlaceholder: '正在读取'
    })
    return apiService.addSensitiveFootprint(listingId).then((result) => {
      if (!isCurrentRequest()) return
      const sensitive = result && result.sensitive ? result.sensitive : {}
      this.setData({
        listing: Object.assign({}, this.data.listing, sensitive),
        sensitiveVisible: true,
        sensitivePlaceholder: '',
        ownSensitiveLoading: false,
        ownSensitiveLoadFailed: false
      })
    }).catch(() => {
      if (!isCurrentRequest()) return
      this.setData({
        sensitiveVisible: false,
        sensitivePlaceholder: '读取失败，请重试',
        ownSensitiveLoading: false,
        ownSensitiveLoadFailed: true
      })
      wx.showToast({ title: '地址和电话加载失败，请重试', icon: 'none' })
    })
  },

  retryOwnSensitive() {
    const listing = this.data.listing || {}
    if (!this.data.ownSensitiveLoading && listing.id) this.loadOwnSensitive(listing.id)
  },

  flushPhoneFootprints(accountId) {
    const flushSessionKey = currentAuthSessionKey()
    if (!accountId || !currentAuthToken() || !profileSessionMatches(this.profileAuthToken, flushSessionKey) || safeText(this.data.currentUserId) !== safeText(accountId)) return Promise.resolve()
    return phoneFootprintOutbox.flushPhoneCalls(
      accountId,
      (listingId, idempotencyKey) => {
        if (currentAuthSessionKey() !== flushSessionKey || safeText(this.data.currentUserId) !== safeText(accountId)) {
          const error = new Error('账号已变化，停止本轮拨号足迹补发')
          error.stopOutboxFlush = true
          return Promise.reject(error)
        }
        return apiService.recordPhoneCallOpened(listingId, idempotencyKey)
      }
    )
  },

  callLandlord() {
    const listing = this.data.listing || {}
    const accountId = safeText(this.data.currentUserId)
    const dialSessionKey = currentAuthSessionKey()
    if (!accountId || !currentAuthToken() || !profileSessionMatches(this.profileAuthToken, dialSessionKey)) {
      this.promptLoginGuide('登录后联系房东', '打开系统拨号页需要记录本人操作，请先登录内部中介账号。')
      return
    }
    if (!this.data.sensitiveVisible) {
      wx.showToast({ title: '请先查看地址和电话', icon: 'none' })
      return
    }
    const phoneNumber = safeText(listing.companyContactPhoneText || listing.landlordPhone)
    if (!/^1[3-9]\d{9}$/.test(phoneNumber)) {
      wx.showToast({ title: '电话待补充，暂不能拨号', icon: 'none' })
      return
    }
    if (this.data.phoneCallBusy) return
    const dialContext = {
      accountId,
      sessionKey: dialSessionKey,
      listingId: safeText(listing.id),
      requestGeneration: this.listingLoadGeneration
    }
    this.setData({ phoneCallBusy: true })
    wx.makePhoneCall({
      phoneNumber,
      success: () => {
        try {
          const idempotencyKey = phoneFootprintOutbox.createPhoneCallIdempotencyKey()
          phoneFootprintOutbox.enqueuePhoneCall({
            accountId: dialContext.accountId,
            listingId: dialContext.listingId,
            idempotencyKey
          })
          const stillCurrent = currentAuthSessionKey() === dialContext.sessionKey &&
            profileSessionMatches(this.profileAuthToken, dialContext.sessionKey) &&
            safeText(this.data.currentUserId) === dialContext.accountId &&
            safeText(this.data.listing && this.data.listing.id) === dialContext.listingId &&
            this.listingLoadGeneration === dialContext.requestGeneration
          if (stillCurrent) this.flushPhoneFootprints(dialContext.accountId)
        } catch (error) {}
      },
      fail: () => {},
      complete: () => this.setData({ phoneCallBusy: false })
    })
  },

  revealSensitive() {
    if (this.data.sensitiveVisible) {
      wx.showToast({ title: this.data.isOwnListing ? '自己上传，已直接展示（免留痕）' : '已解锁地址和电话', icon: 'none' })
      return;
    }
    if (!this.data.isVerified) {
      this.promptLoginGuide('登录后查看地址电话', '查看房源地址和房东联系方式会留痕，需要先登录内部中介账号。')
      return
    }
    this.sensitiveViewIdempotencyKey = apiService.createSensitiveViewIdempotencyKey()
    this.setData({ sensitiveConfirmVisible: true })
  },

  closeSensitiveConfirm() {
    if (this.data.sensitiveSubmitting) return
    this.sensitiveViewIdempotencyKey = ''
    this.setData({ sensitiveConfirmVisible: false })
  },

  confirmRevealSensitive() {
    const listing = this.data.listing || {}
    if (this.data.sensitiveSubmitting || !listing.id) return
    const requestGeneration = this.listingLoadGeneration
    const requestSessionKey = currentAuthSessionKey()
    const listingId = listing.id
    if (!currentAuthToken() || !profileSessionMatches(this.profileAuthToken, requestSessionKey)) {
      this.sensitiveViewIdempotencyKey = ''
      this.setData({ sensitiveConfirmVisible: false, sensitiveSubmitting: false })
      this.promptLoginGuide('登录后查看地址电话', '查看房源地址和房东联系方式会留痕，需要先登录内部中介账号。')
      return Promise.resolve()
    }
    const idempotencyKey = this.sensitiveViewIdempotencyKey || apiService.createSensitiveViewIdempotencyKey()
    this.sensitiveViewIdempotencyKey = idempotencyKey
    const isCurrentRequest = () => (
      this.listingLoadGeneration === requestGeneration &&
      currentAuthSessionKey() === requestSessionKey &&
      this.data.listing && this.data.listing.id === listingId
    )
    this.setData({ sensitiveSubmitting: true })
    return apiService.addSensitiveFootprint(listingId, idempotencyKey).then((result) => {
      if (!isCurrentRequest()) return
      const logs = result && result.logs ? result.logs : result;
      const sensitive = result && result.sensitive ? result.sensitive : {};
      this.setData({
        listing: Object.assign({}, this.data.listing, sensitive),
        sensitiveVisible: true,
        sensitiveConfirmVisible: false,
        sensitiveSubmitting: false,
        logs
      });
      this.sensitiveViewIdempotencyKey = ''
      wx.showToast({
        title: '已记录查看足迹',
        icon: 'none'
      });
    }).catch((error) => {
      if (!isCurrentRequest()) return
      this.setData({ sensitiveSubmitting: false })
      const message = error && error.message ? error.message : '足迹记录失败'
      if (isAuthError(error)) {
        if (typeof apiClient.isStaleUnauthorized === 'function' && apiClient.isStaleUnauthorized(error)) {
          // 写请求绝不自动重放；同账号已续签时保留确认态与幂等键，让用户明确再点一次。
          wx.showToast({ title: '登录状态已更新，请重新确认', icon: 'none' })
          return
        }
        this.sensitiveViewIdempotencyKey = ''
        this.setData({ sensitiveConfirmVisible: false })
        this.promptLoginGuide('登录后查看地址电话', '查看房源地址和房东联系方式会留痕，需要先登录内部中介账号。')
        return
      }
      if (error && error.data && error.data.quotaExceeded) {
        wx.showModal({
          title: '今日额度已用完',
          content: message,
          showCancel: false
        })
        return
      }
      if (message.indexOf('实名') !== -1) {
        wx.showModal({
          title: '需要实名认证',
          content: message,
          confirmText: '去实名',
          success: (authRes) => {
            if (authRes.confirm) {
              wx.navigateTo({ url: '/pages/auth/auth' });
            }
          }
        })
        return
      }
      wx.showToast({ title: message, icon: 'none' })
    });
  },

  recordShowing() {
    if (this.data.showingSubmitting) return
    if (!this.data.isVerified) {
      this.promptLoginGuide('登录后记录带看', '带看水印照片会进入后台审核，需要先登录内部中介账号。')
      return
    }
    wx.showModal({
      title: '拍摄带看水印照片',
      content: '请现场拍摄带时间和地点水印的照片。提交后进入后台人工审核，通过后当天普通房源查看额度 +1。',
      confirmText: '开始拍照',
      success: (res) => {
        if (!res.confirm) return
        this.submitShowingProof()
      }
    })
  },

  async submitShowingProof() {
    const listing = this.data.listing || {}
    if (!listing.id) {
      wx.showToast({ title: '请选择房源', icon: 'none' })
      return
    }

    this.setData({ showingSubmitting: true })
    wx.showLoading({ title: '准备水印相机' })

    try {
      const photo = await chooseCameraImage()
      wx.showLoading({ title: '生成水印照片' })
      const location = await this.getShowingLocationInfo()
      const watermarked = await this.buildShowingWatermark(photo.tempFilePath, location)
      wx.showLoading({ title: '上传水印照片' })
      const policy = await apiService.createShowingPhotoUploadPolicy({
        fileName: 'showing-proof.jpg',
        mimeType: 'image/jpeg',
        size: photo.size || 0,
        tempFilePath: watermarked.tempFilePath
      })
      const uploaded = await apiService.uploadShowingPhoto(watermarked.tempFilePath, policy)
      wx.showLoading({ title: '提交审核' })
      const showingPayload = {
        photoUrl: uploaded.fileUrl,
        photoKey: uploaded.objectKey,
        watermarkText: watermarked.watermarkText,
        locationText: location.locationText,
        latitude: location.latitude,
        longitude: location.longitude
      }
      const relatedNeedId = this.data.needTemporary ? '' : safeText(this.data.needId)
      if (relatedNeedId) showingPayload.needId = relatedNeedId
      const result = await apiService.recordShowing(listing.id, showingPayload)
      this.setData({ showingPhotoPath: watermarked.tempFilePath })
      wx.hideLoading()
      wx.showToast({
        title: result.message || '带看照片已提交审核',
        icon: 'none'
      })
    } catch (error) {
      wx.hideLoading()
      wx.showModal({
        title: '提交失败',
        content: error && error.message ? error.message : '请重新拍摄带水印照片后提交',
        showCancel: false
      })
    } finally {
      this.setData({ showingSubmitting: false })
    }
  },

  getShowingLocationInfo() {
    const listing = this.data.listing || {}
    const fallback = [
      listing.locationSummary,
      listing.community,
      listing.area || listing.district,
      listing.block
    ].filter(Boolean).join(' · ') || '定位未授权，使用房源信息作为位置参考'

    return new Promise((resolve) => {
      if (!wx.getLocation) {
        resolve({ locationText: fallback, latitude: '', longitude: '' })
        return
      }
      wx.getLocation({
        type: 'gcj02',
        success: (res) => {
          const latitude = Number(res.latitude)
          const longitude = Number(res.longitude)
          const text = Number.isFinite(latitude) && Number.isFinite(longitude)
            ? `现场定位 ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
            : fallback
          resolve({
            locationText: text,
            latitude: Number.isFinite(latitude) ? latitude : '',
            longitude: Number.isFinite(longitude) ? longitude : ''
          })
        },
        fail: () => {
          resolve({ locationText: fallback, latitude: '', longitude: '' })
        }
      })
    })
  },

  async buildShowingWatermark(photoPath, location) {
    const listing = this.data.listing || {}
    const image = await getImageInfo(photoPath)
    const width = SHOWING_CANVAS_WIDTH
    const height = SHOWING_CANVAS_HEIGHT
    const ctx = wx.createCanvasContext('showingWatermarkCanvas', this)
    const imageRatio = image.width / image.height
    const canvasRatio = width / height
    let sx = 0
    let sy = 0
    let sWidth = image.width
    let sHeight = image.height

    if (imageRatio > canvasRatio) {
      sWidth = image.height * canvasRatio
      sx = (image.width - sWidth) / 2
    } else {
      sHeight = image.width / canvasRatio
      sy = (image.height - sHeight) / 2
    }

    ctx.drawImage(photoPath, sx, sy, sWidth, sHeight, 0, 0, width, height)
    ctx.setFillStyle('rgba(21, 63, 54, 0.78)')
    ctx.fillRect(0, height - 310, width, 310)
    ctx.setFillStyle('#ffffff')
    ctx.setFontSize(42)
    ctx.fillText('寓你住一起 · 带看水印', 42, height - 248)
    ctx.setFontSize(30)

    const timeText = `时间 ${formatDateTime(new Date())}`
    const houseText = `房源 ${compactText(listing.community || listing.shortTitle || listing.title, 24)}`
    const roomText = `房号 ${compactText([listing.building, listing.unit, listing.roomNumber].filter(Boolean).join('-') || listing.address, 26)}`
    const locationText = `位置 ${compactText(location.locationText, 30)}`
    const lines = [timeText, houseText, roomText].concat(splitText(locationText, 32)).slice(0, 5)
    lines.forEach((line, index) => {
      ctx.fillText(line, 42, height - 196 + index * 40)
    })

    const watermarkText = ['寓你住一起 · 带看水印'].concat(lines).join(' | ')
    const tempFilePath = await new Promise((resolve, reject) => {
      ctx.draw(false, () => {
        wx.canvasToTempFilePath({
          canvasId: 'showingWatermarkCanvas',
          x: 0,
          y: 0,
          width,
          height,
          destWidth: width,
          destHeight: height,
          fileType: 'jpg',
          quality: 0.92,
          success: (res) => resolve(res.tempFilePath),
          fail: reject
        }, this)
      })
    })

    return { tempFilePath, watermarkText }
  }
})
