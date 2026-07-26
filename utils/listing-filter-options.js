'use strict'

const DEFAULT_LAYOUT_OPTIONS = Object.freeze(['不限', '一室', '两室', '三室', '三室以上'])
const DEFAULT_RENT_MODE_OPTIONS = Object.freeze(['全部', '整租', '合租'])

function cleanText(value) {
  return String(value || '').trim()
}

function uniqueText(values) {
  const seen = new Set()
  return (values || []).map(cleanText).filter((value) => {
    if (!value || seen.has(value)) return false
    seen.add(value)
    return true
  })
}

function normalizeRegionOptions(value) {
  if (!Array.isArray(value)) return []
  const byDistrict = new Map()
  value.forEach((item) => {
    const name = cleanText(item && (item.name || item.district || item.area))
    if (!name) return
    if (!byDistrict.has(name)) byDistrict.set(name, [])
    byDistrict.set(name, uniqueText(byDistrict.get(name).concat(item.blocks || item.blockOptions || [])))
  })
  return Array.from(byDistrict.entries())
    .map(([name, blocks]) => ({ name, blocks: blocks.sort() }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

function normalizeListingFilterOptions(payload = {}) {
  const layoutOptions = uniqueText(payload.layoutOptions)
  const rentModeOptions = uniqueText(payload.rentModeOptions)
  return {
    regionOptions: normalizeRegionOptions(payload.regionOptions || payload.regions),
    layoutOptions: layoutOptions.length ? layoutOptions : DEFAULT_LAYOUT_OPTIONS.slice(),
    rentModeOptions: rentModeOptions.length ? rentModeOptions : DEFAULT_RENT_MODE_OPTIONS.slice()
  }
}

function listingFilterOptionsFromListings(listings = {}) {
  const byDistrict = new Map()
  ;(Array.isArray(listings) ? listings : []).forEach((item) => {
    const district = cleanText(item && (item.district || item.area))
    const block = cleanText(item && item.block)
    if (!district) return
    if (!byDistrict.has(district)) byDistrict.set(district, [])
    if (block) byDistrict.set(district, uniqueText(byDistrict.get(district).concat(block)))
  })
  return normalizeListingFilterOptions({
    regionOptions: Array.from(byDistrict.entries()).map(([name, blocks]) => ({ name, blocks }))
  })
}

function mergeListingFilterOptions(basePayload = {}, extraPayload = {}) {
  const base = normalizeListingFilterOptions(basePayload)
  const extra = normalizeListingFilterOptions(extraPayload)
  return normalizeListingFilterOptions({
    regionOptions: base.regionOptions.concat(extra.regionOptions),
    layoutOptions: uniqueText(base.layoutOptions.concat(extra.layoutOptions)),
    rentModeOptions: uniqueText(base.rentModeOptions.concat(extra.rentModeOptions))
  })
}

function blocksForDistrict(regionOptions = [], district = '') {
  const selected = cleanText(district)
  const rows = normalizeRegionOptions(regionOptions)
  if (selected) {
    const matched = rows.find((item) => item.name === selected)
    return matched ? matched.blocks.slice() : []
  }
  return uniqueText(rows.flatMap((item) => item.blocks))
}

module.exports = {
  DEFAULT_LAYOUT_OPTIONS,
  DEFAULT_RENT_MODE_OPTIONS,
  normalizeListingFilterOptions,
  normalizeRegionOptions,
  listingFilterOptionsFromListings,
  mergeListingFilterOptions,
  blocksForDistrict
}
