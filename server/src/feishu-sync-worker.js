const crypto = require('crypto')

const STATES = Object.freeze({
  QUEUED: 'queued',
  DRY_RUNNING: 'dry-running',
  READY_TO_APPLY: 'ready-to-apply',
  APPLYING: 'applying',
  COMMITTING: 'committing',
  DRY_SUCCEEDED: 'dry-succeeded',
  SUCCEEDED: 'succeeded',
  FAILED_BEFORE_WRITE: 'failed-before-write',
  UNKNOWN: 'unknown',
  RECONCILED_PARTIAL: 'reconciled-partial',
  BLOCKED: 'blocked'
})

const TERMINAL_STATES = new Set([
  STATES.DRY_SUCCEEDED,
  STATES.SUCCEEDED,
  STATES.FAILED_BEFORE_WRITE,
  STATES.UNKNOWN,
  STATES.RECONCILED_PARTIAL,
  STATES.BLOCKED
])

const RECOVERABLE_DRY_STATES = new Set([
  STATES.QUEUED,
  STATES.DRY_RUNNING,
  STATES.READY_TO_APPLY
])

const MAX_RECONCILIATION_LINEAGE_DEPTH = 32

const CONTROL_KEYS = Object.freeze([
  'feishuSyncRuns',
  'feishuSyncScheduler',
  'feishuSyncCommitMarkers'
])

const DEFAULT_SAFE_BEFORE_WRITE_CODES = new Set([
  'CONTENT_PLAN_CONFIRMATION_FAILED',
  'SOURCE_READ_FAILED',
  'SOURCE_SCHEMA_INVALID',
  'SCHEMA_DIGEST_MISMATCH',
  'SCHEMA_DIGEST_MISSING',
  'DRY_RUN_FAILED',
  'DRY_RUN_NOT_COMPLETE',
  'WORKER_NOTE_MATERIAL_MODE_REQUIRED',
  'LEASE_LOST'
])

const APPROVAL_BLOCK_CODES = new Set([
  'SCHEMA_APPROVAL_MISSING',
  'SCHEMA_DIGEST_MISMATCH',
  'RESOURCE_IDENTITY_APPROVAL_MISSING',
  'RESOURCE_IDENTITY_MISMATCH'
])

const KNOWN_MATERIAL_FAILURE_ROW_STATES = new Set([
  'listing-missing',
  'media-limit-exceeded',
  'unsupported-non-video',
  'retained-temporary-failure',
  'failed'
])

const KNOWN_DRY_MATERIAL_SUCCESS_ROW_STATES = new Set([
  'planned',
  'cleared'
])

const KNOWN_APPLY_MATERIAL_SUCCESS_ROW_STATES = new Set([
  'verified',
  'cleared'
])

const SAFE_MESSAGES = Object.freeze({
  CONTENT_PLAN_CONFIRMATION_FAILED: '素材内容计划确认失败',
  SOURCE_READ_FAILED: '源数据只读校验失败',
  SOURCE_SCHEMA_INVALID: '源表字段契约不符合要求',
  SCHEMA_APPROVAL_MISSING: '尚未配置获批准的字段契约摘要',
  SCHEMA_BINDINGS_INCOMPLETE: '字段映射证据不完整，已阻断同步',
  RESOURCE_IDENTITY_APPROVAL_MISSING: '尚未配置获批准的目标资源身份摘要',
  RESOURCE_IDENTITY_MISMATCH: '目标资源身份摘要与批准版本不一致',
  SCHEMA_DIGEST_MISSING: '预演未返回完整字段契约摘要',
  SCHEMA_DIGEST_MISMATCH: '字段契约摘要与批准版本不一致',
  MIRROR_SCHEMA_CHANGED: '正式写入前字段契约发生变化',
  MIRROR_PLAN_CHANGED: '正式写入前源数据或镜像计划发生变化',
  MIRROR_RESOURCE_CHANGED: '正式写入前目标资源身份发生变化',
  MIRROR_PREFLIGHT_FAILED: '正式镜像只读预检未形成完整摘要',
  MIRROR_PLAN_DIGEST_MISSING: '预演未返回完整镜像计划摘要',
  RESOURCE_IDENTITY_DIGEST_MISSING: '预演未返回完整目标资源身份摘要',
  CONTENT_PLAN_DIGEST_MISSING: '预演未返回完整素材计划摘要',
  DRY_RUN_FAILED: '只读预演执行失败',
  DRY_RUN_NOT_COMPLETE: '只读预演未完整通过',
  APPLY_RESULT_NOT_COMPLETE: '正式同步结果未完整通过，远端状态待核对',
  APPLY_DIGEST_MISMATCH: '正式同步摘要与预演不一致，远端状态待核对',
  APPLY_FAILED: '正式同步异常，远端状态待核对',
  MATERIALS_PARTIAL_DRY_RUN: '库存预演已通过，部分房源素材待后续重试',
  MATERIALS_PARTIAL_FAILURE: '库存与首页快照已提交，部分房源素材同步失败',
  COMMIT_FAILED: '本地原子提交未确认，状态待核对',
  LEASE_LOST: '任务执行权已被新的安全租约接管',
  LEASE_INTEGRITY_BLOCKED: '同步控制器租约状态不完整，已安全阻断',
  DB_WRITE_LOCK_REQUIRED: '数据库跨进程写锁未启用，已安全阻断同步',
  WORKER_MIRROR_MODE_REQUIRED: '自动同步未启用字段契约明确的镜像模式',
  WORKER_NOTE_MATERIAL_MODE_REQUIRED: '自动同步未启用配置完整的房源笔记素材管线',
  TARGET_WRITE_DISPATCH_EVIDENCE_REQUIRED: '目标 Base 客户端缺少精确写派发证据',
  EXTERNAL_WRITE_INTENT_PERSISTENCE_FAILED: '外部写入意图未能在写请求前持久化，已安全中止',
  WORKER_CONFIGURATION_INVALID: '同步工作器配置不完整',
  LEGACY_PREWRITE_EVIDENCE_MISMATCH: '旧任务写前证据不完整，拒绝解除未知态',
  PARTIAL_RECONCILIATION_FAILED: '部分写入只读对账未通过，旧任务继续保持阻断',
  UNKNOWN_ERROR: '同步异常，详细信息仅保留在受控服务日志中'
})

class WorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message || SAFE_MESSAGES[code] || SAFE_MESSAGES.UNKNOWN_ERROR)
    this.name = 'FeishuSyncWorkerError'
    this.code = code
    this.safeBeforeWrite = options.safeBeforeWrite === true
    this.blocked = options.blocked === true
  }
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
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
  return sha256(JSON.stringify(stableValue(value)))
}

function exactObjectKeys(value, expectedKeys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys.slice().sort())
}

function partialReconciliationFailure() {
  return new WorkerError('PARTIAL_RECONCILIATION_FAILED', '', {
    safeBeforeWrite: true,
    blocked: true
  })
}

function validatePartialReconciliationEvidence(evidence, run) {
  const evidenceKeys = [
    'archiveCount',
    'archiveEvidenceSha256',
    'contract',
    'currentMirrorPlanSha256',
    'currentOperationsSha256',
    'currentPlan',
    'evidenceSha256',
    'historyCount',
    'historyEvidenceSha256',
    'priorMirrorPlanSha256',
    'resourceIdentitySha256',
    'runIdSha256',
    'schemaSha256'
  ]
  const planKeys = ['create', 'deactivate', 'noop', 'restore', 'update']
  const emptyEvidenceSha256 = stableSha256([])
  if (!exactObjectKeys(evidence, evidenceKeys) ||
      !exactObjectKeys(evidence.currentPlan, planKeys) ||
      evidence.contract !== 'feishu-partial-base-write-reconciliation-v1' ||
      evidence.runIdSha256 !== sha256(run.runId) ||
      evidence.priorMirrorPlanSha256 !== run.mirrorPlanSha256 ||
      evidence.schemaSha256 !== run.schemaSha256 ||
      evidence.resourceIdentitySha256 !== run.resourceIdentitySha256 ||
      !validSha256(evidence.currentMirrorPlanSha256) ||
      !validSha256(evidence.archiveEvidenceSha256) ||
      !validSha256(evidence.historyEvidenceSha256) ||
      !validSha256(evidence.currentOperationsSha256) ||
      !validSha256(evidence.evidenceSha256) ||
      !Number.isSafeInteger(evidence.archiveCount) || evidence.archiveCount < 0 ||
      !Number.isSafeInteger(evidence.historyCount) || evidence.historyCount < 0 ||
      (evidence.archiveCount === 0) !== (evidence.archiveEvidenceSha256 === emptyEvidenceSha256) ||
      (evidence.historyCount === 0) !== (evidence.historyEvidenceSha256 === emptyEvidenceSha256) ||
      planKeys.some((key) => !Number.isSafeInteger(evidence.currentPlan[key]) || evidence.currentPlan[key] < 0) ||
      ['create', 'update', 'restore', 'deactivate']
        .reduce((sum, key) => sum + evidence.currentPlan[key], 0) <= 0) {
    throw partialReconciliationFailure()
  }
  const evidenceBody = {
    contract: evidence.contract,
    runIdSha256: evidence.runIdSha256,
    priorMirrorPlanSha256: evidence.priorMirrorPlanSha256,
    currentMirrorPlanSha256: evidence.currentMirrorPlanSha256,
    schemaSha256: evidence.schemaSha256,
    resourceIdentitySha256: evidence.resourceIdentitySha256,
    archiveCount: evidence.archiveCount,
    historyCount: evidence.historyCount,
    archiveEvidenceSha256: evidence.archiveEvidenceSha256,
    historyEvidenceSha256: evidence.historyEvidenceSha256,
    currentOperationsSha256: evidence.currentOperationsSha256,
    currentPlan: clone(evidence.currentPlan)
  }
  if (stableSha256(evidenceBody) !== evidence.evidenceSha256) {
    throw partialReconciliationFailure()
  }
  return { ...evidenceBody, evidenceSha256: evidence.evidenceSha256 }
}

function isZeroBaseWriteEvidence(evidence) {
  return evidence.archiveCount === 0 && evidence.historyCount === 0
}

function isReconciledDryRunBarrier(run) {
  return Boolean(run) && run.state === STATES.RECONCILED_PARTIAL
}

function isVerifiedZeroWriteBarrier(run) {
  if (!isReconciledDryRunBarrier(run) ||
      run.resolutionCode !== 'ZERO_BASE_WRITES_RECONCILED' ||
      !run.reconciliationEvidence ||
      run.reconciliationEvidenceSha256 !== run.reconciliationEvidence.evidenceSha256 ||
      !Number.isSafeInteger(run.resolvedAt) || run.resolvedAt <= 0 ||
      !Number.isSafeInteger(run.finishedAt) || run.resolvedAt <= run.finishedAt ||
      run.updatedAt !== run.resolvedAt) return false
  try {
    const evidence = validatePartialReconciliationEvidence(
      run.reconciliationEvidence,
      run
    )
    return isZeroBaseWriteEvidence(evidence) &&
      sourceUnknownRunIdentityFromResolved(run) === run.sourceUnknownRunSha256
  } catch (error) {
    return false
  }
}

function isDryRunBoundToZeroWriteBarrier(run, barrier) {
  return Boolean(run) && Boolean(barrier) &&
    run.dryRun === true &&
    run.continuationOfRunId === barrier.runId &&
    run.sourceUnknownRunSha256 === barrier.sourceUnknownRunSha256 &&
    run.reconciliationEvidenceSha256 === barrier.reconciliationEvidenceSha256 &&
    Number.isSafeInteger(run.createdAt) &&
    Number.isSafeInteger(barrier.resolvedAt) &&
    run.createdAt >= barrier.resolvedAt
}

function partialContinuationRequestKey(runId, sourceUnknownRunSha256, evidenceSha256) {
  return stableSha256({
    contract: 'feishu-reconciled-partial-continuation-v1',
    continuationOfRunId: runId,
    sourceUnknownRunSha256,
    reconciliationEvidenceSha256: evidenceSha256
  })
}

function zeroWriteContinuationRequestKey(runId, sourceUnknownRunSha256, evidenceSha256) {
  return stableSha256({
    contract: 'feishu-reconciled-zero-write-dry-run-v1',
    continuationOfRunId: runId,
    sourceUnknownRunSha256,
    reconciliationEvidenceSha256: evidenceSha256,
    dryRun: true
  })
}

