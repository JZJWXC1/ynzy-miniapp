const { normalizeAsrText } = require('../asr-normalizer')

function normalizeIntent(value) {
  const text = String(value || '').trim()
  if (/^(rental_match|match|find_house|找房|匹配)$/.test(text)) return 'rental_match'
  if (/^(business_faq|faq|help|业务规则)$/.test(text)) return 'business_faq'
  return ''
}

function detectBusinessTopic(text) {
  if (/报备|客户手机号|客户电话|客源/.test(text)) return 'report'
  if (/签单|成交|佣金|分佣|房东实际支付|月租/.test(text)) return 'deal'
  if (/地图|坐标|定位|小区位置|map/.test(text)) return 'map'
  if (/房态|维护|核验|失效|下架|第\s*[357]\s*天/.test(text)) return 'maintenance'
  if (/房源群|积分|充值|换群|微信支付/.test(text)) return 'hidden'
  if (/规则|怎么用|帮助|说明|FAQ|faq/.test(text)) return 'general'
  return ''
}

function looksLikeRentalNeed(text) {
  return /找房|推荐|匹配|房源|预算|租金|价位|以内|左右|公里|千米|周边|附近|上班|工作|通勤|一室|两室|三室|四室|单间|整租|合租|小区|区域|滨江|拱墅|西湖|上城|萧山|余杭|钱塘|近地铁|阳台|燃气|独卫|电梯|朝南|养宠|\d{3,5}/.test(text)
}

function looksLikeMapUsageQuestion(text) {
  return /地图|坐标|定位|小区位置|map/.test(text) &&
    /怎么用|如何|为什么|为啥|没有|没|无|不显示|看不到|打不开|不准|失败|偏移|规则|说明|帮助/.test(text)
}

function routeIntent(payload = {}, sanitizedText = '') {
  const explicit = normalizeIntent(payload.intent)
  if (explicit) {
    return {
      intent: explicit,
      topic: explicit === 'business_faq' ? detectBusinessTopic(sanitizedText) || 'general' : ''
    }
  }

  const text = normalizeAsrText([
    sanitizedText,
    payload.text,
    payload.voiceText
  ].filter(Boolean).join(' '))
  const rentalNeed = looksLikeRentalNeed(text)
  const businessTopic = detectBusinessTopic(text)
  if (rentalNeed && (!businessTopic || (businessTopic === 'map' && !looksLikeMapUsageQuestion(text)))) {
    return { intent: 'rental_match', topic: '' }
  }
  if (businessTopic) return { intent: 'business_faq', topic: businessTopic }
  return { intent: 'fallback', topic: 'general' }
}

module.exports = {
  routeIntent,
  _internal: {
    detectBusinessTopic,
    looksLikeMapUsageQuestion,
    looksLikeRentalNeed
  }
}
