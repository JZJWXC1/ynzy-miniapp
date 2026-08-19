const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')

const AUTH_SECRET = 'pending-no-data-secret'

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

// 用与服务端同一 AUTH_TOKEN_SECRET 自签一枚合法 mini token（模拟账号被软删前已签发、仍在有效期内的旧 token）。
function signMiniToken(payload) {
  const encoded = base64url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

// 正面固化「待审核/未开通/无密码账号拿不到任何数据」：这些账号一律换不到 token，而无 token 访问
// /mini 受保护写接口一律 401；三类有效房源的公开卡片/脱敏详情与视频无需 token。
// 防回归：若将来有人让注册/待审核发 token，本测试会立刻变红。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-pending-no-data-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 44100 + Math.floor(Math.random() * 300)
const baseUrl = `http://127.0.0.1:${port}`

const NOPW_PHONE = '13900000052'
const NEW_PHONE = '13900000053'
const NEW_PASSWORD = 'applicant-pass-123'
const DEL_PHONE = '13900000054'
const DEL_PASSWORD = 'deleted-pass-123'
const OK_PASSWORD = 'broker-ok-123'

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function listing(overrides = {}) {
  const now = nowText()
  return {
    id: 'PND_LISTING',
    title: '待授权测试房源',
    shortTitle: '测试小区',
    uploaderId: 'U-OK',
    rent: 3000,
    layout: '整租两室一厅',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '测试板块',
    community: '测试小区',
    building: '1幢',
    unit: '1单元',
    roomNumber: '101',
    address: '杭州拱墅区测试小区1幢1单元101室',
    landlordPhone: '13911112222',
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: '整租',
    rentMode: '整租',
    source: '普通上传',
    videoUrl: '',
    videoKey: 'house-videos/synthetic/pnd.mp4',
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    mapLatitude: 30.35,
    mapLongitude: 120.16,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    ...overrides
  }
}

function seedDb() {
  const db = {
    users: [
      { id: 'U-OK', name: '已开通中介', phone: '13900000051', role: '中介', isAdmin: false, authed: '手机号登录', passwordHash: hashPassword(OK_PASSWORD) },
      { id: 'U-NOPW', name: '存量无密码中介', phone: NOPW_PHONE, role: '中介', isAdmin: false, authed: '手机号登录' },
      { id: 'U-DEL', name: '软删中介', phone: DEL_PHONE, role: '中介', isAdmin: false, authed: '手机号登录', deleted: true, status: '已删除', passwordHash: hashPassword(DEL_PASSWORD) }
    ],
    listings: [
      listing({
        id: 'PND_COMPANY', title: '匿名可见公司房源', shortTitle: '公司小区', community: '公司小区',
        ownerType: '公司房源', houseSourceType: '公司房源', source: '公司房源',
        companyListing: true, isCompanyListing: true, noCommission: true, videoUrl: '', videoKey: ''
      }),
      listing({ id: 'PND_PARTNER', title: '需登录合作房源', shortTitle: '合作小区', community: '合作小区' })
    ],
    rentalNeeds: [],
    footprints: [],
    clientReports: [],
    registrationRequests: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'super1', password: 'super1pass', name: '超管', userId: 'U-OK', permission: '全部后台权限', status: '启用' }
    ]
  }
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')
}

