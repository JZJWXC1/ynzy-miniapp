'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const detailPagePath = require.resolve(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js'))

let authToken = 'TOKEN-DETAIL-A'
let authSessionKey = 'SESSION-DETAIL-A'
let toasts = []
let modals = []
let hideLoadingCalls = 0
let phoneCallOptions = null

global.getApp = () => ({ globalData: { authToken, authSessionKey } })
global.wx = {
  hideShareMenu() {},
  showLoading() {},
  hideLoading() { hideLoadingCalls += 1 },
  showToast(options) { toasts.push(options) },
  showModal(options) { modals.push(options) },
  navigateTo() {},
  redirectTo() {},
  switchTab() {},
  makePhoneCall(options) { phoneCallOptions = options },
  chooseMedia(options) {
    options.success({ tempFiles: [{ tempFilePath: '/tmp/showing-a.jpg', size: 1024 }] })
  }
}

function setAtPath(target, key, value) {
  const parts = String(key).replace(/\[(\d+)\]/g, '.$1').split('.')
  let current = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (!current[part] || typeof current[part] !== 'object') current[part] = /^\d+$/.test(parts[index + 1]) ? [] : {}
    current = current[part]
  }
  current[parts[parts.length - 1]] = value
}

function installApiStub(stub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: stub
  }
}

function loadDefinition(stub) {
  installApiStub(stub)
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[detailPagePath]
  require(detailPagePath)
  assert.ok(definition, '未捕获房源详情页定义')
  return definition
}

