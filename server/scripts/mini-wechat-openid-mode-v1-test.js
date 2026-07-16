'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const appPath = path.join(repoRoot, 'app.js')
const apiServicePath = path.join(repoRoot, 'utils', 'api-service.js')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

function instantiateApp({ paymentMode, bindResult } = {}) {
  let definition
  let loginCalls = 0
  let loginOptions = null
  const boundCodes = []

  global.App = (value) => { definition = value }
  global.wx = {
    getSystemInfoSync() { return { platform: 'ios' } },
    getStorageSync() { return '' },
    setStorageSync() {},
    removeStorageSync() {},
    login(options) {
      loginCalls += 1
      loginOptions = options
    }
  }

  require.cache[require.resolve(apiServicePath)] = {
    id: require.resolve(apiServicePath),
    filename: require.resolve(apiServicePath),
    loaded: true,
    exports: {
      bindWechatOpenid(code) {
        boundCodes.push(code)
        return bindResult ? bindResult(code) : Promise.resolve({ id: 'U-SYNTHETIC' })
      }
    }
  }

  delete require.cache[require.resolve(appPath)]
  require(appPath)
  assert.ok(definition, 'app.js 必须注册 App')
  const instance = {
    ...definition,
    globalData: {
      ...definition.globalData,
      authToken: 'TOKEN-SYNTHETIC',
      authSessionKey: 'SESSION-SYNTHETIC',
      user: { id: 'U-ORIGINAL' },
      apiConfig: {
        ...definition.globalData.apiConfig,
        paymentMode: paymentMode || 'manual',
        token: 'TOKEN-SYNTHETIC'
      }
    }
  }

  return {
    app: instance,
    boundCodes,
    getLoginCalls: () => loginCalls,
    getLoginOptions: () => loginOptions
  }
}

async function run() {
  // 第一版固定人工支付：手机号登录成功后不得触发历史 OpenID/微信支付预绑定，
  // 否则开发者工具会在有效登录旁路产生无意义的 502 invalid code。
  {
    const env = instantiateApp({ paymentMode: 'manual' })
    env.app.bindWechatOpenid()
    await flushPromises()
    assert.strictEqual(env.getLoginCalls(), 0, 'manual 模式不得调用 wx.login 获取 OpenID code')
    assert.deepStrictEqual(env.boundCodes, [], 'manual 模式不得请求 /mini/auth/wechat-openid')
  }

  // 只有未来明确切到 wechat 模式时才允许绑定；每次调用只消费本次 fresh code 一次。
  {
    const env = instantiateApp({ paymentMode: 'wechat' })
    env.app.bindWechatOpenid()
    assert.strictEqual(env.getLoginCalls(), 1, 'wechat 模式应只调用一次 wx.login')
    env.getLoginOptions().success({ code: 'SYNTHETIC-FRESH-CODE' })
    await flushPromises()
    assert.deepStrictEqual(env.boundCodes, ['SYNTHETIC-FRESH-CODE'], 'wechat 模式只发送本次 fresh code')
    assert.strictEqual(env.app.globalData.user.id, 'U-SYNTHETIC', '同一会话绑定成功可刷新当前用户资料')
  }

  // wx.login 返回前发生换号/退出时，旧 code 不得发送。
  {
    const env = instantiateApp({ paymentMode: 'wechat' })
    env.app.bindWechatOpenid()
    env.app.globalData.authSessionKey = 'SESSION-CHANGED'
    env.getLoginOptions().success({ code: 'SYNTHETIC-STALE-CODE' })
    await flushPromises()
    assert.deepStrictEqual(env.boundCodes, [], '会话变化后不得发送旧 wx.login code')
  }

  // 请求已发出但响应迟到时，也不能把旧账号资料覆盖到新会话。
  {
    const pending = deferred()
    const env = instantiateApp({ paymentMode: 'wechat', bindResult: () => pending.promise })
    env.app.bindWechatOpenid()
    env.getLoginOptions().success({ code: 'SYNTHETIC-PENDING-CODE' })
    assert.deepStrictEqual(env.boundCodes, ['SYNTHETIC-PENDING-CODE'])
    env.app.globalData.authSessionKey = 'SESSION-NEW-ACCOUNT'
    env.app.globalData.user = { id: 'U-NEW-ACCOUNT' }
    pending.resolve({ id: 'U-OLD-ACCOUNT' })
    await flushPromises()
    assert.strictEqual(env.app.globalData.user.id, 'U-NEW-ACCOUNT', '迟到绑定响应不得覆盖新账号资料')
  }

  delete require.cache[require.resolve(appPath)]
  delete require.cache[require.resolve(apiServicePath)]
  delete global.App
  delete global.wx
  console.log('mini-wechat-openid-mode-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
