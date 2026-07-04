const { URL } = require('url')
const WebSocket = require('ws')
const { WebSocketServer } = WebSocket
const asrService = require('./asr-service')
const { DEFAULT_ASR_VOCABULARY } = require('./asr-normalizer')
const { scrubSensitiveText } = require('./assistant/safety')

const DEFAULT_REALTIME_MODEL = 'qwen3-asr-flash-realtime'
const DEFAULT_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const CLIENT_PATH = '/mini/asr/realtime'
const PCM_SAMPLE_RATE = 16000
const MAX_QUEUED_EVENTS = 128

function unique(values) {
  const seen = new Set()
  return (values || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function resolveRealtimeConfig(db = {}) {
  const baseConfig = asrService.resolveAsrConfig(db)
  return {
    provider: 'qwen-asr-realtime',
    apiKey: baseConfig.apiKey,
    secretName: baseConfig.secretName,
    model: process.env.ASR_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
    apiBaseUrl: process.env.ASR_REALTIME_URL || process.env.DASHSCOPE_ASR_REALTIME_URL || DEFAULT_REALTIME_URL
  }
}

function realtimeUrl(config) {
  const url = new URL(config.apiBaseUrl || DEFAULT_REALTIME_URL)
  if (!url.searchParams.get('model')) url.searchParams.set('model', config.model || DEFAULT_REALTIME_MODEL)
  return url.toString()
}

function vocabularyContextFromDb(db = {}) {
  const listingTerms = (db.listings || []).reduce((terms, listing) => {
    ;['community', 'communityName', 'area', 'block', 'district', 'city'].forEach((key) => {
      if (listing && listing[key]) terms.push(listing[key])
    })
    return terms
  }, [])
  return unique(DEFAULT_ASR_VOCABULARY.concat(listingTerms))
    .slice(0, 240)
    .join('，')
    .slice(0, 4000)
}

function buildSessionUpdate(db = {}) {
  const context = vocabularyContextFromDb(db)
  return {
    type: 'session.update',
    session: {
      input_audio_format: 'pcm',
      sample_rate: PCM_SAMPLE_RATE,
      input_audio_transcription: {
        language: 'zh',
        corpus: {
          text: context
        }
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.35,
        prefix_padding_ms: 300,
        silence_duration_ms: 500
      }
    }
  }
}

function buildAudioAppendEvent(audio) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio)
  return {
    type: 'input_audio_buffer.append',
    audio: buffer.toString('base64')
  }
}

function buildFinishEvent() {
  return { type: 'session.finish' }
}

function extractEventText(event = {}) {
  const candidates = [
    event.transcript,
    event.text,
    event.delta,
    event.partial,
    event.output_text,
    event.item && event.item.transcript,
    event.item && event.item.text,
    event.response && event.response.output_text
  ]
  return String(candidates.find((item) => item !== undefined && item !== null && item !== '') || '')
}

function isCaptionEvent(event = {}) {
  const type = String(event.type || '')
  if (/input_audio_transcription|transcription|transcript|caption/i.test(type)) return true
  return Boolean(extractEventText(event))
}

function isFinalCaptionEvent(event = {}) {
  const type = String(event.type || '')
  return Boolean(event.is_final || event.final || /completed|complete|final|done/i.test(type))
}

function captionFromEvent(event = {}) {
  if (!isCaptionEvent(event)) return null
  const text = scrubSensitiveText(extractEventText(event)).trim()
  const stash = scrubSensitiveText(event.stash || '').trim()
  if (!text && !stash) return null
  return {
    type: 'caption',
    text,
    stash,
    transcript: `${text}${stash}`,
    final: isFinalCaptionEvent(event),
    rawType: event.type || ''
  }
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload))
  return true
}

function sendUpstream(upstream, payload, queue) {
  if (upstream && upstream.readyState === WebSocket.OPEN) {
    upstream.send(JSON.stringify(payload))
    return
  }
  if (queue.length < MAX_QUEUED_EVENTS) queue.push(payload)
}

function flushQueue(upstream, queue) {
  while (queue.length && upstream && upstream.readyState === WebSocket.OPEN) {
    upstream.send(JSON.stringify(queue.shift()))
  }
}

