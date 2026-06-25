const AREA_WORDS = [
  '拱墅区',
  '拱墅',
  '西湖区',
  '西湖',
  '上城区',
  '上城',
  '滨江',
  '萧山',
  '北部软件园',
  '城北万象城',
  '万达',
  '文三路',
  '学院路',
  '翠苑',
  '东新园',
  '杭氧',
  '新天地',
  '闸弄口',
  '新塘',
  '元宝塘',
  '东站'
]

const LAYOUT_WORDS = [
  '一室',
  '1室',
  '二室',
  '两室',
  '2室',
  '三室',
  '3室',
  '四室',
  '4室',
  '五室',
  '5室',
  '六室',
  '6室',
  '整租',
  '合租',
  '公寓'
]

function normalizeLayout(value) {
  return String(value || '')
    .replace('1室', '一室')
    .replace('二室', '两室')
    .replace('2室', '两室')
    .replace('3室', '三室')
    .replace('4室', '四室')
    .replace('5室', '五室')
    .replace('6室', '六室')
}

function pickWord(text, words) {
  return words.find((word) => text.indexOf(word) !== -1) || ''
}

function parseNeedText(text) {
  const source = String(text || '').replace(/\s+/g, '')
  const budgetMatch = source.match(/(?:预算|租金|价格|价位)[^\d]*(\d{3,5})/) ||
    source.match(/(\d{3,5})(?:元|块|左右|以内|以下)?/)
  const area = pickWord(source, AREA_WORDS)
  const layout = normalizeLayout(pickWord(source, LAYOUT_WORDS))
  const moveInMatch = source.match(/(?:入住|搬入|起租|月底|月初|下周|今天|明天|周末)[^，。,.；;]{0,8}/)
  const commuteMatch = source.match(/(?:通勤到|通勤|上班到|上班|公司到|公司|到)([^，。,.；;]{2,12})/)

  return {
    budget: budgetMatch ? budgetMatch[1] : '',
    area,
    layout,
    moveIn: moveInMatch ? moveInMatch[0] : '',
    commute: commuteMatch ? commuteMatch[1].replace(/^到/, '') : ''
  }
}

function getRecordRecognitionManager() {
  if (typeof requirePlugin !== 'function') return null
  try {
    const plugin = requirePlugin('WechatSI')
    if (!plugin || !plugin.getRecordRecognitionManager) return null
    return plugin.getRecordRecognitionManager()
  } catch (error) {
    return null
  }
}

function createController(handlers = {}) {
  const manager = getRecordRecognitionManager()
  if (!manager) return null

  manager.onStart(() => {
    if (handlers.onStart) handlers.onStart()
  })
  manager.onRecognize((res) => {
    const text = (res && res.result) || ''
    if (text && handlers.onRecognize) handlers.onRecognize(text)
  })
  manager.onStop((res) => {
    const text = (res && res.result) || ''
    if (handlers.onStop) handlers.onStop(text, res)
  })
  manager.onError((res) => {
    if (handlers.onError) handlers.onError(res)
  })

  return {
    start() {
      manager.start({
        lang: 'zh_CN',
        duration: 60000
      })
    },
    stop() {
      manager.stop()
    }
  }
}

module.exports = {
  parseNeedText,
  createController
}
