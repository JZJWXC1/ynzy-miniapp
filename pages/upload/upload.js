const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')
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

function isStaffAccount(user) {
  if (!user || user.isAdmin) return false
  const accountTypeText = String(user.accountType || '').trim()
  const accountType = accountTypeText === 'staff' || accountTypeText === '员工' || accountTypeText === '内部员工' || accountTypeText === '员工账号'
    ? 'staff'
    : (accountTypeText === 'broker' || accountTypeText === '中介' || accountTypeText === '中介账号' ? 'broker' : '')
  const role = String(user.role || '').trim()
  if (accountTypeText) {
    if (accountType !== 'staff') return false
    return !role || role === '员工' || /^内部员工(?:\s*·.*)?$/.test(role)
  }
  return role === '员工' || /^内部员工(?:\s*·.*)?$/.test(role)
}

function uploadSuccessMessage(listing) {
  const reviewStatus = String((listing && listing.reviewStatus) || '').trim()
  if (reviewStatus === '已通过') return '房源已直接通过并发布，可在我的房源中查看最新状态。'
  if (reviewStatus === '待审核') return '房源已提交审核，通过后会展示给中介找房使用。'
  return '房源已发布，可在我的房源中查看最新状态。'
}

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}

function currentAuthToken() {
  return String(typeof apiClient.getAuthToken === 'function' ? apiClient.getAuthToken() : '')
}

