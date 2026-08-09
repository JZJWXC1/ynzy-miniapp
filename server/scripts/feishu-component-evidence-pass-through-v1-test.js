'use strict'

const assert = require('assert')
const crypto = require('crypto')

const feishuSync = require('../src/feishu-sync')
const {
  runCompanySourceSync
} = require('../src/feishu-source-mirror')
const {
  STATES,
  createFeishuSyncWorker,
  _internal: workerInternal
} = require('../src/feishu-sync-worker')

const CONTENT_PLAN_SHA256 = 'f'.repeat(64)

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

function snapshot(role, digest, recordCount) {
  return {
    schemaFingerprint: stableSha256({ role, schema: 'v1' }),
    digest,
    recordCount,
    schemaBindings: [{ semantic: 'community', fieldName: '板块/商圈', type: 1 }]
  }
}

function componentDigests(options = {}) {
  const input = {
    sourceSnapshot: snapshot('source', '1'.repeat(64), 43),
    locationSnapshot: snapshot('location', '2'.repeat(64), 34),
    mirrorSnapshot: snapshot('mini', '3'.repeat(64), 67),
    resources: {},
    operations: [],
    archiveOperations: [],
    historyOperations: [],
    plannedRecords: []
  }
  if (options.fiveTables !== false) {
    input.rentedSnapshot = snapshot('rented', '4'.repeat(64), 20)
    input.historySnapshot = snapshot('history', '5'.repeat(64), 46)
  }
  return feishuSync._internal.buildMirrorSafetyDigests(input)
}

function mirrorStage(digests, patch = {}) {
  return {
    complete: true,
    published: false,
    validated: true,
    planned: true,
    failed: 0,
    schemaInvalid: false,
    mirrorIncomplete: false,
    success: true,
    status: 'success-dry-run',
    noop: true,
    dryRun: true,
    records: [],
    schemaSha256: digests.schemaSha256,
    resourceIdentitySha256: digests.resourceIdentitySha256,
    mirrorPlanSha256: digests.mirrorPlanSha256,
    semanticMirrorPlanSha256: digests.semanticMirrorPlanSha256,
    schemaBindings: clone(digests.schemaBindings),
    componentEvidence: clone(digests.componentEvidence),
    componentEvidenceSha256: digests.componentEvidenceSha256,
    ...patch
  }
}

