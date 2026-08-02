const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  STATES,
  createFeishuSyncWorker
} = require('../src/feishu-sync-worker')

const SHA = Object.freeze({
  schema: '1'.repeat(64),
  resource: '4'.repeat(64),
  mirror: '2'.repeat(64),
  content: '3'.repeat(64)
})

const SAFE_SCHEMA_BINDINGS = Object.freeze([
  {
    role: 'source',
    bindings: [{ semantic: 'community', fieldName: '板块/商圈', type: 1 }]
  },
  {
    role: 'location',
    bindings: [{ semantic: 'community', fieldName: '板块/商圈', type: 1 }]
  },
  {
    role: 'mini',
    bindings: [{ semantic: 'community', fieldName: '板块/商圈', type: 1 }]
  }
])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

function createStore(seed = {}) {
  let db = clone({ listings: [], ...seed })
  return {
    readDb() {
      return clone(db)
    },
    updateDb(mutator) {
      const working = clone(db)
      const result = mutator(working)
      if (result && typeof result.then === 'function') {
        throw new Error('测试数据库事务只允许同步回调')
      }
      db = working
      return result
    },
    snapshot() {
      return clone(db)
    }
  }
}

function createCommitDeltaChecked(store, calls = []) {
  return async (baseDb, nextDb, options) => store.updateDb((freshDb) => {
    const run = (freshDb.feishuSyncRuns || []).find((item) => item.runId === options.runId)
    assert.ok(run, '提交时任务必须仍存在')
    assert.strictEqual(run.lease.owner, options.workerId, '提交必须校验当前 lease owner')
    assert.strictEqual(run.lease.fence, options.fence, '提交必须校验当前 fence')

    // 测试桩只模拟业务字段的受检增量提交；控制字段由 finalize 在同一事务内收口。
    freshDb.listings = clone(nextDb.listings || [])
    freshDb.companySheetSnapshot = clone(nextDb.companySheetSnapshot || null)
    freshDb.feishuSyncLogs = clone(nextDb.feishuSyncLogs || [])
    freshDb.feishuSyncCommitMarkers = freshDb.feishuSyncCommitMarkers || {}
    freshDb.feishuSyncCommitMarkers[options.runId] = clone(options.commitMarker)
    options.finalize(freshDb)
    calls.push({ runId: options.runId, marker: clone(options.commitMarker) })
    return { committed: true, marker: clone(options.commitMarker) }
  })
}

function dryResult(patch = {}) {
  return {
    success: true,
    complete: true,
    dryRun: true,
    failed: 0,
    mirrorPlanSha256: SHA.mirror,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 4,
    schemaBindings: clone(SAFE_SCHEMA_BINDINGS),
    ...patch
  }
}

function testCommitMarker(run, patch = {}) {
  const body = {
    runId: run.runId,
    fence: Number(run.lease && run.lease.fence || run.lastFence),
    schemaSha256: run.schemaSha256,
    resourceIdentitySha256: run.resourceIdentitySha256,
    mirrorPlanSha256: run.mirrorPlanSha256,
    contentPlanSha256: run.contentPlanSha256,
    contentPlanAssetCount: run.contentPlanAssetCount,
    committedAt: 1_799_999_990_000,
    ...patch
  }
  return {
    ...body,
    markerSha256: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
  }
}

function applyResult(patch = {}) {
  return {
    success: true,
    complete: true,
    dryRun: false,
    failed: 0,
    inventoryCommittable: true,
    mirrorPlanSha256: SHA.mirror,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 4,
    ...patch
  }
}

function committableMaterialWarningResult(patch = {}) {
  return applyResult({
    success: false,
    complete: false,
    published: false,
    validated: true,
    planned: true,
    failed: 2,
    inventoryCommittable: true,
    inventoryPublished: true,
    status: 'inventory-published-materials-failed',
    noteMaterials: {
      complete: false,
      published: false,
      dryRun: false,
      failed: 2,
      rows: [
        {
          sourceRecordId: 'source-row-1',
          status: 'failed',
          deferred: true,
          sourceValueFingerprint: 'a'.repeat(64),
          sourceLinkFingerprint: 'c'.repeat(64),
          deferredAction: 'clear',
          mediaStateFingerprint: 'e'.repeat(64),
          physicalUnitFingerprint: 'f'.repeat(64),
          error: 'private material error 1'
        },
        {
          sourceRecordId: 'source-row-2',
          status: 'retained-temporary-failure',
          deferred: true,
          sourceValueFingerprint: 'b'.repeat(64),
          sourceLinkFingerprint: 'd'.repeat(64),
          deferredAction: 'retain',
          mediaStateFingerprint: '1'.repeat(64),
          physicalUnitFingerprint: '2'.repeat(64),
          error: 'private material error 2'
        }
      ]
    },
    ...patch
  })
}

function dryMaterialWarningResult(patch = {}) {
  return dryResult({
    success: false,
    complete: false,
    published: false,
    validated: true,
    planned: true,
    failed: 2,
    inventoryCommittable: false,
    inventoryPublished: false,
    status: 'inventory-validated-materials-failed',
    noteMaterials: {
      complete: false,
      published: false,
      dryRun: true,
      failed: 2,
      rows: [
        {
          sourceRecordId: 'source-row-1',
          status: 'failed',
          deferred: true,
          sourceValueFingerprint: 'a'.repeat(64),
          sourceLinkFingerprint: 'c'.repeat(64),
          deferredAction: 'clear',
          mediaStateFingerprint: 'e'.repeat(64),
          physicalUnitFingerprint: 'f'.repeat(64),
          error: 'private dry material error 1'
        },
        {
          sourceRecordId: 'source-row-2',
          status: 'retained-temporary-failure',
          deferred: true,
          sourceValueFingerprint: 'b'.repeat(64),
          sourceLinkFingerprint: 'd'.repeat(64),
          deferredAction: 'retain',
          mediaStateFingerprint: '1'.repeat(64),
          physicalUnitFingerprint: '2'.repeat(64),
          error: 'private dry material error 2'
        },
        { sourceRecordId: 'source-row-3', status: 'planned' }
      ]
    },
    ...patch
  })
}

function makeWorker({
  store = createStore(),
  sync,
  now = () => 1_800_000_000_000,
  ids = [],
  leaseMs = 60_000,
  maxRuns = 50,
  commitCalls = [],
  approvedSchemaSha256 = SHA.schema,
  approvedResourceIdentitySha256 = SHA.resource,
  commitDeltaChecked,
  writeLockEnabled = true,
  heartbeat = false,
  setInterval: setIntervalFn,
  clearInterval: clearIntervalFn
} = {}) {
  let idIndex = 0
  return {
    store,
    commitCalls,
    worker: createFeishuSyncWorker({
      dbStore: store,
      feishuSync: { sync },
      commitDeltaChecked: commitDeltaChecked || createCommitDeltaChecked(store, commitCalls),
      config: {
        approvedSchemaSha256,
        approvedResourceIdentitySha256,
        intervalMinutes: 30,
        leaseMs,
        maxRuns
      },
      now,
      writeLockEnabled,
      randomId: (prefix) => `${prefix}-${ids[idIndex++] || `id${idIndex}`}`,
      heartbeat,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn
    })
  }
}

