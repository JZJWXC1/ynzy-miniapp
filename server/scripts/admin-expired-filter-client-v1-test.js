'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const repoRoot = path.resolve(__dirname, '..', '..')
const adminHtml = fs.readFileSync(path.join(repoRoot, 'admin-web', 'index.html'), 'utf8')
const mockData = require(path.join(repoRoot, 'utils', 'mock-data'))

function extractFunction(source, name) {
  const asyncMarker = `async function ${name}(`
  const syncMarker = `function ${name}(`
  const asyncStart = source.indexOf(asyncMarker)
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(syncMarker)
  assert.ok(start >= 0, `未找到后台函数：${name}`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`后台函数没有闭合：${name}`)
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function assertLatestResponseWins() {
  const first = deferred()
  const second = deferred()
  const calls = []
  const filter = (value = '') => ({ value })
  const context = {
    expiredDistrictFilter: filter('甲区'),
    expiredBlockFilter: filter(''),
    expiredCommunityFilter: filter(''),
    expiredSourceFilter: filter(''),
    expiredRentMinFilter: filter(''),
    expiredRentMaxFilter: filter(''),
    expiredLayoutFilter: filter(''),
    expiredRentModeFilter: filter(''),
    expiredListingRows: { innerHTML: '' },
    expiredListingEmpty: { hidden: false },
    dataCenter: { getExpiredListings: () => [] },
    buildQuery: (value) => `?district=${value.district}`,
    arrayValue: (value) => Array.isArray(value) ? value : [],
    renderExpiredListRow: (item) => item.id,
    showExpiredListingList: () => {},
    getAdminData(url) {
      calls.push(url)
      return calls.length === 1 ? first.promise : second.promise
    }
  }
  vm.createContext(context)
  vm.runInContext(`
    let expiredListingItems = [];
    let expiredListingRequestSeq = 0;
    ${extractFunction(adminHtml, 'renderExpiredListings')}
    globalThis.readExpiredState = () => ({
      ids: expiredListingItems.map((item) => item.id),
      html: expiredListingRows.innerHTML
    });
  `, context)

  const older = context.renderExpiredListings()
  context.expiredDistrictFilter.value = '乙区'
  const newer = context.renderExpiredListings()
  second.resolve([{ id: 'NEW' }])
  await newer
  first.resolve([{ id: 'OLD' }])
  await older
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.readExpiredState())),
    { ids: ['NEW'], html: 'NEW' },
    '废房源筛选的迟到旧响应不得覆盖最后一次筛选结果'
  )
}

async function assertActiveListingLatestResponseWins() {
  const first = deferred()
  const second = deferred()
  const calls = []
  const filter = (value = '') => ({ value })
  const context = {
    areaFilter: filter('甲区'),
    blockFilter: filter('甲板块'),
    communityFilter: filter(''),
    sourceFilter: filter(''),
    statusFilter: filter(''),
    missingVideoFilter: filter(''),
    listingRows: { innerHTML: '' },
    listingEmpty: { hidden: false },
    dataCenter: { getAdminListings: () => [] },
    buildQuery: (value) => `?district=${value.district}&block=${value.block}`,
    arrayValue: (value) => Array.isArray(value) ? value : [],
    safeText: (value) => String(value || ''),
    safeAttr: (value) => String(value || ''),
    pillClass: () => 'pill',
    superOnlyActions: (value) => value,
    getAdminData(url) {
      calls.push(url)
      return calls.length === 1 ? first.promise : second.promise
    }
  }
  vm.createContext(context)
  vm.runInContext(`
    let adminListingItems = [];
    let activeListingRequestSeq = 0;
    ${extractFunction(adminHtml, 'normalizedLocationText')}
    ${extractFunction(adminHtml, 'hasAdminListingVideo')}
    ${extractFunction(adminHtml, 'renderListings')}
    globalThis.readActiveState = () => ({
      ids: adminListingItems.map((item) => item.id),
      html: listingRows.innerHTML
    });
  `, context)

  const older = context.renderListings()
  context.areaFilter.value = '乙区'
  context.blockFilter.value = ''
  const newer = context.renderListings()
  assert.deepStrictEqual(
    calls,
    [
      '/admin/listings?district=甲区&block=甲板块',
      '/admin/listings?district=乙区&block='
    ],
    '切区后的唯一有效请求必须使用 canonical district 且不再携带旧板块'
  )
  second.resolve([{
    id: 'B-CORRECT',
    title: '乙区正确房源',
    district: '乙区',
    area: '乙区',
    block: '',
    community: '乙苑'
  }])
  await newer
  first.resolve([{
    id: 'A-STALE',
    title: '甲区迟到房源',
    district: '甲区',
    area: '甲区',
    block: '甲板块',
    community: '甲苑'
  }])
  await older
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.readActiveState())).ids,
    ['B-CORRECT'],
    '在租房源筛选的迟到旧响应不得覆盖最新区域结果'
  )
}

