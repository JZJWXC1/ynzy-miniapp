const apiService = require('../../utils/api-service')
const gongshuCommunities = require('../../utils/gongshu-communities')
const {
  NO_FEATURE,
  NO_COMMISSION_FEATURE,
  DEPOSIT_FREE_FEATURE,
  LISTING_FEATURE_OPTIONS,
  normalizeListingFeatures
} = require('../../utils/listing-features')

const UPLOAD_FEATURE_HIDDEN_OPTIONS = ['整租', '合租']

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
  commissionRate: '20',
  companyListing: false,
  ownerType: '二房东房源'
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

function normalizeFeaturesForCommission(features, commissionRate, companyListing) {
  let next = normalizeListingFeatures(features)
  const noCommission = companyListing || Number(commissionRate) === 0 || next.indexOf(NO_COMMISSION_FEATURE) !== -1
  if (!noCommission) return next
  next = next.filter((item) => item !== NO_FEATURE)
  if (companyListing && next.indexOf(DEPOSIT_FREE_FEATURE) === -1) next.push(DEPOSIT_FREE_FEATURE)
  if (next.indexOf(NO_COMMISSION_FEATURE) === -1) next.push(NO_COMMISSION_FEATURE)
  return next.length ? next : [NO_COMMISSION_FEATURE]
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
      { value: '二房东房源', title: '二房东房源', desc: '普通上架，按房态规则维护' },
      { value: '业主房源', title: '业主房源', desc: '提交后需管理员审核通过才上架' }
    ],
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
    points: 2,
    submitting: false
  },

  onLoad(options) {
    this.loadCurrentUser()
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
    }).catch(() => {
      this.setData({
        currentUser: null,
        isAdmin: false
      })
    })
  },

  refreshPreview(nextForm) {
    const form = nextForm || this.data.form
    this.setData({
      layoutPreview: buildLayout(form),
      addressPreview: buildAddress(form)
    })
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    const nextData = {
      [`form.${field}`]: value
    }
    if (field === 'commissionRate') {
      const rawFeatures = Number(value) === 0 || this.data.form.companyListing
        ? this.data.form.features
        : (this.data.form.features || []).filter((item) => item !== NO_COMMISSION_FEATURE)
      const features = normalizeFeaturesForCommission(rawFeatures, value, this.data.form.companyListing)
      nextData['form.features'] = features
      nextData.featureOptions = buildFeatureOptions(features)
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
    if (this.data.form.companyListing && value === DEPOSIT_FREE_FEATURE && current.indexOf(DEPOSIT_FREE_FEATURE) !== -1) {
      wx.showToast({ title: '公司房源默认免押金', icon: 'none' })
      return
    }
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
    const removingNoCommission = value === NO_COMMISSION_FEATURE && current.indexOf(NO_COMMISSION_FEATURE) !== -1
    const addingNoCommission = value === NO_COMMISSION_FEATURE && current.indexOf(NO_COMMISSION_FEATURE) === -1
    const commissionRate = addingNoCommission || this.data.form.companyListing
      ? '0'
      : (removingNoCommission ? '20' : this.data.form.commissionRate)
    next = normalizeFeaturesForCommission(next, commissionRate, this.data.form.companyListing)
    this.setData({
      'form.commissionRate': commissionRate,
      'form.features': next,
      featureOptions: buildFeatureOptions(next)
    })
  },

  selectListingSource(event) {
    const companyListing = event.currentTarget.dataset.company === '1'
    if (companyListing && !this.data.isAdmin) {
      wx.showToast({ title: '只有管理员可以上传公司房源', icon: 'none' })
      return
    }
    const commissionRate = companyListing ? '0' : (this.data.form.commissionRate === '0' ? '20' : this.data.form.commissionRate)
    const features = normalizeFeaturesForCommission(this.data.form.features, commissionRate, companyListing)
    this.setData({
      'form.companyListing': companyListing,
      'form.commissionRate': commissionRate,
      'form.features': features,
      featureOptions: buildFeatureOptions(features)
    })
  },

  selectOwnerType(event) {
    const ownerType = event.currentTarget.dataset.value || '二房东房源'
    if (this.data.form.companyListing) return
    this.setData({
      'form.ownerType': ownerType
    })
  },

  chooseVideo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        const tempFilePath = file ? file.tempFilePath : ''
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
        features: normalizeFeaturesForCommission(listing.features, listing.commissionRate, listing.companyListing),
        commissionRate: listing.commissionRate === undefined ? '20' : String(listing.commissionRate),
        companyListing: Boolean(listing.companyListing),
        ownerType: listing.ownerType || listing.houseSourceType || '二房东房源'
      }
      this.setData({
        mode: 'edit',
        pageTitle: '修改房源',
        listingId: id,
        form: nextForm,
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
    const { community, building, unit, roomNumber, contact, rent, commissionRate } = form
    const rate = commissionRate === '' ? 20 : Number(commissionRate)
    const address = buildAddress(form)
    const layout = buildLayout(form)
    const communityMatched = isCommunityMatched(community)
    const needsManualReview = Boolean(community) && !communityMatched

    const hasVideo = this.data.videoPath || this.data.existingVideoUrl
    const missingFields = []
    if (isBlank(community)) missingFields.push('小区名称')
    if (isBlank(building)) missingFields.push('几栋')
    if (isBlank(unit)) missingFields.push('几单元')
    if (isBlank(roomNumber)) missingFields.push('房间号')
    if (isBlank(contact)) missingFields.push('房东联系方式')
    if (isBlank(rent)) missingFields.push('租金')
    if (!hasVideo) missingFields.push('房源视频')
    if (missingFields.length) {
      return {
        ok: false,
        message: `请补充：${missingFields.join('、')}`
      }
    }

    if (Number.isNaN(rate) || rate < 0 || rate > 20) {
      return {
        ok: false,
        message: '分佣比例需在 0-20%'
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
      rate: form.companyListing ? 0 : rate,
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
      commissionRate: validation.rate,
      features: normalizeFeaturesForCommission(form.features, validation.rate, form.companyListing),
      companyListing: Boolean(form.companyListing),
      ownerType: form.ownerType || '二房东房源',
      houseSourceType: form.ownerType || '二房东房源',
      source: form.companyListing ? '公司房源' : (form.ownerType || '二房东房源'),
      noCommission: form.companyListing || Number(validation.rate) === 0,
      communityMatched: validation.communityMatched,
      communityMatchStatus: validation.communityMatchStatus,
      requiresManualReview: validation.needsManualReview,
      manualReviewReason: validation.manualReviewReason
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
        video = await apiService.uploadVideo(this.data.videoPath, policy)
      }

      wx.showLoading({ title: this.data.mode === 'edit' ? '正在保存修改' : '正在提交房源' })
      const payload = this.buildSubmitPayload(validation, video)
      if (this.data.mode === 'edit') {
        await apiService.updateNormalListing(this.data.listingId, payload)
      } else {
        await apiService.addNormalListing(payload)
      }
      wx.hideLoading()
      wx.showToast({
        title: this.data.mode === 'edit' ? '修改成功' : '房源上传成功',
        icon: 'success'
      })
      if (this.data.mode === 'edit') {
        setTimeout(() => wx.navigateBack(), 500)
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
      }
    } catch (error) {
      wx.hideLoading()
      wx.showModal({
        title: this.data.mode === 'edit' ? '修改失败' : '上传失败',
        content: error.message || '请检查视频存储配置和网络后重试',
        showCancel: false
      })
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
    const normalTip = this.data.mode === 'edit' ? '保存后将更新该房源展示信息。' : '提交后进入普通房源库。'
    const listingTip = this.data.form.companyListing
      ? '公司房源仅管理员维护，免押金且成交不分佣。'
      : `${this.data.form.ownerType || '二房东房源'}，${reviewReasons.length ? `${reviewReasons.join('；')}。` : normalTip}`

    wx.showModal({
      title: this.data.mode === 'edit' ? '确认修改房源' : '确认上传房源',
      content: `${validation.address}，${validation.layout}，${validation.rate === 0 ? '不分佣' : `分佣比例 ${validation.rate}%`}。${listingTip}`,
      confirmText: this.data.mode === 'edit' ? '保存修改' : '确认上传',
      success: (res) => {
        if (!res.confirm) return
        this.submitWithVideo(validation)
      }
    })
  }
})
