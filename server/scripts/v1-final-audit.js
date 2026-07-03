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
  'server/scripts/backend-contract-v1-test.js',
  'server/scripts/guest-mode-v1-test.js',
  'server/scripts/auth-token-v1-test.js'
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

function checkMiniProgramDataSources() {
  const appSource = readText('app.js')
  const deploySource = readText('utils/deploy-config.js')
  assertOk(
    /systemInfo\.platform\s*===\s*'devtools'\s*&&\s*deployConfig\.useLocalInDevtools/.test(appSource),
    'app.js 开发者工具本地源必须由 deployConfig.useLocalInDevtools 显式控制'
  )
  assertOk(
    !/systemInfo\.platform\s*===\s*'devtools'\s*\)\s*\{\s*next\.env\s*=\s*'local'/m.test(appSource),
    'app.js 不能在开发者工具中无条件切到本机接口'
  )
  assertOk(/env:\s*'prod'/.test(deploySource), 'utils/deploy-config.js 默认环境必须为 prod')
  assertOk(/baseUrl:\s*'https:\/\/zf-api\.ynzyqbot\.cn'/.test(deploySource), 'utils/deploy-config.js 默认必须指向生产 HTTPS 接口')
  assertOk(/useLocalInDevtools:\s*false/.test(deploySource), 'utils/deploy-config.js 不能默认打开开发者工具本地源')

  const pageFiles = [
    'pages/index/index.js',
    'pages/my-listings/my-listings.js',
    'pages/listings/listings.js',
    'pages/map/map.js',
    'pages/match-chat/match-chat.js',
    'pages/match/match.js',
    'pages/listing-detail/listing-detail.js'
  ]
  const directMockPages = pageFiles.filter((file) => /mock-data|mockData|dataCenter/.test(readText(file)))
  assertOk(!directMockPages.length, `小程序核心找房页面不能直接读取 mock 源：${directMockPages.join('、')}`)

  const sourceContracts = [
    ['首页推荐', 'pages/index/index.js', 'apiService.getHomeListings('],
    ['公司房源专区', 'pages/my-listings/my-listings.js', 'apiService.getListings(query)'],
    ['全部房源', 'pages/listings/listings.js', 'apiService.getListings('],
    ['地图', 'pages/map/map.js', 'apiService.getMapCommunities('],
    ['找房助手候选', 'pages/match-chat/match-chat.js', 'llmService.chatAssistant('],
    ['找房助手确认匹配', 'pages/match/match.js', 'llmService.matchRentalNeed('],
    ['房源详情', 'pages/listing-detail/listing-detail.js', 'apiService.getListingDetail(id)']
  ]
  const missingContracts = sourceContracts
    .filter(([, file, fragment]) => !readText(file).includes(fragment))
    .map(([name]) => name)
  assertOk(!missingContracts.length, `以下页面未命中同步库接口调用契约：${missingContracts.join('、')}`)

  const llmSource = readText('utils/llm-service.js')
  assertOk(llmSource.includes("path: '/mini/assistant/chat'"), '找房助手对话必须调用后端 /mini/assistant/chat')
  assertOk(llmSource.includes("path: '/mini/llm/match'"), '找房助手候选必须调用后端 /mini/llm/match')
  assertOk(
    /function shouldUseLocalFallbackAfterError\(\)\s*\{\s*return shouldUseMock\(getRuntimeConfig\(\)\)\s*\}/.test(llmSource),
    '找房助手网络失败后只能在 mock 环境使用本地候选兜底'
  )
  return '核心找房页面均经统一 API 读取同步库，mock 仅在 env=mock 时启用'
}

