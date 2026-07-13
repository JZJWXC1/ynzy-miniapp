'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client.js'))
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
    shareVideoBusy: true,
    saveVideoBusy: true
  })
  authToken = 'TOKEN-RESET-B'
  authSessionKey = 'SESSION-RESET-B'
  page.onShow()
  assert.strictEqual(page.data.needId, '', '换号后必须清除上一账号需求单关联')
  assert.strictEqual(page.data.needTemporary, false, '换号后必须清除上一账号临时需求标记')
  assert.strictEqual(page.data.showingPhotoPath, '', '换号后必须清除上一账号本地带看照片')
  assert.strictEqual(page.data.showingSubmitting, false, '换号后必须作废上一账号带看状态')
  assert.strictEqual(page.data.shareVideoBusy, false, '换号后必须作废上一账号视频分享状态')
  assert.strictEqual(page.data.saveVideoBusy, false, '换号后必须作废上一账号视频保存状态')

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

async function testSaveBusyResetOnReload() {
  authToken = ''
  authSessionKey = 'GUEST-SAVE-RELOAD'
  const listingRequest = deferred()
  const definition = loadDefinition({
    getListingDetail() { return listingRequest.promise }
  })
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.setData({
    saveVideoBusy: true,
    shareVideoBusy: true,
    showingSubmitting: true,
    showingPhotoPath: '/tmp/stale-listing-photo.jpg',
    phoneCallBusy: true
  })
  const pending = page.loadListing('L-SAVE-RELOAD')
  assert.strictEqual(page.data.saveVideoBusy, false, '每次重新读取详情时必须立即清除旧保存 loading')
  assert.strictEqual(page.data.shareVideoBusy, false, '每次重新读取详情时必须立即清除旧分享 loading')
  assert.strictEqual(page.data.showingSubmitting, false, '切换或重载房源时必须作废旧带看提交状态')
  assert.strictEqual(page.data.showingPhotoPath, '', '切换或重载房源时不得沿用上一套房源的带看照片')
  assert.strictEqual(page.data.phoneCallBusy, false, '切换或重载房源时必须清除旧拨号状态')
  listingRequest.resolve({
    id: 'L-SAVE-RELOAD',
    companyListing: true,
    videoUrl: '',
    nearby: { listings: [], total: 0, hasMore: false }
  })
  await pending
}

async function testGuestVideoShareAndSave() {
  authToken = ''
  authSessionKey = 'GUEST-VIDEO-PUBLIC'
  let recordCalls = 0
  let videoShareCalls = 0
  let fileShareCalls = 0
  let saveCalls = 0
  const definition = loadDefinition({
    recordVideoShare() {
      recordCalls += 1
      return Promise.resolve({})
    }
  })
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.setData({ listing: { id: 'L-GUEST-VIDEO', videoUrl: 'https://example.test/public.mp4' }, canShareVideo: true })
  page.downloadShareVideo = () => Promise.resolve('/tmp/public.mp4')
  page.shareVideoMessage = () => {
    videoShareCalls += 1
    return Promise.resolve()
  }
  page.shareVideoFile = () => {
    fileShareCalls += 1
    return Promise.resolve()
  }
  page.saveVideoForManualShare = () => {
    saveCalls += 1
    return Promise.resolve()
  }

  await page.prepareVideoShare()
  assert.strictEqual(videoShareCalls, 1, '游客必须能直接发送公开视频')
  assert.strictEqual(fileShareCalls, 0, '首选视频发送成功后不得重复走文件发送')
  assert.strictEqual(recordCalls, 0, '游客发送视频不得调用受保护的账号留痕接口')

  await page.saveListingVideo()
  assert.strictEqual(saveCalls, 1, '游客必须能把公开视频保存到相册')
  assert.strictEqual(recordCalls, 0, '游客保存视频同样不得伪造账号留痕')
}

