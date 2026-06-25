const llmService = require('../../utils/llm-service')
const voiceInput = require('../../utils/voice-input')
const listingDisplay = require('../../utils/listing-display')

const MAX_RECOMMEND_COUNT = 6

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

function formatScore(listing) {
  const raw = listing.relevancePercent || listing.matchScore || listing.relevanceScore
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw === 'string' && raw.indexOf('%') !== -1) return raw
  const number = Number(raw)
  if (!Number.isFinite(number)) return String(raw)
  return `${Math.round(number <= 1 ? number * 100 : number)}%`
}

function normalizeListings(listings) {
  return listingDisplay.normalizeListings(listings || [])
    .slice(0, MAX_RECOMMEND_COUNT)
    .map((listing) => {
      return Object.assign({}, listing, {
      displayRelevance: formatScore(listing)
    })
    })
}

function buildNeedTags(need) {
  const tags = []
  const data = need || {}
  if (data.budget) tags.push(`预算 ${data.budget}`)
  if (data.area) tags.push(`区域 ${data.area}`)
  if (data.layout) tags.push(`户型 ${data.layout}`)
  if (data.moveIn) tags.push(data.moveIn)
  if (data.commute) tags.push(`通勤 ${data.commute}`)
  if (data.features && data.features.length) tags.push(data.features.join('、'))
  return tags
}

function buildGuideTips(need) {
  const data = need || {}
  const tips = []
  if (!data.budget) tips.push('补充预算')
  if (!data.area) tips.push('补充区域/小区')
  if (!data.layout) tips.push('补充户型/整租合租')
  if (!data.features || !data.features.length) tips.push('补充阳台、燃气、独卫等特点')
  return tips
}

function buildAssistantText(result, listings) {
  if (!listings.length) {
    return '按目前要求暂时没有找到合适房源，你可以继续补充或放宽预算、区域、户型、特点。'
  }
  if (result && result.reply) return result.reply
  const top = listings[0]
  return `已按相关性重新排序，先看这 ${listings.length} 套；当前最匹配的是 ${top.title}。`
}

Page({
  data: {
    messages: [
      {
        id: 'welcome',
        role: 'assistant',
        text: '你好，我是寓你配房客服。把租客预算、区域、户型、特点发给我，我会直接推荐可匹配房源。'
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
      this.submitNeed(firstNeed, voiceText ? 'voice' : 'text')
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
        if (text) this.setData({ inputText: text })
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

    this.setData({
      messages,
      needHistory,
      inputText: '',
      loading: true,
      scrollTarget: 'typing-row'
    })

    llmService.matchRentalNeed({
      text: combinedText,
      voiceText: source === 'voice' ? text : this.data.voiceText,
      form: {}
    }).then((result) => {
      const matchResult = result || {}
      const listings = normalizeListings(matchResult.listings)
      const assistantMessage = {
        id: createMessageId('assistant'),
        role: 'assistant',
        text: buildAssistantText(matchResult, listings),
        needTags: buildNeedTags(matchResult.need),
        guideTips: buildGuideTips(matchResult.need),
        listings,
        empty: !listings.length
      }
      this.setData({
        messages: this.data.messages.concat(assistantMessage),
        loading: false,
        scrollTarget: assistantMessage.id
      })
    }).catch(() => {
      const errorMessage = {
        id: createMessageId('assistant'),
        role: 'assistant',
        text: '这次匹配失败了，请稍后再试，或者把需求拆成预算、区域、户型再发一次。',
        empty: true
      }
      this.setData({
        messages: this.data.messages.concat(errorMessage),
        loading: false,
        scrollTarget: errorMessage.id
      })
    })
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${id}`
    })
  }
})
