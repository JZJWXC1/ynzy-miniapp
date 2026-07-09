'use strict'

// metric-readout.js 纯函数锁定测试：填充率/供给/成交/变现/护栏聚合正确 + 输出零 PII。

const assert = require('assert')
const m = require('./metric-readout')

// 合成 db（含 PII 探针 customerName/needId，用于验证不外泄）。
const db = {
  rentalNeeds: [{ id: 'N1' }, { id: 'N2' }, { id: 'N3' }, { id: 'N4' }], // 4 条需求
  footprints: [
    { action: '查看地址和电话', needId: 'N1', viewerId: 'U1' },
    { action: '查看地址和电话', needId: 'N2', viewerId: 'U1' },
    { action: '记录带看', needId: 'N3' }, // 非敏感查看 → 不计 L1
    { action: '查看地址和电话', needId: '' } // 空 needId → 不计
  ], // L1 = {N1,N2} = 2/4 = 50%
  clientReports: [
    { needId: 'N1', customerName: '张三丰', dateKey: '2026/7/8' },
    { needId: 'N1', customerName: '李四' } // 同 needId 去重 → {N1} = 1/4 = 25%
  ],
  dealRecords: [
    { needId: 'N1', status: '已确认', dealMonthlyRentFen: 350000, landlordCommissionFen: 100000 },
    { needId: 'N2', status: '待管理员确认', dealMonthlyRentFen: 400000, landlordCommissionFen: 0 }
  ], // L3提交 {N1,N2}=2/4=50%；L3已确认 {N1}=1/4=25%
  listings: [
    { coordinateSource: 'admin', mapLatitude: 30.35, mapLongitude: 120.16 }, // 有效坐标
    { coordinateSource: 'static-library', mapLatitude: 30.29, mapLongitude: 120.17 }, // 有效坐标
    { coordinateSource: 'admin', mapLatitude: 999, mapLongitude: 120.16 }, // 有来源标记但纬度非法 → 不可用（旧口径的高估病例）
    {} // 无坐标
  ], // 坐标可用 2/4=50%；无坐标 2/4=50%（按有效经纬度口径）
  rechargeBills: [
    { status: '已确认到账', amount: 100 },
    { status: '待支付', amount: 999 }
  ]
}

// 1) pct 边界。
assert.strictEqual(m.pct(1, 2), 50, 'pct 50')
assert.strictEqual(m.pct(0, 0), null, '0/0 → null 不造假 0')
assert.strictEqual(m.pct(1, 0), null, 'n/0 → null')
assert.strictEqual(m.pct(1, 3), 33.3, '一位小数')

// 2) 填充率。
{
  const f = m.computeFillRate(db)
  assert.strictEqual(f.needsTotal, 4, '需求总数')
  assert.strictEqual(f.fillL1_viewPct, 50, 'L1 敏感查看 50%（排除记录带看/空 needId）')
  assert.strictEqual(f.fillL2_reportPct, 25, 'L2 报备 25%（同 needId 去重）')
  assert.strictEqual(f.fillL3_dealSubmitPct, 50, 'L3 成交提交 50%')
  assert.strictEqual(f.fillL3_dealConfirmedPct, 25, 'L3 成交已确认 25%')
}

// 3) 供给坐标可用率（有效经纬度口径：来源标记存在但坐标非法的不计入）。
{
  const s = m.computeSupply(db)
  assert.strictEqual(s.listingsTotalRaw, 4)
  assert.strictEqual(s.coordAvailable, 2, '纬度 999 的病例不得计入可用')
  assert.strictEqual(s.coordAvailableRatePct, 50, '坐标可用率 50%')
  assert.strictEqual(s.coordRule, 'valid-latlng', '快照需自描述坐标口径')
  // 边界：(0,0) 占位、缺经度、字符串坐标均不可用；合法边界值可用
  assert.strictEqual(m.computeSupply({ listings: [{ mapLatitude: 0, mapLongitude: 0 }] }).coordAvailable, 0, '(0,0) 占位不可用')
  assert.strictEqual(m.computeSupply({ listings: [{ mapLatitude: 30.1 }] }).coordAvailable, 0, '缺经度不可用')
  assert.strictEqual(m.computeSupply({ listings: [{ mapLatitude: '30.35', mapLongitude: '120.16' }] }).coordAvailable, 1, '数值字符串坐标可用')
  assert.strictEqual(m.computeSupply({ listings: [{ mapLatitude: -90, mapLongitude: 180 }] }).coordAvailable, 1, '合法边界值可用')
}