async function testDbWriteLockIsMandatoryBeforeAnyMutation() {
  const store = createStore({ sentinel: { untouched: true } })
  let syncCalls = 0
  let lockEnabled = false
  const { worker } = makeWorker({
    store,
    writeLockEnabled: () => lockEnabled,
    sync: async () => {
      syncCalls += 1
      return dryResult()
    }
  })
  const before = store.snapshot()
  assert.throws(
    () => worker.enqueue({ trigger: 'manual' }),
    (error) => error && error.code === 'DB_WRITE_LOCK_REQUIRED'
  )
  assert.throws(
    () => worker.recover(),
    (error) => error && error.code === 'DB_WRITE_LOCK_REQUIRED'
  )
  await assert.rejects(
    worker.run('feishu-sync-write-lock-disabled', { workerId: 'unsafe-worker' }),
    (error) => error && error.code === 'DB_WRITE_LOCK_REQUIRED'
  )
  await assert.rejects(
    worker.tick({ workerId: 'unsafe-timer' }),
    (error) => error && error.code === 'DB_WRITE_LOCK_REQUIRED'
  )
  assert.deepStrictEqual(store.snapshot(), before, '写锁关闭时不得落队列、恢复状态或写任意控制字段')
  assert.strictEqual(syncCalls, 0)
  assert.strictEqual(worker.getStatus().scheduler.writeLockEnabled, false)

  lockEnabled = true
  assert.strictEqual(worker.getStatus().scheduler.writeLockEnabled, true)
  const queued = worker.enqueue({ trigger: 'manual', dryRun: true })
  assert.strictEqual((await worker.run(queued.runId, { workerId: 'locked-worker' })).state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(syncCalls, 1, '函数形式的真实写锁状态为 true 时才允许进入同步')
}

async function testManualDryOnlyDoesNotNeedApprovalOrApply() {
  let syncCalls = 0
  const { worker, store, commitCalls } = makeWorker({
    ids: ['run-dry-only'],
    approvedSchemaSha256: '',
    approvedResourceIdentitySha256: '',
    sync: async (db, actorId, options) => {
      syncCalls += 1
      assert.strictEqual(options.dryRun, true, '只预演任务不得进入正式调用')
      return dryResult()
    }
  })
  const queued = worker.enqueue({ trigger: 'manual', dryRun: true })
  const completed = await worker.run(queued.runId, { workerId: 'worker-dry-only' })
  assert.strictEqual(completed.state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(completed.dryRun, true)
  assert.strictEqual(completed.externalWritesMayHaveOccurred, false)
  assert.strictEqual(completed.schemaSha256, SHA.schema)
  assert.strictEqual(completed.resourceIdentitySha256, SHA.resource)
  assert.strictEqual(completed.mirrorPlanSha256, SHA.mirror)
  assert.strictEqual(completed.contentPlanSha256, SHA.content)
  assert.deepStrictEqual(completed.schemaBindings, [
    { role: 'source', semantic: 'community', fieldName: '板块/商圈', type: 1 },
    { role: 'location', semantic: 'community', fieldName: '板块/商圈', type: 1 },
    { role: 'mini', semantic: 'community', fieldName: '板块/商圈', type: 1 }
  ])
  assert.strictEqual(syncCalls, 1)
  assert.strictEqual(commitCalls.length, 0, '只预演不得进入本地业务提交')
  assert.deepStrictEqual(store.snapshot().listings, [])
}

async function testSuccessIsAtomicAndReturnsExpectedDigests() {
  const calls = []
  const { worker, store, commitCalls } = makeWorker({
    ids: ['run-success'],
    sync: async (db, actorId, options) => {
      calls.push({ actorId, options: clone(options) })
      if (options.dryRun) return dryResult()
      assert.strictEqual(
        store.snapshot().feishuSyncRuns[0].externalWritesMayHaveOccurred,
        true,
        '任何正式调用前必须先持久化外部写入可能已发生'
      )
      assert.strictEqual(options.expectedSchemaSha256, SHA.schema)
      assert.strictEqual(options.expectedResourceIdentitySha256, SHA.resource)
      assert.strictEqual(options.expectedMirrorPlanSha256, SHA.mirror)
      assert.strictEqual(options.expectedContentPlanSha256, SHA.content)
      assert.strictEqual(options.expectedContentAssetCount, 4)
      db.listings = [{ id: 'L-1', title: '公开房源' }]
      db.companySheetSnapshot = { schemaVersion: 2, rowCount: 1 }
      return applyResult()
    }
  })

  const queued = worker.enqueue({ trigger: 'manual', actorId: 'admin-1' })
  const completed = await worker.run(queued.runId, { workerId: 'worker-a' })
  assert.strictEqual(completed.state, STATES.SUCCEEDED)
  assert.strictEqual(calls.length, 2, '成功链路必须且只允许一次 dry 与一次 apply')
  assert.strictEqual(calls[0].options.dryRun, true)
  assert.strictEqual(calls[1].options.dryRun, false)
  calls.forEach((call) => {
    assert.strictEqual(call.options.syncController, 'worker-v2', '正式 worker 必须标识唯一控制器')
    assert.strictEqual(
      call.options.disableLegacyMaterials,
      true,
      '正式 worker 必须禁用旧素材目录的随机上传链，只使用房源笔记确定性管线'
    )
  })
  assert.strictEqual(commitCalls.length, 1, '业务数据、提交标记与终态必须一次原子提交')

  const db = store.snapshot()
  assert.deepStrictEqual(db.listings, [{ id: 'L-1', title: '公开房源' }])
  assert.ok(db.feishuSyncCommitMarkers[queued.runId], '成功任务必须留下提交标记')
  assert.strictEqual(db.feishuSyncRuns[0].state, STATES.SUCCEEDED)
  assert.strictEqual(db.feishuSyncRuns[0].externalWritesMayHaveOccurred, true)
  assert.strictEqual(db.feishuSyncRuns[0].actorId, 'admin-1', '内部任务必须持久化已认证发起人')
  assert.ok(calls.every((call) => call.actorId === 'admin-1'), 'dry/apply 必须使用同一持久发起人')
  assert.ok(!JSON.stringify(worker.getStatus()).includes('admin-1'), '公共任务状态不得输出内部发起人身份')
}

async function testCommittableInventoryWithKnownMaterialFailuresCommitsWithWarning() {
  let syncCalls = 0
  const { worker, store, commitCalls } = makeWorker({
    ids: ['run-material-warning'],
    sync: async (db, actorId, options) => {
      syncCalls += 1
      if (options.dryRun) return dryResult()
      db.listings = [{ id: 'L-MATERIAL-WARNING', mediaAssets: [] }]
      db.companySheetSnapshot = { schemaVersion: 2, rowCount: 1 }
      return committableMaterialWarningResult()
    }
  })

  const queued = worker.enqueue({ trigger: 'manual', actorId: 'admin-material-warning' })
  const completed = await worker.run(queued.runId, { workerId: 'worker-material-warning' })
  assert.strictEqual(
    completed.state,
    STATES.SUCCEEDED,
    '库存与首页快照已明确可提交时，逐行素材失败不得误判为 UNKNOWN'
  )
  assert.strictEqual(completed.errorCode, 'MATERIALS_PARTIAL_FAILURE')
  assert.strictEqual(completed.message, '库存与首页快照已提交，部分房源素材同步失败')
  assert.strictEqual(completed.result.success, false)
  assert.strictEqual(completed.result.complete, false)
  assert.strictEqual(completed.result.failed, 2, '公共结果必须保留素材失败计数')
  assert.strictEqual(commitCalls.length, 1, '可提交的库存、快照和逐行素材状态必须原子落库')
  assert.deepStrictEqual(store.snapshot().listings, [{ id: 'L-MATERIAL-WARNING', mediaAssets: [] }])
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, '')
  assert.strictEqual(store.snapshot().feishuSyncScheduler.activeLease, null)
  assert.strictEqual(
    Number(store.snapshot().feishuSyncScheduler.lastSuccessAt || 0),
    0,
    '部分素材告警不得刷新最近一次完整成功时间'
  )
  assert.ok(Number(store.snapshot().feishuSyncScheduler.lastWarningAt) > 0)
  assert.ok(!JSON.stringify(completed).includes('source-row-1'), '公共状态不得泄露素材源记录标识')
  assert.ok(!JSON.stringify(completed).includes('private material error'), '公共状态不得泄露逐行原始错误')

  const replayed = await worker.run(queued.runId, { workerId: 'worker-material-warning-replay' })
  assert.strictEqual(replayed.state, STATES.SUCCEEDED)
  assert.strictEqual(syncCalls, 2, '告警成功终态不得重复执行 dry-run 或正式同步')
  assert.strictEqual(commitCalls.length, 1, '告警成功终态不得重复提交')
}

async function testDryMaterialWarningContinuesToApplyAndAtomicCommit() {
  const calls = []
  const { worker, store, commitCalls } = makeWorker({
    ids: ['run-dry-material-warning'],
    sync: async (db, actorId, options) => {
      calls.push({ actorId, options: clone(options) })
      if (options.dryRun) return dryMaterialWarningResult()
      db.listings = [{ id: 'L-DRY-MATERIAL-WARNING', mediaAssets: [] }]
      db.companySheetSnapshot = { schemaVersion: 2, rowCount: 1 }
      return committableMaterialWarningResult()
    }
  })

  const queued = worker.enqueue({ trigger: 'manual', actorId: 'admin-dry-material-warning' })
  const completed = await worker.run(queued.runId, { workerId: 'worker-dry-material-warning' })
  assert.strictEqual(completed.state, STATES.SUCCEEDED)
  assert.strictEqual(completed.errorCode, 'MATERIALS_PARTIAL_FAILURE')
  assert.strictEqual(completed.result.failed, 2)
  assert.strictEqual(calls.length, 2, '受控 dry 素材告警必须继续一次 apply，且不得重复调用')
  assert.strictEqual(calls[0].options.dryRun, true)
  assert.strictEqual(calls[1].options.dryRun, false)
  assert.strictEqual(calls[1].options.expectedSchemaSha256, SHA.schema)
  assert.strictEqual(calls[1].options.expectedResourceIdentitySha256, SHA.resource)
  assert.strictEqual(calls[1].options.expectedMirrorPlanSha256, SHA.mirror)
  assert.strictEqual(calls[1].options.expectedContentPlanSha256, SHA.content)
  assert.strictEqual(calls[1].options.expectedContentAssetCount, 4)
  assert.strictEqual(commitCalls.length, 1)
  assert.deepStrictEqual(store.snapshot().listings, [{ id: 'L-DRY-MATERIAL-WARNING', mediaAssets: [] }])
  assert.strictEqual(store.snapshot().feishuSyncRuns[0].dryResultSummary.failed, 2)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, '')
}

