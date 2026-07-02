const apiService = require('./api-service')

const AREA_WORDS = [
  '拱墅区',
  '拱墅',
  '西湖区',
  '西湖',
  '上城区',
  '上城',
  '滨江',
  '萧山',
  '余杭',
  '临平',
  '钱塘',
  '北部软件园',
  '城北万象城',
  '万达',
  '文三路',
  '学院路',
  '翠苑',
  '东新园',
  '杭氧',
  '新天地',
  '闸弄口',
  '新塘',
  '元宝塘',
  '东站'
]

const LAYOUT_WORDS = [
  '一室',
  '1室',
  '二室',
  '两室',
  '2室',
  '三室',
  '3室',
  '四室',
  '4室',
  '五室',
  '5室',
  '六室',
  '6室',
  '整租',
  '合租',
  '单间',
  '公寓'
]

const RECORD_OPTIONS = {
  duration: 60000,
  sampleRate: 16000,
  numberOfChannels: 1,
  sampleSize: 16,
  format: 'PCM',
  frameSize: 4
}

const FINAL_WAIT_MS = 2200

function normalizeLayout(value) {
  return String(value || '')
    .replace('1室', '一室')
    .replace('二室', '两室')
    .replace('2室', '两室')
    .replace('3室', '三室')
    .replace('4室', '四室')
    .replace('5室', '五室')
    .replace('6室', '六室')
}

function pickWord(text, words) {
  return words.find((word) => text.indexOf(word) !== -1) || ''
}

function parseNeedText(text) {
  const source = String(text || '').replace(/\s+/g, '')
  const budgetMatch = source.match(/(?:预算|租金|价格|价位)[^\d]*(\d{3,5})/) ||
    source.match(/(\d{3,5})(?:元|块|左右|以内|以下)?/)
  const area = pickWord(source, AREA_WORDS)
  const layout = normalizeLayout(pickWord(source, LAYOUT_WORDS))

  return {
    budget: budgetMatch ? budgetMatch[1] : '',
    area,
    layout
  }
}

function getRecorderManager() {
  if (typeof wx === 'undefined' || !wx.getRecorderManager) return null
  try {
    return wx.getRecorderManager()
  } catch (error) {
    return null
  }
}

function safeCall(handler, ...args) {
  if (typeof handler === 'function') handler(...args)
}

function sendSocketMessage(socketTask, data) {
  if (!socketTask || !socketTask.send) return false
  try {
    socketTask.send({ data })
    return true
  } catch (error) {
    return false
  }
}

function closeSocket(socketTask) {
  if (!socketTask || !socketTask.close) return
  try {
    socketTask.close()
  } catch (error) {
    // 关闭失败不影响录音状态回收。
  }
}

