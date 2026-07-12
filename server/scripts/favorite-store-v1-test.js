'use strict'

const assert = require('assert')

const apiClientPath = require.resolve('../../utils/api-client')
const apiServicePath = require.resolve('../../utils/api-service')
const storePath = require.resolve('../../utils/favorite-store')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

function loadStore(harness) {
  delete require.cache[storePath]
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: { getAuthToken: () => harness.token }
  }
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: {
      getFavoriteIds: () => {
        harness.getCalls += 1
        return harness.getFavoriteIds()
      },
      setFavorite: (listingId, desired) => {
        harness.setCalls.push({ listingId, desired })
        return harness.setFavorite(listingId, desired)
      }
    }
  }
  return require(storePath)
}

function harness(overrides = {}) {
  return {
    token: 'TOKEN_A',
    getCalls: 0,
    setCalls: [],
    getFavoriteIds: () => Promise.resolve([]),
    setFavorite: (listingId, desired) => Promise.resolve({ listingId, isFavorited: desired }),
    ...overrides
  }
}

async function run() {
  // 1) 游客既不读取服务端收藏，也不能产生匿名本地收藏。
  {
    const h = harness({ token: '' })
    const store = loadStore(h)
    assert.deepStrictEqual(await store.load(), [])
    assert.strictEqual(h.getCalls, 0)
    await assert.rejects(store.setFavorite('L1', true), (error) => error && error.statusCode === 401)
    assert.strictEqual(h.setCalls.length, 0)
    assert.strictEqual(store.isFavorite('L1'), false)
  }

  // 2) 同 token 的并发加载合并；同房源同目标态重复操作只发一个请求，两个订阅者同步收到结果。
  {
    const get = deferred()
    const write = deferred()
    const h = harness({
      getFavoriteIds: () => get.promise,
      setFavorite: () => write.promise
    })
    const store = loadStore(h)
    let listenerOne = 0
    let listenerTwo = 0
    store.subscribe(() => { listenerOne += 1 })
    store.subscribe(() => { listenerTwo += 1 })
    const firstLoad = store.load()
    const secondLoad = store.load()
    assert.strictEqual(firstLoad, secondLoad, '同 token 的 in-flight GET 必须复用')
    assert.strictEqual(h.getCalls, 1)
    get.resolve([])
    await firstLoad

    const listenerOneBeforeWrite = listenerOne
    const listenerTwoBeforeWrite = listenerTwo

    const firstWrite = store.setFavorite('L1', true)
    const secondWrite = store.setFavorite('L1', true)
    assert.strictEqual(firstWrite, secondWrite, '同目标态重复点击必须复用请求')
    assert.strictEqual(store.isFavorite('L1'), true, '写入期间先乐观更新')
    await tick()
    assert.deepStrictEqual(h.setCalls, [{ listingId: 'L1', desired: true }])
    write.resolve({ listingId: 'L1', isFavorited: true })
    await firstWrite
    assert.strictEqual(store.isFavorite('L1'), true)
    assert.ok(listenerOne > listenerOneBeforeWrite && listenerTwo > listenerTwoBeforeWrite, '多个组件订阅者必须收到写入后的新增通知')
  }

  // 3) 写入失败只回滚本次乐观状态。
  {
    const h = harness({
      setFavorite: () => Promise.reject(new Error('synthetic-write-failure'))
    })
    const store = loadStore(h)
    await store.load()
    assert.strictEqual(store.isFavorite('L2'), false)
    await assert.rejects(store.setFavorite('L2', true), /synthetic-write-failure/)
    assert.strictEqual(store.isFavorite('L2'), false, '失败后必须恢复原状态')
  }

  // 4) 写入后的旧 GET 响应不得覆盖显式目标态（收藏与取消两个方向）。
  {
    const oldLoad = deferred()
    const h = harness({ getFavoriteIds: () => oldLoad.promise })
    const store = loadStore(h)
    const loading = store.load({ force: true })
    await store.setFavorite('L3', true)
    assert.strictEqual(store.isFavorite('L3'), true)
    oldLoad.resolve(['EXISTING'])
    await loading
    assert.strictEqual(store.isFavorite('L3'), true, '旧 GET 不得撤销已成功收藏')
    assert.strictEqual(store.isFavorite('EXISTING'), true, '丢弃旧 GET 时也不能漏掉账号原有的其他收藏')
  }
  {
    const oldLoad = deferred()
    let getIndex = 0
    const h = harness({
      getFavoriteIds: () => {
        getIndex += 1
        return getIndex === 1 ? Promise.resolve(['L4']) : oldLoad.promise
      }
    })
    const store = loadStore(h)
    await store.load()
    const loading = store.load({ force: true })
    await store.setFavorite('L4', false)
    oldLoad.resolve(['L4'])
    await loading
    assert.strictEqual(store.isFavorite('L4'), false, '旧 GET 不得恢复已成功取消的收藏')
  }

  // 5) token A 的迟到成功/失败在切到 token B 后都必须以 staleSession 拒绝，不能触发 B 的成功事件或回滚。
  {
    const writeA = deferred()
    const h = harness({ setFavorite: () => writeA.promise })
    const store = loadStore(h)
    await store.load()
    const requestA = store.setFavorite('L5', true)
    await tick()
    h.token = 'TOKEN_B'
    assert.strictEqual(store.isFavorite('L5'), false, '切换账号必须立即清空 A 的缓存')
    writeA.resolve({ listingId: 'L5', isFavorited: true })
    await assert.rejects(requestA, (error) => error && error.staleSession === true)
    assert.strictEqual(store.isFavorite('L5'), false)
  }
  {
    const writeA = deferred()
    const h = harness({ setFavorite: () => writeA.promise })
    const store = loadStore(h)
    await store.load()
    const requestA = store.setFavorite('L6', true)
    await tick()
    h.token = 'TOKEN_B'
    store.isFavorite('L6')
    writeA.reject(new Error('old-account-failure'))
    await assert.rejects(requestA, (error) => error && error.staleSession === true)
    assert.strictEqual(store.isFavorite('L6'), false)
  }

  // 6) token A/B 的 in-flight GET 必须隔离：B 发独立请求，A 迟到不能覆盖或清理 B。
  {
    const loadA = deferred()
    const loadB = deferred()
    const h = harness({
      getFavoriteIds: () => h.token === 'TOKEN_A' ? loadA.promise : loadB.promise
    })
    const store = loadStore(h)
    const requestA = store.load()
    h.token = 'TOKEN_B'
    const requestB = store.load()
    assert.notStrictEqual(requestA, requestB)
    assert.strictEqual(h.getCalls, 2, '切换 token 必须发独立 GET')
    loadB.resolve(['LB'])
    await requestB
    assert.strictEqual(store.isFavorite('LB'), true)
    loadA.resolve(['LA'])
    await assert.rejects(requestA, (error) => error && error.staleSession === true)
    assert.strictEqual(store.isFavorite('LB'), true, 'A 迟到不得覆盖 B')
    assert.strictEqual(store.isFavorite('LA'), false)
  }

  // 7) 两个组件排队提交相反目标且都失败时，必须回到最后确认的服务端状态，不能回到前一次乐观态。
  {
    const h = harness({ setFavorite: () => Promise.reject(new Error('synthetic-double-failure')) })
    const store = loadStore(h)
    await store.load()
    const add = store.setFavorite('L7', true)
    const remove = store.setFavorite('L7', false)
    await Promise.allSettled([add, remove])
    assert.strictEqual(store.isFavorite('L7'), false, '初始未收藏时双失败必须回到未收藏')
  }
  {
    const h = harness({
      getFavoriteIds: () => Promise.resolve(['L8']),
      setFavorite: () => Promise.reject(new Error('synthetic-double-failure'))
    })
    const store = loadStore(h)
    await store.load()
    const remove = store.setFavorite('L8', false)
    const add = store.setFavorite('L8', true)
    await Promise.allSettled([remove, add])
    assert.strictEqual(store.isFavorite('L8'), true, '初始已收藏时双失败必须回到已收藏')
  }

  console.log('favorite-store-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