function sourceUnknownRunFromResolved(run) {
  if (!run || !Number.isSafeInteger(run.sourceUnknownUpdatedAt) ||
      !validSha256(run.sourceUnknownRunSha256)) {
    throw partialReconciliationFailure()
  }
  const hasParentRun = typeof run.continuationOfRunId === 'string' &&
    run.continuationOfRunId.length > 0
  const hasParentSource = Object.prototype.hasOwnProperty.call(
    run,
    'parentSourceUnknownRunSha256'
  )
  const hasParentEvidence = Object.prototype.hasOwnProperty.call(
    run,
    'parentReconciliationEvidenceSha256'
  )
  const hasDryRetryRun = Object.prototype.hasOwnProperty.call(run, 'dryRunRetryRunId')
  const hasDryRetrySeed = Object.prototype.hasOwnProperty.call(run, 'dryRunRetrySeedSha256')
  if (hasParentRun !== (hasParentSource && hasParentEvidence) ||
      hasParentSource !== hasParentEvidence ||
      hasDryRetryRun !== hasDryRetrySeed ||
      (hasParentRun && (
        !validSha256(run.parentSourceUnknownRunSha256) ||
        !validSha256(run.parentReconciliationEvidenceSha256)
      )) ||
      (hasDryRetryRun && (
        typeof run.dryRunRetryRunId !== 'string' || !run.dryRunRetryRunId ||
        !validSha256(run.dryRunRetrySeedSha256)
      ))) {
    throw partialReconciliationFailure()
  }
  const original = clone(run)
  const originalUpdatedAt = original.sourceUnknownUpdatedAt
  ;[
    'continuationRunId',
    'continuationSeedSha256',
    'dryRunRetryRunId',
    'dryRunRetrySeedSha256',
    'reconciliationEvidence',
    'reconciliationEvidenceSha256',
    'resolutionCode',
    'resolvedAt',
    'parentReconciliationEvidenceSha256',
    'parentSourceUnknownRunSha256',
    'sourceUnknownRunSha256',
    'sourceUnknownUpdatedAt'
  ].forEach((key) => delete original[key])
  if (hasParentRun) {
    original.sourceUnknownRunSha256 = run.parentSourceUnknownRunSha256
    original.reconciliationEvidenceSha256 = run.parentReconciliationEvidenceSha256
  }
  original.state = STATES.UNKNOWN
  original.updatedAt = originalUpdatedAt
  return original
}

function sourceUnknownRunIdentityFromResolved(run) {
  return stableSha256(sourceUnknownRunFromResolved(run))
}

function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function safeErrorCode(error, fallback = 'UNKNOWN_ERROR') {
  const raw = String(error && error.code ? error.code : fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 64)
  return raw || fallback
}

function safeErrorMessage(code) {
  return SAFE_MESSAGES[code] || SAFE_MESSAGES.UNKNOWN_ERROR
}

function markSafeBeforeWrite(error, fallbackCode) {
  if (error && typeof error === 'object') {
    error.safeBeforeWrite = true
    if (!error.code) error.code = fallbackCode
    return error
  }
  return new WorkerError(fallbackCode, '', { safeBeforeWrite: true })
}

function safeBindingText(value, maxLength = 80) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!text || text.length > maxLength ||
      /(?:https?:\/\/|[A-Za-z]:\\|^\/|\\\\|\.\.\/|\/(?:home|root|etc|var|tmp)\/|(?:^|[\\/])[^\\/]+\.(?:json|txt|csv|xlsx?|mp4|jpe?g|png)$|token|secret|app[_-]?id|table[_-]?id|^fld[A-Za-z0-9_-]{4,}$|(?:\+?86[- ]?)?1[3-9]\d{9})/i.test(text)) {
    return ''
  }
  return text
}

function sanitizeSchemaBindings(result) {
  const source = result && typeof result === 'object' ? result : {}
  const mirror = source.mirror && typeof source.mirror === 'object' ? source.mirror : {}
  const bindings = Array.isArray(source.schemaBindings)
    ? source.schemaBindings
    : (Array.isArray(mirror.schemaBindings) ? mirror.schemaBindings : [])
  const flattened = bindings.flatMap((binding) => {
    if (binding && Array.isArray(binding.bindings)) {
      return binding.bindings.map((nested) => ({ ...nested, role: binding.role }))
    }
    return [binding]
  })
  return flattened.slice(0, 200).map((binding) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null
    const role = safeBindingText(binding.role, 32)
    const semantic = safeBindingText(binding.semantic, 80)
    const fieldName = safeBindingText(binding.fieldName, 80)
    const numericType = Number(binding.type)
    const type = Number.isSafeInteger(numericType)
      ? numericType
      : safeBindingText(binding.type, 32)
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(role) ||
        !/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(semantic) ||
        !fieldName || type === '') return null
    return { role, semantic, fieldName, type }
  }).filter(Boolean)
}

function validateSchemaBindings(result) {
  const source = result && typeof result === 'object' ? result : {}
  const mirror = source.mirror && typeof source.mirror === 'object' ? source.mirror : {}
  const raw = Array.isArray(source.schemaBindings)
    ? source.schemaBindings
    : (Array.isArray(mirror.schemaBindings) ? mirror.schemaBindings : [])
  const safe = sanitizeSchemaBindings(result)
  const allowedRoles = new Set(['source', 'location', 'mini', 'rented', 'history'])
  const declaredRoles = new Set()
  let expectedBindingCount = 0
  let structurallyComplete = raw.length > 0
  raw.forEach((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      structurallyComplete = false
      return
    }
    const role = safeBindingText(entry.role, 32)
    if (!allowedRoles.has(role)) structurallyComplete = false
    if (role) declaredRoles.add(role)
    if (Array.isArray(entry.bindings)) {
      if (!entry.bindings.length) structurallyComplete = false
      expectedBindingCount += entry.bindings.length
    } else {
      expectedBindingCount += 1
    }
  })
  const roles = new Set(safe.map((binding) => binding.role))
  const uniqueBindings = new Set(safe.map((binding) => `${binding.role}\n${binding.semantic}`))
  if (!structurallyComplete || safe.length !== expectedBindingCount ||
      uniqueBindings.size !== safe.length ||
      ![...declaredRoles].every((role) => roles.has(role)) ||
      !['source', 'location', 'mini'].every((role) => roles.has(role))) {
    throw new WorkerError('SCHEMA_BINDINGS_INCOMPLETE', '', {
      safeBeforeWrite: true,
      blocked: true
    })
  }
  return safe
}

function normalizeTrigger(value) {
  return value === 'scheduled' ? 'scheduled' : 'manual'
}

function normalizeRunId(value) {
  const text = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(text) ||
      /(?:token|secret|password|passwd|bearer|appsecret)/i.test(text)) {
    throw new WorkerError('WORKER_CONFIGURATION_INVALID', 'runId 不符合安全格式', {
      safeBeforeWrite: true
    })
  }
  return text
}

function normalizeActorId(value, fallback) {
  const text = String(value || fallback || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(text) ||
      /(?:token|secret|password|passwd|bearer|appsecret)/i.test(text)) {
    throw new WorkerError('WORKER_CONFIGURATION_INVALID', '同步发起人身份不符合安全格式', {
      safeBeforeWrite: true
    })
  }
  return text
}

function validLeaseShape(lease) {
  return Boolean(lease) && typeof lease === 'object' && !Array.isArray(lease) &&
    typeof lease.runId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(lease.runId) &&
    typeof lease.owner === 'string' && lease.owner.length > 0 && lease.owner.length <= 128 &&
    Number.isSafeInteger(lease.fence) && lease.fence > 0 &&
    Number.isFinite(lease.acquiredAt) && lease.acquiredAt >= 0 &&
    Number.isFinite(lease.expiresAt) && lease.expiresAt > lease.acquiredAt
}

function ensureState(db) {
  if (!Array.isArray(db.feishuSyncRuns)) db.feishuSyncRuns = []
  if (!db.feishuSyncScheduler || typeof db.feishuSyncScheduler !== 'object' ||
      Array.isArray(db.feishuSyncScheduler)) {
    db.feishuSyncScheduler = {}
  }
  if (!db.feishuSyncCommitMarkers || typeof db.feishuSyncCommitMarkers !== 'object' ||
      Array.isArray(db.feishuSyncCommitMarkers)) {
    db.feishuSyncCommitMarkers = {}
  }
  const scheduler = db.feishuSyncScheduler
  if (!Number.isSafeInteger(scheduler.nextFence) || scheduler.nextFence < 0) {
    scheduler.nextFence = 0
  }
  if (scheduler.activeLease !== null && scheduler.activeLease !== undefined &&
      !validLeaseShape(scheduler.activeLease)) {
    scheduler.activeLease = null
    scheduler.leaseIntegrityBlockedRunId = 'controller-state-invalid'
  }
  return db
}

function businessSnapshot(db) {
  const snapshot = clone(db || {})
  CONTROL_KEYS.forEach((key) => delete snapshot[key])
  return snapshot
}

function runById(db, runId) {
  return (db.feishuSyncRuns || []).find((item) => item && item.runId === runId) || null
}

function leaseExpired(run, nowMs) {
  return !run.lease || !Number.isFinite(Number(run.lease.expiresAt)) ||
    Number(run.lease.expiresAt) <= nowMs
}

function leaseMatches(lease, runId, owner, fence) {
  return Boolean(lease) && lease.runId === runId && lease.owner === owner &&
    Number(lease.fence) === Number(fence)
}

function schedulerLeaseMatches(db, runId, lease) {
  if (!lease || lease.runId !== runId) return false
  const scheduler = db && db.feishuSyncScheduler
  return Boolean(scheduler) && leaseMatches(
    scheduler.activeLease,
    runId,
    lease.owner,
    lease.fence
  )
}

function schedulerLeaseConsistent(db, runId, lease) {
  if (!schedulerLeaseMatches(db, runId, lease)) return false
  const activeLease = db.feishuSyncScheduler.activeLease
  return Number(activeLease.acquiredAt) === Number(lease.acquiredAt) &&
    Number(activeLease.expiresAt) === Number(lease.expiresAt)
}

function releaseSchedulerLease(db, runId, lease) {
  if (!schedulerLeaseMatches(db, runId, lease)) return false
  db.feishuSyncScheduler.activeLease = null
  return true
}

function markerMatches(run, marker) {
  if (!run || !marker || typeof marker !== 'object' || Array.isArray(marker)) return false
  const runFence = Number(run.lease && run.lease.fence || run.lastFence)
  const body = {
    runId: marker.runId,
    fence: marker.fence,
    schemaSha256: marker.schemaSha256,
    resourceIdentitySha256: marker.resourceIdentitySha256,
    mirrorPlanSha256: marker.mirrorPlanSha256,
    contentPlanSha256: marker.contentPlanSha256,
    contentPlanAssetCount: marker.contentPlanAssetCount,
    committedAt: marker.committedAt
  }
  const exactKeys = Object.keys(body).concat('markerSha256').sort()
  if (Object.keys(marker).sort().join('\n') !== exactKeys.join('\n')) return false
  if (body.runId !== run.runId || !Number.isSafeInteger(body.fence) || body.fence !== runFence ||
      body.schemaSha256 !== run.schemaSha256 ||
      body.resourceIdentitySha256 !== run.resourceIdentitySha256 ||
      body.mirrorPlanSha256 !== run.mirrorPlanSha256 ||
      body.contentPlanSha256 !== run.contentPlanSha256 ||
      !Number.isSafeInteger(body.contentPlanAssetCount) ||
      body.contentPlanAssetCount !== run.contentPlanAssetCount ||
      !Number.isSafeInteger(body.committedAt) || body.committedAt <= 0 ||
      !validSha256(body.schemaSha256) || !validSha256(body.resourceIdentitySha256) ||
      !validSha256(body.mirrorPlanSha256) ||
      !validSha256(body.contentPlanSha256) || !validSha256(run.commitMarkerSha256) ||
      marker.markerSha256 !== run.commitMarkerSha256) return false
  return sha256(JSON.stringify(body)) === marker.markerSha256
}

function trimRuns(db, maxRuns) {
  if (db.feishuSyncRuns.length > maxRuns) {
    const retainedIds = new Set()
    db.feishuSyncRuns.forEach((run) => {
      if (run && !TERMINAL_STATES.has(run.state)) retainedIds.add(run.runId)
      if (run && run.state === STATES.RECONCILED_PARTIAL) {
        retainedIds.add(run.runId)
        if (run.continuationRunId) retainedIds.add(run.continuationRunId)
        if (run.dryRunRetryRunId) retainedIds.add(run.dryRunRetryRunId)
      }
    })
    const protectedRunIds = [
      db.feishuSyncScheduler.blockedRunId,
      db.feishuSyncScheduler.leaseIntegrityBlockedRunId
    ].filter(Boolean)
    protectedRunIds.forEach((runId) => retainedIds.add(runId))
    db.feishuSyncRuns.forEach((run) => {
      if (run && retainedIds.size < maxRuns) retainedIds.add(run.runId)
    })
    db.feishuSyncRuns = db.feishuSyncRuns.filter((run) => run && retainedIds.has(run.runId))
  }
  const retainedRunIds = new Set(db.feishuSyncRuns.map((run) => run && run.runId).filter(Boolean))
  Object.keys(db.feishuSyncCommitMarkers).forEach((runId) => {
    if (!retainedRunIds.has(runId)) delete db.feishuSyncCommitMarkers[runId]
  })
}

