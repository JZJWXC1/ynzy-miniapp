const assert = require('assert')
const crypto = require('crypto')

const feishuSync = require('../src/feishu-sync')
const {
  STATES,
  createFeishuSyncWorker,
  _internal: workerInternal
} = require('../src/feishu-sync-worker')
const workerRunner = require('./run-feishu-sync-worker')
const healthCheck = require('./health-check')

const SHA = Object.freeze({
  schema: '1'.repeat(64),
  resource: '2'.repeat(64),
  content: '3'.repeat(64)
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
  let updateCalls = 0
  let failNextUpdate = false
  return {
    readDb() {
      return clone(db)
    },
    updateDb(mutator) {
      updateCalls += 1
      const working = clone(db)
      const result = mutator(working)
      if (result && typeof result.then === 'function') {
        throw new Error('测试数据库事务只允许同步回调')
      }
      if (failNextUpdate) {
        failNextUpdate = false
        throw new Error('模拟本地数据库提交失败')
      }
      db = working
      return result
    },
    snapshot() {
      return clone(db)
    },
    updateCalls() {
      return updateCalls
    },
    failNextUpdate() {
      failNextUpdate = true
    }
  }
}

function snapshot(role, schema, digest, recordCount, semantic) {
  return {
    schemaFingerprint: schema,
    digest,
    recordCount,
    schemaBindings: [{ semantic, fieldName: `${role}Field`, type: 1 }]
  }
}

function buildEvidence({
  zeroOperations,
  nonzeroOperation = 'main',
  optionalRoles = ['rented', 'history']
}) {
  const operation = {
    type: 'update',
    recordId: 'record-current-1',
    fields: { listingStatus: '待出租' }
  }
  const selectedOperation = zeroOperations ? '' : nonzeroOperation
  return feishuSync._internal.buildMirrorSafetyDigests({
    sourceSnapshot: snapshot('source', SHA.schema, 'a'.repeat(64), 43, 'community'),
    locationSnapshot: snapshot('location', '4'.repeat(64), 'b'.repeat(64), 34, 'community'),
    mirrorSnapshot: snapshot('mini', '5'.repeat(64), 'c'.repeat(64), 76, 'community'),
    rentedSnapshot: optionalRoles.includes('rented')
      ? snapshot('rented', '6'.repeat(64), 'd'.repeat(64), 23, 'listingStatus')
      : null,
    historySnapshot: optionalRoles.includes('history')
      ? snapshot('history', '7'.repeat(64), 'e'.repeat(64), 54, 'eventType')
      : null,
    resources: {},
    operations: selectedOperation === 'main' ? [operation] : [],
    archiveOperations: selectedOperation === 'archive' ? [operation] : [],
    historyOperations: selectedOperation === 'history' ? [operation] : [],
    baselineMarkerOperation: selectedOperation === 'baselineMarker' ? operation : null,
    plannedRecords: []
  })
}

function dryResult(evidence) {
  return {
    success: true,
    complete: true,
    dryRun: true,
    failed: 0,
    created: 0,
    updated: 43,
    down: 0,
    sourceRecordCount: 43,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: evidence.mirrorPlanSha256,
    semanticMirrorPlanSha256: evidence.semanticMirrorPlanSha256,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 12,
    componentEvidence: clone(evidence.componentEvidence),
    componentEvidenceSha256: evidence.componentEvidenceSha256,
    schemaBindings: clone(evidence.schemaBindings)
  }
}

function frozenPlan(evidence) {
  return {
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    mirrorPlanSha256: evidence.mirrorPlanSha256,
    semanticMirrorPlanSha256: evidence.semanticMirrorPlanSha256,
    componentEvidence: clone(evidence.componentEvidence),
    componentEvidenceSha256: evidence.componentEvidenceSha256
  }
}

function exactPartialUnknownRun(runId, nowMs, evidence, {
  requestKeySha256 = '',
  omitRequestKeySha256 = false
} = {}) {
  const run = {
    version: 3,
    runId,
    runNowMs: nowMs,
    state: STATES.UNKNOWN,
    trigger: 'manual',
    dryRun: false,
    actorType: 'manual',
    actorId: 'admin:manual-noop-resolution',
    bucket: null,
    requestKeySha256,
    errorCode: 'UNKNOWN_ERROR',
    mirrorPlanSha256: evidence.mirrorPlanSha256,
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    contentPlanSha256: SHA.content,
    contentPlanAssetCount: 12,
    externalWritesMayHaveOccurred: true,
    applyIntentAt: nowMs + 1_000,
    externalWriteIntentAt: nowMs + 1_000,
    writeIntentEvidenceVersion: 1,
    attemptCount: 1,
    recoveryCount: 0,
    createdAt: nowMs,
    updatedAt: nowMs + 2_000,
    finishedAt: nowMs + 2_000,
    lease: null
  }
  if (omitRequestKeySha256) delete run.requestKeySha256
  return run
}

function partialReconciliationEvidence(runId, evidence) {
  const body = {
    contract: 'feishu-partial-base-write-reconciliation-v1',
    runIdSha256: crypto.createHash('sha256').update(runId).digest('hex'),
    priorMirrorPlanSha256: evidence.mirrorPlanSha256,
    currentMirrorPlanSha256: '8'.repeat(64),
    schemaSha256: SHA.schema,
    resourceIdentitySha256: SHA.resource,
    archiveCount: 3,
    historyCount: 10,
    archiveEvidenceSha256: '9'.repeat(64),
    historyEvidenceSha256: 'a'.repeat(64),
    currentOperationsSha256: 'b'.repeat(64),
    currentPlan: {
      create: 6,
      update: 37,
      deactivate: 3,
      restore: 0,
      noop: 0
    }
  }
  return { ...body, evidenceSha256: stableSha256(body) }
}

function seedState(oldEvidence, initialNowMs, {
  rootLineageDepth = 1,
  rootRequestKeySha256 = '',
  omitRootRequestKeySha256 = false
} = {}) {
  const parentUnknownRunId = 'feishu-sync-parent-partial-unknown-01'
  const rootUnknownRunId = rootLineageDepth === 0
    ? parentUnknownRunId
    : 'feishu-sync-root-unknown-01'
  const baselineDryRunId = 'feishu-sync-baseline-dry-01'
  return {
    parentUnknownRunId,
    rootUnknownRunId,
    baselineDryRunId,
    db: {
      listings: [{
        id: 'local-listing-1',
        status: 'available',
        privateNote: 'privacy-sentinel-13800000000'
      }],
      feishuSyncRuns: [exactPartialUnknownRun(
        parentUnknownRunId,
        initialNowMs,
        oldEvidence,
        {
          requestKeySha256: rootRequestKeySha256,
          omitRequestKeySha256: omitRootRequestKeySha256
        }
      )],
      feishuSyncScheduler: {
        nextFence: 0,
        activeLease: null,
        blockedRunId: parentUnknownRunId,
        leaseIntegrityBlockedRunId: '',
        lastRunId: parentUnknownRunId,
        lastDryRunAt: 0
      },
      feishuSyncCommitMarkers: {},
      feishuSyncConvergenceResolutions: {}
    }
  }
}

function makeFixture({
  maxRuns = 50,
  extraRunIds = [],
  verificationOptionalRoles = [],
  rootLineageDepth = 1,
  rootRequestKeySha256 = '',
  omitRootRequestKeySha256 = false
} = {}) {
  const initialNowMs = 1_900_000_000_000
  const oldEvidence = buildEvidence({ zeroOperations: false })
  const zeroEvidence = buildEvidence({
    zeroOperations: true,
    optionalRoles: verificationOptionalRoles
  })
  const seeded = seedState(oldEvidence, initialNowMs, {
    rootLineageDepth,
    rootRequestKeySha256,
    omitRootRequestKeySha256
  })
  const store = createStore(seeded.db)
  let nowMs = initialNowMs + 86_400_000
  let phase = 'continuation-failure'
  let syncCalls = 0
  let commitCalls = 0
  const reconciliationEvidence = partialReconciliationEvidence(
    seeded.parentUnknownRunId,
    oldEvidence
  )
  const initialIds = [
    ...(rootLineageDepth === 1 ? [seeded.rootUnknownRunId] : []),
    seeded.baselineDryRunId,
    'feishu-sync-failed-v5-01',
    'feishu-sync-verify-dry-01',
    'feishu-sync-verify-dry-02',
    ...extraRunIds
  ]
  function createWorkerInstance(workerMaxRuns, workerIds, workerStore = store) {
    const ids = [...workerIds]
    return createFeishuSyncWorker({
      dbStore: workerStore,
      writeLockEnabled: true,
      heartbeat: false,
      now() {
        nowMs += 1_000
        return nowMs
      },
      randomId() {
        const next = ids.shift()
        if (!next) throw new Error('测试 runId 已耗尽')
        return next
      },
      config: {
        approvedSchemaSha256: SHA.schema,
        approvedResourceIdentitySha256: SHA.resource,
        leaseMs: 60_000,
        maxRuns: workerMaxRuns
      },
      commitDeltaChecked: async () => {
        commitCalls += 1
        throw new Error('失败 V5 不得进入本地正式提交')
      },
      feishuSync: {
        async reconcilePartialBaseWrites(_db, input) {
          assert.strictEqual(input.runId, seeded.parentUnknownRunId)
          assert.strictEqual(input.expectedMirrorPlanSha256, oldEvidence.mirrorPlanSha256)
          return clone(reconciliationEvidence)
        },
        async sync(_db, _actorId, options) {
          syncCalls += 1
          if (phase === 'continuation-failure') {
            if (options.dryRun === true) return dryResult(oldEvidence)
            options.onApplyPlanFrozen(frozenPlan(oldEvidence))
            options.onExternalWriteDispatched()
            throw new Error('模拟原始 V3 首写后连接中断')
          }
          if (phase === 'baseline') {
            assert.strictEqual(options.dryRun, true)
            return dryResult(oldEvidence)
          }
          if (phase === 'failed-convergence') {
            if (options.dryRun === true) return dryResult(oldEvidence)
            options.onApplyPlanFrozen(frozenPlan(oldEvidence))
            options.onExternalWriteDispatched()
            const error = new Error('模拟联系电话字段失败')
            error.code = 'FEISHU_API_1254072'
            throw error
          }
          assert.strictEqual(options.dryRun, true, '解屏前只允许执行两次只读预演')
          return dryResult(zeroEvidence)
        }
      }
    })
  }
  const worker = createWorkerInstance(maxRuns, initialIds)
  return {
    rootLineageDepth,
    seeded,
    store,
    worker,
    oldEvidence,
    zeroEvidence,
    createWorker(workerMaxRuns, workerIds) {
      return createWorkerInstance(workerMaxRuns, workerIds)
    },
    createWorkerWithStore(workerStore, workerMaxRuns = maxRuns, workerIds = []) {
      return createWorkerInstance(workerMaxRuns, workerIds, workerStore)
    },
    counters() {
      return { syncCalls, commitCalls, updateCalls: store.updateCalls() }
    },
    advanceNow(deltaMs) {
      nowMs += deltaMs
    },
    switchToBaseline() {
      phase = 'baseline'
    },
    switchToFailedConvergence() {
      phase = 'failed-convergence'
    },
    switchToVerification() {
      phase = 'verification'
    }
  }
}

async function buildFailedV5AndTwoFreshDryRuns(options) {
  const fixture = makeFixture(options)
  if (fixture.rootLineageDepth === 1) {
    const reconciled = await fixture.worker.resolveAndEnqueueReconciledPartial(
      fixture.seeded.parentUnknownRunId
    )
    assert.strictEqual(reconciled.resolvedRun.state, STATES.RECONCILED_PARTIAL)
    assert.strictEqual(reconciled.continuationRun.runId, fixture.seeded.rootUnknownRunId)
    assert.strictEqual(
      reconciled.continuationRun.continuationOfRunId,
      fixture.seeded.parentUnknownRunId
    )
    const rawContinuation = rawRun(
      fixture.store.snapshot(),
      reconciled.continuationRun.runId
    )
    assert.match(rawContinuation.requestKeySha256, /^[a-f0-9]{64}$/)
    const rootUnknown = await fixture.worker.run(
      reconciled.continuationRun.runId,
      { workerId: 'manual:test-v3-continuation' }
    )
    assert.strictEqual(rootUnknown.state, STATES.UNKNOWN)
    assert.strictEqual(rootUnknown.externalWritesMayHaveOccurred, true)
    const rawRootUnknown = rawRun(fixture.store.snapshot(), rootUnknown.runId)
    assert.strictEqual(rawRootUnknown.continuationOfRunId, fixture.seeded.parentUnknownRunId)
    assert.match(rawRootUnknown.sourceUnknownRunSha256, /^[a-f0-9]{64}$/)
    assert.match(rawRootUnknown.reconciliationEvidenceSha256, /^[a-f0-9]{64}$/)
    assert.match(rawRootUnknown.requestKeySha256, /^[a-f0-9]{64}$/)
  } else {
    const rootUnknown = rawRun(fixture.store.snapshot(), fixture.seeded.rootUnknownRunId)
    assert.strictEqual(rootUnknown.state, STATES.UNKNOWN)
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(rootUnknown, 'continuationOfRunId'),
      false
    )
  }

  fixture.switchToBaseline()
  const baselineQueued = fixture.worker.enqueue({
    trigger: 'manual',
    dryRun: true,
    actorId: 'admin:manual-noop-resolution'
  })
  assert.strictEqual(baselineQueued.runId, fixture.seeded.baselineDryRunId)
  const baseline = await fixture.worker.run(baselineQueued.runId, {
    workerId: 'manual:test-baseline'
  })
  assert.strictEqual(baseline.state, STATES.DRY_SUCCEEDED)

  fixture.switchToFailedConvergence()
  const failedV5 = fixture.worker.createCurrentConvergence(
    fixture.seeded.rootUnknownRunId,
    fixture.seeded.baselineDryRunId
  )
  const failed = await fixture.worker.run(failedV5.runId, { workerId: 'manual:test-v5' })
  assert.strictEqual(failed.state, STATES.UNKNOWN)
  assert.strictEqual(failed.externalWritesMayHaveOccurred, true)
  fixture.switchToVerification()

  const first = fixture.worker.enqueue({
    trigger: 'manual',
    dryRun: true,
    actorId: 'admin:manual-noop-resolution'
  })
  const firstResult = await fixture.worker.run(first.runId, { workerId: 'manual:test-dry-1' })
  assert.strictEqual(firstResult.state, STATES.DRY_SUCCEEDED)

  const second = fixture.worker.enqueue({
    trigger: 'manual',
    dryRun: true,
    actorId: 'admin:manual-noop-resolution'
  })
  const secondResult = await fixture.worker.run(second.runId, { workerId: 'manual:test-dry-2' })
  assert.strictEqual(secondResult.state, STATES.DRY_SUCCEEDED)
  return { fixture, failedV5, firstResult, secondResult }
}

