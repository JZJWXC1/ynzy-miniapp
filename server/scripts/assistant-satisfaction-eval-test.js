// Yooni 推荐满意率评测器（第①刀·准星）
// 目的：把「推荐满意率」从 0 个数字变成可测的百分比 —— 用一批带满意度标注的真实需求跑真实 pipeline，
//       按精确优先口径给每条打分（满足硬条件且诚实=1，只有接近且诚实标注=0.5，误推/撒谎/答非所问=0）。
// 输出：整体满意率% + 分类明细 + 精确优先红线（误推=lie）计数；出现任一 lie 即非零退出（精确性回归门）。
// 种子集 17 条，覆盖 标准/预算/硬特征/模糊(应追问)/防幻觉/无房/指代/相邻降级。
// 注意：本基线跑在受控合成库 makeDb 上，测的是「助手逻辑满意率」，非生产真实满意率；
//       应逐步扩到 100–200 条真实中介需求（含②③刀新能力用例）才反映真实满意率。
const assistantService = require('../src/assistant-service')
const { makeDb } = require('./assistant-eval-runner')

function clone(v) { return JSON.parse(JSON.stringify(v)) }
function reset() { assistantService._internal.threadStore._internal.resetForTest() }
async function chat(db, payload) { return assistantService.chat(clone(db), { debugTrace: true, ...payload }, { userId: payload._u || 'sat-eval' }) }

function layoutMatches(listingLayout, want) {
  if (!want) return true
  return String(listingLayout || '').indexOf(want) !== -1
}
// 一条推荐房源是否满足本用例的硬条件（预算/户型/租法/小区/硬特征）
function satisfiesHard(l, hard = {}) {
  const rent = Number(l.rent || 0)
  if (hard.maxBudget && rent && rent > hard.maxBudget) return false
  if (hard.minBudget && rent && rent < hard.minBudget) return false
  if (hard.layout && !layoutMatches(l.layout, hard.layout)) return false
  if (hard.rentMode && String(l.rentMode || l.type || '').indexOf(hard.rentMode) === -1) return false
  if (hard.community && String(l.community || '').indexOf(hard.community) === -1) return false
  const feats = (l.features || [])
  for (const f of (hard.features || [])) {
    if (!feats.some((x) => String(x).indexOf(f) !== -1)) return false
  }
  return true
}

