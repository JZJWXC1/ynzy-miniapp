const llm = require('../llm')
const { placeNames } = require('../place-locator')
const { safeNeed, scrubSensitiveText } = require('./safety')

const MAX_BUDGET = 100000
const MIN_BUDGET_RATIO = 0.75

const ALLOWED_RENT_MODES = ['整租', '合租']
const ALLOWED_LAYOUTS = ['单间', '一室', '两室', '三室', '四室', '五室', '六室']
// NEED-1：与房源侧 LISTING_FEATURE_OPTIONS + match-service FEATURE_RULES 对齐（13 项实特征）
const CANONICAL_FEATURES = [
  '带阳台', '燃气', '独卫', '电梯', '近地铁', '朝南', '可养宠', '免押金',
  '干湿分离', '采光好', '可短租', '可月付', '首次出租', '民水民电', '带露台（阁楼）'
]

const FEATURE_ALIASES = {
  带阳台: ['带阳台', '阳台', '羊台'],
  燃气: ['燃气', '天然气', '煤气', '燃汽'],
  独卫: ['独卫', '独立卫生间', '独立卫浴', '独立卫', '独位', '独立厨卫', '独厨独卫'],
  电梯: ['电梯', '电提', '电题'],
  近地铁: ['近地铁', '地铁口', '地铁站', '地铁', '地帖', '地贴', '号线'],
  朝南: ['朝南', '南向', '朝男'],
  可养宠: ['可养宠', '养宠', '养猫', '养狗', '宠物'],
  免押金: ['免押金', '无押金', '零押金', '押金0', '免压金'],
  干湿分离: ['干湿分离', '干湿分区'],
  采光好: ['采光好', '采光佳', '采光很好', '光线好', '南北通透', '通透'],
  可短租: ['可短租', '短租'],
  可月付: ['可月付', '月付', '押一付一'],
  首次出租: ['首次出租', '首租', '第一次出租'],
  民水民电: ['民水民电', '民水', '民电'],
  '带露台（阁楼）': ['带露台（阁楼）', '带露台', '露台', '阁楼', '花园']
}

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

function compactText(value) {
  return String(value || '').replace(/\s+/g, '')
}

function normalizeName(value) {
  return compactText(value)
    .replace(/^(杭州市?|杭州)?(拱墅区|余杭区|上城区|西湖区|滨江区|萧山区|临平区|钱塘区)/, '')
    .replace(/附近|周边|旁边|边上|一带|这边|那边/g, '')
}

function numberFrom(value) {
  if (value === undefined || value === null || value === '') return 0
  const number = Number(value)
  if (Number.isFinite(number)) return number
  const matched = String(value).match(/(\d+(?:\.\d+)?)/)
  return matched ? Number(matched[1]) : 0
}

function implicitMinBudget(maxBudget) {
  const value = numberFrom(maxBudget)
  return value ? Math.ceil(value * MIN_BUDGET_RATIO) : 0
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && value !== ''
}

function safeTextFromState(state = {}) {
  return scrubSensitiveText([
    state.sanitizedText,
    state.sanitizedVoiceText
  ].filter(Boolean).join('，'))
}

function objectHasValue(source = {}) {
  return Object.keys(source || {}).some((key) => {
    const value = source[key]
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === 'object') return objectHasValue(value)
    return value !== undefined && value !== null && value !== ''
  })
}

function slotCount(need = {}) {
  return [
    need.maxBudget || need.minBudget || need.budget,
    need.area,
    need.community,
    need.anchorName,
    need.radiusKm,
    need.rentMode,
    need.layout,
    ...(need.features || []),
    ...((need.hardConstraints && need.hardConstraints.features) || []),
    ...((need.preferences && need.preferences.features) || [])
  ].filter(Boolean).length
}

function shouldUseComplexNeedParser(state = {}, ruleNeed = {}) {
  const sourceText = compactText(safeTextFromState(state))
  const previousNeed = state.previousNeed || {}
  if (objectHasValue(previousNeed) && /改|换|重新|还是|不要|不是|另外|刚才|之前|上一轮|这次/.test(sourceText)) return true
  if (/上班|工作|通勤|公司|单位|住的.*公里|离.*近/.test(sourceText)) return true
  if (/不是|不要|别|排除|必须|一定|硬性|不能|冲突/.test(sourceText)) return true
  if (/这几套|哪个更适合|更适合|女生|男生|客户说|租客说/.test(sourceText)) return true
  return slotCount(ruleNeed) >= 7
}

