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

  // 5) commitDelta 增量回写：飞书同步在私有副本上跑完，只回写它真正改动的顶层键，保住 await
  //    窗口内并发 updateDb 落盘的无关键（成交/反馈等），不被整库回写覆盖——丢写回归锁。
  dbStore.writeDb({ listings: [{ id: 'L1', rent: 1000 }], dealRecords: [], feishuSyncLogs: [] })
  const base = dbStore.clone(dbStore.readDb())        // 同步开始前的不可变基线
  const syncCopy = dbStore.clone(base)                // 同步在私有副本上就地改
  syncCopy.listings.push({ id: 'L2', rent: 2000 })    // 同步新增房源
  syncCopy.feishuSyncLogs.unshift({ id: 'FS1' })      // 同步写日志
  // 模拟 await 窗口内并发用户写：一条成交记录经 updateDb 直接落盘（同步不碰 dealRecords）
  dbStore.updateDb((db) => { db.dealRecords.push({ id: 'DEAL1', amount: 8888 }) })
  dbStore.commitDelta(base, syncCopy)                 // 同步落盘走增量合并
  const merged = dbStore.readDb()
  assert.strictEqual(merged.listings.length, 2, 'commitDelta 必须回写同步真正改动的键（新增房源）')
  assert.strictEqual(merged.feishuSyncLogs.length, 1, 'commitDelta 必须回写同步写入的日志')
  assert.ok(
    merged.dealRecords.length === 1 && merged.dealRecords[0].id === 'DEAL1',
    'commitDelta 不得覆盖 await 窗口内并发落盘的成交记录（丢写回归锁）'
  )

  // 6) commitDelta 同键冲突：同步与并发写改同一顶层键时同步值胜出（与旧整库回写一致，无新增回退）。
  dbStore.writeDb({ counter: 1 })
  const base2 = dbStore.clone(dbStore.readDb())
  const syncCopy2 = dbStore.clone(base2)
  syncCopy2.counter = 100                             // 同步改 counter
  dbStore.updateDb((db) => { db.counter = 50 })       // 并发也改 counter
  dbStore.commitDelta(base2, syncCopy2)
  assert.strictEqual(dbStore.readDb().counter, 100, '同键冲突时同步值胜出（与旧整库回写行为一致）')

  // 7) 调用点契约：三处飞书同步必须走 clone 私有副本 + commitDelta 增量回写，而非把 clone 直接
  //    整库 writeDb（那会丢窗口内并发写）；助手快照必须 clone。锁住调用点本身，而不只是工具函数。
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
  const commitDeltaCount = (indexSource.match(/dbStore\.commitDelta\(/g) || []).length
  assert.ok(commitDeltaCount >= 3, `三处飞书同步路径都必须用 commitDelta 回写，实际命中 ${commitDeltaCount} 处`)
  assert.ok(
    !indexSource.includes('dbStore.writeDb(nextDb)'),
    '飞书同步不得再用 dbStore.writeDb(nextDb) 整库覆盖（会丢 await 窗口内并发写）'
  )
  assert.ok(
    indexSource.includes('const snapshot = dbStore.clone(db)'),
    '助手对话快照必须在 clone 的私有副本上跑'
  )
  assert.ok(
    indexSource.includes('已有飞书同步任务进行中'),
    '手动同步必须与定时同步互斥（并发全量同步会先后整库互抹）'
  )

  // 8) footprints 元素级合并：同步下架房源会往 footprints 追加下架留痕（footprints 成为“同步改过
  //    的键”）。此时窗口内并发落盘的用户足迹不得被同步的下架留痕整块覆盖——footprints 丢写回归锁。
  dbStore.writeDb({
    footprints: [{ id: 'F_OLD', action: '旧足迹' }],
    listings: [{ id: 'FL1', externalSource: 'feishu', status: '在租' }]
  })
  const fbBase = dbStore.clone(dbStore.readDb())
  const fbSync = dbStore.clone(fbBase)
  fbSync.listings[0].status = '已下架'                                   // 同步下架房源
  fbSync.footprints.unshift({ id: 'F_SYNCDOWN', action: '飞书同步下架' }) // 同步追加下架留痕
  dbStore.updateDb((db) => { db.footprints.unshift({ id: 'F_USERVIEW', action: '看房' }) }) // 并发用户足迹
  dbStore.commitDelta(fbBase, fbSync)
  const fbMerged = dbStore.readDb()
  const fbIds = fbMerged.footprints.map((item) => item.id)
  assert.ok(fbIds.includes('F_USERVIEW'), 'commitDelta 必须保住 await 窗口内并发落盘的用户足迹（footprints 丢写回归锁）')
  assert.ok(fbIds.includes('F_SYNCDOWN'), 'commitDelta 必须回写同步追加的下架足迹')
  assert.ok(fbIds.includes('F_OLD'), '原有足迹必须保留')
  assert.strictEqual(fbMerged.listings[0].status, '已下架', '同步对房源的下架改动必须落地')

  // 9) listings 元素级合并：同步只改自己的房源，窗口内并发成交确认改了另一套房源的状态。旧的整键
  //    覆盖会把整个 listings 换成同步版本、回滚并发成交状态（重现“成交记录与房源展示自相矛盾”）；
  //    元素级合并必须只覆盖同步动过的房源、保留并发改动的房源——跨键不一致回归锁。
  dbStore.writeDb({
    listings: [
      { id: 'FEISHU1', externalSource: 'feishu', status: '在租' },
      { id: 'PARTNER1', status: '在租' }
    ],
    dealRecords: []
  })
  const lsBase = dbStore.clone(dbStore.readDb())
  const lsSync = dbStore.clone(lsBase)
  lsSync.listings.find((item) => item.id === 'FEISHU1').syncedAt = 'sync-now' // 同步改动 FEISHU1
  dbStore.updateDb((db) => {                                                   // 并发确认成交，改 PARTNER1
    db.listings.find((item) => item.id === 'PARTNER1').status = '已成交'
    db.dealRecords.push({ id: 'DEAL1' })
  })
  dbStore.commitDelta(lsBase, lsSync)
  const lsMerged = dbStore.readDb()
  assert.strictEqual(
    lsMerged.listings.find((item) => item.id === 'PARTNER1').status, '已成交',
    '同步不得回滚窗口内并发成交确认对未同步房源的状态改动（跨键不一致回归锁）'
  )
  assert.strictEqual(
    lsMerged.listings.find((item) => item.id === 'FEISHU1').syncedAt, 'sync-now',
    '同步对自己房源的改动必须落地'
  )
  assert.ok(lsMerged.dealRecords.some((deal) => deal.id === 'DEAL1'), '并发成交记录必须保留')

  // 10) 同步改动的元素在落盘时已不在 fresh（并发删除，或被 slice 从数组挤出）：同步改动必须补回，
  //     不得因“只遍历 fresh + additions 仅收纯新增”而把同步数据丢掉。
  dbStore.writeDb({ listings: [{ id: 'LA', v: 'x' }, { id: 'LB', v: 'y' }] })
  const dbBase = dbStore.clone(dbStore.readDb())
  const dbSync = dbStore.clone(dbBase)
  dbSync.listings.find((item) => item.id === 'LA').v = 'SYNC-CHANGED'          // 同步改动 LA
  dbStore.updateDb((db) => { db.listings = db.listings.filter((item) => item.id !== 'LA') }) // 并发删除 LA
  dbStore.commitDelta(dbBase, dbSync)
  const dbMerged = dbStore.readDb()
  const la = dbMerged.listings.find((item) => item.id === 'LA')
  assert.ok(la && la.v === 'SYNC-CHANGED', '同步改动的元素即使已不在 fresh（并发删除/被截断）也必须落地（防丢同步数据）')

  // 11) 空基线边界：footprints 同步开始时为空，同步追加 1 条、窗口内并发也追加——空数组不得让
  //     commitDelta 退化成整键覆盖抹掉并发写。
  dbStore.writeDb({ footprints: [] })
  const ebBase = dbStore.clone(dbStore.readDb())
  const ebSync = dbStore.clone(ebBase)
  ebSync.footprints.unshift({ id: 'FS_SYNC', action: '同步追加' })
  dbStore.updateDb((db) => { db.footprints.unshift({ id: 'FS_USER', action: '用户足迹' }) })
  dbStore.commitDelta(ebBase, ebSync)
  const ebIds = dbStore.readDb().footprints.map((item) => item.id)
  assert.ok(ebIds.includes('FS_USER'), '空基线下同步追加不得抹掉窗口内并发写（空数组边界回归锁）')
  assert.ok(ebIds.includes('FS_SYNC'), '空基线下同步自己的追加也必须落地')

  console.log('db-cache-v1-test passed')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