async function testDryMaterialWarningRejectsGlobalFailureAndApprovedDigestDrift() {
  let globalApplyCalls = 0
  const globalFailure = makeWorker({
    ids: ['run-dry-global-material-failure'],
    sync: async (db, actorId, options) => {
      if (!options.dryRun) globalApplyCalls += 1
      return dryMaterialWarningResult({
        failed: 1,
        noteMaterials: {
          complete: false,
          published: false,
          dryRun: true,
          failed: 1,
          status: 'pipeline-failed',
          rows: [{ status: 'failed', error: 'unknown dry material failure' }]
        }
      })
    }
  })
  const globalQueued = globalFailure.worker.enqueue({ trigger: 'manual' })
  const globalCompleted = await globalFailure.worker.run(globalQueued.runId, {
    workerId: 'worker-dry-global-material-failure'
  })
  assert.strictEqual(globalCompleted.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(globalCompleted.errorCode, 'DRY_RUN_NOT_COMPLETE')
  assert.strictEqual(globalCompleted.externalWritesMayHaveOccurred, false)
  assert.strictEqual(globalApplyCalls, 0)
  assert.strictEqual(globalFailure.commitCalls.length, 0)

  let driftApplyCalls = 0
  const digestDrift = makeWorker({
    ids: ['run-dry-material-warning-digest-drift'],
    sync: async (db, actorId, options) => {
      if (!options.dryRun) driftApplyCalls += 1
      return dryMaterialWarningResult({ resourceIdentitySha256: '8'.repeat(64) })
    }
  })
  const driftQueued = digestDrift.worker.enqueue({ trigger: 'manual' })
  const driftCompleted = await digestDrift.worker.run(driftQueued.runId, {
    workerId: 'worker-dry-material-warning-digest-drift'
  })
  assert.strictEqual(driftCompleted.state, STATES.BLOCKED)
  assert.strictEqual(driftCompleted.errorCode, 'RESOURCE_IDENTITY_MISMATCH')
  assert.strictEqual(driftCompleted.externalWritesMayHaveOccurred, false)
  assert.strictEqual(driftApplyCalls, 0)
  assert.strictEqual(digestDrift.commitCalls.length, 0)
}

async function testCommittableWarningStillRejectsUnknownFailureAndDigestDrift() {
  const globalFailure = makeWorker({
    ids: ['run-global-material-failure'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      db.listings = [{ id: 'MUST-NOT-COMMIT-GLOBAL-FAILURE' }]
      return committableMaterialWarningResult({
        failed: 1,
        noteMaterials: {
          complete: false,
          published: false,
          dryRun: false,
          failed: 1,
          status: 'pipeline-failed',
          rows: [{ status: 'failed', error: 'unknown remote write state' }]
        }
      })
    }
  })
  const globalQueued = globalFailure.worker.enqueue({ trigger: 'manual' })
  const globalCompleted = await globalFailure.worker.run(globalQueued.runId, {
    workerId: 'worker-global-material-failure'
  })
  assert.strictEqual(globalCompleted.state, STATES.UNKNOWN, '全局素材管线失败仍须保持 UNKNOWN')
  assert.strictEqual(globalCompleted.errorCode, 'APPLY_RESULT_NOT_COMPLETE')
  assert.strictEqual(globalFailure.commitCalls.length, 0)
  assert.deepStrictEqual(globalFailure.store.snapshot().listings, [])
  assert.strictEqual(globalFailure.store.snapshot().feishuSyncScheduler.blockedRunId, globalQueued.runId)

  const digestDrift = makeWorker({
    ids: ['run-material-warning-digest-drift'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      db.listings = [{ id: 'MUST-NOT-COMMIT-DIGEST-DRIFT' }]
      return committableMaterialWarningResult({ contentPlanSha256: '9'.repeat(64) })
    }
  })
  const driftQueued = digestDrift.worker.enqueue({ trigger: 'manual' })
  const driftCompleted = await digestDrift.worker.run(driftQueued.runId, {
    workerId: 'worker-material-warning-digest-drift'
  })
  assert.strictEqual(driftCompleted.state, STATES.UNKNOWN, '告警结果的摘要漂移仍须保持 UNKNOWN')
  assert.strictEqual(driftCompleted.errorCode, 'APPLY_DIGEST_MISMATCH')
  assert.strictEqual(digestDrift.commitCalls.length, 0)
  assert.deepStrictEqual(digestDrift.store.snapshot().listings, [])
  assert.strictEqual(digestDrift.store.snapshot().feishuSyncScheduler.blockedRunId, driftQueued.runId)
}

async function testExternalWriteUnknownAndStateConflictNeverCommit() {
  const externalUnknown = makeWorker({
    ids: ['run-material-external-write-unknown'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      db.listings = [{ id: 'MUST-NOT-COMMIT-EXTERNAL-UNKNOWN' }]
      const result = committableMaterialWarningResult({ externalWriteStateUnknown: true })
      result.noteMaterials.externalWriteStateUnknown = true
      return result
    }
  })
  const externalQueued = externalUnknown.worker.enqueue({ trigger: 'manual' })
  const externalCompleted = await externalUnknown.worker.run(externalQueued.runId, {
    workerId: 'worker-material-external-write-unknown'
  })
  assert.strictEqual(externalCompleted.state, STATES.UNKNOWN)
  assert.strictEqual(externalCompleted.errorCode, 'APPLY_RESULT_NOT_COMPLETE')
  assert.strictEqual(externalUnknown.commitCalls.length, 0)
  assert.deepStrictEqual(externalUnknown.store.snapshot().listings, [])
  assert.strictEqual(
    externalUnknown.store.snapshot().feishuSyncScheduler.blockedRunId,
    externalQueued.runId
  )

  let dryConflictApplyCalls = 0
  const dryConflict = makeWorker({
    ids: ['run-dry-material-state-conflict'],
    sync: async (db, actorId, options) => {
      if (!options.dryRun) dryConflictApplyCalls += 1
      return dryMaterialWarningResult({
        failed: 1,
        noteMaterials: {
          complete: false,
          published: false,
          dryRun: true,
          failed: 1,
          rows: [{
            sourceRecordId: 'source-row-conflict',
            status: 'state-conflict',
            deferred: false,
            sourceValueFingerprint: 'e'.repeat(64)
          }]
        }
      })
    }
  })
  const dryConflictQueued = dryConflict.worker.enqueue({ trigger: 'manual' })
  const dryConflictCompleted = await dryConflict.worker.run(dryConflictQueued.runId, {
    workerId: 'worker-dry-material-state-conflict'
  })
  assert.strictEqual(dryConflictCompleted.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(dryConflictApplyCalls, 0)
  assert.strictEqual(dryConflict.commitCalls.length, 0)

  const applyConflict = makeWorker({
    ids: ['run-apply-material-state-conflict'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      db.listings = [{ id: 'MUST-NOT-COMMIT-STATE-CONFLICT' }]
      return committableMaterialWarningResult({
        failed: 1,
        noteMaterials: {
          complete: false,
          published: false,
          dryRun: false,
          failed: 1,
          externalWriteStateUnknown: true,
          rows: [{
            sourceRecordId: 'source-row-conflict',
            status: 'state-conflict',
            deferred: false,
            sourceValueFingerprint: 'e'.repeat(64)
          }]
        }
      })
    }
  })
  const applyConflictQueued = applyConflict.worker.enqueue({ trigger: 'manual' })
  const applyConflictCompleted = await applyConflict.worker.run(applyConflictQueued.runId, {
    workerId: 'worker-apply-material-state-conflict'
  })
  assert.strictEqual(applyConflictCompleted.state, STATES.UNKNOWN)
  assert.strictEqual(applyConflict.commitCalls.length, 0)
  assert.deepStrictEqual(applyConflict.store.snapshot().listings, [])
  assert.strictEqual(
    applyConflict.store.snapshot().feishuSyncScheduler.blockedRunId,
    applyConflictQueued.runId
  )
}

async function testManualActorSurvivesWorkerRestart() {
  const store = createStore()
  const producer = makeWorker({
    store,
    ids: ['run-actor-restart'],
    sync: async () => dryResult()
  }).worker
  const queued = producer.enqueue({ trigger: 'manual', actorId: 'admin-audit-01' })
  assert.strictEqual(queued.actorId, undefined, '入队响应不得回显内部发起人身份')

  const observedActors = []
  const consumer = makeWorker({
    store,
    sync: async (db, actorId, options) => {
      observedActors.push(actorId)
      return options.dryRun ? dryResult() : applyResult()
    }
  }).worker
  const completed = await consumer.run(queued.runId, { workerId: 'fresh-cli-process' })
  assert.strictEqual(completed.state, STATES.SUCCEEDED)
  assert.deepStrictEqual(
    observedActors,
    ['admin-audit-01', 'admin-audit-01'],
    '新 worker 进程必须从持久任务恢复发起人，不能回退为 system actor'
  )
}

async function testTwoWorkersUseLeaseAndFence() {
  let nowMs = 1_800_000_000_000
  const firstDry = deferred()
  let dryCalls = 0
  let applyCalls = 0
  const store = createStore()
  const sync = async (db, actorId, options) => {
    if (options.dryRun) {
      dryCalls += 1
      if (dryCalls === 1) return firstDry.promise
      return dryResult()
    }
    applyCalls += 1
    db.listings = [{ id: 'FENCED' }]
    return applyResult()
  }
  const common = {
    store,
    sync,
    now: () => nowMs,
    leaseMs: 1_000
  }
  const first = makeWorker({ ...common, ids: ['run-fence'] }).worker
  const second = makeWorker({ ...common, ids: ['unused'] }).worker
  const queued = first.enqueue({ trigger: 'manual' })
  const stalePromise = first.run(queued.runId, { workerId: 'worker-old' })
  await flush()
  assert.strictEqual(store.snapshot().feishuSyncRuns[0].state, STATES.DRY_RUNNING)

  const busy = await second.runNext({ workerId: 'worker-new' })
  assert.strictEqual(busy, null, 'lease 未过期时第二 worker 不得抢任务')

  nowMs += 1_001
  const fresh = await second.runNext({ workerId: 'worker-new' })
  assert.strictEqual(fresh.state, STATES.SUCCEEDED, 'dry-running 崩溃后允许新 fence 从安全预演恢复')
  firstDry.resolve(dryResult())
  const stale = await stalePromise
  assert.strictEqual(stale.state, STATES.SUCCEEDED, '旧 worker 只能读取新 worker 已完成的终态')
  assert.strictEqual(dryCalls, 2)
  assert.strictEqual(applyCalls, 1, '旧 fence 绝不能进入正式调用')
}

async function testDifferentRunsShareOneGlobalLease() {
  const firstDry = deferred()
  const store = createStore()
  let firstRunId = ''
  let activeSyncCalls = 0
  let maxActiveSyncCalls = 0
  const enteredRuns = []
  const sync = async (db, actorId, options) => {
    activeSyncCalls += 1
    maxActiveSyncCalls = Math.max(maxActiveSyncCalls, activeSyncCalls)
    enteredRuns.push(options.runId)
    try {
      if (options.runId === firstRunId && options.dryRun) await firstDry.promise
      return options.dryRun ? dryResult() : applyResult()
    } finally {
      activeSyncCalls -= 1
    }
  }
  const first = makeWorker({ store, sync, ids: ['global-run-a'] }).worker
  const second = makeWorker({ store, sync, ids: ['global-run-b'] }).worker
  const queuedA = first.enqueue({ trigger: 'manual' })
  const queuedB = second.enqueue({ trigger: 'manual', dryRun: true })
  firstRunId = queuedA.runId

  const runningA = first.run(queuedA.runId, { workerId: 'global-worker-a' })
  await flush()
  const whileBusy = await second.run(queuedB.runId, { workerId: 'global-worker-b' })
  assert.strictEqual(whileBusy, null, '不同 runId 也必须受同一把全局 lease 约束')
  assert.deepStrictEqual(enteredRuns, [queuedA.runId], '全局 lease 持有期间第二个任务不得进入 sync')
  assert.strictEqual(store.snapshot().feishuSyncScheduler.activeLease.runId, queuedA.runId)

  firstDry.resolve(dryResult())
  assert.strictEqual((await runningA).state, STATES.SUCCEEDED)
  assert.ok(!store.snapshot().feishuSyncScheduler.activeLease, '成功后必须释放匹配的全局 lease')
  assert.strictEqual((await second.run(queuedB.runId, { workerId: 'global-worker-b' })).state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(maxActiveSyncCalls, 1, '两个不同任务的 dry/apply 调用最多只能有一个同时执行')
}

async function testEnqueueDeduplicatesEveryNonTerminalMode() {
  let applyCalls = 0
  const { worker, store } = makeWorker({
    ids: ['dedupe-full', 'dedupe-dry'],
    sync: async (db, actorId, options) => {
      if (!options.dryRun) applyCalls += 1
      return options.dryRun ? dryResult() : applyResult()
    }
  })
  const full = worker.enqueue({ trigger: 'manual' })
  assert.strictEqual(worker.enqueue({ trigger: 'manual' }).runId, full.runId, '人工 full 双击必须复用在途 run')
  assert.strictEqual(
    worker.enqueue({ trigger: 'scheduled', scheduledAt: 1_800_000_000_000 }).runId,
    full.runId,
    '在途人工 full 与 scheduled full 必须合并为同一 run'
  )
  const dry = worker.enqueue({ trigger: 'manual', dryRun: true })
  assert.notStrictEqual(dry.runId, full.runId)
  assert.strictEqual(
    worker.enqueue({ trigger: 'manual', dryRun: true }).runId,
    dry.runId,
    '人工 dry 双击必须复用在途 dry run'
  )
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, 2)

  assert.strictEqual((await worker.run(full.runId, { workerId: 'dedupe-full-worker' })).state, STATES.SUCCEEDED)
  assert.strictEqual((await worker.runNext({ workerId: 'dedupe-dry-worker' })).state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(await worker.runNext({ workerId: 'dedupe-empty-worker' }), null)
  assert.strictEqual(applyCalls, 1, '去重后的 runNext 不得补跑第二次正式同步')
}

async function testHeartbeatRenewsRunAndGlobalLeaseTogether() {
  let nowMs = 1_800_000_000_000
  const gate = deferred()
  let heartbeatCallback = null
  const { worker, store } = makeWorker({
    ids: ['heartbeat-run'],
    leaseMs: 900,
    now: () => nowMs,
    heartbeat: true,
    setInterval(callback) {
      heartbeatCallback = callback
      return { unref() {} }
    },
    clearInterval() {},
    sync: async (db, actorId, options) => {
      if (options.dryRun) await gate.promise
      return options.dryRun ? dryResult() : applyResult()
    }
  })
  const queued = worker.enqueue({ trigger: 'manual' })
  const running = worker.run(queued.runId, { workerId: 'heartbeat-worker' })
  await flush()
  const before = store.snapshot()
  assert.strictEqual(typeof heartbeatCallback, 'function')
  assert.strictEqual(before.feishuSyncRuns[0].lease.expiresAt, nowMs + 900)
  assert.strictEqual(before.feishuSyncScheduler.activeLease.expiresAt, nowMs + 900)

  nowMs += 350
  heartbeatCallback()
  const renewed = store.snapshot()
  assert.strictEqual(renewed.feishuSyncRuns[0].lease.expiresAt, nowMs + 900)
  assert.strictEqual(renewed.feishuSyncScheduler.activeLease.expiresAt, nowMs + 900)
  assert.strictEqual(
    renewed.feishuSyncScheduler.activeLease.fence,
    renewed.feishuSyncRuns[0].lease.fence,
    'heartbeat 必须在同一事务中续租 run 与全局 lease'
  )

  gate.resolve()
  assert.strictEqual((await running).state, STATES.SUCCEEDED)
}

async function testStaleOwnerCannotReleaseReplacementGlobalLease() {
  let nowMs = 1_800_000_000_000
  const firstGate = deferred()
  const secondGate = deferred()
  let firstRunId = ''
  let secondRunId = ''
  const store = createStore()
  const sync = async (db, actorId, options) => {
    if (options.dryRun && options.runId === firstRunId) await firstGate.promise
    if (options.dryRun && options.runId === secondRunId) await secondGate.promise
    return options.dryRun ? dryResult() : applyResult()
  }
  const first = makeWorker({ store, sync, now: () => nowMs, leaseMs: 1_000, ids: ['stale-a'] }).worker
  const second = makeWorker({ store, sync, now: () => nowMs, leaseMs: 1_000, ids: ['fresh-b'] }).worker
  const queuedA = first.enqueue({ trigger: 'manual' })
  const queuedB = second.enqueue({ trigger: 'manual', dryRun: true })
  firstRunId = queuedA.runId
  secondRunId = queuedB.runId

  const staleExecution = first.run(firstRunId, { workerId: 'stale-owner' })
  await flush()
  nowMs += 1_001
  const freshExecution = second.run(secondRunId, { workerId: 'fresh-owner' })
  await flush()
  const replacement = store.snapshot().feishuSyncScheduler.activeLease
  assert.strictEqual(replacement.runId, secondRunId)

  firstGate.resolve()
  assert.strictEqual((await staleExecution).state, STATES.QUEUED)
  assert.deepStrictEqual(
    store.snapshot().feishuSyncScheduler.activeLease,
    replacement,
    '旧 owner/fence 的收尾绝不能释放或改写新任务的全局 lease'
  )

  secondGate.resolve()
  assert.strictEqual((await freshExecution).state, STATES.DRY_SUCCEEDED)
  assert.ok(!store.snapshot().feishuSyncScheduler.activeLease)
}

async function testMissingGlobalLeaseFailsClosed() {
  const nowMs = 1_800_000_000_000
  const orphanRunId = 'feishu-sync-orphan-active'
  const queuedRunId = 'feishu-sync-waiting-full'
  const store = createStore({
    feishuSyncRuns: [
      {
        runId: orphanRunId,
        state: STATES.DRY_RUNNING,
        dryRun: false,
        createdAt: nowMs - 100,
        updatedAt: nowMs - 100,
        lease: { owner: 'legacy-owner', fence: 4, expiresAt: nowMs + 10_000 }
      },
      {
        runId: queuedRunId,
        state: STATES.QUEUED,
        dryRun: false,
        createdAt: nowMs,
        updatedAt: nowMs,
        lease: null
      }
    ],
    feishuSyncScheduler: { nextFence: 4 }
  })
  let syncCalls = 0
  const { worker } = makeWorker({
    store,
    now: () => nowMs,
    sync: async () => {
      syncCalls += 1
      return dryResult()
    }
  })
  assert.strictEqual(await worker.run(queuedRunId, { workerId: 'new-worker' }), null)
  const scheduler = store.snapshot().feishuSyncScheduler
  assert.strictEqual(scheduler.leaseIntegrityBlockedRunId, orphanRunId)
  assert.strictEqual(syncCalls, 0, 'run.lease 与全局 lease 不一致时必须 fail-closed')

  const malformedStore = createStore({
    feishuSyncRuns: [{
      runId: queuedRunId,
      state: STATES.QUEUED,
      dryRun: false,
      createdAt: nowMs,
      updatedAt: nowMs,
      lease: null
    }],
    feishuSyncScheduler: { nextFence: 4, activeLease: { runId: queuedRunId } }
  })
  const malformedWorker = makeWorker({
    store: malformedStore,
    now: () => nowMs,
    sync: async () => { throw new Error('损坏的全局 lease 不得进入同步') }
  }).worker
  assert.strictEqual(await malformedWorker.run(queuedRunId, { workerId: 'malformed-worker' }), null)
  assert.strictEqual(
    malformedStore.snapshot().feishuSyncScheduler.leaseIntegrityBlockedRunId,
    'controller-state-invalid'
  )
}

function testRecoveryCannotReleaseAnotherOwnersGlobalLease() {
  const nowMs = 1_800_000_000_000
  const activeLease = {
    runId: 'feishu-sync-current-owner',
    owner: 'current-owner',
    fence: 9,
    acquiredAt: nowMs - 100,
    expiresAt: nowMs + 10_000
  }
  const store = createStore({
    feishuSyncRuns: [
      {
        runId: 'feishu-sync-stale-terminal',
        state: STATES.FAILED_BEFORE_WRITE,
        createdAt: nowMs - 1_000,
        updatedAt: nowMs - 1_000,
        lease: {
          runId: 'feishu-sync-stale-terminal',
          owner: 'stale-owner',
          fence: 3,
          acquiredAt: nowMs - 2_000,
          expiresAt: nowMs + 10_000
        }
      },
      {
        runId: activeLease.runId,
        state: STATES.DRY_RUNNING,
        createdAt: nowMs - 100,
        updatedAt: nowMs - 100,
        lease: clone(activeLease)
      }
    ],
    feishuSyncScheduler: { nextFence: 9, activeLease: clone(activeLease) }
  })
  const { worker } = makeWorker({
    store,
    now: () => nowMs,
    sync: async () => { throw new Error('纯恢复不得调用同步') }
  })
  worker.recover()
  assert.deepStrictEqual(
    store.snapshot().feishuSyncScheduler.activeLease,
    activeLease,
    '旧终态任务的 owner/fence 不匹配时绝不能释放新任务的全局 lease'
  )
}

async function testBlockedRunStopsFullBacklogButAllowsExplicitDryOnly() {
  let blockedRunId = ''
  let applyCalls = 0
  const { worker, store } = makeWorker({
    ids: ['blocked-run', 'allowed-dry'],
    sync: async (db, actorId, options) => {
      if (!options.dryRun) applyCalls += 1
      if (options.runId === blockedRunId) {
        return dryResult({ schemaSha256: '9'.repeat(64) })
      }
      return options.dryRun ? dryResult() : applyResult()
    }
  })
  const first = worker.enqueue({ trigger: 'manual' })
  blockedRunId = first.runId
  assert.strictEqual((await worker.run(first.runId, { workerId: 'block-worker' })).state, STATES.BLOCKED)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, first.runId)
  assert.ok(!store.snapshot().feishuSyncScheduler.activeLease, 'BLOCKED 收尾应释放匹配的全局 lease')

  const countBefore = store.snapshot().feishuSyncRuns.length
  const manualFull = worker.enqueue({ trigger: 'manual' })
  assert.strictEqual(manualFull.runId, first.runId, '阻断期间人工 full 不得创建待补跑任务')
  for (const scheduledAt of [1_800_000_000_000, 1_800_001_800_000, 1_800_003_600_000]) {
    const ticked = await worker.tick({ workerId: 'blocked-timer', scheduledAt })
    assert.strictEqual(ticked.enqueued.runId, first.runId)
  }
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, countBefore, '跨多个时间桶不得积累 queued backlog')
  assert.strictEqual(applyCalls, 0)

  const dry = worker.enqueue({ trigger: 'manual', dryRun: true })
  assert.notStrictEqual(dry.runId, first.runId)
  assert.strictEqual((await worker.run(dry.runId, { workerId: 'dry-auditor' })).state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, first.runId)
  assert.strictEqual(applyCalls, 0, '阻断期间只允许明确 dry-only，不得进入 apply')
}

async function testIncompleteBindingsCannotPassDryOnly() {
  let dryCalls = 0
  const { worker, store } = makeWorker({
    ids: ['incomplete-bindings', 'invalid-optional-role'],
    approvedSchemaSha256: '',
    sync: async () => {
      dryCalls += 1
      return dryResult({
        schemaBindings: dryCalls === 1
          ? [{
              role: 'source',
              bindings: [{ semantic: 'community', fieldName: '板块/商圈', type: 1 }]
            }]
          : [
              ...clone(SAFE_SCHEMA_BINDINGS),
              {
                role: 'rented',
                bindings: [{ semantic: 'phone', fieldName: '13800000000', type: 1 }]
              }
            ]
      })
    }
  })
  const queued = worker.enqueue({ trigger: 'manual', dryRun: true })
  const result = await worker.run(queued.runId, { workerId: 'binding-auditor' })
  assert.strictEqual(result.state, STATES.BLOCKED)
  assert.strictEqual(result.errorCode, 'SCHEMA_BINDINGS_INCOMPLETE')
  assert.strictEqual(result.externalWritesMayHaveOccurred, false)
  assert.ok(!store.snapshot().feishuSyncScheduler.activeLease)

  const optional = worker.enqueue({ trigger: 'manual', dryRun: true })
  const optionalResult = await worker.run(optional.runId, { workerId: 'optional-role-auditor' })
  assert.strictEqual(optionalResult.state, STATES.BLOCKED)
  assert.strictEqual(optionalResult.errorCode, 'SCHEMA_BINDINGS_INCOMPLETE')
  assert.strictEqual(optionalResult.externalWritesMayHaveOccurred, false)
}

async function testScheduleBucketIsIdempotent() {
  let syncCalls = 0
  const { worker, store } = makeWorker({
    ids: ['scheduled-run'],
    sync: async (db, actorId, options) => {
      syncCalls += 1
      return options.dryRun ? dryResult() : applyResult()
    }
  })
  const first = await worker.tick({ workerId: 'timer-a' })
  const second = await worker.tick({ workerId: 'timer-b' })
  assert.strictEqual(first.enqueued.runId, second.enqueued.runId, '同一时间桶只能生成一个任务')
  assert.strictEqual(syncCalls, 2, '重复 tick 不得重复 dry/apply')
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, 1)
}

