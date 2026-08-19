'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function assertNoStaleReportDealCopy(text, label) {
  const stalePatterns = [
    /报备保持简单/,
    /签单必须从报备记录发起/,
    /签单从报备记录发起，只填写/,
    /房东实际支付佣金和可选备注/,
    /上传人分佣由后端按房东实付佣金的20%计算/
  ]
  stalePatterns.forEach((pattern) => {
    assert.ok(!pattern.test(text), `${label} 不得保留已暂停报备/签单的旧活动口径：${pattern}`)
  })
}

async function run() {
  // 1. FAQ 是独立公开页面，并从“我的”公开区域进入；不依赖 profileReady 或登录接口。
  const appJson = JSON.parse(read('app.json'))
  assert.ok(appJson.pages.includes('pages/faq/faq'), 'app.json 必须注册公开 FAQ 页面')
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'pages', 'faq', `faq.${ext}`)), `FAQ 页面缺少 faq.${ext}`)
  }

  const profileWxml = read('pages/profile/profile.wxml')
  const publicHelpAt = profileWxml.indexOf('public-help-section')
  const protectedBlockEndAt = profileWxml.lastIndexOf('</block>')
  assert.ok(publicHelpAt > protectedBlockEndAt, '常见问题入口必须位于登录工作台 block 之外，游客始终可见')
  assert.ok(profileWxml.includes('/pages/faq/faq'), '“我的”页必须提供 FAQ 入口')

  const faqJs = read('pages/faq/faq.js')
  const faqWxml = read('pages/faq/faq.wxml')
  assert.ok(!/api-service|api-client|getCurrentUser|getProfileState|Authorization|ynzy_auth_token/.test(faqJs), 'FAQ 必须为公开静态内容，不能调用受保护接口或读取 token')
  assert.ok(/wx:for="\{\{faqItems\}\}"/.test(faqWxml), 'FAQ 页面必须真实渲染问题列表')

  let faqPage
  global.Page = (definition) => { faqPage = definition }
  delete require.cache[require.resolve(path.join(repoRoot, 'pages', 'faq', 'faq.js'))]
  require(path.join(repoRoot, 'pages', 'faq', 'faq.js'))
  assert.ok(faqPage && faqPage.data && Array.isArray(faqPage.data.faqItems), 'FAQ 页面必须提供可渲染数据')
  assert.ok(faqPage.data.faqItems.length >= 6, 'FAQ 至少覆盖报备、佣金、收藏、足迹、登录和账号安全')
  const faqText = faqPage.data.faqItems.map((item) => `${item.question || ''}\n${item.answer || ''}`).join('\n')
  for (const keyword of ['报备', '签单', '佣金', '收藏', '足迹', '30 天', '退出', '修改密码', '停用']) {
    assert.ok(faqText.includes(keyword), `FAQ 缺少当前口径：${keyword}`)
  }
  assert.ok(/当前暂停|已暂停/.test(faqText), 'FAQ 必须明确报备与签单当前暂停')
  assert.ok(/最近 7 天/.test(faqText) && /90 天/.test(faqText), 'FAQ 必须说明中介 7 天、后台 90 天足迹边界')
  assertNoStaleReportDealCopy(faqText, '小程序 FAQ')

  // 2. 游客进入“我的”时只显示登录卡，不得自动弹登录窗挡住 FAQ。
  const profileJs = read('pages/profile/profile.js')
  const authCatch = profileJs.match(/if \(isAuthError\(error\)\) \{([\s\S]*?)\r?\n\s*return\r?\n\s*\}/)
  assert.ok(authCatch, '必须保留游客 profile 401 状态处理')
  assert.ok(!/promptLoginGuide|showModal/.test(authCatch[1]), '游客打开“我的”不得自动弹登录窗挡住公开 FAQ')

  // 3. 主动退出必须先请求服务端撤销；失败不能显示“已退出”或清本地伪装成功。
  const logoutMethod = profileJs.match(/\r?\n\s*logout\(\) \{([\s\S]*?)\r?\n\s*\},\r?\n/)
  assert.ok(logoutMethod, '“我的”页必须保留退出操作')
  assert.ok(/apiService\.logout\(\)/.test(logoutMethod[1]), '主动退出必须调用服务端撤销接口')
  assert.ok(/\.then\(/.test(logoutMethod[1]) && /app\.logout\(\)/.test(logoutMethod[1]), '服务端撤销成功后才可清本地会话')
  assert.ok(/\.catch\(/.test(logoutMethod[1]) && /退出失败/.test(logoutMethod[1]), '网络失败必须明确提示退出失败，不能假报成功')

  // 4. 找房助手业务 FAQ 和中介手册同步当前暂停、30 天滑动与撤销口径。
  const businessFaq = read('server/src/assistant/business-faq.js')
  assertNoStaleReportDealCopy(businessFaq, '找房助手业务 FAQ')
  assert.ok(/报备与签单.*暂停|暂停.*报备与签单/.test(businessFaq), '助手 FAQ 必须明确报备与签单暂停')

  const matchService = read('server/src/match-service.js')
  assert.ok(!/管理员确认签单后.*上传人到手/.test(matchService), '推荐卡文案不得继续暗示当前可提交/确认签单')

  const handbook = read('docs/中介使用手册.md')
  assertNoStaleReportDealCopy(handbook, '中介使用手册')
  assert.ok(!/登录状态大约保持一周|登录已过期（约一周）/.test(handbook), '手册不得继续宣称登录只保持约一周')
  assert.ok(/30 天滑动续期|30 天内持续使用/.test(handbook), '手册必须写明 30 天滑动登录')
  assert.ok(/退出登录.*所有设备|所有设备.*退出登录/.test(handbook), '手册必须写明主动退出的全设备撤销语义')

  console.log('profile-faq-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
