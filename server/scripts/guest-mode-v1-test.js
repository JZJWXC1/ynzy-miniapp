const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')
const BROKER_PASSWORD = 'broker-pass-123'

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-guest-mode-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 39000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function listing(overrides = {}) {
  const now = nowText()
  return {
    id: 'L0',
    title: '游客模式测试房源',
    shortTitle: '游客模式测试小区',
    uploaderId: 'U1',
    rent: 2800,
    layout: '整租两室一厅',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '测试板块',
    community: '游客模式测试小区',
    building: '1幢',
    unit: '1单元',
    roomNumber: '101',
    address: '杭州拱墅区游客模式测试小区1幢1单元101室',
    landlordPhone: '13911112222',
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: '整租',
    rentMode: '整租',
    source: '普通上传',
    videoUrl: 'https://example.com/guest-mode.mp4',
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
    currentUserId: 'U1',
    users: [
      { id: 'U1', name: '测试中介', phone: '13900000001', role: '中介', authed: '手机号登录', passwordHash: hashPassword(BROKER_PASSWORD) }
    ],
    listings: [
      listing({
        id: 'GUEST_COMPANY',
        title: '游客可见公司房源',
        shortTitle: '游客公司小区',
        community: '游客公司小区',
        ownerType: '公司房源',
        houseSourceType: '公司房源',
        source: '公司房源',
        companyListing: true,
        isCompanyListing: true,
        noCommission: true,
        videoUrl: '',
        videoKey: '',
        landlordPhone: '13922223333',
        viewingPassword: '246810#',
        remark: '水电自理'
      }),
      listing({
        id: 'GUEST_PARTNER',
        title: '游客不可见合作房源',
        shortTitle: '游客合作小区',
        community: '游客合作小区',
        ownerType: '二房东房源',
        houseSourceType: '二房东房源',
        source: '普通上传',
        mapLatitude: 30.36,
        mapLongitude: 120.17
      })
    ],
    rentalNeeds: [
      {
        id: 'N1',
        brokerId: 'U1',
        rawText: '客户找游客公司小区两室',
        confirmedNeed: { community: '游客公司小区', layout: '两室', budget: 3000 },
        status: 'active'
      }
    ],
    footprints: [],
    clientReports: [],
    dealRecords: [],
    commissionRecords: [],
    companySheetSnapshot: {
      title: '游客模式公司房源表',
      updatedAt: nowText(),
      rows: [
        ['区域', '小区', '房号', '户型描述', '户型分类', '押一付一', '押二付一', '看房方式密码', '备注'],
        ['拱墅', '游客公司小区', '1-1-101', '两室一厅', '两室', '2800', '2600', '246810#', '水电自理']
      ],
      rowCount: 2,
      columnCount: 9
    }
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

function assertOnlyCompanyRows(rows, context) {
  assert.ok(Array.isArray(rows), `${context} 必须返回数组`)
  assert.ok(rows.length > 0, `${context} 必须至少返回公司房源`)
  rows.forEach((row) => {
    assert.strictEqual(row.companyListing, true, `${context} 只能返回公司房源`)
    assert.notStrictEqual(row.id, 'GUEST_PARTNER', `${context} 不能返回合作房源`)
  })
}

async function run() {
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      V1_DISABLE_LEGACY_ROUTES: '1',
      AUTH_TOKEN_SECRET: 'guest-mode-test-secret',
      COMPANY_CONTACT_PHONES: '19900000001,19900000002,19900000003'
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
    assert.ok(await waitForServer(), `游客模式测试服务未启动：${output}`)

    const guestListings = await request('GET', '/mini/listings')
    assert.strictEqual(guestListings.statusCode, 200, '匿名列表接口应返回 200')
    assertOnlyCompanyRows(dataOf(guestListings), '匿名列表')

    const guestHome = await request('GET', '/mini/home/listings')
    assert.strictEqual(guestHome.statusCode, 200, '匿名首页房源接口应返回 200')
    assertOnlyCompanyRows(dataOf(guestHome), '匿名首页房源')

    const sheetSnapshot = await request('GET', '/mini/company-sheet-snapshot')
    assert.strictEqual(sheetSnapshot.statusCode, 200, '匿名飞书快照接口应返回 200')
    const sheetText = JSON.stringify(dataOf(sheetSnapshot))
    assert.ok(sheetText.includes('1-1-101'), '匿名飞书快照应返回公司房号')
    assert.ok(sheetText.includes('246810#'), '匿名飞书快照应返回看房密码')

    const guestPins = await request('GET', '/mini/map/pins')
    assert.strictEqual(guestPins.statusCode, 200, '匿名地图接口应返回 200')
    const pins = dataOf(guestPins)
    const pinText = JSON.stringify(pins)
    assert.ok(pinText.includes('GUEST_COMPANY'), '匿名地图必须纳入无视频公司房源点位')
    const companyPin = pins.find((item) => (item.activeListingIds || []).indexOf('GUEST_COMPANY') !== -1)
    assert.ok(companyPin && companyPin.listings && companyPin.listings[0] && companyPin.listings[0].hasVideo === false, '匿名地图无视频公司房源不能显示视频标签')
    assert.ok(!pinText.includes('GUEST_PARTNER'), '匿名地图不能包含合作房源点位')

    const companyDetail = await request('GET', '/mini/listings/GUEST_COMPANY')
    assert.strictEqual(companyDetail.statusCode, 200, '匿名公司房源详情应返回 200')
    assert.strictEqual(dataOf(companyDetail).companyListing, true, '匿名详情只能打开公司房源')
    assert.deepStrictEqual(
      dataOf(companyDetail).companyContactPhones,
      ['19900000001', '19900000002', '19900000003'],
      '匿名公司房源详情也必须保留三个服务端统一号码'
    )
    assert.strictEqual(dataOf(companyDetail).companyContactPhoneText, '19900000001', '匿名旧客户端兼容字段只使用首号')
    assert.ok(JSON.stringify(dataOf(companyDetail)).includes('246810#'), '匿名公司房源详情应返回公司看房密码')

    const partnerDetail = await request('GET', '/mini/listings/GUEST_PARTNER')
    assert.strictEqual(partnerDetail.statusCode, 401, '匿名请求合作房源详情必须返回 401')

    const sensitive = await request('POST', '/mini/listings/GUEST_COMPANY/sensitive-view', {
      needId: 'N1',
      purpose: '游客越权测试'
    })
    assert.strictEqual(sensitive.statusCode, 401, '匿名不可调用敏感查看')

    const guestMatch = await request('POST', '/mini/listings/match', {
      area: '游客',
      layout: '两室',
      budget: 3000
    })
    assert.strictEqual(guestMatch.statusCode, 200, '匿名匹配接口应返回 200')
    assertOnlyCompanyRows(dataOf(guestMatch).listings, '匿名匹配')

    const assistant = await request('POST', '/mini/assistant/chat', {
      text: '找游客公司小区两室3000以内',
      form: { community: '游客公司小区', layout: '两室', budget: 3000 }
    })
    assert.strictEqual(assistant.statusCode, 200, '匿名找房助手应返回 200')
    assert.ok(!JSON.stringify(dataOf(assistant)).includes('GUEST_PARTNER'), '匿名找房助手候选不能包含合作房源')
    assert.strictEqual(dataOf(assistant).feedbackMessageId || '', '', '匿名找房助手不得返回服务端反馈结果 ID')

    const profile = await request('GET', '/mini/profile')
    assert.strictEqual(profile.statusCode, 401, '匿名访问我的必须返回 401')

    const login = await request('POST', '/mini/auth/login', { phone: '13900000001', password: BROKER_PASSWORD })
    assert.strictEqual(login.statusCode, 200, '登录应返回 200')
    assert.ok(dataOf(login).token, '登录必须返回小程序 token')
    const loggedSheetSnapshot = await request('GET', '/mini/company-sheet-snapshot', null, {
      Authorization: `Bearer ${dataOf(login).token}`
    })
    assert.strictEqual(loggedSheetSnapshot.statusCode, 200, '登录飞书快照接口应返回 200')
    assert.deepStrictEqual(dataOf(sheetSnapshot).rows, dataOf(loggedSheetSnapshot).rows, '匿名与登录快照列和数据必须一致')
    assert.ok(JSON.stringify(dataOf(loggedSheetSnapshot)).includes('看房方式密码'), '登录快照应包含看房方式密码列')
    const loggedPartnerDetail = await request('GET', '/mini/listings/GUEST_PARTNER', null, {
      Authorization: `Bearer ${dataOf(login).token}`
    })
    assert.strictEqual(loggedPartnerDetail.statusCode, 200, '登录后可查看合作房源脱敏详情')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('guest-mode-v1-test passed')
}).catch((error) => {
  console.error(`guest-mode-v1-test failed: ${error.message}`)
  process.exit(1)
})
