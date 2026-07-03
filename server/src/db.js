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

function readDb() {
  ensureDataFile()
  const content = fs.readFileSync(config.dataFile, 'utf8').replace(/^\uFEFF/, '')
  return content.trim() ? JSON.parse(content) : {}
}

function writeDb(db) {
  ensureDataFile()
  const tempFile = `${config.dataFile}.${process.pid}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8')
  fs.renameSync(tempFile, config.dataFile)
}

function updateDb(mutator) {
  const db = readDb()
  const result = mutator(db)
  writeDb(db)
  return result
}

async function updateDbAsync(mutator) {
  const db = readDb()
  const result = await mutator(db)
  writeDb(db)
  return result
}

module.exports = {
  clone,
  readDb,
  writeDb,
  updateDb,
  updateDbAsync
}