function knownAreasFrom(candidates = []) {
  return unique((candidates || []).flatMap((listing) => [
    listing.area,
    listing.district,
    listing.block
  ]))
}

function knownCommunitiesFrom(candidates = [], db = {}) {
  return unique((candidates || []).map((listing) => listing.community)
    .concat(placeNames(db, candidates, { types: ['community'] })))
}

function knownPlacesFrom(candidates = [], db = {}) {
  return unique(placeNames(db, candidates))
}

function buildNeedParserPrompt(state = {}, ruleNeed = {}) {
  const candidates = state.candidates || []
  const db = state.db || {}
  const safeText = safeTextFromState(state)
  const knownAreas = knownAreasFrom(candidates).slice(0, 40)
  const knownPlaces = knownPlacesFrom(candidates, db).slice(0, 80)

  return [
    '你是找房小程序的需求结构化助手，只把中介原话转成 JSON。',
    '只能抽取用户明确表达或能从原话合理同义归一的字段；不能编造小区、地标、预算、坐标、房源。',
    '相近小区名不能强行纠错，例如杨乐府和杨家府必须按原话保留或留空。',
    '只返回一个 JSON 对象，不要解释。',
    '字段白名单：budgetText,minBudget,maxBudget,area,community,searchMode,anchorName,anchorRole,radiusKm,rentMode,layout,features,hardConstraints,preferences。',
    'searchMode 只有 radius_around_place 或空字符串；anchorRole 只有 workplace 或 anchor。',
    'rentMode 只有 整租/合租；layout 只有 单间/一室/两室/三室/四室/五室/六室。',
    `中介原话：${safeText || '未提供'}`,
    `规则已识别：${JSON.stringify(safeNeed(ruleNeed || {}))}`,
    `可用区域：${JSON.stringify(knownAreas)}`,
    `已知地点/小区词库：${JSON.stringify(knownPlaces)}`,
    '返回示例：{"maxBudget":2000,"budgetText":"2000左右","searchMode":"radius_around_place","anchorName":"拱墅万达","anchorRole":"anchor","radiusKm":3,"layout":"单间","preferences":{"budgetTolerance":300}}'
  ].join('\n')
}

function parseProviderJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return {}
  const withoutFence = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  const jsonText = start >= 0 && end > start ? withoutFence.slice(start, end + 1) : withoutFence
  const parsed = JSON.parse(jsonText)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

async function parseRentalNeedWithLlm(state = {}, ruleNeed = {}) {
  const config = (state.db && state.db.llmConfig) || {}
  if (!config.enabled || config.provider === 'local' || config.needParserEnabled === false) {
    return {
      ruleParsedNeed: ruleNeed,
      llmParsedNeed: {},
      needParserMode: 'local-rule',
      needParserWarnings: []
    }
  }

  try {
    if (!llm._internal || typeof llm._internal.callProvider !== 'function') {
      throw new Error('LLM 调用器不可用')
    }
    const parserTask = shouldUseComplexNeedParser(state, ruleNeed) ? 'complex_need_parser' : 'need_parser'
    const taskConfig = llm._internal.configForTask
      ? llm._internal.configForTask(config, parserTask)
      : config
    const providerText = await llm._internal.callProvider(taskConfig, buildNeedParserPrompt(state, ruleNeed))
    return {
      ruleParsedNeed: ruleNeed,
      llmParsedNeed: parseProviderJson(providerText),
      needParserMode: config.provider || 'llm',
      needParserWarnings: []
    }
  } catch (error) {
    return {
      ruleParsedNeed: ruleNeed,
      llmParsedNeed: {},
      needParserMode: 'local-fallback',
      needParserWarnings: [`LLM 需求解析失败：${scrubSensitiveText(error.message || '')}`]
    }
  }
}

function canonicalFeature(value) {
  const text = compactText(value)
  if (!text) return ''
  return CANONICAL_FEATURES.find((feature) => feature === text) || ''
}

function featureMentioned(feature, sourceText) {
  const aliases = FEATURE_ALIASES[feature] || [feature]
  return aliases.some((alias) => sourceText.indexOf(alias) !== -1)
}

function normalizedIncludes(values, value) {
  const target = normalizeName(value)
  if (!target) return false
  return (values || []).some((item) => normalizeName(item) === target)
}

function textMentionsName(sourceText, value) {
  const target = normalizeName(value)
  if (!target) return false
  return normalizeName(sourceText).indexOf(target) !== -1
}

function radiusIntentMentioned(sourceText) {
  return /附近|周边|旁边|边上|一带|公里|千米|km|上班|工作|通勤/.test(compactText(sourceText))
}

