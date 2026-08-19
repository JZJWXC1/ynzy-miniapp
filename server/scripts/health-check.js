'use strict'

// 独立健康巡检：检查「会拖垮生产但 /healthz 未必发现」的信号——db 可解析、磁盘余量、备份新鲜度、
// 服务端点可达。失败打结构化 [health] 日志并**非零退出**（供 systemd/journald 告警）；配了
// HEALTH_ALERT_CMD 时经**白名单环境**把摘要传给外部通知命令——告警子进程拿不到备份加密密钥/飞书
// secret 等敏感凭据（见 buildAlertEnv）。仓库不写凭据/webhook。不改 index.js/readyz。
//
// 用法：node server/scripts/health-check.js
// 环境：PORT(默认3101)、DATA_FILE(db 路径，同服务)、BACKUP_STAGE_DIR/BACKUP_DIR(备份目录)、
//       BACKUP_MAX_AGE_HOURS(默认24)、DISK_MIN_FREE_PCT(默认10)、HEALTH_ALERT_CMD(可选外部通知)。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const {
  _internal: { manualNoopResolutionMatches, markerMatches }
} = require('../src/feishu-sync-worker')

const SERVER_DIR = path.join(__dirname, '..')
const SYNC_SUCCESS_STATE_VERSION = 1
const SYNC_SUCCESS_MAX_SEEN_RUNS = 4096
// 单轮最多发送 20 条、每条命令最长 15 秒；锁租期必须覆盖合法最坏发送时长，避免第二进程误删活锁。
const SYNC_SUCCESS_LOCK_STALE_MS = 10 * 60 * 1000
const SYNC_RESULT_BOOLEAN_KEYS = new Set(['success', 'complete', 'dryRun'])
const SYNC_RESULT_NUMBER_KEYS = new Set([
  'failed', 'created', 'updated', 'down', 'synced', 'cleared', 'retained',
  'rowCount', 'columnCount', 'sourceRecordCount', 'contentPlanAssetCount'
])
const SYNC_RESULT_ALLOWED_KEYS = new Set([...SYNC_RESULT_BOOLEAN_KEYS, ...SYNC_RESULT_NUMBER_KEYS])
const SYNC_RESULT_REQUIRED_KEYS = ['success', 'complete', 'dryRun', 'failed', 'created', 'updated', 'down']

// ---------- 纯函数（可单测，无副作用） ----------

function evaluateDb(raw) {
  try {
    const text = String(raw || '').charCodeAt(0) === 65279 ? String(raw).slice(1) : String(raw || '')
    const db = JSON.parse(text)
    const listings = Array.isArray(db.listings) ? db.listings.length : -1
    const users = Array.isArray(db.users) ? db.users.length : -1
    if (listings < 0) return { ok: false, detail: 'db.json 缺 listings 数组' }
    return { ok: true, listings, users, sizeBytes: Buffer.byteLength(String(raw || '')) }
  } catch (error) {
    return { ok: false, detail: 'db.json 不可解析：' + (error && error.message) }
  }
}

// 解析 `df -Pk <path>` 输出，可用百分比低于 minFreePct 判失败。
function parseDfFreePct(dfOutput, minFreePct) {
  const min = Number.isFinite(minFreePct) ? minFreePct : 10
  const lines = String(dfOutput || '').trim().split('\n')
  if (lines.length < 2) return { ok: false, detail: 'df 输出异常' }
  const cols = lines[lines.length - 1].trim().split(/\s+/)
  // POSIX `df -Pk`: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const total = Number(cols[1])
  const avail = Number(cols[3])
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(avail)) return { ok: false, detail: 'df 解析失败' }
  const freePct = Math.round((avail / total) * 100)
  return { ok: freePct >= min, freePct, availKb: avail, minFreePct: min }
}

function aggregate(checks) {
  const list = Array.isArray(checks) ? checks : []
  const failures = list.filter((item) => item && item.ok === false).map((item) => item.name)
  return { ok: failures.length === 0, checks: list, failures }
}

function safeSyncContext(run) {
  if (!run || typeof run !== 'object') return {}
  const rawId = String(run.runId || run.id || '')
  const errorCode = String(run.errorCode || '').toUpperCase()
  return {
    ...(rawId ? { traceId: `SYNC-${crypto.createHash('sha256').update(rawId).digest('hex').slice(0, 12).toUpperCase()}` } : {}),
    ...(/^[A-Z][A-Z0-9_-]{2,63}$/.test(errorCode) ? { errorCode } : {})
  }
}

function healthProcessExitCode(healthResult, syncNotificationResult) {
  const notificationStatus = String(syncNotificationResult && syncNotificationResult.status || '')
  const notificationFailed = ['send-failed', 'dispatch-unknown', 'state-error'].includes(notificationStatus)
  return healthResult && healthResult.ok === true && !notificationFailed ? 0 : 1
}

