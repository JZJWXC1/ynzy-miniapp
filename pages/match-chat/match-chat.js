const llmService = require('../../utils/llm-service')
const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')
const { anonymousPublicRequestData } = require('../../utils/public-request-safety')
const voiceInput = require('../../utils/voice-input')
const listingDisplay = require('../../utils/listing-display')
const { createPendingFilterEnvelope } = require('../../utils/pending-filter-storage')
const {
  saveAssistantMapReturnState,
  restoreAssistantMapReturnState,
  clearAssistantMapReturnState
} = require('../../utils/assistant-map-return-state')
const {
  NO_FEATURE,
  parseFeatureInput
} = require('../../utils/listing-features')

const MAX_RECOMMEND_COUNT = 5
const MATCH_RESULT_FEEDBACK_VERSION = 'match-result-v1'
const MIN_VOICE_PRESS_DURATION_MS = 600
const MATCH_RESULT_FEEDBACK_REASONS = {
  helpful: [
    { code: 'price', label: '价格合适' },
    { code: 'location', label: '位置合适' },
    { code: 'layout', label: '户型合适' },
    { code: 'availability', label: '房态准确' },
    { code: 'result_count', label: '数量合适' }
  ],
  bad_recommendation: [
    { code: 'price', label: '价格不合适' },
    { code: 'location', label: '位置不合适' },
    { code: 'layout', label: '户型不合适' },
    { code: 'availability', label: '房态不准' },
    { code: 'too_few', label: '结果太少' },
    { code: 'too_many', label: '结果太多' }
  ]
}
const CONFIRMATION_FIELD_CONFIG = [
  { key: 'budget', label: '预算', emptyText: '待补充' },
  { key: 'location', label: '区域/小区', emptyText: '待补充' },
  { key: 'layout', label: '户型/租法', emptyText: '待补充' },
  { key: 'features', label: '标签/偏好', emptyText: '不限' }
]

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : apiClient.getAuthToken())
}

function initialMessages() {
  return [{
    id: 'welcome',
    role: 'assistant',
    text: '直接说客户预算、位置和户型，我会按真实房源查；条件不够时只追问一个关键问题。'
  }]
}

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
  if (data.searchMode === 'radius_around_place') {
    if (data.anchorName) tags.push(`地点 ${data.anchorName}`)
    if (data.radiusKm) tags.push(`${data.radiusKm}公里内`)
  }
  if (data.area) tags.push(`区域 ${data.area}`)
  if (data.community) tags.push(`小区 ${data.community}`)
  if (data.rentMode) tags.push(data.rentMode)
  if (data.layout) tags.push(`户型 ${data.layout}`)
  if (data.features && data.features.length) tags.push(data.features.join('、'))
  return tags
}

function fieldValue(need, key) {
  const data = need || {}
  if (key === 'budget') return data.budgetText || (data.maxBudget ? `${data.maxBudget}以内` : (data.budget || ''))
  if (key === 'location') return [data.area, data.community].filter(Boolean).join(' · ')
  if (key === 'layout') return [data.rentMode, data.layout].filter(Boolean).join(' · ')
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
    return '网络连接失败，请点下方按钮重试。'
  }
  const question = data.nextQuestion || data.followUpQuestion || ''
  if (question) return question
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
    anchorName: data.anchorName || '',
    radiusKm: data.radiusKm || '',
    listingIds: (listings || []).map((listing) => listing.id).filter(Boolean)
  }
}

function needIdFromResult(result) {
  const data = result || {}
  return data.needId || data.id || (data.need && (data.need.needId || data.need.id)) || ''
}

