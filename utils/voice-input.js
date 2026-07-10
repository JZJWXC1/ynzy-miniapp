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
const SOCKET_OPEN_TIMEOUT_MS = 8000
const RECORDER_STOP_TIMEOUT_MS = 3000
const MAX_PENDING_FRAMES = 80
let nextControllerId = 1
const routedRecorders = []
const recorderHub = {
  recorder: null,
  active: null,
  generationCounter: 0,
  activeGeneration: 0,
  stopPending: false,
  stopOwner: null,
  stopGeneration: 0,
  stopTimer: null,
  pendingStart: null
}

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
  const requiredMethods = ['start', 'stop', 'onStart', 'onStop', 'onError', 'onFrameRecorded']
  const missingMethod = requiredMethods.find((name) => typeof recorder[name] !== 'function')
  if (missingMethod) {
    return { ok: false, message: `当前基础库缺少 RecorderManager.${missingMethod}` }
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

function sendSocketMessage(socketTask, data, onFail) {
  if (!socketTask || !socketTask.send) return false
  try {
    socketTask.send({
      data,
      fail(error) {
        safeCall(onFail, error)
      }
    })
    return true
  } catch (error) {
    safeCall(onFail, error)
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

function drainPendingStart() {
  if (recorderHub.stopPending || recorderHub.active || !recorderHub.pendingStart) return
  const next = recorderHub.pendingStart
  recorderHub.pendingStart = null
  if (!next._isQueued()) return
  recorderHub.active = next
  next._beginStart()
}

function clearRecorderStopTimer() {
  if (!recorderHub.stopTimer) return
  clearTimeout(recorderHub.stopTimer)
  recorderHub.stopTimer = null
}

function releaseRecorderOwner(controller) {
  if (recorderHub.active !== controller || recorderHub.stopPending) return
  recorderHub.active = null
  recorderHub.activeGeneration = 0
  drainPendingStart()
}

function beginRecorderGeneration(controller) {
  recorderHub.generationCounter += 1
  recorderHub.activeGeneration = recorderHub.generationCounter
  controller._setRecorderGeneration(recorderHub.activeGeneration)
  return recorderHub.activeGeneration
}

function clearActiveRecorderRun(controller, generation) {
  if (recorderHub.active !== controller || recorderHub.activeGeneration !== generation) return false
  recorderHub.active = null
  recorderHub.activeGeneration = 0
  return true
}

function clearSupersededStopTombstone(generation) {
  const tombstoneGeneration = recorderHub.stopGeneration
  if (recorderHub.stopPending || !recorderHub.stopOwner) return false
  if (!tombstoneGeneration || tombstoneGeneration >= generation) return false
  recorderHub.stopOwner = null
  recorderHub.stopGeneration = 0
  return true
}

function retainTerminalTombstone(controller, generation) {
  if (!controller || !generation) {
    recorderHub.stopOwner = null
    recorderHub.stopGeneration = 0
    return false
  }
  recorderHub.stopOwner = controller
  recorderHub.stopGeneration = generation
  return true
}

function queueControllerStart(controller) {
  const previous = recorderHub.pendingStart
  if (previous && previous !== controller) previous._cancelQueued()
  recorderHub.pendingStart = controller
  controller._markQueued()
}

function requestRecorderStop(controller) {
  if (recorderHub.active !== controller || recorderHub.stopPending) return
  const generation = recorderHub.activeGeneration
  if (!generation) return
  recorderHub.stopPending = true
  recorderHub.stopOwner = controller
  recorderHub.stopGeneration = generation
  clearRecorderStopTimer()
  recorderHub.stopTimer = setTimeout(() => {
    if (recorderHub.stopOwner !== controller || recorderHub.stopGeneration !== generation || !recorderHub.stopPending) return
    recorderHub.stopTimer = null
    recorderHub.stopPending = false
    controller._handleRecorderStopTimeout(generation)
    clearActiveRecorderRun(controller, generation)
    // stopOwner/stopGeneration 作为旧原生录音的终态墓碑保留；迟到 onStop/onError 只能结算这一代。
    drainPendingStart()
  }, RECORDER_STOP_TIMEOUT_MS)
  try {
    recorderHub.recorder.stop()
  } catch (error) {
    clearRecorderStopTimer()
    recorderHub.stopPending = false
    recorderHub.stopOwner = null
    recorderHub.stopGeneration = 0
    controller._handleRecorderStopFailure(error, generation)
    clearActiveRecorderRun(controller, generation)
    drainPendingStart()
  }
}

function requestControllerStart(controller) {
  if (!controller._canRequestStart()) return false
  ensureRecorderRouter(controller._recorder)
  const current = recorderHub.active
  if (current && current !== controller) current._preempt()

  if (recorderHub.stopPending || recorderHub.active) {
    if (recorderHub.active === controller && !recorderHub.stopPending) return false
    queueControllerStart(controller)
    return true
  }

  recorderHub.active = controller
  controller._beginStart()
  return true
}

function bindRecorderRouter(recorder) {
  if (routedRecorders.indexOf(recorder) !== -1) return
  routedRecorders.push(recorder)

  recorder.onStart(() => {
    if (recorderHub.recorder !== recorder || !recorderHub.active) return
    recorderHub.active._handleRecorderStart(recorderHub.activeGeneration)
  })
  recorder.onFrameRecorded((res) => {
    if (recorderHub.recorder !== recorder || !recorderHub.active) return
    recorderHub.active._handleRecorderFrame(res, recorderHub.activeGeneration)
  })
  recorder.onStop((res) => {
    if (recorderHub.recorder !== recorder) return
    clearRecorderStopTimer()
    const owner = recorderHub.stopOwner || recorderHub.active
    const generation = recorderHub.stopOwner ? recorderHub.stopGeneration : recorderHub.activeGeneration
    const keepOwner = owner ? owner._handleRecorderStop(res, generation) === true : false
    recorderHub.stopPending = false
    recorderHub.stopOwner = null
    recorderHub.stopGeneration = 0
    if (owner && !keepOwner) clearActiveRecorderRun(owner, generation)
    drainPendingStart()
  })
  recorder.onError((error) => {
    if (recorderHub.recorder !== recorder) return
    clearRecorderStopTimer()
    const owner = recorderHub.stopOwner || recorderHub.active
    const generation = recorderHub.stopOwner ? recorderHub.stopGeneration : recorderHub.activeGeneration
    recorderHub.stopPending = false
    // 原生 error/interruption 后可能再补一个 onStop；保留已结算代际，直到尾随终态或新代 onStart。
    retainTerminalTombstone(owner, generation)
    if (owner) owner._handleRecorderError(error, generation)
    clearActiveRecorderRun(owner, generation)
    drainPendingStart()
  })
  if (typeof recorder.onInterruptionBegin === 'function') {
    recorder.onInterruptionBegin(() => {
      if (recorderHub.recorder !== recorder) return
      clearRecorderStopTimer()
      const owner = recorderHub.stopOwner || recorderHub.active
      const generation = recorderHub.stopOwner ? recorderHub.stopGeneration : recorderHub.activeGeneration
      recorderHub.stopPending = false
      retainTerminalTombstone(owner, generation)
      if (owner) owner._handleRecorderInterruption(generation)
      clearActiveRecorderRun(owner, generation)
      drainPendingStart()
    })
  }
}

function ensureRecorderRouter(recorder) {
  if (recorderHub.recorder === recorder) return
  clearRecorderStopTimer()
  if (recorderHub.active) recorderHub.active._forceReset()
  if (recorderHub.pendingStart) recorderHub.pendingStart._cancelQueued()
  recorderHub.recorder = recorder
  recorderHub.active = null
  recorderHub.activeGeneration = 0
  recorderHub.stopPending = false
  recorderHub.stopOwner = null
  recorderHub.stopGeneration = 0
  recorderHub.pendingStart = null
  bindRecorderRouter(recorder)
}

function createController(handlers = {}) {
  const support = getSupportStatus()
  if (!support.ok) return null
  const recorder = getRecorderManager()
  if (!recorder) return null
  ensureRecorderRouter(recorder)

  const controllerId = `voice-${nextControllerId++}`
  let sessionId = 0
  let recorderGeneration = 0
  let queued = false
  let starting = false
  let listening = false
  let stopping = false
  let transcribing = false
  let recorderStartIssued = false
  let socketTask = null
  let socketReady = false
  let socketFailed = false
  let cancelled = false
  let finalTimer = null
  let socketOpenTimer = null
  let confirmedSegments = []
  let draftText = ''
  let pendingFrames = []
  let finishPending = false
  let lastRecordResult = null
  let errored = false
  let lastCaptionText = ''
  let stopDelivered = false
  let cancelDelivered = false

  function isOwner() {
    return recorderHub.recorder === recorder && recorderHub.active === controller
  }

  function localBusy() {
    return Boolean(queued || starting || listening || (!cancelled && stopping) || transcribing || socketTask || finalTimer)
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

  function clearSocketOpenTimer() {
    if (!socketOpenTimer) return
    clearTimeout(socketOpenTimer)
    socketOpenTimer = null
  }

  function closeRealtimeSocket() {
    const task = socketTask
    socketTask = null
    socketReady = false
    finishPending = false
    pendingFrames = []
    clearSocketOpenTimer()
    closeSocket(task)
  }

  function resetSessionState() {
    queued = false
    starting = false
    listening = false
    stopping = false
    transcribing = false
    recorderStartIssued = false
    clearFinalTimer()
    closeRealtimeSocket()
  }

  function releaseIfOwner() {
    releaseRecorderOwner(controller)
  }

  function isCurrentSocket(task, targetSessionId) {
    return isOwner() && sessionId === targetSessionId && socketTask === task && !cancelled
  }

  function finishWithCurrentCaption(targetSessionId = sessionId) {
    if (targetSessionId !== sessionId || !transcribing || cancelled || stopDelivered) return
    stopDelivered = true
    clearFinalTimer()
    transcribing = false
    const text = currentCaption()
    closeRealtimeSocket()
    releaseIfOwner()
    safeCall(handlers.onStop, text, Object.assign({}, lastRecordResult || {}, {
      asrResult: {
        text,
        provider: 'qwen-asr-realtime',
        mode: 'bailian-asr-realtime-v1'
      }
    }))
  }

  function failRealtime(error) {
    if (cancelled || !isOwner()) return
    // 转写等待期内出错：若已识别到文本，优先交付（与 onClose 一致），不丢弃用户已说内容。
    if (transcribing && !cancelled && !stopDelivered && currentCaption()) {
      finishWithCurrentCaption()
      return
    }
    errored = true
    socketFailed = true
    cancelled = true
    starting = false
    listening = false
    stopping = false
    transcribing = false
    clearFinalTimer()
    closeRealtimeSocket()
    const shouldStopRecorder = recorderStartIssued && !recorderHub.stopPending
    if (shouldStopRecorder) requestRecorderStop(controller)
    else releaseIfOwner()
    safeCall(handlers.onError, createVoiceError(errorMessage(error), '', error && error.code))
  }

  function sendCurrentSocket(data, targetSessionId, label) {
    const task = socketTask
    if (!task || targetSessionId !== sessionId) return false
    return sendSocketMessage(task, data, (error) => {
      if (!isCurrentSocket(task, targetSessionId)) return
      failRealtime(createVoiceError(`${label || '语音数据'}发送失败`, errorMessage(error), 'asr-socket-send-failed'))
    })
  }

  function flushFrames(targetSessionId) {
    if (!socketReady || !socketTask || targetSessionId !== sessionId) return
    while (pendingFrames.length) {
      if (!sendCurrentSocket(pendingFrames.shift(), targetSessionId, '语音数据')) return
    }
  }

  function pushFrame(frameBuffer) {
    if (!frameBuffer || socketFailed) return
    if (socketReady && socketTask) {
      sendCurrentSocket(frameBuffer, sessionId, '语音数据')
      return
    }
    if (pendingFrames.length >= MAX_PENDING_FRAMES) {
      failRealtime(createVoiceError('语音连接较慢，录音数据积压，请重试', '', 'asr-frame-backlog'))
      return
    }
    pendingFrames.push(frameBuffer)
  }

  function handleSocketMessage(message, task, targetSessionId) {
    if (!isCurrentSocket(task, targetSessionId)) return
    let event = {}
    try {
      event = JSON.parse(message && message.data ? message.data : '{}')
    } catch (error) {
      return
    }

    if (event.type === 'connected' || event.type === 'ready') {
      socketReady = true
      flushFrames(targetSessionId)
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
      finishWithCurrentCaption(targetSessionId)
      return
    }

    if (event.type === 'error') {
      failRealtime(new Error(event.message || '实时语音识别失败'))
    }
  }

  function sendFinish(targetSessionId) {
    if (!socketReady || !socketTask) {
      finishPending = true
      return true
    }
    finishPending = false
    const sent = sendCurrentSocket(JSON.stringify({ type: 'finish' }), targetSessionId, '语音结束信号')
    if (sent) {
      clearFinalTimer()
      finalTimer = setTimeout(() => finishWithCurrentCaption(targetSessionId), FINAL_WAIT_MS)
    }
    return sent
  }

  function openRealtimeSocket(targetSessionId) {
    socketReady = false
    socketFailed = false
    cancelled = false
    pendingFrames = []
    finishPending = false
    let task = null
    try {
      task = apiService.createRealtimeAsrSocket()
    } catch (error) {
      return createVoiceError('实时语音连接启动失败', errorMessage(error), 'asr-socket-create-failed')
    }
    if (!task) return createVoiceError('当前环境暂不支持实时语音识别', '', 'asr-socket-unavailable')
    if (!task.onOpen || !task.onMessage || !task.onError || !task.onClose) {
      closeSocket(task)
      return createVoiceError('当前环境的实时语音连接能力不完整', '', 'asr-socket-incomplete')
    }
    socketTask = task
    socketOpenTimer = setTimeout(() => {
      if (!isCurrentSocket(task, targetSessionId) || socketReady) return
      failRealtime(createVoiceError('实时语音连接超时，请检查网络后重试', '', 'asr-socket-open-timeout'))
    }, SOCKET_OPEN_TIMEOUT_MS)

    try {
      task.onOpen(() => {
        if (!isCurrentSocket(task, targetSessionId)) return
        clearSocketOpenTimer()
        socketReady = true
        if (!sendCurrentSocket(JSON.stringify({
          type: 'start',
          format: 'pcm',
          sampleRate: RECORD_OPTIONS.sampleRate
        }), targetSessionId, '语音开始信号')) return
        flushFrames(targetSessionId)
        if (finishPending) sendFinish(targetSessionId)
      })
      task.onMessage((message) => handleSocketMessage(message, task, targetSessionId))
      task.onError((error) => {
        if (!isCurrentSocket(task, targetSessionId)) return
        const url = task.realtimeAsrUrl ? `WebSocket ${task.realtimeAsrUrl}` : 'WebSocket'
        failRealtime(createVoiceError(`${url} 连接失败`, errorMessage(error), 'asr-socket-error'))
      })
      task.onClose(() => {
        if (!isCurrentSocket(task, targetSessionId)) return
        clearSocketOpenTimer()
        socketReady = false
        if (listening && !socketFailed) {
          failRealtime(new Error('实时语音识别连接已断开'))
          return
        }
        if (transcribing) finishWithCurrentCaption(targetSessionId)
      })
    } catch (error) {
      clearSocketOpenTimer()
      socketTask = null
      closeSocket(task)
      return createVoiceError('实时语音事件绑定失败', errorMessage(error), 'asr-socket-bind-failed')
    }
    return null
  }

  function isCurrentRecorderGeneration(generation) {
    return Number(generation) > 0 && recorderGeneration === generation
  }

  function handleRecorderStart(generation) {
    if (!isOwner() || !isCurrentRecorderGeneration(generation) || cancelled) return
    // 单例录音器已确认启动新一代后，旧代终态不会再到达；继续保留墓碑会吞掉新一代的自然终态。
    clearSupersededStopTombstone(generation)
    starting = false
    listening = true
    stopping = false
    transcribing = false
    cancelled = false
    errored = false
    confirmedSegments = []
    draftText = ''
    lastCaptionText = ''
    stopDelivered = false
    lastRecordResult = null
    safeCall(handlers.onStart)
  }

  function handleRecorderFrame(res, generation) {
    if (!isOwner() || !isCurrentRecorderGeneration(generation) || cancelled || !recorderStartIssued) return
    if (res && res.frameBuffer) pushFrame(res.frameBuffer)
  }

  function handleRecorderStop(res, generation) {
    if (!isCurrentRecorderGeneration(generation)) return false
    recorderStartIssued = false
    listening = false
    stopping = false
    if (cancelled) {
      starting = false
      transcribing = false
      return false
    }
    starting = false
    transcribing = true
    lastRecordResult = res || {}
    safeCall(handlers.onTranscribing, res)
    sendFinish(sessionId)
    return true
  }

  function handleRecorderError(error, generation) {
    if (!isCurrentRecorderGeneration(generation)) return false
    const shouldNotify = !cancelled
    errored = shouldNotify
    recorderStartIssued = false
    queued = false
    starting = false
    listening = false
    stopping = false
    transcribing = false
    cancelled = true
    clearFinalTimer()
    closeRealtimeSocket()
    if (shouldNotify) {
      const code = (error && error.code) || 'recorder-error'
      const interrupted = code === 'recorder-interrupted'
      safeCall(handlers.onError, createVoiceError(
        interrupted ? errorMessage(error) : '录音器报错',
        interrupted ? '' : errorMessage(error),
        code
      ))
    }
    return true
  }

  function cancelSession(notify = true) {
    const wasQueued = recorderHub.pendingStart === controller
    const wasOwner = isOwner()
    const wasBusy = localBusy() || wasQueued || wasOwner
    if (!wasBusy) return

    if (wasQueued) recorderHub.pendingStart = null
    const shouldStopRecorder = wasOwner && recorderStartIssued && !recorderHub.stopPending
    queued = false
    cancelled = true
    socketFailed = true
    starting = false
    listening = false
    stopping = false
    transcribing = false
    clearFinalTimer()
    closeRealtimeSocket()

    if (shouldStopRecorder) requestRecorderStop(controller)
    else if (wasOwner) releaseIfOwner()

    if (notify && !cancelDelivered) {
      cancelDelivered = true
      safeCall(handlers.onCancel)
    }
  }

  function beginStart() {
    sessionId += 1
    recorderGeneration = 0
    queued = false
    starting = true
    listening = false
    stopping = false
    transcribing = false
    recorderStartIssued = false
    cancelled = false
    errored = false
    socketFailed = false
    confirmedSegments = []
    draftText = ''
    lastCaptionText = ''
    stopDelivered = false
    cancelDelivered = false
    lastRecordResult = null
    pendingFrames = []
    finishPending = false
    const targetSessionId = sessionId

    ensureRecordAuthorized((authError) => {
      if (cancelled || !starting || !isOwner() || targetSessionId !== sessionId) return
      if (authError) {
        starting = false
        releaseIfOwner()
        safeCall(handlers.onError, authError)
        return
      }
      const socketError = openRealtimeSocket(targetSessionId)
      if (socketError) {
        starting = false
        releaseIfOwner()
        safeCall(handlers.onError, socketError)
        return
      }
      recorderStartIssued = true
      const generation = beginRecorderGeneration(controller)
      try {
        recorder.start(RECORD_OPTIONS)
      } catch (error) {
        recorderStartIssued = false
        errored = true
        starting = false
        closeRealtimeSocket()
        clearActiveRecorderRun(controller, generation)
        drainPendingStart()
        safeCall(handlers.onError, createVoiceError('语音输入启动失败', errorMessage(error), 'recorder-start-failed'))
      }
    })
  }

  const controller = {
    _recorder: recorder,
    _controllerId: controllerId,
    _setRecorderGeneration(generation) {
      recorderGeneration = generation
    },
    _canRequestStart() {
      return !localBusy()
    },
    _markQueued() {
      queued = true
    },
    _isQueued() {
      return queued
    },
    _cancelQueued() {
      if (!queued) return
      queued = false
      cancelled = true
      if (!cancelDelivered) {
        cancelDelivered = true
        safeCall(handlers.onCancel)
      }
    },
    _beginStart: beginStart,
    _preempt() {
      cancelSession(true)
    },
    _forceReset() {
      queued = false
      cancelled = true
      socketFailed = true
      resetSessionState()
    },
    _handleRecorderStart: handleRecorderStart,
    _handleRecorderFrame: handleRecorderFrame,
    _handleRecorderStop: handleRecorderStop,
    _handleRecorderError: handleRecorderError,
    _handleRecorderInterruption(generation) {
      handleRecorderError(createVoiceError('录音被系统中断，请稍后重试', '', 'recorder-interrupted'), generation)
    },
    _handleRecorderStopFailure(error, generation) {
      if (!isCurrentRecorderGeneration(generation)) return
      recorderStartIssued = false
      listening = false
      stopping = false
      if (cancelled) return
      errored = true
      starting = false
      transcribing = false
      closeRealtimeSocket()
      safeCall(handlers.onError, createVoiceError('停止录音失败', errorMessage(error), 'recorder-stop-failed'))
    },

    _handleRecorderStopTimeout(generation) {
      if (!isCurrentRecorderGeneration(generation)) return
      const shouldNotify = !cancelled
      recorderStartIssued = false
      queued = false
      starting = false
      listening = false
      stopping = false
      transcribing = false
      cancelled = true
      clearFinalTimer()
      closeRealtimeSocket()
      if (shouldNotify) {
        errored = true
        safeCall(handlers.onError, createVoiceError('停止录音超时，请重试', '', 'recorder-stop-timeout'))
      }
    },

    start() {
      requestControllerStart(controller)
    },
    stop() {
      if (!isOwner() || recorderHub.stopPending || (!listening && !recorderStartIssued)) return
      stopping = true
      requestRecorderStop(controller)
    },
    cancel() {
      cancelSession(true)
    },
    release() {
      if (localBusy() || isOwner() || recorderHub.pendingStart === controller) {
        cancelSession(true)
        return
      }
      cancelled = true
      socketFailed = true
      clearFinalTimer()
      closeRealtimeSocket()
      releaseIfOwner()
    },
    isBusy() {
      return localBusy()
    },
    isErrored() {
      return errored
    }
  }

  return controller
}

module.exports = {
  parseNeedText,
  createController,
  getSupportStatus,
  errorMessage,
  _internal: {
    RECORD_OPTIONS,
    FINAL_WAIT_MS,
    SOCKET_OPEN_TIMEOUT_MS,
    RECORDER_STOP_TIMEOUT_MS,
    MAX_PENDING_FRAMES,
    ensureRecordAuthorized,
    createVoiceError
  }
}