function testRunHistoryAlsoBoundsCommitMarkers() {
  const terminalRuns = ['old-a', 'old-b', 'old-c'].map((suffix, index) => ({
    runId: `feishu-sync-${suffix}`,
    state: STATES.SUCCEEDED,
    createdAt: 1_800_000_000_000 - index,
    updatedAt: 1_800_000_000_000 - index,
    lease: null
  }))
  const store = createStore({
    feishuSyncRuns: terminalRuns,
    feishuSyncCommitMarkers: Object.fromEntries(terminalRuns.map((run) => [
      run.runId,
      { runId: run.runId, markerSha256: 'a'.repeat(64) }
    ]))
  })
  const { worker } = makeWorker({
    store,
    ids: ['new-active'],
    maxRuns: 2,
    sync: async () => dryResult()
  })
  worker.enqueue({ trigger: 'manual', dryRun: true })
  const snapshot = store.snapshot()
  assert.strictEqual(snapshot.feishuSyncRuns.length, 2)
  assert.deepStrictEqual(
    Object.keys(snapshot.feishuSyncCommitMarkers),
    [terminalRuns[0].runId],
    '裁剪历史 run 时必须同步清理孤儿 commit marker，避免半小时任务长期无界增长'
  )

  const blocker = {
    runId: 'feishu-sync-protected-blocker',
    state: STATES.UNKNOWN,
    createdAt: 1_799_999_999_000,
    updatedAt: 1_799_999_999_000,
    lease: null
  }
  const blockedStore = createStore({
    feishuSyncRuns: terminalRuns.concat(blocker),
    feishuSyncScheduler: { blockedRunId: blocker.runId },
    feishuSyncCommitMarkers: Object.fromEntries(terminalRuns.map((run) => [
      run.runId,
      { runId: run.runId, markerSha256: 'b'.repeat(64) }
    ]))
  })
  const blockedWorker = makeWorker({
    store: blockedStore,
    ids: ['bounded-dry'],
    maxRuns: 2,
    sync: async () => dryResult()
  }).worker
  blockedWorker.enqueue({ trigger: 'manual', dryRun: true })
  const blockedSnapshot = blockedStore.snapshot()
  assert.ok(
    blockedSnapshot.feishuSyncRuns.some((run) => run.runId === blocker.runId),
    '历史裁剪不得删除仍承重的 UNKNOWN/BLOCKED 任务'
  )
  assert.strictEqual(blockedSnapshot.feishuSyncScheduler.blockedRunId, blocker.runId)
}

