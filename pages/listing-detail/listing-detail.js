const apiService = require('../../utils/api-service')

const SHOWING_CANVAS_WIDTH = 900
const SHOWING_CANVAS_HEIGHT = 1200
const SENSITIVE_PURPOSE_OPTIONS = ['带客户看房', '报备前核对', '签约前确认']

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

function isUnsupportedApiError(error) {
  const message = String((error && (error.errMsg || error.message)) || '').toLowerCase()
  return /not\s+support|unsupported|未支持|不支持|not\s+function|undefined/.test(message)
}

function isAlbumAuthError(error) {
  const message = String((error && (error.errMsg || error.message)) || '')
  return /auth|authorize|permission|deny|denied|scope\.writePhotosAlbum/i.test(message)
}

function isAuthError(error) {
  return error && (error.statusCode === 401 || error.statusCode === 403)
}

function decodeOption(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return value
  }
}

function needIdFromResult(result) {
  const data = result || {}
  return data.needId || data.id || (data.need && (data.need.needId || data.need.id)) || ''
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
    listing: {},
    logs: [],
    showingSubmitting: false,
    showingPhotoPath: '',
    showingCanvasWidth: SHOWING_CANVAS_WIDTH,
    showingCanvasHeight: SHOWING_CANVAS_HEIGHT,
    reportModalVisible: false,
    dealModalVisible: false,
    sensitivePurposeModalVisible: false,
    reportSubmitting: false,
    dealSubmitting: false,
    sensitiveSubmitting: false,
    sensitivePurposeOptions: SENSITIVE_PURPOSE_OPTIONS,
    sensitivePurpose: SENSITIVE_PURPOSE_OPTIONS[0],
    sensitivePurposeCustom: '',
    canShareVideo: false,
    shareVideoBusy: false,
    shareStateText: '登录中介账号后，可把原视频文件发送给租客。',
    shareBrokerName: '',
    needId: '',
    needTemporary: false,
    entrySource: '',
    reportForm: {
      customerName: '',
      customerPhone: ''
    },
    dealForm: {
      monthlyRent: '',
      landlordCommission: '',
      remark: ''
    },
    currentReportId: ''
  },

  onLoad(options) {
    const id = options.id;
    const needId = decodeOption(options.needId)
    if (!id) {
      wx.showToast({ title: '请选择房源', icon: 'none' });
      return;
    }
    this.setData({
      needId,
      needTemporary: /^TMP-NEED-/.test(needId),
      entrySource: decodeOption(options.source)
    })
    this.loadListing(id);
  },

  loadListing(id) {
    Promise.all([
      apiService.getListingDetail(id),
      apiService.getListingLogs(id).catch(() => []),
      // profile 只影响“可查看敏感信息”按钮态，属辅助请求：任何失败（鉴权或网络/5xx）都降级为
      // 未登录空用户，不能因它 fail-fast 拖垮整个 Promise.all，否则公司房源在弱网下会误报
      // “房源不存在或已下架”（此时 getListingDetail 往往已成功）。
      apiService.getProfileState().catch(() => ({ user: {} }))
    ]).then(([listing, logs, profile]) => {
      const user = profile && profile.user ? profile.user : {}
      const canTrySensitive = Boolean(
        user.isAdmin ||
        user.authed === '已实名' ||
        user.authed === '手机号登录' ||
        String(user.role || '').indexOf('中介') !== -1
      )
      const canShareVideo = Boolean(listing && listing.videoUrl && (user.id || canTrySensitive))
      const companyListing = Boolean(listing && listing.companyListing)
      this.setData({
        listing,
        logs,
        sensitiveVisible: companyListing,
        isVerified: canTrySensitive,
        sensitiveAuthLabel: companyListing ? '直接公开' : (canTrySensitive ? '可查看' : '需实名'),
        canShareVideo,
        shareBrokerName: user.name || '',
        shareStateText: canShareVideo
          ? '只转发原视频文件，不包含地址、房东电话、楼栋单元房号。'
          : (listing && listing.videoUrl ? '请先登录内部中介账号后再转发。' : '这套房源暂无可转发视频。')
      });
    }).catch((error) => {
      if (isAuthError(error)) {
        this.promptLoginGuide('登录后查看合作房源', '公司房源可直接浏览；二房东和业主合作房源需要登录内部中介账号后查看。')
        return
      }
      wx.showToast({ title: '房源不存在或已下架', icon: 'none' })
    });
  },

  noop() {},

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
        await this.shareVideoFile(filePath)
        await this.recordVideoFileShare('wechat-file')
        wx.showToast({ title: '视频已发送', icon: 'none' })
      } catch (shareError) {
        if (!isUnsupportedApiError(shareError)) throw shareError
        await this.fallbackSaveVideo(filePath)
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

  revealSensitive() {
    if (this.data.sensitiveVisible) {
      wx.showToast({ title: '已解锁地址和电话', icon: 'none' })
      return;
    }
    if (!this.data.isVerified) {
      this.promptLoginGuide('登录后查看地址电话', '查看房源地址和房东联系方式会留痕，需要先登录内部中介账号。')
      return
    }
    if (!this.data.needId) {
      wx.showModal({
        title: '先绑定需求单',
        content: '查看地址和电话需要尽量绑定客户需求。可用当前房源创建一条最小需求单后继续。',
        cancelText: '先不查看',
        confirmText: '创建需求',
        success: (res) => {
          if (!res.confirm) return
          this.createMinimalNeedForListing().then(() => {
            this.openSensitivePurposeModal()
          }).catch(() => {})
        }
      })
      return
    }
    this.openSensitivePurposeModal()
  },

  openSensitivePurposeModal() {
    this.setData({
      sensitivePurposeModalVisible: true,
      sensitivePurpose: this.data.sensitivePurpose || SENSITIVE_PURPOSE_OPTIONS[0],
      sensitivePurposeCustom: ''
    })
  },

  closeSensitivePurposeModal() {
    if (this.data.sensitiveSubmitting) return
    this.setData({ sensitivePurposeModalVisible: false })
  },

  chooseSensitivePurpose(event) {
    const purpose = event.currentTarget.dataset.purpose || ''
    if (!purpose) return
    this.setData({ sensitivePurpose: purpose })
  },

  updateSensitivePurposeCustom(event) {
    this.setData({ sensitivePurposeCustom: event.detail.value })
  },

  createMinimalNeedForListing() {
    if (!this.data.isVerified) {
      this.promptLoginGuide('登录后绑定需求', '创建需求单、报备和查看敏感信息都需要先登录内部中介账号。')
      return Promise.reject(new Error('请先登录内部中介账号'))
    }
    const listing = this.data.listing || {}
    if (!listing.id) return Promise.reject(new Error('请选择房源'))
    const community = listing.community || listing.shortTitle || listing.title || ''
    const confirmedNeed = {
      community,
      area: listing.area || listing.district || '',
      layout: listing.layout || '',
      rentMode: listing.rentMode || listing.type || '',
      budget: listing.rent || '',
      maxBudget: listing.rent || ''
    }
    const rawText = [
      community ? `客户对${community}感兴趣` : '客户对当前房源感兴趣',
      listing.rent ? `预算约${listing.rent}元/月` : '',
      listing.layout ? `户型${listing.layout}` : '',
      listing.rentMode || listing.type ? `租住方式${listing.rentMode || listing.type}` : ''
    ].filter(Boolean).join('，')
    wx.showLoading({ title: '创建需求单' })
    return apiService.createRentalNeed({
      source: 'listing-detail',
      listingId: listing.id,
      rawText,
      text: rawText,
      confirmedNeed,
      form: confirmedNeed
    }).then((result) => {
      wx.hideLoading()
      const needId = needIdFromResult(result)
      this.setData({
        needId,
        needTemporary: Boolean(result && result.temporary)
      })
      if (result && result.temporary) {
        wx.showToast({ title: '已用临时需求单继续', icon: 'none' })
      }
      return result
    }).catch((error) => {
      wx.hideLoading()
      wx.showModal({
        title: '需求单创建失败',
        content: error && error.message ? error.message : '请稍后重试',
        showCancel: false
      })
      throw error
    })
  },

  submitSensitivePurpose() {
    const listing = this.data.listing || {}
    const purpose = safeText(this.data.sensitivePurposeCustom) || safeText(this.data.sensitivePurpose)
    if (!purpose) {
      wx.showToast({ title: '请选择或填写用途', icon: 'none' })
      return
    }
    if (!this.data.needId) {
      wx.showToast({ title: '请先创建或选择需求单', icon: 'none' })
      return
    }
    if (this.data.sensitiveSubmitting || !listing.id) return
    this.setData({ sensitiveSubmitting: true })
    apiService.addSensitiveFootprint(listing.id, {
      needId: this.data.needId,
      purpose,
      action: '查看地址和电话'
    }).then((result) => {
      const logs = result && result.logs ? result.logs : result;
      const sensitive = result && result.sensitive ? result.sensitive : {};
      this.setData({
        listing: Object.assign({}, this.data.listing, sensitive),
        sensitiveVisible: true,
        sensitivePurposeModalVisible: false,
        sensitiveSubmitting: false,
        logs
      });
      wx.showToast({
        title: '已记录查看足迹',
        icon: 'none'
      });
    }).catch((error) => {
      this.setData({ sensitiveSubmitting: false })
      const message = error && error.message ? error.message : '足迹记录失败'
      if (isAuthError(error)) {
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

  confirmRevealSensitive() {
    wx.showModal({
      title: '确认查看敏感信息',
      content: '查看后将留下用途、需求单和足迹，并同步给房源上传人和管理员后台。',
      confirmText: '确认查看',
      success: (res) => {
        if (!res.confirm) return;
        this.submitSensitivePurpose()
      }
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
      const result = await apiService.recordShowing(listing.id, {
        photoUrl: uploaded.fileUrl,
        photoKey: uploaded.objectKey,
        watermarkText: watermarked.watermarkText,
        locationText: location.locationText,
        latitude: location.latitude,
        longitude: location.longitude
      })
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
  },

  startReportDeal() {
    if (!this.data.isVerified) {
      this.promptLoginGuide('登录后报备签单', '报备客户和提交签单需要先登录内部中介账号。')
      return
    }
    const listing = this.data.listing || {}
    this.setData({
      reportModalVisible: true,
      dealModalVisible: false,
      currentReportId: '',
      'dealForm.monthlyRent': listing.rent || '',
      'dealForm.landlordCommission': '',
      'dealForm.remark': ''
    })
  },

  closeReportModal() {
    if (this.data.reportSubmitting) return
    this.setData({ reportModalVisible: false })
  },

  closeDealModal() {
    if (this.data.dealSubmitting) return
    this.setData({ dealModalVisible: false })
  },

  updateReportField(event) {
    const field = event.currentTarget.dataset.field
    if (!field) return
    this.setData({ [`reportForm.${field}`]: event.detail.value })
  },

  updateDealField(event) {
    const field = event.currentTarget.dataset.field
    if (!field) return
    this.setData({ [`dealForm.${field}`]: event.detail.value })
  },

  submitClientReport() {
    if (!this.data.isVerified) {
      this.promptLoginGuide('登录后报备客户', '报备客户需要先登录内部中介账号。')
      return
    }
    const listing = this.data.listing || {}
    const form = this.data.reportForm || {}
    const customerPhone = safeText(form.customerPhone)
    if (!/^1[3-9]\d{9}$/.test(customerPhone)) {
      wx.showToast({ title: '请填写客户手机号', icon: 'none' })
      return
    }
    if (!listing.id || this.data.reportSubmitting) return
    this.setData({ reportSubmitting: true })
    const needId = this.data.needId
    if (!needId) {
      this.createMinimalNeedForListing().then((result) => {
        const createdNeedId = needIdFromResult(result) || this.data.needId
        this.submitClientReportWithNeed(listing, form, customerPhone, createdNeedId)
      }).catch(() => {
        this.setData({ reportSubmitting: false })
      })
      return
    }
    this.submitClientReportWithNeed(listing, form, customerPhone, needId)
  },

  submitClientReportWithNeed(listing, form, customerPhone, needId) {
    if (!needId) {
      this.setData({ reportSubmitting: false })
      wx.showToast({ title: '请先绑定需求单', icon: 'none' })
      return
    }
    apiService.createClientReport(listing.id, {
      customerName: safeText(form.customerName),
      customerPhone,
      needId
    }).then((result) => {
      const report = result && result.report ? result.report : result
      this.setData({
        reportSubmitting: false,
        reportModalVisible: false,
        dealModalVisible: true,
        currentReportId: report.id || '',
        'dealForm.monthlyRent': listing.rent || '',
        'dealForm.landlordCommission': '',
        'dealForm.remark': ''
      })
      wx.showToast({ title: '报备已创建', icon: 'none' })
    }).catch((error) => {
      this.setData({ reportSubmitting: false })
      wx.showModal({
        title: '报备失败',
        content: error && error.message ? error.message : '请稍后重试',
        showCancel: false
      })
    })
  },

  submitDealFromReport() {
    const reportId = this.data.currentReportId
    const form = this.data.dealForm || {}
    const monthlyRent = Number(form.monthlyRent)
    const landlordCommission = Number(form.landlordCommission)
    if (!reportId) {
      wx.showToast({ title: '请先完成报备', icon: 'none' })
      return
    }
    if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) {
      wx.showToast({ title: '请填写成交月租', icon: 'none' })
      return
    }
    if (!Number.isFinite(landlordCommission) || landlordCommission <= 0) {
      wx.showToast({ title: '请填写房东实付佣金', icon: 'none' })
      return
    }
    if (this.data.dealSubmitting) return
    this.setData({ dealSubmitting: true })
    apiService.createDealFromReport(reportId, {
      monthlyRent,
      landlordCommission,
      needId: this.data.needId,
      remark: safeText(form.remark)
    }).then((result) => {
      this.setData({
        dealSubmitting: false,
        dealModalVisible: false,
        currentReportId: ''
      })
      wx.showModal({
        title: '签单已提交',
        content: (result && result.message) || '待管理员确认后生成正式分佣记录。',
        showCancel: false
      })
    }).catch((error) => {
      this.setData({ dealSubmitting: false })
      wx.showModal({
        title: '签单失败',
        content: error && error.message ? error.message : '请稍后重试',
        showCancel: false
      })
    })
  }
})