function summarizeResult(result) {
  const source = result && typeof result === 'object' ? result : {}
  const summary = {
    success: source.success === true,
    complete: source.complete === true,
    dryRun: source.dryRun === true,
    failed: Math.max(0, Number(source.failed || 0))
  }
  const numericKeys = [
    'created', 'updated', 'down', 'synced', 'cleared', 'retained',
    'rowCount', 'columnCount', 'sourceRecordCount', 'contentPlanAssetCount'
  ]
  numericKeys.forEach((key) => {
    if (Number.isFinite(Number(source[key]))) summary[key] = Math.max(0, Number(source[key]))
  })
  return summary
}

function sanitizeRun(run) {
  if (!run) return null
  return {
    runId: String(run.runId || ''),
    state: String(run.state || ''),
    trigger: normalizeTrigger(run.trigger),
    dryRun: run.dryRun === true,
    bucket: Number.isSafeInteger(run.bucket) ? run.bucket : null,
    createdAt: Number(run.createdAt || 0),
    updatedAt: Number(run.updatedAt || 0),
    startedAt: Number(run.startedAt || 0) || null,
    finishedAt: Number(run.finishedAt || 0) || null,
    attemptCount: Math.max(0, Number(run.attemptCount || 0)),
    recoveryCount: Math.max(0, Number(run.recoveryCount || 0)),
    fence: Math.max(0, Number(run.lease && run.lease.fence || run.lastFence || 0)),
    externalWritesMayHaveOccurred: run.externalWritesMayHaveOccurred === true,
    writeIntentEvidenceVersion: Number.isSafeInteger(Number(run.writeIntentEvidenceVersion))
      ? Number(run.writeIntentEvidenceVersion)
      : null,
    externalWriteIntentAt: Number(run.externalWriteIntentAt || 0) || null,
    resourceIdentitySha256: validSha256(run.resourceIdentitySha256)
      ? run.resourceIdentitySha256
      : '',
    mirrorPlanSha256: validSha256(run.mirrorPlanSha256) ? run.mirrorPlanSha256 : '',
    schemaSha256: validSha256(run.schemaSha256) ? run.schemaSha256 : '',
    contentPlanSha256: validSha256(run.contentPlanSha256) ? run.contentPlanSha256 : '',
    contentPlanAssetCount: Number.isSafeInteger(run.contentPlanAssetCount)
      ? run.contentPlanAssetCount
      : null,
    resolvedAt: Number(run.resolvedAt || 0) || null,
    resolutionCode: safeErrorCode({ code: run.resolutionCode || '' }, ''),
    reconciliationEvidenceSha256: validSha256(run.reconciliationEvidenceSha256)
      ? run.reconciliationEvidenceSha256
      : '',
    continuationRunId: run.continuationRunId ? String(run.continuationRunId) : '',
    continuationOfRunId: run.continuationOfRunId ? String(run.continuationOfRunId) : '',
    errorCode: safeErrorCode({ code: run.errorCode || '' }, ''),
    message: run.errorCode ? safeErrorMessage(run.errorCode) : '',
    result: run.resultSummary ? clone(run.resultSummary) : null,
    schemaBindings: sanitizeSchemaBindings({ schemaBindings: run.schemaBindings })
  }
}

function extractDigests(result, captured) {
  const source = result && typeof result === 'object' ? result : {}
  const mirror = source.mirror && typeof source.mirror === 'object' ? source.mirror : {}
  const note = source.noteMaterials && typeof source.noteMaterials === 'object'
    ? source.noteMaterials
    : {}
  const capturedReport = captured && captured.report && typeof captured.report === 'object'
    ? captured.report
    : {}
  const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')
  return {
    mirrorPlanSha256: pick(source.mirrorPlanSha256, mirror.mirrorPlanSha256, mirror.planSha256),
    schemaSha256: pick(source.schemaSha256, mirror.schemaSha256),
    resourceIdentitySha256: pick(
      source.resourceIdentitySha256,
      mirror.resourceIdentitySha256
    ),
    contentPlanSha256: pick(
      source.contentPlanSha256,
      note.contentPlanSha256,
      capturedReport.contentPlanSha256
    ),
    contentPlanAssetCount: pick(
      source.contentPlanAssetCount,
      note.contentPlanAssetCount,
      capturedReport.contentPlanAssetCount
    )
  }
}

function materialFailureRowIsDeferred(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.deferred !== true) return false
  const status = String(row.status || '')
  const sourceRecordId = String(row.sourceRecordId || '').trim()
  const sourceValueFingerprint = String(row.sourceValueFingerprint || '').trim().toLowerCase()
  const sourceLinkFingerprint = String(row.sourceLinkFingerprint || '').trim().toLowerCase()
  const deferredAction = String(row.deferredAction || '')
  const mediaStateFingerprint = String(row.mediaStateFingerprint || '').trim().toLowerCase()
  const physicalUnitFingerprint = String(row.physicalUnitFingerprint || '').trim().toLowerCase()
  const actionValid = deferredAction === 'none'
    ? status === 'listing-missing' && !mediaStateFingerprint && !physicalUnitFingerprint
    : (deferredAction === 'retain' || deferredAction === 'clear') &&
      validSha256(mediaStateFingerprint) &&
      (!physicalUnitFingerprint || validSha256(physicalUnitFingerprint)) &&
      (deferredAction !== 'retain' || validSha256(physicalUnitFingerprint))
  return KNOWN_MATERIAL_FAILURE_ROW_STATES.has(status) && Boolean(sourceRecordId) &&
    validSha256(sourceValueFingerprint) &&
    (!sourceLinkFingerprint || validSha256(sourceLinkFingerprint)) && actionValid
}

function knownMaterialWarningReport(noteMaterials, dryRun) {
  if (!noteMaterials || typeof noteMaterials !== 'object' || Array.isArray(noteMaterials) ||
      noteMaterials.complete !== false || noteMaterials.published !== false ||
      noteMaterials.dryRun !== dryRun || noteMaterials.externalWriteStateUnknown === true) return false
  const materialFailed = Number(noteMaterials.failed)
  const rows = Array.isArray(noteMaterials.rows) ? noteMaterials.rows : []
  if (!Number.isSafeInteger(materialFailed) || materialFailed <= 0 || !rows.length) return false
  const successStatuses = dryRun
    ? KNOWN_DRY_MATERIAL_SUCCESS_ROW_STATES
    : KNOWN_APPLY_MATERIAL_SUCCESS_ROW_STATES
  const failureRows = rows.filter(materialFailureRowIsDeferred)
  const rowsAreKnown = rows.every((row) => {
    const status = row && typeof row === 'object' && !Array.isArray(row)
      ? String(row.status || '')
      : ''
    return materialFailureRowIsDeferred(row) || successStatuses.has(status)
  })
  const reportStatus = String(noteMaterials.status || '')
  return rowsAreKnown && failureRows.length === materialFailed &&
    (!reportStatus || reportStatus === 'unsupported-non-video')
}

function materialWarningResult(result, dryRun) {
  if (!result || result.externalWriteStateUnknown === true) return false
  const noteMaterials = result.noteMaterials
  const failed = Number(result.failed)
  const expectedStatus = dryRun
    ? 'inventory-validated-materials-failed'
    : 'inventory-published-materials-failed'
  const inventoryFlagsMatch = dryRun
    ? result.inventoryCommittable === false && result.inventoryPublished === false
    : result.inventoryCommittable === true && result.inventoryPublished === true
  return result.success === false && result.complete === false && result.published === false &&
    result.dryRun === dryRun && result.validated === true && result.planned === true &&
    result.status === expectedStatus && inventoryFlagsMatch &&
    Number.isSafeInteger(failed) && failed > 0 &&
    knownMaterialWarningReport(noteMaterials, dryRun) &&
    failed === Number(noteMaterials.failed)
}

function validateDryResult(
  result,
  captured,
  approvedSchemaSha256,
  approvedResourceIdentitySha256,
  options = {}
) {
  const completeSuccess = Boolean(result) && result.success === true && result.complete === true &&
    result.dryRun === true && Number(result.failed || 0) === 0 &&
    result.externalWriteStateUnknown !== true
  const committableMaterialWarning = materialWarningResult(result, true)
  if (!completeSuccess && !committableMaterialWarning) {
    throw new WorkerError('DRY_RUN_NOT_COMPLETE', '', { safeBeforeWrite: true })
  }
  const digests = extractDigests(result, captured)
  if (!validSha256(digests.schemaSha256)) {
    throw new WorkerError('SCHEMA_DIGEST_MISSING', '', { safeBeforeWrite: true, blocked: true })
  }
  if (!validSha256(digests.mirrorPlanSha256)) {
    throw new WorkerError('MIRROR_PLAN_DIGEST_MISSING', '', { safeBeforeWrite: true, blocked: true })
  }
  if (!validSha256(digests.resourceIdentitySha256)) {
    throw new WorkerError('RESOURCE_IDENTITY_DIGEST_MISSING', '', {
      safeBeforeWrite: true,
      blocked: true
    })
  }
  if (!validSha256(digests.contentPlanSha256) ||
      !Number.isSafeInteger(Number(digests.contentPlanAssetCount)) ||
      Number(digests.contentPlanAssetCount) < 0) {
    throw new WorkerError('CONTENT_PLAN_DIGEST_MISSING', '', { safeBeforeWrite: true, blocked: true })
  }
  if (options.requireApprovedSchema !== false && !validSha256(approvedSchemaSha256)) {
    throw new WorkerError('SCHEMA_APPROVAL_MISSING', '', {
      safeBeforeWrite: true,
      blocked: true
    })
  }
  if (options.requireApprovedSchema !== false && digests.schemaSha256 !== approvedSchemaSha256) {
    throw new WorkerError('SCHEMA_DIGEST_MISMATCH', '', { safeBeforeWrite: true, blocked: true })
  }
  if (options.requireApprovedSchema !== false && !validSha256(approvedResourceIdentitySha256)) {
    throw new WorkerError('RESOURCE_IDENTITY_APPROVAL_MISSING', '', {
      safeBeforeWrite: true,
      blocked: true
    })
  }
  if (options.requireApprovedSchema !== false &&
      digests.resourceIdentitySha256 !== approvedResourceIdentitySha256) {
    throw new WorkerError('RESOURCE_IDENTITY_MISMATCH', '', {
      safeBeforeWrite: true,
      blocked: true
    })
  }
  return {
    mirrorPlanSha256: digests.mirrorPlanSha256,
    schemaSha256: digests.schemaSha256,
    resourceIdentitySha256: digests.resourceIdentitySha256,
    contentPlanSha256: digests.contentPlanSha256,
    contentPlanAssetCount: Number(digests.contentPlanAssetCount),
    committableMaterialWarning
  }
}

function validateApplyResult(result, expected) {
  const noteMaterials = result && result.noteMaterials &&
    typeof result.noteMaterials === 'object' && !Array.isArray(result.noteMaterials)
    ? result.noteMaterials
    : null
  const completeSuccess = Boolean(result) && result.success === true && result.complete === true &&
    result.dryRun !== true && Number(result.failed || 0) === 0 &&
    result.inventoryCommittable === true && result.externalWriteStateUnknown !== true &&
    !(noteMaterials && noteMaterials.externalWriteStateUnknown === true)
  const committableMaterialWarning = materialWarningResult(result, false)
  if (!completeSuccess && !committableMaterialWarning) {
    throw new WorkerError('APPLY_RESULT_NOT_COMPLETE')
  }
  const actual = extractDigests(result, null)
  if (actual.mirrorPlanSha256 !== expected.mirrorPlanSha256 ||
      actual.schemaSha256 !== expected.schemaSha256 ||
      actual.resourceIdentitySha256 !== expected.resourceIdentitySha256 ||
      actual.contentPlanSha256 !== expected.contentPlanSha256 ||
      Number(actual.contentPlanAssetCount) !== expected.contentPlanAssetCount) {
    throw new WorkerError('APPLY_DIGEST_MISMATCH')
  }
  return { ...actual, committableMaterialWarning }
}