async function testDigestDriftBlocksBeforeApply() {
  let formalCalls = 0
  const { worker, store } = makeWorker({
    ids: ['run-drift'],
    sync: async (db, actorId, options) => {
      if (!options.dryRun) formalCalls += 1
      return dryResult({
        schemaSha256: '9'.repeat(64),
        schemaBindings: [
          {
            role: 'source',
            bindings: [{
              semantic: 'community',
              fieldName: '小区',
              type: 1,
              fieldId: 'fld-secret-id',
              token: 'token-must-not-leak',
              tableId: 'tbl-must-not-leak',
              records: [{ privateValue: 'sensitive-row-value' }]
            }]
          },
          clone(SAFE_SCHEMA_BINDINGS[1]),
          clone(SAFE_SCHEMA_BINDINGS[2])
        ]
      })
    }
  })
  const queued = worker.enqueue({ trigger: 'manual' })
  const result = await worker.run(queued.runId, { workerId: 'worker-drift' })
  assert.strictEqual(result.state, STATES.BLOCKED)
  assert.strictEqual(result.errorCode, 'SCHEMA_DIGEST_MISMATCH')
  assert.strictEqual(result.schemaSha256, '9'.repeat(64), '阻断状态必须展示待人工批准的候选 schema 摘要')
  assert.strictEqual(formalCalls, 0, 'schema 摘要漂移必须在任何正式调用前阻断')
  assert.strictEqual(store.snapshot().feishuSyncRuns[0].externalWritesMayHaveOccurred, false)
  const publicRun = worker.getStatus().runs[0]
  assert.deepStrictEqual(publicRun.schemaBindings, [
    { role: 'source', semantic: 'community', fieldName: '小区', type: 1 },
    { role: 'location', semantic: 'community', fieldName: '板块/商圈', type: 1 },
    { role: 'mini', semantic: 'community', fieldName: '板块/商圈', type: 1 }
  ], '阻断状态只允许展示可人工核对的四项字段语义')
  const serialized = JSON.stringify(publicRun)
  assert.ok(!serialized.includes('fld-secret-id'))
  assert.ok(!serialized.includes('token-must-not-leak'))
  assert.ok(!serialized.includes('tbl-must-not-leak'))
  assert.ok(!serialized.includes('13800000000'))
}

