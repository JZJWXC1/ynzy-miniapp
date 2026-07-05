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
const socket = makeSocket()

global.wx = {
  getRecorderManager: () => recorder
}

apiService.createRealtimeAsrSocket = () => socket

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

;[
  'pages/index/index.js',
  'pages/match/match.js',
  'pages/match-chat/match-chat.js'
].forEach((relativePath) => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8')
  assert(source.includes('onHide()'), `${relativePath} 必须在 onHide 清理语音输入`)
  assert(source.includes('cleanupVoiceInput()'), `${relativePath} 必须复用 cleanupVoiceInput`)
  assert(source.includes('voiceController.cancel'), `${relativePath} 必须调用控制器 cancel 关闭录音和 WebSocket`)
})

console.log('voice-client-cleanup-test passed')
