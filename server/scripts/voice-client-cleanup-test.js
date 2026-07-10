const assert = require('assert')
const fs = require('fs')
const path = require('path')
const apiService = require('../../utils/api-service')

function makeRecorder(options = {}) {
  const handlers = {}
  const autoStart = options.autoStart !== false
  const autoStop = options.autoStop !== false
  return {
    started: false,
    startCount: 0,
    stopped: 0,
    options: null,
    bindCounts: { start: 0, frame: 0, stop: 0, error: 0, interruptionBegin: 0 },
    onStart(handler) {
      this.bindCounts.start += 1
      handlers.start = handler
    },
    onFrameRecorded(handler) {
      this.bindCounts.frame += 1
      handlers.frame = handler
    },
    onStop(handler) {
      this.bindCounts.stop += 1
      handlers.stop = handler
    },
    onError(handler) {
      this.bindCounts.error += 1
      handlers.error = handler
    },
    onInterruptionBegin(handler) {
      this.bindCounts.interruptionBegin += 1
      handlers.interruptionBegin = handler
    },
    start(options) {
      this.started = true
      this.startCount += 1
      this.options = options
      if (autoStart) this.emitStart()
    },
    stop() {
      this.stopped += 1
      if (autoStop) this.emitStop()
    },
    emitStop(result) {
      if (handlers.stop) handlers.stop(result || { tempFilePath: 'voice.pcm' })
    },
    emitStart() {
      if (handlers.start) handlers.start()
    },
    emitFrame(frameBuffer) {
      if (handlers.frame) handlers.frame({ frameBuffer })
    },
    emitError(error) {
      if (handlers.error) handlers.error(error)
    },
    emitInterruptionBegin() {
      if (handlers.interruptionBegin) handlers.interruptionBegin()
    }
  }
}

function makeSocket(options = {}) {
  const handlers = {}
  const autoCloseEvent = options.autoCloseEvent !== false
  return {
    closed: 0,
    sent: [],
    onOpen(handler) {
      handlers.open = handler
    },
    onMessage(handler) {
      handlers.message = handler
    },
    onError(handler) {
      handlers.error = handler
    },
    onClose(handler) {
      handlers.close = handler
    },
    send(message) {
      this.sent.push(message)
    },
    close() {
      this.closed += 1
      if (autoCloseEvent) this.emitClose()
    },
    open() {
      if (handlers.open) handlers.open()
    },
    message(data) {
      if (handlers.message) handlers.message({ data })
    },
    error(error) {
      if (handlers.error) handlers.error(error || { errMsg: 'socket failed' })
    },
    emitClose() {
      if (handlers.close) handlers.close()
    }
  }
}

const recorder = makeRecorder()
let currentRecorder = recorder
const socket = makeSocket()
let currentSocket = socket

global.wx = {
  getRecorderManager: () => currentRecorder
}

apiService.createRealtimeAsrSocket = () => currentSocket

const voiceInput = require('../../utils/voice-input')

let stopCalled = false
let errorCalled = false
let cancelCalled = false
const controller = voiceInput.createController({
  onStop: () => {
    stopCalled = true
  },
  onError: () => {
    errorCalled = true
  },
  onCancel: () => {
    cancelCalled = true
  }
})

assert(controller, '应创建语音控制器')
controller.start()
assert.strictEqual(controller.isBusy(), true, '录音开始后应处于忙碌状态')
assert.strictEqual(recorder.started, true, '应启动录音器')

controller.cancel()
assert.strictEqual(recorder.stopped, 1, '退出页面时必须停止录音器')
assert.strictEqual(socket.closed, 1, '退出页面时必须关闭 ASR WebSocket')
assert.strictEqual(controller.isBusy(), false, '退出页面后控制器不应继续忙碌')
assert.strictEqual(stopCalled, false, '取消清理不应误触发识别完成')
assert.strictEqual(errorCalled, false, '取消清理不应误报语音错误')
assert.strictEqual(cancelCalled, true, '取消清理应触发 onCancel 钩子')