async function testResourceIdentityIsRequiredAndBoundAcrossApply() {
  let applyCalls = 0
  const missing = makeWorker({
    ids: ['missing-resource'],
    sync: async (db, actorId, options) => {
      if (!options.dryRun) applyCalls += 1
      return dryResult({ resourceIdentitySha256: '' })
    }
  }).worker
  const missingRun = missing.enqueue({ trigger: 'manual' })
  const missingResult = await missing.run(missingRun.runId, { workerId: 'resource-auditor' })
  assert.strictEqual(missingResult.state, STATES.BLOCKED)
  assert.strictEqual(missingResult.errorCode, 'RESOURCE_IDENTITY_DIGEST_MISSING')
  assert.strictEqual(applyCalls, 0, '资源身份缺失必须在正式写入前阻断')

  const drift = makeWorker({
    ids: ['resource-apply-drift'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      return applyResult({ resourceIdentitySha256: '5'.repeat(64) })
    }
  }).worker
  const driftRun = drift.enqueue({ trigger: 'manual' })
  const driftResult = await drift.run(driftRun.runId, { workerId: 'resource-drift-auditor' })
  assert.strictEqual(driftResult.state, STATES.UNKNOWN)
  assert.strictEqual(driftResult.errorCode, 'APPLY_DIGEST_MISMATCH')
  assert.strictEqual(driftResult.resourceIdentitySha256, SHA.resource)
}

