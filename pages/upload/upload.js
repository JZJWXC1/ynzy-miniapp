const apiService = require('../../utils/api-service')
const gongshuCommunities = require('../../utils/gongshu-communities')
const {
  NO_FEATURE,
  NO_COMMISSION_FEATURE,
  DEPOSIT_FREE_FEATURE,
  LISTING_FEATURE_OPTIONS,
  normalizeListingFeatures
} = require('../../utils/listing-features')

// 上传是受保护操作：游客（401）进入或提交时需显式引导登录。api-client 已不再对游客
// 全局强跳登录，故上传页要自己兜底，避免游客填完表单提交才失败、失去登录引导。
function isAuthError(error) {
  return Boolean(error) && Number(error.statusCode) === 401
}

const UPLOAD_FEATURE_HIDDEN_OPTIONS = [DEPOSIT_FREE_FEATURE, NO_COMMISSION_FEATURE]
const FALLBACK_MAX_VIDEO_MB = 300 // 与服务端 OSS 策略默认上限对齐的前端预检兜底值
const DEFAULT_COMMISSION_CONFIG = {
  secondLandlordRate: 20,
  ownerRate: 20,
  companyRate: 0,
  secondLandlordPlatformRate: 10,
  ownerPlatformRate: 10
}

const defaultForm = {
  city: '杭州',
  area: '拱墅区',
  community: '',
  building: '',
  unit: '',
  roomNumber: '',
  contact: '',
  rent: '',
  rentMode: '整租',
  room: '一室',
  hall: '0厅',
  bath: '公卫',
  features: [],
  companyListing: false,
  ownerType: '二房东房源',
  // 看房方式：钥匙/密码/联系房东；房东手机号仅在「联系房东」时必填
  viewingMethod: '联系房东',
  viewingKeyLocation: '',
  viewingPassword: ''
}

function normalizePart(value, suffix) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.endsWith(suffix) ? text : `${text}${suffix}`
}

function buildLayout(form) {
  return `${form.rentMode}${form.room}${form.hall}${form.bath}`
}

function buildAddress(form) {
  const building = normalizePart(form.building, '栋')
  const unit = form.unit ? normalizePart(form.unit, '单元') : ''
  const room = normalizePart(form.roomNumber, '室')
  return [form.city, form.area, form.community, building, unit, room].filter(Boolean).join('')
}

function buildFeatureOptions(selected) {
  const values = selected || []
  return LISTING_FEATURE_OPTIONS
    .filter((name) => UPLOAD_FEATURE_HIDDEN_OPTIONS.indexOf(name) === -1)
    .map((name) => ({
      name,
      active: values.indexOf(name) !== -1
    }))
}

function isBlank(value) {
  return String(value === undefined || value === null ? '' : value).trim() === ''
}

function requiresUploadVideo(form = {}) {
  return !form.companyListing
}

function normalizeCommissionConfig(config) {
  const source = config || {}
  const upRates = source.uploaderRates || {}
  const platRates = source.platformRates || {}
  const pickRate = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : Number(value))
  return {
    secondLandlordRate: pickRate(source.secondLandlordRate, upRates['二房东房源'] === undefined ? DEFAULT_COMMISSION_CONFIG.secondLandlordRate : upRates['二房东房源']),
    ownerRate: pickRate(source.ownerRate, upRates['业主房源'] === undefined ? DEFAULT_COMMISSION_CONFIG.ownerRate : upRates['业主房源']),
    secondLandlordPlatformRate: pickRate(source.secondLandlordPlatformRate, platRates['二房东房源'] === undefined ? DEFAULT_COMMISSION_CONFIG.secondLandlordPlatformRate : platRates['二房东房源']),
    ownerPlatformRate: pickRate(source.ownerPlatformRate, platRates['业主房源'] === undefined ? DEFAULT_COMMISSION_CONFIG.ownerPlatformRate : platRates['业主房源']),
    companyRate: 0
  }
}

function commissionRuleText(form = {}, config = DEFAULT_COMMISSION_CONFIG) {
  const rule = normalizeCommissionConfig(config)
  if (form.companyListing) return '公司房源成交不抽佣，带看中介全佣'
  const rate = form.ownerType === '业主房源' ? rule.ownerRate : rule.secondLandlordRate
  return `别人带看成交你上传的这条房源，你按成交总佣金拿 ${rate}% 收益`
}