function rawRun(db, runId) {
  return db.feishuSyncRuns.find((run) => run && run.runId === runId)
}

function assertManualFailure(callback, message) {
  assert.throws(callback, (error) => (
    error && error.code === 'MANUAL_NOOP_RESOLUTION_FAILED'
  ), message)
}

function replaceDryEvidence(db, runId, evidence) {
  const run = rawRun(db, runId)
  run.mirrorPlanSha256 = evidence.mirrorPlanSha256
  run.semanticMirrorPlanSha256 = evidence.semanticMirrorPlanSha256
  run.componentEvidence = clone(evidence.componentEvidence)
  run.componentEvidenceSha256 = evidence.componentEvidenceSha256
  run.schemaBindings = clone(evidence.schemaBindings)
}

function evidenceWithoutRequiredRole(evidence, role) {
  const result = clone(evidence)
  result.componentEvidence.snapshots = result.componentEvidence.snapshots.filter((item) => (
    item.role !== role
  ))
  result.componentEvidenceSha256 = stableSha256(result.componentEvidence)
  result.schemaBindings = result.schemaBindings.filter((item) => item.role !== role)
  return result
}

function rehashManualResolutionMarker(db, plan) {
  const marker = db.feishuSyncConvergenceResolutions[plan.rootUnknownRun.runId]
  const root = rawRun(db, marker.rootUnknownRunId)
  const failed = rawRun(db, marker.failedConvergenceRunId)
  const baseline = rawRun(db, marker.failedConvergenceBaselineDryRunId)
  const dryRuns = marker.verificationDryRunIds.map((runId) => rawRun(db, runId))
  marker.rootUnknownRunSha256 = stableSha256(root)
  marker.failedConvergenceRunSha256 = stableSha256(failed)
  marker.failedConvergenceBaselineDryRunSha256 = stableSha256(baseline)
  marker.verificationDryRunSha256s = dryRuns.map(stableSha256)
  marker.evidenceSha256 = stableSha256(plan.evidence)
  marker.approvalSha256 = stableSha256({
    contract: 'feishu-manual-five-table-noop-approval-v1',
    rootUnknownRun: {
      runId: root.runId,
      runSha256: stableSha256(root)
    },
    failedConvergenceRun: {
      runId: failed.runId,
      runSha256: stableSha256(failed)
    },
    failedConvergenceBaselineDryRun: {
      runId: baseline.runId,
      runSha256: stableSha256(baseline)
    },
    verificationDryRuns: dryRuns.map((run) => ({
      runId: run.runId,
      runSha256: stableSha256(run)
    })),
    evidence: clone(plan.evidence),
    evidenceSha256: stableSha256(plan.evidence),
    businessSnapshotSha256: marker.businessSnapshotSha256,
    approvalExpiresAt: dryRuns[1].finishedAt + 30 * 60 * 1000
  })
  const markerBody = clone(marker)
  delete markerBody.markerSha256
  marker.markerSha256 = stableSha256(markerBody)
}

