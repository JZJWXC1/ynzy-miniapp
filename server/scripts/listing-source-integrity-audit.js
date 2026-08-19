const fs = require('fs')
const config = require('../src/config')
const domain = require('../src/domain')

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

function isExplicitFalseCompanyFlag(value) {
  if (value === undefined || value === null) return false
  if (value === '') return false
  return !domain.isCompanyListing({ companyListing: value })
}

function hasExplicitFalseCompanyFlag(listing = {}) {
  return (
    hasOwn(listing, 'companyListing') && isExplicitFalseCompanyFlag(listing.companyListing)
  ) || (
    hasOwn(listing, 'isCompanyListing') && isExplicitFalseCompanyFlag(listing.isCompanyListing)
  )
}

function hasCanonicalCompanySource(listing = {}) {
  const sourceText = [
    listing.source,
    listing.sourceType,
    listing.listingType,
    listing.inventoryType
  ].map((item) => String(item || '')).join(' ')
  return /公司房源|company/i.test(sourceText)
}

function isAmbiguousFalseFlagCompanySource(listing = {}) {
  return hasExplicitFalseCompanyFlag(listing) &&
    hasCanonicalCompanySource(listing)
}

function sourceIntegritySummary(db = {}) {
  if (!Array.isArray(db.listings)) {
    throw new TypeError('listings 必须为数组')
  }
  const listings = db.listings
  return {
    totalListings: listings.length,
    ambiguousFalseFlagCompanySource: listings.filter(isAmbiguousFalseFlagCompanySource).length
  }
}

function requestedDbPath(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--db')
  if (index === -1 || !argv[index + 1]) return config.dataFile
  return argv[index + 1]
}

function auditFile(dbPath) {
  const emptySummary = {
    totalListings: 0,
    ambiguousFalseFlagCompanySource: 0
  }
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      dataFileFound: false,
      readable: false,
      parseable: false,
      structureValid: false,
      errorCode: 'FILE_NOT_FOUND',
      ...emptySummary
    }
  }

  let text
  try {
    text = fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '')
  } catch (_error) {
    return {
      ok: false,
      dataFileFound: true,
      readable: false,
      parseable: false,
      structureValid: false,
      errorCode: 'READ_ERROR',
      ...emptySummary
    }
  }

  if (!text.trim()) {
    return {
      ok: false,
      dataFileFound: true,
      readable: true,
      parseable: false,
      structureValid: false,
      errorCode: 'EMPTY_FILE',
      ...emptySummary
    }
  }

  let db
  try {
    db = JSON.parse(text)
  } catch (_error) {
    return {
      ok: false,
      dataFileFound: true,
      readable: true,
      parseable: false,
      structureValid: false,
      errorCode: 'INVALID_JSON',
      ...emptySummary
    }
  }

  if (!db || !Array.isArray(db.listings)) {
    return {
      ok: false,
      dataFileFound: true,
      readable: true,
      parseable: true,
      structureValid: false,
      errorCode: 'INVALID_LISTINGS',
      ...emptySummary
    }
  }

  const summary = sourceIntegritySummary(db)
  return {
    ok: summary.ambiguousFalseFlagCompanySource === 0,
    dataFileFound: true,
    readable: true,
    parseable: true,
    structureValid: true,
    errorCode: '',
    ...summary
  }
}

function main() {
  const result = auditFile(requestedDbPath())
  console.log(JSON.stringify(result))
  if (!result.ok) process.exitCode = 2
}

if (require.main === module) main()

module.exports = {
  isExplicitFalseCompanyFlag,
  isAmbiguousFalseFlagCompanySource,
  sourceIntegritySummary,
  auditFile
}