async function testResourceApprovalAndNarrowAutomaticUnblock() {
  let applyCalls = 0
  const missingApproval = makeWorker({
    ids: ['resource-approval-missing'],
    approvedResourceIdentitySha256: '',
    sync: async (db, actorId, options) => {
      if (!options.dryRun) applyCalls += 1
      return dryResult()
    }
  }).worker
  const missingRun = missingApproval.enqueue({ trigger: 'manual' })
  const missingResult = await missingApproval.run(missingRun.runId, { workerId: 'approval-auditor' })
  assert.strictEqual(missingResult.state, STATES.BLOCKED)
  assert.strictEqual(missingResult.errorCode, 'RESOURCE_IDENTITY_APPROVAL_MISSING')
  assert.strictEqual(applyCalls, 0)

  const mismatchedApproval = makeWorker({
    ids: ['resource-approval-mismatch'],
    approvedResourceIdentitySha256: '8'.repeat(64),
    sync: async (db, actorId, options) => {
      if (!options.dryRun) applyCalls += 1
      return dryResult()
    }
  }).worker
  const mismatchRun = mismatchedApproval.enqueue({ trigger: 'manual' })
  const mismatchResult = await mismatchedApproval.run(mismatchRun.runId, {
    workerId: 'approval-mismatch-auditor'
  })
  assert.strictEqual(mismatchResult.state, STATES.BLOCKED)
  assert.strictEqual(mismatchResult.errorCode, 'RESOURCE_IDENTITY_MISMATCH')
  assert.strictEqual(applyCalls, 0)

  const store = createStore()
  const unapproved = makeWorker({
    store,
    ids: ['approval-blocked'],
    approvedSchemaSha256: '9'.repeat(64),
    approvedResourceIdentitySha256: SHA.resource,
    sync: async (db, actorId, options) => options.dryRun ? dryResult() : applyResult()
  }).worker
  const blocked = unapproved.enqueue({ trigger: 'manual' })
  assert.strictEqual(
    (await unapproved.run(blocked.runId, { workerId: 'unapproved-worker' })).state,
    STATES.BLOCKED
  )

  const partlyApproved = makeWorker({
    store,
    ids: ['must-not-enqueue'],
    approvedSchemaSha256: SHA.schema,
    approvedResourceIdentitySha256: '8'.repeat(64),
    sync: async () => { throw new Error('任一批准摘要不符时不得进入同步') }
  }).worker
  const countBefore = store.snapshot().feishuSyncRuns.length
  assert.strictEqual(partlyApproved.enqueue({ trigger: 'manual' }).runId, blocked.runId)
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, countBefore)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, blocked.runId)

  const approved = makeWorker({
    store,
    ids: ['approval-resolved'],
    approvedSchemaSha256: SHA.schema,
    approvedResourceIdentitySha256: SHA.resource,
    sync: async (db, actorId, options) => options.dryRun ? dryResult() : applyResult()
  }).worker
  const next = approved.enqueue({ trigger: 'manual' })
  assert.notStrictEqual(next.runId, blocked.runId)
  const resolvedHistoricalRun = store.snapshot().feishuSyncRuns.find((run) => run.runId === blocked.runId)
  assert.strictEqual(resolvedHistoricalRun.state, STATES.FAILED_BEFORE_WRITE)
  assert.ok(resolvedHistoricalRun.resolvedAt > 0, '仅批准类 BLOCKED 在两项批准值都匹配时可自动解阻')
  assert.strictEqual((await approved.run(next.runId, { workerId: 'approved-worker' })).state, STATES.SUCCEEDED)

  const unsafeRunId = 'feishu-sync-unsafe-approval-block'
  const unsafeStore = createStore({
    feishuSyncRuns: [{
      runId: unsafeRunId,
      state: STATES.BLOCKED,
      errorCode: 'SCHEMA_DIGEST_MISMATCH',
      schemaSha256: SHA.schema,
      resourceIdentitySha256: SHA.resource,
      externalWritesMayHaveOccurred: true,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      lease: null
    }],
    feishuSyncScheduler: { blockedRunId: unsafeRunId }
  })
  const unsafeWorker = makeWorker({
    store: unsafeStore,
    sync: async () => { throw new Error('写意图已落盘的阻断任务不得自动解阻') }
  }).worker
  unsafeWorker.recover()
  const unsafeRun = unsafeStore.snapshot().feishuSyncRuns[0]
  assert.strictEqual(unsafeRun.state, STATES.BLOCKED)
  assert.ok(!unsafeRun.resolvedAt)
  assert.strictEqual(unsafeStore.snapshot().feishuSyncScheduler.blockedRunId, unsafeRunId)
}

async function testApplyExceptionBecomesUnknownAndNeverReplays() {
  let applyCalls = 0
  const { worker, store } = makeWorker({
    ids: ['run-unknown', 'unknown-dry-audit'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      applyCalls += 1
      throw new Error('网关超时，远端是否完成未知')
    }
  })
  const queued = worker.enqueue({ trigger: 'manual' })
  const result = await worker.run(queued.runId, { workerId: 'worker-unknown' })
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(await worker.runNext({ workerId: 'worker-retry' }), null)
  assert.ok(!store.snapshot().feishuSyncScheduler.activeLease, 'UNKNOWN 收尾应释放匹配的全局 lease')
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, queued.runId)
  const fullAfterUnknown = worker.enqueue({ trigger: 'manual' })
  assert.strictEqual(fullAfterUnknown.runId, queued.runId, 'UNKNOWN 未消解前不得积累新的 full 任务')
  const dryAudit = worker.enqueue({ trigger: 'manual', dryRun: true })
  assert.strictEqual((await worker.run(dryAudit.runId, { workerId: 'unknown-auditor' })).state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, queued.runId)
  assert.strictEqual(applyCalls, 1, 'UNKNOWN 永远不得自动重放正式同步')
}

async function testSafeLabelsCannotDowngradePostIntentFailure() {
  const variants = [
    {
      name: 'explicit-safe-flag',
      makeError() {
        const error = new Error('正式写入阶段字段契约变化')
        error.code = 'FIELD_CONTRACT_CHANGED'
        error.safeBeforeWrite = true
        return error
      }
    },
    {
      name: 'safe-code-only',
      makeError() {
        const error = new Error('正式写入阶段源读取异常')
        error.code = 'SOURCE_READ_FAILED'
        return error
      }
    }
  ]
  for (const variant of variants) {
    let applyCalls = 0
    let syncCalls = 0
    const { worker, store } = makeWorker({
      ids: [`post-intent-${variant.name}`],
      sync: async (db, actorId, options) => {
        syncCalls += 1
        if (options.dryRun) return dryResult()
        applyCalls += 1
        throw variant.makeError()
      }
    })
    const queued = worker.enqueue({ trigger: 'manual' })
    const failed = await worker.run(queued.runId, { workerId: `worker-${variant.name}` })
    assert.strictEqual(failed.state, STATES.UNKNOWN, `${variant.name} 在写意图后只能进入 UNKNOWN`)
    assert.strictEqual(failed.externalWritesMayHaveOccurred, true)
    assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, queued.runId)
    assert.ok(!store.snapshot().feishuSyncScheduler.activeLease)

    const runCount = store.snapshot().feishuSyncRuns.length
    await worker.tick({
      workerId: `timer-${variant.name}`,
      scheduledAt: 1_800_001_800_000
    })
    assert.strictEqual(store.snapshot().feishuSyncRuns.length, runCount)
    assert.strictEqual(syncCalls, 2, '后续 tick 不得重放 dry 或 apply')
    assert.strictEqual(applyCalls, 1, '后续 tick 绝不得再次进入 apply')
  }
}

async function testCommitFailureKeepsBusinessDbUntouchedAndUnknown() {
  const store = createStore()
  let commitCalls = 0
  const { worker } = makeWorker({
    store,
    ids: ['run-commit-failure'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      db.listings = [{ id: 'MUST-NOT-COMMIT' }]
      return applyResult()
    },
    commitDeltaChecked: async () => {
      commitCalls += 1
      throw new Error('模拟提交前本地故障')
    }
  })
  const queued = worker.enqueue({ trigger: 'manual' })
  const result = await worker.run(queued.runId, { workerId: 'worker-commit-failure' })
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.errorCode, 'COMMIT_FAILED')
  assert.strictEqual(commitCalls, 1)
  assert.deepStrictEqual(store.snapshot().listings, [], '提交失败不得留下半份业务数据')
  assert.ok(!store.snapshot().feishuSyncCommitMarkers[queued.runId], '提交失败不得伪造提交标记')
}

async function testStatusIsSanitized() {
  const secret = 'token-secret-123'
  const rawUrl = 'https://private.example/path/file.mp4'
  const { worker, store } = makeWorker({
    ids: ['run-redacted'],
    sync: async () => {
      const error = new Error(`读取 ${rawUrl} 失败：${secret}`)
      error.code = 'SOURCE_READ_FAILED'
      error.safeBeforeWrite = true
      throw error
    }
  })
  const queued = worker.enqueue({ trigger: 'manual', actorId: 'admin-redacted-01' })
  const failed = await worker.run(queued.runId, { workerId: 'worker-redacted' })
  assert.strictEqual(failed.state, STATES.FAILED_BEFORE_WRITE)
  const serialized = JSON.stringify(worker.getStatus())
  assert.ok(!serialized.includes(secret), '状态输出不得包含账号、token 或原始身份')
  assert.ok(!serialized.includes(rawUrl), '状态输出不得包含 URL 或路径')
  assert.ok(!serialized.includes('private.example'), '状态输出不得泄露远端主机')
  assert.ok(serialized.includes('SOURCE_READ_FAILED'), '状态输出应保留可检索的安全错误码')

  store.updateDb((db) => {
    db.feishuSyncRuns[0].schemaBindings = [
      {
        role: 'source',
        semantic: 'community',
        fieldName: '小区',
        type: 1,
        fieldId: 'fld-private-id',
        token: 'token-persisted-secret'
      },
      { role: 'location', semantic: 'phone', fieldName: '13800000000', type: 1 },
      { role: 'mini', semantic: 'path', fieldName: 'C:\\private\\schema.json', type: 1 }
    ]
  })
  const persisted = JSON.stringify(worker.getStatus())
  assert.ok(persisted.includes('"fieldName":"小区"'))
  assert.ok(!persisted.includes('fieldId'))
  assert.ok(!persisted.includes('fld-private-id'))
  assert.ok(!persisted.includes('token-persisted-secret'))
  assert.ok(!persisted.includes('13800000000'))
  assert.ok(!persisted.includes('private\\\\schema.json'))
}

