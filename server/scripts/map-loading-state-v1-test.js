const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const mapPagePath = require.resolve(path.join(repoRoot, 'pages', 'map', 'map.js'))
const mapWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'map', 'map.wxml'), 'utf8')

let storageShouldThrow = false
let toasts = []

global.wx = {
  getStorageSync() {
    if (storageShouldThrow) throw new Error('模拟存储读取失败')
    return ''
  },
  removeStorageSync() {},
  showToast(options) { toasts.push(options) },
  createMapContext() { return {} },
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

function loadDefinition(apiStub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[mapPagePath]
  require(mapPagePath)
  assert.ok(definition, '未捕获地图页面定义')
  return definition
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

function mapCommunity(id = '可信小区') {
  return {
    id,
    community: id,
    latitude: 30.31,
    longitude: 120.17,
    coordinateLevel: 'verified',
    coordinateVerified: true,
    listingCount: 1,
    activeListingIds: [`${id}-L1`],
    listings: [{ id: `${id}-L1`, rent: 2800 }]
  }
}

async function run() {
  let requestShouldFail = true
  let requestCount = 0
  const apiStub = {
    getMapCommunities() {
      requestCount += 1
      return requestShouldFail
        ? Promise.reject(Object.assign(new Error('地图服务暂不可用'), { statusCode: 503 }))
        : Promise.resolve([mapCommunity('恢复小区')])
    }
  }
  const definition = loadDefinition(apiStub)
  const page = makePage(definition)
  const trusted = mapCommunity('上次可信小区')
  page.applyCommunities([trusted], true)
  const previousCommunities = JSON.parse(JSON.stringify(page.data.communities))
  const previousMarkers = JSON.parse(JSON.stringify(page.data.markers))
  const previousSummary = page.data.summaryText

  page.loadCommunities({ recenter: false })
  await flushPromises()
  assert.strictEqual(page.data.loadFailed, true, '地图网络/5xx 必须进入持续失败态')
  assert.strictEqual(page.data.loading, false, '地图失败后必须结束加载态')
  assert.deepStrictEqual(page.data.communities, previousCommunities, '地图刷新失败不得清空上次可信小区')
  assert.deepStrictEqual(page.data.markers, previousMarkers, '地图刷新失败不得清空上次可信点位')
  assert.strictEqual(page.data.summaryText, previousSummary, '地图刷新失败不得把可信统计改写成零房源')
  assert.ok(toasts.some((item) => /加载失败/.test(item.title)), '地图失败必须给出即时提示')
  assert.strictEqual(typeof page.retryMap, 'function', '地图失败态必须提供重试方法')

  requestShouldFail = false
  page.retryMap()
  await flushPromises()
  assert.strictEqual(requestCount, 2, '地图重试必须重新请求服务端')
  assert.strictEqual(page.data.loadFailed, false, '地图重试成功必须清除失败态')
  assert.strictEqual(page.data.communities[0].community, '恢复小区', '地图重试成功必须采用最新服务端结果')

  const initialFailureDefinition = loadDefinition({
    getMapCommunities() { return Promise.reject(new Error('初次加载失败')) }
  })
  const initialFailurePage = makePage(initialFailureDefinition)
  initialFailurePage.loadCommunities({ recenter: false })
  await flushPromises()
  assert.strictEqual(initialFailurePage.data.loadFailed, true, '地图初次失败必须显示失败态')
  assert.strictEqual(initialFailurePage.data.communities.length, 0, '地图初次失败可以保持无点位')
  assert.ok(!/暂无可上图/.test(initialFailurePage.data.summaryText), '地图初次失败不得把故障描述成零房源')

  let rejectStaleRequest = null
  let raceRequestCount = 0
  const raceDefinition = loadDefinition({
    getMapCommunities() {
      raceRequestCount += 1
      if (raceRequestCount === 1) {
        return new Promise((resolve, reject) => {
          rejectStaleRequest = reject
        })
      }
      return Promise.resolve([mapCommunity('最新筛选小区')])
    }
  })
  const racePage = makePage(raceDefinition)
  racePage.loadCommunities({ recenter: false })
  racePage.loadCommunities({ recenter: false })
  await flushPromises()
  rejectStaleRequest(new Error('过期请求失败'))
  await flushPromises()
  assert.strictEqual(racePage.data.loadFailed, false, '过期请求失败不得覆盖最新成功状态')
  assert.strictEqual(racePage.data.communities[0].community, '最新筛选小区', '竞态下必须保留最新请求结果')

  storageShouldThrow = true
  const storageDefinition = loadDefinition({
    getMapCommunities() { return Promise.resolve([]) }
  })
  const storagePage = makePage(storageDefinition)
  assert.doesNotThrow(() => storagePage.onShow(), '待处理筛选存储异常不得中断地图页面展示')
  storageShouldThrow = false
  await flushPromises()

  assert.ok(/wx:if="\{\{loadFailed\}\}"/.test(mapWxml), '地图模板必须持续显示加载失败状态')
  assert.ok(/bindtap="retryMap"/.test(mapWxml), '地图模板必须绑定重试入口')
  assert.ok(/!loading && !loadFailed && !communities\.length/.test(mapWxml), '地图故障时不得显示零房源空态')

  console.log('map-loading-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
