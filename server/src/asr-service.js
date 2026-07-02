const llm = require('./llm')
const { scrubSensitiveText } = require('./assistant/safety')

const DEFAULT_ASR_MODEL = 'qwen3-asr-flash'
const DEFAULT_ASR_API_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const SUPPORTED_FORMATS = new Set(['wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg', 'opus', 'amr', 'webm'])

function normalizeFormat(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^\./, '')
  if (text === 'mpeg' || text === 'mpga') return 'mp3'
  if (text === 'x-m4a' || text === 'mp4') return 'm4a'
  if (text === 'x-wav') return 'wav'
  return text
}

function formatFromMimeType(mimeType) {
  const matched = String(mimeType || '').toLowerCase().match(/^audio\/([^;]+)/)
  return matched ? normalizeFormat(matched[1]) : ''
}

function formatFromFilename(filename) {
  const matched = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return matched ? normalizeFormat(matched[1]) : ''
}

function mimeTypeFor(format, contentType) {
  const current = String(contentType || '').trim()
  if (current && current.indexOf('/') !== -1) return current
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'm4a') return 'audio/mp4'
  return `audio/${format || 'mpeg'}`
}

function firstConfiguredSecret(candidates) {
  const seen = new Set()
  for (let index = 0; index < candidates.length; index += 1) {
    const name = candidates[index]
    if (!name || seen.has(name)) continue
    seen.add(name)
    const value = process.env[name]
    if (value) return { name, value }
  }
  return { name: candidates.find(Boolean) || 'ASR_API_KEY', value: '' }
}

function resolveAsrConfig(db = {}) {
  const llmConfig = db.llmConfig || {}
  const llmBaseUrl = llmConfig.provider === 'qwen' ? llmConfig.apiBaseUrl : ''
  const secret = firstConfiguredSecret([
    'ASR_API_KEY',
    'DASHSCOPE_API_KEY',
    llmConfig.secretName || 'LLM_API_KEY',
    'LLM_API_KEY'
  ])

  return {
    provider: 'qwen-asr',
    protocol: 'openai-compatible',
    apiBaseUrl: process.env.ASR_API_BASE_URL || process.env.DASHSCOPE_ASR_API_BASE_URL || llmBaseUrl || DEFAULT_ASR_API_BASE_URL,
    model: process.env.ASR_MODEL || DEFAULT_ASR_MODEL,
    secretName: secret.name,
    apiKey: secret.value
  }
}

function configStatus(db = {}) {
  const config = resolveAsrConfig(db)
  return {
    ready: Boolean(config.apiBaseUrl && config.apiKey),
    provider: config.provider,
    model: config.model,
    apiBaseUrl: config.apiBaseUrl,
    secretName: config.secretName
  }
}

function normalizeAudioFile(file = {}, fields = {}) {
  const buffer = file.buffer || file.content
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new Error('缺少语音文件')
    error.statusCode = 400
    throw error
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    const error = new Error('语音文件不能超过 10MB')
    error.statusCode = 413
    throw error
  }

  const fieldFormat = fields.format || fields.audioFormat || ''
  const format = normalizeFormat(fieldFormat) ||
    formatFromFilename(file.filename) ||
    formatFromMimeType(file.contentType) ||
    'mp3'

  if (!SUPPORTED_FORMATS.has(format)) {
    const error = new Error(`暂不支持 ${format || '未知'} 音频格式`)
    error.statusCode = 400
    throw error
  }

  const mimeType = mimeTypeFor(format, file.contentType)
  return {
    buffer,
    format,
    mimeType,
    size: buffer.length,
    filename: file.filename || `voice.${format}`
  }
}

function buildAsrPrompt(fields = {}) {
  const context = String(fields.context || fields.scene || '').trim()
  return [
    '请把这段中文找房语音准确转写成文本，只输出转写结果。',
    '重点保留预算金额、小区名、地名、距离、整租/合租、户型、朝向、燃气、电梯、通勤等找房关键词。',
    '不要补充解释，不要改写成推荐话术。',
    context ? `业务上下文：${context}` : ''
  ].filter(Boolean).join('\n')
}

function buildAsrRequestBody(audio, config, fields = {}) {
  const base64 = audio.buffer.toString('base64')
  return {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: `data:${audio.mimeType};base64,${base64}`,
              format: audio.format
            }
          },
          {
            type: 'text',
            text: buildAsrPrompt(fields)
          }
        ]
      }
    ],
    temperature: 0
  }
}

function extractAsrText(body) {
  if (llm._internal && typeof llm._internal.extractProviderText === 'function') {
    return llm._internal.extractProviderText(body)
  }
  if (body && Array.isArray(body.choices) && body.choices[0] && body.choices[0].message) {
    return String(body.choices[0].message.content || '')
  }
  return ''
}

async function callAsrProvider(config, body) {
  if (typeof fetch !== 'function') {
    const error = new Error('当前 Node 版本不支持 fetch，请使用 Node 18 或以上版本')
    error.statusCode = 500
    throw error
  }
  if (!config.apiBaseUrl || !config.apiKey) {
    const error = new Error('百炼 ASR 密钥未配置：请在服务端设置 ASR_API_KEY、DASHSCOPE_API_KEY 或 LLM_API_KEY')
    error.statusCode = 503
    throw error
  }

  const response = await fetch(config.apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body)
  })

  const responseText = await response.text()
  let responseBody = {}
  try {
    responseBody = responseText ? JSON.parse(responseText) : {}
  } catch (error) {
    responseBody = { raw: responseText }
  }

  if (!response.ok) {
    const providerMessage = scrubSensitiveText(responseBody.message || responseBody.error && responseBody.error.message || responseText || '')
    const error = new Error(`百炼 ASR 请求失败：${response.status}${providerMessage ? ` ${providerMessage}` : ''}`)
    error.statusCode = response.status >= 500 ? 502 : response.status
    throw error
  }

  return responseBody
}

async function transcribeAudio(db, file, options = {}) {
  const fields = options.fields || {}
  const audio = normalizeAudioFile(file, fields)
  const config = resolveAsrConfig(db)
  const requestBody = buildAsrRequestBody(audio, config, fields)
  const providerBody = await callAsrProvider(config, requestBody)
  const text = scrubSensitiveText(extractAsrText(providerBody)).trim()

  return {
    text,
    provider: config.provider,
    protocol: config.protocol,
    model: config.model,
    mode: 'bailian-asr-v1',
    audio: {
      format: audio.format,
      mimeType: audio.mimeType,
      size: audio.size,
      duration: Number(fields.duration || 0) || 0
    }
  }
}

module.exports = {
  DEFAULT_ASR_MODEL,
  DEFAULT_ASR_API_BASE_URL,
  MAX_AUDIO_BYTES,
  configStatus,
  resolveAsrConfig,
  transcribeAudio,
  _internal: {
    normalizeFormat,
    normalizeAudioFile,
    buildAsrPrompt,
    buildAsrRequestBody,
    extractAsrText,
    callAsrProvider
  }
}