async function testPlanAndApplyAreLocalAtomicAndAuditable() {
  const built = await buildFailedV5AndTwoFreshDryRuns()
  const { fixture, failedV5, firstResult, secondResult } = built
  const beforePlan = fixture.store.snapshot()
  const beforePlanBytes = JSON.stringify(beforePlan)
  const countersBeforePlan = fixture.counters()
  const rootSha256 = stableSha256(rawRun(beforePlan, fixture.seeded.rootUnknownRunId))
  const failedV5Sha256 = stableSha256(rawRun(beforePlan, failedV5.runId))
  const allRunsSha256 = stableSha256(beforePlan.feishuSyncRuns)
  const businessBefore = workerInternal.businessSnapshot(beforePlan)
  const plan = fixture.worker.planManualNoopResolution(
    failedV5.runId,
    firstResult.runId,
    secondResult.runId
  )
  assert.strictEqual(JSON.stringify(fixture.store.snapshot()), beforePlanBytes, '批准计划必须严格只读')
  assert.deepStrictEqual(fixture.counters(), countersBeforePlan, '批准计划不得调用同步、提交或数据库事务')
  assert.strictEqual(plan.contract, 'feishu-manual-five-table-noop-approval-v1')
  assert.match(plan.approvalSha256, /^[a-f0-9]{64}$/)
  assert.deepStrictEqual(plan.evidence.snapshots.map((item) => item.role), [
    'source', 'location', 'mini'
  ])
  assert.deepStrictEqual(
    rawRun(beforePlan, fixture.seeded.baselineDryRunId).componentEvidence.snapshots
      .map((item) => item.role),
    ['source', 'location', 'mini', 'rented', 'history'],
    '事故基线 dry 仍必须保留五表历史证据'
  )
  assert.deepStrictEqual(
    rawRun(beforePlan, failedV5.runId).componentEvidence.snapshots.map((item) => item.role),
    ['source', 'location', 'mini', 'rented', 'history'],
    '失败 convergence 仍必须保留五表历史证据'
  )
  const emptyOperationsSha256 = stableSha256([])
  for (const key of ['main', 'archive', 'history', 'baselineMarker']) {
    assert.deepStrictEqual(plan.evidence.operations[key], {
      count: 0,
      digest: emptyOperationsSha256
    }, `${key} 必须有 count+digest 双零证据`)
  }
  assert.strictEqual(plan.evidence.resultSummary.created, 0)
  assert.strictEqual(plan.evidence.resultSummary.updated, 43)
  assert.strictEqual(plan.evidence.resultSummary.down, 0)
  assert.strictEqual(plan.evidence.resultSummary.sourceRecordCount, 43)
  assert.strictEqual(
    JSON.stringify(plan).includes('privacy-sentinel-13800000000'),
    false,
    '批准摘要不得泄露本地房源正文或手机号'
  )

  const countersBeforeApply = fixture.counters()
  const staleBeforeApply = clone(fixture.store.snapshot())
  const resolved = fixture.worker.applyManualNoopResolution(
    failedV5.runId,
    firstResult.runId,
    secondResult.runId,
    plan.approvalSha256
  )
  assert.strictEqual(resolved.blockerCleared, true)
  assert.strictEqual(resolved.externalWrites, 0)
  const afterApply = fixture.store.snapshot()
  assert.strictEqual(afterApply.feishuSyncScheduler.blockedRunId, '')
  assert.strictEqual(stableSha256(rawRun(afterApply, fixture.seeded.rootUnknownRunId)), rootSha256)
  assert.strictEqual(stableSha256(rawRun(afterApply, failedV5.runId)), failedV5Sha256)
  assert.strictEqual(stableSha256(afterApply.feishuSyncRuns), allRunsSha256)
  assert.deepStrictEqual(workerInternal.businessSnapshot(afterApply), businessBefore)
  assert.strictEqual(
    fixture.counters().updateCalls,
    countersBeforeApply.updateCalls + 1,
    '解屏必须恰好一个本地数据库事务'
  )
  assert.strictEqual(fixture.counters().syncCalls, countersBeforeApply.syncCalls)
  assert.strictEqual(fixture.counters().commitCalls, countersBeforeApply.commitCalls)
  const marker = afterApply.feishuSyncConvergenceResolutions[fixture.seeded.rootUnknownRunId]
  assert.strictEqual(marker.contract, 'feishu-manual-five-table-noop-resolution-v1')
  assert.strictEqual(
    workerInternal.manualNoopResolutionMatches(
      afterApply,
      rawRun(afterApply, fixture.seeded.rootUnknownRunId)
    ),
    true
  )
  assert.strictEqual(
    workerInternal.manualNoopResolutionMatches(afterApply, rawRun(afterApply, failedV5.runId)),
    true
  )
  const health = healthCheck.evaluateFeishuSyncState(afterApply, { autoSyncEnabled: false })
  assert.strictEqual(health.ok, true, '有效本地 resolution 不得继续制造 UNKNOWN 假告警')

  let staleReadPending = true
  const staleReadStore = {
    readDb() {
      if (staleReadPending) {
        staleReadPending = false
        return clone(staleBeforeApply)
      }
      return fixture.store.readDb()
    },
    updateDb(mutator) {
      return fixture.store.updateDb(mutator)
    }
  }
  const concurrentWorker = fixture.createWorkerWithStore(staleReadStore)
  const beforeConcurrentBytes = JSON.stringify(fixture.store.snapshot())
  const beforeConcurrentUpdates = fixture.store.updateCalls()
  const concurrent = concurrentWorker.applyManualNoopResolution(
    failedV5.runId,
    firstResult.runId,
    secondResult.runId,
    plan.approvalSha256
  )
  assert.deepStrictEqual(concurrent, resolved, '并发进程看到旧快照后仍须幂等接受已落 marker')
  assert.strictEqual(JSON.stringify(fixture.store.snapshot()), beforeConcurrentBytes)
  assert.strictEqual(fixture.store.updateCalls(), beforeConcurrentUpdates + 1)

  const beforeRepeatBytes = JSON.stringify(afterApply)
  const beforeRepeatUpdates = fixture.store.updateCalls()
  const repeated = fixture.worker.applyManualNoopResolution(
    failedV5.runId,
    firstResult.runId,
    secondResult.runId,
    plan.approvalSha256
  )
  assert.deepStrictEqual(repeated, resolved, '本地回执丢失后的同参数重入必须幂等')
  assert.strictEqual(JSON.stringify(fixture.store.snapshot()), beforeRepeatBytes)
  assert.strictEqual(fixture.store.updateCalls(), beforeRepeatUpdates, '幂等重入不得重写数据库')

  fixture.store.updateDb((db) => {
    db.listings.push({ id: 'legitimate-later-business-change', status: 'available' })
  })
  fixture.worker.recover()
  assert.strictEqual(
    fixture.store.snapshot().feishuSyncScheduler.blockedRunId,
    '',
    '后续合法业务变化不得让历史解屏证据失信'
  )
}