// 种子用例。expect.behavior: recommend | ask | no_result；recommend 需给 hard 供满意度判定。
const CASES = [
  // —— 标准结构化（应 recommend 且满足硬条件）——
  { id: 'std-radius-2room', cat: '标准', text: '新天地3公里内有哪些整租的两室', expect: { behavior: 'recommend', hard: { layout: '两室', rentMode: '整租' } } },
  { id: 'std-wanda-single', cat: '标准', text: '拱墅万达附近2000左右的单间', expect: { behavior: 'recommend', hard: { layout: '单间' } } },
  { id: 'std-budget-4000', cat: '预算', text: '新天地预算4000内，两室整租', expect: { behavior: 'recommend', hard: { maxBudget: 4000, layout: '两室', rentMode: '整租' } } },
  { id: 'std-community-2room', cat: '标准', text: '东新园整租两室预算3500', expect: { behavior: 'recommend', hard: { maxBudget: 3500, layout: '两室', rentMode: '整租', community: '东新园' } } },
  { id: 'std-near-community', cat: '相邻降级', text: '想住祥符空小区，1500左右的一室整租', expect: { behavior: 'recommend', hard: { layout: '一室', rentMode: '整租' } } },
  // —— 硬特征（必须满足；推了缺该特征的当"符合"即撒谎）——
  { id: 'hard-gas', cat: '硬特征', text: '新天地3公里内有哪些整租两室，必须有燃气', expect: { behavior: 'recommend', hard: { layout: '两室', rentMode: '整租', features: ['燃气'] } } },
  { id: 'hard-elevator', cat: '硬特征', text: '祥符一室整租，一定要电梯，1500左右', expect: { behavior: 'recommend', hard: { layout: '一室', rentMode: '整租', features: ['电梯'] } } },
  // —— 模糊/现字段无法表示：精确优先应【追问】，不应乱推（推了=撒谎）——
  { id: 'fuzzy-school', cat: '模糊', text: '带娃上学方便的', expect: { behavior: 'ask' } },
  { id: 'fuzzy-quiet', cat: '模糊', text: '想找个安静点的房子', expect: { behavior: 'ask' } },
  { id: 'fuzzy-commute', cat: '模糊', text: '通勤到黄龙半小时内的一室', expect: { behavior: 'ask' } },
  { id: 'fuzzy-only-feature', cat: '模糊', text: '必须有阳台', expect: { behavior: 'ask' } },
  // —— 防幻觉：冲突/多候选/未知小区 → 应【追问】——
  { id: 'guard-conflict', cat: '防幻觉', text: '拱墅万达附近2000左右整租单间', expect: { behavior: 'ask' } },
  { id: 'guard-ambiguous', cat: '防幻觉', text: '万达附近有哪些2000左右的单间', expect: { behavior: 'ask' } },
  { id: 'guard-unknown', cat: '防幻觉', text: '想住陌生小区，1500左右的一室整租', expect: { behavior: 'ask' } },
  // —— 无房：条件完整但无满足 → 应【no_result】，不许乱推——
  { id: 'noresult-4room', cat: '无房', text: '新天地3公里内有哪些整租四室，预算1000以内', expect: { behavior: 'no_result' } },
  // —— 指代/续问（多轮，末轮应继续找房 recommend）——
  { id: 'ref-cheaper', cat: '指代', turns: ['新天地3公里内有哪些4000以内整租的两室', '换一个便宜点的'], expect: { behavior: 'recommend', hard: { layout: '两室', rentMode: '整租' } } },
  { id: 'ref-switch', cat: '指代', turns: ['新天地3公里内有哪些4000以内整租的两室', '改看东新园两室'], expect: { behavior: 'recommend', hard: { layout: '两室', community: '东新园' } } },
  // —— 第②刀 NEED-1 证明：需求侧新特征可表达且精确匹配（改动前"干湿分离"被丢→把无该特征的两室当"符合"=撒谎；改动后只推真有的）——
  { id: 'need1-drywet', cat: 'NEED-1', text: '新天地3公里内两室整租，必须干湿分离', extraListings: [{ id: 'NEED1-A', community: '新天地', block: '新天地', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['干湿分离', '采光好'] }], expect: { behavior: 'recommend', hard: { layout: '两室', rentMode: '整租', features: ['干湿分离'] } } },
  { id: 'need1-garden', cat: 'NEED-1', text: '新天地3公里内两室整租，必须带花园', extraListings: [{ id: 'NEED1-G', community: '新天地', block: '新天地', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['带露台（阁楼）'] }], expect: { behavior: 'recommend', hard: { layout: '两室', rentMode: '整租', features: ['带露台（阁楼）'] } } },
  // P1-A 行为固化：普通区域（非半径）找房「必须带花园」不得被当小区名吞掉，真带露台房必须能推荐（need1-garden 走半径路绕过小区抽取，覆盖不到此漏推）。
  { id: 'need1-garden-area', cat: 'NEED-1', text: '想找拱墅两室整租，必须带花园', extraListings: [{ id: 'NEED1-GA', community: '金色家园', block: '金色家园', area: '拱墅', layout: '整租两室一厅一卫', room: '两室', rent: 3800, features: ['带露台（阁楼）'] }], expect: { behavior: 'recommend', hard: { layout: '两室', rentMode: '整租', features: ['带露台（阁楼）'] } } }
]

function behaviorOf(r) {
  const intent = r.intent || (r.traceSummary && r.traceSummary.intent) || ''
  if (intent === 'fallback' || intent === 'business_faq') return 'faq'
  if ((r.listings || []).length > 0) return 'recommend'
  if (r.nextQuestion) return 'ask'
  return 'no_result'
}