const idleController = voiceInput.createController({})
assert(idleController, '应能创建空闲语音控制器')
idleController.release()
assert.strictEqual(recorder.stopped, 1, '无录音状态下触发 onUnload/release 不得调用 recorder.stop')

const sharedRecorder = makeRecorder()
const firstSocket = makeSocket()
const secondSocket = makeSocket()
currentRecorder = sharedRecorder
currentSocket = firstSocket
const firstController = voiceInput.createController({})
assert(firstController, '应能创建第一个页面语音控制器')
firstController.start()
assert.strictEqual(firstController.isBusy(), true, '第一页录音开始后应处于本地忙碌状态')
currentSocket = secondSocket
const secondController = voiceInput.createController({})
assert(secondController, '应能创建第二个页面语音控制器')
secondController.start()
assert.strictEqual(secondController.isBusy(), true, '第二页抢占后应处于忙碌状态')
assert.strictEqual(sharedRecorder.stopped, 1, '第二页接管前必须先停止第一页仍在进行的全局录音')
firstController.release()
assert.strictEqual(firstController.isBusy(), false, '被抢占的旧页面 release 后不得留下 transcribing/listening 悬空态')
assert.strictEqual(sharedRecorder.stopped, 1, '被抢占的旧页面 release 不得再次误停当前页面录音器')
assert.strictEqual(secondController.isBusy(), true, '旧页面 release 不得破坏当前活跃页面会话')
secondController.cancel()
assert.strictEqual(sharedRecorder.stopped, 2, '当前活跃页面 cancel 只停止自己的录音')

const captionRecorder = makeRecorder()
const captionSocket = makeSocket()
currentRecorder = captionRecorder
currentSocket = captionSocket
const recognized = []
const stoppedTexts = []
const captionController = voiceInput.createController({
  onRecognize: (text) => recognized.push(text),
  onStop: (text) => stoppedTexts.push(text)
})
captionController.start()
captionSocket.open()
captionSocket.message(JSON.stringify({ type: 'caption', transcript: '东新园附近两室', final: false }))
captionRecorder.stop()
captionSocket.message(JSON.stringify({ type: 'finished' }))
captionSocket.message(JSON.stringify({ type: 'finished' }))
assert.deepStrictEqual(recognized, ['东新园附近两室'], '实时字幕应把有效识别文本回传给页面')
assert.deepStrictEqual(stoppedTexts, ['东新园附近两室'], '已有有效字幕时 onStop 不得被空结果覆盖')
assert.strictEqual(captionController.isBusy(), false, '识别完成后控制器应收尾为空闲态')

const badRecorder = makeRecorder()
const goodRecorder = makeRecorder()
const badSocket = makeSocket()
const goodSocket = makeSocket()
currentRecorder = badRecorder
currentSocket = badSocket
const badController = voiceInput.createController({})
assert(badController, '应能创建错误态前的语音控制器')
badController.start()
badRecorder.emitError({ errMsg: 'error PCM record', errType: 1 })
assert.strictEqual(badController.isErrored(), true, '录音器 PCM 错误后控制器应标记为可重建错误态')
currentRecorder = goodRecorder
currentSocket = goodSocket
const rebuiltController = voiceInput.createController({})
assert(rebuiltController, '错误态后点击语音入口应能重建控制器')
rebuiltController.start()
assert.strictEqual(goodRecorder.started, true, '重建后的控制器应能重新 start 录音器')

