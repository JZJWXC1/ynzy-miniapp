const config = require('../src/config')
const dbStore = require('../src/db')
const feishuSync = require('../src/feishu-sync')
const {
  STATES,
  createFeishuSyncWorker,
  _internal: workerInternal
} = require('../src/feishu-sync-worker')

function parseArgs(argv = []) {
  if (argv.length === 1 && argv[0] === '--schedule') return { mode: 'schedule' }
  const validRunId = (value) => (
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(String(value || '')) &&
    !/(?:token|secret|password|passwd|bearer|appsecret)/i.test(String(value || ''))
  )
  if (argv.length === 2 && argv[0] === '--run' && validRunId(argv[1])) {
    return { mode: 'run', runId: argv[1] }
  }
  if (argv.length === 2 && argv[0] === '--continue-reconciled-partial' && validRunId(argv[1])) {
    return { mode: 'continue-reconciled-partial', runId: argv[1] }
  }
  const error = new Error('同步 worker 参数无效')
  error.code = 'WORKER_ARGUMENT_INVALID'
  throw error
}

function createConfiguredWorker() {
  return createFeishuSyncWorker({
    dbStore,
    feishuSync,
    commitDeltaChecked: dbStore.commitDeltaChecked,
    writeLockEnabled: dbStore.writeLockEnabled,
    config: {
      approvedSchemaSha256: config.feishu.approvedSchemaSha256,
      approvedResourceIdentitySha256: config.feishu.approvedResourceIdentitySha256,
      intervalMinutes: config.feishu.syncIntervalMinutes,
      leaseMs: Number(config.feishu.syncWorkerLeaseSeconds) * 1000,
      maxRuns: config.feishu.syncRunHistoryLimit,
      systemActorId: 'system:feishu-sync-worker'
    }
  })
}

function publicResult(result, extra = {}) {
  const run = result && result.result ? result.result : result
  return {
    ok: Boolean(run && (run.state === STATES.SUCCEEDED || run.state === STATES.DRY_SUCCEEDED)),
    skipped: false,
    runId: run && run.runId ? run.runId : '',
    state: run && run.state ? run.state : '',
    ...extra
  }
}

function exitCodeFor(result) {
  return result && (result.state === STATES.SUCCEEDED || result.state === STATES.DRY_SUCCEEDED) ? 0 : 1
}

async function main(argv = process.argv.slice(2), runtime = {}) {
  const createWorker = runtime.createWorker || createConfiguredWorker
  const writeOutput = runtime.writeOutput || ((value) => process.stdout.write(value))
  if (typeof createWorker !== 'function' || typeof writeOutput !== 'function') {
    const error = new Error('同步 worker 运行时依赖无效')
    error.code = 'WORKER_CONFIGURATION_INVALID'
    throw error
  }
  const args = parseArgs(argv)
  if (args.mode === 'continue-reconciled-partial' && config.feishu.autoSyncEnabled) {
    const error = new Error('部分写入恢复前必须先关闭自动同步')
    error.code = 'WORKER_CONFIGURATION_INVALID'
    throw error
  }
  if (args.mode === 'schedule' && (!config.feishu.syncEnabled || !config.feishu.autoSyncEnabled)) {
    writeOutput(`${JSON.stringify({ ok: true, skipped: true, reason: 'automatic-sync-disabled' })}\n`)
    return 0
  }
  if (args.mode === 'schedule' && !feishuSync.automaticWorkerConfigurationStatus().ready) {
    writeOutput(`${JSON.stringify({ ok: false, skipped: true, reason: 'automatic-sync-not-approved' })}\n`)
    return 1
  }

  const worker = createWorker()
  if (args.mode === 'continue-reconciled-partial') {
    const resolved = await worker.resolveAndEnqueueReconciledPartial(args.runId)
    writeOutput(`${JSON.stringify({
      ok: true,
      skipped: false,
      reconciledRunId: resolved.resolvedRun.runId,
      resolvedState: resolved.resolvedRun.state,
      runId: resolved.continuationRun.runId,
      state: resolved.continuationRun.state
    })}\n`)
    return 0
  }
  worker.recover()

  if (args.mode === 'run') {
    const result = await worker.run(args.runId, { workerId: `manual-cli:${process.pid}` })
    writeOutput(`${JSON.stringify(publicResult(result))}\n`)
    return exitCodeFor(result)
  }

  // 先接续已经排队的手工任务，避免 API 进程刚入队便重启时任务永久悬空；本次 tick
  // 只执行一个完整任务，下一次计划任务再生成新时间桶，杜绝同一进程连续双写。
  const queued = await worker.runNext({ workerId: `scheduled-cli:${process.pid}` })
  if (queued) {
    writeOutput(`${JSON.stringify(publicResult(queued, { resumedQueuedRun: true }))}\n`)
    return exitCodeFor(queued)
  }
  const result = await worker.tick({ workerId: `scheduled-cli:${process.pid}` })
  writeOutput(`${JSON.stringify(publicResult(result))}\n`)
  return exitCodeFor(result && result.result)
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    const code = workerInternal.safeErrorCode(error, 'WORKER_FAILED')
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  parseArgs,
  createConfiguredWorker,
  main,
  publicResult,
  exitCodeFor
}
