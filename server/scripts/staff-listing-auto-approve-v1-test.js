const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const domain = require('../src/domain')
const mockData = require('../../utils/mock-data')
const uploadSource = fs.readFileSync(path.join(repoRoot, 'pages', 'upload', 'upload.js'), 'utf8')
const uploadWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'upload', 'upload.wxml'), 'utf8')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const uploadPagePath = require.resolve(path.join(repoRoot, 'pages', 'upload', 'upload.js'))

function makeDb() {
  return {
    users: [
      { id: 'STAFF', name: '测试员工', role: '内部员工', accountType: 'staff', isAdmin: false, authed: '手机号登录' },
      { id: 'LEGACY_STAFF', name: '存量员工', role: '内部员工', isAdmin: false, authed: '手机号登录' },
      { id: 'BROKER', name: '测试中介', role: '中介', accountType: 'broker', isAdmin: false, authed: '手机号登录' },
      { id: 'CONFLICT', name: '冲突账号', role: '内部员工', accountType: 'broker', isAdmin: false, authed: '手机号登录' },
      { id: 'UNKNOWN_TYPE', name: '未知类型账号', role: '内部员工', accountType: 'legacy-import', isAdmin: false, authed: '手机号登录' },
      { id: 'ADMIN', name: '测试管理员', role: '管理员', isAdmin: true, authed: '手机号登录' }
    ],
    listings: [],
    rentalNeeds: [],
    footprints: [],
    pointLogs: [],
    commissionRecords: [],
    clientReports: [],
    dealRecords: []
  }
}

function listingPayload(suffix, overrides = {}) {
  const roomNumber = String(suffix)
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '半山',
    communityName: '半山家苑',
    community: '半山家苑',
    building: '1',
    unit: '1',
    roomNumber,
    address: `杭州拱墅区半山家苑1栋1单元${roomNumber}室`,
    contact: '13900001111',
    rent: 3200,
    layout: '整租两室1厅1卫',
    rentMode: '整租',
    room: '两室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯'],
    videoKey: `house-videos/staff-policy/${roomNumber}.mp4`,
    viewingMethod: '联系房东',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    ...overrides
  }
}

