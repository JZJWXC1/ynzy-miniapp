const assert = require('assert')
const {
  createTrace,
  appendTrace,
  summarizeTrace,
  _internal
} = require('../src/assistant/trace-logger')

function assertNoSensitiveText(value) {
  const text = JSON.stringify(value)
  ;[
    '13812345678',
    '13900000001',
    'wxid_secret12345',
    'OSSAccessKeyId=ak',
    'Signature=rawsig',
    '1幢',
    '2单元',
    '301室',
    '房号:A301'
  ].forEach((fragment) => {
    assert(!text.includes(fragment), `trace 摘要包含敏感片段：${fragment}`)
  })
}

function main() {
  const trace = createTrace({
    threadId: 'T001',
    userPhone: '13812345678',
    source: 'assistant-test'
  })

  assert.strictEqual(trace.version, 'assistant-trace-v1', 'trace 版本不正确')
  assert(Array.isArray(trace.events), 'trace events 应为数组')
  assert.strictEqual(trace.events.length, 0, 'createTrace 不应预置节点事件')
  assert(!JSON.stringify(trace).includes('13812345678'), 'meta 中手机号必须脱敏')

  const withInput = appendTrace(trace, 'sanitize_input', {
    text: '客户电话13812345678，微信wxid_secret12345，想看杭州市拱墅区杨家府1幢2单元301室，房号:A301',
    customerPhone: '13812345678'
  }, {
    text: '想看杨家府两室整租'
  })

  assert.strictEqual(trace.events.length, 0, 'appendTrace 应返回新对象，不应修改原 trace')
  assert.strictEqual(withInput.events.length, 1, '应追加第一个节点')
  assert.strictEqual(withInput.events[0].index, 0, '节点序号应从0开始')
  assert.strictEqual(withInput.events[0].node, 'sanitize_input', '节点名记录错误')
  assert(withInput.events[0].timestamp, '节点应记录时间戳')
  assert(!Number.isNaN(Date.parse(withInput.events[0].timestamp)), '节点时间戳应可解析')

  const withPlace = appendTrace(withInput, 'place_locator', {
    anchorName: '乐富智慧园',
    address: '杭州市拱墅区祥符街道乐富智慧园1幢2单元301室',
    landlordPhone: '13900000001',
    videoSignedUrl: 'https://example.com/a.mp4?OSSAccessKeyId=ak&Signature=rawsig'
  }, {
    anchorName: '乐富智慧园',
    coordinateVerified: false,
    nextQuestion: '乐富智慧园我没确认坐标，是祥符这边的吗？或者你再发我一个附近的地点。'
  })

  const withRanking = appendTrace(withPlace, 'ranking', {
    candidates: [
      {
        id: 'L001',
        community: '杨家府',
        rent: 2100,
        address: '杭州市拱墅区杨家府1幢2单元301室',
        landlordPhone: '13900000001'
      }
    ]
  }, {
    listings: [
      {
        id: 'L001',
        community: '杨家府',
        rent: 2100,
        distanceText: '距乐富智慧园约900m',
        matchReason: '预算接近，距离近',
        videoUrl: 'https://example.com/a.mp4?OSSAccessKeyId=ak&Signature=rawsig'
      }
    ]
  })

  assert.deepStrictEqual(
    withRanking.events.map((event) => event.node),
    ['sanitize_input', 'place_locator', 'ranking'],
    '节点顺序不正确'
  )

  assertNoSensitiveText(withRanking)

  const summary = summarizeTrace(withRanking)
  assert.strictEqual(summary.eventCount, 3, 'summary 节点数量不正确')
  assert.strictEqual(summary.timeline, 'sanitize_input -> place_locator -> ranking', 'summary 链路不正确')
  assert(summary.readable.includes('执行了3个节点'), 'summary 可读摘要缺失')
  assert(summary.steps[1].outputSummary.nextQuestion.includes('附近的地点'), 'summary 应保留可读追问')
  assertNoSensitiveText(summary)

  const masked = _internal.scrubSensitiveText('VX:broker888，电话13900000001，视频https://x.test/a.mp4?Signature=abc')
  assert(masked.includes('[微信号已隐藏]'), '微信号应脱敏')
  assert(masked.includes('[手机号已隐藏]'), '手机号应脱敏')
  assert(!masked.includes('Signature=abc'), '签名参数应脱敏')

  console.log('assistant-trace-v1-test passed')
}

main()
