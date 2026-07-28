'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const detailPagePath = require.resolve(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js'))
const detailWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.wxml'), 'utf8')

global.getApp = () => ({ globalData: { authToken: '', authSessionKey: 'guest-media-test' } })
global.wx = {
  hideShareMenu() {},
  getStorageSync() { return '' },
  showToast() {},
  showLoading() {},
  hideLoading() {},
  navigateTo() {},
  navigateBack() {},
  redirectTo() {},
  switchTab() {}
}

function setAtPath(target, key, value) {
  const parts = key.split('.')
  let current = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current[parts[index]] || typeof current[parts[index]] !== 'object') current[parts[index]] = {}
    current = current[parts[index]]
  }
  current[parts[parts.length - 1]] = value
}

function makePage(definition) {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  return page
}

function loadDefinition(listing) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: {
      getListingDetail() { return Promise.resolve(typeof listing === 'function' ? listing() : listing) },
      getListingLogs() { return Promise.resolve([]) },
      getProfileState() { return Promise.resolve({ user: {} }) }
    }
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[detailPagePath]
  require(detailPagePath)
  return definition
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function run() {
  let currentMediaAssets = [
    {
      assetId: 'asset-a',
      kind: 'video',
      displayOrder: 0,
      videoUrl: 'https://api.example.test/media/a',
      coverUrl: 'https://api.example.test/media/a-cover'
    },
    {
      assetId: 'asset-b',
      kind: 'video',
      displayOrder: 1,
      videoUrl: 'https://api.example.test/media/b',
      coverUrl: 'https://api.example.test/media/b-cover'
    }
  ]
  const currentListing = () => ({
    id: 'L-MULTI',
    title: '多素材测试房源',
    companyListing: true,
    mediaAssets: currentMediaAssets,
    nearby: { listings: [], total: 0, hasMore: false }
  })
  const definition = loadDefinition(currentListing)
  const page = makePage(definition)
  page.loadListing('L-MULTI')
  await settle()
  await settle()
  assert.strictEqual(page.data.listing.videoUrl, currentMediaAssets[0].videoUrl, '加载后必须选择第一个视频作为当前视频')
  assert.strictEqual(page.data.selectedMediaAssetId, 'asset-a')
  assert.strictEqual(page.data.canShareVideo, true, '多素材房源即使没有旧顶层 videoUrl 也必须可转发当前视频')
  assert.strictEqual(typeof page.selectMediaAsset, 'function', '详情页必须提供视频切换行为')

  page.selectMediaAsset({
    currentTarget: { dataset: { assetId: 'asset-b' } }
  })
  assert.strictEqual(page.data.selectedMediaAssetId, 'asset-b')
  assert.strictEqual(page.data.listing.videoUrl, currentMediaAssets[1].videoUrl, '切换后播放、保存和转发必须绑定选中视频')
  page.selectMediaAsset({
    currentTarget: { dataset: { assetId: 'unknown' } }
  })
  assert.strictEqual(page.data.selectedMediaAssetId, 'asset-b', '未知素材 ID 不得改变当前视频')

  const oldShareOperation = page.beginDetailOperation('share')
  page.selectMediaAsset({
    currentTarget: { dataset: { assetId: 'asset-a' } }
  })
  assert.strictEqual(page.isDetailOperationCurrent(oldShareOperation), false, '切换视频必须立即作废旧视频的异步分享/保存操作')
  page.selectMediaAsset({
    currentTarget: { dataset: { assetId: 'asset-b' } }
  })

  page.setData({ showingSubmitting: true })
  const showingOperation = page.beginDetailOperation('showing')
  const showingSequence = page._showingOperationSeq
  page.selectMediaAsset({
    currentTarget: { dataset: { assetId: 'asset-a' } }
  })
  assert.strictEqual(page._showingOperationSeq, showingSequence, '切换视频不得作废与视频无关的在途带看提交')
  assert.strictEqual(page.isDetailOperationCurrent(showingOperation), true, '切换视频后带看提交仍必须能完成自己的 finally 清理')
  if (page.isDetailOperationCurrent(showingOperation)) page.setData({ showingSubmitting: false })
  assert.strictEqual(page.data.showingSubmitting, false, '带看提交完成后按钮不得永久卡在提交中')
  page.selectMediaAsset({
    currentTarget: { dataset: { assetId: 'asset-b' } }
  })

  const applyAutomaticFallback = () => {
    page.setData({
      listing: {
        ...page.data.listing,
        mediaAssets: currentMediaAssets,
        videoUrl: currentMediaAssets[0].videoUrl,
        coverUrl: currentMediaAssets[0].coverUrl
      },
      selectedMediaAssetId: 'asset-a'
    })
  }
  let staleShareCalls = 0
  page.downloadShareVideo = async () => {
    applyAutomaticFallback()
    return '/tmp/fallback-a.mp4'
  }
  page.shareVideoMessage = async () => { staleShareCalls += 1 }
  await page.prepareVideoShare()
  assert.strictEqual(staleShareCalls, 0, '原视频失效并回退其他素材后不得误转发回退视频')
  assert.strictEqual(page.data.shareVideoBusy, false, '原视频失效并回退其他素材后必须清理转发 busy')

  page.selectMediaAsset({
    currentTarget: { dataset: { assetId: 'asset-b' } }
  })
  let staleSaveCalls = 0
  page.downloadShareVideo = async () => {
    applyAutomaticFallback()
    return '/tmp/fallback-a.mp4'
  }
  page.saveVideoForManualShare = async () => { staleSaveCalls += 1 }
  await page.saveListingVideo()
  assert.strictEqual(staleSaveCalls, 0, '原视频失效并回退其他素材后不得误保存回退视频')
  assert.strictEqual(page.data.saveVideoBusy, false, '原视频失效并回退其他素材后必须清理保存 busy')
  page.selectMediaAsset({
    currentTarget: { dataset: { assetId: 'asset-b' } }
  })

  currentMediaAssets = currentMediaAssets.map((asset) => ({
    ...asset,
    videoUrl: `${asset.videoUrl}-refreshed`,
    coverUrl: `${asset.coverUrl}-refreshed`
  }))
  await page.refreshListingMedia()
  assert.strictEqual(page.data.selectedMediaAssetId, 'asset-b', '能力地址刷新后必须保持当前选中的素材')
  assert.strictEqual(page.data.listing.videoUrl, currentMediaAssets[1].videoUrl, '刷新后必须使用同一 assetId 的新能力地址')

  currentMediaAssets = [currentMediaAssets[0]]
  await page.refreshListingMedia()
  assert.strictEqual(page.data.selectedMediaAssetId, 'asset-a', '选中素材被移除后刷新必须安全回退第一项')
  assert.strictEqual(page.data.listing.videoUrl, currentMediaAssets[0].videoUrl)

  const playbackToasts = []
  const originalShowToast = global.wx.showToast
  global.wx.showToast = (options) => playbackToasts.push(options)
  page._pageActive = true
  page._videoPlaybackRefreshCount = 1
  page._videoPlaybackFailureNotified = false
  page.onVideoPlaybackError()
  page.onVideoPlaybackError()
  global.wx.showToast = originalShowToast
  assert.deepStrictEqual(
    playbackToasts,
    [{ title: '视频加载失败，请重试', icon: 'none' }],
    '视频地址自动刷新一次后仍播放失败时必须明确提示，且连续 error 只能提示一次'
  )

  assert.ok(/wx:for="\{\{listing\.mediaAssets\}\}"/.test(detailWxml), 'WXML 必须渲染服务端返回的全部素材选项')
  assert.ok(/data-asset-id="\{\{item\.assetId\}\}"/.test(detailWxml), '切换事件必须使用不透明 assetId')
  assert.strictEqual((detailWxml.match(/<video\b/g) || []).length, 1, '详情页必须只保留一个视频播放器')
  assert.ok(/<image\b[^>]*class="listing-media-image"/.test(detailWxml), '详情页必须提供一个受控图片展示位')
  assert.ok(/bindtap="previewCurrentImage"/.test(detailWxml), '房源图片必须支持微信原生大图预览')
  assert.ok(/wx:if="\{\{canShareVideo\}\}"/.test(detailWxml), '原视频转发与保存区域只允许在当前选中视频时出现')

  let mixedAssets = [
    {
      assetId: 'asset-photo',
      kind: 'image',
      displayOrder: 9,
      label: '照片 1',
      imageUrl: 'https://api.example.test/media/photo',
      coverUrl: 'https://api.example.test/media/photo'
    },
    {
      assetId: 'asset-video',
      kind: 'video',
      displayOrder: 0,
      label: '视频 1',
      videoUrl: 'https://api.example.test/media/video',
      coverUrl: 'https://api.example.test/media/video-cover'
    }
  ]
  let mixedReadCount = 0
  const mixedListing = () => ({
    id: 'L-MIXED',
    title: '图片视频混合房源',
    companyListing: true,
    videoUrl: mixedAssets[1].videoUrl,
    coverUrl: mixedAssets[0].coverUrl,
    mediaAssets: mixedAssets,
    nearby: { listings: [], total: 0, hasMore: false }
  })
  const mixedDefinition = loadDefinition(() => {
    mixedReadCount += 1
    return mixedListing()
  })
  const mixedPage = makePage(mixedDefinition)
  mixedPage._pageActive = true
  mixedPage.loadListing('L-MIXED')
  await settle()
  await settle()
  assert.strictEqual(mixedReadCount, 1)
  assert.strictEqual(mixedPage.data.selectedMediaAssetId, 'asset-photo', '必须保持服务端数组顺序，不得按 displayOrder 在前端重排')
  assert.strictEqual(mixedPage.data.selectedMediaKind, 'image')
  assert.strictEqual(mixedPage.data.listing.imageUrl, mixedAssets[0].imageUrl)
  assert.strictEqual(mixedPage.data.listing.videoUrl, '', '选中照片时不得把图片能力塞进 videoUrl')
  assert.strictEqual(mixedPage.data.canShareVideo, false, '选中照片时原视频转发/保存门必须关闭')

  let previewOptions = null
  global.wx.previewImage = (options) => { previewOptions = options }
  mixedPage.previewCurrentImage()
  assert.deepStrictEqual(
    previewOptions,
    { current: mixedAssets[0].imageUrl, urls: [mixedAssets[0].imageUrl] },
    '图片预览只允许使用当前公开 DTO 中的受控图片能力地址'
  )

  mixedPage.selectMediaAsset({ currentTarget: { dataset: { assetId: 'asset-video' } } })
  assert.strictEqual(mixedPage.data.selectedMediaKind, 'video')
  assert.strictEqual(mixedPage.data.listing.videoUrl, mixedAssets[1].videoUrl)
  assert.strictEqual(mixedPage.data.listing.imageUrl, '')
  assert.strictEqual(mixedPage.data.canShareVideo, true, '切换到视频后原视频转发/保存能力必须恢复')
  previewOptions = null
  mixedPage.previewCurrentImage()
  assert.strictEqual(previewOptions, null, '选中视频时不得误打开图片预览')

  mixedPage.selectMediaAsset({ currentTarget: { dataset: { assetId: 'asset-photo' } } })
  mixedPage.setData({ showingSubmitting: true })
  const mixedShowingOperation = mixedPage.beginDetailOperation('showing')
  mixedPage.selectMediaAsset({ currentTarget: { dataset: { assetId: 'asset-video' } } })
  mixedPage.selectMediaAsset({ currentTarget: { dataset: { assetId: 'asset-photo' } } })
  assert.strictEqual(mixedPage.isDetailOperationCurrent(mixedShowingOperation), true, '图片/视频切换不得作废在途带看')
  mixedPage.setData({ showingSubmitting: false })

  let imageDownloadCalls = 0
  mixedPage.downloadShareVideo = async () => {
    imageDownloadCalls += 1
    return '/tmp/must-not-download.mp4'
  }
  await mixedPage.prepareVideoShare()
  await mixedPage.saveListingVideo()
  assert.strictEqual(imageDownloadCalls, 0, '选中图片时不得误走视频下载、转发或保存链路')

  const imageToasts = []
  global.wx.showToast = (options) => imageToasts.push(options)
  mixedAssets = mixedAssets.map((asset) => (
    asset.kind === 'image'
      ? {
          ...asset,
          imageUrl: `${asset.imageUrl}-refreshed`,
          coverUrl: `${asset.coverUrl}-refreshed`
        }
      : asset
  ))
  mixedPage.onImageLoadError()
  await settle()
  await settle()
  assert.strictEqual(mixedReadCount, 2, '图片能力地址失败后必须重读一次公开详情')
  assert.strictEqual(mixedPage.data.selectedMediaAssetId, 'asset-photo', '图片能力刷新后必须保持同一素材')
  assert.strictEqual(mixedPage.data.listing.imageUrl, mixedAssets[0].imageUrl, '刷新后必须使用同一图片素材的新能力地址')

  mixedPage.onImageLoadError()
  mixedPage.onImageLoadError()
  await settle()
  assert.strictEqual(mixedReadCount, 2, '同一轮图片加载失败最多自动刷新一次')
  assert.deepStrictEqual(
    imageToasts.filter((item) => item && item.title === '图片加载失败，请重试'),
    [{ title: '图片加载失败，请重试', icon: 'none' }],
    '图片刷新后仍失败必须只提示一次'
  )
  global.wx.showToast = originalShowToast

  const emptyDefinition = loadDefinition({
    id: 'L-EMPTY-MEDIA',
    title: '无素材房源',
    companyListing: true,
    nearby: { listings: [], total: 0, hasMore: false }
  })
  const emptyPage = makePage(emptyDefinition)
  emptyPage.loadListing('L-EMPTY-MEDIA')
  await settle()
  await settle()
  assert.deepStrictEqual(emptyPage.data.listing.mediaAssets, [])
  assert.strictEqual(emptyPage.data.selectedMediaKind, '')
  assert.strictEqual(emptyPage.data.canShareVideo, false, '无素材房源必须保持旧空态')
  assert.ok(/暂无房源视频/.test(detailWxml), '无素材房源旧空态文案必须保留')

  console.log('listing-detail-multi-media-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
