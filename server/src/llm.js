const matchService = require('./match-service')

function scrubSensitiveText(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'，。；;]+/ig, '[链接已隐藏]')
    .replace(/\b(?:Signature|Expires|OSSAccessKeyId|security-token|x-oss-[^=\s&]+)=[^&\s"'，。；;]+/ig, '[签名参数已隐藏]')
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, '[身份证号已隐藏]')
    .replace(/(?:客户|租客|房东|联系人)?(?:手机号|手机|电话|联系电话|联系方式|号码)[:：\s]*\+?\d[\d\s-]{6,18}/g, '[电话已隐藏]')
    .replace(/1[3-9](?:[\s-]?\d){9}/g, '[手机号已隐藏]')
    .replace(/\b0\d{2,3}[-\s]?\d{7,8}\b/g, '[电话已隐藏]')
    .replace(/\b400[-\s]?\d{3}[-\s]?\d{4}\b/g, '[电话已隐藏]')
    .replace(/\bwxid_[A-Za-z0-9_-]{5,}\b/ig, '[微信号已隐藏]')
    .replace(/(?:微信号?|微信|VX|V信|weixin|wechat)[:：\s]*[A-Za-z][A-Za-z0-9_-]{4,19}/ig, '[微信号已隐藏]')
    .replace(/[A-Za-z0-9\u4e00-\u9fa5]{0,30}(?:\d{1,3}|[一二三四五六七八九十]{1,3})(?:栋|幢|号楼|座)[^，。,.；;\s]{0,30}/g, '[地址已隐藏]')
    .replace(/(?:房号|门牌|房间|室号)[:：\s]*[A-Za-z0-9-]{2,12}/g, '[房号已隐藏]')
    .replace(/\d{1,3}[-－]\d{1,3}[-－]\d{2,4}/g, '[房号已隐藏]')
    .replace(/\d{2,5}(?:室|房号)/g, '[房号已隐藏]')
    .replace(/\d{1,3}(?:栋|幢|号楼|座|单元)/g, '[房号已隐藏]')
    .replace(/[一二三四五六七八九十]{1,3}(?:栋|幢|号楼|座|单元)/g, '[房号已隐藏]')
}

function clampReply(text, fallback) {
  const value = scrubSensitiveText(text).trim()
  const reply = value || fallback || ''
  return reply.length > 100 ? `${reply.slice(0, 97)}...` : reply
}

function parseNeedText(text) {
  return matchService.parseNeed({ text }, [])
}

function buildLocalMatch(db, payload = {}) {
  return matchService.buildLocalMatch(db, payload)
}

function recognizeRentalNeed(db, payload = {}) {
  return matchService.recognizeNeed(db, payload)
}

function extractProviderText(body) {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.output_text === 'string') return body.output_text
  if (Array.isArray(body.choices) && body.choices[0]) {
    return body.choices[0].message && body.choices[0].message.content
      ? body.choices[0].message.content
      : body.choices[0].text || ''
  }
  if (body.output && Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => item.content || [])
      .map((item) => item.text || '')
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

async function callProvider(config, prompt) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node 版本不支持 fetch，请使用 Node 18 或以上')
  }

  const key = process.env[config.secretName || 'LLM_API_KEY']
  if (!config.apiBaseUrl || !key) {
    throw new Error('LLM API 地址或服务端密钥未配置')
  }

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: config.systemPrompt || '你是寓你配房小帮手。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  }

  const res = await fetch(config.apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    throw new Error(`LLM 请求失败：${res.status}`)
  }
  return extractProviderText(await res.json())
}

function safePromptText(value) {
  return scrubSensitiveText(value).replace(/\s+/g, ' ').trim()
}

function sanitizePromptValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizePromptValue(item)).filter((item) => item !== '')
  if (value && typeof value === 'object') return sanitizePromptObject(value)
  if (typeof value === 'string') return safePromptText(value)
  return value === undefined || value === null ? '' : value
}

function sanitizePromptObject(source, allowedKeys) {
  const result = {}
  const data = source || {}
  const keys = allowedKeys || Object.keys(data)
  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) return
    const value = sanitizePromptValue(data[key])
    if (Array.isArray(value)) {
      if (value.length) result[key] = value
      return
    }
    if (value !== '') result[key] = value
  })
  return result
}

function safeNeedForPrompt(need = {}) {
  return sanitizePromptObject(need, [
    'budget',
    'budgetText',
    'minBudget',
    'maxBudget',
    'area',
    'community',
    'rentMode',
    'layout',
    'moveIn',
    'commuteLocation',
    'maxCommuteMinutes',
    'features'
  ])
}

function safeConstraintsForPrompt(constraints = {}) {
  return sanitizePromptObject(constraints, [
    'minBudget',
    'maxBudget',
    'area',
    'community',
    'rentMode',
    'layout',
    'moveIn',
    'commuteLocation',
    'maxCommuteMinutes',
    'features'
  ])
}

function safePreferencesForPrompt(preferences = {}) {
  return sanitizePromptObject(preferences, [
    'budgetTolerance',
    'features'
  ])
}

function safeListingsForPrompt(listings) {
  return (matchService.safeListingsForPrompt(listings) || []).map((listing) => sanitizePromptObject(listing, [
    'id',
    'community',
    'area',
    'layout',
    'rentMode',
    'rent',
    'features',
    'maintenanceText',
    'matchGroupText',
    'matchReason',
    'differenceText',
    'relevancePercent'
  ]))
}

function buildPrompt(payload, localResult) {
  const rawNeed = safePromptText([
    payload && payload.text,
    payload && payload.voiceText
  ].filter(Boolean).join('，'))
  const safeNeed = safeNeedForPrompt(localResult.need || {})
  const safeHardConstraints = safeConstraintsForPrompt(localResult.hardConstraints || {})
  const safePreferences = safePreferencesForPrompt(localResult.preferences || {})
  const promptListings = safeListingsForPrompt(localResult.listings)
  return [
    `中介找房需求：${rawNeed || '未填写'}`,
    `结构化需求：${JSON.stringify(safeNeed)}`,
    `硬条件：${JSON.stringify(safeHardConstraints)}`,
    `偏好：${JSON.stringify(safePreferences)}`,
    `本地候选：${JSON.stringify(promptListings)}`,
    '只生成 100 个中文字以内的简短说明。',
    '不能决定、修改、排序或编造房源 ID。',
    '不能输出完整地址、楼栋房号、房东电话、客户手机号、微信号、身份证信息或视频签名链接。'
  ].join('\n')
}

async function matchRentalNeed(db, payload = {}) {
  if (payload.stage === 'recognize' || payload.recognizeOnly) {
    return recognizeRentalNeed(db, payload)
  }

  const local = buildLocalMatch(db, payload)
  const config = db.llmConfig || {}

  if (!config.enabled || config.provider === 'local') {
    return local
  }

  try {
    const reply = await callProvider(config, buildPrompt(payload, local))
    return {
      ...local,
      reply: clampReply(reply, local.reply),
      mode: config.provider
    }
  } catch (error) {
    return {
      ...local,
      mode: 'local-fallback',
      warning: error.message
    }
  }
}

module.exports = {
  parseNeedText,
  recognizeRentalNeed,
  buildLocalMatch,
  matchRentalNeed,
  _internal: {
    buildPrompt,
    safeNeedForPrompt,
    safeListingsForPrompt,
    scrubSensitiveText,
    callProvider
  }
}
