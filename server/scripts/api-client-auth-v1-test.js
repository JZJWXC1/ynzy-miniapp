'use strict'

// 小程序 utils/api-client.js 的 401 跳转策略锁定测试（Codex 返修要求固化）。
// 用 mock wx / getApp / getCurrentPages 加载 api-client，直接调用导出的 handleUnauthorized，
// 固化三条不变量：
//   1) 游客（无 token）遇 401 只清状态、不跳登录页；
//   2) 已登录（有 token）遇 401 清 token 并跳登录页一次；
//   3) token 清空后的连续 401 不再重复跳转（不形成循环）。
// 另加：非 401（403）不跳转。这样任何人把 handleUnauthorized 改回“401 立即跳登录”都会被测到。

const assert = require('assert')

// 构造一套 wx/getApp/getCurrentPages 环境，返回可观察的 nav / storage / globalData。
function setupEnv({ globalToken, storageToken } = {}) {
  const nav = []
  const storage = {}
  if (storageToken) storage['ynzy_auth_token'] = storageToken
  const globalData = {
    authToken: globalToken || '',
    userId: globalToken ? 'U1' : '',
    user: globalToken ? { id: 'U1' } : null,
    apiConfig: { token: globalToken || '' }
  }
  global.getApp = () => ({
    globalData,
    logout() {
      globalData.user = null
      globalData.userId = ''
      globalData.authToken = ''
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
  return { nav, storage, globalData }
}

// 每个用例清 require 缓存重载 api-client，重置其模块级 authRedirecting 状态。
function loadFresh() {
  const p = require.resolve('../../utils/api-client')
  delete require.cache[p]
  return require('../../utils/api-client')
}

function run() {
  // 1) 游客（无任何 token）遇 401：只清状态，不跳登录。
  {
    const env = setupEnv({})
    const apiClient = loadFresh()
    apiClient.handleUnauthorized({ statusCode: 401 })
    assert.strictEqual(env.nav.length, 0, '游客 401 不应跳登录页')
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

  console.log('api-client-auth-v1-test passed')
}

run()
process.exit(0)
