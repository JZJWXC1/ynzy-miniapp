const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const hiddenV1EntryKeywords = ['房源群', '积分', '充值', '换群', '微信支付']

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath)
}

function readText(relativePath) {
  return fs.readFileSync(repoPath(relativePath), 'utf8')
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message)
}

function includesAny(text, fragments) {
  return fragments.some((fragment) => text.includes(fragment))
}

function sliceBetween(text, startPattern, endPattern) {
  const startMatch = text.match(startPattern)
  if (!startMatch || startMatch.index === undefined) return ''
  const start = startMatch.index
  const rest = text.slice(start + startMatch[0].length)
  const endMatch = rest.match(endPattern)
  return text.slice(start, endMatch && endMatch.index !== undefined ? start + startMatch[0].length + endMatch.index : text.length)
}

function checkDemandOrderContract() {
  const indexSource = readText('server/src/index.js')
  const domainSource = readText('server/src/domain.js')
  const hasNeedRoute = /\/mini\/(?:needs|rental-needs|demands|need-orders|demand-orders)\b/.test(indexSource)
  const hasNeedHandler = /(createRentalNeed|createNeedOrder|createDemand|createNeed|rentalNeeds|needOrders|demandOrders)/.test(indexSource)
  const domainFragments = ['function createRentalNeed', 'function createNeedOrder', 'function createDemand', 'function createNeed', 'rentalNeeds', 'needOrders', 'demandOrders']
  assertOk(hasNeedRoute && hasNeedHandler, '缺少需求单接口入口，例如 /mini/needs 或 /mini/rental-needs')
  assertOk(includesAny(domainSource, domainFragments), '缺少需求单领域函数或数据结构')
  return '需求单接口和领域函数已出现'
}

