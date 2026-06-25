const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const importDir = path.join(rootDir, '.tmp', 'feishu-import')
const candidatesPath = path.join(importDir, 'candidates.json')
const resultsPath = path.join(importDir, 'import-results.json')
const baseUrl = process.env.YNZY_API_BASE || 'https://zf-api.ynzyqbot.cn'
const adminAccount = process.env.YNZY_ADMIN_ACCOUNT || '19941091943'
const adminPassword = process.env.YNZY_ADMIN_PASSWORD || 'WZJwzj123'
const dryRun = process.env.DRY_RUN === '1'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function cleanBlock(value) {
  return String(value || '').replace(/\s+/g, '')
}

function inferArea(block) {
  const text = cleanBlock(block)
  if (/文三路|学院路|翠苑/.test(text)) return '西湖区'
  if (/闸弄口|新塘|元宝塘|东站/.test(text)) return '上城区'
  return '拱墅'
}

function normalizeHousePart(value, suffix) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.endsWith(suffix) ? text : `${text}${suffix}`
}

function parseRoomNo(value) {
  const parts = String(value || '').trim().split('-').filter(Boolean)
  if (parts.length >= 3) {
    return {
      building: parts[0],
      unit: parts[1],
      roomNumber: parts.slice(2).join('-')
    }
  }
  if (parts.length === 2) {
    return {
      building: parts[0],
      unit: '',
      roomNumber: parts[1]
    }
  }
  return {
    building: '',
    unit: '',
    roomNumber: String(value || '').trim()
  }
}

function inferRoom(layout, category) {
  const text = `${layout || ''}${category || ''}`
  if (/六室|6室/.test(text)) return '六室'
  if (/五室|5室/.test(text)) return '五室'
  if (/四室|4室/.test(text)) return '四室'
  if (/三室|3室/.test(text)) return '三室'
  if (/两室|二室|2室/.test(text)) return '二室'
  return '一室'
}

function inferHall(layout, category) {
  const text = `${layout || ''}${category || ''}`
  if (/六厅|6厅/.test(text)) return '6厅'
  if (/五厅|5厅/.test(text)) return '5厅'
  if (/四厅|4厅/.test(text)) return '4厅'
  if (/三厅|3厅/.test(text)) return '3厅'
  if (/两厅|二厅|2厅/.test(text)) return '2厅'
  if (/一厅|1厅/.test(text)) return '1厅'
  return '0厅'
}

function inferBath(layout, category) {
  const text = `${layout || ''}${category || ''}`
  if (/六卫|6卫/.test(text)) return '6卫'
  if (/五卫|5卫/.test(text)) return '5卫'
  if (/四卫|4卫/.test(text)) return '4卫'
  if (/三卫|3卫/.test(text)) return '3卫'
  if (/两卫|二卫|2卫/.test(text)) return '2卫'
  if (/公卫/.test(text)) return '公卫'
  return '1卫'
}

function buildAddress(item, area, roomParts) {
  return [
    '杭州',
    area,
    item.community,
    normalizeHousePart(roomParts.building, '栋'),
    normalizeHousePart(roomParts.unit, '单元'),
    normalizeHousePart(roomParts.roomNumber, '室')
  ].filter(Boolean).join('')
}

function buildUpdates() {
  const candidates = readJson(candidatesPath).candidates || []
  const results = readJson(resultsPath).successes || []
  const candidateByKey = new Map(candidates.map((item) => [item.importKey, item]))

  return results.map((result) => {
    const item = candidateByKey.get(result.importKey)
    if (!item) throw new Error(`缺少候选记录：${result.importKey}`)

    const area = inferArea(item.block)
    const roomParts = parseRoomNo(item.room)
    const rentMode = String(item.layout || '').includes('（整）') ? '整租' : '合租'
    const address = buildAddress(item, area, roomParts)

    return {
      id: result.listingId,
      payload: {
        city: '杭州',
        district: area,
        area,
        block: area,
        communityName: item.community,
        community: item.community,
        buildingNo: roomParts.building,
        building: roomParts.building,
        unitNo: roomParts.unit,
        unit: roomParts.unit,
        roomNo: roomParts.roomNumber,
        houseNo: roomParts.roomNumber,
        roomNumber: roomParts.roomNumber,
        address,
        contact: item.contact,
        rent: item.rent,
        layout: item.layout,
        type: rentMode,
        rentMode,
        bedroom: inferRoom(item.layout, item.category),
        room: inferRoom(item.layout, item.category),
        livingRoom: inferHall(item.layout, item.category),
        hall: inferHall(item.layout, item.category),
        bathroom: inferBath(item.layout, item.category),
        bath: inferBath(item.layout, item.category),
        commissionRate: 20
      }
    }
  })
}

async function request(pathname, options = {}) {
  const res = await fetch(new URL(pathname, baseUrl), options)
  const text = await res.text()
  let json = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch (error) {
    json = { raw: text }
  }
  if (!res.ok || json.code !== 0) {
    throw new Error(`${pathname} ${res.status}: ${json.message || text}`)
  }
  return json.data
}

async function main() {
  const updates = buildUpdates()
  const previewPath = path.join(importDir, 'listing-format-fix-plan.json')
  fs.writeFileSync(previewPath, JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, updates }, null, 2), 'utf8')

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, count: updates.length, previewPath }, null, 2))
    return
  }

  const login = await request('/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: adminAccount, password: adminPassword })
  })

  const updated = []
  for (const item of updates) {
    const detail = await request(`/admin/listings/${encodeURIComponent(item.id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.token}`
      },
      body: JSON.stringify(item.payload)
    })
    updated.push({
      id: item.id,
      title: detail.title,
      area: detail.area,
      type: detail.type || item.payload.type
    })
  }

  const list = await request('/mini/listings', {
    headers: { 'X-User-Id': 'U001' }
  })
  const listById = new Map(list.map((item) => [item.id, item]))
  const bad = updates.filter((item) => {
    const row = listById.get(item.id)
    return !row || row.area !== item.payload.area || row.block !== item.payload.block || row.type !== item.payload.type
  })

  console.log(JSON.stringify({
    previewPath,
    requested: updates.length,
    updated: updated.length,
    bad: bad.map((item) => item.id)
  }, null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
