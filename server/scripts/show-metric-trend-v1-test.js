'use strict'

// show-metric-trend.js 纯函数测试：readTrend 坏行跳过 / formatRow 容错 / resolveArgs。

const assert = require('assert')
const t = require('./show-metric-trend')

// 1) readTrend：合法行解析、坏行跳过、空 → []。
{
  const raw = [
    JSON.stringify({ t: '2026-07-08T02:30:00Z', schema: 'metric-readout/v1', fillRate: { fillL2_reportPct: 0, needsTotal: 8 } }),
    '坏行不是 json',
    '',
    JSON.stringify({ t: '2026-07-09T02:30:00Z', fillRate: { fillL2_reportPct: 12.5, needsTotal: 10 } })
  ].join('\n')
  const rows = t.readTrend(raw)
  assert.strictEqual(rows.length, 2, '两条合法、坏行/空行跳过')
  assert.strictEqual(rows[0].fillRate.needsTotal, 8)
  assert.deepStrictEqual(t.readTrend(''), [], '空 → []')
  assert.deepStrictEqual(t.readTrend(null), [], 'null → []')
}

// 2) formatRow：正常行含日期与北极星；缺字段不崩、以 - 占位。
{
  const line = t.formatRow({ t: '2026-07-08T02:30:00Z', northStar: { valueAxis_fillL2_reportPct: 0 }, fillRate: { needsTotal: 8, fillL1_viewPct: 50 }, supply: { effectiveListingCount: 37, expiredListingCount: 40 }, deals: { dealsConfirmed: 0 } })
  assert.ok(line.indexOf('2026-07-08') !== -1, '含日期')
  assert.ok(line.indexOf('NS-fillL2=0%') !== -1, '含北极星 fillL2')
  assert.ok(line.indexOf('有效供给=37') !== -1)
  const empty = t.formatRow({})
  assert.ok(empty.indexOf('-') !== -1, '缺字段以 - 占位不崩')
  assert.doesNotThrow(() => t.formatRow(null), 'null 不崩')
}

// 3) resolveArgs。
{
  assert.strictEqual(t.resolveArgs(['--last=7']).last, 7)
  assert.strictEqual(t.resolveArgs(['--file=/x/y.jsonl']).file, '/x/y.jsonl')
  assert.strictEqual(t.resolveArgs([]).last, 14, '默认 last=14')
}

console.log('show-metric-trend-v1-test passed')
