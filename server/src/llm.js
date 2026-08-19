const matchService = require('./match-service')

const DEFAULT_QWEN_NEED_PARSER_MODEL = 'qwen3.5-plus'
const DEFAULT_QWEN_COMPLEX_NEED_PARSER_MODEL = 'qwen3.7-plus'
const DEFAULT_QWEN_REPLY_MODEL = 'qwen-turbo'
const LLM_PROVIDER_TIMEOUT_MS = 20000

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
    .replace(/(^|[^A-Za-z0-9_-])(?:vx|wx|wei\s*xin|we\s*chat|weixin|wechat)\s*[:：号]?\s*[A-Za-z][A-Za-z0-9_-]{3,31}/ig, '$1[微信号已隐藏]')
    .replace(/(?:联\s*系\s*微\s*信|微\s*信(?:\s*号)?|微\s*号|v\s*信)\s*[:：号]?\s*[A-Za-z][A-Za-z0-9_-]{3,31}/ig, '[微信号已隐藏]')
    .replace(/[A-Za-z0-9\u4e00-\u9fa5]{0,30}(?:\d{1,3}|[一二三四五六七八九十]{1,3})(?:栋|幢|号楼|座)[^，。,.；;\s]{0,30}/g, '[地址已隐藏]')
    .replace(/(?:房号|门牌|房间|室号)[:：\s]*[A-Za-z0-9-]{2,12}/g, '[房号已隐藏]')
    .replace(/(^|[^\d])\d{1,3}[-－]\d{1,3}[-－]\d{2,4}(?!\d)/g, '$1[房号已隐藏]')
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

function providerProtocol(config = {}) {
  return String(config.protocol || 'openai-compatible').trim() || 'openai-compatible'
}

function providerSystemPrompt(config = {}) {
  return config.systemPrompt || '你是寓你配房小帮手。'
}

function configForTask(config = {}, task = '') {
  const taskKeyMap = {
    need_parser: 'needParserModel',
    llm_need_parser: 'needParserModel',
    complex_need_parser: 'complexNeedParserModel',
    complex_llm_need_parser: 'complexNeedParserModel',
    reply_writer: 'replyModel',
    llm_reply_writer: 'replyModel'
  }
  const modelKey = taskKeyMap[task] || ''
  const taskModel = modelKey ? String(config[modelKey] || '').trim() : ''
  const qwenDefaults = {
    needParserModel: DEFAULT_QWEN_NEED_PARSER_MODEL,
    complexNeedParserModel: DEFAULT_QWEN_COMPLEX_NEED_PARSER_MODEL,
    replyModel: DEFAULT_QWEN_REPLY_MODEL
  }
  const qwenDefault = config.provider === 'qwen' ? qwenDefaults[modelKey] : ''
  return {
    ...config,
    model: taskModel || qwenDefault || config.model
  }
}

function providerTimeoutMs(config = {}) {
  const timeout = Number(config.providerTimeoutMs || config.timeoutMs || 0)
  return Number.isFinite(timeout) && timeout > 0 ? timeout : LLM_PROVIDER_TIMEOUT_MS
}

function providerTextPart(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value.text === 'string') return value.text
  if (value.text && typeof value.text.value === 'string') return value.text.value
  if (typeof value.output_text === 'string') return value.output_text
  return ''
}

function providerContentText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(providerTextPart).filter(Boolean).join('\n')
  }
  return providerTextPart(content)
}

function extractProviderText(body) {
  if (!body) return ''
  if (typeof body === 'string') return body
  if (typeof body !== 'object') return ''
  if (typeof body.output_text === 'string') return body.output_text
  if (body.data && typeof body.data.text === 'string') return body.data.text
  if (body.data && typeof body.data.output_text === 'string') return body.data.output_text
  if (Array.isArray(body.choices) && body.choices[0]) {
    const choice = body.choices[0]
    const messageText = choice.message ? providerContentText(choice.message.content) : ''
    return messageText || providerContentText(choice.text)
  }
  if (Array.isArray(body.output)) {
    return body.output
      .map((item) => providerContentText(item.content) || providerTextPart(item))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function buildProviderRequestBody(config = {}, prompt) {
  const protocol = providerProtocol(config)
  const systemPrompt = providerSystemPrompt(config)

  if (protocol === 'responses-compatible') {
    return {
      model: config.model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    }
  }

  if (protocol === 'custom-json') {
    return {
      model: config.model,
      system: systemPrompt,
      prompt,
      temperature: 0.2
    }
  }

  return {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  }
}

async function callProvider(config, prompt) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node 版本不支持 fetch，请使用 Node 18 或以上')
  }

  const key = process.env[config.secretName || 'LLM_API_KEY']
  if (!config.apiBaseUrl || !key) {
    throw new Error('LLM API 地址或服务端密钥未配置')
  }

  const body = buildProviderRequestBody(config, prompt)
  const timeoutMs = providerTimeoutMs(config)
  const controller = new AbortController()
  let timedOut = false
  let timeoutTimer = null
  const timeoutError = () => {
    const error = new Error(`LLM 供应商调用超过 ${Math.round(timeoutMs / 1000)} 秒，已降级本地匹配`)
    error.statusCode = 504
    error.code = 'LLM_PROVIDER_TIMEOUT'
    return error
  }
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(timeoutError())
    }, timeoutMs)
  })

  const providerRequest = fetch(config.apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    signal: controller.signal,
    body: JSON.stringify(body)
  }).catch((error) => {
    if (timedOut && error && error.name === 'AbortError') return null
    throw error
  })
  const res = await Promise.race([providerRequest, timeoutPromise]).finally(() => {
    clearTimeout(timeoutTimer)
  })
  if (!res) throw timeoutError()

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
    const reply = await callProvider(configForTask(config, 'reply_writer'), buildPrompt(payload, local))
    return {
      ...local,
      reply: clampReply(reply, local.reply),
      mode: config.provider
    }
  } catch (error) {
    return {
      ...local,
      mode: 'local-fallback',
      degraded: true,
      degradedNotice: '智能解读稍后重试',
      degradedReason: 'llm_provider_failed',
      warning: scrubSensitiveText(error.message)
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
    extractProviderText,
    buildProviderRequestBody,
    configForTask,
    providerTimeoutMs,
    LLM_PROVIDER_TIMEOUT_MS,
    callProvider
  }
}
