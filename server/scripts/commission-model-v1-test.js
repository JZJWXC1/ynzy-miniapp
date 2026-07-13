'use strict'

// 平台分佣模型锁定测试（money 级）。基数=成交总佣金 landlordCommissionFen。
// 业主/二房东：上传20%+平台10%（分出30%），带看成交中介净留70%；公司0；自传自带全免。

const assert = require('assert')
process.env.REPORT_DEAL_WRITES_ENABLED = '1' // 结算模型测试显式进入历史恢复模式。
const domain = require('../src/domain')

const OWNER = '业主房源'
const SUBLEASE = '二房东房源'
const COMPANY = '公司房源'

function makeDb() {
  return { users: [{ id: 'U1' }, { id: 'U2' }, { id: 'ADM', isAdmin: true, role: '管理员' }] }
}

// 1) 默认比例：业主/二房东 上传20+平台10=分出30。
{
  const d = makeDb()
  const owner = domain.commissionRuleForListing({ ownerType: OWNER, uploaderId: 'U1' }, d, 'U1', 'U2')
  assert.strictEqual(owner.uploaderRate, 20, '业主上传20')
  assert.strictEqual(owner.platformRate, 10, '业主平台10')
  assert.strictEqual(owner.rate, 30, '业主分出30')

  const sub = domain.commissionRuleForListing({ ownerType: SUBLEASE, uploaderId: 'U1' }, d, 'U1', 'U2')
  assert.strictEqual(sub.uploaderRate, 20, '二房东上传20（由15统一为20）')
  assert.strictEqual(sub.platformRate, 10, '二房东平台10')
  assert.strictEqual(sub.rate, 30)
}

// 2) 公司房源：不分佣（带看全佣）。
{
  const d = makeDb()
  const comp = domain.commissionRuleForListing({ ownerType: COMPANY, companyListing: true, uploaderId: 'U1' }, d, 'U1', 'U2')
  assert.strictEqual(comp.rate, 0, '公司房源 rate 0 → 不生成分佣记录')
  assert.strictEqual(comp.uploaderRate, 0)
  assert.strictEqual(comp.platformRate, 0)
}

// 3) 自传自带（成交人==上传人）：全免、不生成分佣记录；不同人则正常分佣。
{
  const d = makeDb()
  const self = domain.commissionRuleForListing({ ownerType: OWNER, uploaderId: 'U1' }, d, 'U1', 'U1')
  assert.deepStrictEqual(self, { rate: 0, uploaderRate: 0, platformRate: 0 }, '自传自带全免（rate 0 → 不生成分佣记录）')
  const other = domain.commissionRuleForListing({ ownerType: OWNER, uploaderId: 'U1' }, d, 'U1', 'U2')
  assert.strictEqual(other.rate, 30, '不同人正常分佣30')
}

// 4) 管理员上传：不给上传人分佣，平台仍抽。
{
  const d = makeDb()
  const adm = domain.commissionRuleForListing({ ownerType: OWNER, uploaderId: 'ADM' }, d, 'ADM', 'U2')
  assert.strictEqual(adm.uploaderRate, 0, '管理员上传不给上传人分佣')
  assert.strictEqual(adm.platformRate, 10, '平台仍抽10')
}

// 5) Fen 计算（confirmDeal 同款公式）：基数=成交总佣金。
{
  const uploaderRate = 20
  const platformRate = 10
  const landlordCommissionFen = 1000000 // 10000 元
  const uploaderFen = Math.round(landlordCommissionFen * uploaderRate / 100)
  const platformFen = Math.round(landlordCommissionFen * platformRate / 100)
  assert.strictEqual(uploaderFen, 200000, '上传人=总佣金20%')
  assert.strictEqual(platformFen, 100000, '平台=总佣金10%')
  assert.strictEqual(landlordCommissionFen - uploaderFen - platformFen, 700000, '带看中介净留70%')
}

