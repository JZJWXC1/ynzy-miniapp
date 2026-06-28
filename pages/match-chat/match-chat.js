const llmService = require('../../utils/llm-service')
const apiService = require('../../utils/api-service')
const voiceInput = require('../../utils/voice-input')
const listingDisplay = require('../../utils/listing-display')
const {
  NO_FEATURE,
  parseFeatureInput
} = require('../../utils/listing-features')

const MAX_RECOMMEND_COUNT = 5
const CONFIRMATION_FIELD_CONFIG = [
  { key: 'budget', label: '预算', emptyText: '待补充' },
  { key: 'location', label: '区域/小区', emptyText: '待补充' },
  { key: 'layout', label: '户型/租法', emptyText: '待补充' },
  { key: 'moveIn', label: '入住时间', emptyText: '可后补' },
  { key: 'commute', label: '通勤', emptyText: '可后补' },
  { key: 'features', label: '标签/偏好', emptyText: '不限' }
]

function decodeOption(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return value
  }
}

function createMessageId(role) {
  return `${role}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

function numberFrom(value) {
  if (value === undefined || value === null || value === '') return 0
  const direct = Number(value)
  if (Number.isFinite(direct)) return direct
  const matched = String(value).match(/(\d+(?:\.\d+)?)/)
  return matched ? Number(matched[1]) : 0
}

function formatScore(listing) {
  const raw = listing.relevancePercent || listing.matchScore || listing.relevanceScore
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw === 'string' && raw.indexOf('%') !== -1) return raw
  const number = Number(raw)
  if (!Number.isFinite(number)) return String(raw)
  return `${Math.round(number <= 1 ? number * 100 : number)}%`
}

function safeCardTitle(listing) {
  if (listing.cardTitle) return listing.cardTitle
  if (listing.community && listing.layout) return `${listing.community} · ${listing.layout}`
  if (listing.community) return listing.community
  if (listing.area && listing.layout) return `${listing.area} · ${listing.layout}`
  return '可租房源'
}

function normalizeListings(listings, group) {
  return listingDisplay.normalizeListings(listings || [])
    .slice(0, MAX_RECOMMEND_COUNT)
    .map((listing) => {
      const rent = numberFrom(listing.rent || listing.price)
      return Object.assign({}, listing, {
        cardTitle: safeCardTitle(listing),
        rent,
        price: rent ? `¥${rent}/月` : (listing.price || ''),
        matchGroup: listing.matchGroup || group || 'exact',
        matchGroupText: listing.matchGroupText || (group === 'nearby' ? '接近要求' : '符合要求'),
        matchReason: listing.matchReason || (listing.relevanceReasons && listing.relevanceReasons.join('、')) || '基础条件相近',
        differenceText: listing.differenceText || '',
        displayRelevance: formatScore(listing)
      })
    })
}

function buildListingSections(result) {
  const data = result || {}
  let exactListings = normalizeListings(data.exactListings || [], 'exact')
  let nearbyListings = normalizeListings(data.nearbyListings || [], 'nearby')

  if (!exactListings.length && !nearbyListings.length && data.listings && data.listings.length) {
    const normalized = normalizeListings(data.listings, '')
    exactListings = normalized.filter((listing) => listing.matchGroup !== 'nearby')
    nearbyListings = normalized.filter((listing) => listing.matchGroup === 'nearby')
    if (!exactListings.length && !nearbyListings.length) exactListings = normalized
  }

  const sections = []
  const exactLimited = exactListings.slice(0, MAX_RECOMMEND_COUNT)
  const nearbyLimited = nearbyListings.slice(0, Math.max(0, MAX_RECOMMEND_COUNT - exactLimited.length))
  if (exactLimited.length) sections.push({ title: '符合要求', listings: exactLimited })
  if (nearbyLimited.length) sections.push({ title: '接近要求', listings: nearbyLimited })
  return sections
}

function flattenSections(sections) {
  return (sections || []).reduce((list, section) => list.concat(section.listings || []), [])
}

function buildNeedTags(need) {
  const tags = []
  const data = need || {}
  const budget = data.budget || data.maxBudget || data.budgetText
  if (budget) tags.push(`预算 ${budget}`)
  if (data.area) tags.push(`区域 ${data.area}`)
  if (data.community) tags.push(`小区 ${data.community}`)
  if (data.rentMode) tags.push(data.rentMode)
  if (data.layout) tags.push(`户型 ${data.layout}`)
  if (data.moveIn) tags.push(data.moveIn)
  if (data.commuteLocation) tags.push(`通勤 ${data.commuteLocation}`)
  if (data.features && data.features.length) tags.push(data.features.join('、'))
  return tags
}

function fieldValue(need, key) {
  const data = need || {}
  if (key === 'budget') return data.budgetText || (data.maxBudget ? `${data.maxBudget}以内` : (data.budget || ''))
  if (key === 'location') return [data.area, data.community].filter(Boolean).join(' · ')
  if (key === 'layout') return [data.rentMode, data.layout].filter(Boolean).join(' · ')
  if (key === 'moveIn') return data.moveIn || ''
  if (key === 'commute') {
    return [
      data.commuteLocation,
      data.maxCommuteMinutes ? `${data.maxCommuteMinutes}分钟内` : ''
    ].filter(Boolean).join(' · ')
  }
  if (key === 'features') return (data.features || []).join('、')
  return ''
}

function buildNeedFields(need, providedFields) {
  if (providedFields && providedFields.length) return providedFields
  return CONFIRMATION_FIELD_CONFIG.map((field) => {
    const value = fieldValue(need, field.key)
    return {
      key: field.key,
      label: field.label,
      value: value || field.emptyText,
      filled: Boolean(value)
    }
  })
}

function trimValue(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function featuresTextFromNeed(need) {
  return (need && need.features && need.features.length) ? need.features.join('、') : ''
}

function parseFeaturesText(value) {
  return parseFeatureInput(value)
    .filter((item) => item && item !== NO_FEATURE)
}

function needToConfirmForm(need) {
  const data = need || {}
  return {
    budget: data.budgetText || data.maxBudget || data.budget || '',
    minBudget: data.minBudget || '',
    maxBudget: data.maxBudget || '',
    area: data.area || '',
    community: data.community || '',
    rentMode: data.rentMode || '',
    layout: data.layout || '',
    moveIn: data.moveIn || '',
    commuteLocation: data.commuteLocation || '',
    maxCommuteMinutes: data.maxCommuteMinutes || '',
    featuresText: featuresTextFromNeed(data)
  }
}

function confirmFormToPayload(form) {
  const data = form || {}
  return {
    budget: trimValue(data.budget),
    minBudget: '',
    maxBudget: '',
    area: trimValue(data.area),
    community: trimValue(data.community),
    rentMode: trimValue(data.rentMode),
    layout: trimValue(data.layout),
    moveIn: trimValue(data.moveIn),
    commuteLocation: trimValue(data.commuteLocation),
    maxCommuteMinutes: trimValue(data.maxCommuteMinutes),
    features: parseFeaturesText(data.featuresText)
  }
}

function confirmFormToNeed(form, baseNeed) {
  const data = confirmFormToPayload(form)
  return Object.assign({}, baseNeed || {}, {
    budget: data.budget,
    budgetText: data.budget,
    minBudget: data.minBudget,
    maxBudget: data.maxBudget || numberFrom(data.budget) || '',
    area: data.area,
    community: data.community,
    rentMode: data.rentMode,
    layout: data.layout,
    moveIn: data.moveIn,
    commuteLocation: data.commuteLocation,
    maxCommuteMinutes: data.maxCommuteMinutes,
    features: data.features
  })
}

function buildNeedFieldsFromConfirmForm(form, baseNeed) {
  return buildNeedFields(confirmFormToNeed(form, baseNeed), null)
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

function sourceLabelFromPayload(payload) {
  if (payload && payload.voiceText) return '已转写文本'
  return '输入文本'
}

function sourceTextFromPayload(payload) {
  const text = trimValue(payload && payload.text)
  const voiceText = trimValue(payload && payload.voiceText)
  if (text) return text
  return voiceText
}

function buildConfirmHint(canConfirm) {
  if (canConfirm) return '可以先修正字段，确认后才开始匹配房源。'
  return '至少确认预算、区域/小区、户型/租法中的两项，或直接回复追问。'
}

function clampAssistantText(text) {
  const value = String(text || '').trim()
  return value.length > 100 ? `${value.slice(0, 97)}...` : value
}

function buildAssistantText(result, listings) {
  const data = result || {}
  if (data.networkFailed) {
    return clampAssistantText(listings.length ? '网络连接失败，可重试；先给你本地匹配结果。' : '网络连接失败，请点下方按钮重试。')
  }
  if (data.followUpQuestion) return data.followUpQuestion
  if (data.reply) return clampAssistantText(data.reply)
  if (!listings.length) return '暂未找到合适房源，建议放宽预算、区域或户型。'
  return `先看这${listings.length}套真实房源，已按预算、位置和偏好排序。`
}

function buildRecognitionText(result) {
  const data = result || {}
  if (data.networkFailed) {
    return '网络连接失败，已先按本地规则整理需求。'
  }
  if (data.followUpQuestion) {
    return `我先整理了已识别条件，还差一个关键问题：${data.followUpQuestion}`
  }
  if (data.reply) return clampAssistantText(data.reply)
  return '请确认这些找房条件，确认后我再匹配本地房源。'
}

function buildMapFilters(need, listings) {
  const data = need || {}
  return {
    budget: data.maxBudget || data.budget || '',
    area: data.area || data.community || '',
    community: data.community || '',
    layout: data.layout || '',
    rentMode: data.rentMode || '',
    listingIds: (listings || []).map((listing) => listing.id).filter(Boolean)
  }
}

function needIdFromResult(result) {
  const data = result || {}
  return data.needId || data.id || (data.need && (data.need.needId || data.need.id)) || ''
}

Page({
  data: {
    messages: [
      {
        id: 'welcome',
        role: 'assistant',
        text: '告诉我预算、区域/小区和户型，我会先整理成字段，确认后再匹配真实可租房源。'
      }
    ],
    inputText: '',
    needHistory: [],
    voiceText: '',
    isVoiceListening: false,
    loading: false,
    scrollTarget: 'bottom-anchor'
  },

  onLoad(options) {
    this.initVoiceInput()
    const text = decodeOption(options.text)
    const voiceText = decodeOption(options.voiceText)
    const firstNeed = text || voiceText
    if (voiceText) {
      this.setData({ voiceText })
    }
    if (firstNeed) {
      const source = voiceText && (!text || text === voiceText) ? 'voice' : 'text'
      this.submitNeed(firstNeed, source)
    }
  },

  onUnload() {
    if (this.voiceController && this.data.isVoiceListening) {
      this.voiceController.stop()
    }
  },

  initVoiceInput() {
    this.voiceController = voiceInput.createController({
      onStart: () => {
        this.setData({ isVoiceListening: true })
      },
      onRecognize: (text) => {
        if (text && !this.data.loading) this.setData({ inputText: text })
      },
      onStop: (text) => {
        this.setData({ isVoiceListening: false })
        const content = String(text || '').trim()
        if (!content) {
          wx.showToast({ title: '没有识别到内容', icon: 'none' })
          return
        }
        this.setData({ voiceText: content, inputText: '' }, () => {
          this.submitNeed(content, 'voice')
        })
      },
      onError: () => {
        this.setData({ isVoiceListening: false })
        wx.showToast({ title: '语音识别失败', icon: 'none' })
      }
    })
  },

  toggleVoiceInput() {
    if (this.data.loading) return
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

  handleInput(event) {
    this.setData({ inputText: event.detail.value })
  },

  sendMessage() {
    const content = String(this.data.inputText || '').trim()
    if (this.data.loading) return
    if (!content) {
      wx.showToast({ title: '请输入租客需求', icon: 'none' })
      return
    }
    this.submitNeed(content, 'text')
  },

  submitNeed(content, source) {
    const text = String(content || '').trim()
    if (!text || this.data.loading) return

    const userMessage = {
      id: createMessageId('user'),
      role: 'user',
      text
    }
    const needHistory = this.data.needHistory.concat(text)
    const messages = this.data.messages.concat(userMessage)
    const combinedText = needHistory.join('，补充：')
    const payload = {
      text: combinedText,
      voiceText: source === 'voice' ? (this.data.voiceText || text) : '',
      form: {}
    }

    this.lastRecognizePayload = payload
    this.setData({
      messages,
      needHistory,
      inputText: '',
      loading: true,
      scrollTarget: 'typing-row'
    })
    this.executeRecognize(payload)
  },

  executeRecognize(payload) {
    const requestId = createMessageId('recognize')
    this.activeRequestId = requestId
    this.activeRecognizePayload = payload
    llmService.recognizeRentalNeed(payload).then((result) => {
      if (this.activeRequestId !== requestId) return
      this.appendRecognitionResult(result || {})
    }).catch((error) => {
      if (this.activeRequestId !== requestId) return
      this.appendRecognitionResult({
        reply: '网络连接失败，请补充条件后重试。',
        warning: error.message || '网络连接失败',
        networkFailed: true,
        need: {},
        listings: []
      })
    })
  },

  executeMatch(payload) {
    const requestId = createMessageId('request')
    this.activeRequestId = requestId
    llmService.matchRentalNeed(payload).then((result) => {
      if (this.activeRequestId !== requestId) return
      this.appendAssistantResult(result || {})
    }).catch((error) => {
      if (this.activeRequestId !== requestId) return
      this.appendAssistantResult({
        reply: '网络连接失败，请点下方按钮重试。',
        warning: error.message || '网络连接失败',
        networkFailed: true,
        listings: []
      })
    })
  },

  appendRecognitionResult(result) {
    const sourcePayload = this.activeRecognizePayload || this.lastRecognizePayload || {}
    const confirmForm = needToConfirmForm(result.need)
    const canConfirm = canConfirmForm(confirmForm)
    const assistantMessage = {
      id: createMessageId('assistant'),
      role: 'assistant',
      text: buildRecognitionText(result),
      need: result.need || {},
      needFields: buildNeedFieldsFromConfirmForm(confirmForm, result.need),
      confirmForm,
      confirmText: sourceTextFromPayload(sourcePayload),
      sourceLabel: sourceLabelFromPayload(sourcePayload),
      canEditConfirmation: true,
      canConfirm,
      confirmHint: buildConfirmHint(canConfirm),
      followUpQuestion: result.followUpQuestion || '',
      retryable: Boolean(result.networkFailed),
      retryAction: 'recognize',
      retryText: '重试识别',
      empty: false
    }
    this.pendingNeed = result.need || {}
    this.setData({
      messages: this.data.messages.concat(assistantMessage),
      loading: false,
      scrollTarget: assistantMessage.id
    })
  },

  appendAssistantResult(matchResult) {
    const listingSections = buildListingSections(matchResult)
    const listings = flattenSections(listingSections)
    const requestPayload = this.lastRequestPayload || {}
    const needId = matchResult.needId || requestPayload.needId || ''
    const needTemporary = Boolean(requestPayload.needTemporary || matchResult.needTemporary)
    const assistantMessage = {
      id: createMessageId('assistant'),
      role: 'assistant',
      text: buildAssistantText(matchResult, listings),
      needTags: buildNeedTags(matchResult.need),
      needId,
      needTemporary,
      needNotice: needTemporary ? '需求单接口暂不可用，已生成临时需求单，可继续看房验证。' : '',
      listingSections,
      listings,
      mapFilters: Object.assign(buildMapFilters(matchResult.need, listings), { needId }),
      retryable: Boolean(matchResult.networkFailed),
      retryAction: 'match',
      retryText: '重试匹配',
      empty: !listings.length && !matchResult.followUpQuestion
    }
    this.setData({
      messages: this.data.messages.concat(assistantMessage),
      loading: false,
      scrollTarget: assistantMessage.id
    })
  },

  retryLastNeed() {
    if (this.data.loading) return
    const lastMessage = (this.data.messages || []).slice().reverse().find((message) => message.retryable)
    const retryAction = lastMessage && lastMessage.retryAction
    this.setData({
      loading: true,
      scrollTarget: 'typing-row'
    })
    if (retryAction === 'recognize' && this.lastRecognizePayload) {
      this.executeRecognize(this.lastRecognizePayload)
      return
    }
    if (this.lastRequestPayload) {
      this.executeMatch(this.lastRequestPayload)
      return
    }
    this.setData({ loading: false })
  },

  findMessage(messageId) {
    return (this.data.messages || []).find((message) => message.id === messageId)
  },

  updateMessage(messageId, updater) {
    const messages = (this.data.messages || []).map((message) => {
      if (message.id !== messageId) return message
      return updater(Object.assign({}, message))
    })
    this.setData({ messages })
  },

  handleConfirmFieldInput(event) {
    const messageId = event.currentTarget.dataset.messageId
    const field = event.currentTarget.dataset.field
    if (!messageId || !field) return
    const value = event.detail.value
    this.updateMessage(messageId, (message) => {
      const confirmForm = Object.assign({}, message.confirmForm || {}, {
        [field]: value
      })
      if (field === 'budget') {
        confirmForm.minBudget = ''
        confirmForm.maxBudget = ''
      }
      const canConfirm = canConfirmForm(confirmForm)
      message.confirmForm = confirmForm
      message.need = confirmFormToNeed(confirmForm, message.need)
      message.needFields = buildNeedFieldsFromConfirmForm(confirmForm, message.need)
      message.canConfirm = canConfirm
      message.confirmHint = buildConfirmHint(canConfirm)
      return message
    })
  },

  handleConfirmTextInput(event) {
    const messageId = event.currentTarget.dataset.messageId
    if (!messageId) return
    const value = event.detail.value
    this.updateMessage(messageId, (message) => {
      message.confirmText = value
      return message
    })
  },

  recognizeEditedTextFromMessage(event) {
    if (this.data.loading) return
    const messageId = event.currentTarget.dataset.messageId
    const message = this.findMessage(messageId) || {}
    const text = trimValue(message.confirmText)
    if (!text) {
      wx.showToast({ title: '请先填写修正后的需求', icon: 'none' })
      return
    }
    const payload = {
      text,
      voiceText: '',
      form: {}
    }
    const userMessage = {
      id: createMessageId('user'),
      role: 'user',
      text: `按修正文本重新识别：${text}`
    }
    this.lastRecognizePayload = payload
    this.setData({
      messages: this.data.messages.concat(userMessage),
      needHistory: [text],
      loading: true,
      scrollTarget: 'typing-row'
    })
    this.executeRecognize(payload)
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    const needId = event.currentTarget.dataset.needId || ''
    if (!id) return
    const query = needId ? `&needId=${encodeURIComponent(needId)}&source=match` : ''
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${id}${query}`
    })
  },

  confirmNeedFromMessage(event) {
    if (this.data.loading) return
    const messageId = event.currentTarget.dataset.messageId
    const message = this.findMessage(messageId) || {}
    if (!message.canConfirm) return
    const text = trimValue(message.confirmText) || (this.data.needHistory || []).join('，补充：')
    const payload = {
      text,
      voiceText: '',
      form: confirmFormToPayload(message.confirmForm),
      stage: 'match',
      confirmed: true
    }
    const userMessage = {
      id: createMessageId('user'),
      role: 'user',
      text: '确认这些条件，开始匹配。'
    }
    this.setData({
      messages: this.data.messages.concat(userMessage),
      loading: true,
      scrollTarget: 'typing-row'
    })
    this.createNeedAndMatch(payload, message)
  },

  createNeedAndMatch(payload, message) {
    const need = confirmFormToNeed(message.confirmForm, message.need)
    apiService.createRentalNeed({
      source: 'match-chat',
      text: payload.text,
      need,
      form: payload.form
    }).then((result) => {
      const needId = needIdFromResult(result)
      const needTemporary = Boolean(result && result.temporary)
      const nextPayload = Object.assign({}, payload, {
        needId,
        needTemporary,
        need
      })
      this.lastNeedContext = {
        needId,
        needTemporary
      }
      this.lastRequestPayload = nextPayload
      if (needTemporary) {
        wx.showToast({ title: '已用临时需求单继续验证', icon: 'none' })
      }
      this.executeMatch(nextPayload)
    }).catch(() => {
      this.lastRequestPayload = payload
      wx.showToast({ title: '需求单保存失败，继续本地匹配', icon: 'none' })
      this.executeMatch(payload)
    })
  },

  openMapForListing(event) {
    const messageId = event.currentTarget.dataset.messageId
    const message = this.findMessage(messageId) || {}
    const filters = Object.assign({}, message.mapFilters || {})
    if (message.needId) filters.needId = message.needId
    filters.listingIds = (message.listings || []).map((listing) => listing.id).filter(Boolean)
    if (!filters.listingIds.length) {
      const id = event.currentTarget.dataset.id
      if (id) filters.listingIds = [id]
    }
    wx.setStorageSync('ynzy_pending_map_filters', filters)
    wx.switchTab({ url: '/pages/map/map' })
  }
})
