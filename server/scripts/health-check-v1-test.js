'use strict'

// 健康巡检 health-check.js 纯函数锁定测试：evaluateDb / parseDfFreePct / aggregate。

const assert = require('assert')
const { execFileSync, spawn, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const hc = require('./health-check')

// 1) evaluateDb：有效 / BOM / 坏 JSON / 缺 listings。
{
  const good = hc.evaluateDb(JSON.stringify({ listings: [1, 2, 3], users: [1] }))
  assert.strictEqual(good.ok, true, '有效 db ok')
  assert.strictEqual(good.listings, 3, 'listings 计数')
  assert.strictEqual(good.users, 1, 'users 计数')

  const bom = hc.evaluateDb('﻿' + JSON.stringify({ listings: [1], users: [] }))
  assert.strictEqual(bom.ok, true, 'BOM 前缀仍可解析')
  assert.strictEqual(bom.listings, 1, 'BOM 后 listings')

  assert.strictEqual(hc.evaluateDb('{ not json ').ok, false, '坏 JSON → false')
  assert.strictEqual(hc.evaluateDb(JSON.stringify({ users: [] })).ok, false, '缺 listings 数组 → false')
}

// 2) parseDfFreePct：正常 / 低余量告警 / 坏输出。
{
  const df = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41152000 20000000 21152000 49% /'
  const r = hc.parseDfFreePct(df, 10)
  assert.strictEqual(r.ok, true, '余量充足 ok')
  assert.strictEqual(r.freePct, 51, 'freePct≈51')

  const low = 'Header\n/dev/vda1 41152000 39000000 2152000 95% /'
  const rl = hc.parseDfFreePct(low, 10)
  assert.strictEqual(rl.ok, false, '低余量 → false')
  assert.ok(rl.freePct < 10, 'freePct<10')

  assert.strictEqual(hc.parseDfFreePct('garbage-single-line', 10).ok, false, '坏 df 输出 → false')
  assert.strictEqual(hc.parseDfFreePct('', 10).ok, false, '空 df → false')
}

// 3) aggregate：全通过 / 部分失败（skipped 不算失败）/ 空。
{
  const allOk = hc.aggregate([{ name: 'a', ok: true }, { name: 'b', ok: true }])
  assert.strictEqual(allOk.ok, true)
  assert.deepStrictEqual(allOk.failures, [])

  const someFail = hc.aggregate([{ name: 'db', ok: true }, { name: 'disk', ok: false }, { name: 'backup', ok: true, skipped: 'x' }])
  assert.strictEqual(someFail.ok, false, '有 ok:false → 整体失败')
  assert.deepStrictEqual(someFail.failures, ['disk'], 'failures 只列 ok:false 的名字')

  assert.strictEqual(hc.aggregate([]).ok, true, '空 checks 视为 ok')
}

// 4) 无凭据字段：结果 JSON 里不出现 secret/token/password/加密密钥。
{
  const r = hc.aggregate([{ name: 'db', ...hc.evaluateDb(JSON.stringify({ listings: [], users: [] })) }])
  assert.strictEqual(/secret|password|token|BACKUP_ENCRYPTION_KEY/i.test(JSON.stringify(r)), false, '巡检结果不得含凭据类字段')
}

// 5) buildAlertEnv：告警子进程环境走白名单——拿不到备份/飞书凭据，但拿得到系统变量与本次摘要。
//    buildAlertEnv 是告警命令 env 的唯一来源（alertIfNeeded 只用它），所以锁住它即锁住子进程环境。
{
  const src = {
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    SystemRoot: 'C:\\Windows',
    BACKUP_ENCRYPTION_KEY: 'LEAK_PROBE_BACKUP_KEY',
    BACKUP_REMOTE_CMD: 'rsync ...',
    FEISHU_BACKUP_APP_SECRET: 'LEAK_PROBE_FEISHU_SECRET',
    FEISHU_BACKUP_APP_ID: 'cli_probe',
    FEISHU_BACKUP_FOLDER_TOKEN: 'fldxxx',
    SOME_API_TOKEN: 't',
    DB_PASSWORD: 'p',
    HEALTH_ALERT_WEBHOOK: 'https://example.invalid/hook'
  }
  const env = hc.buildAlertEnv(src, { HEALTH_FAILURES: 'disk', HEALTH_SUMMARY: '{"ok":false}' })

  // 摘要与系统变量：保留。
  assert.strictEqual(env.HEALTH_FAILURES, 'disk', '摘要 HEALTH_FAILURES 传入')
  assert.strictEqual(env.HEALTH_SUMMARY, '{"ok":false}', '摘要 HEALTH_SUMMARY 传入')
  assert.strictEqual(env.PATH, '/usr/bin:/bin', '系统 PATH 保留（命令得以运行）')
  assert.strictEqual(env.HOME, '/root', '系统 HOME 保留')
  assert.strictEqual(env.SystemRoot, 'C:\\Windows', 'Windows SystemRoot 保留')
  assert.strictEqual(env.HEALTH_ALERT_WEBHOOK, 'https://example.invalid/hook', 'HEALTH_ALERT_* 专用变量保留')

  // 敏感凭据：一律拿不到。
  assert.strictEqual('BACKUP_ENCRYPTION_KEY' in env, false, '备份加密密钥不得透传')
  assert.strictEqual('BACKUP_REMOTE_CMD' in env, false, '备份异地命令不得透传')
  assert.strictEqual('FEISHU_BACKUP_APP_SECRET' in env, false, '飞书 secret 不得透传')
  assert.strictEqual('FEISHU_BACKUP_APP_ID' in env, false, '飞书 app id 不得透传')
  assert.strictEqual('FEISHU_BACKUP_FOLDER_TOKEN' in env, false, '飞书 folder token 不得透传')
  assert.strictEqual('SOME_API_TOKEN' in env, false, 'TOKEN 类不得透传')
  assert.strictEqual('DB_PASSWORD' in env, false, 'PASSWORD 类不得透传')

  // 整体断言：环境值里不出现任何泄漏探针值。
  assert.strictEqual(/LEAK_PROBE/.test(JSON.stringify(env)), false, '告警环境里不得含任何泄漏探针值')

  // 空/非法入参不崩。
  assert.deepStrictEqual(hc.buildAlertEnv(null, null), {}, 'null 入参返回空对象')
}

// 6) 自动同步健康：关闭时明确跳过；开启后必须使用 worker-v2、无 UNKNOWN/BLOCKED，
//    且最近一次成功不能长期陈旧。巡检只输出阶段/时间/计数，不回显任务错误正文或外部标识。
{
  const nowMs = Date.parse('2026-08-02T04:00:00.000Z')
  const healthMarkers = {}
  const trustedHealthRun = (overrides = {}) => {
    const run = {
      version: 3,
      runId: `trusted-health-${Object.keys(healthMarkers).length + 1}`,
      state: 'succeeded',
      dryRun: false,
      trigger: 'scheduled',
      finishedAt: nowMs - 60_000,
      lease: null,
      errorCode: '',
      lastFence: 1,
      schemaSha256: '1'.repeat(64),
      resourceIdentitySha256: '2'.repeat(64),
      mirrorPlanSha256: '3'.repeat(64),
      contentPlanSha256: '4'.repeat(64),
      contentPlanAssetCount: 0,
      resultSummary: { success: true, complete: true, dryRun: false, failed: 0, created: 1, updated: 1, down: 0 },
      ...overrides
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, 'updatedAt')) run.updatedAt = run.finishedAt
    if (!Object.prototype.hasOwnProperty.call(overrides, 'applyResultSummary')) {
      run.applyResultSummary = { ...run.resultSummary }
    }
    const markerBody = {
      runId: run.runId,
      fence: run.lastFence,
      schemaSha256: run.schemaSha256,
      resourceIdentitySha256: run.resourceIdentitySha256,
      mirrorPlanSha256: run.mirrorPlanSha256,
      contentPlanSha256: run.contentPlanSha256,
      contentPlanAssetCount: run.contentPlanAssetCount,
      committedAt: run.finishedAt
    }
    const markerSha256 = crypto.createHash('sha256').update(JSON.stringify(markerBody)).digest('hex')
    run.commitMarkerSha256 = markerSha256
    healthMarkers[run.runId] = { ...markerBody, markerSha256 }
    return run
  }
  const trustedHealthDb = (runs, markers = healthMarkers) => ({
    feishuSyncRuns: runs,
    feishuSyncCommitMarkers: markers
  })
  const disabled = hc.evaluateFeishuSyncState({}, {
    nowMs,
    autoSyncEnabled: false,
    controllerMode: '',
    intervalMinutes: 30
  })
  assert.strictEqual(disabled.ok, true)
  assert.strictEqual(disabled.skipped, '自动同步未启用')

  const disabledFailed = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{
      version: 3,
      runId: 'formal-disabled-failed-before-write',
      state: 'failed-before-write',
      dryRun: false,
      trigger: 'manual',
      finishedAt: nowMs - 1000,
      updatedAt: nowMs - 1000,
      errorCode: 'SOURCE_VALIDATION_FAILED'
    }]
  }, { nowMs, autoSyncEnabled: false })
  assert.strictEqual(disabledFailed.ok, false, '关闭自动同步也不得漏报最新普通 V3 正式任务的写入前失败')
  assert.strictEqual(disabledFailed.detail, '同步前检查没有通过，本次没有更新小程序房源', '写入前失败必须给业务可读影响')
  const failedBeforeWriteAlert = require('./send-feishu-alert').buildText({
    HEALTH_FAILURES: 'feishuSync',
    HEALTH_SUMMARY: JSON.stringify(hc.aggregate([{ name: 'feishuSync', ...disabledFailed }]))
  }, [])
  assert.ok(failedBeforeWriteAlert.includes('同步前检查没有通过，本次没有更新小程序房源'), '写入前失败外发时不得退化成原因尚未确认')
  assert.ok(failedBeforeWriteAlert.includes('影响：本次小程序房源可能还不是最新；安排带看前请先向管家确认房态'), '同步健康告警必须直接说明业务影响')
  assert.ok(failedBeforeWriteAlert.includes('把排查编号发给技术人员；在确认前不要重复点击同步'), '同步失败必须告诉业务人员下一步怎么做')

  for (const inProgressState of ['queued', 'running']) {
    const inProgressRun = {
      version: 3,
      runId: `formal-newer-${inProgressState}-run`,
      state: inProgressState,
      dryRun: false,
      trigger: 'manual',
      createdAt: nowMs,
      updatedAt: nowMs,
      errorCode: ''
    }
    const activeLease = inProgressState === 'running'
      ? { runId: inProgressRun.runId, owner: 'worker-health-test', fence: 2, acquiredAt: nowMs - 100, expiresAt: nowMs + 60_000 }
      : null
    if (activeLease) inProgressRun.lease = activeLease
    const stillFailed = hc.evaluateFeishuSyncState({
      feishuSyncScheduler: activeLease ? { activeLease } : {},
      feishuSyncRuns: [inProgressRun, {
        version: 3,
        runId: 'formal-older-failure-must-persist',
        state: 'failed-before-write',
        dryRun: false,
        trigger: 'scheduled',
        finishedAt: nowMs - 1000,
        updatedAt: nowMs - 1000,
        errorCode: 'SOURCE_VALIDATION_FAILED'
      }]
    }, { nowMs, autoSyncEnabled: false })
    assert.strictEqual(stillFailed.ok, false, `更新的 ${inProgressState} 不得清除上一条正式终态事故`)
    assert.strictEqual(stillFailed.detail, '同步前检查没有通过，本次没有更新小程序房源', `${inProgressState} 期间必须继续报告原事故`)
  }

  const disabledPartial = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{
      version: 3,
      runId: 'formal-disabled-materials-partial',
      state: 'succeeded',
      dryRun: false,
      trigger: 'scheduled',
      finishedAt: nowMs - 1000,
      updatedAt: nowMs - 1000,
      errorCode: 'MATERIALS_PARTIAL_FAILURE'
    }]
  }, { nowMs, autoSyncEnabled: false })
  assert.strictEqual(disabledPartial.ok, false, '关闭自动同步也不得漏报最新正式任务的素材部分失败')
  assert.strictEqual(disabledPartial.degraded, true, '素材部分失败必须明确降级')

  for (const state of ['unknown', 'blocked']) {
    const disabledWithUnresolved = hc.evaluateFeishuSyncState({
      feishuSyncRuns: [{ id: `RUN-${state}`, state, updatedAt: nowMs - 1000 }]
    }, {
      nowMs,
      autoSyncEnabled: false,
      controllerMode: '',
      intervalMinutes: 30
    })
    assert.strictEqual(
      disabledWithUnresolved.ok,
      false,
      `关闭自动同步也不得掩盖未处置的 ${state.toUpperCase()} 任务`
    )
    assert.strictEqual(disabledWithUnresolved.lastState, state)
  }

  const integrityBlocked = hc.evaluateFeishuSyncState({
    feishuSyncScheduler: { leaseIntegrityBlockedRunId: 'controller-state-invalid' },
    feishuSyncRuns: [{ runId: 'RUN-OK', state: 'succeeded', finishedAt: nowMs - 1000 }]
  }, {
    nowMs,
    autoSyncEnabled: false,
    controllerMode: '',
    intervalMinutes: 30
  })
  assert.strictEqual(integrityBlocked.ok, false, '关闭自动同步也不得掩盖控制器租约完整性异常')
  assert.strictEqual(/controller|RUN-OK/i.test(JSON.stringify(integrityBlocked)), false, '健康结果不得回显任务或控制器内部标识')

  const inconsistentLease = hc.evaluateFeishuSyncState({
    feishuSyncScheduler: {
      activeLease: { runId: 'RUN-ACTIVE', owner: 'worker-a', fence: 3, acquiredAt: nowMs - 1000, expiresAt: nowMs + 60_000 }
    },
    feishuSyncRuns: [{
      runId: 'RUN-ACTIVE',
      state: 'dry-running',
      lease: { runId: 'RUN-ACTIVE', owner: 'worker-b', fence: 3, acquiredAt: nowMs - 1000, expiresAt: nowMs + 60_000 }
    }]
  }, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(inconsistentLease.ok, false, '调度器与任务租约身份不一致必须告警')
  assert.strictEqual(/RUN-ACTIVE|worker-/i.test(JSON.stringify(inconsistentLease)), false, '租约异常告警不得暴露运行身份')

  const wrongEmbeddedRunId = hc.evaluateFeishuSyncState({
    feishuSyncScheduler: {
      activeLease: { runId: 'active-run-01', owner: 'worker-a', fence: 3, acquiredAt: nowMs - 1000, expiresAt: nowMs + 60_000 }
    },
    feishuSyncRuns: [{
      runId: 'active-run-01',
      state: 'dry-running',
      lease: { runId: 'different-run-02', owner: 'worker-a', fence: 3, acquiredAt: nowMs - 1000, expiresAt: nowMs + 60_000 }
    }, {
      runId: 'recent-success-01', state: 'succeeded', finishedAt: nowMs - 1000
    }]
  }, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(wrongEmbeddedRunId.ok, false, '任务租约内嵌 runId 与任务身份不同必须告警')
  assert.strictEqual(/active-run|different-run/i.test(JSON.stringify(wrongEmbeddedRunId)), false, '租约 runId 异常不得暴露内部身份')

  const applyingWithoutLease = hc.evaluateFeishuSyncState({
    feishuSyncScheduler: { activeLease: null },
    feishuSyncRuns: [{
      runId: 'applying-without-lease',
      state: 'applying',
      lease: null,
      updatedAt: nowMs - 1000
    }, {
      runId: 'recent-success-before-broken-run',
      state: 'succeeded',
      finishedAt: nowMs - 60 * 1000
    }]
  }, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(applyingWithoutLease.ok, false, '非 queued 的活动任务缺少租约必须告警')
  assert.strictEqual(
    /applying-without-lease|recent-success/i.test(JSON.stringify(applyingWithoutLease)),
    false,
    '无租约异常不得暴露内部任务身份'
  )

  const wrongController = hc.evaluateFeishuSyncState({}, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: '',
    intervalMinutes: 30
  })
  assert.strictEqual(wrongController.ok, false, '自动同步开启但未绑定 worker-v2 必须告警')

  const missingApproval = hc.evaluateFeishuSyncState({}, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: false,
    intervalMinutes: 30
  })
  assert.strictEqual(missingApproval.ok, false, '自动同步缺任一字段/资源身份批准摘要必须告警')

  const missingWriteLock = hc.evaluateFeishuSyncState({}, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: false,
    intervalMinutes: 30
  })
  assert.strictEqual(missingWriteLock.ok, false, '数据库跨进程写锁关闭时自动同步必须告警')

  const unknown = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{
      runId: 'RUN-UNKNOWN-20260811',
      state: 'unknown',
      updatedAt: nowMs - 1000,
      errorCode: 'FEISHU_API_1254072',
      errorMessage: 'https://secret.invalid/path?token=never-output'
    }]
  }, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(unknown.ok, false, 'UNKNOWN 必须 fail-loud')
  assert.strictEqual(/secret|token|https?:|path/i.test(JSON.stringify(unknown)), false, '巡检结果不得带任务原始错误或外部地址')
  assert.strictEqual(unknown.errorCode, 'FEISHU_API_1254072', '同步巡检必须透传白名单形态机器码')
  assert.match(unknown.traceId, /^SYNC-[A-F0-9]{12}$/, '同步巡检必须提供不可逆脱敏任务编号')
  assert.ok(!JSON.stringify(unknown).includes('RUN-UNKNOWN-20260811'), '同步巡检不得回显原始 runId')

  const newest = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [
      { runId: 'RUN-OLDER-UNKNOWN', state: 'unknown', updatedAt: nowMs - 5000, errorCode: 'OLDER_ERROR' },
      { runId: 'RUN-NEWER-BLOCKED', state: 'blocked', updatedAt: nowMs - 1000, errorCode: 'NEWER_ERROR' }
    ]
  }, { nowMs, autoSyncEnabled: false })
  assert.strictEqual(newest.lastState, 'blocked', '多个未处置任务必须固定选择最新任务')
  assert.strictEqual(newest.errorCode, 'NEWER_ERROR', '最新任务的安全机器码必须进入巡检')

  const syncAlertText = require('./send-feishu-alert').buildText({
    HEALTH_FAILURES: 'feishuSync',
    HEALTH_SUMMARY: JSON.stringify(hc.aggregate([{ name: 'feishuSync', ...unknown }]))
  }, [])
  assert.ok(syncAlertText.includes('字段值格式不符合飞书表格要求'), '真实同步巡检结构必须进入受控中文原因模板')
  assert.ok(syncAlertText.includes(unknown.traceId), '同步告警必须沿用健康巡检生成的脱敏任务编号')

  const incidentFile = path.join(os.tmpdir(), `ynzy-health-incident-test-${process.pid}-${Date.now()}.json`)
  try {
    const failed = { ok: false, failures: ['service'] }
    const firstIncident = hc.updateHealthIncident(failed, { file: incidentFile, nowMs })
    assert.strictEqual(hc.updateHealthIncident(failed, { file: incidentFile, nowMs: nowMs + 1000 }), firstIncident, '连续同一故障必须沿用事件编号')
    hc.updateHealthIncident({ ok: true, failures: [] }, { file: incidentFile, nowMs: nowMs + 2000 })
    const secondIncident = hc.updateHealthIncident(failed, { file: incidentFile, nowMs: nowMs + 3000 })
    assert.notStrictEqual(secondIncident, firstIncident, '恢复后再次发生同类故障必须生成新事件编号')
  } finally {
    try { fs.unlinkSync(incidentFile) } catch (_error) {}
  }

  const forgedManualResolution = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{
      version: 3,
      runId: 'feishu-sync-forged-unknown-01',
      state: 'unknown',
      updatedAt: nowMs - 1000
    }],
    feishuSyncCommitMarkers: {},
    feishuSyncConvergenceResolutions: {
      'feishu-sync-forged-unknown-01': {
        contract: 'feishu-manual-five-table-noop-resolution-v1'
      }
    }
  }, {
    nowMs,
    autoSyncEnabled: false
  })
  assert.strictEqual(
    forgedManualResolution.ok,
    false,
    '只有完整且可复核的本地零差异 marker 才能消除 UNKNOWN 告警'
  )

  const freshRun = trustedHealthRun({ runId: 'trusted-fresh-success', finishedAt: nowMs - 20 * 60 * 1000 })
  const fresh = hc.evaluateFeishuSyncState(trustedHealthDb([freshRun]), {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(fresh.ok, true, '最近成功在健康窗口内必须通过')
  assert.strictEqual(fresh.lastState, 'succeeded')

  const failedAfterFresh = hc.evaluateFeishuSyncState(trustedHealthDb([{
    version: 3,
    runId: 'formal-failed-after-fresh-success',
    state: 'failed-before-write',
    dryRun: false,
    trigger: 'scheduled',
    finishedAt: nowMs - 1000,
    updatedAt: nowMs - 1000,
    errorCode: 'SOURCE_VALIDATION_FAILED'
  }, freshRun]), {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true
  })
  assert.strictEqual(failedAfterFresh.ok, false, '旧成功仍新鲜时也不得掩盖最新正式任务失败')

  const badMarkerRun = trustedHealthRun({
    runId: 'formal-bad-marker-success',
    finishedAt: nowMs - 500
  })
  const badMarkerDb = trustedHealthDb([badMarkerRun], {
    ...healthMarkers,
    [badMarkerRun.runId]: { ...healthMarkers[badMarkerRun.runId], markerSha256: 'f'.repeat(64) }
  })
  const badMarkerHealth = hc.evaluateFeishuSyncState(badMarkerDb, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true
  })
  assert.strictEqual(badMarkerHealth.ok, false, '缺失或错误 commit marker 的 succeeded 不得把健康状态刷绿')
  assert.match(badMarkerHealth.detail, /完整性校验/, '坏 marker 必须给出可读的完整性失败原因')

  const recoveryRun = trustedHealthRun({
    runId: 'trusted-clean-success-after-failure',
    trigger: 'manual',
    finishedAt: nowMs - 100
  })
  const recoveredHealth = hc.evaluateFeishuSyncState(trustedHealthDb([
    recoveryRun,
    {
      version: 3,
      runId: 'formal-older-failed-before-write',
      state: 'failed-before-write',
      dryRun: false,
      trigger: 'manual',
      finishedAt: nowMs - 1000,
      updatedAt: nowMs - 1000,
      errorCode: 'SOURCE_VALIDATION_FAILED'
    }
  ]), {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true
  })
  assert.strictEqual(recoveredHealth.ok, true, '失败后的下一条新受信正式成功必须恢复健康')

  const oldSuccessBeforeClockRollback = trustedHealthRun({
    runId: 'trusted-old-success-before-health-clock-rollback',
    finishedAt: nowMs - 1_000
  })
  const failedAfterClockRollback = hc.evaluateFeishuSyncState(trustedHealthDb([{
    version: 3,
    runId: 'new-failure-with-earlier-clock',
    state: 'failed-before-write',
    dryRun: false,
    trigger: 'scheduled',
    finishedAt: nowMs - 2_000,
    updatedAt: nowMs - 2_000,
    errorCode: 'SOURCE_VALIDATION_FAILED'
  }, oldSuccessBeforeClockRollback]), { nowMs, autoSyncEnabled: false })
  assert.strictEqual(failedAfterClockRollback.ok, false, '账本首条新失败即使墙钟早于旧成功也必须告警')

  const cleanAfterClockRollback = trustedHealthRun({
    runId: 'trusted-new-clean-with-earlier-clock',
    finishedAt: nowMs - 3_000
  })
  const recoveredAfterClockRollback = hc.evaluateFeishuSyncState(trustedHealthDb([cleanAfterClockRollback, {
    version: 3,
    runId: 'old-failure-with-later-clock',
    state: 'failed-before-write',
    dryRun: false,
    trigger: 'scheduled',
    finishedAt: nowMs - 1_000,
    updatedAt: nowMs - 1_000,
    errorCode: 'SOURCE_VALIDATION_FAILED'
  }]), { nowMs, autoSyncEnabled: false })
  assert.strictEqual(recoveredAfterClockRollback.ok, true, '账本首条新可信成功即使墙钟早于旧失败也必须恢复健康')

  const dailyRun = trustedHealthRun({ runId: 'trusted-daily-fresh', finishedAt: nowMs - 12 * 60 * 60 * 1000 })
  const dailyScheduleFresh = hc.evaluateFeishuSyncState(trustedHealthDb([dailyRun]), {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30,
    maxAgeMinutes: 18 * 60
  })
  assert.strictEqual(dailyScheduleFresh.ok, true, '每日三次最长 12 小时间隔不得被 30 分钟防重桶误判为过期')
  assert.strictEqual(dailyScheduleFresh.maxAgeMinutes, 18 * 60, '健康窗口必须使用独立配置而不是防重桶的三倍')

  const fullBeforePartial = trustedHealthRun({
    runId: 'trusted-full-before-partial',
    finishedAt: nowMs - 4 * 60 * 60 * 1000
  })
  const partialAfterOldSuccess = hc.evaluateFeishuSyncState(trustedHealthDb([{
      version: 3,
      runId: 'formal-material-warning',
      state: 'succeeded',
      dryRun: false,
      trigger: 'scheduled',
      errorCode: 'MATERIALS_PARTIAL_FAILURE',
      finishedAt: nowMs - 5 * 60 * 1000,
      updatedAt: nowMs - 5 * 60 * 1000
    }, fullBeforePartial]), {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(partialAfterOldSuccess.ok, false, '最新任务仅素材部分失败时不得报告全链路健康')
  assert.strictEqual(partialAfterOldSuccess.degraded, true, '素材部分失败必须明确标记 degraded')
  assert.strictEqual(partialAfterOldSuccess.lastState, 'succeeded', '库存提交成功状态仍应如实保留')
  assert.strictEqual(partialAfterOldSuccess.lastSuccessAgeMinutes, 240, '素材告警不得刷新上一次完整成功时间')
  assert.match(partialAfterOldSuccess.detail, /素材.*(?:未完整|没有完整)/, '健康摘要应明确素材链路未完整')

  const repeatedPartial = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{
      version: 3,
      runId: 'formal-material-warning-2',
      state: 'succeeded',
      dryRun: false,
      trigger: 'scheduled',
      errorCode: 'MATERIALS_PARTIAL_FAILURE',
      finishedAt: nowMs - 10 * 60 * 1000,
      updatedAt: nowMs - 10 * 60 * 1000
    }, {
      version: 3,
      runId: 'formal-material-warning-1',
      state: 'succeeded',
      dryRun: false,
      trigger: 'scheduled',
      errorCode: 'MATERIALS_PARTIAL_FAILURE',
      finishedAt: nowMs - 40 * 60 * 1000,
      updatedAt: nowMs - 40 * 60 * 1000
    }]
  }, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(repeatedPartial.ok, false, '连续素材告警不得被当成新鲜完整成功')
  assert.strictEqual(repeatedPartial.degraded, true, '连续素材告警必须保持 degraded')
  assert.strictEqual(repeatedPartial.lastSuccessAgeMinutes, null, '从未完整成功时不得伪造成功新鲜度')

  const fullBeforeWarning = trustedHealthRun({
    runId: 'trusted-full-before-warning',
    finishedAt: nowMs - 30 * 60 * 1000
  })
  const partialFollowedByDryRun = hc.evaluateFeishuSyncState(trustedHealthDb([{
      version: 3,
      runId: 'dry-after-warning',
      state: 'dry-succeeded',
      dryRun: true,
      finishedAt: nowMs - 5 * 60 * 1000,
      updatedAt: nowMs - 5 * 60 * 1000
    }, {
      version: 3,
      runId: 'formal-material-warning-before-dry',
      state: 'succeeded',
      dryRun: false,
      trigger: 'manual',
      errorCode: 'MATERIALS_PARTIAL_FAILURE',
      finishedAt: nowMs - 20 * 60 * 1000,
      updatedAt: nowMs - 20 * 60 * 1000
    }, fullBeforeWarning]), {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(partialFollowedByDryRun.ok, false, '后续 dry-run 不得遮住最近正式运行的素材告警')
  assert.strictEqual(partialFollowedByDryRun.degraded, true, '素材告警后的 dry-run 仍必须保持 degraded')
  assert.strictEqual(partialFollowedByDryRun.lastSuccessAgeMinutes, 30, 'dry-run 不得刷新完整正式成功时间')

  const staleRun = trustedHealthRun({ runId: 'trusted-stale-success', finishedAt: nowMs - 19 * 60 * 60 * 1000 })
  const stale = hc.evaluateFeishuSyncState(trustedHealthDb([staleRun]), {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30,
    maxAgeMinutes: 18 * 60
  })
  assert.strictEqual(stale.ok, false, '超过每日三次独立健康窗口仍无成功任务必须告警')
}

// 7) 正式同步成功通知：独立于 auto 开关，只认普通 V3 的完整正式成功、commit marker 与受信 resultSummary。
//    首次无状态仅建基线，不补发历史；同窗多条逐条发，第二条失败只推进第一条，dry-run 永不外发。
{
  const baseNow = Date.parse('2026-08-11T12:00:00.000Z')
  const markers = {}
  const trustedRun = (overrides) => {
    const run = {
      version: 3,
      runId: 'formal-history-secret-run-id',
      state: 'succeeded',
      dryRun: false,
      trigger: 'manual',
      finishedAt: baseNow - 60_000,
      lease: null,
      errorCode: '',
      lastFence: 1,
      schemaSha256: 'a'.repeat(64),
      resourceIdentitySha256: 'b'.repeat(64),
      mirrorPlanSha256: 'c'.repeat(64),
      contentPlanSha256: 'd'.repeat(64),
      contentPlanAssetCount: 0,
      resultSummary: { success: true, complete: true, dryRun: false, failed: 0, created: 1, updated: 2, down: 3 },
      ...overrides
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, 'updatedAt')) run.updatedAt = run.finishedAt
    if (!Object.prototype.hasOwnProperty.call(overrides, 'applyResultSummary')) {
      run.applyResultSummary = { ...run.resultSummary }
    }
    const markerBody = {
      runId: run.runId,
      fence: run.lastFence,
      schemaSha256: run.schemaSha256,
      resourceIdentitySha256: run.resourceIdentitySha256,
      mirrorPlanSha256: run.mirrorPlanSha256,
      contentPlanSha256: run.contentPlanSha256,
      contentPlanAssetCount: run.contentPlanAssetCount,
      committedAt: run.finishedAt
    }
    const markerSha256 = crypto.createHash('sha256').update(JSON.stringify(markerBody)).digest('hex')
    run.commitMarkerSha256 = markerSha256
    markers[run.runId] = { ...markerBody, markerSha256 }
    return run
  }
  const makeDb = (runs, markerMap = markers) => ({ feishuSyncRuns: runs, feishuSyncCommitMarkers: markerMap })
  const historicalRun = trustedRun({})
  const dryRun = {
    version: 3,
    runId: 'dry-run-must-never-notify',
    state: 'dry-succeeded',
    dryRun: true,
    trigger: 'manual',
    finishedAt: baseNow + 1_000,
    resultSummary: { success: true, complete: true, dryRun: true, failed: 0, created: 99, updated: 99, down: 99 }
  }
  const partialRun = trustedRun({
    runId: 'partial-run-must-use-existing-alert',
    trigger: 'scheduled',
    finishedAt: baseNow + 2_000,
    errorCode: 'MATERIALS_PARTIAL_FAILURE',
    resultSummary: { success: true, complete: true, dryRun: false, failed: 1, created: 8, updated: 8, down: 8 }
  })
  const selected = hc.selectLatestFeishuSyncSuccess(makeDb([historicalRun, dryRun, partialRun]))
  assert.ok(selected, '应跳过预演和素材部分失败，选择最新完整正式成功')
  assert.strictEqual(selected.trigger, 'manual', '触发类型必须来自服务端任务枚举')
  assert.deepStrictEqual(selected.counts, { created: 1, updated: 2, down: 3 }, '汇总只能取受信终态 resultSummary')
  assert.match(selected.traceId, /^SYNC-[A-F0-9]{12}$/, '追踪号必须为不可逆脱敏编号')
  assert.ok(!JSON.stringify(selected).includes(historicalRun.runId), '通知事件不得携带原始 runId')

  const invalidCountRun = trustedRun({
      runId: 'formal-invalid-counts',
      finishedAt: baseNow,
      resultSummary: { ...historicalRun.resultSummary, created: '1', updated: 1.5, down: -1 },
      applyResultSummary: { ...historicalRun.resultSummary, created: 7, updated: 8, down: 9 }
  })
  const invalidCounts = hc.selectLatestFeishuSyncSuccess(makeDb([invalidCountRun]))
  assert.strictEqual(invalidCounts, null, '字符串/小数/负数不得显示，且不得回退到 applyResultSummary')

  const extraSummaryKey = trustedRun({
    runId: 'formal-summary-private-extra',
    finishedAt: baseNow + 100,
    resultSummary: { ...historicalRun.resultSummary, privatePollution: 999999 }
  })
  const mismatchedApplySummary = trustedRun({ runId: 'formal-summary-mismatch', finishedAt: baseNow + 200 })
  mismatchedApplySummary.resultSummary = { ...mismatchedApplySummary.resultSummary, created: 999999 }
  const illegalOptionalCount = trustedRun({
    runId: 'formal-summary-illegal-optional',
    finishedAt: baseNow + 300,
    resultSummary: { ...historicalRun.resultSummary, synced: 1.5 }
  })
  for (const [label, run] of [
    ['终态汇总含私有额外键', extraSummaryKey],
    ['resultSummary 与 applyResultSummary 不一致', mismatchedApplySummary],
    ['可选计数字段不是安全非负整数', illegalOptionalCount]
  ]) {
    const unsafeSummaryDb = makeDb([run])
    assert.strictEqual(hc.selectFeishuSyncSuccesses(unsafeSummaryDb).length, 0, `${label}时不得生成成功通知`)
    assert.strictEqual(
      hc.evaluateFeishuSyncState(unsafeSummaryDb, { nowMs: baseNow + 1000, autoSyncEnabled: false }).ok,
      false,
      `${label}时健康状态不得刷绿`
    )
  }

  assert.strictEqual(hc.selectLatestFeishuSyncSuccess(makeDb([historicalRun], {})), null, '缺 commit marker 不得通知')
  assert.strictEqual(hc.selectLatestFeishuSyncSuccess(makeDb([historicalRun], {
    [historicalRun.runId]: { ...markers[historicalRun.runId], extra: true }
  })), null, 'marker 结构畸形不得通知')
  assert.strictEqual(hc.selectLatestFeishuSyncSuccess(makeDb([historicalRun], {
    [historicalRun.runId]: { ...markers[historicalRun.runId], markerSha256: 'e'.repeat(64) }
  })), null, 'marker 摘要不匹配不得通知')
  const committedAtMismatch = trustedRun({ runId: 'formal-finished-marker-mismatch', finishedAt: baseNow + 3_100 })
  committedAtMismatch.finishedAt += 1
  committedAtMismatch.updatedAt = committedAtMismatch.finishedAt
  const updatedAtMismatch = trustedRun({ runId: 'formal-updated-finished-mismatch', finishedAt: baseNow + 3_200 })
  updatedAtMismatch.updatedAt += 1
  const liveLeaseSuccess = trustedRun({
    runId: 'formal-success-still-has-lease',
    finishedAt: baseNow + 3_300,
    lease: { runId: 'formal-success-still-has-lease', owner: 'worker-test', fence: 1, acquiredAt: 1, expiresAt: 2 }
  })
  for (const [label, run] of [
    ['finishedAt 与 marker.committedAt 不同', committedAtMismatch],
    ['updatedAt 与 finishedAt 不同', updatedAtMismatch],
    ['终态仍残留 lease', liveLeaseSuccess]
  ]) {
    const mutationDb = makeDb([run])
    assert.strictEqual(hc.selectFeishuSyncSuccesses(mutationDb).length, 0, `${label}时不得生成成功通知候选`)
    assert.strictEqual(
      hc.evaluateFeishuSyncState(mutationDb, { nowMs: baseNow + 10_000, autoSyncEnabled: false }).ok,
      false,
      `${label}时健康状态不得刷绿`
    )
  }
  const otherError = trustedRun({ runId: 'formal-other-error', errorCode: 'SOME_WARNING', finishedAt: baseNow + 3_000 })
  assert.strictEqual(hc.selectLatestFeishuSyncSuccess(makeDb([otherError])), null, '任意非空 errorCode 均不得包装成完整成功')
  for (const version of [4, 5, 6, 7]) {
    const convergence = trustedRun({ runId: `convergence-v${version}`, version, finishedAt: baseNow + version * 1000 })
    assert.strictEqual(hc.selectLatestFeishuSyncSuccess(makeDb([convergence])), null, `V${version} 收敛/恢复成功不得冒充普通 V3 同步成功`)
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-sync-success-notify-'))
  const stateFile = path.join(stateDir, 'state.json')
  let sends = 0
  const delivered = []
  try {
    const explicitStateFile = path.join(stateDir, 'explicit-state.json')
    const baselineDb = makeDb([historicalRun, dryRun, partialRun])
    const baselineDbBefore = JSON.stringify(baselineDb)
    let forbiddenSendCalls = 0
    const explicitBaseline = hc.initializeFeishuSyncSuccessBaseline(baselineDb, {
      stateFile: explicitStateFile,
      nowMs: baseNow,
      send: () => { forbiddenSendCalls += 1 }
    })
    assert.strictEqual(explicitBaseline.status, 'baselined', '部署初始化入口必须显式建立成功通知基线')
    assert.strictEqual(forbiddenSendCalls, 0, '部署初始化入口即使存在告警命令也不得调用发送链')
    assert.strictEqual(JSON.stringify(baselineDb), baselineDbBefore, '部署初始化入口不得改写业务数据库对象')
    assert.strictEqual(
      hc.initializeFeishuSyncSuccessBaseline(baselineDb, { stateFile: explicitStateFile, nowMs: baseNow + 1 }).status,
      'already-initialized',
      '已存在游标时部署初始化不得重置，避免吞掉待发新成功'
    )
    fs.unlinkSync(explicitStateFile)

    const raceStateFile = path.join(stateDir, 'race-state.json')
    assert.strictEqual(
      hc.initializeFeishuSyncSuccessBaseline(makeDb([historicalRun]), { stateFile: raceStateFile, nowMs: baseNow }).status,
      'baselined'
    )
    const successCompletedDuringBaseline = trustedRun({
      runId: 'success-finished-between-db-read-and-state-write',
      finishedAt: baseNow - 30_000
    })
    let raceDeliveries = 0
    const raceResult = hc.processFeishuSyncSuccessNotification(
      makeDb([successCompletedDuringBaseline, historicalRun]),
      { stateFile: raceStateFile, nowMs: baseNow + 1, send: () => { raceDeliveries += 1 } }
    )
    assert.strictEqual(raceResult.status, 'notified', 'finishedAt 介于已读历史和初始化墙钟之间的新成功不得被基线吞掉')
    assert.strictEqual(raceDeliveries, 1, '基线竞态中的新正式成功必须恰好发送一次')
    fs.unlinkSync(raceStateFile)

    const rollbackStateFile = path.join(stateDir, 'clock-rollback-state.json')
    const laterClockSuccess = trustedRun({ runId: 'history-before-clock-rollback', finishedAt: baseNow + 2_000 })
    hc.initializeFeishuSyncSuccessBaseline(makeDb([laterClockSuccess]), { stateFile: rollbackStateFile, nowMs: baseNow + 3_000 })
    const newSuccessWithEarlierClock = trustedRun({ runId: 'new-success-after-clock-rollback', finishedAt: baseNow + 1_000 })
    let rollbackDeliveries = 0
    const rollbackResult = hc.processFeishuSyncSuccessNotification(
      makeDb([newSuccessWithEarlierClock, laterClockSuccess]),
      { stateFile: rollbackStateFile, nowMs: baseNow + 4_000, send: () => { rollbackDeliveries += 1 } }
    )
    assert.strictEqual(rollbackResult.status, 'notified', '服务器时钟回拨后的新 runKey 不得被 finishedAt 水位永久忽略')
    assert.strictEqual(rollbackDeliveries, 1, '时钟回拨后的新正式成功必须通知一次')
    fs.unlinkSync(rollbackStateFile)

    assert.throws(
      () => hc.buildSyncSuccessBaselineState(Array.from({ length: 4097 }, (_item, index) => ({
        runKey: index.toString(16).padStart(64, '0'),
        finishedAt: index + 1
      })), baseNow),
      (error) => error && error.code === 'SYNC_SUCCESS_STATE_CAPACITY',
      '历史候选超过身份容量时必须初始化失败关闭，不得 slice 后补发旧历史'
    )

    const lockStateFile = path.join(stateDir, 'lock-duration-state.json')
    const lockFile = `${lockStateFile}.lock`
    fs.writeFileSync(lockFile, '999999:1', { encoding: 'utf8', mode: 0o600 })
    const sixtyOneSecondsAgo = new Date(Date.now() - 61_000)
    fs.utimesSync(lockFile, sixtyOneSecondsAgo, sixtyOneSecondsAgo)
    assert.strictEqual(
      hc.processFeishuSyncSuccessNotification(makeDb([historicalRun]), { stateFile: lockStateFile, nowMs: baseNow }).status,
      'busy',
      '合法批量发送可能超过 60 秒，61 秒旧锁仍不得被第二进程误删'
    )
    const overTenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000 - 1000)
    fs.utimesSync(lockFile, overTenMinutesAgo, overTenMinutesAgo)
    assert.strictEqual(
      hc.processFeishuSyncSuccessNotification(makeDb([historicalRun]), { stateFile: lockStateFile, nowMs: baseNow }).status,
      'baselined',
      '超过十分钟的异常遗留锁必须允许下一进程接管'
    )
    fs.unlinkSync(lockStateFile)

    const abaStateFile = path.join(stateDir, 'lock-aba-state.json')
    const releaseA = hc.acquireSyncSuccessLock(abaStateFile)
    assert.strictEqual(typeof releaseA, 'function', 'A 必须先取得成功通知锁')
    const abaLockFile = `${abaStateFile}.lock`
    const staleA = new Date(Date.now() - 10 * 60 * 1000 - 1000)
    fs.utimesSync(abaLockFile, staleA, staleA)
    const releaseB = hc.acquireSyncSuccessLock(abaStateFile)
    assert.strictEqual(typeof releaseB, 'function', 'A 过期后 B 必须可以接管')
    const tokenB = fs.readFileSync(abaLockFile, 'utf8')
    releaseA()
    assert.strictEqual(fs.readFileSync(abaLockFile, 'utf8'), tokenB, 'A 的 finally 不得误删 B 的新 token 锁')
    releaseB()
    assert.strictEqual(fs.existsSync(abaLockFile), false, 'B 只能释放仍属于自己的 token 锁')

    let staleRaceReads = 0
    let staleRaceUnlinks = 0
    const staleRaceFs = {
      mkdirSync() {},
      openSync() {
        const error = new Error('exists')
        error.code = 'EEXIST'
        throw error
      },
      readFileSync() {
        staleRaceReads += 1
        return staleRaceReads === 1 ? 'old-stale-owner-token' : 'new-live-owner-token'
      },
      statSync: () => ({ mtimeMs: 0 }),
      unlinkSync() { staleRaceUnlinks += 1 }
    }
    assert.strictEqual(
      hc.acquireSyncSuccessLock('/persistent/racing-state.json', {
        fsOps: staleRaceFs,
        now: () => 10 * 60 * 1000 + 1
      }),
      null,
      '过期检查后 owner token 已变化时必须按 busy 收口'
    )
    assert.strictEqual(staleRaceUnlinks, 0, 'stale 清理不得删除二次确认时已属于新 owner 的锁')

    const preSendCrashStateFile = path.join(stateDir, 'pre-send-crash-state.json')
    hc.initializeFeishuSyncSuccessBaseline(makeDb([historicalRun]), { stateFile: preSendCrashStateFile, nowMs: baseNow })
    const preSendCrashSuccess = trustedRun({
      runId: 'new-success-after-pre-send-crash',
      finishedAt: baseNow + 4_000
    })
    const preSendState = JSON.parse(fs.readFileSync(preSendCrashStateFile, 'utf8'))
    hc.writeSyncSuccessState(preSendCrashStateFile, {
      ...preSendState,
      dispatching: { runKey: hc.selectLatestFeishuSyncSuccess(makeDb([preSendCrashSuccess])).runKey, finishedAt: preSendCrashSuccess.finishedAt }
    })
    let preSendRetryCalls = 0
    const preSendRetry = hc.processFeishuSyncSuccessNotification(
      makeDb([preSendCrashSuccess, historicalRun]),
      { stateFile: preSendCrashStateFile, nowMs: baseNow + 5_000, send: () => { preSendRetryCalls += 1 } }
    )
    assert.strictEqual(preSendRetry.status, 'notified', '落 dispatching 后、调用机器人前崩溃必须在下一轮重试')
    assert.strictEqual(preSendRetryCalls, 1, 'pre-send crash 恢复后必须实际调用一次发送链')
    fs.unlinkSync(preSendCrashStateFile)

    const postSendCrashStateFile = path.join(stateDir, 'post-send-crash-state.json')
    hc.initializeFeishuSyncSuccessBaseline(makeDb([historicalRun]), { stateFile: postSendCrashStateFile, nowMs: baseNow })
    const postSendCrashSuccess = trustedRun({
      runId: 'new-success-after-post-send-crash',
      trigger: 'scheduled',
      finishedAt: baseNow + 6_000
    })
    const postSendEvent = hc.selectLatestFeishuSyncSuccess(makeDb([postSendCrashSuccess]))
    const postSendState = JSON.parse(fs.readFileSync(postSendCrashStateFile, 'utf8'))
    hc.writeSyncSuccessState(postSendCrashStateFile, {
      ...postSendState,
      dispatching: { runKey: postSendEvent.runKey, finishedAt: postSendEvent.finishedAt }
    })
    const alert = require('./send-feishu-alert')
    const postSendDedupeDir = path.join(stateDir, 'post-send-alert-dedupe')
    const postSendEnv = {
      HEALTH_ALERT_WEBHOOK: 'http://local.invalid/fake',
      ALERT_KIND: 'FEISHU_SYNC_SUCCEEDED',
      ALERT_DEDUPE_KEY: `SYNC-SUCCESS-${postSendEvent.runKey}`,
      ALERT_DETAIL: JSON.stringify({
        traceId: postSendEvent.traceId,
        trigger: postSendEvent.trigger,
        finishedAt: postSendEvent.finishedAt,
        ...postSendEvent.counts
      })
    }
    const persistentAlertDedupe = alert.createFileDedupeStore({ dir: postSendDedupeDir })
    persistentAlertDedupe.claim(alert.alertFingerprint(postSendEnv)).markSent()
    let repeatedWebhookCalls = 0
    const postSendRetry = hc.processFeishuSyncSuccessNotification(
      makeDb([postSendCrashSuccess, historicalRun]),
      {
        stateFile: postSendCrashStateFile,
        nowMs: baseNow + 7_000,
        send: () => {
          let callbackCalled = false
          alert.sendAlert({
            env: postSendEnv,
            dedupeStore: persistentAlertDedupe,
            transport: () => { repeatedWebhookCalls += 1 }
          }, (error, result) => {
            assert.ifError(error)
            assert.strictEqual(result && result.deduplicated, true, '已送达但游标未落时必须由持久告警去重接住')
            callbackCalled = true
          })
          assert.strictEqual(callbackCalled, true, '持久去重返回必须在本次游标推进前完成')
        }
      }
    )
    assert.strictEqual(postSendRetry.status, 'notified', 'post-send crash 恢复后应通过去重成功推进游标')
    assert.strictEqual(repeatedWebhookCalls, 0, 'post-send crash 恢复不得产生第二条群消息')
    fs.rmSync(postSendDedupeDir, { recursive: true, force: true })
    fs.unlinkSync(postSendCrashStateFile)

    const baseline = hc.processFeishuSyncSuccessNotification(
      makeDb([historicalRun, dryRun, partialRun]),
      { stateFile, nowMs: baseNow, send: (event) => { sends += 1; delivered.push(event) } }
    )
    assert.strictEqual(baseline.status, 'baselined', '首次部署无状态时只建立基线')
    assert.strictEqual(sends, 0, '首次部署不得补发历史成功')
    assert.ok(!fs.readFileSync(stateFile, 'utf8').includes(historicalRun.runId), '持久状态不得保存原始 runId')
    assert.deepStrictEqual(fs.readdirSync(stateDir), ['state.json'], '原子写后不得遗留临时文件或锁文件')
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(stateFile).mode & 0o777, 0o600, '游标文件权限必须为 0600')

    const manualSuccess = trustedRun({
      runId: 'new-manual-success-private-id',
      finishedAt: baseNow + 10_000,
      resultSummary: { ...historicalRun.resultSummary, created: 4, updated: 5, down: 6 }
    })
    const scheduledSuccess = trustedRun({
      runId: 'new-scheduled-success-private-id',
      trigger: 'scheduled',
      finishedAt: baseNow + 20_000,
      resultSummary: { ...historicalRun.resultSummary, created: 0, updated: 7, down: 1 }
    })
    const failedSend = hc.processFeishuSyncSuccessNotification(
      makeDb([scheduledSuccess, manualSuccess, dryRun, historicalRun]),
      {
        stateFile,
        nowMs: baseNow + 21_000,
        send: (event) => {
          sends += 1
          if (event.traceId === hc.safeSyncContext(scheduledSuccess).traceId) {
            throw Object.assign(new Error('自由失败正文不得输出'), { code: 'EPIPE' })
          }
          delivered.push(event)
        }
      }
    )
    assert.strictEqual(failedSend.status, 'send-failed', '明确发送失败必须保留重试机会')
    assert.strictEqual(failedSend.notifiedCount, 1, '同窗第二条失败时只能推进已成功的第一条')
    assert.strictEqual(sends, 2, '同窗两条必须按 worker 账本从旧到新逐条尝试')
    assert.deepStrictEqual(delivered[0].counts, { created: 4, updated: 5, down: 6 }, '第一条人工成功必须先送达')

    // 重新加载模块模拟服务/进程重启；游标必须从持久文件续读，不能重发第一条。
    delete require.cache[require.resolve('./health-check')]
    const restartedHc = require('./health-check')
    const retried = restartedHc.processFeishuSyncSuccessNotification(
      makeDb([dryRun, scheduledSuccess, manualSuccess, historicalRun]),
      { stateFile, nowMs: baseNow + 22_000, send: (event) => { sends += 1; delivered.push(event) } }
    )
    assert.strictEqual(retried.status, 'notified', '失败后的下一次巡检必须重试同一新成功')
    assert.strictEqual(delivered[1].trigger, 'scheduled', '定时任务触发类型必须安全透传')
    assert.strictEqual(sends, 3, '一次失败加一次成功重试，总调用次数应精确')
    const duplicate = restartedHc.processFeishuSyncSuccessNotification(
      makeDb([scheduledSuccess, manualSuccess, historicalRun]),
      { stateFile, nowMs: baseNow + 23_000, send: () => { sends += 1 } }
    )
    assert.strictEqual(duplicate.status, 'no-new-success', '跨进程重启后两条正式成功仍不得重复通知')
    assert.strictEqual(sends, 3, '跨进程重启不得重发已成功事件')

    const movedFinishedAtSameRun = trustedRun({
      runId: scheduledSuccess.runId,
      trigger: 'scheduled',
      finishedAt: baseNow + 40_000,
      resultSummary: scheduledSuccess.resultSummary
    })
    const movedTimestampResult = restartedHc.processFeishuSyncSuccessNotification(
      makeDb([movedFinishedAtSameRun, manualSuccess, historicalRun]),
      { stateFile, nowMs: baseNow + 41_000, send: () => { sends += 1 } }
    )
    assert.strictEqual(movedTimestampResult.status, 'no-new-success', '已处理 run 即使 finishedAt 被异常改大也不得重新发送')
    assert.strictEqual(sends, 3, '同一 runKey 必须永久保持单次通知身份')

    const ledgerOrderStateFile = path.join(stateDir, 'ledger-order-state.json')
    hc.initializeFeishuSyncSuccessBaseline(makeDb([historicalRun]), { stateFile: ledgerOrderStateFile, nowMs: baseNow })
    const ledgerOlderWithLaterClock = trustedRun({
      runId: 'ledger-older-success-with-later-clock',
      finishedAt: baseNow + 60_000,
      resultSummary: { ...historicalRun.resultSummary, created: 8, updated: 0, down: 0 }
    })
    const ledgerNewerAfterClockRollback = trustedRun({
      runId: 'ledger-newer-success-after-clock-rollback',
      finishedAt: baseNow + 50_000,
      resultSummary: { ...historicalRun.resultSummary, created: 9, updated: 0, down: 0 }
    })
    const ledgerDeliveries = []
    const ledgerOrderResult = restartedHc.processFeishuSyncSuccessNotification(
      makeDb([ledgerNewerAfterClockRollback, ledgerOlderWithLaterClock, historicalRun]),
      { stateFile: ledgerOrderStateFile, nowMs: baseNow + 70_000, send: (event) => ledgerDeliveries.push(event.counts.created) }
    )
    assert.strictEqual(ledgerOrderResult.status, 'notified', '同窗两条回拨成功都必须发送')
    assert.deepStrictEqual(ledgerDeliveries, [8, 9], '通知顺序必须按 worker 账本旧到新，不能按 finishedAt 墙钟排序')
    fs.unlinkSync(ledgerOrderStateFile)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

// 8) 默认游标必须与 DATA_FILE 同属持久目录；落盘顺序必须是 0600 临时文件→文件 fsync→rename→父目录 fsync。
{
  const priorDataFile = process.env.DATA_FILE
  const priorIncidentFile = process.env.HEALTH_ALERT_INCIDENT_FILE
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-sync-success-path-'))
  let healthServiceProcess = null
  try {
    process.env.DATA_FILE = path.join(dir, 'db.json')
    delete process.env.HEALTH_ALERT_INCIDENT_FILE
    assert.strictEqual(
      hc.resolveSyncSuccessStatePath(),
      path.join(dir, '.feishu-sync-success-notification.json'),
      '默认游标必须由 DATA_FILE 决定并放在同级持久目录'
    )
    assert.strictEqual(
      hc.resolveHealthIncidentFile(),
      path.join(dir, '.health-alert-incident.json'),
      '健康事故编号默认状态也必须放在 DATA_FILE 同级持久目录'
    )
    const persistentFailure = { ok: false, failures: ['service'] }
    const persistentIncident = hc.updateHealthIncident(persistentFailure, { nowMs: 1000 })
    delete require.cache[require.resolve('./health-check')]
    const restartedIncidentHc = require('./health-check')
    assert.strictEqual(
      restartedIncidentHc.updateHealthIncident(persistentFailure, { nowMs: 2000 }),
      persistentIncident,
      '进程重启后同一持续事故必须沿用原排查编号，不能绕过持久去重'
    )

    const cliDbFile = path.join(dir, 'cli-db.json')
    const cliStateFile = path.join(dir, '.feishu-sync-success-notification.json')
    const cliAlertProbe = path.join(dir, 'alert-command-must-not-run.txt')
    const cliDbText = JSON.stringify({ listings: [], feishuSyncRuns: [], feishuSyncCommitMarkers: {} })
    fs.writeFileSync(cliDbFile, cliDbText, 'utf8')
    const probeCommand = `"${process.execPath}" -e "require('fs').writeFileSync(process.env.HEALTH_ALERT_PROBE_FILE,'called')"`
    const cliOutput = execFileSync(process.execPath, [path.join(__dirname, 'health-check.js'), '--init-sync-notify-baseline'], {
      env: {
        ...process.env,
        DATA_FILE: cliDbFile,
        HEALTH_ALERT_CMD: probeCommand,
        HEALTH_ALERT_PROBE_FILE: cliAlertProbe
      },
      encoding: 'utf8'
    })
    assert.ok(cliOutput.includes('成功通知基线已建立'), '部署命令必须明确报告基线已建立')
    assert.ok(fs.existsSync(cliStateFile), '部署命令必须写入独立持久游标')
    assert.strictEqual(fs.existsSync(cliAlertProbe), false, '部署命令绝不调用机器人或普通告警命令')
    assert.strictEqual(fs.readFileSync(cliDbFile, 'utf8'), cliDbText, '部署命令不得改写业务数据库文件')

    const rejectedDir = path.join(dir, 'rejected-extra-arg')
    fs.mkdirSync(rejectedDir)
    const rejectedDbFile = path.join(rejectedDir, 'db.json')
    const rejectedStateFile = path.join(rejectedDir, '.feishu-sync-success-notification.json')
    fs.writeFileSync(rejectedDbFile, cliDbText, 'utf8')
    const rejected = spawnSync(process.execPath, [path.join(__dirname, 'health-check.js'), '--init-sync-notify-baseline', '--extra'], {
      env: { ...process.env, DATA_FILE: rejectedDbFile },
      encoding: 'utf8'
    })
    assert.notStrictEqual(rejected.status, 0, '初始化入口带额外参数必须非零拒绝')
    assert.strictEqual(fs.existsSync(rejectedStateFile), false, '非法额外参数不得静默写入游标')

    assert.strictEqual(hc.healthProcessExitCode({ ok: true }, { status: 'busy' }), 0, '并发忙不得改变原健康退出语义')
    for (const status of ['send-failed', 'dispatch-unknown', 'state-error']) {
      assert.strictEqual(hc.healthProcessExitCode({ ok: true }, { status }), 1, `${status} 必须让普通巡检非零退出`)
    }

    // 起一个独立的本机 healthz 服务，让 CLI 子进程的基础巡检真实为绿；随后只改变成功通知状态，
    // 证明 systemd 看到的非零退出确实来自游标损坏/发送失败，而不是其他健康项。
    const serviceReadyFile = path.join(dir, 'health-service-ready.txt')
    const serviceProgram = [
      "const fs=require('fs')",
      "const http=require('http')",
      "const ready=process.argv[1]",
      "const server=http.createServer((_req,res)=>{res.statusCode=200;res.end('ok')})",
      "server.listen(0,'127.0.0.1',()=>fs.writeFileSync(ready,String(server.address().port)))"
    ].join(';')
    healthServiceProcess = spawn(process.execPath, ['-e', serviceProgram, serviceReadyFile], {
      stdio: 'ignore',
      windowsHide: true
    })
    const waitCell = new Int32Array(new SharedArrayBuffer(4))
    const readyDeadline = Date.now() + 5000
    while (!fs.existsSync(serviceReadyFile) && Date.now() < readyDeadline && healthServiceProcess.exitCode == null) {
      Atomics.wait(waitCell, 0, 0, 25)
    }
    assert.ok(fs.existsSync(serviceReadyFile), 'CLI 退出码测试的本机 healthz 服务必须启动')
    const healthPort = fs.readFileSync(serviceReadyFile, 'utf8').trim()
    const commonHealthEnv = {
      ...process.env,
      DATA_FILE: cliDbFile,
      PORT: healthPort,
      FEISHU_AUTO_SYNC_ENABLED: '0',
      BACKUP_STAGE_DIR: '',
      BACKUP_DIR: '',
      HEALTH_ALERT_INCIDENT_FILE: path.join(dir, 'cli-health-incident.json')
    }

    const invalidCliStateFile = cliStateFile
    fs.writeFileSync(invalidCliStateFile, '{"version":999}', 'utf8')
    const stateErrorExit = spawnSync(process.execPath, [path.join(__dirname, 'health-check.js')], {
      env: {
        ...commonHealthEnv,
        HEALTH_ALERT_CMD: ''
      },
      encoding: 'utf8'
    })
    assert.ok(stateErrorExit.stdout.includes('"ok":true'), '游标损坏用例的基础健康项必须真实为绿')
    assert.notStrictEqual(stateErrorExit.status, 0, '成功通知游标损坏时普通 health CLI 不得假绿退出')

    const sendFailureRun = {
      version: 3,
      runId: 'cli-send-failure-private-run',
      state: 'succeeded',
      dryRun: false,
      trigger: 'manual',
      finishedAt: Date.now(),
      updatedAt: 0,
      lease: null,
      errorCode: '',
      lastFence: 1,
      schemaSha256: '1'.repeat(64),
      resourceIdentitySha256: '2'.repeat(64),
      mirrorPlanSha256: '3'.repeat(64),
      contentPlanSha256: '4'.repeat(64),
      contentPlanAssetCount: 0,
      resultSummary: { success: true, complete: true, dryRun: false, failed: 0, created: 1, updated: 0, down: 0 }
    }
    sendFailureRun.updatedAt = sendFailureRun.finishedAt
    sendFailureRun.applyResultSummary = { ...sendFailureRun.resultSummary }
    const sendMarkerBody = {
      runId: sendFailureRun.runId,
      fence: sendFailureRun.lastFence,
      schemaSha256: sendFailureRun.schemaSha256,
      resourceIdentitySha256: sendFailureRun.resourceIdentitySha256,
      mirrorPlanSha256: sendFailureRun.mirrorPlanSha256,
      contentPlanSha256: sendFailureRun.contentPlanSha256,
      contentPlanAssetCount: sendFailureRun.contentPlanAssetCount,
      committedAt: sendFailureRun.finishedAt
    }
    const sendMarkerSha256 = crypto.createHash('sha256').update(JSON.stringify(sendMarkerBody)).digest('hex')
    sendFailureRun.commitMarkerSha256 = sendMarkerSha256
    fs.writeFileSync(cliDbFile, JSON.stringify({
      listings: [],
      feishuSyncRuns: [sendFailureRun],
      feishuSyncCommitMarkers: {
        [sendFailureRun.runId]: { ...sendMarkerBody, markerSha256: sendMarkerSha256 }
      }
    }), 'utf8')
    const sendFailureStateFile = cliStateFile
    hc.writeSyncSuccessState(sendFailureStateFile, {
      version: 1,
      initializedAt: 1,
      watermarkFinishedAt: 0,
      seenRunKeys: [],
      dispatching: null
    })
    const failingAlertCommand = `"${process.execPath}" -e "process.exit(9)"`
    const sendFailureExit = spawnSync(process.execPath, [path.join(__dirname, 'health-check.js')], {
      env: {
        ...commonHealthEnv,
        HEALTH_ALERT_CMD: failingAlertCommand
      },
      encoding: 'utf8'
    })
    assert.ok(sendFailureExit.stdout.includes('"ok":true'), '发送失败用例的基础健康项必须真实为绿')
    assert.notStrictEqual(sendFailureExit.status, 0, '成功通知命令发送失败时普通 health CLI 不得假绿退出')
  } finally {
    if (healthServiceProcess && healthServiceProcess.exitCode == null) healthServiceProcess.kill()
    if (priorDataFile == null) delete process.env.DATA_FILE
    else process.env.DATA_FILE = priorDataFile
    if (priorIncidentFile == null) delete process.env.HEALTH_ALERT_INCIDENT_FILE
    else process.env.HEALTH_ALERT_INCIDENT_FILE = priorIncidentFile
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const calls = []
  let nextFd = 10
  const fakeFs = {
    mkdirSync: (_target, options) => calls.push(['mkdir', options.mode]),
    openSync: (target, flags, mode) => { calls.push(['open', path.basename(target), flags, mode]); return nextFd++ },
    writeFileSync: (fd) => calls.push(['write', fd]),
    fsyncSync: (fd) => calls.push(['fsync', fd]),
    closeSync: (fd) => calls.push(['close', fd]),
    renameSync: (from, to) => calls.push(['rename', path.basename(from), path.basename(to)]),
    unlinkSync: (target) => calls.push(['unlink', path.basename(target)])
  }
  hc.writeSyncSuccessState('/persistent/state.json', {
    version: 1,
    initializedAt: 1,
    watermarkFinishedAt: 1,
    seenRunKeys: [],
    dispatching: null
  }, { fsOps: fakeFs, platform: 'linux' })
  const tempOpen = calls.find((call) => call[0] === 'open' && call[2] === 'wx')
  assert.ok(tempOpen && tempOpen[3] === 0o600, '临时游标必须以 0600 独占创建')
  const renameIndex = calls.findIndex((call) => call[0] === 'rename')
  const fsyncIndexes = calls.map((call, index) => call[0] === 'fsync' ? index : -1).filter((index) => index >= 0)
  assert.ok(fsyncIndexes.length === 2 && fsyncIndexes[0] < renameIndex && renameIndex < fsyncIndexes[1], '必须先 fsync 文件，再 rename，最后 fsync 父目录')
}

console.log('health-check-v1-test passed')