async function testShareAuditFailureDoesNotDuplicateDelivery() {
  authToken = 'TOKEN-VIDEO-AUDIT'
  authSessionKey = 'SESSION-VIDEO-AUDIT'
  let recordCalls = 0
  let videoShareCalls = 0
  let fileShareCalls = 0
  let fallbackCalls = 0
  const definition = loadDefinition({
    recordVideoShare() {
      recordCalls += 1
      return Promise.reject(new Error('synthetic audit outage'))
    }
  })
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.setData({ listing: { id: 'L-VIDEO-AUDIT', videoUrl: 'https://example.test/audit.mp4' }, canShareVideo: true })
  page.downloadShareVideo = () => Promise.resolve('/tmp/audit.mp4')
  page.shareVideoMessage = () => {
    videoShareCalls += 1
    return Promise.resolve()
  }
  page.shareVideoFile = () => {
    fileShareCalls += 1
    return Promise.resolve()
  }
  page.fallbackSaveVideo = () => {
    fallbackCalls += 1
    return Promise.resolve(true)
  }

  await page.prepareVideoShare()
  assert.strictEqual(videoShareCalls, 1, '登录用户只发送一次视频')
  assert.strictEqual(recordCalls, 1, '登录用户仍尝试服务端留痕')
  assert.strictEqual(fileShareCalls, 0, '留痕失败不能误判发送失败并重复发送文件')
  assert.strictEqual(fallbackCalls, 0, '留痕失败不能误触相册兜底')
}

async function testShareCancelAndAlbumFallbackAuditBoundary() {
  authToken = 'TOKEN-VIDEO-CANCEL'
  authSessionKey = 'SESSION-VIDEO-CANCEL'
  let recordCalls = 0
  let fileShareCalls = 0
  let fallbackCalls = 0
  const definition = loadDefinition({
    recordVideoShare() {
      recordCalls += 1
      return Promise.resolve({})
    }
  })

  const videoCancelPage = makePage(definition)
  videoCancelPage.authTokenSnapshot = authSessionKey
  videoCancelPage.setData({ listing: { id: 'L-VIDEO-CANCEL', videoUrl: 'https://example.test/cancel.mp4' }, canShareVideo: true })
  videoCancelPage.downloadShareVideo = () => Promise.resolve('/tmp/cancel.mp4')
  videoCancelPage.shareVideoMessage = () => Promise.reject({ errMsg: 'shareVideoMessage:fail cancel' })
  videoCancelPage.shareVideoFile = () => { fileShareCalls += 1; return Promise.resolve() }
  videoCancelPage.fallbackSaveVideo = () => { fallbackCalls += 1; return Promise.resolve(true) }
  await videoCancelPage.prepareVideoShare()
  assert.strictEqual(fileShareCalls, 0, '用户取消视频分享后不得再次弹文件分享')
  assert.strictEqual(fallbackCalls, 0, '用户取消视频分享后不得自动保存相册')
  assert.strictEqual(recordCalls, 0, '用户取消视频分享不得写成功足迹')

  fileShareCalls = 0
  fallbackCalls = 0
  const fileCancelPage = makePage(definition)
  fileCancelPage.authTokenSnapshot = authSessionKey
  fileCancelPage.setData({ listing: { id: 'L-FILE-CANCEL', videoUrl: 'https://example.test/file-cancel.mp4' }, canShareVideo: true })
  fileCancelPage.downloadShareVideo = () => Promise.resolve('/tmp/file-cancel.mp4')
  fileCancelPage.shareVideoMessage = () => Promise.reject(new Error('当前微信版本暂不支持直接发送视频气泡'))
  fileCancelPage.shareVideoFile = () => { fileShareCalls += 1; return Promise.reject({ errMsg: 'shareFileMessage:fail canceled' }) }
  fileCancelPage.fallbackSaveVideo = () => { fallbackCalls += 1; return Promise.resolve(true) }
  await fileCancelPage.prepareVideoShare()
  assert.strictEqual(fileShareCalls, 1, '视频气泡能力不可用时允许尝试一次文件发送')
  assert.strictEqual(fallbackCalls, 0, '用户取消文件分享后不得自动保存相册')
  assert.strictEqual(recordCalls, 0, '两级分享均未成功不得写成功足迹')

  const albumPage = makePage(definition)
  albumPage.authTokenSnapshot = authSessionKey
  albumPage.setData({ listing: { id: 'L-ALBUM-FALLBACK', videoUrl: 'https://example.test/album.mp4' }, canShareVideo: true })
  albumPage.downloadShareVideo = () => Promise.resolve('/tmp/album.mp4')
  albumPage.shareVideoMessage = () => Promise.reject(new Error('当前微信版本暂不支持直接发送视频气泡'))
  albumPage.shareVideoFile = () => Promise.reject(new Error('当前微信版本暂不支持直接发送视频文件'))
  albumPage.saveVideoForManualShare = () => Promise.resolve()
  await albumPage.prepareVideoShare()
  assert.strictEqual(recordCalls, 0, '仅保存到相册尚未实际发送，不得伪造视频转发足迹')
}

