const assert = require('assert')
const crypto = require('crypto')

const feishuSync = require('../src/feishu-sync')
const {
  STATES,
  createFeishuSyncWorker,
  _internal: workerInternal
} = require('../src/feishu-sync-worker')
const workerRunner = require('./run-feishu-sync-worker')

const SHA = Object.freeze({
  schema: '1'.repeat(64),
  resource: '2'.repeat(64),
  oldMirror: '3'.repeat(64),
  mirror: '4'.repeat(64),
  content: '5'.repeat(64)
})

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

function createStore(seed) {
  let db = clone(seed)
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

function buildComponentEvidence(sourceDigest = 'a'.repeat(64), batch = {}) {
  const runId = batch.runId || 'feishu-sync-semantic-plan-a'
  const nowMs = batch.nowMs || 1_900_000_000_000
  return feishuSync._internal.buildMirrorSafetyDigests({
    sourceSnapshot: {
      schemaFingerprint: SHA.schema,
      digest: sourceDigest,
      recordCount: 43,
      schemaBindings: [{ semantic: 'community', fieldName: '板块/商圈', type: 1 }]
    },
    locationSnapshot: {
      schemaFingerprint: '6'.repeat(64),
      digest: 'b'.repeat(64),
      recordCount: 34,
      schemaBindings: [{ semantic: 'community', fieldName: '板块/商圈', type: 1 }]
    },
    mirrorSnapshot: {
      schemaFingerprint: '7'.repeat(64),
      digest: 'c'.repeat(64),
      recordCount: 67,
      schemaBindings: [{ semantic: 'community', fieldName: '板块/商圈', type: 1 }]
    },
    rentedSnapshot: {
      schemaFingerprint: '8'.repeat(64),
      digest: 'd'.repeat(64),
      recordCount: 20,
      schemaBindings: [{ semantic: 'listingStatus', fieldName: '房源状态', type: 1 }]
    },
    historySnapshot: {
      schemaFingerprint: '9'.repeat(64),
      digest: 'e'.repeat(64),
      recordCount: 46,
      schemaBindings: [{ semantic: 'eventType', fieldName: '事件类型', type: 1 }]
    },
    resources: {},
    operations: [{
      type: 'update',
      recordId: 'rec-current-1',
      fields: { listingStatus: '待出租' }
    }],
    archiveOperations: [{
      type: 'create',
      archiveKey: 'archive-stable-1',
      fields: { archiveKey: 'archive-stable-1', archivedAt: nowMs }
    }],
    historyOperations: [{
      type: 'create',
      historyEventId: 'history-stable-1',
      fields: { historyEventId: 'history-stable-1', eventAt: nowMs, runId }
    }],
    baselineMarkerOperation: {
      type: 'create',
      historyEventId: 'history-baseline-stable-1',
      fields: { historyEventId: 'history-baseline-stable-1', eventAt: nowMs + 1, runId }
    },
    plannedRecords: []
  })
}

function exactUnknown(runId, nowMs) {
  return {
    version: 3,
    runId,
    state: STATES.UNKNOWN,
    trigger: 'manual',
    dryRun: false,
    actorType: 'manual',
    actorId: 'admin:current-convergence',
    bucket: null,
    requestKeySha256: '6'.repeat(64),
    runNowMs: nowMs - 50_000,
    createdAt: nowMs - 50_000,
    updatedAt: nowMs - 30_000,
    startedAt: nowMs - 49_000,
    finishedAt: nowMs - 30_000,
    attemptCount: 1,
    recoveryCount: 0,
    externalWritesMayHaveOccurred: true,
    writeIntentEvidenceVersion: 1,
    applyIntentAt: nowMs - 31_000,
    externalWriteIntentAt: nowMs - 31_000,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: SHA.oldMirror,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 296,
    lease: null,
    errorCode: 'UNKNOWN_ERROR'
  }
}

function exactDry(runId, nowMs, evidence) {
  return {
    version: 3,
    runId,
    state: STATES.DRY_SUCCEEDED,
    trigger: 'manual',
    dryRun: true,
    actorType: 'manual',
    actorId: 'admin:current-convergence',
    bucket: null,
    requestKeySha256: '7'.repeat(64),
    runNowMs: nowMs - 20_000,
    createdAt: nowMs - 20_000,
    updatedAt: nowMs - 10_000,
    startedAt: nowMs - 19_000,
    finishedAt: nowMs - 10_000,
    attemptCount: 1,
    recoveryCount: 0,
    externalWritesMayHaveOccurred: false,
    writeIntentEvidenceVersion: 1,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: SHA.mirror,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 296,
    componentEvidence: clone(evidence.componentEvidence),
    componentEvidenceSha256: evidence.componentEvidenceSha256,
    schemaBindings: clone(evidence.schemaBindings),
    resultSummary: {
      success: true,
      complete: true,
      dryRun: true,
      failed: 0,
      sourceRecordCount: 43,
      contentPlanAssetCount: 296
    },
    lease: null,
    errorCode: ''
  }
}

function seedState(nowMs, evidence) {
  const blockedRunId = 'feishu-sync-unknown-current-01'
  const baselineDryRunId = 'feishu-sync-dry-current-01'
  const blocked = exactUnknown(blockedRunId, nowMs)
  const baseline = exactDry(baselineDryRunId, nowMs, evidence)
  return {
    blockedRunId,
    baselineDryRunId,
    blocked,
    baseline,
    db: {
      listings: [],
      feishuSyncRuns: [baseline, blocked],
      feishuSyncScheduler: {
        nextFence: 2,
        activeLease: null,
        blockedRunId,
        leaseIntegrityBlockedRunId: '',
        lastRunId: baselineDryRunId
      },
      feishuSyncCommitMarkers: {},
      feishuSyncConvergenceResolutions: {}
    }
  }
}

function dryResult(evidence, patch = {}) {
  return {
    success: true,
    complete: true,
    dryRun: true,
    failed: 0,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: SHA.mirror,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 296,
    componentEvidence: clone(evidence.componentEvidence),
    componentEvidenceSha256: evidence.componentEvidenceSha256,
    schemaBindings: clone(evidence.schemaBindings),
    ...patch
  }
}

function applyResult(evidence, patch = {}) {
  return {
    success: true,
    complete: true,
    dryRun: false,
    failed: 0,
    inventoryCommittable: true,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: SHA.mirror,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 296,
    componentEvidence: clone(evidence.componentEvidence),
    componentEvidenceSha256: evidence.componentEvidenceSha256,
    ...patch
  }
}

function commitDeltaChecked(store, beforeFinalize) {
  return async (_baseDb, nextDb, options) => store.updateDb((db) => {
    db.listings = clone(nextDb.listings || [])
    db.feishuSyncCommitMarkers[options.runId] = clone(options.commitMarker)
    if (typeof beforeFinalize === 'function') beforeFinalize(db, options)
    options.finalize(db)
    return { committed: true }
  })
}

function makeWorker({ seed, nowMs, evidence, sync, maxRuns = 50, beforeFinalize }) {
  const store = createStore(seed)
  let nextId = 0
  const worker = createFeishuSyncWorker({
    dbStore: store,
    feishuSync: { sync },
    commitDeltaChecked: commitDeltaChecked(store, beforeFinalize),
    writeLockEnabled: true,
    heartbeat: false,
    now: () => nowMs + (++nextId * 1000),
    randomId: () => `feishu-sync-convergence-${String(nextId + 1).padStart(2, '0')}`,
    config: {
      approvedSchemaSha256: SHA.schema,
      approvedResourceIdentitySha256: SHA.resource,
      leaseMs: 60_000,
      maxRuns
    }
  })
  return { store, worker, evidence }
}

async function successPathIsExactlyOnce() {
  const nowMs = 1_900_000_000_000
  const evidence = buildComponentEvidence()
  assert.ok(evidence.componentEvidence, '镜像摘要必须提供安全的分项证据')
  assert.match(evidence.componentEvidenceSha256, /^[0-9a-f]{64}$/)
  assert.deepStrictEqual(
    evidence.componentEvidence.snapshots.map((item) => item.role),
    ['source', 'location', 'mini', 'rented', 'history'],
    '分项证据必须覆盖飞书五表'
  )
  assert.strictEqual(JSON.stringify(evidence.componentEvidence).includes('真实房源'), false)
  for (const mutate of [
    (value) => { value.snapshots[0].fields = { community: '不应公开' } },
    (value) => { value.operations.main.recordId = 'rec-private' },
    (value) => { value.companySheet.url = 'https://private.example.test' },
    (value) => { value.legacyMaterials.token = 'private-token' }
  ]) {
    const unsafe = clone(evidence.componentEvidence)
    mutate(unsafe)
    assert.strictEqual(
      workerInternal.validComponentEvidence(unsafe, stableSha256(unsafe)),
      false,
      '分项证据出现正文、记录身份、URL 或 token 时必须失败关闭'
    )
  }
  const changed = buildComponentEvidence('f'.repeat(64))
  assert.notStrictEqual(changed.componentEvidenceSha256, evidence.componentEvidenceSha256)
  assert.notStrictEqual(
    changed.componentEvidence.snapshots[0].digest,
    evidence.componentEvidence.snapshots[0].digest,
    '源表漂移必须能直接定位到 source 分项'
  )
  const samePlanNewBatch = buildComponentEvidence('a'.repeat(64), {
    runId: 'feishu-sync-semantic-plan-b',
    nowMs: 1_900_000_100_000
  })
  assert.strictEqual(
    samePlanNewBatch.mirrorPlanSha256,
    evidence.mirrorPlanSha256,
    '相同业务操作只改变 runId、eventAt、archivedAt 时语义计划摘要必须稳定'
  )
  assert.strictEqual(
    samePlanNewBatch.componentEvidenceSha256,
    evidence.componentEvidenceSha256,
    '分项摘要也不得被批次编号和写入时间污染'
  )

  const seeded = seedState(nowMs, evidence)
  const originalUnknownSha256 = stableSha256(seeded.blocked)
  let dryCalls = 0
  let applyCalls = 0
  let writeIntentCalls = 0
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(db, _actorId, options) {
      if (options.dryRun === true) {
        dryCalls += 1
        return dryResult(evidence)
      }
      applyCalls += 1
      options.onApplyPlanFrozen({
        schemaSha256: SHA.schema,
        resourceIdentitySha256: SHA.resource,
        mirrorPlanSha256: SHA.mirror,
        componentEvidence: clone(evidence.componentEvidence),
        componentEvidenceSha256: evidence.componentEvidenceSha256
      })
      options.onExternalWriteDispatched()
      writeIntentCalls += 1
      db.listings.push({ id: 'local-converged-proof' })
      return applyResult(evidence)
    }
  })

  const first = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  const duplicate = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  assert.strictEqual(first.runId, duplicate.runId, '重复创建必须幂等返回同一任务')
  assert.strictEqual(first.state, STATES.QUEUED)
  assert.strictEqual(store.snapshot().feishuSyncRuns.filter((run) => run.convergenceContract).length, 1)

  const result = await worker.run(first.runId, { workerId: 'manual-cli:convergence-test' })
  assert.strictEqual(result.state, STATES.SUCCEEDED, JSON.stringify(result))
  assert.strictEqual(dryCalls, 1, '正式收敛只允许一次内部 dry')
  assert.strictEqual(applyCalls, 1, '正式收敛只允许一次 apply')
  assert.strictEqual(writeIntentCalls, 1, '首写门只允许一次')

  const after = store.snapshot()
  const oldAfter = after.feishuSyncRuns.find((run) => run.runId === seeded.blockedRunId)
  assert.strictEqual(stableSha256(oldAfter), originalUnknownSha256, '旧 UNKNOWN 必须逐字保持不变')
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, '', '只有成功提交后才允许解除旧 blocker')
  const resolution = after.feishuSyncConvergenceResolutions[seeded.blockedRunId]
  assert.ok(resolution, '成功必须原子写入独立 resolution marker')
  assert.strictEqual(resolution.baselineDryRunId, seeded.baselineDryRunId)
  assert.strictEqual(resolution.convergenceRunId, first.runId)
  assert.strictEqual(resolution.componentEvidenceSha256, evidence.componentEvidenceSha256)
  assert.match(resolution.markerSha256, /^[0-9a-f]{64}$/)

  const convergenceRun = after.feishuSyncRuns.find((run) => run.runId === first.runId)
  const originalRequestKeySha256 = convergenceRun.requestKeySha256
  store.updateDb((db) => {
    db.feishuSyncRuns.find((run) => run.runId === first.runId).requestKeySha256 = 'f'.repeat(64)
  })
  worker.recover()
  assert.strictEqual(
    store.snapshot().feishuSyncScheduler.blockedRunId,
    seeded.blockedRunId,
    '收敛任务终态身份被破坏后 recover 必须重新阻断旧 UNKNOWN'
  )

  store.updateDb((db) => {
    db.feishuSyncScheduler.blockedRunId = ''
    db.feishuSyncRuns.find((run) => run.runId === first.runId).requestKeySha256 =
      originalRequestKeySha256
    db.feishuSyncConvergenceResolutions[seeded.blockedRunId].markerSha256 = '0'.repeat(64)
  })
  worker.recover()
  assert.strictEqual(
    store.snapshot().feishuSyncScheduler.blockedRunId,
    seeded.blockedRunId,
    'resolution marker 被破坏后 recover 必须重新阻断旧 UNKNOWN'
  )

  for (const duplicatedRunId of [
    seeded.blockedRunId,
    seeded.baselineDryRunId,
    first.runId
  ]) {
    store.updateDb((db) => {
      Object.keys(db).forEach((key) => delete db[key])
      Object.assign(db, clone(after))
      const original = db.feishuSyncRuns.find((run) => run.runId === duplicatedRunId)
      db.feishuSyncRuns.push(clone(original))
    })
    worker.recover()
    assert.strictEqual(
      store.snapshot().feishuSyncScheduler.blockedRunId,
      seeded.blockedRunId,
      `resolution 谱系出现重复 runId 时必须重新阻断：${duplicatedRunId}`
    )
  }
}

