const assert = require('assert')

const bitableClient = require('../src/feishu-bitable-client')
const config = require('../src/config')
const feishuSync = require('../src/feishu-sync')
const workerCli = require('./run-feishu-sync-worker')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function snapshot(records) {
  return {
    complete: true,
    records: clone(records),
    recordCount: records.length,
    digest: '0'.repeat(64),
    schemaFingerprint: '1'.repeat(64),
    schemaBindings: [
      { semantic: 'name', fieldName: '名称', type: '1' },
      { semantic: 'tags', fieldName: '标签', type: '4' },
      { semantic: 'video', fieldName: '视频', type: '17' }
    ],
    fieldNames: {
      name: '名称',
      tags: '标签',
      video: '视频'
    }
  }
}

function testValidatedSnapshotDigestCanBeRebuiltWithoutMixedState() {
  const rebuild = bitableClient._internal &&
    bitableClient._internal.rebuildValidatedTableSnapshot
  assert.strictEqual(
    typeof rebuild,
    'function',
    '部分写入对账必须复用飞书客户端的同源快照摘要算法'
  )

  const first = {
    recordId: 'rec-b',
    createdTimeMs: 1_700_000_000_200,
    fields: {
      video: [{ file_token: 'video-b', name: '显示名不得进入摘要' }],
      tags: ['整租', '电梯', '整租'],
      name: '乙房源'
    }
  }
  const second = {
    recordId: 'rec-a',
    createdTimeMs: 1_700_000_000_100,
    fields: {
      name: '甲房源',
      tags: ['电梯', '整租'],
      video: [{ token: 'video-a' }]
    }
  }
  const original = snapshot([first, second])
  const originalCopy = clone(original)
  const rebuilt = rebuild(original, [second], { includeCreatedTime: false })
  const sameSemanticValue = rebuild(original, [{
    ...second,
    createdTimeMs: 1_700_000_000_999,
    fields: {
      video: [{ obj_token: 'video-a', name: '另一个显示名' }],
      tags: ['整租', '电梯', '电梯'],
      name: '甲房源'
    }
  }], { includeCreatedTime: false })
  const changed = rebuild(original, [{
    ...second,
    fields: { ...second.fields, name: '甲房源已变化' }
  }], { includeCreatedTime: false })
  const withCreatedTime = rebuild(original, [second], { includeCreatedTime: true })

  assert.deepStrictEqual(original, originalCopy, '重建不得原地修改正式快照')
  assert.strictEqual(rebuilt.recordCount, 1)
  assert.deepStrictEqual(rebuilt.records, [second])
  assert.strictEqual(rebuilt.digest, sameSemanticValue.digest, '附件显示名、多选顺序和创建时间不得污染标准目标表摘要')
  assert.notStrictEqual(rebuilt.digest, changed.digest, '业务字段变化必须改变重建摘要')
  assert.notStrictEqual(rebuilt.digest, withCreatedTime.digest, '取证用创建时间只能在显式要求时进入摘要')
  assert.throws(
    () => rebuild({ ...original, schemaBindings: [] }, [second], { includeCreatedTime: false }),
    /schema|字段|绑定/i,
    '缺少字段类型绑定时必须 fail-closed'
  )
}

function testContinuationTokensAndCliAreDeterministicAndNarrow() {
  const stableUpdateClientToken = feishuSync._internal.stableUpdateClientToken
  assert.strictEqual(typeof stableUpdateClientToken, 'function', '主表更新批次必须具备跨进程稳定 token')
  const firstScope = {
    phase: 'foundation-current',
    runId: 'feishu-sync-token-scope-a',
    runNowMs: 1_800_000_000_000
  }
  const laterScope = {
    phase: 'foundation-current',
    runId: 'feishu-sync-token-scope-b',
    runNowMs: 1_800_000_060_000
  }
  const first = stableUpdateClientToken('tbl-mini', [{
    record_id: 'rec-1',
    fields: { 价格: 3200, 状态: '待出租' }
  }], firstScope)
  const reordered = stableUpdateClientToken('tbl-mini', [{
    fields: { 状态: '待出租', 价格: 3200 },
    record_id: 'rec-1'
  }], firstScope)
  const changed = stableUpdateClientToken('tbl-mini', [{
    record_id: 'rec-1',
    fields: { 价格: 3300, 状态: '待出租' }
  }], firstScope)
  const laterSameBody = stableUpdateClientToken('tbl-mini', [{
    record_id: 'rec-1',
    fields: { 价格: 3200, 状态: '待出租' }
  }], laterScope)
  const otherTable = stableUpdateClientToken('tbl-history', [{
    record_id: 'rec-1',
    fields: { 价格: 3200, 状态: '待出租' }
  }], firstScope)
  const otherPhase = stableUpdateClientToken('tbl-mini', [{
    record_id: 'rec-1',
    fields: { 价格: 3200, 状态: '待出租' }
  }], { ...firstScope, phase: 'foundation-enrichment-current' })
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.strictEqual(first, reordered, '同一更新语义改变对象键顺序时 token 必须一致')
  assert.notStrictEqual(first, changed, '更新字段变化时不得复用旧 token')
  assert.notStrictEqual(first, laterSameBody, '不同正式 run 即使 A→B→A 请求体相同也不得复用旧 token')
  assert.notStrictEqual(first, otherTable, '同一 run 的相同请求体写向不同表时不得复用 token')
  assert.notStrictEqual(first, otherPhase, '同一 run 的相同请求体处于不同业务阶段时不得复用 token')
  assert.throws(
    () => stableUpdateClientToken('tbl-mini', [{
      record_id: 'rec-1',
      fields: { 价格: 3200 }
    }]),
    /作用域|runId|runNowMs/i,
    '缺少持久 run 作用域时不得退回跨批次复用 token'
  )

  assert.deepStrictEqual(
    workerCli.parseArgs(['--continue-reconciled-partial', 'feishu-sync-old-unknown']),
    { mode: 'continue-reconciled-partial', runId: 'feishu-sync-old-unknown' }
  )
  assert.throws(
    () => workerCli.parseArgs(['--continue-reconciled-partial', 'bad']),
    (error) => error && error.code === 'WORKER_ARGUMENT_INVALID',
    '解阻入口必须只接受完整安全 runId'
  )
  assert.throws(
    () => workerCli.parseArgs(['--continue-reconciled-partial', 'feishu-sync-old-unknown', '--run']),
    (error) => error && error.code === 'WORKER_ARGUMENT_INVALID',
    '解阻入口不得与执行入口组合成一次隐式写入'
  )
}

