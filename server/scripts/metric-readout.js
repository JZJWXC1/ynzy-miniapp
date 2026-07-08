'use strict'

// 经营指标只读快照（稳定层→增长层 装准星 S1/S2）。
// 双主轴北极星里【价值主轴=需求填充率-报备(fillL2)】的线上只读读出，外加供给/活跃/漏斗/成交/变现/护栏。
// 质量主轴【满意率】由 yooni 线离线评测产出，不在本脚本。
//
// 设计与边界：
// - 只 READ db.json（同 health-check 的 resolveDbPath 模式）+ require('../src/domain') 调其【已导出纯函数】
//   dashboardSummary(db)，复用应用自身的供给/活跃口径；不 EDIT domain.js/index.js/assistant。
// - 输出【仅聚合值：计数/比率/金额汇总】，绝不输出任何原始记录/needId/姓名/电话/地址等 PII。
// - createdAt/time 多为 'YYYY/M/D 下午…' 本地串且无 dateKey，故按天趋势仅对有 dateKey 的集合可靠；
//   本 v1 主打【时点比率】(填充率/坐标可用率等快照不依赖分桶)，趋势维度后续补。
//
// 用法：node server/scripts/metric-readout.js            # 打印 [metric] {…} 聚合快照
//       node server/scripts/metric-readout.js --pretty   # 缩进输出

const fs = require('fs')
const path = require('path')

const SERVER_DIR = path.join(__dirname, '..')

function resolveDbPath() {
  const env = process.env.DATA_FILE || ''
  if (env && path.isAbsolute(env)) return env
  return path.join(SERVER_DIR, env || 'data/db.json')
}

function loadDb(raw) {
  const text = String(raw || '').charCodeAt(0) === 65279 ? String(raw).slice(1) : String(raw || '')
  return JSON.parse(text)
}

// ---------- 纯函数（可单测，无副作用，只读 db，只吐聚合） ----------

// 一位小数百分比；分母为 0 返回 null（不制造 0/0=0 的假象）。
function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null
}

// 收集满足 pred 且带非空 needId 的记录所覆盖的 needId 集合（去重）。只吐 size，不吐 id。
function coveredNeedIds(rows, needIds, pred) {
  const set = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const nid = row && row.needId
    if (nid && needIds.has(nid) && pred(row)) set.add(nid)
  }
  return set.size
}

// 需求填充率 L1/L2/L3：一条需求是否产生了下游撮合动作（按 needId 归因）。价值主轴本体。
function computeFillRate(db) {
  const needs = Array.isArray(db.rentalNeeds) ? db.rentalNeeds : []
  const needIds = new Set(needs.map((n) => n && n.id).filter(Boolean))
  const total = needIds.size
  const l1 = coveredNeedIds(db.footprints, needIds, (f) => f.action === '查看地址和电话') // 敏感查看解锁
  const l2 = coveredNeedIds(db.clientReports, needIds, () => true) // 报备（价值主轴）
  const l3s = coveredNeedIds(db.dealRecords, needIds, () => true) // 成交提交
  const l3c = coveredNeedIds(db.dealRecords, needIds, (d) => d.status === '已确认') // 成交已确认
  return {
    needsTotal: total,
    fillL1_viewPct: pct(l1, total),
    fillL2_reportPct: pct(l2, total),
    fillL3_dealSubmitPct: pct(l3s, total),
    fillL3_dealConfirmedPct: pct(l3c, total),
    _counts: { l1, l2, l3s, l3c }
  }
}

// 供给数据完备率：坐标可用率（能进半径/地图检索）。无坐标房源在 match-service 被静默过滤。
function computeSupply(db) {
  const listings = Array.isArray(db.listings) ? db.listings : []
  const withCoord = listings.filter(
    (l) => l && l.coordinateSource && l.coordinateSource !== 'pending-map-coordinate'
  ).length
  return {
    listingsTotalRaw: listings.length,
    coordAvailable: withCoord,
    coordAvailableRatePct: pct(withCoord, listings.length) // 全库口径（分母为整库，非 publicListings）
  }
}

// 成交与 GMV：仅【已确认】单计入实成交，排除待确认噪声。金额分→元。
function computeDeals(db) {
  const deals = Array.isArray(db.dealRecords) ? db.dealRecords : []
  const confirmed = deals.filter((d) => d && d.status === '已确认')
  const gmvFen = confirmed.reduce((s, d) => s + Number(d.dealMonthlyRentFen || 0), 0)
  const commFen = confirmed.reduce((s, d) => s + Number(d.landlordCommissionFen || 0), 0)
  return {
    dealsSubmitted: deals.length,
    dealsConfirmed: confirmed.length,
    gmvConfirmedYuan: Math.round(gmvFen / 100),
    landlordCommissionConfirmedYuan: Math.round(commFen / 100)
  }
}