// 真机 recorder.stop 的 onStop 是异步事件。取消时必须立刻清掉本页 busy，但新页面要等旧 stop
// 事件真正到达后再 start，避免旧 stop 被误认成新会话的 stop（这类竞态会导致麦克风无反应或 PCM 错误）。
const asyncRecorder = makeRecorder({ autoStop: false })
const asyncSocket1 = makeSocket()
const asyncSocket2 = makeSocket()
currentRecorder = asyncRecorder
currentSocket = asyncSocket1
let secondStarted = 0
const asyncFirst = voiceInput.createController({})
asyncFirst.start()
asyncFirst.cancel()
assert.strictEqual(asyncFirst.isBusy(), false, '异步 stop 尚未回调时，已取消页面也必须立即退出 busy')
currentSocket = asyncSocket2
const asyncSecond = voiceInput.createController({ onStart: () => { secondStarted += 1 } })
asyncSecond.start()
assert.strictEqual(asyncRecorder.startCount, 1, '旧 stop 未回调前不得立即 start 新录音，避免 stop/start 交叉')
asyncRecorder.emitStop()
assert.strictEqual(asyncRecorder.startCount, 2, '旧 stop 回调后应自动启动排队的新页面录音')
assert.strictEqual(secondStarted, 1, '排队的新页面录音只能启动一次')
asyncSecond.cancel()
asyncRecorder.emitStop()

