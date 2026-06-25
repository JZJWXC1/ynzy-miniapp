const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { coordinateByCommunity } = require('../src/community-coordinates')

const rootDir = path.resolve(__dirname, '..')
const dataFile = path.join(rootDir, 'data/db.json')
const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000'
const adminAccount = process.env.SMOKE_ADMIN_ACCOUNT || '19941091943'
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD || 'WZJwzj123'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jsonRequest(method, pathname, body, headers = {}) {
  const url = new URL(pathname, baseUrl)
  const payload = body ? JSON.stringify(body) : ''
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = {}
        try {
          parsed = text ? JSON.parse(text) : {}
        } catch (error) {
          parsed = { raw: text }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(parsed.message || `HTTP ${res.statusCode}`)
          err.statusCode = res.statusCode
          err.body = parsed
          reject(err)
          return
        }
        resolve(parsed && Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed)
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function waitForServer() {
  for (let i = 0; i < 20; i += 1) {
    try {
      const health = await jsonRequest('GET', '/healthz')
      if (health.ok) return true
    } catch (error) {
      await sleep(300)
    }
  }
  return false
}

function smokeListingPayload(suffix, overrides = {}) {
  const community = overrides.community || `冒烟测试小区${suffix}`
  const building = overrides.building || String(suffix)
  const unit = overrides.unit || '1'
  const roomNumber = overrides.roomNumber || `${suffix}01`
  const area = overrides.area || '滨江区'
  const rentMode = overrides.type || overrides.rentMode || '整租'
  const room = overrides.room || '两室'
  const hall = overrides.hall || '1厅'
  const bath = overrides.bath || '1卫'
  return {
    city: '杭州',
    district: area,
    area,
    block: overrides.block || area,
    communityName: community,
    community,
    buildingNo: building,
    building,
    unitNo: unit,
    unit,
    roomNo: roomNumber,
    roomNumber,
    address: `杭州${area}${community}${building}栋${unit}单元${roomNumber}室`,
    contact: `1380000${String(suffix).padStart(4, '0')}`,
    rent: overrides.rent || 3000,
    layout: overrides.layout || `${rentMode}${room}${hall}${bath}`,
    commissionRate: overrides.commissionRate === undefined ? 18 : overrides.commissionRate,
    videoUrl: `https://example.com/smoke-${suffix}.mp4`,
    videoKey: `house-videos/smoke-${suffix}.mp4`,
    type: rentMode,
    rentMode,
    room,
    hall,
    bath,
    features: overrides.features || ['带阳台', '燃气'],
    companyListing: Boolean(overrides.companyListing),
    ownerType: overrides.ownerType,
    houseSourceType: overrides.houseSourceType || overrides.ownerType,
    source: overrides.source || (overrides.companyListing ? '公司房源' : (overrides.ownerType || '普通上传'))
  }
}

async function createSmokeListing(userId, suffix, overrides) {
  const listing = await jsonRequest('POST', '/mini/listings', smokeListingPayload(suffix, overrides), {
    'X-User-Id': userId
  })
  if (!listing || !listing.id) throw new Error('临时测试房源创建失败')
  return listing
}

async function runChecks() {
  const results = []
  const check = async (name, fn) => {
    try {
      const detail = await fn()
      results.push({ name, ok: true, detail: detail || 'ok' })
    } catch (error) {
      results.push({ name, ok: false, detail: error.message })
    }
  }

  let adminToken = ''
  const smokeListings = {}

  await check('探活和就绪检查', async () => {
    const health = await jsonRequest('GET', '/healthz')
    const ready = await jsonRequest('GET', '/readyz')
    if (!health.ok || ready.checks.todo !== 0) throw new Error('服务未就绪')
    return `pass=${ready.checks.pass}, pending=${ready.checks.pending}`
  })

  await check('后台管理员登录', async () => {
    const login = await jsonRequest('POST', '/admin/auth/login', {
      account: adminAccount,
      password: adminPassword
    })
    if (!login.token) throw new Error('未返回后台 token')
    adminToken = login.token
    return login.admin.account
  })

  await check('准备临时测试房源', async () => {
    smokeListings.owner = await createSmokeListing('U001', 101)
    smokeListings.adminOwned = await createSmokeListing('U004', 102, { rent: 3200, block: '长河' })
    smokeListings.other = await createSmokeListing('U003', 103, { rent: 2600, layout: '一室公寓', type: '公寓' })
    smokeListings.company = await createSmokeListing('U004', 104, {
      rent: 2800,
      commissionRate: 0,
      features: ['不分佣'],
      companyListing: true,
      source: '公司房源'
    })
    return [smokeListings.owner.id, smokeListings.adminOwned.id, smokeListings.other.id].join('、')
  })

  await check('首页/列表/地图接口', async () => {
    const headers = { 'X-User-Id': 'U001' }
    const home = await jsonRequest('GET', '/mini/home/listings', null, headers)
    const listings = await jsonRequest('GET', '/mini/listings', null, headers)
    const pins = await jsonRequest('GET', '/mini/map/pins', null, headers)
    if (!home.length || !listings.length || !pins.length) throw new Error('临时测试房源未进入基础接口')
    if (!Array.isArray(listings[0].features) || !listings[0].maintenanceText) {
      throw new Error('列表接口缺少特点标签或维护文案')
    }
    if (!Array.isArray(pins[0].features) || !pins[0].maintenanceText) {
      throw new Error('地图接口缺少特点标签或维护文案')
    }
    const companyPin = pins.find((pin) => pin.id === smokeListings.company.id)
    if (!companyPin || !companyPin.companyListing || !companyPin.noCommission || companyPin.commissionText !== '不分佣') {
      throw new Error('地图接口缺少公司房源或不分佣标记')
    }
    if (!Array.isArray(companyPin.features) || companyPin.features.indexOf('免押金') === -1) {
      throw new Error('地图接口缺少公司房源免押金标记')
    }
    if (pins.some((pin) => !Number.isFinite(Number(pin.latitude)) || !Number.isFinite(Number(pin.longitude)))) {
      throw new Error('地图点位缺少经纬度')
    }
    return `home=${home.length}, listings=${listings.length}, pins=${pins.length}`
  })

  await check('LLM 配房小帮手', async () => {
    const result = await jsonRequest('POST', '/mini/llm/match', {
      text: '预算3000，滨江两室，带阳台和燃气，月底入住，通勤到西兴',
      voiceText: '想要近地铁',
      form: {
        budget: '3000',
        area: '滨江',
        layout: '两室',
        moveIn: '月底入住',
        commute: '西兴',
        features: ['带阳台', '燃气']
      }
    }, { 'X-User-Id': 'U001' })
    if (!result.reply || !Array.isArray(result.listings) || !result.listings.length) {
      throw new Error('配房助手未返回推荐房源')
    }
    if (!Array.isArray(result.need.features) || result.need.features.indexOf('带阳台') === -1) {
      throw new Error('配房助手未解析特点标签')
    }
    if (!result.listings[0].relevancePercent || !Array.isArray(result.listings[0].features) || !result.listings[0].maintenanceText) {
      throw new Error('配房结果缺少相关性评分、特点标签或维护文案')
    }
    if (process.env.SMOKE_REQUIRE_REAL_LLM === '1' && result.mode === 'local-fallback') {
      throw new Error(result.warning || 'LLM 真实供应商调用失败')
    }
    return `${result.mode}: ${result.listings[0].id} ${result.listings[0].relevancePercent}`
  })

  await check('登录注册接口', async () => {
    const phone = `139${Date.now().toString().slice(-8)}`
    const created = await jsonRequest('POST', '/mini/auth/register', {
      name: '冒烟测试员工',
      phone,
      role: '租赁顾问'
    })
    const login = await jsonRequest('POST', '/mini/auth/login', { phone })
    if (created.phone !== phone || login.phone !== phone) throw new Error('登录注册结果不一致')
    return login.id
  })

  await check('敏感信息防跳单', async () => {
    const ownId = smokeListings.owner.id
    const otherId = smokeListings.other.id
    const detail = await jsonRequest('GET', `/mini/listings/${ownId}`, null, { 'X-User-Id': 'U001' })
    if (detail.address !== '确认留痕后可查看') throw new Error('详情接口泄露真实地址')
    if (!Array.isArray(detail.features) || !detail.maintenanceText) throw new Error('详情缺少特点标签或维护文案')
    try {
      await jsonRequest('POST', `/mini/listings/${ownId}/sensitive-view`, {
        action: '查看地址和电话'
      }, { 'X-User-Id': 'U006' })
      throw new Error('未实名用户被放行')
    } catch (error) {
      if (error.statusCode !== 403) throw error
    }
    const revealed = await jsonRequest('POST', `/mini/listings/${ownId}/sensitive-view`, {
      action: '查看地址和电话'
    }, { 'X-User-Id': 'U001' })
    if (!revealed.sensitive || !revealed.sensitive.address) throw new Error('实名查看未返回敏感信息')
    await jsonRequest('POST', `/mini/listings/${otherId}/sensitive-view`, {
      action: '冒烟无关查看'
    }, { 'X-User-Id': 'U003' })
    const u001Footprints = await jsonRequest('GET', '/mini/footprints', null, { 'X-User-Id': 'U001' })
    if ((u001Footprints || []).some((item) => item.raw && item.raw.action === '冒烟无关查看')) {
      throw new Error('员工端足迹泄露了无关房源记录')
    }
    const adminFootprints = await jsonRequest('GET', '/admin/footprints', null, { Authorization: `Bearer ${adminToken}` })
    if (!(adminFootprints || []).some((item) => item.action === '冒烟无关查看')) {
      throw new Error('管理员后台未同步敏感查看足迹')
    }
    return 'masked +实名留痕 +权限隔离通过'
  })

  await check('房源上传校验', async () => {
    try {
      await jsonRequest('POST', '/mini/listings', {
        address: '测试地址',
        contact: '13800000000',
        rent: 3000,
        layout: '两室',
        commissionRate: 21,
        videoUrl: 'https://example.com/a.mp4'
      }, { 'X-User-Id': 'U001' })
      throw new Error('超过 20% 分佣被放行')
    } catch (error) {
      if (error.statusCode !== 400) throw error
    }
    const listing = await jsonRequest('POST', '/mini/listings', {
      city: '杭州',
      district: '滨江区',
      area: '滨江区',
      block: '滨江区',
      communityName: '冒烟测试小区',
      community: '冒烟测试小区',
      buildingNo: '8',
      building: '8',
      unitNo: '1',
      unit: '1',
      roomNo: '8801',
      roomNumber: '8801',
      address: '杭州滨江区冒烟测试小区8栋1单元8801室',
      contact: '13800000000',
      rent: 3000,
      layout: '整租两室1厅1卫',
      commissionRate: 18,
      videoUrl: 'https://example.com/test.mp4',
      videoKey: 'house-videos/smoke.mp4',
      type: '整租',
      rentMode: '整租',
      room: '两室',
      hall: '1厅',
      bath: '1卫',
      features: ['无']
    }, { 'X-User-Id': 'U001' })
    if (listing.commissionRate !== 18 || !Array.isArray(listing.features) || listing.features[0] !== '无') throw new Error('房源上传结果异常')
    try {
      await jsonRequest('POST', '/mini/listings', Object.assign(smokeListingPayload(777, {
        commissionRate: 0,
        features: ['不分佣'],
        companyListing: true,
        source: '公司房源'
      }), {
        communityName: '非管理员公司房源测试',
        community: '非管理员公司房源测试',
        address: '杭州滨江区非管理员公司房源测试1栋1单元777室'
      }), { 'X-User-Id': 'U001' })
      throw new Error('非管理员公司房源上传被放行')
    } catch (error) {
      if (error.statusCode !== 403) throw error
    }
    return listing.id
  })

  await check('业主房源审核后上架', async () => {
    const realCommunity = '京漾东韵府'
    const ownerListing = await createSmokeListing('U001', 120, {
      ownerType: '业主房源',
      houseSourceType: '业主房源',
      source: '业主房源',
      community: realCommunity,
      rent: 3300
    })
    if (ownerListing.status !== '待审核' || ownerListing.reviewStatus !== '待审核') {
      throw new Error('业主房源提交后未进入待审核')
    }
    const hiddenList = await jsonRequest('GET', `/mini/listings?community=${encodeURIComponent(realCommunity)}`, null, { 'X-User-Id': 'U002' })
    if ((hiddenList || []).some((item) => item.id === ownerListing.id)) {
      throw new Error('待审核业主房源进入了公开列表')
    }
    try {
      await jsonRequest('POST', `/mini/listings/${ownerListing.id}/sensitive-view`, {
        action: '查看地址和电话'
      }, { 'X-User-Id': 'U002' })
      throw new Error('待审核业主房源敏感信息被放行')
    } catch (error) {
      if (error.statusCode !== 404) throw error
    }
    await jsonRequest('POST', `/admin/listings/${ownerListing.id}/review`, {
      action: 'approve',
      note: '冒烟测试：业主房源审核通过'
    }, { Authorization: `Bearer ${adminToken}` })
    const visibleList = await jsonRequest('GET', `/mini/listings?community=${encodeURIComponent(realCommunity)}`, null, { 'X-User-Id': 'U002' })
    if (!(visibleList || []).some((item) => item.id === ownerListing.id)) {
      throw new Error('审核通过后业主房源未上架')
    }
    const expectedCoordinate = coordinateByCommunity(realCommunity)
    const pins = await jsonRequest('GET', '/mini/map/pins', null, { 'X-User-Id': 'U002' })
    const pin = (pins || []).find((item) => item.id === ownerListing.id)
    if (!pin) throw new Error('审核通过后业主房源未进入地图')
    if (
      Math.abs(Number(pin.latitude) - expectedCoordinate.latitude) > 0.000001 ||
      Math.abs(Number(pin.longitude) - expectedCoordinate.longitude) > 0.000001
    ) {
      throw new Error('审核通过后地图未匹配真实小区坐标')
    }
    return ownerListing.id
  })

  await check('中介每日敏感查看额度', async () => {
    const brokerPhone = `137${Date.now().toString().slice(-8)}`
    const broker = await jsonRequest('POST', '/mini/auth/login', { phone: brokerPhone })
    if (!broker || broker.role !== '中介' || broker.authed !== '手机号登录') {
      throw new Error('新手机号未自动创建中介账号')
    }

    const ownerListings = []
    for (let i = 0; i < 4; i += 1) {
      const listing = await createSmokeListing('U001', 130 + i, {
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        source: '业主房源',
        community: `冒烟业主额度小区${i}`,
        roomNumber: `13${i}01`
      })
      await jsonRequest('POST', `/admin/listings/${listing.id}/review`, {
        action: 'approve',
        note: '冒烟测试：额度业主房源审核通过'
      }, { Authorization: `Bearer ${adminToken}` })
      ownerListings.push(listing)
    }
    for (let i = 0; i < 3; i += 1) {
      await jsonRequest('POST', `/mini/listings/${ownerListings[i].id}/sensitive-view`, {
        action: '查看地址和电话'
      }, { 'X-User-Id': broker.id })
    }
    try {
      await jsonRequest('POST', `/mini/listings/${ownerListings[3].id}/sensitive-view`, {
        action: '查看地址和电话'
      }, { 'X-User-Id': broker.id })
      throw new Error('中介第 4 套业主房源查看被放行')
    } catch (error) {
      if (error.statusCode !== 403 || !error.body || !error.body.data || error.body.data.quotaCategory !== 'owner') throw error
    }

    const normalListings = []
    for (let i = 0; i < 16; i += 1) {
      normalListings.push(await createSmokeListing('U001', 150 + i, {
        ownerType: '二房东房源',
        houseSourceType: '二房东房源',
        source: '二房东房源',
        community: `冒烟普通额度小区${i}`,
        roomNumber: `15${i}01`
      }))
    }
    for (let i = 0; i < 15; i += 1) {
      await jsonRequest('POST', `/mini/listings/${normalListings[i].id}/sensitive-view`, {
        action: '查看地址和电话'
      }, { 'X-User-Id': broker.id })
    }
    try {
      await jsonRequest('POST', `/mini/listings/${normalListings[15].id}/sensitive-view`, {
        action: '查看地址和电话'
      }, { 'X-User-Id': broker.id })
      throw new Error('中介第 16 套普通房源查看被放行')
    } catch (error) {
      if (error.statusCode !== 403 || !error.body || !error.body.data || error.body.data.quotaCategory !== 'normal') throw error
    }
    const repeat = await jsonRequest('POST', `/mini/listings/${normalListings[0].id}/sensitive-view`, {
      action: '重复查看地址和电话'
    }, { 'X-User-Id': broker.id })
    if (!repeat.sensitive || !repeat.sensitive.address) throw new Error('重复查看已解锁房源失败')
    return `${broker.id}: owner 3/3, normal 15/15`
  })

  await check('带看水印审核增加普通房源额度', async () => {
    const brokerPhone = `136${Date.now().toString().slice(-8)}`
    const broker = await jsonRequest('POST', '/mini/auth/login', { phone: brokerPhone })
    const listing = await createSmokeListing('U001', 190, {
      ownerType: '二房东房源',
      houseSourceType: '二房东房源',
      source: '二房东房源',
      community: '冒烟带看水印小区',
      roomNumber: '1901'
    })
    const submitted = await jsonRequest('POST', `/mini/listings/${listing.id}/showings`, {
      photoUrl: 'https://example.com/showing-proof.jpg',
      photoKey: 'showing-photos/smoke/showing-proof.jpg',
      watermarkText: '寓你住一起 · 带看水印 | 时间 2026-06-19 20:00:00 | 位置 杭州',
      locationText: '现场定位 30.000000, 120.000000',
      latitude: 30,
      longitude: 120
    }, { 'X-User-Id': broker.id })
    if (!submitted.showing || submitted.showing.status !== '待审核') {
      throw new Error('带看水印照片未进入待审核')
    }
    const headers = { Authorization: `Bearer ${adminToken}` }
    const pendingRows = await jsonRequest('GET', '/admin/showings', null, headers)
    const pending = (pendingRows || []).find((item) => item.id === submitted.showing.id)
    if (!pending || pending.status !== '待审核' || !pending.photoUrl) {
      throw new Error('后台未返回待审核带看照片')
    }
    await jsonRequest('POST', `/admin/showings/${submitted.showing.id}/review`, {
      action: 'approve',
      note: '冒烟测试：水印照片核验通过'
    }, headers)
    const usersState = await jsonRequest('GET', '/admin/users', null, headers)
    const brokerRow = (usersState.users || []).find((item) => item.id === broker.id)
    if (!brokerRow || Number(brokerRow.normalViewLimit) < 16) {
      throw new Error('带看审核通过未增加普通房源额度')
    }
    const logs = await jsonRequest('GET', `/mini/listings/${listing.id}/footprints`, null, { 'X-User-Id': broker.id })
    if (!(logs || []).some((item) => item.action === '记录带看')) {
      throw new Error('带看审核通过后未生成记录带看足迹')
    }
    return `${broker.id}: 普通额度 ${brokerRow.normalViewLimit}`
  })

  await check('修改已上传房源', async () => {
    const listing = await jsonRequest('PUT', `/mini/my/listings/${smokeListings.owner.id}`, {
      city: '杭州',
      district: '上城区',
      area: '上城区',
      block: '上城区',
      communityName: '冒烟修改小区',
      community: '冒烟修改小区',
      buildingNo: '9',
      building: '9',
      unitNo: '2',
      unit: '2',
      roomNo: '901',
      roomNumber: '901',
      address: '杭州上城区冒烟修改小区9栋2单元901室',
      contact: '13800009999',
      rent: 3100,
      layout: '合租一室1厅1卫',
      commissionRate: 16,
      type: '合租',
      rentMode: '合租',
      room: '一室',
      hall: '1厅',
      bath: '1卫',
      features: ['独卫', '合租']
    }, { 'X-User-Id': 'U001' })
    const list = await jsonRequest('GET', '/mini/listings?community=冒烟修改小区', null, { 'X-User-Id': 'U001' })
    if (!listing || listing.commissionRate !== 16 || !list.length || list[0].type !== '合租' || list[0].features.indexOf('独卫') === -1) {
      throw new Error('修改已上传房源未生效')
    }
    return list[0].title
  })

  await check('OSS 上传策略', async () => {
    const videoPolicy = await jsonRequest('POST', '/mini/uploads/video-policy', {
      fileName: 'smoke.mp4'
    }, { 'X-User-Id': 'U001' })
    const screenshotPolicy = await jsonRequest('POST', '/mini/uploads/group-screenshot-policy', {
      fileName: 'group.jpg'
    }, { 'X-User-Id': 'U001' })
    const showingPolicy = await jsonRequest('POST', '/mini/uploads/showing-photo-policy', {
      fileName: 'showing-proof.jpg',
      mimeType: 'image/jpeg'
    }, { 'X-User-Id': 'U001' })
    if (videoPolicy.uploadMode !== 'oss-post' || screenshotPolicy.uploadMode !== 'oss-post' || showingPolicy.uploadMode !== 'oss-post') {
      throw new Error('OSS 未返回真实直传策略')
    }
    if (!String(showingPolicy.objectKey || '').startsWith('showing-photos/')) {
      throw new Error('带看水印照片未使用专用 OSS 目录')
    }
    return 'oss-post'
  })

  await check('群聊上传审核加分', async () => {
    const headers = { Authorization: `Bearer ${adminToken}` }
    const before = await jsonRequest('GET', '/mini/groups', null, { 'X-User-Id': 'U003' })
    await jsonRequest('POST', '/mini/groups/listings', {
      title: `冒烟测试群${Date.now()}`,
      area: '滨江',
      block: '西兴',
      screenshotKey: 'group-screenshots/smoke.jpg',
      screenshotUrl: 'https://example.com/group.jpg'
    }, { 'X-User-Id': 'U003' })
    let uploads = await jsonRequest('GET', '/admin/groups/uploads', null, headers)
    uploads = Array.isArray(uploads) ? uploads : [uploads]
    const upload = uploads.find((item) => item.status === '待审核' && item.uploaderPhone === '13800010003')
    if (!upload) throw new Error('未找到待审核群聊上传')
    await jsonRequest('POST', `/admin/groups/uploads/${upload.id}/review`, {
      action: 'approve',
      note: '冒烟测试：已联系核对'
    }, headers)
    const after = await jsonRequest('GET', '/mini/groups', null, { 'X-User-Id': 'U003' })
    if (Number(after.points) < Number(before.points) + 1) throw new Error('群聊审核通过未加积分')
    return `${before.points}->${after.points}`
  })

  await check('换群按用户扣积分', async () => {
    const state = await jsonRequest('GET', '/mini/groups', null, { 'X-User-Id': 'U003' })
    const target = (state.groups || []).find((item) => !item.unlocked)
    if (!target) return '无可解锁群，跳过'
    const result = await jsonRequest('POST', `/mini/groups/${target.id}/unlock`, {}, { 'X-User-Id': 'U003' })
    if (!result.ok || Number(result.data.points) !== Number(state.points) - 1) throw new Error('换群扣积分异常')
    const other = await jsonRequest('GET', '/mini/groups', null, { 'X-User-Id': 'U002' })
    const otherGroup = (other.groups || []).find((item) => item.id === target.id)
    if (otherGroup && otherGroup.unlocked) throw new Error('换群状态污染其他用户')
    return `${target.id}: ${state.points}->${result.data.points}`
  })

  await check('充值人工审核闭环', async () => {
    const headers = { Authorization: `Bearer ${adminToken}` }
    const created = await jsonRequest('POST', '/mini/points/recharge', { points: 1 }, { 'X-User-Id': 'U001' })
    if (!created.bill || created.bill.status !== '待确认') throw new Error('未创建待确认充值账单')
    await jsonRequest('POST', `/admin/recharges/${created.bill.id}/review`, {
      action: 'approve',
      note: '冒烟测试：确认到账'
    }, headers)
    const bills = await jsonRequest('GET', '/admin/recharges', null, headers)
    const bill = (Array.isArray(bills) ? bills : [bills]).find((item) => item.id === created.bill.id)
    if (!bill || bill.status !== '已确认到账') throw new Error('充值审核未到账')
    return created.bill.id
  })

  await check('成交分佣记录', async () => {
    const deal = await jsonRequest('POST', `/mini/listings/${smokeListings.adminOwned.id}/deals`, {}, { 'X-User-Id': 'U003' })
    const commissions = await jsonRequest('GET', '/mini/commissions', null, { 'X-User-Id': 'U003' })
    if (!deal.record || !(Array.isArray(commissions) ? commissions.length : 1)) throw new Error('分佣记录异常')
    return deal.record.id
  })

  await check('公司房源成交不分佣', async () => {
    const before = await jsonRequest('GET', '/mini/commissions', null, { 'X-User-Id': 'U003' })
    const deal = await jsonRequest('POST', `/mini/listings/${smokeListings.company.id}/deals`, {}, { 'X-User-Id': 'U003' })
    const after = await jsonRequest('GET', '/mini/commissions', null, { 'X-User-Id': 'U003' })
    if (!deal.noCommission || deal.record !== null) throw new Error('公司房源成交仍生成分佣')
    if ((after || []).length !== (before || []).length) throw new Error('公司房源成交增加了分佣记录')
    return deal.message
  })

  return results
}

async function main() {
  const originalData = fs.readFileSync(dataFile, 'utf8')
  let serverProcess = null

  try {
    if (!(await waitForServer())) {
      serverProcess = spawn(process.execPath, ['src/index.js'], {
        cwd: rootDir,
        env: process.env,
        stdio: 'ignore',
        windowsHide: true
      })
      if (!(await waitForServer())) throw new Error('后端服务启动失败')
    }

    const results = await runChecks()
    const failed = results.filter((item) => !item.ok)
    results.forEach((item) => {
      const mark = item.ok ? 'PASS' : 'FAIL'
      console.log(`${mark} ${item.name}: ${item.detail}`)
    })
    if (failed.length) {
      process.exitCode = 1
    }
  } finally {
    fs.writeFileSync(dataFile, originalData, 'utf8')
    if (serverProcess) serverProcess.kill()
  }
}

main().catch((error) => {
  console.error(`FAIL 冒烟测试运行失败: ${error.message}`)
  process.exit(1)
})