function validateFrozenApplyPlan(candidate, prepared) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
      !prepared || typeof prepared !== 'object') {
    throw new WorkerError('MIRROR_PREFLIGHT_FAILED', '', { safeBeforeWrite: true })
  }
  const keys = Object.keys(candidate).sort()
  const expectedKeys = ['mirrorPlanSha256', 'resourceIdentitySha256', 'schemaSha256']
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
      !validSha256(candidate.schemaSha256) ||
      !validSha256(candidate.resourceIdentitySha256) ||
      !validSha256(candidate.mirrorPlanSha256)) {
    throw new WorkerError('MIRROR_PREFLIGHT_FAILED', '', { safeBeforeWrite: true })
  }
  if (candidate.schemaSha256 !== prepared.schemaSha256) {
    throw new WorkerError('MIRROR_SCHEMA_CHANGED', '', { safeBeforeWrite: true, blocked: true })
  }
  if (candidate.resourceIdentitySha256 !== prepared.resourceIdentitySha256) {
    throw new WorkerError('MIRROR_RESOURCE_CHANGED', '', { safeBeforeWrite: true, blocked: true })
  }
  return {
    mirrorPlanSha256: candidate.mirrorPlanSha256,
    schemaSha256: prepared.schemaSha256,
    resourceIdentitySha256: prepared.resourceIdentitySha256,
    contentPlanSha256: prepared.contentPlanSha256,
    contentPlanAssetCount: prepared.contentPlanAssetCount,
    committableMaterialWarning: prepared.committableMaterialWarning === true
  }
}

