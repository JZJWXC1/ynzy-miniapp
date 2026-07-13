'use strict'

// 小程序 utils/api-client.js 的 401 跳转策略锁定测试（Codex 返修要求固化）。
// 用 mock wx / getApp / getCurrentPages 加载 api-client，直接调用导出的 handleUnauthorized，
// 固化三条不变量：
//   1) 游客（无 token）遇 401 不撤销不存在的登录态、不轮换稳定游客会话，也不跳登录页；
//   2) 已登录（有 token）遇 401 清 token 并跳登录页一次；
//   3) token 清空后的连续 401 不再重复跳转（不形成循环）。
// 另加：非 401（403）不跳转。这样任何人把 handleUnauthorized 改回“401 立即跳登录”都会被测到。

const assert = require('assert')

// 构造一套 wx/getApp/getCurrentPages 环境，返回可观察的 nav / storage / globalData。
function setupEnv({ globalToken, storageToken } = {}) {
  const nav = []
  const storage = {}
  let logoutCount = 0
  let refreshCount = 0
  if (storageToken) storage['ynzy_auth_token'] = storageToken
  const globalData = {
    authToken: globalToken || '',
    authSessionKey: globalToken ? 'auth-session-1' : 'guest-session-1',
    userId: globalToken ? 'U1' : '',
    user: globalToken ? { id: 'U1' } : null,
    apiConfig: { token: globalToken || '' }
  }
  global.getApp = () => ({
    globalData,
    refreshAuthToken(nextToken, nextExpiresAt, previousToken) {
      if (globalData.authToken !== previousToken) return false
      refreshCount += 1
      globalData.authToken = nextToken
      globalData.authTokenExpiresAt = nextExpiresAt
      if (globalData.apiConfig) globalData.apiConfig.token = nextToken
      storage.ynzy_auth_token = nextToken
      storage.ynzy_auth_token_expires_at = nextExpiresAt
      return true
    },
    logout() {
      logoutCount += 1
      globalData.user = null
      globalData.userId = ''
      globalData.authToken = ''
      globalData.authSessionKey = `guest-session-${logoutCount + 1}`
      if (globalData.apiConfig) globalData.apiConfig.token = ''
      delete storage['ynzy_auth_token']
      delete storage['ynzy_user_id']
    }
  })
  global.getCurrentPages = () => [{ route: 'pages/index/index' }]
  global.wx = {
    navigateTo(opts) {
      nav.push(opts && opts.url)
      if (opts && typeof opts.complete === 'function') opts.complete()
    },
    getStorageSync(k) { return storage[k] || '' },
    setStorageSync(k, v) { storage[k] = v },
    removeStorageSync(k) { delete storage[k] }
  }
  return {
    nav,
    storage,
    globalData,
    get logoutCount() { return logoutCount },
    get refreshCount() { return refreshCount }
  }
}

// 每个用例清 require 缓存重载 api-client，重置其模块级 authRedirecting 状态。
function loadFresh() {
  const p = require.resolve('../../utils/api-client')
  delete require.cache[p]
  return require('../../utils/api-client')
}

