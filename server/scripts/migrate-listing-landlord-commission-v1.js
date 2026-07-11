const fs = require('fs')
const path = require('path')

const DEFAULT_PERCENT = 50

function readDb(dataFile) {
  if (!dataFile || !fs.existsSync(dataFile)) throw new Error('数据文件不存在')
  const text = fs.readFileSync(dataFile, 'utf8').replace(/^\uFEFF/, '')
  const db = text.trim() ? JSON.parse(text) : {}
  if (!Array.isArray(db.listings)) throw new Error('数据结构异常：listings 必须是数组')
  return db
}

function isMissing(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

function canonicalPercent(value) {
  if (isMissing(value)) return null
  if (typeof value !== 'number' && typeof value !== 'string') return Number.NaN
  const text = String(value).trim()
  if (typeof value === 'string' && !/^\d+$/.test(text)) return Number.NaN
  const number = Number(text)
  return Number.isInteger(number) && number >= 0 && number <= 100 ? number : Number.NaN
}

function inspectListings(listings) {
  let missing = 0
  let normalized = 0
  const invalidIds = []
  listings.forEach((listing, index) => {
    if (!listing || typeof listing !== 'object' || Array.isArray(listing)) {
      invalidIds.push(`index-${index}`)
      return
    }
    const raw = listing && listing.landlordCommissionPercent
    const value = canonicalPercent(raw)
    if (value === null) {
      missing += 1
      return
    }
    if (!Number.isFinite(value)) {
      invalidIds.push(String((listing && listing.id) || `index-${index}`))
      return
    }
    if (typeof raw !== 'number' || raw !== value) normalized += 1
  })
  return { missing, normalized, invalidIds }
}

function atomicWriteJson(dataFile, db) {
  const tempFile = `${dataFile}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tempFile, JSON.stringify(db), 'utf8')
  try {
    let lastError = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        fs.renameSync(tempFile, dataFile)
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
    if (lastError) throw lastError
  } finally {
    if (fs.existsSync(tempFile)) fs.rmSync(tempFile, { force: true })
  }
}

function backupName(dataFile, now) {
  const stamp = String(now || new Date().toISOString()).replace(/[^0-9]/g, '').slice(0, 14)
  return `${dataFile}.bak-landlord-commission-${stamp || Date.now()}`
}

function migrateFile(options = {}) {
  const dataFile = path.resolve(String(options.dataFile || ''))
  const apply = options.apply === true
  const db = readDb(dataFile)
  const listings = db.listings
  const before = inspectListings(listings)
  if (before.invalidIds.length) {
    throw new Error(`存在非法 landlordCommissionPercent：${before.invalidIds.length} 条，请先人工核对`)
  }
  const currentCovered = listings.length - before.missing
  if (!apply) {
    return {
      mode: 'dry-run',
      total: listings.length,
      missing: before.missing,
      normalized: before.normalized,
      changed: 0,
      wouldChange: before.missing + before.normalized,
      coverage: listings.length ? Math.round(currentCovered * 10000 / listings.length) / 100 : 100,
      backupFile: ''
    }
  }

  const changeCount = before.missing + before.normalized
  if (!changeCount) {
    return { mode: 'apply', total: listings.length, missing: 0, normalized: 0, changed: 0, coverage: 100, backupFile: '' }
  }

  const backupFile = backupName(dataFile, options.now)
  fs.copyFileSync(dataFile, backupFile, fs.constants.COPYFILE_EXCL)
  listings.forEach((listing) => {
    const current = canonicalPercent(listing.landlordCommissionPercent)
    listing.landlordCommissionPercent = current === null ? DEFAULT_PERCENT : current
  })
  atomicWriteJson(dataFile, db)

  const verified = readDb(dataFile)
  const after = inspectListings(verified.listings)
  if (verified.listings.length !== listings.length || after.missing || after.normalized || after.invalidIds.length) {
    fs.copyFileSync(backupFile, dataFile)
    throw new Error('迁移后校验失败，已自动恢复迁移前备份')
  }
  return {
    mode: 'apply',
    total: verified.listings.length,
    missing: before.missing,
    normalized: before.normalized,
    changed: changeCount,
    coverage: 100,
    backupFile
  }
}

function rollbackFile(options = {}) {
  const dataFile = path.resolve(String(options.dataFile || ''))
  const backupFile = path.resolve(String(options.backupFile || ''))
  if (!fs.existsSync(backupFile)) throw new Error('回滚备份不存在')
  const backupDb = readDb(backupFile)
  const safetyBackup = `${dataFile}.bak-before-rollback-${Date.now()}`
  if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, safetyBackup, fs.constants.COPYFILE_EXCL)
  const tempFile = `${dataFile}.rollback-${process.pid}-${Date.now()}`
  fs.copyFileSync(backupFile, tempFile)
  fs.renameSync(tempFile, dataFile)
  const restored = readDb(dataFile)
  return { mode: 'rollback', total: restored.listings.length, safetyBackupFile: safetyBackup, sourceTotal: backupDb.listings.length }
}

function argValue(args, name) {
  const inline = args.find((item) => item.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function runCli() {
  const args = process.argv.slice(2)
  const config = require('../src/config')
  const dataFile = argValue(args, '--data-file') || config.dataFile
  const rollback = argValue(args, '--rollback')
  const result = rollback
    ? rollbackFile({ dataFile, backupFile: rollback })
    : migrateFile({ dataFile, apply: args.includes('--apply') })
  const output = {
    mode: result.mode,
    total: result.total,
    missing: result.missing || 0,
    normalized: result.normalized || 0,
    changed: result.changed || 0,
    wouldChange: result.wouldChange || 0,
    coverage: result.coverage === undefined ? null : result.coverage,
    backup: result.backupFile ? path.basename(result.backupFile) : ''
  }
  console.log(JSON.stringify(output))
}

if (require.main === module) {
  try {
    runCli()
  } catch (error) {
    console.error(`迁移失败：${error.message}`)
    process.exit(1)
  }
}

module.exports = {
  migrateFile,
  rollbackFile,
  inspectListings
}
