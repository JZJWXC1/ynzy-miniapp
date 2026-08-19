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
  const lifecycleDays = Number.isSafeInteger(batch.lifecycleDays) ? batch.lifecycleDays : 10
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
      fields: { listingStatus: '待出租', lifecycleDays }
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
    mirrorPlanSha256: evidence.mirrorPlanSha256,
    semanticMirrorPlanSha256: evidence.semanticMirrorPlanSha256,
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

function applyResultNotCompleteRootCanUseCurrentConvergence() {
  const nowMs = 1_900_000_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  seeded.blocked.errorCode = 'APPLY_RESULT_NOT_COMPLETE'

  const build = (mutate) => {
    const db = clone(seeded.db)
    const blocked = db.feishuSyncRuns.find((run) => run.runId === seeded.blockedRunId)
    blocked.errorCode = 'APPLY_RESULT_NOT_COMPLETE'
    if (typeof mutate === 'function') mutate(db, blocked)
    return makeWorker({
      seed: db,
      nowMs,
      evidence,
      sync: async () => { throw new Error('创建阶段不得执行同步') }
    }).worker
  }

  const created = build().createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  assert.strictEqual(created.state, STATES.QUEUED)
  assert.strictEqual(created.convergenceContract, 'feishu-current-state-convergence-v2')

  const unsafeMutations = [
    (_db, blocked) => { blocked.errorCode = 'SOME_OTHER_UNKNOWN' },
    (_db, blocked) => { blocked.resultSummary = {} },
    (_db, blocked) => { blocked.applyResultSummary = {} },
    (db, blocked) => { db.feishuSyncCommitMarkers[blocked.runId] = { tampered: true } },
    (_db, blocked) => { blocked.continuationOfRunId = 'feishu-sync-parent-unknown-01' },
    (db) => {
      db.feishuSyncRuns.push({
        ...exactUnknown('feishu-sync-other-unknown-01', nowMs),
        updatedAt: nowMs - 20_000,
        finishedAt: nowMs - 20_000
      })
    }
  ]
  unsafeMutations.forEach((mutate) => {
    assert.throws(
      () => build(mutate).createCurrentConvergence(
        seeded.blockedRunId,
        seeded.baselineDryRunId
      ),
      (error) => error && error.code === 'CURRENT_CONVERGENCE_FAILED'
    )
  })
}

function componentEvidenceWithRoles(evidence, roles) {
  const next = clone(evidence)
  const byRole = new Map(next.componentEvidence.snapshots.map((snapshot) => [snapshot.role, snapshot]))
  next.componentEvidence.snapshots = roles.map((role) => clone(byRole.get(role)))
  next.componentEvidenceSha256 = stableSha256(next.componentEvidence)
  return next
}

function canonicalThreeRoleBaselineCanUseCurrentConvergence() {
  const nowMs = 1_900_010_000_000
  const evidence = componentEvidenceWithRoles(
    buildComponentEvidence(),
    ['source', 'location', 'mini']
  )
  const seeded = seedState(nowMs, evidence)
  const created = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    sync: async () => { throw new Error('创建阶段不得执行同步') }
  }).worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  assert.strictEqual(created.state, STATES.QUEUED)

  const reordered = componentEvidenceWithRoles(
    buildComponentEvidence(),
    ['location', 'source', 'mini']
  )
  const reorderedSeed = seedState(nowMs, reordered)
  assert.throws(
    () => makeWorker({
      seed: reorderedSeed.db,
      nowMs,
      evidence: reordered,
      sync: async () => { throw new Error('乱序证据不得执行同步') }
    }).worker.createCurrentConvergence(
      reorderedSeed.blockedRunId,
      reorderedSeed.baselineDryRunId
    ),
    (error) => error && error.code === 'CURRENT_CONVERGENCE_FAILED',
    '三角色证据必须保持 canonical source/location/mini 顺序'
  )
}

