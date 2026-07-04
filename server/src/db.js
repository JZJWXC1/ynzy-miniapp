const fs = require('fs')
const path = require('path')
const config = require('./config')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function ensureDataFile() {
  const dir = path.dirname(config.dataFile)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(config.dataFile)) {
    fs.writeFileSync(config.dataFile, '{}', 'utf8')
  }
}

// \u89E3\u6790\u7F13\u5B58\uFF1A\u4EE5\u6587\u4EF6 mtimeMs+size \u4F5C\u4E3A\u7248\u672C\u952E\u3002\u547D\u4E2D\u5373\u590D\u7528\u4E0A\u6B21\u89E3\u6790\u51FA\u7684\u5BF9\u8C61\uFF0C
// \u8DF3\u8FC7 readFileSync + JSON.parse\uFF1B\u6587\u4EF6\u88AB\u5199\u6539\u540E stat \u53D8\u5316\uFF0C\u7F13\u5B58\u81EA\u52A8\u5931\u6548\u3002
// \u8FD9\u6837\u65E2\u6D88\u9664\u201C\u6BCF\u8BF7\u6C42\u5168\u91CF\u89E3\u6790\u201D\u4E0E\u5199\u63A5\u53E3\u201C\u540C\u8BF7\u6C42\u53CC\u91CD\u89E3\u6790\u201D\uFF0C\u53C8\u5929\u7136\u6B63\u786E\u5904\u7406\u5E76\u53D1\u5199\u2014\u2014
// \u957F await \u671F\u95F4\u82E5\u522B\u7684\u8BF7\u6C42\u5199\u76D8\uFF0Cmtime \u53D8\u5316\u4F1A\u5F3A\u5236\u4E0B\u4E00\u6B21 readDb \u91CD\u65B0\u89E3\u6790\u62FF\u5230\u6700\u65B0\u6570\u636E\u3002
let parseCache = null

function statKey() {
  try {
    const stat = fs.statSync(config.dataFile)
    return `${stat.mtimeMs}:${stat.size}`
  } catch (error) {
    return null
  }
}

function readDb() {
  ensureDataFile()
  const key = statKey()
  if (parseCache && key && parseCache.key === key) {
    return parseCache.db
  }
  const content = fs.readFileSync(config.dataFile, 'utf8').replace(/^\uFEFF/, '')
  const db = content.trim() ? JSON.parse(content) : {}
  if (key) parseCache = { key, db }
  return db
}

// 默认紧凑序列化：两空格 pretty-print 会使 db.json 膨胀近 2 倍，放大每次整库重写的
// 磁盘写入量（足迹等高频只增留痕尤其明显）。需要人读时用 DB_JSON_PRETTY=1 恢复缩进。
function serializeDb(db) {
  return config.dbPrettyJson ? JSON.stringify(db, null, 2) : JSON.stringify(db)
}

function writeDb(db) {
  ensureDataFile()
  const tempFile = `${config.dataFile}.${process.pid}.tmp`
  fs.writeFileSync(tempFile, serializeDb(db), 'utf8')
  fs.renameSync(tempFile, config.dataFile)
  // \u521A\u5199\u5165\u7684\u5BF9\u8C61\u5373\u6700\u65B0\u72B6\u6001\uFF0C\u7ED1\u5B9A\u65B0 stat \u4F5C\u4E3A\u7F13\u5B58\uFF0C\u8BA9\u7D27\u968F\u5176\u540E\u7684 readDb \u76F4\u63A5\u547D\u4E2D\u3002
  const key = statKey()
  parseCache = key ? { key, db } : null
}

function updateDb(mutator) {
  const db = readDb()
  try {
    const result = mutator(db)
    writeDb(db)
    return result
  } catch (error) {
    // mutator \u53EF\u80FD\u5DF2\u5C31\u5730\u6539\u52A8\u7F13\u5B58\u5BF9\u8C61\uFF0C\u4F46\u78C1\u76D8\u672A\u5199\u5165\uFF1B\u5931\u6548\u7F13\u5B58\uFF0C\u8BA9\u4E0B\u4E00\u6B21 readDb
    // \u4ECE\u78C1\u76D8\u91CD\u65B0\u89E3\u6790\u51FA\u672A\u88AB\u6C61\u67D3\u7684\u72B6\u6001\uFF0C\u4FDD\u6301\u201C\u629B\u5F02\u5E38\u5373\u56DE\u6EDA\u201D\u8BED\u4E49\u3002
    parseCache = null
    throw error
  }
}

function isIdObjectArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (item) => item && typeof item === 'object' && !Array.isArray(item) &&
      Object.prototype.hasOwnProperty.call(item, 'id')
  )
}

// \u5E26 id \u7684\u5BF9\u8C61\u6570\u7EC4\u4E09\u65B9\u6309\u5143\u7D20\u5408\u5E76\uFF1Abase=\u540C\u6B65\u524D\u57FA\u7EBF\uFF0Cmutated=\u540C\u6B65\u79C1\u6709\u526F\u672C\uFF0Cfresh=\u843D\u76D8\u65F6\u6700\u65B0\u5E93\u3002
// \u4EE5 fresh\uFF08\u542B await \u7A97\u53E3\u5185\u5E76\u53D1\u5199\uFF09\u4E3A\u5E95\uFF0C\u53EA\u5957\u7528 sync \u771F\u6B63\u6539\u52A8/\u65B0\u589E/\u5220\u9664\u7684\u5143\u7D20\uFF1A
// - sync \u6539\u4E86\u67D0 id\uFF08mutated \u8BE5\u5143\u7D20 !== base\uFF09\u2192 \u7528 sync \u7248\u672C\uFF1B
// - sync \u6CA1\u78B0\u67D0 id\uFF08mutated===base\uFF09\u2192 \u4FDD\u7559 fresh \u7248\u672C\uFF08\u4FDD\u4F4F\u5E76\u53D1\u5BF9\u8BE5\u5143\u7D20\u7684\u6539\u52A8\uFF09\uFF1B
// - sync \u5220\u4E86\u67D0 id\uFF08base \u6709\u3001mutated \u65E0\uFF09\u2192 \u4ECE\u7ED3\u679C\u5254\u9664\uFF1B
// - sync \u65B0\u589E\u67D0 id\uFF08mutated \u6709\u3001base \u65E0\uFF09\u2192 \u524D\u63D2\uFF08\u8D34\u5408 footprints/\u65E5\u5FD7 unshift \u7684\u201C\u65B0\u7684\u5728\u524D\u201D\uFF09\uFF1B
// - fresh \u5E76\u53D1\u65B0\u589E\uFF08base/mutated \u90FD\u65E0\uFF09\u2192 \u4FDD\u7559\u3002
function mergeById(base, mutated, fresh) {
  const baseById = new Map(base.map((item) => [item.id, item]))
  const mutatedById = new Map(mutated.map((item) => [item.id, item]))
  const kept = []
  const seen = new Set()
  for (const item of fresh) {
    if (!item || item.id == null) { kept.push(item); continue } // \u5F02\u5E38\u5143\u7D20\u539F\u6837\u4FDD\u7559
    seen.add(item.id)
    const inBase = baseById.has(item.id)
    const inMutated = mutatedById.has(item.id)
    if (inBase && !inMutated) continue // sync \u5220\u9664\u4E86\u8BE5\u5143\u7D20
    if (inMutated && JSON.stringify(baseById.get(item.id)) !== JSON.stringify(mutatedById.get(item.id))) {
      kept.push(mutatedById.get(item.id)) // sync \u6539\u52A8\u4E86\u8BE5 id
    } else {
      kept.push(item) // sync \u672A\u6539\uFF08\u6216 fresh \u5E76\u53D1\u65B0\u589E\uFF09\u2192 \u4FDD\u7559 fresh
    }
  }
  const additions = mutated.filter((item) => !seen.has(item.id) && !baseById.has(item.id))
  return additions.concat(kept)
}

