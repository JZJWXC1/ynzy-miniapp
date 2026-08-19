const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// 用独立临时数据文件，避免动到真实 db.json；必须在 require db.js（进而 config.js）之前设置。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-db-cache-'))
process.env.DATA_FILE = path.join(tempDir, 'db.json')
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'test-secret'

const dbStore = require('../src/db')
const domain = require('../src/domain')

try {
  dbStore.writeDb({ listings: [{ id: 'L1', rent: 1000 }], counter: 1 })

  // 1) 解析缓存命中但对外隔离：文件未变时连续 readDb 不重复读盘，但必须返回不同副本。
  const a = dbStore.readDb()
  const b = dbStore.readDb()
  assert.notStrictEqual(a, b, 'readDb 对外必须返回隔离副本，避免读路径污染共享缓存')
  a.listings[0].rent = 99999
  a.listings.push({ id: 'EVIL' })
  const cleanRead = dbStore.readDb()
  assert.strictEqual(cleanRead.listings[0].rent, 1000, 'readDb 返回对象上的字段改动不得污染后续读取')
  assert.strictEqual(cleanRead.listings.length, 1, 'readDb 返回对象上新增的元素不得污染后续读取')

  // 2) clone 隔离：在 clone 的私有副本上就地改动，绝不污染共享缓存。
  //    飞书同步与助手对话的长 await 路径正是靠这条隔离，避免并发读看到半成品状态。
  const snapshot = dbStore.clone(dbStore.readDb())
  snapshot.listings[0].rent = 99999
  snapshot.listings.push({ id: 'EVIL' })
  const after = dbStore.readDb()
  assert.strictEqual(after.listings[0].rent, 1000, 'clone 上的字段改动不得污染共享缓存')
  assert.strictEqual(after.listings.length, 1, 'clone 上新增的元素不得出现在缓存/后续读里')

  // 2.1) inspectDb 是只读临界区：回调内修改、回调返回后继续修改都不得污染解析缓存或磁盘；
  //      嵌套在 updateDb 内时也只能看见事务快照，不能借只读入口改动活动事务对象。
  dbStore.writeDb({ guard: { value: 1 }, counter: 1 })
  const inspected = dbStore.inspectDb((readonlyDb) => {
    readonlyDb.guard.value = 999
    return readonlyDb
  })
  assert.strictEqual(dbStore.readDb().guard.value, 1, 'inspectDb 回调内修改不得污染共享缓存或磁盘')
  inspected.guard.value = 777
  assert.strictEqual(dbStore.readDb().guard.value, 1, 'inspectDb 返回引用在锁释放后修改也不得污染共享状态')
  dbStore.updateDb((txDb) => {
    txDb.guard.value = 2
    const nestedInspected = dbStore.inspectDb((readonlyDb) => {
      assert.strictEqual(readonlyDb.guard.value, 2, '事务内 inspectDb 应看见当前事务快照')
      readonlyDb.guard.value = 888
      return readonlyDb
    })
    nestedInspected.guard.value = 666
    assert.strictEqual(txDb.guard.value, 2, '事务内 inspectDb 不得借回调或返回引用污染活动事务')
  })
  assert.strictEqual(dbStore.readDb().guard.value, 2, '事务自己的合法修改必须正常落盘')
  assert.throws(
    () => dbStore.inspectDb(async () => true),
    /同步只读回调/,
    'inspectDb 必须拒绝跨 await 的异步回调，避免伪装成仍持锁的临界区'
  )
  assert.throws(
    () => dbStore.inspectDb(() => { throw new Error('合成只读检查失败') }),
    /合成只读检查失败/
  )
  dbStore.updateDb((db) => { db.afterInspectError = true })
  assert.strictEqual(dbStore.readDb().afterInspectError, true, 'inspector 抛错后必须释放锁，后续写入仍可成功')

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

  // 4.1) 读路径副作用隔离：列表/地图会计算房态并可能在副本上触发自动下架，不能污染缓存后被无关写入带盘。
  const oldTime = new Date(Date.now() - 9 * 86400000).toISOString()
  dbStore.writeDb({
    counter: 0,
    footprints: [],
    listings: [{
      id: 'L_STALE_READ',
      title: '读路径陈旧房源',
      shortTitle: '读路径陈旧房源',
      uploaderId: 'U1',
      rent: 1000,
      layout: '整租一室',
      community: '读路径小区',
      address: '读路径地址',
      landlordPhone: '13800000000',
      videoUrl: 'https://example.com/read-path.mp4',
      status: '在租',
      lifecycleStatus: 'active',
      lastVerifiedAt: oldTime,
      createdAt: oldTime
    }]
  })
  domain.homeListings(dbStore.readDb())
  dbStore.updateDb((db) => { db.counter = 1 })
  const readSideEffectSafe = dbStore.readDb()
  assert.strictEqual(readSideEffectSafe.counter, 1, '无关写入应正常落盘')
  assert.strictEqual(readSideEffectSafe.listings[0].status, '在租', '读路径触发的自动下架不得污染缓存后被无关写入持久化')
  assert.strictEqual(readSideEffectSafe.footprints.length, 0, '读路径生成的留痕不得污染缓存后被无关写入持久化')

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

  // 7) 调用点契约：飞书同步已从三个进程内入口收敛到唯一持久化 worker，最终业务差量、提交标记
  //    和成功终态必须走同一把 DB 锁内的 commitDeltaChecked；助手快照仍必须 clone。
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'feishu-sync-worker.js'), 'utf8')
  assert.strictEqual(
    (workerSource.match(/commitDeltaChecked\(applyBase, nextDb,/g) || []).length,
    1,
    '飞书 worker 必须只有一个受租约与围栏保护的原子业务提交点'
  )
  assert.ok(
    !indexSource.includes('dbStore.writeDb(nextDb)'),
    '飞书同步不得再用 dbStore.writeDb(nextDb) 整库覆盖（会丢 await 窗口内并发写）'
  )
  assert.ok(
    indexSource.includes('const snapshot = dbStore.clone(db)'),
    '助手对话快照必须在 clone 的私有副本上跑'
  )
  assert.ok(
    indexSource.includes('feishuSyncWorker.enqueue({') &&
      indexSource.includes('startFeishuSyncWorkerProcess(queued.runId)'),
    '手动同步必须进入与定时同步共用的持久化 worker，不能另开进程内旁路'
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

  // 12) 同一元素被同步与并发同时改动（不同字段）：同步刷 syncedAt 使该房源成为“同步改过的元素”，
  //     窗口内并发确认成交改了同一房源的 status/lifecycleStatus。旧的“同步动过的元素整份胜出”会
  //     静默回滚并发的成交状态（成交记录说已成交、房源却被改回在租重新上架，自相矛盾）。必须按
  //     字段三方合并：只覆盖同步真正改动的字段（syncedAt/updatedAt），保留并发改动的字段——同一
  //     元素丢写回归锁。
  dbStore.writeDb({
    listings: [{ id: 'FEISHU2', externalSource: 'feishu', status: '在租', lifecycleStatus: 'active', syncedAt: 'T0', updatedAt: 'T0' }],
    dealRecords: []
  })
  const seBase = dbStore.clone(dbStore.readDb())
  const seSync = dbStore.clone(seBase)
  const seF = seSync.listings.find((item) => item.id === 'FEISHU2')
  seF.syncedAt = 'T1'  // attachFeishuFields 对已在租房源只刷元数据、不动 status —— 真实行为
  seF.updatedAt = 'T1'
  dbStore.updateDb((db) => {                                    // 并发确认成交，改同一房源 FEISHU2
    const f = db.listings.find((item) => item.id === 'FEISHU2')
    f.status = '已成交'
    f.lifecycleStatus = 'sold'
    db.dealRecords.push({ id: 'DEAL2', listingId: 'FEISHU2' })
  })
  dbStore.commitDelta(seBase, seSync)
  const seResult = dbStore.readDb().listings.find((item) => item.id === 'FEISHU2')
  assert.strictEqual(seResult.status, '已成交', '同步刷元数据不得回滚窗口内并发对同一房源的成交状态（同元素丢写回归锁）')
  assert.strictEqual(seResult.lifecycleStatus, 'sold', '同步不得回滚窗口内并发对同一房源的生命周期状态')
  assert.strictEqual(seResult.syncedAt, 'T1', '同步对该房源真正改动的字段（syncedAt）必须落地')

  // 13) 同字段状态冲突：同步认为飞书房源应下架，同时窗口内并发成交确认已把同一房源置为
  //     已成交/sold。成交/签单是业务终态，优先级必须高于同步下架；否则会出现成交记录存在、
  //     房源却被同步改进资产池的矛盾状态。同步自己的非状态元数据仍应落地。
  dbStore.writeDb({
    listings: [{ id: 'FEISHU3', externalSource: 'feishu', status: '在租', lifecycleStatus: 'active', syncedAt: 'T0' }],
    dealRecords: []
  })
  const scBase = dbStore.clone(dbStore.readDb())
  const scSync = dbStore.clone(scBase)
  const scListing = scSync.listings.find((item) => item.id === 'FEISHU3')
  scListing.status = '已下架'
  scListing.lifecycleStatus = 'expired'
  scListing.expiredAt = 'SYNC-DOWN'
  scListing.expiredReason = '飞书同步下架'
  scListing.syncedAt = 'T2'
  dbStore.updateDb((db) => {
    const f = db.listings.find((item) => item.id === 'FEISHU3')
    f.status = '已成交'
    f.lifecycleStatus = 'sold'
    db.dealRecords.push({ id: 'DEAL3', listingId: 'FEISHU3' })
  })
  dbStore.commitDelta(scBase, scSync)
  const scResult = dbStore.readDb().listings.find((item) => item.id === 'FEISHU3')
  assert.strictEqual(scResult.status, '已成交', '并发成交终态必须优先于同步下架状态')
  assert.strictEqual(scResult.lifecycleStatus, 'sold', '并发成交生命周期必须优先于同步 expired')
  assert.strictEqual(scResult.expiredAt, undefined, '成交终态胜出时不得残留同步下架时间')
  assert.strictEqual(scResult.expiredReason, undefined, '成交终态胜出时不得残留同步下架原因')
  assert.strictEqual(scResult.syncedAt, 'T2', '状态裁决不应阻止同步元数据落地')

  // 13b) 同步准备把此前下架房源重新发布时，若 await 窗口内人工确认成交，成交终态必须
  //      连同不可见开关一起胜出；不能出现“状态已成交，但 published/enabled 又被同步打开”的矛盾房源。
  dbStore.writeDb({
    listings: [{
      id: 'FEISHU4',
      externalSource: 'feishu',
      status: '已下架',
      listingStatus: '已下架',
      lifecycleStatus: 'expired',
      lifecycleStatusText: '已下架',
      published: false,
      enabled: false,
      syncedAt: 'T0'
    }],
    dealRecords: []
  })
  const reopenBase = dbStore.clone(dbStore.readDb())
  const reopenSync = dbStore.clone(reopenBase)
  Object.assign(reopenSync.listings[0], {
    status: '在租',
    listingStatus: '待出租',
    lifecycleStatus: 'active',
    lifecycleStatusText: '待出租',
    published: true,
    enabled: true,
    syncedAt: 'T3'
  })
  dbStore.updateDb((db) => {
    const listing = db.listings.find((item) => item.id === 'FEISHU4')
    Object.assign(listing, {
      status: '已成交',
      listingStatus: '已出租',
      lifecycleStatus: 'sold',
      lifecycleStatusText: '已出租',
      published: false,
      enabled: false
    })
    db.dealRecords.push({ id: 'DEAL4', listingId: 'FEISHU4' })
  })
  dbStore.commitDelta(reopenBase, reopenSync)
  const reopenResult = dbStore.readDb().listings.find((item) => item.id === 'FEISHU4')
  assert.strictEqual(reopenResult.status, '已成交', '并发成交终态不得被同步重新上架覆盖')
  assert.strictEqual(reopenResult.lifecycleStatus, 'sold', '并发成交生命周期不得被同步恢复为 active')
  assert.strictEqual(reopenResult.published, false, '并发成交后 published 必须保持关闭')
  assert.strictEqual(reopenResult.enabled, false, '并发成交后 enabled 必须保持关闭')
  assert.strictEqual(reopenResult.syncedAt, 'T3', '终态可见性保护不应阻止同步元数据落地')

  // 14) 后台同步最终提交必须在同一把数据库文件锁内验证 lease/fence。若旧 worker 的
  //     fence 已被新 worker 替换，任何业务改动和提交标记都不得落盘；验证通过时仍复用
  //     commitDelta 的三方合并语义，保住窗口内并发写。
  dbStore.writeDb({
    counter: 0,
    listings: [{ id: 'LEASE-L1', rent: 1000 }],
    feishuSyncScheduler: { lease: { ownerNonce: 'owner-new', fence: 8 } },
    feishuSyncCommitMarkers: []
  })
  const leaseBase = dbStore.clone(dbStore.readDb())
  const leaseSync = dbStore.clone(leaseBase)
  leaseSync.listings[0].rent = 2000
  leaseSync.feishuSyncCommitMarkers.push({ id: 'RUN-OLD', fence: 7 })
  assert.throws(
    () => dbStore.commitDeltaChecked(leaseBase, leaseSync, (freshDb) => {
      const lease = freshDb.feishuSyncScheduler && freshDb.feishuSyncScheduler.lease
      return Boolean(lease && lease.ownerNonce === 'owner-old' && lease.fence === 7)
    }),
    (error) => error && error.code === 'DB_COMMIT_GUARD_REJECTED',
    '旧 fence 必须在同一数据库临界区被拒绝'
  )
  assert.strictEqual(dbStore.readDb().listings[0].rent, 1000, 'guard 拒绝后业务数据不得部分落盘')
  assert.strictEqual(dbStore.readDb().feishuSyncCommitMarkers.length, 0, 'guard 拒绝后提交标记不得落盘')

  const currentBase = dbStore.clone(dbStore.readDb())
  const currentSync = dbStore.clone(currentBase)
  currentSync.listings[0].rent = 3000
  currentSync.feishuSyncCommitMarkers.push({ id: 'RUN-NEW', fence: 8 })
  dbStore.updateDb((db) => { db.concurrentAudit = [{ id: 'AUDIT-1' }] })
  dbStore.commitDeltaChecked(currentBase, currentSync, (freshDb) => {
    const lease = freshDb.feishuSyncScheduler && freshDb.feishuSyncScheduler.lease
    return Boolean(lease && lease.ownerNonce === 'owner-new' && lease.fence === 8)
  })
  const guardedMerged = dbStore.readDb()
  assert.strictEqual(guardedMerged.listings[0].rent, 3000, '当前 fence 通过后同步业务数据必须落盘')
  assert.ok(guardedMerged.feishuSyncCommitMarkers.some((item) => item.id === 'RUN-NEW'), '当前 fence 的提交标记必须与业务数据同次落盘')
  assert.ok(guardedMerged.concurrentAudit.some((item) => item.id === 'AUDIT-1'), '受 guard 的增量提交仍须保留无关并发写')

  // 15) worker 对象契约必须把业务增量、提交标记与任务终态放进同一锁事务。
  dbStore.writeDb({
    listings: [{ id: 'WORKER-L1', rent: 1000 }],
    feishuSyncRuns: [{
      runId: 'RUN-ATOMIC',
      state: 'committing',
      lease: { owner: 'worker-1', fence: 12 }
    }],
    feishuSyncCommitMarkers: {},
    concurrentAudit: [{ id: 'AUDIT-2' }]
  })
  const atomicBase = { listings: [{ id: 'WORKER-L1', rent: 1000 }] }
  const atomicNext = { listings: [{ id: 'WORKER-L1', rent: 3600 }] }
  const markerBody = {
    runId: 'RUN-ATOMIC',
    fence: 12,
    schemaSha256: '1'.repeat(64),
    mirrorPlanSha256: '2'.repeat(64),
    contentPlanSha256: '3'.repeat(64),
    contentPlanAssetCount: 4,
    committedAt: 1800000000000
  }
  const atomicMarker = {
    ...markerBody,
    markerSha256: crypto.createHash('sha256').update(JSON.stringify(markerBody)).digest('hex')
  }
  const atomicResult = dbStore.commitDeltaChecked(atomicBase, atomicNext, {
    runId: 'RUN-ATOMIC',
    workerId: 'worker-1',
    fence: 12,
    excludedTopLevelKeys: ['feishuSyncRuns', 'feishuSyncCommitMarkers'],
    commitMarker: atomicMarker,
    finalize(freshDb) {
      const run = freshDb.feishuSyncRuns.find((item) => item.runId === 'RUN-ATOMIC')
      assert.strictEqual(freshDb.feishuSyncCommitMarkers['RUN-ATOMIC'].markerSha256, atomicMarker.markerSha256)
      run.state = 'succeeded'
      run.lease = null
    }
  })
  assert.strictEqual(atomicResult.committed, true, '对象契约成功后必须返回已提交证据')
  const atomicDb = dbStore.readDb()
  assert.strictEqual(atomicDb.listings[0].rent, 3600, '业务增量必须落盘')
  assert.strictEqual(atomicDb.feishuSyncRuns[0].state, 'succeeded', '任务终态必须与业务增量同次落盘')
  assert.strictEqual(atomicDb.feishuSyncCommitMarkers['RUN-ATOMIC'].markerSha256, atomicMarker.markerSha256, '提交标记必须同次落盘')
  assert.ok(atomicDb.concurrentAudit.some((item) => item.id === 'AUDIT-2'), '对象契约也必须保留无关并发写')

  const rejectedNext = { listings: [{ id: 'WORKER-L1', rent: 9999 }] }
  assert.throws(
    () => dbStore.commitDeltaChecked(atomicBase, rejectedNext, {
      runId: 'RUN-ATOMIC',
      workerId: 'worker-old',
      fence: 11,
      excludedTopLevelKeys: ['feishuSyncRuns', 'feishuSyncCommitMarkers'],
      commitMarker: { ...atomicMarker, fence: 11 },
      finalize() { throw new Error('旧 fence 不得进入 finalize') }
    }),
    (error) => error && error.code === 'DB_COMMIT_GUARD_REJECTED',
    '旧 owner/fence 必须在业务增量前被拒绝'
  )
  assert.strictEqual(dbStore.readDb().listings[0].rent, 3600, '旧 fence 拒绝后不得产生任何业务变化')

  console.log('db-cache-v1-test passed')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