async function preexistingResolutionMarkerFailsClosed() {
  const nowMs = 1_900_125_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  let store
  const built = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(evidence)
      options.onApplyPlanFrozen({
        schemaSha256: SHA.schema,
        resourceIdentitySha256: SHA.resource,
        mirrorPlanSha256: SHA.mirror,
        componentEvidence: clone(evidence.componentEvidence),
        componentEvidenceSha256: evidence.componentEvidenceSha256
      })
      options.onExternalWriteDispatched()
      store.updateDb((db) => {
        db.feishuSyncConvergenceResolutions[seeded.blockedRunId] = { tampered: true }
      })
      return applyResult(evidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, { workerId: 'manual-cli:marker-conflict' })
  assert.strictEqual(result.state, STATES.UNKNOWN, '同 key marker 竞态必须以新 UNKNOWN 失败关闭')
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, created.runId)
}

async function commitPhaseTamperingCreatesANewUnknownBarrier() {
  const nowMs = 1_900_127_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    beforeFinalize(db, options) {
      const run = db.feishuSyncRuns.find((item) => item.runId === options.runId)
      delete run.externalWriteIntentAt
    },
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(evidence)
      options.onApplyPlanFrozen({
        schemaSha256: SHA.schema,
        resourceIdentitySha256: SHA.resource,
        mirrorPlanSha256: SHA.mirror,
        componentEvidence: clone(evidence.componentEvidence),
        componentEvidenceSha256: evidence.componentEvidenceSha256
      })
      options.onExternalWriteDispatched()
      return applyResult(evidence)
    }
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  const result = await worker.run(created.runId, { workerId: 'manual-cli:commit-phase-tamper' })
  assert.strictEqual(result.state, STATES.UNKNOWN, '提交前证据漂移必须形成新的 UNKNOWN 屏障')
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, created.runId)
  assert.strictEqual(store.snapshot().feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function tamperedPristineSeedNeverRuns() {
  const nowMs = 1_900_130_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  let syncCalls = 0
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync() {
      syncCalls += 1
      throw new Error('坏种子不得执行')
    }
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  store.updateDb((db) => {
    const run = db.feishuSyncRuns.find((item) => item.runId === created.runId)
    run.externalWritesMayHaveOccurred = true
  })
  await assert.rejects(
    worker.run(created.runId, { workerId: 'manual-cli:bad-seed' }),
    /当前态收敛|CONVERGENCE/
  )
  assert.strictEqual(syncCalls, 0, '坏的 queued 种子必须在读取源表前失败')
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
}

async function tamperedPersistedDrySummaryNeverReachesTheWriteGate() {
  const nowMs = 1_900_132_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  let store
  let writeCalls = 0
  const built = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(evidence)
      options.onApplyPlanFrozen({
        schemaSha256: SHA.schema,
        resourceIdentitySha256: SHA.resource,
        mirrorPlanSha256: SHA.mirror,
        componentEvidence: clone(evidence.componentEvidence),
        componentEvidenceSha256: evidence.componentEvidenceSha256
      })
      store.updateDb((db) => {
        const run = db.feishuSyncRuns.find((item) => item.convergenceContract)
        delete run.dryResultSummary
      })
      options.onExternalWriteDispatched()
      writeCalls += 1
      return applyResult(evidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, { workerId: 'manual-cli:dry-summary-tamper' })
  assert.strictEqual(result.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(result.externalWritesMayHaveOccurred, false)
  assert.strictEqual(writeCalls, 0, '持久 dry 摘要漂移时不得越过首写门')
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
}

async function runNextNeverClaimsExplicitConvergence() {
  const nowMs = 1_900_135_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  let syncCalls = 0
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync() {
      syncCalls += 1
      throw new Error('runNext 不得执行专用收敛任务')
    }
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  assert.strictEqual(await worker.runNext({ workerId: 'scheduled-cli:must-skip' }), null)
  assert.strictEqual(syncCalls, 0)
  assert.strictEqual(
    store.snapshot().feishuSyncRuns.find((run) => run.runId === created.runId).state,
    STATES.QUEUED
  )
}

async function safePrewriteFailureAllowsANewBaselineAttempt() {
  const nowMs = 1_900_140_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  let driftFirst = true
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true && driftFirst) {
        driftFirst = false
        return dryResult(evidence, { mirrorPlanSha256: 'f'.repeat(64) })
      }
      return dryResult(evidence)
    }
  })
  const first = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  const failed = await worker.run(first.runId, { workerId: 'manual-cli:first-safe-failure' })
  assert.strictEqual(failed.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, seeded.blockedRunId)

  const nextDryRunId = 'feishu-sync-dry-current-02'
  store.updateDb((db) => {
    const baseline = exactDry(nextDryRunId, nowMs + 5_000, evidence)
    db.feishuSyncRuns.unshift(baseline)
    db.feishuSyncScheduler.lastRunId = nextDryRunId
  })
  const second = worker.createCurrentConvergence(seeded.blockedRunId, nextDryRunId)
  assert.notStrictEqual(second.runId, first.runId)
  assert.strictEqual(second.state, STATES.QUEUED)
}