// 4) 成交：仅已确认计入。
{
  const d = m.computeDeals(db)
  assert.strictEqual(d.dealsSubmitted, 2)
  assert.strictEqual(d.dealsConfirmed, 1, '仅已确认单')
  assert.strictEqual(d.gmvConfirmedYuan, 3500, 'GMV=350000分/100')
  assert.strictEqual(d.landlordCommissionConfirmedYuan, 1000)
}

// 5) 变现：仅已确认到账。
{
  const mo = m.computeMonetization(db)
  assert.strictEqual(mo.rechargeConfirmedCount, 1)
  assert.strictEqual(mo.rechargeConfirmedAmountYuan, 100)
}

// 6) 护栏：无坐标率。
{
  const g = m.computeGuardrails(db)
  assert.strictEqual(g.ghostNoCoordRatePct, 50)
}

// 7) 快照零 PII：输出里不得出现 needId 值/客户姓名/任何原始记录标识。
{
  const snap = m.buildSnapshot(db, { listingCount: 3, staleListingCount: 1, expiredListingCount: 0, userCount: 9, authedUsers: 7, todaySensitiveViews: 2, pendingShowingUploadCount: 1 })
  const json = JSON.stringify(snap)
  assert.strictEqual(/张三丰|李四/.test(json), false, '客户姓名不得外泄')
  assert.strictEqual(/N1|N2|N3|N4/.test(json), false, 'needId 值不得外泄')
  assert.strictEqual(/U1/.test(json), false, 'viewerId 不得外泄')
  assert.strictEqual(snap.northStar.valueAxis_fillL2_reportPct, 25, '北极星价值主轴=L2 25%')
  assert.strictEqual(snap.activity.userCount, 9, '活跃复用 dashboardSummary 口径')
  assert.strictEqual(snap.supply.effectiveListingCount, 3, '有效供给数取 summary')
}

// 8) summary 缺失（domain 不可用）不崩，活跃字段降级 null。
{
  const snap = m.buildSnapshot(db, null)
  assert.strictEqual(snap.activity.userCount, null, 'summary 缺失 → null 降级')
  assert.strictEqual(snap.fillRate.fillL2_reportPct, 25, '填充率不依赖 summary 仍可算')
}

// 9) appendSnapshot：追加带时间戳的 JSONL 行；可解析、含 t、仍零 PII；多次追加累积。
{
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const tmp = path.join(os.tmpdir(), 'metric-readout-append-test-' + process.pid + '.jsonl')
  try {
    fs.existsSync(tmp) && fs.unlinkSync(tmp)
    const snap = m.buildSnapshot(db, { listingCount: 3 })
    m.appendSnapshot(tmp, snap, '2026-07-08T02:30:00.000Z')
    m.appendSnapshot(tmp, snap, '2026-07-09T02:30:00.000Z')
    const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n')
    assert.strictEqual(lines.length, 2, '两次追加两行')
    const rec = JSON.parse(lines[0])
    assert.strictEqual(rec.t, '2026-07-08T02:30:00.000Z', '带时间戳 t')
    assert.strictEqual(rec.schema, 'metric-readout/v1', '含快照体')
    assert.strictEqual(rec.fillRate.fillL2_reportPct, 25, '追加体保真')
    assert.strictEqual(/张三丰|李四|N1|N2/.test(fs.readFileSync(tmp, 'utf8')), false, '追加文件仍零 PII')
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) { /* 忽略 */ }
  }
}

// 10) parseCliArgs：--append=/path 与 --pretty 解析。
{
  const a = m.parseCliArgs(['--pretty', '--append=/opt/x/metrics-snapshots.jsonl'])
  assert.strictEqual(a.pretty, true)
  assert.strictEqual(a.append, '/opt/x/metrics-snapshots.jsonl')
  assert.strictEqual(m.parseCliArgs([]).append, '', '默认不追加')
}

console.log('metric-readout-v1-test passed')
