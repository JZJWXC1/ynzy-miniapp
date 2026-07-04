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

function writeDb(db) {
  ensureDataFile()
  const tempFile = `${config.dataFile}.${process.pid}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8')
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

module.exports = {
  clone,
  readDb,
  writeDb,
  updateDb
}
