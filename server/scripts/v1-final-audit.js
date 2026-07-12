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
const hiddenV1EntryKeywords = ['房源群', '积分', '充值', '换群', '微信支付', '报备', '签单']
const criticalScripts = [
  // 历史综合 smoke 会写临时业务数据，门禁只执行其 env-only 配置测试，绝不直接跑真实 smoke。
  'server/scripts/smoke-credentials-env-v1-test.js',
  'server/scripts/map-v1-test.js',
  'server/scripts/assistant-v1-test.js',
  'server/scripts/backend-contract-v1-test.js',
  // 详情佣金、自动成交金额与拨号成功最小足迹是房源体验闭环资金/隐私红线。
  'server/scripts/listing-detail-commission-v1-test.js',
  'server/scripts/listing-phone-footprint-v1-test.js',
  // M3：报备/签单默认暂停、旧客户端封堵、敏感查看最小化、7/90 天留存和活动入口下线。
  'server/scripts/report-deal-pause-v1-test.js',
  'server/scripts/sensitive-view-simplification-v1-test.js',
  'server/scripts/footprint-retention-v1-test.js',
  'server/scripts/footprint-route-prune-v1-test.js',
  'server/scripts/mini-paused-entry-v1-test.js',
  'server/scripts/mini-static-contract-v1-test.js',
  // M4：服务端账号收藏、跨进程幂等、失效房源脱敏、token/请求竞态、全场景星标与 Mock 同口径。
  'server/scripts/favorite-domain-v1-test.js',
  'server/scripts/favorite-http-v1-test.js',
  'server/scripts/favorite-store-v1-test.js',
  'server/scripts/favorite-component-page-v1-test.js',
  'server/scripts/favorite-entry-v1-test.js',
  'server/scripts/favorite-mock-v1-test.js',
  // M5：verified-only 3 公里、服务端权限裁剪、详情/全量页与 Mock 同形。
  'server/scripts/listing-nearby-domain-v1-test.js',
  'server/scripts/listing-nearby-http-v1-test.js',
  'server/scripts/listing-nearby-mock-v1-test.js',
  'server/scripts/listing-nearby-page-v1-test.js',
  'server/scripts/listing-verify-outcome-v1-test.js',
  // 内部员工上传业主/二房东房源自动通过；普通中介、冲突账号与客户端伪造权限仍必须走原审核边界。
  'server/scripts/staff-listing-auto-approve-v1-test.js',
  'server/scripts/guest-mode-v1-test.js',
  'server/scripts/auth-token-v1-test.js',
  // 小程序登录接入账号密码：正确/错误/缺密/存量无密码/待审核/软删登录口径 + passwordHash 不外泄 +
  // DB 只存 scrypt 哈希；以及「待审核/无密码账号拿不到任何 token、无 token 拿不到 /mini 数据」正面固化。
  'server/scripts/mini-login-password-v1-test.js',
  // 改密会话撤销：自助改密给当前设备换发新 token、其他旧会话立即失效；管理员重置使全部旧会话失效。
  'server/scripts/mini-token-revocation-v1-test.js',
  // M6：30 天滑动登录、全设备退出/停用/删除撤销、在途写 fresh 验签、稳定会话键与公开 FAQ。
  'server/scripts/mini-sliding-auth-v1-test.js',
  'server/scripts/mini-sliding-auth-client-v1-test.js',
  'server/scripts/admin-mini-user-revocation-race-v1-test.js',
  'server/scripts/profile-loading-state-v1-test.js',
  'server/scripts/profile-faq-v1-test.js',
  'server/scripts/mini-page-resume-state-v1-test.js',
  'server/scripts/mini-pending-no-data-v1-test.js',
  // 视频首帧封面：OSS 私有桶 video/snapshot 签名必须把 x-oss-process 纳入 subresource，否则 SignatureDoesNotMatch。
  'server/scripts/oss-video-snapshot-v1-test.js',
  // STS 临时凭据：GET/快照/PUT 必须把 security token 纳入 V1 签名，错误正文不得回显 token。
  'server/scripts/oss-sts-signing-v1-test.js',
  // 图片错误事件晚于列表刷新时，必须按房源 id + 当时 URL 定位，禁止旧 index 误清另一套房的封面。
  'server/scripts/listing-cover-error-race-test.js',
  // 告警到人：飞书 webhook 通知脚本的两条契约（HEALTH_ALERT_CMD 白名单 env / BACKUP_ALERT_CMD ALERT_*）、
  // 签名、截断、失败退出码。告警链坏了没人收到通知，必须门禁锁住。
  'server/scripts/send-feishu-alert-v1-test.js',
  // 注册申请飞书提醒：新申请/驳回后重申请→通知、待审核重复提交不轰炸、409 不通知、手机号打码零 PII、
  // 无 webhook 注册不受影响。
  'server/scripts/registration-notify-v1-test.js',
  // 历史恢复模式的签单快照冻结、带看需求归因、视频转发最小留痕与验收矩阵此前不在合并门禁内，改坏这些规则
  // v1-final-audit 仍全绿；纳入门禁使行为级回归也能被拦下。
  'server/scripts/v1-closure-contract-test.js',
  // P1.3 需求漏斗：敏感查看不再制造 L1；历史恢复模式 L2/带看/L3 仍只接受服务端可信 needId。
  'server/scripts/need-funnel-v1-test.js',
  'server/scripts/video-share-v1-test.js',
  'server/scripts/v1-acceptance-check.js',
  // db.json 解析缓存/clone 隔离/写后刷新/抛异常回滚的契约（飞书同步与助手长 await 路径依赖）。
  'server/scripts/db-cache-v1-test.js',
  'server/scripts/db-write-lock-v1-test.js',
  // asr upgrade 处理器兜住畸形请求（单个坏请求不打崩进程）+ 未捕获异常记录后优雅退出的契约。
  'server/scripts/graceful-exit-v1-test.js',
  // 升级握手成功后，客户端一条畸形（未 mask）WS 帧不得逃逸成 uncaughtException 打死进程
  // （clientWs 必须挂 error 监听）。
  'server/scripts/asr-realtime-crash-test.js',
  // 实时 ASR upgrade 鉴权钩子：未授权/超限连接必须在升级阶段被拒，鉴权回调抛错须兜成拒绝。
  'server/scripts/asr-realtime-auth-test.js',
  // 公司房源一律默认带电梯房（38584f6 引入的规则），此前唯一锁定它的测试不在门禁内，
  // 改坏也不会红；纳入门禁。
  'server/scripts/company-default-features-test.js',
  // 飞书公司房源同步是线上库存口径来源：无素材/素材失败必须降级上架并保留对账信息。
  'server/scripts/feishu-sync-v1-test.js',
  // 登录态真 LLM 链路挂起时必须在供应商级超时后回本地真实匹配，不能让前端报网络失败。
  'server/scripts/llm-provider-timeout-fallback-test.js',
  // 把静态上线差距审计纳入最终门禁，避免旧 need/purpose、主动签单入口或足迹旁路再次漂移。
  'server/scripts/v1-online-gap-audit.js'
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

function checkSmokeTestEnvOnly() {
  assertOk(fs.existsSync(repoPath('server/scripts/smoke-test.js')), 'server/scripts/smoke-test.js 不存在')
  const source = readText('server/scripts/smoke-test.js')
  const requiredNames = ['SMOKE_BASE_URL', 'SMOKE_ADMIN_ACCOUNT', 'SMOKE_ADMIN_PASSWORD']
  requiredNames.forEach((name) => {
    assertOk(source.includes(name), `server/scripts/smoke-test.js 缺少 ${name} 环境变量入口`)
    const literalFallback = new RegExp(`process\\.env\\.${name}\\s*(?:\\|\\||\\?\\?)\\s*['\"\\x60]`)
    assertOk(!literalFallback.test(source), `server/scripts/smoke-test.js 的 ${name} 不得带字面量默认值`)
  })
  assertOk(source.includes('SMOKE_ENV_REQUIRED'), 'server/scripts/smoke-test.js 缺少环境变量时必须 fail-closed')
  const unstaged = runGit(['diff', '--name-only', '--', 'server/scripts/smoke-test.js'])
  const staged = runGit(['diff', '--cached', '--name-only', '--', 'server/scripts/smoke-test.js'])
  assertOk(!unstaged && !staged, 'server/scripts/smoke-test.js 存在未提交或已暂存改动')
  return '三项运行配置仅来自环境变量，缺失即在请求前退出'
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
  assertOk(indexWxml.includes('Yooni小助手'), '首页助手必须更名为 Yooni小助手')
  assertOk(indexWxml.includes('一句话告诉我需要找什么房子'), '首页助手简介必须使用指定文案')
  return '首页快照标题只保留寓你住一起房源表，首页助手已更名为 Yooni小助手'
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

function checkPausedReportDealHistoryContract() {
  const indexSource = readText('server/src/index.js')
  const domainSource = readText('server/src/domain.js')
  const app = readJson('app.json')
  const detailJs = readText('pages/listing-detail/listing-detail.js')
  const detailWxml = readText('pages/listing-detail/listing-detail.wxml')
  const profileJs = profileEntrySurface()
  const profileWxml = readText('pages/profile/profile.wxml')
  const adminSource = readText('admin-web/index.html')
  const listingDisplaySource = readText('utils/listing-display.js')
  const configSource = readText('server/src/config.js')
  const requiredIndexFragments = [
    "pathname === '/mini/reports'",
    "pathname === '/mini/deals'",
    "pathname === '/admin/reports'",
    "pathname === '/admin/deals'",
    'adminDealConfirmMatch'
  ]
  const requiredDomainFragments = [
    'function createClientReport',
    'function createDealFromReport',
    'function confirmDeal',
    'const SECOND_LANDLORD_COMMISSION_RATE = 20',
    'const OWNER_COMMISSION_RATE = 20',
    'const PLATFORM_COMMISSION_RATE = 10',
    'function platformRateByOwnerType',
    'function commissionRuleForListing',
    'COMPANY_COMMISSION_TEXT',
    'landlordCommissionFen',
    'uploaderCommissionFen',
    'platformCommissionFen'
  ]
  const missingIndex = requiredIndexFragments.filter((fragment) => !indexSource.includes(fragment))
  const missingDomain = requiredDomainFragments.filter((fragment) => !domainSource.includes(fragment))
  assertOk(!missingIndex.length, `server/src/index.js 缺少接口片段：${missingIndex.join('、')}`)
  assertOk(!missingDomain.length, `server/src/domain.js 缺少契约片段：${missingDomain.join('、')}`)
  assertOk(/REPORT_DEAL_WRITES_ENABLED'[\s\S]{0,50}false/.test(configSource), '报备/签单服务端恢复开关必须默认关闭')
  assertOk(indexSource.includes("error.data = { reason: 'REPORT_DEAL_PAUSED' }"), '路由层必须返回稳定 REPORT_DEAL_PAUSED 原因')
  assertOk(domainSource.includes("error.data = { reason: 'REPORT_DEAL_PAUSED' }"), '领域层必须返回稳定 REPORT_DEAL_PAUSED 原因')
  ;['reportMatch', 'reportDealMatch', 'dealMatch', 'adminDealConfirmMatch'].forEach((routeName) => {
    const start = indexSource.indexOf(`if (method === 'POST' && ${routeName})`)
    const block = indexSource.slice(start, start + 700)
    const guardAt = block.indexOf('assertReportDealWritesEnabled()')
    const parseAt = block.indexOf('parseBody')
    const updateAt = block.indexOf('updateDb')
    assertOk(start >= 0 && guardAt >= 0, `${routeName} 必须保留兼容路由并在路由层封堵`)
    assertOk(parseAt < 0 || guardAt < parseAt, `${routeName} 必须在解析客户端正文前封堵`)
    assertOk(updateAt < 0 || guardAt < updateAt, `${routeName} 必须在数据库写锁前封堵`)
  })
  ;['createClientReport', 'createDealFromReport', 'confirmDeal', 'registerDeal'].forEach((name) => {
    const start = domainSource.indexOf(`function ${name}`)
    assertOk(start >= 0 && domainSource.slice(start, start + 260).includes('assertReportDealWritesEnabled()'), `${name} 必须保留恢复实现并默认由领域层封堵`)
  })
  assertOk(!app.pages.includes('pages/client-reports/client-reports') && !app.pages.includes('pages/deal-records/deal-records'), '小程序不得注册报备/签单历史页面')
  assertOk(!/startReportDeal|submitClientReport|submitDealFromReport|客户报备|提交签单/.test(`${detailJs}\n${detailWxml}`), '详情页不得保留可达报备/签单入口')
  assertOk(!/client-reports|deal-records|我的报备|我的签单/.test(`${profileJs}\n${profileWxml}`), '我的页面不得保留报备/签单入口')
  assertOk(!/need-bind-row|purpose-options|sensitivePurpose/.test(detailWxml), '敏感查看不得恢复需求绑定或用途选择')
  assertOk(!/confirm-deal-button|confirmAdminDeal/.test(adminSource), '后台历史签单不得保留确认动作')
  assertOk(/报备与签单功能暂停/.test(adminSource) && /历史数据只读/.test(adminSource), '后台必须明确暂停且历史只读')
  assertOk(domainSource.includes('公司房源成交不抽佣，带看中介全佣'), '后端必须提供公司房源带看中介全佣文案')
  assertOk(domainSource.includes('commissionRule.rate <= 0'), 'confirmDeal 必须保留 no-commission 分支')
  assertOk(domainSource.includes('commissionRecord: null'), '公司房源确认签单必须返回空分佣记录')
  assertOk(listingDisplaySource.includes('COMPANY_COMMISSION_TEXT'), '非详情房源卡归一化必须保留公司房源分佣文案')
  assertOk(detailWxml.includes('listing.commissionBreakdown.landlordPercentOfRent'), '详情页必须展示服务端房东总佣金月租占比')
  assertOk(detailWxml.includes('listing.commissionBreakdown.viewingAgentPercentOfRent'), '详情页必须展示服务端带看人月租占比')
  assertOk(detailWxml.includes('listing.commissionBreakdown.maintainerPercentOfRent'), '详情页必须展示服务端维护人月租占比')
  assertOk(detailWxml.includes('listing.commissionBreakdown.platformPercentOfRent'), '详情页必须展示服务端平台月租占比')
  assertOk(!detailWxml.includes('listing.commissionText') && !detailWxml.includes('listing.uploader'), '详情页不得恢复旧佣金黄条或上传人显示')
  assertOk(detailWxml.includes('bindtap="callLandlord"'), '详情页必须提供统一联系房东按钮')
  assertOk(configSource.includes('COMPANY_CONTACT_PHONES'), '公司看房电话必须来自服务端配置')
  assertOk(domainSource.includes('companyContactPhones') && domainSource.includes('companyContactPhoneText'), '公司房源详情必须下发公司看房电话')
  assertOk(domainSource.includes('sensitiveLocked: !display.companyListing'), '公司房源详情必须直接公开地址电话')
  // 查看地址电话按钮须由 !listing.companyListing 守卫（公司房源隐藏）。上传人自查分支加入后，
  // reveal 按钮由 wx:if 变为 wx:elif（前置 isOwnListing 自查 wx:if），两种形式都满足"公司房源隐藏"。
  assertOk(
    detailWxml.includes('wx:elif="{{!listing.companyListing}}" class="primary-button"') ||
    detailWxml.includes('wx:if="{{!listing.companyListing}}" class="primary-button"'),
    '公司房源详情必须隐藏查看地址电话按钮（查看按钮须由 !companyListing 守卫，含自查 wx:if/wx:elif 分支）'
  )
  assertOk(detailWxml.includes('wx:if="{{!listing.companyListing}}" class="showing-action-card'), '公司房源详情必须隐藏水印拍照区块')
  return '报备/签单默认暂停且旧客户端双层封堵；历史查询与显式恢复佣金快照保留，活动界面只读无写入口'
}

function checkMapCoordinateGrading() {
  const configSource = readText('server/src/config.js')
  const domainSource = readText('server/src/domain.js')
  const indexSource = readText('server/src/index.js')
  const mapJs = readText('pages/map/map.js')
  const adminWeb = readText('admin-web/index.html')
  const geocodeScript = readText('server/scripts/geocode-listing-communities.js')
  assertOk(configSource.includes('QQ_MAP_WEBSERVICE_KEY'), '腾讯位置服务 WebService Key 必须从环境变量读取')
  assertOk(configSource.includes('blockCenters'), '板块中心兜底坐标必须在服务端配置')
  ;['verified', 'approximate', 'block-center'].forEach((level) => {
    assertOk(domainSource.includes(level), `地图坐标等级缺少 ${level}`)
    assertOk(mapJs.includes(level), `小程序地图缺少 ${level} 展示逻辑`)
  })
  assertOk(geocodeScript.includes('https://apis.map.qq.com/ws/geocoder/v1/'), '离线脚本必须调用腾讯地理编码 WebService')
  assertOk(geocodeScript.includes('config.qqMap.webserviceKey'), '离线脚本必须读取服务端环境变量 Key')
  assertOk(indexSource.includes('/coordinate'), '管理后台必须提供坐标修正接口')
  assertOk(adminWeb.includes('coordinate-listing-button'), '管理后台必须提供坐标修正入口')
  return '地图支持 verified/approximate/block-center 分级上图，腾讯地理编码脚本与后台人工修正入口存在'
}

function checkProfileLogout() {
  const profileJs = readText('pages/profile/profile.js')
  const profileWxml = readText('pages/profile/profile.wxml')
  assertOk(profileWxml.includes('退出登录'), '我的页面必须提供退出登录按钮')
  assertOk(/apiService\.logout\(\)[\s\S]*\.then\([\s\S]*app\.logout\(\)/.test(profileJs), '退出登录必须先由服务端撤销成功，再调用 app.logout 清除本地 token')
  assertOk(profileJs.includes("wx.switchTab({ url: '/pages/index/index' })"), '退出登录后必须跳回找房首页')
  return '我的页面主动退出会先撤销服务端全部设备会话，再清本地 token 并回到找房首页'
}

function checkMiniLoginPassword() {
  const indexJs = readText('server/src/index.js')
  const domainJs = readText('server/src/domain.js')
  assertOk(/loginByPhone\(nextDb, body\.phone, body\.password\)/.test(indexJs), '/mini/auth/login 必须把密码传入 loginByPhone')
  assertOk(indexJs.includes("require('./auth-util')") && domainJs.includes("require('./auth-util')"), 'index.js 与 domain.js 必须共用 auth-util 的密码哈希实现')
  assertOk(/verifyPassword\(/.test(domainJs), 'loginByPhone 必须用 verifyPassword 校验密码')
  assertOk(/if \(!user\.passwordHash\)/.test(domainJs), '无 passwordHash 账号必须 fail-closed 禁登')
  assertOk(/delete safe\.passwordHash/.test(indexJs), '登录响应必须剥离 passwordHash')
  assertOk(/delete safe\.tokenVersion/.test(indexJs) && /delete copy\.tokenVersion/.test(domainJs), 'tokenVersion 不得作为用户字段外泄')
  assertOk(domainJs.includes('function withoutSecret'), 'user 序列化必须过 withoutSecret 剥离密码哈希')
  assertOk(indexJs.includes("pathname === '/mini/auth/password'") && domainJs.includes('function changeOwnPassword'), '必须提供登录后自助修改密码入口（/mini/auth/password → changeOwnPassword）')
  assertOk(/signMiniAuthPayload\(\{ userId, exp: tokenExpiresAt, tokenVersion \}\)/.test(indexJs), '小程序 token 必须签入账号 tokenVersion')
  assertOk(/payload\.tokenVersion !== miniAuthTokenVersion\(user\)/.test(indexJs), '鉴权必须校验 tokenVersion 与账号当前版本一致')
  assertOk(/revokeUserTokens\(user\)/.test(domainJs), '改密必须提升账号 tokenVersion 撤销旧会话')
  assertOk(/return miniAuthResponse\(changedUser\)/.test(indexJs), '自助改密后必须为当前设备换发新 token')
  return '小程序登录已接密码校验（scrypt）、无密码账号 fail-closed、敏感字段不外泄、改密撤销旧会话'
}

function checkSlidingAuthAndPublicFaq() {
  const appJson = readJson('app.json')
  const appJs = readText('app.js')
  const apiClient = readText('utils/api-client.js')
  const indexJs = readText('server/src/index.js')
  const domainJs = readText('server/src/domain.js')
  const ossJs = readText('server/src/oss.js')
  const faqJs = readText('pages/faq/faq.js')
  const faqWxml = readText('pages/faq/faq.wxml')
  const profileWxml = readText('pages/profile/profile.wxml')
  const businessFaq = readText('server/src/assistant/business-faq.js')
  assertOk(appJson.pages.includes('pages/faq/faq'), '公开 FAQ 页面必须注册到 app.json')
  assertOk(profileWxml.includes('public-help-section') && profileWxml.includes('/pages/faq/faq'), '我的页必须在公开区域提供 FAQ 入口')
  assertOk(/30 天/.test(faqJs) && /最近 7 天/.test(faqJs) && /90 天/.test(faqJs), 'FAQ 必须覆盖 30 天登录与 7/90 天足迹')
  assertOk(/当前已暂停|当前暂停/.test(faqJs) && !/签单必须从报备记录发起/.test(`${faqJs}\n${businessFaq}`), 'FAQ 必须使用报备/签单暂停口径')
  assertOk(!/api-service|api-client|Authorization|ynzy_auth_token/.test(faqJs) && faqWxml.includes('faqItems'), 'FAQ 必须公开静态渲染且不读取登录态')
  assertOk(/MINI_AUTH_TOKEN_TTL_MS\s*=\s*30\s*\*\s*24/.test(indexJs), '小程序 token 必须为 30 天 TTL')
  assertOk(indexJs.includes('X-Auth-Token') && indexJs.includes('X-Auth-Token-Expires-At'), '服务端必须下发滑动续签响应头')
  assertOk(indexJs.includes("pathname.startsWith('/mini/auth/')") && indexJs.includes("headers['Cache-Control'] = 'no-store'"), '鉴权成功与错误响应必须统一禁止缓存')
  assertOk(indexJs.includes("pathname === '/mini/auth/logout'") && domainJs.includes('function logoutUserSessions'), '必须提供服务端主动退出撤销')
  assertOk(indexJs.includes('function updateMiniDb(req, mutator)') && indexJs.includes('dbStore.inspectDb'), '登录态写与外部能力必须在临界点 fresh 验签')
  assertOk(domainJs.includes('function setManagedUserStatus') && indexJs.includes('/status$/'), '必须提供小程序账号停用/恢复并撤销旧 token')
  assertOk(appJs.includes('persistAuthStorageAtomically') && appJs.includes('authSessionKey'), 'App 必须事务式持久化续签并维护稳定会话键')
  assertOk(apiClient.includes('requestAuthSessionKey') && apiClient.includes('isStaleUnauthorized'), 'API 客户端必须按稳定会话键识别旧 401，并仅安全重试读取')
  assertOk(indexJs.includes('function updateAdminDb(req, mutator)') && indexJs.includes('assertFreshAdminCapability(req, nextDb)'), '后台账号管理写入必须在写锁内重验管理员最新权限')
  assertOk(indexJs.includes('clientUploadPolicyInput(body)') && !ossJs.includes("['starts-with', '$key'"), '上传策略必须忽略客户端对象键并精确绑定服务端生成 key')
  assertOk((ossJs.match(/\{ key: objectKey \}/g) || []).length >= 2, '视频与图片 OSS policy 都必须精确绑定单一对象键')
  return '30 天滑动续签、鉴权禁缓存、全设备撤销、事务内重验、上传键隔离、竞态隔离与未登录 FAQ 均已固化'
}

function checkRunnableV1Scripts() {
  return criticalScripts.map((script) => `${script} => ${runNodeScript(script)}`).join('；')
}

const checks = [
  ['app.json 与自定义 tabBar 固定为找房/房源/地图/我的', checkTabBar],
  ['server/scripts/smoke-test.js 凭据仅来自环境变量', checkSmokeTestEnvOnly],
  ['关键 V1 脚本存在', checkCriticalScriptsExist],
  ['第一版可见入口不暴露历史关键词', checkLegacyVisibleEntryKeywords],
  ['前端与 Mock 房态固定 7 天自动失效', checkFrontendVerifyRule],
  ['小程序核心找房页面读取同步库', checkMiniProgramDataSources],
  ['语音实时 ASR 链路配置完整', checkVoiceAsrRealtimeChain],
  ['房源筛选栏共用组件', checkSharedListingFilterComponent],
  ['区域映射配置可扩展', checkDistrictMappingConfig],
  ['首页快照标题不暴露飞书来源', checkHomeSnapshotBranding],
  ['第一版文档不残留 15 天房态规则', checkV1DocsMaintenanceRule],
  ['报备/签单暂停与历史只读契约', checkPausedReportDealHistoryContract],
  ['地图坐标分级链路存在', checkMapCoordinateGrading],
  ['我的页面退出登录存在', checkProfileLogout],
  ['小程序登录已接账号密码校验', checkMiniLoginPassword],
  ['30 天滑动登录与公开 FAQ', checkSlidingAuthAndPublicFaq],
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
