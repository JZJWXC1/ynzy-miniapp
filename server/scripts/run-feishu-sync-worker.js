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
  if (argv.length === 2 && argv[0] === '--run' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(argv[1])) {
    return { mode: 'run', runId: argv[1] }
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

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.mode === 'schedule' && (!config.feishu.syncEnabled || !config.feishu.autoSyncEnabled)) {
    process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: 'automatic-sync-disabled' })}\n`)
    return 0
  }
  if (args.mode === 'schedule' && !feishuSync.automaticWorkerConfigurationStatus().ready) {
    process.stdout.write(`${JSON.stringify({ ok: false, skipped: true, reason: 'automatic-sync-not-approved' })}\n`)
    return 1
  }

  const worker = createConfiguredWorker()
  worker.recover()

  if (args.mode === 'run') {
    const result = await worker.run(args.runId, { workerId: `manual-cli:${process.pid}` })
    process.stdout.write(`${JSON.stringify(publicResult(result))}\n`)
    return exitCodeFor(result)
  }

  // 先接续已经排队的手工任务，避免 API 进程刚入队便重启时任务永久悬空；本次 tick
  // 只执行一个完整任务，下一次半小时调度再生成新时间桶，杜绝同一进程连续双写。
  const queued = await worker.runNext({ workerId: `scheduled-cli:${process.pid}` })
  if (queued) {
    process.stdout.write(`${JSON.stringify(publicResult(queued, { resumedQueuedRun: true }))}\n`)
    return exitCodeFor(queued)
  }
  const result = await worker.tick({ workerId: `scheduled-cli:${process.pid}` })
  process.stdout.write(`${JSON.stringify(publicResult(result))}\n`)
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