async function resolvedHistoricalUnknownDoesNotBlockFreshConvergence() {
  const firstNowMs = 1_900_020_000_000
  const evidence = buildComponentEvidence()
  const firstSeed = seedState(firstNowMs, evidence)
  const firstBuilt = makeWorker({
    seed: firstSeed.db,
    nowMs: firstNowMs + 86_400_000,
    evidence,
    async sync(db, _actorId, options) {
      if (options.dryRun === true) return dryResult(evidence)
      options.onApplyPlanFrozen(frozenPlan(evidence))
      options.onExternalWriteDispatched()
      db.listings.push({ id: 'resolved-history-proof' })
      return applyResult(evidence)
    }
  })
  const firstConvergence = firstBuilt.worker.createCurrentConvergence(
    firstSeed.blockedRunId,
    firstSeed.baselineDryRunId
  )
  const firstResult = await firstBuilt.worker.run(firstConvergence.runId, {
    workerId: 'manual-cli:resolved-history'
  })
  assert.strictEqual(firstResult.state, STATES.SUCCEEDED)

  const addFreshPair = (db) => {
    const fresh = seedState(firstNowMs + 172_800_000, evidence)
    fresh.blocked.runId = 'feishu-sync-unknown-current-02'
    fresh.baseline.runId = 'feishu-sync-dry-current-02'
    fresh.db.feishuSyncRuns = [fresh.baseline, fresh.blocked]
    db.feishuSyncRuns.push(clone(fresh.baseline), clone(fresh.blocked))
    db.feishuSyncScheduler.blockedRunId = fresh.blocked.runId
    db.feishuSyncScheduler.lastRunId = fresh.baseline.runId
    return fresh
  }

  const resolvedDb = firstBuilt.store.snapshot()
  const fresh = addFreshPair(resolvedDb)
  const resolvedWorker = makeWorker({
    seed: resolvedDb,
    nowMs: firstNowMs + 259_200_000,
    evidence,
    randomIdPrefix: 'feishu-sync-fresh-convergence',
    sync: async () => { throw new Error('创建阶段不得执行同步') }
  }).worker
  assert.strictEqual(
    resolvedWorker.createCurrentConvergence(fresh.blocked.runId, fresh.baseline.runId).state,
    STATES.QUEUED,
    '已有完整 resolution 的历史 UNKNOWN 不得重复阻断新的 current convergence'
  )

  for (const mutate of [
    (db) => { delete db.feishuSyncConvergenceResolutions[firstSeed.blockedRunId] },
    (db) => { db.feishuSyncConvergenceResolutions[firstSeed.blockedRunId].markerSha256 = '0'.repeat(64) }
  ]) {
    const unsafeDb = firstBuilt.store.snapshot()
    const unsafeFresh = addFreshPair(unsafeDb)
    mutate(unsafeDb)
    assert.throws(
      () => makeWorker({
        seed: unsafeDb,
        nowMs: firstNowMs + 259_200_000,
        evidence,
        randomIdPrefix: 'feishu-sync-unsafe-convergence',
        sync: async () => { throw new Error('未解决历史 UNKNOWN 不得执行同步') }
      }).worker.createCurrentConvergence(unsafeFresh.blocked.runId, unsafeFresh.baseline.runId),
      (error) => error && error.code === 'CURRENT_CONVERGENCE_FAILED'
    )
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
    mirrorPlanSha256: evidence.mirrorPlanSha256,
    semanticMirrorPlanSha256: evidence.semanticMirrorPlanSha256,
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
    mirrorPlanSha256: evidence.mirrorPlanSha256,
    semanticMirrorPlanSha256: evidence.semanticMirrorPlanSha256,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 296,
    componentEvidence: clone(evidence.componentEvidence),
    componentEvidenceSha256: evidence.componentEvidenceSha256,
    ...patch
  }
}

function frozenPlan(evidence, patch = {}) {
  return {
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: evidence.mirrorPlanSha256,
    semanticMirrorPlanSha256: evidence.semanticMirrorPlanSha256,
    componentEvidence: clone(evidence.componentEvidence),
    componentEvidenceSha256: evidence.componentEvidenceSha256,
    ...patch
  }
}

function replacePersistedPreparedDigests(store, runId, evidence) {
  store.updateDb((db) => {
    const run = db.feishuSyncRuns.find((item) => item.runId === runId)
    run.mirrorPlanSha256 = evidence.mirrorPlanSha256
    run.semanticMirrorPlanSha256 = evidence.semanticMirrorPlanSha256
    run.componentEvidence = clone(evidence.componentEvidence)
    run.componentEvidenceSha256 = evidence.componentEvidenceSha256
  })
}

function stripPersistedConvergenceIdentity(store, runId) {
  store.updateDb((db) => {
    const run = db.feishuSyncRuns.find((item) => item.runId === runId)
    delete run.convergenceContract
    delete run.convergenceDigestContract
  })
}