async function testSaveAndShareAreMutuallyExclusive() {
  authToken = ''
  authSessionKey = 'GUEST-VIDEO-MUTEX'
  let downloadCalls = 0
  const definition = loadDefinition({})
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.setData({
    listing: { id: 'L-VIDEO-MUTEX', videoUrl: 'https://example.test/mutex.mp4' },
    canShareVideo: true,
    saveVideoBusy: true,
    shareVideoBusy: false
  })
  page._shareVideoOperationSeq = 7
  page.downloadShareVideo = () => {
    downloadCalls += 1
    return Promise.resolve('/tmp/mutex.mp4')
  }

  await page.prepareVideoShare()
  assert.strictEqual(downloadCalls, 0, '保存视频进行中时，分享入口必须立即停止且不得重复下载')
  assert.strictEqual(page._shareVideoOperationSeq, 7, '被保存操作拦截的分享不得作废当前保存操作序列')
  assert.strictEqual(page.data.saveVideoBusy, true, '被拦截的分享不得清除仍在进行的保存状态')
  assert.strictEqual(page.data.shareVideoBusy, false, '被拦截的分享不得制造新的分享 loading')
}

async function testExpiredMediaDownloadRefreshesOnce() {
  authToken = ''
  authSessionKey = 'GUEST-MEDIA-DOWNLOAD-REFRESH'
  let refreshCalls = 0
  const definition = loadDefinition({
    getListingDetail(id, options) {
      refreshCalls += 1
      assert.strictEqual(id, 'L-MEDIA-DOWNLOAD')
      assert.strictEqual(options && options.anonymous, true, '过期媒体重取必须使用匿名公开详情')
      return Promise.resolve({
        id,
        videoUrl: 'https://api.example.test/media/fresh-download',
        coverUrl: 'https://api.example.test/media/fresh-cover'
      })
    }
  })
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.listingId = 'L-MEDIA-DOWNLOAD'
  page.setData({
    listing: {
      id: 'L-MEDIA-DOWNLOAD',
      videoUrl: 'https://api.example.test/media/expired-download',
      coverUrl: 'https://api.example.test/media/expired-cover',
      landlordPhone: '仅用于证明刷新不覆盖'
    },
    canShareVideo: true
  })
  const downloadOptions = []
  global.wx.downloadFile = (options) => {
    downloadOptions.push(options)
    if (downloadOptions.length === 1) {
      options.success({ statusCode: 404 })
      return
    }
    options.success({ statusCode: 200, tempFilePath: '/tmp/fresh-download.mp4' })
  }

  const filePath = await page.downloadShareVideo(page.data.listing.videoUrl)
  assert.strictEqual(filePath, '/tmp/fresh-download.mp4')
  assert.strictEqual(downloadOptions.length, 2, '能力地址失效后只允许刷新并重试一次下载')
  assert.strictEqual(downloadOptions[0].timeout, 300000, '大视频下载超时必须与发布体积边界对齐')
  assert.strictEqual(downloadOptions[1].url, 'https://api.example.test/media/fresh-download')
  assert.strictEqual(refreshCalls, 1)
  assert.strictEqual(page.data.listing.coverUrl, 'https://api.example.test/media/fresh-cover')
  assert.strictEqual(page.data.listing.landlordPhone, '仅用于证明刷新不覆盖', '媒体刷新只能合并公开视频字段')

  downloadOptions.length = 0
  refreshCalls = 0
  page.setData({ listing: Object.assign({}, page.data.listing, { videoUrl: 'https://api.example.test/media/expired-again' }) })
  global.wx.downloadFile = (options) => {
    downloadOptions.push(options)
    options.success({ statusCode: 404 })
  }
  await assert.rejects(
    page.downloadShareVideo(page.data.listing.videoUrl),
    (error) => error && error.statusCode === 404
  )
  assert.strictEqual(downloadOptions.length, 2, '刷新后的地址仍失败时必须停止，不能形成下载循环')
  assert.strictEqual(refreshCalls, 1, '单次下载最多重取一次公开详情')
  delete global.wx.downloadFile
}

