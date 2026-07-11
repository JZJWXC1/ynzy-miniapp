const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const net = require('net')
const { spawn } = require('child_process')

// 需求4：敏感查看足迹加筛选（查看人/房源关键词/内容类型/时间范围）+ 分页。
// 无查询参数时返回旧数组（保 smoke-test），带参数时返回分页对象。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-fp-filter-'))
const dataFile = path.join(tempDir, 'db.json')
const baseNow = new Date()
let baseUrl = ''

function localDateTimeDaysAgo(days, hour) {
  const date = new Date(baseNow.getTime())
  date.setDate(date.getDate() - days)
  date.setHours(hour, 0, 0, 0)
  return date.toLocaleString('zh-CN', { hour12: false })
}

function dateParamDaysAgo(days) {
  const date = new Date(baseNow.getTime())
  date.setDate(date.getDate() - days)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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

function seedDb() {
  const db = {
    users: [
      { id: 'U1', name: '甲中介', phone: '13900000001', isAdmin: true },
      { id: 'U2', name: '乙中介', phone: '13900000002' },
      { id: 'U3', name: '上传人丙', phone: '13900000003' }
    ],
    listings: [
      { id: 'L1', shortTitle: '阳光小区', uploaderId: 'U3' },
      { id: 'L2', shortTitle: '月亮花园', uploaderId: 'U3' }
    ],
    footprints: [
      { viewerId: 'U1', listingId: 'L1', action: '查看地址和电话', time: localDateTimeDaysAgo(10, 10), needId: 'N1', purpose: '带看', sync: '已同步' },
      { viewerId: 'U2', listingId: 'L2', action: '转发视频', time: localDateTimeDaysAgo(8, 11), sync: '未同步' },
      { viewerId: 'U1', listingId: 'L2', action: '飞书同步下架', time: localDateTimeDaysAgo(6, 9), sync: '已同步' },
      { viewerId: 'U2', listingId: 'L1', action: '自动下架', time: localDateTimeDaysAgo(5, 8), sync: '已同步' },
      { viewerId: 'U1', listingId: 'L1', action: '查看地址和电话', time: localDateTimeDaysAgo(4, 7), sync: '已同步' },
      { viewerId: 'U2', listingId: 'L2', action: '转发视频', time: localDateTimeDaysAgo(3, 6), sync: '未同步' },
      { viewerId: 'U1', listingId: 'L1', action: '查看地址和电话', time: localDateTimeDaysAgo(2, 5), sync: '已同步' }
    ],
    adminAccounts: [
      { id: 'A-SUPER', account: 'superadmin', password: 'superpass123', name: '超管', userId: 'U1', permission: '全部后台权限', status: '启用' }
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

async function login(account, password) {
  const res = await request('POST', '/admin/auth/login', { account, password })
  assert.strictEqual(res.statusCode, 200, `${account} 登录失败：${JSON.stringify(res.body)}`)
  return { Authorization: `Bearer ${res.body.data.token}` }
}

async function run() {
  seedDb()
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN_SECRET: 'fp-filter-secret', AUTH_TOKEN_SECRET: 'fp-filter-mini', V1_DISABLE_LEGACY_ROUTES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (c) => { output += c.toString() })
  server.stderr.on('data', (c) => { output += c.toString() })

  try {
    assert.ok(await waitForServer(), `服务未启动：${output}`)
    const superAuth = await login('superadmin', 'superpass123')

    // 无参数：兼容旧数组（smoke-test 依赖）
    const all = await request('GET', '/admin/footprints', null, superAuth)
    assert.strictEqual(all.statusCode, 200, '足迹列表应 200')
    assert.ok(Array.isArray(all.body.data), '无查询参数时应返回数组')
    assert.strictEqual(all.body.data.length, 7, '应返回全部 7 条')

    // 内容类型筛选
    const byAction = await request('GET', '/admin/footprints?action=' + encodeURIComponent('转发视频'), null, superAuth)
    assert.ok(!Array.isArray(byAction.body.data), '带参数应返回分页对象')
    assert.strictEqual(byAction.body.data.total, 2, '转发视频应 2 条')
    assert.ok(byAction.body.data.rows.every((r) => r.action === '转发视频'), '筛选结果均为转发视频')
    assert.ok(Array.isArray(byAction.body.data.actions) && byAction.body.data.actions.length === 4, 'actions 候选应为 4 种')
    assert.ok(byAction.body.data.actions.indexOf('飞书同步下架') !== -1, 'actions 应含飞书同步下架')

    // 查看人筛选（按姓名子串）
    const byViewer = await request('GET', '/admin/footprints?viewer=' + encodeURIComponent('甲'), null, superAuth)
    assert.strictEqual(byViewer.body.data.total, 4, '甲中介应 4 条')

    // 房源/小区关键词筛选
    const byKeyword = await request('GET', '/admin/footprints?keyword=' + encodeURIComponent('月亮'), null, superAuth)
    assert.strictEqual(byKeyword.body.data.total, 3, '月亮花园相关应 3 条')

    // 时间范围筛选（闭区间）
    const byDatePath = `/admin/footprints?startDate=${dateParamDaysAgo(9)}&endDate=${dateParamDaysAgo(7)}`
    const byDate = await request('GET', byDatePath, null, superAuth)
    assert.strictEqual(byDate.body.data.total, 1, '动态日期闭区间只应命中 8 天前一条')
    assert.strictEqual(byDate.body.data.rows[0].action, '转发视频', '命中的应是 8 天前转发视频')

    // 分页
    const page1 = await request('GET', '/admin/footprints?pageSize=2&page=1', null, superAuth)
    assert.strictEqual(page1.body.data.total, 7, '分页 total 应为 7')
    assert.strictEqual(page1.body.data.totalPages, 4, 'pageSize=2 应 4 页')
    assert.strictEqual(page1.body.data.rows.length, 2, '第一页应 2 条')
    assert.strictEqual(page1.body.data.page, 1, '页码应为 1')
    const page2 = await request('GET', '/admin/footprints?pageSize=2&page=2', null, superAuth)
    assert.strictEqual(page2.body.data.rows.length, 2, '第二页应 2 条')
    assert.strictEqual(page2.body.data.page, 2, '页码应为 2')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-footprints-filter-v1-test passed')
}).catch((error) => {
  console.error(`admin-footprints-filter-v1-test failed: ${error.message}`)
  process.exit(1)
})
