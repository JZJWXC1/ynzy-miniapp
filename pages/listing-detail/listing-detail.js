const apiService = require('../../utils/api-service')

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
    isVerified: true,
    sensitiveAuthLabel: '可查看',
    sensitiveVisible: false,
    listing: {},
    logs: [],
    showingSubmitting: false,
    showingPhotoPath: '',
    showingCanvasWidth: SHOWING_CANVAS_WIDTH,
    showingCanvasHeight: SHOWING_CANVAS_HEIGHT
  },

  onLoad(options) {
    const id = options.id;
    if (!id) {
      wx.showToast({ title: '请选择房源', icon: 'none' });
      return;
    }
    this.loadListing(id);
  },

  loadListing(id) {
    Promise.all([
      apiService.getListingDetail(id),
      apiService.getListingLogs(id),
      apiService.getProfileState()
    ]).then(([listing, logs, profile]) => {
      const user = profile && profile.user ? profile.user : {}
      const canTrySensitive = Boolean(
        user.isAdmin ||
        user.authed === '已实名' ||
        user.authed === '手机号登录' ||
        String(user.role || '').indexOf('中介') !== -1
      )
      this.setData({
        listing,
        logs,
        sensitiveVisible: false,
        isVerified: canTrySensitive,
        sensitiveAuthLabel: canTrySensitive ? '可查看' : '需实名'
      });
    }).catch(() => {
      wx.showToast({ title: '房源不存在或已下架', icon: 'none' })
    });
  },

  revealSensitive() {
    if (this.data.sensitiveVisible) {
      wx.showToast({ title: '已解锁地址和电话', icon: 'none' })
      return;
    }

    wx.showModal({
      title: '确认查看敏感信息',
      content: '查看后将留下足迹，并同步给房源上传人和管理员后台，用于防跳单监控。',
      confirmText: '确认查看',
      success: (res) => {
        if (!res.confirm) return;
        apiService.addSensitiveFootprint(this.data.listing.id, '查看地址和电话').then((result) => {
          const logs = result && result.logs ? result.logs : result;
          const sensitive = result && result.sensitive ? result.sensitive : {};
          this.setData({
            listing: Object.assign({}, this.data.listing, sensitive),
            sensitiveVisible: true,
            logs
          });
          wx.showToast({
            title: '已记录查看足迹',
            icon: 'none'
          });
        }).catch((error) => {
          const message = error && error.message ? error.message : '足迹记录失败'
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
      }
    });
  },

  recordShowing() {
    if (this.data.showingSubmitting) return
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

  registerDeal() {
    const listing = this.data.listing || {}
    wx.showModal({
      title: '确认登记成交',
      content: listing.noCommission
        ? '该房源为不分佣房源，登记后只同步成交状态，不生成分佣记录。'
        : `登记后将按上传人设置的 ${listing.commissionRate}% 分佣，状态同步到管理员后台。`,
      confirmText: '登记成交',
      success: (res) => {
        if (!res.confirm) return;
        apiService.registerDeal(this.data.listing.id).then((result) => {
          wx.showToast({
            title: result.message || '成交已登记',
            icon: 'none'
          });
          this.loadListing(this.data.listing.id);
        }).catch(() => {
          wx.showToast({ title: '成交登记失败', icon: 'none' })
        });
      }
    });
  }
})