Page({
  data: {
    messages: initialMessages(),
    inputText: '',
    needHistory: [],
    voiceMode: true,
    voiceText: '',
    isVoiceListening: false,
    voiceCancelActive: false,
    voicePhase: '',
    loading: false,
    scrollTarget: 'bottom-anchor'
  },

  // 增量追加消息：按索引路径 setData，避免消息越多整表序列化越慢
  appendMessage(message, extra) {
    const index = this.data.messages.length
    this.setData(Object.assign({ [`messages[${index}]`]: message }, extra || {}))
  },

  onLoad(options) {
    this._pageActive = true
    this.authSessionSnapshot = currentAuthSessionKey()
    this.bindAuthInvalidationListener()
    this.initVoiceInput()
    if (options && options.returnFromMap === '1') {
      const restored = restoreAssistantMapReturnState(this.authSessionSnapshot)
      if (restored) {
        const restoredMessages = Array.isArray(restored.data && restored.data.messages)
          ? restored.data.messages.map((message) => Object.assign({}, message, { feedbackLoading: false }))
          : initialMessages()
        const restoredData = Object.assign({}, restored.data || {}, {
          messages: restoredMessages,
          loading: false,
          isVoiceListening: false,
          voiceCancelActive: false,
          voicePhase: ''
        })
        this.setData(restoredData)
        Object.assign(this, restored.context || {})
        return
      }
    }
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

  onShow() {
    this._pageActive = true
    this.syncAuthSession()
  },

  onHide() {
    this.cleanupVoiceInput()
  },

  onUnload() {
    this._pageActive = false
    if (typeof this._unsubscribeAuthInvalidation === 'function') {
      this._unsubscribeAuthInvalidation()
      this._unsubscribeAuthInvalidation = null
    }
    this.activeRequestId = createMessageId('unloaded')
    this.activeRequestAllowsPublicFallback = false
    this.confirmedPublicFallbackRequestId = ''
    this.cleanupVoiceInput()
  },

  syncAuthSession() {
    const nextSessionKey = currentAuthSessionKey()
    const changed = this.authSessionSnapshot !== undefined && this.authSessionSnapshot !== nextSessionKey
    if (changed) this.resetForAuthSession(nextSessionKey)
    else this.authSessionSnapshot = nextSessionKey
    return { key: nextSessionKey, changed }
  },

  resetForAuthSession(nextSessionKey) {
    clearAssistantMapReturnState()
    this.authSessionSnapshot = nextSessionKey
    this.activeRequestId = createMessageId('session-reset')
    this.activeRequestAllowsPublicFallback = false
    this.confirmedPublicFallbackRequestId = ''
    this.cleanupVoiceInput()
    ;[
      'currentThreadId',
      'lastNeedContext',
      'lastAssistantPayload',
      'lastRecognizePayload',
      'activeRecognizePayload',
      'lastRequestPayload',
      'lastAssistantResultSource',
      'pendingNeed',
      'lastVoiceRecognizedText'
    ].forEach((key) => { delete this[key] })
    this.setData({
      messages: initialMessages(),
      inputText: '',
      needHistory: [],
      voiceText: '',
      isVoiceListening: false,
      voiceCancelActive: false,
      voicePhase: '',
      loading: false,
      scrollTarget: 'bottom-anchor'
    })
  },

  adoptPublicAuthFallback(requestSessionKey) {
    const canAdopt = typeof apiClient.isPublicReadAuthFallbackContinuation === 'function' &&
      apiClient.isPublicReadAuthFallbackContinuation(requestSessionKey)
    if (!canAdopt) return false
    this.authSessionSnapshot = currentAuthSessionKey()
    ;['currentThreadId', 'lastNeedContext', 'pendingNeed'].forEach((key) => { delete this[key] })
    ;['lastAssistantPayload', 'lastRecognizePayload', 'activeRecognizePayload', 'lastRequestPayload'].forEach((key) => {
      if (this[key]) this[key] = anonymousPublicRequestData(this[key])
    })
    const lastUserMessage = (this.data.messages || []).slice().reverse().find((message) => message && message.role === 'user')
    const safeUserMessage = lastUserMessage ? anonymousPublicRequestData(lastUserMessage) : null
    this.setData({
      messages: initialMessages().concat(safeUserMessage ? [safeUserMessage] : []),
      needHistory: safeUserMessage && safeUserMessage.text ? [safeUserMessage.text] : [],
      inputText: '',
      voiceText: '',
      isVoiceListening: false,
      voiceCancelActive: false,
      voicePhase: '',
      loading: true,
      scrollTarget: 'typing-row'
    })
    return true
  },

  bindAuthInvalidationListener() {
    if (this._unsubscribeAuthInvalidation || typeof apiClient.subscribeAuthInvalidation !== 'function') return
    this._unsubscribeAuthInvalidation = apiClient.subscribeAuthInvalidation((event) => {
      if (this._pageActive === false) return
      const fromSessionKey = String(event && event.fromSessionKey || '')
      if (!fromSessionKey || fromSessionKey !== String(this.authSessionSnapshot || '')) return
      const nextSessionKey = currentAuthSessionKey()
      if (event && event.toSessionKey && String(event.toSessionKey) !== nextSessionKey) return
      const publicFallbackRequestId = String(event && event.publicFallbackRequestId || '')
      if (
        this.data.loading &&
        this.activeRequestAllowsPublicFallback === true &&
        publicFallbackRequestId &&
        publicFallbackRequestId === String(this.activeRequestId || '') &&
        this.adoptPublicAuthFallback(fromSessionKey)
      ) {
        this.confirmedPublicFallbackRequestId = publicFallbackRequestId
        return
      }
      this.resetForAuthSession(nextSessionKey)
    })
  },

  isSessionRequestCurrent(requestId, requestSessionKey, allowPublicFallback = false) {
    if (this._pageActive === false || this.activeRequestId !== requestId) return false
    if (currentAuthSessionKey() === requestSessionKey) return true
    if (
      allowPublicFallback &&
      this.activeRequestAllowsPublicFallback === true &&
      this.confirmedPublicFallbackRequestId === requestId &&
      currentAuthSessionKey() === this.authSessionSnapshot
    ) return true
    this.syncAuthSession()
    return false
  },

  cleanupVoiceInput() {
    this.voicePressing = false
    this.voicePressStartedAt = 0
    this.voiceAutoFindEligible = false
    const controller = this.voiceController
    if (!controller) return
    const busy = typeof controller.isBusy === 'function' ? controller.isBusy() : this.data.isVoiceListening
    if (busy && typeof controller.cancel === 'function') {
      controller.cancel()
    } else if (busy && typeof controller.stop === 'function') {
      controller.stop()
    } else if (typeof controller.release === 'function') {
      controller.release()
    }
    if (this._pageActive !== false && this.data.isVoiceListening) {
      this.setData({ isVoiceListening: false })
    }
  },

  ensureVoiceInput() {
    if (!this.voiceController || (typeof this.voiceController.isErrored === 'function' && this.voiceController.isErrored())) {
      this.initVoiceInput()
    }
    return this.voiceController
  },

  initVoiceInput() {
    this.voicePressStartedAt = 0
    this.voiceAutoFindEligible = false
    const voiceControllerGeneration = Number(this._voiceControllerGeneration || 0) + 1
    this._voiceControllerGeneration = voiceControllerGeneration
    const isCurrentVoiceController = () => (
      this._pageActive !== false && this._voiceControllerGeneration === voiceControllerGeneration
    )
    if (this.voiceController && typeof this.voiceController.release === 'function') {
      this.voiceController.release()
    }
    const support = voiceInput.getSupportStatus ? voiceInput.getSupportStatus() : { ok: true }
    this.voiceController = voiceInput.createController({
      onStart: () => {
        if (!isCurrentVoiceController()) return
        this.voiceAutoFindEligible = false
        this.lastVoiceRecognizedText = ''
        this.setData({ isVoiceListening: true, voicePhase: 'recording', voiceCancelActive: false, voiceText: '' })
        // 极快点按/慢启动：start 回调晚于 touchend，用户已松手 → 静默丢弃本次（cancel 不走 2.2s 空转与「没有识别到内容」，也避免误触凭杂音帧自动匹配）。
        if (this.voicePressing === false && this.voiceController) {
          try { this.voiceController.cancel() } catch (error) {}
        }
      },
      onRecognize: (text) => {
        if (!isCurrentVoiceController()) return
        const recognizedText = String(text || '').trim()
        if (recognizedText) this.lastVoiceRecognizedText = recognizedText
        // 录音中实时字幕只进浮层；仅有效长按的最终识别结果可以自动提交找房。
        this.setData({ voiceText: text })
      },
      onTranscribing: () => {
        if (!isCurrentVoiceController()) return
        if (this.data.voicePhase === 'recording') this.setData({ voicePhase: 'transcribing' })
      },
      onStop: (text) => {
        if (!isCurrentVoiceController()) return
        const shouldAutoFind = this.voiceAutoFindEligible === true
        this.voiceAutoFindEligible = false
        this.voicePressStartedAt = 0
        const content = String(text || this.lastVoiceRecognizedText || '').trim()
        this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false })
        if (!shouldAutoFind) {
          this.lastVoiceRecognizedText = ''
          return
        }
        if (!content) {
          wx.showToast({ title: '没有识别到内容', icon: 'none' })
          return
        }
        this.lastVoiceRecognizedText = ''
        this.setData({ voiceText: content, inputText: content }, () => {
          if (isCurrentVoiceController()) this.submitNeed(content, 'voice')
        })
      },
      onCancel: () => {
        if (!isCurrentVoiceController()) return
        this.voicePressing = false
        this.voicePressStartedAt = 0
        this.voiceAutoFindEligible = false
        this.lastVoiceRecognizedText = ''
        this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false, voiceText: '' })
      },
      onError: (error) => {
        if (!isCurrentVoiceController()) return
        this.voicePressing = false
        this.voicePressStartedAt = 0
        this.voiceAutoFindEligible = false
        this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false })
        wx.showToast({ title: voiceInput.errorMessage(error, '语音识别失败'), icon: 'none' })
      }
    })
    if (!this.voiceController && support && support.message) {
      this.voiceUnavailableMessage = support.message
    }
  },

  toggleVoiceMode() {
    if (this.data.voicePhase || this.data.loading) return
    const nextVoice = !this.data.voiceMode
    if (nextVoice && wx.hideKeyboard) {
      try { wx.hideKeyboard() } catch (error) {}
    }
    this.setData({ voiceMode: nextVoice })
  },

  onVoiceTouchStart(event) {
    if (this.data.loading) return
    const controller = this.ensureVoiceInput()
    if (!controller) {
      wx.showToast({ title: this.voiceUnavailableMessage || '当前环境暂不支持语音输入', icon: 'none' })
      return
    }
    // 上一句仍在录音/识别收尾（FINAL_WAIT 窗口）时忽略新的按下，避免震动+清屏假象与串句自动提交。
    if (this.data.voicePhase || (typeof controller.isBusy === 'function' && controller.isBusy())) return
    const touch = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0]) || {}
    this.voiceStartY = Number(touch.clientY || touch.pageY || 0)
    this.voicePressing = true
    this.voicePressStartedAt = Date.now()
    this.voiceAutoFindEligible = false
    this.lastVoiceRecognizedText = ''
    this.setData({ voiceCancelActive: false, voiceText: '' })
    if (wx.vibrateShort) {
      try { wx.vibrateShort({ type: 'light' }) } catch (error) {}
    }
    try {
      controller.start()
    } catch (error) {
      this.voicePressing = false
      this.voicePressStartedAt = 0
      this.voiceAutoFindEligible = false
      this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false })
      wx.showToast({ title: voiceInput.errorMessage(error, '语音输入启动失败'), icon: 'none' })
    }
  },

  onVoiceTouchMove(event) {
    if (this.data.voicePhase !== 'recording') return
    const touch = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0]) || {}
    const y = Number(touch.clientY || touch.pageY || 0)
    const slideUp = (this.voiceStartY - y) > 80
    if (slideUp !== this.data.voiceCancelActive) this.setData({ voiceCancelActive: slideUp })
  },

  onVoiceTouchEnd() {
    this.voicePressing = false
    const pressStartedAt = Number(this.voicePressStartedAt || 0)
    const pressDuration = pressStartedAt > 0 ? Date.now() - pressStartedAt : 0
    this.voicePressStartedAt = 0
    const controller = this.voiceController
    if (!controller) {
      this.voiceAutoFindEligible = false
      this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false })
      return
    }
    if (this.data.voiceCancelActive || pressDuration < MIN_VOICE_PRESS_DURATION_MS) {
      this.voiceAutoFindEligible = false
      controller.cancel()
      return
    }
    if (this.data.voicePhase === 'recording') {
      this.voiceAutoFindEligible = true
      try {
        controller.stop()
      } catch (error) {
        this.voiceAutoFindEligible = false
        controller.cancel()
      }
    }
  },

  onVoiceTouchCancel() {
    this.voicePressing = false
    this.voicePressStartedAt = 0
    this.voiceAutoFindEligible = false
    const controller = this.voiceController
    if (controller) {
      controller.cancel()
    } else {
      this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false })
    }
  },

  noop() {},

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
    const payload = {
      text,
      voiceText: source === 'voice' && this.data.voiceText && this.data.voiceText !== text ? this.data.voiceText : '',
      form: {},
      threadId: this.currentThreadId || ''
    }

    this.lastAssistantPayload = payload
    this.setData({
      messages,
      needHistory,
      inputText: '',
      loading: true,
      scrollTarget: 'typing-row'
    })
    this.executeAssistantChat(payload)
  },

  executeAssistantChat(payload) {
    const requestSessionKey = this.syncAuthSession().key
    const requestId = createMessageId('assistant-chat')
    this.activeRequestId = requestId
    this.activeRequestAllowsPublicFallback = true
    this.confirmedPublicFallbackRequestId = ''
    this.lastAssistantPayload = payload
    llmService.chatAssistant(payload, { authFallbackRequestId: requestId }).then((result) => {
      if (!this.isSessionRequestCurrent(requestId, requestSessionKey, true)) return
      this.lastAssistantResultSource = 'assistant-chat'
      this.appendAssistantResult(result || {})
    }).catch((error) => {
      if (!this.isSessionRequestCurrent(requestId, requestSessionKey, true)) return
      this.lastAssistantResultSource = 'assistant-chat'
      this.appendAssistantResult({
        reply: '网络连接失败，请点下方按钮重试。',
        warning: error.message || '网络连接失败',
        networkFailed: true,
        listings: []
      })
    })
  },

  executeRecognize(payload) {
    const requestSessionKey = this.syncAuthSession().key
    const requestId = createMessageId('recognize')
    this.activeRequestId = requestId
    this.activeRequestAllowsPublicFallback = true
    this.confirmedPublicFallbackRequestId = ''
    this.activeRecognizePayload = payload
    llmService.recognizeRentalNeed(payload, { authFallbackRequestId: requestId }).then((result) => {
      if (!this.isSessionRequestCurrent(requestId, requestSessionKey, true)) return
      this.appendRecognitionResult(result || {})
    }).catch((error) => {
      if (!this.isSessionRequestCurrent(requestId, requestSessionKey, true)) return
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
    const requestSessionKey = this.syncAuthSession().key
    const requestId = createMessageId('request')
    this.activeRequestId = requestId
    this.activeRequestAllowsPublicFallback = true
    this.confirmedPublicFallbackRequestId = ''
    llmService.matchRentalNeed(payload, { authFallbackRequestId: requestId }).then((result) => {
      if (!this.isSessionRequestCurrent(requestId, requestSessionKey, true)) return
      this.lastAssistantResultSource = 'match'
      this.appendAssistantResult(result || {})
    }).catch((error) => {
      if (!this.isSessionRequestCurrent(requestId, requestSessionKey, true)) return
      this.lastAssistantResultSource = 'match'
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
    this.appendMessage(assistantMessage, { loading: false, scrollTarget: assistantMessage.id })
  },

  appendAssistantResult(matchResult) {
    if (matchResult && matchResult.threadId) {
      this.currentThreadId = matchResult.threadId
    }
    const listingSections = matchResult && matchResult.networkFailed ? [] : buildListingSections(matchResult)
    const listings = flattenSections(listingSections)
    const requestPayload = this.lastAssistantResultSource === 'match'
      ? (this.lastRequestPayload || this.lastAssistantPayload || {})
      : (this.lastAssistantPayload || this.lastRequestPayload || {})
    const needId = matchResult.needId || requestPayload.needId || ''
    const needTemporary = Boolean(requestPayload.needTemporary || matchResult.needTemporary)
    const feedbackMessageId = matchResult.feedbackMessageId || ''
    const assistantMessageId = createMessageId('assistant')
    const assistantMessage = {
      id: assistantMessageId,
      role: 'assistant',
      text: buildAssistantText(matchResult, listings),
      threadId: matchResult.threadId || this.currentThreadId || '',
      feedbackMessageId,
      sourceText: requestPayload.text || '',
      degradedNotice: matchResult.degraded ? (matchResult.degradedNotice || '智能解读稍后重试') : '',
      needTags: buildNeedTags(matchResult.need),
      need: matchResult.need || {},
      placeResolution: matchResult.placeResolution || null,
      needId,
      needTemporary,
      needNotice: needTemporary ? '需求单接口暂不可用，已生成临时需求单，可继续看房验证。' : '',
      listingSections,
      listings,
      mapFilters: Object.assign(buildMapFilters(matchResult.need, listings), { needId }),
      retryable: Boolean(matchResult.networkFailed),
      retryAction: matchResult.networkFailed ? 'assistant-chat' : 'match',
      retryText: '重试匹配',
      empty: !listings.length && !(matchResult.nextQuestion || matchResult.followUpQuestion),
      canFeedback: !matchResult.networkFailed && Boolean(matchResult.threadId || this.currentThreadId) && Boolean(feedbackMessageId) && Boolean(needId) && !needTemporary,
      feedbackLoading: false,
      feedbackSent: false,
      feedbackType: '',
      feedbackReasonCode: '',
      feedbackReasonLabel: '',
      feedbackReasonOptions: []
    }
    this.appendMessage(assistantMessage, { loading: false, scrollTarget: assistantMessage.id })
  },

  retryLastNeed() {
    if (this.data.loading) return
    const lastMessage = (this.data.messages || []).slice().reverse().find((message) => message.retryable)
    const retryAction = lastMessage && lastMessage.retryAction
    this.setData({
      loading: true,
      scrollTarget: 'typing-row'
    })
    if (retryAction === 'assistant-chat' && this.lastAssistantPayload) {
      this.executeAssistantChat(this.lastAssistantPayload)
      return
    }
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

  selectAssistantFeedbackType(event) {
    const messageId = event.currentTarget.dataset.messageId
    const feedbackType = event.currentTarget.dataset.type || 'other'
    const message = this.findMessage(messageId) || {}
    if (!messageId || !message.canFeedback || message.feedbackLoading || message.feedbackSent) return
    const feedbackReasonOptions = MATCH_RESULT_FEEDBACK_REASONS[feedbackType] || []
    if (!feedbackReasonOptions.length) return
    this.updateMessage(messageId, (item) => {
      item.feedbackType = feedbackType
      item.feedbackReasonCode = ''
      item.feedbackReasonLabel = ''
      item.feedbackReasonOptions = feedbackReasonOptions
      return item
    })
  },

  submitAssistantFeedback(event) {
    const messageId = event.currentTarget.dataset.messageId
    const reasonCode = event.currentTarget.dataset.reasonCode || ''
    const message = this.findMessage(messageId) || {}
    const feedbackType = message.feedbackType || ''
    const reasonOptions = MATCH_RESULT_FEEDBACK_REASONS[feedbackType] || []
    const reason = reasonOptions.find((item) => item.code === reasonCode)
    if (!messageId || !message.canFeedback || message.feedbackLoading || message.feedbackSent || !reason) return
    const requestSessionKey = this.syncAuthSession().key
    const requestFeedbackMessageId = String(message.feedbackMessageId || '')
    const isCurrentFeedback = () => {
      if (this._pageActive === false || currentAuthSessionKey() !== requestSessionKey) return false
      const currentMessage = this.findMessage(messageId) || {}
      return String(currentMessage.feedbackMessageId || '') === requestFeedbackMessageId &&
        !currentMessage.feedbackSent
    }
    this.updateMessage(messageId, (item) => {
      item.feedbackLoading = true
      item.feedbackReasonCode = reasonCode
      return item
    })
    llmService.submitAssistantFeedback({
      feedbackVersion: MATCH_RESULT_FEEDBACK_VERSION,
      needId: message.needId,
      threadId: message.threadId || this.currentThreadId || '',
      messageId: message.feedbackMessageId,
      feedbackType,
      reasonCode
    }).then(() => {
      if (!isCurrentFeedback()) {
        if (this._pageActive !== false && currentAuthSessionKey() !== requestSessionKey) this.syncAuthSession()
        return
      }
      this.updateMessage(messageId, (item) => {
        item.feedbackLoading = false
        item.feedbackSent = true
        item.feedbackType = feedbackType
        item.feedbackReasonCode = reasonCode
        item.feedbackReasonLabel = reason.label
        return item
      })
      wx.showToast({ title: '已记录反馈', icon: 'none' })
    }).catch(() => {
      if (!isCurrentFeedback()) {
        if (this._pageActive !== false && currentAuthSessionKey() !== requestSessionKey) this.syncAuthSession()
        return
      }
      this.updateMessage(messageId, (item) => {
        item.feedbackLoading = false
        return item
      })
      wx.showToast({ title: '反馈提交失败', icon: 'none' })
    })
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
    this.appendMessage(userMessage, { needHistory: [text], loading: true, scrollTarget: 'typing-row' })
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
    this.appendMessage(userMessage, { loading: true, scrollTarget: 'typing-row' })
    if (!apiClient.getAuthToken()) {
      this.lastRequestPayload = payload
      this.executeMatch(payload)
      return
    }
    this.createNeedAndMatch(payload, message)
  },

  createNeedAndMatch(payload, message) {
    const requestSessionKey = this.syncAuthSession().key
    const requestId = createMessageId('create-need')
    this.activeRequestId = requestId
    this.activeRequestAllowsPublicFallback = false
    const need = confirmFormToNeed(message.confirmForm, message.need)
    apiService.createRentalNeed({
      source: 'match-chat',
      text: payload.text,
      need,
      form: payload.form
    }).then((result) => {
      if (!this.isSessionRequestCurrent(requestId, requestSessionKey)) return
      const needId = needIdFromResult(result)
      const needTemporary = Boolean(result && result.temporary)
      const nextPayload = Object.assign({}, payload, {
        needId,
        needTemporary,
        need,
        threadId: this.currentThreadId || message.threadId || ''
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
      if (!this.isSessionRequestCurrent(requestId, requestSessionKey)) return
      this.lastRequestPayload = payload
      wx.showToast({ title: '需求单保存失败，继续本地匹配', icon: 'none' })
      this.executeMatch(payload)
    })
  },

  openMapForListing(event) {
    if (this.data.loading) {
      wx.showToast({ title: '请等待找房结果完成', icon: 'none' })
      return
    }
    const messageId = event.currentTarget.dataset.messageId
    const message = this.findMessage(messageId) || {}
    const filters = Object.assign({}, message.mapFilters || {})
    if (message.needId) filters.needId = message.needId
    filters.listingIds = (message.listings || []).map((listing) => listing.id).filter(Boolean)
    if (!filters.listingIds.length) {
      const id = event.currentTarget.dataset.id
      if (id) filters.listingIds = [id]
    }
    if (filters.listingIds.length) {
      // 推荐卡里的房源 ID 已经是最终结果；“新天地附近”等仅是检索锚点，
      // 不能再作为房源自身 area/community 与 ID 叠加，否则周边房源会被全部误筛掉。
      delete filters.area
      delete filters.community
      delete filters.budget
      delete filters.layout
      delete filters.rentMode
    }
    filters.returnToAssistant = true
    const returnMessages = this.data.messages || []
    const lastMessage = returnMessages[returnMessages.length - 1]
    const returnScrollTarget = this.data.scrollTarget === 'typing-row'
      ? ((lastMessage && lastMessage.id) || 'bottom-anchor')
      : this.data.scrollTarget
    saveAssistantMapReturnState({
      sessionKey: currentAuthSessionKey(),
      data: {
        messages: this.data.messages,
        inputText: this.data.inputText,
        needHistory: this.data.needHistory,
        voiceMode: this.data.voiceMode,
        voiceText: this.data.voiceText,
        scrollTarget: returnScrollTarget
      },
      context: {
        currentThreadId: this.currentThreadId || '',
        lastNeedContext: this.lastNeedContext || null,
        lastAssistantPayload: this.lastAssistantPayload || null,
        lastRecognizePayload: this.lastRecognizePayload || null,
        lastRequestPayload: this.lastRequestPayload || null,
        lastAssistantResultSource: this.lastAssistantResultSource || ''
      }
    })
    try {
      wx.setStorageSync('ynzy_pending_map_filters', createPendingFilterEnvelope(filters, currentAuthSessionKey()))
    } catch (error) {
      wx.showToast({ title: '筛选条件保存失败', icon: 'none' })
      return
    }
    wx.switchTab({ url: '/pages/map/map' })
  }
})
