const assert = require('assert')
const fs = require('fs')
const path = require('path')
const apiService = require('../../utils/api-service')

function makeRecorder() {
  const handlers = {}
  return {
    started: false,
    stopped: 0,
    options: null,
    onStart(handler) {
      handlers.start = handler
    },
    onFrameRecorded(handler) {
      handlers.frame = handler
    },
    onStop(handler) {
      handlers.stop = handler
    },
    onError(handler) {
      handlers.error = handler
    },
    start(options) {
      this.started = true
      this.options = options
      if (handlers.start) handlers.start()
    },
    stop() {
      this.stopped += 1
      if (handlers.stop) handlers.stop({ tempFilePath: 'voice.pcm' })
    },
    emitFrame(frameBuffer) {
      if (handlers.frame) handlers.frame({ frameBuffer })
    },
    emitError(error) {
      if (handlers.error) handlers.error(error)
    }
  }
}

function makeSocket() {
  const handlers = {}
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
      if (handlers.close) handlers.close()
    },
    open() {
      if (handlers.open) handlers.open()
    },
    message(data) {
      if (handlers.message) handlers.message({ data })
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
firstController.release()
assert.strictEqual(firstController.isBusy(), false, '被抢占的旧页面 release 后不得留下 transcribing/listening 悬空态')
assert.strictEqual(sharedRecorder.stopped, 0, '被抢占的旧页面 release 不得误停当前页面录音器')
assert.strictEqual(secondController.isBusy(), true, '旧页面 release 不得破坏当前活跃页面会话')
secondController.cancel()
assert.strictEqual(sharedRecorder.stopped, 1, '当前活跃页面 cancel 才能停止录音器')

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
