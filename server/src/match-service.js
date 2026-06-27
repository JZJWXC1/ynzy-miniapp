const domain = require('./domain')
const {
  NO_FEATURE,
  DEPOSIT_FREE_FEATURE,
  parseFeatureInput
} = require('./listing-features')

const MAX_RECOMMEND_COUNT = 5
const DEFAULT_BUDGET_TOLERANCE = 200

const CONFIRMATION_FIELD_CONFIG = [
  { key: 'budget', label: '预算', emptyText: '待补充' },
  { key: 'location', label: '区域/小区', emptyText: '待补充' },
  { key: 'layout', label: '户型/租法', emptyText: '待补充' },
  { key: 'moveIn', label: '入住时间', emptyText: '可后补' },
  { key: 'commute', label: '通勤', emptyText: '可后补' },
  { key: 'features', label: '标签/偏好', emptyText: '不限' }
]

const AREA_WORDS = [
  '钱江新城',
  '上城区',
  '拱墅区',
  '西湖区',
  '滨江区',
  '萧山区',
  '余杭区',
  '临平区',
  '钱塘区',
  '上城',
  '拱墅',
  '西湖',
  '滨江',
  '萧山',
  '余杭',
  '临平',
  '钱塘',
  '西兴',
  '长河',
  '浦沿',
  '建设路',
  '古荡',
  '文三',
  '近江',
  '武林',
  '东新'
]

const AREA_ALIASES = {
  上城区: '上城',
  拱墅区: '拱墅',
  西湖区: '西湖',
  滨江区: '滨江',
  萧山区: '萧山',
  余杭区: '余杭',
  临平区: '临平',
  钱塘区: '钱塘'
}

const AREA_NEIGHBORS = {
  滨江: ['西兴', '长河', '浦沿', '萧山', '上城'],
  西兴: ['滨江', '长河', '萧山'],
  长河: ['滨江', '西兴', '浦沿'],
  浦沿: ['滨江', '长河'],
  拱墅: ['东新', '武林', '上城', '西湖'],
  东新: ['拱墅', '武林'],
  武林: ['拱墅', '上城', '西湖'],
  上城: ['钱江新城', '近江', '滨江', '拱墅'],
  钱江新城: ['上城', '近江'],
  近江: ['上城', '钱江新城'],
  西湖: ['古荡', '文三', '拱墅'],
  古荡: ['西湖', '文三'],
  文三: ['西湖', '古荡'],
  萧山: ['建设路', '滨江', '西兴'],
  建设路: ['萧山', '滨江']
}

const CN_DIGITS = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}

const FEATURE_RULES = [
  { name: '带阳台', aliases: ['带阳台', '阳台'], missing: '没有阳台', reason: '有阳台' },
  { name: '燃气', aliases: ['燃气', '天然气', '煤气'], missing: '没有燃气', reason: '有燃气' },
  { name: '独卫', aliases: ['独卫', '独立卫生间', '独立卫浴', '独立卫'], missing: '没有独卫', reason: '有独卫' },
  { name: '电梯', aliases: ['电梯'], missing: '没有电梯', reason: '有电梯' },
  { name: '近地铁', aliases: ['近地铁', '地铁口', '地铁站', '地铁'], missing: '离地铁较远', reason: '近地铁' },
  { name: '朝南', aliases: ['朝南', '南向'], missing: '不是朝南', reason: '朝南' },
  { name: '可养宠', aliases: ['可养宠', '养宠', '养猫', '养狗', '宠物'], missing: '不能养宠', reason: '可养宠' },
  { name: DEPOSIT_FREE_FEATURE, aliases: ['免押金', '无押金', '零押金', '押金0', '押金为0'], missing: '不免押金', reason: '免押金' }
]