function expiredPrewriteLeasesTerminateAndAllowFreshAttempt() {
  for (const state of [STATES.DRY_RUNNING, STATES.READY_TO_APPLY]) {
    const nowMs = state === STATES.DRY_RUNNING ? 1_900_142_000_000 : 1_900_143_000_000
    const evidence = buildComponentEvidence()
    const seeded = seedState(nowMs, evidence)
    const { store, worker } = makeWorker({
      seed: seeded.db,
      nowMs,
      evidence,
      async sync() {
        throw new Error('过期租约测试不执行同步')
      }
    })
    const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
    store.updateDb((db) => {
      const run = db.feishuSyncRuns.find((item) => item.runId === created.runId)
      const lease = {
        runId: run.runId,
        owner: 'synthetic-expired-owner',
        fence: 9,
        acquiredAt: run.createdAt + 100,
        expiresAt: run.createdAt + 200
      }
      run.state = state
      run.startedAt = run.createdAt + 100
      run.updatedAt = run.createdAt + 100
      run.attemptCount = 1
      run.lease = clone(lease)
      if (state === STATES.READY_TO_APPLY) {
        run.dryResultSummary = clone(run.baselineDryResultSummary)
      }
      db.feishuSyncScheduler.activeLease = clone(lease)
    })
    worker.recover()
    const after = store.snapshot()
    const expired = after.feishuSyncRuns.find((run) => run.runId === created.runId)
    assert.strictEqual(expired.state, STATES.FAILED_BEFORE_WRITE)
    assert.strictEqual(expired.recoveryCount, 0)
    assert.strictEqual(after.feishuSyncScheduler.blockedRunId, seeded.blockedRunId)

    const nextDryRunId = `feishu-sync-dry-after-${state}`
    store.updateDb((db) => {
      db.feishuSyncRuns.unshift(exactDry(nextDryRunId, nowMs + 10_000, evidence))
      db.feishuSyncScheduler.lastRunId = nextDryRunId
    })
    const retry = worker.createCurrentConvergence(seeded.blockedRunId, nextDryRunId)
    assert.strictEqual(retry.state, STATES.QUEUED, `${state} 超时后必须允许全新基线重建任务`)
    assert.notStrictEqual(retry.runId, created.runId)
  }
}

