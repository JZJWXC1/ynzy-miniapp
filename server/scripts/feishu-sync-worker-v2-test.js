const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  STATES,
  createFeishuSyncWorker,
  _internal: workerInternal
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key])
      return result
    }, {})
  }
  return value
}

function stableSha256(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
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

function freezeApplyPlan(options, patch = {}) {
  assert.strictEqual(typeof options.onApplyPlanFrozen, 'function')
  const frozen = {
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: SHA.mirror,
    ...patch
  }
  options.onApplyPlanFrozen(frozen)
  return frozen
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
  reconcilePartialBaseWrites,
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
      feishuSync: { sync, reconcilePartialBaseWrites },
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

function partialReconciliationEvidence(runId, patch = {}) {
  const body = {
    contract: 'feishu-partial-base-write-reconciliation-v1',
    runIdSha256: crypto.createHash('sha256').update(runId).digest('hex'),
    priorMirrorPlanSha256: SHA.mirror,
    currentMirrorPlanSha256: '5'.repeat(64),
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    archiveCount: 3,
    historyCount: 10,
    archiveEvidenceSha256: '7'.repeat(64),
    historyEvidenceSha256: '8'.repeat(64),
    currentOperationsSha256: '9'.repeat(64),
    currentPlan: {
      create: 6,
      update: 37,
      deactivate: 3,
      restore: 0,
      noop: 0
    },
    ...patch
  }
  return {
    ...body,
    evidenceSha256: stableSha256(body)
  }
}

function testManualNoopAllowsOnlyExactCurrentInventoryRefresh() {
  const valid = {
    created: 0,
    updated: 54,
    down: 0,
    sourceRecordCount: 54
  }
  assert.strictEqual(
    workerInternal.manualNoopResultSummaryValid(valid),
    true,
    '54 套当前库存的 54 条本地刷新必须允许进入人工解屏证据'
  )
  assert.strictEqual(
    workerInternal.manualNoopResultSummaryValid({ ...valid, updated: 53 }),
    false,
    'updated 与 sourceRecordCount 不相等必须失败关闭'
  )
  for (const invalid of [
    { ...valid, updated: -1, sourceRecordCount: -1 },
    { ...valid, updated: 1.5, sourceRecordCount: 1.5 },
    { ...valid, created: 1 },
    { ...valid, down: 1 }
  ]) {
    assert.strictEqual(
      workerInternal.manualNoopResultSummaryValid(invalid),
      false,
      '非负安全整数、created=0、down=0 任一条件不满足都必须拒绝'
    )
  }
}

function exactPartialUnknownRun(runId, nowMs, patch = {}) {
  return {
    version: 3,
    runId,
    runNowMs: nowMs - 30_000,
    state: STATES.UNKNOWN,
    trigger: 'manual',
    dryRun: false,
    actorType: 'manual',
    actorId: 'admin:partial-reconcile',
    errorCode: 'UNKNOWN_ERROR',
    mirrorPlanSha256: SHA.mirror,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 4,
    externalWritesMayHaveOccurred: true,
    applyIntentAt: nowMs - 20_000,
    externalWriteIntentAt: nowMs - 20_000,
    writeIntentEvidenceVersion: 1,
    attemptCount: 1,
    recoveryCount: 0,
    createdAt: nowMs - 30_000,
    updatedAt: nowMs - 10_000,
    finishedAt: nowMs - 10_000,
    lease: null,
    ...patch
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
        false,
        '正式函数可以先做只读预检，首个真实写请求前不得过早标记外部写入'
      )
      assert.strictEqual(typeof options.onExternalWriteDispatched, 'function')
      assert.strictEqual(options.expectedSchemaSha256, SHA.schema)
      assert.strictEqual(options.expectedResourceIdentitySha256, SHA.resource)
      assert.strictEqual(options.expectedMirrorPlanSha256, SHA.mirror)
      assert.strictEqual(options.expectedContentPlanSha256, SHA.content)
      assert.strictEqual(options.expectedContentAssetCount, 4)
      freezeApplyPlan(options)
      options.onExternalWriteDispatched()
      assert.strictEqual(
        store.snapshot().feishuSyncRuns[0].externalWritesMayHaveOccurred,
        true,
        '首个真实写请求前必须同步持久化精确写意图'
      )
      db.listings = [{ id: 'L-1', title: '公开房源' }]
      db.companySheetSnapshot = { schemaVersion: 2, rowCount: 1 }
      return applyResult()
    }
  })

  const queued = worker.enqueue({ trigger: 'manual', actorId: 'admin-1' })
  const queuedRaw = store.snapshot().feishuSyncRuns[0]
  assert.strictEqual(queuedRaw.version, 3, '普通同步必须继续使用 V3 身份')
  assert.strictEqual(queuedRaw.convergenceContract, undefined, '普通同步不得误挂 V5 收敛合同')
  const completed = await worker.run(queued.runId, { workerId: 'worker-a' })
  assert.strictEqual(completed.state, STATES.SUCCEEDED, `formal success blocked: ${completed.errorCode || 'no-error-code'}`)
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

async function testClearedWriteIntentCannotCommitAsNoWrite() {
  let store
  let writeIntentCalls = 0
  const built = makeWorker({
    ids: ['run-cleared-write-intent'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      options.onExternalWriteDispatched()
      writeIntentCalls += 1
      store.updateDb((current) => {
        const run = current.feishuSyncRuns.find((item) => item.runId === options.runId)
        run.state = STATES.READY_TO_APPLY
        run.externalWritesMayHaveOccurred = false
        delete run.applyIntentAt
        delete run.externalWriteIntentAt
      })
      db.listings = [{ id: 'must-not-commit-after-intent-tamper' }]
      return applyResult()
    }
  })
  store = built.store
  const queued = built.worker.enqueue({ trigger: 'manual', actorId: 'admin-intent-tamper' })
  const result = await built.worker.run(queued.runId, { workerId: 'worker-intent-tamper' })
  const after = store.snapshot()
  const persisted = after.feishuSyncRuns.find((run) => run.runId === queued.runId)
  assert.strictEqual(writeIntentCalls, 1)
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.ok(Number.isSafeInteger(persisted.applyIntentAt))
  assert.strictEqual(persisted.externalWriteIntentAt, persisted.applyIntentAt)
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, queued.runId)
  assert.strictEqual(after.feishuSyncCommitMarkers[queued.runId], undefined)
  assert.deepStrictEqual(after.listings, [], '持久写意图被清空时业务增量不得提交')
}

async function testForgedPersistentWriteIntentWithoutCallbackCannotCommit() {
  let store
  const built = makeWorker({
    ids: ['run-forged-write-intent'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      store.updateDb((current) => {
        const run = current.feishuSyncRuns.find((item) => item.runId === options.runId)
        run.state = STATES.APPLYING
        run.externalWritesMayHaveOccurred = true
        run.applyIntentAt = run.startedAt
        run.externalWriteIntentAt = run.startedAt
      })
      db.listings = [{ id: 'must-not-commit-forged-intent' }]
      return applyResult()
    }
  })
  store = built.store
  const queued = built.worker.enqueue({ trigger: 'manual', actorId: 'admin-forged-intent' })
  const result = await built.worker.run(queued.runId, { workerId: 'worker-forged-intent' })
  const after = store.snapshot()
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, queued.runId)
  assert.strictEqual(after.feishuSyncCommitMarkers[queued.runId], undefined)
  assert.deepStrictEqual(after.listings, [], '本地未派发写请求时伪造的持久意图不得获得提交资格')
}

async function testSlowPreparationFreezesAuthoritativeMirrorBeforeFirstWrite() {
  const authoritativeMirror = '6'.repeat(64)
  const { worker, store, commitCalls } = makeWorker({
    ids: ['run-authoritative-mirror'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      assert.strictEqual(
        typeof options.onApplyPlanFrozen,
        'function',
        '正式同步必须提供临写前权威计划冻结回调'
      )
      options.onApplyPlanFrozen({
        schemaSha256: SHA.schema,
        resourceIdentitySha256: SHA.resource,
        mirrorPlanSha256: authoritativeMirror
      })
      const frozen = store.snapshot().feishuSyncRuns[0]
      assert.strictEqual(frozen.state, STATES.READY_TO_APPLY)
      assert.strictEqual(frozen.externalWritesMayHaveOccurred, false)
      assert.strictEqual(frozen.mirrorPlanSha256, authoritativeMirror)
      assert.strictEqual(frozen.schemaSha256, SHA.schema)
      assert.strictEqual(frozen.resourceIdentitySha256, SHA.resource)
      assert.strictEqual(frozen.contentPlanSha256, SHA.content)
      assert.strictEqual(frozen.contentPlanAssetCount, 4)

      options.onExternalWriteDispatched()
      assert.strictEqual(store.snapshot().feishuSyncRuns[0].state, STATES.APPLYING)
      db.listings = [{ id: 'L-AUTHORITATIVE-MIRROR' }]
      db.companySheetSnapshot = { schemaVersion: 2, rowCount: 1 }
      return applyResult({ mirrorPlanSha256: authoritativeMirror })
    }
  })

  const queued = worker.enqueue({ trigger: 'manual', actorId: 'admin-authoritative-mirror' })
  const completed = await worker.run(queued.runId, { workerId: 'worker-authoritative-mirror' })
  assert.strictEqual(completed.state, STATES.SUCCEEDED)
  assert.strictEqual(completed.mirrorPlanSha256, authoritativeMirror)
  assert.strictEqual(commitCalls.length, 1)
  assert.strictEqual(commitCalls[0].marker.mirrorPlanSha256, authoritativeMirror)
  assert.strictEqual(store.snapshot().feishuSyncRuns[0].mirrorPlanSha256, authoritativeMirror)
}

