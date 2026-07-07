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

console.log('health-check-v1-test passed')