// 打分：返回 { score(0/0.5/1), lie(bool), detail }
function scoreCase(c, r) {
  const b = behaviorOf(r)
  const exp = c.expect.behavior
  if (exp === 'ask') return { score: b === 'ask' ? 1 : 0, lie: b === 'recommend', detail: `期望追问，实际=${b}` }
  if (exp === 'no_result') {
    // 严格：只有真"无房"(诚实空结果、不追问不FAQ)才满分；错误地追问/落FAQ均0分，误推算撒谎
    return { score: b === 'no_result' ? 1 : 0, lie: b === 'recommend', detail: `期望无房，实际=${b}` }
  }
  // recommend
  if (b !== 'recommend') return { score: 0, lie: false, detail: `期望推荐，实际=${b}（漏推/答非所问）` }
  const listings = r.listings || []
  const hard = c.expect.hard || {}
  const exact = listings.filter((l) => l.matchGroup === 'exact')
  const exactSat = exact.filter((l) => satisfiesHard(l, hard))
  const exactViolate = exact.filter((l) => !satisfiesHard(l, hard)) // 标"符合要求"却不满足硬条件 = 撒谎
  if (exactViolate.length) return { score: 0, lie: true, detail: `撒谎：${exactViolate.length} 套标"符合"却不满足硬条件（${exactViolate.map((x) => x.id).join(',')}）` }
  if (exactSat.length) return { score: 1, lie: false, detail: `${exactSat.length} 套精确满足` }
  // 只有接近房源：诚实标注(有差异说明)则给 0.5，否则 0
  const honestNearby = listings.every((l) => l.matchGroup !== 'exact' && (l.differenceText || l.matchGroupText))
  return { score: honestNearby ? 0.5 : 0, lie: false, detail: honestNearby ? '仅接近房源(已诚实标注)' : '无精确满足且标注不清' }
}

async function runCase(c) {
  reset()
  const db = makeDb()
  // 用例可追加特征房源（以 makeDb 首条为形状模板），用于验证②③刀新能力
  if (c.extraListings) c.extraListings.forEach((p) => db.listings.push({ ...db.listings[0], ...p }))
  let r
  for (const t of (c.turns || [c.text])) r = await chat(db, { text: t, threadId: r && r.threadId })
  return scoreCase(c, r)
}

async function main() {
  const results = []
  for (const c of CASES) results.push({ c, ...(await runCase(c)) })

  const byCat = {}
  let lies = 0
  for (const x of results) {
    if (x.lie) lies += 1
    const k = x.c.cat
    byCat[k] = byCat[k] || { sum: 0, n: 0 }
    byCat[k].sum += x.score; byCat[k].n += 1
  }
  const total = results.reduce((s, x) => s + x.score, 0)
  const rate = Math.round((total / results.length) * 1000) / 10

  console.log('===== Yooni 推荐满意率评测 =====')
  results.forEach((x) => console.log(`${x.score === 1 ? '✅' : x.score === 0.5 ? '🟡' : '❌'} [${x.c.cat}] ${x.c.id}  得分=${x.score}${x.lie ? ' ⚠撒谎' : ''}  ${x.detail}`))
  console.log('----- 分类满意率 -----')
  Object.keys(byCat).forEach((k) => console.log(`  ${k}: ${Math.round((byCat[k].sum / byCat[k].n) * 1000) / 10}%  (${byCat[k].n}条)`))
  console.log(`===== 总满意率：${rate}%  （${results.length} 条种子用例）=====`)
  const zeros = results.filter((x) => x.score === 0 && !x.c.knownGap).length
  console.log(`精确优先红线：撒谎(误推硬条件不满足) ${lies} 条` + (lies ? '  ❌ 违反精确优先' : '  ✅ 无') +
    `；满意率0分(漏推/答非所问/无房却追问) ${zeros} 条` + (zeros ? '  ❌' : '  ✅'))
  console.log('注：种子集(受控 makeDb)，应扩到 100–200 条真实中介需求；满意率数字用于每次改动前后对比。')

  // 准星回归门：任一撒谎 或 任一非「已知缺口(knownGap)」用例得 0 分即失败；0.5(诚实相邻降级)为允许的半分
  if (lies > 0 || zeros > 0) process.exit(1)
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1) })
}

module.exports = { CASES, scoreCase, satisfiesHard, runCase }