async function testApplyPlanFreezeGateFailsClosed() {
  const variants = [
    {
      name: 'missing-freeze',
      expectedState: STATES.FAILED_BEFORE_WRITE,
      expectedCode: 'MIRROR_PREFLIGHT_FAILED',
      invoke(options) {}
    },
    {
      name: 'duplicate-freeze',
      expectedState: STATES.FAILED_BEFORE_WRITE,
      expectedCode: 'MIRROR_PREFLIGHT_FAILED',
      invoke(options) {
        freezeApplyPlan(options)
        freezeApplyPlan(options)
      }
    },
    {
      name: 'schema-drift',
      expectedState: STATES.BLOCKED,
      expectedCode: 'MIRROR_SCHEMA_CHANGED',
      invoke(options) {
        freezeApplyPlan(options, { schemaSha256: '7'.repeat(64) })
      }
    },
    {
      name: 'resource-drift',
      expectedState: STATES.BLOCKED,
      expectedCode: 'MIRROR_RESOURCE_CHANGED',
      invoke(options) {
        freezeApplyPlan(options, { resourceIdentitySha256: '8'.repeat(64) })
      }
    },
    {
      name: 'malformed-mirror',
      expectedState: STATES.FAILED_BEFORE_WRITE,
      expectedCode: 'MIRROR_PREFLIGHT_FAILED',
      invoke(options) {
        freezeApplyPlan(options, { mirrorPlanSha256: 'not-a-digest' })
      }
    },
    {
      name: 'extra-key',
      expectedState: STATES.FAILED_BEFORE_WRITE,
      expectedCode: 'MIRROR_PREFLIGHT_FAILED',
      invoke(options) {
        freezeApplyPlan(options, { unexpected: true })
      }
    },
    {
      name: 'write-before-freeze',
      expectedState: STATES.FAILED_BEFORE_WRITE,
      expectedCode: 'MIRROR_PREFLIGHT_FAILED',
      invoke(options) {
        options.onExternalWriteDispatched()
      }
    }
  ]

  for (const variant of variants) {
    const { worker, store, commitCalls } = makeWorker({
      ids: [`run-freeze-gate-${variant.name}`],
      sync: async (db, actorId, options) => {
        if (options.dryRun) return dryResult()
        variant.invoke(options)
        return applyResult()
      }
    })
    const queued = worker.enqueue({ trigger: 'manual' })
    const failed = await worker.run(queued.runId, { workerId: `worker-${variant.name}` })
    assert.strictEqual(failed.state, variant.expectedState, `${variant.name} 必须安全停在写前`)
    assert.strictEqual(failed.errorCode, variant.expectedCode)
    assert.strictEqual(failed.externalWritesMayHaveOccurred, false)
    assert.strictEqual(commitCalls.length, 0, `${variant.name} 不得提交业务数据`)
    assert.deepStrictEqual(store.snapshot().listings, [])
  }
}

async function testCommittableInventoryWithKnownMaterialFailuresCommitsWithWarning() {
  let syncCalls = 0
  const { worker, store, commitCalls } = makeWorker({
    ids: ['run-material-warning'],
    sync: async (db, actorId, options) => {
      syncCalls += 1
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
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
      freezeApplyPlan(options)
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
      freezeApplyPlan(options)
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
      freezeApplyPlan(options)
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
      freezeApplyPlan(options)
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
      freezeApplyPlan(options)
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
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      return applyResult()
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
    freezeApplyPlan(options)
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
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      return applyResult()
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
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      return applyResult()
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
      if (options.dryRun) {
        await gate.promise
        return dryResult()
      }
      freezeApplyPlan(options)
      return applyResult()
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
    if (options.dryRun) return dryResult()
    freezeApplyPlan(options)
    return applyResult()
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
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      return applyResult()
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
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      return applyResult()
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
    '裁剪历史 run 时必须同步清理孤儿 commit marker，避免定时任务长期无界增长'
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
      freezeApplyPlan(options)
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
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      return applyResult()
    }
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
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      return applyResult()
    }
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
      freezeApplyPlan(options)
      options.onExternalWriteDispatched()
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
        freezeApplyPlan(options)
        options.onExternalWriteDispatched()
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

async function testMirrorPlanDriftBeforeWriteIntentIsSafeAndDoesNotBlock() {
  let applyCalls = 0
  const { worker, store } = makeWorker({
    ids: ['run-mirror-prewrite-safe'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      applyCalls += 1
      assert.strictEqual(typeof options.onExternalWriteDispatched, 'function')
      assert.strictEqual(store.snapshot().feishuSyncRuns[0].state, STATES.READY_TO_APPLY)
      assert.strictEqual(store.snapshot().feishuSyncRuns[0].externalWritesMayHaveOccurred, false)
      freezeApplyPlan(options, { mirrorPlanSha256: '6'.repeat(64) })
      const error = new Error('飞书镜像源数据或写入计划已变化，已在写入前阻断')
      error.name = 'MirrorSafetyDigestError'
      error.code = 'MIRROR_PLAN_CHANGED'
      error.safeBeforeWrite = true
      throw error
    }
  })
  const queued = worker.enqueue({ trigger: 'manual' })
  const failed = await worker.run(queued.runId, { workerId: 'worker-mirror-prewrite-safe' })
  assert.strictEqual(applyCalls, 1)
  assert.strictEqual(failed.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(failed.errorCode, 'MIRROR_PLAN_CHANGED')
  assert.strictEqual(failed.externalWritesMayHaveOccurred, false)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, '')
  assert.ok(!store.snapshot().feishuSyncScheduler.activeLease)
}

async function testCommitFailureKeepsBusinessDbUntouchedAndUnknown() {
  const store = createStore()
  let commitCalls = 0
  const { worker } = makeWorker({
    store,
    ids: ['run-commit-failure'],
    sync: async (db, actorId, options) => {
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
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

function testLegacyMirrorDigestUnknownNeedsExplicitExactResolution() {
  const nowMs = 1_800_000_000_000
  const runId = 'feishu-sync-legacy-prewrite-digest'
  const legacyRun = {
    version: 2,
    runId,
    state: STATES.UNKNOWN,
    dryRun: false,
    errorCode: 'MIRROR_PLAN_CHANGED',
    mirrorPlanSha256: SHA.mirror,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 4,
    externalWritesMayHaveOccurred: true,
    applyIntentAt: nowMs - 10_000,
    attemptCount: 1,
    recoveryCount: 0,
    createdAt: nowMs - 20_000,
    updatedAt: nowMs - 5_000,
    finishedAt: nowMs - 5_000,
    lease: null
  }
  const store = createStore({
    feishuSyncRuns: [legacyRun],
    feishuSyncScheduler: { blockedRunId: runId },
    feishuSyncCommitMarkers: {}
  })
  const { worker } = makeWorker({
    store,
    now: () => nowMs,
    sync: async () => { throw new Error('显式解阻不得调用同步') }
  })
  const evidence = {
    runId,
    expectedErrorCode: 'MIRROR_PLAN_CHANGED',
    expectedMirrorPlanSha256: SHA.mirror,
    evidenceContract: 'worker-v2-mirror-digest-before-first-write-v1'
  }
  assert.throws(
    () => worker.resolveLegacyPrewriteDigestUnknown({
      ...evidence,
      expectedMirrorPlanSha256: 'f'.repeat(64)
    }),
    (error) => error && error.code === 'LEGACY_PREWRITE_EVIDENCE_MISMATCH'
  )
  assert.strictEqual(store.snapshot().feishuSyncRuns[0].state, STATES.UNKNOWN)

  const resolved = worker.resolveLegacyPrewriteDigestUnknown(evidence)
  assert.strictEqual(resolved.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(resolved.externalWritesMayHaveOccurred, false)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, '')
  const persisted = store.snapshot().feishuSyncRuns[0]
  assert.strictEqual(persisted.resolutionCode, 'LEGACY_MIRROR_DIGEST_PREWRITE_CONFIRMED')
  assert.strictEqual(persisted.resolvedAt, nowMs)

  const unsafeCases = [
    { label: 'version', run: { version: 3 } },
    { label: 'state', run: { state: STATES.BLOCKED } },
    { label: 'dry-run', run: { dryRun: true } },
    { label: 'external-write-flag', run: { externalWritesMayHaveOccurred: false } },
    { label: 'apply-intent', run: { applyIntentAt: 0 } },
    { label: 'exact-intent', run: { externalWriteIntentAt: nowMs - 9_000 } },
    { label: 'intent-evidence', run: { writeIntentEvidenceVersion: 1 } },
    { label: 'attempt', run: { attemptCount: 2 } },
    { label: 'recovery', run: { recoveryCount: 1 } },
    { label: 'run-lease', run: { lease: { owner: 'other', fence: 1, expiresAt: nowMs + 1_000 } } },
    { label: 'run-marker', run: { commitMarkerSha256: 'a'.repeat(64) } },
    { label: 'apply-summary', run: { applyResultSummary: { complete: false } } },
    { label: 'result-summary', run: { resultSummary: { complete: false } } },
    { label: 'error-code', run: { errorCode: 'APPLY_FAILED' } },
    { label: 'db-marker', commitMarker: { markerSha256: 'b'.repeat(64) } },
    { label: 'blocked-run', blockedRunId: 'another-unknown-run' },
    {
      label: 'active-lease',
      activeLease: {
        runId: 'another-run',
        owner: 'other',
        fence: 2,
        acquiredAt: nowMs - 1_000,
        expiresAt: nowMs + 1_000
      }
    },
    { label: 'extra-input', evidence: { extra: true } }
  ]
  for (const unsafeCase of unsafeCases) {
    const unsafeRunId = `unsafe-${unsafeCase.label}`
    const unsafeErrorCode = unsafeCase.run && unsafeCase.run.errorCode || 'MIRROR_PLAN_CHANGED'
    const unsafeStore = createStore({
      feishuSyncRuns: [{ ...legacyRun, ...(unsafeCase.run || {}), runId: unsafeRunId }],
      feishuSyncScheduler: {
        blockedRunId: unsafeCase.blockedRunId || unsafeRunId,
        activeLease: unsafeCase.activeLease || null
      },
      feishuSyncCommitMarkers: unsafeCase.commitMarker
        ? { [unsafeRunId]: unsafeCase.commitMarker }
        : {}
    })
    const unsafeWorker = makeWorker({
      store: unsafeStore,
      now: () => nowMs,
      sync: async () => { throw new Error('不安全证据不得调用同步') }
    }).worker
    assert.throws(
      () => unsafeWorker.resolveLegacyPrewriteDigestUnknown({
        ...evidence,
        ...(unsafeCase.evidence || {}),
        runId: unsafeRunId,
        expectedErrorCode: unsafeErrorCode
      }),
      (error) => error && error.code === 'LEGACY_PREWRITE_EVIDENCE_MISMATCH',
      `旧任务不安全解阻证据必须被拒绝：${unsafeCase.label}`
    )
    assert.strictEqual(
      unsafeStore.snapshot().feishuSyncRuns[0].state,
      unsafeCase.run && unsafeCase.run.state || STATES.UNKNOWN,
      '拒绝解阻时必须保持原任务状态'
    )
    assert.strictEqual(
      unsafeStore.snapshot().feishuSyncScheduler.blockedRunId,
      unsafeCase.blockedRunId || unsafeRunId,
      '拒绝解阻时必须保持原 scheduler blocker'
    )
  }
}

async function testReconciledPartialUnknownAtomicallyQueuesOneFreshRun() {
  const nowMs = 1_800_000_000_000
  const runId = 'feishu-sync-partial-base-unknown'
  const oldRun = {
    version: 3,
    runId,
    runNowMs: nowMs - 30_000,
    state: STATES.UNKNOWN,
    trigger: 'manual',
    dryRun: false,
    actorType: 'manual',
    actorId: 'admin:partial-reconcile',
    errorCode: 'UNKNOWN_ERROR',
    mirrorPlanSha256: SHA.mirror,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 4,
    externalWritesMayHaveOccurred: true,
    applyIntentAt: nowMs - 20_000,
    externalWriteIntentAt: nowMs - 20_000,
    writeIntentEvidenceVersion: 1,
    attemptCount: 1,
    recoveryCount: 0,
    createdAt: nowMs - 30_000,
    updatedAt: nowMs - 10_000,
    finishedAt: nowMs - 10_000,
    lease: null
  }
  const store = createStore({
    listings: [{ id: 'business-data-must-stay-untouched' }],
    feishuSyncRuns: [oldRun],
    feishuSyncScheduler: { blockedRunId: runId, activeLease: null },
    feishuSyncCommitMarkers: {}
  })
  let reconcileCalls = 0
  let syncCalls = 0
  const expectedEvidence = partialReconciliationEvidence(runId)
  const { worker } = makeWorker({
    store,
    now: () => nowMs,
    ids: ['partial-continuation'],
    sync: async () => {
      syncCalls += 1
      throw new Error('对账解阻只能排队，不得隐式执行同步')
    },
    reconcilePartialBaseWrites: async (businessDb, input) => {
      reconcileCalls += 1
      assert.deepStrictEqual(businessDb.listings, [{ id: 'business-data-must-stay-untouched' }])
      assert.strictEqual(input.runId, runId)
      assert.strictEqual(input.runNowMs, oldRun.runNowMs)
      assert.strictEqual(input.expectedMirrorPlanSha256, SHA.mirror)
      return clone(expectedEvidence)
    }
  })

  const resolved = await worker.resolveAndEnqueueReconciledPartial(runId)
  assert.strictEqual(resolved.resolvedRun.state, STATES.RECONCILED_PARTIAL)
  assert.strictEqual(resolved.resolvedRun.externalWritesMayHaveOccurred, true, '旧任务的外部写事实不得被抹成 false')
  assert.strictEqual(resolved.resolvedRun.errorCode, 'UNKNOWN_ERROR', '旧任务原始未知错误必须保留')
  assert.strictEqual(resolved.resolvedRun.resolutionCode, 'PARTIAL_BASE_WRITES_RECONCILED')
  assert.strictEqual(resolved.continuationRun.state, STATES.QUEUED)
  assert.strictEqual(resolved.continuationRun.runId, 'feishu-sync-partial-continuation')
  assert.strictEqual(syncCalls, 0, '对账解阻不得执行 fresh run')

  const persisted = store.snapshot()
  const persistedOld = persisted.feishuSyncRuns.find((run) => run.runId === runId)
  const continuation = persisted.feishuSyncRuns.find((run) => run.runId === resolved.continuationRun.runId)
  assert.strictEqual(persistedOld.state, STATES.RECONCILED_PARTIAL)
  assert.strictEqual(persistedOld.reconciliationEvidenceSha256, expectedEvidence.evidenceSha256)
  assert.strictEqual(persistedOld.continuationRunId, continuation.runId)
  assert.match(persistedOld.sourceUnknownRunSha256, /^[0-9a-f]{64}$/)
  assert.match(persistedOld.continuationSeedSha256, /^[0-9a-f]{64}$/)
  assert.strictEqual(continuation.continuationOfRunId, runId)
  assert.strictEqual(continuation.sourceUnknownRunSha256, persistedOld.sourceUnknownRunSha256)
  assert.strictEqual(continuation.reconciliationEvidenceSha256, expectedEvidence.evidenceSha256)
  assert.strictEqual(continuation.requestKeySha256.length, 64)
  assert.strictEqual(persisted.feishuSyncScheduler.blockedRunId, '')
  assert.strictEqual(persisted.feishuSyncScheduler.lastRunId, continuation.runId)
  assert.deepStrictEqual(persisted.listings, [{ id: 'business-data-must-stay-untouched' }])

  const repeated = await worker.resolveAndEnqueueReconciledPartial(runId)
  assert.strictEqual(repeated.continuationRun.runId, continuation.runId, '重复调用只能返回同一个续跑任务')
  assert.strictEqual(reconcileCalls, 1, '已经原子解阻后不得再次联网对账')
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, 2, '重复调用不得生成第二个 fresh run')

  const pristineResolvedState = store.snapshot()
  for (const corruption of [
    {
      label: 'continuation 伪造 succeeded 但没有 commit marker',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === continuation.runId).state = STATES.SUCCEEDED
      }
    },
    {
      label: 'continuation 伪造 unknown 但没有外写事实和 blocker',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === continuation.runId).state = STATES.UNKNOWN
      }
    },
    {
      label: 'continuation 原子入队记录被改动',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === continuation.runId).createdAt += 1
      }
    },
    {
      label: '解阻时间不得早于或等于旧任务完成时间',
      mutate(db) {
        const old = db.feishuSyncRuns.find((run) => run.runId === runId)
        old.resolvedAt = old.finishedAt
        old.updatedAt = old.finishedAt
        const fresh = db.feishuSyncRuns.find((run) => run.runId === continuation.runId)
        fresh.runNowMs = old.finishedAt
        fresh.createdAt = old.finishedAt
        fresh.updatedAt = old.finishedAt
        old.continuationSeedSha256 = stableSha256(fresh)
      }
    },
    {
      label: '已解阻旧任务的 runNowMs 被改动',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === runId).runNowMs += 1
      }
    },
    {
      label: '已解阻旧任务的原始外写事实被抹除',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === runId).externalWritesMayHaveOccurred = false
      }
    }
  ]) {
    const corruptStore = createStore(pristineResolvedState)
    corruptStore.updateDb(corruption.mutate)
    let unexpectedReads = 0
    const corruptWorker = makeWorker({
      store: corruptStore,
      sync: async () => { throw new Error('快路径不得执行同步') },
      reconcilePartialBaseWrites: async () => {
        unexpectedReads += 1
        return clone(expectedEvidence)
      }
    }).worker
    await assert.rejects(
      corruptWorker.resolveAndEnqueueReconciledPartial(runId),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      `已解阻快路径必须拒绝：${corruption.label}`
    )
    assert.strictEqual(unexpectedReads, 0, `已解阻证据损坏时不得重新联网：${corruption.label}`)
  }

  worker.recover()
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, '', '合法对账终态不得被 recover 重新设为 blocker')
  assert.strictEqual(
    worker.enqueue({ trigger: 'manual' }).runId,
    continuation.runId,
    'fresh run 未完成前，普通正式入队只能命中同一个续跑任务'
  )
}

