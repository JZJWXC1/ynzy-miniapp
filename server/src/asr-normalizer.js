const DEFAULT_ASR_VOCABULARY = [
  '钱江新城',
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
  '东新',
  '一室',
  '两室',
  '三室',
  '四室',
  '单间',
  '整租',
  '合租',
  '带阳台',
  '阳台',
  '燃气',
  '独卫',
  '电梯',
  '近地铁',
  '地铁',
  '朝南',
  '可养宠',
  '免押金'
]

const SPOKEN_SYNONYM_REPLACEMENTS = [
  [/一房/g, '一室'],
  [/两房/g, '两室'],
  [/二房/g, '两室'],
  [/三房/g, '三室'],
  [/四房/g, '四室']
]

const PROTECTED_ASR_TERMS = [
  '整租',
  '合租',
  '单间',
  '一室',
  '两室',
  '三室',
  '四室',
  '五室',
  '六室'
]

const PINYIN_MAP = {
  一: 'yi',
  事: 'shi',
  是: 'shi',
  世: 'shi',
  室: 'shi',
  两: 'liang',
  二: 'er',
  三: 'san',
  四: 'si',
  房: 'fang',
  单: 'dan',
  间: 'jian',
  见: 'jian',
  建: 'jian',
  独: 'du',
  位: 'wei',
  喂: 'wei',
  卫: 'wei',
  阳: 'yang',
  羊: 'yang',
  台: 'tai',
  燃: 'ran',
  气: 'qi',
  汽: 'qi',
  电: 'dian',
  梯: 'ti',
  提: 'ti',
  题: 'ti',
  地: 'di',
  铁: 'tie',
  帖: 'tie',
  贴: 'tie',
  朝: 'chao',
  南: 'nan',
  男: 'nan',
  合: 'he',
  租: 'zu',
  祖: 'zu',
  免: 'mian',
  押: 'ya',
  压: 'ya',
  金: 'jin',
  钱: 'qian',
  唐: 'tang',
  塘: 'tang',
  江: 'jiang',
  姜: 'jiang',
  滨: 'bin',
  宾: 'bin',
  彬: 'bin',
  西: 'xi',
  湖: 'hu',
  胡: 'hu',
  古: 'gu',
  荡: 'dang',
  当: 'dang',
  拱: 'gong',
  墅: 'shu',
  树: 'shu',
  述: 'shu',
  上: 'shang',
  城: 'cheng',
  成: 'cheng',
  萧: 'xiao',
  山: 'shan',
  余: 'yu',
  杭: 'hang',
  临: 'lin',
  平: 'ping',
  兴: 'xing',
  长: 'chang',
  河: 'he',
  禾: 'he',
  浦: 'pu',
  普: 'pu',
  沿: 'yan',
  设: 'she',
  路: 'lu',
  文: 'wen',
  近: 'jin',
  武: 'wu',
  林: 'lin',
  东: 'dong',
  新: 'xin',
  春: 'chun',
  波: 'bo',
  播: 'bo',
  苑: 'yuan',
  院: 'yuan',
  雅: 'ya',
  亚: 'ya',
  沙: 'sha',
  万: 'wan',
  区: 'qu',
  达: 'da',
  公: 'gong',
  寓: 'yu',
  家: 'jia',
  园: 'yuan',
  村: 'cun',
  寸: 'cun'
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

function hasChinese(value) {
  return /[\u4e00-\u9fa5]/.test(String(value || ''))
}

function charsOf(value) {
  return Array.from(String(value || ''))
}

function pinyinOf(value) {
  return charsOf(value).map((char) => PINYIN_MAP[char] || char.toLowerCase())
}

function initialsOf(value) {
  return pinyinOf(value).map((item) => item.slice(0, 1)).join('')
}

function samePositionRatio(left, right) {
  const leftChars = charsOf(left)
  const rightChars = charsOf(right)
  if (!leftChars.length || leftChars.length !== rightChars.length) return 0
  const sameCount = leftChars.filter((char, index) => char === rightChars[index]).length
  return sameCount / leftChars.length
}

function editDistance(left, right) {
  const leftChars = charsOf(left)
  const rightChars = charsOf(right)
  const dp = Array.from({ length: leftChars.length + 1 }, () => Array(rightChars.length + 1).fill(0))
  for (let i = 0; i <= leftChars.length; i += 1) dp[i][0] = i
  for (let j = 0; j <= rightChars.length; j += 1) dp[0][j] = j
  for (let i = 1; i <= leftChars.length; i += 1) {
    for (let j = 1; j <= rightChars.length; j += 1) {
      const cost = leftChars[i - 1] === rightChars[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }
  return dp[leftChars.length][rightChars.length]
}

function similarity(left, right) {
  const maxLength = Math.max(charsOf(left).length, charsOf(right).length)
  if (!maxLength) return 1
  return 1 - editDistance(left, right) / maxLength
}

function hasUsefulPinyin(value) {
  return charsOf(value).some((char) => PINYIN_MAP[char])
}

function differingCharsHavePinyin(left, right) {
  const leftChars = charsOf(left)
  const rightChars = charsOf(right)
  if (leftChars.length !== rightChars.length) return false
  return leftChars.every((char, index) => {
    if (char === rightChars[index]) return true
    return Boolean(PINYIN_MAP[char] && PINYIN_MAP[rightChars[index]])
  })
}

function correctionScore(windowText, target) {
  if (windowText === target) return 0
  if (!hasChinese(windowText) || !hasChinese(target)) return false

  const windowChars = charsOf(windowText)
  const targetChars = charsOf(target)
  if (windowChars.length !== targetChars.length || targetChars.length < 2 || targetChars.length > 8) {
    return 0
  }

  const sameRatio = samePositionRatio(windowText, target)
  const distance = editDistance(windowText, target)
  const pinyinText = pinyinOf(windowText).join('|')
  const targetPinyin = pinyinOf(target).join('|')
  const pinyinSimilarity = similarity(pinyinText, targetPinyin)
  const initialsSimilarity = similarity(initialsOf(windowText), initialsOf(target))
  const hasPinyinSignal = hasUsefulPinyin(windowText) && hasUsefulPinyin(target)
  const mappedDifferences = differingCharsHavePinyin(windowText, target)

  if (hasPinyinSignal && mappedDifferences && pinyinText === targetPinyin && sameRatio >= 0.5) return 0.95 + sameRatio * 0.04
  if (hasPinyinSignal && mappedDifferences && targetChars.length >= 3 && pinyinSimilarity >= 0.9 && sameRatio >= 0.45) {
    return 0.86 + pinyinSimilarity * 0.08 + sameRatio * 0.04
  }
  if (hasPinyinSignal && mappedDifferences && targetChars.length >= 4 && initialsSimilarity >= 0.95 && sameRatio >= 0.5) {
    return 0.82 + initialsSimilarity * 0.1 + sameRatio * 0.04
  }
  if (targetChars.length >= 4 && distance === 1 && sameRatio >= 0.65) return 0.72 + sameRatio * 0.12
  return 0
}

function shouldCorrectTo(windowText, target) {
  return correctionScore(windowText, target) >= 0.8
}

function termsByLength(terms) {
  return terms.reduce((result, term) => {
    const length = charsOf(term).length
    if (!result[length]) result[length] = []
    result[length].push(term)
    return result
  }, {})
}

function bestCorrectionForWindow(windowText, terms, vocabularySet) {
  if (vocabularySet.has(windowText)) return ''
  const scored = (terms || [])
    .filter((term) => term !== windowText)
    .filter((term) => !protectedTermsChanged(windowText, term))
    .map((term) => ({ term, score: correctionScore(windowText, term) }))
    .filter((item) => item.score >= 0.8)
    .sort((left, right) => right.score - left.score)

  if (!scored.length) return ''
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.06) return ''
  return scored[0].term
}

function protectedTermsChanged(windowText, target) {
  const protectedTerms = PROTECTED_ASR_TERMS.filter((term) => windowText.indexOf(term) !== -1)
  if (!protectedTerms.length) return false
  return protectedTerms.some((term) => target.indexOf(term) === -1)
}

function replaceSimilarWindows(value, terms, vocabularySet) {
  const chars = charsOf(value)
  const termLength = charsOf((terms || [])[0] || '').length
  if (termLength < 2 || termLength > chars.length) return value

  for (let index = 0; index <= chars.length - termLength; index += 1) {
    const windowText = chars.slice(index, index + termLength).join('')
    const correction = bestCorrectionForWindow(windowText, terms, vocabularySet)
    if (!correction) continue
    chars.splice(index, termLength, ...charsOf(correction))
    index += termLength - 1
  }
  return chars.join('')
}

function normalizeByVocabulary(value, vocabulary = []) {
  const terms = unique(vocabulary)
    .map(compactText)
    .filter((item) => charsOf(item).length >= 2)
    .sort((left, right) => charsOf(right).length - charsOf(left).length)

  const groupedTerms = termsByLength(terms)
  const vocabularySet = new Set(terms)
  return Object.keys(groupedTerms)
    .map(Number)
    .sort((left, right) => right - left)
    .reduce((text, length) => replaceSimilarWindows(text, groupedTerms[length], vocabularySet), String(value || ''))
}

function normalizeAsrText(value, options = {}) {
  const vocabulary = unique(DEFAULT_ASR_VOCABULARY.concat(options.vocabulary || []))
  const text = normalizeByVocabulary(String(value || ''), vocabulary)
  return SPOKEN_SYNONYM_REPLACEMENTS.reduce((result, rule) => result.replace(rule[0], rule[1]), text)
}

module.exports = {
  DEFAULT_ASR_VOCABULARY,
  normalizeAsrText,
  normalizeByVocabulary,
  _internal: {
    PINYIN_MAP,
    correctionScore,
    differingCharsHavePinyin,
    shouldCorrectTo,
    protectedTermsChanged
  }
}
