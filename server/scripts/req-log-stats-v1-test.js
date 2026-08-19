'use strict'

// req-log-stats.js 纯函数锁定测试：解析/路径归一化/分位/聚合 + 输出零 IP/trace。

const assert = require('assert')
const r = require('./req-log-stats')

// 1) parseReqLine。
{
  const line = '[req] {"t":"2026-07-08T00:00:00Z","lvl":"info","trace":"deadbeef","method":"GET","path":"/healthz","status":200,"ms":12,"ip":"1.2.3.4"}'
  const e = r.parseReqLine(line)
  assert.strictEqual(e.path, '/healthz')
  assert.strictEqual(e.status, 200)
  assert.strictEqual(e.ms, 12)
  // journald 可能在 [req] 前带内容，仍应解析。
  assert.ok(r.parseReqLine('Jul 08 xxx ynzy[1]: [req] {"path":"/a","status":200,"ms":5}'), '前缀不影响解析')
  assert.strictEqual(r.parseReqLine('普通日志行无 req'), null, '非 req 行 → null')
  assert.strictEqual(r.parseReqLine('[req] not-json'), null, '坏 JSON → null')
  assert.strictEqual(r.parseReqLine('[req] {"path":"/a"}'), null, '缺 status → null')
}

// 2) normalizePath：折叠 id 段。含 Codex 对抗复现的真实 id 形态（多字母前缀 + 后台账号）。
{
  // 单字母前缀 + 长数字（原本就过）。
  assert.strictEqual(r.normalizePath('/listing/L1783427664217530/detail'), '/listing/:id/detail')
  assert.strictEqual(r.normalizePath('/users/123'), '/users/:id')
  assert.strictEqual(r.normalizePath('/f/deadbeefcafe1234'), '/f/:id')
  // 多字母前缀 domain.id：RC/SH/GU/GUO（Codex 打回的核心遗漏）。
  assert.strictEqual(r.normalizePath('/admin/recharges/RC1783427664217530/review'), '/admin/recharges/:id/review', 'RC 前缀必须折叠')
  assert.strictEqual(r.normalizePath('/showings/SH1783427664217530'), '/showings/:id', 'SH 前缀')
  assert.strictEqual(r.normalizePath('/groups/GU1783427664217530'), '/groups/:id', 'GU 前缀')
  assert.strictEqual(r.normalizePath('/groups/GUO1783427664217530/unlock'), '/groups/:id/unlock', 'GUO 三字母前缀')
  // 后台账号 id。
  assert.strictEqual(r.normalizePath('/admin/accounts/A001/status'), '/admin/accounts/:id/status', 'A001 账号')
  assert.strictEqual(r.normalizePath('/admin/accounts/A-SUPER/status'), '/admin/accounts/:id/status', 'A-SUPER 账号')
  // UUID / 长 token。
  assert.strictEqual(r.normalizePath('/x/550e8400-e29b-41d4-a716-446655440000'), '/x/:id', 'UUID')
  assert.strictEqual(r.normalizePath('/t/aB3xY9zK2mN7qP4wL8vR1s'), '/t/:id', '长不透明 token')
  // 真实路由词不得误折（防过度折叠）。
  assert.strictEqual(r.normalizePath('/admin/recharges/review'), '/admin/recharges/review', 'recharges/review 不折')
  assert.strictEqual(r.normalizePath('/admin/accounts/status'), '/admin/accounts/status')
  assert.strictEqual(r.normalizePath('/healthz'), '/healthz', '普通段不动')
  assert.strictEqual(r.normalizePath('/match/chat'), '/match/chat')
  assert.strictEqual(r.normalizePath('/mini/asr/realtime'), '/mini/asr/realtime', 'asr/realtime 不折')
  assert.strictEqual(r.normalizePath('/api/v1/listings'), '/api/v1/listings', 'v1 不折（数字位数不足）')
}

// 3) percentile：最近秩。
{
  assert.strictEqual(r.percentile([10, 20, 30, 40, 50], 50), 30)
  assert.strictEqual(r.percentile([10, 20, 30, 40, 50], 95), 50)
  assert.strictEqual(r.percentile([], 95), null, '空 → null')
  assert.strictEqual(r.percentile([42], 99), 42)
}

// 4) aggregate。
{
  const lines = [
    '[req] {"path":"/healthz","status":200,"ms":10,"ip":"9.9.9.9","trace":"aaa"}',
    '[req] {"path":"/healthz","status":200,"ms":20}',
    '[req] {"path":"/listing/L123456/detail","status":404,"ms":30}',
    '[req] {"path":"/match/chat","status":500,"ms":40}',
    '[req] {"path":"/match/chat","status":200,"ms":50}',
    '无关行'
  ]
  const entries = lines.map(r.parseReqLine).filter(Boolean)
  assert.strictEqual(entries.length, 5, '5 条有效 req')
  const agg = r.aggregate(entries, 10)
  assert.strictEqual(agg.total, 5)
  assert.strictEqual(agg.status.c2xx, 3)
  assert.strictEqual(agg.status.c4xx, 1)
  assert.strictEqual(agg.status.c5xx, 1)
  assert.strictEqual(agg.err4xxPct, 20)
  assert.strictEqual(agg.err5xxPct, 20)
  assert.strictEqual(agg.latencyMs.p50, 30)
  assert.strictEqual(agg.latencyMs.p95, 50)

  const chat = agg.endpoints.find((x) => x.path === '/match/chat')
  assert.strictEqual(chat.count, 2)
  assert.strictEqual(chat.err5xxPct, 50, '/match/chat 5xx 50%')
  const detail = agg.endpoints.find((x) => x.path === '/listing/:id/detail')
  assert.strictEqual(detail.err4xxPct, 100, '详情 4xx 100%（id 已折叠）')

  // 零 IP/trace 外泄。
  const json = JSON.stringify(agg)
  assert.strictEqual(/9\.9\.9\.9/.test(json), false, 'IP 不得进聚合输出')
  assert.strictEqual(/aaa/.test(json), false, 'trace 不得进聚合输出')
  assert.strictEqual(/L123456/.test(json), false, '具体 id 已折叠为 :id')
}

// 5) 空输入不崩。
{
  const agg = r.aggregate([], 10)
  assert.strictEqual(agg.total, 0)
  assert.strictEqual(agg.err5xxPct, null)
  assert.deepStrictEqual(agg.endpoints, [])
}

console.log('req-log-stats-v1-test passed')