function staleAuthSessionError() {
  const error = new Error('登录账号已切换，本次上传已停止')
  error.staleSession = true
  return error
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
  block: '',
  community: '',
  building: '',
  unit: '',
  roomNumber: '',
  contact: '',
  remark: '',
  landlordCommissionPercent: 50,
  rent: '',
  rentMode: '整租',
  room: '一室',
  hall: '0厅',
  bath: '公卫',
  features: [],
  companyListing: false,
  ownerType: '二房东房源',
  // 看房方式：钥匙/密码/联系房东；合作房源所有方式均需房东手机号，公司房源可留空
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

function remarkContainsContact(value) {
  const text = String(value || '').trim().normalize('NFKC')
  if (!text) return false
  const compact = text.replace(/[\s\-—_()（）+.,，:：]/g, '')
  if (/1[3-9]\d{9}/.test(compact)) return true
  return /微信|微\s*信|wei\s*xin|we\s*chat|二维码|https?:\/\/|www\.|(?:^|[^a-z0-9])(?:wx|vx|v信|微号)(?:\s*[:：号]?)/i.test(text)
}

function requiresUploadVideo(form = {}) {
  return !form.companyListing
}

function normalizeCommissionConfig(config) {
  const source = config || {}
  const upRates = source.uploaderRates || {}
  const platRates = source.platformRates || {}
  const pickRate = (primary, mapped, label) => {
    const raw = primary === undefined || primary === null || primary === '' ? mapped : primary
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${label}配置无效`)
    }
    return value
  }
  const normalized = {
    secondLandlordRate: pickRate(source.secondLandlordRate, upRates['二房东房源'], '二房东上传人比例'),
    ownerRate: pickRate(source.ownerRate, upRates['业主房源'], '业主上传人比例'),
    secondLandlordPlatformRate: pickRate(source.secondLandlordPlatformRate, platRates['二房东房源'], '二房东平台比例'),
    ownerPlatformRate: pickRate(source.ownerPlatformRate, platRates['业主房源'], '业主平台比例'),
    companyRate: 0
  }
  if (normalized.secondLandlordRate + normalized.secondLandlordPlatformRate > 100) {
    throw new Error('二房东分佣比例合计不能超过 100%')
  }
  if (normalized.ownerRate + normalized.ownerPlatformRate > 100) {
    throw new Error('业主分佣比例合计不能超过 100%')
  }
  return normalized
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

function getCommunityReviewTip(keyword, isStaff) {
  const text = String(keyword || '').trim()
  if (!text) return ''
  if (isStaff) {
    return isCommunityMatched(text)
      ? '已匹配小区库，员工账号提交后直接通过'
      : '未匹配小区库；员工账号仍会直接通过，地图坐标需后台补充'
  }
  return isCommunityMatched(text)
    ? '已匹配小区库，上架无需因小区人工审核'
    : '未匹配小区库，提交后需管理员审核通过才上架'
}

function getCommunityMessage(keyword, suggestions, isStaff) {
  const text = String(keyword || '').trim()
  if (!text) return '热门小区，可输入关键字缩小范围'
  if (isCommunityMatched(text)) return '已匹配小区库，可继续填写楼栋房号'
  if (isStaff) {
    return suggestions.length
      ? `匹配到 ${suggestions.length} 个小区，请点选确认；直接手填也会按员工权限通过`
      : `未匹配到「${text}」，可直接提交；坐标后续由后台补充`
  }
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
    isStaff: false,
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
    commissionConfig: null,
    commissionConfigLoading: false,
    commissionConfigReady: false,
    commissionConfigFailed: false,
    commissionRuleText: '正在同步分佣规则',
    submitting: false
  },

  onLoad(options) {
    this._pageActive = true
    this.authTokenSnapshot = currentAuthSessionKey()
    this.authHadLoginSnapshot = Boolean(currentAuthToken())
    const id = options && options.id ? String(options.id) : ''
    this.editingListingId = id
    this.loadCurrentUser()
    this.loadCommissionConfig()
    if (id) {
      this.loadEditableListing(id)
      return
    }
    this.refreshPreview()
  },

  onShow() {
    this._pageActive = true
    // 后台可能已调整分佣比例：每次显示页面都以服务端为准重新拉取，避免展示后台修改前的旧比例。
    // loadCommissionConfig 自带 activeCommissionRequestId 代次守卫，重复调用安全。
    this.loadCommissionConfig()
    const nextToken = currentAuthSessionKey()
    const previousHadLogin = this.authHadLoginSnapshot === true
    const nextHadLogin = Boolean(currentAuthToken())
    if (this.authTokenSnapshot === undefined) {
      this.authTokenSnapshot = nextToken
      this.authHadLoginSnapshot = nextHadLogin
      return
    }
    if (nextToken === this.authTokenSnapshot) return
    this.authTokenSnapshot = nextToken
    this.authHadLoginSnapshot = nextHadLogin
    this._submitRequestSeq = Number(this._submitRequestSeq || 0) + 1
    this._submitConfirmationSeq = Number(this._submitConfirmationSeq || 0) + 1
    this._mediaOperationSeq = Number(this._mediaOperationSeq || 0) + 1
    if (wx.hideLoading) wx.hideLoading()

    const editingListingId = String(this.editingListingId || (this.data.mode === 'edit' ? this.data.listingId : '') || '')
    const resetPatch = {
      currentUser: null,
      isAdmin: false,
      isStaff: false,
      submitting: false
    }
    if (editingListingId || previousHadLogin) {
      const resetForm = Object.assign({}, defaultForm, { features: (defaultForm.features || []).slice() })
      Object.assign(resetPatch, {
        mode: editingListingId ? 'edit' : 'create',
        pageTitle: editingListingId ? '修改房源' : '上传房源',
        listingId: editingListingId || '',
        form: resetForm,
        initialViewingMethod: '',
        initialViewingKeyLocation: '',
        initialViewingPassword: '',
        featureOptions: buildFeatureOptions(resetForm.features),
        communitySuggestions: [],
        communityPanelVisible: false,
        communityMatchMessage: editingListingId
          ? '正在按当前账号重新读取房源'
          : '输入小区名后显示匹配结果，也可以直接使用手填名称',
        communityReviewTip: '',
        layoutPreview: buildLayout(resetForm),
        addressPreview: '',
        videoPath: '',
        videoFile: null,
        existingVideoUrl: '',
        existingVideoKey: ''
      })
    } else if (this.data.form && this.data.form.companyListing) {
      // 公司房源选择来自上一账号的管理员能力；换号后先收回，待当前账号资料返回后再由用户显式选择。
      const resetForm = Object.assign({}, this.data.form, { companyListing: false })
      Object.assign(resetPatch, {
        form: resetForm,
        featureOptions: buildFeatureOptions(resetForm.features)
      })
    }
    this.setData(resetPatch, () => this.refreshPreview())
    this.loadCurrentUser()
    if (editingListingId) this.loadEditableListing(editingListingId)
    if (this.data.commissionConfigFailed) this.loadCommissionConfig()
  },

  onUnload() {
    this._pageActive = false
    this._currentUserRequestSeq = Number(this._currentUserRequestSeq || 0) + 1
    this._editableListingRequestSeq = Number(this._editableListingRequestSeq || 0) + 1
    this._submitRequestSeq = Number(this._submitRequestSeq || 0) + 1
    this._submitConfirmationSeq = Number(this._submitConfirmationSeq || 0) + 1
    this._mediaOperationSeq = Number(this._mediaOperationSeq || 0) + 1
    this.activeCommissionRequestId = `unloaded-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    if (wx.hideLoading) wx.hideLoading()
  },

  beginUploadPageOperation(sequenceField, extra = {}) {
    const sequence = Number(this[sequenceField] || 0) + 1
    this[sequenceField] = sequence
    return Object.assign({
      sequenceField,
      sequence,
      sessionKey: currentAuthSessionKey()
    }, extra)
  },

  isUploadPageOperationCurrent(operation) {
    return Boolean(operation) &&
      this._pageActive !== false &&
      this[operation.sequenceField] === operation.sequence &&
      currentAuthSessionKey() === operation.sessionKey
  },

  submitDraftFingerprint() {
    const file = this.data.videoFile || {}
    return JSON.stringify({
      mode: this.data.mode,
      listingId: this.data.listingId,
      form: this.data.form || {},
      videoPath: this.data.videoPath || '',
      videoFile: {
        tempFilePath: file.tempFilePath || '',
        fileName: file.fileName || '',
        size: Number(file.size || 0)
      },
      existingVideoUrl: this.data.existingVideoUrl || '',
      existingVideoKey: this.data.existingVideoKey || '',
      commissionConfigReady: Boolean(this.data.commissionConfigReady),
      commissionRuleText: this.data.commissionRuleText || '',
      commissionConfig: this.data.commissionConfig || null,
      commissionRequestId: this.activeCommissionRequestId || ''
    })
  },

  beginSubmitConfirmation(validation) {
    return this.beginUploadPageOperation('_submitConfirmationSeq', {
      draftFingerprint: this.submitDraftFingerprint(),
      validationFingerprint: JSON.stringify({
        address: validation.address,
        layout: validation.layout,
        communityMatched: Boolean(validation.communityMatched),
        communityMatchStatus: validation.communityMatchStatus || '',
        needsManualReview: Boolean(validation.needsManualReview),
        manualReviewReason: validation.manualReviewReason || ''
      })
    })
  },

  isSubmitConfirmationCurrent(operation) {
    return this.isUploadPageOperationCurrent(operation) &&
      operation.draftFingerprint === this.submitDraftFingerprint()
  },

  loadCurrentUser() {
    const requestSeq = Number(this._currentUserRequestSeq || 0) + 1
    const requestSessionKey = currentAuthSessionKey()
    const requestAuthToken = currentAuthToken()
    this._currentUserRequestSeq = requestSeq
    return apiService.getCurrentUser().then((user) => {
      if (this._currentUserRequestSeq !== requestSeq || currentAuthSessionKey() !== requestSessionKey) return
      const isStaff = isStaffAccount(user)
      const community = String(this.data.form.community || '').trim()
      const suggestions = getCommunitySuggestions(community)
      this.setData({
        currentUser: user,
        isAdmin: Boolean(user && user.isAdmin),
        isStaff,
        communityMatchMessage: getCommunityMessage(community, suggestions, isStaff),
        communityReviewTip: getCommunityReviewTip(community, isStaff)
      })
    }).catch((error) => {
      if (this._currentUserRequestSeq !== requestSeq) return
      const sameSession = currentAuthSessionKey() === requestSessionKey
      // 游客请求的真实 401 可能让 api-client 生成新的 guest 会话键；仍需保留本页的显式登录引导。
      const currentGuestAuthError = isAuthError(error) && !requestAuthToken && !currentAuthToken()
      if (!sameSession && !currentGuestAuthError) return
      this.setData({
        currentUser: null,
        isAdmin: false,
        isStaff: false
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
    if (this._pageActive === false) return
    const requestId = `commission-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    this.activeCommissionRequestId = requestId
    this._submitConfirmationSeq = Number(this._submitConfirmationSeq || 0) + 1
    this._commissionRetryPromptSeq = Number(this._commissionRetryPromptSeq || 0) + 1
    this.setData({
      commissionConfigLoading: true,
      commissionConfigReady: false,
      commissionConfigFailed: false,
      commissionRuleText: this.data.form.companyListing ? '公司房源成交不抽佣，带看中介全佣' : '正在同步分佣规则'
    })
    apiService.getCommissionConfig().then((config) => {
      if (this._pageActive === false || this.activeCommissionRequestId !== requestId) return
      const normalized = normalizeCommissionConfig(config)
      this.setData({
        commissionConfig: normalized,
        commissionConfigLoading: false,
        commissionConfigReady: true,
        commissionConfigFailed: false,
        commissionRuleText: commissionRuleText(this.data.form, normalized)
      })
    }).catch(() => {
      if (this._pageActive === false || this.activeCommissionRequestId !== requestId) return
      this.setData({
        commissionConfig: null,
        commissionConfigLoading: false,
        commissionConfigReady: false,
        commissionConfigFailed: true,
        commissionRuleText: this.data.form.companyListing ? '公司房源成交不抽佣，带看中介全佣' : '分佣规则加载失败，请重试'
      })
      wx.showToast({ title: '分佣规则加载失败', icon: 'none' })
    })
  },

  retryCommissionConfig() {
    if (this._pageActive === false) return
    if (!this.data.commissionConfigLoading) this.loadCommissionConfig()
  },

  ensureCommissionConfigReady() {
    if (this.data.form.companyListing || this.data.commissionConfigReady) return true
    if (this.data.commissionConfigLoading) {
      wx.showToast({ title: '正在同步分佣规则，请稍候', icon: 'none' })
      return false
    }
    const retryOperation = this.beginUploadPageOperation('_commissionRetryPromptSeq')
    wx.showModal({
      title: '分佣规则尚未同步',
      content: '为避免展示错误比例，请先重新读取后台当前分佣规则。',
      cancelText: '暂不提交',
      confirmText: '重新加载',
      success: (res) => {
        if (res.confirm && this.isUploadPageOperationCurrent(retryOperation)) this.retryCommissionConfig()
      }
    })
    return false
  },

  refreshPreview(nextForm) {
    const form = nextForm || this.data.form
    let nextCommissionRuleText = this.data.commissionRuleText
    if (form.companyListing) {
      nextCommissionRuleText = '公司房源成交不抽佣，带看中介全佣'
    } else if (this.data.commissionConfigReady && this.data.commissionConfig) {
      nextCommissionRuleText = commissionRuleText(form, this.data.commissionConfig)
    } else if (this.data.commissionConfigLoading) {
      nextCommissionRuleText = '正在同步分佣规则'
    } else if (this.data.commissionConfigFailed) {
      nextCommissionRuleText = '分佣规则加载失败，请重试'
    }
    this.setData({
      layoutPreview: buildLayout(form),
      addressPreview: buildAddress(form),
      commissionRuleText: nextCommissionRuleText
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
      communityMatchMessage: getCommunityMessage(value, suggestions, this.data.isStaff),
      communityReviewTip: getCommunityReviewTip(value, this.data.isStaff)
    }, () => this.refreshPreview())
  },

  showCommunityPanel() {
    const value = this.data.form.community
    const suggestions = getCommunitySuggestions(value)
    this.setData({
      communitySuggestions: suggestions,
      communityPanelVisible: true,
      communityMatchMessage: getCommunityMessage(value, suggestions, this.data.isStaff),
      communityReviewTip: getCommunityReviewTip(value, this.data.isStaff)
    })
  },

  chooseCommunity(event) {
    const name = event.currentTarget.dataset.name
    this.setData({
      'form.community': name,
      communitySuggestions: [],
      communityPanelVisible: false,
      communityMatchMessage: '已匹配小区库',
      communityReviewTip: getCommunityReviewTip(name, this.data.isStaff)
    }, () => this.refreshPreview())
  },

  useTypedCommunity() {
    const name = String(this.data.form.community || '').trim()
    if (!name) return
    this.setData({
      'form.community': name,
      communitySuggestions: [],
      communityPanelVisible: false,
      communityMatchMessage: isCommunityMatched(name)
        ? '已匹配小区库'
        : (this.data.isStaff ? '已使用手填小区，按员工权限直接通过' : '已使用手填小区，提交后需人工审核'),
      communityReviewTip: getCommunityReviewTip(name, this.data.isStaff)
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
    const operation = this.beginUploadPageOperation('_mediaOperationSeq')
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      // 相册视频交给微信转码压缩，弱网上传成功率更高；仅约束拍摄时长
      sizeType: ['compressed'],
      maxDuration: 60,
      success: (res) => {
        if (!this.isUploadPageOperationCurrent(operation)) return
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
    const listingId = String(id || '')
    const requestSeq = Number(this._editableListingRequestSeq || 0) + 1
    const requestSessionKey = currentAuthSessionKey()
    this._editableListingRequestSeq = requestSeq
    this.editingListingId = listingId
    const isCurrentRequest = () => (
      this._editableListingRequestSeq === requestSeq &&
      currentAuthSessionKey() === requestSessionKey &&
      String(this.editingListingId || '') === listingId
    )
    wx.showLoading({ title: '正在加载房源' })
    return apiService.getEditableListing(listingId).then((listing) => {
      if (!isCurrentRequest()) return
      const nextForm = {
        city: listing.city || '杭州',
        area: listing.district || listing.area || '拱墅区',
        block: listing.block || '',
        community: listing.community || '',
        building: listing.building || '',
        unit: listing.unit || '',
        roomNumber: listing.roomNumber || '',
        contact: listing.contact || listing.landlordPhone || '',
        remark: listing.remark || '',
        landlordCommissionPercent: listing.landlordCommissionPercent === undefined || listing.landlordCommissionPercent === null
          ? 50
          : listing.landlordCommissionPercent,
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
        listingId,
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
    }).catch((error) => {
      if (!isCurrentRequest()) return
      wx.showModal({
        title: '加载失败',
        content: error.message || '无法读取该房源',
        showCancel: false
      })
    }).finally(() => {
      if (this._editableListingRequestSeq === requestSeq && wx.hideLoading) wx.hideLoading()
    })
  },

  validateForm() {
    const form = this.data.form
    const { community, building, roomNumber, contact, rent, rentMode } = form
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
    if (isBlank(roomNumber)) missingFields.push('房间号')
    if (isBlank(rentMode)) missingFields.push('租法')
    // 合作房源所有方式都必须填写房东手机号；公司详情只使用服务器统一号码，允许留空
    if (viewingMethod === '钥匙' && isBlank(form.viewingKeyLocation)) missingFields.push('钥匙在哪')
    if (viewingMethod === '密码' && isBlank(form.viewingPassword)) missingFields.push('看房密码')
    if (!form.companyListing && isBlank(contact)) missingFields.push('房东手机号')
    if (isBlank(form.landlordCommissionPercent)) missingFields.push('房东佣金占月租比例')
    if (isBlank(rent)) missingFields.push('租金')
    if (videoRequired && !hasVideo) missingFields.push(this.data.mode === 'edit' ? '房源视频（原房源无视频时需补传）' : '房源视频')
    if (missingFields.length) {
      return {
        ok: false,
        message: `请补充：${missingFields.join('、')}`
      }
    }

    if (!isBlank(contact) && !/^1[3-9]\d{9}$/.test(String(contact).trim())) {
      return {
        ok: false,
        message: '请输入 11 位房东手机号'
      }
    }

    const landlordCommissionRaw = form.landlordCommissionPercent
    const landlordCommissionText = String(landlordCommissionRaw).trim()
    const landlordCommissionTypeValid = typeof landlordCommissionRaw === 'number' || typeof landlordCommissionRaw === 'string'
    const landlordCommissionFormatValid = typeof landlordCommissionRaw === 'number'
      ? Number.isInteger(landlordCommissionRaw)
      : /^\d+$/.test(landlordCommissionText)
    const landlordCommissionPercent = landlordCommissionTypeValid && landlordCommissionFormatValid ? Number(landlordCommissionText) : Number.NaN
    if (!Number.isInteger(landlordCommissionPercent) || landlordCommissionPercent < 0 || landlordCommissionPercent > 100) {
      return {
        ok: false,
        message: '房东佣金占月租比例必须是 0 至 100 的整数'
      }
    }

    const remark = String(form.remark || '').trim()
    if (Array.from(remark).length > 200) {
      return { ok: false, message: '房源备注最多 200 字' }
    }
    if (remarkContainsContact(remark)) {
      return { ok: false, message: '房源备注不能包含手机号、微信号等联系方式' }
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
      block: String(form.block || '').trim(),
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
      remark: String(form.remark || '').trim(),
      landlordCommissionPercent: Number(String(form.landlordCommissionPercent).trim()),
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
      payload.videoUploadTicket = video.uploadTicket || ''
    }
    return payload
  },

  async submitWithVideo(validation, confirmationOperation) {
    if (this.data.submitting) return

    if (confirmationOperation) {
      if (!this.isSubmitConfirmationCurrent(confirmationOperation)) return
      const currentValidation = this.validateForm()
      if (!currentValidation.ok) return
      const currentValidationFingerprint = JSON.stringify({
        address: currentValidation.address,
        layout: currentValidation.layout,
        communityMatched: Boolean(currentValidation.communityMatched),
        communityMatchStatus: currentValidation.communityMatchStatus || '',
        needsManualReview: Boolean(currentValidation.needsManualReview),
        manualReviewReason: currentValidation.manualReviewReason || ''
      })
      if (currentValidationFingerprint !== confirmationOperation.validationFingerprint) return
      validation = currentValidation
      // 消费确认上下文，防止同一原生回调被重复触发而二次写入。
      this._submitConfirmationSeq = Number(this._submitConfirmationSeq || 0) + 1
    }

    const requestSeq = Number(this._submitRequestSeq || 0) + 1
    const requestSessionKey = currentAuthSessionKey()
    const requestAuthToken = currentAuthToken()
    const submitMode = this.data.mode
    const submitListingId = this.data.listingId
    this._submitRequestSeq = requestSeq
    const isCurrentRequest = () => (
      this._pageActive !== false &&
      this._submitRequestSeq === requestSeq &&
      currentAuthSessionKey() === requestSessionKey
    )
    const assertCurrentRequest = () => {
      if (!isCurrentRequest()) throw staleAuthSessionError()
    }
    this.setData({ submitting: true })

    try {
      assertCurrentRequest()
      let video = null
      let savedListing = null
      if (this.data.videoPath && this.data.videoFile) {
        const videoPath = this.data.videoPath
        const videoFile = this.data.videoFile
        wx.showLoading({ title: '正在上传视频' })
        const policy = await apiService.createVideoUploadPolicy(videoFile)
        assertCurrentRequest()
        // 以服务端策略返回的上限为准做二次校验
        if (policy && policy.maxSize && videoFile.size > policy.maxSize) {
          const limitMB = Math.round(policy.maxSize / 1024 / 1024)
          throw new Error(`视频超过服务端 ${limitMB}MB 上限，请压缩后重试`)
        }
        let lastShownPercent = -5
        video = await apiService.uploadVideo(videoPath, policy, {
          onProgress: (percent) => {
            if (!isCurrentRequest()) return
            // 每 5% 刷新一次进度文案，避免 loading 高频闪烁
            if (percent - lastShownPercent >= 5 || percent >= 100) {
              lastShownPercent = percent
              wx.showLoading({ title: `上传视频 ${percent}%` })
            }
          }
        })
        assertCurrentRequest()
      }

      assertCurrentRequest()
      wx.showLoading({ title: submitMode === 'edit' ? '正在保存修改' : '正在提交房源' })
      const payload = this.buildSubmitPayload(validation, video)
      assertCurrentRequest()
      if (submitMode === 'edit') {
        savedListing = await apiService.updateNormalListing(submitListingId, payload)
      } else {
        savedListing = await apiService.addNormalListing(payload)
      }
      assertCurrentRequest()
      wx.hideLoading()
      if (submitMode === 'edit') {
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
          content: uploadSuccessMessage(savedListing),
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
      const latestRequest = this._submitRequestSeq === requestSeq
      if (latestRequest && wx.hideLoading) wx.hideLoading()
      const currentGuestAuthError = isAuthError(error) && !requestAuthToken && !currentAuthToken()
      if ((error && error.staleSession) || (!isCurrentRequest() && !currentGuestAuthError)) return
      // 兜底：提交时才暴露的 401（如游客未登录）给出「去登录」引导，而不是笼统的失败提示。
      if (isAuthError(error)) {
        if (typeof apiClient.isStaleUnauthorized === 'function' && apiClient.isStaleUnauthorized(error)) {
          // 写请求绝不自动重放；同账号已续签时只恢复按钮，交给用户明确重新提交。
          wx.showToast({ title: '登录状态已更新，请重新提交', icon: 'none' })
          return
        }
        this.promptLoginGuide('登录后上传房源', '上传房源需要先登录内部中介账号。')
      } else {
        wx.showModal({
          title: submitMode === 'edit' ? '修改失败' : '上传失败',
          content: error.message || '请检查视频存储配置和网络后重试',
          showCancel: false
        })
      }
    } finally {
      if (this._submitRequestSeq === requestSeq) this.setData({ submitting: false })
    }
  },

  submitListing() {
    if (!this.ensureCommissionConfigReady()) return
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
    const confirmationOperation = this.beginSubmitConfirmation(validation)

    wx.showModal({
      title: this.data.mode === 'edit' ? '确认修改房源' : '确认上传房源',
      content: `${validation.address}，${validation.layout}，${this.data.commissionRuleText}。${listingTip}`,
      confirmText: this.data.mode === 'edit' ? '保存修改' : '确认上传',
      success: (res) => {
        if (!res.confirm) return
        if (!this.isSubmitConfirmationCurrent(confirmationOperation)) return
        this.submitWithVideo(validation, confirmationOperation)
      }
    })
  }
})