async function testSilentAuditLogoutClearsSensitiveState() {
  authToken = 'TOKEN-VIDEO-EXPIRED'
  authSessionKey = 'SESSION-VIDEO-EXPIRED'
  let recordCalls = 0
  let shareCalls = 0
  let publicReloadCalls = 0
  const definition = loadDefinition({
    recordVideoShare() {
      recordCalls += 1
      // 模拟 api-client 对当前失效 token 的真实行为：清理身份并轮换为游客会话，但不导航。
      authToken = ''
      authSessionKey = 'GUEST-AFTER-VIDEO-AUDIT-401'
      const error = new Error('登录已过期')
      error.statusCode = 401
      return Promise.reject(error)
    },
    getListingDetail(id) {
      publicReloadCalls += 1
      return Promise.resolve({
        id,
        companyListing: false,
        videoUrl: 'https://api.example.test/media/public-after-logout',
        nearby: { listings: [], total: 0, hasMore: false }
      })
    }
  })
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.listingId = 'L-VIDEO-AUDIT-401'
  page.profileAuthToken = authSessionKey
  page.setData({
    listing: {
      id: 'L-VIDEO-AUDIT-401',
      videoUrl: 'https://api.example.test/media/before-logout',
      address: '仅用于测试的旧账号敏感地址',
      landlordPhone: '19900001111'
    },
    logs: [{ id: 'OLD-ACCOUNT-LOG' }],
    currentUserId: 'U-OLD',
    isVerified: true,
    sensitiveVisible: true,
    canShareVideo: true,
    shareVideoBusy: false
  })
  page.downloadShareVideo = () => Promise.resolve('/tmp/audit-401.mp4')
  page.shareVideoMessage = () => { shareCalls += 1; return Promise.resolve() }

  await page.prepareVideoShare()
  await flushPromises()
  await flushPromises()
  assert.strictEqual(shareCalls, 1, '留痕 401 发生前公开视频必须只发送一次')
  assert.strictEqual(recordCalls, 1, '登录态存在时仍应尽力留痕一次')
  assert.strictEqual(publicReloadCalls, 1, '静默撤销旧身份后必须立即重读公共详情')
  assert.strictEqual(page.data.shareVideoBusy, false, '留痕 401 轮换会话后不得卡死分享 loading')
  assert.strictEqual(page.data.sensitiveVisible, false, '静默退出后必须立即关闭旧账号敏感信息')
  assert.strictEqual(page.data.listing.address, undefined, '静默退出后不得残留旧账号完整地址')
  assert.strictEqual(page.data.listing.landlordPhone, undefined, '静默退出后不得残留旧账号房东电话')
  assert.deepStrictEqual(page.data.logs, [], '静默退出后不得残留旧账号足迹')
  assert.strictEqual(page.data.listing.videoUrl, 'https://api.example.test/media/public-after-logout', '身份失效不应破坏公开视频继续浏览')
  assert.ok(toasts.some((item) => item.title === '视频已发送'), '实际发送成功仍应给出成功反馈')
}