async function testRecoveryRules() {
  const nowMs = 1_800_000_000_000
  const markerRunId = 'run-with-marker'
  const markerRun = {
    runId: markerRunId,
    state: STATES.COMMITTING,
    createdAt: nowMs - 20_000,
    updatedAt: nowMs - 20_000,
    externalWritesMayHaveOccurred: true,
    lease: { owner: 'dead', fence: 5, expiresAt: nowMs - 1 },
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: SHA.mirror,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 4
  }
  const validMarker = testCommitMarker(markerRun)
  markerRun.commitMarkerSha256 = validMarker.markerSha256
  const forgedRun = {
    ...clone(markerRun),
    runId: 'run-forged-marker',
    lease: { owner: 'dead', fence: 6, expiresAt: nowMs - 1 }
  }
  const forgedMarker = testCommitMarker(forgedRun, { schemaSha256: '8'.repeat(64) })
  forgedRun.commitMarkerSha256 = forgedMarker.markerSha256
  const forgedHashRun = {
    ...clone(markerRun),
    runId: 'run-forged-marker-hash',
    lease: { owner: 'dead', fence: 8, expiresAt: nowMs - 1 }
  }
  const forgedHashMarker = {
    ...testCommitMarker(forgedHashRun),
    markerSha256: 'f'.repeat(64)
  }
  forgedHashRun.commitMarkerSha256 = forgedHashMarker.markerSha256
  const store = createStore({
    feishuSyncRuns: [
      {
        runId: 'run-applying',
        state: STATES.APPLYING,
        createdAt: nowMs - 20_000,
        updatedAt: nowMs - 20_000,
        externalWritesMayHaveOccurred: true,
        lease: { owner: 'dead', fence: 3, expiresAt: nowMs - 1 }
      },
      markerRun,
      forgedRun,
      forgedHashRun,
      {
        runId: 'run-committing-no-marker',
        state: STATES.COMMITTING,
        createdAt: nowMs - 20_000,
        updatedAt: nowMs - 20_000,
        externalWritesMayHaveOccurred: true,
        lease: { owner: 'dead', fence: 7, expiresAt: nowMs - 1 },
        commitMarkerSha256: '5'.repeat(64)
      }
    ],
    feishuSyncCommitMarkers: {
      [markerRunId]: validMarker,
      [forgedRun.runId]: forgedMarker,
      [forgedHashRun.runId]: forgedHashMarker
    },
    feishuSyncScheduler: {
      nextFence: 7,
      activeLease: {
        runId: markerRunId,
        owner: 'dead',
        fence: 5,
        acquiredAt: nowMs - 20_000,
        expiresAt: nowMs - 1
      }
    }
  })
  const { worker } = makeWorker({
    store,
    now: () => nowMs,
    sync: async () => { throw new Error('恢复时不得调用同步') }
  })
  const recovered = worker.recover()
  const byId = new Map(recovered.runs.map((item) => [item.runId, item]))
  assert.strictEqual(byId.get('run-applying').state, STATES.UNKNOWN, 'applying 无提交标记只能进入 UNKNOWN')
  assert.strictEqual(byId.get('run-applying').errorCode, 'APPLY_FAILED')
  assert.strictEqual(byId.get(markerRunId).state, STATES.SUCCEEDED, 'committing 命中原子提交标记必须收敛成功')
  assert.strictEqual(byId.get(forgedRun.runId).state, STATES.UNKNOWN, '摘要不匹配的伪提交标记不得恢复成成功')
  assert.strictEqual(byId.get(forgedRun.runId).errorCode, 'COMMIT_FAILED')
  assert.strictEqual(byId.get(forgedHashRun.runId).state, STATES.UNKNOWN, '未按标记正文重算的伪哈希不得恢复成成功')
  assert.strictEqual(byId.get(forgedHashRun.runId).errorCode, 'COMMIT_FAILED')
  assert.strictEqual(byId.get('run-committing-no-marker').state, STATES.UNKNOWN, 'committing 无标记不得猜测提交成功')
  assert.strictEqual(byId.get('run-committing-no-marker').errorCode, 'COMMIT_FAILED')
  assert.ok(!store.snapshot().feishuSyncScheduler.activeLease, '恢复只能释放与旧任务 owner/fence 匹配的全局 lease')
}

function testCliAndHalfHourlyTimerStayNoopWhenDisabled() {
  const repoRoot = path.join(__dirname, '..', '..')
  const cliPath = path.join(__dirname, 'run-feishu-sync-worker.js')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-sync-worker-cli-'))
  const dataFile = path.join(tempDir, 'db.json')
  try {
    const result = spawnSync(process.execPath, [cliPath, '--schedule'], {
      cwd: path.join(repoRoot, 'server'),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATA_FILE: dataFile,
        AUTH_TOKEN_SECRET: process.env.AUTH_TOKEN_SECRET || 'test-sync-worker-secret',
        FEISHU_SYNC_ENABLED: 'true',
        FEISHU_AUTO_SYNC_ENABLED: 'false',
        FEISHU_SYNC_CONTROLLER_MODE: '',
        FEISHU_APPROVED_SCHEMA_SHA256: ''
      }
    })
    assert.strictEqual(result.status, 0, `自动关闭时 CLI 应安全跳过：${result.stderr}`)
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), {
      ok: true,
      skipped: true,
      reason: 'automatic-sync-disabled'
    })
    assert.strictEqual(fs.existsSync(dataFile), false, '自动关闭时定时唤醒不得连空状态都写入生产数据库')

    const service = fs.readFileSync(path.join(repoRoot, 'deploy', 'ynzy-feishu-sync.service'), 'utf8')
    const timer = fs.readFileSync(path.join(repoRoot, 'deploy', 'ynzy-feishu-sync.timer'), 'utf8')
    const installer = fs.readFileSync(path.join(repoRoot, 'deploy', 'install-on-server.sh'), 'utf8')
    assert.ok(service.includes('scripts/run-feishu-sync-worker.js --schedule'), 'systemd 必须只调用统一 worker 入口')
    assert.ok(/OnCalendar=\*-\*-\* \*:00,30:00/.test(timer), '自动同步检查周期必须固定为每个墙钟半小时')
    assert.ok(!/OnUnitActiveSec=/.test(timer), '长同步不得因 OnUnitActiveSec 到点时服务仍 active 而丢失后续调度')
    assert.ok(/Persistent=true/.test(timer), '关机期间错过的检查必须在启动后补触发')
    assert.ok(/RandomizedDelaySec=90/.test(timer), '定时器应避免与其他整点任务同时抢资源')
    assert.ok(
      installer.includes('systemctl disable --now ynzy-feishu-sync.timer'),
      '安装脚本必须先停用自动 timer，等待首次人工验收后再显式开启'
    )
    assert.ok(
      !installer.includes('systemctl enable --now ynzy-feishu-sync.timer'),
      '部署过程不得直接获得自动写触发资格'
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function main() {
  await testDbWriteLockIsMandatoryBeforeAnyMutation()
  await testManualDryOnlyDoesNotNeedApprovalOrApply()
  await testSuccessIsAtomicAndReturnsExpectedDigests()
  await testCommittableInventoryWithKnownMaterialFailuresCommitsWithWarning()
  await testDryMaterialWarningContinuesToApplyAndAtomicCommit()
  await testDryMaterialWarningRejectsGlobalFailureAndApprovedDigestDrift()
  await testCommittableWarningStillRejectsUnknownFailureAndDigestDrift()
  await testExternalWriteUnknownAndStateConflictNeverCommit()
  await testManualActorSurvivesWorkerRestart()
  await testTwoWorkersUseLeaseAndFence()
  await testDifferentRunsShareOneGlobalLease()
  await testEnqueueDeduplicatesEveryNonTerminalMode()
  await testHeartbeatRenewsRunAndGlobalLeaseTogether()
  await testStaleOwnerCannotReleaseReplacementGlobalLease()
  await testMissingGlobalLeaseFailsClosed()
  testRecoveryCannotReleaseAnotherOwnersGlobalLease()
  await testBlockedRunStopsFullBacklogButAllowsExplicitDryOnly()
  await testIncompleteBindingsCannotPassDryOnly()
  await testScheduleBucketIsIdempotent()
  testRunHistoryAlsoBoundsCommitMarkers()
  await testDigestDriftBlocksBeforeApply()
  await testResourceIdentityIsRequiredAndBoundAcrossApply()
  await testResourceApprovalAndNarrowAutomaticUnblock()
  await testApplyExceptionBecomesUnknownAndNeverReplays()
  await testSafeLabelsCannotDowngradePostIntentFailure()
  await testCommitFailureKeepsBusinessDbUntouchedAndUnknown()
  await testStatusIsSanitized()
  await testRecoveryRules()
  testCliAndHalfHourlyTimerStayNoopWhenDisabled()
  console.log('feishu-sync-worker-v2-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