function normalizeUploadFeatures(features) {
  const next = normalizeListingFeatures(features)
    .filter((item) => item !== NO_COMMISSION_FEATURE && item !== DEPOSIT_FREE_FEATURE)
  return next.length ? next : [NO_FEATURE]
}

function normalizeCommunityText(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase()
}

function getCommunitySuggestions(keyword) {
  const normalizedKeyword = normalizeCommunityText(keyword)
  if (!normalizedKeyword) return gongshuCommunities.slice(0, 8)
  return gongshuCommunities
    .filter((name) => normalizeCommunityText(name).indexOf(normalizedKeyword) !== -1)
    .slice(0, 8)
}

function isCommunityMatched(value) {
  const normalizedValue = normalizeCommunityText(value)
  if (!normalizedValue) return false
  return gongshuCommunities.some((name) => normalizeCommunityText(name) === normalizedValue)
}

function getCommunityReviewTip(keyword) {
  const text = String(keyword || '').trim()
  if (!text) return ''
  return isCommunityMatched(text)
    ? '已匹配小区库，上架无需因小区人工审核'
    : '未匹配小区库，提交后需管理员审核通过才上架'
}

function getCommunityMessage(keyword, suggestions) {
  const text = String(keyword || '').trim()
  if (!text) return '热门小区，可输入关键字缩小范围'
  if (isCommunityMatched(text)) return '已匹配小区库，可继续填写楼栋房号'
  return suggestions.length
    ? `匹配到 ${suggestions.length} 个小区，请点选确认；直接使用手填名称将进入人工审核`
    : `未匹配到「${text}」，提交后需管理员审核通过才上架`
}

