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
let nextControllerId = 1
let activeControllerId = ''

function createVoiceError(message, detail, code) {
  const cleanMessage = String(message || '语音识别失败').trim()
  const cleanDetail = String(detail || '').trim()
  const error = new Error(cleanDetail && cleanMessage.indexOf(cleanDetail) === -1
    ? `${cleanMessage}：${cleanDetail}`
    : cleanMessage)
  error.code = code || ''
  error.detail = cleanDetail
  return error
}

function errorMessage(error, fallback) {
  const parts = [
    error && error.message,
    error && error.errMsg,
    error && error.detail
  ].map((item) => String(item || '').trim()).filter(Boolean)
  return parts[0] || fallback || '语音识别失败'
}

function getSupportStatus() {
  if (typeof wx === 'undefined') {
    return { ok: false, message: '当前环境没有 wx 对象，无法调用录音能力' }
  }
  if (!wx.getRecorderManager) {
    return { ok: false, message: '当前基础库缺少 wx.getRecorderManager' }
  }
  const recorder = getRecorderManager()
  if (!recorder) {
    return { ok: false, message: 'wx.getRecorderManager 初始化失败' }
  }
  if (typeof recorder.onFrameRecorded !== 'function') {
    return { ok: false, message: '当前基础库不支持 onFrameRecorded 实时录音帧' }
  }
  return { ok: true, message: 'wx.getRecorderManager 可用' }
}

function ensureRecordAuthorized(done) {
  if (typeof wx === 'undefined' || !wx.getSetting || !wx.authorize) {
    done()
    return
  }
  wx.getSetting({
    success(res) {
      const authSetting = (res && res.authSetting) || {}
      if (authSetting['scope.record'] === true) {
        done()
        return
      }
      wx.authorize({
        scope: 'scope.record',
        success() {
          done()
        },
        fail(error) {
          done(createVoiceError('录音授权被拒绝，请在微信设置中允许麦克风权限', errorMessage(error), 'record-auth-denied'))
        }
      })
    },
    fail(error) {
      done(createVoiceError('读取录音授权状态失败', errorMessage(error), 'record-auth-check-failed'))
    }
  })
}

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

function bindRecorderNoop(recorder) {
  if (!recorder) return
  if (typeof recorder.onStart === 'function') recorder.onStart(() => {})
  if (typeof recorder.onFrameRecorded === 'function') recorder.onFrameRecorded(() => {})
  if (typeof recorder.onStop === 'function') recorder.onStop(() => {})
  if (typeof recorder.onError === 'function') recorder.onError(() => {})
}

