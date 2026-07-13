const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))

const scenarios = [
  {
    name: '报备',
    pagePath: require.resolve(path.join(repoRoot, 'pages', 'client-reports', 'client-reports.js')),
    wxmlPath: path.join(repoRoot, 'pages', 'client-reports', 'client-reports.wxml'),
    apiMethod: 'getClientReports',
    refreshMethod: 'refresh',
    dataKey: 'reports'
  },
  {
    name: '签单',
    pagePath: require.resolve(path.join(repoRoot, 'pages', 'deal-records', 'deal-records.js')),
    wxmlPath: path.join(repoRoot, 'pages', 'deal-records', 'deal-records.wxml'),
    apiMethod: 'getDealRecords',
    refreshMethod: 'refresh',
    dataKey: 'deals'
  },
  {
    name: '分佣',
    pagePath: require.resolve(path.join(repoRoot, 'pages', 'commissions', 'commissions.js')),
    wxmlPath: path.join(repoRoot, 'pages', 'commissions', 'commissions.wxml'),
    apiMethod: 'getCommissionRecords',
    refreshMethod: 'refresh',
    dataKey: 'records'
  },
  {
    name: '足迹',
    pagePath: require.resolve(path.join(repoRoot, 'pages', 'footprint', 'footprint.js')),
    wxmlPath: path.join(repoRoot, 'pages', 'footprint', 'footprint.wxml'),
    apiMethod: 'getFootprintRecords',
    refreshMethod: 'refreshRecords',
    dataKey: 'records'
  }
]

let toasts = []
let authToken = 'TOKEN-RECORD-BASE'
let authSessionKey = 'auth-record-base'

global.getApp = () => ({ globalData: { authToken, authSessionKey } })

