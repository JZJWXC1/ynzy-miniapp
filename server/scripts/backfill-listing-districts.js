const dbStore = require('../src/db')
const locationMap = require('../src/location-map')

function text(value) {
  return String(value || '').trim()
}

function isCompanyListing(listing = {}) {
  const sourceText = [
    listing.source,
    listing.sourceType,
    listing.listingType,
    listing.inventoryType,
    listing.ownerType,
    listing.houseSourceType
  ].map(text).join(' ')
  return Boolean(
    listing.companyListing ||
    listing.isCompanyListing ||
    /公司房源|company/.test(sourceText)
  )
}

function inferDistrict(listing = {}) {
  const block = text(listing.block)
  const current = text(listing.district || listing.area)
  const mapped = locationMap.districtForLocation({
    community: listing.community,
    block: block || current,
    district: current
  })
  if (mapped && mapped !== '待分区') return mapped
  if (isCompanyListing(listing) && block && block !== '待板块') return '拱墅区'
  return mapped || current || '待分区'
}

function inferBlock(listing = {}) {
  return locationMap.blockForLocation({
    community: listing.community,
    block: text(listing.block) || '待板块',
    area: text(listing.area || listing.district)
  })
}

function distribution(listings = []) {
  return listings.reduce((map, listing) => {
    const district = text(listing.district || listing.area) || '待分区'
    map[district] = (map[district] || 0) + 1
    return map
  }, {})
}

function backfill(db = {}) {
  const listings = Array.isArray(db.listings) ? db.listings : []
  let changed = 0
  listings.forEach((listing) => {
    const nextDistrict = inferDistrict(listing)
    const nextBlock = inferBlock(listing)
    if (!nextDistrict) return
    const beforeDistrict = text(listing.district)
    const beforeArea = text(listing.area)
    const beforeBlock = text(listing.block)
    if (beforeDistrict !== nextDistrict) listing.district = nextDistrict
    if (beforeArea !== nextDistrict) listing.area = nextDistrict
    if (nextBlock && beforeBlock !== nextBlock) listing.block = nextBlock
    if (
      beforeDistrict !== text(listing.district) ||
      beforeArea !== text(listing.area) ||
      beforeBlock !== text(listing.block)
    ) changed += 1
  })
  return {
    total: listings.length,
    changed,
    distribution: distribution(listings)
  }
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const db = dbStore.readDb()
  const result = backfill(db)
  if (!dryRun) dbStore.writeDb(db)
  console.log(JSON.stringify({ dryRun, ...result }, null, 2))
}

if (require.main === module) main()

module.exports = {
  backfill,
  inferDistrict
}
