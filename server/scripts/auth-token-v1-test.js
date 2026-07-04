const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-auth-token-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 40000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`
const authSecret = 'auth-token-v1-test-secret'

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function signMiniToken(payload) {
  const encoded = base64url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function listing(overrides = {}) {
  const now = nowText()
  return {
    id: 'AUTH_LISTING',
    title: '鉴权测试房源',
    shortTitle: '鉴权测试小区',
    uploaderId: 'U1',
    rent: 3000,
    layout: '整租两室一厅',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '测试板块',
    community: '鉴权测试小区',
    building: '1幢',
    unit: '1单元',
    roomNumber: '101',
    address: '杭州拱墅区鉴权测试小区1幢1单元101室',
    landlordPhone: '13911112222',
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: '整租',
    rentMode: '整租',
    source: '普通上传',
    videoUrl: 'https://example.com/auth-token.mp4',
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
    currentUserId: 'U2',
    users: [
      { id: 'U1', name: '真实登录中介', phone: '13900000001', role: '中介', authed: '手机号登录' },
      { id: 'U2', name: '伪造请求头中介', phone: '13900000002', role: '中介', authed: '手机号登录' }
    ],
    listings: [
      listing({
        id: 'AUTH_COMPANY',
        title: '匿名可见公司房源',
        shortTitle: '匿名公司小区',
        community: '匿名公司小区',
        ownerType: '公司房源',
        houseSourceType: '公司房源',
        source: '公司房源',
        companyListing: true,
        isCompanyListing: true,
        noCommission: true,
        videoUrl: '',
        videoKey: ''
      }),
      listing({
        id: 'AUTH_PARTNER',
        title: '需登录合作房源',
        shortTitle: '合作鉴权小区',
        community: '合作鉴权小区'
      })
    ],
    rentalNeeds: [],
    footprints: [],
    clientReports: [],
    dealRecords: [],
    commissionRecords: []
  }
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')
}

function request(method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        let parsed = {}
        try {
          parsed = raw ? JSON.parse(raw) : {}
        } catch (error) {
          parsed = { raw }
        }
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

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: authSecret,
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  server.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })

  try {
    assert.ok(await waitForServer(), `鉴权测试服务未启动：${output}`)

    const forgedHeaderOnly = await request('GET', '/mini/profile', null, { 'X-User-Id': 'U1' })
    assert.strictEqual(forgedHeaderOnly.statusCode, 401, '伪造 X-User-Id 访问需登录接口必须返回 401')

    const anonymousPartner = await request('GET', '/mini/listings/AUTH_PARTNER')
    assert.strictEqual(anonymousPartner.statusCode, 401, '无 token 请求合作房源详情必须返回 401')

    const login = await request('POST', '/mini/auth/login', { phone: '13900000001' })
    assert.strictEqual(login.statusCode, 200, '手机号登录应返回 200')
    assert.ok(dataOf(login).token, '手机号登录必须签发 token')
    assert.ok(dataOf(login).tokenExpiresAt > Date.now(), 'token 必须带未来过期时间')
    const authHeader = { Authorization: `Bearer ${dataOf(login).token}` }

    const validProfile = await request('GET', '/mini/profile', null, authHeader)
    assert.strictEqual(validProfile.statusCode, 200, '有效 token 可访问需登录接口')
    assert.strictEqual(dataOf(validProfile).user.id, 'U1', '有效 token 必须解析出真实登录用户')

    const forgedWithToken = await request('GET', '/mini/profile', null, {
      ...authHeader,
      'X-User-Id': 'U2'
    })
    assert.strictEqual(forgedWithToken.statusCode, 200, '有效 token 加伪造 X-User-Id 仍应成功')
    assert.strictEqual(dataOf(forgedWithToken).user.id, 'U1', '服务端必须忽略伪造 X-User-Id')

    const loggedPartner = await request('GET', '/mini/listings/AUTH_PARTNER', null, authHeader)
    assert.strictEqual(loggedPartner.statusCode, 200, '有效 token 可查看合作房源详情')

    const expiredToken = signMiniToken({ userId: 'U1', exp: Date.now() - 1000 })
    const expiredProfile = await request('GET', '/mini/profile', null, { Authorization: `Bearer ${expiredToken}` })
    assert.strictEqual(expiredProfile.statusCode, 401, '过期 token 必须返回 401')

    // 管理后台鉴权：/admin/* 必须校验管理员 token，不接受无 token、小程序 token 或伪造 token
    const adminNoToken = await request('GET', '/admin/dashboard')
    assert.strictEqual(adminNoToken.statusCode, 401, '无 token 访问管理后台必须返回 401')

    const adminWithMiniToken = await request('GET', '/admin/dashboard', null, authHeader)
    assert.strictEqual(adminWithMiniToken.statusCode, 401, '小程序 token 不能冒充管理后台 token')

    const adminForged = await request('GET', '/admin/dashboard', null, { Authorization: 'Bearer forged-admin-token.invalidsig' })
    assert.strictEqual(adminForged.statusCode, 401, '伪造/篡改的管理后台 token 必须返回 401')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('auth-token-v1-test passed')
}).catch((error) => {
  console.error(`auth-token-v1-test failed: ${error.message}`)
  process.exit(1)
})
