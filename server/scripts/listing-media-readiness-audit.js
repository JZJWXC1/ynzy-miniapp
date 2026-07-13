'use strict'

// 发布前只读审计：确认所有前台有效视频都能解析为受控 OSS 对象键。
// 只输出汇总与不可逆短指纹，不输出对象键、URL、文件名、地址或电话。
const crypto = require('crypto')
const fs = require('fs')
const config = require('../src/config')
const domain = require('../src/domain')
const { resolveManagedVideoObjectKey } = require('../src/public-listing-media')
const oss = require('../src/oss')

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12)
}

function main() {
  if (!fs.existsSync(config.dataFile)) {
    console.error('LISTING_MEDIA_AUDIT BLOCKED: DATA_FILE 不存在')
    process.exit(2)
  }
  const db = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'))
  const snapshot = JSON.parse(JSON.stringify(db))
  const publicIds = new Set(domain.filterListings(snapshot).map((item) => String(item.id || '')))
  const candidates = (db.listings || []).filter((listing) => publicIds.has(String(listing.id || '')))
  const withVideo = candidates.filter((listing) => /\.(mp4|mov|m4v|webm)(?:\?|#|$)/i.test(`${listing.videoKey || ''} ${listing.videoUrl || ''}`))
  const sourceOptions = {
    uploadDir: config.oss.uploadDir,
    allowedOrigins: oss.readSourceOrigins()
  }
  const unresolved = withVideo.filter((listing) => !resolveManagedVideoObjectKey(listing, sourceOptions))
  const summary = {
    frontendEffective: candidates.length,
    withVideo: withVideo.length,
    resolvable: withVideo.length - unresolved.length,
    unresolved: unresolved.length,
    unresolvedFingerprints: unresolved.slice(0, 20).map((listing) => fingerprint(listing.id))
  }
  console.log(JSON.stringify(summary))
  if (unresolved.length) {
    console.error('LISTING_MEDIA_AUDIT FAIL: 存在无法通过受控代理读取的前台视频，禁止发布')
    process.exit(2)
  }
  console.log('LISTING_MEDIA_AUDIT PASS')
}

try {
  main()
} catch (error) {
  console.error(`LISTING_MEDIA_AUDIT ERROR: ${String(error && error.message || error).replace(/\s+/g, '_').slice(0, 120)}`)
  process.exit(2)
}
