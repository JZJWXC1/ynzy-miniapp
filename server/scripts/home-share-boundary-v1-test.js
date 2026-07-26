const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const indexPath = path.join(repoRoot, 'pages', 'index', 'index.js')
const detailPath = path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js')
const sharedVideoPath = path.join(repoRoot, 'pages', 'shared-video', 'shared-video.js')

function loadHomeDefinition(showShareMenu) {
  const originalPage = global.Page
  const originalWx = global.wx
  let definition = null
  global.Page = (value) => { definition = value }
  global.wx = showShareMenu === undefined ? {} : { showShareMenu }
  delete require.cache[require.resolve(indexPath)]
  try {
    require(indexPath)
  } finally {
    global.Page = originalPage
    global.wx = originalWx
  }
  assert.ok(definition, '必须能捕获首页 Page 配置')
  return definition
}

function makeLifecyclePage(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data || {})),
    bindAuthInvalidationListener() {},
    initVoiceInput() {},
    syncAuthSession() {},
    loadTodayTasks() {},
    loadCompanySheetSnapshot() {},
    loadHomeListings() {},
    getTabBar() { return null }
  }
}

function runWithWx(wxValue, callback) {
  const originalWx = global.wx
  global.wx = wxValue
  try {
    return callback()
  } finally {
    global.wx = originalWx
  }
}

const menuCalls = []
const definition = loadHomeDefinition((options) => menuCalls.push(options))

assert.strictEqual(typeof definition.onShareAppMessage, 'function', '首页必须提供转发给朋友配置')
assert.deepStrictEqual(
  definition.onShareAppMessage(),
  { title: '寓你住一起', path: '/pages/index/index' },
  '首页好友转发必须固定品牌标题与无 query 首页路径'
)

assert.strictEqual(typeof definition.onShareTimeline, 'function', '首页必须提供分享到朋友圈配置')
assert.deepStrictEqual(
  definition.onShareTimeline(),
  { title: '寓你住一起' },
  '首页朋友圈分享只能返回品牌标题，不得携带 query 或可识别参数'
)

const lifecyclePage = makeLifecyclePage(definition)
runWithWx({ showShareMenu: (options) => menuCalls.push(options) }, () => lifecyclePage.onLoad())
assert.strictEqual(menuCalls.length, 1, '首页加载时必须且只需开启一次系统分享菜单')
assert.deepStrictEqual(
  menuCalls[0],
  { menus: ['shareAppMessage', 'shareTimeline'] },
  '首页分享菜单必须精确开放好友与朋友圈两个系统入口'
)

assert.doesNotThrow(
  () => runWithWx({}, () => makeLifecyclePage(loadHomeDefinition(undefined)).onLoad()),
  '旧版微信缺少 showShareMenu 时首页 onLoad 不得中断'
)
assert.doesNotThrow(
  () => runWithWx(
    { showShareMenu() { throw new Error('模拟系统分享菜单异常') } },
    () => makeLifecyclePage(loadHomeDefinition(() => {})).onLoad()
  ),
  'showShareMenu 抛错时首页 onLoad 不得中断'
)
assert.doesNotThrow(() => runWithWx({}, () => makeLifecyclePage(definition).onShow()), '首页既有 onShow 业务不得被分享能力破坏')

const pageJsFiles = []
function collectJsFiles(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectJsFiles(fullPath)
    else if (entry.isFile() && entry.name.endsWith('.js')) pageJsFiles.push(fullPath)
  })
}
collectJsFiles(path.join(repoRoot, 'pages'))

const pagesWithNativeShareHooks = pageJsFiles
  .filter((filePath) => /\bonShare(?:AppMessage|Timeline)\s*\(/.test(fs.readFileSync(filePath, 'utf8')))
  .map((filePath) => path.relative(repoRoot, filePath).replace(/\\/g, '/'))
  .sort()
assert.deepStrictEqual(
  pagesWithNativeShareHooks,
  ['pages/index/index.js', 'pages/shared-video/shared-video.js'],
  '不得给首页和既有共享视频页以外的私有页面新增系统分享钩子'
)

const detailSource = fs.readFileSync(detailPath, 'utf8')
assert(detailSource.includes("menus: ['shareAppMessage', 'shareTimeline']"), '详情页必须继续隐藏好友与朋友圈分享菜单')
assert(/onLoad\([\s\S]*?this\.hideNativeShareMenu\(\)/.test(detailSource), '详情页加载时必须继续执行 hideShareMenu 门禁')
assert(detailSource.includes('wx.shareVideoMessage'), '详情页原视频转发能力不得移除')
assert(detailSource.includes('wx.saveVideoToPhotosAlbum'), '详情页保存相册能力不得移除')
assert(fs.readFileSync(sharedVideoPath, 'utf8').includes('onShareAppMessage()'), '既有共享视频页转发钩子不得误删')

let detailDefinition = null
const originalPage = global.Page
const originalWx = global.wx
try {
  global.Page = (value) => { detailDefinition = value }
  delete require.cache[require.resolve(detailPath)]
  require(detailPath)
  assert.ok(detailDefinition, '必须捕获房源详情页定义')
  const detailPage = Object.assign({}, detailDefinition, {
    data: JSON.parse(JSON.stringify(detailDefinition.data || {})),
    setData(patch) {
      this.data = Object.assign({}, this.data, patch || {})
    },
    bindAuthInvalidationListener() {},
    loadListing() {}
  })
  const hiddenMenus = []
  global.wx = {
    hideShareMenu(options) { hiddenMenus.push(options) },
    showShareMenu() { throw new Error('详情页不得打开系统分享菜单') }
  }
  detailPage.onLoad({ id: 'DETAIL-SHARE-GUARD' })
  detailPage.onShow()
  assert.deepStrictEqual(
    hiddenMenus,
    [
      { menus: ['shareAppMessage', 'shareTimeline'] },
      { menus: ['shareAppMessage', 'shareTimeline'] }
    ],
    '房源详情 onLoad/onShow 必须真实执行两次 hideShareMenu，不能只保留源码字符串'
  )
} finally {
  global.Page = originalPage
  global.wx = originalWx
}

console.log('home-share-boundary-v1-test passed')