function trimPreservesTheBoundBaseline() {
  for (const maxRuns of [1, 2]) {
    const nowMs = 1_900_145_000_000 + maxRuns * 100_000
    const evidence = buildComponentEvidence()
    const seeded = seedState(nowMs, evidence)
    const { store, worker } = makeWorker({
      seed: seeded.db,
      nowMs,
      evidence,
      maxRuns,
      async sync() {
        throw new Error('本测试不执行')
      }
    })
    const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
    const ids = new Set(store.snapshot().feishuSyncRuns.map((run) => run.runId))
    assert.ok(ids.has(created.runId))
    assert.ok(ids.has(seeded.blockedRunId))
    assert.ok(ids.has(seeded.baselineDryRunId), `maxRuns=${maxRuns} 时必须保留收敛任务绑定的 dry 基线`)
  }
}

async function driftFailsBeforeWriteAndPreservesOldBarrier() {
  const nowMs = 1_900_100_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  let applyCalls = 0
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) {
        return dryResult(evidence, { mirrorPlanSha256: 'f'.repeat(64) })
      }
      applyCalls += 1
      return applyResult(evidence)
    }
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  const result = await worker.run(created.runId, { workerId: 'manual-cli:convergence-drift' })
  assert.strictEqual(result.externalWritesMayHaveOccurred, false)
  assert.ok([STATES.BLOCKED, STATES.FAILED_BEFORE_WRITE].includes(result.state))
  assert.strictEqual(applyCalls, 0, '基线漂移时不得进入 apply')
  const after = store.snapshot()
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function materialWarningInInternalDryFailsBeforeWrite() {
  const nowMs = 1_900_110_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  let applyCalls = 0
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun !== true) {
        applyCalls += 1
        return applyResult(evidence)
      }
      return dryResult(evidence, {
        success: false,
        complete: false,
        failed: 1,
        published: false,
        validated: true,
        planned: true,
        status: 'inventory-validated-materials-failed',
        inventoryCommittable: false,
        inventoryPublished: false,
        noteMaterials: {
          complete: false,
          published: false,
          dryRun: true,
          failed: 1,
          status: 'unsupported-non-video',
          rows: [{
            status: 'listing-missing',
            deferred: true,
            sourceRecordId: 'synthetic-source-1',
            sourceValueFingerprint: 'a'.repeat(64),
            sourceLinkFingerprint: '',
            deferredAction: 'none',
            mediaStateFingerprint: '',
            physicalUnitFingerprint: ''
          }]
        }
      })
    }
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  const result = await worker.run(created.runId, { workerId: 'manual-cli:material-warning' })
  assert.strictEqual(result.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(result.externalWritesMayHaveOccurred, false)
  assert.strictEqual(applyCalls, 0, '内部预演出现素材部分失败时不得进入 apply')
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
}