// 若微信没有回 recorder.onStop，不能让全局录音路由永久卡在 stopPending。
// 超时后应放行下一页录音；迟到的旧 onStop 只能回到旧 controller，不能误停新会话。
const lostStopRecorder = makeRecorder({ autoStop: false })
const lostStopSocket1 = makeSocket()
const lostStopSocket2 = makeSocket()
currentRecorder = lostStopRecorder
currentSocket = lostStopSocket1
let stopTimeoutCallback = null
let lostStopError = null
const nativeSetTimeoutForStop = global.setTimeout
const nativeClearTimeoutForStop = global.clearTimeout
global.setTimeout = (handler, delay, ...args) => {
  if (delay === voiceInput._internal.RECORDER_STOP_TIMEOUT_MS) {
    stopTimeoutCallback = handler
    return { voiceStopTimeout: true }
  }
  return nativeSetTimeoutForStop(handler, delay, ...args)
}
global.clearTimeout = (timer) => {
  if (timer && timer.voiceStopTimeout) return
  nativeClearTimeoutForStop(timer)
}
try {
  const manualStop = voiceInput.createController({ onError: (error) => { lostStopError = error } })
  manualStop.start()
  lostStopSocket1.open()
  manualStop.stop()
  assert.strictEqual(typeof stopTimeoutCallback, 'function', '发出 recorder.stop 后必须设置停止回调超时保护')
  stopTimeoutCallback()
  assert(lostStopError, '用户主动停止时 recorder.stop 回调丢失，必须给页面稳定错误')
  assert.strictEqual(lostStopError.code, 'recorder-stop-timeout', 'stop 回调丢失应返回稳定错误码')
  assert.strictEqual(manualStop.isBusy(), false, 'stop 超时后旧 controller 必须退出 busy')
  lostStopRecorder.emitStop()

  stopTimeoutCallback = null
  lostStopError = null
  const lostStopFirst = voiceInput.createController({ onError: (error) => { lostStopError = error } })
  lostStopFirst.start()
  lostStopSocket1.open()
  lostStopFirst.stop()
  assert.strictEqual(typeof stopTimeoutCallback, 'function', '发出 recorder.stop 后必须设置停止回调超时保护')

  currentSocket = lostStopSocket2
  const lostStopSecond = voiceInput.createController({})
  lostStopSecond.start()
  assert.strictEqual(lostStopRecorder.startCount, 2, '旧 stop 未收口前，新页面录音必须排队，不能交叉 start')
  stopTimeoutCallback()
  assert.strictEqual(lostStopError, null, '页面切换抢占后的旧 stop 超时不应向旧页面弹错误')
  assert.strictEqual(lostStopFirst.isBusy(), false, 'stop 超时后旧 controller 必须退出 busy')
  assert.strictEqual(lostStopRecorder.startCount, 3, 'stop 超时收口后应自动启动排队的新页面录音')
  lostStopRecorder.emitStop()
  assert.strictEqual(lostStopSecond.isBusy(), true, '迟到的旧 onStop 不得结束新页面会话')
  lostStopSecond.cancel()
  lostStopRecorder.emitStop()

  // A 的 stop 终态永久丢失时，旧墓碑不能继续吞掉已经真实启动的 B 的自然 onStop。
  const tombstoneRecorder = makeRecorder({ autoStop: false })
  const tombstoneSocket1 = makeSocket()
  const tombstoneSocket2 = makeSocket()
  currentRecorder = tombstoneRecorder
  currentSocket = tombstoneSocket1
  const tombstoneFirst = voiceInput.createController({})
  tombstoneFirst.start()
  tombstoneSocket1.open()
  tombstoneFirst.stop()
  currentSocket = tombstoneSocket2
  let tombstoneSecondTranscribing = 0
  let tombstoneSecondStopped = 0
  const tombstoneSecond = voiceInput.createController({
    onTranscribing: () => { tombstoneSecondTranscribing += 1 },
    onStop: () => { tombstoneSecondStopped += 1 }
  })
  tombstoneSecond.start()
  stopTimeoutCallback()
  assert.strictEqual(tombstoneRecorder.startCount, 2, '旧 stop 超时后应启动排队的新 controller')
  tombstoneSocket2.open()
  tombstoneRecorder.emitStop()
  assert.strictEqual(tombstoneSecondTranscribing, 1, '新录音真实启动后，其自然 onStop 必须结算到新 controller')
  tombstoneSocket2.message(JSON.stringify({ type: 'finished' }))
  assert.strictEqual(tombstoneSecondStopped, 1, '新录音自然结束后必须完成一次识别收尾')
  assert.strictEqual(tombstoneSecond.isBusy(), false, '新录音自然结束后不得永久卡在 busy')

  // 同一竞态的 onError 路径：B 已发起 start 但尚未收到原生 onStart，旧 error 仍只能结算 A。
  const lateErrorRecorder = makeRecorder({ autoStart: false, autoStop: false })
  const lateErrorSocket1 = makeSocket()
  const lateErrorSocket2 = makeSocket()
  currentRecorder = lateErrorRecorder
  currentSocket = lateErrorSocket1
  let lateOldErrors = 0
  let lateNewErrors = 0
  const lateErrorFirst = voiceInput.createController({ onError: () => { lateOldErrors += 1 } })
  lateErrorFirst.start()
  lateErrorRecorder.emitStart()
  lateErrorSocket1.open()
  lateErrorFirst.stop()
  currentSocket = lateErrorSocket2
  const lateErrorSecond = voiceInput.createController({ onError: () => { lateNewErrors += 1 } })
  lateErrorSecond.start()
  stopTimeoutCallback()
  assert.strictEqual(lateErrorRecorder.startCount, 2, '旧 stop 超时后应启动排队的新 controller')
  lateErrorRecorder.emitError({ errMsg: '旧录音迟到 error PCM record', errType: 1 })
  assert.strictEqual(lateOldErrors, 0, '页面切换取消的旧 controller 不应因迟到 error 再弹错误')
  assert.strictEqual(lateNewErrors, 0, '旧录音迟到 error 不得误报给新 controller')
  assert.strictEqual(lateErrorSecond.isBusy(), true, '旧录音迟到 error 不得结束新 controller')
  lateErrorRecorder.emitStart()
  lateErrorSecond.cancel()
  lateErrorRecorder.emitStop()

  // controller 对象本身也会复用；仅比较 owner 引用不够，必须用每次 recorder.start 的 generation 隔离。
  const generationRecorder = makeRecorder({ autoStart: false, autoStop: false })
  const generationSocket1 = makeSocket()
  const generationSocket2 = makeSocket()
  currentRecorder = generationRecorder
  currentSocket = generationSocket1
  let generationErrors = 0
  const generationController = voiceInput.createController({ onError: () => { generationErrors += 1 } })
  generationController.start()
  generationRecorder.emitStart()
  generationSocket1.open()
  generationController.stop()
  stopTimeoutCallback()
  assert.strictEqual(generationErrors, 1, '主动 stop 超时应只报告本轮一次错误')
  currentSocket = generationSocket2
  generationController.start()
  generationSocket2.open()
  generationRecorder.emitStop()
  generationRecorder.emitStart()
  assert.strictEqual(generationController.isBusy(), true, '同 controller 上一代迟到 onStop 不得结束新 generation')
  assert.strictEqual(generationErrors, 1, '同 controller 上一代迟到 onStop 不得新增错误')
  generationController.cancel()
  generationRecorder.emitStop()

  const generationErrorSocket1 = makeSocket()
  const generationErrorSocket2 = makeSocket()
  currentSocket = generationErrorSocket1
  generationController.start()
  generationRecorder.emitStart()
  generationErrorSocket1.open()
  generationController.stop()
  stopTimeoutCallback()
  assert.strictEqual(generationErrors, 2, '第二次主动 stop 超时应只增加一次本轮错误')
  currentSocket = generationErrorSocket2
  generationController.start()
  generationErrorSocket2.open()
  generationRecorder.emitError({ errMsg: '上一代迟到 error PCM record', errType: 1 })
  generationRecorder.emitStart()
  assert.strictEqual(generationController.isBusy(), true, '同 controller 上一代迟到 onError 不得结束新 generation')
  assert.strictEqual(generationErrors, 2, '同 controller 上一代迟到 onError 不得污染新 generation')
  generationController.cancel()
  generationRecorder.emitStop()
} finally {
  global.setTimeout = nativeSetTimeoutForStop
  global.clearTimeout = nativeClearTimeoutForStop
}

