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

function checkSensitiveViewMinimalAudit() {
  const indexSource = readText('server/src/index.js')
  const domainSource = readText('server/src/domain.js')
  const detailSource = readText('pages/listing-detail/listing-detail.js')
  const detailWxml = readText('pages/listing-detail/listing-detail.wxml')
  const sensitiveHandler = sliceBetween(indexSource, /const sensitiveMatch\b/, /const phoneCallOpenedMatch\b/)
  const addSensitiveBlock = sliceBetween(domainSource, /function addSensitiveFootprint\b/, /function hasDialableListingPhone\b/)
  const sensitiveGuardBlock = sliceBetween(domainSource, /function assertSensitiveViewAllowed\b/, /function adminUsers\b/)
  assertOk(
    /idempotencyKey:\s*body\.idempotencyKey/.test(sensitiveHandler),
    '敏感查看路由必须只透传幂等键'
  )
  assertOk(
    !/needId:\s*body|purpose:\s*body|viewerId:\s*body|actionType:\s*body/.test(sensitiveHandler),
    '敏感查看路由不得透传客户端身份、动作、需求或用途'
  )
  assertOk(
    /actionType:\s*'sensitive_view'/.test(addSensitiveBlock) && /pushFootprint\(/.test(addSensitiveBlock),
    '敏感查看动作与写入入口必须由服务端固定'
  )
  assertOk(
    !/assertUserNeed/.test(sensitiveGuardBlock) && !/markMilestone/.test(addSensitiveBlock),
    '敏感查看不得再绑定需求或制造 L1 漏斗里程碑'
  )
  assertOk(
    /sensitiveConfirmVisible/.test(detailSource) && /idempotencyKey/.test(readText('utils/api-service.js')),
    '详情必须保留二次确认且请求仅使用幂等键'
  )
  assertOk(
    !/need-bind-row|purpose-options|sensitivePurpose/.test(detailWxml),
    '详情不得恢复需求绑定或查看用途 UI'
  )
  return '敏感查看仅保留账号、二次确认、额度、服务端六字段留痕，不再绑定需求或用途'
}

function checkReportDealPauseGuard() {
  const configSource = readText('server/src/config.js')
  const indexSource = readText('server/src/index.js')
  const domainSource = readText('server/src/domain.js')
  const adminSource = readText('admin-web/index.html')
  const app = JSON.parse(readText('app.json'))
  assertOk(/REPORT_DEAL_WRITES_ENABLED'[\s\S]{0,40}false/.test(configSource), '报备/签单恢复开关必须默认关闭')
  ;['reportMatch', 'reportDealMatch', 'dealMatch', 'adminDealConfirmMatch'].forEach((routeName) => {
    const block = sliceBetween(indexSource, new RegExp(`if \\(method === 'POST' && ${routeName}\\)`), /\n\s*(?:const|if) /)
    assertOk(/assertReportDealWritesEnabled\(\)/.test(block), `${routeName} 缺少路由层暂停封堵`)
  })
  ;['createClientReport', 'createDealFromReport', 'confirmDeal', 'registerDeal'].forEach((name) => {
    const start = domainSource.indexOf(`function ${name}`)
    assertOk(start >= 0 && /assertReportDealWritesEnabled\(\)/.test(domainSource.slice(start, start + 260)), `${name} 缺少领域层暂停封堵`)
  })
  assertOk(indexSource.includes("pathname === '/mini/reports'") && indexSource.includes("pathname === '/mini/deals'"), '历史中介报备/签单查询必须保留')
  assertOk(indexSource.includes("pathname === '/admin/reports'") && indexSource.includes("pathname === '/admin/deals'"), '历史后台报备/签单查询必须保留')
  assertOk(!app.pages.includes('pages/client-reports/client-reports') && !app.pages.includes('pages/deal-records/deal-records'), '暂停页面不得注册到小程序')
  assertOk(!/confirm-deal-button|confirmAdminDeal/.test(adminSource), '后台不得保留确认签单动作')
  assertOk(/报备与签单功能暂停/.test(adminSource) && /历史数据只读/.test(adminSource), '后台必须明确暂停且历史只读')
  return '报备/签单默认暂停，四条写链路双层封堵，历史查询只读保留'
}

function checkFootprintRetentionAndSingleWriter() {
  const domainSource = readText('server/src/domain.js')
  const indexSource = readText('server/src/index.js')
  const feishuSource = readText('server/src/feishu-sync.js')
  const footprintPage = readText('pages/footprint/footprint.js')
  assertOk(/BROKER_FOOTPRINT_RETENTION_MS\s*=\s*7\s*\*\s*DAY_MS/.test(domainSource), '中介足迹必须只读最近 7 天')
  assertOk(/ADMIN_FOOTPRINT_RETENTION_MS\s*=\s*90\s*\*\s*DAY_MS/.test(domainSource), '后台足迹必须保留 90 天')
  assertOk(!/MAX_FOOTPRINT_ROWS|FOOTPRINT_MAX_ROWS/.test(domainSource), '足迹不得按数量截断 90 天内证据')
  assertOk((domainSource.match(/\.footprints\.unshift\(/g) || []).length === 1, 'domain.js 只能由统一入口直接写 footprints 数组')
  assertOk(!/\.footprints\.(?:unshift|push)\(/.test(feishuSource), '飞书同步不得绕过统一足迹入口')
  assertOk(/recordSystemFootprint/.test(feishuSource), '飞书系统动作必须调用统一足迹入口')
  assertOk(/expiredFootprintCount\(snapshot\)/.test(indexSource) && /pruneExpiredFootprints\(nextDb\)/.test(indexSource), '只在命中过期记录时进入写锁清理')
  assertOk(/filters:\s*\['我的房源被查看',\s*'电话查看'\]/.test(footprintPage), '中介足迹页只允许两个筛选')
  return '新足迹统一六字段单写入口；中介 7 天、后台 90 天、锁内清理且不按行数截断'
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

function checkAdminHistoricalReadOnlyPanels() {
  const adminSource = readText('admin-web/index.html')
  const requiredTexts = [
    '待维护房源',
    '即将失效 / 废房源池',
    '今日敏感查看',
    '报备与签单功能暂停',
    '历史数据只读'
  ]
  const missing = requiredTexts.filter((text) => !adminSource.includes(text))
  assertOk(!missing.length, `后台数据总览缺少今日任务文案：${missing.join('、')}`)
  assertOk(adminSource.includes('needId / snapshot'), '历史报备/签单表仍须展示冻结快照摘要')
  assertOk(!/confirm-deal-button|confirmAdminDeal/.test(adminSource), '历史只读面板不得包含确认动作')
  return '后台当前任务存在，历史报备/签单暂停只读且无确认动作'
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
  ['敏感查看最小六字段审计', checkSensitiveViewMinimalAudit],
  ['报备/签单双层暂停封堵', checkReportDealPauseGuard],
  ['足迹 7/90 天与单写入口', checkFootprintRetentionAndSingleWriter],
  ['签单 snapshot 使用 deal.uploaderId', checkDealSnapshotUsesDealUploader],
  ['上传去重函数/测试存在', checkUploadDedupeExists],
  ['后台当前任务与历史只读面板', checkAdminHistoricalReadOnlyPanels],
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