// \u589E\u91CF\u5408\u5E76\u56DE\u5199\uFF1A\u7528\u4E8E\u98DE\u4E66\u540C\u6B65\u8FD9\u7C7B\u300Cclone \u79C1\u6709\u526F\u672C \u2192 \u957F await \u2192 \u843D\u76D8\u300D\u7684\u8DEF\u5F84\u3002base \u662F\u540C\u6B65\u5F00\u59CB\u524D\u7684
// \u4E0D\u53EF\u53D8\u57FA\u7EBF\u5FEB\u7167\uFF0Cmutated \u662F\u540C\u6B65\u8DD1\u5B8C\u7684\u79C1\u6709\u526F\u672C\u3002\u76F4\u63A5 writeDb(mutated) \u4F1A\u7528\u540C\u6B65\u5F00\u59CB\u65F6\u7684\u6574\u5E93\u5FEB\u7167
// \u8986\u76D6\u78C1\u76D8\uFF0C\u62B9\u6389 await \u7A97\u53E3\u5185\u5E76\u53D1 updateDb \u843D\u76D8\u7684\u5199\u5165\u3002\u6539\u4E3A\u5728 updateDb \u91CC\u91CD\u8BFB\u6700\u65B0\u5E93\uFF0C\u53EA\u628A mutated
// \u76F8\u5BF9 base \u771F\u6B63\u6539\u52A8\u8FC7\u7684\u90E8\u5206\u5AC1\u63A5\u8FC7\u53BB\uFF1A\u9876\u5C42\u952E\u82E5\u662F\u5E26 id \u7684\u5BF9\u8C61\u6570\u7EC4\uFF08listings/footprints/\u65E5\u5FD7\u7B49\uFF09\uFF0C
// \u6309\u5143\u7D20\u7EA7\u4E09\u65B9\u5408\u5E76\uFF0C\u53EA\u8986\u76D6 sync \u52A8\u8FC7\u7684\u5143\u7D20\u3001\u4FDD\u7559 fresh \u91CC sync \u6CA1\u78B0\u7684\u5143\u7D20\uFF08\u5E76\u53D1\u5199\uFF09\uFF1B\u5176\u4F59\u952E\u505A\u6574\u952E
// \u589E\u91CF\uFF08sync \u6539\u8FC7\u5219\u8986\u76D6\u3001\u672A\u6539\u5219\u4FDD\u7559\u5E76\u53D1\u5199\uFF09\u3002\u8FD9\u6837\u540C\u6B65\u5BF9\u81EA\u5DF1\u623F\u6E90\u7684\u6539\u52A8\u7167\u5E38\u843D\u5730\uFF0C\u800C\u7A97\u53E3\u5185\u5E76\u53D1\u7684\u6210\u4EA4
// \u786E\u8BA4/\u8DB3\u8FF9/\u7F16\u8F91\u4E0D\u518D\u56E0\u201C\u540C\u6B65\u78B0\u4E86\u540C\u4E00\u4E2A\u9876\u5C42\u6570\u7EC4\u201D\u88AB\u6574\u5757\u56DE\u6EDA\u3002sync \u6570\u636E\u6C38\u4E0D\u4E22\u5931\uFF08\u5B83\u52A8\u8FC7\u7684\u5143\u7D20\u603B\u662F\u80DC\u51FA\uFF09\u3002
function commitDelta(base, mutated) {
  const safeBase = base || {}
  const safeMutated = mutated || {}
  return updateDb((freshDb) => {
    const keys = new Set([...Object.keys(safeBase), ...Object.keys(safeMutated)])
    for (const key of keys) {
      const hasNext = Object.prototype.hasOwnProperty.call(safeMutated, key)
      const before = JSON.stringify(safeBase[key])
      const after = hasNext ? JSON.stringify(safeMutated[key]) : undefined
      if (before === after) continue // \u540C\u6B65\u672A\u6539\u8BE5\u952E\uFF0C\u4FDD\u7559 freshDb \u4E2D\u7684\u5E76\u53D1\u5199
      if (!hasNext) { delete freshDb[key]; continue } // \u540C\u6B65\u5220\u9664\u4E86\u8BE5\u9876\u5C42\u952E
      if (isIdObjectArray(safeBase[key]) && isIdObjectArray(safeMutated[key])) {
        const freshArr = Array.isArray(freshDb[key]) ? freshDb[key] : []
        freshDb[key] = mergeById(safeBase[key], safeMutated[key], freshArr)
      } else {
        freshDb[key] = safeMutated[key] // \u975E id \u5BF9\u8C61\u6570\u7EC4\uFF1A\u6574\u952E\u8986\u76D6\uFF08\u4E0E\u65E7\u884C\u4E3A\u4E00\u81F4\uFF09
      }
    }
    return freshDb
  })
}

module.exports = {
  clone,
  readDb,
  writeDb,
  updateDb,
  commitDelta
}