// 系统中断可能先于同一旧录音的尾随 onStop；B 尚未收到 onStart 前，尾随终态仍应归 A。
const interruptionTailRecorder = makeRecorder({ autoStart: false, autoStop: false })
const interruptionTailSocket1 = makeSocket()
const interruptionTailSocket2 = makeSocket()
currentRecorder = interruptionTailRecorder
currentSocket = interruptionTailSocket1
const interruptionTailFirst = voiceInput.createController({})
interruptionTailFirst.start()
interruptionTailRecorder.emitStart()
interruptionTailSocket1.open()
currentSocket = interruptionTailSocket2
let interruptionTailTranscribing = 0
const interruptionTailSecond = voiceInput.createController({
  onTranscribing: () => { interruptionTailTranscribing += 1 }
})
interruptionTailSecond.start()
assert.strictEqual(interruptionTailRecorder.stopped, 1, 'B 接管前应先请求停止 A')
interruptionTailRecorder.emitInterruptionBegin()
assert.strictEqual(interruptionTailRecorder.startCount, 2, 'A 中断结算后应启动排队的 B')
interruptionTailRecorder.emitStop()
assert.strictEqual(interruptionTailTranscribing, 0, 'A 中断后的尾随 onStop 不得提前截断尚未 onStart 的 B')
interruptionTailRecorder.emitStart()
assert.strictEqual(interruptionTailSecond.isBusy(), true, '尾随旧终态后 B 仍应正常进入录音态')
interruptionTailSecond.cancel()
assert.strictEqual(interruptionTailRecorder.stopped, 2, 'B 真实启动后取消必须停止 B 自己的录音')
interruptionTailRecorder.emitStop()

// 同一 controller 可复用。上一轮 socket 的延迟 close/error/message 不能污染新一轮会话。
const reuseRecorder = makeRecorder()
const staleSocket = makeSocket({ autoCloseEvent: false })
const freshSocket = makeSocket()
currentRecorder = reuseRecorder
currentSocket = staleSocket
let reuseErrors = 0
const reuseController = voiceInput.createController({ onError: () => { reuseErrors += 1 } })
reuseController.start()
staleSocket.open()
reuseController.cancel()
currentSocket = freshSocket
reuseController.start()
freshSocket.open()
staleSocket.message(JSON.stringify({ type: 'error', message: '旧连接迟到错误' }))
staleSocket.emitClose()
assert.strictEqual(reuseErrors, 0, '旧 socket 延迟事件不得报到新会话')
assert.strictEqual(reuseController.isBusy(), true, '旧 socket 延迟事件不得结束新会话')
reuseController.cancel()