async function testCanonicalOptionalVerificationRoleSequencesAreAccepted() {
  for (const optionalRoles of [['rented'], ['history'], ['rented', 'history']]) {
    const { fixture, failedV5, firstResult, secondResult } =
      await buildFailedV5AndTwoFreshDryRuns({ verificationOptionalRoles: optionalRoles })
    const plan = fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    )
    assert.deepStrictEqual(
      plan.evidence.snapshots.map((snapshot) => snapshot.role),
      ['source', 'location', 'mini', ...optionalRoles],
      '生产 canonical 可选角色序列必须保持可用'
    )
  }
}

async function testRootRequestKeyContractAcrossSupportedLineages() {
  const validRootRequestKeySha256 = 'c'.repeat(64)
  for (const rootLineageDepth of [0, 1]) {
    for (const rootRequestKeySha256 of ['', validRootRequestKeySha256]) {
      const { fixture, failedV5, firstResult, secondResult } =
        await buildFailedV5AndTwoFreshDryRuns({
          rootLineageDepth,
          rootRequestKeySha256
        })
      const plan = fixture.worker.planManualNoopResolution(
        failedV5.runId,
        firstResult.runId,
        secondResult.runId
      )
      assert.strictEqual(plan.rootUnknownRun.runId, fixture.seeded.rootUnknownRunId)
      assert.strictEqual(
        rawRun(fixture.store.snapshot(), fixture.seeded.parentUnknownRunId).requestKeySha256,
        rootRequestKeySha256,
        `depth ${rootLineageDepth} 的历史根请求摘要必须保持原值并可批准`
      )
    }
  }

  for (const invalid of [
    { label: 'missing', omitRootRequestKeySha256: true },
    { label: 'null', rootRequestKeySha256: null },
    { label: '空白', rootRequestKeySha256: ' ' },
    { label: 'uppercase', rootRequestKeySha256: 'A'.repeat(64) },
    { label: '63 位', rootRequestKeySha256: 'a'.repeat(63) },
    { label: '65 位', rootRequestKeySha256: 'a'.repeat(65) },
    { label: '非 hex', rootRequestKeySha256: 'g'.repeat(64) }
  ]) {
    const { fixture, failedV5, firstResult, secondResult } =
      await buildFailedV5AndTwoFreshDryRuns({ rootLineageDepth: 0, ...invalid })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), `ultimate root requestKeySha256 为 ${invalid.label} 时必须拒绝`)
  }

  for (const rootLineageDepth of [0, 1]) {
    const { fixture, failedV5, firstResult, secondResult } =
      await buildFailedV5AndTwoFreshDryRuns({
        rootLineageDepth,
        rootRequestKeySha256: 'a'.repeat(64)
      })
    fixture.store.updateDb((db) => {
      rawRun(db, fixture.seeded.parentUnknownRunId).requestKeySha256 = 'b'.repeat(64)
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), `depth ${rootLineageDepth} 的合法 SHA 单点漂移不得绕过全链绑定`)
  }
}