async function postIntentFailureCreatesANewUnknownBarrier() {
  const nowMs = 1_900_150_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(evidence)
      options.onApplyPlanFrozen({
        schemaSha256: SHA.schema,
        resourceIdentitySha256: SHA.resource,
        mirrorPlanSha256: SHA.mirror,
        componentEvidence: clone(evidence.componentEvidence),
        componentEvidenceSha256: evidence.componentEvidenceSha256
      })
      options.onExternalWriteDispatched()
      const error = new Error('模拟首写后的连接中断')
      error.code = 'MOCK_POST_INTENT_FAILURE'
      throw error
    }
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  const result = await worker.run(created.runId, { workerId: 'manual-cli:post-intent' })
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  const after = store.snapshot()
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, created.runId)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function preflightDriftStopsBeforeTheWriteIntent() {
  const nowMs = 1_900_175_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  let writeIntentCalls = 0
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(evidence)
      options.onApplyPlanFrozen({
        schemaSha256: SHA.schema,
        resourceIdentitySha256: SHA.resource,
        mirrorPlanSha256: 'f'.repeat(64),
        componentEvidence: clone(evidence.componentEvidence),
        componentEvidenceSha256: evidence.componentEvidenceSha256
      })
      options.onExternalWriteDispatched()
      writeIntentCalls += 1
      return applyResult(evidence)
    }
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  const result = await worker.run(created.runId, { workerId: 'manual-cli:preflight-drift' })
  assert.strictEqual(result.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(result.externalWritesMayHaveOccurred, false)
  assert.strictEqual(writeIntentCalls, 0)
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
}

