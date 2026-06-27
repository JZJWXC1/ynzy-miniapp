const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '..', '..')
const expectedTabs = [
  { pagePath: 'pages/index/index', text: '找房' },
  { pagePath: 'pages/listings/listings', text: '房源' },
  { pagePath: 'pages/map/map', text: '地图' },
  { pagePath: 'pages/profile/profile', text: '我的' }
]
const hiddenV1EntryKeywords = ['房源群', '积分', '充值', '换群', '微信支付']
const criticalScripts = [
  'server/scripts/map-v1-test.js',
  'server/scripts/assistant-v1-test.js',
  'server/scripts/backend-contract-v1-test.js'
]

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath)
}

function readText(relativePath) {
  return fs.readFileSync(repoPath(relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} 执行失败`).trim())
  }
  return String(result.stdout || '').trim()
}

function runNodeScript(relativePath) {
  const result = spawnSync(process.execPath, [repoPath(relativePath)], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0'
    }
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${relativePath} 执行失败${detail ? `：\n${detail}` : ''}`)
  }
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean)
  return lines[lines.length - 1] || '通过'
}

function checkTabBar() {
  const app = readJson('app.json')
  const list = app.tabBar && Array.isArray(app.tabBar.list) ? app.tabBar.list : []
  assertOk(list.length === expectedTabs.length, `tabBar 数量应为 ${expectedTabs.length} 个，当前为 ${list.length} 个`)
  expectedTabs.forEach((expected, index) => {
    const actual = list[index] || {}
    assertOk(actual.pagePath === expected.pagePath, `tabBar 第 ${index + 1} 项路径应为 ${expected.pagePath}，当前为 ${actual.pagePath || '空'}`)
    assertOk(actual.text === expected.text, `tabBar 第 ${index + 1} 项文案应为 ${expected.text}，当前为 ${actual.text || '空'}`)
  })

  const customTab = readText('custom-tab-bar/index.js')
  expectedTabs.forEach((expected) => {
    assertOk(customTab.includes(`pagePath: '/${expected.pagePath}'`), `自定义 tabBar 缺少路径 /${expected.pagePath}`)
    assertOk(customTab.includes(`text: '${expected.text}'`), `自定义 tabBar 缺少文案 ${expected.text}`)
  })
  return expectedTabs.map((item) => item.text).join(' / ')
}

function profileEntrySurface() {
  return readText('pages/profile/profile.js')
    .replace(/const\s+hiddenV1EntryKeywords\s*=\s*\[[\s\S]*?\]\s*/m, '')
}

function checkLegacyVisibleEntryKeywords() {
  const app = readJson('app.json')
  const pages = Array.isArray(app.pages) ? app.pages : []
  assertOk(!pages.includes('pages/groups/groups'), '第一版 app.json pages 不能注册房源群页面直达路径')
  const surfaces = [
    {
      name: 'app.json tabBar',
      text: JSON.stringify((app.tabBar && app.tabBar.list) || [])
    },
    {
      name: 'custom-tab-bar/index.js',
      text: readText('custom-tab-bar/index.js')
    },
    {
      name: 'pages/profile/profile.js 可见工作台',
      text: profileEntrySurface()
    },
    {
      name: 'pages/my-listings/my-listings.wxml',
      text: readText('pages/my-listings/my-listings.wxml')
    }
  ]

  const hits = []
  surfaces.forEach((surface) => {
    hiddenV1EntryKeywords.forEach((keyword) => {
      if (surface.text.includes(keyword)) {
        hits.push(`${surface.name}：${keyword}`)
      }
    })
  })
  assertOk(!hits.length, `第一版可见入口仍出现历史入口关键词：${hits.join('、')}`)
  return `未出现 ${hiddenV1EntryKeywords.join('、')}`
}