async function run() {
  // 1) 游客（无任何 token）遇 401：当前本来就是匿名态，不能调用 logout 轮换 guest session。
  {
    const env = setupEnv({})
    const apiClient = loadFresh()
    const sessionBefore = env.globalData.authSessionKey
    apiClient.handleUnauthorized({ statusCode: 401 })
    assert.strictEqual(env.nav.length, 0, '游客 401 不应跳登录页')
    assert.strictEqual(env.logoutCount, 0, '游客 401 不得调用 logout 撤销不存在的登录态')
    assert.strictEqual(env.globalData.authSessionKey, sessionBefore, '游客 401 不得轮换稳定 guest session，否则公开详情成功响应会被误判为旧请求')
  }

  // 2) 已登录（globalData 有 token）遇 401：清 token 并跳登录一次；再次 401 不重复跳。
  {
    const env = setupEnv({ globalToken: 'T1' })
    const apiClient = loadFresh()
    apiClient.handleUnauthorized({ statusCode: 401 })
    assert.strictEqual(env.nav.length, 1, '过期登录态 401 应跳登录一次')
    assert.strictEqual(env.nav[0], '/pages/auth/auth', '应跳到登录页')
    assert.strictEqual(env.globalData.authToken, '', '应已清 globalData token')
    // 连续第二次 401：token 已清 → hadToken=false → 不再跳（防循环）。
    apiClient.handleUnauthorized({ statusCode: 401 })
    assert.strictEqual(env.nav.length, 1, 'token 清空后连续 401 不应重复跳转')
  }

  // 3) 仅 storage 里残留 token 的过期态：也应视为“有 token”跳一次，清后不再跳。
  {
    const env = setupEnv({ storageToken: 'S1' })
    const apiClient = loadFresh()
    apiClient.handleUnauthorized({ statusCode: 401 })
    assert.strictEqual(env.nav.length, 1, 'storage 残留 token 的 401 应跳登录一次')
    assert.strictEqual(env.storage['ynzy_auth_token'], undefined, '应已清 storage token')
    apiClient.handleUnauthorized({ statusCode: 401 })
    assert.strictEqual(env.nav.length, 1, '清 storage token 后连续 401 不应重复跳转')
  }

  // 4) 非 401（403）：直接返回，不跳转、不清状态。
  {
    const env = setupEnv({ globalToken: 'T1' })
    const apiClient = loadFresh()
    apiClient.handleUnauthorized({ statusCode: 403 })
    assert.strictEqual(env.nav.length, 0, '403 不应触发登录跳转')
    assert.strictEqual(env.globalData.authToken, 'T1', '403 不应清登录态')
  }

  // 5) 空 error / 无 statusCode：安全返回，不跳转。
  {
    const env = setupEnv({ globalToken: 'T1' })
    const apiClient = loadFresh()
    apiClient.handleUnauthorized(null)
    apiClient.handleUnauthorized({})
    assert.strictEqual(env.nav.length, 0, '空 error / 无状态码不应跳转')
  }

  // 6) TOKEN_A 请求发出后切到 TOKEN_B，A 的迟到 401 不能清空/跳转 B。
  {
    const env = setupEnv({ globalToken: 'TOKEN_A', storageToken: 'TOKEN_A' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN_A'
    }
    let pendingRequest
    global.wx.request = (options) => { pendingRequest = options }
    const apiClient = loadFresh()
    const request = apiClient.call({ path: '/mini/listings/ANCHOR/nearby?all=1' })
    assert.strictEqual(pendingRequest.header.Authorization, 'Bearer TOKEN_A', '请求必须快照实际发送的 token')

    env.globalData.authToken = 'TOKEN_B'
    env.globalData.authSessionKey = 'auth-session-B'
    env.globalData.userId = 'U2'
    env.globalData.user = { id: 'U2' }
    env.globalData.apiConfig.token = 'TOKEN_B'
    env.storage['ynzy_auth_token'] = 'TOKEN_B'
    pendingRequest.success({ statusCode: 401, data: { message: 'TOKEN_A 已失效' }, header: {} })
    await assert.rejects(request, (error) => error && error.statusCode === 401)
    assert.strictEqual(env.globalData.authToken, 'TOKEN_B', '旧 A 请求的 401 不得清空当前 B token')
    assert.strictEqual(env.storage['ynzy_auth_token'], 'TOKEN_B', '旧 A 请求的 401 不得清空 B 的本地 token')
    assert.strictEqual(env.nav.length, 0, '旧 A 请求的 401 不得把 B 跳回登录页')
  }

  // 7) 游客请求发出后用户完成登录，游客请求迟到 401 也不能清新登录态。
  {
    const env = setupEnv({})
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: ''
    }
    let pendingRequest
    global.wx.request = (options) => { pendingRequest = options }
    const apiClient = loadFresh()
    const request = apiClient.call({ path: '/mini/listings/ANCHOR/nearby?all=1' })
    assert.ok(!pendingRequest.header.Authorization, '游客请求不应带 Authorization')

    env.globalData.authToken = 'TOKEN_NEW'
    env.globalData.authSessionKey = 'auth-session-new'
    env.globalData.userId = 'U2'
    env.globalData.user = { id: 'U2' }
    env.globalData.apiConfig.token = 'TOKEN_NEW'
    env.storage['ynzy_auth_token'] = 'TOKEN_NEW'
    pendingRequest.success({ statusCode: 401, data: { message: '游客请求被拒绝' }, header: {} })
    await assert.rejects(request, (error) => error && error.statusCode === 401)
    assert.strictEqual(env.globalData.authToken, 'TOKEN_NEW', '游客旧请求 401 不得清除刚登录的新 token')
    assert.strictEqual(env.nav.length, 0)
  }

  // 8) A 请求发出后用户主动退出，迟到 401 不应再次跳转或复活任何会话副作用。
  {
    const env = setupEnv({ globalToken: 'TOKEN_A', storageToken: 'TOKEN_A' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN_A'
    }
    let pendingRequest
    global.wx.request = (options) => { pendingRequest = options }
    const apiClient = loadFresh()
    const request = apiClient.call({ path: '/mini/listings/ANCHOR/nearby?all=1' })
    env.globalData.authToken = ''
    env.globalData.authSessionKey = 'guest-session-after-logout'
    env.globalData.userId = ''
    env.globalData.user = null
    env.globalData.apiConfig.token = ''
    delete env.storage['ynzy_auth_token']
    pendingRequest.success({ statusCode: 401, data: { message: 'TOKEN_A 已失效' }, header: {} })
    await assert.rejects(request, (error) => error && error.statusCode === 401)
    assert.strictEqual(env.globalData.authToken, '')
    assert.strictEqual(env.nav.length, 0, '主动退出后的旧 401 不得再跳登录')
  }

  // 9) 公共视频发送成功后的留痕只是可选审计：旧 token 401 必须清理失效身份，
  // 但绝不能把仍可匿名播放/转发视频的用户强行导航到登录页。
  {
    const env = setupEnv({ globalToken: 'TOKEN-VIDEO-EXPIRED', storageToken: 'TOKEN-VIDEO-EXPIRED' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-VIDEO-EXPIRED'
    }
    let pendingRequest
    global.wx.request = (options) => { pendingRequest = options }
    const apiClient = loadFresh()
    const request = apiClient.call({
      path: '/mini/listings/L-PUBLIC/video-share',
      method: 'POST',
      data: { channel: 'wechat-video' },
      silentAuthFailure: true
    })
    pendingRequest.success({ statusCode: 401, data: { code: 401, message: '登录已过期' }, header: {} })
    await assert.rejects(request, (error) => error && error.statusCode === 401)
    assert.strictEqual(env.globalData.authToken, '', '可选留痕 401 仍必须清除当前失效 token')
    assert.strictEqual(env.storage.ynzy_auth_token, undefined, '可选留痕 401 仍必须清除本地失效 token')
    assert.strictEqual(env.nav.length, 0, '可选视频留痕失败不得破坏免登录转发并跳登录页')
  }

  // 10) 有效 token 的公共读取必须保留 Authorization 与滑动续签，不能为了匿名可读而永久 omitAuth。
  {
    const env = setupEnv({ globalToken: 'TOKEN-PUBLIC-VALID', storageToken: 'TOKEN-PUBLIC-VALID' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-PUBLIC-VALID'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    const apiClient = loadFresh()
    const request = apiClient.call({ path: '/mini/home/listings', publicReadAuthFallback: true })
    assert.strictEqual(pendingRequests[0].header.Authorization, 'Bearer TOKEN-PUBLIC-VALID', '有效 token 的公共读取必须携带 Authorization')
    const nextExpiresAt = Date.now() + 60 * 60 * 1000
    pendingRequests[0].success({
      statusCode: 200,
      data: { code: 0, data: [] },
      header: {
        'X-Auth-Token': 'TOKEN-PUBLIC-REFRESHED',
        'X-Auth-Token-Expires-At': String(nextExpiresAt)
      }
    })
    await request
    assert.strictEqual(pendingRequests.length, 1, '有效 token 成功时不得多发匿名请求')
    assert.strictEqual(env.refreshCount, 1, '公共读取成功响应应照常执行滑动续签')
    assert.strictEqual(env.globalData.authToken, 'TOKEN-PUBLIC-REFRESHED')
    assert.strictEqual(env.globalData.authSessionKey, 'auth-session-1', '滑动续签不得轮换稳定会话键')
  }

  // 11) 公共只读请求优先携带当前 token，以便服务端返回个性化结果；若该 token 失效，必须静默
  // 撤销同一会话并且只重试一次完全匿名请求，不能把仍可公开浏览的页面强制送去登录。
  {
    const env = setupEnv({ globalToken: 'TOKEN-PUBLIC-EXPIRED', storageToken: 'TOKEN-PUBLIC-EXPIRED' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-PUBLIC-EXPIRED'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    const apiClient = loadFresh()
    const invalidations = []
    const unsubscribeInvalidation = apiClient.subscribeAuthInvalidation((event) => invalidations.push(event))
    const outcome = apiClient.call({
      path: '/mini/home/listings',
      publicReadAuthFallback: true
    }).then((value) => ({ value }), (error) => ({ error }))

    assert.strictEqual(pendingRequests[0].header.Authorization, 'Bearer TOKEN-PUBLIC-EXPIRED', '公共读取第一次请求仍须携带有效登录态以保留个性化')
    pendingRequests[0].success({ statusCode: 401, data: { code: 401, message: '登录已过期' }, header: {} })
    await Promise.resolve()
    assert.strictEqual(pendingRequests.length, 2, '公共读取的当前 token 失效后应自动发起一次匿名重试')
    assert.ok(!pendingRequests[1].header.Authorization, '公共读取的降级重试必须完全移除 Authorization')
    assert.strictEqual(env.globalData.authToken, '', '公共读取 401 必须撤销当前失效 token')
    assert.deepStrictEqual(invalidations, [{
      reason: 'unauthorized',
      fromSessionKey: 'auth-session-1',
      toSessionKey: 'guest-session-2'
    }], '当前身份被 401 撤销时必须同步通知页面清除已展示的地址、电话和账号私有状态')
    unsubscribeInvalidation()
    assert.strictEqual(
      apiClient.isPublicReadAuthFallbackContinuation('auth-session-1'),
      true,
      '公共读取从失效登录态降级为游客后，页面必须能识别这一条受限会话接力并接收匿名结果'
    )
    assert.strictEqual(apiClient.isPublicReadAuthFallbackContinuation('auth-session-other'), false, '其他旧会话不得借用公共读取接力')
    assert.strictEqual(env.nav.length, 0, '公共读取 401 不得跳转登录页')
    pendingRequests[1].success({
      statusCode: 200,
      data: { code: 0, data: [{ id: 'PUBLIC-1' }] },
      header: {
        'X-Auth-Token': 'TOKEN-MUST-NOT-BE-MINTED-FROM-ANONYMOUS',
        'X-Auth-Token-Expires-At': String(Date.now() + 60 * 60 * 1000)
      }
    })
    const result = await outcome
    assert.ok(!result.error, '匿名重试成功时原公共读取 Promise 应成功完成')
    assert.deepStrictEqual(result.value, [{ id: 'PUBLIC-1' }])
    assert.strictEqual(pendingRequests.length, 2, '公共读取最多只能执行一次匿名降级重试')
    assert.strictEqual(env.globalData.authToken, '', '匿名响应不得通过滑动续签头凭空签发登录态')
    assert.strictEqual(env.refreshCount, 0, '匿名重试不得执行滑动续签')
    env.globalData.authToken = 'TOKEN-NEW-ACCOUNT'
    env.globalData.authSessionKey = 'auth-session-new-account'
    assert.strictEqual(apiClient.isPublicReadAuthFallbackContinuation('auth-session-1'), false, '游客重新登录后必须立即拒绝旧账号公共结果')
  }

  // 11.1) 同一页面并发的多个公共读取会同时携带旧 token。第一个 401 撤销会话后，其余迟到 401
  // 仍必须凭同一条接力各自匿名重试；不能只有首个请求成功、其余请求被会话差异误杀。
  {
    const env = setupEnv({ globalToken: 'TOKEN-PUBLIC-CONCURRENT', storageToken: 'TOKEN-PUBLIC-CONCURRENT' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-PUBLIC-CONCURRENT'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    const apiClient = loadFresh()
    const first = apiClient.call({ path: '/mini/listings', publicReadAuthFallback: true })
    const second = apiClient.call({ path: '/mini/map/communities', publicReadAuthFallback: true })
    pendingRequests[0].success({ statusCode: 401, data: { message: '旧 token 失效' }, header: {} })
    await Promise.resolve()
    pendingRequests[1].success({ statusCode: 401, data: { message: '同一旧 token 失效' }, header: {} })
    await Promise.resolve()
    assert.strictEqual(pendingRequests.length, 4, '同一失效会话的两个公共读取都应各匿名重试一次')
    ;[pendingRequests[2], pendingRequests[3]].forEach((request) => {
      assert.ok(!request.header.Authorization, '并发公共读取的降级重试均不得携带 Authorization')
    })
    pendingRequests[2].success({ statusCode: 200, data: { code: 0, data: [{ id: 'PUBLIC-LIST' }] }, header: {} })
    pendingRequests[3].success({ statusCode: 200, data: { code: 0, data: [{ id: 'PUBLIC-MAP' }] }, header: {} })
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.deepStrictEqual(firstResult, [{ id: 'PUBLIC-LIST' }])
    assert.deepStrictEqual(secondResult, [{ id: 'PUBLIC-MAP' }])
  }

  // 12) 匿名重试自己仍被 401 时必须原样失败且禁止循环，也不得跳登录。
  {
    const env = setupEnv({ globalToken: 'TOKEN-PUBLIC-LOOP', storageToken: 'TOKEN-PUBLIC-LOOP' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-PUBLIC-LOOP'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    const apiClient = loadFresh()
    const outcome = apiClient.call({
      path: '/mini/listings',
      publicReadAuthFallback: true
    }).then((value) => ({ value }), (error) => ({ error }))

    pendingRequests[0].success({ statusCode: 401, data: { message: '旧 token 失效' }, header: {} })
    await Promise.resolve()
    assert.strictEqual(pendingRequests.length, 2)
    pendingRequests[1].success({ statusCode: 401, data: { message: '匿名请求也被拒绝' }, header: {} })
    const result = await outcome
    assert.ok(result.error && result.error.statusCode === 401, '匿名重试仍 401 时应向调用方返回失败')
    assert.strictEqual(pendingRequests.length, 2, '匿名 401 不得触发第三次请求')
    assert.strictEqual(env.nav.length, 0, '公共读取匿名降级失败也不得强制跳登录')
  }

  // 13) Mock 预览也必须遵守同一公共读取边界：伪/过期 token 被撤销后，以游客身份重跑一次。
  {
    const env = setupEnv({ globalToken: 'TOKEN-MOCK-EXPIRED', storageToken: 'TOKEN-MOCK-EXPIRED' })
    env.globalData.apiConfig = {
      env: 'mock',
      baseUrl: 'http://127.0.0.1:8787',
      timeout: 15000,
      token: 'TOKEN-MOCK-EXPIRED'
    }
    let mockCalls = 0
    const apiClient = loadFresh()
    const result = await apiClient.call({
      path: '/mini/home/listings',
      publicReadAuthFallback: true,
      mock() {
        mockCalls += 1
        if (mockCalls === 1) {
          const error = new Error('Mock token 已失效')
          error.statusCode = 401
          throw error
        }
        return [{ id: 'MOCK-PUBLIC-1' }]
      }
    })
    assert.deepStrictEqual(result, [{ id: 'MOCK-PUBLIC-1' }])
    assert.strictEqual(mockCalls, 2, 'Mock 公共读取也只能匿名降级一次')
    assert.strictEqual(env.globalData.authToken, '')
    assert.strictEqual(env.nav.length, 0)
  }

  // 14) 房源匹配/助手虽然属于公开内容，但 POST 可能生成 LLM/trace，401 时只能静默清理登录态，
  // 不能自动重放；用户再次主动提交时自然会以匿名请求发出。
  {
    const env = setupEnv({ globalToken: 'TOKEN-PUBLIC-MATCH', storageToken: 'TOKEN-PUBLIC-MATCH' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-PUBLIC-MATCH'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    const apiClient = loadFresh()
    const outcome = apiClient.call({
      path: '/mini/listings/match',
      method: 'POST',
      data: { community: '测试小区' },
      publicReadAuthFallback: true
    }).then((value) => ({ value }), (error) => ({ error }))
    pendingRequests[0].success({
      statusCode: 401,
      data: { message: '登录已过期', data: { authFailurePhase: 'pre_execution' } },
      header: {}
    })
    const result = await outcome
    assert.ok(result.error && result.error.statusCode === 401, '公共 POST 不得在调用方不知情时重复执行')
    assert.strictEqual(pendingRequests.length, 1, '公共 POST 的 401 不得自动重放')
    assert.strictEqual(env.globalData.authToken, '', '公共 POST 仍应静默清除当前失效 token')
    assert.strictEqual(env.nav.length, 0, '公共 POST 401 不得强制跳登录')
  }

  // 13.1) Mock 受保护接口必须和生产一致处理 401：撤销伪登录态并提示登录，但绝不匿名重放。
  {
    const env = setupEnv({ globalToken: 'TOKEN-MOCK-PROTECTED-EXPIRED', storageToken: 'TOKEN-MOCK-PROTECTED-EXPIRED' })
    env.globalData.apiConfig = {
      env: 'mock',
      baseUrl: 'http://127.0.0.1:8787',
      timeout: 15000,
      token: 'TOKEN-MOCK-PROTECTED-EXPIRED'
    }
    let mockCalls = 0
    const apiClient = loadFresh()
    const error = await apiClient.call({
      path: '/mini/listings/L-PROTECTED/sensitive-view',
      method: 'POST',
      mock() {
        mockCalls += 1
        const authError = new Error('Mock 登录已撤销')
        authError.statusCode = 401
        throw authError
      }
    }).then(() => null, (caught) => caught)
    assert.ok(error && error.statusCode === 401)
    assert.strictEqual(mockCalls, 1, 'Mock 受保护写接口 401 不得重放')
    assert.strictEqual(env.globalData.authToken, '', 'Mock 受保护接口也必须清除失效 token')
    assert.strictEqual(env.nav.length, 1, 'Mock 受保护接口应保持登录引导')
  }

  // 13.2) Mock uploadFile 也必须走同一 401 撤销门。ASR 等上传型接口不能出现
  // “Mock 回调已拒绝伪 token，但客户端仍保留伪登录态”的预览/生产分叉。
  {
    const env = setupEnv({ globalToken: 'TOKEN-MOCK-UPLOAD-INVALID', storageToken: 'TOKEN-MOCK-UPLOAD-INVALID' })
    env.globalData.apiConfig = {
      env: 'mock',
      baseUrl: '',
      timeout: 15000,
      token: 'TOKEN-MOCK-UPLOAD-INVALID'
    }
    const apiClient = loadFresh()
    await assert.rejects(
      apiClient.uploadFile({
        url: '/mini/asr/transcribe',
        header: { Authorization: 'Bearer TOKEN-MOCK-UPLOAD-INVALID' },
        mock() {
          const error = new Error('伪 token')
          error.statusCode = 401
          error.data = { authFailurePhase: 'pre_execution' }
          throw error
        }
      }),
      (error) => error && error.statusCode === 401
    )
    assert.strictEqual(env.globalData.authToken, '', 'Mock 上传 401 必须撤销当前失效 token')
    assert.strictEqual(env.storage.ynzy_auth_token, undefined, 'Mock 上传 401 必须清除本地失效 token')
    assert.strictEqual(env.nav.length, 1, 'Mock 上传 401 应与生产上传一致进入登录恢复流程')
  }

  // 15) 仅服务端确认“鉴权先于业务、401 尚未产生副作用”的纯计算 POST，才可同时打开第二个
  // 显式开关执行一次匿名重试；这给 /mini/llm/match 等调用方提供安全而可审计的能力。
  {
    const env = setupEnv({ globalToken: 'TOKEN-PURE-COMPUTE', storageToken: 'TOKEN-PURE-COMPUTE' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-PURE-COMPUTE'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    const apiClient = loadFresh()
    const invalidations = []
    apiClient.subscribeAuthInvalidation((event) => invalidations.push(event))
    const { anonymousPublicRequestData } = require('../../utils/public-request-safety')
    const outcome = apiClient.call({
      path: '/mini/llm/match',
      method: 'POST',
      data: {
        stage: 'match',
        threadId: 'THREAD-ACCOUNT-A',
        needId: 'NEED-ACCOUNT-A',
        form: { community: '测试小区', viewerId: 'U-ACCOUNT-A' }
      },
      publicReadAuthFallback: true,
      retryAnonymousOnAuthFailure: true,
      buildAnonymousRetryData: anonymousPublicRequestData,
      authFallbackRequestId: 'MATCH-PROMISE-1'
    }).then((value) => ({ value }), (error) => ({ error }))
    pendingRequests[0].success({
      statusCode: 401,
      data: { message: '登录已过期', data: { authFailurePhase: 'pre_execution' } },
      header: {}
    })
    await Promise.resolve()
    assert.strictEqual(pendingRequests.length, 2, '双显式开关的纯计算 POST 应允许一次匿名重试')
    assert.ok(!pendingRequests[1].header.Authorization)
    assert.deepStrictEqual(pendingRequests[1].data, {
      stage: 'match',
      form: { community: '测试小区' }
    }, '匿名重试必须剥离旧账号 thread/need/身份上下文，只保留公开找房条件')
    assert.deepStrictEqual(invalidations, [{
      reason: 'unauthorized',
      fromSessionKey: 'auth-session-1',
      toSessionKey: 'guest-session-2',
      publicFallbackRequestId: 'MATCH-PROMISE-1'
    }], '公开 POST 撤销事件必须带这一个 Promise 的请求标识，页面不得借用其他请求建立的会话桥')
    pendingRequests[1].success({ statusCode: 200, data: { code: 0, data: { listings: [] } }, header: {} })
    const result = await outcome
    assert.ok(!result.error)
    assert.strictEqual(pendingRequests.length, 2)
    assert.strictEqual(env.nav.length, 0)
  }

  // 15.1) 即使调用方开了两个开关，只要服务端没有证明 401 发生在业务执行前，就绝不能重放
  // 公共 POST；这锁住“LLM 已计费/trace 已写后会话被撤销”的 exactly-once 边界。
  {
    const env = setupEnv({ globalToken: 'TOKEN-POST-AFTER-EXECUTION', storageToken: 'TOKEN-POST-AFTER-EXECUTION' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-POST-AFTER-EXECUTION'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    const apiClient = loadFresh()
    const outcome = apiClient.call({
      path: '/mini/assistant/chat',
      method: 'POST',
      data: { text: '测试中途撤销' },
      publicReadAuthFallback: true,
      retryAnonymousOnAuthFailure: true
    }).then((value) => ({ value }), (error) => ({ error }))
    pendingRequests[0].success({ statusCode: 401, data: { message: '执行后会话已撤销' }, header: {} })
    const result = await outcome
    assert.ok(result.error && result.error.statusCode === 401)
    assert.strictEqual(pendingRequests.length, 1, '未标记为执行前的 401 不得匿名重放公共 POST')
    assert.strictEqual(env.globalData.authToken, '', '执行后 401 仍须撤销失效本地登录态')
  }

  // 16) 只有重试开关、没有公共读取白名单绝不生效，防止敏感写接口误用单个布尔值降级。
  {
    const env = setupEnv({ globalToken: 'TOKEN-SENSITIVE-WRITE', storageToken: 'TOKEN-SENSITIVE-WRITE' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-SENSITIVE-WRITE'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    const apiClient = loadFresh()
    const outcome = apiClient.call({
      path: '/mini/listings/L-PUBLIC/sensitive-view',
      method: 'POST',
      data: { idempotencyKey: 'idem-sensitive' },
      retryAnonymousOnAuthFailure: true
    }).then((value) => ({ value }), (error) => ({ error }))
    pendingRequests[0].success({ statusCode: 401, data: { message: '登录已过期' }, header: {} })
    const result = await outcome
    assert.ok(result.error && result.error.statusCode === 401)
    assert.strictEqual(pendingRequests.length, 1, '非公共写接口不得因单独重试开关而匿名重放')
    assert.strictEqual(env.nav.length, 1, '非公共写接口仍保持原登录引导')
  }

  // 17) 公共卡片的收藏 ID 只是可选个性化：过期 token 先静默匿名重试，匿名端点仍 401 时
  // 返回空集合；收藏列表和收藏写操作仍然严格鉴权。
  {
    const env = setupEnv({ globalToken: 'TOKEN-FAVORITES-EXPIRED', storageToken: 'TOKEN-FAVORITES-EXPIRED' })
    env.globalData.apiConfig = {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token: 'TOKEN-FAVORITES-EXPIRED'
    }
    const pendingRequests = []
    global.wx.request = (options) => { pendingRequests.push(options) }
    loadFresh()
    const apiServicePath = require.resolve('../../utils/api-service')
    delete require.cache[apiServicePath]
    const apiService = require(apiServicePath)
    const request = apiService.getFavoriteIds()
    assert.strictEqual(pendingRequests[0].header.Authorization, 'Bearer TOKEN-FAVORITES-EXPIRED')
    pendingRequests[0].success({ statusCode: 401, data: { message: '登录已过期' }, header: {} })
    await Promise.resolve()
    assert.strictEqual(pendingRequests.length, 2, '收藏 ID 预加载应在清态后匿名重试一次')
    assert.ok(!pendingRequests[1].header.Authorization)
    pendingRequests[1].success({ statusCode: 401, data: { message: '收藏 ID 仅登录可用' }, header: {} })
    assert.deepStrictEqual(await request, [], '游客无法读取收藏 ID 时应以空集合继续渲染公共卡片')
    assert.strictEqual(env.globalData.authToken, '')
    assert.strictEqual(env.nav.length, 0, '收藏 ID 可选预加载失败不得跳登录')
    assert.strictEqual(pendingRequests.length, 2)
    delete require.cache[apiServicePath]
  }

  // 18) api-service 必须逐方法显式启用公共读取降级，绝不能用“所有 GET”之类宽泛规则；
  // 同时 Mock 飞书快照只保留展示白名单，不暴露 URL、range 或起始行列定位信息。
  {
    const mockData = require('../../utils/mock-data')
    mockData.loginByPhone('13800010005')
    const signedServiceSession = mockData.issueAuthSession('U005')
    setupEnv({ globalToken: signedServiceSession.token, storageToken: signedServiceSession.token })
    const apiClient = loadFresh()
    const originalCall = apiClient.call
    const apiServicePath = require.resolve('../../utils/api-service')
    const captured = []
    apiClient.call = (options) => {
      captured.push(options)
      if (options.path === '/mini/company-sheet-snapshot') return Promise.resolve(options.mock())
      if (/\/favorites\/ids$/.test(options.path)) return Promise.resolve([])
      if (/\/favorites(?:\?|$)/.test(options.path)) return Promise.resolve([])
      if (options.path === '/mini/listings/match') return Promise.resolve({ listings: [] })
      if (options.path === '/mini/assistant/chat') return Promise.resolve({ listings: [], exactListings: [], nearbyListings: [] })
      if (/\/nearby\?all=1$/.test(options.path)) return Promise.resolve({ listings: [], total: 0 })
      if (options.path === '/mini/listings/L-PUBLIC') return Promise.resolve({ unavailable: true })
      if (/\/mini\/(?:home\/listings|listings(?:\?|$)|map\/)/.test(options.path)) return Promise.resolve([])
      return Promise.resolve({})
    }
    delete require.cache[apiServicePath]
    const apiService = require(apiServicePath)

    const captureCall = async (label, invoke, expectedFallback) => {
      const before = captured.length
      await invoke()
      const options = captured[before]
      assert.ok(options, `${label} 应发起 API 请求`)
      assert.strictEqual(
        options.publicReadAuthFallback === true,
        expectedFallback,
        `${label} 的公共匿名降级标记不符合鉴权边界`
      )
    }

    const publicMethods = [
      ['getHomeListings', () => apiService.getHomeListings()],
      ['getListings', () => apiService.getListings({ area: '测试区' })],
      ['getCompanyListings', () => apiService.getCompanyListings()],
      ['getCompanySheetSnapshot', () => apiService.getCompanySheetSnapshot()],
      ['getCommissionConfig', () => apiService.getCommissionConfig()],
      ['submitAssistantFeedback', () => apiService.submitAssistantFeedback({ feedbackType: 'other' })],
      ['getFavoriteIds', () => apiService.getFavoriteIds()],
      ['matchListings', () => apiService.matchListings({ community: '测试小区' })],
      ['chatAssistant', () => apiService.chatAssistant({ text: '测试小区附近' })],
      ['getMapCommunities', () => apiService.getMapCommunities({ area: '测试区' })],
      ['getMapPins', () => apiService.getMapPins({ area: '测试区' })],
      ['getListingDetail', () => apiService.getListingDetail('L-PUBLIC')],
      ['getNearbyListings', () => apiService.getNearbyListings('L-PUBLIC')]
    ]
    for (const [label, invoke] of publicMethods) await captureCall(label, invoke, true)
    ;['/mini/listings/match', '/mini/assistant/chat', '/mini/assistant/feedback'].forEach((pathname) => {
      const request = captured.find((item) => item.path === pathname)
      assert.ok(request && request.retryAnonymousOnAuthFailure === true, `${pathname} 必须仅在服务端执行前 401 标记下允许一次匿名重试`)
    })

    const protectedMethods = [
      ['getFavorites', () => apiService.getFavorites({})],
      ['setFavorite', () => apiService.setFavorite('L-PUBLIC', true)],
      ['getCurrentUser', () => apiService.getCurrentUser()],
      ['getListingLogs', () => apiService.getListingLogs('L-PUBLIC')],
      ['addSensitiveFootprint', () => apiService.addSensitiveFootprint('L-PUBLIC', 'idem-test')],
      ['recordPhoneCallOpened', () => apiService.recordPhoneCallOpened('L-PUBLIC', 'idem-test')],
      ['recordVideoShare', () => apiService.recordVideoShare('L-PUBLIC', {})],
      ['recordShowing', () => apiService.recordShowing('L-PUBLIC', {})],
      ['createRentalNeed', () => apiService.createRentalNeed({ community: '测试小区' })]
    ]
    for (const [label, invoke] of protectedMethods) await captureCall(label, invoke, false)

    const snapshot = await apiService.getCompanySheetSnapshot()
    assert.deepStrictEqual(
      Object.keys(snapshot).sort(),
      ['columnCount', 'rowCount', 'rows', 'sensitiveStripped', 'title', 'unavailable', 'updatedAt'].sort(),
      'Mock 飞书快照只能返回前端展示所需白名单字段'
    )
    for (const key of ['sheetUrl', 'range', 'startRow', 'startCol']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, key), `Mock 飞书快照不得返回 ${key}`)
    }
    assert.ok(!/https?:\/\//i.test(JSON.stringify(snapshot)), 'Mock 飞书快照不得夹带任何表格 URL')

    apiClient.call = originalCall
    mockData.revokeAuthSession(signedServiceSession.token)
    delete require.cache[apiServicePath]
  }

  console.log('api-client-auth-v1-test passed')
}

function runWithTimeout() {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('api-client-auth-v1-test 超时，可能存在未响应的鉴权重试导致假绿')), 5000)
  })
  return Promise.race([run(), timeout]).finally(() => clearTimeout(timer))
}

runWithTimeout().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