function trustedTerminalResultSummary(run) {
  const summary = run && run.resultSummary
  const applied = run && run.applyResultSummary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary) ||
      !applied || typeof applied !== 'object' || Array.isArray(applied)) return null
  const summaryKeys = Object.keys(summary).sort()
  const appliedKeys = Object.keys(applied).sort()
  if (summaryKeys.length !== appliedKeys.length ||
      !summaryKeys.every((key, index) => key === appliedKeys[index]) ||
      !summaryKeys.every((key) => SYNC_RESULT_ALLOWED_KEYS.has(key)) ||
      !SYNC_RESULT_REQUIRED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(summary, key))) return null
  for (const key of summaryKeys) {
    const value = summary[key]
    if (SYNC_RESULT_BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') return null
    } else if (!Number.isSafeInteger(value) || value < 0) {
      return null
    }
    if (applied[key] !== value) return null
  }
  if (summary.success !== true || summary.complete !== true || summary.dryRun !== false || summary.failed !== 0) return null
  return summary
}

function selectFeishuSyncSuccesses(db) {
  const runs = Array.isArray(db && db.feishuSyncRuns) ? db.feishuSyncRuns : []
  const markers = db && db.feishuSyncCommitMarkers
  if (!markers || typeof markers !== 'object' || Array.isArray(markers)) return []
  const candidates = runs.map((run, ledgerIndex) => {
    if (!(run && run.version === 3 && run.state === 'succeeded' && run.dryRun === false &&
        ['manual', 'scheduled'].includes(run.trigger) && run.errorCode === '')) return null
    const marker = typeof run.runId === 'string' && Object.prototype.hasOwnProperty.call(markers, run.runId)
      ? markers[run.runId]
      : null
    if (typeof run.runId !== 'string' || !run.runId || run.runId.length > 256 ||
        !Number.isSafeInteger(run.finishedAt) || run.finishedAt <= 0 ||
        run.updatedAt !== run.finishedAt || run.lease !== null ||
        !marker || marker.committedAt !== run.finishedAt ||
        !markerMatches(run, marker)) return null
    const summary = trustedTerminalResultSummary(run)
    if (!summary) return null
    const context = safeSyncContext(run)
    if (!context.traceId) return null
    return {
      ledgerIndex,
      runKey: crypto.createHash('sha256').update(`feishu-sync-success-v1|${run.runId}`).digest('hex'),
      traceId: context.traceId,
      trigger: run.trigger,
      finishedAt: run.finishedAt,
      counts: {
        created: summary.created,
        updated: summary.updated,
        down: summary.down
      }
    }
  }).filter(Boolean)
  // worker 以 unshift 持久化任务：数组 index 越大越旧。通知按账本旧→新，而不是按可能回拨的墙钟排序。
  candidates.sort((left, right) => right.ledgerIndex - left.ledgerIndex)
  return candidates.map(({ ledgerIndex: _ledgerIndex, ...event }) => event)
}

function selectLatestFeishuSyncSuccess(db) {
  const candidates = selectFeishuSyncSuccesses(db)
  return candidates.length ? candidates[candidates.length - 1] : null
}

function writeSyncSuccessState(file, state, options = {}) {
  const io = options.fsOps || fs
  const platform = options.platform || process.platform
  io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let fileFd = null
  try {
    fileFd = io.openSync(temp, 'wx', 0o600)
    io.writeFileSync(fileFd, JSON.stringify(state), 'utf8')
    io.fsyncSync(fileFd)
    io.closeSync(fileFd)
    fileFd = null
    io.renameSync(temp, file)
    // Linux 生产环境必须同步父目录，确保断电后 rename 目录项不会回退到旧游标。
    // Windows 不允许对目录句柄 fsync；本地测试通过可注入 fsOps + platform='linux' 锁定生产顺序。
    if (platform !== 'win32') {
      const dirFd = io.openSync(path.dirname(file), 'r')
      try { io.fsyncSync(dirFd) } finally { io.closeSync(dirFd) }
    }
  } finally {
    if (fileFd != null) {
      try { io.closeSync(fileFd) } catch (_error) {}
    }
    try { io.unlinkSync(temp) } catch (_error) {}
  }
}

function readSyncSuccessState(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const state = JSON.parse(raw)
  const validKeys = Array.isArray(state && state.seenRunKeys) && state.seenRunKeys.every((key) => /^[a-f0-9]{64}$/.test(String(key || '')))
  const dispatching = state && state.dispatching
  const validDispatching = dispatching === null || (
    dispatching && typeof dispatching === 'object' && !Array.isArray(dispatching) &&
    /^[a-f0-9]{64}$/.test(String(dispatching.runKey || '')) &&
    Number.isSafeInteger(dispatching.finishedAt) && dispatching.finishedAt > 0
  )
  if (!state || state.version !== SYNC_SUCCESS_STATE_VERSION ||
      !Number.isSafeInteger(state.initializedAt) || state.initializedAt <= 0 ||
      !Number.isSafeInteger(state.watermarkFinishedAt) || state.watermarkFinishedAt < 0 ||
      !validKeys || state.seenRunKeys.length > SYNC_SUCCESS_MAX_SEEN_RUNS || !validDispatching) {
    const error = new Error('正式同步成功通知状态无效')
    error.code = 'SYNC_SUCCESS_STATE_INVALID'
    throw error
  }
  return state
}