function makePage(definition) {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    if (page._pageActive === false) page._writesAfterUnload = Number(page._writesAfterUnload || 0) + 1
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  page._pageActive = true
  page.authTokenSnapshot = authSessionKey
  page.listingLoadGeneration = 1
  page.listingId = 'L-DETAIL-SESSION'
  return page
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function testVideoShareSessionBoundary() {
  let recordCalls = 0
  let shareCalls = 0
  const download = deferred()
  const definition = loadDefinition({
    recordVideoShare() {
      recordCalls += 1
      return Promise.resolve({ logs: [{ id: 'WRONG-ACCOUNT-LOG' }] })
    }
  })
  const page = makePage(definition)
  page.setData({
    listing: { id: 'L-DETAIL-SESSION', videoUrl: 'https://example.test/account-a.mp4' },
    canShareVideo: true,
    logs: [{ id: 'SAFE-OLD-LOG' }]
  })
  page.downloadShareVideo = () => download.promise
  page.shareVideoMessage = () => {
    shareCalls += 1
    return Promise.resolve()
  }
  page.shareVideoFile = () => Promise.reject(new Error('不应进入文件兜底'))

  const pending = page.prepareVideoShare()
  authToken = 'TOKEN-DETAIL-B'
  authSessionKey = 'SESSION-DETAIL-B'
  download.resolve('/tmp/account-a.mp4')
  await pending
  assert.strictEqual(shareCalls, 0, '会话变化后不得继续以新账号发送旧账号发起的视频')
  assert.strictEqual(recordCalls, 0, '会话变化后不得以账号B记录账号A发起的视频分享')
  assert.deepStrictEqual(page.data.logs.map((item) => item.id), ['SAFE-OLD-LOG'], '迟到分享结果不得覆盖新会话日志')
}

async function testShowingSessionBoundary() {
  let recordCalls = 0
  const upload = deferred()
  const definition = loadDefinition({
    createShowingPhotoUploadPolicy() { return Promise.resolve({ uploadUrl: 'https://example.test/upload' }) },
    uploadShowingPhoto() { return upload.promise },
    recordShowing() {
      recordCalls += 1
      return Promise.resolve({ message: '错误归属' })
    }
  })
  authToken = 'TOKEN-SHOWING-A'
  authSessionKey = 'SESSION-SHOWING-A'
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.setData({
    listing: { id: 'L-SHOWING-SESSION', community: '合成小区' },
    isVerified: true,
    needId: 'NEED-A',
    needTemporary: false,
    showingPhotoPath: ''
  })
  page.getShowingLocationInfo = () => Promise.resolve({ locationText: '合成位置', latitude: 30, longitude: 120 })
  page.buildShowingWatermark = () => Promise.resolve({ tempFilePath: '/tmp/watermarked-a.jpg', watermarkText: '合成水印' })

  const pending = page.submitShowingProof()
  await flushPromises()
  await flushPromises()
  authToken = 'TOKEN-SHOWING-B'
  authSessionKey = 'SESSION-SHOWING-B'
  upload.resolve({ fileUrl: 'https://example.test/a.jpg', objectKey: 'showing-proof/a.jpg' })
  await pending
  assert.strictEqual(recordCalls, 0, '会话变化后不得以账号B提交账号A发起的带看记录')
  assert.strictEqual(page.data.showingPhotoPath, '', '会话变化后的迟到带看结果不得写入页面')
}

async function testShowingConfirmationBoundary() {
  const definition = loadDefinition({})

  authToken = 'TOKEN-SHOWING-MODAL-A'
  authSessionKey = 'SESSION-SHOWING-MODAL-A'
  const switchedPage = makePage(definition)
  switchedPage.authTokenSnapshot = authSessionKey
  switchedPage.setData({ listing: { id: 'L-SHOWING-MODAL-A' }, isVerified: true })
  let switchedSubmitCalls = 0
  switchedPage.submitShowingProof = () => { switchedSubmitCalls += 1 }
  modals = []
  switchedPage.recordShowing()
  const switchedModal = modals.pop()
  assert.ok(switchedModal && typeof switchedModal.success === 'function', '记录带看前必须显示拍照确认框')
  authToken = 'TOKEN-SHOWING-MODAL-B'
  authSessionKey = 'SESSION-SHOWING-MODAL-B'
  switchedModal.success({ confirm: true })
  assert.strictEqual(switchedSubmitCalls, 0, 'A 打开的旧带看确认框不得在 B 会话启动相机')

  authToken = 'TOKEN-SHOWING-MODAL-UNLOAD'
  authSessionKey = 'SESSION-SHOWING-MODAL-UNLOAD'
  const unloadedPage = makePage(definition)
  unloadedPage.authTokenSnapshot = authSessionKey
  unloadedPage.setData({ listing: { id: 'L-SHOWING-MODAL-UNLOAD' }, isVerified: true })
  let unloadedSubmitCalls = 0
  unloadedPage.submitShowingProof = () => { unloadedSubmitCalls += 1 }
  modals = []
  unloadedPage.recordShowing()
  const unloadedModal = modals.pop()
  unloadedPage.onUnload()
  unloadedModal.success({ confirm: true })
  assert.strictEqual(unloadedSubmitCalls, 0, '详情页卸载后旧带看确认框不得启动相机')

  authToken = 'TOKEN-SHOWING-MODAL-CURRENT'
  authSessionKey = 'SESSION-SHOWING-MODAL-CURRENT'
  const currentPage = makePage(definition)
  currentPage.authTokenSnapshot = authSessionKey
  currentPage.setData({ listing: { id: 'L-SHOWING-MODAL-CURRENT' }, isVerified: true })
  let currentOperation = null
  currentPage.submitShowingProof = (operation) => { currentOperation = operation }
  modals = []
  currentPage.recordShowing()
  modals.pop().success({ confirm: true })
  assert.ok(currentOperation && currentOperation.listingId === 'L-SHOWING-MODAL-CURRENT', '同会话确认必须把点击时冻结的房源上下文传给拍照链路')
}

async function testSessionResetAndUnload() {
  authToken = 'TOKEN-RESET-A'
  authSessionKey = 'SESSION-RESET-A'
  const definition = loadDefinition({})
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.loadListing = () => Promise.resolve()
  page.setData({
    needId: 'NEED-RESET-A',
    needTemporary: false,
    showingPhotoPath: '/tmp/account-a.jpg',
    showingSubmitting: true,
    shareVideoBusy: true
  })
  authToken = 'TOKEN-RESET-B'
  authSessionKey = 'SESSION-RESET-B'
  page.onShow()
  assert.strictEqual(page.data.needId, '', '换号后必须清除上一账号需求单关联')
  assert.strictEqual(page.data.needTemporary, false, '换号后必须清除上一账号临时需求标记')
  assert.strictEqual(page.data.showingPhotoPath, '', '换号后必须清除上一账号本地带看照片')
  assert.strictEqual(page.data.showingSubmitting, false, '换号后必须作废上一账号带看状态')
  assert.strictEqual(page.data.shareVideoBusy, false, '换号后必须作废上一账号视频分享状态')

  authToken = 'TOKEN-UNLOAD-A'
  authSessionKey = 'SESSION-UNLOAD-A'
  const unloadDownload = deferred()
  let unloadShareCalls = 0
  const unloadPage = makePage(definition)
  unloadPage.authTokenSnapshot = authSessionKey
  unloadPage.setData({ listing: { id: 'L-UNLOAD', videoUrl: 'https://example.test/unload.mp4' }, canShareVideo: true })
  unloadPage.downloadShareVideo = () => unloadDownload.promise
  unloadPage.shareVideoMessage = () => {
    unloadShareCalls += 1
    return Promise.resolve()
  }
  hideLoadingCalls = 0
  const pending = unloadPage.prepareVideoShare()
  unloadPage.onUnload()
  assert.strictEqual(hideLoadingCalls, 1, '详情页卸载时必须立即关闭本页已打开的全局加载层')
  unloadDownload.resolve('/tmp/unload.mp4')
  await pending
  assert.strictEqual(unloadShareCalls, 0, '详情页卸载后不得继续迟到的视频分享链路')
}

async function testPhoneCompleteUnloadBoundary() {
  authToken = 'TOKEN-PHONE-UNLOAD'
  authSessionKey = 'SESSION-PHONE-UNLOAD'
  const definition = loadDefinition({})
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.profileAuthToken = authSessionKey
  page.setData({
    currentUserId: 'U-PHONE-UNLOAD',
    listing: { id: 'L-PHONE-UNLOAD', landlordPhone: '13900000001' },
    sensitiveVisible: true,
    phoneCallBusy: false
  })
  phoneCallOptions = null
  page.callLandlord()
  assert.ok(phoneCallOptions && typeof phoneCallOptions.complete === 'function', '拨号必须注册完成回调')
  page.onUnload()
  phoneCallOptions.complete()
  assert.strictEqual(page._writesAfterUnload || 0, 0, '详情页卸载后拨号完成回调不得写已销毁页面')
}

async function run() {
  toasts = []
  modals = []
  hideLoadingCalls = 0
  await testVideoShareSessionBoundary()
  await testShowingSessionBoundary()
  await testShowingConfirmationBoundary()
  await testSessionResetAndUnload()
  await testPhoneCompleteUnloadBoundary()
  console.log('listing-detail-operation-session-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
