const assert = require('assert')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const detailPagePath = require.resolve(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js'))
const uploadPagePath = require.resolve(path.join(repoRoot, 'pages', 'upload', 'upload.js'))
const authPagePath = require.resolve(path.join(repoRoot, 'pages', 'auth', 'auth.js'))
const changePasswordPagePath = require.resolve(path.join(repoRoot, 'pages', 'change-password', 'change-password.js'))

let authToken = ''
let authSessionKey = ''

global.getApp = () => ({
  globalData: { authToken, authSessionKey }
})

global.wx = {
  hideShareMenu() {},
  showToast() {},
  showModal() {},
  showLoading() {},
  hideLoading() {},
  navigateTo() {},
  navigateBack() {},
  redirectTo() {},
  switchTab() {},
  chooseMedia() {},
  getStorageSync() { return authToken }
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

function installApiStub(stub) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: stub
  }
}

function loadPage(pagePath) {
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[pagePath]
  require(pagePath)
  assert.ok(definition, `未捕获页面定义：${pagePath}`)
  return definition
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function validCommissionConfig() {
  return {
    secondLandlordRate: 20,
    ownerRate: 20,
    secondLandlordPlatformRate: 10,
    ownerPlatformRate: 10
  }
}

function editableListing(owner) {
  return {
    id: 'L-UPLOAD-RACE',
    city: '杭州',
    district: '拱墅区',
    community: `${owner}小区`,
    building: '1',
    roomNumber: '101',
    contact: owner === 'A' ? '13900000001' : '13900000002',
    remark: `${owner}-SENSITIVE-REMARK`,
    landlordCommissionPercent: 50,
    rent: 3000,
    rentMode: '整租',
    room: '一室',
    hall: '0厅',
    bath: '公卫',
    features: ['无'],
    ownerType: '二房东房源',
    viewingMethod: '密码',
    viewingKeyLocation: `${owner}-KEY-LOCATION`,
    viewingPassword: `${owner}-VIEWING-PASSWORD`,
    videoUrl: `https://example.test/${owner.toLowerCase()}.mp4`,
    videoKey: `house-videos/${owner.toLowerCase()}.mp4`
  }
}

async function testUploadProfileRace() {
  const profileRequests = []
  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_A'
  installApiStub({
    getCurrentUser() {
      const request = deferred()
      profileRequests.push({ sessionKey: authSessionKey, ...request })
      return request.promise
    },
    getCommissionConfig() { return Promise.resolve(validCommissionConfig()) },
    getEditableListing() { return Promise.reject(new Error('本用例不进入编辑态')) }
  })

  const uploadPage = makePage(loadPage(uploadPagePath))
  uploadPage.onLoad({})
  assert.strictEqual(profileRequests.length, 1, 'A 首次进入必须发起一条 profile 请求')

  authToken = 'TOKEN_B'
  authSessionKey = 'SESSION_B'
  uploadPage.onShow()
  assert.strictEqual(profileRequests.length, 2, '切到 B 后必须重新读取 B 的 profile')

  profileRequests[1].resolve({ id: 'U-B', name: 'B 用户', isAdmin: false })
  await flushPromises()
  assert.strictEqual(uploadPage.data.currentUser.id, 'U-B')

  profileRequests[0].resolve({ id: 'U-A', name: 'A 用户', isAdmin: true })
  await flushPromises()
  assert.strictEqual(uploadPage.data.currentUser.id, 'U-B', 'A 的迟到 profile 不得覆盖 B')
  assert.strictEqual(uploadPage.data.isAdmin, false, 'A 的管理员标记不得泄漏到 B')
}

async function testUploadEditableRaceAndReset() {
  const editRequests = []
  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_A'
  installApiStub({
    getCurrentUser() {
      return Promise.resolve({ id: authSessionKey === 'SESSION_A' ? 'U-A' : 'U-B', isAdmin: false })
    },
    getCommissionConfig() { return Promise.resolve(validCommissionConfig()) },
    getEditableListing() {
      const request = deferred()
      editRequests.push({ sessionKey: authSessionKey, ...request })
      return request.promise
    }
  })

  const uploadPage = makePage(loadPage(uploadPagePath))
  uploadPage.onLoad({ id: 'L-UPLOAD-RACE' })
  editRequests[0].resolve(editableListing('A'))
  await flushPromises()
  assert.strictEqual(uploadPage.data.form.contact, '13900000001')
  assert.strictEqual(uploadPage.data.form.viewingPassword, 'A-VIEWING-PASSWORD')

  authToken = 'TOKEN_B'
  authSessionKey = 'SESSION_B'
  uploadPage.onShow()
  assert.strictEqual(uploadPage.data.form.contact, '', '换号时必须立即清除 A 的电话')
  assert.strictEqual(uploadPage.data.form.remark, '', '换号时必须立即清除 A 的备注')
  assert.strictEqual(uploadPage.data.form.viewingKeyLocation, '', '换号时必须立即清除 A 的钥匙位置')
  assert.strictEqual(uploadPage.data.form.viewingPassword, '', '换号时必须立即清除 A 的看房密码')
  assert.strictEqual(uploadPage.data.existingVideoUrl, '', '换号时必须立即清除 A 的视频地址')
  assert.strictEqual(uploadPage.data.existingVideoKey, '', '换号时必须立即清除 A 的视频对象键')
  assert.strictEqual(editRequests.length, 2, '编辑态换号后必须用 B 重新读取同一房源')
  editRequests[1].resolve(editableListing('B'))
  await flushPromises()
  assert.strictEqual(uploadPage.data.form.contact, '13900000002')
  assert.strictEqual(uploadPage.data.form.viewingPassword, 'B-VIEWING-PASSWORD')

  // 再锁定真正的乱序：B 先回、A 后回时，A 也不能复写 B 的敏感表单。
  const lateRequests = []
  authToken = 'TOKEN_A'
  authSessionKey = 'SESSION_A'
  installApiStub({
    getCurrentUser() {
      return Promise.resolve({ id: authSessionKey === 'SESSION_A' ? 'U-A' : 'U-B', isAdmin: false })
    },
    getCommissionConfig() { return Promise.resolve(validCommissionConfig()) },
    getEditableListing() {
      const request = deferred()
      lateRequests.push({ sessionKey: authSessionKey, ...request })
      return request.promise
    }
  })
  const latePage = makePage(loadPage(uploadPagePath))
  latePage.onLoad({ id: 'L-UPLOAD-RACE' })
  authToken = 'TOKEN_B'
  authSessionKey = 'SESSION_B'
  latePage.onShow()
  assert.strictEqual(lateRequests.length, 2, 'A 编辑请求在途时切 B，也必须发起 B 重读')
  lateRequests[1].resolve(editableListing('B'))
  await flushPromises()
  lateRequests[0].resolve(editableListing('A'))
  await flushPromises()
  assert.strictEqual(latePage.data.form.contact, '13900000002', 'A 的迟到编辑详情不得覆盖 B')
  assert.strictEqual(latePage.data.form.remark, 'B-SENSITIVE-REMARK')
}

async function testUploadSubmitAccountSwitch() {
  for (const mode of ['create', 'edit']) {
    const uploadResult = deferred()
    let createCalls = 0
    let updateCalls = 0
    authToken = `TOKEN_A_${mode}`
    authSessionKey = `SESSION_A_${mode}`
    installApiStub({
      createVideoUploadPolicy() {
        return Promise.resolve({ maxSize: 10 * 1024 * 1024 })
      },
      uploadVideo() { return uploadResult.promise },
      addNormalListing() {
        createCalls += 1
        return Promise.resolve({ id: 'L-CREATED' })
      },
      updateNormalListing() {
        updateCalls += 1
        return Promise.resolve({ id: 'L-UPDATED' })
      }
    })

    const uploadPage = makePage(loadPage(uploadPagePath))
    uploadPage.data.mode = mode
    uploadPage.data.listingId = mode === 'edit' ? 'L-UPLOAD-RACE' : ''
    uploadPage.data.form = {
      ...uploadPage.data.form,
      community: '合成小区',
      building: '1',
      roomNumber: '101',
      contact: '13900000001',
      rent: 3000,
      features: ['无'],
      viewingMethod: '联系房东'
    }
    uploadPage.data.videoPath = '/tmp/synthetic.mp4'
    uploadPage.data.videoFile = { tempFilePath: '/tmp/synthetic.mp4', fileName: 'synthetic.mp4', size: 1024 }
    const pending = uploadPage.submitWithVideo({
      address: '杭州拱墅区合成小区1栋101室',
      layout: '整租一室0厅公卫',
      communityMatched: true,
      communityMatchStatus: '已匹配',
      needsManualReview: false,
      manualReviewReason: ''
    })
    await flushPromises()

    authToken = `TOKEN_B_${mode}`
    authSessionKey = `SESSION_B_${mode}`
    uploadResult.resolve({
      fileUrl: 'https://example.test/synthetic.mp4',
      objectKey: 'house-videos/synthetic.mp4'
    })
    await pending
    assert.strictEqual(createCalls, 0, `${mode}：A 上传期间切 B 后不得以 B 新建房源`)
    assert.strictEqual(updateCalls, 0, `${mode}：A 上传期间切 B 后不得以 B 更新房源`)
  }

  // 同账号 A→A′ 后，旧 A 写请求的 401 只允许提示人工重试；不得误导重新登录，更不能自动重放。
  authToken = 'TOKEN_A_REFRESHED'
  authSessionKey = 'SESSION_A_STABLE'
  let staleWriteCalls = 0
  let loginPromptCalls = 0
  installApiStub({
    addNormalListing() {
      staleWriteCalls += 1
      return Promise.reject(Object.assign(new Error('旧 token 迟到 401'), {
        statusCode: 401,
        authResponseStale: true
      }))
    }
  })
  const staleWritePage = makePage(loadPage(uploadPagePath))
  staleWritePage.promptLoginGuide = () => { loginPromptCalls += 1 }
  staleWritePage.data.form = {
    ...staleWritePage.data.form,
    community: '合成小区',
    building: '1',
    roomNumber: '101',
    contact: '13900000001',
    rent: 3000,
    features: ['无'],
    viewingMethod: '联系房东'
  }
  await staleWritePage.submitWithVideo({
    address: '杭州拱墅区合成小区1栋101室',
    layout: '整租一室0厅公卫',
    communityMatched: true,
    communityMatchStatus: '已匹配',
    needsManualReview: false,
    manualReviewReason: ''
  })
  assert.strictEqual(staleWriteCalls, 1, '旧 401 的写请求只能执行原始一次，不能自动重放')
  assert.strictEqual(loginPromptCalls, 0, '同 session 已续签时不得误提示重新登录')
}

async function testChangePasswordUnloadFailure() {
  const changePasswordResult = deferred()
  const originalShowModal = wx.showModal
  let modalCalls = 0
  authToken = 'TOKEN_CHANGE_PASSWORD'
  authSessionKey = 'SESSION_CHANGE_PASSWORD'
  installApiStub({
    changePassword() { return changePasswordResult.promise }
  })
  wx.showModal = () => { modalCalls += 1 }

  try {
    const changePasswordPage = makePage(loadPage(changePasswordPagePath))
    changePasswordPage.onLoad()
    changePasswordPage.data.form = {
      oldPassword: 'old-password',
      newPassword: 'new-password-1',
      confirmPassword: 'new-password-1'
    }
    changePasswordPage.submit()
    changePasswordPage.onUnload()
    changePasswordResult.reject(new Error('synthetic late failure'))
    await flushPromises()
    await flushPromises()
    assert.strictEqual(modalCalls, 0, '改密页卸载后，同一登录会话的迟到失败也不得弹窗')
  } finally {
    wx.showModal = originalShowModal
  }
}

async function testAuthPrefillDoesNotOverwriteEdits() {
  const currentUserResult = deferred()
  authToken = 'TOKEN_AUTH_PREFILL'
  authSessionKey = 'SESSION_AUTH_PREFILL'
  installApiStub({
    getCurrentUser() { return currentUserResult.promise }
  })

  const authPage = makePage(loadPage(authPagePath))
  authPage.onLoad()
  authPage.updateField({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '手工输入姓名' } })
  authPage.updateField({ currentTarget: { dataset: { field: 'phone' } }, detail: { value: '13900000088' } })
  currentUserResult.resolve({ id: 'U-OLD', name: '旧账号姓名', phone: '13900000001' })
  await flushPromises()
  assert.strictEqual(authPage.data.form.name, '手工输入姓名', '登录页用户编辑姓名后，旧预填响应不得覆盖输入')
  assert.strictEqual(authPage.data.form.phone, '13900000088', '登录页用户编辑手机号后，旧预填响应不得覆盖输入')
}