function unique(values) {
  const seen = new Set()
  return (values || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function normalizeArea(value) {
  const text = String(value || '').trim()
  return AREA_ALIASES[text] || text
}

function cnDigit(value) {
  if (value === undefined || value === null || value === '') return 0
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value)
  return CN_DIGITS[value] || 0
}

function chineseNumber(value) {
  const text = String(value || '').replace(/[块元左右上下以内以下内]/g, '')
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (/^\d+(?:\.\d+)?万$/.test(text)) return Number(text.replace('万', '')) * 10000

  if (text.indexOf('万') !== -1) {
    const parts = text.split('万')
    const left = chineseNumber(parts[0]) || 1
    const right = parts[1] ? chineseNumber(parts[1]) : 0
    return left * 10000 + (parts[1] && parts[1].length === 1 ? cnDigit(parts[1]) * 1000 : right)
  }
  if (text.indexOf('千') !== -1) {
    const parts = text.split('千')
    const left = chineseNumber(parts[0]) || 1
    const right = parts[1] ? chineseNumber(parts[1]) : 0
    return left * 1000 + (parts[1] && parts[1].length === 1 ? cnDigit(parts[1]) * 100 : right)
  }
  if (text.indexOf('百') !== -1) {
    const parts = text.split('百')
    const left = chineseNumber(parts[0]) || 1
    const right = parts[1] ? chineseNumber(parts[1]) : 0
    return left * 100 + right
  }
  if (text.indexOf('十') !== -1) {
    const parts = text.split('十')
    const left = parts[0] ? chineseNumber(parts[0]) : 1
    const right = parts[1] ? chineseNumber(parts[1]) : 0
    return left * 10 + right
  }
  if (text.length === 1) return cnDigit(text)
  return text.split('').reduce((total, char) => total * 10 + cnDigit(char), 0)
}

function amountValue(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text)
    return number < 100 && text.indexOf('.') !== -1 ? Math.round(number * 1000) : number
  }
  return chineseNumber(text)
}

function numberFrom(value) {
  if (value === undefined || value === null || value === '') return 0
  const direct = Number(value)
  if (Number.isFinite(direct)) return direct
  const matched = String(value).match(/(\d+(?:\.\d+)?)/)
  return matched ? Number(matched[1]) : 0
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, '')
}

function scrubDemandSource(value) {
  return compactText(value)
    .replace(/https?:\/\/[^\s，。；;]+/ig, '')
    .replace(/(?:Signature|Expires|OSSAccessKeyId|security-token|x-oss-[^=]+)=[^&\s"'，。；;]+/ig, '')
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, '')
    .replace(/(?:客户|租客|房东|联系人)?(?:手机号|手机|电话|联系电话|联系方式|号码)[:：]?\+?\d[\d-]{6,18}/g, '')
    .replace(/1[3-9]\d{9}/g, '')
    .replace(/\b0\d{2,3}-?\d{7,8}\b/g, '')
    .replace(/\b400-?\d{3}-?\d{4}\b/g, '')
    .replace(/\bwxid_[A-Za-z0-9_-]{5,}\b/ig, '')
    .replace(/(?:微信号?|微信|VX|V信|weixin|wechat)[:：]?[A-Za-z][A-Za-z0-9_-]{4,19}/ig, '')
    .replace(/(?:\d{1,3}|[一二三四五六七八九十]{1,3})(?:栋|幢|号楼|座)(?:\d{1,3}|[一二三四五六七八九十]{1,3})?(?:单元)?[A-Za-z0-9一二三四五六七八九十-]{0,8}(?:室|房|房号)?/g, '')
    .replace(/(?:房号|门牌|房间|室号)[:：]?[A-Za-z0-9-]{2,12}/g, '')
    .replace(/\d{1,3}[-－]\d{1,3}[-－]\d{2,4}/g, '')
    .replace(/\d{2,5}(?:室|房号)/g, '')
    .replace(/\d{1,3}(?:栋|幢|号楼|座|单元)/g, '')
    .replace(/[一二三四五六七八九十]{1,3}(?:栋|幢|号楼|座|单元)/g, '')
}

function sourceTextFromPayload(payload = {}) {
  return scrubDemandSource([
    payload.text,
    payload.voiceText,
    payload.form && payload.form.text,
    payload.form && payload.form.remark
  ].filter(Boolean).join('，'))
}

function normalizeCommunity(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(杭州市?|杭州)?(上城区|拱墅区|西湖区|滨江区|萧山区|余杭区|临平区|钱塘区)/, '')
    .replace(/附近$/, '')
}

