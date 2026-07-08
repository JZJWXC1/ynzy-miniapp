'use strict'

// [req] 请求链路日志聚合器（稳定层 S3：满意率地基健康 / 端点健康护栏）。
// 从 stdin 读 journald 的 [req] 行，输出各端点 4xx/5xx 与 P50/P95/P99 时延——仅聚合值，不吐 IP/trace。
//
// 用法（服务器上）：
//   journalctl -u ynzy-miniapp --since "1 hour ago" -o cat | node server/scripts/req-log-stats.js
//   journalctl -u ynzy-miniapp -o cat | node server/scripts/req-log-stats.js --top=15
//
// 边界：纯读日志文本，不碰 index.js/request-log.js/domain.js；request-log.js 只逐条 emit，
// 分位/分端点错误率必须在此聚合后才有——本脚本即那个聚合器。

// ---------- 纯函数（可单测） ----------

// 解析一行日志，取 '[req] ' 后的 JSON。非 req 行 / 坏 JSON → null（容错，不中断）。
function parseReqLine(line) {
  const s = String(line == null ? '' : line)
  const at = s.indexOf('[req] ')
  if (at === -1) return null
  const jsonText = s.slice(at + 6).trim()
  if (!jsonText || jsonText[0] !== '{') return null
  try {
    const o = JSON.parse(jsonText)
    const status = Number(o.status)
    const ms = Number(o.ms)
    if (!Number.isFinite(status)) return null
    return { path: String(o.path || ''), method: String(o.method || ''), status, ms: Number.isFinite(ms) ? ms : null }
  } catch (error) {
    return null
  }
}

// 归一化 pathname：把疑似 id 段折叠成 :id，便于聚合、也不回显具体真实 id。
// id 形态来源（据实核对，非虚构）：
//   - domain.id(prefix) = 前缀 + Date.now() + 3 位随机 = 前缀 + 13~16 位数字；
//     前缀实测枚举：C/D/F/L/N/P/R/GU/GUO/RC/SH（1~3 个字母）。
//   - 后台账号路径 id：A001（A+数字）、A-SUPER（A-短横线+词）。
//   - UUID / 长不透明 token（base64url 等）。
// 任何新增 id 前缀都应在此补规则；规则均要求"够像 id"，避免误折 healthz/recharges/accounts 等真实路由词。
const ID_SEGMENT_RES = [
  /^\d+$/, // 纯数字
  /^[A-Za-z]{1,5}\d{5,}$/, // 字母前缀(1~5)+长数字：覆盖全部 domain.id 输出（含 RC/SH/GU/GUO 多字母前缀）
  /^A\d+$/, // 后台账号 A001
  /^A-[A-Za-z0-9_-]+$/, // 后台账号 A-SUPER
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // UUID
  /^[0-9a-f]{8,}$/i, // 长 hex（trace 类）
  /^(?=.*\d)[A-Za-z0-9_-]{20,}$/ // 长不透明 token（≥20 且含数字，保守不误折普通词）
]

function looksLikeId(seg) {
  return ID_SEGMENT_RES.some((re) => re.test(seg))
}

function normalizePath(p) {
  const path = String(p || '')
  if (!path) return ''
  return path
    .split('/')
    .map((seg) => (seg && looksLikeId(seg) ? ':id' : seg))
    .join('/')
}

// 最近秩法分位（p ∈ 0..100）。空数组 → null。
function percentile(nums, p) {
  const arr = (Array.isArray(nums) ? nums : []).filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b)
  if (!arr.length) return null
  const rank = Math.ceil((p / 100) * arr.length)
  const idx = Math.min(arr.length - 1, Math.max(0, rank - 1))
  return arr[idx]
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null
}

// 聚合一批已解析 entry。topN 控制回传端点明细数（按请求量降序）。
function aggregate(entries, topN) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  const total = list.length
  const clazz = { c2xx: 0, c3xx: 0, c4xx: 0, c5xx: 0 }
  const allMs = []
  const byPath = new Map()
  for (const e of list) {
    const bucket = e.status >= 500 ? 'c5xx' : e.status >= 400 ? 'c4xx' : e.status >= 300 ? 'c3xx' : 'c2xx'
    clazz[bucket]++
    if (e.ms != null) allMs.push(e.ms)
    const key = normalizePath(e.path)
    let row = byPath.get(key)
    if (!row) { row = { path: key, count: 0, err4xx: 0, err5xx: 0, ms: [] }; byPath.set(key, row) }
    row.count++
    if (e.status >= 500) row.err5xx++
    else if (e.status >= 400) row.err4xx++
    if (e.ms != null) row.ms.push(e.ms)
  }
  const endpoints = Array.from(byPath.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, Number.isFinite(topN) && topN > 0 ? topN : 20)
    .map((r) => ({
      path: r.path,
      count: r.count,
      err4xxPct: pct(r.err4xx, r.count),
      err5xxPct: pct(r.err5xx, r.count),
      p95ms: percentile(r.ms, 95)
    }))
  return {
    schema: 'req-log-stats/v1',
    total,
    status: clazz,
    err4xxPct: pct(clazz.c4xx, total),
    err5xxPct: pct(clazz.c5xx, total),
    latencyMs: { p50: percentile(allMs, 50), p95: percentile(allMs, 95), p99: percentile(allMs, 99) },
    endpoints
  }
}

// ---------- CLI（读 stdin） ----------

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = /^--top=(\d+)$/.exec(a)
    if (m) out.top = Number(m[1])
  }
  return out
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2))
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { buf += chunk })
  process.stdin.on('end', () => {
    const entries = buf.split('\n').map(parseReqLine).filter(Boolean)
    process.stdout.write('[reqstats] ' + JSON.stringify(aggregate(entries, args.top)) + '\n')
  })
}

module.exports = { parseReqLine, normalizePath, percentile, pct, aggregate }