function createController(handlers = {}) {
  const recorder = getRecorderManager()
  if (!recorder) return null
  if (typeof recorder.onFrameRecorded !== 'function') return null

  let listening = false
  let transcribing = false
  let socketTask = null
  let socketReady = false
  let socketFailed = false
  let cancelled = false
  let finalTimer = null
  let confirmedSegments = []
  let draftText = ''
  let pendingFrames = []
  let lastRecordResult = null

  function currentCaption() {
    return `${confirmedSegments.join('')}${draftText}`.trim()
  }

  function clearFinalTimer() {
    if (!finalTimer) return
    clearTimeout(finalTimer)
    finalTimer = null
  }

  function stopRecorderQuietly() {
    if (!listening) return
    try {
      recorder.stop()
    } catch (error) {
      listening = false
    }
  }

  function finishWithCurrentCaption() {
    if (!transcribing || cancelled) return
    clearFinalTimer()
    transcribing = false
    const text = currentCaption()
    closeSocket(socketTask)
    safeCall(handlers.onStop, text, Object.assign({}, lastRecordResult || {}, {
      asrResult: {
        text,
        provider: 'qwen-asr-realtime',
        mode: 'bailian-asr-realtime-v1'
      }
    }))
  }

  function failRealtime(error) {
    socketFailed = true
    cancelled = true
    transcribing = false
    clearFinalTimer()
    closeSocket(socketTask)
    stopRecorderQuietly()
    safeCall(handlers.onError, error)
  }

  function flushFrames() {
    if (!socketReady || !socketTask) return
    while (pendingFrames.length) {
      sendSocketMessage(socketTask, pendingFrames.shift())
    }
  }

  function pushFrame(frameBuffer) {
    if (!frameBuffer || socketFailed) return
    if (socketReady && socketTask) {
      sendSocketMessage(socketTask, frameBuffer)
      return
    }
    if (pendingFrames.length < 80) pendingFrames.push(frameBuffer)
  }

  function handleSocketMessage(message) {
    let event = {}
    try {
      event = JSON.parse(message && message.data ? message.data : '{}')
    } catch (error) {
      return
    }

    if (event.type === 'connected' || event.type === 'ready') {
      socketReady = true
      flushFrames()
      return
    }

    if (event.type === 'caption') {
      const transcript = String(event.transcript || '').trim()
      if (event.final) {
        if (transcript && confirmedSegments[confirmedSegments.length - 1] !== transcript) {
          confirmedSegments.push(transcript)
        }
        draftText = ''
      } else {
        draftText = transcript
      }
      const caption = currentCaption()
      if (caption) safeCall(handlers.onRecognize, caption, event)
      return
    }

    if (event.type === 'finished' || event.type === 'closed') {
      finishWithCurrentCaption()
      return
    }

    if (event.type === 'error') {
      failRealtime(new Error(event.message || '实时语音识别失败'))
    }
  }

  function openRealtimeSocket() {
    socketReady = false
    socketFailed = false
    cancelled = false
    pendingFrames = []
    socketTask = apiService.createRealtimeAsrSocket()
    if (!socketTask) return false

    socketTask.onOpen(() => {
      socketReady = true
      sendSocketMessage(socketTask, JSON.stringify({
        type: 'start',
        format: 'pcm',
        sampleRate: RECORD_OPTIONS.sampleRate
      }))
      flushFrames()
    })
    socketTask.onMessage(handleSocketMessage)
    socketTask.onError((error) => {
      failRealtime(error)
    })
    socketTask.onClose(() => {
      socketReady = false
      if (listening && !socketFailed) {
        failRealtime(new Error('实时语音识别连接已断开'))
        return
      }
      if (transcribing) finishWithCurrentCaption()
    })
    return true
  }

  recorder.onStart(() => {
    listening = true
    transcribing = false
    cancelled = false
    confirmedSegments = []
    draftText = ''
    lastRecordResult = null
    safeCall(handlers.onStart)
  })

  recorder.onFrameRecorded((res) => {
    if (res && res.frameBuffer) pushFrame(res.frameBuffer)
  })

  recorder.onStop((res) => {
    listening = false
    if (cancelled) {
      transcribing = false
      return
    }
    transcribing = true
    lastRecordResult = res || {}
    safeCall(handlers.onTranscribing, res)
    sendSocketMessage(socketTask, JSON.stringify({ type: 'finish' }))
    clearFinalTimer()
    finalTimer = setTimeout(finishWithCurrentCaption, FINAL_WAIT_MS)
  })

  recorder.onError((error) => {
    listening = false
    transcribing = false
    cancelled = true
    clearFinalTimer()
    closeSocket(socketTask)
    safeCall(handlers.onError, error)
  })

  return {
    start() {
      if (listening || transcribing) return
      if (!openRealtimeSocket()) {
        safeCall(handlers.onError, new Error('当前环境暂不支持实时语音识别'))
        return
      }
      recorder.start(RECORD_OPTIONS)
    },
    stop() {
      if (!listening) return
      recorder.stop()
    },
    isBusy() {
      return listening || transcribing
    }
  }
}

module.exports = {
  parseNeedText,
  createController,
  _internal: {
    RECORD_OPTIONS,
    FINAL_WAIT_MS
  }
}