function parseBudget(source) {
  const text = compactText(source)
  const budget = {
    minBudget: 0,
    maxBudget: 0,
    budgetText: '',
    budgetTolerance: 0
  }

  const range = text.match(/(?:预算|租金)?([一二两三四五六七八九十百千万\d.]+)(?:元|块)?(?:到|至|-|~)([一二两三四五六七八九十百千万\d.]+)(?:元|块)?/)
  if (range) {
    budget.minBudget = amountValue(range[1])
    budget.maxBudget = amountValue(range[2])
    budget.budgetText = `${budget.minBudget}-${budget.maxBudget}`
  }

  if (!budget.maxBudget) {
    const maxMatch = text.match(/(?:预算|租金)?(?:大概|约|差不多)?([一二两三四五六七八九十百千万\d.]+)(?:元|块)?(?:以内|以下|内)/)
    if (maxMatch) {
      budget.maxBudget = amountValue(maxMatch[1])
      budget.budgetText = `${budget.maxBudget}以内`
    }
  }

  if (!budget.maxBudget) {
    const aroundMatch = text.match(/(?:预算|租金)?(?:大概|约|差不多)?([一二两三四五六七八九十百千万\d.]+)(?:元|块)?(?:左右|上下)/)
    if (aroundMatch) {
      budget.maxBudget = amountValue(aroundMatch[1])
      budget.budgetText = `${budget.maxBudget}左右`
      budget.budgetTolerance = DEFAULT_BUDGET_TOLERANCE
    }
  }

  if (!budget.maxBudget) {
    const directBudget = text.match(/预算(?:是|大概|约|可以)?([一二两三四五六七八九十百千万\d.]+)/)
    if (directBudget) {
      const value = amountValue(directBudget[1])
      if (value >= 1000) {
        budget.maxBudget = value
        budget.budgetText = `${budget.maxBudget}`
      }
    }
  }

  if (!budget.maxBudget) {
    const budgetBeforeLayout = text.match(/([一二两三四五六七八九十]+千[一二三四五六七八九十]?)(?=[一二两三四五六七八九\d](?:室|房))/)
    if (budgetBeforeLayout) {
      const value = amountValue(budgetBeforeLayout[1])
      if (value >= 1000) {
        budget.maxBudget = value
        budget.budgetText = `${budget.maxBudget}`
      }
    }
  }

  if (!budget.maxBudget) {
    const looseAmount = text.match(/(\d{3,5}|[一二两三四五六七八九十]+千[一二两三四五六七八九十百]*|[一二两三四五六七八九十]+百[一二两三四五六七八九十]*)/)
    if (looseAmount) {
      const value = amountValue(looseAmount[1])
      if (value >= 1000) {
        budget.maxBudget = value
        budget.budgetText = `${budget.maxBudget}`
      }
    }
  }

  const minMatch = text.match(/最低(?:预算|租金)?([一二两三四五六七八九十百千万\d.]+)/)
  if (minMatch) {
    budget.minBudget = amountValue(minMatch[1])
    budget.budgetText = budget.maxBudget ? `${budget.minBudget}-${budget.maxBudget}` : `${budget.minBudget}起`
  }

  const flexMatch = text.match(/(?:多|加|上浮)([一二两三四五六七八九十百千万\d.]+)(?:元|块)?/)
  if (flexMatch) {
    budget.budgetTolerance = amountValue(flexMatch[1])
  }

  return budget
}

function parseArea(source) {
  const text = compactText(source)
  const matched = AREA_WORDS.find((word) => text.indexOf(word) !== -1)
  return normalizeArea(matched || '')
}

function parseCommunity(source, candidates) {
  const text = normalizeCommunity(source)
  if (!text) return ''
  const communities = unique((candidates || []).map((listing) => listing.community))
    .filter((item) => normalizeCommunity(item).length >= 2)
    .sort((left, right) => normalizeCommunity(right).length - normalizeCommunity(left).length)

  const matched = communities.find((community) => {
    const name = normalizeCommunity(community)
    return text.indexOf(name) !== -1 || (name.length >= 3 && name.indexOf(text) !== -1)
  })
  return matched || ''
}

function parseLayout(source) {
  const text = compactText(source)
  if (/单间|一间/.test(text)) return '单间'
  const match = text.match(/([一二两三四五六七八九\d])(?:室|房)/)
  if (!match) return ''
  const count = amountValue(match[1])
  const map = { 1: '一室', 2: '两室', 3: '三室', 4: '四室', 5: '五室', 6: '六室' }
  return map[count] || `${count}室`
}

function parseRentMode(source) {
  const text = compactText(source)
  if (/合租|单间/.test(text)) return '合租'
  if (/整租/.test(text)) return '整租'
  return ''
}