function checkSmokeTestUnchanged() {
  assertOk(fs.existsSync(repoPath('server/scripts/smoke-test.js')), 'server/scripts/smoke-test.js 不存在')
  const unstaged = runGit(['diff', '--name-only', '--', 'server/scripts/smoke-test.js'])
  const staged = runGit(['diff', '--cached', '--name-only', '--', 'server/scripts/smoke-test.js'])
  assertOk(!unstaged && !staged, 'server/scripts/smoke-test.js 存在未提交或已暂存改动')
  return '未修改'
}

function checkCriticalScriptsExist() {
  const missing = criticalScripts.filter((script) => !fs.existsSync(repoPath(script)))
  assertOk(!missing.length, `缺少关键 V1 脚本：${missing.join('、')}`)
  return criticalScripts.join('、')
}

function checkFrontendVerifyRule() {
  const files = [
    'utils/listing-display.js',
    'utils/mock-data.js'
  ]
  files.forEach((file) => {
    const text = readText(file)
    assertOk(/VERIFY_STALE_DAYS\s*=\s*7\b/.test(text), `${file} 必须使用 7 天自动失效规则`)
    assertOk(!/VERIFY_STALE_DAYS\s*=\s*15\b/.test(text), `${file} 不能残留 15 天房态规则`)
  })
  return '前端与 Mock 房态自动失效均为 7 天'
}

function checkAdminReportDealContract() {
  const indexSource = readText('server/src/index.js')
  const domainSource = readText('server/src/domain.js')
  const requiredIndexFragments = [
    "pathname === '/mini/reports'",
    "pathname === '/mini/deals'",
    'domain.createClientReport',
    'domain.createDealFromReport',
    "pathname === '/admin/reports'",
    "pathname === '/admin/deals'",
    'adminDealConfirmMatch',
    'domain.confirmDeal'
  ]
  const requiredDomainFragments = [
    'function createClientReport',
    'function createDealFromReport',
    'function confirmDeal',
    'const UPLOADER_COMMISSION_RATE = 20',
    'landlordCommissionFen',
    'uploaderCommissionFen'
  ]
  const missingIndex = requiredIndexFragments.filter((fragment) => !indexSource.includes(fragment))
  const missingDomain = requiredDomainFragments.filter((fragment) => !domainSource.includes(fragment))
  assertOk(!missingIndex.length, `server/src/index.js 缺少接口片段：${missingIndex.join('、')}`)
  assertOk(!missingDomain.length, `server/src/domain.js 缺少契约片段：${missingDomain.join('、')}`)
  return '报备、签单、后台确认与固定 20% 分佣契约存在'
}

function checkRunnableV1Scripts() {
  return criticalScripts.map((script) => `${script} => ${runNodeScript(script)}`).join('；')
}

const checks = [
  ['app.json 与自定义 tabBar 固定为找房/房源/地图/我的', checkTabBar],
  ['server/scripts/smoke-test.js 未被修改', checkSmokeTestUnchanged],
  ['关键 V1 脚本存在', checkCriticalScriptsExist],
  ['第一版可见入口不暴露历史关键词', checkLegacyVisibleEntryKeywords],
  ['前端与 Mock 房态固定 7 天自动失效', checkFrontendVerifyRule],
  ['报备/签单/后台确认接口契约存在', checkAdminReportDealContract],
  ['地图/助手/后端契约脚本可运行', checkRunnableV1Scripts]
]

function main() {
  const results = []
  checks.forEach(([name, check]) => {
    try {
      const detail = check()
      results.push({ name, ok: true, detail })
    } catch (error) {
      results.push({ name, ok: false, detail: error.message })
    }
  })

  console.log('🙂 V1 最终合并审计')
  results.forEach((result) => {
    const mark = result.ok ? '通过' : '失败'
    console.log(`- ${mark}：${result.name}${result.detail ? `（${result.detail}）` : ''}`)
  })

  const failed = results.filter((result) => !result.ok)
  if (failed.length) {
    console.error(`\n审计失败：${failed.length} 项未通过`)
    process.exit(1)
  }
  console.log('\n全部审计项通过。嘻嘻')
}

main()