function cleanLlmNeed(source = {}) {
  const hard = source.hardConstraints && typeof source.hardConstraints === 'object' ? source.hardConstraints : {}
  const preferences = source.preferences && typeof source.preferences === 'object' ? source.preferences : {}
  return {
    budgetText: scrubSensitiveText(source.budgetText || ''),
    minBudget: numberFrom(source.minBudget),
    maxBudget: numberFrom(source.maxBudget),
    area: scrubSensitiveText(source.area || ''),
    community: scrubSensitiveText(source.community || ''),
    searchMode: source.searchMode === 'radius_around_place' ? 'radius_around_place' : '',
    anchorName: scrubSensitiveText(source.anchorName || ''),
    anchorRole: source.anchorRole === 'workplace' ? 'workplace' : (source.anchorRole === 'anchor' ? 'anchor' : ''),
    radiusKm: numberFrom(source.radiusKm),
    rentMode: ALLOWED_RENT_MODES.indexOf(source.rentMode) !== -1 ? source.rentMode : '',
    layout: ALLOWED_LAYOUTS.indexOf(source.layout) !== -1 ? source.layout : '',
    features: Array.isArray(source.features) ? source.features.map(canonicalFeature).filter(Boolean) : [],
    hardConstraints: {
      features: Array.isArray(hard.features) ? hard.features.map(canonicalFeature).filter(Boolean) : []
    },
    preferences: {
      budgetTolerance: numberFrom(preferences.budgetTolerance),
      features: Array.isArray(preferences.features) ? preferences.features.map(canonicalFeature).filter(Boolean) : []
    }
  }
}

function refreshNeedShape(need = {}) {
  const hardFeatures = unique(need.hardConstraints && need.hardConstraints.features)
  const preferenceFeatures = unique((need.preferences && need.preferences.features) || [])
    .filter((feature) => hardFeatures.indexOf(feature) === -1)
  const maxBudget = numberFrom(need.maxBudget)
  const minBudget = numberFrom(need.minBudget)
  const result = {
    ...need,
    budget: maxBudget ? String(maxBudget) : (need.budget || ''),
    minBudget: minBudget || '',
    maxBudget: maxBudget || '',
    budgetText: need.budgetText || (maxBudget ? String(maxBudget) : ''),
    features: unique((need.features || []).concat(hardFeatures).concat(preferenceFeatures)),
    hardConstraints: {
      minBudget: minBudget || implicitMinBudget(maxBudget) || '',
      maxBudget: maxBudget || '',
      area: need.searchMode === 'radius_around_place' ? '' : (need.area || ''),
      community: need.searchMode === 'radius_around_place' ? '' : (need.community || ''),
      rentMode: need.rentMode || '',
      layout: need.layout || '',
      features: hardFeatures
    },
    preferences: {
      budgetTolerance: numberFrom(need.preferences && need.preferences.budgetTolerance) || '',
      features: preferenceFeatures
    }
  }
  if (result.searchMode !== 'radius_around_place') {
    result.anchorName = ''
    result.anchorRole = ''
    result.radiusKm = ''
  }
  return result
}

