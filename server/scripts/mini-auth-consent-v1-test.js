const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = process.env.YNZY_TEST_REPO_ROOT
  ? path.resolve(process.env.YNZY_TEST_REPO_ROOT)
  : path.resolve(__dirname, '..', '..')
const authPagePath = require.resolve(path.join(repoRoot, 'pages', 'auth', 'auth.js'))
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client.js'))

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function setAtPath(target, key, value) {
  const parts = key.split('.')
  let current = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current[parts[index]] || typeof current[parts[index]] !== 'object') current[parts[index]] = {}
    current = current[parts[index]]
  }
  current[parts[parts.length - 1]] = value
}

function makePage(definition) {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  return page
}

function installModuleStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  }
}

function restoreGlobal(name, value, existed) {
  if (existed) global[name] = value
  else delete global[name]
}

function pendingPromise() {
  return new Promise(() => {})
}

function loadAuthHarness() {
  const originalGlobals = {}
  ;['Page', 'wx', 'getApp', 'getCurrentPages'].forEach((name) => {
    originalGlobals[name] = {
      existed: Object.prototype.hasOwnProperty.call(global, name),
      value: global[name]
    }
  })
  const originalModules = new Map([
    [apiServicePath, require.cache[apiServicePath]],
    [apiClientPath, require.cache[apiClientPath]],
    [authPagePath, require.cache[authPagePath]]
  ])
  const calls = { login: [], register: [] }
  const toasts = []
  const navigations = []

  installModuleStub(apiServicePath, {
    loginByPhone(phone, password) {
      calls.login.push({ phone, password })
      return pendingPromise()
    },
    registerUser(payload) {
      calls.register.push(payload)
      return pendingPromise()
    },
    getCurrentUser() {
      return Promise.resolve(null)
    }
  })
  installModuleStub(apiClientPath, {
    getAuthToken() { return '' },
    getAuthSessionKey() { return '' }
  })

  global.getApp = () => ({ setCurrentUser() { return true } })
  global.getCurrentPages = () => []
  global.wx = {
    showToast(options) { toasts.push(options || {}) },
    showModal() {},
    navigateTo(options) { navigations.push(options || {}) },
    navigateBack() {},
    switchTab() {}
  }

  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[authPagePath]
  try {
    require(authPagePath)
  } finally {
    restoreGlobal('Page', originalGlobals.Page.value, originalGlobals.Page.existed)
  }
  assert.ok(definition, '未捕获登录注册页面定义')
  return {
    definition,
    calls,
    toasts,
    navigations,
    cleanup() {
      delete require.cache[authPagePath]
      originalModules.forEach((cached, modulePath) => {
        if (cached) require.cache[modulePath] = cached
        else delete require.cache[modulePath]
      })
      ;['wx', 'getApp', 'getCurrentPages'].forEach((name) => {
        restoreGlobal(name, originalGlobals[name].value, originalGlobals[name].existed)
      })
    }
  }
}

function validLoginForm() {
  return {
    name: '',
    phone: '13800010005',
    password: 'synthetic-login-password',
    confirmPassword: ''
  }
}

function validRegisterForm() {
  return {
    name: '合成注册用户',
    phone: '19900009999',
    password: 'synthetic-register-password',
    confirmPassword: 'synthetic-register-password'
  }
}

function assertBlockedWithoutConsent(mode, form) {
  const harness = loadAuthHarness()
  try {
    const page = makePage(harness.definition)
    page.onLoad()
    page.setData({ mode, form })
    assert.strictEqual(page.data.agreementsAccepted, false, `${mode} 必须默认未同意协议`)

    page.submit()

    assert.strictEqual(harness.calls.login.length, 0, `${mode} 未同意时不得调用登录接口`)
    assert.strictEqual(harness.calls.register.length, 0, `${mode} 未同意时不得调用注册接口`)
    assert.strictEqual(page.data.submitting, false, `${mode} 未同意时不得进入提交中状态`)
    assert.ok(
      harness.toasts.some((item) => /阅读.*同意.*用户服务协议.*隐私政策/.test(String(item.title || ''))),
      `${mode} 未同意时必须明确提示阅读并同意两份协议`
    )
    page.onUnload()
  } finally {
    harness.cleanup()
  }
}

function testExplicitConsentAndPayloads() {
  const loginHarness = loadAuthHarness()
  try {
    const loginPage = makePage(loginHarness.definition)
    loginPage.onLoad()
    loginPage.setData({ form: validLoginForm() })
    loginPage.onAgreementChange({ detail: { value: ['accepted'] } })
    assert.strictEqual(loginPage.data.agreementsAccepted, true, '用户主动勾选后才可记为已同意')
    loginPage.submit()
    loginPage.submit()
    assert.deepStrictEqual(loginHarness.calls.login, [{
      phone: validLoginForm().phone,
      password: validLoginForm().password
    }], '同意后的登录请求必须且只能调用一次，原参数不变，连点不得重复提交')
    assert.deepStrictEqual(loginHarness.calls.register, [], '登录不得误调用注册接口')
    loginPage.onUnload()
  } finally {
    loginHarness.cleanup()
  }

  const registerHarness = loadAuthHarness()
  try {
    const registerPage = makePage(registerHarness.definition)
    registerPage.onLoad()
    registerPage.setData({ mode: 'register', form: validRegisterForm() })
    registerPage.onAgreementChange({ detail: { value: ['accepted'] } })
    registerPage.submit()
    registerPage.submit()
    assert.deepStrictEqual(registerHarness.calls.register, [{
      name: validRegisterForm().name,
      phone: validRegisterForm().phone,
      password: validRegisterForm().password
    }], '同意后的注册请求必须且只能调用一次，且不得把同意状态混入业务参数，连点不得重复提交')
    assert.deepStrictEqual(registerHarness.calls.login, [], '注册不得误调用登录接口')
    registerPage.onUnload()
  } finally {
    registerHarness.cleanup()
  }

  const withdrawnHarness = loadAuthHarness()
  try {
    const withdrawnPage = makePage(withdrawnHarness.definition)
    withdrawnPage.onLoad()
    withdrawnPage.setData({ form: validLoginForm() })
    withdrawnPage.onAgreementChange({ detail: { value: ['accepted'] } })
    withdrawnPage.onAgreementChange({ detail: { value: [] } })
    withdrawnPage.submit()
    assert.strictEqual(withdrawnPage.data.agreementsAccepted, false, '取消勾选必须立即撤回本次提交授权')
    assert.strictEqual(withdrawnHarness.calls.login.length, 0, '取消勾选后必须重新阻断登录')
    withdrawnPage.onUnload()
  } finally {
    withdrawnHarness.cleanup()
  }
}