async function testInvalidEvidenceAndConcurrentDriftFailClosed() {
  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    const plan = fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    )
    const before = JSON.stringify(fixture.store.snapshot())
    assertManualFailure(() => fixture.worker.applyManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId,
      'f'.repeat(64)
    ), '错误批准摘要必须失败关闭')
    assert.strictEqual(JSON.stringify(fixture.store.snapshot()), before)
    fixture.store.updateDb((db) => {
      db.listings.push({ id: 'business-changed-after-plan' })
    })
    const drifted = JSON.stringify(fixture.store.snapshot())
    assertManualFailure(() => fixture.worker.applyManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId,
      plan.approvalSha256
    ), '计划后本地业务变化必须要求重新批准')
    assert.strictEqual(JSON.stringify(fixture.store.snapshot()), drifted)
  }

  for (const nonzeroOperation of ['main', 'archive', 'history', 'baselineMarker']) {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    const nonzeroEvidence = buildEvidence({ zeroOperations: false, nonzeroOperation })
    fixture.store.updateDb((db) => {
      replaceDryEvidence(db, firstResult.runId, nonzeroEvidence)
      replaceDryEvidence(db, secondResult.runId, nonzeroEvidence)
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), `${nonzeroOperation} 任一 Base 操作非零都不得解屏`)
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    fixture.store.updateDb((db) => {
      for (const runId of [firstResult.runId, secondResult.runId]) {
        const run = rawRun(db, runId)
        run.resultSummary.created = 1
        run.resultSummary.down = 3
      }
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), '四类操作为零但 created/down 非零的矛盾证据不得解屏')
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    fixture.store.updateDb((db) => {
      for (const runId of [firstResult.runId, secondResult.runId]) {
        rawRun(db, runId).resultSummary.updated = 42
      }
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), 'updated 与 sourceRecordCount 不相等时必须拒绝解屏')
  }

  for (const missingRole of ['source', 'location', 'mini']) {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    const fourRoleEvidence = buildEvidence({
      zeroOperations: true,
      optionalRoles: ['rented']
    })
    const missingEvidence = evidenceWithoutRequiredRole(fourRoleEvidence, missingRole)
    fixture.store.updateDb((db) => {
      replaceDryEvidence(db, firstResult.runId, missingEvidence)
      replaceDryEvidence(db, secondResult.runId, missingEvidence)
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), `verification dry 缺少必要 ${missingRole} 角色必须拒绝`)
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    const fourRoleEvidence = buildEvidence({
      zeroOperations: true,
      optionalRoles: ['rented']
    })
    fixture.store.updateDb((db) => {
      replaceDryEvidence(db, secondResult.runId, fourRoleEvidence)
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), '两轮 verification dry 的合法角色集合漂移仍必须拒绝')
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    fixture.store.updateDb((db) => {
      for (const runId of [firstResult.runId, secondResult.runId]) {
        const run = rawRun(db, runId)
        const snapshots = new Map(run.componentEvidence.snapshots.map((item) => [item.role, item]))
        const bindings = new Map(run.schemaBindings.map((item) => [item.role, item]))
        run.componentEvidence.snapshots = ['mini', 'source', 'location']
          .map((role) => snapshots.get(role))
        run.componentEvidenceSha256 = stableSha256(run.componentEvidence)
        run.schemaBindings = ['mini', 'source', 'location'].map((role) => bindings.get(role))
      }
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), '两轮同时重排角色并重哈希也必须拒绝')
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    fixture.store.updateDb((db) => {
      const run = rawRun(db, secondResult.runId)
      run.componentEvidence.snapshots[0].digest = 'f'.repeat(64)
      run.componentEvidenceSha256 = stableSha256(run.componentEvidence)
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), '两次五表快照漂移必须拒绝')
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      fixture.seeded.baselineDryRunId,
      secondResult.runId
    ), '事故前旧 dry 不得冒充事故后验证')
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      firstResult.runId
    ), '同一条 dry 不得重复充当两次独立验证')
    fixture.advanceNow(31 * 60 * 1000)
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), '第二次 dry 超过 30 分钟必须重新验证')
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    fixture.store.updateDb((db) => {
      rawRun(db, fixture.seeded.parentUnknownRunId).requestKeySha256 = 'invalid-root-key'
    })
    assertManualFailure(() => fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    ), '不符合真实单层续跑根身份的历史链不得生成假批准')
  }
}

