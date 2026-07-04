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

// \u589E\u91CF\u5408\u5E76\u56DE\u5199\uFF1A\u7528\u4E8E\u98DE\u4E66\u540C\u6B65\u8FD9\u7C7B\u300Cclone \u79C1\u6709\u526F\u672C \u2192 \u957F await \u2192 \u843D\u76D8\u300D\u7684\u8DEF\u5F84\u3002base \u662F\u540C\u6B65\u5F00\u59CB\u524D
// \u7684\u4E0D\u53EF\u53D8\u57FA\u7EBF\u5FEB\u7167\uFF0Cmutated \u662F\u540C\u6B65\u8DD1\u5B8C\u7684\u79C1\u6709\u526F\u672C\u3002\u76F4\u63A5 writeDb(mutated) \u4F1A\u7528\u540C\u6B65\u5F00\u59CB\u65F6\u7684\u6574\u5E93
// \u5FEB\u7167\u8986\u76D6\u78C1\u76D8\uFF0C\u62B9\u6389 await \u7A97\u53E3\u5185\u5E76\u53D1 updateDb \u843D\u76D8\u7684\u6210\u4EA4/\u53CD\u9988/\u7559\u75D5\u7B49\u65E0\u5173\u5199\u5165\u3002\u6539\u4E3A\u5728 updateDb
// \u91CC\u91CD\u8BFB\u6700\u65B0\u5E93\uFF0C\u53EA\u628A\u300Cmutated \u76F8\u5BF9 base \u771F\u6B63\u6539\u52A8\u8FC7\u7684\u9876\u5C42\u952E\u300D\u5AC1\u63A5\u8FC7\u53BB\uFF0C\u5176\u4F59\u952E\u4FDD\u7559\u7A97\u53E3\u5185\u7684\u5E76\u53D1\u5199\u3002
// \u6CE8\u610F\uFF1A\u82E5\u540C\u6B65\u4E0E\u5E76\u53D1\u5199\u6539\u7684\u662F\u540C\u4E00\u9876\u5C42\u952E\uFF08\u73B0\u5B9E\u4E2D\u4E3B\u8981\u662F listings\uFF09\uFF0C\u540C\u6B65\u503C\u80DC\u51FA\u2014\u2014\u4E0E\u65E7\u6574\u5E93\u56DE\u5199\u884C\u4E3A
// \u4E00\u81F4\uFF0C\u672A\u65B0\u589E\u56DE\u9000\uFF1B\u771F\u6B63\u88AB\u4FDD\u4F4F\u7684\u662F\u540C\u6B65\u4E0D\u78B0\u7684\u90A3\u4E9B\u952E\u3002
function commitDelta(base, mutated) {
  return updateDb((freshDb) => {
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(mutated || {})])
    for (const key of keys) {
      const hasNext = Object.prototype.hasOwnProperty.call(mutated || {}, key)
      const before = JSON.stringify(base ? base[key] : undefined)
      const after = hasNext ? JSON.stringify(mutated[key]) : undefined
      if (before === after) continue // \u540C\u6B65\u672A\u6539\u8BE5\u952E\uFF0C\u4FDD\u7559 freshDb \u4E2D\u7684\u5E76\u53D1\u5199
      if (hasNext) {
        freshDb[key] = mutated[key]
      } else {
        delete freshDb[key] // \u540C\u6B65\u5220\u9664\u4E86\u8BE5\u9876\u5C42\u952E
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