function createFeishuSyncWorker(dependencies = {}) {
  const dbStore = dependencies.dbStore
  const feishuSync = dependencies.feishuSync
  const commitDeltaChecked = dependencies.commitDeltaChecked
  if (!dbStore || typeof dbStore.readDb !== 'function' || typeof dbStore.updateDb !== 'function' ||
      !feishuSync || typeof feishuSync.sync !== 'function' ||
      typeof commitDeltaChecked !== 'function') {
    throw new WorkerError('WORKER_CONFIGURATION_INVALID', '', { safeBeforeWrite: true })
  }

  const settings = dependencies.config || {}
  const now = typeof dependencies.now === 'function' ? dependencies.now : Date.now
  const randomId = typeof dependencies.randomId === 'function'
    ? dependencies.randomId
    : (prefix) => `${prefix}-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const leaseMs = positiveInteger(settings.leaseMs || settings.syncLeaseMs, 10 * 60 * 1000)
  const intervalMinutes = positiveInteger(
    settings.intervalMinutes || settings.syncIntervalMinutes,
    30
  )
  const intervalMs = intervalMinutes * 60 * 1000
  const maxRuns = positiveInteger(settings.maxRuns, 100)
  const approvedSchemaSha256 = String(settings.approvedSchemaSha256 || '').trim()
  const approvedResourceIdentitySha256 = String(
    settings.approvedResourceIdentitySha256 || ''
  ).trim()
  const writeLockEnabledSource = dependencies.writeLockEnabled
  const safeBeforeWriteCodes = new Set([
    ...DEFAULT_SAFE_BEFORE_WRITE_CODES,
    ...(Array.isArray(settings.safeBeforeWriteCodes)
      ? settings.safeBeforeWriteCodes.map((code) => safeErrorCode({ code }))
      : [])
  ])
  const heartbeatEnabled = dependencies.heartbeat !== false
  const setIntervalFn = dependencies.setInterval || setInterval
  const clearIntervalFn = dependencies.clearInterval || clearInterval

  function isWriteLockEnabled() {
    try {
      const value = typeof writeLockEnabledSource === 'function'
        ? writeLockEnabledSource()
        : writeLockEnabledSource
      return value === true
    } catch (error) {
      return false
    }
  }

  function assertWriteLockEnabled() {
    if (!isWriteLockEnabled()) {
      throw new WorkerError('DB_WRITE_LOCK_REQUIRED', '', {
        safeBeforeWrite: true,
        blocked: true
      })
    }
  }

  function schedulerBucket(atMs) {
    return Math.floor(atMs / intervalMs)
  }

  function nextRunId() {
    return normalizeRunId(randomId('feishu-sync'))
  }

  function readRun(runId) {
    const db = dbStore.readDb()
    return sanitizeRun(runById(db, runId))
  }

  function publicStatusFromDb(db, limit = 20) {
    ensureState(db)
    const runs = db.feishuSyncRuns.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(sanitizeRun)
    const scheduler = db.feishuSyncScheduler
    return {
      scheduler: {
        writeLockEnabled: isWriteLockEnabled(),
        intervalMinutes,
        lastEnqueuedBucket: Number.isSafeInteger(scheduler.lastEnqueuedBucket)
          ? scheduler.lastEnqueuedBucket
          : null,
        lastRunId: String(scheduler.lastRunId || ''),
        lastTickAt: Number(scheduler.lastTickAt || 0) || null,
        lastDryRunAt: Number(scheduler.lastDryRunAt || 0) || null,
        lastSuccessAt: Number(scheduler.lastSuccessAt || 0) || null,
        blockedRunId: String(scheduler.blockedRunId || ''),
        leaseIntegrityBlockedRunId: String(scheduler.leaseIntegrityBlockedRunId || ''),
        activeRunId: String(scheduler.activeLease && scheduler.activeLease.runId || ''),
        activeFence: Number(scheduler.activeLease && scheduler.activeLease.fence || 0) || null,
        activeLeaseExpiresAt: Number(
          scheduler.activeLease && scheduler.activeLease.expiresAt || 0
        ) || null
      },
      counts: Object.values(STATES).reduce((counts, state) => {
        counts[state] = db.feishuSyncRuns.filter((run) => run.state === state).length
        return counts
      }, {}),
      runs
    }
  }

  function getStatus(options = {}) {
    return publicStatusFromDb(dbStore.readDb(), options.limit)
  }

  function enqueue(options = {}) {
    assertWriteLockEnabled()
    const trigger = normalizeTrigger(options.trigger)
    if (Object.prototype.hasOwnProperty.call(options, 'dryRun') && typeof options.dryRun !== 'boolean') {
      throw new WorkerError('WORKER_CONFIGURATION_INVALID', 'dryRun 必须是布尔值', {
        safeBeforeWrite: true
      })
    }
    if (trigger === 'scheduled' && options.dryRun === true) {
      throw new WorkerError('WORKER_CONFIGURATION_INVALID', '定时任务不可伪装成人工只预演', {
        safeBeforeWrite: true
      })
    }
    const dryRun = trigger === 'manual' && options.dryRun === true
    const requestedAt = Number.isSafeInteger(options.scheduledAt)
      ? options.scheduledAt
      : Number(now())
    const bucket = trigger === 'scheduled' ? schedulerBucket(requestedAt) : null
    const suppliedRunId = options.runId ? normalizeRunId(options.runId) : null
    const actorId = normalizeActorId(
      trigger === 'scheduled' ? settings.systemActorId : options.actorId,
      settings.systemActorId || 'system:feishu-sync-worker'
    )
    const idempotencySha256 = options.idempotencyKey
      ? sha256(String(options.idempotencyKey))
      : ''
    let selected = null

    dbStore.updateDb((db) => {
      reconcileInDb(db, requestedAt)
      const scheduler = db.feishuSyncScheduler
      if (scheduler.leaseIntegrityBlockedRunId) {
        if (trigger === 'scheduled') scheduler.lastTickAt = requestedAt
        const integrityRun = runById(db, scheduler.leaseIntegrityBlockedRunId)
        if (integrityRun) {
          selected = clone(integrityRun)
          return
        }
        throw new WorkerError('LEASE_INTEGRITY_BLOCKED', '', {
          safeBeforeWrite: true,
          blocked: true
        })
      }
      const blocker = runById(db, scheduler.blockedRunId)
      if (blocker && [STATES.UNKNOWN, STATES.BLOCKED].includes(blocker.state) && !dryRun) {
        if (trigger === 'scheduled') scheduler.lastTickAt = requestedAt
        selected = clone(blocker)
        return
      }
      if (blocker && isReconciledDryRunBarrier(blocker) && !dryRun) {
        if (trigger === 'scheduled') scheduler.lastTickAt = requestedAt
        throw new WorkerError('ZERO_WRITE_DRY_RUN_REQUIRED', '', {
          safeBeforeWrite: true,
          blocked: true
        })
      }
      const zeroWriteBarrier = blocker && isReconciledDryRunBarrier(blocker)
        ? blocker
        : null
      if (zeroWriteBarrier && !isVerifiedZeroWriteBarrierInDb(db, zeroWriteBarrier)) {
        throw partialReconciliationFailure()
      }
      const existingNonTerminal = db.feishuSyncRuns.find((run) =>
        run && !TERMINAL_STATES.has(run.state) && run.dryRun === dryRun
      )
      if (existingNonTerminal) {
        if (zeroWriteBarrier && dryRun &&
            !isAuthorizedZeroWriteDryInDb(db, existingNonTerminal, zeroWriteBarrier)) {
          throw partialReconciliationFailure()
        }
        if (trigger === 'scheduled') scheduler.lastTickAt = requestedAt
        selected = clone(existingNonTerminal)
        return
      }
      if (trigger === 'scheduled') {
        const existingId = scheduler.bucketRunIds && scheduler.bucketRunIds[String(bucket)]
        const existing = existingId ? runById(db, existingId) : null
        if (existing) {
          scheduler.lastTickAt = requestedAt
          selected = clone(existing)
          return
        }
      }
      if (idempotencySha256 && !zeroWriteBarrier) {
        const existing = db.feishuSyncRuns.find((run) => run.requestKeySha256 === idempotencySha256)
        if (existing) {
          selected = clone(existing)
          return
        }
      }

      if (zeroWriteBarrier && dryRun) {
        const priorDryRunId = Object.prototype.hasOwnProperty.call(
          zeroWriteBarrier,
          'dryRunRetryRunId'
        )
          ? zeroWriteBarrier.dryRunRetryRunId
          : zeroWriteBarrier.continuationRunId
        const priorDryRun = runById(db, priorDryRunId)
        if (!isAuthorizedZeroWriteDryInDb(db, priorDryRun, zeroWriteBarrier) ||
            ![STATES.FAILED_BEFORE_WRITE, STATES.BLOCKED].includes(priorDryRun.state) ||
            priorDryRun.externalWritesMayHaveOccurred === true || priorDryRun.lease) {
          throw partialReconciliationFailure()
        }
      }

      const runId = suppliedRunId || nextRunId()
      if (runById(db, runId)) throw new WorkerError('WORKER_CONFIGURATION_INVALID', 'runId 已存在')
      const run = {
        version: 3,
        runId,
        state: STATES.QUEUED,
        trigger,
        dryRun,
        actorType: trigger === 'scheduled' ? 'scheduler' : 'manual',
        // 发起人只保存在内部任务记录中，公共状态由 sanitizeRun 明确剥离；跨进程 CLI
        // 必须从持久任务恢复该身份，不能回退成系统账号后丢失审计归属。
        actorId: zeroWriteBarrier && dryRun ? zeroWriteBarrier.actorId : actorId,
        bucket,
        requestKeySha256: zeroWriteBarrier && dryRun
          ? zeroWriteContinuationRequestKey(
              zeroWriteBarrier.runId,
              zeroWriteBarrier.sourceUnknownRunSha256,
              zeroWriteBarrier.reconciliationEvidenceSha256
            )
          : idempotencySha256,
        runNowMs: requestedAt,
        createdAt: requestedAt,
        updatedAt: requestedAt,
        attemptCount: 0,
        recoveryCount: 0,
        externalWritesMayHaveOccurred: false,
        writeIntentEvidenceVersion: 1,
        lease: null,
        errorCode: ''
      }
      if (zeroWriteBarrier && dryRun) {
        run.continuationOfRunId = zeroWriteBarrier.runId
        run.sourceUnknownRunSha256 = zeroWriteBarrier.sourceUnknownRunSha256
        run.reconciliationEvidenceSha256 = zeroWriteBarrier.reconciliationEvidenceSha256
        zeroWriteBarrier.dryRunRetryRunId = runId
        zeroWriteBarrier.dryRunRetrySeedSha256 = stableSha256(run)
      }
      db.feishuSyncRuns.unshift(run)
      scheduler.lastRunId = runId
      scheduler.lastTickAt = trigger === 'scheduled' ? requestedAt : Number(scheduler.lastTickAt || 0)
      if (trigger === 'scheduled') {
        scheduler.lastEnqueuedBucket = bucket
        scheduler.bucketRunIds = scheduler.bucketRunIds || {}
        scheduler.bucketRunIds[String(bucket)] = runId
        const retainedBuckets = Object.keys(scheduler.bucketRunIds)
          .map(Number)
          .filter(Number.isSafeInteger)
          .sort((a, b) => b - a)
          .slice(0, maxRuns)
        const retained = new Set(retainedBuckets.map(String))
        Object.keys(scheduler.bucketRunIds).forEach((key) => {
          if (!retained.has(key)) delete scheduler.bucketRunIds[key]
        })
      }
      trimRuns(db, maxRuns)
      selected = clone(run)
    })
    return sanitizeRun(selected)
  }

  function reconcileInDb(db, atMs) {
    ensureState(db)
    assertZeroWriteBarrierPointerIntegrity(db)
    db.feishuSyncRuns.forEach((run) => {
      if (!run) return
      const approvalsNowMatch = run.state === STATES.BLOCKED &&
        APPROVAL_BLOCK_CODES.has(run.errorCode) &&
        run.externalWritesMayHaveOccurred !== true &&
        validSha256(run.schemaSha256) && validSha256(run.resourceIdentitySha256) &&
        run.schemaSha256 === approvedSchemaSha256 &&
        run.resourceIdentitySha256 === approvedResourceIdentitySha256
      if (approvalsNowMatch) {
        run.state = STATES.FAILED_BEFORE_WRITE
        run.resolvedAt = atMs
        run.updatedAt = atMs
      }
      if (TERMINAL_STATES.has(run.state)) {
        const terminalLease = clone(run.lease)
        if (terminalLease) {
          run.lastFence = Number(terminalLease.fence || 0)
          run.lease = null
          releaseSchedulerLease(db, run.runId, terminalLease)
        }
        return
      }
      if (!leaseExpired(run, atMs)) return
      const expiredLease = clone(run.lease)
      const marker = db.feishuSyncCommitMarkers[run.runId]
      if ((run.state === STATES.APPLYING || run.state === STATES.COMMITTING) && markerMatches(run, marker)) {
        run.state = STATES.SUCCEEDED
        run.finishedAt = Number(marker.committedAt || atMs)
        run.updatedAt = atMs
        run.lastFence = Number(run.lease && run.lease.fence || 0)
        run.lease = null
        run.errorCode = ''
        db.feishuSyncScheduler.lastSuccessAt = run.finishedAt
        releaseSchedulerLease(db, run.runId, expiredLease)
        return
      }
      if (run.state === STATES.APPLYING || run.state === STATES.COMMITTING) {
        const interruptedState = run.state
        run.state = STATES.UNKNOWN
        run.finishedAt = atMs
        run.updatedAt = atMs
        run.lastFence = Number(run.lease && run.lease.fence || 0)
        run.lease = null
        run.errorCode = interruptedState === STATES.COMMITTING ? 'COMMIT_FAILED' : 'APPLY_FAILED'
        db.feishuSyncScheduler.blockedRunId = run.runId
        releaseSchedulerLease(db, run.runId, expiredLease)
        return
      }
      if (RECOVERABLE_DRY_STATES.has(run.state)) {
        if (run.state !== STATES.QUEUED) run.recoveryCount = Number(run.recoveryCount || 0) + 1
        run.state = STATES.QUEUED
        run.updatedAt = atMs
        run.lastFence = Number(run.lease && run.lease.fence || 0)
        run.lease = null
        run.errorCode = ''
        releaseSchedulerLease(db, run.runId, expiredLease)
      }
    })

    const activeLease = db.feishuSyncScheduler.activeLease
    if (activeLease && (!Number.isFinite(Number(activeLease.expiresAt)) ||
        Number(activeLease.expiresAt) <= atMs)) {
      db.feishuSyncScheduler.activeLease = null
    }
    const scheduler = db.feishuSyncScheduler
    if (scheduler.leaseIntegrityBlockedRunId !== 'controller-state-invalid') {
      const leasedRuns = db.feishuSyncRuns.filter((run) =>
        run && !TERMINAL_STATES.has(run.state) && run.lease && !leaseExpired(run, atMs)
      )
      const orphanedRun = leasedRuns.find((run) =>
        !schedulerLeaseConsistent(db, run.runId, run.lease)
      )
      const activeRun = scheduler.activeLease
        ? runById(db, scheduler.activeLease.runId)
        : null
      const activeLeaseOrphaned = scheduler.activeLease &&
        (!activeRun || !activeRun.lease ||
          !schedulerLeaseConsistent(db, activeRun.runId, activeRun.lease))
      scheduler.leaseIntegrityBlockedRunId = orphanedRun
        ? orphanedRun.runId
        : (activeLeaseOrphaned ? String(scheduler.activeLease.runId || 'controller-state-invalid') : '')
    }
    const currentBlocker = runById(db, db.feishuSyncScheduler.blockedRunId)
    const currentBlockerStillRequired = currentBlocker && (
      [STATES.UNKNOWN, STATES.BLOCKED].includes(currentBlocker.state) ||
      isReconciledDryRunBarrier(currentBlocker)
    )
    if (!currentBlockerStillRequired) {
      const unresolved = db.feishuSyncRuns.find((run) =>
        run && [STATES.UNKNOWN, STATES.BLOCKED].includes(run.state)
      )
      db.feishuSyncScheduler.blockedRunId = unresolved ? unresolved.runId : ''
    }
  }

  function recover() {
    assertWriteLockEnabled()
    dbStore.updateDb((db) => reconcileInDb(db, Number(now())))
    return getStatus()
  }

  function resolveLegacyPrewriteDigestUnknown(input = {}) {
    assertWriteLockEnabled()
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const exactKeys = [
      'evidenceContract',
      'expectedErrorCode',
      'expectedMirrorPlanSha256',
      'runId'
    ]
    const receivedKeys = Object.keys(source).sort()
    const evidenceValid = JSON.stringify(receivedKeys) === JSON.stringify(exactKeys) &&
      source.evidenceContract === 'worker-v2-mirror-digest-before-first-write-v1' &&
      source.expectedErrorCode === 'MIRROR_PLAN_CHANGED' &&
      validSha256(source.expectedMirrorPlanSha256)
    if (!evidenceValid) {
      throw new WorkerError('LEGACY_PREWRITE_EVIDENCE_MISMATCH')
    }
    const runId = normalizeRunId(source.runId)
    let resolved = null
    dbStore.updateDb((db) => {
      ensureState(db)
      const run = runById(db, runId)
      const scheduler = db.feishuSyncScheduler
      const commitMarker = db.feishuSyncCommitMarkers && db.feishuSyncCommitMarkers[runId]
      const exactLegacyPrewriteEvidence = run &&
        Number(run.version) === 2 &&
        run.state === STATES.UNKNOWN &&
        run.dryRun !== true &&
        run.errorCode === source.expectedErrorCode &&
        run.mirrorPlanSha256 === source.expectedMirrorPlanSha256 &&
        run.externalWritesMayHaveOccurred === true &&
        Number.isSafeInteger(Number(run.applyIntentAt)) && Number(run.applyIntentAt) > 0 &&
        !Number(run.externalWriteIntentAt || 0) &&
        !Number(run.writeIntentEvidenceVersion || 0) &&
        Number(run.attemptCount) === 1 &&
        Number(run.recoveryCount || 0) === 0 &&
        !run.lease &&
        !run.commitMarkerSha256 &&
        !commitMarker &&
        !run.applyResultSummary &&
        !run.resultSummary &&
        scheduler.blockedRunId === runId &&
        !scheduler.activeLease
      if (!exactLegacyPrewriteEvidence) {
        throw new WorkerError('LEGACY_PREWRITE_EVIDENCE_MISMATCH')
      }
      const atMs = Number(now())
      run.state = STATES.FAILED_BEFORE_WRITE
      run.externalWritesMayHaveOccurred = false
      run.resolutionCode = 'LEGACY_MIRROR_DIGEST_PREWRITE_CONFIRMED'
      run.resolvedAt = atMs
      run.updatedAt = atMs
      scheduler.blockedRunId = ''
      const unresolved = db.feishuSyncRuns.find((item) => (
        item && item.runId !== runId && [STATES.UNKNOWN, STATES.BLOCKED].includes(item.state)
      ))
      if (unresolved) scheduler.blockedRunId = unresolved.runId
      resolved = clone(run)
    })
    return sanitizeRun(resolved)
  }

  function queuedContinuationSeedFromRun(run) {
    return {
      version: run.version,
      runId: run.runId,
      state: STATES.QUEUED,
      trigger: run.trigger,
      dryRun: run.dryRun,
      actorType: run.actorType,
      actorId: run.actorId,
      bucket: run.bucket,
      requestKeySha256: run.requestKeySha256,
      continuationOfRunId: run.continuationOfRunId,
      sourceUnknownRunSha256: run.sourceUnknownRunSha256,
      reconciliationEvidenceSha256: run.reconciliationEvidenceSha256,
      runNowMs: run.runNowMs,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      attemptCount: 0,
      recoveryCount: 0,
      externalWritesMayHaveOccurred: false,
      writeIntentEvidenceVersion: 1,
      lease: null,
      errorCode: ''
    }
  }

  function partialUnknownResolutionFieldsAbsent(run) {
    return [
      'continuationRunId',
      'continuationSeedSha256',
      'dryRunRetryRunId',
      'dryRunRetrySeedSha256',
      'reconciliationEvidence',
      'resolutionCode',
      'resolvedAt',
      'sourceUnknownUpdatedAt',
      'parentSourceUnknownRunSha256',
      'parentReconciliationEvidenceSha256'
    ].every((key) => !Object.prototype.hasOwnProperty.call(run || {}, key))
  }

  function exactPartialUnknownCore(run, commitMarker) {
    if (!run || run.version !== 3 || run.state !== STATES.UNKNOWN ||
        run.trigger !== 'manual' || run.actorType !== 'manual' || run.dryRun !== false ||
        run.errorCode !== 'UNKNOWN_ERROR' || run.externalWritesMayHaveOccurred !== true ||
        run.writeIntentEvidenceVersion !== 1 || run.attemptCount !== 1 ||
        run.recoveryCount !== 0 ||
        !Number.isSafeInteger(run.runNowMs) || run.runNowMs <= 0 ||
        !Number.isSafeInteger(run.createdAt) || run.createdAt !== run.runNowMs ||
        !Number.isSafeInteger(run.applyIntentAt) || run.applyIntentAt < run.runNowMs ||
        !Number.isSafeInteger(run.externalWriteIntentAt) ||
        run.externalWriteIntentAt !== run.applyIntentAt ||
        !Number.isSafeInteger(run.finishedAt) || run.finishedAt < run.externalWriteIntentAt ||
        !Number.isSafeInteger(run.updatedAt) || run.updatedAt !== run.finishedAt ||
        !validSha256(run.schemaSha256) || !validSha256(run.resourceIdentitySha256) ||
        !validSha256(run.mirrorPlanSha256) || !validSha256(run.contentPlanSha256) ||
        !Number.isSafeInteger(run.contentPlanAssetCount) || run.contentPlanAssetCount < 0 ||
        run.lease || run.commitMarkerSha256 || commitMarker ||
        run.applyResultSummary || run.resultSummary ||
        !partialUnknownResolutionFieldsAbsent(run)) return false
    try {
      normalizeActorId(run.actorId, '')
    } catch (error) {
      return false
    }
    return true
  }

  function validateUnknownContinuationLineage(db, unknownRun) {
    const runs = Array.isArray(db.feishuSyncRuns) ? db.feishuSyncRuns : []
    const commitMarkers = db.feishuSyncCommitMarkers || {}
    const runIndex = new Map()
    runs.forEach((run) => {
      if (!run || typeof run.runId !== 'string') return
      if (!runIndex.has(run.runId)) runIndex.set(run.runId, [])
      runIndex.get(run.runId).push(run)
    })
    const visited = new Set()
    let child = unknownRun
    let depth = 0

    while (true) {
      if (!child || visited.has(child.runId) ||
          !exactPartialUnknownCore(child, commitMarkers[child.runId])) {
        throw partialReconciliationFailure()
      }
      visited.add(child.runId)

      const hasParentRun = Object.prototype.hasOwnProperty.call(child, 'continuationOfRunId')
      const hasParentSource = Object.prototype.hasOwnProperty.call(
        child,
        'sourceUnknownRunSha256'
      )
      const hasParentEvidence = Object.prototype.hasOwnProperty.call(
        child,
        'reconciliationEvidenceSha256'
      )
      if (hasParentRun !== hasParentSource || hasParentRun !== hasParentEvidence) {
        throw partialReconciliationFailure()
      }
      if (!hasParentRun) return { depth, rootRunId: child.runId }
      if (depth >= MAX_RECONCILIATION_LINEAGE_DEPTH ||
          typeof child.continuationOfRunId !== 'string' ||
          !child.continuationOfRunId ||
          !validSha256(child.sourceUnknownRunSha256) ||
          !validSha256(child.reconciliationEvidenceSha256)) {
        throw partialReconciliationFailure()
      }

      const parentRunId = child.continuationOfRunId
      const parents = runIndex.get(parentRunId) || []
      const parent = parents.length === 1 ? parents[0] : null
      if (!parent || parent.state !== STATES.RECONCILED_PARTIAL ||
          visited.has(parentRunId) || parent.continuationRunId !== child.runId ||
          parent.version !== 3 || parent.trigger !== 'manual' ||
          parent.actorType !== 'manual' || parent.dryRun !== false ||
          parent.errorCode !== 'UNKNOWN_ERROR' ||
          parent.externalWritesMayHaveOccurred !== true ||
          parent.writeIntentEvidenceVersion !== 1 ||
          parent.attemptCount !== 1 || parent.recoveryCount !== 0 ||
          !Number.isSafeInteger(parent.resolvedAt) ||
          !Number.isSafeInteger(parent.finishedAt) || parent.resolvedAt <= parent.finishedAt ||
          parent.updatedAt !== parent.resolvedAt ||
          !validSha256(parent.sourceUnknownRunSha256) ||
          !validSha256(parent.reconciliationEvidenceSha256) ||
          !validSha256(parent.continuationSeedSha256) ||
          parent.actorId !== child.actorId ||
          child.sourceUnknownRunSha256 !== parent.sourceUnknownRunSha256 ||
          child.reconciliationEvidenceSha256 !== parent.reconciliationEvidenceSha256 ||
          commitMarkers[parentRunId] || commitMarkers[child.runId]) {
        throw partialReconciliationFailure()
      }

      let evidence
      let parentUnknown
      try {
        evidence = validatePartialReconciliationEvidence(parent.reconciliationEvidence, parent)
        parentUnknown = sourceUnknownRunFromResolved(parent)
      } catch (error) {
        throw partialReconciliationFailure()
      }
      const zeroWrite = isZeroBaseWriteEvidence(evidence)
      const expectedResolutionCode = zeroWrite
        ? 'ZERO_BASE_WRITES_RECONCILED'
        : 'PARTIAL_BASE_WRITES_RECONCILED'
      const expectedRequestKey = zeroWrite
        ? zeroWriteContinuationRequestKey(
            parentRunId,
            parent.sourceUnknownRunSha256,
            parent.reconciliationEvidenceSha256
          )
        : partialContinuationRequestKey(
            parentRunId,
            parent.sourceUnknownRunSha256,
            parent.reconciliationEvidenceSha256
          )
      if (parent.resolutionCode !== expectedResolutionCode ||
          parent.reconciliationEvidenceSha256 !== evidence.evidenceSha256 ||
          parent.sourceUnknownRunSha256 !== stableSha256(parentUnknown) ||
          !exactPartialUnknownCore(parentUnknown, commitMarkers[parentRunId]) ||
          child.version !== 3 || child.trigger !== 'manual' ||
          child.actorType !== 'manual' || child.dryRun !== zeroWrite ||
          child.bucket !== null || child.runNowMs !== parent.resolvedAt ||
          child.createdAt !== parent.resolvedAt ||
          child.requestKeySha256 !== expectedRequestKey ||
          stableSha256(queuedContinuationSeedFromRun(child)) !== parent.continuationSeedSha256) {
        throw partialReconciliationFailure()
      }

      child = parentUnknown
      depth += 1
    }
  }

  function zeroWriteDrySeedMatches(db, run, barrier, expectedRunId, expectedSeedSha256) {
    if (!run || !barrier || run.runId !== expectedRunId ||
        db.feishuSyncRuns.filter((item) => item && item.runId === run.runId).length !== 1 ||
        !validSha256(expectedSeedSha256) ||
        !isDryRunBoundToZeroWriteBarrier(run, barrier) ||
        run.version !== 3 || run.trigger !== 'manual' || run.actorType !== 'manual' ||
        run.actorId !== barrier.actorId || run.bucket !== null ||
        run.requestKeySha256 !== zeroWriteContinuationRequestKey(
          barrier.runId,
          barrier.sourceUnknownRunSha256,
          barrier.reconciliationEvidenceSha256
        ) ||
        !Number.isSafeInteger(run.runNowMs) || run.runNowMs !== run.createdAt ||
        run.createdAt < barrier.resolvedAt || run.writeIntentEvidenceVersion !== 1 ||
        run.externalWritesMayHaveOccurred === true || run.commitMarkerSha256 ||
        db.feishuSyncCommitMarkers && db.feishuSyncCommitMarkers[run.runId]) return false
    return stableSha256(queuedContinuationSeedFromRun(run)) === expectedSeedSha256
  }

  function isVerifiedZeroWriteBarrierInDb(db, run) {
    try {
      if (!isVerifiedZeroWriteBarrier(run) ||
          db.feishuSyncRuns.filter((item) => item && item.runId === run.runId).length !== 1 ||
          db.feishuSyncCommitMarkers && db.feishuSyncCommitMarkers[run.runId]) return false
      validateUnknownContinuationLineage(db, sourceUnknownRunFromResolved(run))
      const originalDry = runById(db, run.continuationRunId)
      if (!zeroWriteDrySeedMatches(
        db,
        originalDry,
        run,
        run.continuationRunId,
        run.continuationSeedSha256
      ) || originalDry.createdAt !== run.resolvedAt) return false
      const hasRetryRun = Object.prototype.hasOwnProperty.call(run, 'dryRunRetryRunId')
      const hasRetrySeed = Object.prototype.hasOwnProperty.call(run, 'dryRunRetrySeedSha256')
      if (hasRetryRun !== hasRetrySeed) return false
      if (hasRetryRun && !zeroWriteDrySeedMatches(
        db,
        runById(db, run.dryRunRetryRunId),
        run,
        run.dryRunRetryRunId,
        run.dryRunRetrySeedSha256
      )) return false
      return true
    } catch (error) {
      return false
    }
  }

  function isAuthorizedZeroWriteDryInDb(db, run, barrier) {
    if (!isVerifiedZeroWriteBarrierInDb(db, barrier)) return false
    const hasRetry = Object.prototype.hasOwnProperty.call(barrier, 'dryRunRetryRunId')
    const expectedRunId = hasRetry ? barrier.dryRunRetryRunId : barrier.continuationRunId
    const expectedSeedSha256 = hasRetry
      ? barrier.dryRunRetrySeedSha256
      : barrier.continuationSeedSha256
    return zeroWriteDrySeedMatches(db, run, barrier, expectedRunId, expectedSeedSha256)
  }

  function zeroWriteRecoveryBarrierCandidates(db) {
    const runs = Array.isArray(db.feishuSyncRuns) ? db.feishuSyncRuns : []
    const candidates = new Map()
    let orphanRecoveryDry = false
    runs.forEach((run) => {
      if (!run) return
      if (run.resolutionCode === 'ZERO_BASE_WRITES_RECONCILED' &&
          typeof run.runId === 'string' && run.runId) {
        candidates.set(run.runId, run)
      }
      const recoveryDry = run.dryRun === true &&
        typeof run.continuationOfRunId === 'string' && run.continuationOfRunId
      if (!recoveryDry) return
      const parents = runs.filter((item) => (
        item && item.runId === run.continuationOfRunId
      ))
      if (parents.length !== 1) {
        orphanRecoveryDry = true
        return
      }
      candidates.set(parents[0].runId, parents[0])
    })
    return { candidates: Array.from(candidates.values()), orphanRecoveryDry }
  }

  function zeroWriteBarrierCompletedInDb(db, barrier) {
    if (!isVerifiedZeroWriteBarrierInDb(db, barrier)) return false
    const hasRetry = Object.prototype.hasOwnProperty.call(barrier, 'dryRunRetryRunId')
    const activeRunId = hasRetry ? barrier.dryRunRetryRunId : barrier.continuationRunId
    const activeDry = runById(db, activeRunId)
    return isAuthorizedZeroWriteDryInDb(db, activeDry, barrier) &&
      activeDry.state === STATES.DRY_SUCCEEDED &&
      Number.isSafeInteger(activeDry.startedAt) && activeDry.startedAt >= activeDry.createdAt &&
      Number.isSafeInteger(activeDry.finishedAt) && activeDry.finishedAt >= activeDry.startedAt &&
      activeDry.updatedAt === activeDry.finishedAt &&
      Number.isSafeInteger(activeDry.attemptCount) && activeDry.attemptCount >= 1 &&
      Number.isSafeInteger(activeDry.lastFence) && activeDry.lastFence >= 1 &&
      !activeDry.lease && activeDry.externalWritesMayHaveOccurred !== true &&
      validSha256(activeDry.schemaSha256) &&
      validSha256(activeDry.resourceIdentitySha256) &&
      validSha256(activeDry.mirrorPlanSha256) &&
      validSha256(activeDry.contentPlanSha256) &&
      Number.isSafeInteger(activeDry.contentPlanAssetCount) &&
      activeDry.contentPlanAssetCount >= 0 &&
      activeDry.resultSummary && activeDry.resultSummary.dryRun === true
  }

  function assertZeroWriteBarrierPointerIntegrity(db) {
    const scheduler = db.feishuSyncScheduler || {}
    const { candidates, orphanRecoveryDry } = zeroWriteRecoveryBarrierCandidates(db)
    const pending = candidates.filter((barrier) => !zeroWriteBarrierCompletedInDb(db, barrier))
    if (orphanRecoveryDry || pending.length > 1) throw partialReconciliationFailure()
    if (pending.length === 1) {
      const barrier = pending[0]
      if (scheduler.blockedRunId !== barrier.runId ||
          !isVerifiedZeroWriteBarrierInDb(db, barrier)) {
        throw partialReconciliationFailure()
      }
      return barrier
    }
    const pointed = runById(db, scheduler.blockedRunId)
    if (pointed && candidates.some((barrier) => barrier.runId === pointed.runId)) {
      throw partialReconciliationFailure()
    }
    return null
  }

  function resolvedPartialContinuation(db, runId) {
    const resolvedRun = runById(db, runId)
    if (!resolvedRun || resolvedRun.state !== STATES.RECONCILED_PARTIAL) return null
    const continuation = runById(db, resolvedRun.continuationRunId)
    const scheduler = db.feishuSyncScheduler || {}
    const commitMarkers = db.feishuSyncCommitMarkers || {}
    let verifiedEvidence
    let verifiedSourceUnknownSha256
    try {
      verifiedEvidence = validatePartialReconciliationEvidence(
        resolvedRun.reconciliationEvidence,
        resolvedRun
      )
      verifiedSourceUnknownSha256 = sourceUnknownRunIdentityFromResolved(resolvedRun)
      validateUnknownContinuationLineage(db, sourceUnknownRunFromResolved(resolvedRun))
    } catch (error) {
      throw partialReconciliationFailure()
    }
    const zeroWrite = isZeroBaseWriteEvidence(verifiedEvidence)
    const expectedRequestKey = zeroWrite
      ? zeroWriteContinuationRequestKey(
          runId,
          resolvedRun.sourceUnknownRunSha256,
          resolvedRun.reconciliationEvidenceSha256
        )
      : partialContinuationRequestKey(
          runId,
          resolvedRun.sourceUnknownRunSha256,
          resolvedRun.reconciliationEvidenceSha256
        )
    const expectedResolutionCode = zeroWrite
      ? 'ZERO_BASE_WRITES_RECONCILED'
      : 'PARTIAL_BASE_WRITES_RECONCILED'
    if (resolvedRun.version !== 3 || resolvedRun.trigger !== 'manual' ||
        resolvedRun.actorType !== 'manual' || resolvedRun.dryRun !== false ||
        resolvedRun.errorCode !== 'UNKNOWN_ERROR' ||
        resolvedRun.externalWritesMayHaveOccurred !== true ||
        resolvedRun.resolutionCode !== expectedResolutionCode ||
        !Number.isSafeInteger(resolvedRun.resolvedAt) || resolvedRun.resolvedAt <= 0 ||
        !Number.isSafeInteger(resolvedRun.finishedAt) || resolvedRun.resolvedAt <= resolvedRun.finishedAt ||
        resolvedRun.updatedAt !== resolvedRun.resolvedAt ||
        resolvedRun.sourceUnknownRunSha256 !== verifiedSourceUnknownSha256 ||
        resolvedRun.reconciliationEvidenceSha256 !== verifiedEvidence.evidenceSha256 ||
        !validSha256(resolvedRun.continuationSeedSha256) ||
        Object.prototype.hasOwnProperty.call(resolvedRun, 'dryRunRetryRunId') ||
        Object.prototype.hasOwnProperty.call(resolvedRun, 'dryRunRetrySeedSha256') ||
        db.feishuSyncRuns.filter((run) => run && run.runId === runId).length !== 1 ||
        db.feishuSyncRuns.filter((run) => run && run.runId === resolvedRun.continuationRunId).length !== 1 ||
        !continuation || continuation.continuationOfRunId !== runId ||
        continuation.version !== 3 || continuation.trigger !== 'manual' ||
        continuation.actorType !== 'manual' || continuation.actorId !== resolvedRun.actorId ||
        continuation.dryRun !== zeroWrite || continuation.state !== STATES.QUEUED ||
        continuation.runNowMs !== resolvedRun.resolvedAt ||
        continuation.createdAt !== resolvedRun.resolvedAt ||
        continuation.updatedAt !== resolvedRun.resolvedAt ||
        continuation.sourceUnknownRunSha256 !== resolvedRun.sourceUnknownRunSha256 ||
        continuation.reconciliationEvidenceSha256 !== resolvedRun.reconciliationEvidenceSha256 ||
        continuation.requestKeySha256 !== expectedRequestKey ||
        stableSha256(continuation) !== resolvedRun.continuationSeedSha256 ||
        scheduler.blockedRunId !== (zeroWrite ? runId : '') ||
        scheduler.activeLease || scheduler.leaseIntegrityBlockedRunId ||
        scheduler.lastRunId !== continuation.runId ||
        commitMarkers[runId] || commitMarkers[continuation.runId]) {
      throw partialReconciliationFailure()
    }
    return {
      resolvedRun: sanitizeRun(resolvedRun),
      continuationRun: sanitizeRun(continuation)
    }
  }

  function exactPartialUnknownRun(db, runId) {
    ensureState(db)
    const run = runById(db, runId)
    const exactRunCount = db.feishuSyncRuns.filter((item) => item && item.runId === runId).length
    const scheduler = db.feishuSyncScheduler
    const commitMarker = db.feishuSyncCommitMarkers && db.feishuSyncCommitMarkers[runId]
    const otherUnsafeRun = db.feishuSyncRuns.find((item) => (
      item && item.runId !== runId && (
        !TERMINAL_STATES.has(item.state) ||
        [STATES.UNKNOWN, STATES.BLOCKED].includes(item.state)
      )
    ))
    const exact = exactRunCount === 1 && exactPartialUnknownCore(run, commitMarker) &&
      scheduler.blockedRunId === runId && !scheduler.activeLease &&
      !scheduler.leaseIntegrityBlockedRunId && !otherUnsafeRun
    if (!exact) throw partialReconciliationFailure()
    try {
      validateUnknownContinuationLineage(db, run)
    } catch (error) {
      throw partialReconciliationFailure()
    }
    return run
  }

  function partialUnknownIdentity(run) {
    return stableSha256(run)
  }

  async function resolveAndEnqueueReconciledPartial(runIdInput) {
    assertWriteLockEnabled()
    const runId = normalizeRunId(runIdInput)
    const initialDb = clone(dbStore.readDb())
    ensureState(initialDb)
    const alreadyResolved = resolvedPartialContinuation(initialDb, runId)
    if (alreadyResolved) return alreadyResolved
    const frozenRun = clone(exactPartialUnknownRun(initialDb, runId))
    const frozenBusinessSha256 = stableSha256(businessSnapshot(initialDb))
    if (typeof feishuSync.reconcilePartialBaseWrites !== 'function') {
      throw partialReconciliationFailure()
    }

    let evidence
    try {
      evidence = validatePartialReconciliationEvidence(
        await feishuSync.reconcilePartialBaseWrites(businessSnapshot(initialDb), {
          externalWriteIntentAt: frozenRun.externalWriteIntentAt,
          expectedMirrorPlanSha256: frozenRun.mirrorPlanSha256,
          expectedResourceIdentitySha256: frozenRun.resourceIdentitySha256,
          expectedSchemaSha256: frozenRun.schemaSha256,
          runId: frozenRun.runId,
          runNowMs: frozenRun.runNowMs
        }),
        frozenRun
      )
    } catch (error) {
      throw partialReconciliationFailure()
    }

    let resolved = null
    dbStore.updateDb((db) => {
      ensureState(db)
      const concurrentResolution = resolvedPartialContinuation(db, runId)
      if (concurrentResolution) {
        resolved = concurrentResolution
        return
      }
      const currentRun = exactPartialUnknownRun(db, runId)
      if (partialUnknownIdentity(currentRun) !== partialUnknownIdentity(frozenRun)) {
        throw partialReconciliationFailure()
      }
      if (stableSha256(businessSnapshot(db)) !== frozenBusinessSha256) {
        throw partialReconciliationFailure()
      }
      const confirmedEvidence = validatePartialReconciliationEvidence(evidence, currentRun)
      const zeroWrite = isZeroBaseWriteEvidence(confirmedEvidence)
      const atMs = Number(now())
      if (!Number.isSafeInteger(atMs) || atMs <= currentRun.finishedAt) {
        throw partialReconciliationFailure()
      }
      const continuationRunId = nextRunId()
      if (runById(db, continuationRunId)) throw partialReconciliationFailure()
      const sourceUnknownRunSha256 = stableSha256(frozenRun)
      const requestKeySha256 = zeroWrite
        ? zeroWriteContinuationRequestKey(
            runId,
            sourceUnknownRunSha256,
            confirmedEvidence.evidenceSha256
          )
        : partialContinuationRequestKey(
            runId,
            sourceUnknownRunSha256,
            confirmedEvidence.evidenceSha256
          )
      const continuation = {
        version: 3,
        runId: continuationRunId,
        state: STATES.QUEUED,
        trigger: 'manual',
        dryRun: zeroWrite,
        actorType: 'manual',
        actorId: normalizeActorId(currentRun.actorId, ''),
        bucket: null,
        requestKeySha256,
        continuationOfRunId: runId,
        sourceUnknownRunSha256,
        reconciliationEvidenceSha256: confirmedEvidence.evidenceSha256,
        runNowMs: atMs,
        createdAt: atMs,
        updatedAt: atMs,
        attemptCount: 0,
        recoveryCount: 0,
        externalWritesMayHaveOccurred: false,
        writeIntentEvidenceVersion: 1,
        lease: null,
        errorCode: ''
      }
      if (Object.prototype.hasOwnProperty.call(currentRun, 'continuationOfRunId')) {
        currentRun.parentSourceUnknownRunSha256 = currentRun.sourceUnknownRunSha256
        currentRun.parentReconciliationEvidenceSha256 = currentRun.reconciliationEvidenceSha256
      }
      currentRun.state = STATES.RECONCILED_PARTIAL
      currentRun.resolutionCode = zeroWrite
        ? 'ZERO_BASE_WRITES_RECONCILED'
        : 'PARTIAL_BASE_WRITES_RECONCILED'
      currentRun.resolvedAt = atMs
      currentRun.updatedAt = atMs
      currentRun.reconciliationEvidenceSha256 = confirmedEvidence.evidenceSha256
      currentRun.reconciliationEvidence = clone(confirmedEvidence)
      currentRun.continuationRunId = continuationRunId
      currentRun.sourceUnknownRunSha256 = sourceUnknownRunSha256
      currentRun.sourceUnknownUpdatedAt = frozenRun.updatedAt
      currentRun.continuationSeedSha256 = stableSha256(continuation)
      db.feishuSyncRuns.unshift(continuation)
      db.feishuSyncScheduler.blockedRunId = zeroWrite ? runId : ''
      db.feishuSyncScheduler.lastRunId = continuationRunId
      trimRuns(db, maxRuns)
      resolved = {
        resolvedRun: sanitizeRun(currentRun),
        continuationRun: sanitizeRun(continuation)
      }
    })
    if (!resolved) throw partialReconciliationFailure()
    return resolved
  }

  function claim(runId, workerId) {
    assertWriteLockEnabled()
    const atMs = Number(now())
    const owner = sha256(String(workerId || randomId('worker')))
    let claimResult = null
    dbStore.updateDb((db) => {
      reconcileInDb(db, atMs)
      const scheduler = db.feishuSyncScheduler
      if (scheduler.leaseIntegrityBlockedRunId) return
      const blocked = Boolean(scheduler.blockedRunId)
      let run = runId
        ? runById(db, runId)
        : db.feishuSyncRuns.find((item) =>
          item.state === STATES.QUEUED && (!blocked || item.dryRun === true)
        )
      if (!run) return
      if (TERMINAL_STATES.has(run.state)) {
        claimResult = { terminal: clone(run) }
        return
      }
      if (run.state !== STATES.QUEUED || !leaseExpired(run, atMs)) return
      if (blocked && run.dryRun !== true) return
      if (scheduler.activeLease && Number(scheduler.activeLease.expiresAt) > atMs) return

      const reconciliationBarrier = runById(db, scheduler.blockedRunId)
      if (isReconciledDryRunBarrier(reconciliationBarrier) &&
          !isAuthorizedZeroWriteDryInDb(db, run, reconciliationBarrier)) {
        throw partialReconciliationFailure()
      }

      scheduler.nextFence += 1
      const fence = scheduler.nextFence
      const lease = {
        runId: run.runId,
        owner,
        fence,
        acquiredAt: atMs,
        expiresAt: atMs + leaseMs
      }
      run.state = STATES.DRY_RUNNING
      run.startedAt = run.startedAt || atMs
      run.updatedAt = atMs
      run.attemptCount = Number(run.attemptCount || 0) + 1
      run.errorCode = ''
      run.lease = clone(lease)
      scheduler.activeLease = clone(lease)
      claimResult = {
        run: clone(run),
        owner,
        fence,
        baseDb: businessSnapshot(db)
      }
    })
    return claimResult
  }

  function mutateClaimed(runId, claimInfo, allowedStates, mutator) {
    const atMs = Number(now())
    return dbStore.updateDb((db) => {
      ensureState(db)
      const run = runById(db, runId)
      const schedulerLease = db.feishuSyncScheduler.activeLease
      const validLease = run && run.lease && schedulerLease &&
        run.lease.owner === claimInfo.owner &&
        Number(run.lease.fence) === Number(claimInfo.fence) &&
        Number(run.lease.expiresAt) > atMs &&
        schedulerLeaseConsistent(db, runId, run.lease) &&
        Number(schedulerLease.expiresAt) > atMs
      if (!validLease || (allowedStates && !allowedStates.includes(run.state))) {
        throw new WorkerError('LEASE_LOST', '', { safeBeforeWrite: true })
      }
      run.updatedAt = atMs
      run.lease.expiresAt = atMs + leaseMs
      schedulerLease.expiresAt = atMs + leaseMs
      return mutator(run, db, atMs)
    })
  }

  function startHeartbeat(runId, claimInfo) {
    if (!heartbeatEnabled) return { stop() {}, lost: () => false }
    let lost = false
    const timer = setIntervalFn(() => {
      if (lost) return
      try {
        mutateClaimed(runId, claimInfo, null, () => true)
      } catch (error) {
        lost = true
      }
    }, Math.max(250, Math.floor(leaseMs / 3)))
    if (timer && typeof timer.unref === 'function') timer.unref()
    return {
      stop() { clearIntervalFn(timer) },
      lost: () => lost
    }
  }

  function recordFailure(runId, claimInfo, error) {
    const code = safeErrorCode(error)
    const safeBeforeWrite = error && error.safeBeforeWrite === true || safeBeforeWriteCodes.has(code)
    const requestedState = error && error.blocked === true
      ? STATES.BLOCKED
      : (safeBeforeWrite ? STATES.FAILED_BEFORE_WRITE : STATES.UNKNOWN)
    try {
      mutateClaimed(runId, claimInfo, null, (run, db, atMs) => {
        const writeIntentReached = run.externalWritesMayHaveOccurred === true ||
          run.state === STATES.APPLYING || run.state === STATES.COMMITTING
        const state = writeIntentReached ? STATES.UNKNOWN : requestedState
        run.state = state
        run.finishedAt = atMs
        run.errorCode = code
        const finishedLease = clone(run.lease)
        run.lastFence = Number(finishedLease.fence)
        run.lease = null
        releaseSchedulerLease(db, runId, finishedLease)
        const existingBarrier = runById(db, db.feishuSyncScheduler.blockedRunId)
        const existingReconciledBarrier = isReconciledDryRunBarrier(existingBarrier)
        const preserveZeroWriteParentBarrier = state === STATES.BLOCKED &&
          existingReconciledBarrier
        if ((state === STATES.BLOCKED || state === STATES.UNKNOWN) &&
            !preserveZeroWriteParentBarrier) {
          db.feishuSyncScheduler.blockedRunId = runId
        }
      })
    } catch (transitionError) {
      if (safeErrorCode(transitionError) !== 'LEASE_LOST') throw transitionError
    }
    return readRun(runId)
  }

  function makeCommitMarker(run, claimInfo, atMs) {
    const body = {
      runId: run.runId,
      fence: claimInfo.fence,
      schemaSha256: run.schemaSha256,
      resourceIdentitySha256: run.resourceIdentitySha256,
      mirrorPlanSha256: run.mirrorPlanSha256,
      contentPlanSha256: run.contentPlanSha256,
      contentPlanAssetCount: run.contentPlanAssetCount,
      committedAt: atMs
    }
    return { ...body, markerSha256: sha256(JSON.stringify(body)) }
  }

  async function executeClaim(claimInfo, options = {}) {
    const runId = claimInfo.run.runId
    const workerLeaseId = claimInfo.owner
    const actorId = normalizeActorId(
      claimInfo.run && claimInfo.run.actorId,
      settings.systemActorId || 'system:feishu-sync-worker'
    )
    const heartbeat = startHeartbeat(runId, claimInfo)
    try {
      let captured = null
      const dryDb = clone(claimInfo.baseDb)
      let dryResult
      try {
        dryResult = await feishuSync.sync(dryDb, actorId, {
          dryRun: true,
          syncController: 'worker-v2',
          disableLegacyMaterials: true,
          runId,
          nowMs: claimInfo.run.runNowMs,
          _captureContentPlanConfirmation(value) {
            captured = value
          }
        })
      } catch (error) {
        throw markSafeBeforeWrite(error, 'DRY_RUN_FAILED')
      }
      if (heartbeat.lost()) throw new WorkerError('LEASE_LOST', '', { safeBeforeWrite: true })
      mutateClaimed(runId, claimInfo, [STATES.DRY_RUNNING], () => true)

      const schemaBindings = validateSchemaBindings(dryResult)
      const candidateDigests = extractDigests(dryResult, captured)
      mutateClaimed(runId, claimInfo, [STATES.DRY_RUNNING], (run) => {
        if (schemaBindings.length) run.schemaBindings = schemaBindings
        if (validSha256(candidateDigests.schemaSha256)) {
          run.schemaSha256 = candidateDigests.schemaSha256
        }
        if (validSha256(candidateDigests.resourceIdentitySha256)) {
          run.resourceIdentitySha256 = candidateDigests.resourceIdentitySha256
        }
        if (validSha256(candidateDigests.mirrorPlanSha256)) {
          run.mirrorPlanSha256 = candidateDigests.mirrorPlanSha256
        }
        if (validSha256(candidateDigests.contentPlanSha256)) {
          run.contentPlanSha256 = candidateDigests.contentPlanSha256
        }
        if (Number.isSafeInteger(Number(candidateDigests.contentPlanAssetCount)) &&
            Number(candidateDigests.contentPlanAssetCount) >= 0) {
          run.contentPlanAssetCount = Number(candidateDigests.contentPlanAssetCount)
        }
      })
      const digests = validateDryResult(
        dryResult,
        captured,
        approvedSchemaSha256,
        approvedResourceIdentitySha256,
        {
          requireApprovedSchema: claimInfo.run.dryRun !== true
        }
      )
      if (claimInfo.run.dryRun === true) {
        mutateClaimed(runId, claimInfo, [STATES.DRY_RUNNING], (run, db, atMs) => {
          run.state = STATES.DRY_SUCCEEDED
          run.mirrorPlanSha256 = digests.mirrorPlanSha256
          run.schemaSha256 = digests.schemaSha256
          run.resourceIdentitySha256 = digests.resourceIdentitySha256
          run.contentPlanSha256 = digests.contentPlanSha256
          run.contentPlanAssetCount = digests.contentPlanAssetCount
          run.resultSummary = summarizeResult(dryResult)
          run.finishedAt = atMs
          const finishedLease = clone(run.lease)
          run.lastFence = Number(finishedLease.fence)
          run.lease = null
          releaseSchedulerLease(db, runId, finishedLease)
          run.errorCode = digests.committableMaterialWarning
            ? 'MATERIALS_PARTIAL_DRY_RUN'
            : ''
          db.feishuSyncScheduler.lastDryRunAt = atMs
          const reconciliationBarrier = runById(db, db.feishuSyncScheduler.blockedRunId)
          if (isAuthorizedZeroWriteDryInDb(db, run, reconciliationBarrier)) {
            db.feishuSyncScheduler.blockedRunId = ''
          }
        })
        return readRun(runId)
      }
      mutateClaimed(runId, claimInfo, [STATES.DRY_RUNNING], (run) => {
        run.state = STATES.READY_TO_APPLY
        run.mirrorPlanSha256 = digests.mirrorPlanSha256
        run.schemaSha256 = digests.schemaSha256
        run.resourceIdentitySha256 = digests.resourceIdentitySha256
        run.contentPlanSha256 = digests.contentPlanSha256
        run.contentPlanAssetCount = digests.contentPlanAssetCount
        run.dryResultSummary = summarizeResult(dryResult)
      })

      let applyBase
      try {
        applyBase = businessSnapshot(dbStore.readDb())
      } catch (error) {
        throw markSafeBeforeWrite(error, 'SOURCE_READ_FAILED')
      }
      const nextDb = clone(applyBase)
      let applyDigests = null
      let applyPlanFreezeCount = 0
      const onApplyPlanFrozen = (candidate) => {
        if (heartbeat.lost()) throw new WorkerError('LEASE_LOST', '', { safeBeforeWrite: true })
        applyPlanFreezeCount += 1
        if (applyPlanFreezeCount !== 1 || applyDigests) {
          throw new WorkerError('MIRROR_PREFLIGHT_FAILED', '', { safeBeforeWrite: true })
        }
        const frozen = validateFrozenApplyPlan(candidate, digests)
        // 必须先在受租约保护的事务中落盘 B，再允许内存门开启；落盘失败时外部写永远不能开始。
        mutateClaimed(runId, claimInfo, [STATES.READY_TO_APPLY], (run) => {
          run.mirrorPlanSha256 = frozen.mirrorPlanSha256
        })
        applyDigests = frozen
      }
      // 正式函数允许先执行只读复验。只有 Base、Drive 或 OSS 即将派发首个真实写请求时，
      // 适配器才同步调用此门；门先原子持久化，失败则抛错并阻止外部请求发出。
      const onExternalWriteDispatched = () => {
        if (!applyDigests || applyPlanFreezeCount !== 1) {
          throw new WorkerError('MIRROR_PREFLIGHT_FAILED', '', { safeBeforeWrite: true })
        }
        if (heartbeat.lost()) throw new WorkerError('LEASE_LOST', '', { safeBeforeWrite: true })
        mutateClaimed(runId, claimInfo, [STATES.READY_TO_APPLY, STATES.APPLYING], (run, db, atMs) => {
          if (run.externalWritesMayHaveOccurred === true) return
          run.state = STATES.APPLYING
          run.externalWritesMayHaveOccurred = true
          run.applyIntentAt = atMs
          run.externalWriteIntentAt = atMs
          run.writeIntentEvidenceVersion = 1
        })
      }
      const applyResult = await feishuSync.sync(nextDb, actorId, {
        dryRun: false,
        syncController: 'worker-v2',
        disableLegacyMaterials: true,
        runId,
        nowMs: claimInfo.run.runNowMs,
        expectedSchemaSha256: digests.schemaSha256,
        expectedResourceIdentitySha256: digests.resourceIdentitySha256,
        expectedMirrorPlanSha256: digests.mirrorPlanSha256,
        expectedContentPlanSha256: digests.contentPlanSha256,
        expectedContentAssetCount: digests.contentPlanAssetCount,
        onApplyPlanFrozen,
        onExternalWriteDispatched
      })
      if (heartbeat.lost()) throw new WorkerError('LEASE_LOST')
      mutateClaimed(runId, claimInfo, [STATES.READY_TO_APPLY, STATES.APPLYING], () => true)
      if (!applyDigests || applyPlanFreezeCount !== 1) {
        throw new WorkerError('MIRROR_PREFLIGHT_FAILED', '', { safeBeforeWrite: true })
      }
      const applyValidation = validateApplyResult(applyResult, applyDigests)
      const applyWarningCode = applyValidation.committableMaterialWarning
        ? 'MATERIALS_PARTIAL_FAILURE'
        : ''

      let marker = null
      mutateClaimed(runId, claimInfo, [STATES.READY_TO_APPLY, STATES.APPLYING], (run, db, atMs) => {
        run.state = STATES.COMMITTING
        run.applyResultSummary = summarizeResult(applyResult)
        marker = makeCommitMarker(run, claimInfo, atMs)
        run.commitMarkerSha256 = marker.markerSha256
      })

      let commitResult
      try {
        commitResult = await commitDeltaChecked(applyBase, nextDb, {
          runId,
          workerId: workerLeaseId,
          fence: claimInfo.fence,
          excludedTopLevelKeys: CONTROL_KEYS.slice(),
          commitMarker: marker,
          finalize(freshDb) {
            ensureState(freshDb)
            const freshRun = runById(freshDb, runId)
            const schedulerLease = freshDb.feishuSyncScheduler.activeLease
            if (!freshRun || freshRun.state !== STATES.COMMITTING || !freshRun.lease ||
                freshRun.lease.owner !== claimInfo.owner ||
                Number(freshRun.lease.fence) !== Number(claimInfo.fence) ||
                !schedulerLeaseConsistent(freshDb, runId, freshRun.lease) ||
                Number(freshRun.lease.expiresAt) <= Number(now()) ||
                Number(schedulerLease.expiresAt) <= Number(now())) {
              throw new WorkerError('LEASE_LOST')
            }
            const committedMarker = freshDb.feishuSyncCommitMarkers[runId]
            if (!markerMatches(freshRun, committedMarker)) {
              throw new WorkerError('COMMIT_FAILED')
            }
            const committedAt = Number(committedMarker.committedAt || now())
            freshRun.state = STATES.SUCCEEDED
            freshRun.finishedAt = committedAt
            freshRun.updatedAt = committedAt
            freshRun.resultSummary = summarizeResult(applyResult)
            const finishedLease = clone(freshRun.lease)
            freshRun.lastFence = Number(finishedLease.fence)
            freshRun.lease = null
            releaseSchedulerLease(freshDb, runId, finishedLease)
            freshRun.errorCode = applyWarningCode
            if (applyWarningCode) {
              freshDb.feishuSyncScheduler.lastWarningAt = committedAt
            } else {
              freshDb.feishuSyncScheduler.lastSuccessAt = committedAt
            }
            if (freshDb.feishuSyncScheduler.blockedRunId === runId) {
              freshDb.feishuSyncScheduler.blockedRunId = ''
            }
          }
        })
      } catch (error) {
        if (safeErrorCode(error) === 'LEASE_LOST') throw error
        throw new WorkerError('COMMIT_FAILED')
      }
      if (!commitResult || commitResult.committed !== true) {
        throw new WorkerError('COMMIT_FAILED')
      }
      return readRun(runId)
    } catch (error) {
      return recordFailure(runId, claimInfo, error)
    } finally {
      heartbeat.stop()
    }
  }

  async function run(runId, options = {}) {
    const normalized = normalizeRunId(runId)
    const claimInfo = claim(normalized, options.workerId)
    if (!claimInfo) return null
    if (claimInfo.terminal) return sanitizeRun(claimInfo.terminal)
    return executeClaim(claimInfo, options)
  }

  async function runNext(options = {}) {
    const claimInfo = claim(null, options.workerId)
    if (!claimInfo) return null
    if (claimInfo.terminal) return sanitizeRun(claimInfo.terminal)
    return executeClaim(claimInfo, options)
  }

  async function tick(options = {}) {
    const atMs = Number.isSafeInteger(options.scheduledAt) ? options.scheduledAt : Number(now())
    const enqueued = enqueue({
      trigger: 'scheduled',
      scheduledAt: atMs,
      idempotencyKey: `scheduled:${schedulerBucket(atMs)}`
    })
    const result = await run(enqueued.runId, {
      workerId: options.workerId,
      actorId: options.actorId
    })
    return { enqueued, result }
  }

  return {
    enqueue,
    tick,
    runNext,
    run,
    recover,
    resolveLegacyPrewriteDigestUnknown,
    resolveAndEnqueueReconciledPartial,
    getStatus,
    status: getStatus
  }
}

module.exports = {
  STATES,
  createFeishuSyncWorker,
  _internal: {
    CONTROL_KEYS,
    businessSnapshot,
    extractDigests,
    validateDryResult,
    validateApplyResult,
    validateFrozenApplyPlan,
    sanitizeRun,
    sanitizeSchemaBindings,
    markerMatches,
    validatePartialReconciliationEvidence,
    safeErrorCode
  }
}