global.wx = {
  showToast(options) { toasts.push(options) },
  navigateTo() {},
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

function loadDefinition(pagePath, apiStub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[pagePath]
  require(pagePath)
  assert.ok(definition, `未捕获页面定义：${pagePath}`)
  return definition
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
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

async function testScenario(scenario) {
  let shouldFail = true
  const apiStub = {
    [scenario.apiMethod]() {
      return shouldFail
        ? Promise.reject(new Error(`${scenario.name}服务失败`))
        : Promise.resolve([])
    }
  }
  const definition = loadDefinition(scenario.pagePath, apiStub)
  const page = makePage(definition)
  page.setData({ [scenario.dataKey]: [{ id: `${scenario.name}-OLD`, status: '电话查看', direction: '我查看的', meta: '' }] })
  if (scenario.name === '足迹') {
    page.setData({ allRecords: page.data.records.slice() })
  }

  page[scenario.refreshMethod]()
  assert.strictEqual(page.data.loading, true, `${scenario.name}完整请求周期必须进入加载态`)
  await flushPromises()
  assert.strictEqual(page.data.loading, false, `${scenario.name}失败后必须结束加载态`)
  assert.strictEqual(page.data.loadFailed, true, `${scenario.name}失败必须进入持续故障态`)
  assert.deepStrictEqual(page.data[scenario.dataKey].map((item) => item.id), [`${scenario.name}-OLD`], `${scenario.name}刷新失败必须保留上次可信记录`)
  assert.strictEqual(typeof page.retryRecords, 'function', `${scenario.name}失败态必须提供重试方法`)

  shouldFail = false
  page.retryRecords()
  await flushPromises()
  assert.strictEqual(page.data.loadFailed, false, `${scenario.name}重试成功必须清除失败态`)
  assert.strictEqual(page.data[scenario.dataKey].length, 0, `${scenario.name}成功空数组才允许显示真实空态`)

  const wxml = fs.readFileSync(scenario.wxmlPath, 'utf8')
  assert.ok(/bindtap="retryRecords"/.test(wxml), `${scenario.name}模板必须绑定重试入口`)
  const emptyPattern = scenario.dataKey === 'deals'
    ? /!deals\.length && !loading && !loadFailed/
    : (scenario.dataKey === 'reports'
      ? /!reports\.length && !loading && !loadFailed/
      : /!records\.length && !loading && !loadFailed/)
  assert.ok(emptyPattern.test(wxml), `${scenario.name}只有成功空数组才可显示暂无`)
}

async function run() {
  for (const scenario of scenarios) {
    await testScenario(scenario)
  }

  const footprintScenario = scenarios.find((item) => item.name === '足迹')
  let footprintLoads = 0
  let footprintTabBarReads = 0
  const footprintDefinition = loadDefinition(footprintScenario.pagePath, {
    getFootprintRecords() {
      footprintLoads += 1
      return Promise.resolve([])
    }
  })
  const footprintPage = makePage(footprintDefinition)
  footprintPage.getTabBar = () => {
    footprintTabBarReads += 1
    return { setData() {} }
  }
  footprintPage.onShow()
  await flushPromises()
  assert.strictEqual(footprintLoads, 1, '足迹页每次 onShow 只能发起一次刷新')
  assert.strictEqual(footprintTabBarReads, 0, '足迹页不是 tabBar 页面，不得残留 getTabBar 操作')

  let resolveStale = null
  let raceCount = 0
  const commissionScenario = scenarios.find((item) => item.name === '分佣')
  const raceDefinition = loadDefinition(commissionScenario.pagePath, {
    getCommissionRecords() {
      raceCount += 1
      if (raceCount === 1) {
        return new Promise((resolve) => {
          resolveStale = resolve
        })
      }
      return Promise.resolve([{ id: 'COMMISSION-LATEST', role: '我是上传人', status: '已确认' }])
    }
  })
  const racePage = makePage(raceDefinition)
  racePage.refresh()
  racePage.refresh()
  await flushPromises()
  resolveStale([{ id: 'COMMISSION-STALE', role: '我是上传人', status: '已确认' }])
  await flushPromises()
  assert.strictEqual(racePage.data.records[0].id, 'COMMISSION-LATEST', '业务记录过期响应不得覆盖最新刷新结果')

  for (const scenario of scenarios.filter((item) => item.name === '足迹' || item.name === '分佣')) {
    for (const target of [
      { token: '', sessionKey: `guest-${scenario.name}`, label: '退出到游客' },
      { token: `TOKEN-${scenario.name}-B`, sessionKey: `auth-${scenario.name}-b`, label: '切换到账号B' }
    ]) {
      authToken = `TOKEN-${scenario.name}-A`
      authSessionKey = `auth-${scenario.name}-a-${target.label}`
      let mode = 'success'
      const sessionDefinition = loadDefinition(scenario.pagePath, {
        [scenario.apiMethod]() {
          if (mode === 'fail') return Promise.reject(new Error('新会话记录请求失败'))
          return Promise.resolve([{
            id: `${scenario.name}-A-PRIVATE`,
            role: '我是上传人',
            status: '电话查看',
            direction: '我的房源被查看'
          }])
        }
      })
      const sessionPage = makePage(sessionDefinition)
      sessionPage.onShow()
      await flushPromises()
      assert.deepStrictEqual(sessionPage.data[scenario.dataKey].map((item) => item.id), [`${scenario.name}-A-PRIVATE`], `${scenario.name}账号A记录应先成功落地`)

      mode = 'fail'
      authToken = target.token
      authSessionKey = target.sessionKey
      sessionPage.onShow()
      assert.strictEqual(sessionPage.data[scenario.dataKey].length, 0, `${scenario.name}${target.label}时必须在请求返回前清空旧账号记录`)
      assert.strictEqual(sessionPage.data.stats.length, 0, `${scenario.name}${target.label}时必须清空旧账号统计`)
      if (scenario.name === '足迹') {
        assert.strictEqual(sessionPage.data.allRecords.length, 0, '足迹会话变化时必须同步清空未筛选原始记录')
      }
      await flushPromises()
      assert.strictEqual(sessionPage.data[scenario.dataKey].length, 0, `${scenario.name}${target.label}后的失败请求不得恢复账号A记录`)
    }

    authToken = `TOKEN-${scenario.name}-LATE-A`
    authSessionKey = `auth-${scenario.name}-late-a`
    let resolveLateRecord = null
    const lateDefinition = loadDefinition(scenario.pagePath, {
      [scenario.apiMethod]() {
        return new Promise((resolve) => { resolveLateRecord = resolve })
      }
    })
    const latePage = makePage(lateDefinition)
    latePage[scenario.refreshMethod]()
    authToken = ''
    authSessionKey = `guest-${scenario.name}-late`
    resolveLateRecord([{
      id: `${scenario.name}-A-LATE`,
      role: '我是成交人',
      status: '电话查看',
      direction: '我的房源被查看'
    }])
    await flushPromises()
    assert.strictEqual(latePage.data[scenario.dataKey].length, 0, `${scenario.name}会话变化后迟到的账号A响应不得被采纳`)

    authToken = `TOKEN-${scenario.name}-UNLOAD`
    authSessionKey = `auth-${scenario.name}-unload`
    const unloadRequest = deferred()
    const unloadDefinition = loadDefinition(scenario.pagePath, {
      [scenario.apiMethod]() { return unloadRequest.promise }
    })
    const unloadPage = makePage(unloadDefinition)
    const unloadToastCount = toasts.length
    unloadPage[scenario.refreshMethod]()
    assert.strictEqual(typeof unloadPage.onUnload, 'function', `${scenario.name}页卸载时必须作废在途请求`)
    unloadPage.onUnload()
    unloadRequest.resolve([{
      id: `${scenario.name}-UNLOAD-LATE`,
      role: '我是上传人',
      status: '电话查看',
      direction: '我的房源被查看'
    }])
    await flushPromises()
    assert.strictEqual(unloadPage.data[scenario.dataKey].length, 0, `${scenario.name}页卸载后的迟到响应不得回写`)
    assert.strictEqual(toasts.length, unloadToastCount, `${scenario.name}页卸载后的迟到失败不得弹提示`)
  }

  assert.ok(toasts.some((item) => /加载失败/.test(item.title)), '业务记录请求失败必须有即时提示')
  console.log('mini-record-loading-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
