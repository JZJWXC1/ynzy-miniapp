const assert = require('assert')
const { createLangGraph } = require('../src/assistant/graph-runner')

async function main() {
  const graph = createLangGraph({
    start: 'start_node',
    nodes: {
      start_node: async (state) => ({
        readyToMatch: Boolean(state.payload && state.payload.ready)
      }),
      high_branch: async (state) => ({
        reply: state.readyToMatch ? '进入匹配' : '不应进入'
      }),
      low_branch: async (state) => ({
        reply: state.readyToMatch ? '不应进入' : '继续追问'
      })
    },
    edges: {
      start_node: (state) => state.readyToMatch ? 'high_branch' : 'low_branch',
      high_branch: '__end__',
      low_branch: '__end__'
    }
  })

  let state = await graph.run({ payload: { ready: true } })
  assert.strictEqual(state.reply, '进入匹配', 'LangGraph 条件边没有进入高分支')
  assert.deepStrictEqual(state.trace, ['start_node', 'high_branch'], 'LangGraph trace 顺序错误')
  assert(state.structuredTrace, '应生成结构化 trace')
  assert.strictEqual(state.structuredTrace.events.length, 2, '结构化 trace 节点数量错误')
  assert.strictEqual(state.traceSummary.eventCount, 2, 'trace 摘要节点数量错误')
  assert.deepStrictEqual(state.traceSummary.nodes, ['start_node', 'high_branch'], 'trace 摘要节点顺序错误')
  assert(state.traceSummary.timeline.indexOf('start_node -> high_branch') !== -1, 'trace 摘要缺少链路')

  state = await graph.run({ payload: { ready: false } })
  assert.strictEqual(state.reply, '继续追问', 'LangGraph 条件边没有进入低分支')
  assert.deepStrictEqual(state.trace, ['start_node', 'low_branch'], 'LangGraph trace 顺序错误')
  assert.strictEqual(state.traceSummary.eventCount, 2, '低分支 trace 摘要节点数量错误')
  assert.deepStrictEqual(state.traceSummary.nodes, ['start_node', 'low_branch'], '低分支 trace 摘要节点顺序错误')

  console.log('assistant-langgraph-runner-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