function parseMoveIn(source) {
  const text = compactText(source)
  const matched = text.match(/(?:入住|搬入|起租|月底|月初|下周|今天|明天|周末)[^，。,.；;]{0,8}/)
  return matched ? matched[0] : ''
}

function parseCommute(source) {
  const text = compactText(source)
  const matched = text.match(/(?:通勤到|上班到|公司到)([^，。,.；;]{2,12})/)
    || text.match(/通勤([^，。,.；;]{2,12})/)
  const location = matched ? matched[1].replace(/(?:半小时|[一二两三四五六七八九十\d]+分钟|以内|内).*$/, '') : ''
  let minutes = 0
  if (/半小时/.test(text)) {
    minutes = 30
  } else {
    const minuteMatch = text.match(/([一二两三四五六七八九十\d]{1,3})(?:分钟|分)/)
    if (minuteMatch) minutes = amountValue(minuteMatch[1])
  }
  return {
    commuteLocation: location,
    maxCommuteMinutes: minutes
  }
}

function featurePriority(source, alias) {
  const index = source.indexOf(alias)
  if (index === -1) return ''
  const windowText = source.slice(Math.max(0, index - 8), index + alias.length + 10)
  if (/必须|一定|硬性|必备|要求|不能没有|要有|得有/.test(windowText)) return 'hard'
  if (/最好|优先|希望|尽量|可有可无|可以有|无所谓|加分/.test(windowText)) return 'preference'
  return 'preference'
}

function parseFeatures(source) {
  const text = compactText(source)
  const hard = []
  const preferences = []
  FEATURE_RULES.forEach((rule) => {
    const alias = rule.aliases.find((item) => text.indexOf(item) !== -1)
    if (!alias) return
    if (featurePriority(text, alias) === 'hard') {
      hard.push(rule.name)
    } else {
      preferences.push(rule.name)
    }
  })
  return {
    hardFeatures: unique(hard),
    preferenceFeatures: unique(preferences.filter((item) => hard.indexOf(item) === -1))
  }
}

function cleanConstraintObject(data) {
  const result = {}
  Object.keys(data || {}).forEach((key) => {
    const value = data[key]
    if (Array.isArray(value)) {
      result[key] = value.slice()
      return
    }
    if (value !== undefined && value !== null && value !== '') {
      result[key] = value
    }
  })
  return result
}

function parseNeed(payload = {}, candidates = []) {
  const source = sourceTextFromPayload(payload)
  const form = payload.form || {}
  const budget = parseBudget([source, form.budget, form.budgetText].filter(Boolean).join('，'))
  const formMinBudget = numberFrom(form.minBudget)
  const formMaxBudget = numberFrom(form.maxBudget)
  if (formMinBudget) budget.minBudget = formMinBudget
  if (formMaxBudget) {
    budget.maxBudget = formMaxBudget
    budget.budgetText = budget.minBudget ? `${budget.minBudget}-${budget.maxBudget}` : `${budget.maxBudget}`
  }
  const community = form.community || parseCommunity(source, candidates)
  const area = normalizeArea(form.area || parseArea(source))
  const layout = form.layout || parseLayout(source)
  const rentMode = form.rentMode || parseRentMode(source)
  const moveIn = form.moveIn || parseMoveIn(source)
  const commute = parseCommute([source, form.commute, form.commuteLocation].filter(Boolean).join('，'))
  if (form.commuteLocation) commute.commuteLocation = form.commuteLocation
  if (numberFrom(form.maxCommuteMinutes)) commute.maxCommuteMinutes = numberFrom(form.maxCommuteMinutes)
  const featureResult = parseFeatures([source, parseFeatureInput(form.features).join('，')].filter(Boolean).join('，'))
  const allFeatures = unique(featureResult.hardFeatures.concat(featureResult.preferenceFeatures))
  const hardConstraints = cleanConstraintObject({
    minBudget: budget.minBudget || '',
    maxBudget: budget.maxBudget || '',
    area,
    community,
    rentMode,
    layout,
    moveIn,
    commuteLocation: commute.commuteLocation,
    maxCommuteMinutes: commute.maxCommuteMinutes || '',
    features: featureResult.hardFeatures
  })
  const preferences = cleanConstraintObject({
    budgetTolerance: budget.budgetTolerance || '',
    features: featureResult.preferenceFeatures
  })

  return {
    rawText: source,
    budget: budget.maxBudget ? String(budget.maxBudget) : '',
    minBudget: budget.minBudget || '',
    maxBudget: budget.maxBudget || '',
    budgetText: budget.budgetText,
    area,
    community,
    rentMode,
    layout,
    moveIn,
    commuteLocation: commute.commuteLocation,
    maxCommuteMinutes: commute.maxCommuteMinutes || '',
    features: allFeatures,
    hardConstraints,
    preferences
  }
}