function checkVoiceAsrRealtimeChain() {
  const appJson = readJson('app.json')
  const permission = appJson.permission || {}
  assertOk(
    permission['scope.record'] && /语音|麦克风|录音/.test(permission['scope.record'].desc || ''),
    'app.json 必须声明 scope.record 录音权限说明'
  )

  const voiceSource = readText('utils/voice-input.js')
  const apiServiceSource = readText('utils/api-service.js')
  const nginxSource = readText('deploy/nginx-zf-api-miniapp.conf')
  const asrRealtimeSource = readText('server/src/asr-realtime.js')
  const packageSource = readText('server/package.json')

  assertOk(voiceSource.includes('ensureRecordAuthorized'), '语音输入必须在启动录音前检查 scope.record 授权')
  assertOk(voiceSource.includes('wx.authorize'), '语音输入必须主动触发录音授权')
  assertOk(voiceSource.includes('getSupportStatus'), '语音输入必须暴露录音器支持状态用于真机诊断')
  assertOk(voiceSource.includes('asr-socket-error'), '语音输入必须区分实时 ASR WebSocket 错误')
  assertOk(apiServiceSource.includes('realtimeAsrUrl'), '实时 ASR socket task 必须保留 wss URL 便于诊断')
  assertOk(packageSource.includes('"ws"'), '后端必须依赖 ws 支持实时 ASR 代理')
  assertOk(asrRealtimeSource.includes("CLIENT_PATH = '/mini/asr/realtime'"), '后端实时 ASR 路径必须为 /mini/asr/realtime')
  assertOk(asrRealtimeSource.includes('server.on(\'upgrade\''), '后端必须监听 HTTP upgrade 事件')
  assertOk(nginxSource.includes('server_name zf-api.ynzyqbot.cn'), 'Nginx 模板必须覆盖 zf-api API 域名')
  assertOk(nginxSource.includes('location = /mini/asr/realtime'), 'Nginx 模板必须单独配置实时 ASR 路径')
  assertOk(nginxSource.includes('proxy_set_header Upgrade $http_upgrade'), 'Nginx 模板必须转发 WebSocket Upgrade 头')
  assertOk(nginxSource.includes('proxy_set_header Connection "upgrade"'), 'Nginx 模板必须转发 WebSocket Connection upgrade')
  return '录音授权、前端诊断、后端 upgrade 监听与 zf-api Nginx Upgrade 模板均存在'
}

function checkSharedListingFilterComponent() {
  const componentJs = readText('components/listing-filter/listing-filter.js')
  const componentWxml = readText('components/listing-filter/listing-filter.wxml')
  const listingsJson = readText('pages/listings/listings.json')
  const myListingsJson = readText('pages/my-listings/my-listings.json')
  const listingsJs = readText('pages/listings/listings.js')
  const myListingsJs = readText('pages/my-listings/my-listings.js')

  assertOk(listingsJson.includes('/components/listing-filter/listing-filter'), '全部房源页必须注册共用筛选组件')
  assertOk(myListingsJson.includes('/components/listing-filter/listing-filter'), '公司房源专区必须注册共用筛选组件')
  assertOk(readText('pages/listings/listings.wxml').includes('<listing-filter'), '全部房源页必须使用共用筛选组件')
  assertOk(readText('pages/my-listings/my-listings.wxml').includes('<listing-filter'), '公司房源专区必须使用共用筛选组件')
  ;['不限', '区域', '板块', '小区', '户型', '最低租金', '最高租金', '筛选', '重置'].forEach((text) => {
    assertOk(componentWxml.includes(text), `共用筛选组件缺少 ${text}`)
  })
  ;['filterchange', 'filterapply', 'filterreset', 'visibleCommunities'].forEach((text) => {
    assertOk(componentJs.includes(text), `共用筛选组件缺少 ${text}`)
  })
  ;['拱墅区', '上城区', '余杭区'].forEach((district) => {
    assertOk(listingsJs.includes(district), `全部房源页区域选项缺少 ${district}`)
    assertOk(myListingsJs.includes(district), `公司房源专区区域选项缺少 ${district}`)
  })
  assertOk(listingsJs.includes('district: cleanFilterValue(sourceFilters.district || sourceFilters.area)'), '全部房源页必须兼容旧 area 参数并落到 district')
  assertOk(listingsJs.includes('communityOptions: uniqueCommunities'), '全部房源页小区联想必须来自当前在架房源去重')
  assertOk(myListingsJs.includes('companyCommunityOptions'), '公司房源专区小区联想必须来自当前公司房源去重')
  return '全部房源页与公司房源专区共用 listing-filter，旧 area 参数兼容为 district'
}