// 现金变现：仅【已确认到账】充值计入。
function computeMonetization(db) {
  const bills = Array.isArray(db.rechargeBills) ? db.rechargeBills : []
  const paid = bills.filter((b) => b && b.status === '已确认到账')
  const amt = paid.reduce((s, b) => s + Number(b.amount || 0), 0)
  return { rechargeConfirmedCount: paid.length, rechargeConfirmedAmountYuan: Math.round(amt * 100) / 100 }
}

// 护栏只读监控：幽灵/无坐标供给率（防堆陈旧房源做大供给深度）。
function computeGuardrails(db) {
  const listings = Array.isArray(db.listings) ? db.listings : []
  const noCoord = listings.filter(
    (l) => !l || !l.coordinateSource || l.coordinateSource === 'pending-map-coordinate'
  ).length
  return { ghostNoCoordRatePct: pct(noCoord, listings.length) }
}

// 组装快照：只保留聚合值。summary 为 domain.dashboardSummary(db) 的结果（复用应用口径）。
function buildSnapshot(db, summary) {
  const fill = computeFillRate(db)
  const s = summary && typeof summary === 'object' ? summary : {}
  return {
    schema: 'metric-readout/v1',
    northStar: {
      note: '双主轴：质量轴=满意率(yooni线离线评测,不在本脚本) × 价值轴=需求填充率-报备',
      valueAxis_fillL2_reportPct: fill.fillL2_reportPct
    },
    supply: Object.assign({}, computeSupply(db), {
      effectiveListingCount: s.listingCount != null ? s.listingCount : null, // dashboardSummary 口径
      staleListingCount: s.staleListingCount != null ? s.staleListingCount : null,
      expiredListingCount: s.expiredListingCount != null ? s.expiredListingCount : null
    }),
    activity: {
      userCount: s.userCount != null ? s.userCount : null,
      authedUsers: s.authedUsers != null ? s.authedUsers : null,
      todaySensitiveViews: s.todaySensitiveViews != null ? s.todaySensitiveViews : null,
      pendingShowingUploadCount: s.pendingShowingUploadCount != null ? s.pendingShowingUploadCount : null
    },
    fillRate: {
      needsTotal: fill.needsTotal,
      fillL1_viewPct: fill.fillL1_viewPct,
      fillL2_reportPct: fill.fillL2_reportPct,
      fillL3_dealSubmitPct: fill.fillL3_dealSubmitPct,
      fillL3_dealConfirmedPct: fill.fillL3_dealConfirmedPct
    },
    deals: computeDeals(db),
    monetization: computeMonetization(db),
    guardrails: computeGuardrails(db)
  }
}

// dashboardSummary：优先用 domain 已导出纯函数（复用口径）；require/调用异常则降级为 null 摘要（快照仍可出）。
function loadSummary(db) {
  try {
    const domain = require('../src/domain')
    if (domain && typeof domain.dashboardSummary === 'function') return domain.dashboardSummary(db)
  } catch (error) {
    process.stderr.write('[metric] dashboardSummary 不可用，供给/活跃口径降级：' + (error && error.message) + '\n')
  }
  return {}
}

// 追加一条带时间戳的快照到 JSONL（每日趋势）。record 应为 buildSnapshot 结果（仅聚合、无 PII）。
// 幂等追加：一行一条 JSON，坏行不影响后续读取。nowIso 显式传入以便单测确定性。
function appendSnapshot(filePath, snapshot, nowIso) {
  const record = Object.assign({ t: nowIso }, snapshot)
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n')
  return record
}

function parseCliArgs(argv) {
  const out = { pretty: false, append: '' }
  for (const a of Array.isArray(argv) ? argv : []) {
    if (a === '--pretty') out.pretty = true
    const m = /^--append=(.+)$/.exec(a)
    if (m) out.append = m[1]
  }
  return out
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2))
  let db
  try {
    db = loadDb(fs.readFileSync(resolveDbPath(), 'utf8'))
  } catch (error) {
    process.stderr.write('[metric] db 读取/解析失败：' + (error && error.message) + '\n')
    process.exit(1)
  }
  const snapshot = buildSnapshot(db, loadSummary(db))
  process.stdout.write('[metric] ' + JSON.stringify(snapshot, null, args.pretty ? 2 : 0) + '\n')
  if (args.append) {
    try {
      appendSnapshot(args.append, snapshot, new Date().toISOString())
      process.stderr.write('[metric] 已追加快照到 ' + args.append + '\n')
    } catch (error) {
      process.stderr.write('[metric] 追加失败：' + (error && error.message) + '\n')
      process.exit(1)
    }
  }
}

module.exports = { pct, coveredNeedIds, computeFillRate, computeSupply, computeDeals, computeMonetization, computeGuardrails, buildSnapshot, resolveDbPath, loadDb, appendSnapshot, parseCliArgs }
