'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const repoRoot = path.resolve(__dirname, '..', '..')
const serverEntry = path.join(repoRoot, 'server', 'src', 'index.js')
const syntheticSecret = 'synthetic-favorite-http-secret'

function makeListing(id, overrides = {}) {
  return {
    id,
    uploaderId: 'U1',
    ownerType: '二房东房源',
    source: '二房东房源',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    communityMatched: true,
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '合成板块',
    community: '合成小区',
    address: 'SENTINEL_HTTP_ADDRESS',
    landlordPhone: '19900000021',
    viewingPassword: 'SENTINEL_HTTP_PASSWORD',
    rent: 3200,
    rentMode: '整租',
    type: '整租',
    layout: '整租一室一厅一卫',
    features: ['Loft'],
    videoKey: `house-videos/synthetic/${id}.mp4`,
    landlordCommissionPercent: 50,
    lastVerifiedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

function makeDb() {
  return {
    users: [
      { id: 'U1', name: '合成账号甲', role: '中介', authed: '手机号登录', tokenVersion: 0 },
      { id: 'U2', name: '合成账号乙', role: '中介', authed: '手机号登录', tokenVersion: 0 }
    ],
    listings: [
      makeListing('L1'),
      makeListing('L2', { district: '上城区', area: '上城区', block: '东站', community: '合成花园', rent: 4200 }),
      makeListing('L3', { lifecycleStatus: 'expired', status: '已下架', expiredReason: 'SENTINEL_HTTP_EXPIRED' })
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 7 },
    footprints: [],
    commissionRecords: [],
    clientReports: [],
    dealRecords: [],
    pointLogs: [],
    adminLogs: []
  }
}

function signToken(userId, tokenVersion = 0) {
  const encoded = Buffer.from(JSON.stringify({
    userId,
    tokenVersion,
    exp: Date.now() + 60 * 60 * 1000
  })).toString('base64url')
  const signature = crypto.createHmac('sha256', syntheticSecret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function requestJson(port, method, pathname, token, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { raw += chunk })
      response.on('end', () => {
        let parsed = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch (error) { return reject(error) }
        resolve({ statusCode: response.statusCode, body: parsed, data: parsed.data })
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
      AUTH_TOKEN_SECRET: syntheticSecret,
      ADMIN_TOKEN_SECRET: 'synthetic-favorite-admin-secret',
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
    if (child.exitCode !== null) throw new Error(`收藏测试服务提前退出 ${child.exitCode}\n${child.testOutput()}`)
    try {
      const response = await requestJson(port, 'GET', '/healthz')
      if (response.statusCode === 200) return
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`收藏测试服务启动超时\n${child.testOutput()}`)
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-favorite-http-'))
  const dataFile = path.join(tempDir, 'db.json')
  fs.writeFileSync(dataFile, JSON.stringify(makeDb(), null, 2), 'utf8')
  const firstPort = await freePort()
  let secondPort = await freePort()
  while (secondPort === firstPort) secondPort = await freePort()
  const ports = [firstPort, secondPort]
  const children = ports.map((port) => startServer(port, dataFile))
  const tokenU1 = signToken('U1')
  const tokenU2 = signToken('U2')

  try {
    await Promise.all(children.map((child, index) => waitForServer(ports[index], child)))

    for (const method of ['GET', 'PUT', 'DELETE']) {
      const pathname = method === 'GET' ? '/mini/favorites' : '/mini/favorites/L1'
      const response = await requestJson(ports[0], method, pathname)
      assert.strictEqual(response.statusCode, 401, `未登录 ${method} 必须拒绝`)
    }

    // 两个服务进程同时收到重复 PUT，最终只允许一条 U1/L1；正文/query 的伪造身份和房源编号全部无效。
    const writes = Array.from({ length: 20 }, (_, index) => requestJson(
      ports[index % ports.length],
      'PUT',
      '/mini/favorites/L1?userId=U2&role=%E7%AE%A1%E7%90%86%E5%91%98&listingId=L2',
      tokenU1,
      { userId: 'U2', viewerId: 'U2', role: '管理员', listingId: 'L2', createdAt: 'client-time' }
    ))
    const writeResponses = await Promise.all(writes)
    writeResponses.forEach((response) => assert.strictEqual(response.statusCode, 200))
    assert.strictEqual(new Set(writeResponses.map((response) => response.data.id)).size, 1, '重复 PUT 必须返回同一关系 id')
    assert.strictEqual(new Set(writeResponses.map((response) => response.data.favoritedAt)).size, 1, '重复 PUT 不得刷新收藏时间')
    let disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assert.strictEqual(disk.favorites.filter((item) => item.userId === 'U1' && item.listingId === 'L1').length, 1)
    assert.strictEqual(disk.favorites.some((item) => item.userId === 'U2' || item.listingId === 'L2'), false, '客户端伪造字段不得落库')
    assert.deepStrictEqual(Object.keys(disk.favorites[0]).sort(), ['createdAt', 'id', 'listingId', 'userId'])

    const u1Ids = await requestJson(ports[1], 'GET', '/mini/favorites/ids', tokenU1)
    const u2IdsBefore = await requestJson(ports[1], 'GET', '/mini/favorites/ids', tokenU2)
    assert.deepStrictEqual(u1Ids.data, ['L1'])
    assert.deepStrictEqual(u2IdsBefore.data, [])

    assert.strictEqual((await requestJson(ports[1], 'PUT', '/mini/favorites/L1', tokenU2)).statusCode, 200)
    disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assert.strictEqual(disk.favorites.filter((item) => item.listingId === 'L1').length, 2, '不同账号关系必须隔离共存')

    const list = await requestJson(ports[0], 'GET', '/mini/favorites?category=%E4%BA%8C%E6%88%BF%E4%B8%9C%E6%88%BF%E6%BA%90&availability=available', tokenU1)
    assert.strictEqual(list.statusCode, 200)
    assert.deepStrictEqual(list.data.map((item) => item.id), ['L1'])
    const listText = JSON.stringify(list.data)
    assert.ok(!listText.includes('19900000021') && !listText.includes('SENTINEL_HTTP_ADDRESS') && !listText.includes('SENTINEL_HTTP_PASSWORD'))

    // 历史收藏允许保留已下架房源，但公共媒体包装层不得根据 raw videoKey 把灰态卡重新伪装成可播放。
    disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    disk.favorites = (disk.favorites || []).concat({
      id: 'FV-U1-L3-HISTORICAL',
      userId: 'U1',
      listingId: 'L3',
      createdAt: new Date().toISOString()
    })
    fs.writeFileSync(dataFile, JSON.stringify(disk, null, 2), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const unavailableList = await requestJson(ports[0], 'GET', '/mini/favorites?availability=unavailable', tokenU1)
    assert.strictEqual(unavailableList.statusCode, 200)
    const unavailableRow = unavailableList.data.find((item) => item.id === 'L3')
    assert.ok(unavailableRow, '历史已下架收藏必须保留灰态卡')
    assert.strictEqual(unavailableRow.isAvailable, false)
    assert.strictEqual(unavailableRow.hasVideo, false, '已下架收藏不得被媒体包装层重新标成有视频')
    assert.ok(!unavailableRow.videoUrl && !unavailableRow.coverUrl, '已下架收藏不得下发无效媒体能力地址')
    assert.ok(!JSON.stringify(unavailableRow).includes('/media/'), '已下架收藏响应不得含媒体能力 token')
    disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    disk.favorites = (disk.favorites || []).filter((item) => item.id !== 'FV-U1-L3-HISTORICAL')
    fs.writeFileSync(dataFile, JSON.stringify(disk, null, 2), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const unavailableBefore = fs.readFileSync(dataFile, 'utf8')
    const unavailableWrite = await requestJson(ports[0], 'PUT', '/mini/favorites/L3', tokenU1)
    assert.strictEqual(unavailableWrite.statusCode, 410)
    assert.strictEqual(fs.readFileSync(dataFile, 'utf8'), unavailableBefore, '不可用收藏失败不得改库')

    const deletes = Array.from({ length: 20 }, (_, index) => requestJson(ports[index % ports.length], 'DELETE', '/mini/favorites/L1', tokenU1))
    const deleteResponses = await Promise.all(deletes)
    deleteResponses.forEach((response) => assert.strictEqual(response.statusCode, 200))
    assert.strictEqual((await requestJson(ports[0], 'DELETE', '/mini/favorites/L1', tokenU1)).statusCode, 200, '重复 DELETE 仍成功')
    disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assert.strictEqual(disk.favorites.filter((item) => item.userId === 'U1').length, 0)
    assert.strictEqual(disk.favorites.filter((item) => item.userId === 'U2' && item.listingId === 'L1').length, 1, 'U1 删除不得影响 U2')

    const profile = await requestJson(ports[1], 'GET', '/mini/profile', tokenU2)
    assert.strictEqual(profile.statusCode, 200)
    assert.strictEqual(profile.data.favoriteCount, 1)

    const lockFile = `${dataFile}.lock`

    // 自动过期先读到旧快照并等待写锁时，锁持有者并发写入收藏；释放后必须基于 fresh DB 重做过期并保住收藏。
    disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    disk.listingMaintenanceRule.enabled = true
    disk.listings.push(makeListing('L-STALE', {
      lastVerifiedAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z'
    }))
    fs.writeFileSync(dataFile, JSON.stringify(disk, null, 2), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 30))
    fs.writeFileSync(lockFile, `${process.pid}:synthetic-migration-lock`, 'utf8')
    let migrationSettled = false
    const migrationRequest = requestJson(ports[0], 'GET', '/mini/home/listings').then((response) => {
      migrationSettled = true
      return response
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.strictEqual(migrationSettled, false, '自动过期请求必须已进入写锁等待，测试时序才有效')
    const concurrentDb = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    concurrentDb.favorites.push({
      id: 'FV-CONCURRENT-MIGRATION',
      userId: 'U1',
      listingId: 'L2',
      createdAt: '2026-07-12T00:00:00.000Z'
    })
    fs.writeFileSync(dataFile, JSON.stringify(concurrentDb, null, 2), 'utf8')
    fs.unlinkSync(lockFile)
    assert.strictEqual((await migrationRequest).statusCode, 200)
    disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assert.ok(disk.favorites.some((item) => item.id === 'FV-CONCURRENT-MIGRATION'), '锁内自动过期不得覆盖并发收藏')
    const staleListing = disk.listings.find((item) => item.id === 'L-STALE')
    assert.strictEqual(staleListing.lifecycleStatus, 'expired', '并发收藏也不得阻止房态自动过期')

    // 外层验签通过后让 PUT 等待写锁；锁持有者提升 tokenVersion，释放后必须由锁内重验拒绝写入。
    fs.writeFileSync(lockFile, `${process.pid}:synthetic-revocation-lock`, 'utf8')
    let revokedSettled = false
    const revokedRequest = requestJson(ports[0], 'PUT', '/mini/favorites/L2', tokenU2).then((response) => {
      revokedSettled = true
      return response
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.strictEqual(revokedSettled, false, '收藏 PUT 必须已通过外层验签并进入写锁等待，撤权时序才有效')
    disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    const favoriteBeforeRevocation = JSON.stringify(disk.favorites)
    disk.users.find((item) => item.id === 'U2').tokenVersion = 1
    fs.writeFileSync(dataFile, JSON.stringify(disk, null, 2), 'utf8')
    fs.unlinkSync(lockFile)
    const revoked = await revokedRequest
    assert.strictEqual(revoked.statusCode, 401)
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(dataFile, 'utf8')))
    assert.strictEqual(JSON.stringify(JSON.parse(fs.readFileSync(dataFile, 'utf8')).favorites), favoriteBeforeRevocation, '锁内撤权后不得写收藏')

    const indexSource = fs.readFileSync(path.join(repoRoot, 'server', 'src', 'index.js'), 'utf8')
    const start = indexSource.indexOf('function readDbForRequest()')
    const end = indexSource.indexOf('\nasync function handleMini', start)
    const block = indexSource.slice(start, end)
    assert.ok(block.includes('dbStore.updateDb'), '自动迁移/过期必须在写锁内重做')
    assert.ok(!block.includes('dbStore.writeDb(db)'), '不得用锁外陈旧快照整库覆盖并发收藏')

    console.log('favorite-http-v1-test passed')
  } finally {
    try { fs.unlinkSync(`${dataFile}.lock`) } catch (error) {}
    await Promise.all(children.map(stopServer))
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (error) {}
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