// 6) 后台可配 + 上限保护。
{
  const d = makeDb()
  domain.setCommissionConfig(d, 'ADM', { ownerRate: 25, ownerPlatformRate: 15, secondLandlordRate: 18, secondLandlordPlatformRate: 12 })
  const cfg = domain.commissionConfig(d)
  assert.strictEqual(cfg.ownerRate, 25, '业主上传比例可配')
  assert.strictEqual(cfg.ownerPlatformRate, 15, '业主平台比例可配')
  assert.strictEqual(cfg.secondLandlordRate, 18)
  assert.strictEqual(cfg.secondLandlordPlatformRate, 12)
  const owner = domain.commissionRuleForListing({ ownerType: OWNER, uploaderId: 'U1' }, d, 'U1', 'U2')
  assert.strictEqual(owner.uploaderRate, 25, '配置生效到规则')
  assert.strictEqual(owner.platformRate, 15)
  assert.strictEqual(owner.rate, 40)
  domain.setCommissionConfig(d, 'ADM', { ownerRate: 200, ownerPlatformRate: 0 })
  assert.ok(domain.commissionConfig(d).ownerRate <= 100, '单档超100被夹到<=100（防客户端配非法比例）')
  assert.strictEqual(domain.commissionConfig(d).companyRate, 0, '公司房源恒0')
}

// 7) 合计上限（money 守恒）：上传+平台>100 拒绝；=100 允许且确认签单不超发。
{
  const d = makeDb()
  assert.throws(
    () => domain.setCommissionConfig(d, 'ADM', { secondLandlordRate: 60, secondLandlordPlatformRate: 60 }),
    (e) => e && e.statusCode === 400,
    '二房东 上传60+平台60 应被拒绝（合计120会超发）'
  )
  assert.throws(
    () => domain.setCommissionConfig(d, 'ADM', { ownerRate: 70, ownerPlatformRate: 40 }),
    (e) => e && e.statusCode === 400,
    '业主 上传70+平台40 应被拒绝'
  )
  // =100 允许（带看净留 0，账仍守恒）
  domain.setCommissionConfig(d, 'ADM', { secondLandlordRate: 60, secondLandlordPlatformRate: 40 })
  const rule = domain.commissionRuleForListing({ ownerType: SUBLEASE, uploaderId: 'U1' }, d, 'U1', 'U2')
  const landlordFen = 1000000
  const upFen = Math.round(landlordFen * rule.uploaderRate / 100)
  const platFen = Math.round(landlordFen * rule.platformRate / 100)
  assert.ok(upFen + platFen <= landlordFen, '分佣合计不得超过成交总佣金（money 守恒）')
}

// 7.1) 负比例必须明确 400，不能静默夹成 0；拒绝后配置和审计足迹都必须零变化。
{
  const cases = [
    { label: '顶层业主上传人比例', payload: { ownerRate: -1 } },
    { label: '顶层二房东平台比例字符串', payload: { secondLandlordPlatformRate: '-0.01' } },
    { label: '嵌套业主上传人比例', payload: { uploaderRates: { [OWNER]: -5 } } },
    { label: '嵌套二房东平台比例', payload: { platformRates: { [SUBLEASE]: -10 } } }
  ]
  cases.forEach(({ label, payload }) => {
    const d = makeDb()
    d.commissionConfig = { ownerRate: 25, ownerPlatformRate: 15, secondLandlordRate: 18, secondLandlordPlatformRate: 12, updatedBy: 'OLD' }
    d.footprints = [{ id: 'EXISTING' }]
    const before = JSON.parse(JSON.stringify(d))
    assert.throws(
      () => domain.setCommissionConfig(d, 'ADM', payload),
      (error) => error && error.statusCode === 400 && /不能小于 0/.test(error.message),
      `${label}必须返回 400`
    )
    assert.deepStrictEqual(d, before, `${label}拒绝后不得改配置或新增足迹`)
  })

  const zero = makeDb()
  domain.setCommissionConfig(zero, 'ADM', { ownerRate: 0, ownerPlatformRate: 0 })
  assert.strictEqual(domain.commissionConfig(zero).ownerRate, 0, '0 仍是合法比例，不能误伤原规则')
}

// 7.2) 显式畸形比例不能假成功后静默回退旧值；拒绝后配置与审计足迹零变化。
{
  const cases = [
    { label: '顶层非数字', payload: { ownerRate: 'abc' } },
    { label: '别名负无穷', payload: { secondLandlordUploaderRate: '-1e999' } },
    { label: '嵌套正无穷', payload: { platformRates: { [OWNER]: Infinity } } },
    { label: '布尔值', payload: { ownerRate: false } },
    { label: '空数组', payload: { ownerRate: [] } },
    { label: '单元素数组', payload: { ownerRate: [5] } },
    { label: '空字符串', payload: { ownerRate: '' } },
    { label: '纯空白', payload: { ownerRate: '   ' } },
    { label: '对象', payload: { ownerRate: {} } }
  ]
  cases.forEach(({ label, payload }) => {
    const d = makeDb()
    d.commissionConfig = { ownerRate: 25, ownerPlatformRate: 15, secondLandlordRate: 18, secondLandlordPlatformRate: 12, updatedBy: 'OLD' }
    d.footprints = [{ id: 'EXISTING' }]
    const before = JSON.parse(JSON.stringify(d))
    assert.throws(
      () => domain.setCommissionConfig(d, 'ADM', payload),
      (error) => error && error.statusCode === 400 && /有限数字/.test(error.message),
      `${label}必须返回 400`
    )
    assert.deepStrictEqual(d, before, `${label}拒绝后不得改配置或新增足迹`)
  })
}