function recognizedCoreCount(need) {
  return [
    Boolean(need.maxBudget || need.minBudget),
    Boolean(need.area || need.community),
    Boolean(need.layout || need.rentMode)
  ].filter(Boolean).length
}

function buildFollowUpQuestion(need) {
  if (recognizedCoreCount(need) >= 2) return ''
  if (!need.maxBudget && !need.minBudget) return '预算大概多少？'
  if (!need.area && !need.community) return '想看哪个区域或小区？'
  if (!need.layout && !need.rentMode) return '客户想要几室或单间？'
  return ''
}

function confirmationFieldValue(need = {}, key) {
  if (key === 'budget') return need.budgetText || (need.maxBudget ? `${need.maxBudget}以内` : '')
  if (key === 'location') return [need.area, need.community].filter(Boolean).join(' · ')
  if (key === 'layout') return [need.rentMode, need.layout].filter(Boolean).join(' · ')
  if (key === 'moveIn') return need.moveIn || ''
  if (key === 'commute') {
    return [
      need.commuteLocation,
      need.maxCommuteMinutes ? `${need.maxCommuteMinutes}分钟内` : ''
    ].filter(Boolean).join(' · ')
  }
  if (key === 'features') return (need.features || []).join('、')
  return ''
}

function buildConfirmationFields(need = {}) {
  return CONFIRMATION_FIELD_CONFIG.map((field) => {
    const value = confirmationFieldValue(need, field.key)
    return {
      key: field.key,
      label: field.label,
      value: value || field.emptyText,
      filled: Boolean(value)
    }
  })
}

function buildRecognitionReply(followUpQuestion) {
  if (followUpQuestion) return `我先整理了已识别条件，还差一个关键问题：${followUpQuestion}`
  return '请确认这些找房条件，确认后我再匹配本地房源。'
}

function listingSearchText(listing = {}) {
  return [
    listing.title,
    listing.meta,
    listing.sub,
    listing.city,
    listing.district,
    listing.area,
    listing.block,
    listing.community,
    listing.layout,
    listing.type,
    listing.rentMode,
    listing.room,
    listing.hall,
    listing.bath,
    listing.sourceLabel,
    listing.source,
    (listing.features || []).join(' '),
    (listing.rawFeatures || []).join(' ')
  ].map((item) => String(item || '')).join(' ')
}

function getFeatureRule(feature) {
  return FEATURE_RULES.find((rule) => rule.name === feature) || {
    name: feature,
    aliases: [feature],
    missing: `没有${feature}`,
    reason: `有${feature}`
  }
}

function listingFeatureSet(listing = {}) {
  const text = listingSearchText(listing)
  const featureNames = parseFeatureInput(listing.features)
    .concat(parseFeatureInput(listing.rawFeatures))
    .filter((item) => item !== NO_FEATURE)
  FEATURE_RULES.forEach((rule) => {
    if (rule.aliases.some((alias) => text.indexOf(alias) !== -1)) {
      featureNames.push(rule.name)
    }
  })
  return new Set(unique(featureNames.concat([listing.type, listing.rentMode]).filter(Boolean)))
}

function featureMatched(listing, feature) {
  const set = listingFeatureSet(listing)
  if (set.has(feature)) return true
  const text = listingSearchText(listing)
  return getFeatureRule(feature).aliases.some((alias) => text.indexOf(alias) !== -1)
}

function rentOfListing(listing = {}) {
  return numberFrom(listing.rent || listing.price)
}

function areaText(listing = {}) {
  return [
    listing.city,
    listing.district,
    listing.area,
    listing.block,
    listing.community
  ].map((item) => String(item || '')).join('')
}

function areaMatches(listing, area) {
  const target = normalizeArea(area)
  if (!target) return true
  return areaText(listing).indexOf(target) !== -1
}

