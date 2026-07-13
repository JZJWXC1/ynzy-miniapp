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
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      dataFileFound: false,
      readable: false,
      totalListings: 0,
      ambiguousFalseFlagCompanySource: 0
    }
  }
  try {
    const text = fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '')
    const db = text.trim() ? JSON.parse(text) : {}
    const summary = sourceIntegritySummary(db)
    return {
      ok: summary.ambiguousFalseFlagCompanySource === 0,
      dataFileFound: true,
      readable: true,
      ...summary
    }
  } catch (error) {
    return {
      ok: false,
      dataFileFound: true,
      readable: false,
      totalListings: 0,
      ambiguousFalseFlagCompanySource: 0
    }
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
