'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const apiClientPath = path.join(repoRoot, 'utils', 'api-client.js')
const appPath = path.join(repoRoot, 'app.js')

function setupApiEnv({ token = 'TOKEN_A', expiresAt = Date.now() + 60 * 60 * 1000 } = {}) {
  const storage = {}
  if (token) storage.ynzy_auth_token = token
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') storage.ynzy_auth_token_expires_at = expiresAt
  if (token) storage.ynzy_user_id = 'U-A'
  const requests = []
  const nav = []
  const globalData = {
    user: token ? { id: 'U-A' } : null,
    userId: token ? 'U-A' : '',
    authToken: token,
    authTokenExpiresAt: expiresAt || '',
    authSessionKey: token ? 'SESSION_A' : 'GUEST_SESSION',
    apiConfig: {
      env: 'prod',
      baseUrl: 'https://api.example.test',
      timeout: 15000,
      token
    }
  }
  const app = {
    globalData,
    refreshAuthToken(nextToken, nextExpiresAt, expectedToken) {
      const currentToken = String(globalData.authToken || '')
      const expiry = Number(nextExpiresAt)
      const currentExpiry = Number(globalData.authTokenExpiresAt || storage.ynzy_auth_token_expires_at || 0)
      if (!nextToken || currentToken !== String(expectedToken || '') || !Number.isFinite(expiry) || expiry <= Date.now() || expiry <= currentExpiry) return false
      globalData.authToken = nextToken
      globalData.authTokenExpiresAt = expiry
      globalData.apiConfig.token = nextToken
      storage.ynzy_auth_token = nextToken
      storage.ynzy_auth_token_expires_at = expiry
      return true
    },
    logout() {
      globalData.user = null
      globalData.userId = ''
      globalData.authToken = ''
      globalData.authTokenExpiresAt = ''
      globalData.apiConfig.token = ''
      delete storage.ynzy_auth_token
      delete storage.ynzy_auth_token_expires_at
      delete storage.ynzy_user_id
    }
  }
  global.getApp = () => app
  global.getCurrentPages = () => [{ route: 'pages/index/index' }]
  global.wx = {
    getStorageSync(key) { return storage[key] === undefined ? '' : storage[key] },
    setStorageSync(key, value) { storage[key] = value },
    removeStorageSync(key) { delete storage[key] },
    navigateTo(options) {
      nav.push(options && options.url)
      if (options && typeof options.complete === 'function') options.complete()
    },
    request(options) { requests.push(options) }
  }
  return { app, globalData, storage, requests, nav }
}

function loadFreshApiClient() {
  delete require.cache[require.resolve(apiClientPath)]
  return require(apiClientPath)
}

async function successfulCall(apiClient, env, headers, data = { ok: true }) {
  const promise = apiClient.call({ path: '/mini/auth/me' })
  const request = env.requests.shift()
  request.success({ statusCode: 200, data: { code: 0, message: 'ok', data }, header: headers || {} })
  return promise
}

function instantiateApp(storage, options = {}) {
  let definition
  global.App = (value) => { definition = value }
  global.wx = {
    getSystemInfoSync() { return { platform: 'ios' } },
    getStorageSync(key) { return storage[key] === undefined ? '' : storage[key] },
    setStorageSync(key, value) {
      storage[key] = value
      if (typeof options.failStorageWrite === 'function' && options.failStorageWrite(key, value)) {
        throw new Error(`合成存储失败：${key}`)
      }
    },
    removeStorageSync(key) { delete storage[key] }
  }
  delete require.cache[require.resolve(appPath)]
  require(appPath)
  assert.ok(definition, 'app.js 必须注册 App')
  const instance = { ...definition, globalData: { ...definition.globalData, apiConfig: { ...definition.globalData.apiConfig } } }
  return instance
}

function authStateSnapshot(app, storage) {
  return {
    user: app.globalData.user ? JSON.parse(JSON.stringify(app.globalData.user)) : app.globalData.user,
    userId: app.globalData.userId,
    authToken: app.globalData.authToken,
    authTokenExpiresAt: app.globalData.authTokenExpiresAt,
    authSessionKey: app.globalData.authSessionKey,
    apiToken: app.globalData.apiConfig.token,
    storageToken: storage.ynzy_auth_token,
    storageExpiresAt: storage.ynzy_auth_token_expires_at,
    storageUserId: storage.ynzy_user_id
  }
}