async function testExternalAuthInvalidationImmediatelyClearsSensitiveState() {
  authToken = 'TOKEN-DETAIL-EXTERNAL-REVOKE'
  authSessionKey = 'SESSION-DETAIL-EXTERNAL-REVOKE'
  const apiClient = require(apiClientPath)
  const originalSubscribe = apiClient.subscribeAuthInvalidation
  let invalidationListener = null
  let unsubscribed = false
  apiClient.subscribeAuthInvalidation = (listener) => {
    invalidationListener = listener
    return () => { unsubscribed = true }
  }
  let publicReloadCalls = 0
  const definition = loadDefinition({
    getListingDetail(id) {
      publicReloadCalls += 1
      return Promise.resolve({
        id,
        companyListing: false,
        sensitiveLocked: true,
        videoUrl: 'https://api.example.test/media/public-after-external-revoke',
        nearby: { listings: [], total: 0, hasMore: false }
      })
    }
  })
  const page = makePage(definition)
  page.authTokenSnapshot = authSessionKey
  page.listingId = 'L-EXTERNAL-REVOKE'
  page.setData({
    listing: {
      id: 'L-EXTERNAL-REVOKE',
      address: '合成旧账号完整地址',
      landlordPhone: '19900002222',
      videoUrl: 'https://api.example.test/media/before-external-revoke'
    },
    logs: [{ id: 'OLD-PRIVATE-LOG' }],
    currentUserId: 'U-OLD',
    isVerified: true,
    isOwnListing: true,
    sensitiveVisible: true
  })

  assert.strictEqual(typeof page.bindAuthInvalidationListener, 'function', '详情页必须订阅全局鉴权撤销事件')
  page.bindAuthInvalidationListener()
  assert.strictEqual(typeof invalidationListener, 'function')
  authToken = ''
  authSessionKey = 'GUEST-AFTER-EXTERNAL-REVOKE'
  invalidationListener({
    reason: 'unauthorized',
    fromSessionKey: 'SESSION-DETAIL-EXTERNAL-REVOKE',
    toSessionKey: authSessionKey
  })

  assert.strictEqual(page.data.sensitiveVisible, false, '收藏等子组件发现撤销时必须同步关闭已解锁敏感区')
  assert.deepStrictEqual(page.data.logs, [], '全局撤销通知不得等待下一次 onShow 才清足迹')
  assert.strictEqual(page.data.currentUserId, '', '全局撤销通知必须立即清旧账号身份')
  assert.strictEqual(page.data.listing.address, undefined, '全局撤销通知必须立即移除旧账号完整地址')
  assert.strictEqual(page.data.listing.landlordPhone, undefined, '全局撤销通知必须立即移除旧账号房东电话')
  await flushPromises()
  await flushPromises()
  assert.strictEqual(publicReloadCalls, 1, '清除敏感态后必须以当前游客会话重读公共详情')
  assert.strictEqual(page.data.listing.videoUrl, 'https://api.example.test/media/public-after-external-revoke')

  page.onUnload()
  assert.strictEqual(unsubscribed, true, '详情卸载必须取消鉴权撤销订阅，避免跨页面回写')
  apiClient.subscribeAuthInvalidation = originalSubscribe
}

async function run() {
  toasts = []
  modals = []
  hideLoadingCalls = 0
  await testVideoShareSessionBoundary()
  await testShowingSessionBoundary()
  await testShowingConfirmationBoundary()
  await testSessionResetAndUnload()
  await testSaveBusyResetOnReload()
  await testPhoneCompleteUnloadBoundary()
  await testGuestVideoShareAndSave()
  await testShareAuditFailureDoesNotDuplicateDelivery()
  await testShareCancelAndAlbumFallbackAuditBoundary()
  await testSaveAndShareAreMutuallyExclusive()
  await testExpiredMediaDownloadRefreshesOnce()
  await testSilentAuditLogoutClearsSensitiveState()
  await testExternalAuthInvalidationImmediatelyClearsSensitiveState()
  console.log('listing-detail-operation-session-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