async function testReconciledZeroWriteUnknownQueuesDryRunOnly() {
  const nowMs = 1_800_000_100_000
  const runId = 'feishu-sync-zero-base-write-unknown'
  const oldRun = exactPartialUnknownRun(runId, nowMs)
  const store = createStore({
    listings: [{ id: 'business-zero-write-must-stay-untouched' }],
    feishuSyncRuns: [oldRun],
    feishuSyncScheduler: { blockedRunId: runId, activeLease: null },
    feishuSyncCommitMarkers: {}
  })
  const evidence = partialReconciliationEvidence(runId, {
    archiveCount: 0,
    historyCount: 0,
    archiveEvidenceSha256: stableSha256([]),
    historyEvidenceSha256: stableSha256([])
  })
  let reconcileCalls = 0
  let syncCalls = 0
  const { worker } = makeWorker({
    store,
    now: () => nowMs,
    ids: ['zero-write-dry-run'],
    sync: async () => {
      syncCalls += 1
      return dryResult()
    },
    reconcilePartialBaseWrites: async (businessDb, input) => {
      reconcileCalls += 1
      assert.deepStrictEqual(businessDb.listings, [{ id: 'business-zero-write-must-stay-untouched' }])
      assert.strictEqual(input.runId, runId)
      return clone(evidence)
    }
  })

  const resolved = await worker.resolveAndEnqueueReconciledPartial(runId)
  assert.strictEqual(resolved.resolvedRun.state, STATES.RECONCILED_PARTIAL)
  assert.strictEqual(resolved.resolvedRun.resolutionCode, 'ZERO_BASE_WRITES_RECONCILED')
  assert.strictEqual(resolved.resolvedRun.externalWritesMayHaveOccurred, true, '旧 UNKNOWN 的保守外写事实必须保留')
  assert.strictEqual(resolved.continuationRun.state, STATES.QUEUED)
  assert.strictEqual(resolved.continuationRun.dryRun, true, '五表零业务增量解阻后只能排队全新只读预演')
  assert.strictEqual(syncCalls, 0, '解阻入口不得隐式运行 dry-run 或正式同步')

  const persisted = store.snapshot()
  const persistedOld = persisted.feishuSyncRuns.find((run) => run.runId === runId)
  const continuation = persisted.feishuSyncRuns.find((run) => run.runId === resolved.continuationRun.runId)
  assert.strictEqual(persistedOld.reconciliationEvidence.archiveCount, 0)
  assert.strictEqual(persistedOld.reconciliationEvidence.historyCount, 0)
  assert.strictEqual(continuation.dryRun, true)
  assert.strictEqual(
    persisted.feishuSyncScheduler.blockedRunId,
    runId,
    '全新 dry-run 完整成功前必须保留零写入恢复屏障'
  )
  assert.deepStrictEqual(persisted.listings, [{ id: 'business-zero-write-must-stay-untouched' }])

  const repeated = await worker.resolveAndEnqueueReconciledPartial(runId)
  assert.strictEqual(repeated.continuationRun.runId, continuation.runId, '重复解阻只能返回同一只读预演任务')
  assert.strictEqual(reconcileCalls, 1, '已原子解阻后不得再次读取飞书五表')
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, 2, '重复解阻不得生成第二个任务')

  for (const barrierCorruption of [
    {
      label: '零写入屏障的解阻时间不晚于旧任务完成时间',
      mutate(old) {
        old.resolvedAt = old.finishedAt
        old.updatedAt = old.finishedAt
      }
    },
    {
      label: '零写入屏障的原始 UNKNOWN 身份发生漂移',
      mutate(old) {
        old.contentPlanAssetCount += 1
      }
    }
  ]) {
    const corruptBarrierStore = createStore(store.snapshot())
    corruptBarrierStore.updateDb((db) => {
      barrierCorruption.mutate(db.feishuSyncRuns.find((run) => run.runId === runId))
    })
    const corruptBarrierWorker = makeWorker({
      store: corruptBarrierStore,
      sync: async () => { throw new Error('损坏屏障不得执行预演') }
    }).worker
    assert.throws(
      () => corruptBarrierWorker.enqueue({ trigger: 'manual', dryRun: true }),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      barrierCorruption.label
    )
    assert.strictEqual(corruptBarrierStore.snapshot().feishuSyncRuns.length, 2)
  }

  for (const retryPairCorruption of [
    {
      label: '只存在重试任务 ID',
      mutate(old) {
        old.dryRunRetryRunId = continuation.runId
      }
    },
    {
      label: '只存在重试任务种子',
      mutate(old) {
        old.dryRunRetrySeedSha256 = 'f'.repeat(64)
      }
    }
  ]) {
    const halfPairStore = createStore(store.snapshot())
    halfPairStore.updateDb((db) => {
      retryPairCorruption.mutate(db.feishuSyncRuns.find((run) => run.runId === runId))
    })
    let halfPairSyncCalls = 0
    const halfPairWorker = makeWorker({
      store: halfPairStore,
      now: () => nowMs,
      sync: async () => {
        halfPairSyncCalls += 1
        return dryResult()
      }
    }).worker
    const beforeHalfPair = halfPairStore.snapshot()
    assert.throws(
      () => halfPairWorker.enqueue({ trigger: 'manual', dryRun: true }),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      `${retryPairCorruption.label}时入队必须失败关闭`
    )
    assert.deepStrictEqual(halfPairStore.snapshot(), beforeHalfPair)
    await assert.rejects(
      halfPairWorker.run(continuation.runId, { workerId: 'half-retry-pair-worker' }),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      `${retryPairCorruption.label}时领取执行权必须失败关闭`
    )
    assert.strictEqual(halfPairSyncCalls, 0)
    assert.deepStrictEqual(halfPairStore.snapshot(), beforeHalfPair)
  }

  for (const pointerCorruption of [
    {
      label: '零写恢复屏障状态漂移',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === runId).state = STATES.DRY_SUCCEEDED
      }
    },
    {
      label: '零写恢复屏障指针丢失',
      mutate(db) {
        db.feishuSyncScheduler.blockedRunId = ''
      }
    }
  ]) {
    const pointerStore = createStore(store.snapshot())
    pointerStore.updateDb(pointerCorruption.mutate)
    let pointerSyncCalls = 0
    const pointerWorker = makeWorker({
      store: pointerStore,
      now: () => nowMs,
      sync: async () => {
        pointerSyncCalls += 1
        return dryResult()
      }
    }).worker
    const beforePointerAttempt = pointerStore.snapshot()
    await assert.rejects(
      pointerWorker.run(continuation.runId, { workerId: 'missing-barrier-pointer-worker' }),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      `${pointerCorruption.label}时恢复预演不得领取执行权`
    )
    assert.strictEqual(pointerSyncCalls, 0)
    assert.deepStrictEqual(pointerStore.snapshot(), beforePointerAttempt)
    assert.throws(
      () => pointerWorker.enqueue({ trigger: 'manual', dryRun: false }),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      `${pointerCorruption.label}时正式任务仍必须失败关闭`
    )
    assert.deepStrictEqual(pointerStore.snapshot(), beforePointerAttempt)
  }

  assert.throws(
    () => worker.enqueue({ trigger: 'manual', dryRun: false, actorId: 'admin:formal-bypass' }),
    (error) => error && error.code === 'ZERO_WRITE_DRY_RUN_REQUIRED',
    '零写入恢复的 dry-run 尚未成功时，普通正式入队必须失败关闭'
  )
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, 2, '正式入队被阻断时不得创建第三个任务')
  assert.strictEqual(syncCalls, 0, '入队门禁不得隐式执行 dry-run 或正式同步')
  assert.throws(
    () => worker.enqueue({ trigger: 'scheduled', dryRun: false, scheduledAt: nowMs }),
    (error) => error && error.code === 'ZERO_WRITE_DRY_RUN_REQUIRED',
    '零写入恢复的 dry-run 尚未成功时，定时正式入队也必须失败关闭'
  )
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, 2, '定时正式入队被阻断时不得创建第三个任务')
  assert.strictEqual(syncCalls, 0, '定时入队门禁不得隐式执行同步')

  const dryRunningStore = createStore(store.snapshot())
  dryRunningStore.updateDb((db) => {
    const running = db.feishuSyncRuns.find((run) => run.runId === continuation.runId)
    running.state = STATES.DRY_RUNNING
    running.startedAt = nowMs
    running.updatedAt = nowMs
    running.attemptCount = 1
    running.lease = {
      runId: running.runId,
      owner: 'a'.repeat(64),
      fence: 1,
      acquiredAt: nowMs,
      expiresAt: nowMs + 60_000
    }
    db.feishuSyncScheduler.activeLease = clone(running.lease)
  })
  const dryRunningWorker = makeWorker({
    store: dryRunningStore,
    now: () => nowMs,
    sync: async () => { throw new Error('运行中的恢复预演不得被正式任务越过') }
  }).worker
  assert.throws(
    () => dryRunningWorker.enqueue({ trigger: 'manual', dryRun: false }),
    (error) => error && error.code === 'ZERO_WRITE_DRY_RUN_REQUIRED',
    '恢复预演处于 dry-running 时仍必须阻断普通正式入队'
  )
  assert.strictEqual(dryRunningStore.snapshot().feishuSyncRuns.length, 2)

  const blockedDryStore = createStore(store.snapshot())
  let blockedDrySyncCalls = 0
  const blockedDryWorker = makeWorker({
    store: blockedDryStore,
    now: () => nowMs + 1,
    sync: async () => {
      blockedDrySyncCalls += 1
      return dryResult({ schemaSha256: '' })
    }
  }).worker
  const blockedDryResult = await blockedDryWorker.run(continuation.runId, {
    workerId: 'zero-write-blocked-dry-worker'
  })
  assert.strictEqual(blockedDryResult.state, STATES.BLOCKED)
  assert.strictEqual(blockedDryResult.errorCode, 'SCHEMA_DIGEST_MISSING')
  assert.strictEqual(blockedDrySyncCalls, 1)
  assert.strictEqual(
    blockedDryStore.snapshot().feishuSyncScheduler.blockedRunId,
    runId,
    '绑定恢复 dry 发生写前 BLOCKED 时必须保留旧零写入证据屏障'
  )
  assert.throws(
    () => blockedDryWorker.enqueue({ trigger: 'manual', dryRun: false }),
    (error) => error && error.code === 'ZERO_WRITE_DRY_RUN_REQUIRED'
  )
  assert.throws(
    () => blockedDryWorker.enqueue({
      trigger: 'scheduled',
      dryRun: false,
      scheduledAt: nowMs + 1
    }),
    (error) => error && error.code === 'ZERO_WRITE_DRY_RUN_REQUIRED'
  )
  assert.strictEqual(blockedDryStore.snapshot().feishuSyncRuns.length, 2)
  assert.strictEqual(blockedDrySyncCalls, 1, '正式任务被阻断时不得再次执行同步')

  const tamperedStore = createStore(store.snapshot())
  tamperedStore.updateDb((db) => {
    db.feishuSyncRuns.find((run) => run.runId === continuation.runId).dryRun = false
  })
  const tamperedWorker = makeWorker({
    store: tamperedStore,
    sync: async () => { throw new Error('篡改快路径不得执行同步') },
    reconcilePartialBaseWrites: async () => { throw new Error('篡改快路径不得重新联网') }
  }).worker
  await assert.rejects(
    tamperedWorker.resolveAndEnqueueReconciledPartial(runId),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '把零写入续跑从 dry-run 篡改为正式写入必须失败关闭'
  )

  const unrelatedDryStore = createStore(store.snapshot())
  const unrelatedDryRunId = 'feishu-sync-unrelated-dry-run'
  unrelatedDryStore.updateDb((db) => {
    db.feishuSyncRuns.unshift({
      version: 3,
      runId: unrelatedDryRunId,
      state: STATES.QUEUED,
      trigger: 'manual',
      dryRun: true,
      actorType: 'manual',
      actorId: 'admin:unrelated-dry',
      bucket: null,
      requestKeySha256: '',
      runNowMs: nowMs,
      createdAt: nowMs,
      updatedAt: nowMs,
      attemptCount: 0,
      recoveryCount: 0,
      externalWritesMayHaveOccurred: false,
      writeIntentEvidenceVersion: 1,
      lease: null,
      errorCode: ''
    })
  })
  const unrelatedDryWorker = makeWorker({
    store: unrelatedDryStore,
    now: () => nowMs,
    sync: async () => { throw new Error('未授权 dry-run 不得联网') }
  }).worker
  const beforeUnrelatedDry = unrelatedDryStore.snapshot()
  assert.throws(
    () => unrelatedDryWorker.enqueue({ trigger: 'manual', dryRun: true }),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '已有未授权 queued dry-run 时，入队复用必须失败关闭'
  )
  assert.deepStrictEqual(unrelatedDryStore.snapshot(), beforeUnrelatedDry)
  await assert.rejects(
    unrelatedDryWorker.run(unrelatedDryRunId, { workerId: 'unrelated-dry-worker' }),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '存在零写恢复屏障时，未授权 dry-run 必须在领取执行权前失败关闭'
  )
  assert.deepStrictEqual(unrelatedDryStore.snapshot(), beforeUnrelatedDry)
  assert.throws(
    () => unrelatedDryWorker.enqueue({ trigger: 'manual', dryRun: false }),
    (error) => error && error.code === 'ZERO_WRITE_DRY_RUN_REQUIRED'
  )

  const failedDryStore = createStore(store.snapshot())
  failedDryStore.updateDb((db) => {
    const failed = db.feishuSyncRuns.find((run) => run.runId === continuation.runId)
    failed.state = STATES.FAILED_BEFORE_WRITE
    failed.finishedAt = nowMs
    failed.updatedAt = nowMs
    failed.errorCode = 'SYNC_FAILED'
  })
  let failedDrySyncCalls = 0
  const failedDryWorker = makeWorker({
    store: failedDryStore,
    now: () => nowMs + 1,
    ids: ['zero-write-bound-dry-retry'],
    sync: async () => {
      failedDrySyncCalls += 1
      return dryResult()
    }
  }).worker
  assert.throws(
    () => failedDryWorker.enqueue({ trigger: 'manual', dryRun: false }),
    (error) => error && error.code === 'ZERO_WRITE_DRY_RUN_REQUIRED',
    '绑定恢复 dry 失败后，人工正式任务仍必须被旧屏障阻断'
  )
  assert.throws(
    () => failedDryWorker.enqueue({
      trigger: 'scheduled',
      dryRun: false,
      scheduledAt: nowMs + 1
    }),
    (error) => error && error.code === 'ZERO_WRITE_DRY_RUN_REQUIRED',
    '绑定恢复 dry 失败后，定时正式任务仍必须被旧屏障阻断'
  )
  assert.strictEqual(failedDryStore.snapshot().feishuSyncRuns.length, 2)
  assert.strictEqual(failedDrySyncCalls, 0)

  const retryAtomicBaseStore = createStore(failedDryStore.snapshot())
  let retryInsertFaultInjected = false
  const retryAtomicFaultStore = {
    readDb: () => retryAtomicBaseStore.readDb(),
    snapshot: () => retryAtomicBaseStore.snapshot(),
    updateDb(mutator) {
      return retryAtomicBaseStore.updateDb((db) => {
        db.feishuSyncRuns.unshift = () => {
          retryInsertFaultInjected = true
          throw new Error('INJECT_RETRY_INSERT_FAILURE')
        }
        return mutator(db)
      })
    }
  }
  const retryAtomicWorker = makeWorker({
    store: retryAtomicFaultStore,
    now: () => nowMs + 1,
    ids: ['zero-write-bound-dry-atomic-fault'],
    sync: async () => dryResult()
  }).worker
  const beforeRetryAtomicFault = retryAtomicFaultStore.snapshot()
  assert.throws(
    () => retryAtomicWorker.enqueue({ trigger: 'manual', dryRun: true }),
    /INJECT_RETRY_INSERT_FAILURE/,
    '更新当前重试指针后若插入任务失败，整笔事务必须回滚'
  )
  assert.strictEqual(retryInsertFaultInjected, true)
  assert.deepStrictEqual(retryAtomicFaultStore.snapshot(), beforeRetryAtomicFault)

  const boundRetry = failedDryWorker.enqueue({
    trigger: 'manual',
    dryRun: true,
    actorId: 'admin:bound-dry-retry'
  })
  const persistedBoundRetry = failedDryStore.snapshot().feishuSyncRuns.find((run) => (
    run.runId === boundRetry.runId
  ))
  const retryBarrier = failedDryStore.snapshot().feishuSyncRuns.find((run) => run.runId === runId)
  assert.strictEqual(persistedBoundRetry.continuationOfRunId, runId)
  assert.strictEqual(persistedBoundRetry.actorId, retryBarrier.actorId)
  assert.strictEqual(persistedBoundRetry.sourceUnknownRunSha256, persistedOld.sourceUnknownRunSha256)
  assert.strictEqual(
    persistedBoundRetry.reconciliationEvidenceSha256,
    persistedOld.reconciliationEvidenceSha256,
    '失败后的只读重试必须继承同一零写入证据绑定'
  )
  assert.strictEqual(retryBarrier.dryRunRetryRunId, boundRetry.runId)
  assert.match(retryBarrier.dryRunRetrySeedSha256, /^[0-9a-f]{64}$/)

  const badRetrySeedStore = createStore(failedDryStore.snapshot())
  badRetrySeedStore.updateDb((db) => {
    db.feishuSyncRuns.find((run) => run.runId === runId).dryRunRetrySeedSha256 = 'f'.repeat(64)
  })
  let badRetrySeedSyncCalls = 0
  const badRetrySeedWorker = makeWorker({
    store: badRetrySeedStore,
    now: () => nowMs + 2,
    sync: async () => {
      badRetrySeedSyncCalls += 1
      return dryResult()
    }
  }).worker
  const beforeBadRetrySeed = badRetrySeedStore.snapshot()
  assert.throws(
    () => badRetrySeedWorker.enqueue({ trigger: 'manual', dryRun: true }),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '当前重试种子漂移时不得继续入队'
  )
  assert.deepStrictEqual(badRetrySeedStore.snapshot(), beforeBadRetrySeed)
  await assert.rejects(
    badRetrySeedWorker.run(boundRetry.runId, { workerId: 'bad-retry-seed-worker' }),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '当前重试种子漂移时不得领取执行权'
  )
  assert.strictEqual(badRetrySeedSyncCalls, 0)
  assert.deepStrictEqual(badRetrySeedStore.snapshot(), beforeBadRetrySeed)

  const completionTamperStore = createStore(failedDryStore.snapshot())
  let completionTamperSyncCalls = 0
  const completionTamperWorker = makeWorker({
    store: completionTamperStore,
    now: () => nowMs + 3,
    sync: async () => {
      completionTamperSyncCalls += 1
      completionTamperStore.updateDb((db) => {
        db.feishuSyncRuns.find((run) => run.runId === runId).dryRunRetrySeedSha256 = 'f'.repeat(64)
      })
      return dryResult()
    }
  }).worker
  const completionAfterTamper = await completionTamperWorker.run(boundRetry.runId, {
    workerId: 'completion-rechecks-current-retry-seed'
  })
  assert.strictEqual(completionAfterTamper.state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(completionTamperSyncCalls, 1)
  assert.strictEqual(
    completionTamperStore.snapshot().feishuSyncScheduler.blockedRunId,
    runId,
    '领取执行权后授权种子漂移，即使预演完成也不得清除旧屏障'
  )

  const retryChainStore = createStore(failedDryStore.snapshot())
  let retryChainNow = nowMs + 10
  let retryChainSyncCalls = 0
  const retryChainWorker = makeWorker({
    store: retryChainStore,
    now: () => ++retryChainNow,
    ids: ['zero-write-bound-dry-retry-two'],
    sync: async () => {
      retryChainSyncCalls += 1
      return retryChainSyncCalls === 1
        ? dryResult({ schemaSha256: '' })
        : dryResult()
    }
  }).worker
  const firstRetryBlocked = await retryChainWorker.run(boundRetry.runId, {
    workerId: 'zero-write-bound-dry-retry-one-blocked'
  })
  assert.strictEqual(firstRetryBlocked.state, STATES.BLOCKED)
  assert.strictEqual(retryChainSyncCalls, 1)
  assert.strictEqual(retryChainStore.snapshot().feishuSyncScheduler.blockedRunId, runId)
  const secondRetry = retryChainWorker.enqueue({
    trigger: 'manual',
    dryRun: true,
    actorId: 'admin:must-not-replace-barrier-actor'
  })
  const retryTwoBarrier = retryChainStore.snapshot().feishuSyncRuns.find((run) => run.runId === runId)
  const persistedSecondRetry = retryChainStore.snapshot().feishuSyncRuns.find((run) => (
    run.runId === secondRetry.runId
  ))
  assert.strictEqual(retryTwoBarrier.dryRunRetryRunId, secondRetry.runId)
  assert.match(retryTwoBarrier.dryRunRetrySeedSha256, /^[0-9a-f]{64}$/)
  assert.strictEqual(persistedSecondRetry.actorId, retryTwoBarrier.actorId)
  retryChainStore.updateDb((db) => {
    const staleRetry = db.feishuSyncRuns.find((run) => run.runId === boundRetry.runId)
    staleRetry.state = STATES.QUEUED
    staleRetry.updatedAt = staleRetry.createdAt
    staleRetry.attemptCount = 0
    staleRetry.errorCode = ''
    delete staleRetry.startedAt
    delete staleRetry.finishedAt
  })
  const beforeStaleRetry = retryChainStore.snapshot()
  await assert.rejects(
    retryChainWorker.run(boundRetry.runId, { workerId: 'stale-retry-must-not-replay' }),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '当前授权指针切到第二次重试后，旧重试不得再次执行'
  )
  assert.strictEqual(retryChainSyncCalls, 1)
  assert.deepStrictEqual(retryChainStore.snapshot(), beforeStaleRetry)
  const secondRetryCompleted = await retryChainWorker.run(secondRetry.runId, {
    workerId: 'zero-write-bound-dry-retry-two-success'
  })
  assert.strictEqual(secondRetryCompleted.state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(retryChainSyncCalls, 2)
  assert.strictEqual(retryChainStore.snapshot().feishuSyncScheduler.blockedRunId, '')

  const completedRetry = await failedDryWorker.run(boundRetry.runId, {
    workerId: 'zero-write-bound-dry-retry-worker'
  })
  assert.strictEqual(completedRetry.state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(failedDrySyncCalls, 1)
  assert.strictEqual(failedDryStore.snapshot().feishuSyncScheduler.blockedRunId, '')

  const completedDryRun = await worker.run(continuation.runId, {
    workerId: 'zero-write-dry-run-worker'
  })
  assert.strictEqual(completedDryRun.state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(syncCalls, 1, '恢复屏障只能由这次完整 dry-run 真正执行后解除')
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, '')
  const formalAfterDryRun = worker.enqueue({
    trigger: 'manual',
    dryRun: false,
    actorId: 'admin:after-dry-run'
  })
  assert.strictEqual(formalAfterDryRun.dryRun, false, '完整 dry-run 成功后才允许新建正式任务')
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, 3)
}

async function testUnknownContinuationCanBeReconciledWithoutDroppingParentEvidence() {
  const firstResolvedAt = 1_800_000_200_000
  const parentRunId = 'feishu-sync-parent-partial-unknown'
  const parentUnknown = exactPartialUnknownRun(parentRunId, firstResolvedAt)
  const store = createStore({
    listings: [{ id: 'nested-zero-write-business-must-stay-untouched' }],
    feishuSyncRuns: [parentUnknown],
    feishuSyncScheduler: { blockedRunId: parentRunId, activeLease: null },
    feishuSyncCommitMarkers: {}
  })
  const parentEvidence = partialReconciliationEvidence(parentRunId)
  const parentWorker = makeWorker({
    store,
    now: () => firstResolvedAt,
    ids: ['parent-formal-continuation'],
    sync: async () => { throw new Error('父任务解阻只允许排队') },
    reconcilePartialBaseWrites: async () => clone(parentEvidence)
  }).worker
  const parentResolved = await parentWorker.resolveAndEnqueueReconciledPartial(parentRunId)
  const continuationRunId = parentResolved.continuationRun.runId
  const parentResolvedState = store.snapshot()
  const rawResolvedParent = parentResolvedState.feishuSyncRuns.find((run) => run.runId === parentRunId)
  const rawParentContinuation = parentResolvedState.feishuSyncRuns.find((run) => (
    run.runId === continuationRunId
  ))
  assert.strictEqual(parentResolved.continuationRun.continuationOfRunId, parentRunId)
  assert.match(rawResolvedParent.sourceUnknownRunSha256, /^[0-9a-f]{64}$/)
  assert.strictEqual(
    rawParentContinuation.sourceUnknownRunSha256,
    rawResolvedParent.sourceUnknownRunSha256
  )
  assert.strictEqual(
    rawParentContinuation.reconciliationEvidenceSha256,
    parentEvidence.evidenceSha256
  )
  let executionNow = firstResolvedAt + 1_000
  let executionCalls = 0
  const executionWorker = makeWorker({
    store,
    now: () => ++executionNow,
    sync: async (businessDb, actorId, options) => {
      executionCalls += 1
      if (options.dryRun) return dryResult()
      freezeApplyPlan(options)
      options.onExternalWriteDispatched()
      throw new Error('合成的首笔 Base 新增发送后未知')
    }
  }).worker
  const unknown = await executionWorker.run(continuationRunId, {
    workerId: 'nested-formal-unknown-worker'
  })
  assert.strictEqual(executionCalls, 2, '正式续跑必须先预演，再在 apply 写意图后失败')
  assert.strictEqual(unknown.state, STATES.UNKNOWN)
  assert.strictEqual(unknown.externalWritesMayHaveOccurred, true)
  assert.strictEqual(unknown.continuationOfRunId, parentRunId)
  const naturalUnknownState = store.snapshot()
  const rawUnknown = naturalUnknownState.feishuSyncRuns.find((run) => (
    run.runId === continuationRunId
  ))
  assert.match(rawUnknown.sourceUnknownRunSha256, /^[0-9a-f]{64}$/)
  assert.strictEqual(
    rawUnknown.sourceUnknownRunSha256,
    rawResolvedParent.sourceUnknownRunSha256
  )
  assert.strictEqual(rawUnknown.reconciliationEvidenceSha256, parentEvidence.evidenceSha256)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, continuationRunId)
  const failedAt = unknown.finishedAt

  const zeroEvidence = partialReconciliationEvidence(continuationRunId, {
    archiveCount: 0,
    historyCount: 0,
    archiveEvidenceSha256: stableSha256([]),
    historyEvidenceSha256: stableSha256([])
  })
  const replacementParentEvidence = partialReconciliationEvidence(parentRunId, {
    currentOperationsSha256: 'c'.repeat(64)
  })
  const lineageCorruptions = [
    {
      label: '删除父任务 ID',
      mutate(db) { delete db.feishuSyncRuns.find((run) => run.runId === continuationRunId).continuationOfRunId }
    },
    {
      label: '删除父 UNKNOWN 身份',
      mutate(db) { delete db.feishuSyncRuns.find((run) => run.runId === continuationRunId).sourceUnknownRunSha256 }
    },
    {
      label: '删除父对账证据',
      mutate(db) { delete db.feishuSyncRuns.find((run) => run.runId === continuationRunId).reconciliationEvidenceSha256 }
    },
    {
      label: '篡改父 UNKNOWN 身份',
      mutate(db) { db.feishuSyncRuns.find((run) => run.runId === continuationRunId).sourceUnknownRunSha256 = 'a'.repeat(64) }
    },
    {
      label: '篡改父对账证据',
      mutate(db) { db.feishuSyncRuns.find((run) => run.runId === continuationRunId).reconciliationEvidenceSha256 = 'b'.repeat(64) }
    },
    {
      label: '删除父任务形成孤儿',
      mutate(db) { db.feishuSyncRuns = db.feishuSyncRuns.filter((run) => run.runId !== parentRunId) }
    },
    {
      label: '父任务反向链接被改动',
      mutate(db) { db.feishuSyncRuns.find((run) => run.runId === parentRunId).continuationRunId = 'feishu-sync-other-child' }
    },
    {
      label: '父任务状态不再是已对账',
      mutate(db) { db.feishuSyncRuns.find((run) => run.runId === parentRunId).state = STATES.BLOCKED }
    },
    {
      label: '父任务身份字段被改动',
      mutate(db) { db.feishuSyncRuns.find((run) => run.runId === parentRunId).contentPlanAssetCount += 1 }
    },
    {
      label: '父证据与子绑定被整体替换',
      mutate(db) {
        const parent = db.feishuSyncRuns.find((run) => run.runId === parentRunId)
        const child = db.feishuSyncRuns.find((run) => run.runId === continuationRunId)
        parent.reconciliationEvidence = clone(replacementParentEvidence)
        parent.reconciliationEvidenceSha256 = replacementParentEvidence.evidenceSha256
        child.reconciliationEvidenceSha256 = replacementParentEvidence.evidenceSha256
      }
    },
    {
      label: '续跑 UNKNOWN 预塞父身份字段',
      mutate(db) {
        const child = db.feishuSyncRuns.find((run) => run.runId === continuationRunId)
        child.parentSourceUnknownRunSha256 = 'd'.repeat(64)
        child.parentReconciliationEvidenceSha256 = 'e'.repeat(64)
      }
    },
    {
      label: '父任务出现重复记录',
      mutate(db) {
        const parent = db.feishuSyncRuns.find((run) => run.runId === parentRunId)
        db.feishuSyncRuns.push(clone(parent))
      }
    },
    {
      label: '续跑任务形成自引用',
      mutate(db) {
        db.feishuSyncRuns.find((run) => (
          run.runId === continuationRunId
        )).continuationOfRunId = continuationRunId
      }
    }
  ]
  for (const corruption of lineageCorruptions) {
    const corruptStore = createStore(naturalUnknownState)
    corruptStore.updateDb(corruption.mutate)
    const before = corruptStore.snapshot()
    let unexpectedReads = 0
    const corruptWorker = makeWorker({
      store: corruptStore,
      now: () => failedAt + 10_000,
      sync: async () => { throw new Error('父证据损坏不得执行同步') },
      reconcilePartialBaseWrites: async () => {
        unexpectedReads += 1
        return clone(zeroEvidence)
      }
    }).worker
    await assert.rejects(
      corruptWorker.resolveAndEnqueueReconciledPartial(continuationRunId),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      `父级续跑身份损坏必须失败关闭：${corruption.label}`
    )
    assert.strictEqual(unexpectedReads, 0, `父级续跑身份损坏时不得读取飞书：${corruption.label}`)
    assert.deepStrictEqual(corruptStore.snapshot(), before, `拒绝时数据库必须逐字不变：${corruption.label}`)
  }
  let reconcileCalls = 0
  const worker = makeWorker({
    store,
    now: () => failedAt + 10_000,
    ids: ['nested-zero-write-dry-run'],
    sync: async () => { throw new Error('再次解阻只允许排队 dry-run') },
    reconcilePartialBaseWrites: async (businessDb, input) => {
      reconcileCalls += 1
      assert.deepStrictEqual(
        businessDb.listings,
        [{ id: 'nested-zero-write-business-must-stay-untouched' }]
      )
      assert.strictEqual(input.runId, continuationRunId)
      return clone(zeroEvidence)
    }
  }).worker

  const resolved = await worker.resolveAndEnqueueReconciledPartial(continuationRunId)
  assert.strictEqual(reconcileCalls, 1)
  assert.strictEqual(resolved.resolvedRun.state, STATES.RECONCILED_PARTIAL)
  assert.strictEqual(resolved.resolvedRun.resolutionCode, 'ZERO_BASE_WRITES_RECONCILED')
  assert.strictEqual(resolved.continuationRun.state, STATES.QUEUED)
  assert.strictEqual(resolved.continuationRun.dryRun, true)
  const persisted = store.snapshot()
  const persistedParent = persisted.feishuSyncRuns.find((run) => run.runId === parentRunId)
  const persistedUnknown = persisted.feishuSyncRuns.find((run) => run.runId === continuationRunId)
  assert.strictEqual(persistedUnknown.continuationOfRunId, parentRunId)
  assert.strictEqual(
    persistedUnknown.parentSourceUnknownRunSha256,
    persistedParent.sourceUnknownRunSha256,
    '再次解阻必须保留父 UNKNOWN 身份，不能被本轮身份摘要覆盖'
  )
  assert.strictEqual(
    persistedUnknown.parentReconciliationEvidenceSha256,
    persistedParent.reconciliationEvidenceSha256,
    '再次解阻必须保留父对账证据，不能被本轮证据摘要覆盖'
  )
  assert.notStrictEqual(
    persistedUnknown.sourceUnknownRunSha256,
    persistedUnknown.parentSourceUnknownRunSha256,
    '本轮 UNKNOWN 身份与父 UNKNOWN 身份必须分开保存'
  )
  assert.strictEqual(persistedUnknown.reconciliationEvidenceSha256, zeroEvidence.evidenceSha256)
  const nestedDry = persisted.feishuSyncRuns.find((run) => (
    run.runId === resolved.continuationRun.runId
  ))
  assert.strictEqual(nestedDry.continuationOfRunId, continuationRunId)
  assert.strictEqual(nestedDry.sourceUnknownRunSha256, persistedUnknown.sourceUnknownRunSha256)
  assert.strictEqual(
    nestedDry.reconciliationEvidenceSha256,
    persistedUnknown.reconciliationEvidenceSha256
  )
  assert.strictEqual(persisted.feishuSyncScheduler.blockedRunId, continuationRunId)
  assert.deepStrictEqual(
    persisted.listings,
    [{ id: 'nested-zero-write-business-must-stay-untouched' }]
  )

  const beforeIdempotent = store.snapshot()
  const idempotent = await worker.resolveAndEnqueueReconciledPartial(continuationRunId)
  assert.strictEqual(idempotent.continuationRun.runId, nestedDry.runId)
  assert.strictEqual(reconcileCalls, 1, '幂等快路径不得再次读取飞书')
  assert.deepStrictEqual(store.snapshot(), beforeIdempotent, '幂等快路径不得重复新增或改写')

  const corruptResolvedStore = createStore(beforeIdempotent)
  corruptResolvedStore.updateDb((db) => {
    db.feishuSyncRuns.find((run) => run.runId === parentRunId).contentPlanAssetCount += 1
  })
  const beforeCorruptFastPath = corruptResolvedStore.snapshot()
  let corruptFastPathReads = 0
  const corruptFastPathWorker = makeWorker({
    store: corruptResolvedStore,
    sync: async () => { throw new Error('坏祖先不得执行同步') },
    reconcilePartialBaseWrites: async () => {
      corruptFastPathReads += 1
      return clone(zeroEvidence)
    }
  }).worker
  await assert.rejects(
    corruptFastPathWorker.resolveAndEnqueueReconciledPartial(continuationRunId),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '已对账快路径也必须重新校验完整祖先链'
  )
  assert.strictEqual(corruptFastPathReads, 0)
  assert.deepStrictEqual(corruptResolvedStore.snapshot(), beforeCorruptFastPath)

  const corruptDryStore = createStore(beforeIdempotent)
  corruptDryStore.updateDb((db) => {
    db.feishuSyncRuns.find((run) => run.runId === parentRunId).contentPlanAssetCount += 1
  })
  let corruptDryCalls = 0
  const corruptDryWorker = makeWorker({
    store: corruptDryStore,
    now: () => failedAt + 20_000,
    sync: async () => {
      corruptDryCalls += 1
      return dryResult()
    }
  }).worker
  const beforeCorruptDry = corruptDryStore.snapshot()
  await assert.rejects(
    corruptDryWorker.run(nestedDry.runId, { workerId: 'corrupt-lineage-dry-worker' }),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '祖先链损坏时，绑定 dry-run 必须在任何飞书读取前失败关闭'
  )
  assert.strictEqual(corruptDryCalls, 0)
  assert.deepStrictEqual(corruptDryStore.snapshot(), beforeCorruptDry)

  for (const bindingMutation of [
    {
      label: 'dry-run 请求键被篡改',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === nestedDry.runId).requestKeySha256 = 'f'.repeat(64)
      }
    },
    {
      label: 'dry-run 发起人被篡改',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === nestedDry.runId).actorId = 'admin:tampered'
      }
    },
    {
      label: 'dry-run 运行时间被篡改',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === nestedDry.runId).runNowMs += 1
      }
    },
    {
      label: 'dry-run 创建时间被篡改',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === nestedDry.runId).createdAt += 1
      }
    },
    {
      label: '屏障绑定的子任务 ID 被篡改',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === continuationRunId).continuationRunId = 'other-dry-run'
      }
    },
    {
      label: '屏障绑定的子任务种子被篡改',
      mutate(db) {
        db.feishuSyncRuns.find((run) => run.runId === continuationRunId).continuationSeedSha256 = 'f'.repeat(64)
      }
    },
    {
      label: '相同 runId 的 dry-run 被复制',
      mutate(db) {
        db.feishuSyncRuns.push(clone(db.feishuSyncRuns.find((run) => run.runId === nestedDry.runId)))
      }
    }
  ]) {
    const bindingStore = createStore(beforeIdempotent)
    bindingStore.updateDb(bindingMutation.mutate)
    const beforeBindingAttempt = bindingStore.snapshot()
    let bindingSyncCalls = 0
    const bindingWorker = makeWorker({
      store: bindingStore,
      now: () => failedAt + 20_000,
      sync: async () => {
        bindingSyncCalls += 1
        return dryResult()
      }
    }).worker
    await assert.rejects(
      bindingWorker.run(nestedDry.runId, { workerId: 'tampered-binding-dry-worker' }),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      bindingMutation.label
    )
    assert.strictEqual(bindingSyncCalls, 0, `${bindingMutation.label}时不得联网`)
    assert.deepStrictEqual(bindingStore.snapshot(), beforeBindingAttempt, `${bindingMutation.label}时不得改库`)
  }

  let nestedDryCalls = 0
  let nestedDryNow = failedAt + 20_000
  const nestedDryWorker = makeWorker({
    store,
    now: () => ++nestedDryNow,
    sync: async () => {
      nestedDryCalls += 1
      return dryResult()
    }
  }).worker
  const completedNestedDry = await nestedDryWorker.run(nestedDry.runId, {
    workerId: 'nested-zero-write-dry-worker'
  })
  assert.strictEqual(completedNestedDry.state, STATES.DRY_SUCCEEDED)
  assert.strictEqual(nestedDryCalls, 1)
  const afterNestedDry = store.snapshot()
  assert.strictEqual(afterNestedDry.feishuSyncScheduler.blockedRunId, '')
  const parentAfterDry = afterNestedDry.feishuSyncRuns.find((run) => run.runId === parentRunId)
  const resolvedAfterDry = afterNestedDry.feishuSyncRuns.find((run) => (
    run.runId === continuationRunId
  ))
  assert.strictEqual(
    resolvedAfterDry.parentSourceUnknownRunSha256,
    persistedUnknown.parentSourceUnknownRunSha256
  )
  assert.strictEqual(
    resolvedAfterDry.parentReconciliationEvidenceSha256,
    persistedUnknown.parentReconciliationEvidenceSha256
  )
  assert.strictEqual(parentAfterDry.sourceUnknownRunSha256, persistedParent.sourceUnknownRunSha256)
  assert.deepStrictEqual(
    afterNestedDry.listings,
    [{ id: 'nested-zero-write-business-must-stay-untouched' }]
  )
  const formalAfterNestedDry = nestedDryWorker.enqueue({
    trigger: 'manual',
    dryRun: false,
    actorId: 'admin:after-nested-zero-write-dry'
  })
  assert.strictEqual(formalAfterNestedDry.dryRun, false)
}