function assertActiveDistrictChangeIsSingleOrderedRefresh() {
  const calls = []
  const context = {
    refreshActiveBlockOptions() {
      calls.push('refresh-block-options')
    },
    refreshListingViews() {
      calls.push('refresh-listings')
    }
  }
  vm.createContext(context)
  vm.runInContext(extractFunction(adminHtml, 'handleActiveDistrictChange'), context)
  context.handleActiveDistrictChange()
  assert.deepStrictEqual(
    calls,
    ['refresh-block-options', 'refresh-listings'],
    '切换行政区必须先清理/重建板块，再发唯一一次列表请求'
  )

  const eventStart = adminHtml.indexOf("areaFilter.addEventListener('change'")
  const eventEnd = adminHtml.indexOf("document.getElementById('resetListingFilters')", eventStart)
  const eventBlock = adminHtml.slice(eventStart, eventEnd)
  assert.ok(eventStart >= 0 && eventEnd > eventStart, '必须定位在租房源筛选事件绑定')
  assert.ok(
    eventBlock.includes("areaFilter.addEventListener('change', handleActiveDistrictChange)"),
    '行政区必须只走先联动板块、再刷新列表的单一 change 处理器'
  )
  assert.ok(
    !eventBlock.includes('[areaFilter,'),
    '行政区不得再进入通用 input/change 双监听，否则会携带旧板块发出错误请求'
  )
  const metadataLoader = extractFunction(adminHtml, 'loadListingFilterMetadata')
  assert.ok(
    metadataLoader.includes("getAdminData('/admin/listing-filter-options'"),
    '后台必须从管理员鉴权端点读取在租房源筛选元数据'
  )
  assert.ok(
    !metadataLoader.includes("getAdminData('/mini/listing-filter-options'"),
    '后台不得携管理员 token 调用 mini 端点，否则登录后会被 401 清会话'
  )
}

function assertMockConsumesEveryAxis() {
  assert.strictEqual(
    typeof mockData.__expiredListingMatchesFilterForTest,
    'function',
    'Mock 必须暴露只读测试入口验证完整筛选语义'
  )
  const listing = {
    district: '云城区',
    area: '云城区',
    block: '未来板块',
    community: '未来花苑',
    source: '公司房源',
    companyListing: true,
    rent: 3200,
    layout: '2室1厅',
    room: '二室',
    rentMode: '整租',
    type: '整租'
  }
  const exact = {
    district: '云城区',
    block: '未来板块',
    community: '未来花苑',
    sourceType: '公司房源',
    rentMin: 3000,
    rentMax: 3500,
    layout: '两室',
    rentMode: '整租'
  }
  assert.strictEqual(mockData.__expiredListingMatchesFilterForTest(listing, exact), true)
  const mutations = [
    ['district', '其它区'],
    ['block', '其它板块'],
    ['community', '其它小区'],
    ['sourceType', '业主房源'],
    ['rentMin', 3300],
    ['rentMax', 3100],
    ['layout', '三室'],
    ['rentMode', '合租']
  ]
  mutations.forEach(([key, value]) => {
    assert.strictEqual(
      mockData.__expiredListingMatchesFilterForTest(listing, Object.assign({}, exact, { [key]: value })),
      false,
      `Mock 废房源筛选必须真实消费 ${key}`
    )
  })
}

function assertMediaManifestCountsAsVideo() {
  const context = {}
  vm.createContext(context)
  vm.runInContext(extractFunction(adminHtml, 'hasAdminListingVideo'), context)
  assert.strictEqual(
    context.hasAdminListingVideo({
      videoUrl: '',
      videoKey: '',
      hasVideo: false,
      mediaAssets: [{ assetId: 'MAT-synthetic', kind: 'video' }]
    }),
    true,
    '房源笔记同步只保留 mediaAssets 时，后台仍必须识别为有视频'
  )
  assert.strictEqual(
    context.hasAdminListingVideo({ mediaAssets: [] }),
    false,
    '空素材清单不得误报有视频'
  )
}

Promise.resolve()
  .then(assertMockConsumesEveryAxis)
  .then(assertMediaManifestCountsAsVideo)
  .then(assertActiveDistrictChangeIsSingleOrderedRefresh)
  .then(assertActiveListingLatestResponseWins)
  .then(assertLatestResponseWins)
  .then(() => console.log('admin-expired-filter-client-v1-test: PASS'))
  .catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