function handleUpstreamMessage(clientWs, data) {
  let event = null
  try {
    event = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''))
  } catch (error) {
    return
  }

  const caption = captionFromEvent(event)
  if (caption) {
    safeSend(clientWs, caption)
    return
  }

  const type = String(event.type || '')
  if (/session\.updated|session\.created/i.test(type)) {
    safeSend(clientWs, { type: 'ready', rawType: type })
    return
  }
  if (/speech_started/i.test(type)) {
    safeSend(clientWs, { type: 'speech_started' })
    return
  }
  if (/speech_stopped/i.test(type)) {
    safeSend(clientWs, { type: 'speech_stopped' })
    return
  }
  if (/session\.finished|done/i.test(type)) {
    safeSend(clientWs, { type: 'finished' })
    return
  }
  if (/error/i.test(type) || event.error) {
    const message = scrubSensitiveText((event.error && (event.error.message || event.error.code)) || event.message || '实时语音识别失败')
    safeSend(clientWs, { type: 'error', message })
  }
}

function handleRealtimeConnection(clientWs, req, options = {}) {
  const db = typeof options.getDb === 'function' ? options.getDb() : (options.db || {})
  const config = resolveRealtimeConfig(db)
  if (!config.apiKey) {
    safeSend(clientWs, {
      type: 'error',
      message: `百炼实时 ASR 密钥未配置：请设置 ${config.secretName || 'ASR_API_KEY'}`
    })
    clientWs.close(1011, 'missing asr key')
    return
  }

  const queue = []
  const upstream = new WebSocket(realtimeUrl(config), {
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    }
  })

  upstream.on('open', () => {
    upstream.send(JSON.stringify(buildSessionUpdate(db)))
    flushQueue(upstream, queue)
    safeSend(clientWs, {
      type: 'connected',
      provider: config.provider,
      model: config.model,
      sampleRate: PCM_SAMPLE_RATE
    })
  })

  upstream.on('message', (data) => handleUpstreamMessage(clientWs, data))
  upstream.on('error', (error) => {
    safeSend(clientWs, {
      type: 'error',
      message: scrubSensitiveText(error.message || '实时语音识别连接失败')
    })
  })
  upstream.on('close', () => {
    safeSend(clientWs, { type: 'closed' })
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close()
  })

  clientWs.on('message', (data, isBinary) => {
    if (isBinary || Buffer.isBuffer(data)) {
      sendUpstream(upstream, buildAudioAppendEvent(data), queue)
      return
    }
    let event = {}
    try {
      event = JSON.parse(String(data || ''))
    } catch (error) {
      return
    }
    if (event.type === 'audio' && event.audio) {
      sendUpstream(upstream, {
        type: 'input_audio_buffer.append',
        audio: String(event.audio)
      }, queue)
      return
    }
    if (event.type === 'finish' || event.type === 'stop') {
      sendUpstream(upstream, buildFinishEvent(), queue)
    }
  })

  clientWs.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close()
    }
  })
}

function attachRealtimeAsr(server, options = {}) {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    // upgrade 事件是同步监听器，不经过 async router 的兜底：畸形百分号转义（如 /%zz）会让
    // decodeURIComponent 抛 URIError、畸形 Host 头会让 new URL 抛 TypeError，逃逸出去即
    // uncaughtException——现在全局兜底是 process.exit，任意客户端一条畸形 upgrade 即可打死
    // 进程。故与 router 的 URL 解析同样独立 try：解析失败直接销毁连接，不升级、不崩进程。
    let pathname
    try {
      const url = new URL(req.url, `http://${req.headers.host}`)
      pathname = decodeURIComponent(url.pathname)
    } catch (error) {
      socket.destroy()
      return
    }
    if (pathname !== CLIENT_PATH) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleRealtimeConnection(ws, req, options)
    })
  })
  return wss
}

module.exports = {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_URL,
  CLIENT_PATH,
  PCM_SAMPLE_RATE,
  attachRealtimeAsr,
  resolveRealtimeConfig,
  _internal: {
    realtimeUrl,
    vocabularyContextFromDb,
    buildSessionUpdate,
    buildAudioAppendEvent,
    buildFinishEvent,
    captionFromEvent,
    handleUpstreamMessage
  }
}