// 8) 上传人比例可配到 >30%（不再被默认总分出卡死）——阻断1 规则层。
{
  const d = makeDb()
  domain.setCommissionConfig(d, 'ADM', { secondLandlordRate: 40, secondLandlordPlatformRate: 10 })
  const rule = domain.commissionRuleForListing({ ownerType: SUBLEASE, uploaderId: 'U1' }, d, 'U1', 'U2')
  assert.strictEqual(rule.uploaderRate, 40, '上传人比例可配 40（>30 不被卡死）')
  assert.strictEqual(rule.rate, 50)
}

// 9) 结算端最后防线：异常冻结快照/脏配置绕过入口，confirmDeal 也拒绝、不生成分佣记录；正常100仍可确认。
{
  // (a) 异常冻结快照 120%（模拟历史脏数据/人工编辑）。
  const d = makeDb()
  d.listings = [{ id: 'L1', ownerType: SUBLEASE, uploaderId: 'U1', status: '待确认' }]
  d.dealRecords = [{
    id: 'D1', listingId: 'L1', uploaderId: 'U1', brokerId: 'U2', reportId: 'R1',
    landlordCommissionFen: 1000000, status: '待管理员确认',
    commissionRule: { rate: 120, uploaderRate: 60, platformRate: 60 }
  }]
  d.commissionRecords = []
  assert.throws(
    () => domain.confirmDeal(d, 'ADM', 'D1'),
    (e) => e && (e.statusCode === 500 || e.statusCode === 400),
    '异常冻结快照(120%) confirmDeal 必须 fail-loud'
  )
  assert.strictEqual(d.commissionRecords.length, 0, '拒绝后不得生成分佣记录')

  // (b) 异常持久化配置(60+60)派生的坏快照也被拦住。
  const d2 = makeDb()
  d2.commissionConfig = { secondLandlordRate: 60, secondLandlordPlatformRate: 60, ownerRate: 20, ownerPlatformRate: 10 }
  const badRule = domain.commissionRuleForListing({ ownerType: SUBLEASE, uploaderId: 'U1' }, d2, 'U1', 'U2')
  assert.strictEqual(badRule.rate, 120, '脏配置确实派生出 120% 坏快照')
  d2.listings = [{ id: 'L2', ownerType: SUBLEASE, uploaderId: 'U1', status: '待确认' }]
  d2.dealRecords = [{ id: 'D2', listingId: 'L2', uploaderId: 'U1', brokerId: 'U2', reportId: 'R2', landlordCommissionFen: 1000000, status: '待管理员确认', commissionRule: badRule }]
  d2.commissionRecords = []
  assert.throws(() => domain.confirmDeal(d2, 'ADM', 'D2'), (e) => e && e.statusCode >= 400, '脏配置派生的坏快照也拒绝')
  assert.strictEqual(d2.commissionRecords.length, 0)

  // (c) 正常 60+40=100（守恒边界）仍可确认且不超发。
  const d3 = makeDb()
  d3.listings = [{ id: 'L3', ownerType: SUBLEASE, uploaderId: 'U1', status: '待确认' }]
  d3.dealRecords = [{ id: 'D3', listingId: 'L3', uploaderId: 'U1', brokerId: 'U2', reportId: 'R3', landlordCommissionFen: 1000000, status: '待管理员确认', commissionRule: { rate: 100, uploaderRate: 60, platformRate: 40 } }]
  d3.commissionRecords = []
  const ok = domain.confirmDeal(d3, 'ADM', 'D3')
  assert.strictEqual(d3.commissionRecords.length, 1, '60+40=100 正常确认生成记录')
  assert.ok(ok.commissionRecord.uploaderCommissionFen + ok.commissionRecord.platformCommissionFen <= 1000000, '合计不超过成交总佣金')
}

console.log('commission-model-v1-test passed')