Page({
  data: {
    mode: 'create',
    pageTitle: '上传房源',
    listingId: '',
    form: Object.assign({}, defaultForm),
    currentUser: null,
    isAdmin: false,
    cityOptions: ['杭州'],
    areaOptions: ['拱墅区', '上城区', '西湖区', '滨江区', '萧山区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区'],
    rentModeOptions: ['整租', '合租'],
    roomOptions: ['一室', '二室', '三室', '四室', '五室', '六室'],
    hallOptions: ['0厅', '1厅', '2厅', '3厅', '4厅', '5厅', '6厅'],
    bathOptions: ['公卫', '1卫', '2卫', '3卫', '4卫', '5卫', '6卫'],
    ownerTypeOptions: [
      { value: '二房东房源', title: '二房东房源', desc: '合作房源，可按房态规则维护' },
      { value: '业主房源', title: '业主房源', desc: '合作房源，提交后需管理员审核通过才上架' }
    ],
    viewingMethodOptions: ['钥匙', '密码', '联系房东'],
    // 编辑态打开时的看房方式与敏感输入初值（方式可能是服务端推导值）。提交时与之比较：
    // 未切换方式则不下发方式字段；未改动的敏感输入也不下发（脏检查），
    // 让服务端此刻的最新值获胜，避免页面停留期间飞书并发更新被旧值覆盖
    initialViewingMethod: '',
    initialViewingKeyLocation: '',
    initialViewingPassword: '',
    featureOptions: buildFeatureOptions(defaultForm.features),
    communitySuggestions: [],
    communityPanelVisible: false,
    communityMatchMessage: '输入小区名后显示匹配结果，也可以直接使用手填名称',
    communityReviewTip: '',
    layoutPreview: buildLayout(defaultForm),
    addressPreview: '',
    videoPath: '',
    videoFile: null,
    existingVideoUrl: '',
    existingVideoKey: '',
    commissionConfig: DEFAULT_COMMISSION_CONFIG,
    commissionRuleText: commissionRuleText(defaultForm, DEFAULT_COMMISSION_CONFIG),
    submitting: false
  },

  onLoad(options) {
    this.loadCurrentUser()
    this.loadCommissionConfig()
    const id = options && options.id ? options.id : ''
    if (id) {
      this.loadEditableListing(id)
      return
    }
    this.refreshPreview()
  },

  loadCurrentUser() {
    apiService.getCurrentUser().then((user) => {
      this.setData({
        currentUser: user,
        isAdmin: Boolean(user && user.isAdmin)
      })
    }).catch((error) => {
      this.setData({
        currentUser: null,
        isAdmin: false
      })
      // 游客进入上传页即引导登录，别让其填完整张表单提交才失败。
      if (isAuthError(error)) {
        this.promptLoginGuide('登录后上传房源', '上传房源需要先登录内部中介账号，登录后即可发布房源。')
      }
    })
  },

  promptLoginGuide(title, content) {
    wx.showModal({
      title: title || '需要登录',
      content: content || '该操作需要先登录内部中介账号后继续。',
      confirmText: '去登录',
      cancelText: '再看看',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/auth/auth' })
      }
    })
  },

  loadCommissionConfig() {
    apiService.getCommissionConfig().then((config) => {
      const normalized = normalizeCommissionConfig(config)
      this.setData({
        commissionConfig: normalized,
        commissionRuleText: commissionRuleText(this.data.form, normalized)
      })
    }).catch(() => {
      this.setData({
        commissionConfig: DEFAULT_COMMISSION_CONFIG,
        commissionRuleText: commissionRuleText(this.data.form, DEFAULT_COMMISSION_CONFIG)
      })
    })
  },

  refreshPreview(nextForm) {
    const form = nextForm || this.data.form
    this.setData({
      layoutPreview: buildLayout(form),
      addressPreview: buildAddress(form),
      commissionRuleText: commissionRuleText(form, this.data.commissionConfig)
    })
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    const nextData = {
      [`form.${field}`]: value
    }
    this.setData(nextData, () => this.refreshPreview())
  },

  updateCommunity(event) {
    const value = event.detail.value
    const suggestions = getCommunitySuggestions(value)

    this.setData({
      'form.community': value,
      communitySuggestions: suggestions,
      communityPanelVisible: true,
      communityMatchMessage: getCommunityMessage(value, suggestions),
      communityReviewTip: getCommunityReviewTip(value)
    }, () => this.refreshPreview())
  },

  showCommunityPanel() {
    const value = this.data.form.community
    const suggestions = getCommunitySuggestions(value)
    this.setData({
      communitySuggestions: suggestions,
      communityPanelVisible: true,
      communityMatchMessage: getCommunityMessage(value, suggestions),
      communityReviewTip: getCommunityReviewTip(value)
    })
  },

  chooseCommunity(event) {
    const name = event.currentTarget.dataset.name
    this.setData({
      'form.community': name,
      communitySuggestions: [],
      communityPanelVisible: false,
      communityMatchMessage: '已匹配小区库',
      communityReviewTip: getCommunityReviewTip(name)
    }, () => this.refreshPreview())
  },

  useTypedCommunity() {
    const name = String(this.data.form.community || '').trim()
    if (!name) return
    this.setData({
      'form.community': name,
      communitySuggestions: [],
      communityPanelVisible: false,
      communityMatchMessage: isCommunityMatched(name) ? '已匹配小区库' : '已使用手填小区，提交后需人工审核',
      communityReviewTip: getCommunityReviewTip(name)
    }, () => this.refreshPreview())
  },

  updatePicker(event) {
    const field = event.currentTarget.dataset.field
    const optionsName = event.currentTarget.dataset.options
    const options = this.data[optionsName] || []
    const value = options[Number(event.detail.value)] || ''
    if (!value) return
    this.setData({
      [`form.${field}`]: value
    }, () => this.refreshPreview())
  },

  selectLayoutOption(event) {
    const field = event.currentTarget.dataset.field
    const value = event.currentTarget.dataset.value
    this.setData({
      [`form.${field}`]: value
    }, () => this.refreshPreview())
  },

  toggleFeature(event) {
    const value = event.currentTarget.dataset.value
    if (!value) return
    const current = this.data.form.features || []
    let next = current.slice()
    if (value === NO_FEATURE) {
      next = current.indexOf(NO_FEATURE) === -1 ? [NO_FEATURE] : []
    } else {
      next = current.filter((item) => item !== NO_FEATURE)
      if (next.indexOf(value) === -1) {
        next.push(value)
      } else {
        next = next.filter((item) => item !== value)
      }
    }
    const normalizedFeatures = next.length ? normalizeUploadFeatures(next) : []
    this.setData({
      'form.features': normalizedFeatures,
      featureOptions: buildFeatureOptions(normalizedFeatures)
    })
  },

  selectListingSource(event) {
    const companyListing = event.currentTarget.dataset.company === '1'
    if (companyListing && !this.data.isAdmin) {
      wx.showToast({ title: '只有管理员可以上传公司房源', icon: 'none' })
      return
    }
    const features = normalizeUploadFeatures(this.data.form.features)
    this.setData({
      'form.companyListing': companyListing,
      'form.features': features,
      featureOptions: buildFeatureOptions(features)
    }, () => this.refreshPreview())
  },

  selectOwnerType(event) {
    const ownerType = event.currentTarget.dataset.value || '二房东房源'
    if (this.data.form.companyListing) return
    this.setData({
      'form.ownerType': ownerType
    }, () => this.refreshPreview())
  },

  chooseVideo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      // 相册视频交给微信转码压缩，弱网上传成功率更高；仅约束拍摄时长
      sizeType: ['compressed'],
      maxDuration: 60,
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        const tempFilePath = file ? file.tempFilePath : ''
        // 大小预检：超过上限直接拦下，避免弱网白传几分钟后失败
        const maxBytes = FALLBACK_MAX_VIDEO_MB * 1024 * 1024
        if (file && file.size > maxBytes) {
          const sizeMB = Math.round(file.size / 1024 / 1024)
          wx.showModal({
            title: '视频过大',
            content: `所选视频约 ${sizeMB}MB，超过 ${FALLBACK_MAX_VIDEO_MB}MB 上限。请截取关键片段或压缩后再上传。`,
            showCancel: false
          })
          return
        }
        const fileName = tempFilePath ? tempFilePath.split('/').pop() : 'listing-video.mp4'
        this.setData({
          videoPath: tempFilePath,
          videoFile: file
            ? {
                tempFilePath,
                fileName,
                size: file.size || 0,
                mimeType: 'video/mp4'
              }
            : null
        })
      }
    })
  },

  loadEditableListing(id) {
    wx.showLoading({ title: '正在加载房源' })
    apiService.getEditableListing(id).then((listing) => {
      const nextForm = {
        city: listing.city || '杭州',
        area: listing.district || listing.area || '拱墅区',
        community: listing.community || '',
        building: listing.building || '',
        unit: listing.unit || '',
        roomNumber: listing.roomNumber || '',
        contact: listing.contact || listing.landlordPhone || '',
        rent: listing.rent || '',
        rentMode: listing.rentMode || listing.type || '整租',
        room: listing.room || '一室',
        hall: listing.hall || '0厅',
        bath: listing.bath || '公卫',
        features: normalizeUploadFeatures(listing.features),
        companyListing: Boolean(listing.companyListing),
        ownerType: listing.ownerType || listing.houseSourceType || '二房东房源',
        // 服务端已按存量信息推导 viewingMethod（有密码→密码，有电话→联系房东）；兜底同口径
        viewingMethod: listing.viewingMethod || (listing.viewingPassword ? '密码' : '联系房东'),
        viewingKeyLocation: listing.viewingKeyLocation || '',
        viewingPassword: listing.viewingPassword || ''
      }
      this.setData({
        mode: 'edit',
        pageTitle: '修改房源',
        listingId: id,
        form: nextForm,
        initialViewingMethod: nextForm.viewingMethod,
        initialViewingKeyLocation: nextForm.viewingKeyLocation,
        initialViewingPassword: nextForm.viewingPassword,
        featureOptions: buildFeatureOptions(nextForm.features),
        communityMatchMessage: getCommunityMessage(nextForm.community, getCommunitySuggestions(nextForm.community)),
        communityReviewTip: getCommunityReviewTip(nextForm.community),
        existingVideoUrl: listing.videoUrl || '',
        existingVideoKey: listing.videoKey || '',
        videoPath: '',
        videoFile: null
      }, () => this.refreshPreview(nextForm))
      wx.hideLoading()
    }).catch((error) => {
      wx.hideLoading()
      wx.showModal({
        title: '加载失败',
        content: error.message || '无法读取该房源',
        showCancel: false
      })
    })
  },

  validateForm() {
    const form = this.data.form
    const { community, building, unit, roomNumber, contact, rent, rentMode } = form
    const address = buildAddress(form)
    const layout = buildLayout(form)
    const communityMatched = isCommunityMatched(community)
    const needsManualReview = Boolean(community) && !communityMatched

    const hasNewVideo = Boolean(this.data.videoPath && this.data.videoFile)
    const hasExistingVideo = this.data.mode === 'edit' && Boolean(this.data.existingVideoUrl)
    const hasVideo = hasNewVideo || hasExistingVideo
    const videoRequired = requiresUploadVideo(form)
    const viewingMethod = form.viewingMethod || '联系房东'
    const missingFields = []
    if (isBlank(community)) missingFields.push('小区名称')
    if (isBlank(building)) missingFields.push('几栋')
    if (isBlank(unit)) missingFields.push('几单元')
    if (isBlank(roomNumber)) missingFields.push('房间号')
    if (isBlank(rentMode)) missingFields.push('租法')
    // 房东手机号只在看房方式=联系房东时必填；钥匙/密码各自必填对应信息
    if (viewingMethod === '钥匙' && isBlank(form.viewingKeyLocation)) missingFields.push('钥匙在哪')
    if (viewingMethod === '密码' && isBlank(form.viewingPassword)) missingFields.push('看房密码')
    if (viewingMethod === '联系房东' && isBlank(contact)) missingFields.push('房东手机号')
    if (isBlank(rent)) missingFields.push('租金')
    if (videoRequired && !hasVideo) missingFields.push(this.data.mode === 'edit' ? '房源视频（原房源无视频时需补传）' : '房源视频')
    if (missingFields.length) {
      return {
        ok: false,
        message: `请补充：${missingFields.join('、')}`
      }
    }

    if (form.companyListing && !this.data.isAdmin) {
      return {
        ok: false,
        message: '只有管理员可以上传公司房源'
      }
    }

    if (!form.features || !form.features.length) {
      return {
        ok: false,
        message: '请选择房源特点标签，若没有特点请选择无'
      }
    }

    return {
      ok: true,
      address,
      layout,
      communityMatched,
      communityMatchStatus: communityMatched ? '已匹配' : '未匹配',
      needsManualReview,
      manualReviewReason: needsManualReview ? '小区名称未匹配小区库' : ''
    }
  },

  buildSubmitPayload(validation, video) {
    const form = this.data.form
    const payload = {
      city: form.city,
      district: form.area,
      area: form.area,
      block: form.area,
      communityName: form.community,
      community: form.community,
      buildingNo: form.building,
      building: form.building,
      unitNo: form.unit,
      unit: form.unit,
      roomNo: form.roomNumber,
      houseNo: form.roomNumber,
      roomNumber: form.roomNumber,
      address: validation.address,
      contact: form.contact,
      rent: form.rent,
      layout: validation.layout,
      type: form.rentMode,
      rentMode: form.rentMode,
      bedroom: form.room,
      room: form.room,
      livingRoom: form.hall,
      hall: form.hall,
      bathroom: form.bath,
      bath: form.bath,
      features: normalizeUploadFeatures(form.features),
      companyListing: Boolean(form.companyListing),
      ownerType: form.ownerType || '二房东房源',
      houseSourceType: form.ownerType || '二房东房源',
      source: form.companyListing ? '公司房源' : (form.ownerType || '二房东房源'),
      communityMatched: validation.communityMatched,
      communityMatchStatus: validation.communityMatchStatus,
      requiresManualReview: validation.needsManualReview,
      manualReviewReason: validation.manualReviewReason
    }
    // 编辑态未切换看房方式时，不下发方式与非当前方式字段：服务端下发的可能是存量推导值（并非库里显式方式），
    // 原样回传会把推导值物化落库，并误清空另一方式字段里的旧值——如飞书公司房源存于 viewingPassword 的
    // 「15号空出」腾房备注，只改租金保存也会被写空。切换方式（或新建）才显式下发并清非当前方式旧值。
    const method = form.viewingMethod || '联系房东'
    const methodChanged = this.data.mode !== 'edit' || method !== this.data.initialViewingMethod
    if (methodChanged) {
      payload.viewingMethod = method
      payload.viewingKeyLocation = method === '钥匙' ? form.viewingKeyLocation : ''
      payload.viewingPassword = method === '密码' ? form.viewingPassword : ''
    } else {
      // 未切换方式：仅当用户确实改动了当前方式的可见输入才下发（脏检查）；未改动则省略该键，
      // 让服务端此刻的最新值获胜——否则页面停留期间飞书并发写入的新备注/新密码会被页面旧值覆盖
      if (method === '钥匙' && form.viewingKeyLocation !== this.data.initialViewingKeyLocation) {
        payload.viewingKeyLocation = form.viewingKeyLocation
      }
      if (method === '密码' && form.viewingPassword !== this.data.initialViewingPassword) {
        payload.viewingPassword = form.viewingPassword
      }
    }
    if (video) {
      payload.videoUrl = video.fileUrl
      payload.videoKey = video.objectKey
    }
    return payload
  },

  async submitWithVideo(validation) {
    if (this.data.submitting) return

    this.setData({ submitting: true })

    try {
      let video = null
      if (this.data.videoPath && this.data.videoFile) {
        wx.showLoading({ title: '正在上传视频' })
        const policy = await apiService.createVideoUploadPolicy(this.data.videoFile)
        // 以服务端策略返回的上限为准做二次校验
        if (policy && policy.maxSize && this.data.videoFile.size > policy.maxSize) {
          const limitMB = Math.round(policy.maxSize / 1024 / 1024)
          throw new Error(`视频超过服务端 ${limitMB}MB 上限，请压缩后重试`)
        }
        let lastShownPercent = -5
        video = await apiService.uploadVideo(this.data.videoPath, policy, {
          onProgress: (percent) => {
            // 每 5% 刷新一次进度文案，避免 loading 高频闪烁
            if (percent - lastShownPercent >= 5 || percent >= 100) {
              lastShownPercent = percent
              wx.showLoading({ title: `上传视频 ${percent}%` })
            }
          }
        })
      }

      wx.showLoading({ title: this.data.mode === 'edit' ? '正在保存修改' : '正在提交房源' })
      const payload = this.buildSubmitPayload(validation, video)
      if (this.data.mode === 'edit') {
        await apiService.updateNormalListing(this.data.listingId, payload)
      } else {
        await apiService.addNormalListing(payload)
      }
      wx.hideLoading()
      if (this.data.mode === 'edit') {
        wx.showModal({
          title: '保存成功',
          content: '房源信息已更新，返回后可在我的房源中查看最新状态。',
          showCancel: false,
          confirmText: '返回',
          success: () => {
            wx.navigateBack({
              fail: () => wx.redirectTo({ url: '/pages/my-listings/my-listings' })
            })
          }
        })
      } else {
        this.setData({
          form: Object.assign({}, defaultForm),
          featureOptions: buildFeatureOptions(defaultForm.features),
          communitySuggestions: [],
          communityPanelVisible: false,
          communityMatchMessage: '输入小区名后显示匹配结果，也可以直接使用手填名称',
          communityReviewTip: '',
          layoutPreview: buildLayout(defaultForm),
          addressPreview: '',
          videoPath: '',
          videoFile: null,
          existingVideoUrl: '',
          existingVideoKey: ''
        })
        wx.showModal({
          title: '上传成功',
          content: '房源已提交。若小区或业主合作房源需要审核，通过后会展示给中介找房使用。',
          cancelText: '继续上传',
          confirmText: '查看房源',
          success: (res) => {
            if (!res.confirm) return
            wx.navigateTo({
              url: '/pages/my-listings/my-listings',
              fail: () => wx.redirectTo({ url: '/pages/my-listings/my-listings' })
            })
          }
        })
      }
    } catch (error) {
      wx.hideLoading()
      // 兜底：提交时才暴露的 401（如游客未登录）给出「去登录」引导，而不是笼统的失败提示。
      if (isAuthError(error)) {
        this.promptLoginGuide('登录后上传房源', '上传房源需要先登录内部中介账号。')
      } else {
        wx.showModal({
          title: this.data.mode === 'edit' ? '修改失败' : '上传失败',
          content: error.message || '请检查视频存储配置和网络后重试',
          showCancel: false
        })
      }
    } finally {
      this.setData({ submitting: false })
    }
  },

  submitListing() {
    const validation = this.validateForm()
    if (!validation.ok) {
      wx.showModal({
        title: '还差一点',
        content: validation.message,
        showCancel: false
      })
      return
    }

    const reviewReasons = []
    if (!this.data.form.companyListing) {
      if (this.data.form.ownerType === '业主房源') reviewReasons.push('业主房源需管理员审核通过后才上架')
      if (validation.needsManualReview) reviewReasons.push('小区未匹配小区库，需管理员审核通过后才上架')
    }
    const normalTip = this.data.mode === 'edit' ? '保存后将更新该房源展示信息。' : '提交后进入合作房源库。'
    const listingTip = this.data.form.companyListing
      ? '公司房源仅管理员维护。'
      : `合作房源 / ${this.data.form.ownerType || '二房东房源'}，${reviewReasons.length ? `${reviewReasons.join('；')}。` : normalTip}`

    wx.showModal({
      title: this.data.mode === 'edit' ? '确认修改房源' : '确认上传房源',
      content: `${validation.address}，${validation.layout}，${this.data.commissionRuleText}。${listingTip}`,
      confirmText: this.data.mode === 'edit' ? '保存修改' : '确认上传',
      success: (res) => {
        if (!res.confirm) return
        this.submitWithVideo(validation)
      }
    })
  }
})