function markSyncSuccessHandled(state, runKey, finishedAt) {
  const seen = [...new Set([...(state.seenRunKeys || []), runKey])]
  if (seen.length > SYNC_SUCCESS_MAX_SEEN_RUNS) {
    const error = new Error('正式同步成功通知身份容量已满')
    error.code = 'SYNC_SUCCESS_STATE_CAPACITY'
    throw error
  }
  return {
    ...state,
    watermarkFinishedAt: Math.max(Number(state.watermarkFinishedAt || 0), finishedAt),
    seenRunKeys: seen,
    dispatching: null
  }
}

function acquireSyncSuccessLock(stateFile, options = {}) {
  const io = options.fsOps || fs
  const now = typeof options.now === 'function' ? options.now : Date.now
  const lockFile = `${stateFile}.lock`
  io.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = `${process.pid}:${now()}:${crypto.randomBytes(12).toString('hex')}`
      const fd = io.openSync(lockFile, 'wx', 0o600)
      io.writeFileSync(fd, token, 'utf8')
      io.closeSync(fd)
      return () => {
        try {
          // 只释放仍属于自己的 token；A 过期后 B 接管时，A 的 finally 不得误删 B 的新锁。
          if (io.readFileSync(lockFile, 'utf8') === token) io.unlinkSync(lockFile)
        } catch (_error) {}
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      let observedToken = ''
      try {
        observedToken = io.readFileSync(lockFile, 'utf8')
        stale = now() - io.statSync(lockFile).mtimeMs >= SYNC_SUCCESS_LOCK_STALE_MS
      } catch (_error) {}
      if (!stale) return null
      try {
        // stat/read 后锁可能已被另一进程接管；删除前必须再核对 owner token，避免删掉新锁。
        if (io.readFileSync(lockFile, 'utf8') !== observedToken) return null
        io.unlinkSync(lockFile)
      } catch (_error) { return null }
    }
  }
  return null
}

function buildSyncSuccessBaselineState(events, nowMs) {
  if (events.length > SYNC_SUCCESS_MAX_SEEN_RUNS) {
    const error = new Error('正式同步成功通知基线超过安全容量')
    error.code = 'SYNC_SUCCESS_STATE_CAPACITY'
    throw error
  }
  const latestFinishedAt = events.length ? events[events.length - 1].finishedAt : 0
  return {
    version: SYNC_SUCCESS_STATE_VERSION,
    initializedAt: nowMs,
    // 水位只代表本次 DB 快照里确实见过的最新成功。不能使用墙钟 nowMs，否则“读 DB 后、写游标前”刚完成且
    // finishedAt <= nowMs 的新任务会被永远越过；initializedAt 仅记录基线建立时间，不参与候选过滤。
    watermarkFinishedAt: latestFinishedAt,
    seenRunKeys: events.map((event) => event.runKey),
    dispatching: null
  }
}

function initializeFeishuSyncSuccessBaseline(db, options = {}) {
  const stateFile = options.stateFile || resolveSyncSuccessStatePath()
  const nowMs = Number.isSafeInteger(options.nowMs) && options.nowMs > 0 ? options.nowMs : Date.now()
  let releaseLock
  try {
    releaseLock = acquireSyncSuccessLock(stateFile)
    if (!releaseLock) return { status: 'busy' }
    const existing = readSyncSuccessState(stateFile)
    if (existing) return { status: 'already-initialized' }
    const events = selectFeishuSyncSuccesses(db)
    writeSyncSuccessState(stateFile, buildSyncSuccessBaselineState(events, nowMs))
    return { status: 'baselined', baselineCount: events.length }
  } catch (error) {
    const errorCode = /^[A-Z][A-Z0-9_-]{1,63}$/.test(String(error && error.code || '').toUpperCase())
      ? String(error.code).toUpperCase()
      : 'UNKNOWN'
    return { status: 'state-error', errorCode }
  } finally {
    if (releaseLock) releaseLock()
  }
}

