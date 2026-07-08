'use strict'

// 读经营指标快照 JSONL（metric-readout --append 产出），打印最近 N 条的关键指标趋势。
// 只读、只吐聚合值。坏行自动跳过、文件缺失不崩。
//
// 用法：node server/scripts/show-metric-trend.js [--last=14] [--file=/opt/ynzy-miniapp/server/metrics-snapshots.jsonl]

const fs = require('fs')
const path = require('path')

const SERVER_DIR = path.join(__dirname, '..')

function defaultTrendPath() {
  return path.join(SERVER_DIR, 'metrics-snapshots.jsonl')
}

// 读 JSONL → 快照数组。坏行跳过，文件不存在返回 []（不抛）。
function readTrend(raw) {
  const out = []
  for (const line of String(raw || '').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') out.push(o)
    } catch (error) {
      // 坏行跳过
    }
  }
  return out
}

function num(v) {
  return v == null ? '-' : String(v)
}

// 一行关键指标：日期 | 北极星fillL2 | 有效供给 | 已过期 | 需求数 | L1查看% | 成交(确认)。
function formatRow(rec) {
  const r = rec && typeof rec === 'object' ? rec : {}
  const fill = r.fillRate || {}
  const supply = r.supply || {}
  const deals = r.deals || {}
  const ns = r.northStar || {}
  const day = String(r.t || '').slice(0, 10) || '(无时间)'
  return [
    day.padEnd(11),
    ('NS-fillL2=' + num(ns.valueAxis_fillL2_reportPct != null ? ns.valueAxis_fillL2_reportPct : fill.fillL2_reportPct) + '%').padEnd(16),
    ('有效供给=' + num(supply.effectiveListingCount)).padEnd(13),
    ('过期=' + num(supply.expiredListingCount)).padEnd(9),
    ('需求=' + num(fill.needsTotal)).padEnd(8),
    ('L1查看=' + num(fill.fillL1_viewPct) + '%').padEnd(13),
    '成交确认=' + num(deals.dealsConfirmed)
  ].join(' ')
}

function resolveArgs(argv) {
  const out = { last: 14, file: '' }
  for (const a of Array.isArray(argv) ? argv : []) {
    let mt = /^--last=(\d+)$/.exec(a)
    if (mt) out.last = Number(mt[1])
    mt = /^--file=(.+)$/.exec(a)
    if (mt) out.file = mt[1]
  }
  return out
}

if (require.main === module) {
  const args = resolveArgs(process.argv.slice(2))
  const file = args.file || defaultTrendPath()
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    process.stdout.write('（暂无经营快照趋势文件：' + file + '，等每日快照定时器产出）\n')
    process.exit(0)
  }
  const all = readTrend(raw)
  const shown = args.last > 0 ? all.slice(-args.last) : all
  process.stdout.write('经营指标趋势（最近 ' + shown.length + ' / 共 ' + all.length + ' 条快照）：\n')
  for (const rec of shown) process.stdout.write('  ' + formatRow(rec) + '\n')
}

module.exports = { readTrend, formatRow, resolveArgs, defaultTrendPath }