async function testContinuationLineageDepthIsBounded() {
  let clock = 1_900_000_000_000
  const rootRunId = 'feishu-sync-depth-root-unknown'
  const store = createStore({
    listings: [{ id: 'depth-limit-business-sentinel' }],
    feishuSyncRuns: [exactPartialUnknownRun(rootRunId, clock)],
    feishuSyncScheduler: { blockedRunId: rootRunId, activeLease: null },
    feishuSyncCommitMarkers: {}
  })
  let currentRunId = rootRunId

  // 深度 0 到 32 都使用真实 resolver 与真实 worker 状态机生成，避免手拼链路假绿。
  for (let depth = 0; depth <= 32; depth += 1) {
    const evidence = partialReconciliationEvidence(currentRunId)
    let evidenceReads = 0
    const resolver = makeWorker({
      store,
      now: () => ++clock,
      ids: [`depth-child-${depth + 1}`],
      sync: async () => { throw new Error('解阻阶段只允许排队') },
      reconcilePartialBaseWrites: async () => {
        evidenceReads += 1
        return clone(evidence)
      }
    }).worker
    const resolved = await resolver.resolveAndEnqueueReconciledPartial(currentRunId)
    assert.strictEqual(evidenceReads, 1)
    const childRunId = resolved.continuationRun.runId
    let executionCalls = 0
    const executor = makeWorker({
      store,
      now: () => ++clock,
      sync: async (businessDb, actorId, options) => {
        executionCalls += 1
        if (options.dryRun) return dryResult()
        freezeApplyPlan(options)
        options.onExternalWriteDispatched()
        throw new Error('合成的深链首笔写请求未知')
      }
    }).worker
    const unknown = await executor.run(childRunId, {
      workerId: `depth-worker-${depth + 1}`
    })
    assert.strictEqual(executionCalls, 2)
    assert.strictEqual(unknown.state, STATES.UNKNOWN)
    currentRunId = childRunId
  }

  const beforeTooDeep = store.snapshot()
  let tooDeepReads = 0
  const tooDeepWorker = makeWorker({
    store,
    now: () => ++clock,
    ids: ['depth-must-not-be-created'],
    sync: async () => { throw new Error('超深链不得执行同步') },
    reconcilePartialBaseWrites: async () => {
      tooDeepReads += 1
      return partialReconciliationEvidence(currentRunId)
    }
  }).worker
  await assert.rejects(
    tooDeepWorker.resolveAndEnqueueReconciledPartial(currentRunId),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '超过 32 层的恢复链必须在联网前失败关闭'
  )
  assert.strictEqual(tooDeepReads, 0)
  assert.deepStrictEqual(store.snapshot(), beforeTooDeep)
}