async function testLocalTransactionFailureRollsBackAndStructuralMarkerMutationReblocks() {
  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    const plan = fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    )
    const before = JSON.stringify(fixture.store.snapshot())
    fixture.store.failNextUpdate()
    assert.throws(() => fixture.worker.applyManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId,
      plan.approvalSha256
    ), /模拟本地数据库提交失败/)
    assert.strictEqual(JSON.stringify(fixture.store.snapshot()), before, '事务失败不得留下半个 marker')
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    const plan = fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    )
    fixture.worker.applyManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId,
      plan.approvalSha256
    )
    fixture.store.updateDb((db) => {
      const marker = db.feishuSyncConvergenceResolutions[fixture.seeded.rootUnknownRunId]
      marker.unapprovedExtra = true
      const body = clone(marker)
      delete body.markerSha256
      marker.markerSha256 = stableSha256(body)
    })
    fixture.worker.recover()
    const after = fixture.store.snapshot()
    assert.strictEqual(after.feishuSyncScheduler.blockedRunId, failedV5.runId)
    assert.strictEqual(
      healthCheck.evaluateFeishuSyncState(after, { autoSyncEnabled: false }).ok,
      false,
      'marker 即使自洽重哈希但多字段也必须重新告警'
    )
  }

  {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    const plan = fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    )
    fixture.worker.applyManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId,
      plan.approvalSha256
    )
    fixture.store.updateDb((db) => {
      delete db.feishuSyncConvergenceResolutions[fixture.seeded.rootUnknownRunId]
    })
    fixture.worker.recover()
    const after = fixture.store.snapshot()
    assert.strictEqual(after.feishuSyncScheduler.blockedRunId, failedV5.runId)
    assert.strictEqual(
      healthCheck.evaluateFeishuSyncState(after, { autoSyncEnabled: false }).ok,
      false,
      'marker 丢失后必须重新阻断并恢复告警'
    )
  }
}