function rawListing(db, id) {
  return db.listings.find((item) => item.id === id)
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

function loadUploadPage(apiStub, modalLog) {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: apiStub
  }
  global.getApp = () => ({ globalData: { authToken: 'synthetic-staff-token' } })
  global.wx = {
    getStorageSync() { return 'synthetic-staff-token' },
    showLoading() {},
    hideLoading() {},
    showToast() {},
    showModal(options) { modalLog.push(options) },
    navigateTo() {},
    redirectTo() {}
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[uploadPagePath]
  require(uploadPagePath)
  assert.ok(definition, '必须捕获上传页定义')
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  return page
}

function assertAutoApproved(db, listing, label) {
  const raw = rawListing(db, listing.id)
  assert.ok(raw, `${label}必须落库`)
  assert.strictEqual(raw.status, '待确认', `${label}业务状态必须直接进入待确认`)
  assert.strictEqual(raw.reviewStatus, '已通过', `${label}审核状态必须直接通过`)
  assert.strictEqual(raw.reviewNote, '内部员工上传，按员工权限自动通过', `${label}必须留下员工策略自动通过说明`)
  assert.ok(raw.reviewedAt && raw.reviewerId, `${label}必须沿用审核字段留下时间与执行账号`)
  assert.ok(domain.filterListings(db).some((item) => item.id === raw.id), `${label}必须立即进入前台有效房源池`)
  return raw
}

const db = makeDb()

const managedStaff = domain.createManagedUser(db, {
  type: 'staff',
  name: '后台新建员工',
  phone: '13900009999',
  source: 'synthetic-test'
})
const managedStaffOwner = domain.addNormalListing(db, managedStaff.id, listingPayload('9100', {
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  source: '业主房源'
}))
assertAutoApproved(db, managedStaffOwner, '后台真实创建路径生成的员工上传业主房源')

const staffOwner = domain.addNormalListing(db, 'STAFF', listingPayload('9101', {
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  source: '业主房源'
}))
assertAutoApproved(db, staffOwner, '员工上传业主房源')

const staffSecondLandlord = domain.addNormalListing(db, 'STAFF', listingPayload('9102'))
assertAutoApproved(db, staffSecondLandlord, '员工上传二房东房源')

const staffOutsideCommunity = domain.addNormalListing(db, 'LEGACY_STAFF', listingPayload('9103', {
  communityName: '测试库外小区甲',
  community: '测试库外小区甲',
  address: '杭州拱墅区测试库外小区甲1栋1单元9103室',
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  source: '业主房源'
}))
const staffOutsideRaw = assertAutoApproved(db, staffOutsideCommunity, '存量员工上传库外业主房源')
assert.strictEqual(staffOutsideRaw.communityMatched, false, '员工免审不能伪造小区库匹配结果')
assert.strictEqual(staffOutsideRaw.requiresManualReview, true, '员工免审仍须保留库外小区风险标记供坐标补充')

domain.updateNormalListing(db, 'STAFF', staffOwner.id, {
  communityName: '测试库外小区乙',
  community: '测试库外小区乙',
  address: '杭州拱墅区测试库外小区乙1栋1单元9101室',
  rent: 3300
})
assertAutoApproved(db, staffOwner, '员工编辑自己的合作房源')

domain.updateNormalListing(db, 'ADMIN', staffOwner.id, { rent: 3400 }, { admin: true })
assertAutoApproved(db, staffOwner, '管理员编辑员工自动通过房源')

const legacyPending = domain.addNormalListing(db, 'BROKER', listingPayload('9104', {
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  source: '业主房源'
}))
rawListing(db, legacyPending.id).uploaderId = 'STAFF'
domain.updateNormalListing(db, 'STAFF', legacyPending.id, { rent: 3500 })
assertAutoApproved(db, legacyPending, '员工本人编辑历史待审核合作房源')

const brokerOwner = domain.addNormalListing(db, 'BROKER', listingPayload('9201', {
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  source: '业主房源',
  role: '内部员工',
  accountType: 'staff',
  isAdmin: true,
  uploaderId: 'STAFF',
  status: '待确认',
  reviewStatus: '已通过',
  reviewNote: '内部员工上传，按员工权限自动通过'
}))
const brokerOwnerRaw = rawListing(db, brokerOwner.id)
assert.strictEqual(brokerOwnerRaw.uploaderId, 'BROKER', '上传人必须来自服务端当前登录用户')
assert.strictEqual(brokerOwnerRaw.status, '待审核', '普通中介上传业主房源仍须待审核')
assert.strictEqual(brokerOwnerRaw.reviewStatus, '待审核', '请求体伪造审核状态不得生效')
assert.notStrictEqual(brokerOwnerRaw.reviewNote, '内部员工上传，按员工权限自动通过', '普通中介不得伪造员工自动通过说明')
assert.ok(!domain.filterListings(db).some((item) => item.id === brokerOwnerRaw.id), '普通中介待审核业主房源不得进入前台')

const brokerOutside = domain.addNormalListing(db, 'BROKER', listingPayload('9202', {
  communityName: '测试库外小区丙',
  community: '测试库外小区丙',
  address: '杭州拱墅区测试库外小区丙1栋1单元9202室'
}))
assert.strictEqual(rawListing(db, brokerOutside.id).reviewStatus, '待审核', '普通中介库外二房东房源仍须待审核')

const conflictOwner = domain.addNormalListing(db, 'CONFLICT', listingPayload('9203', {
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  source: '业主房源'
}))
assert.strictEqual(rawListing(db, conflictOwner.id).reviewStatus, '待审核', 'accountType=broker 与员工角色冲突时必须按中介权限收紧')

const unknownTypeOwner = domain.addNormalListing(db, 'UNKNOWN_TYPE', listingPayload('9204', {
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  source: '业主房源'
}))
assert.strictEqual(rawListing(db, unknownTypeOwner.id).reviewStatus, '待审核', '非空未知 accountType 不得仅凭员工角色获得直通权限')

mockData.loginByPhone('13800010005')
const mockStaffOwner = mockData.addNormalListing(listingPayload('9301', {
  ownerType: '业主房源',
  houseSourceType: '业主房源',
  source: '业主房源'
}))
assert.strictEqual(mockStaffOwner.reviewStatus, '已通过', 'Mock 员工上传业主房源必须与真实后端一致')
assert.strictEqual(mockStaffOwner.status, '待确认', 'Mock 员工房源业务状态必须与真实后端一致')

async function runUploadPageChecks() {
  assert.ok(/isStaff:\s*false/.test(uploadSource), '上传页必须维护员工展示态')
  assert.ok(/reviewStatus\s*===\s*['"]已通过['"]/.test(uploadSource), '上传成功提示必须以服务端回包审核状态为准')
  assert.ok(/isStaff/.test(uploadWxml) && /直接通过/.test(uploadWxml), '上传页必须向员工明确展示合作房源直接通过')
  ;['role', 'accountType', 'isAdmin', 'uploaderId', 'status', 'reviewStatus', 'reviewNote'].forEach((field) => {
    const payloadBlock = uploadSource.match(/buildSubmitPayload\([\s\S]*?\n\s*}\s*,\n\s*\n\s*async submitWithVideo/)?.[0] || ''
    assert.ok(!new RegExp(`\\b${field}\\s*:`).test(payloadBlock), `客户端提交体不得包含权限或审核字段：${field}`)
  })

  const approvedModals = []
  let approvedPayload = null
  const approvedPage = loadUploadPage({
    getCurrentUser: async () => ({ id: 'STAFF', role: '内部员工', accountType: 'staff', isAdmin: false }),
    addNormalListing: async (payload) => {
      approvedPayload = payload
      return { id: 'L-APPROVED', status: '待确认', reviewStatus: '已通过' }
    }
  }, approvedModals)
  await approvedPage.loadCurrentUser()
  assert.strictEqual(approvedPage.data.isStaff, true, '服务端返回员工账号后页面必须显示员工直通口径')
  await approvedPage.submitWithVideo({
    address: '杭州拱墅区半山家苑1栋1单元9401室',
    layout: '整租两室1厅1卫',
    communityMatched: true,
    communityMatchStatus: '已匹配',
    needsManualReview: false,
    manualReviewReason: ''
  })
  assert.ok(approvedPayload, '上传页必须真实调用新增房源接口')
  ;['role', 'accountType', 'isAdmin', 'uploaderId', 'status', 'reviewStatus', 'reviewNote'].forEach((field) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(approvedPayload, field), `真实提交体不得包含权限或审核字段：${field}`)
  })
  const approvedModal = approvedModals.find((item) => item.title === '上传成功')
  assert.ok(approvedModal && /直接通过并发布/.test(approvedModal.content), '服务端回包已通过时必须提示已直接发布')

  const pendingModals = []
  const pendingPage = loadUploadPage({
    getCurrentUser: async () => ({ id: 'BROKER', role: '中介', accountType: 'broker', isAdmin: false }),
    addNormalListing: async () => ({ id: 'L-PENDING', status: '待审核', reviewStatus: '待审核' })
  }, pendingModals)
  await pendingPage.loadCurrentUser()
  assert.strictEqual(pendingPage.data.isStaff, false, '普通中介页面不得显示员工直通口径')
  await pendingPage.submitWithVideo({
    address: '杭州拱墅区半山家苑1栋1单元9402室',
    layout: '整租两室1厅1卫',
    communityMatched: true,
    communityMatchStatus: '已匹配',
    needsManualReview: false,
    manualReviewReason: ''
  })
  const pendingModal = pendingModals.find((item) => item.title === '上传成功')
  assert.ok(pendingModal && /提交审核/.test(pendingModal.content), '服务端回包待审核时必须提示等待审核')
}

runUploadPageChecks()
  .then(() => console.log('staff-listing-auto-approve-v1-test passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
