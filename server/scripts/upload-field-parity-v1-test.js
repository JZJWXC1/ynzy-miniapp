const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
const uploadPagePath = require.resolve(path.join(repoRoot, 'pages', 'upload', 'upload.js'))
const uploadWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'upload', 'upload.wxml'), 'utf8')
const domain = require(path.join(repoRoot, 'server', 'src', 'domain.js'))

global.getApp = () => ({ globalData: { authToken: 'test-token' } })
global.wx = {
  getStorageSync() { return 'test-token' },
  showToast() {},
  showModal() {}
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

function loadUploadPage() {
  require.cache[apiServicePath] = {
    id: apiServicePath,
    filename: apiServicePath,
    loaded: true,
    exports: {}
  }
  let definition = null
  global.Page = (value) => { definition = value }
  delete require.cache[uploadPagePath]
  require(uploadPagePath)
  assert.ok(definition, '未捕获上传页面定义')
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  return page
}

function validClientForm(overrides = {}) {
  return {
    city: '杭州',
    area: '拱墅区',
    block: '东新园',
    community: '皋塘运都',
    building: '3',
    unit: '',
    roomNumber: '502',
    contact: '13800001111',
    remark: '',
    landlordCommissionPercent: 50,
    rent: '3500',
    rentMode: '整租',
    room: '二室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯'],
    companyListing: false,
    ownerType: '二房东房源',
    viewingMethod: '联系房东',
    viewingKeyLocation: '',
    viewingPassword: '',
    ...overrides
  }
}

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '上传人', role: '中介', authed: '已实名' }
    ],
    listings: [],
    footprints: [],
    pointLogs: [],
    rentalNeeds: []
  }
}

function validServerForm(overrides = {}) {
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新园',
    community: '皋塘运都',
    building: '3',
    unit: '',
    roomNumber: '502',
    contact: '13800001111',
    rent: 3500,
    rentMode: '整租',
    room: '二室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯'],
    videoUrl: 'https://example.test/listing.mp4',
    videoKey: 'listing.mp4',
    viewingMethod: '联系房东',
    ...overrides
  }
}

const page = loadUploadPage()
page.setData({
  form: validClientForm(),
  videoPath: 'wxfile://listing.mp4',
  videoFile: { tempFilePath: 'wxfile://listing.mp4', fileName: 'listing.mp4', size: 1024 },
  commissionConfigReady: true
})
const noUnitValidation = page.validateForm()
assert.strictEqual(noUnitValidation.ok, true, '无单元楼栋必须允许上传，前端不得强制“几单元”')

page.setData({ form: validClientForm({ contact: '12345', unit: '1' }) })
const invalidPhoneValidation = page.validateForm()
assert.strictEqual(invalidPhoneValidation.ok, false, '联系房东时前端必须拒绝非法手机号')
assert.ok(/11 位|手机号/.test(invalidPhoneValidation.message), '非法手机号提示必须明确')

page.setData({ form: validClientForm({ block: ' 东新园 ' }) })
const payload = page.buildSubmitPayload(noUnitValidation, null)
assert.strictEqual(payload.block, '东新园', '客户端必须提交用户填写并去空格的板块，不得用行政区冒充')
assert.strictEqual(payload.unit, '', '可选单元留空时客户端必须保持空值')
;['isAdmin', 'uploaderId', 'commissionRate', 'uploaderRate', 'platformRate'].forEach((field) => {
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, field), `客户端不得提交权限/分佣字段：${field}`)
})
assert.strictEqual(payload.landlordCommissionPercent, 50, '客户端应提交房东佣金占月租比例这一业务输入')
assert.strictEqual(payload.remark, '', '客户端应提交规范化备注')

const db = makeDb()
domain.addNormalListing(db, 'U1', validServerForm({ block: ' 东新园 ', unit: '' }))
assert.strictEqual(db.listings[0].unit, '', '服务端必须接受合法空单元')
assert.strictEqual(db.listings[0].block, '东新园', '服务端必须规范化并落库真实板块')
assert.strictEqual(domain.filterListings(db, { block: '东新园' }).length, 1, '手工上传房源必须能按真实板块筛选')

assert.throws(
  () => domain.addNormalListing(makeDb(), 'U1', validServerForm({ contact: '12345' })),
  (error) => error && error.statusCode === 400 && /11 位|手机号/.test(error.message),
  '服务端必须拒绝非法房东手机号，不能只依赖前端'
)

const keyDb = makeDb()
domain.addNormalListing(keyDb, 'U1', validServerForm({
  contact: '13911112222',
  viewingMethod: '钥匙',
  viewingKeyLocation: '前台领取'
}))
assert.strictEqual(keyDb.listings[0].landlordPhone, '13911112222', '钥匙方式也必须保存房东手机号')
assert.throws(
  () => domain.addNormalListing(makeDb(), 'U1', validServerForm({ contact: '', viewingMethod: '钥匙', viewingKeyLocation: '前台领取' })),
  (error) => error && error.statusCode === 400 && /房东手机号/.test(error.message),
  '钥匙方式缺房东手机号也必须由服务端拒绝'
)

assert.ok(/板块（可选）/.test(uploadWxml), '上传页必须提供可选板块输入')
assert.ok(/几单元（可选）/.test(uploadWxml), '上传页必须明确单元可选')
assert.ok(/data-field="contact"[^>]*type="number"[^>]*maxlength="11"/.test(uploadWxml), '房东手机号输入必须限制数字和 11 位')
assert.ok(/data-field="landlordCommissionPercent"/.test(uploadWxml), '上传页必须提供房东佣金占月租比例输入')
assert.ok(/data-field="remark"/.test(uploadWxml), '上传页必须提供房源备注输入')

console.log('upload-field-parity-v1-test passed')
