const assert = require('assert')

const feishuSync = require('../src/feishu-sync')
const { _internal: workerInternal } = require('../src/feishu-sync-worker')

const SHA = Object.freeze({
  sourceSchema: '1'.repeat(64),
  locationSchema: '2'.repeat(64),
  mirrorSchema: '3'.repeat(64),
  sourceDigest: '4'.repeat(64),
  locationDigest: '5'.repeat(64),
  mirrorDigest: '6'.repeat(64)
})

function snapshot(schemaFingerprint, digest, records = []) {
  return {
    complete: true,
    schemaFingerprint,
    digest,
    recordCount: records.length,
    records
  }
}

function build({ operations, currentFields, mirrorRecords, plannedFields }) {
  return feishuSync._internal.buildMirrorSafetyDigests({
    sourceSnapshot: snapshot(SHA.sourceSchema, SHA.sourceDigest),
    locationSnapshot: snapshot(SHA.locationSchema, SHA.locationDigest),
    mirrorSnapshot: snapshot(SHA.mirrorSchema, SHA.mirrorDigest, mirrorRecords || [{
      recordId: 'rec-current-1',
      fields: currentFields
    }]),
    resources: {},
    operations,
    plannedRecords: [{
      recordId: 'rec-current-1',
      fields: plannedFields
    }]
  })
}

function update(fields) {
  return [{
    type: 'update',
    recordId: 'rec-current-1',
    sourceRecordId: 'rec-source-1',
    foundationListingId: 'TMP-SEMANTIC-1',
    fields
  }]
}