async function testConfiguredReconciliationApiIsReadOnlyAndInternal() {
  assert.strictEqual(
    typeof feishuSync.reconcilePartialBaseWrites,
    'function',
    'worker 必须通过服务端只读对账函数取得证据，不能接收客户端伪造计数'
  )
  await assert.rejects(
    feishuSync.reconcilePartialBaseWrites({}, {
      externalWriteIntentAt: 1_800_000_000_001,
      expectedMirrorPlanSha256: '2'.repeat(64),
      expectedResourceIdentitySha256: '3'.repeat(64),
      expectedSchemaSha256: '4'.repeat(64),
      runId: 'feishu-sync-old-unknown',
      runNowMs: '1800000000000'
    }),
    (error) => error && error.code === 'PARTIAL_RECONCILIATION_FAILED',
    '只读对账坐标必须使用服务端持久化的原生整数，字符串不得被宽松转换'
  )
}

async function testCliContinuationOnlyResolvesAndQueues() {
  const calls = []
  const output = []
  const runId = 'feishu-sync-old-unknown'
  const continuationRunId = 'feishu-sync-new-continuation'
  const worker = {
    async resolveAndEnqueueReconciledPartial(receivedRunId) {
      calls.push(['resolve', receivedRunId])
      return {
        resolvedRun: {
          runId,
          state: 'reconciled-partial',
          resolutionCode: 'PARTIAL_BASE_WRITES_RECONCILED'
        },
        continuationRun: { runId: continuationRunId, state: 'queued', dryRun: false }
      }
    },
    recover() { calls.push(['recover']) },
    async run() { calls.push(['run']) },
    async runNext() { calls.push(['runNext']) },
    async tick() { calls.push(['tick']) }
  }
  const code = await workerCli.main(
    ['--continue-reconciled-partial', runId],
    {
      createWorker() { return worker },
      writeOutput(value) { output.push(value) }
    }
  )
  assert.strictEqual(code, 0)
  assert.deepStrictEqual(calls, [['resolve', runId]], 'CLI 解阻只能调用 resolver 一次，不得 recover 或执行任务')
  assert.strictEqual(output.length, 1)
  assert.deepStrictEqual(JSON.parse(output[0]), {
    ok: true,
    skipped: false,
    reconciledRunId: runId,
    resolvedState: 'reconciled-partial',
    resolutionCode: 'PARTIAL_BASE_WRITES_RECONCILED',
    runId: continuationRunId,
    state: 'queued',
    dryRun: false
  })

  const originalAutoSyncEnabled = config.feishu.autoSyncEnabled
  const guardedCalls = []
  try {
    config.feishu.autoSyncEnabled = true
    await assert.rejects(
      workerCli.main(
        ['--continue-reconciled-partial', runId],
        {
          createWorker() {
            guardedCalls.push('createWorker')
            return worker
          },
          writeOutput(value) { guardedCalls.push(['output', value]) }
        }
      ),
      (error) => error && error.code === 'WORKER_CONFIGURATION_INVALID',
      '自动同步开启时必须在创建 worker 前拒绝解阻，避免定时器立即拾取 continuation'
    )
    assert.deepStrictEqual(guardedCalls, [], '自动同步开启时解阻入口必须零 worker、零输出、零写入')
  } finally {
    config.feishu.autoSyncEnabled = originalAutoSyncEnabled
  }
}

async function main() {
  testValidatedSnapshotDigestCanBeRebuiltWithoutMixedState()
  testContinuationTokensAndCliAreDeterministicAndNarrow()
  await testConfiguredReconciliationApiIsReadOnlyAndInternal()
  await testCliContinuationOnlyResolvesAndQueues()
  console.log('feishu-sync-partial-reconcile-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