function checkSensitiveViewNeedBinding() {
  const indexSource = readText('server/src/index.js')
  const domainSource = readText('server/src/domain.js')
  const mapSource = readText('pages/map/map.js')
  const listingsSource = readText('pages/listings/listings.js')
  const detailSource = readText('pages/listing-detail/listing-detail.js')
  const sensitiveHandler = sliceBetween(indexSource, /const sensitiveMatch[\s\S]*?if \(method === 'POST' && sensitiveMatch\) \{/, /const error = new Error/)
  const addSensitiveBlock = sliceBetween(domainSource, /function addSensitiveFootprint\b/, /function rechargePoints\b/)
  const sensitiveGuardBlock = sliceBetween(domainSource, /function assertSensitiveViewAllowed\b/, /function listingDisplayFields\b/)
  const adminLogsBlock = sliceBetween(domainSource, /function adminLogs\b/, /function adminReportRows\b/)
  const reportBlock = sliceBetween(domainSource, /function createClientReport\b/, /function createDealFromReport\b/)
  assertOk(
    /needId/.test(sensitiveHandler) && /purpose/.test(sensitiveHandler),
    '敏感查看接口应接收并传递 needId / purpose'
  )
  assertOk(
    /needId/.test(addSensitiveBlock) && /purpose/.test(addSensitiveBlock),
    'addSensitiveFootprint 应保存 needId / purpose 到 footprints'
  )
  assertOk(
    /assertUserNeed/.test(sensitiveGuardBlock) && /purpose/.test(sensitiveGuardBlock) && !/category === 'own'[\s\S]{0,120}return/.test(sensitiveGuardBlock),
    '前台敏感查看不能因上传人查看自己房源而豁免 needId / purpose'
  )
  assertOk(
    /needId/.test(adminLogsBlock) && /purpose/.test(adminLogsBlock),
    '后台足迹接口应返回 needId / purpose，页面才可审计追责'
  )
  assertOk(
    /needId/.test(mapSource) && /listing-detail\/listing-detail\?id=\$\{id\}\$\{query\}/.test(mapSource),
    '地图进入房源详情必须继续携带 needId'
  )
  assertOk(
    /needId/.test(listingsSource) && /source=listings/.test(listingsSource),
    '列表进入房源详情必须继续携带 needId'
  )
  assertOk(
    /createMinimalNeedForListing/.test(detailSource) && /submitClientReportWithNeed/.test(detailSource),
    '详情页报备缺 needId 时应先创建需求单再报备'
  )
  assertOk(
    /assertUserNeed/.test(reportBlock) && /reportSnapshot/.test(reportBlock),
    '报备接口必须校验 needId 并冻结 reportSnapshot'
  )
  return '敏感查看已绑定 needId / purpose，后台足迹可审计'
}

function checkDealSnapshotUsesDealUploader() {
  const domainSource = readText('server/src/domain.js')
  const confirmDealBlock = sliceBetween(domainSource, /function confirmDeal\b/, /function registerDeal\b/)
  const formatDealBlock = sliceBetween(domainSource, /function formatDealRecord\b/, /function userDealRows\b/)
  const createDealBlock = sliceBetween(domainSource, /function createDealFromReport\b/, /function confirmDeal\b/)
  assertOk(/snapshot|dealSnapshot|listingSnapshot/.test(createDealBlock), '签单记录缺少 snapshot / listingSnapshot 字段')
  assertOk(
    /uploaderId:\s*deal\.uploaderId/.test(confirmDealBlock),
    '确认签单生成分佣时应使用 deal.uploaderId，不能回查 listing.uploaderId 覆盖历史快照'
  )
  assertOk(
    /snapshot|dealSnapshot|listingSnapshot/.test(formatDealBlock),
    '后台签单行应输出 snapshot 摘要所需字段'
  )
  return '签单 snapshot 与 deal.uploaderId 契约已锁定'
}

function checkUploadDedupeExists() {
  const domainSource = readText('server/src/domain.js')
  const mockSource = fs.existsSync(repoPath('utils/mock-data.js')) ? readText('utils/mock-data.js') : ''
  const scripts = fs.readdirSync(repoPath('server/scripts')).filter((name) => name.endsWith('.js'))
  const scriptSource = scripts
    .filter((name) => name !== 'v1-online-gap-audit.js')
    .map((name) => readText(`server/scripts/${name}`))
    .join('\n')
  const hasDedupeFunction = /function\s+\w*(Dedupe|Duplicate|Fingerprint)|const\s+\w*(Dedupe|Duplicate|Fingerprint)|duplicateListing|listingFingerprint|uploadDedupe|dedupeListing|重复房源/i.test(`${domainSource}\n${mockSource}`)
  const hasDedupeTest = /(上传去重|重复房源|duplicate|dedupe|fingerprint)/i.test(scriptSource)
  assertOk(hasDedupeFunction, '缺少上传房源去重函数或唯一指纹逻辑')
  assertOk(hasDedupeTest, '缺少上传去重脚本测试或审计项')
  return '上传去重函数和测试/审计项存在'
}

function checkAdminDashboardFinalTasks() {
  const adminSource = readText('admin-web/index.html')
  const requiredTexts = [
    '待维护房源',
    '即将失效 / 废房源池',
    '待跟进报备',
    '待确认签单',
    '今日敏感查看',
    '待确认预计上传人分佣'
  ]
  const missing = requiredTexts.filter((text) => !adminSource.includes(text))
  assertOk(!missing.length, `后台数据总览缺少今日任务文案：${missing.join('、')}`)
  assertOk(adminSource.includes('needId / snapshot'), '报备/签单表缺少 needId / snapshot 表头')
  assertOk(adminSource.includes('footprintPurposeText') && adminSource.includes('needIdText'), '足迹表缺少 needId / purpose fallback 渲染')
  return '后台今日任务和 needId/snapshot 展示结构存在'
}

function checkDefaultAdminPasswordAudit() {
  const indexSource = readText('server/src/index.js')
  const adminSource = readText('admin-web/index.html')
  assertOk(indexSource.includes("new Set(['admin123', 'manager123'])"), '后端上线检查缺少默认后台密码集合')
  assertOk(indexSource.includes('管理员初始密码') && indexSource.includes('weakAdmins'), '后端上线检查缺少管理员初始密码审计项')
  assertOk(adminSource.includes("['admin123', 'manager123']"), '后台账号管理前端缺少默认密码拦截')
  return '默认后台密码上线检查仍可识别'
}

function checkV1HiddenLegacyEntries() {
  const appSource = readText('app.json')
  const customTabSource = readText('custom-tab-bar/index.js')
  const profileSource = readText('pages/profile/profile.js')
    .replace(/const\s+hiddenV1EntryKeywords\s*=\s*\[[\s\S]*?\]\s*/m, '')
  const adminSource = readText('admin-web/index.html')
  const surfaces = [
    ['app.json', appSource],
    ['custom-tab-bar/index.js', customTabSource],
    ['pages/profile/profile.js 可见工作台', profileSource],
    ['admin-web/index.html 导航', adminSource.match(/<aside class="sidebar">[\s\S]*?<\/aside>/)?.[0] || '']
  ]
  const hits = []
  surfaces.forEach(([name, text]) => {
    hiddenV1EntryKeywords.forEach((keyword) => {
      if (text.includes(keyword)) hits.push(`${name}:${keyword}`)
    })
  })
  assertOk(!hits.length, `第一版可见入口仍出现历史入口关键词：${hits.join('、')}`)
  return '第一版未暴露房源群/积分/充值/换群/微信支付入口'
}

const checks = [
  ['需求单接口/函数存在', checkDemandOrderContract],
  ['敏感查看绑定 needId/purpose', checkSensitiveViewNeedBinding],
  ['签单 snapshot 使用 deal.uploaderId', checkDealSnapshotUsesDealUploader],
  ['上传去重函数/测试存在', checkUploadDedupeExists],
  ['首页今日任务文案/结构存在', checkAdminDashboardFinalTasks],
  ['默认后台密码上线检查仍能识别', checkDefaultAdminPasswordAudit],
  ['历史入口未在第一版可见', checkV1HiddenLegacyEntries]
]

function main() {
  const results = checks.map(([name, check]) => {
    try {
      return { name, ok: true, detail: check() }
    } catch (error) {
      return { name, ok: false, detail: error.message }
    }
  })

  console.log('🙂 V1 上线差距审计')
  results.forEach((result) => {
    console.log(`- ${result.ok ? '通过' : '失败'}：${result.name}（${result.detail}）`)
  })

  const failed = results.filter((result) => !result.ok)
  if (failed.length) {
    console.error(`\n上线差距审计失败：${failed.length} 项未通过`)
    process.exit(1)
  }
  console.log('\n全部上线差距审计项通过。嘻嘻')
}

main()
