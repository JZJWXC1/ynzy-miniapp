const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-auth-token-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 40000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`
const authSecret = 'auth-token-v1-test-secret'
const brokerPassword = 'broker-pass-123'

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
      { id: 'U1', name: '真实登录中介', phone: '13900000001', role: '中介', authed: '手机号登录', passwordHash: hashPassword(brokerPassword) },
      { id: 'U2', name: '伪造请求头中介', phone: '13900000002', role: '中介', authed: '手机号登录', passwordHash: hashPassword(brokerPassword) }
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
    commissionRecords: [],
    adminAccounts: [
      {
        id: 'A001',
        account: 'admin',
        password: 'admin123',
        name: '管理员',
        userId: 'U1',
        permission: '全部后台权限',
        status: '启用'
      },
      {
        id: 'A002',
        account: 'manager01',
        password: 'manager123',
        name: '区域主管',
        userId: 'U1',
        permission: '区域查看权限',
        status: '启用'
      },
      {
        id: 'A003',
        account: 'legacyadmin',
        password: 'legacy123',
        name: '存量管理员',
        userId: 'U1',
        status: '启用'
      }
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

    const login = await request('POST', '/mini/auth/login', { phone: '13900000001', password: brokerPassword })
    assert.strictEqual(login.statusCode, 200, '手机号+密码登录应返回 200')
    assert.ok(dataOf(login).token, '手机号登录必须签发 token')
    assert.ok(dataOf(login).tokenExpiresAt > Date.now(), 'token 必须带未来过期时间')
    assert.strictEqual(dataOf(login).passwordHash, undefined, '登录响应绝不能带出 passwordHash')
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

    // token 篡改①：改 payload（延长有效期）但沿用旧签名 → 401（HMAC 覆盖 payload，签名必对不上）
    const validParts = dataOf(login).token.split('.')
    const forgedPayload = base64url(JSON.stringify({ userId: 'U1', exp: Date.now() + 60000 }))
    const tamperedToken = `${forgedPayload}.${validParts[1]}`
    const tamperedProfile = await request('GET', '/mini/profile', null, { Authorization: `Bearer ${tamperedToken}` })
    assert.strictEqual(tamperedProfile.statusCode, 401, '篡改 payload 沿用旧签名的 token 必须返回 401')

    // token 篡改②：用错误密钥重签一个「未过期」payload → 401（攻击者无 AUTH_TOKEN_SECRET 无法伪造合法签名）
    const wrongSecretPayload = base64url(JSON.stringify({ userId: 'U1', exp: Date.now() + 60000 }))
    const wrongSecretSig = crypto.createHmac('sha256', 'not-the-real-secret').update(wrongSecretPayload).digest('base64url')
    const wrongSecretProfile = await request('GET', '/mini/profile', null, { Authorization: `Bearer ${wrongSecretPayload}.${wrongSecretSig}` })
    assert.strictEqual(wrongSecretProfile.statusCode, 401, '用错误密钥重签的 token 必须返回 401')

    // 管理后台鉴权：/admin/* 必须校验管理员 token，不接受无 token、小程序 token 或伪造 token
    const adminNoToken = await request('GET', '/admin/dashboard')
    assert.strictEqual(adminNoToken.statusCode, 401, '无 token 访问管理后台必须返回 401')

    const adminWithMiniToken = await request('GET', '/admin/dashboard', null, authHeader)
    assert.strictEqual(adminWithMiniToken.statusCode, 401, '小程序 token 不能冒充管理后台 token')

    const adminForged = await request('GET', '/admin/dashboard', null, { Authorization: 'Bearer forged-admin-token.invalidsig' })
    assert.strictEqual(adminForged.statusCode, 401, '伪造/篡改的管理后台 token 必须返回 401')

    // 权限分级：受限管理员（区域查看权限）不得执行超级管理员专属高危操作
    const managerLogin = await request('POST', '/admin/auth/login', { account: 'manager01', password: 'manager123' })
    assert.strictEqual(managerLogin.statusCode, 200, '区域查看权限管理员应能登录')
    const managerAuth = { Authorization: `Bearer ${dataOf(managerLogin).token}` }
    const requiredHighRiskWriteCases = [
      ['PUT', '/admin/listing-maintenance-rule', { enabled: false }],
      ['POST', '/admin/listings/L-NOEXIST/review', { action: 'approve' }],
      ['POST', '/admin/listings/L-NOEXIST/verify', null],
      ['POST', '/admin/listings/L-NOEXIST/coordinate', { latitude: 30.1, longitude: 120.1 }],
      ['POST', '/admin/expired-listings/L-NOEXIST/restore', null],
      ['POST', '/admin/recharges/R-NOEXIST/sync', null]
    ]
    for (const [method, targetPath, body] of requiredHighRiskWriteCases) {
      const response = await request(method, targetPath, body, managerAuth)
      assert.strictEqual(response.statusCode, 403, `restricted admin must not call ${method} ${targetPath}`)
    }
    const managerExport = await request('GET', '/admin/data/export', null, managerAuth)
    assert.strictEqual(managerExport.statusCode, 403, '受限管理员不得导出整库数据')
    const managerCreate = await request('POST', '/admin/accounts', { account: 'eviladmin', password: 'evilpass99', permission: '全部后台权限' }, managerAuth)
    assert.strictEqual(managerCreate.statusCode, 403, '受限管理员不得创建管理员自我提权')
    const managerResetPwd = await request('POST', '/admin/accounts/A001/password', { password: 'takeover99' }, managerAuth)
    assert.strictEqual(managerResetPwd.statusCode, 403, '受限管理员不得重置他人（含超管）密码接管账号')
    // 与整库导出同级的高危写操作也必须受能力门约束（能力门在业务处理前即拦截，故不存在的 id
    // 也应返回 403 而非 404）：整库飞书同步回写、改全局 LLM 配置、放行充值、确认成交/佣金。
    const managerMaintenanceRule = await request('PUT', '/admin/listing-maintenance-rule', { enabled: false }, managerAuth)
    assert.strictEqual(managerMaintenanceRule.statusCode, 403, '受限管理员不得修改全局房态维护规则')
    const managerFeishuSync = await request('POST', '/admin/feishu-sync/run', { dryRun: true }, managerAuth)
    assert.strictEqual(managerFeishuSync.statusCode, 403, '受限管理员不得触发整库飞书同步回写')
    const managerListingEdit = await request('PUT', '/admin/listings/AUTH_PARTNER', { rent: 1, contact: '13900000000', companyListing: true }, managerAuth)
    assert.strictEqual(managerListingEdit.statusCode, 403, '受限管理员不得编辑房源租金、联系方式或公司房源标记')
    const managerExpiredRestore = await request('POST', '/admin/expired-listings/L-NOEXIST/restore', null, managerAuth)
    assert.strictEqual(managerExpiredRestore.statusCode, 403, '受限管理员不得从资产池重新上架房源')
    const managerListingCoordinate = await request('POST', '/admin/listings/L-NOEXIST/coordinate', { latitude: 30.1, longitude: 120.1 }, managerAuth)
    assert.strictEqual(managerListingCoordinate.statusCode, 403, '受限管理员不得修正房源坐标')
    const managerListingVerify = await request('POST', '/admin/listings/L-NOEXIST/verify', null, managerAuth)
    assert.strictEqual(managerListingVerify.statusCode, 403, '受限管理员不得核验房态并上架房源')
    const managerListingReview = await request('POST', '/admin/listings/L-NOEXIST/review', { action: 'approve' }, managerAuth)
    assert.strictEqual(managerListingReview.statusCode, 403, '受限管理员不得审核房源上架或驳回')
    const managerShowingReview = await request('POST', '/admin/showings/S-NOEXIST/review', { action: 'approve' }, managerAuth)
    assert.strictEqual(managerShowingReview.statusCode, 403, '受限管理员不得审核带看奖励')
    const managerGroupReview = await request('POST', '/admin/groups/uploads/G-NOEXIST/review', { action: 'approve' }, managerAuth)
    assert.strictEqual(managerGroupReview.statusCode, 403, '受限管理员不得审核群素材')
    const managerLlmConfig = await request('PUT', '/admin/llm-config', { systemPrompt: 'takeover' }, managerAuth)
    assert.strictEqual(managerLlmConfig.statusCode, 403, '受限管理员不得修改全局 LLM 配置（影响所有用户）')
    const managerAssistantReview = await request('POST', '/admin/assistant/feedbacks/AF-NOEXIST/review', { status: 'resolved' }, managerAuth)
    assert.strictEqual(managerAssistantReview.statusCode, 403, '受限管理员不得分诊或关闭助手反馈')
    const managerAssistantEval = await request('POST', '/admin/assistant/feedbacks/AF-NOEXIST/promote-eval', {}, managerAuth)
    assert.strictEqual(managerAssistantEval.statusCode, 403, '受限管理员不得把反馈提升为评估样本')
    const managerDealConfirm = await request('POST', '/admin/deals/D-NOEXIST/confirm', null, managerAuth)
    assert.strictEqual(managerDealConfirm.statusCode, 403, '受限管理员不得确认成交/放行佣金')
    const managerRechargeReview = await request('POST', '/admin/recharges/R-NOEXIST/review', { action: 'approve' }, managerAuth)
    assert.strictEqual(managerRechargeReview.statusCode, 403, '受限管理员不得放行充值')
    const managerRechargeSync = await request('POST', '/admin/recharges/R-NOEXIST/sync', null, managerAuth)
    assert.strictEqual(managerRechargeSync.statusCode, 403, '受限管理员不得同步并改写充值状态')

    // 存量管理员账号没有 permission/capabilities 字段时，必须按超级管理员兼容，不能误拦房源编辑为 403
    const legacyLogin = await request('POST', '/admin/auth/login', { account: 'legacyadmin', password: 'legacy123' })
    assert.strictEqual(legacyLogin.statusCode, 200, '无显式权限字段的存量管理员应能登录')
    const legacyEdit = await request('PUT', '/admin/listings/AUTH_PARTNER', {
      area: '拱墅区',
      block: '测试板块',
      community: '合作鉴权小区',
      building: '1幢',
      unit: '1单元',
      roomNumber: '101',
      rentMode: '整租',
      room: '两室',
      hall: '一厅',
      bath: '一卫',
      rent: 3100,
      contact: '13911112222',
      ownerType: '二房东房源',
      companyListing: false,
      features: ['电梯'],
      videoUrl: 'https://example.com/auth-token.mp4'
    }, { Authorization: `Bearer ${dataOf(legacyLogin).token}` })
    assert.strictEqual(legacyEdit.statusCode, 200, '存量管理员编辑房源不应被 assertAdminCapability 误拦 403')
    assert.strictEqual(dataOf(legacyEdit).id, 'AUTH_PARTNER', '存量管理员编辑应返回房源详情')

    // 对照：全部后台权限管理员可以执行高危操作
    const superLogin = await request('POST', '/admin/auth/login', { account: 'admin', password: 'admin123' })
    assert.strictEqual(superLogin.statusCode, 200, '超级管理员应能登录')
    const superExport = await request('GET', '/admin/data/export', null, { Authorization: `Bearer ${dataOf(superLogin).token}` })
    assert.strictEqual(superExport.statusCode, 200, '全部后台权限管理员可导出整库数据')

    const adminWebSource = fs.readFileSync(path.join(serverDir, '..', 'admin-web', 'index.html'), 'utf8')
    assert(adminWebSource.includes('showAdminToast'), '后台审核通过/驳回后必须有 toast 反馈')
    assert(adminWebSource.includes('renderListings(updatedListings)'), '审核后房源列表必须使用接口返回的新状态即时刷新')
    assert(adminWebSource.includes('renderListingReviews(updatedListings)'), '审核后待审核列表必须使用接口返回的新状态即时刷新')
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