function processFeishuSyncSuccessNotification(db, options = {}) {
  const stateFile = options.stateFile || resolveSyncSuccessStatePath()
  const nowMs = Number.isSafeInteger(options.nowMs) && options.nowMs > 0 ? options.nowMs : Date.now()
  let releaseLock
  try {
    releaseLock = acquireSyncSuccessLock(stateFile)
    if (!releaseLock) return { status: 'busy' }
    let state = readSyncSuccessState(stateFile)
    const events = selectFeishuSyncSuccesses(db)
    if (!state) {
      state = buildSyncSuccessBaselineState(events, nowMs)
      writeSyncSuccessState(stateFile, state)
      return { status: 'baselined' }
    }
    // dispatching 在真正执行机器人命令前落盘，进程可能在两者之间退出，因此重启时必须清回 pending 重试。
    // 若上次其实已经送达，send-feishu-alert 的持久 ALERT_DEDUPE_KEY 会返回去重成功，再由本游标推进。
    if (state.dispatching) {
      state = { ...state, dispatching: null }
      writeSyncSuccessState(stateFile, state)
    }
    const allKnownRunKeys = new Set([...state.seenRunKeys, ...events.map((event) => event.runKey)])
    if (allKnownRunKeys.size > SYNC_SUCCESS_MAX_SEEN_RUNS) {
      const error = new Error('正式同步成功通知身份容量已满')
      error.code = 'SYNC_SUCCESS_STATE_CAPACITY'
      throw error
    }
    // runKey 是一次通知身份的唯一依据；finishedAt 只用于展示和诊断。若服务器时钟回拨，新成功时间可能
    // 小于历史水位，但只要身份未见就仍必须通知。
    const pending = events.filter((event) => !state.seenRunKeys.includes(event.runKey))
    if (!pending.length) {
      return { status: 'no-new-success' }
    }
    if (typeof options.send !== 'function') return { status: 'command-unconfigured' }
    const maxPerRun = Number.isSafeInteger(options.maxPerRun) && options.maxPerRun > 0
      ? Math.min(options.maxPerRun, 20)
      : 4
    let notifiedCount = 0
    for (const event of pending.slice(0, maxPerRun)) {
      state = { ...state, dispatching: { runKey: event.runKey, finishedAt: event.finishedAt } }
      writeSyncSuccessState(stateFile, state)
      try {
        options.send(event)
      } catch (error) {
        state = { ...state, dispatching: null }
        try { writeSyncSuccessState(stateFile, state) } catch (_stateError) {
          return { status: 'dispatch-unknown', errorCode: 'STATE_WRITE_FAILED', notifiedCount }
        }
        const errorCode = /^[A-Z][A-Z0-9_-]{1,63}$/.test(String(error && error.code || '').toUpperCase())
          ? String(error.code).toUpperCase()
          : 'UNKNOWN'
        return { status: 'send-failed', errorCode, notifiedCount }
      }
      try {
        state = markSyncSuccessHandled(state, event.runKey, event.finishedAt)
        writeSyncSuccessState(stateFile, state)
      } catch (_error) {
        return { status: 'dispatch-unknown', errorCode: 'STATE_WRITE_FAILED', notifiedCount }
      }
      notifiedCount += 1
    }
    return { status: 'notified', notifiedCount, remaining: Math.max(0, pending.length - notifiedCount) }
  } catch (error) {
    const errorCode = /^[A-Z][A-Z0-9_-]{1,63}$/.test(String(error && error.code || '').toUpperCase())
      ? String(error.code).toUpperCase()
      : 'UNKNOWN'
    return { status: 'state-error', errorCode }
  } finally {
    if (releaseLock) releaseLock()
  }
}

