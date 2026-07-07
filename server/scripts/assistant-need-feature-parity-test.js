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
    ['阁楼', '带露台（阁楼）'], ['露台', '带露台（阁楼）'], ['花园', '带露台（阁楼）'],
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

  console.log(`assistant-need-feature-parity-test passed: ${checks} checks`)
}

main().catch((e) => { console.error(e); process.exit(1) })
