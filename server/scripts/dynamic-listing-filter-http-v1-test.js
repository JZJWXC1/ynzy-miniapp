'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const repoRoot = path.resolve(__dirname, '..', '..')
const serverEntry = path.join(repoRoot, 'server', 'src', 'index.js')
const syntheticAdminSecret = 'synthetic-dynamic-filter-admin-secret'
const syntheticMiniSecret = 'synthetic-dynamic-filter-mini-secret'
const now = new Date().toISOString()

function companyListing(id, overrides = {}) {
  return {
    id,
    title: `合成房源 ${id}`,
    shortTitle: `合成房源 ${id}`,
    source: '公司房源',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    communityMatched: true,
    city: '杭州',
    district: '云城区',
    area: '云城区',
    block: '未来板块',
    community: '未来花苑',
    rent: 3200,
    layout: '2室1厅',
    room: '二室',
    hall: '1厅',
    bath: '1卫',
    rentMode: '整租',
    type: '整租',
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    ...overrides
  }
}

function expiredListing(id, overrides = {}) {
  return companyListing(id, {
    status: '已下架',
    lifecycleStatus: 'expired',
    expiredAt: now,
    expiredReason: '合成测试下架',
    ...overrides
  })
}

function seedDb() {
  return {
    users: [
      {
        id: 'U-FILTER-ADMIN',
        name: '合成筛选管理员',
        role: '管理员',
        authed: '已实名',
        tokenVersion: 0
      }
    ],
    adminAccounts: [
      {
        id: 'A-FILTER-ADMIN',
        account: 'filter-admin',
        password: 'filter-admin-pass',
        name: '合成筛选管理员',
        userId: 'U-FILTER-ADMIN',
        permission: '全部后台权限',
        status: '启用'
      }
    ],
    listingMaintenanceRule: {
      enabled: false,
      remindDays: [3, 5],
      expireDays: 7
    },
    listings: [
      companyListing('PUBLIC-ACTIVE', {
        district: '公开新区',
        area: '公开新',
        block: '公开板块',
        community: '公开花苑'
      }),
      companyListing('PENDING-ACTIVE', {
        status: '待审核',
        reviewStatus: '待审核',
        district: '待审新区',
        area: '待审新',
        block: '待审板块',
        community: '待审花苑'
      }),
      expiredListing('EXACT'),
      expiredListing('WRONG-DISTRICT', {
        district: '隔离区',
        area: '隔离区'
      }),
      expiredListing('WRONG-BLOCK', {
        block: '隔离板块'
      }),
      expiredListing('WRONG-COMMUNITY', {
        community: '隔离花苑'
      }),
      expiredListing('WRONG-SOURCE', {
        source: '业主房源',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        companyListing: false,
        isCompanyListing: false
      }),
      expiredListing('WRONG-RENT-MIN', {
        rent: 2999
      }),
      expiredListing('WRONG-RENT-MAX', {
        rent: 3501
      }),
      expiredListing('WRONG-LAYOUT', {
        layout: '3室1厅',
        room: '三室'
      }),
      expiredListing('WRONG-RENT-MODE', {
        rentMode: '合租',
        type: '合租'
      })
    ],
    footprints: [],
    favorites: [],
    commissionRecords: [],
    clientReports: [],
    dealRecords: [],
    pointLogs: [],
    adminLogs: []
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function requestJson(port, method, pathname, body, headers = {}) {
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          : {}),
        ...headers
      }
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { raw += chunk })
      response.on('end', () => {
        let parsed = {}
        try {
          parsed = raw ? JSON.parse(raw) : {}
        } catch (error) {
          return reject(new Error(`接口返回非 JSON：${raw.slice(0, 300)}`))
        }
        resolve({
          statusCode: response.statusCode,
          body: parsed,
          data: parsed.data
        })
      })
    })
    request.once('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function startServer(port, dataFile) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_FILE: dataFile,
      ADMIN_TOKEN_SECRET: syntheticAdminSecret,
      AUTH_TOKEN_SECRET: syntheticMiniSecret,
      FEISHU_SYNC_ENABLED: '0',
      FEISHU_SYNC_INTERVAL_MINUTES: '99999',
      REPORT_DEAL_WRITES_ENABLED: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  child.testOutput = () => output.slice(-4000)
  return child
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`动态筛选测试服务提前退出 ${child.exitCode}\n${child.testOutput()}`)
    }
    try {
      const response = await requestJson(port, 'GET', '/healthz')
      if (response.statusCode === 200) return
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`动态筛选测试服务启动超时\n${child.testOutput()}`)
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function loginAdmin(port) {
  const response = await requestJson(port, 'POST', '/admin/auth/login', {
    account: 'filter-admin',
    password: 'filter-admin-pass'
  })
  assert.strictEqual(response.statusCode, 200, `管理员登录失败：${JSON.stringify(response.body)}`)
  assert.ok(response.data && response.data.token, '管理员登录必须返回 token')
  return {
    Authorization: `Bearer ${response.data.token}`
  }
}

function queryString(params) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') {
      search.set(key, String(value))
    }
  })
  return search.toString()
}