// 用户很快松手时 WebSocket 可能尚未 open。finish 必须排队，在 open 后按 start→finish 顺序发出，
// 否则服务端收不到 session.finish，只能等兜底超时并误报“没有识别到内容”。
const earlyStopRecorder = makeRecorder()
const lateOpenSocket = makeSocket()
currentRecorder = earlyStopRecorder
currentSocket = lateOpenSocket
const earlyStopController = voiceInput.createController({})
earlyStopController.start()
earlyStopController.stop()
lateOpenSocket.open()
const controlMessages = lateOpenSocket.sent
  .map((item) => item && item.data)
  .filter((item) => typeof item === 'string')
  .map((item) => JSON.parse(item).type)
assert.deepStrictEqual(controlMessages, ['start', 'finish'], '晚开连接必须补发 start→finish 控制帧')
earlyStopController.cancel()

// RecorderManager 是全局单例且官方没有 offStart/offStop：同一实例只能绑定一套稳定路由。
// 多次创建/开始/取消不得反复堆叠监听器。
const bindingRecorder = makeRecorder()
currentRecorder = bindingRecorder
currentSocket = makeSocket()
const bindingController = voiceInput.createController({})
bindingController.start()
bindingController.cancel()
currentSocket = makeSocket()
bindingController.start()
bindingController.cancel()
assert.deepStrictEqual(bindingRecorder.bindCounts, {
  start: 1,
  frame: 1,
  stop: 1,
  error: 1,
  interruptionBegin: 1
}, '全局录音器每类事件只能绑定一次稳定路由')

// WebSocket 一直不开不能让录音器和麦克风指示灯无限挂住；到时必须主动收口并给出可诊断错误码。
const timeoutRecorder = makeRecorder()
const timeoutSocket = makeSocket()
currentRecorder = timeoutRecorder
currentSocket = timeoutSocket
let timeoutCallback = null
let timeoutError = null
const nativeSetTimeout = global.setTimeout
const nativeClearTimeout = global.clearTimeout
global.setTimeout = (handler, delay, ...args) => {
  if (delay === voiceInput._internal.SOCKET_OPEN_TIMEOUT_MS) {
    timeoutCallback = handler
    return { voiceOpenTimeout: true }
  }
  return nativeSetTimeout(handler, delay, ...args)
}
global.clearTimeout = (timer) => {
  if (timer && timer.voiceOpenTimeout) return
  nativeClearTimeout(timer)
}
try {
  const timeoutController = voiceInput.createController({ onError: (error) => { timeoutError = error } })
  timeoutController.start()
  assert.strictEqual(typeof timeoutCallback, 'function', '启动语音后必须设置 WebSocket 开连超时')
  timeoutCallback()
  assert(timeoutError, 'WebSocket 开连超时必须回调错误')
  assert.strictEqual(timeoutError.code, 'asr-socket-open-timeout', '开连超时应返回稳定错误码')
  assert.strictEqual(timeoutController.isBusy(), false, '开连超时后控制器必须恢复空闲')
  assert.strictEqual(timeoutRecorder.stopped, 1, '开连超时后必须停止仍在使用的麦克风')
} finally {
  global.setTimeout = nativeSetTimeout
  global.clearTimeout = nativeClearTimeout
}