async function testPartialReconciliationRejectsDriftWithoutChangingDb() {
  const nowMs = 1_800_000_000_000
  const runId = 'feishu-sync-partial-drift'
  const oldRun = {
    version: 3,
    runId,
    runNowMs: nowMs - 30_000,
    state: STATES.UNKNOWN,
    trigger: 'manual',
    dryRun: false,
    actorType: 'manual',
    actorId: 'admin:partial-reconcile',
    errorCode: 'UNKNOWN_ERROR',
    mirrorPlanSha256: SHA.mirror,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 4,
    externalWritesMayHaveOccurred: true,
    applyIntentAt: nowMs - 20_000,
    externalWriteIntentAt: nowMs - 20_000,
    writeIntentEvidenceVersion: 1,
    attemptCount: 1,
    recoveryCount: 0,
    createdAt: nowMs - 30_000,
    updatedAt: nowMs - 10_000,
    finishedAt: nowMs - 10_000,
    lease: null
  }
  const unsafeCases = [
    {
      label: 'evidence-old-mirror',
      patchEvidence: { priorMirrorPlanSha256: '9'.repeat(64) }
    },
    {
      label: 'evidence-run-identity',
      patchEvidence: { runIdSha256: '8'.repeat(64) }
    },
    {
      label: 'evidence-self-signature',
      rawEvidencePatch: { evidenceSha256: '0'.repeat(64) }
    },
    {
      label: 'zero-count-must-use-empty-evidence-digest',
      patchEvidence: { archiveCount: 0, historyCount: 0 }
    },
    {
      label: 'nonzero-count-must-not-use-empty-evidence-digest',
      patchEvidence: { archiveEvidenceSha256: stableSha256([]) }
    },
    {
      label: 'no-outstanding-main-write-plan',
      patchEvidence: {
        currentPlan: { create: 0, update: 0, deactivate: 0, restore: 0, noop: 43 }
      }
    },
    {
      label: 'strict-attempt-type',
      runPatch: { attemptCount: '1' }
    },
    {
      label: 'strict-version-type',
      runPatch: { version: '3' },
      expectNoReconciliationRead: true
    },
    {
      label: 'strict-updated-at-type',
      runPatch: { updatedAt: String(nowMs - 10_000) },
      expectNoReconciliationRead: true
    },
    {
      label: 'created-at-must-match-run-coordinate',
      runPatch: { createdAt: nowMs - 29_999 },
      expectNoReconciliationRead: true
    },
    {
      label: 'stale-reconciliation-evidence-key',
      runPatch: { reconciliationEvidence: { stale: true } },
      expectNoReconciliationRead: true
    },
    {
      label: 'explicit-empty-resolution-code-key',
      runPatch: { resolutionCode: '' },
      expectNoReconciliationRead: true
    },
    {
      label: 'write-intent-times-differ',
      runPatch: { externalWriteIntentAt: nowMs - 19_999 }
    },
    {
      label: 'reconciliation-time-must-follow-finished-time',
      runPatch: { finishedAt: nowMs, updatedAt: nowMs }
    },
    {
      label: 'active-lease',
      activeLease: {
        runId: 'another-active-run',
        owner: 'another-owner',
        fence: 2,
        acquiredAt: nowMs - 1_000,
        expiresAt: nowMs + 60_000
      }
    },
    {
      label: 'another-unknown',
      extraRun: {
        version: 3,
        runId: 'another-unknown-run',
        state: STATES.UNKNOWN,
        dryRun: false,
        createdAt: nowMs - 1,
        updatedAt: nowMs - 1,
        lease: null
      }
    },
    {
      label: 'duplicate-exact-run-id',
      extraRun: clone(oldRun),
      expectNoReconciliationRead: true
    }
  ]

  for (const unsafeCase of unsafeCases) {
    const store = createStore({
      listings: [{ id: 'must-not-change' }],
      feishuSyncRuns: [{ ...oldRun, ...(unsafeCase.runPatch || {}) }]
        .concat(unsafeCase.extraRun ? [unsafeCase.extraRun] : []),
      feishuSyncScheduler: {
        blockedRunId: runId,
        activeLease: unsafeCase.activeLease || null
      },
      feishuSyncCommitMarkers: {}
    })
    const before = store.snapshot()
    let syncCalls = 0
    let reconciliationReads = 0
    const worker = makeWorker({
      store,
      now: () => nowMs,
      ids: [`must-not-create-${unsafeCase.label}`],
      sync: async () => { syncCalls += 1 },
      reconcilePartialBaseWrites: async () => {
        reconciliationReads += 1
        return {
          ...partialReconciliationEvidence(runId, unsafeCase.patchEvidence || {}),
          ...(unsafeCase.rawEvidencePatch || {})
        }
      }
    }).worker
    await assert.rejects(
      worker.resolveAndEnqueueReconciledPartial(runId),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      `不安全部分写入对账必须拒绝：${unsafeCase.label}`
    )
    assert.deepStrictEqual(store.snapshot(), before, `拒绝后数据库必须逐字节不变：${unsafeCase.label}`)
    assert.strictEqual(syncCalls, 0)
    if (unsafeCase.expectNoReconciliationRead) {
      assert.strictEqual(reconciliationReads, 0, `初始控制面歧义必须在联网前拒绝：${unsafeCase.label}`)
    }
  }
}