function testOpeningPoliciesDoesNotGrantConsent() {
  const harness = loadAuthHarness()
  try {
    const page = makePage(harness.definition)
    page.onLoad()
    assert.strictEqual(page.data.agreementsAccepted, false, '打开协议前必须保持默认未同意')
    page.openUserAgreement()
    assert.strictEqual(page.data.agreementsAccepted, false, '打开用户服务协议不得自动勾选')
    page.openPrivacyPolicy()
    assert.strictEqual(page.data.agreementsAccepted, false, '打开隐私政策不得自动勾选')
    assert.deepStrictEqual(harness.navigations.map((item) => item.url), [
      '/pages/user-agreement/user-agreement',
      '/pages/privacy-policy/privacy-policy'
    ], '两份协议必须分别进入已注册的独立页面')
    page.onUnload()
  } finally {
    harness.cleanup()
  }
}

function testStaticContracts() {
  const app = JSON.parse(read('app.json'))
  const expectedPages = [
    'pages/user-agreement/user-agreement',
    'pages/privacy-policy/privacy-policy'
  ]
  expectedPages.forEach((page) => {
    assert.ok((app.pages || []).includes(page), `${page} 必须注册到 app.json`)
    ;['.js', '.json', '.wxml', '.wxss'].forEach((extension) => {
      assert.ok(fs.existsSync(path.join(repoRoot, `${page}${extension}`)), `${page}${extension} 不存在`)
    })
  })

  const authWxml = read('pages/auth/auth.wxml')
  assert.ok(/checkbox-group[^>]+bindchange="onAgreementChange"/.test(authWxml), '登录注册页必须提供主动勾选控件')
  assert.ok(/checked="\{\{agreementsAccepted\}\}"/.test(authWxml), '勾选控件必须绑定默认未同意状态')
  assert.ok(/catchtap="openUserAgreement"/.test(authWxml), '登录注册页缺少阻止冒泡的《用户服务协议》入口')
  assert.ok(/catchtap="openPrivacyPolicy"/.test(authWxml), '登录注册页缺少阻止冒泡的《隐私政策》入口')
  assert.ok(authWxml.includes('《用户服务协议》') && authWxml.includes('《隐私政策》'), '两份协议名称必须对用户清晰可见')
  const checkboxGroup = authWxml.match(/<checkbox-group[\s\S]*?<\/checkbox-group>/)
  assert.ok(checkboxGroup, '登录注册页必须保留独立 checkbox-group')
  assert.ok(!/openUserAgreement|openPrivacyPolicy/.test(checkboxGroup[0]), '协议入口不得放进勾选标签内，避免点击链接顺带同意')
  assert.ok(!/getPhoneNumber|open-type="getPhoneNumber"/.test(`${read('pages/auth/auth.js')}\n${authWxml}`), '本整改不得引入手机号快捷获取敏感接口')

  const agreement = read('pages/user-agreement/user-agreement.wxml')
  const privacy = read('pages/privacy-policy/privacy-policy.wxml')
  ;[agreement, privacy].forEach((content) => {
    assert.ok(content.includes('杭州初寓网络科技有限公司'), '协议主体必须与用户确认的运营主体一致')
    assert.ok(content.includes('1176803465@qq.com'), '协议必须提供已确认的对外业务邮箱')
    assert.ok(content.includes('2026年7月20日'), '协议必须标明生效日期')
  })
  ;['手机号', '真实姓名', '您主动填写', '登录与账号注册审核', '保存期限', '账号存续期间', '软删除', '撤回同意', '房东手机号', '实时发送', '自动提交', '最近最多500条', '大模型技术服务商', '仅在本次运行内存', '不获取您的实时地理位置', '飞书'].forEach((keyword) => {
    assert.ok(privacy.includes(keyword), `隐私政策缺少必要披露：${keyword}`)
  })
  ;['房东手机号', '合法授权', '账号安全', '隐私政策'].forEach((keyword) => {
    assert.ok(agreement.includes(keyword), `用户服务协议缺少必要条款：${keyword}`)
  })
}

function run() {
  testStaticContracts()
  assertBlockedWithoutConsent('login', validLoginForm())
  assertBlockedWithoutConsent('register', validRegisterForm())
  testExplicitConsentAndPayloads()
  testOpeningPoliciesDoesNotGrantConsent()
  console.log('mini-auth-consent-v1-test passed')
}

run()
