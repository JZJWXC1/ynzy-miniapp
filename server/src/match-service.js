const domain = require('./domain')
const config = require('./config')
const { normalizeAsrText } = require('./asr-normalizer')
const {
  DEFAULT_RADIUS_KM,
  SERVICE_AREAS,
  distanceKm,
  listingCoordinate,
  placeNames,
  resolvePlace
} = require('./place-locator')
const {
  NO_FEATURE,
  DEPOSIT_FREE_FEATURE,
  parseFeatureInput
} = require('./listing-features')

const MAX_RECOMMEND_COUNT = 5
const DEFAULT_BUDGET_TOLERANCE = 300
const COMMUNITY_NEARBY_RADIUS_KM = 2
const MIN_BUDGET_RATIO = 0.75

const CONFIRMATION_FIELD_CONFIG = [
  { key: 'budget', label: '预算', emptyText: '待补充' },
  { key: 'location', label: '区域/小区', emptyText: '待补充' },
  { key: 'layout', label: '户型/租法', emptyText: '待补充' },
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
  { name: '独卫', aliases: ['独卫', '独立卫生间', '独立卫浴', '独立卫', '独立厨卫', '独厨独卫'], missing: '没有独卫', reason: '有独卫' },
  { name: '电梯', aliases: ['电梯'], missing: '没有电梯', reason: '有电梯' },
  // 近地铁：aliases 供「需求侧」解析（用户说「号线/地铁」＝要地铁）；房源侧只做整词精确命中（见 tokenHitsRule），
  // 裸「地铁/号线」只有当标签 token 恰好整词等于时才算，故「地铁明珠苑/一号线公寓」不会误判；真号线标签(2号线口)另经 NEAR_METRO_TAG_RE。
  { name: '近地铁', aliases: ['近地铁', '地铁口', '地铁站', '地铁旁', '地铁边', '靠地铁', '临地铁', '挨地铁', '地铁', '号线'], missing: '离地铁较远', reason: '近地铁' },
  { name: '朝南', aliases: ['朝南', '南向'], missing: '不是朝南', reason: '朝南' },
  // NEED-1：与房源侧 LISTING_FEATURE_OPTIONS 对齐（别名同房源侧自动打标签口径），让中介说得出、系统点得动
  { name: '干湿分离', aliases: ['干湿分离', '干湿分区'], missing: '不是干湿分离', reason: '干湿分离' },
  { name: '采光好', aliases: ['采光好', '采光佳', '采光很好', '光线好', '南北通透', '通透'], missing: '采光一般', reason: '采光好' },
  { name: '可短租', aliases: ['可短租', '短租'], missing: '不支持短租', reason: '可短租' },
  { name: '可月付', aliases: ['可月付', '月付', '押一付一'], missing: '不支持月付', reason: '可月付' },
  { name: '首次出租', aliases: ['首次出租', '首租', '第一次出租'], missing: '非首次出租', reason: '首次出租' },
  { name: '民水民电', aliases: ['民水民电', '民水', '民电'], missing: '非民水民电', reason: '民水民电' },
  { name: '带露台（阁楼）', aliases: ['带露台（阁楼）', '带露台', '带阁楼', '露台', '阁楼', '带花园', '有花园', '花园房', '带院子', '有院子'], missing: '没有露台/阁楼', reason: '带露台（阁楼）' },
  { name: '可养宠', aliases: ['可养宠', '养宠', '养猫', '养狗', '宠物'], missing: '不能养宠', reason: '可养宠' },
  { name: DEPOSIT_FREE_FEATURE, aliases: ['免押金', '无押金', '零押金', '押金0', '押金为0'], missing: '不免押金', reason: '免押金' }
]

// 特征别名全集 + 需求前缀，用于把「必须带花园/一定要带院子」这类特征需求短语挡在「小区名」抽取之外。
// 只剥离纯需求词（必须/一定/要/想…），不剥「带/有」——它们是「带花园/有花园」别名的组成部分。
const FEATURE_ALIAS_SET = new Set(FEATURE_RULES.reduce((acc, rule) => acc.concat(rule.aliases, rule.name), []))
const DEMAND_PREFIX_RE = /^(想要有|想要|需要|必须要|必须|一定要|一定|得要|得|最好|优先|尽量|偏好|看重|希望|想找|想住|要有|要)/

function isFeatureDemandPhrase(value) {
  let text = String(value || '').trim()
  let prev
  do { prev = text; text = text.replace(DEMAND_PREFIX_RE, '') } while (text && text !== prev)
  return Boolean(text) && FEATURE_ALIAS_SET.has(text)
}