async function run() {
  const selectedCase = String(process.env.MINI_PAGE_RESUME_CASE || '').trim()
  if (selectedCase) {
    const cases = {
      'upload-profile-race': testUploadProfileRace,
      'upload-edit-race': testUploadEditableRaceAndReset,
      'upload-submit-switch': testUploadSubmitAccountSwitch,
      'change-password-unload': testChangePasswordUnloadFailure,
      'auth-prefill-dirty': testAuthPrefillDoesNotOverwriteEdits
    }
    assert.ok(cases[selectedCase], `未知 MINI_PAGE_RESUME_CASE：${selectedCase}`)
    await cases[selectedCase]()
    console.log(`mini-page-resume-state-v1-test ${selectedCase} passed`)
    return
  }

  let detailLoads = 0
  let profileLoads = 0
  authToken = ''
  installApiStub({
    getListingDetail() {
      detailLoads += 1
      return Promise.resolve({
        id: 'L-RESUME',
        title: '恢复态测试房源',
        videoUrl: 'https://example.test/resume.mp4',
        companyListing: false,
        ownListing: false
      })
    },
    getListingLogs() { return Promise.resolve([]) },
    getProfileState() {
      profileLoads += 1
      return Promise.resolve({
        user: authToken
          ? { id: 'U-RESUME', name: '恢复态中介', role: '中介', authed: '已实名' }
          : {}
      })
    }
  })
  const detailDefinition = loadPage(detailPagePath)
  const detailPage = makePage(detailDefinition)
  detailPage.onLoad({ id: 'L-RESUME' })
  await flushPromises()
  assert.strictEqual(detailLoads, 1, '详情页首次展示只应加载一次')
  assert.strictEqual(profileLoads, 1, '详情页首次展示只应读取一次登录态')
  assert.strictEqual(detailPage.data.isVerified, false, '游客首次进入应保持未登录状态')

  authToken = 'token-after-login'
  detailPage.onShow()
  await flushPromises()
  assert.strictEqual(detailLoads, 2, '登录返回详情页必须重新读取房源和登录态')
  assert.strictEqual(profileLoads, 2, '登录返回详情页必须重新读取当前用户')
  assert.strictEqual(detailPage.data.isVerified, true, '登录返回后敏感查看与带看能力必须立即解锁')
  assert.strictEqual(detailPage.data.canShareVideo, true, '登录返回后视频转发能力必须立即更新')

  let currentUserLoads = 0
  authToken = ''
  installApiStub({
    getCurrentUser() {
      currentUserLoads += 1
      if (!authToken) {
        const error = new Error('未登录')
        error.statusCode = 401
        return Promise.reject(error)
      }
      return Promise.resolve({ id: 'U-ADMIN', name: '管理员', isAdmin: true })
    },
    getCommissionConfig() { return Promise.resolve({}) },
    getEditableListing() { return Promise.reject(new Error('本用例不进入编辑态')) }
  })
  const uploadDefinition = loadPage(uploadPagePath)
  const uploadPage = makePage(uploadDefinition)
  uploadPage.promptLoginGuide = () => {}
  uploadPage.onLoad({})
  await flushPromises()
  assert.strictEqual(currentUserLoads, 1, '上传页首次展示只应读取一次当前用户')
  assert.strictEqual(uploadPage.data.isAdmin, false, '游客首次进入上传页不应拥有管理员能力')

  authToken = 'admin-token-after-login'
  assert.strictEqual(typeof uploadPage.onShow, 'function', '上传页必须在返回前台时检查登录态变化')
  uploadPage.onShow()
  await flushPromises()
  assert.strictEqual(currentUserLoads, 2, '登录返回上传页必须重新读取当前用户')
  assert.strictEqual(uploadPage.data.isAdmin, true, '管理员登录返回后必须能选择公司房源')

  assert.strictEqual(typeof detailDefinition.startReportDeal, 'undefined', '暂停期间详情页不得保留报备/签单可达方法')

  await testUploadProfileRace()
  await testUploadEditableRaceAndReset()
  await testUploadSubmitAccountSwitch()
  await testChangePasswordUnloadFailure()
  await testAuthPrefillDoesNotOverwriteEdits()

  console.log('mini-page-resume-state-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
