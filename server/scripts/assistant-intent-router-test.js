const assert = require('assert')
const { routeIntent, _internal } = require('../src/assistant/intents')

function assertRoute(input, expectedIntent, expectedTopic, message) {
  const payload = typeof input === 'string' ? { text: input } : input
  const result = routeIntent(payload)
  assert.strictEqual(result.intent, expectedIntent, `${message}：意图不正确`)
  assert.strictEqual(result.topic, expectedTopic, `${message}：主题不正确`)
}

function main() {
  assertRoute('拱墅万达附近房源有哪些', 'rental_match', '', '地点周边房源查询应进入找房')
  assertRoute('新天地3公里内整租两室', 'rental_match', '', '半径整租两室查询应进入找房')
  assertRoute({ voiceText: '乐富智慧园附近1500一室整租' }, 'rental_match', '', '语音转写的预算户型查询应进入找房')

  assertRoute('地图怎么用', 'business_faq', 'map', '地图使用说明应进入地图 FAQ')
  assertRoute('为什么地图没有坐标', 'business_faq', 'map', '地图坐标缺失说明应进入地图 FAQ')
  assertRoute('为什么地图没有定位', 'business_faq', 'map', '地图定位缺失说明应进入地图 FAQ')

  assert.strictEqual(_internal.detectBusinessTopic('拱墅万达附近房源有哪些'), '', '附近房源查询不应被识别为地图 FAQ')
  assert.strictEqual(_internal.detectBusinessTopic('地图怎么用'), 'map', '地图使用问题应保留 map 主题')
  assert.strictEqual(_internal.looksLikeMapUsageQuestion('为什么地图没有坐标'), true, '地图坐标缺失应识别为地图使用问题')
  assert.strictEqual(_internal.looksLikeMapUsageQuestion('拱墅万达附近房源有哪些'), false, '地点周边找房不应识别为地图使用问题')

  console.log('assistant-intent-router-test passed')
}

main()