// 开连前积帧超过上限不能静默丢音频；应失败收口，让用户明确重试。
const backlogRecorder = makeRecorder()
const backlogSocket = makeSocket()
currentRecorder = backlogRecorder
currentSocket = backlogSocket
let backlogError = null
const backlogController = voiceInput.createController({ onError: (error) => { backlogError = error } })
backlogController.start()
for (let i = 0; i <= voiceInput._internal.MAX_PENDING_FRAMES; i += 1) {
  backlogRecorder.emitFrame(Buffer.from([i % 255]))
}
assert(backlogError, '积帧超过上限必须回调错误，不能继续静默丢帧')
assert.strictEqual(backlogError.code, 'asr-frame-backlog', '积帧错误应返回稳定错误码')
assert.strictEqual(backlogController.isBusy(), false, '积帧失败后控制器必须恢复空闲')

// 来电/微信通话等系统中断要立即释放本次会话；中断结束后下一页仍可重新创建并录音。
const interruptedRecorder = makeRecorder()
currentRecorder = interruptedRecorder
currentSocket = makeSocket()
let interruptionError = null
const interruptedController = voiceInput.createController({ onError: (error) => { interruptionError = error } })
interruptedController.start()
interruptedRecorder.emitInterruptionBegin()
assert(interruptionError, '系统中断录音必须通知页面')
assert.strictEqual(interruptionError.code, 'recorder-interrupted', '系统中断应返回稳定错误码')
assert.strictEqual(interruptedController.isBusy(), false, '系统中断后不得留下忙碌状态')
currentSocket = makeSocket()
const afterInterruption = voiceInput.createController({})
afterInterruption.start()
assert.strictEqual(interruptedRecorder.startCount, 2, '系统中断后下一页应能重新开始录音')
afterInterruption.cancel()

// wx.connectSocket 在授权回调内同步抛错也必须收敛成页面错误，不能逃逸成未捕获异常。
const normalSocketFactory = apiService.createRealtimeAsrSocket
const throwingRecorder = makeRecorder()
currentRecorder = throwingRecorder
apiService.createRealtimeAsrSocket = () => { throw new Error('connectSocket boom') }
let createSocketError = null
const throwingController = voiceInput.createController({ onError: (error) => { createSocketError = error } })
assert.doesNotThrow(() => throwingController.start(), '连接创建异常不得逃出 controller.start')
assert(createSocketError, '连接创建异常必须回调页面')
assert.strictEqual(createSocketError.code, 'asr-socket-create-failed', '连接创建异常应返回稳定错误码')
assert.strictEqual(throwingController.isBusy(), false, '连接创建异常后控制器必须恢复空闲')
apiService.createRealtimeAsrSocket = normalSocketFactory

// 支持探测要检查整套 RecorderManager 契约，避免缺 onStop/onError 时创建阶段直接抛 TypeError。
const incompleteRecorder = makeRecorder()
incompleteRecorder.onStop = undefined
currentRecorder = incompleteRecorder
const incompleteStatus = voiceInput.getSupportStatus()
assert.strictEqual(incompleteStatus.ok, false, 'RecorderManager 缺关键方法时应明确判为不支持')
assert.ok(incompleteStatus.message.includes('RecorderManager.onStop'), '不支持原因应指出缺失的方法')

;[
  'pages/index/index.js',
  'pages/match/match.js',
  'pages/match-chat/match-chat.js'
].forEach((relativePath) => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8')
  assert(source.includes('onHide()'), `${relativePath} 必须在 onHide 清理语音输入`)
  assert(source.includes('cleanupVoiceInput()'), `${relativePath} 必须复用 cleanupVoiceInput`)
  assert(source.includes('controller.isBusy'), `${relativePath} 退出时必须先确认本页确有录音/转写会话`)
  assert(source.includes('controller.release'), `${relativePath} 无录音退出时只能释放本页回调，不能空 stop 全局录音器`)
  assert(source.includes('lastVoiceRecognizedText'), `${relativePath} 必须保留最后一次有效字幕，避免成功识别后弹空内容 toast`)
})

console.log('voice-client-cleanup-test passed')