async function testRunTrimmingRetainsCompleteResolutionEvidence() {
  const built = await buildFailedV5AndTwoFreshDryRuns()
  const { fixture, failedV5, firstResult, secondResult } = built
  const plan = fixture.worker.planManualNoopResolution(
    failedV5.runId,
    firstResult.runId,
    secondResult.runId
  )
  fixture.worker.applyManualNoopResolution(
    failedV5.runId,
    firstResult.runId,
    secondResult.runId,
    plan.approvalSha256
  )

  const trimmingWorker = fixture.createWorker(1, ['feishu-sync-later-dry-01'])
  const later = trimmingWorker.enqueue({
    trigger: 'manual',
    dryRun: true,
    actorId: 'admin:manual-noop-resolution'
  })
  const laterResult = await trimmingWorker.run(later.runId, { workerId: 'manual:test-later' })
  assert.strictEqual(laterResult.state, STATES.DRY_SUCCEEDED)

  const after = fixture.store.snapshot()
  const retainedRunIds = new Set(after.feishuSyncRuns.map((run) => run.runId))
  for (const runId of [
    fixture.seeded.parentUnknownRunId,
    fixture.seeded.rootUnknownRunId,
    fixture.seeded.baselineDryRunId,
    failedV5.runId,
    firstResult.runId,
    secondResult.runId
  ]) {
    assert.strictEqual(retainedRunIds.has(runId), true, `历史裁剪不得删除解屏证据 ${runId}`)
  }
  assert.strictEqual(
    workerInternal.manualNoopResolutionMatches(
      after,
      rawRun(after, fixture.seeded.rootUnknownRunId)
    ),
    true
  )
  assert.strictEqual(
    workerInternal.manualNoopResolutionMatches(after, rawRun(after, failedV5.runId)),
    true
  )
  assert.strictEqual(after.feishuSyncScheduler.blockedRunId, '')
}