function checkDistrictMappingConfig() {
  const configSource = readText('server/src/config.js')
  const locationMapSource = readText('server/src/location-map.js')
  const feishuSource = readText('server/src/feishu-sync.js')
  const backfillSource = readText('server/scripts/backfill-listing-districts.js')

  ;['拱墅区', '上城区', '余杭区', '小洋坝家园一区', '小洋坝家园二区', '小洋坝家园三区', '大华海派风景', '风雅乐府', '瑷颐湾'].forEach((text) => {
    assertOk(configSource.includes(text), `区域配置缺少 ${text}`)
  })
  assertOk(configSource.includes('communityDistrictOverrides'), '区域配置必须提供小区级覆盖表')
  assertOk(locationMapSource.includes('function districtForCommunity'), 'location-map 必须先支持小区级覆盖')
  assertOk(locationMapSource.includes('districtForLocation'), 'location-map 必须提供统一位置映射入口')
  assertOk(feishuSource.includes('districtForLocation'), '飞书同步必须使用统一位置映射入口')
  assertOk(backfillSource.includes('districtForLocation'), 'district 回填脚本必须使用统一位置映射入口')
  return '三区与余杭小区覆盖表、飞书同步、存量回填共用统一映射入口'
}

function checkHomeSnapshotBranding() {
  const indexWxml = readText('pages/index/index.wxml')
  assertOk(indexWxml.includes('寓你住一起房源表'), '首页快照标题必须保留寓你住一起房源表')
  assertOk(!/飞书实时房源表截图/.test(indexWxml), '首页快照标题不能出现飞书实时房源表截图')
  assertOk(!/同步飞书/.test(indexWxml), '首页快照空态不能暴露飞书来源')
  return '首页快照标题只保留寓你住一起房源表'
}

function checkV1DocsMaintenanceRule() {
  const files = [
    '需求.md',
    '接口上线说明.md',
    'docs/V1_SCOPE.md',
    'docs/V1_WECHAT_DEVTOOLS_ACCEPTANCE.md',
    'server/README.md'
  ].filter((file) => fs.existsSync(repoPath(file)))
  const hits = []
  files.forEach((file) => {
    const text = readText(file)
    if (/15\s*天|15天|十五天/.test(text)) {
      hits.push(file)
    }
  })
  assertOk(!hits.length, `第一版文档不能残留 15 天房态规则：${hits.join('、')}`)
  return '第一版文档均为 3/5/7 房态规则'
}

function checkAdminReportDealContract() {
  const indexSource = readText('server/src/index.js')
  const domainSource = readText('server/src/domain.js')
  const detailWxml = readText('pages/listing-detail/listing-detail.wxml')
  const listingDisplaySource = readText('utils/listing-display.js')
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
    'const SECOND_LANDLORD_COMMISSION_RATE = 15',
    'const OWNER_COMMISSION_RATE = 20',
    'const TOTAL_DEAL_COMMISSION_RATE = 20',
    'function commissionRateForListing',
    'COMPANY_COMMISSION_TEXT',
    'landlordCommissionFen',
    'uploaderCommissionFen',
    'platformCommissionFen'
  ]
  const missingIndex = requiredIndexFragments.filter((fragment) => !indexSource.includes(fragment))
  const missingDomain = requiredDomainFragments.filter((fragment) => !domainSource.includes(fragment))
  assertOk(!missingIndex.length, `server/src/index.js 缺少接口片段：${missingIndex.join('、')}`)
  assertOk(!missingDomain.length, `server/src/domain.js 缺少契约片段：${missingDomain.join('、')}`)
  assertOk(domainSource.includes('公司房源成交不抽佣，带看中介全佣'), '后端必须提供公司房源带看中介全佣文案')
  assertOk(domainSource.includes('commissionRule.rate <= 0'), 'confirmDeal 必须保留 no-commission 分支')
  assertOk(domainSource.includes('commissionRecord: null'), '公司房源确认签单必须返回空分佣记录')
  assertOk(listingDisplaySource.includes('COMPANY_COMMISSION_TEXT'), '前端房源归一化必须保留公司房源分佣文案')
  assertOk(detailWxml.includes("listing.noCommission ? 'no-commission' : ''"), '详情页黄条必须按 noCommission 区分样式')
  return '报备、签单、后台确认与总 20%/上传人平台拆分分佣契约存在，公司房源不生成分佣记录'
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
  ['小程序核心找房页面读取同步库', checkMiniProgramDataSources],
  ['语音实时 ASR 链路配置完整', checkVoiceAsrRealtimeChain],
  ['房源筛选栏共用组件', checkSharedListingFilterComponent],
  ['区域映射配置可扩展', checkDistrictMappingConfig],
  ['首页快照标题不暴露飞书来源', checkHomeSnapshotBranding],
  ['第一版文档不残留 15 天房态规则', checkV1DocsMaintenanceRule],
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
