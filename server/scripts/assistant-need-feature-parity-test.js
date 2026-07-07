// NEED-1 需求侧特征对齐测试（第②刀）
// 目标：房源侧 LISTING_FEATURE_OPTIONS 的每个实特征，需求侧都能解析出来（闭合"房源能标、需求点不动"）；
//       别名口径与房源侧自动打标签一致；匹配保持精确优先（有该硬特征才算精确，缺的不当"符合"）。
const assert = require('assert')
const { makeDb } = require('./assistant-eval-runner')
const assistantService = require('../src/assistant-service')
const { LISTING_FEATURE_OPTIONS, NO_FEATURE } = require('../src/listing-features')

function reset() { assistantService._internal.threadStore._internal.resetForTest() }
async function needResult(text, extra) {
  reset()
  const db = makeDb()
  if (extra) extra.forEach((p) => db.listings.push({ ...db.listings[0], ...p }))
  return assistantService.chat(JSON.parse(JSON.stringify(db)), { debugTrace: true, text }, { userId: 'parity-' + Math.random() })
}
function allFeatures(need = {}) {
  return [
    ...((need.hardConstraints && need.hardConstraints.features) || []),
    ...((need.preferences && need.preferences.features) || []),
    ...(need.features || [])
  ]
}

async function main() {
  let checks = 0

  // ① SSOT 一致性：每个非 legacy 房源特色都能被需求侧解析（房源能标的，中介一定点得动）
  const realOptions = LISTING_FEATURE_OPTIONS.filter((f) => f !== NO_FEATURE)
  for (const feat of realOptions) {
    const r = await needResult(`拱墅两室，必须${feat}`)
    assert(allFeatures(r.need).includes(feat), `需求侧应能解析房源特色「${feat}」，实际 features=${JSON.stringify(allFeatures(r.need))}`)
    checks += 1
  }

  // ② 别名口径与房源侧自动打标签(domain.js FEATURE_INFERENCE_RULES)完整一致：
  //    房源侧能从某词推断出的特征，需求侧必须也能从该词点动，否则"房源能标、需求点不动"=撒谎风险。
  //    本清单覆盖 domain.js 全部推断词，防今后单侧新增别名造成漂移。
  const aliasCases = [
    ['阳台', '带阳台'], ['干湿分离', '干湿分离'], ['干湿分区', '干湿分离'],
    ['天然气', '燃气'], ['煤气', '燃气'],
    ['阁楼', '带露台（阁楼）'], ['露台', '带露台（阁楼）'], ['带花园', '带露台（阁楼）'], ['花园房', '带露台（阁楼）'],
    ['地铁口', '近地铁'], ['地铁站', '近地铁'], ['号线', '近地铁'],
    ['南向', '朝南'],
    ['独立卫生间', '独卫'], ['独立厨卫', '独卫'], ['独厨独卫', '独卫'],
    ['南北通透', '采光好'], ['光线好', '采光好'], ['采光佳', '采光好'],
    ['短租', '可短租'], ['月付', '可月付'], ['押一付一', '可月付'],
    ['首租', '首次出租'], ['第一次出租', '首次出租'],
    ['民水', '民水民电'], ['民电', '民水民电']
  ]
  for (const [alias, feat] of aliasCases) {
    const r = await needResult(`拱墅两室，要${alias}`)
    assert(allFeatures(r.need).includes(feat), `别名「${alias}」应归一到「${feat}」，实际=${JSON.stringify(allFeatures(r.need))}`)
    checks += 1
  }

  // ③ 精确优先：有该硬特征的房源为 exact，缺该特征的不得作为 exact（不撒谎）
  const A = { id: 'PAR-A', community: '新天地', block: '新天地', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['干湿分离', '采光好'] }
  const B = { id: 'PAR-B', community: '新天地', block: '新天地', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'] }
  const r = await needResult('新天地3公里内两室整租，必须干湿分离', [A, B])
  assert((r.need.hardConstraints.features || []).includes('干湿分离'), '「必须干湿分离」应进硬特征')
  const items = r.listings || []
  const aItem = items.find((x) => x.id === 'PAR-A')
  const bItem = items.find((x) => x.id === 'PAR-B')
  assert(aItem && aItem.matchGroup === 'exact', 'PAR-A(有干湿分离) 应为精确匹配')
  assert(!(bItem && bItem.matchGroup === 'exact'), 'PAR-B(无干湿分离) 不应作为精确匹配（精确优先，不撒谎）')
  checks += 1

  // ④ P1-A 双向固化：「必须带花园」既不能被当小区名吞掉（否则真带露台房漏推），也不能把「阳光花园」普通房误标 exact。
  const G = { id: 'PAR-G', community: '阳光花园', block: '阳光花园', area: '拱墅', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'] }
  const RT = { id: 'PAR-RT', community: '金色家园', block: '金色家园', area: '拱墅', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['带露台（阁楼）'] }
  const rg = await needResult('想找拱墅两室整租，必须带花园', [G, RT])
  assert(!rg.need.community, '「必须带花园」不得被解析成小区名（否则真带露台房漏推），实际 community=' + JSON.stringify(rg.need.community))
  assert((rg.need.hardConstraints.features || []).includes('带露台（阁楼）'), '「必须带花园」应进硬特征 带露台（阁楼）')
  const rtItem = (rg.listings || []).find((x) => x.id === 'PAR-RT')
  const gItem = (rg.listings || []).find((x) => x.id === 'PAR-G')
  assert(rtItem && rtItem.matchGroup === 'exact', '真带「带露台（阁楼）」的房应被精确推荐（不漏推）')
  assert(!(gItem && gItem.matchGroup === 'exact'), '小区名「阳光花园」不应被当成 带露台（阁楼）特征而标 exact（防小区名误命中）')
  checks += 1

  // ⑤ P1-B 固化：房源侧「号线/地铁」小区名/标题回显不得凭空标近地铁；真「近地铁」tag 或「地铁口」语境仍 exact。
  //    注意「号线」在需求侧是合法意图（用户说号线＝要地铁，见 aliasCases），仅房源侧收紧——非对称，由 LISTING_UNSAFE_ALIASES 保证。
  const MXname = { id: 'PAR-MX1', community: '一号线公寓', block: '一号线公寓', area: '拱墅', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'] }
  const MXtitle = { id: 'PAR-MX2', community: '金色家园', block: '金色家园', area: '拱墅', title: '一号线公寓精装两室', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'] }
  const MXreal = { id: 'PAR-MX3', community: '金色家园', block: '金色家园', area: '拱墅', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['近地铁'] }
  const rm = await needResult('想找拱墅两室整租，必须近地铁', [MXname, MXtitle, MXreal])
  const mx1 = (rm.listings || []).find((x) => x.id === 'PAR-MX1')
  const mx2 = (rm.listings || []).find((x) => x.id === 'PAR-MX2')
  const mx3 = (rm.listings || []).find((x) => x.id === 'PAR-MX3')
  assert(!(mx1 && mx1.matchGroup === 'exact'), '小区名「一号线公寓」不应被标近地铁 exact（对硬条件撒谎）')
  assert(!(mx2 && mx2.matchGroup === 'exact'), '标题回显「一号线公寓」不应被标近地铁 exact')
  assert(mx3 && mx3.matchGroup === 'exact', '真带「近地铁」tag 的房应精确匹配（不误伤真信号）')
  checks += 1

  // ⑥ 系统性固化（对抗工作流 P1·title/meta 后门）：空 title 会被 publicListingTitle 回填成小区名、meta 含 locationSummary，
  //    普通房不得因小区名含特征字被任一特征标 exact。逐特征覆盖，防「阳台山庄→带阳台」这类系统性撒谎复发。
  const leakCases = [
    { community: '阳台山庄', feat: '带阳台', q: '必须带阳台' },
    { community: '阁楼公寓', feat: '带露台（阁楼）', q: '必须带阁楼' },
    { community: '南向嘉园', feat: '朝南', q: '必须朝南' },
    { community: '南北通透苑', feat: '采光好', q: '必须采光好' },
    { community: '民电家园', feat: '民水民电', q: '必须民水民电' },
    { community: '地铁口花园', feat: '近地铁', q: '必须近地铁' }
  ]
  for (const c of leakCases) {
    const bait = { id: 'PAR-LEAK', community: c.community, block: c.community, area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'] }
    const it = ((await needResult('想找拱墅两室整租，' + c.q, [bait])).listings || []).find((x) => x.id === 'PAR-LEAK')
    assert(!(it && it.matchGroup === 'exact'), `小区名「${c.community}」经 title/meta 回填不得被当「${c.feat}」标 exact（对硬条件撒谎）`)
    checks += 1
  }

  // ⑦ demand-eaten 固化（对抗工作流 P1·截断顺序）：含「有」字或无逗号的特征需求短语不得被截断当小区名，真房必须能推荐。
  const demandCases = ['想找拱墅两室整租，一定要有花园', '想找拱墅两室整租，必须要有花园', '想找拱墅两室整租必须带花园']
  for (const q of demandCases) {
    const real = { id: 'PAR-DM', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['带露台（阁楼）'] }
    const rd = await needResult(q, [real])
    assert(!rd.need.community, `「${q}」特征需求不得被当小区名，实际 community=` + JSON.stringify(rd.need.community))
    const it = (rd.listings || []).find((x) => x.id === 'PAR-DM')
    assert(it && it.matchGroup === 'exact', `「${q}」下真带露台房应被精确推荐（不漏推）`)
    checks += 1
  }

  // ⑧ 号线真标签召回固化（对抗工作流 P2·字段信任分层）：可信标签字段 tags=['2号线口'] 等真实写法应识别为近地铁并 exact；
  //    仅靠可信标签召回，不回退小区名撒谎（community 仅含号线的普通房仍须排除，见 ⑤）。
  const metroTag = { id: 'PAR-MT', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'], tags: ['2号线口'] }
  const mt = ((await needResult('想找拱墅两室整租，必须近地铁', [metroTag])).listings || []).find((x) => x.id === 'PAR-MT')
  assert(mt && mt.matchGroup === 'exact', '真实号线标签 tags=[2号线口] 应被识别为近地铁并 exact（可信标签字段召回）')
  checks += 1

  // ⑨ title 专名固化（对抗工作流二轮 P1）：title 内嵌『含特征语素的专名』(阳台苑/露台名邸/免押金公馆/南向嘉园/南北通透苑)
  //    ——不等于 community 值、掩码抓不到——不得让无真实标签的房被标 exact。硬特征满足只能来自标签字段，title 不支撑 exact。
  const titleNameCases = [
    { title: '阳光阳台苑B座', feat: '带阳台', q: '必须带阳台' },
    { title: '露台名邸2幢', feat: '带露台（阁楼）', q: '必须带露台' },
    { title: '免押金公馆1号楼', feat: '免押金', q: '必须免押金' },
    { title: '南向嘉园', feat: '朝南', q: '必须朝南' },
    { title: '南北通透苑', feat: '采光好', q: '必须采光好' }
  ]
  for (const c of titleNameCases) {
    const bait = { id: 'PAR-TN', community: '金色家园', block: '金色家园', area: '拱墅', title: c.title, layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'] }
    const it = ((await needResult('想找拱墅两室整租，' + c.q, [bait])).listings || []).find((x) => x.id === 'PAR-TN')
    assert(!(it && it.matchGroup === 'exact'), `title 专名「${c.title}」不得被当「${c.feat}」标 exact（title 不支撑硬特征）`)
    checks += 1
  }

  // ⑩ 可信标签里的地名 token 固化（对抗工作流二轮 P1）：tags 里塞进地名/桥名/楼盘专名(地铁明珠苑/短租桥/一号线公寓)
  //    不得凭裸别名子串冒充特征；真标签(2号线口/短租/可短租)整词或强语境仍 exact（见 ⑧ 与正例）。
  const tagNameCases = [
    { tags: ['地铁明珠苑'], feat: '近地铁', q: '必须近地铁' },
    { tags: ['一号线公寓'], feat: '近地铁', q: '必须近地铁' },
    { tags: ['短租桥'], feat: '可短租', q: '必须可短租' },
    { tags: ['短租弄'], feat: '可短租', q: '必须可短租' }
  ]
  for (const c of tagNameCases) {
    const bait = { id: 'PAR-TG', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'], tags: c.tags }
    const it = ((await needResult('想找拱墅两室整租，' + c.q, [bait])).listings || []).find((x) => x.id === 'PAR-TG')
    assert(!(it && it.matchGroup === 'exact'), `标签地名 token「${c.tags[0]}」不得裸子串冒充「${c.feat}」标 exact`)
    checks += 1
  }

  // ⑪ 量词漏推固化（对抗工作流二轮 P1）：「找个带花园/找套带花园/找个花园房/想找个带院子」量词不得打断特征需求擦除，真房必须推荐。
  const quantifierCases = ['找个带花园的拱墅两室整租', '找套带花园的拱墅两室整租', '找个花园房拱墅两室整租', '想找个带院子的拱墅两室整租']
  for (const q of quantifierCases) {
    const real = { id: 'PAR-QT', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['带露台（阁楼）'] }
    const rq = await needResult(q, [real])
    assert(!rq.need.community, `「${q}」量词+特征需求不得被当小区名，实际 community=` + JSON.stringify(rq.need.community))
    const it = (rq.listings || []).find((x) => x.id === 'PAR-QT')
    assert(it && it.matchGroup === 'exact', `「${q}」下真带露台房应被精确推荐（不漏推）`)
    checks += 1
  }

  // ⑫ 标签专名 token 固化（对抗工作流三轮 P1）：tags 里塞进以社区/楼盘后缀收尾的专名(阳台名邸/南向嘉园/通透雅苑/露台名邸/免押金公馆/民电家园)
  //    不得子串冒充特征标 exact；干净标签(带阁楼/采光好/独立卫生间/2号线口)仍 exact（见下 ⑮）。
  const tagProperNameCases = [
    { tags: ['阳台名邸'], feat: '带阳台', q: '必须带阳台' },
    { tags: ['南向嘉园'], feat: '朝南', q: '必须朝南' },
    { tags: ['通透雅苑'], feat: '采光好', q: '必须采光好' },
    { tags: ['露台名邸'], feat: '带露台（阁楼）', q: '必须带露台' },
    { tags: ['免押金公馆'], feat: '免押金', q: '必须免押金' },
    { tags: ['民电家园'], feat: '民水民电', q: '必须民水民电' }
  ]
  for (const c of tagProperNameCases) {
    const bait = { id: 'PAR-TP', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'], tags: c.tags }
    const it = ((await needResult('想找拱墅两室整租，' + c.q, [bait])).listings || []).find((x) => x.id === 'PAR-TP')
    assert(!(it && it.matchGroup === 'exact'), `标签专名「${c.tags[0]}」不得子串冒充「${c.feat}」标 exact`)
    checks += 1
  }

  // ⑬ description 撞词固化（对抗工作流三轮 P1）：自动打标签不得把「独立卫星电视→独卫」「居民电梯/便民电话→民水民电」等撞词误烘焙。
  const descCollisionCases = [
    { description: '房间配独立卫星电视，家电齐全', feat: '独卫', q: '必须独卫' },
    { description: '小区有居民电梯', feat: '民水民电', q: '必须民水民电' },
    { description: '提供便民电话服务', feat: '民水民电', q: '必须民水民电' }
  ]
  for (const c of descCollisionCases) {
    const bait = { id: 'PAR-DC', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'], description: c.description }
    const it = ((await needResult('想找拱墅两室整租，' + c.q, [bait])).listings || []).find((x) => x.id === 'PAR-DC')
    assert(!(it && it.matchGroup === 'exact'), `description「${c.description}」不得撞词烘焙成「${c.feat}」标 exact`)
    checks += 1
  }

  // ⑭ 软偏好漏推固化（对抗工作流三轮 P2）：「优先/尽量/看重带花园」软偏好前缀不得让特征需求被当小区名 → 真房漏推。
  const softPrefCases = ['想找拱墅两室整租，优先带花园', '想找拱墅两室整租，尽量带花园', '拱墅两室整租，我比较看重带花园']
  for (const q of softPrefCases) {
    const real = { id: 'PAR-SP', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, tags: ['带露台（阁楼）'] }
    const rs = await needResult(q, [real])
    assert(!rs.need.community, `「${q}」软偏好特征需求不得被当小区名，实际 community=` + JSON.stringify(rs.need.community))
    const it = (rs.listings || []).find((x) => x.id === 'PAR-SP')
    assert(it && it.matchGroup === 'exact', `「${q}」下真带露台房应被精确推荐（不漏推）`)
    checks += 1
  }

  // ⑮ 干净标签/描述正例固化（防上面的 token 专名护栏过切造成漏推）：这些真信号必须仍 exact。
  const cleanPositives = [
    { p: { tags: ['带阁楼'] }, feat: '带露台（阁楼）', q: '必须带露台' },
    { p: { tags: ['采光好'] }, feat: '采光好', q: '必须采光好' },
    { p: { tags: ['独立卫生间'] }, feat: '独卫', q: '必须独卫' },
    { p: { tags: ['2号线口'] }, feat: '近地铁', q: '必须近地铁' },
    { p: { description: '配备独立卫生间，南北通透采光好' }, feat: '独卫', q: '必须独卫' },
    { p: { description: '紧邻2号线出行方便' }, feat: '近地铁', q: '必须近地铁' }
  ]
  for (const c of cleanPositives) {
    const good = { id: 'PAR-CP', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['电梯'], ...c.p }
    const it = ((await needResult('想找拱墅两室整租，' + c.q, [good])).listings || []).find((x) => x.id === 'PAR-CP')
    assert(it && it.matchGroup === 'exact', `干净信号 ${JSON.stringify(c.p)} 应被识别为「${c.feat}」并 exact（护栏不得过切）`)
    checks += 1
  }

  // ⑯ 后缀白名单外的专名 tag 固化（对抗工作流四轮 P1·根治）：「别名+任意后缀」的专名(阳台山/电梯华都/免押金时代/朝南象屿/露台美地)
  //    因房源侧只认整词、不子串，一律不得冒充特征标 exact——不依赖有限后缀枚举。
  const suffixNameCases = [
    { tags: ['阳台山'], feat: '带阳台', q: '必须带阳台' },
    { tags: ['电梯华都'], feat: '电梯', q: '必须电梯' },
    { tags: ['免押金时代'], feat: '免押金', q: '必须免押金' },
    { tags: ['朝南象屿'], feat: '朝南', q: '必须朝南' },
    { tags: ['露台美地'], feat: '带露台（阁楼）', q: '必须带露台' }
  ]
  for (const c of suffixNameCases) {
    const bait = { id: 'PAR-SN', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: [], tags: c.tags }
    const it = ((await needResult('想找拱墅两室整租，' + c.q, [bait])).listings || []).find((x) => x.id === 'PAR-SN')
    // 核心防撒谎：专名标签不得被烘焙成该特征；也不得作为该硬特征的精确匹配
    assert(!(it && (it.features || []).includes(c.feat)), `别名+后缀专名「${c.tags[0]}」不得被烘焙成特征「${c.feat}」`)
    assert(!(it && it.matchGroup === 'exact' && String(it.matchReason || '').includes(c.feat)), `专名「${c.tags[0]}」不得以「${c.feat}」为由标 exact`)
    checks += 1
  }

  // ⑰ 否定标签固化（对抗工作流四轮 P1）：显式否定的标签(无电梯/非首次出租/不可短租/没有阳台)不得被当成满足硬条件而标 exact。
  const negationTagCases = [
    { tags: ['无电梯'], feat: '电梯', q: '必须电梯' },
    { tags: ['非首次出租'], feat: '首次出租', q: '必须首次出租' },
    { tags: ['不可短租'], feat: '可短租', q: '必须可短租' },
    { tags: ['没有阳台'], feat: '带阳台', q: '必须带阳台' }
  ]
  for (const c of negationTagCases) {
    const bait = { id: 'PAR-NG', community: '金色家园', block: '金色家园', area: '拱墅', title: '', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: [], tags: c.tags }
    const it = ((await needResult('想找拱墅两室整租，' + c.q, [bait])).listings || []).find((x) => x.id === 'PAR-NG')
    // 核心防撒谎：显式否定的标签不得被烘焙成正特征，也不得以该特征为由标 exact
    assert(!(it && (it.features || []).includes(c.feat)), `否定标签「${c.tags[0]}」不得被烘焙成正特征「${c.feat}」`)
    assert(!(it && it.matchGroup === 'exact' && String(it.matchReason || '').includes(c.feat)), `否定标签「${c.tags[0]}」不得以「${c.feat}」为由标 exact`)
    checks += 1
  }

  console.log(`assistant-need-feature-parity-test passed: ${checks} checks`)
}

main().catch((e) => { console.error(e); process.exit(1) })