function communityMatches(listing, community) {
  if (!community) return true
  const target = normalizeCommunity(community)
  const current = normalizeCommunity(listing.community)
  return Boolean(target && current && (current.indexOf(target) !== -1 || target.indexOf(current) !== -1))
}

function isNeighborArea(listing, area) {
  const target = normalizeArea(area)
  const currentText = areaText(listing)
  const neighbors = AREA_NEIGHBORS[target] || []
  return neighbors.some((item) => currentText.indexOf(item) !== -1)
}

function bedroomCount(value) {
  const text = String(value || '')
  if (/单间/.test(text)) return 1
  const matched = text.match(/([一二两三四五六七八九\d])(?:室|房)/)
  return matched ? amountValue(matched[1]) : 0
}

function layoutMatches(listing, layout) {
  if (!layout) return true
  const text = listingSearchText(listing)
  if (text.indexOf(layout) !== -1) return true
  const needCount = bedroomCount(layout)
  const listingCount = bedroomCount(text)
  return Boolean(needCount && listingCount && needCount === listingCount)
}

function layoutDifference(listing, layout) {
  const needCount = bedroomCount(layout)
  const listingCount = bedroomCount(listingSearchText(listing))
  if (needCount && listingCount) {
    const diff = listingCount - needCount
    if (diff === -1) return '户型少一室'
    if (diff === 1) return '户型多一室'
  }
  return '户型不符'
}

function rentModeMatches(listing, rentMode) {
  if (!rentMode) return true
  return listingSearchText(listing).indexOf(rentMode) !== -1
}

function exactReasonParts(listing, need, matchedPreferenceFeatures) {
  const reasons = []
  if (need.maxBudget && rentOfListing(listing) <= need.maxBudget) reasons.push('预算内')
  if (need.area || need.community) reasons.push('位置匹配')
  if (need.layout) reasons.push('户型匹配')
  if (need.rentMode) reasons.push(`${need.rentMode}匹配`)
  ;(need.hardConstraints.features || []).forEach((feature) => {
    reasons.push(getFeatureRule(feature).reason)
  })
  matchedPreferenceFeatures.forEach((feature) => {
    reasons.push(getFeatureRule(feature).reason)
  })
  return unique(reasons).slice(0, 3)
}

function evaluateListing(listing, need) {
  const hard = need.hardConstraints || {}
  const preferences = need.preferences || {}
  const rent = rentOfListing(listing)
  const hardDifferences = []
  const preferenceDifferences = []
  const matchedPreferenceFeatures = []
  let score = 50

  if (hard.maxBudget && rent && rent > Number(hard.maxBudget)) {
    const over = rent - Number(hard.maxBudget)
    hardDifferences.push(`超预算${over}元`)
    score -= Math.min(35, Math.ceil(over / 100) * 4)
  } else if (hard.maxBudget && rent) {
    score += Math.max(4, Math.min(18, Math.floor((Number(hard.maxBudget) - rent) / 120) + 8))
  }
  if (hard.minBudget && rent && rent < Number(hard.minBudget)) {
    hardDifferences.push(`低于最低预算${Number(hard.minBudget) - rent}元`)
    score -= 8
  }
  if (hard.area && !areaMatches(listing, hard.area)) {
    hardDifferences.push(isNeighborArea(listing, hard.area) ? '区域相邻' : '区域不符')
    score -= isNeighborArea(listing, hard.area) ? 10 : 26
  } else if (hard.area) {
    score += 14
  }
  if (hard.community && !communityMatches(listing, hard.community)) {
    hardDifferences.push(areaMatches(listing, hard.area) ? `不在${hard.community}` : '小区不符')
    score -= 14
  } else if (hard.community) {
    score += 18
  }
  if (hard.layout && !layoutMatches(listing, hard.layout)) {
    hardDifferences.push(layoutDifference(listing, hard.layout))
    score -= 18
  } else if (hard.layout) {
    score += 16
  }
  if (hard.rentMode && !rentModeMatches(listing, hard.rentMode)) {
    hardDifferences.push(`${hard.rentMode}不符`)
    score -= 18
  } else if (hard.rentMode) {
    score += 10
  }

  ;(hard.features || []).forEach((feature) => {
    if (featureMatched(listing, feature)) {
      score += 14
    } else {
      hardDifferences.push(getFeatureRule(feature).missing)
      score -= 18
    }
  })

  ;(preferences.features || []).forEach((feature) => {
    if (featureMatched(listing, feature)) {
      matchedPreferenceFeatures.push(feature)
      score += 10
    } else {
      preferenceDifferences.push(getFeatureRule(feature).missing)
      score -= 4
    }
  })

  if (String(listing.status || '').indexOf('在租') !== -1) score += 5
  const differences = unique(hardDifferences.concat(preferenceDifferences))
  const exact = hardDifferences.length === 0
  const reasons = exactReasonParts(listing, need, matchedPreferenceFeatures)

  return {
    exact,
    score: Math.max(1, Math.min(99, score)),
    hardDifferences: unique(hardDifferences),
    differences,
    reasons: reasons.length ? reasons : ['基础条件相近'],
    listing
  }
}