async function testHistoricalSelfConsistentRehashFailsClosed() {
  for (const mutation of [
    'root-shape',
    'lineage-root-request-key',
    'v5-seed',
    'late-resolution'
  ]) {
    const built = await buildFailedV5AndTwoFreshDryRuns()
    const { fixture, failedV5, firstResult, secondResult } = built
    const plan = fixture.worker.planManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId
    )
    fixture.worker.applyManualNoopResolution(
      failedV5.runId,
      firstResult.runId,
      secondResult.runId,
      plan.approvalSha256
    )
    fixture.store.updateDb((db) => {
      const root = rawRun(db, fixture.seeded.rootUnknownRunId)
      const lineageRoot = rawRun(db, fixture.seeded.parentUnknownRunId)
      const failed = rawRun(db, failedV5.runId)
      const marker = db.feishuSyncConvergenceResolutions[root.runId]
      if (mutation === 'root-shape') {
        root.errorCode = 'APPLY_FAILED'
        failed.supersedesBlockedRunSha256 = stableSha256(root)
      } else if (mutation === 'lineage-root-request-key') {
        lineageRoot.requestKeySha256 = 'tampered-request-key'
      } else if (mutation === 'v5-seed') {
        failed.convergenceSeedSha256 = 'f'.repeat(64)
      } else {
        marker.resolvedAt = secondResult.finishedAt + 31 * 60 * 1000
      }
      rehashManualResolutionMarker(db, plan)
    })

    const tampered = fixture.store.snapshot()
    assert.strictEqual(
      workerInternal.manualNoopResolutionMatches(
        tampered,
        rawRun(tampered, fixture.seeded.rootUnknownRunId)
      ),
      false,
      `${mutation} 即使重算全部公开摘要也不得继续受信`
    )
    fixture.worker.recover()
    const afterRecover = fixture.store.snapshot()
    assert.strictEqual(afterRecover.feishuSyncScheduler.blockedRunId, failedV5.runId)
    assert.strictEqual(
      healthCheck.evaluateFeishuSyncState(afterRecover, { autoSyncEnabled: false }).ok,
      false
    )
  }
}

async function testCliPlanAndApplyNeverEnterSyncExecution() {
  const built = await buildFailedV5AndTwoFreshDryRuns()
  const { fixture, failedV5, firstResult, secondResult } = built
  const outputs = []
  let genericRecoverCalls = 0
  let genericRunCalls = 0
  const cliWorker = {
    ...fixture.worker,
    recover() {
      genericRecoverCalls += 1
      throw new Error('本地解屏 CLI 不得进入 generic recover')
    },
    async run() {
      genericRunCalls += 1
      throw new Error('本地解屏 CLI 不得进入 generic run')
    }
  }
  const countersBeforePlan = fixture.counters()
  const planCode = await workerRunner.main([
    '--plan-manual-noop-resolution',
    failedV5.runId,
    firstResult.runId,
    secondResult.runId
  ], {
    createWorker() {
      return cliWorker
    },
    writeOutput(value) {
      outputs.push(value)
    }
  })
  assert.strictEqual(planCode, 0)
  const planOutput = JSON.parse(outputs.shift())
  assert.strictEqual(planOutput.ok, true)
  assert.deepStrictEqual(fixture.counters(), countersBeforePlan)
  assert.strictEqual(genericRecoverCalls, 0)
  assert.strictEqual(genericRunCalls, 0)
  assert.strictEqual(JSON.stringify(planOutput).includes('privacy-sentinel-13800000000'), false)

  const countersBeforeApply = fixture.counters()
  const applyCode = await workerRunner.main([
    '--apply-manual-noop-resolution',
    failedV5.runId,
    firstResult.runId,
    secondResult.runId,
    planOutput.approvalSha256
  ], {
    createWorker() {
      return cliWorker
    },
    writeOutput(value) {
      outputs.push(value)
    }
  })
  assert.strictEqual(applyCode, 0)
  const applyOutput = JSON.parse(outputs.shift())
  assert.strictEqual(applyOutput.blockerCleared, true)
  assert.strictEqual(genericRecoverCalls, 0)
  assert.strictEqual(genericRunCalls, 0)
  assert.strictEqual(fixture.counters().updateCalls, countersBeforeApply.updateCalls + 1)
  assert.strictEqual(fixture.counters().syncCalls, countersBeforeApply.syncCalls)
  assert.strictEqual(fixture.counters().commitCalls, countersBeforeApply.commitCalls)
  assert.throws(
    () => workerRunner.parseArgs([
      '--plan-manual-noop-resolution',
      failedV5.runId,
      firstResult.runId,
      firstResult.runId
    ]),
    /参数无效/
  )
  assert.throws(
    () => workerRunner.parseArgs([
      '--apply-manual-noop-resolution',
      failedV5.runId,
      firstResult.runId,
      secondResult.runId,
      'bad-sha'
    ]),
    /参数无效/
  )
}

async function main() {
  await testPlanAndApplyAreLocalAtomicAndAuditable()
  await testCanonicalOptionalVerificationRoleSequencesAreAccepted()
  await testRootRequestKeyContractAcrossSupportedLineages()
  await testInvalidEvidenceAndConcurrentDriftFailClosed()
  await testLocalTransactionFailureRollsBackAndStructuralMarkerMutationReblocks()
  await testRunTrimmingRetainsCompleteResolutionEvidence()
  await testHistoricalSelfConsistentRehashFailsClosed()
  await testCliPlanAndApplyNeverEnterSyncExecution()
  process.stdout.write('feishu-sync-manual-noop-resolution-v1-test passed\n')
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { main }