function failOnceAtStorageKey(expectedKey) {
  let failed = false
  return (key) => {
    if (failed || key !== expectedKey) return false
    failed = true
    return true
  }
}

async function run() {
  // 1. 成功响应的续签头只在“发出请求的 token 仍是当前 token”时原子落地。
  {
    const originalExpiry = Date.now() + 60 * 60 * 1000
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: originalExpiry })
    const apiClient = loadFreshApiClient()
    const nextExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    await successfulCall(apiClient, env, {
      'X-Auth-Token': 'TOKEN_A_REFRESHED',
      'x-auth-token-expires-at': String(nextExpiry)
    })
    assert.strictEqual(env.globalData.authToken, 'TOKEN_A_REFRESHED')
    assert.strictEqual(env.globalData.authTokenExpiresAt, nextExpiry)
    assert.strictEqual(env.globalData.apiConfig.token, 'TOKEN_A_REFRESHED')
    assert.strictEqual(env.storage.ynzy_auth_token, 'TOKEN_A_REFRESHED')
    assert.strictEqual(env.storage.ynzy_auth_token_expires_at, nextExpiry)
    assert.strictEqual(env.globalData.authSessionKey, 'SESSION_A', '同账号滑动续签不得改变稳定会话键')
    assert.strictEqual(apiClient.getAuthSessionKey(), 'SESSION_A')
  }

  // 2. 同一旧 token 的并发响应只有第一个能轮换；迟到响应不能把新 token 倒退覆盖。
  {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 1000 })
    const apiClient = loadFreshApiClient()
    const first = apiClient.call({ path: '/mini/profile' })
    const second = apiClient.call({ path: '/mini/footprints' })
    const firstRequest = env.requests.shift()
    const secondRequest = env.requests.shift()
    const laterExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    secondRequest.success({ statusCode: 200, data: { code: 0, data: {} }, header: {
      'x-auth-token': 'TOKEN_A_SECOND',
      'x-auth-token-expires-at': String(laterExpiry)
    } })
    await second
    firstRequest.success({ statusCode: 200, data: { code: 0, data: {} }, header: {
      'x-auth-token': 'TOKEN_A_FIRST_LATE',
      'x-auth-token-expires-at': String(laterExpiry + 10000)
    } })
    await first
    assert.strictEqual(env.globalData.authToken, 'TOKEN_A_SECOND', '旧 A 的迟到成功响应不能覆盖已轮换的新 token')
  }

  // 3. A 请求发出后切换 B 或主动退出，A 的续签响应不得覆盖/复活当前会话。
  for (const mode of ['switch', 'logout']) {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 1000 })
    const apiClient = loadFreshApiClient()
    const pending = apiClient.call({ path: '/mini/profile' })
    const request = env.requests.shift()
    if (mode === 'switch') {
      env.globalData.authToken = 'TOKEN_B'
      env.globalData.authTokenExpiresAt = Date.now() + 5000
      env.globalData.authSessionKey = 'SESSION_B'
      env.globalData.apiConfig.token = 'TOKEN_B'
      env.storage.ynzy_auth_token = 'TOKEN_B'
    } else {
      env.app.logout()
    }
    request.success({ statusCode: 200, data: { code: 0, data: {} }, header: {
      'x-auth-token': 'TOKEN_A_LATE',
      'x-auth-token-expires-at': String(Date.now() + 30 * 24 * 60 * 60 * 1000)
    } })
    await pending
    assert.strictEqual(env.globalData.authToken, mode === 'switch' ? 'TOKEN_B' : '', `${mode} 后旧响应不得覆盖当前会话`)
  }

  // 4. 缺 token、畸形/过期/不前移 expiry，以及非 2xx 响应头都不能改本地登录态。
  {
    const currentExpiry = Date.now() + 2 * 60 * 60 * 1000
    const invalidHeaders = [
      { 'x-auth-token-expires-at': String(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      { 'x-auth-token': 'BAD_NO_EXPIRY' },
      { 'x-auth-token': 'BAD_TEXT_EXPIRY', 'x-auth-token-expires-at': 'not-a-date' },
      { 'x-auth-token': 'BAD_PAST', 'x-auth-token-expires-at': String(Date.now() - 1) },
      { 'x-auth-token': 'BAD_OLDER', 'x-auth-token-expires-at': String(currentExpiry - 1) }
    ]
    for (const headers of invalidHeaders) {
      const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: currentExpiry })
      const apiClient = loadFreshApiClient()
      await successfulCall(apiClient, env, headers)
      assert.strictEqual(env.globalData.authToken, 'TOKEN_A')
      assert.strictEqual(env.storage.ynzy_auth_token, 'TOKEN_A')
    }

    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: currentExpiry })
    const apiClient = loadFreshApiClient()
    const pending = apiClient.call({ path: '/mini/profile' })
    const request = env.requests.shift()
    request.success({ statusCode: 500, data: { code: 500, message: '合成错误' }, header: {
      'x-auth-token': 'MUST_NOT_APPLY',
      'x-auth-token-expires-at': String(Date.now() + 30 * 24 * 60 * 60 * 1000)
    } })
    await assert.rejects(pending, (error) => error && error.statusCode === 500)
    assert.strictEqual(env.globalData.authToken, 'TOKEN_A', '错误响应不得续签')
  }

  // 5. 401 撤销除了 token/userId 还必须删除本地 expiry，不能留下伪登录时间。
  {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 5000 })
    const apiClient = loadFreshApiClient()
    apiClient.handleUnauthorized({ statusCode: 401 }, 'TOKEN_A')
    assert.strictEqual(env.storage.ynzy_auth_token, undefined)
    assert.strictEqual(env.storage.ynzy_auth_token_expires_at, undefined)
    assert.strictEqual(env.globalData.authTokenExpiresAt, '')
  }

  // 4.2 语音 multipart 上传同样属于活跃使用：带 Bearer 的成功响应必须续签；当前 token 的
  //     401 必须撤销。OSS 直传没有 Bearer，不参与本地会话轮换。
  {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 1000 })
    let uploadRequest
    global.wx.uploadFile = (options) => {
      uploadRequest = options
      return { onProgressUpdate() {} }
    }
    const apiClient = loadFreshApiClient()
    const pending = apiClient.uploadFile({
      url: 'https://api.example.test/mini/asr/transcribe',
      filePath: '/tmp/synthetic-voice.mp3',
      header: { Authorization: 'Bearer TOKEN_A' }
    })
    const nextExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    uploadRequest.success({
      statusCode: 200,
      data: JSON.stringify({ code: 0, data: { text: '合成语音' } }),
      header: {
        'x-auth-token': 'TOKEN_A_UPLOAD_REFRESHED',
        'x-auth-token-expires-at': String(nextExpiry)
      }
    })
    await pending
    assert.strictEqual(env.globalData.authToken, 'TOKEN_A_UPLOAD_REFRESHED', '带 Bearer 的成功文件上传必须续签')
    assert.strictEqual(env.storage.ynzy_auth_token_expires_at, nextExpiry)
  }

  {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 1000 })
    let uploadRequest
    global.wx.uploadFile = (options) => {
      uploadRequest = options
      return { onProgressUpdate() {} }
    }
    const apiClient = loadFreshApiClient()
    const pending = apiClient.uploadFile({
      url: 'https://api.example.test/mini/asr/transcribe',
      filePath: '/tmp/synthetic-voice.mp3',
      header: { Authorization: 'Bearer TOKEN_A' }
    })
    uploadRequest.success({ statusCode: 401, data: JSON.stringify({ code: 401, message: '登录失效' }), header: {} })
    await assert.rejects(pending, (error) => error && error.statusCode === 401)
    assert.strictEqual(env.globalData.authToken, '', '带 Bearer 文件上传的当前 token 真 401 必须撤销本地会话')
  }

  // 4.1 缺少 App 原子持久化方法时必须 fail-closed；api-client 不得自行先改内存再逐键写存储。
  {
    const currentExpiry = Date.now() + 2 * 60 * 60 * 1000
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: currentExpiry })
    delete env.app.refreshAuthToken
    const apiClient = loadFreshApiClient()
    await successfulCall(apiClient, env, {
      'x-auth-token': 'MUST_NOT_APPLY_WITHOUT_ATOMIC_APP',
      'x-auth-token-expires-at': String(Date.now() + 30 * 24 * 60 * 60 * 1000)
    })
    assert.strictEqual(env.globalData.authToken, 'TOKEN_A')
    assert.strictEqual(env.storage.ynzy_auth_token, 'TOKEN_A')
    assert.strictEqual(env.storage.ynzy_auth_token_expires_at, currentExpiry)
  }

  // 6. App 启动：已过期的本地 token 在任何请求前清空；未来 expiry 恢复；缺 expiry 的存量 token 交给服务端兼容验证。
  {
    const expiredStorage = {
      ynzy_auth_token: 'EXPIRED_LOCAL',
      ynzy_auth_token_expires_at: Date.now() - 1,
      ynzy_user_id: 'U-OLD'
    }
    const expiredApp = instantiateApp(expiredStorage)
    expiredApp.onLaunch.call(expiredApp)
    assert.strictEqual(expiredApp.globalData.authToken, '')
    assert.strictEqual(expiredStorage.ynzy_auth_token, undefined)
    assert.strictEqual(expiredStorage.ynzy_auth_token_expires_at, undefined)
    assert.strictEqual(expiredStorage.ynzy_user_id, undefined)

    const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    const futureStorage = { ynzy_auth_token: 'FUTURE_LOCAL', ynzy_auth_token_expires_at: futureExpiry, ynzy_user_id: 'U-FUTURE' }
    const futureApp = instantiateApp(futureStorage)
    futureApp.onLaunch.call(futureApp)
    assert.strictEqual(futureApp.globalData.authToken, 'FUTURE_LOCAL')
    assert.strictEqual(futureApp.globalData.authTokenExpiresAt, futureExpiry)

    const legacyStorage = { ynzy_auth_token: 'LEGACY_LOCAL', ynzy_user_id: 'U-LEGACY' }
    const legacyApp = instantiateApp(legacyStorage)
    legacyApp.onLaunch.call(legacyApp)
    assert.strictEqual(legacyApp.globalData.authToken, 'LEGACY_LOCAL', '缺 expiry 的存量 token 不应在客户端武断删除')
  }

  // 7. App 的换 token 方法自身也必须执行 expected-token 和 expiry 单调门禁。
  {
    const expiry = Date.now() + 1000
    const storage = { ynzy_auth_token: 'TOKEN_A', ynzy_auth_token_expires_at: expiry, ynzy_user_id: 'U-A' }
    const app = instantiateApp(storage)
    app.onLaunch.call(app)
    assert.strictEqual(typeof app.refreshAuthToken, 'function')
    assert.ok(app.globalData.authSessionKey, '恢复登录时必须生成稳定会话键')
    const sessionKey = app.globalData.authSessionKey
    assert.strictEqual(app.refreshAuthToken('TOKEN_B', Date.now() + 5000, 'WRONG_TOKEN'), false)
    assert.strictEqual(app.globalData.authToken, 'TOKEN_A')
    assert.strictEqual(app.refreshAuthToken('TOKEN_A_NEW', Date.now() - 1, 'TOKEN_A'), false)
    const nextExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    assert.strictEqual(app.refreshAuthToken('TOKEN_A_NEW', nextExpiry, 'TOKEN_A'), true)
    assert.strictEqual(app.globalData.authToken, 'TOKEN_A_NEW')
    assert.strictEqual(storage.ynzy_auth_token_expires_at, nextExpiry)
    assert.strictEqual(app.globalData.authSessionKey, sessionKey, '滑动续签不能被页面误判成换号')
  }

  // 8. 页面与共享收藏仓库的异步代次必须使用稳定 session key，不能再把会轮换的 bearer 当账号 ID。
  {
    const files = [
      'utils/favorite-store.js',
      'pages/profile/profile.js',
      'pages/favorites/favorites.js',
      'pages/nearby-listings/nearby-listings.js',
      'pages/listing-detail/listing-detail.js',
      'pages/upload/upload.js'
    ]
    for (const relativePath of files) {
      const source = require('fs').readFileSync(path.join(repoRoot, relativePath), 'utf8')
      assert.ok(/getAuthSessionKey|currentAuthSessionKey/.test(source), `${relativePath} 必须用稳定会话键隔离换号/退出与迟到响应`)
    }
  }

  // 7.1 App 登录/续签的本地持久化必须具备事务语义：任一同步写失败时，内存、API 配置、
  //     稳定会话键与三个存储键都保持旧账号，不能出现 A 用户配 B token 或新 token 配旧 expiry。
  for (const failedKey of ['ynzy_auth_token_expires_at', 'ynzy_auth_token']) {
    const originalExpiry = Date.now() + 60 * 60 * 1000
    const storage = { ynzy_auth_token: 'TOKEN_A', ynzy_auth_token_expires_at: originalExpiry, ynzy_user_id: 'U-A' }
    const app = instantiateApp(storage, { failStorageWrite: failOnceAtStorageKey(failedKey) })
    app.onLaunch.call(app)
    app.globalData.user = { id: 'U-A', name: '账号A' }
    const before = authStateSnapshot(app, storage)
    const nextExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    assert.strictEqual(app.refreshAuthToken('TOKEN_A_REFRESHED', nextExpiry, 'TOKEN_A'), false, `${failedKey} 写失败时续签必须失败`)
    assert.deepStrictEqual(authStateSnapshot(app, storage), before, `${failedKey} 写失败不得留下半更新续签状态`)
    assert.strictEqual(app.refreshAuthToken('TOKEN_A_REFRESHED', nextExpiry, 'TOKEN_A'), true, '存储恢复后续签应可重试成功')
  }

  for (const failedKey of ['ynzy_auth_token_expires_at', 'ynzy_user_id', 'ynzy_auth_token']) {
    const originalExpiry = Date.now() + 60 * 60 * 1000
    const storage = { ynzy_auth_token: 'TOKEN_A', ynzy_auth_token_expires_at: originalExpiry, ynzy_user_id: 'U-A' }
    const app = instantiateApp(storage, { failStorageWrite: failOnceAtStorageKey(failedKey) })
    app.onLaunch.call(app)
    app.globalData.user = { id: 'U-A', name: '账号A' }
    const before = authStateSnapshot(app, storage)
    const userB = { id: 'U-B', name: '账号B', token: 'TOKEN_B', tokenExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }
    assert.strictEqual(app.setCurrentUser(userB), false, `${failedKey} 写失败时换号登录必须失败`)
    assert.deepStrictEqual(authStateSnapshot(app, storage), before, `${failedKey} 写失败不得串联 A/B 账号状态`)
    assert.strictEqual(app.setCurrentUser(userB), true, '存储恢复后换号登录应可重试成功')
    assert.strictEqual(app.globalData.userId, 'U-B')
    assert.strictEqual(storage.ynzy_auth_token, 'TOKEN_B')
  }

  // 9. 共享收藏仓库行为验证：同账号 token A→A′ 期间在途 GET 仍应成功落地，不得抛“账号已切换”。
  {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 1000 })
    const apiClient = loadFreshApiClient()
    const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
    const favoriteStorePath = require.resolve(path.join(repoRoot, 'utils', 'favorite-store.js'))
    let resolveFavoriteIds
    require.cache[apiServicePath] = {
      id: apiServicePath,
      filename: apiServicePath,
      loaded: true,
      exports: {
        getFavoriteIds: () => new Promise((resolve) => { resolveFavoriteIds = resolve }),
        setFavorite: () => Promise.resolve({ favorite: true })
      }
    }
    // favorite-store 必须复用本用例刚加载、已连接真实 App 会话键的 api-client。
    require.cache[require.resolve(apiClientPath)] = {
      id: require.resolve(apiClientPath),
      filename: require.resolve(apiClientPath),
      loaded: true,
      exports: apiClient
    }
    delete require.cache[favoriteStorePath]
    const favoriteStore = require(favoriteStorePath)
    const pending = favoriteStore.load({ force: true })
    const nextExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    assert.strictEqual(env.app.refreshAuthToken('TOKEN_A_REFRESHED', nextExpiry, 'TOKEN_A'), true)
    assert.strictEqual(env.globalData.authSessionKey, 'SESSION_A')
    resolveFavoriteIds(['L-SESSION-STABLE'])
    assert.deepStrictEqual(await pending, ['L-SESSION-STABLE'])
    assert.strictEqual(favoriteStore.isFavorite('L-SESSION-STABLE'), true)
    delete require.cache[favoriteStorePath]
    delete require.cache[apiServicePath]
  }

  // 10. 同一会话 A→A′ 后，旧 A 的迟到 401：GET 只用当前 A′ 自动重试一次；第二次真 401
  //     正常撤销；写请求绝不自动重放，只标记为旧响应供页面提示重试。
  {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 1000 })
    const apiClient = loadFreshApiClient()
    const refreshPending = apiClient.call({ path: '/mini/profile' })
    const stalePending = apiClient.call({ path: '/mini/footprints' })
    const refreshRequest = env.requests.shift()
    const staleRequest = env.requests.shift()
    const nextExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    refreshRequest.success({ statusCode: 200, data: { code: 0, data: { refreshed: true } }, header: {
      'x-auth-token': 'TOKEN_A_REFRESHED',
      'x-auth-token-expires-at': String(nextExpiry)
    } })
    await refreshPending
    staleRequest.success({ statusCode: 401, data: { code: 401, message: '旧 token 已过期' }, header: {} })
    const retryRequest = env.requests.shift()
    assert.ok(retryRequest, '旧 GET 的迟到 401 必须自动发出一次重试')
    assert.strictEqual(retryRequest.header.Authorization, 'Bearer TOKEN_A_REFRESHED', '重试必须使用当前续签 token')
    retryRequest.success({ statusCode: 200, data: { code: 0, data: [{ id: 'F-RETRY' }] }, header: {} })
    assert.deepStrictEqual(await stalePending, [{ id: 'F-RETRY' }])
    assert.strictEqual(env.globalData.authToken, 'TOKEN_A_REFRESHED')
    assert.strictEqual(env.nav.length, 0, '被安全重试的旧 401 不得跳登录')
  }

  {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 1000 })
    const apiClient = loadFreshApiClient()
    const pending = apiClient.call({ path: '/mini/profile' })
    const oldRequest = env.requests.shift()
    assert.strictEqual(env.app.refreshAuthToken('TOKEN_A_REFRESHED', Date.now() + 5000, 'TOKEN_A'), true)
    oldRequest.success({ statusCode: 401, data: { code: 401, message: '旧响应' }, header: {} })
    const retryRequest = env.requests.shift()
    assert.ok(retryRequest, '旧 GET 应重试一次')
    retryRequest.success({ statusCode: 401, data: { code: 401, message: '当前 token 也失效' }, header: {} })
    await assert.rejects(pending, (error) => error && error.statusCode === 401)
    assert.strictEqual(env.requests.length, 0, 'GET 鉴权重试最多一次，不能循环')
    assert.strictEqual(env.globalData.authToken, '', '重试后的当前 token 真 401 必须撤销本地会话')
  }

  {
    const env = setupApiEnv({ token: 'TOKEN_A', expiresAt: Date.now() + 1000 })
    const apiClient = loadFreshApiClient()
    const pending = apiClient.call({ path: '/mini/listings', method: 'POST', data: { title: '合成测试' } })
    const oldRequest = env.requests.shift()
    assert.strictEqual(env.app.refreshAuthToken('TOKEN_A_REFRESHED', Date.now() + 5000, 'TOKEN_A'), true)
    oldRequest.success({ statusCode: 401, data: { code: 401, message: '旧响应' }, header: {} })
    await assert.rejects(pending, (error) => error && error.statusCode === 401 && error.authResponseStale === true)
    assert.strictEqual(env.requests.length, 0, 'POST 的旧 401 绝不能自动重放')
    assert.strictEqual(env.globalData.authToken, 'TOKEN_A_REFRESHED', 'POST 旧响应不得清除当前续签会话')
    assert.strictEqual(env.nav.length, 0)
  }

  console.log('mini-sliding-auth-client-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