async function testPartialReconciliationAtomicRollbackAndConcurrentDriftGuards() {
  const nowMs = 1_800_000_100_000
  const runId = 'feishu-sync-partial-atomic'
  const seed = {
    listings: [{ id: 'business-before' }],
    feishuSyncRuns: [exactPartialUnknownRun(runId, nowMs)],
    feishuSyncScheduler: { blockedRunId: runId, activeLease: null },
    feishuSyncCommitMarkers: {}
  }
  const baseStore = createStore(seed)
  let failAfterMutation = true
  const atomicStore = {
    readDb: baseStore.readDb,
    snapshot: baseStore.snapshot,
    updateDb(mutator) {
      return baseStore.updateDb((working) => {
        const result = mutator(working)
        if (failAfterMutation && working.feishuSyncRuns.some((run) => (
          run && run.state === STATES.RECONCILED_PARTIAL
        ))) {
          failAfterMutation = false
          throw new Error('合成的原子提交失败')
        }
        return result
      })
    }
  }
  const evidence = partialReconciliationEvidence(runId)
  let reconciliationReads = 0
  const worker = makeWorker({
    store: atomicStore,
    now: () => nowMs,
    ids: ['partial-rolled-back', 'partial-after-retry'],
    maxRuns: 1,
    sync: async () => { throw new Error('解阻阶段不得运行 fresh 同步') },
    reconcilePartialBaseWrites: async () => {
      reconciliationReads += 1
      return clone(evidence)
    }
  }).worker
  const before = atomicStore.snapshot()
  await assert.rejects(
    worker.resolveAndEnqueueReconciledPartial(runId),
    /原子提交失败/,
    '旧任务解阻和 fresh run 入队必须同事务失败'
  )
  assert.deepStrictEqual(atomicStore.snapshot(), before, '原子提交失败后数据库必须逐字节不变')
  const resolved = await worker.resolveAndEnqueueReconciledPartial(runId)
  assert.strictEqual(resolved.continuationRun.runId, 'feishu-sync-partial-after-retry')
  assert.strictEqual(
    atomicStore.snapshot().feishuSyncRuns.length,
    2,
    'maxRuns=1 时也必须同时保留对账旧任务与 continuation 审计链'
  )
  atomicStore.updateDb((db) => {
    const old = db.feishuSyncRuns.find((run) => run.runId === runId)
    old.reconciliationEvidence.archiveCount += 1
  })
  await assert.rejects(
    worker.resolveAndEnqueueReconciledPartial(runId),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '已解阻审计证据被篡改时不得假装幂等成功'
  )
  assert.strictEqual(reconciliationReads, 2, '幂等快速检查失败不得再次联网取证')

  for (const driftCase of [
    {
      label: 'business-snapshot',
      mutate(db) { db.listings.push({ id: 'concurrent-business-change' }) }
    },
    {
      label: 'full-old-run',
      mutate(db) {
        const old = db.feishuSyncRuns.find((run) => run.runId === runId)
        old.schemaBindings = [{ role: 'mini', semantic: 'community', fieldName: '板块', type: 1 }]
      }
    }
  ]) {
    const driftStore = createStore(seed)
    const driftWorker = makeWorker({
      store: driftStore,
      now: () => nowMs,
      ids: [`must-not-create-${driftCase.label}`],
      sync: async () => { throw new Error('不得执行') },
      reconcilePartialBaseWrites: async () => {
        driftStore.updateDb(driftCase.mutate)
        return clone(evidence)
      }
    }).worker
    await assert.rejects(
      driftWorker.resolveAndEnqueueReconciledPartial(runId),
      (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
      `对账期间漂移必须拒绝：${driftCase.label}`
    )
    const after = driftStore.snapshot()
    const old = after.feishuSyncRuns.find((run) => run.runId === runId)
    assert.strictEqual(old.state, STATES.UNKNOWN)
    assert.strictEqual(after.feishuSyncRuns.length, 1)
    assert.strictEqual(after.feishuSyncScheduler.blockedRunId, runId)
  }
}

async function testConcurrentPartialResolversCreateOneContinuation() {
  const nowMs = 1_800_000_200_000
  const runId = 'feishu-sync-partial-concurrent'
  const store = createStore({
    listings: [{ id: 'stable-business' }],
    feishuSyncRuns: [exactPartialUnknownRun(runId, nowMs)],
    feishuSyncScheduler: { blockedRunId: runId, activeLease: null },
    feishuSyncCommitMarkers: {}
  })
  const gate = deferred()
  let calls = 0
  const worker = makeWorker({
    store,
    now: () => nowMs,
    ids: ['partial-concurrent-continuation', 'must-not-be-used'],
    sync: async () => { throw new Error('不得执行') },
    reconcilePartialBaseWrites: async () => {
      calls += 1
      await gate.promise
      return partialReconciliationEvidence(runId)
    }
  }).worker
  const firstPromise = worker.resolveAndEnqueueReconciledPartial(runId)
  const secondPromise = worker.resolveAndEnqueueReconciledPartial(runId)
  await flush()
  assert.strictEqual(calls, 2, '并发 resolver 可以各自只读，但都必须在最终事务重新确认')
  gate.resolve()
  const [first, second] = await Promise.all([firstPromise, secondPromise])
  assert.strictEqual(first.continuationRun.runId, second.continuationRun.runId)
  assert.strictEqual(store.snapshot().feishuSyncRuns.length, 2, '并发解阻只能原子生成一个 continuation')
}

function testCliAndDailyTimerStayNoopWhenDisabled() {
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
    const operationsGuide = fs.readFileSync(path.join(repoRoot, 'docs', '生产运维手册.md'), 'utf8')
    assert.ok(service.includes('scripts/run-feishu-sync-worker.js --schedule'), 'systemd 必须只调用统一 worker 入口')
    assert.ok(/TimeoutStartSec=5h(?:\r?\n|$)/.test(service), '单轮最多运行 5 小时，必须给相邻日历点留出至少 1 小时余量')
    assert.ok(operationsGuide.includes('单次最长 5 小时'), '运维手册必须与 service 的 5 小时上限一致')
    assert.ok(!operationsGuide.includes('单次最长 6 小时'), '运维手册不得保留已失效的 6 小时上限')
    const calendarRules = timer.match(/^OnCalendar=.*$/gm) || []
    assert.deepStrictEqual(
      calendarRules,
      ['OnCalendar=*-*-* 08,14,20:00:00 Asia/Shanghai'],
      '自动同步必须且只能按北京时间每天 08:00、14:00、20:00 触发'
    )
    assert.ok(!/OnBootSec=/.test(timer), '每天三次不得额外保留开机触发，避免出现第四轮计划外同步')
    assert.ok(!/OnUnitActiveSec=/.test(timer), '长同步不得因 OnUnitActiveSec 到点时服务仍 active 而丢失后续调度')
    assert.ok(/Persistent=false/.test(timer), '每日仅三次不得在启用或开机后补跑并形成第四轮')
    assert.ok(/AccuracySec=1s/.test(timer), '每日三次应按明确日历点触发，不保留分钟级漂移')
    assert.ok(!/RandomizedDelaySec=/.test(timer), '相邻任务必须保留完整运行余量，不得额外随机延迟')
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
  testManualNoopAllowsOnlyExactCurrentInventoryRefresh()
  await testDbWriteLockIsMandatoryBeforeAnyMutation()
  await testManualDryOnlyDoesNotNeedApprovalOrApply()
  await testSuccessIsAtomicAndReturnsExpectedDigests()
  await testClearedWriteIntentCannotCommitAsNoWrite()
  await testForgedPersistentWriteIntentWithoutCallbackCannotCommit()
  await testSlowPreparationFreezesAuthoritativeMirrorBeforeFirstWrite()
  await testApplyPlanFreezeGateFailsClosed()
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
  await testMirrorPlanDriftBeforeWriteIntentIsSafeAndDoesNotBlock()
  await testCommitFailureKeepsBusinessDbUntouchedAndUnknown()
  await testStatusIsSanitized()
  await testRecoveryRules()
  await testReconciledPartialUnknownAtomicallyQueuesOneFreshRun()
  await testReconciledZeroWriteUnknownQueuesDryRunOnly()
  await testUnknownContinuationCanBeReconciledWithoutDroppingParentEvidence()
  await testContinuationLineageDepthIsBounded()
  await testPartialReconciliationRejectsDriftWithoutChangingDb()
  await testPartialReconciliationAtomicRollbackAndConcurrentDriftGuards()
  await testConcurrentPartialResolversCreateOneContinuation()
  testLegacyMirrorDigestUnknownNeedsExplicitExactResolution()
  testCliAndDailyTimerStayNoopWhenDisabled()
  console.log('feishu-sync-worker-v2-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