function updateHealthIncident(result, options = {}) {
  const file = options.file || resolveHealthIncidentFile()
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  if (!result || result.ok) {
    try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return ''
  }
  const signature = crypto.createHash('sha256')
    .update([...new Set(result.failures || [])].sort().join(','))
    .digest('hex')
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current && current.signature === signature && /^INC-[A-F0-9]{16}$/.test(String(current.incidentId || ''))) {
      return current.incidentId
    }
  } catch (_error) {}
  const incidentId = `INC-${crypto.createHash('sha256').update(`${signature}|${nowMs}|${crypto.randomBytes(16).toString('hex')}`).digest('hex').slice(0, 16).toUpperCase()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ signature, incidentId }), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temp, file)
  return incidentId
}

function evaluateFeishuSyncState(db, options = {}) {
  const autoSyncEnabled = options.autoSyncEnabled === true
  const runs = Array.isArray(db && db.feishuSyncRuns) ? db.feishuSyncRuns : []
  const scheduler = db && db.feishuSyncScheduler && typeof db.feishuSyncScheduler === 'object'
    ? db.feishuSyncScheduler
    : {}
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  const maxAgeMinutes = Number.isFinite(Number(options.maxAgeMinutes)) && Number(options.maxAgeMinutes) > 0
    ? Number(options.maxAgeMinutes)
    : 18 * 60
  const latestRun = runs[0]
  const ordinaryFormal = (run) => Boolean(
    run && run.version === 3 && run.dryRun === false && ['manual', 'scheduled'].includes(run.trigger)
  )
  // queued/running 只是进行中，不能清除更早的终态事故；健康只由更新的可信干净成功恢复。
  const latestOrdinaryTerminal = runs.find((run) => (
    ordinaryFormal(run) && ['failed-before-write', 'succeeded'].includes(run.state)
  ))
  const trustedSuccesses = selectFeishuSyncSuccesses(db)
  const trustedSuccessByKey = new Map(trustedSuccesses.map((event) => [event.runKey, event]))
  const lastSuccess = runs.map((run) => {
    if (!run || typeof run.runId !== 'string') return null
    const runKey = crypto.createHash('sha256').update(`feishu-sync-success-v1|${run.runId}`).digest('hex')
    return trustedSuccessByKey.get(runKey) || null
  }).find(Boolean) || null
  const lastSuccessAgeMinutes = lastSuccess && Number.isFinite(Number(lastSuccess.finishedAt))
    ? Math.floor(Math.max(0, nowMs - Number(lastSuccess.finishedAt)) / 60000)
    : null
  const terminalStates = new Set([
    'dry-succeeded',
    'succeeded',
    'failed-before-write',
    'unknown',
    'blocked',
    'reconciled-partial'
  ])
  const validLease = (lease) => Boolean(lease) && typeof lease === 'object' && !Array.isArray(lease) &&
    typeof lease.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(lease.runId) &&
    typeof lease.owner === 'string' && lease.owner.length > 0 && lease.owner.length <= 128 &&
    Number.isSafeInteger(lease.fence) && lease.fence > 0 &&
    Number.isFinite(lease.acquiredAt) && lease.acquiredAt >= 0 &&
    Number.isFinite(lease.expiresAt) && lease.expiresAt > lease.acquiredAt
  const manualNoopResolved = (run) => {
    try {
      return manualNoopResolutionMatches(db, run)
    } catch (error) {
      return false
    }
  }
  const unresolved = runs.filter((run) => (
    run && ['unknown', 'blocked'].includes(String(run.state || '')) &&
    !Number(run.resolvedAt || 0) && !manualNoopResolved(run)
  )).sort((left, right) => Number(right.updatedAt || right.finishedAt || right.createdAt || 0) - Number(left.updatedAt || left.finishedAt || left.createdAt || 0))
  // 关闭自动同步通常正是 UNKNOWN/BLOCKED 的处置动作之一；不能因为关闭开关就把事故假报为健康。
  if (unresolved.length) {
    return {
      ok: false,
      detail: '同步存在未处置的未知或阻断任务',
      unresolvedCount: unresolved.length,
      lastState: String(unresolved[0] && unresolved[0].state || ''),
      ...safeSyncContext(unresolved[0])
    }
  }
  if (String(scheduler.leaseIntegrityBlockedRunId || '').trim()) {
    return { ok: false, detail: '同步控制器租约完整性异常', ...safeSyncContext({ runId: scheduler.leaseIntegrityBlockedRunId }) }
  }
  const activeLease = scheduler.activeLease
  const activeRun = activeLease && runs.find((run) => run && run.runId === activeLease.runId)
  const activeRunLease = activeRun && activeRun.lease
  const activeLeaseConsistent = !activeLease || Boolean(
    validLease(activeLease) && activeRun && String(activeRun.state || '') !== 'queued' &&
    !terminalStates.has(String(activeRun.state || '')) &&
    validLease(activeRunLease) &&
    String(activeRunLease.runId || '') === String(activeRun.runId || '') &&
    String(activeLease.runId || '') === String(activeRun.runId || '') &&
    String(activeRunLease.owner || '') === String(activeLease.owner || '') &&
    Number(activeRunLease.fence) === Number(activeLease.fence) &&
    Number(activeRunLease.acquiredAt) === Number(activeLease.acquiredAt) &&
    Number(activeRunLease.expiresAt) === Number(activeLease.expiresAt) &&
    Number(activeLease.expiresAt) > nowMs
  )
  const orphanedRunLease = runs.some((run) => (
    run && String(run.state || '') !== 'queued' &&
    !terminalStates.has(String(run.state || '')) &&
    (!validLease(run.lease) || String(run.lease.runId || '') !== String(run.runId || '') ||
      Number(run.lease.expiresAt) <= nowMs || !activeLease || run.runId !== activeLease.runId ||
      String(run.lease.owner || '') !== String(activeLease.owner || '') ||
      Number(run.lease.fence) !== Number(activeLease.fence) ||
      Number(run.lease.acquiredAt) !== Number(activeLease.acquiredAt) ||
      Number(run.lease.expiresAt) !== Number(activeLease.expiresAt))
  ))
  if (!activeLeaseConsistent || orphanedRunLease) {
    return { ok: false, detail: '同步控制器活动租约不一致' }
  }
  // 普通 V3 正式任务的终态事故独立于自动开关与“上次成功是否仍新鲜”。否则关闭定时器或旧成功仍在
  // 健康窗口内时，会把最新一次明确失败误报成健康。后续新的干净 V3 成功自然越过该事故。
  if (latestOrdinaryTerminal && latestOrdinaryTerminal.state === 'failed-before-write') {
    return {
      ok: false,
      detail: '同步前检查没有通过，本次没有更新小程序房源',
      lastState: 'failed-before-write',
      lastSuccessAgeMinutes,
      maxAgeMinutes,
      ...safeSyncContext(latestOrdinaryTerminal)
    }
  }
  if (latestOrdinaryTerminal && latestOrdinaryTerminal.state === 'succeeded' && latestOrdinaryTerminal.errorCode === 'MATERIALS_PARTIAL_FAILURE') {
    return {
      ok: false,
      degraded: true,
      detail: '最近一次正式同步的素材处理没有完整完成',
      lastState: 'succeeded',
      lastSuccessAgeMinutes,
      maxAgeMinutes,
      ...safeSyncContext(latestOrdinaryTerminal)
    }
  }
  const latestOrdinaryTrusted = latestOrdinaryTerminal && selectFeishuSyncSuccesses({
    ...db,
    feishuSyncRuns: [latestOrdinaryTerminal]
  }).length === 1
  if (latestOrdinaryTerminal && latestOrdinaryTerminal.state === 'succeeded' && !latestOrdinaryTrusted) {
    return {
      ok: false,
      detail: '最近一次正式同步的完成记录未通过完整性校验',
      lastState: 'succeeded',
      lastSuccessAgeMinutes,
      maxAgeMinutes,
      ...safeSyncContext(latestOrdinaryTerminal)
    }
  }
  if (!autoSyncEnabled) return { ok: true, skipped: '自动同步未启用' }
  if (options.controllerMode !== 'worker-v2') {
    return { ok: false, detail: '自动同步未绑定 worker-v2 控制器' }
  }
  if (options.schemaApproved !== true || options.resourceApproved !== true) {
    return { ok: false, detail: '自动同步尚未同时批准字段契约与飞书资源身份' }
  }
  if (options.writeLockEnabled !== true) {
    return { ok: false, detail: '自动同步要求数据库跨进程写锁保持开启' }
  }

  if (!lastSuccess || !Number.isFinite(Number(lastSuccess.finishedAt))) {
    return {
      ok: false,
      detail: '自动同步尚无受信成功记录',
      lastState: String(latestRun && latestRun.state || ''),
      ...safeSyncContext(latestRun)
    }
  }
  const ageMs = Math.max(0, nowMs - Number(lastSuccess.finishedAt))
  const maxAgeMs = maxAgeMinutes * 60 * 1000
  return {
    ok: ageMs <= maxAgeMs,
    ...(ageMs <= maxAgeMs ? {} : { detail: '自动同步成功记录已超过健康窗口' }),
    lastState: String(latestRun && latestRun.state || ''),
    lastSuccessAgeMinutes: Math.floor(ageMs / 60000),
    maxAgeMinutes,
    ...(ageMs <= maxAgeMs ? {} : safeSyncContext(latestRun || lastSuccess))
  }
}

function resolveDbPath() {
  const env = process.env.DATA_FILE || ''
  if (env && path.isAbsolute(env)) return env
  return path.join(SERVER_DIR, env || 'data/db.json')
}

function resolveHealthIncidentFile() {
  const configured = String(process.env.HEALTH_ALERT_INCIDENT_FILE || '').trim()
  if (configured) return configured
  return path.join(path.dirname(resolveDbPath()), '.health-alert-incident.json')
}

// 告警子进程只允许拿到「运行命令必需的系统变量」，绝不透传备份/飞书等敏感凭据。
// systemd service 会 EnvironmentFile 加载 /etc/default/ynzy-backup（含 BACKUP_ENCRYPTION_KEY、
// FEISHU_BACKUP_APP_SECRET 等），若把整个 process.env 交给 HEALTH_ALERT_CMD，任意告警命令都能读到
// 这些凭据——白名单式（默认拒绝）从根上堵死这条泄漏路径。
const ALERT_ENV_SYSTEM_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME',
  // Windows 上命令解释器所需（cmd/powershell）
  'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP'
]

// 构造告警命令的环境：系统必需变量 + 运维显式命名的 HEALTH_ALERT_* 专用配置（如 webhook）+ 本次摘要。
// 任何 BACKUP_*/FEISHU_*/TOKEN/SECRET/PASSWORD/.env 变量都不进白名单，因此拿不到。extras 覆盖同名键。
function buildAlertEnv(sourceEnv, extras) {
  const src = sourceEnv && typeof sourceEnv === 'object' ? sourceEnv : {}
  const out = {}
  for (const key of ALERT_ENV_SYSTEM_KEYS) {
    if (src[key] != null) out[key] = src[key]
  }
  // 专用告警配置：webhook URL 等由运维显式命名为 HEALTH_ALERT_*，与备份凭据物理隔离。
  for (const key of Object.keys(src)) {
    if (key.startsWith('HEALTH_ALERT_')) out[key] = src[key]
  }
  const add = extras && typeof extras === 'object' ? extras : {}
  for (const key of Object.keys(add)) out[key] = add[key]
  return out
}

// ---------- CLI 各项检查（含 IO 副作用，不进单测） ----------

function checkDb() {
  try {
    return { name: 'db', ...evaluateDb(fs.readFileSync(resolveDbPath(), 'utf8')) }
  } catch (error) {
    return { name: 'db', ok: false, detail: 'db.json 读取失败：' + (error && error.code) }
  }
}

function checkDisk() {
  try {
    const out = execSync('df -Pk "' + SERVER_DIR + '"', { encoding: 'utf8' })
    return { name: 'disk', ...parseDfFreePct(out, Number(process.env.DISK_MIN_FREE_PCT || 10)) }
  } catch (error) {
    return { name: 'disk', ok: true, skipped: 'df 不可用（' + (error && error.code) + '）' } // 无 df 则跳过、不误报
  }
}

function checkBackup() {
  const dir = process.env.BACKUP_STAGE_DIR || process.env.BACKUP_DIR
  if (!dir) return { name: 'backup', ok: true, skipped: '未配置备份目录' } // 未配置才跳过、不误报
  // 一旦配置了备份目录，任何 require/检查异常都 fail-loud——备份坏了却报健康是最危险的假阳性。
  try {
    const backup = require('../src/backup')
    if (typeof backup.checkFreshness !== 'function') {
      return { name: 'backup', ok: false, detail: 'backup.checkFreshness 不可用（已配置备份目录，按失败处理）' }
    }
    const fresh = backup.checkFreshness({ dir, maxAgeHours: Number(process.env.BACKUP_MAX_AGE_HOURS || 24) })
    return { name: 'backup', ok: fresh.ok !== false, latest: fresh.latest, ageHours: fresh.ageMs != null ? Math.round(fresh.ageMs / 3600000) : null, reason: fresh.reason }
  } catch (error) {
    return { name: 'backup', ok: false, detail: 'backup 检查异常（已配置备份目录）：' + (error && error.message) }
  }
}

function checkService() {
  const port = process.env.PORT || 3101
  try {
    const code = execSync('curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:' + port + '/healthz"', { encoding: 'utf8' }).trim()
    return { name: 'service', ok: code === '200', httpCode: code, port: Number(port) }
  } catch (error) {
    return { name: 'service', ok: false, detail: 'healthz 不可达', port: Number(port) }
  }
}

function checkFeishuSync() {
  try {
    const config = require('../src/config')
    const dbStore = require('../src/db')
    const raw = fs.readFileSync(resolveDbPath(), 'utf8')
    const text = String(raw || '').charCodeAt(0) === 65279 ? String(raw).slice(1) : String(raw || '')
    const db = JSON.parse(text)
    return {
      name: 'feishuSync',
      ...evaluateFeishuSyncState(db, {
        autoSyncEnabled: config.feishu.autoSyncEnabled,
        controllerMode: config.feishu.syncControllerMode,
        schemaApproved: /^[a-f0-9]{64}$/.test(String(config.feishu.approvedSchemaSha256 || '')),
        resourceApproved: /^[a-f0-9]{64}$/.test(String(config.feishu.approvedResourceIdentitySha256 || '')),
        writeLockEnabled: dbStore.writeLockEnabled(),
        maxAgeMinutes: config.feishu.syncHealthMaxAgeMinutes
      })
    }
  } catch (error) {
    return { name: 'feishuSync', ok: false, detail: '自动同步状态读取失败' }
  }
}

function resolveSyncSuccessStatePath() {
  // 与业务数据库同属部署保留的数据目录，但使用独立文件，不进入 db.json 或数据库 schema。
  // 该目录跨服务和系统重启保留，避免 /tmp 清空后重复补发旧成功。
  return path.join(path.dirname(resolveDbPath()), '.feishu-sync-success-notification.json')
}

function notifyFeishuSyncSuccessIfNeeded() {
  let db
  try {
    const raw = fs.readFileSync(resolveDbPath(), 'utf8')
    const text = String(raw || '').charCodeAt(0) === 65279 ? String(raw).slice(1) : String(raw || '')
    db = JSON.parse(text)
  } catch (error) {
    return { status: 'state-error', errorCode: 'DB_READ_FAILED' }
  }
  const cmd = String(process.env.HEALTH_ALERT_CMD || '').trim()
  const result = processFeishuSyncSuccessNotification(db, {
    stateFile: resolveSyncSuccessStatePath(),
    send: cmd
      ? (event) => {
          execSync(cmd, {
            env: buildAlertEnv(process.env, {
              ALERT_KIND: 'FEISHU_SYNC_SUCCEEDED',
              ALERT_DETAIL: JSON.stringify({
                traceId: event.traceId,
                trigger: event.trigger,
                finishedAt: event.finishedAt,
                created: event.counts.created,
                updated: event.counts.updated,
                down: event.counts.down
              }),
              ALERT_DEDUPE_KEY: `SYNC-SUCCESS-${event.runKey}`
            }),
            stdio: 'ignore',
            timeout: 15000
          })
        }
      : null
  })
  if (result.status === 'notified') {
    process.stdout.write('[health] 飞书正式同步成功通知已发送\n')
  } else if (result.status === 'send-failed') {
    process.stderr.write(`[health] 飞书正式同步成功通知发送失败，机器码=${result.errorCode}\n`)
  } else if (['dispatch-unknown', 'state-error'].includes(result.status)) {
    process.stderr.write(`[health] 飞书正式同步成功通知状态异常，机器码=${result.errorCode}\n`)
  }
  return result
}

function initializeFeishuSyncSuccessBaselineFromDisk() {
  let db
  try {
    const raw = fs.readFileSync(resolveDbPath(), 'utf8')
    const text = String(raw || '').charCodeAt(0) === 65279 ? String(raw).slice(1) : String(raw || '')
    db = JSON.parse(text)
  } catch (_error) {
    return { status: 'state-error', errorCode: 'DB_READ_FAILED' }
  }
  return initializeFeishuSyncSuccessBaseline(db, { stateFile: resolveSyncSuccessStatePath() })
}

function alertIfNeeded(result) {
  let incidentId = ''
  try { incidentId = updateHealthIncident(result) } catch (error) {
    process.stderr.write('[health] 告警事故状态更新失败：' + (error && error.code || 'UNKNOWN') + '\n')
  }
  if (result.ok) return
  process.stderr.write('[health][ALERT] 巡检失败：' + result.failures.join(',') + '\n')
  const cmd = process.env.HEALTH_ALERT_CMD
  if (!cmd || !cmd.trim()) return
  try {
    // 摘要经环境变量传入，避免拼接注入。env 走白名单：告警命令拿不到备份/飞书等凭据。
    execSync(cmd, {
      env: buildAlertEnv(process.env, {
        HEALTH_FAILURES: result.failures.join(','),
        HEALTH_SUMMARY: JSON.stringify(result),
        HEALTH_INCIDENT_ID: incidentId
      }),
      stdio: 'ignore',
      timeout: 15000
    })
  } catch (error) {
    const safeCode = error && /^[A-Z][A-Z0-9_-]{1,63}$/.test(String(error.code || '').toUpperCase())
      ? String(error.code).toUpperCase()
      : 'UNKNOWN'
    process.stderr.write('[health] 告警命令执行失败，机器码=' + safeCode + '\n')
  }
}

if (require.main === module) {
  const cliArgs = process.argv.slice(2)
  if (cliArgs.length === 1 && cliArgs[0] === '--init-sync-notify-baseline') {
    // 部署初始化入口只读业务数据库、只写独立游标；绝不进入机器人告警命令，也不改写同步任务或业务数据。
    const initialized = initializeFeishuSyncSuccessBaselineFromDisk()
    if (['baselined', 'already-initialized'].includes(initialized.status)) {
      process.stdout.write(`[health] 飞书同步成功通知基线${initialized.status === 'baselined' ? '已建立' : '已存在'}\n`)
      process.exit(0)
    }
    process.stderr.write(`[health] 飞书同步成功通知基线初始化失败，机器码=${initialized.errorCode || initialized.status}\n`)
    process.exit(1)
  } else if (cliArgs.length > 0) {
    process.stderr.write('[health] 参数无效；基线初始化只接受单一参数 --init-sync-notify-baseline\n')
    process.exit(1)
  } else {
    const result = aggregate([checkDb(), checkDisk(), checkBackup(), checkService(), checkFeishuSync()])
    process.stdout.write('[health] ' + JSON.stringify(result) + '\n')
    // 成功通知只读扫描任务账本，独立于 auto 开关和健康判定；通知失败不反向改写同步终态。
    const syncNotificationResult = notifyFeishuSyncSuccessIfNeeded()
    alertIfNeeded(result)
    // 成功通知发送或游标落盘异常必须让 systemd 看见非零退出；不把该异常再递归交给机器人告警链。
    process.exit(healthProcessExitCode(result, syncNotificationResult))
  }
}

module.exports = {
  evaluateDb,
  parseDfFreePct,
  aggregate,
  healthProcessExitCode,
  safeSyncContext,
  selectFeishuSyncSuccesses,
  selectLatestFeishuSyncSuccess,
  buildSyncSuccessBaselineState,
  initializeFeishuSyncSuccessBaseline,
  initializeFeishuSyncSuccessBaselineFromDisk,
  processFeishuSyncSuccessNotification,
  writeSyncSuccessState,
  acquireSyncSuccessLock,
  updateHealthIncident,
  evaluateFeishuSyncState,
  resolveDbPath,
  resolveHealthIncidentFile,
  resolveSyncSuccessStatePath,
  buildAlertEnv,
  notifyFeishuSyncSuccessIfNeeded
}
