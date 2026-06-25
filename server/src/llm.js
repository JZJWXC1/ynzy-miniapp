const domain = require('./domain')
const {
  NO_FEATURE,
  LISTING_FEATURE_OPTIONS,
  parseFeatureInput
} = require('./listing-features')

const areaWords = ['滨江', '西兴', '长河', '浦沿', '萧山', '建设路', '上城区', '上城', '拱墅区', '拱墅', '西湖区', '西湖', '余杭', '临平', '钱塘', '钱江新城']
const layoutWords = ['一室', '两室', '二室', '三室', '四室', '整租', '合租', '公寓', '单间']
const featureAliases = {
  带阳台: ['带阳台', '阳台'],
  干湿分离: ['干湿分离'],
  燃气: ['燃气', '天然气', '煤气'],
  阁楼: ['阁楼', '带阁楼'],
  露台: ['露台', '带露台'],
  花园: ['花园', '带花园'],
  近地铁: ['近地铁', '地铁口', '地铁'],
  朝南: ['朝南', '南向'],
  独卫: ['独卫', '独立卫生间', '独立卫浴'],
  电梯: ['电梯'],
  整租: ['整租'],
  合租: ['合租'],
  免押金: ['免押金', '无押金', '零押金', '押金0', '押金为0']
}

function pickWord(text, words) {
  return words.find((word) => text.indexOf(word) !== -1) || ''
}

function parseNeedText(text) {
  const source = String(text || '').replace(/\s+/g, '')
  const budgetMatch = source.match(/预算?(\d{3,5})|(\d{3,5})(元|块|左右|以内)?/)
  const commuteMatch = source.match(/(?:通勤到|上班到|公司到|到)([^，。,.；;]{2,12})/)
  const moveInMatch = source.match(/(?:入住|搬入|起租|月底|月初|下周|今天|明天|周末)[^，。,.；;]{0,8}/)
  const features = LISTING_FEATURE_OPTIONS
    .filter((feature) => feature !== NO_FEATURE)
    .filter((feature) => (featureAliases[feature] || [feature]).some((word) => source.indexOf(word) !== -1))

  return {
    budget: budgetMatch ? budgetMatch[1] || budgetMatch[2] : '',
    area: pickWord(source, areaWords),
    layout: pickWord(source, layoutWords),
    moveIn: moveInMatch ? moveInMatch[0] : '',
    commute: commuteMatch ? commuteMatch[1].replace(/^到/, '') : '',
    features
  }
}

function mergeNeed(textNeed, formNeed = {}) {
  const rawFormFeatures = parseFeatureInput(formNeed.features)
  const formFeatures = rawFormFeatures.filter((item) => item !== NO_FEATURE)
  return {
    budget: formNeed.budget || textNeed.budget || '',
    area: formNeed.area || textNeed.area || '',
    layout: formNeed.layout || textNeed.layout || '',
    moveIn: formNeed.moveIn || textNeed.moveIn || '',
    commute: formNeed.commute || textNeed.commute || '',
    features: rawFormFeatures.length ? formFeatures : (textNeed.features || [])
  }
}

function localReply(need, result) {
  const parts = []
  if (need.budget) parts.push(`预算 ${need.budget}`)
  if (need.area) parts.push(`区域 ${need.area}`)
  if (need.layout) parts.push(`户型 ${need.layout}`)
  if (need.moveIn) parts.push(need.moveIn)
  if (need.commute) parts.push(`通勤到 ${need.commute}`)
  if (need.features && need.features.length) parts.push(`特点 ${need.features.join('、')}`)

  const conditionText = parts.length ? parts.join(' · ') : '当前需求'
  const top = result.listings[0]
  if (!top) {
    return `${conditionText} 暂时没有高匹配房源，建议放宽区域或预算。`
  }
  return `${conditionText} 已匹配到 ${result.listings.length} 套，已按相关性评分排序；优先看 ${top.title}，相关性 ${top.relevancePercent || top.matchScore}。`
}

function buildLocalMatch(db, payload = {}) {
  const textNeed = parseNeedText([payload.text, payload.voiceText].filter(Boolean).join('，'))
  const need = mergeNeed(textNeed, payload.form || {})
  const result = domain.matchListings(db, need)
  return {
    need,
    reply: localReply(need, result),
    listings: result.listings,
    mode: 'local-llm-adapter'
  }
}

function safeListingsForPrompt(listings) {
  return (listings || []).map((listing) => ({
    id: listing.id,
    title: listing.title,
    community: listing.community,
    area: listing.area,
    block: listing.block,
    layout: listing.layout,
    price: listing.price,
    sourceLabel: listing.sourceLabel,
    commissionText: listing.commissionText || listing.commission,
    noCommission: Boolean(listing.noCommission),
    features: listing.features,
    maintenanceText: listing.maintenanceText,
    relevancePercent: listing.relevancePercent || listing.matchScore,
    relevanceReasons: listing.relevanceReasons
  }))
}

function extractProviderText(body) {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.output_text === 'string') return body.output_text
  if (Array.isArray(body.choices) && body.choices[0]) {
    return body.choices[0].message && body.choices[0].message.content
      ? body.choices[0].message.content
      : body.choices[0].text || ''
  }
  if (body.output && Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => item.content || [])
      .map((item) => item.text || '')
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

async function callProvider(config, prompt) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node 版本不支持 fetch，请使用 Node 18 或以上')
  }

  const key = process.env[config.secretName || 'LLM_API_KEY']
  if (!config.apiBaseUrl || !key) {
    throw new Error('LLM API 地址或服务端密钥未配置')
  }

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: config.systemPrompt || '你是寓你配房小帮手。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  }

  const res = await fetch(config.apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    throw new Error(`LLM 请求失败：${res.status}`)
  }
  return extractProviderText(await res.json())
}

async function matchRentalNeed(db, payload = {}) {
  const local = buildLocalMatch(db, payload)
  const config = db.llmConfig || {}
  const promptListings = safeListingsForPrompt(local.listings)

  if (!config.enabled || config.provider === 'local') {
    return local
  }

  const prompt = [
    `租客需求：${[payload.text, payload.voiceText].filter(Boolean).join('，') || JSON.stringify(payload.form || {})}`,
    `解析条件：${JSON.stringify(local.need)}`,
    `本地匹配结果：${JSON.stringify(promptListings)}`,
    '只允许基于本地匹配结果里的房源生成回复，不能编造不存在的房源、价格、小区或联系方式。',
    '不要输出详细地址、房东联系方式、房间号、视频签名链接或任何隐藏敏感信息。',
    '每套房源已带 relevanceScore、relevancePercent 和 relevanceReasons，请基于这些评分给出推荐理由，不要改变排序。',
    '请用 80 字以内中文给出推荐理由，并提醒查看地址和房东联系方式会实名留痕。'
  ].join('\n')

  try {
    const reply = await callProvider(config, prompt)
    return {
      ...local,
      reply: reply || local.reply,
      mode: config.provider
    }
  } catch (error) {
    return {
      ...local,
      mode: 'local-fallback',
      warning: error.message
    }
  }
}

module.exports = {
  parseNeedText,
  buildLocalMatch,
  matchRentalNeed
}
