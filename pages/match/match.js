const llmService = require('../../utils/llm-service')
const voiceInput = require('../../utils/voice-input')
const listingDisplay = require('../../utils/listing-display')
const {
  NO_FEATURE,
  LISTING_FEATURE_OPTIONS
} = require('../../utils/listing-features')

function buildFeatureOptions(selected) {
  const current = selected || []
  return LISTING_FEATURE_OPTIONS.map((name) => ({
    name,
    active: current.indexOf(name) !== -1
  }))
}

function buildGuideTips(form, needText, voiceText) {
  const tips = []
  const text = [needText, voiceText].filter(Boolean).join('，')
  if (!form.budget && text.indexOf('预算') === -1) tips.push('补充预算后排序更准')
  if (!form.area && !/(滨江|萧山|上城|拱墅|西湖|余杭|临平|钱塘|区域|小区|商圈)/.test(text)) tips.push('补充区域或小区')
  if (!form.layout && !/(一室|两室|二室|三室|整租|合租|公寓|户型)/.test(text)) tips.push('补充户型或租住方式')
  if (!form.features || !form.features.length) tips.push('选择阳台、燃气、近地铁等特点')
  return tips
}

Page({
  data: {
    needText: '客户预算3000左右，想住滨江西兴，两室，带阳台和燃气，月底入住，通勤到滨康地铁站',
    form: {
      budget: '',
      area: '',
      layout: '',
      moveIn: '',
      commute: '',
      features: []
    },
    featureOptions: buildFeatureOptions([]),
    guideTips: buildGuideTips({ features: [] }, '客户预算3000左右，想住滨江西兴，两室，带阳台和燃气，月底入住，通勤到滨康地铁站', ''),
    messages: [
      {
        role: 'assistant',
        text: '把租客预算、区域、户型、特点和通勤位置发给我，我会按相关性评分排序推荐房源。'
      }
    ],
    parsedNeed: [],
    listings: [],
    hasMatched: false,
    isVoiceListening: false,
    voiceText: '',
    voiceTip: '说出租客预算、区域、户型、特点或通勤位置'
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

  onUnload() {
    if (this.voiceController && this.data.isVoiceListening) {
      this.voiceController.stop()
    }
  },

  initVoiceInput() {
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
      onStop: (text) => {
        this.setData({ isVoiceListening: false })
        if (!text) {
          wx.showToast({ title: '没有识别到内容', icon: 'none' })
          return
        }
        this.applyVoiceNeed(text, true)
      },
      onError: () => {
        this.setData({
          isVoiceListening: false,
          voiceTip: '语音识别失败，请重试或手动输入'
        })
        wx.showToast({ title: '语音识别失败', icon: 'none' })
      }
    })
  },

  toggleVoiceInput() {
    if (!this.voiceController) {
      wx.showToast({ title: '当前环境暂不支持语音输入', icon: 'none' })
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
      wx.showToast({ title: '语音输入启动失败', icon: 'none' })
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
    if (need.moveIn) nextForm.moveIn = need.moveIn
    if (need.commute) nextForm.commute = need.commute
    this.setData({
      needText: text,
      voiceText: text,
      voiceTip: '已识别，可继续修改或重新匹配',
      form: nextForm,
      guideTips: buildGuideTips(nextForm, text, text)
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
    this.setData({ form }, () => this.refreshGuideTips(form))
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
      featureOptions: buildFeatureOptions(next)
    }, () => this.refreshGuideTips(form))
  },

  formatNeed(need) {
    const features = need.features && need.features.length ? need.features.join('、') : '不限'
    return [
      { label: '预算', value: need.budget ? `${need.budget} 元` : '未填写' },
      { label: '区域', value: need.area || '不限' },
      { label: '户型', value: need.layout || '不限' },
      { label: '特点', value: features },
      { label: '入住', value: need.moveIn || '待确认' },
      { label: '通勤', value: need.commute || '待确认' }
    ]
  },

  runMatch() {
    wx.showLoading({ title: '匹配中' })
    llmService.matchRentalNeed({
      text: this.data.needText,
      voiceText: this.data.voiceText,
      form: this.data.form
    }).then((result) => {
      const messages = [
        {
          role: 'user',
          text: this.data.needText || this.data.voiceText || '使用表单条件匹配房源'
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
    const text = type === 'commute'
      ? '客户预算3500，滨江长河或西兴，两室，近地铁，带阳台，7月入住，通勤到江陵路地铁站'
      : '客户预算2600，想找萧山建设路，一室公寓，独卫，燃气，越快入住越好'
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