async function expiredIds(port, auth, params) {
  const response = await requestJson(
    port,
    'GET',
    `/admin/expired-listings?${queryString(params)}`,
    null,
    auth
  )
  assert.strictEqual(response.statusCode, 200, `废房源筛选失败：${JSON.stringify(response.body)}`)
  assert.ok(Array.isArray(response.data), '废房源筛选响应必须为数组')
  return response.data.map((item) => item.id).sort()
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-dynamic-filter-http-'))
  const dataFile = path.join(tempDir, 'db.json')
  fs.writeFileSync(dataFile, JSON.stringify(seedDb(), null, 2), 'utf8')
  const port = await freePort()
  const child = startServer(port, dataFile)

  try {
    await waitForServer(port, child)

    const publicOptions = await requestJson(port, 'GET', '/mini/listing-filter-options')
    assert.strictEqual(publicOptions.statusCode, 200, '未登录用户必须能读取公开动态筛选元数据')
    assert.deepStrictEqual(
      publicOptions.data.regionOptions,
      [{ name: '公开新区', blocks: ['公开板块'] }],
      '公开动态筛选项只能来自当前有效公开房源'
    )
    assert.ok(
      !JSON.stringify(publicOptions.data).includes('云城区'),
      '废房源区域不得污染公开动态筛选项'
    )

    const adminAuth = await loginAdmin(port)
    const adminOptions = await requestJson(
      port,
      'GET',
      '/admin/listing-filter-options',
      null,
      adminAuth
    )
    assert.strictEqual(adminOptions.statusCode, 200, '后台必须通过管理员鉴权端点读取在租房源动态筛选元数据')
    assert.deepStrictEqual(
      adminOptions.data.regionOptions,
      [
        { name: '公开新区', blocks: ['公开板块'] },
        { name: '待审新区', blocks: ['待审板块'] }
      ].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      '后台在租筛选元数据必须覆盖同源 activeListings 中尚未公开的待审地点'
    )
    assert.ok(
      !publicOptions.data.regionOptions.some((item) => item.name === '待审新区'),
      '待审地点不得反向泄露到游客动态筛选元数据'
    )
    const wronglyAuthenticatedMini = await requestJson(
      port,
      'GET',
      '/mini/listing-filter-options',
      null,
      adminAuth
    )
    assert.strictEqual(
      wronglyAuthenticatedMini.statusCode,
      401,
      '管理员 token 不能伪装成小程序 token；后台不得再跨鉴权调用 mini 端点'
    )
    const activeByCanonicalDistrict = await requestJson(
      port,
      'GET',
      '/admin/listings?district=%E5%85%AC%E5%BC%80%E6%96%B0%E5%8C%BA',
      null,
      adminAuth
    )
    assert.strictEqual(activeByCanonicalDistrict.statusCode, 200)
    assert.deepStrictEqual(
      activeByCanonicalDistrict.data.map((item) => item.id),
      ['PUBLIC-ACTIVE'],
      '后台必须按动态元数据返回的 canonical district 命中 area 不带“区”的同一房源'
    )
    const pendingByCanonicalDistrict = await requestJson(
      port,
      'GET',
      '/admin/listings?district=%E5%BE%85%E5%AE%A1%E6%96%B0%E5%8C%BA',
      null,
      adminAuth
    )
    assert.strictEqual(pendingByCanonicalDistrict.statusCode, 200)
    assert.deepStrictEqual(
      pendingByCanonicalDistrict.data.map((item) => item.id),
      ['PENDING-ACTIVE'],
      '后台动态选项中的待审行政区必须能筛回同源待审房源'
    )

    const expiredOptions = await requestJson(
      port,
      'GET',
      '/admin/expired-listing-filter-options',
      null,
      adminAuth
    )
    assert.strictEqual(expiredOptions.statusCode, 200, '管理员必须能读取废房源池动态筛选元数据')
    const mainRegion = expiredOptions.data.regionOptions.find((item) => item.name === '云城区')
    assert.ok(mainRegion, '废房源池元数据必须包含废房源行政区')
    assert.deepStrictEqual(
      mainRegion.blocks,
      ['未来板块', '隔离板块'].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      '废房源池元数据必须汇总该区域下的全部动态板块'
    )
    assert.ok(
      expiredOptions.data.regionOptions.some((item) => item.name === '隔离区'),
      '废房源池元数据必须包含后续新增行政区'
    )
    assert.ok(
      !JSON.stringify(expiredOptions.data).includes('公开新区'),
      '有效公开房源不得污染废房源池独立筛选元数据'
    )

    const exactFilter = {
      district: '云城区',
      block: '未来板块',
      community: '未来花苑',
      sourceType: '公司房源',
      rentMin: 3000,
      rentMax: 3500,
      layout: '两室',
      rentMode: '整租'
    }
    assert.deepStrictEqual(
      await expiredIds(port, adminAuth, exactFilter),
      ['EXACT'],
      '废房源池八轴 AND 组合必须精确只命中预期记录'
    )

    const axisCases = [
      ['district', 'WRONG-DISTRICT'],
      ['block', 'WRONG-BLOCK'],
      ['community', 'WRONG-COMMUNITY'],
      ['sourceType', 'WRONG-SOURCE'],
      ['rentMin', 'WRONG-RENT-MIN'],
      ['rentMax', 'WRONG-RENT-MAX'],
      ['layout', 'WRONG-LAYOUT'],
      ['rentMode', 'WRONG-RENT-MODE']
    ]
    for (const [axis, admittedId] of axisCases) {
      const relaxed = { ...exactFilter }
      delete relaxed[axis]
      assert.deepStrictEqual(
        await expiredIds(port, adminAuth, relaxed),
        ['EXACT', admittedId].sort(),
        `移除 ${axis} 后必须只额外放入该轴不匹配的合成房源，证明该轴真实参与 HTTP 筛选`
      )
    }
  } finally {
    await stopServer(child)
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (error) {}
  }
}

run().then(() => {
  console.log('dynamic-listing-filter-http-v1-test: PASS')
}).catch((error) => {
  console.error(`dynamic-listing-filter-http-v1-test: FAIL\n${error.stack || error.message}`)
  process.exitCode = 1
})