function createController(handlers = {}) {
  const support = getSupportStatus()
  if (!support.ok) return null
  const recorder = getRecorderManager()
  if (!recorder) return null

  const controllerId = `voice-${nextControllerId++}`
  let starting = false
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
  let errored = false
  let lastCaptionText = ''
  let stopDelivered = false

  function isActive() {
    return activeControllerId === controllerId
  }

  function localBusy() {
    return Boolean(starting || listening || transcribing || socketTask || finalTimer)
  }

  function currentCaption() {
    const text = `${confirmedSegments.join('')}${draftText}`.trim()
    if (text) lastCaptionText = text
    return text || lastCaptionText
  }

  function clearFinalTimer() {
    if (!finalTimer) return
    clearTimeout(finalTimer)
    finalTimer = null
  }

  function closeRealtimeSocket() {
    const task = socketTask
    socketTask = null
    socketReady = false
    pendingFrames = []
    closeSocket(task)
  }

  function resetPreemptedSession() {
    if (isActive() || !localBusy()) return false
    cancelled = true
    socketFailed = true
    starting = false
    listening = false
    transcribing = false
    clearFinalTimer()
    closeRealtimeSocket()
    return true
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
    if (!transcribing || cancelled || stopDelivered) return
    stopDelivered = true
    clearFinalTimer()
    transcribing = false
    const text = currentCaption()
    closeRealtimeSocket()
    safeCall(handlers.onStop, text, Object.assign({}, lastRecordResult || {}, {
      asrResult: {
        text,
        provider: 'qwen-asr-realtime',
        mode: 'bailian-asr-realtime-v1'
      }
    }))
  }

  function failRealtime(error) {
    errored = true
    socketFailed = true
    cancelled = true
    starting = false
    transcribing = false
    clearFinalTimer()
    closeRealtimeSocket()
    stopRecorderQuietly()
    safeCall(handlers.onError, createVoiceError(errorMessage(error), '', error && error.code))
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
    if (!isActive()) {
      resetPreemptedSession()
      return
    }
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
      if (!isActive()) {
        resetPreemptedSession()
        return
      }
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
      if (!isActive()) {
        resetPreemptedSession()
        return
      }
      const url = socketTask && socketTask.realtimeAsrUrl ? `WebSocket ${socketTask.realtimeAsrUrl}` : 'WebSocket'
      failRealtime(createVoiceError(`${url} 连接失败`, errorMessage(error), 'asr-socket-error'))
    })
    socketTask.onClose(() => {
      if (!isActive()) {
        resetPreemptedSession()
        return
      }
      socketReady = false
      if (listening && !socketFailed) {
        failRealtime(new Error('实时语音识别连接已断开'))
        return
      }
      if (transcribing) finishWithCurrentCaption()
    })
    return true
  }

  function bindRecorderHandlers() {
    activeControllerId = controllerId

  recorder.onStart(() => {
    if (!isActive()) {
      resetPreemptedSession()
      return
    }
    starting = false
    listening = true
    transcribing = false
    cancelled = false
    errored = false
    confirmedSegments = []
    draftText = ''
    lastCaptionText = ''
    stopDelivered = false
    lastRecordResult = null
    safeCall(handlers.onStart)
  })

  recorder.onFrameRecorded((res) => {
    if (!isActive()) {
      resetPreemptedSession()
      return
    }
    if (res && res.frameBuffer) pushFrame(res.frameBuffer)
  })

  recorder.onStop((res) => {
    if (!isActive()) {
      resetPreemptedSession()
      return
    }
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
    if (!isActive()) {
      resetPreemptedSession()
      return
    }
    errored = true
    starting = false
    listening = false
    transcribing = false
    cancelled = true
    clearFinalTimer()
    closeRealtimeSocket()
    safeCall(handlers.onError, createVoiceError('录音器报错', errorMessage(error), 'recorder-error'))
  })
  }

  bindRecorderHandlers()

  return {
    start() {
      resetPreemptedSession()
      if (starting || listening || transcribing) return
      starting = true
      cancelled = false
      errored = false
      confirmedSegments = []
      draftText = ''
      lastCaptionText = ''
      stopDelivered = false
      lastRecordResult = null
      pendingFrames = []
      bindRecorderHandlers()
      ensureRecordAuthorized((authError) => {
        if (cancelled || !starting || !isActive()) return
        if (authError) {
          starting = false
          safeCall(handlers.onError, authError)
          return
        }
        if (!openRealtimeSocket()) {
          starting = false
          safeCall(handlers.onError, createVoiceError('当前环境暂不支持实时语音识别', '', 'asr-socket-unavailable'))
          return
        }
        try {
          recorder.start(RECORD_OPTIONS)
        } catch (error) {
          errored = true
          starting = false
          closeRealtimeSocket()
          safeCall(handlers.onError, createVoiceError('语音输入启动失败', errorMessage(error), 'recorder-start-failed'))
        }
      })
    },
    stop() {
      if (!isActive()) {
        resetPreemptedSession()
        return
      }
      if (!listening) return
      recorder.stop()
    },
    cancel() {
      if (!localBusy() && !isActive()) return
      const shouldReleaseRecorder = isActive()
      const shouldStopRecorder = shouldReleaseRecorder && listening
      cancelled = true
      socketFailed = true
      starting = false
      transcribing = false
      clearFinalTimer()
      closeRealtimeSocket()
      if (shouldStopRecorder) {
        stopRecorderQuietly()
      } else {
        listening = false
      }
      if (shouldReleaseRecorder) {
        activeControllerId = ''
        bindRecorderNoop(recorder)
      }
      safeCall(handlers.onCancel)
    },
    release() {
      if (localBusy()) {
        this.cancel()
        return
      }
      cancelled = true
      socketFailed = true
      clearFinalTimer()
      closeRealtimeSocket()
      if (isActive()) {
        activeControllerId = ''
        bindRecorderNoop(recorder)
      }
    },
    isBusy() {
      return localBusy()
    },
    isErrored() {
      return errored
    }
  }
}

module.exports = {
  parseNeedText,
  createController,
  getSupportStatus,
  errorMessage,
  _internal: {
    RECORD_OPTIONS,
    FINAL_WAIT_MS,
    ensureRecordAuthorized,
    createVoiceError
  }
}