function canBeNearby(item, need) {
  if (item.exact || !item.differences.length) return false
  const tolerance = Number((need.preferences && need.preferences.budgetTolerance) || DEFAULT_BUDGET_TOLERANCE)
  const rent = rentOfListing(item.listing)
  const maxBudget = Number(need.maxBudget || 0)
  const tooExpensive = maxBudget && rent && rent - maxBudget > Math.max(800, tolerance + 400)
  const impossibleArea = item.hardDifferences.indexOf('区域不符') !== -1 && item.hardDifferences.length > 1
  return !tooExpensive && !impossibleArea && item.score >= 25
}

function displayTitle(listing = {}) {
  if (listing.community && listing.layout) return `${listing.community} · ${listing.layout}`
  if (listing.community) return listing.community
  if (listing.area && listing.layout) return `${listing.area} · ${listing.layout}`
  return listing.title || '可租房源'
}

function sanitizeListing(item, group) {
  const listing = item.listing || item
  const rent = rentOfListing(listing)
  const relevanceScore = Math.round(item.score || listing.relevanceScore || 50)
  const differenceText = item.differences && item.differences.length
    ? item.differences.join('、')
    : ''
  const matchReason = item.reasons && item.reasons.length
    ? item.reasons.join('、')
    : '基础条件相近'
  return {
    id: listing.id,
    title: displayTitle(listing),
    cardTitle: displayTitle(listing),
    community: listing.community || '',
    area: listing.area || listing.district || '',
    block: listing.block || '',
    layout: listing.layout || '',
    rentMode: listing.rentMode || listing.type || '',
    type: listing.type || listing.rentMode || '',
    rent,
    price: rent ? `¥${rent}/月` : (listing.price || ''),
    meta: [listing.area || listing.district, listing.block, listing.layout].filter(Boolean).join(' · '),
    sub: '管理员确认签单后，上传人按房东实付佣金的 20% 结算',
    features: unique(parseFeatureInput(listing.features).concat(parseFeatureInput(listing.rawFeatures))).slice(0, 8),
    maintenanceText: listing.maintenanceText || '',
    matchGroup: group,
    matchGroupText: group === 'exact' ? '符合要求' : '接近要求',
    matchReason,
    differenceText,
    differences: item.differences || [],
    relevanceReasons: item.reasons || [],
    relevanceScore,
    relevancePercent: `${relevanceScore}%`,
    matchScore: `${relevanceScore}%`,
    displayRelevance: `${relevanceScore}%`
  }
}

function rawListingsById(db = {}) {
  const map = new Map()
  ;(db.listings || []).forEach((listing) => {
    if (listing && listing.id) map.set(listing.id, listing)
  })
  return map
}

function candidateListings(db = {}) {
  const rawMap = rawListingsById(db)
  return domain.filterListings(db, {}).map((listing) => {
    const raw = rawMap.get(listing.id) || {}
    return {
      ...listing,
      rawFeatures: unique(parseFeatureInput(raw.features).concat(parseFeatureInput(raw.tags))),
      status: raw.status || listing.status || '',
      rent: numberFrom(raw.rent || listing.rent || listing.price),
      layout: raw.layout || listing.layout || '',
      rentMode: raw.rentMode || raw.type || listing.rentMode || listing.type || '',
      type: raw.type || raw.rentMode || listing.type || listing.rentMode || '',
      room: raw.room || listing.room || '',
      hall: raw.hall || listing.hall || '',
      bath: raw.bath || listing.bath || '',
      area: raw.area || raw.district || listing.area || listing.district || '',
      district: raw.district || listing.district || listing.area || '',
      block: raw.block || listing.block || '',
      community: raw.community || listing.community || ''
    }
  })
}

