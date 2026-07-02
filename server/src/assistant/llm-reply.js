const llm = require('../llm')
const { safeNeed, safeListings, scrubSensitiveText } = require('./safety')

const MAX_REPLY_LENGTH = 140

function clampReply(text, fallback) {
  const value = scrubSensitiveText(text || '').replace(/\s+/g, ' ').trim()
  const reply = value || fallback || ''
  return reply.length > MAX_REPLY_LENGTH ? `${reply.slice(0, MAX_REPLY_LENGTH - 3)}...` : reply
}

function safeListingsForPrompt(listings = []) {
  if (llm._internal && typeof llm._internal.safeListingsForPrompt === 'function') {
    return llm._internal.safeListingsForPrompt(listings)
  }
  return safeListings(listings).map((listing) => ({
    id: listing.id,
    community: listing.community,
    area: listing.area,
    layout: listing.layout,
    rentMode: listing.rentMode,
    rent: listing.rent,
    features: listing.features,
    matchGroupText: listing.matchGroupText,
    matchReason: listing.matchReason,
    differenceText: listing.differenceText,
    relevancePercent: listing.relevancePercent
  }))
}

function compactNeedForPrompt(need = {}) {
  return {
    need: safeNeed(need),
    hardConstraints: safeNeed(need.hardConstraints || {}).hardConstraints,
    preferences: {
      budgetTolerance: need.preferences && need.preferences.budgetTolerance ? need.preferences.budgetTolerance : '',
      features: Array.isArray(need.preferences && need.preferences.features)
        ? need.preferences.features.slice(0, 8).map((item) => scrubSensitiveText(item))
        : []
    }
  }
}

function buildReplyPrompt(state = {}) {
  const listings = state.listings && state.listings.length
    ? state.listings
    : (state.exactListings || []).concat(state.nearbyListings || [])
  const need = compactNeedForPrompt(state.need || {})
  const taskType = state.nextQuestion
    ? '追问补槽'
    : (listings.length ? '推荐房源' : '无结果建议')

  return [
    '你是给房产中介使用的找房小程序客服。',
    '你只负责把系统已经算好的找房结果改写成自然、简短、有对话感的中文回复。',
    '禁止新增、删除、排序或改写房源 ID；禁止改变预算、距离、数量、地点解析结论。',
    '禁止输出完整地址、楼栋房号、房东电话、客户手机号、微信号、身份证信息、视频链接或签名参数。',
    '如果 nextQuestion 不为空，必须围绕 nextQuestion 追问，不能同时问多个问题。',
    `任务类型：${taskType}`,
    `中介原话：${scrubSensitiveText([state.sanitizedText, state.sanitizedVoiceText].filter(Boolean).join('，')) || '未提供'}`,
    `结构化需求：${JSON.stringify(need.need)}`,
    `硬条件：${JSON.stringify(need.hardConstraints)}`,
    `偏好：${JSON.stringify(need.preferences)}`,
    `本地回复：${scrubSensitiveText(state.reply || '')}`,
    `nextQuestion：${scrubSensitiveText(state.nextQuestion || '')}`,
    `房源摘要：${JSON.stringify(safeListingsForPrompt(listings).slice(0, 5))}`,
    '只输出最终回复正文，140 个中文字符以内。'
  ].join('\n')
}

function currentListings(state = {}) {
  return state.listings && state.listings.length
    ? state.listings
    : (state.exactListings || []).concat(state.nearbyListings || [])
}

function findUnknownListingIds(text, listings = []) {
  const allowedIds = new Set((listings || [])
    .map((listing) => String(listing.id || '').trim())
    .filter(Boolean))
  if (!allowedIds.size) return []

  const referencedIds = String(text || '').match(/\b[A-Za-z]{1,6}\d{1,8}\b/g) || []
  if (!allowedIds.size) {
    return referencedIds.filter((id, index, all) => all.indexOf(id) === index)
  }
  return referencedIds
    .filter((id) => !allowedIds.has(id))
    .filter((id, index, all) => all.indexOf(id) === index)
}

async function generateControlledReply(state = {}) {
  const localReply = scrubSensitiveText(state.reply || '')
  const config = (state.db && state.db.llmConfig) || {}

  if (state.intent !== 'rental_match' || !config.enabled || config.provider === 'local') {
    return {
      reply: localReply,
      replyMode: 'local'
    }
  }

  try {
    if (!llm._internal || typeof llm._internal.callProvider !== 'function') {
      throw new Error('LLM 调用器不可用')
    }
    const taskConfig = llm._internal.configForTask
      ? llm._internal.configForTask(config, 'reply_writer')
      : config
    const providerReply = await llm._internal.callProvider(taskConfig, buildReplyPrompt(state))
    const reply = clampReply(providerReply, localReply)
    const unknownListingIds = findUnknownListingIds(reply, currentListings(state))
    if (unknownListingIds.length) {
      return {
        reply: localReply,
        replyMode: 'local-fallback',
        llmWarning: `LLM 返回了候选外房源编号：${unknownListingIds.join(',')}`
      }
    }
    return {
      reply,
      replyMode: config.provider || 'llm'
    }
  } catch (error) {
    return {
      reply: localReply,
      replyMode: 'local-fallback',
      llmWarning: scrubSensitiveText(error.message || 'LLM 话术生成失败')
    }
  }
}

module.exports = {
  buildReplyPrompt,
  generateControlledReply,
  _internal: {
    clampReply,
    safeListingsForPrompt,
    compactNeedForPrompt,
    findUnknownListingIds
  }
}