async function invalidBaselineAndTamperingAreRejected() {
  const nowMs = 1_900_200_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync() {
      throw new Error('不应执行')
    }
  })
  store.updateDb((db) => {
    const dry = db.feishuSyncRuns.find((run) => run.runId === seeded.baselineDryRunId)
    dry.finishedAt = seeded.blocked.finishedAt
    dry.updatedAt = dry.finishedAt
  })
  assert.throws(
    () => worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId),
    /当前态收敛|CONVERGENCE/,
    '旧于 UNKNOWN 的预演不能作为当前基线'
  )

  const evidenceTampered = seedState(nowMs, evidence)
  let evidenceTamperedSyncCalls = 0
  const evidenceTamperedWorker = makeWorker({
    seed: evidenceTampered.db,
    nowMs,
    evidence,
    async sync() {
      evidenceTamperedSyncCalls += 1
      throw new Error('证据被篡改后不应执行')
    }
  })
  evidenceTamperedWorker.store.updateDb((db) => {
    const dry = db.feishuSyncRuns.find((run) => run.runId === evidenceTampered.baselineDryRunId)
    dry.componentEvidence.snapshots[0].recordCount += 1
  })
  assert.throws(
    () => evidenceTamperedWorker.worker.createCurrentConvergence(
      evidenceTampered.blockedRunId,
      evidenceTampered.baselineDryRunId
    ),
    /当前态收敛|CONVERGENCE/,
    '分项证据正文与摘要不一致时必须拒绝创建'
  )
  assert.strictEqual(evidenceTamperedSyncCalls, 0)

  const clean = seedState(nowMs, evidence)
  const next = makeWorker({
    seed: clean.db,
    nowMs,
    evidence,
    async sync() {
      throw new Error('绑定被篡改后不应执行')
    }
  })
  const created = next.worker.createCurrentConvergence(clean.blockedRunId, clean.baselineDryRunId)
  next.store.updateDb((db) => {
    db.feishuSyncRuns.find((run) => run.runId === clean.blockedRunId).updatedAt += 1
  })
  await assert.rejects(
    next.worker.run(created.runId, { workerId: 'manual-cli:tampered' }),
    /当前态收敛|CONVERGENCE/,
    '旧 UNKNOWN 身份变化后必须在读取源表前拒绝执行'
  )


  const baselineTampered = seedState(nowMs, evidence)
  let baselineTamperedSyncCalls = 0
  const baselineTamperedWorker = makeWorker({
    seed: baselineTampered.db,
    nowMs,
    evidence,
    async sync() {
      baselineTamperedSyncCalls += 1
      throw new Error('dry 基线身份被篡改后不应执行')
    }
  })
  const baselineBoundRun = baselineTamperedWorker.worker.createCurrentConvergence(
    baselineTampered.blockedRunId,
    baselineTampered.baselineDryRunId
  )
  baselineTamperedWorker.store.updateDb((db) => {
    db.feishuSyncRuns.find((run) => run.runId === baselineTampered.baselineDryRunId)
      .resultSummary.sourceRecordCount += 1
  })
  await assert.rejects(
    baselineTamperedWorker.worker.run(baselineBoundRun.runId, {
      workerId: 'manual-cli:baseline-tampered'
    }),
    /当前态收敛|CONVERGENCE/,
    'dry 基线完整身份变化后必须在读取源表前拒绝执行'
  )
  assert.strictEqual(baselineTamperedSyncCalls, 0)
}

