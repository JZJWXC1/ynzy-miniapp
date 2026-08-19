const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const componentPath = path.join(__dirname, '..', '..', 'components', 'navigation-bar', 'navigation-bar.js')
const source = fs.readFileSync(componentPath, 'utf8')

function loadComponent(wxApi, pages = []) {
  let definition = null
  vm.runInNewContext(source, {
    wx: wxApi,
    getCurrentPages() {
      return pages
    },
    Component(value) {
      definition = value
    }
  }, { filename: componentPath })
  assert.ok(definition, '导航栏组件必须完成注册')
  return definition
}

const homeCalls = []
const homeEvents = []
const homeComponent = loadComponent({
  switchTab(options) {
    homeCalls.push(['switchTab', options.url])
  },
  reLaunch(options) {
    homeCalls.push(['reLaunch', options.url])
  }
})

assert.strictEqual(typeof homeComponent.methods.home, 'function', '导航栏必须实现模板绑定的 home 方法')
homeComponent.methods.home.call({
  triggerEvent(name, detail) {
    homeEvents.push({ name, detail })
  }
})
assert.deepStrictEqual(homeCalls, [['switchTab', '/pages/index/index']], '首页按钮必须切换到首页 Tab')
assert.strictEqual(homeEvents.length, 1, '首页按钮必须只触发一次 home 组件事件')
assert.strictEqual(homeEvents[0].name, 'home', '首页按钮组件事件名称必须为 home')

const backCalls = []
const backEvents = []
const backComponent = loadComponent({
  navigateBack(options) {
    backCalls.push(['navigateBack', options.delta])
  },
  switchTab(options) {
    backCalls.push(['switchTab', options.url])
  },
  reLaunch(options) {
    backCalls.push(['reLaunch', options.url])
  }
}, [{ route: 'pages/index/index' }, { route: 'pages/auth/auth' }])
backComponent.methods.back.call({
  data: { delta: 1 },
  triggerEvent(name, detail) {
    backEvents.push({ name, detail })
  }
})
assert.deepStrictEqual(backCalls, [['navigateBack', 1]], '普通页面的返回行为不得回退')
assert.strictEqual(backEvents[0].name, 'back', '返回按钮组件事件不得回退')

const fallbackCalls = []
const fallbackComponent = loadComponent({
  switchTab(options) {
    fallbackCalls.push(['switchTab', options.url])
    options.fail()
  },
  reLaunch(options) {
    fallbackCalls.push(['reLaunch', options.url])
  }
})
fallbackComponent.methods.home.call({ triggerEvent() {} })
assert.deepStrictEqual(fallbackCalls, [
  ['switchTab', '/pages/index/index'],
  ['reLaunch', '/pages/index/index']
], '首页 Tab 切换失败时必须安全重启到首页')

let legacySystemInfoReads = 0
const legacyComponent = loadComponent({
  getMenuButtonBoundingClientRect() {
    return { left: 300 }
  },
  getSystemInfoSync() {
    legacySystemInfoReads += 1
    return {
      platform: 'android',
      windowWidth: 375,
      safeArea: { top: 24, bottom: 780 }
    }
  }
})
let attachedData = null
assert.doesNotThrow(() => {
  legacyComponent.lifetimes.attached.call({
    setData(value) {
      attachedData = value
    }
  })
}, '仅有旧版系统信息 API 时导航栏仍必须正常挂载')
assert.strictEqual(legacySystemInfoReads, 1, '旧版系统信息只应读取一次')
assert.strictEqual(attachedData.ios, false, '旧版 Android 平台识别必须正确')
assert.strictEqual(attachedData.innerPaddingRight, 'padding-right: 75px', '旧版窗口宽度必须用于计算右侧安全间距')
assert.ok(attachedData.safeAreaTop.includes('24px'), '旧版安全区顶部必须用于导航栏布局')

console.log('navigation-bar-compat-v1-test passed')
