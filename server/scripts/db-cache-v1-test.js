const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 用独立临时数据文件，避免动到真实 db.json；必须在 require db.js（进而 config.js）之前设置。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-db-cache-'))
process.env.DATA_FILE = path.join(tempDir, 'db.json')
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'test-secret'

const dbStore = require('../src/db')

try {
  dbStore.writeDb({ listings: [{ id: 'L1', rent: 1000 }], counter: 1 })

  // 1) 解析缓存命中：文件未变时连续 readDb 返回同一引用（缓存的设计前提）。
  const a = dbStore.readDb()
  const b = dbStore.readDb()
  assert.strictEqual(a, b, '文件未变时 readDb 应命中缓存返回同一对象')

  // 2) clone 隔离：在 clone 的私有副本上就地改动，绝不污染共享缓存。
  //    飞书同步与助手对话的长 await 路径正是靠这条隔离，避免并发读看到半成品状态。
  const snapshot = dbStore.clone(dbStore.readDb())
  snapshot.listings[0].rent = 99999
  snapshot.listings.push({ id: 'EVIL' })
  const after = dbStore.readDb()
  assert.strictEqual(after.listings[0].rent, 1000, 'clone 上的字段改动不得污染共享缓存')
  assert.strictEqual(after.listings.length, 1, 'clone 上新增的元素不得出现在缓存/后续读里')

  // 3) 写后缓存刷新：writeDb / updateDb 后 readDb 必须反映最新数据。
  dbStore.updateDb((db) => { db.counter = 2 })
  assert.strictEqual(dbStore.readDb().counter, 2, 'writeDb 后 readDb 必须反映最新数据')

  // 4) mutator 抛异常回滚：失效缓存，磁盘与后续读保持写入前的值。
  let threw = false
  try {
    dbStore.updateDb((db) => { db.counter = 999; throw new Error('boom') })
  } catch (error) {
    threw = true
  }
  assert.ok(threw, 'updateDb 的 mutator 抛异常必须向上传播')
  assert.strictEqual(dbStore.readDb().counter, 2, 'updateDb 抛异常后必须回滚，磁盘/缓存保持写入前的值')

  console.log('db-cache-v1-test passed')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