function cliContractIsExplicitAndNonAmbiguous() {
  assert.deepStrictEqual(
    workerRunner.parseArgs([
      '--create-current-convergence',
      'feishu-sync-unknown-current-01',
      'feishu-sync-dry-current-01'
    ]),
    {
      mode: 'create-current-convergence',
      blockedRunId: 'feishu-sync-unknown-current-01',
      baselineDryRunId: 'feishu-sync-dry-current-01'
    }
  )
  assert.deepStrictEqual(
    workerRunner.parseArgs([
      '--create-current-convergence',
      'sync-unknown-current-01',
      'sync-abd3840-20260809-fresh-dry-01'
    ]),
    {
      mode: 'create-current-convergence',
      blockedRunId: 'sync-unknown-current-01',
      baselineDryRunId: 'sync-abd3840-20260809-fresh-dry-01'
    },
    'CLI 必须接受 worker 通用安全规则允许的任务号，不能额外绑定历史前缀'
  )
  assert.throws(
    () => workerRunner.parseArgs(['--create-current-convergence', 'bad', 'feishu-sync-dry-current-01']),
    /参数无效/
  )
  assert.throws(
    () => workerRunner.parseArgs([
      '--create-current-convergence',
      'sync-password-current-01',
      'sync-abd3840-20260809-fresh-dry-01'
    ]),
    /参数无效/,
    '放宽历史前缀后仍必须拒绝含敏感词的任务号'
  )
  assert.throws(
    () => workerRunner.parseArgs([
      '--create-current-convergence',
      'sync-same-current-01',
      'sync-same-current-01'
    ]),
    /参数无效/,
    '被收敛任务与预演任务必须保持两个不同身份'
  )
  assert.throws(
    () => workerRunner.parseArgs([
      '--create-current-convergence',
      'sync-unknown-current-01',
      'sync-abd3840-20260809-fresh-dry-01',
      'unexpected'
    ]),
    /参数无效/,
    '合法参数后追加内容时必须拒绝，不能静默忽略歧义输入'
  )
  assert.throws(
    () => workerRunner.parseArgs([
      '--create-current-convergence-extra',
      'sync-unknown-current-01',
      'sync-abd3840-20260809-fresh-dry-01'
    ]),
    /参数无效/,
    '创建入口名称必须精确匹配'
  )
}