function clearPersistedWriteIntent(store, runId) {
  store.updateDb((db) => {
    const run = db.feishuSyncRuns.find((item) => item.runId === runId)
    run.state = STATES.READY_TO_APPLY
    run.externalWritesMayHaveOccurred = false
    delete run.applyIntentAt
    delete run.externalWriteIntentAt
  })
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

function makeWorker({
  seed,
  nowMs,
  evidence,
  sync,
  maxRuns = 50,
  beforeFinalize,
  randomIdPrefix = 'feishu-sync-convergence'
}) {
  const store = createStore(seed)
  let nextId = 0
  const worker = createFeishuSyncWorker({
    dbStore: store,
    feishuSync: { sync },
    commitDeltaChecked: commitDeltaChecked(store, beforeFinalize),
    writeLockEnabled: true,
    heartbeat: false,
    now: () => nowMs + (++nextId * 1000),
    randomId: () => `${randomIdPrefix}-${String(nextId + 1).padStart(2, '0')}`,
    config: {
      approvedSchemaSha256: SHA.schema,
      approvedResourceIdentitySha256: SHA.resource,
      leaseMs: 60_000,
      maxRuns
    }
  })
  return { store, worker, evidence }
}

function legacyResolvedState(snapshot, blockedRunId, baselineDryRunId, convergenceRunId, version = 4) {
  const db = clone(snapshot)
  const blocked = db.feishuSyncRuns.find((run) => run.runId === blockedRunId)
  const baseline = db.feishuSyncRuns.find((run) => run.runId === baselineDryRunId)
  const convergence = db.feishuSyncRuns.find((run) => run.runId === convergenceRunId)
  convergence.version = version
  convergence.convergenceContract = 'feishu-current-state-convergence-v1'
  convergence.mirrorPlanSha256 = baseline.mirrorPlanSha256
  convergence.componentEvidence = clone(baseline.componentEvidence)
  convergence.componentEvidenceSha256 = baseline.componentEvidenceSha256
  ;[
    'baselineComponentEvidenceSha256',
    'baselineMirrorPlanSha256',
    'baselineSemanticMirrorPlanSha256',
    'convergenceDigestContract',
    'semanticMirrorPlanSha256'
  ].forEach((key) => delete convergence[key])
  const markerBody = {
    runId: convergence.runId,
    fence: convergence.lastFence,
    schemaSha256: convergence.schemaSha256,
    resourceIdentitySha256: convergence.resourceIdentitySha256,
    mirrorPlanSha256: convergence.mirrorPlanSha256,
    contentPlanSha256: convergence.contentPlanSha256,
    contentPlanAssetCount: convergence.contentPlanAssetCount,
    committedAt: convergence.finishedAt
  }
  const commitMarker = {
    ...markerBody,
    markerSha256: crypto.createHash('sha256').update(JSON.stringify(markerBody)).digest('hex')
  }
  convergence.commitMarkerSha256 = commitMarker.markerSha256
  delete convergence.convergenceResolutionSha256
  const resolutionBody = {
    contract: 'feishu-current-state-resolution-v1',
    supersededRunId: blocked.runId,
    supersededRunSha256: stableSha256(blocked),
    baselineDryRunId: baseline.runId,
    baselineDryRunSha256: stableSha256(baseline),
    convergenceRunId: convergence.runId,
    convergenceRunSha256: stableSha256(convergence),
    commitMarkerSha256: commitMarker.markerSha256,
    schemaSha256: convergence.schemaSha256,
    resourceIdentitySha256: convergence.resourceIdentitySha256,
    mirrorPlanSha256: convergence.mirrorPlanSha256,
    contentPlanSha256: convergence.contentPlanSha256,
    contentPlanAssetCount: convergence.contentPlanAssetCount,
    componentEvidenceSha256: convergence.componentEvidenceSha256,
    resolvedAt: convergence.finishedAt
  }
  const resolution = { ...resolutionBody, markerSha256: stableSha256(resolutionBody) }
  convergence.convergenceResolutionSha256 = resolution.markerSha256
  db.feishuSyncCommitMarkers[convergence.runId] = commitMarker
  db.feishuSyncConvergenceResolutions[blocked.runId] = resolution
  db.feishuSyncScheduler.blockedRunId = ''
  return db
}

async function successPathIsExactlyOnce() {
  const baselineNowMs = 1_900_000_000_000
  const nowMs = baselineNowMs + 86_400_000
  const evidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    runId: 'feishu-sync-semantic-plan-current',
    nowMs: nowMs + 86_400_000,
    lifecycleDays: 11
  })
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
  assert.notStrictEqual(
    currentEvidence.mirrorPlanSha256,
    evidence.mirrorPlanSha256,
    '跨天后完整计划必须保留 lifecycleDays 的真实变化'
  )
  assert.notStrictEqual(
    currentEvidence.componentEvidenceSha256,
    evidence.componentEvidenceSha256,
    '跨天后完整分项证据必须保留 lifecycleDays 的真实变化'
  )
  assert.strictEqual(
    currentEvidence.semanticMirrorPlanSha256,
    evidence.semanticMirrorPlanSha256,
    '跨运行收敛语义摘要必须忽略纯生命周期天数变化'
  )

  const seeded = seedState(baselineNowMs, evidence)
  const originalUnknownSha256 = stableSha256(seeded.blocked)
  let dryCalls = 0
  let applyCalls = 0
  let writeIntentCalls = 0
  const observedRunNowMs = []
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync(db, _actorId, options) {
      observedRunNowMs.push(options.nowMs)
      if (options.dryRun === true) {
        dryCalls += 1
        return dryResult(currentEvidence)
      }
      applyCalls += 1
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      options.onExternalWriteDispatched()
      writeIntentCalls += 1
      db.listings.push({ id: 'local-converged-proof' })
      return applyResult(currentEvidence)
    }
  })

  const first = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  const duplicate = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  assert.strictEqual(first.runId, duplicate.runId, '重复创建必须幂等返回同一任务')
  assert.strictEqual(first.state, STATES.QUEUED)
  const createdRaw = store.snapshot().feishuSyncRuns.find((run) => run.runId === first.runId)
  assert.strictEqual(createdRaw.version, 5, '新收敛任务必须使用不可与旧 V4 混用的 V5 身份')
  assert.strictEqual(first.convergenceContract, 'feishu-current-state-convergence-v2')
  assert.strictEqual(first.convergenceDigestContract, 'feishu-current-state-digest-binding-v2')
  assert.strictEqual(createdRaw.baselineMirrorPlanSha256, evidence.mirrorPlanSha256)
  assert.strictEqual(
    createdRaw.baselineSemanticMirrorPlanSha256,
    evidence.semanticMirrorPlanSha256
  )
  assert.strictEqual(
    createdRaw.baselineComponentEvidenceSha256,
    evidence.componentEvidenceSha256
  )
  assert.ok(
    createdRaw.runNowMs - seeded.baseline.finishedAt > 86_000_000,
    'V5 行为测试必须真实跨越一天，不能再用 100 秒假装跨日'
  )
  assert.strictEqual(store.snapshot().feishuSyncRuns.filter((run) => run.convergenceContract).length, 1)

  const result = await worker.run(first.runId, { workerId: 'manual-cli:convergence-test' })
  assert.strictEqual(result.state, STATES.SUCCEEDED, JSON.stringify(result))
  assert.strictEqual(dryCalls, 1, '正式收敛只允许一次内部 dry')
  assert.strictEqual(applyCalls, 1, '正式收敛只允许一次 apply')
  assert.strictEqual(writeIntentCalls, 1, '首写门只允许一次')
  assert.deepStrictEqual(
    observedRunNowMs,
    [createdRaw.runNowMs, createdRaw.runNowMs],
    '同一 V5 的 dry 与 apply 必须冻结使用同一个 runNowMs'
  )

  const after = store.snapshot()
  const oldAfter = after.feishuSyncRuns.find((run) => run.runId === seeded.blockedRunId)
  assert.strictEqual(stableSha256(oldAfter), originalUnknownSha256, '旧 UNKNOWN 必须逐字保持不变')
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, '', '只有成功提交后才允许解除旧 blocker')
  const resolution = after.feishuSyncConvergenceResolutions[seeded.blockedRunId]
  assert.ok(resolution, '成功必须原子写入独立 resolution marker')
  assert.strictEqual(resolution.baselineDryRunId, seeded.baselineDryRunId)
  assert.strictEqual(resolution.convergenceRunId, first.runId)
  assert.strictEqual(resolution.contract, 'feishu-current-state-resolution-v2')
  assert.strictEqual(resolution.baselineMirrorPlanSha256, evidence.mirrorPlanSha256)
  assert.strictEqual(
    resolution.baselineComponentEvidenceSha256,
    evidence.componentEvidenceSha256
  )
  assert.strictEqual(
    resolution.baselineSemanticMirrorPlanSha256,
    evidence.semanticMirrorPlanSha256
  )
  assert.strictEqual(resolution.mirrorPlanSha256, currentEvidence.mirrorPlanSha256)
  assert.strictEqual(resolution.componentEvidenceSha256, currentEvidence.componentEvidenceSha256)
  assert.strictEqual(resolution.semanticMirrorPlanSha256, evidence.semanticMirrorPlanSha256)
  assert.deepStrictEqual(Object.keys(resolution).sort(), [
    'baselineComponentEvidenceSha256',
    'baselineDryRunId',
    'baselineDryRunSha256',
    'baselineMirrorPlanSha256',
    'baselineSemanticMirrorPlanSha256',
    'commitMarkerSha256',
    'componentEvidenceSha256',
    'contentPlanAssetCount',
    'contentPlanSha256',
    'contract',
    'convergenceRunId',
    'convergenceRunSha256',
    'markerSha256',
    'mirrorPlanSha256',
    'resolvedAt',
    'resourceIdentitySha256',
    'schemaSha256',
    'semanticMirrorPlanSha256',
    'supersededRunId',
    'supersededRunSha256'
  ].sort(), 'V5 resolution 必须使用精确闭集字段')
  assert.match(resolution.markerSha256, /^[0-9a-f]{64}$/)

  const convergenceRun = after.feishuSyncRuns.find((run) => run.runId === first.runId)
  const commitMarker = after.feishuSyncCommitMarkers[first.runId]
  assert.strictEqual(commitMarker.semanticMirrorPlanSha256, currentEvidence.semanticMirrorPlanSha256)
  assert.strictEqual(commitMarker.componentEvidenceSha256, currentEvidence.componentEvidenceSha256)
  assert.strictEqual(workerInternal.markerMatches(convergenceRun, commitMarker), true)
  for (const field of ['semanticMirrorPlanSha256', 'componentEvidenceSha256']) {
    store.updateDb((db) => {
      Object.keys(db).forEach((key) => delete db[key])
      Object.assign(db, clone(after))
      db.feishuSyncCommitMarkers[first.runId][field] = '0'.repeat(64)
    })
    worker.recover()
    assert.strictEqual(
      store.snapshot().feishuSyncScheduler.blockedRunId,
      seeded.blockedRunId,
      `V5 commit marker 的 ${field} 被篡改后必须恢复旧 UNKNOWN 屏障`
    )
  }
  store.updateDb((db) => {
    Object.keys(db).forEach((key) => delete db[key])
    Object.assign(db, clone(after))
  })
  store.updateDb((db) => {
    const invalid = clone(db.feishuSyncConvergenceResolutions[seeded.blockedRunId])
    invalid.unexpected = true
    delete invalid.markerSha256
    invalid.markerSha256 = stableSha256(invalid)
    db.feishuSyncConvergenceResolutions[seeded.blockedRunId] = invalid
    db.feishuSyncRuns.find((run) => run.runId === first.runId)
      .convergenceResolutionSha256 = invalid.markerSha256
  })
  worker.recover()
  assert.strictEqual(
    store.snapshot().feishuSyncScheduler.blockedRunId,
    seeded.blockedRunId,
    'resolution 即使重算哈希，额外字段也必须被读取器拒绝'
  )
  store.updateDb((db) => {
    Object.keys(db).forEach((key) => delete db[key])
    Object.assign(db, clone(after))
  })
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

  const legacyDb = legacyResolvedState(
    after,
    seeded.blockedRunId,
    seeded.baselineDryRunId,
    first.runId,
    4
  )
  const legacyWorker = makeWorker({
    seed: legacyDb,
    nowMs: nowMs + 200_000,
    evidence,
    async sync() {
      throw new Error('历史 V4 resolution 只读兼容不应执行同步')
    }
  })
  legacyWorker.worker.recover()
  assert.strictEqual(
    legacyWorker.store.snapshot().feishuSyncScheduler.blockedRunId,
    '',
    '历史 V4 + resolution v1 必须继续保持受信兼容'
  )

  const disguisedV5Db = legacyResolvedState(
    after,
    seeded.blockedRunId,
    seeded.baselineDryRunId,
    first.runId,
    5
  )
  const disguisedV5Worker = makeWorker({
    seed: disguisedV5Db,
    nowMs: nowMs + 300_000,
    evidence,
    async sync() {
      throw new Error('伪装为 legacy 的 V5 不应执行同步')
    }
  })
  disguisedV5Worker.worker.recover()
  assert.strictEqual(
    disguisedV5Worker.store.snapshot().feishuSyncScheduler.blockedRunId,
    seeded.blockedRunId,
    'V5 不得伪装成 legacy V4 绕过新合同'
  )

  const downgradedMarkerDb = clone(after)
  const downgradedRun = downgradedMarkerDb.feishuSyncRuns.find((run) => run.runId === first.runId)
  downgradedRun.version = 4
  downgradedRun.state = STATES.APPLYING
  downgradedRun.finishedAt = undefined
  downgradedRun.lastFence = undefined
  downgradedRun.convergenceResolutionSha256 = undefined
  downgradedRun.lease = {
    runId: first.runId,
    owner: 'manual-cli:downgraded-marker',
    fence: 9,
    acquiredAt: nowMs - 20_000,
    expiresAt: nowMs - 10_000
  }
  const downgradedMarkerBody = {
    runId: first.runId,
    fence: 9,
    schemaSha256: downgradedRun.schemaSha256,
    resourceIdentitySha256: downgradedRun.resourceIdentitySha256,
    mirrorPlanSha256: downgradedRun.mirrorPlanSha256,
    contentPlanSha256: downgradedRun.contentPlanSha256,
    contentPlanAssetCount: downgradedRun.contentPlanAssetCount,
    committedAt: nowMs - 15_000
  }
  const downgradedMarker = {
    ...downgradedMarkerBody,
    markerSha256: crypto.createHash('sha256')
      .update(JSON.stringify(downgradedMarkerBody))
      .digest('hex')
  }
  downgradedRun.commitMarkerSha256 = downgradedMarker.markerSha256
  for (const invalidIdentity of [
    { version: 4, convergenceContract: 'feishu-current-state-convergence-v2' },
    { version: 5, convergenceContract: '' },
    { version: 5, convergenceContract: 'unknown-convergence-contract' },
    { version: 5, convergenceContract: 'feishu-current-state-convergence-v1' }
  ]) {
    assert.strictEqual(
      workerInternal.markerMatches({ ...downgradedRun, ...invalidIdentity }, downgradedMarker),
      false,
      `收敛合同与版本必须双向精确配对：${JSON.stringify(invalidIdentity)}`
    )
  }
  for (const invalidDigestContract of [undefined, '', 'unknown-digest-contract']) {
    const invalidRun = {
      ...convergenceRun
    }
    if (invalidDigestContract === undefined) {
      delete invalidRun.convergenceDigestContract
    } else {
      invalidRun.convergenceDigestContract = invalidDigestContract
    }
    assert.strictEqual(
      workerInternal.markerMatches(invalidRun, commitMarker),
      false,
      `V5 marker 必须绑定精确摘要合同：${String(invalidDigestContract)}`
    )
  }
  for (const injectedLegacyDigestContract of [
    '',
    'unknown-digest-contract',
    'feishu-current-state-digest-binding-v2'
  ]) {
    assert.strictEqual(
      workerInternal.markerMatches({
        ...downgradedRun,
        version: 4,
        convergenceContract: 'feishu-current-state-convergence-v1',
        convergenceDigestContract: injectedLegacyDigestContract
      }, downgradedMarker),
      false,
      `旧 V4 marker 不得携带任何摘要合同字段：${injectedLegacyDigestContract}`
    )
  }
  downgradedMarkerDb.feishuSyncCommitMarkers[first.runId] = downgradedMarker
  delete downgradedMarkerDb.feishuSyncConvergenceResolutions[seeded.blockedRunId]
  downgradedMarkerDb.feishuSyncScheduler.blockedRunId = seeded.blockedRunId
  downgradedMarkerDb.feishuSyncScheduler.activeLease = clone(downgradedRun.lease)
  const downgradedWorker = makeWorker({
    seed: downgradedMarkerDb,
    nowMs,
    evidence,
    async sync() {
      throw new Error('合同版本不配对时不得执行同步')
    }
  })
  downgradedWorker.worker.recover()
  assert.strictEqual(
    downgradedWorker.store.snapshot().feishuSyncRuns.find((run) => run.runId === first.runId).state,
    STATES.UNKNOWN,
    'V5 合同被降级为 version=4 后不得借旧 marker 恢复成成功'
  )
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
      options.onApplyPlanFrozen(frozenPlan(evidence))
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
      options.onApplyPlanFrozen(frozenPlan(evidence))
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
      options.onApplyPlanFrozen(frozenPlan(evidence))
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