// 在「小区名抽取」之前，先把「必须带花园/一定要有院子/要阁楼」这类『需求前缀+特征别名』片段从文本里擦掉。
// 否则花园/院子/阁楼等以社区后缀（园/苑/院/阁）收尾的特征别名会被 parseExplicitCommunity 的后缀正则误当小区名
// （尤其无逗号长句被 整租/两室 截断后，守卫看不到完整特征短语），导致真有该特征的房源被当地点过滤而漏推。
// 要求必带需求前缀，才不会误伤「地铁明珠苑」这种正常小区名（其 地铁 前没有需求词）。
// 前缀与特征别名之间允许可选量词（个/套/间…）：覆盖「找个带花园/找套带花园/想找个带院子」等中文最自然问法，
// 否则量词打断相邻性会让「个带花园」以社区后缀『园』被误当小区名 → 真房漏推。
const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g
const DEMAND_PREFIX_ALT = '必须要?|一定要?|想要有?|需要有?|得要?|最好|优先|尽量|偏好|看重|想找|想住|帮我?找|找|希望|想|要有|要|来'
const DEMAND_QUANTIFIER = '(?:来?个|来?套|间|栋|处)?'
const FEATURE_DEMAND_FRAGMENT_RE = new RegExp(
  '(?:' + DEMAND_PREFIX_ALT + ')' + DEMAND_QUANTIFIER + '(?:' +
  [...FEATURE_ALIAS_SET].filter(Boolean).sort((a, b) => b.length - a.length).map((a) => a.replace(ESCAPE_RE, '\\$&')).join('|') +
  ')', 'g'
)
function eraseFeatureDemands(text) {
  return String(text || '').replace(FEATURE_DEMAND_FRAGMENT_RE, ' ')
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

function implicitMinBudget(maxBudget) {
  const value = numberFrom(maxBudget)
  return value ? Math.ceil(value * MIN_BUDGET_RATIO) : 0
}

function effectiveMinBudget(need = {}) {
  const hard = need.hardConstraints || {}
  return numberFrom(hard.minBudget || need.minBudget) || implicitMinBudget(hard.maxBudget || need.maxBudget)
}

function allowedBudgetOverage(need = {}) {
  const preferences = need.preferences || {}
  return Math.max(0, numberFrom(preferences.budgetTolerance))
}

function exceedsBudgetOverage(need = {}, rent = 0) {
  const hard = need.hardConstraints || {}
  const maxBudget = numberFrom(hard.maxBudget || need.maxBudget)
  if (!maxBudget || !rent) return false
  const over = rent - maxBudget
  if (over <= 0) return false
  return over > allowedBudgetOverage(need)
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

function sourceTextFromPayload(payload = {}, vocabulary = []) {
  return normalizeAsrText(scrubDemandSource([
    payload.text,
    payload.voiceText,
    payload.form && payload.form.text,
    payload.form && payload.form.remark
  ].filter(Boolean).join('，')), { vocabulary })
}

function shouldUseConfirmedFormOnly(payload = {}) {
  return payload.confirmed === true && payload.form && typeof payload.form === 'object'
}

function normalizeCommunity(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(杭州市?|杭州)?(上城区|拱墅区|西湖区|滨江区|萧山区|余杭区|临平区|钱塘区)/, '')
    .replace(/附近$/, '')
}

function asrVocabularyFromCandidates(candidates = [], extraTerms = []) {
  const listingTerms = (candidates || []).flatMap((listing) => [
    listing.city,
    listing.district,
    listing.area,
    listing.block,
    listing.community,
    listing.layout,
    listing.room,
    listing.hall,
    listing.bath,
    listing.type,
    listing.rentMode,
    ...(parseFeatureInput(listing.features) || []),
    ...(parseFeatureInput(listing.rawFeatures) || [])
  ])
  const featureTerms = FEATURE_RULES.flatMap((rule) => [rule.name].concat(rule.aliases || []))
  return unique([
    ...AREA_WORDS,
    ...Object.keys(AREA_ALIASES),
    ...Object.values(AREA_ALIASES),
    '一室',
    '两室',
    '三室',
    '四室',
    '五室',
    '六室',
    '一厅',
    '两厅',
    '一卫',
    '两卫',
    '单间',
    '整租',
    '合租',
    ...featureTerms,
    ...listingTerms,
    ...extraTerms
  ])
}

function configuredBlockNames() {
  const location = (config && config.location) || {}
  const districtBlocks = location.districtBlocks || {}
  return unique(Object.keys(location.blockCenters || {})
    .concat(Object.keys(location.blockDistrictMap || {}))
    .concat(Object.values(districtBlocks).flat()))
}

function structuredScopeNames(candidates = []) {
  return unique((candidates || []).flatMap((listing) => [
    listing.community,
    listing.block
  ]).concat(configuredBlockNames()))
}

function knownScopeNames(db = {}, candidates = []) {
  return unique(structuredScopeNames(candidates).concat(placeNames(db, candidates)))
}

function exactKnownScopeName(value, candidates = [], options = {}) {
  const target = normalizeCommunity(cleanAnchorName(value))
  if (!target) return ''
  return structuredScopeNames(candidates).find((name) => normalizeCommunity(name) === target) || ''
}

function hasAmbiguousPlaceName(value, candidates = [], options = {}) {
  const resolution = resolvePlace(options.db || {}, value, candidates)
  return resolution && resolution.status === 'ambiguous'
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

function parseRadiusValue(source) {
  const text = compactText(source)
  const matched = text.match(/([一二两三四五六七八九十百千万\d.]+)(?:公里|千米|km)(?:以内|内|范围内|范围)?/i)
  if (!matched) return 0
  const value = amountValue(matched[1])
  return value > 0 ? value : 0
}

function cleanAnchorName(value) {
  return compactText(value)
    .replace(/^(客户|租客|他|她|我|帮我|帮客户|帮租客)/, '')
    .replace(/^(想|要|想要|想住|想找|找|找个|找一套|看看|看下|有没有)/, '')
    .replace(/^(在|离|距|距离)/, '')
    .replace(/(上班|工作|通勤|住的|住|有哪些|有什么|房源|找房|附近|周边|旁边|边上|一带)$/g, '')
    .replace(/[，,。；;：:！？?]/g, '')
}

function shouldUseNearbyRadius(anchorName) {
  const text = cleanAnchorName(anchorName)
  if (!text) return false
  if (AREA_WORDS.map(normalizeArea).indexOf(normalizeArea(text)) !== -1) return false
  if (/园|苑|府|城|广场|万达|中心|大厦|智慧园|产业园|写字楼|新天地/.test(text)) return true
  return false
}

function parseRadiusSearch(source, candidates = [], options = {}) {
  const text = compactText(source)
  if (!text) return null
  const explicitRadius = parseRadiusValue(text)

  const workplace = text.match(/(?:客户|租客|他|她)?(?:在|离|距|距离)(.{2,30}?)(?:上班|工作|通勤)/)
  if (workplace) {
    const anchorName = cleanAnchorName(workplace[1])
    if (anchorName) {
      return {
        searchMode: 'radius_around_place',
        anchorName,
        anchorRole: 'workplace',
        radiusKm: explicitRadius || DEFAULT_RADIUS_KM
      }
    }
  }

  const radiusNearAnchor = text.match(/(.{2,30}?)(?:的)?[一二两三四五六七八九十百千万\d.]+(?:公里|千米|km)(?:以内|内|范围内|范围)?/i)
  if (radiusNearAnchor) {
    const anchorName = cleanAnchorName(radiusNearAnchor[1])
    if (anchorName) {
      return {
        searchMode: 'radius_around_place',
        anchorName,
        anchorRole: 'anchor',
        radiusKm: explicitRadius || DEFAULT_RADIUS_KM
      }
    }
  }

  const nearbyAnchor = text.match(/(.{2,30}?)(?:附近|周边|旁边|边上|一带)/)
  if (nearbyAnchor) {
    if (/想住|住在|住到/.test(nearbyAnchor[1])) return null
    const anchorName = cleanAnchorName(nearbyAnchor[1])
    if (anchorName && exactKnownScopeName(anchorName, candidates, options) && !hasAmbiguousPlaceName(anchorName, candidates, options)) {
      return null
    }
    if (anchorName && shouldUseNearbyRadius(anchorName)) {
      return {
        searchMode: 'radius_around_place',
        anchorName,
        anchorRole: 'anchor',
        radiusKm: DEFAULT_RADIUS_KM
      }
    }
  }

  return null
}

function parseArea(source) {
  const text = compactText(source)
  const matched = AREA_WORDS.find((word) => text.indexOf(word) !== -1)
  return normalizeArea(matched || '')
}

function cleanExplicitCommunity(value) {
  const candidate = normalizeCommunity(value)
    .replace(/^(想住|住在|住到|想看|看看|看下|帮我?找|找|有没有|有无)/, '')
    .replace(/^(来?个|来?套|间|栋|处)/, '') // 剥掉残留量词（「个带花园」→「带花园」），交给下方 isFeatureDemandPhrase 拦截
    .replace(/(有|有没有|附近|周边|旁边|一室|两室|三室|四室|单间|整租|合租|预算|\d{3,5}).*$/, '')
  if (!candidate || candidate.length < 3 || candidate.length > 24) return ''
  if (['小区', '公寓', '家园', '花园'].indexOf(candidate) !== -1) return ''
  if (AREA_WORDS.map(normalizeArea).indexOf(normalizeArea(candidate)) !== -1) return ''
  // 「必须带花园/一定要带院子」等特征需求短语不是小区名，剥离需求前缀后若命中特征别名则拒判为小区，避免真有该特征的房源漏推。
  if (isFeatureDemandPhrase(candidate)) return ''
  return candidate
}

function parseExplicitCommunity(source) {
  // 先擦除「必须带花园」等特征需求片段，再抽小区名，避免特征别名的社区后缀（园/苑/院/阁）被误当小区名（导致真房漏推）。
  const text = eraseFeatureDemands(normalizeCommunity(source))
  if (!text) return ''
  const suffix = '(?:小区|公寓|家园|花园|新村|苑|府|园|城|湾|庭|轩|里|坊|庄|村|郡|阁|寓|邸)'
  const patterns = [
    new RegExp(`(?:想住|住在|住到|想看|看看|看下|找|有没有|有无)([\\u4e00-\\u9fa5A-Za-z0-9·（）()]{2,24}?${suffix})`),
    new RegExp(`([\\u4e00-\\u9fa5A-Za-z0-9·（）()]{2,24}?${suffix})(?:有|有没有|附近|周边|旁边|一室|两室|三室|四室|单间|整租|合租|预算|\\d{3,5}|$)`)
  ]
  for (const pattern of patterns) {
    const matched = text.match(pattern)
    const candidate = matched ? cleanExplicitCommunity(matched[1]) : ''
    if (candidate) return candidate
  }
  return ''
}

function parseCommunity(source, candidates, options = {}) {
  const text = normalizeCommunity(source)
  if (!text) return ''
  const communities = unique((candidates || []).map((listing) => listing.community)
    .concat((candidates || []).map((listing) => listing.block))
    .concat(options.communityNames || []))
    .concat(knownScopeNames(options.db || {}, candidates))
    .filter((item) => normalizeCommunity(item).length >= 2)
    .sort((left, right) => normalizeCommunity(right).length - normalizeCommunity(left).length)

  const matched = communities.find((community) => {
    const name = normalizeCommunity(community)
    return text.indexOf(name) !== -1 || (name.length >= 3 && name.indexOf(text) !== -1)
  })
  return matched || parseExplicitCommunity(text)
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
  if (/整租/.test(text)) return '整租'
  if (/合租|单间/.test(text)) return '合租'
  return ''
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

function parseNeed(payload = {}, candidates = [], options = {}) {
  const useConfirmedFormOnly = shouldUseConfirmedFormOnly(payload)
  const coordinateVocabulary = placeNames(options.db || {}, candidates)
  const communityNames = placeNames(options.db || {}, candidates, { types: ['community'] })
  const source = useConfirmedFormOnly
    ? ''
    : sourceTextFromPayload(payload, asrVocabularyFromCandidates(candidates, coordinateVocabulary))
  const form = payload.form || {}
  const radiusSearch = form.searchMode === 'radius_around_place'
    ? {
        searchMode: 'radius_around_place',
        anchorName: form.anchorName || form.anchorPlace || '',
        anchorRole: form.anchorRole || 'anchor',
        radiusKm: numberFrom(form.radiusKm) || DEFAULT_RADIUS_KM
      }
    : parseRadiusSearch(source, candidates, { db: options.db })
  const budget = parseBudget([form.budget, form.budgetText, source].filter(Boolean).join('，'))
  const formMinBudget = numberFrom(form.minBudget)
  const formMaxBudget = numberFrom(form.maxBudget)
  if (formMinBudget) budget.minBudget = formMinBudget
  if (formMaxBudget) {
    budget.maxBudget = formMaxBudget
    budget.budgetText = budget.minBudget ? `${budget.minBudget}-${budget.maxBudget}` : `${budget.maxBudget}`
  }
  const community = radiusSearch ? '' : (form.community || parseCommunity(source, candidates, { communityNames, db: options.db }))
  const area = normalizeArea(form.area || parseArea(source))
  const layout = form.layout || parseLayout(source)
  const rentMode = form.rentMode || parseRentMode(source)
  const featureResult = parseFeatures([source, parseFeatureInput(form.features).join('，')].filter(Boolean).join('，'))
  const allFeatures = unique(featureResult.hardFeatures.concat(featureResult.preferenceFeatures))
  const hardMinBudget = budget.minBudget || implicitMinBudget(budget.maxBudget)
  const hardConstraints = cleanConstraintObject({
    minBudget: hardMinBudget || '',
    maxBudget: budget.maxBudget || '',
    area: radiusSearch ? '' : area,
    community: radiusSearch ? '' : community,
    rentMode,
    layout,
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
    searchMode: radiusSearch ? radiusSearch.searchMode : '',
    anchorName: radiusSearch ? radiusSearch.anchorName : '',
    anchorRole: radiusSearch ? radiusSearch.anchorRole : '',
    radiusKm: radiusSearch ? radiusSearch.radiusKm : '',
    preferredAreas: radiusSearch ? SERVICE_AREAS.slice() : [],
    rentMode,
    layout,
    features: allFeatures,
    hardConstraints,
    preferences
  }
}

function recognizedCoreCount(need) {
  return [
    Boolean(need.maxBudget || need.minBudget),
    Boolean(need.area || need.community || need.anchorName),
    Boolean(need.layout || need.rentMode)
  ].filter(Boolean).length
}

function buildFollowUpQuestion(need) {
  if (recognizedCoreCount(need) >= 2) return ''
  if (!need.maxBudget && !need.minBudget) return '预算大概多少？'
  if (!need.area && !need.community && !need.anchorName) return '想看哪个区域、小区或地点周边？'
  if (!need.layout && !need.rentMode) return '客户想要几室或单间？'
  return ''
}

function confirmationFieldValue(need = {}, key) {
  if (key === 'budget') return need.budgetText || (need.maxBudget ? `${need.maxBudget}以内` : '')
  if (key === 'location') {
    if (need.searchMode === 'radius_around_place') {
      return [need.anchorName, need.radiusKm ? `${need.radiusKm}公里内` : '附近'].filter(Boolean).join(' · ')
    }
    return [need.area, need.community].filter(Boolean).join(' · ')
  }
  if (key === 'layout') return [need.rentMode, need.layout].filter(Boolean).join(' · ')
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

// 房源侧特征判定 —— 硬特征满足(exact)只来自「可信标签字段」features/rawFeatures 的【整词精确】命中（守精确优先北极星）：
// - 逐 token（标签本是数组）：token 整词等于某别名/特征名 → 真标签；否则不算。不做任何子串命中——
//   否则「阳台山/电梯华都/免押金时代」(别名+任意专名后缀) 与「无电梯/非首次出租/不可短租」(否定形) 都会子串冒充硬特征。
// - 描述性 title/meta（多为专名/营销名）不支撑 exact；description 里的真实特征已由 domain.inferListingFeatures
//   走【非锚定+否定判定】烘焙进 features（整词）、自由标签走【整词锚定】，二者结果都以整词进入本判定。宁可漏标不可错标。
// - 唯一例外：近地铁的真号线标签(2号线口/紧邻2号线)用强语境正则识别，排除「X号线+专名后缀(公寓/苑/家园…)」如 一号线公寓。
const NAME_SUFFIX_ALT = '公寓|公馆|花园|家园|嘉园|雅苑|华府|华庭|山庄|大厦|名邸|新村|小区|苑|园|城|府|庄|座|幢|邸|里|巷|弄|路|桥|馆|居|庭|轩|湾|郡|墅|寓|阁'
const NEAR_METRO_TAG_RE = new RegExp('(?:近|紧邻|临|靠|挨)?(?:地铁)?[\\d一二三四五六七八九十两]号线(?!' + NAME_SUFFIX_ALT + ')')

function listingFeatureTokens(listing = {}) {
  return parseFeatureInput(listing.features)
    .concat(parseFeatureInput(listing.rawFeatures))
    .map((token) => String(token || '').trim())
    .filter(Boolean)
}

function tokenHitsRule(token, rule) {
  // 房源侧只认『整词精确等于别名/特征名』的可信标签 token（features/rawFeatures 逐 token）。
  // 刻意不做任何子串命中：否则「阳台山/电梯华都/免押金时代」(别名+任意后缀专名) 与「无电梯/非首次出租/不可短租」(否定形)
  // 都会被子串命中冒充硬特征 → 对硬条件撒谎。真实描述里的特征已由 domain.inferListingFeatures 烘焙进 features（整词），仍命中。
  if (token === rule.name || rule.aliases.indexOf(token) !== -1) return true
  // 安全正向前缀归一：剥掉正向标记(有/带/自带/配/支持/接受/可)后若余部整词等于别名则算真标签——
  // 覆盖「有阳台/有电梯/有燃气/带电梯/支持月付」等房东正向写法；剥后必须整词等于别名，故「阳台山/电梯华都」(专名)
  // 与「无电梯/没有阳台/非首次出租」(否定，前缀不在正向集里) 仍不命中。
  const core = token.replace(/^(有|带|自带|配|支持|接受|可)/, '')
  if (core !== token && (core === rule.name || rule.aliases.indexOf(core) !== -1)) return true
  // 唯一例外：近地铁的真号线标签「2号线口/紧邻2号线」，用强语境正则识别（排除「X号线+专名后缀」如 一号线公寓）。
  if (rule.name === '近地铁' && NEAR_METRO_TAG_RE.test(token)) return true
  return false
}

function ruleHitsListing(rule, listing) {
  return listingFeatureTokens(listing).some((token) => tokenHitsRule(token, rule))
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
  const featureNames = parseFeatureInput(listing.features)
    .concat(parseFeatureInput(listing.rawFeatures))
    .filter((item) => item !== NO_FEATURE)
  FEATURE_RULES.forEach((rule) => {
    if (ruleHitsListing(rule, listing)) featureNames.push(rule.name)
  })
  return new Set(unique(featureNames.concat([listing.type, listing.rentMode]).filter(Boolean)))
}

function featureMatched(listing, feature) {
  const set = listingFeatureSet(listing)
  if (set.has(feature)) return true
  return ruleHitsListing(getFeatureRule(feature), listing)
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
  const listingCommunity = normalizeCommunity(listing.community)
  if (target && listingCommunity && (listingCommunity.indexOf(target) !== -1 || target.indexOf(listingCommunity) !== -1)) {
    return true
  }
  const strictScopeValues = [
    listing.block,
    listing.area,
    listing.district
  ].map(normalizeCommunity).filter(Boolean)
  return Boolean(target && strictScopeValues.some((value) => value === target))
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
  const hardFeatureReasons = (need.hardConstraints.features || []).map((feature) => getFeatureRule(feature).reason)
  const preferenceFeatureReasons = matchedPreferenceFeatures.map((feature) => getFeatureRule(feature).reason)
  const baseReasons = []
  if (need.maxBudget && rentOfListing(listing) <= need.maxBudget) baseReasons.push('预算内')
  if (need.area || need.community) baseReasons.push('位置匹配')
  if (need.layout) baseReasons.push('户型匹配')
  if (need.rentMode) baseReasons.push(`${need.rentMode}匹配`)
  return unique(hardFeatureReasons.concat(preferenceFeatureReasons).concat(baseReasons)).slice(0, 3)
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
  if (listing.qualityScore) score += Math.min(8, Math.round(Number(listing.qualityScore) / 15))
  if (listing.freshnessScore) score += Math.min(5, Math.round(Number(listing.freshnessScore) / 25))
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
  if (hasHardFeatureMismatch(item, need)) return false
  const rent = rentOfListing(item.listing)
  const minBudget = effectiveMinBudget(need)
  const tooExpensive = exceedsBudgetOverage(need, rent)
  const tooCheap = minBudget && rent && rent < minBudget
  const impossibleArea = item.hardDifferences.indexOf('区域不符') !== -1 && item.hardDifferences.length > 1
  return !tooCheap && !tooExpensive && !impossibleArea && item.score >= 25
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
    : '无明显差异'
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
    sub: '管理员确认签单后，成交总比例按房东实付佣金的 20% 计算，上传人按房源类型到手',
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
    displayRelevance: `${relevanceScore}%`,
    qualityScore: listing.qualityScore || 0,
    freshnessScore: listing.freshnessScore || 0,
    coordinateQuality: listing.coordinateQuality || '',
    distanceKm: listing.distanceKm || '',
    distanceText: listing.distanceText || '',
    anchorName: listing.anchorName || ''
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
    const profile = raw.recommendationProfile || null
    const profileLocation = profile && profile.publicLocation ? profile.publicLocation : {}
    if (profile && profile.ready !== true) return null
    return {
      ...listing,
      recommendationProfile: profile || undefined,
      rawFeatures: unique(parseFeatureInput(raw.features).concat(parseFeatureInput(raw.tags))),
      status: raw.status || listing.status || '',
      rent: numberFrom((profile && profile.rent) || raw.rent || listing.rent || listing.price),
      layout: (profile && profile.layout) || raw.layout || listing.layout || '',
      rentMode: (profile && profile.rentMode) || raw.rentMode || raw.type || listing.rentMode || listing.type || '',
      type: (profile && profile.rentMode) || raw.type || raw.rentMode || listing.type || listing.rentMode || '',
      room: (profile && profile.room) || raw.room || listing.room || '',
      hall: (profile && profile.hall) || raw.hall || listing.hall || '',
      bath: (profile && profile.bath) || raw.bath || listing.bath || '',
      area: profileLocation.area || raw.area || raw.district || listing.area || listing.district || '',
      district: profileLocation.district || raw.district || listing.district || listing.area || '',
      block: profileLocation.block || raw.block || listing.block || '',
      community: profileLocation.community || raw.community || listing.community || '',
      mapLatitude: raw.mapLatitude || raw.latitude || listing.mapLatitude || listing.latitude || '',
      mapLongitude: raw.mapLongitude || raw.longitude || listing.mapLongitude || listing.longitude || '',
      coordinateSource: raw.coordinateSource || listing.coordinateSource || '',
      coordinateVerified: raw.coordinateVerified === true || listing.coordinateVerified === true,
      qualityScore: Number(profile && profile.qualityScore) || 0,
      freshnessScore: Number(profile && profile.freshnessScore) || 0,
      coordinateQuality: (profile && profile.coordinateQuality) || ''
    }
  }).filter(Boolean)
}

function sortEvaluated(left, right) {
  if (right.score !== left.score) return right.score - left.score
  return rentOfListing(left.listing) - rentOfListing(right.listing)
}

function formatDistance(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  if (number < 1) return `${Math.round(number * 1000)}m`
  return `${number.toFixed(1)}km`
}

function radiusEvaluationNeed(need = {}) {
  return {
    ...need,
    area: '',
    community: '',
    hardConstraints: {
      ...(need.hardConstraints || {}),
      area: '',
      community: ''
    }
  }
}

function addDistanceToListing(listing, place, distanceValue) {
  const distanceText = formatDistance(distanceValue)
  return {
    ...listing,
    distanceKm: Number(distanceValue.toFixed(3)),
    distanceText: distanceText ? `距${place.name}约${distanceText}` : '',
    anchorName: place.name
  }
}

function sortRadiusEvaluated(left, right) {
  if (right.score !== left.score) return right.score - left.score
  return Number(left.listing.distanceKm || 999) - Number(right.listing.distanceKm || 999)
}

function hasStructuralMismatch(item) {
  return (item.hardDifferences || []).some((text) => /户型不符|户型少|户型多|整租不符|合租不符/.test(text))
}

function hasHardFeatureMismatch(item, need = {}) {
  const features = (need.hardConstraints && need.hardConstraints.features) || []
  if (!features.length) return false
  const differences = item.hardDifferences || []
  return features.some((feature) => differences.indexOf(getFeatureRule(feature).missing) !== -1)
}

function canBeRadiusNearby(item, need) {
  if (item.exact || !item.differences.length) return false
  if (hasStructuralMismatch(item)) return false
  if (hasHardFeatureMismatch(item, need)) return false
  const rent = rentOfListing(item.listing)
  const minBudget = effectiveMinBudget(need)
  if (minBudget && rent && rent < minBudget) return false
  if (exceedsBudgetOverage(need, rent)) return false
  return item.score >= 35
}

function buildPlaceFollowUp(resolution, need = {}) {
  if (!need.anchorName) return '想围绕哪个地点找房？'
  if (resolution && resolution.status === 'ambiguous') {
    const names = (resolution.candidates || []).map((item) => [item.area, item.name].filter(Boolean).join('')).slice(0, 3)
    return names.length
      ? `我找到多个叫「${need.anchorName}」的地点，你指的是：${names.join('、')}？`
      : `我找到多个叫「${need.anchorName}」的地点，需要你确认一下具体位置。`
  }
  if (need.anchorName === '乐富智慧园') {
    return '乐富智慧园我没确认坐标，是祥符这边的吗？或者你再发我一个附近的地点。'
  }
  return `${need.anchorName}我没确认坐标，你再发我一个附近的地点或更具体地址，我再按${need.radiusKm || DEFAULT_RADIUS_KM}公里内筛。`
}

function buildRadiusGroupReply(need = {}, place = {}, groups = {}) {
  const placeName = place.name || need.anchorName || '这个地点'
  const radiusKm = need.radiusKm || DEFAULT_RADIUS_KM
  const exactCount = (groups.exactListings || []).length
  const nearbyCount = (groups.nearbyListings || []).length
  if (exactCount && nearbyCount) {
    return `我按${placeName}${radiusKm}公里内筛了，找到${exactCount}套符合要求，另有${nearbyCount}套接近房源。`
  }
  if (exactCount) {
    return `我按${placeName}${radiusKm}公里内筛了，找到${exactCount}套符合要求，已按距离和匹配度排序。`
  }
  if (nearbyCount) {
    return `我按${placeName}${radiusKm}公里内筛了，没有完全符合的，先给你${nearbyCount}套接近房源。`
  }
  return `我按${placeName}${radiusKm}公里内筛了，暂未找到合适房源，可以放宽预算、户型或距离。`
}

function buildCommunityNearbyReply(need = {}, place = {}, groups = {}) {
  const community = need.community || (need.hardConstraints && need.hardConstraints.community) || place.name || '这个小区'
  const count = (groups.nearbyListings || []).length
  if (count) {
    return `${community}里暂时没有完全符合的，我按周边${COMMUNITY_NEARBY_RADIUS_KM}公里找了${count}套相邻小区房源。`
  }
  return `${community}里暂时没有完全符合的，周边${COMMUNITY_NEARBY_RADIUS_KM}公里也没筛到合适房源，可以放宽预算、户型或距离。`
}

function communityAdjacentEvaluationNeed(need = {}) {
  return {
    ...need,
    community: '',
    hardConstraints: {
      ...(need.hardConstraints || {}),
      community: ''
    }
  }
}

function shouldUseCommunityAdjacentFallback(need = {}, exact = []) {
  const community = need.community || (need.hardConstraints && need.hardConstraints.community)
  return Boolean(community && exact.length === 0)
}

function groupCommunityAdjacentListings(candidates, need, options = {}) {
  const community = need.community || (need.hardConstraints && need.hardConstraints.community)
  const resolution = resolvePlace(options.db || {}, community, candidates)
  if (resolution.status !== 'resolved') {
    const nextQuestion = community
      ? `${community}我没确认坐标，你再发我一个附近的地点或更具体地址，我再按周边帮你筛。`
      : '你说的小区我没确认坐标，你再发我一个附近的地点或更具体地址。'
    return {
      exactListings: [],
      nearbyListings: [],
      listings: [],
      nextQuestion,
      reply: nextQuestion,
      placeResolution: resolution
    }
  }

  const scopedCandidates = (candidates || []).map((listing) => {
    const coordinate = listingCoordinate(listing)
    if (!coordinate) return null
    const value = distanceKm(resolution, coordinate)
    if (!Number.isFinite(value) || value > COMMUNITY_NEARBY_RADIUS_KM) return null
    return addDistanceToListing(listing, resolution, value)
  }).filter(Boolean)

  const needForEvaluation = communityAdjacentEvaluationNeed(need)
  const evaluated = scopedCandidates.map((listing) => {
    const item = evaluateListing(listing, needForEvaluation)
    const distanceValue = Number(listing.distanceKm || 0)
    const distanceBoost = Math.max(0, Math.round(8 - (distanceValue / COMMUNITY_NEARBY_RADIUS_KM) * 8))
    item.score = Math.max(1, Math.min(99, item.score + distanceBoost))
    item.reasons = unique([listing.distanceText].concat(item.reasons || [])).slice(0, 3)
    if (!communityMatches(listing, community)) {
      item.hardDifferences = unique((item.hardDifferences || []).concat(`不在${community}`))
      item.differences = unique((item.differences || []).concat(`不在${community}`))
      item.exact = false
    }
    return item
  }).filter((item) => item.exact || canBeRadiusNearby(item, needForEvaluation))
    .sort(sortRadiusEvaluated)

  const nearbyListings = evaluated.slice(0, MAX_RECOMMEND_COUNT).map((item) => sanitizeListing(item, 'nearby'))
  const groups = {
    exactListings: [],
    nearbyListings,
    listings: nearbyListings,
    placeResolution: resolution
  }
  return {
    ...groups,
    reply: buildCommunityNearbyReply(need, resolution, groups)
  }
}

function groupRadiusListings(candidates, need, options = {}) {
  const resolution = resolvePlace(options.db || {}, need.anchorName, candidates)
  const empty = {
    exactListings: [],
    nearbyListings: [],
    listings: [],
    placeResolution: resolution
  }
  if (resolution.status !== 'resolved') {
    const nextQuestion = buildPlaceFollowUp(resolution, need)
    return {
      ...empty,
      nextQuestion,
      reply: nextQuestion
    }
  }

  const radiusKm = Number(need.radiusKm || DEFAULT_RADIUS_KM)
  const scopedCandidates = (candidates || []).map((listing) => {
    const coordinate = listingCoordinate(listing)
    if (!coordinate) return null
    const value = distanceKm(resolution, coordinate)
    if (!Number.isFinite(value) || value > radiusKm) return null
    return addDistanceToListing(listing, resolution, value)
  }).filter(Boolean)

  const needForEvaluation = radiusEvaluationNeed(need)
  const evaluated = scopedCandidates.map((listing) => {
    const item = evaluateListing(listing, needForEvaluation)
    const distanceValue = Number(listing.distanceKm || 0)
    const distanceBoost = Math.max(0, Math.round(12 - (distanceValue / Math.max(radiusKm, 0.1)) * 12))
    item.score = Math.max(1, Math.min(99, item.score + distanceBoost))
    item.reasons = unique([listing.distanceText].concat(item.reasons || [])).slice(0, 3)
    return item
  })

  const exact = evaluated
    .filter((item) => item.exact)
    .sort(sortRadiusEvaluated)
  const nearby = evaluated
    .filter((item) => canBeRadiusNearby(item, needForEvaluation))
    .sort(sortRadiusEvaluated)
  const exactListings = exact.slice(0, MAX_RECOMMEND_COUNT).map((item) => sanitizeListing(item, 'exact'))
  const nearbyListings = nearby.slice(0, MAX_RECOMMEND_COUNT).map((item) => sanitizeListing(item, 'nearby'))
  const listings = exactListings.concat(nearbyListings).slice(0, MAX_RECOMMEND_COUNT)
  const reply = buildRadiusGroupReply(need, resolution, { exactListings, nearbyListings })

  return {
    exactListings,
    nearbyListings,
    listings,
    reply,
    placeResolution: resolution
  }
}

function groupListings(candidates, need, options = {}) {
  if (need && need.searchMode === 'radius_around_place') {
    return groupRadiusListings(candidates, need, options)
  }
  const evaluated = (candidates || []).map((listing) => evaluateListing(listing, need))
  const exact = evaluated
    .filter((item) => item.exact)
    .sort(sortEvaluated)
  if (shouldUseCommunityAdjacentFallback(need, exact)) {
    const adjacentGroups = groupCommunityAdjacentListings(candidates, need, options)
    if (adjacentGroups) return adjacentGroups
  }
  const explicitCommunity = Boolean(need.community || (need.hardConstraints && need.hardConstraints.community))
  const nearby = explicitCommunity && exact.length
    ? []
    : evaluated
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

function publicPlaceResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') return null
  const result = {}
  ;['status', 'query', 'name', 'area', 'type', 'source'].forEach((key) => {
    const value = resolution[key]
    if (value !== undefined && value !== null && value !== '') result[key] = value
  })
  if (Array.isArray(resolution.candidates)) {
    result.candidates = resolution.candidates.slice(0, 5).map((item) => {
      const candidate = {}
      ;['name', 'area', 'type', 'source'].forEach((key) => {
        const value = item && item[key]
        if (value !== undefined && value !== null && value !== '') candidate[key] = value
      })
      return candidate
    })
  }
  return Object.keys(result).length ? result : null
}

function clampReply(text) {
  const value = String(text || '').trim()
  return value.length > 100 ? `${value.slice(0, 97)}...` : value
}

function buildReply(need, groups, followUpQuestion) {
  if (followUpQuestion) return followUpQuestion
  if (groups.reply) return clampReply(groups.reply)
  if (need && need.searchMode === 'radius_around_place') {
    const placeName = (groups.placeResolution && groups.placeResolution.name) || need.anchorName || '这个地点'
    const radiusKm = need.radiusKm || DEFAULT_RADIUS_KM
    if (groups.exactListings.length && groups.nearbyListings.length) {
      return clampReply(`我按${placeName}${radiusKm}公里内筛了，找到${groups.exactListings.length}套符合要求，另有${groups.nearbyListings.length}套接近房源。`)
    }
    if (groups.exactListings.length) {
      return clampReply(`我按${placeName}${radiusKm}公里内筛了，找到${groups.exactListings.length}套符合要求，已按距离和匹配度排序。`)
    }
    if (groups.nearbyListings.length) {
      return clampReply(`我按${placeName}${radiusKm}公里内筛了，没有完全符合的，先给你${groups.nearbyListings.length}套接近房源。`)
    }
    return clampReply(`我按${placeName}${radiusKm}公里内筛了，暂未找到合适房源，可以放宽预算、户型或距离。`)
  }
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
  const need = parseNeed(payload, candidates, { db })
  const followUpQuestion = buildFollowUpQuestion(need)
  const emptyGroups = { exactListings: [], nearbyListings: [], listings: [] }
  const groups = followUpQuestion ? emptyGroups : groupListings(candidates, need, { db })
  const nextQuestion = followUpQuestion || groups.nextQuestion || ''
  return {
    need,
    hardConstraints: need.hardConstraints,
    preferences: need.preferences,
    exactListings: groups.exactListings,
    nearbyListings: groups.nearbyListings,
    followUpQuestion: nextQuestion,
    listings: groups.listings,
    placeResolution: publicPlaceResolution(groups.placeResolution),
    reply: buildReply(need, groups, nextQuestion),
    mode: 'local-match-v1'
  }
}

function recognizeNeed(db, payload = {}, options = {}) {
  const candidates = options.candidates || candidateListings(db || {})
  const need = parseNeed(payload, candidates, { db })
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
    relevancePercent: listing.relevancePercent,
    qualityScore: listing.qualityScore,
    freshnessScore: listing.freshnessScore,
    coordinateQuality: listing.coordinateQuality,
    distanceKm: listing.distanceKm,
    distanceText: listing.distanceText,
    anchorName: listing.anchorName
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
    asrVocabularyFromCandidates,
    buildConfirmationFields,
    buildFollowUpQuestion,
    candidateListings,
    parseExplicitCommunity,
    publicPlaceResolution,
    groupCommunityAdjacentListings,
    groupRadiusListings,
    groupListings,
    evaluateListing
  }
}