function request(method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let parsed = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch (error) { parsed = { raw } }
        resolve({ statusCode: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitForServer() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 12000) {
    try {
      const res = await request('GET', '/healthz')
      if (res.statusCode === 200) return true
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

function dataOf(response) {
  return response.body && response.body.data
}

function hasToken(response) {
  return Boolean(dataOf(response) && dataOf(response).token)
}

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: AUTH_SECRET,
      ADMIN_TOKEN_SECRET: 'pending-no-data-admin',
      V1_DISABLE_LEGACY_ROUTES: '1',
      MINI_REQUEST_DOMAIN: baseUrl,
      ALI_OSS_BUCKET: 'synthetic-bucket',
      ALI_OSS_REGION: 'oss-cn-example',
      ALI_OSS_ACCESS_KEY_ID: 'synthetic-access-key-id',
      ALI_OSS_ACCESS_KEY_SECRET: 'synthetic-access-key-secret',
      ALI_OSS_PUBLIC_BASE_URL: 'https://synthetic-bucket.oss-cn-example.aliyuncs.com'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (c) => { output += c.toString() })
  server.stderr.on('data', (c) => { output += c.toString() })

  try {
    assert.ok(await waitForServer(), `待授权无数据测试服务未启动：${output}`)

    // ① 这些「不该有访问权」的流程一律换不到 token
    const reg = await request('POST', '/mini/auth/register', { name: '新申请人', phone: NEW_PHONE, password: NEW_PASSWORD })
    assert.strictEqual(reg.statusCode, 403, '新注册应待审核（403）')
    const pendingLogin = await request('POST', '/mini/auth/login', { phone: NEW_PHONE, password: NEW_PASSWORD })
    assert.strictEqual(pendingLogin.statusCode, 403, '待审核账号不能登录')
    const nopwLogin = await request('POST', '/mini/auth/login', { phone: NOPW_PHONE, password: 'anything-123' })
    assert.strictEqual(nopwLogin.statusCode, 403, '无密码存量账号不能登录')
    ;[reg, pendingLogin, nopwLogin].forEach((r, i) => {
      assert.ok(!hasToken(r), `不该有访问权的流程#${i} 绝不能发 token`)
    })

    // ② 无 token仍不能访问账号接口，但可读取合作房源的公开详情和视频。
    const noAuthProfile = await request('GET', '/mini/profile')
    assert.strictEqual(noAuthProfile.statusCode, 401, '无 token 访问我的必须 401')
    const noAuthPartner = await request('GET', '/mini/listings/PND_PARTNER')
    assert.strictEqual(noAuthPartner.statusCode, 200, '无 token 可访问合作房源脱敏详情')
    assert.ok(String(dataOf(noAuthPartner).videoUrl || '').startsWith(`${baseUrl}/mini/listings/PND_PARTNER/media/video?token=`), '游客合作详情必须保留 API 域不透明视频地址')
    assert.ok(!JSON.stringify(dataOf(noAuthPartner)).includes('house-videos/synthetic/pnd.mp4'), '游客合作详情不得泄露服务端对象键')
    ;['building', 'unit', 'roomNumber', 'address', 'landlordPhone', 'viewingMethod', 'remark'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(dataOf(noAuthPartner), field), `游客合作详情不得下发 ${field}`)
    })
    const noAuthMe = await request('GET', '/mini/auth/me')
    assert.strictEqual(noAuthMe.statusCode, 401, '无 token 访问 me 必须 401')

    // ③ 游客首页同时公开公司与合作房源卡片，但合作房源保持小区级脱敏。
    const guestHome = await request('GET', '/mini/home/listings')
    assert.strictEqual(guestHome.statusCode, 200, '游客首页应 200')
    const rows = dataOf(guestHome) || []
    assert.ok(rows.some((r) => r.id === 'PND_COMPANY'), '游客首页应能看到公司房源')
    assert.ok(rows.some((r) => r.id === 'PND_PARTNER'), '游客首页应出现脱敏合作房源卡片')

    // ④ 软删账号：即便密码正确也不能重新登录；删除前签发、仍在有效期内的旧 token 也即时失效
    const delLogin = await request('POST', '/mini/auth/login', { phone: DEL_PHONE, password: DEL_PASSWORD })
    assert.strictEqual(delLogin.statusCode, 403, '软删账号即便密码正确也不能登录')
    assert.ok(!hasToken(delLogin), '软删账号绝不能发 token')
    const staleHeader = { Authorization: `Bearer ${signMiniToken({ userId: 'U-DEL', exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })}` }
    const staleMe = await request('GET', '/mini/auth/me', null, staleHeader)
    assert.strictEqual(staleMe.statusCode, 401, '软删账号删除前签发的旧 token 访问 me 必须 401')
    const staleProfile = await request('GET', '/mini/profile', null, staleHeader)
    assert.strictEqual(staleProfile.statusCode, 401, '软删账号旧 token 访问 profile 必须 401')
    const stalePartner = await request('GET', '/mini/listings/PND_PARTNER', null, staleHeader)
    assert.strictEqual(stalePartner.statusCode, 401, '软删账号旧 token 访问合作房源详情必须 401')

    // ⑤ 对照：正确账号 + 错误密码 → 403 无 token（确认防线只对正确密码放行，不是无脑发 token）
    const okWrongPw = await request('POST', '/mini/auth/login', { phone: '13900000051', password: 'wrong-pass-999' })
    assert.strictEqual(okWrongPw.statusCode, 403, '正确账号错误密码应 403')
    assert.ok(!hasToken(okWrongPw), '错误密码绝不能发 token')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('mini-pending-no-data-v1-test passed')
}).catch((error) => {
  console.error(`mini-pending-no-data-v1-test failed: ${error.message}`)
  process.exit(1)
})
