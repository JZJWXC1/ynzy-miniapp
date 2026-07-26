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

  console.log('listing-detail-multi-media-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