async function composedDryResult(mirrorResult, stagePatch = {}) {
  const result = await runCompanySourceSync({
    db: { listings: [] },
    mirrorSync: async () => stagePatch.useSharedMirrorResult === true
      ? mirrorResult
      : clone(mirrorResult),
    applyInventory: async () => ({
      complete: true,
      published: true,
      failed: 0,
      noop: true,
      dryRun: true,
      ...(stagePatch.inventory || {})
    }),
    publishSnapshot: async () => ({
      complete: true,
      published: true,
      failed: 0,
      noop: true,
      dryRun: true,
      ...(stagePatch.snapshot || {})
    }),
    commit: async () => ({
      complete: true,
      failed: 0,
      noop: true,
      dryRun: true,
      ...(stagePatch.commit || {})
    })
  })
  return {
    ...result,
    contentPlanSha256: CONTENT_PLAN_SHA256,
    contentPlanAssetCount: 329
  }
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

async function testValidEvidencePassesThroughStageAndWorker() {
  const digests = componentDigests()
  const composed = await composedDryResult(mirrorStage(digests))
  assert.strictEqual(composed.status, 'success-dry-run')
  assert.ok(composed.mirror, '组合链路必须先通过镜像阶段，红测才能锁定摘要边界')
  assert.deepStrictEqual(
    composed.mirror.componentEvidence,
    digests.componentEvidence,
    '阶段摘要必须透传脱敏五表分项证据'
  )
  assert.strictEqual(
    composed.mirror.componentEvidenceSha256,
    digests.componentEvidenceSha256,
    '阶段摘要必须透传与分项证据自洽的 SHA-256'
  )
  assert.strictEqual(
    composed.mirror.semanticMirrorPlanSha256,
    digests.semanticMirrorPlanSha256,
    '阶段摘要必须透传跨运行语义计划摘要'
  )
  const extracted = workerInternal.extractDigests(composed, null)
  assert.deepStrictEqual(extracted.componentEvidence, digests.componentEvidence)
  assert.strictEqual(extracted.componentEvidenceSha256, digests.componentEvidenceSha256)
  assert.strictEqual(extracted.semanticMirrorPlanSha256, digests.semanticMirrorPlanSha256)

  const sharedMirrorResult = mirrorStage(digests)
  const sharedComposed = await composedDryResult(sharedMirrorResult, { useSharedMirrorResult: true })
  const originalCount = sharedComposed.mirror.componentEvidence.snapshots[0].recordCount
  sharedMirrorResult.componentEvidence.snapshots[0].recordCount += 1
  assert.strictEqual(
    sharedComposed.mirror.componentEvidence.snapshots[0].recordCount,
    originalCount,
    '阶段摘要必须深拷贝证据，不能受后续输入修改影响'
  )

  const store = createStore()
  const worker = createFeishuSyncWorker({
    dbStore: store,
    feishuSync: {
      sync: async () => clone(composed)
    },
    commitDeltaChecked: async () => {
      throw new Error('只读预演不得进入业务提交')
    },
    config: {
      approvedSchemaSha256: digests.schemaSha256,
      approvedResourceIdentitySha256: digests.resourceIdentitySha256,
      intervalMinutes: 30,
      leaseMs: 60_000,
      maxRuns: 50
    },
    now: () => 1_910_000_000_000,
    randomId: (prefix) => `${prefix}-component-evidence-dry-v1`,
    writeLockEnabled: true,
    heartbeat: false
  })
  const queued = worker.enqueue({
    trigger: 'manual',
    dryRun: true,
    actorId: 'admin:component-evidence-test'
  })
  const completed = await worker.run(queued.runId, { workerId: 'component-evidence-worker' })
  assert.strictEqual(completed.state, STATES.DRY_SUCCEEDED)
  assert.deepStrictEqual(completed.componentEvidence, digests.componentEvidence)
  assert.strictEqual(completed.componentEvidenceSha256, digests.componentEvidenceSha256)
  assert.strictEqual(completed.semanticMirrorPlanSha256, digests.semanticMirrorPlanSha256)
  assert.deepStrictEqual(
    store.snapshot().feishuSyncRuns[0].componentEvidence,
    digests.componentEvidence,
    '持久运行记录必须保留相同的五表证据'
  )
}

async function testInvalidOrExpandedEvidenceIsNotExposed() {
  const digests = componentDigests()
  const badSha = await composedDryResult(mirrorStage(digests, {
    componentEvidenceSha256: '0'.repeat(64)
  }))
  assert.strictEqual(badSha.mirror.componentEvidence, undefined)
  assert.strictEqual(badSha.mirror.componentEvidenceSha256, undefined)

  const expanded = clone(digests.componentEvidence)
  expanded.sourceRows = [{ sourceRecordId: '不得进入阶段摘要' }]
  const expandedResult = await composedDryResult(mirrorStage(digests, {
    componentEvidence: expanded,
    componentEvidenceSha256: stableSha256(expanded),
    records: [{ sourceRecordId: '不得进入阶段摘要的房源正文' }],
    privateToken: '不得透传的私有值'
  }))
  assert.strictEqual(expandedResult.mirror.componentEvidence, undefined)
  assert.strictEqual(expandedResult.mirror.componentEvidenceSha256, undefined)
  assert.strictEqual(JSON.stringify(expandedResult).includes('不得透传的私有值'), false)
  assert.strictEqual(JSON.stringify(expandedResult).includes('不得进入阶段摘要'), false)
  assert.strictEqual(JSON.stringify(expandedResult).includes('不得进入阶段摘要的房源正文'), false)

  const wrongStage = await composedDryResult(mirrorStage(digests), {
    snapshot: {
      componentEvidence: clone(digests.componentEvidence),
      componentEvidenceSha256: digests.componentEvidenceSha256
    },
    commit: {
      componentEvidence: clone(digests.componentEvidence),
      componentEvidenceSha256: digests.componentEvidenceSha256
    }
  })
  assert.strictEqual(wrongStage.snapshot.componentEvidence, undefined)
  assert.strictEqual(wrongStage.snapshot.componentEvidenceSha256, undefined)
  assert.strictEqual(wrongStage.commit.componentEvidence, undefined)
  assert.strictEqual(wrongStage.commit.componentEvidenceSha256, undefined)

  const reordered = clone(digests.componentEvidence)
  ;[reordered.snapshots[0], reordered.snapshots[1]] = [reordered.snapshots[1], reordered.snapshots[0]]
  const reorderedResult = await composedDryResult(mirrorStage(digests, {
    componentEvidence: reordered,
    componentEvidenceSha256: stableSha256(reordered)
  }))
  assert.strictEqual(reorderedResult.mirror.componentEvidence, undefined)
  assert.strictEqual(reorderedResult.mirror.componentEvidenceSha256, undefined)

  const sparse = clone(componentDigests({ fiveTables: false }).componentEvidence)
  delete sparse.snapshots[1]
  const sparseMirrorResult = mirrorStage(digests, {
    componentEvidence: sparse,
    componentEvidenceSha256: stableSha256(sparse)
  })
  const sparseResult = await composedDryResult(sparseMirrorResult, { useSharedMirrorResult: true })
  assert.strictEqual(sparseResult.mirror.componentEvidence, undefined)
  assert.strictEqual(sparseResult.mirror.componentEvidenceSha256, undefined)
}

async function testThreeTableEvidenceRemainsCompatible() {
  const digests = componentDigests({ fiveTables: false })
  const composed = await composedDryResult(mirrorStage(digests))
  assert.strictEqual(composed.status, 'success-dry-run')
  assert.deepStrictEqual(
    composed.mirror.componentEvidence.snapshots.map((snapshot) => snapshot.role),
    ['source', 'location', 'mini'],
    '旧三表模式必须继续透传规范证据，五表要求只由当前态收敛门承担'
  )
  assert.strictEqual(composed.mirror.componentEvidenceSha256, digests.componentEvidenceSha256)
}

async function testInventoryCannotOverrideMirrorEvidence() {
  const digests = componentDigests()
  const forgedEvidence = clone(digests.componentEvidence)
  forgedEvidence.snapshots[0].recordCount += 1
  const forgedSha256 = stableSha256(forgedEvidence)
  const composed = await composedDryResult(mirrorStage(digests), {
    inventory: {
      componentEvidence: forgedEvidence,
      componentEvidenceSha256: forgedSha256,
      contentPlanAssetCount: 999,
      contentPlanSha256: '4'.repeat(64),
      mirrorPlanSha256: '1'.repeat(64),
      noteMaterials: {
        contentPlanAssetCount: 329,
        contentPlanSha256: CONTENT_PLAN_SHA256
      },
      resourceIdentitySha256: '2'.repeat(64),
      schemaSha256: '3'.repeat(64),
      schemaBindings: [{ role: 'source', bindings: [] }],
      semanticMirrorPlanSha256: '0'.repeat(64)
    }
  })
  assert.strictEqual(composed.inventory.componentEvidence, undefined)
  assert.strictEqual(composed.inventory.componentEvidenceSha256, undefined)
  assert.strictEqual(composed.inventory.contentPlanAssetCount, undefined)
  assert.strictEqual(composed.inventory.contentPlanSha256, undefined)
  assert.strictEqual(composed.inventory.mirrorPlanSha256, undefined)
  assert.strictEqual(composed.inventory.resourceIdentitySha256, undefined)
  assert.strictEqual(composed.inventory.schemaSha256, undefined)
  assert.strictEqual(composed.inventory.schemaBindings, undefined)
  assert.strictEqual(composed.inventory.semanticMirrorPlanSha256, undefined)
  const flattened = feishuSync._internal.finalizeMirrorSyncResult(composed)
  assert.strictEqual(flattened.componentEvidence, undefined)
  assert.strictEqual(flattened.componentEvidenceSha256, undefined)
  assert.strictEqual(flattened.contentPlanAssetCount, undefined)
  assert.strictEqual(flattened.contentPlanSha256, undefined)
  assert.strictEqual(flattened.mirrorPlanSha256, undefined)
  assert.strictEqual(flattened.resourceIdentitySha256, undefined)
  assert.strictEqual(flattened.schemaSha256, undefined)
  assert.strictEqual(flattened.schemaBindings, undefined)
  assert.strictEqual(flattened.semanticMirrorPlanSha256, undefined)
  const extracted = workerInternal.extractDigests(flattened, null)
  assert.deepStrictEqual(extracted.componentEvidence, digests.componentEvidence)
  assert.strictEqual(
    extracted.componentEvidenceSha256,
    digests.componentEvidenceSha256,
    'worker 必须选择镜像证据，库存阶段不得用自洽伪造证据覆盖它'
  )
  assert.strictEqual(
    extracted.semanticMirrorPlanSha256,
    digests.semanticMirrorPlanSha256,
    'worker 必须选择镜像语义摘要，库存阶段不得覆盖它'
  )
  assert.strictEqual(extracted.mirrorPlanSha256, digests.mirrorPlanSha256)
  assert.strictEqual(extracted.resourceIdentitySha256, digests.resourceIdentitySha256)
  assert.strictEqual(extracted.schemaSha256, digests.schemaSha256)
  assert.strictEqual(extracted.contentPlanSha256, CONTENT_PLAN_SHA256)
  assert.strictEqual(extracted.contentPlanAssetCount, 329)
  assert.deepStrictEqual(
    workerInternal.sanitizeSchemaBindings(flattened),
    workerInternal.sanitizeSchemaBindings({ mirror: composed.mirror }),
    'schemaBindings 必须只信任镜像阶段，不得被库存根字段覆盖'
  )
}

async function main() {
  await testValidEvidencePassesThroughStageAndWorker()
  await testInvalidOrExpandedEvidenceIsNotExposed()
  await testThreeTableEvidenceRemainsCompatible()
  await testInventoryCannotOverrideMirrorEvidence()
  console.log('feishu-component-evidence-pass-through-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
