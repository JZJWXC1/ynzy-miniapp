const llmService = require('../../utils/llm-service')
const voiceInput = require('../../utils/voice-input')
const listingDisplay = require('../../utils/listing-display')
const {
  NO_FEATURE,
  LISTING_FEATURE_OPTIONS,
  parseFeatureInput
} = require('../../utils/listing-features')

function buildFeatureOptions(selected) {
  const current = selected || []
  return LISTING_FEATURE_OPTIONS.map((name) => ({
    name,
    active: current.indexOf(name) !== -1
  }))
}

function trimValue(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function canConfirmForm(form) {
  const data = form || {}
  const coreCount = [
    Boolean(trimValue(data.budget) || trimValue(data.maxBudget) || trimValue(data.minBudget)),
    Boolean(trimValue(data.area) || trimValue(data.community)),
    Boolean(trimValue(data.layout) || trimValue(data.rentMode))
  ].filter(Boolean).length
  return coreCount >= 2
}

function formFromNeed(need, currentForm) {
  const data = need || {}
  const current = currentForm || {}
  return Object.assign({}, current, {
    budget: data.budgetText || data.maxBudget || data.budget || current.budget || '',
    area: data.area || current.area || '',
    community: data.community || current.community || '',
    rentMode: data.rentMode || current.rentMode || '',
    layout: data.layout || current.layout || '',
    features: data.features && data.features.length ? data.features : (current.features || [])
  })
}

function payloadForm(form) {
  const data = form || {}
  return {
    budget: trimValue(data.budget),
    area: trimValue(data.area),
    community: trimValue(data.community),
    rentMode: trimValue(data.rentMode),
    layout: trimValue(data.layout),
    features: parseFeatureInput(data.features).filter((item) => item !== NO_FEATURE)
  }
}

function buildGuideTips(form, needText, voiceText) {
  const tips = []
  const text = [needText, voiceText].filter(Boolean).join('，')
  if (!form.budget && text.indexOf('预算') === -1) tips.push('补充预算后排序更准')
  if (!form.area && !form.community && !/(滨江|萧山|上城|拱墅|西湖|余杭|临平|钱塘|区域|小区|商圈)/.test(text)) tips.push('补充区域或小区')
  if (!form.layout && !form.rentMode && !/(一室|两室|二室|三室|整租|合租|公寓|户型)/.test(text)) tips.push('补充户型或租住方式')
  if (!form.features || !form.features.length) tips.push('选择阳台、燃气、近地铁等特点')
  return tips
}

Page({
  data: {
    needText: '客户预算3000左右，想住滨江西兴，两室，带阳台和燃气',
    form: {
      budget: '',
      area: '',
      community: '',
      rentMode: '',
      layout: '',
      features: []
    },
    featureOptions: buildFeatureOptions([]),
    guideTips: buildGuideTips({ features: [] }, '客户预算3000左右，想住滨江西兴，两室，带阳台和燃气', ''),
    messages: [
      {
        role: 'assistant',
        text: '把租客预算、区域、户型和特点发给我，我会先整理字段，确认后再匹配房源。'
      }
    ],
    parsedNeed: [],
    listings: [],
    hasRecognized: false,
    hasMatched: false,
    canConfirm: false,
    followUpQuestion: '',
    isVoiceListening: false,
    voiceText: '',
    voiceTip: '可使用语音转写，也可手动输入修正文本'
  },

  onLoad(options) {
    this.initVoiceInput()
    const decodedVoiceText = options.voiceText ? decodeURIComponent(options.voiceText) : ''
    const nextForm = Object.assign({}, this.data.form, {
      budget: options.budget || '',
      area: options.area || '',
      layout: options.layout || ''
    })
    const nextData = {
      form: nextForm,
      guideTips: buildGuideTips(nextForm, this.data.needText, decodedVoiceText)
    }
    if (decodedVoiceText) nextData.voiceText = decodedVoiceText
    this.setData(nextData, () => {
      if (options.budget || options.area || options.layout || options.voiceText) this.runMatch()
    })
  },

  onHide() {
    this.cleanupVoiceInput()
  },

  onUnload() {
    this.cleanupVoiceInput()
  },

  cleanupVoiceInput() {
    if (!this.voiceController) return
    if (typeof this.voiceController.cancel === 'function') {
      this.voiceController.cancel()
    } else if (this.data.isVoiceListening) {
      this.voiceController.stop()
    }
    if (this.data.isVoiceListening) {
      this.setData({ isVoiceListening: false })
    }
  },

  initVoiceInput() {
    const support = voiceInput.getSupportStatus ? voiceInput.getSupportStatus() : { ok: true }
    this.voiceController = voiceInput.createController({
      onStart: () => {
        this.setData({
          isVoiceListening: true,
          voiceTip: '正在听，请说出租客需求'
        })
      },
      onRecognize: (text) => {
        this.applyVoiceNeed(text, false)
      },
      onTranscribing: () => {
        this.setData({
          isVoiceListening: false,
          voiceTip: '正在识别语音'
        })
      },
      onStop: (text) => {
        this.setData({ isVoiceListening: false })
        if (!text) {
          wx.showToast({ title: '没有识别到内容', icon: 'none' })
          return
        }
        this.applyVoiceNeed(text, true)
      },
      onError: (error) => {
        this.setData({
          isVoiceListening: false,
          voiceTip: voiceInput.errorMessage(error, '语音识别失败，请重试或手动输入')
        })
        wx.showToast({ title: voiceInput.errorMessage(error, '语音识别失败'), icon: 'none' })
      }
    })
    if (!this.voiceController && support && support.message) {
      this.voiceUnavailableMessage = support.message
      this.setData({ voiceTip: support.message })
    }
  },

  toggleVoiceInput() {
    if (!this.voiceController) {
      wx.showToast({ title: this.voiceUnavailableMessage || '当前环境暂不支持语音输入', icon: 'none' })
      return
    }
    try {
      if (this.data.isVoiceListening) {
        this.voiceController.stop()
        return
      }
      this.voiceController.start()
    } catch (error) {
      this.setData({ isVoiceListening: false })
      wx.showToast({ title: voiceInput.errorMessage(error, '语音输入启动失败'), icon: 'none' })
    }
  },

  refreshGuideTips(nextForm, nextNeedText, nextVoiceText) {
    this.setData({
      guideTips: buildGuideTips(
        nextForm || this.data.form,
        nextNeedText === undefined ? this.data.needText : nextNeedText,
        nextVoiceText === undefined ? this.data.voiceText : nextVoiceText
      )
    })
  },

  applyVoiceNeed(text, shouldMatch) {
    const need = voiceInput.parseNeedText(text)
    const nextForm = Object.assign({}, this.data.form)
    if (need.budget) nextForm.budget = need.budget
    if (need.area) nextForm.area = need.area
    if (need.layout) nextForm.layout = need.layout
    this.setData({
      needText: text,
      voiceText: text,
      voiceTip: '已得到转写文本，可继续修改后重新识别',
      form: nextForm,
      guideTips: buildGuideTips(nextForm, text, text),
      canConfirm: canConfirmForm(nextForm)
    }, () => {
      if (shouldMatch) this.runMatch()
    })
  },

  updateNeedText(event) {
    const needText = event.detail.value
    this.setData({ needText }, () => this.refreshGuideTips(null, needText))
  },

  updateVoiceText(event) {
    const voiceText = event.detail.value
    this.setData({ voiceText }, () => this.refreshGuideTips(null, undefined, voiceText))
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field
    const form = Object.assign({}, this.data.form, {
      [field]: event.detail.value
    })
    this.setData({ form, canConfirm: canConfirmForm(form) }, () => this.refreshGuideTips(form))
  },

  toggleFeature(event) {
    const value = event.currentTarget.dataset.value
    const current = this.data.form.features || []
    let next = []
    if (value === NO_FEATURE) {
      next = current.indexOf(NO_FEATURE) === -1 ? [NO_FEATURE] : []
    } else if (current.indexOf(value) === -1) {
      next = current.filter((item) => item !== NO_FEATURE).concat(value)
    } else {
      next = current.filter((item) => item !== value)
    }
    const form = Object.assign({}, this.data.form, {
      features: next
    })
    this.setData({
      form,
      featureOptions: buildFeatureOptions(next),
      canConfirm: canConfirmForm(form)
    }, () => this.refreshGuideTips(form))
  },

  formatNeed(need) {
    const features = need.features && need.features.length ? need.features.join('、') : '不限'
    return [
      { label: '预算', value: need.budget ? `${need.budget} 元` : '未填写' },
      { label: '区域', value: need.area || '不限' },
      { label: '小区/板块', value: need.community || '不限' },
      { label: '租法', value: need.rentMode || '不限' },
      { label: '户型', value: need.layout || '不限' },
      { label: '特点', value: features }
    ]
  },

  runMatch() {
    const text = String(this.data.needText || '').trim()
    const voiceText = String(this.data.voiceText || '').trim()
    const payloadVoiceText = voiceText && (!text || text === voiceText) ? voiceText : ''
    const form = payloadForm(this.data.form)
    if (!text && !voiceText && !canConfirmForm(form)) {
      wx.showToast({ title: '请先填写找房需求', icon: 'none' })
      return
    }
    wx.showLoading({ title: '识别中' })
    llmService.recognizeRentalNeed({
      text,
      voiceText: payloadVoiceText,
      form
    }).then((result) => {
      const nextForm = formFromNeed(result.need || {}, this.data.form)
      const messages = [
        {
          role: 'user',
          text: text || payloadVoiceText || '使用表单条件识别需求'
        },
        {
          role: 'assistant',
          text: result.reply
        }
      ]
      this.setData({
        messages,
        parsedNeed: this.formatNeed(result.need || {}),
        form: nextForm,
        featureOptions: buildFeatureOptions(nextForm.features || []),
        hasRecognized: true,
        hasMatched: false,
        listings: [],
        canConfirm: canConfirmForm(nextForm),
        followUpQuestion: result.followUpQuestion || '',
        guideTips: buildGuideTips(nextForm, text, payloadVoiceText)
      })
      wx.hideLoading()
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '需求识别失败', icon: 'none' })
    })
  },

  confirmAndMatch() {
    const form = payloadForm(this.data.form)
    if (!canConfirmForm(form)) {
      wx.showToast({ title: '请先确认预算、位置、户型中的两项', icon: 'none' })
      return
    }
    wx.showLoading({ title: '匹配中' })
    const text = String(this.data.needText || '').trim()
    const voiceText = String(this.data.voiceText || '').trim()
    const payloadVoiceText = voiceText && (!text || text === voiceText) ? voiceText : ''
    llmService.matchRentalNeed({
      text,
      voiceText: payloadVoiceText,
      form,
      stage: 'match',
      confirmed: true
    }).then((result) => {
      const messages = [
        {
          role: 'user',
          text: text || payloadVoiceText || '使用表单条件匹配房源'
        },
        {
          role: 'assistant',
          text: result.reply
        }
      ]
      this.setData({
        messages,
        parsedNeed: this.formatNeed(result.need || {}),
        listings: listingDisplay.normalizeListings(result.listings || []),
        hasRecognized: true,
        hasMatched: true
      })
      wx.hideLoading()
    }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: '智能匹配失败', icon: 'none' })
    })
  },

  useDemoNeed(event) {
    const type = event.currentTarget.dataset.type
    const text = type === 'feature'
      ? '客户预算3500，滨江长河或西兴，两室，近地铁，带阳台'
      : '客户预算2600，想找萧山建设路，一室公寓，独卫，燃气'
    this.setData({ needText: text }, () => {
      this.refreshGuideTips(null, text)
      this.runMatch()
    })
  },

  openListing(event) {
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${event.currentTarget.dataset.id}`
    })
  }
})