async function cliCreatesButNeverRunsTheConvergence() {
  let createCalls = 0
  let runCalls = 0
  let output = ''
  const exitCode = await workerRunner.main([
    '--create-current-convergence',
    'feishu-sync-unknown-current-01',
    'feishu-sync-dry-current-01'
  ], {
    createWorker() {
      return {
        createCurrentConvergence(blockedRunId, baselineDryRunId) {
          createCalls += 1
          assert.strictEqual(blockedRunId, 'feishu-sync-unknown-current-01')
          assert.strictEqual(baselineDryRunId, 'feishu-sync-dry-current-01')
          return {
            runId: 'feishu-sync-convergence-current-01',
            state: STATES.QUEUED,
            convergenceContract: 'feishu-current-state-convergence-v1',
            supersedesBlockedRunId: blockedRunId,
            baselineDryRunId
          }
        },
        run() {
          runCalls += 1
        }
      }
    },
    writeOutput(value) {
      output += value
    }
  })
  assert.strictEqual(exitCode, 0)
  assert.strictEqual(createCalls, 1)
  assert.strictEqual(runCalls, 0, '创建入口不得顺手执行正式同步')
  assert.strictEqual(JSON.parse(output).state, STATES.QUEUED)
}

async function main() {
  await successPathIsExactlyOnce()
  await driftFailsBeforeWriteAndPreservesOldBarrier()
  await materialWarningInInternalDryFailsBeforeWrite()
  await preexistingResolutionMarkerFailsClosed()
  await commitPhaseTamperingCreatesANewUnknownBarrier()
  await tamperedPristineSeedNeverRuns()
  await tamperedPersistedDrySummaryNeverReachesTheWriteGate()
  await runNextNeverClaimsExplicitConvergence()
  await safePrewriteFailureAllowsANewBaselineAttempt()
  expiredPrewriteLeasesTerminateAndAllowFreshAttempt()
  trimPreservesTheBoundBaseline()
  await preflightDriftStopsBeforeTheWriteIntent()
  await postIntentFailureCreatesANewUnknownBarrier()
  await invalidBaselineAndTamperingAreRejected()
  cliContractIsExplicitAndNonAmbiguous()
  await cliCreatesButNeverRunsTheConvergence()
  console.log('feishu-sync-current-convergence-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