function sortEvaluated(left, right) {
  if (right.score !== left.score) return right.score - left.score
  return rentOfListing(left.listing) - rentOfListing(right.listing)
}

function groupListings(candidates, need) {
  const evaluated = (candidates || []).map((listing) => evaluateListing(listing, need))
  const exact = evaluated
    .filter((item) => item.exact)
    .sort(sortEvaluated)
  const nearby = evaluated
    .filter((item) => canBeNearby(item, need))
    .sort(sortEvaluated)
  const exactListings = exact.slice(0, MAX_RECOMMEND_COUNT).map((item) => sanitizeListing(item, 'exact'))
  const nearbyListings = nearby.slice(0, MAX_RECOMMEND_COUNT).map((item) => sanitizeListing(item, 'nearby'))
  const listings = exactListings.concat(nearbyListings).slice(0, MAX_RECOMMEND_COUNT)
  return {
    exactListings,
    nearbyListings,
    listings
  }
}

function clampReply(text) {
  const value = String(text || '').trim()
  return value.length > 100 ? `${value.slice(0, 97)}...` : value
}

function buildReply(need, groups, followUpQuestion) {
  if (followUpQuestion) return followUpQuestion
  if (groups.exactListings.length && groups.nearbyListings.length) {
    return clampReply(`找到${groups.exactListings.length}套符合要求，另有${groups.nearbyListings.length}套接近房源，差异已标出。`)
  }
  if (groups.exactListings.length) {
    return clampReply(`找到${groups.exactListings.length}套符合要求，已按预算、位置和偏好排序。`)
  }
  if (groups.nearbyListings.length) {
    return clampReply(`没有完全符合的，先看${groups.nearbyListings.length}套接近房源，差异已标出。`)
  }
  return clampReply('暂未找到合适房源，建议放宽预算、区域或户型。')
}

function buildLocalMatch(db, payload = {}, options = {}) {
  const candidates = options.candidates || candidateListings(db || {})
  const need = parseNeed(payload, candidates)
  const followUpQuestion = buildFollowUpQuestion(need)
  const emptyGroups = { exactListings: [], nearbyListings: [], listings: [] }
  const groups = followUpQuestion ? emptyGroups : groupListings(candidates, need)
  return {
    need,
    hardConstraints: need.hardConstraints,
    preferences: need.preferences,
    exactListings: groups.exactListings,
    nearbyListings: groups.nearbyListings,
    followUpQuestion,
    listings: groups.listings,
    reply: buildReply(need, groups, followUpQuestion),
    mode: 'local-match-v1'
  }
}

function recognizeNeed(db, payload = {}, options = {}) {
  const candidates = options.candidates || candidateListings(db || {})
  const need = parseNeed(payload, candidates)
  const followUpQuestion = buildFollowUpQuestion(need)
  return {
    stage: 'recognize',
    mode: 'recognize-v1',
    need,
    hardConstraints: need.hardConstraints,
    preferences: need.preferences,
    confirmationFields: buildConfirmationFields(need),
    readyToConfirm: !followUpQuestion,
    followUpQuestion,
    exactListings: [],
    nearbyListings: [],
    listings: [],
    reply: buildRecognitionReply(followUpQuestion)
  }
}

function safeListingsForPrompt(listings) {
  return (listings || []).map((listing) => ({
    id: listing.id,
    community: listing.community,
    area: listing.area,
    block: listing.block,
    layout: listing.layout,
    rentMode: listing.rentMode,
    rent: listing.rent,
    features: listing.features,
    maintenanceText: listing.maintenanceText,
    matchGroupText: listing.matchGroupText,
    matchReason: listing.matchReason,
    differenceText: listing.differenceText,
    relevancePercent: listing.relevancePercent
  }))
}

module.exports = {
  MAX_RECOMMEND_COUNT,
  parseNeed,
  recognizeNeed,
  buildLocalMatch,
  safeListingsForPrompt,
  _internal: {
    amountValue,
    buildConfirmationFields,
    buildFollowUpQuestion,
    candidateListings,
    groupListings,
    evaluateListing
  }
}