function run() {
  const current = {
    foundationListingId: 'TMP-SEMANTIC-1',
    sourceRecordId: 'rec-source-1',
    listingStatus: '待出租',
    vacancyNote: '',
    lifecycleDays: 9,
    enabled: true,
    published: true
  }
  const day10Fields = { ...current, vacancyNote: '有阳台', lifecycleDays: 10 }
  const day11Fields = { ...current, vacancyNote: '有阳台', lifecycleDays: 11 }
  const day10 = build({
    currentFields: current,
    operations: update(day10Fields),
    plannedFields: day10Fields
  })
  const day11 = build({
    currentFields: current,
    operations: update(day11Fields),
    plannedFields: day11Fields
  })

  assert.match(day10.semanticMirrorPlanSha256, /^[0-9a-f]{64}$/)
  assert.notStrictEqual(
    day10.mirrorPlanSha256,
    day11.mirrorPlanSha256,
    '完整摘要必须继续观察 lifecycleDays，供同一次 dry→apply 防篡改'
  )
  assert.strictEqual(
    day10.semanticMirrorPlanSha256,
    day11.semanticMirrorPlanSha256,
    '跨运行相差一天时，只变化 lifecycleDays 不得制造业务计划漂移'
  )

  const lifecycleOnlyCurrent = { ...current, lifecycleDays: 10 }
  const lifecycleNoop = build({
    currentFields: lifecycleOnlyCurrent,
    operations: [],
    plannedFields: lifecycleOnlyCurrent
  })
  const lifecycleUpdate = build({
    currentFields: lifecycleOnlyCurrent,
    operations: update({ ...lifecycleOnlyCurrent, lifecycleDays: 11 }),
    plannedFields: { ...lifecycleOnlyCurrent, lifecycleDays: 11 }
  })
  assert.notStrictEqual(
    lifecycleNoop.mirrorPlanSha256,
    lifecycleUpdate.mirrorPlanSha256,
    '完整摘要必须保留纯生命周期更新的出现与消失'
  )
  assert.strictEqual(
    lifecycleNoop.semanticMirrorPlanSha256,
    lifecycleUpdate.semanticMirrorPlanSha256,
    '纯 lifecycleDays 更新从无到有时，跨运行语义摘要必须稳定'
  )

  const businessChange = build({
    currentFields: current,
    operations: update({ ...day11Fields, vacancyNote: '改成密码锁' }),
    plannedFields: { ...day11Fields, vacancyNote: '改成密码锁' }
  })
  assert.notStrictEqual(
    businessChange.semanticMirrorPlanSha256,
    day11.semanticMirrorPlanSha256,
    '任何非派生业务字段变化都必须改变跨运行语义摘要'
  )

  const targetCurrent = { ...current, vacancyNote: '原备注', lifecycleDays: 10 }
  const changedTarget = { ...targetCurrent, vacancyNote: '新备注', lifecycleDays: 11 }
  const mirrorRecords = [
    { recordId: 'rec-decoy-1', fields: changedTarget },
    { recordId: 'rec-current-1', fields: targetCurrent }
  ]
  const samePlannedWithoutOperation = build({
    currentFields: targetCurrent,
    mirrorRecords,
    operations: [],
    plannedFields: changedTarget
  })
  const exactRecordUpdate = build({
    currentFields: targetCurrent,
    mirrorRecords,
    operations: update(changedTarget),
    plannedFields: changedTarget
  })
  assert.notStrictEqual(
    exactRecordUpdate.semanticMirrorPlanSha256,
    samePlannedWithoutOperation.semanticMirrorPlanSha256,
    '纯生命周期更新只能按 operation.recordId 精确命中当前记录，不得借用其他记录过滤真实业务变化'
  )

  const operationTampered = build({
    currentFields: targetCurrent,
    operations: update({ ...targetCurrent, vacancyNote: '操作单独篡改', lifecycleDays: 11 }),
    plannedFields: targetCurrent
  })
  const untamperedPlan = build({
    currentFields: targetCurrent,
    operations: [],
    plannedFields: targetCurrent
  })
  assert.notStrictEqual(
    operationTampered.semanticMirrorPlanSha256,
    untamperedPlan.semanticMirrorPlanSha256,
    '只有全部托管字段除 lifecycleDays 外完全一致才能过滤 update'
  )

  const lifecyclePlanned = { ...targetCurrent, lifecycleDays: 11 }
  const lifecyclePlannedWithoutOperation = build({
    currentFields: targetCurrent,
    operations: [],
    plannedFields: lifecyclePlanned
  })
  const injectedFields = build({
    currentFields: targetCurrent,
    operations: update({
      ...lifecyclePlanned,
      unexpectedField: 'must-remain-visible'
    }),
    plannedFields: lifecyclePlanned
  })
  assert.notStrictEqual(
    injectedFields.semanticMirrorPlanSha256,
    lifecyclePlannedWithoutOperation.semanticMirrorPlanSha256,
    'operation.fields 的任何未知字段都必须进入语义摘要，不得随纯生命周期 update 被过滤'
  )
  const injectedOperation = update(lifecyclePlanned)
  injectedOperation[0].unexpectedTopLevel = 'must-remain-visible'
  const injectedTopLevel = build({
    currentFields: targetCurrent,
    operations: injectedOperation,
    plannedFields: lifecyclePlanned
  })
  assert.notStrictEqual(
    injectedTopLevel.semanticMirrorPlanSha256,
    lifecyclePlannedWithoutOperation.semanticMirrorPlanSha256,
    'update 顶层必须使用精确闭集，额外字段不得被语义过滤器吞掉'
  )

  assert.throws(
    () => workerInternal.validateFrozenApplyPlan({
      schemaSha256: day11.schemaSha256,
      resourceIdentitySha256: day11.resourceIdentitySha256,
      mirrorPlanSha256: day11.mirrorPlanSha256,
      semanticMirrorPlanSha256: day11.semanticMirrorPlanSha256,
      componentEvidence: day11.componentEvidence,
      componentEvidenceSha256: day11.componentEvidenceSha256
    }, {
      ...day10,
      contentPlanSha256: '7'.repeat(64),
      contentPlanAssetCount: 1
    }, { strictMirrorPlanBinding: true }),
    (error) => error && error.code === 'MIRROR_PLAN_CHANGED',
    '同一次 apply 即使语义摘要相同，也必须用完整摘要拦截 lifecycleDays 篡改'
  )
}

run()
console.log('feishu-sync-semantic-plan-digest-v1-test passed')