async function frozenEvidenceTamperingNeverReachesTheFirstWrite() {
  const baselineNowMs = 1_900_133_000_000
  const executionNowMs = baselineNowMs + 86_400_000
  const baselineEvidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    nowMs: executionNowMs,
    lifecycleDays: 11
  })
  const seeded = seedState(baselineNowMs, baselineEvidence)
  let store
  let writeCalls = 0
  const built = makeWorker({
    seed: seeded.db,
    nowMs: executionNowMs,
    evidence: baselineEvidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(currentEvidence)
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      replacePersistedPreparedDigests(store, options.runId, baselineEvidence)
      options.onExternalWriteDispatched()
      writeCalls += 1
      return applyResult(currentEvidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, {
    workerId: 'manual-cli:frozen-evidence-tamper'
  })
  assert.strictEqual(result.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(result.externalWritesMayHaveOccurred, false)
  assert.strictEqual(writeCalls, 0, '冻结后证据被替换时不得越过首写门')
  assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
}

async function postIntentEvidenceTamperingCannotCommit() {
  const baselineNowMs = 1_900_134_000_000
  const executionNowMs = baselineNowMs + 86_400_000
  const baselineEvidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    nowMs: executionNowMs,
    lifecycleDays: 11
  })
  const seeded = seedState(baselineNowMs, baselineEvidence)
  let store
  let writeIntentCalls = 0
  const built = makeWorker({
    seed: seeded.db,
    nowMs: executionNowMs,
    evidence: baselineEvidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(currentEvidence)
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      options.onExternalWriteDispatched()
      writeIntentCalls += 1
      replacePersistedPreparedDigests(store, options.runId, baselineEvidence)
      return applyResult(currentEvidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, {
    workerId: 'manual-cli:post-intent-evidence-tamper'
  })
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(writeIntentCalls, 1)
  const after = store.snapshot()
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, created.runId)
  assert.strictEqual(after.feishuSyncCommitMarkers[created.runId], undefined)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function frozenIdentityTamperingNeverReachesTheFirstWrite() {
  const baselineNowMs = 1_900_134_500_000
  const executionNowMs = baselineNowMs + 86_400_000
  const baselineEvidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    nowMs: executionNowMs,
    lifecycleDays: 11
  })
  const seeded = seedState(baselineNowMs, baselineEvidence)
  let store
  let writeCalls = 0
  const built = makeWorker({
    seed: seeded.db,
    nowMs: executionNowMs,
    evidence: baselineEvidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(currentEvidence)
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      stripPersistedConvergenceIdentity(store, options.runId)
      options.onExternalWriteDispatched()
      writeCalls += 1
      return applyResult(currentEvidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, {
    workerId: 'manual-cli:frozen-identity-tamper'
  })
  const after = store.snapshot()
  assert.strictEqual(result.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(result.externalWritesMayHaveOccurred, false)
  assert.strictEqual(writeCalls, 0, '冻结后 V5 身份被删除时不得越过首写门')
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
  assert.strictEqual(after.feishuSyncCommitMarkers[created.runId], undefined)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function postIntentIdentityTamperingCannotCommit() {
  const baselineNowMs = 1_900_134_750_000
  const executionNowMs = baselineNowMs + 86_400_000
  const baselineEvidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    nowMs: executionNowMs,
    lifecycleDays: 11
  })
  const seeded = seedState(baselineNowMs, baselineEvidence)
  let store
  let writeIntentCalls = 0
  const built = makeWorker({
    seed: seeded.db,
    nowMs: executionNowMs,
    evidence: baselineEvidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(currentEvidence)
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      options.onExternalWriteDispatched()
      writeIntentCalls += 1
      stripPersistedConvergenceIdentity(store, options.runId)
      return applyResult(currentEvidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, {
    workerId: 'manual-cli:post-intent-identity-tamper'
  })
  const after = store.snapshot()
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(writeIntentCalls, 1)
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, created.runId)
  assert.strictEqual(after.feishuSyncCommitMarkers[created.runId], undefined)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function clearedPersistedWriteIntentCannotMasqueradeAsZeroWrite() {
  const baselineNowMs = 1_900_134_900_000
  const executionNowMs = baselineNowMs + 86_400_000
  const baselineEvidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    nowMs: executionNowMs,
    lifecycleDays: 11
  })
  const seeded = seedState(baselineNowMs, baselineEvidence)
  let store
  let writeIntentCalls = 0
  const built = makeWorker({
    seed: seeded.db,
    nowMs: executionNowMs,
    evidence: baselineEvidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(currentEvidence)
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      options.onExternalWriteDispatched()
      writeIntentCalls += 1
      clearPersistedWriteIntent(store, options.runId)
      return applyResult(currentEvidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, {
    workerId: 'manual-cli:cleared-write-intent'
  })
  const after = store.snapshot()
  const persisted = after.feishuSyncRuns.find((run) => run.runId === created.runId)
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(writeIntentCalls, 1)
  assert.ok(Number.isSafeInteger(persisted.applyIntentAt))
  assert.strictEqual(persisted.externalWriteIntentAt, persisted.applyIntentAt)
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, created.runId)
  assert.strictEqual(after.feishuSyncCommitMarkers[created.runId], undefined)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function repeatedWriteCallbackCannotRebuildClearedIntent() {
  const baselineNowMs = 1_900_134_950_000
  const executionNowMs = baselineNowMs + 86_400_000
  const baselineEvidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    nowMs: executionNowMs,
    lifecycleDays: 11
  })
  const seeded = seedState(baselineNowMs, baselineEvidence)
  let store
  let firstDispatchAt = null
  let writeIntentCalls = 0
  const built = makeWorker({
    seed: seeded.db,
    nowMs: executionNowMs,
    evidence: baselineEvidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(currentEvidence)
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      options.onExternalWriteDispatched()
      writeIntentCalls += 1
      firstDispatchAt = store.snapshot().feishuSyncRuns
        .find((run) => run.runId === options.runId).applyIntentAt
      clearPersistedWriteIntent(store, options.runId)
      options.onExternalWriteDispatched()
      return applyResult(currentEvidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, {
    workerId: 'manual-cli:repeated-write-callback'
  })
  const after = store.snapshot()
  const persisted = after.feishuSyncRuns.find((run) => run.runId === created.runId)
  assert.strictEqual(writeIntentCalls, 1)
  assert.ok(Number.isSafeInteger(firstDispatchAt))
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(persisted.applyIntentAt, firstDispatchAt)
  assert.strictEqual(persisted.externalWriteIntentAt, firstDispatchAt)
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, created.runId)
  assert.strictEqual(after.feishuSyncCommitMarkers[created.runId], undefined)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function changedPersistedWriteIntentTimeCannotCommit() {
  const baselineNowMs = 1_900_134_975_000
  const executionNowMs = baselineNowMs + 86_400_000
  const baselineEvidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    nowMs: executionNowMs,
    lifecycleDays: 11
  })
  const seeded = seedState(baselineNowMs, baselineEvidence)
  let store
  let firstDispatchAt = null
  const built = makeWorker({
    seed: seeded.db,
    nowMs: executionNowMs,
    evidence: baselineEvidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(currentEvidence)
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      options.onExternalWriteDispatched()
      firstDispatchAt = store.snapshot().feishuSyncRuns
        .find((run) => run.runId === options.runId).applyIntentAt
      store.updateDb((db) => {
        const run = db.feishuSyncRuns.find((item) => item.runId === options.runId)
        run.applyIntentAt = firstDispatchAt + 1
        run.externalWriteIntentAt = firstDispatchAt + 1
      })
      return applyResult(currentEvidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, {
    workerId: 'manual-cli:changed-write-intent-time'
  })
  const after = store.snapshot()
  const persisted = after.feishuSyncRuns.find((run) => run.runId === created.runId)
  assert.ok(Number.isSafeInteger(firstDispatchAt))
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(persisted.applyIntentAt, firstDispatchAt)
  assert.strictEqual(persisted.externalWriteIntentAt, firstDispatchAt)
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, created.runId)
  assert.strictEqual(after.feishuSyncCommitMarkers[created.runId], undefined)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
}

async function repeatedWriteCallbackRejectsIdentityDriftBeforeSecondWrite() {
  const baselineNowMs = 1_900_134_990_000
  const executionNowMs = baselineNowMs + 86_400_000
  const baselineEvidence = buildComponentEvidence('a'.repeat(64), { lifecycleDays: 10 })
  const currentEvidence = buildComponentEvidence('a'.repeat(64), {
    nowMs: executionNowMs,
    lifecycleDays: 11
  })
  const seeded = seedState(baselineNowMs, baselineEvidence)
  let store
  let dispatchedWriteCalls = 0
  const built = makeWorker({
    seed: seeded.db,
    nowMs: executionNowMs,
    evidence: baselineEvidence,
    async sync(_db, _actorId, options) {
      if (options.dryRun === true) return dryResult(currentEvidence)
      options.onApplyPlanFrozen(frozenPlan(currentEvidence))
      options.onExternalWriteDispatched()
      dispatchedWriteCalls += 1
      stripPersistedConvergenceIdentity(store, options.runId)
      options.onExternalWriteDispatched()
      dispatchedWriteCalls += 1
      return applyResult(currentEvidence)
    }
  })
  store = built.store
  const created = built.worker.createCurrentConvergence(
    seeded.blockedRunId,
    seeded.baselineDryRunId
  )
  const result = await built.worker.run(created.runId, {
    workerId: 'manual-cli:repeated-callback-identity-drift'
  })
  const after = store.snapshot()
  assert.strictEqual(dispatchedWriteCalls, 1, '第二次写必须在回调内发现 V5 身份漂移并停止')
  assert.strictEqual(result.state, STATES.UNKNOWN)
  assert.strictEqual(result.externalWritesMayHaveOccurred, true)
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, created.runId)
  assert.strictEqual(after.feishuSyncCommitMarkers[created.runId], undefined)
  assert.strictEqual(after.feishuSyncConvergenceResolutions[seeded.blockedRunId], undefined)
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
  const legacyTerminalRunId = 'feishu-sync-convergence-legacy-terminal-01'
  store.updateDb((db) => {
    db.feishuSyncRuns.unshift({
      version: 4,
      runId: legacyTerminalRunId,
      state: STATES.FAILED_BEFORE_WRITE,
      convergenceContract: 'feishu-current-state-convergence-v1',
      supersedesBlockedRunId: seeded.blockedRunId,
      baselineDryRunId: seeded.baselineDryRunId,
      dryRun: false,
      externalWritesMayHaveOccurred: false,
      attemptCount: 1,
      recoveryCount: 0,
      lease: null,
      createdAt: nowMs - 5_000,
      updatedAt: nowMs - 4_000,
      finishedAt: nowMs - 4_000,
      errorCode: 'CURRENT_CONVERGENCE_FAILED'
    })
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  assert.notStrictEqual(created.runId, legacyTerminalRunId, '同 pair 的旧 V4 终态不得被 V5 幂等复用')
  assert.strictEqual(created.convergenceContract, 'feishu-current-state-convergence-v2')
  const legacyQueuedRunId = 'feishu-sync-convergence-legacy-queued-01'
  const malformedQueuedRunId = 'feishu-sync-convergence-malformed-queued-01'
  store.updateDb((db) => {
    const legacyQueued = clone(db.feishuSyncRuns.find((run) => run.runId === created.runId))
    legacyQueued.runId = legacyQueuedRunId
    legacyQueued.version = 4
    legacyQueued.convergenceContract = 'feishu-current-state-convergence-v1'
    delete legacyQueued.convergenceDigestContract
    db.feishuSyncRuns.unshift(legacyQueued)
    const malformedQueued = clone(db.feishuSyncRuns.find((run) => run.runId === created.runId))
    malformedQueued.runId = malformedQueuedRunId
    delete malformedQueued.convergenceContract
    delete malformedQueued.convergenceDigestContract
    db.feishuSyncRuns.unshift(malformedQueued)
  })
  assert.strictEqual(
    await worker.runNext({ workerId: 'scheduled-cli:must-skip' }),
    null,
    'runNext 不得领取精确 V5、旧 V4 或被删除合同的畸形 V5'
  )
  assert.strictEqual(syncCalls, 0)
  await assert.rejects(
    worker.run(legacyQueuedRunId, { workerId: 'manual-cli:legacy-v4-must-stop' }),
    /当前态收敛|CONVERGENCE/,
    '旧 V4 queued 即使显式调用也必须在同步前安全拒绝'
  )
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
        return dryResult(evidence, { semanticMirrorPlanSha256: 'f'.repeat(64) })
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
        return dryResult(evidence, { semanticMirrorPlanSha256: 'f'.repeat(64) })
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
      options.onApplyPlanFrozen(frozenPlan(evidence))
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
      options.onApplyPlanFrozen(frozenPlan(evidence, {
        mirrorPlanSha256: 'f'.repeat(64)
      }))
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

async function baselineDigestBindingsRejectTamperingBeforeSourceRead() {
  for (const field of [
    'baselineMirrorPlanSha256',
    'baselineSemanticMirrorPlanSha256',
    'baselineComponentEvidenceSha256'
  ]) {
    const nowMs = 1_900_190_000_000
    const evidence = buildComponentEvidence()
    const seeded = seedState(nowMs, evidence)
    let syncCalls = 0
    const { store, worker } = makeWorker({
      seed: seeded.db,
      nowMs,
      evidence,
      async sync() {
        syncCalls += 1
        throw new Error('基线绑定被篡改后不得读取源表')
      }
    })
    const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
    store.updateDb((db) => {
      db.feishuSyncRuns.find((run) => run.runId === created.runId)[field] = 'f'.repeat(64)
    })
    await assert.rejects(
      worker.run(created.runId, { workerId: `manual-cli:tamper-${field}` }),
      /当前态收敛|CONVERGENCE/
    )
    assert.strictEqual(syncCalls, 0, `${field} 漂移必须在读取源表前拒绝`)
    assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
  }
}

function expiredTamperedConvergenceIdentityFailsClosed() {
  const nowMs = 1_900_144_000_000
  const evidence = buildComponentEvidence()
  const seeded = seedState(nowMs, evidence)
  const { store, worker } = makeWorker({
    seed: seeded.db,
    nowMs,
    evidence,
    async sync() {
      throw new Error('畸形 V5 过期租约不得执行同步')
    }
  })
  const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
  store.updateDb((db) => {
    const run = db.feishuSyncRuns.find((item) => item.runId === created.runId)
    const lease = {
      runId: run.runId,
      owner: 'synthetic-expired-tampered-owner',
      fence: 10,
      acquiredAt: run.createdAt + 100,
      expiresAt: run.createdAt + 200
    }
    run.state = STATES.READY_TO_APPLY
    run.startedAt = run.createdAt + 100
    run.updatedAt = run.createdAt + 100
    run.attemptCount = 1
    run.dryResultSummary = clone(run.baselineDryResultSummary)
    run.lease = clone(lease)
    delete run.convergenceContract
    delete run.convergenceDigestContract
    db.feishuSyncScheduler.activeLease = clone(lease)
  })
  worker.recover()
  const after = store.snapshot()
  const recovered = after.feishuSyncRuns.find((run) => run.runId === created.runId)
  assert.strictEqual(recovered.state, STATES.FAILED_BEFORE_WRITE)
  assert.strictEqual(recovered.externalWritesMayHaveOccurred, false)
  assert.strictEqual(recovered.recoveryCount, 0)
  assert.strictEqual(recovered.lease, null)
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
}

async function malformedConvergenceIdentityIsRejectedBeforeSourceRead() {
  const mutations = [
    ['missing-contract', (run) => { delete run.convergenceContract }],
    ['missing-digest-contract', (run) => { delete run.convergenceDigestContract }],
    ['missing-both-contracts', (run) => {
      delete run.convergenceContract
      delete run.convergenceDigestContract
    }],
    ['downgraded-version', (run) => { run.version = 3 }]
  ]
  for (const [label, mutate] of mutations) {
    const nowMs = 1_900_195_000_000
    const evidence = buildComponentEvidence()
    const seeded = seedState(nowMs, evidence)
    let syncCalls = 0
    const { store, worker } = makeWorker({
      seed: seeded.db,
      nowMs,
      evidence,
      async sync() {
        syncCalls += 1
        throw new Error('畸形 V5 身份不得读取源表')
      }
    })
    const created = worker.createCurrentConvergence(seeded.blockedRunId, seeded.baselineDryRunId)
    store.updateDb((db) => {
      mutate(db.feishuSyncRuns.find((run) => run.runId === created.runId))
    })
    await assert.rejects(
      worker.run(created.runId, { workerId: `manual-cli:identity-${label}` }),
      /当前态收敛|CONVERGENCE/,
      `畸形 V5 身份必须在读取源表前拒绝：${label}`
    )
    assert.strictEqual(syncCalls, 0, `畸形 V5 身份不得读取源表：${label}`)
    assert.strictEqual(store.snapshot().feishuSyncScheduler.blockedRunId, seeded.blockedRunId)
  }
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
            version: 5,
            runId: 'feishu-sync-convergence-current-01',
            state: STATES.QUEUED,
            convergenceContract: 'feishu-current-state-convergence-v2',
            convergenceDigestContract: 'feishu-current-state-digest-binding-v2',
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
  applyResultNotCompleteRootCanUseCurrentConvergence()
  await resolvedHistoricalUnknownDoesNotBlockFreshConvergence()
  canonicalThreeRoleBaselineCanUseCurrentConvergence()
  await successPathIsExactlyOnce()
  await driftFailsBeforeWriteAndPreservesOldBarrier()
  await materialWarningInInternalDryFailsBeforeWrite()
  await preexistingResolutionMarkerFailsClosed()
  await commitPhaseTamperingCreatesANewUnknownBarrier()
  await tamperedPristineSeedNeverRuns()
  await tamperedPersistedDrySummaryNeverReachesTheWriteGate()
  await frozenEvidenceTamperingNeverReachesTheFirstWrite()
  await postIntentEvidenceTamperingCannotCommit()
  await frozenIdentityTamperingNeverReachesTheFirstWrite()
  await postIntentIdentityTamperingCannotCommit()
  await clearedPersistedWriteIntentCannotMasqueradeAsZeroWrite()
  await repeatedWriteCallbackCannotRebuildClearedIntent()
  await changedPersistedWriteIntentTimeCannotCommit()
  await repeatedWriteCallbackRejectsIdentityDriftBeforeSecondWrite()
  await runNextNeverClaimsExplicitConvergence()
  await safePrewriteFailureAllowsANewBaselineAttempt()
  expiredPrewriteLeasesTerminateAndAllowFreshAttempt()
  expiredTamperedConvergenceIdentityFailsClosed()
  trimPreservesTheBoundBaseline()
  await preflightDriftStopsBeforeTheWriteIntent()
  await baselineDigestBindingsRejectTamperingBeforeSourceRead()
  await malformedConvergenceIdentityIsRejectedBeforeSourceRead()
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
