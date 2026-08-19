const fs = require('fs')
const path = require('path')
const config = require('../src/config')
const domain = require('../src/domain')

const COMPANY_SOURCE = '公司房源'
const OUTPUT_FILE = path.resolve(config.rootDir, '..', 'docs', 'company-listings-inventory.md')

const isCompanyListing = domain.isCompanyListing

function readDb() {
  if (!fs.existsSync(config.dataFile)) {
    return { missing: true, db: {} }
  }
  const content = fs.readFileSync(config.dataFile, 'utf8').replace(/^\uFEFF/, '')
  return { missing: false, db: content.trim() ? JSON.parse(content) : {} }
}

function value(...items) {
  const found = items.find((item) => item !== undefined && item !== null && item !== '')
  return found === undefined ? '' : String(found)
}

function yesNo(flag) {
  return flag ? '是' : '否'
}

function statusOf(listing = {}) {
  return value(listing.status, listing.lifecycleStatus, '未知')
}

function coordinateStatus(listing = {}) {
  if (!listing.mapLatitude || !listing.mapLongitude) return '无坐标'
  if (listing.coordinateVerified === false) return '未验证'
  return value(listing.coordinateStatus, listing.coordinateSource, '已记录')
}

function publicRow(listing = {}, index) {
  const profile = listing.recommendationProfile || {}
  return {
    index,
    id: value(listing.id),
    community: value(listing.community, listing.shortTitle, '未填'),
    area: value(listing.area, listing.district, '未填'),
    block: value(listing.block, ''),
    rent: value(listing.rent, listing.price, '未填'),
    layout: value(listing.layout, '未填'),
    rentMode: value(listing.rentMode, listing.type, ''),
    status: statusOf(listing),
    reviewStatus: value(listing.reviewStatus, '无需审核'),
    hasVideo: yesNo(Boolean(listing.videoKey || listing.videoUrl)),
    coordinateStatus: coordinateStatus(listing),
    recommendationReady: profile.ready === undefined ? '未生成' : yesNo(profile.ready),
    recommendationReason: value(profile.unavailableReason, ''),
    source: value(listing.source, listing.sourceLabel, COMPANY_SOURCE),
    updatedAt: value(listing.updatedAt, listing.lastVerifiedAt, listing.createdAt, '')
  }
}

function markdownTable(rows) {
  if (!rows.length) return '当前数据源未发现公司房源。'
  const header = [
    '序号',
    '房源ID',
    '小区',
    '区域',
    '板块',
    '租金',
    '户型',
    '租法',
    '房态',
    '审核',
    '视频',
    '坐标',
    '推荐就绪',
    '不可推荐原因',
    '来源',
    '更新时间'
  ]
  const lines = [
    `| ${header.join(' |')} |`,
    `| ${header.map(() => '---').join(' |')} |`
  ]
  rows.forEach((row) => {
    lines.push(`| ${[
      row.index,
      row.id,
      row.community,
      row.area,
      row.block,
      row.rent,
      row.layout,
      row.rentMode,
      row.status,
      row.reviewStatus,
      row.hasVideo,
      row.coordinateStatus,
      row.recommendationReady,
      row.recommendationReason,
      row.source,
      row.updatedAt
    ].map((item) => String(item || '').replace(/\|/g, '/')).join(' | ')} |`)
  })
  return lines.join('\n')
}

function buildMarkdown(summary) {
  return [
    '# 公司房源清单',
    '',
    `生成时间：${summary.generatedAt}`,
    '',
    '## 数据源',
    '',
    `- 数据文件：\`${summary.dataFile}\``,
    `- 数据文件状态：${summary.dataFileMissing ? '不存在' : '已读取'}`,
    `- 总房源数：${summary.totalListings}`,
    `- 公司房源数：${summary.companyListingCount}`,
    '',
    '## 清单',
    '',
    markdownTable(summary.rows),
    '',
    '## 说明',
    '',
    '- 公司房源判定：`companyListing`、`isCompanyListing`、`companyOwned` 为真，或来源字段包含“公司房源/company”。',
    '- 清单只保留小区、区域、租金、户型、状态、坐标和推荐就绪等公开管理字段。',
    '- 清单不纳入完整地址、楼栋、单元、房号、房东电话、微信号、身份证、视频签名链接等敏感字段。',
    '- 当前若公司房源数为 0，说明本工作树没有可读取的真实运行数据；飞书或后台同步后可重新运行脚本生成。'
  ].join('\n')
}

function main() {
  const { missing, db } = readDb()
  const listings = db.listings || []
  const companyListings = listings.filter(isCompanyListing)
  const rows = companyListings.map((listing, index) => publicRow(listing, index + 1))
  const summary = {
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    dataFile: config.dataFile,
    dataFileMissing: missing,
    totalListings: listings.length,
    companyListingCount: companyListings.length,
    rows
  }
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true })
  fs.writeFileSync(OUTPUT_FILE, buildMarkdown(summary), 'utf8')
  console.log(`company-listings-inventory written: ${OUTPUT_FILE}`)
  console.log(`company listings: ${companyListings.length}/${listings.length}`)
}

if (require.main === module) main()

module.exports = {
  isCompanyListing,
  buildMarkdown
}