function validateRentalNeed({ ruleNeed = {}, llmNeed = {}, state = {} } = {}) {
  const sourceText = safeTextFromState(state)
  const candidates = state.candidates || []
  const db = state.db || {}
  const cleaned = cleanLlmNeed(llmNeed)
  const need = JSON.parse(JSON.stringify(ruleNeed || {}))
  const acceptedFields = []
  const rejectedFields = []
  const warnings = []
  const knownAreas = knownAreasFrom(candidates)
  const knownCommunities = knownCommunitiesFrom(candidates, db)
  const knownPlaces = knownPlacesFrom(candidates, db)

  function reject(field, reason) {
    if (!hasValue(cleaned[field]) && field !== 'hardConstraints' && field !== 'preferences') return
    rejectedFields.push({ field, reason })
  }

  function accept(field, value) {
    need[field] = value
    acceptedFields.push(field)
  }

  if (!hasValue(need.maxBudget) && cleaned.maxBudget > 0 && cleaned.maxBudget <= MAX_BUDGET) {
    accept('maxBudget', cleaned.maxBudget)
    need.budget = String(cleaned.maxBudget)
    need.budgetText = cleaned.budgetText || `${cleaned.maxBudget}`
  } else if (hasValue(cleaned.maxBudget) && hasValue(need.maxBudget) && Number(need.maxBudget) !== cleaned.maxBudget) {
    reject('maxBudget', '规则已识别预算，LLM 不能覆盖')
  }

  if (!hasValue(need.minBudget) && cleaned.minBudget > 0 && cleaned.minBudget <= MAX_BUDGET) {
    accept('minBudget', cleaned.minBudget)
  }

  if (!hasValue(need.area) && cleaned.area) {
    if (knownAreas.indexOf(cleaned.area) !== -1 || textMentionsName(sourceText, cleaned.area)) {
      accept('area', cleaned.area)
    } else {
      reject('area', '区域不在已知区域或原话中')
    }
  } else if (cleaned.area && need.area && cleaned.area !== need.area) {
    reject('area', '规则已识别区域，LLM 不能覆盖')
  }

  if (!hasValue(need.community) && cleaned.community && cleaned.searchMode !== 'radius_around_place') {
    if (normalizedIncludes(knownCommunities, cleaned.community) || textMentionsName(sourceText, cleaned.community)) {
      accept('community', cleaned.community)
    } else {
      reject('community', '小区不在词库或原话中，疑似编造')
    }
  } else if (cleaned.community && need.community && normalizeName(cleaned.community) !== normalizeName(need.community)) {
    reject('community', '规则已识别小区，LLM 不能覆盖')
  }

  if (!hasValue(need.rentMode) && cleaned.rentMode) accept('rentMode', cleaned.rentMode)
  if (cleaned.rentMode && need.rentMode && cleaned.rentMode !== need.rentMode) {
    reject('rentMode', '规则已识别租法，LLM 不能覆盖')
  }

  if (!hasValue(need.layout) && cleaned.layout) accept('layout', cleaned.layout)
  if (cleaned.layout && need.layout && cleaned.layout !== need.layout) {
    reject('layout', '规则已识别户型，LLM 不能覆盖')
  }

  const baseHardFeatures = unique(need.hardConstraints && need.hardConstraints.features)
  const basePrefFeatures = unique(need.preferences && need.preferences.features)
  const llmHardFeatures = unique(cleaned.hardConstraints.features)
    .filter((feature) => featureMentioned(feature, sourceText))
  const llmPrefFeatures = unique(cleaned.features.concat(cleaned.preferences.features))
    .filter((feature) => featureMentioned(feature, sourceText))
    .filter((feature) => llmHardFeatures.indexOf(feature) === -1)
  need.hardConstraints = {
    ...(need.hardConstraints || {}),
    features: unique(baseHardFeatures.concat(llmHardFeatures))
  }
  need.preferences = {
    ...(need.preferences || {}),
    features: unique(basePrefFeatures.concat(llmPrefFeatures))
  }
  if (llmHardFeatures.length) acceptedFields.push('hardConstraints.features')
  if (llmPrefFeatures.length) acceptedFields.push('preferences.features')

  if (cleaned.preferences.budgetTolerance && !(need.preferences && need.preferences.budgetTolerance)) {
    need.preferences = {
      ...(need.preferences || {}),
      budgetTolerance: cleaned.preferences.budgetTolerance
    }
    acceptedFields.push('preferences.budgetTolerance')
  }

  if (cleaned.searchMode === 'radius_around_place') {
    const anchorName = cleaned.anchorName || need.anchorName || ''
    const anchorAllowed = normalizedIncludes(knownPlaces, anchorName) || textMentionsName(sourceText, anchorName)
    if (anchorName && anchorAllowed && radiusIntentMentioned(sourceText)) {
      if (!hasValue(need.searchMode)) accept('searchMode', 'radius_around_place')
      if (!hasValue(need.anchorName)) accept('anchorName', anchorName)
      if (!hasValue(need.anchorRole)) accept('anchorRole', cleaned.anchorRole || 'anchor')
      if (!hasValue(need.radiusKm)) accept('radiusKm', cleaned.radiusKm || 3)
      need.area = ''
      need.community = ''
    } else {
      reject('searchMode', '半径找房缺少可信锚点或原话半径意图')
    }
  }

  const validatedNeed = refreshNeedShape(need)
  if (rejectedFields.length) warnings.push('部分 LLM 解析字段被规则校验拒绝')
  return {
    validatedNeed,
    needValidation: {
      acceptedFields: unique(acceptedFields),
      rejectedFields,
      warnings
    }
  }
}

module.exports = {
  buildNeedParserPrompt,
  parseProviderJson,
  parseRentalNeedWithLlm,
  validateRentalNeed,
  _internal: {
    cleanLlmNeed,
    refreshNeedShape,
    featureMentioned,
    radiusIntentMentioned,
    shouldUseComplexNeedParser
  }
}
