'use strict'

// 健康巡检 health-check.js 纯函数锁定测试：evaluateDb / parseDfFreePct / aggregate。

const assert = require('assert')
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
  const disabled = hc.evaluateFeishuSyncState({}, {
    nowMs,
    autoSyncEnabled: false,
    controllerMode: '',
    intervalMinutes: 30
  })
  assert.strictEqual(disabled.ok, true)
  assert.strictEqual(disabled.skipped, '自动同步未启用')

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
      id: 'RUN-UNKNOWN',
      state: 'unknown',
      updatedAt: nowMs - 1000,
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

  const fresh = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{ id: 'RUN-OK', state: 'succeeded', finishedAt: nowMs - 20 * 60 * 1000 }]
  }, {
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

  const partialAfterOldSuccess = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{
      id: 'RUN-FULL-OLD',
      state: 'succeeded',
      finishedAt: nowMs - 4 * 60 * 60 * 1000,
      updatedAt: nowMs - 4 * 60 * 60 * 1000
    }, {
      id: 'RUN-MATERIAL-WARNING',
      state: 'succeeded',
      errorCode: 'MATERIALS_PARTIAL_FAILURE',
      finishedAt: nowMs - 5 * 60 * 1000,
      updatedAt: nowMs - 5 * 60 * 1000
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
  assert.strictEqual(partialAfterOldSuccess.ok, false, '最新任务仅素材部分失败时不得报告全链路健康')
  assert.strictEqual(partialAfterOldSuccess.degraded, true, '素材部分失败必须明确标记 degraded')
  assert.strictEqual(partialAfterOldSuccess.lastState, 'succeeded', '库存提交成功状态仍应如实保留')
  assert.strictEqual(partialAfterOldSuccess.lastSuccessAgeMinutes, 240, '素材告警不得刷新上一次完整成功时间')
  assert.match(partialAfterOldSuccess.detail, /素材.*未完整|未完整.*素材/, '健康摘要应明确素材链路未完整')

  const repeatedPartial = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{
      id: 'RUN-MATERIAL-WARNING-1',
      state: 'succeeded',
      errorCode: 'MATERIALS_PARTIAL_FAILURE',
      finishedAt: nowMs - 40 * 60 * 1000,
      updatedAt: nowMs - 40 * 60 * 1000
    }, {
      id: 'RUN-MATERIAL-WARNING-2',
      state: 'succeeded',
      errorCode: 'MATERIALS_PARTIAL_FAILURE',
      finishedAt: nowMs - 10 * 60 * 1000,
      updatedAt: nowMs - 10 * 60 * 1000
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

  const partialFollowedByDryRun = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{
      id: 'RUN-FULL-BEFORE-WARNING',
      state: 'succeeded',
      finishedAt: nowMs - 30 * 60 * 1000,
      updatedAt: nowMs - 30 * 60 * 1000
    }, {
      id: 'RUN-MATERIAL-WARNING-BEFORE-DRY',
      state: 'succeeded',
      errorCode: 'MATERIALS_PARTIAL_FAILURE',
      finishedAt: nowMs - 20 * 60 * 1000,
      updatedAt: nowMs - 20 * 60 * 1000
    }, {
      id: 'RUN-DRY-AFTER-WARNING',
      state: 'dry-succeeded',
      dryRun: true,
      finishedAt: nowMs - 5 * 60 * 1000,
      updatedAt: nowMs - 5 * 60 * 1000
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
  assert.strictEqual(partialFollowedByDryRun.ok, false, '后续 dry-run 不得遮住最近正式运行的素材告警')
  assert.strictEqual(partialFollowedByDryRun.degraded, true, '素材告警后的 dry-run 仍必须保持 degraded')
  assert.strictEqual(partialFollowedByDryRun.lastSuccessAgeMinutes, 30, 'dry-run 不得刷新完整正式成功时间')

  const stale = hc.evaluateFeishuSyncState({
    feishuSyncRuns: [{ id: 'RUN-STALE', state: 'succeeded', finishedAt: nowMs - 4 * 60 * 60 * 1000 }]
  }, {
    nowMs,
    autoSyncEnabled: true,
    controllerMode: 'worker-v2',
    schemaApproved: true,
    resourceApproved: true,
    writeLockEnabled: true,
    intervalMinutes: 30
  })
  assert.strictEqual(stale.ok, false, '超过三个调度周期仍无成功任务必须告警')
}

console.log('health-check-v1-test passed')
