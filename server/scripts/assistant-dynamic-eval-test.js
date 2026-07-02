const assert = require('assert')
const evalRunner = require('./assistant-eval-runner')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function main() {
  const db = evalRunner.makeDb()
  db.assistantEvalCases = [
    {
      id: 'AEC-RECOMMEND-WANDA',
      status: 'active',
      behavior: 'recommend',
      text: '拱墅万达附近有哪些2000左右的单间',
      expectedNeed: {
        anchorName: '拱墅万达',
        radiusKm: 3,
        layout: '单间',
        preferences: {
          budgetTolerance: 300
        }
      },
      expectedListingIds: ['WD01', 'WD02'],
      requiredNodes: ['sanitize_input', 'geo_place_tool', 'ranking_tool', 'output_guard']
    },
    {
      id: 'AEC-FOLLOWUP-MISSING-PLACE',
      status: 'active',
      behavior: 'ask_followup',
      text: '想住陌生小区，1500左右的一室整租',
      expectedNeed: {
        maxBudget: 1500
      },
      expectedListingIds: [],
      requiredNodes: ['confidence_gate', 'output_guard']
    },
    {
      id: 'AEC-DISABLED',
      status: 'disabled',
      behavior: 'recommend',
      text: '这条不应该被执行'
    }
  ]

  const dynamicItems = evalRunner.dynamicCasesFromDb(db)
  assert.strictEqual(dynamicItems.length, 2, '动态评估应过滤 disabled 样本')

  const singleResult = await evalRunner.runDynamicEvalCase(clone(db), dynamicItems[0])
  assert((singleResult.listings || []).some((item) => item.id === 'WD01'), '单条动态评估没有返回期望房源')
  assert(singleResult.traceSummary.nodes.includes('ranking_tool'), '单条动态评估缺少排序节点')

  const results = await evalRunner.runDynamicEvalCases(clone(db))
  assert.strictEqual(results.length, 2, '动态评估执行数量错误')
  results.forEach((result) => {
    assert.strictEqual(result.passed, true, `动态评估失败：${result.name} ${result.error || ''}`)
  })

  console.log('assistant-dynamic-eval-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
