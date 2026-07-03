const fs = require('fs')
const path = require('path')
const config = require('./config')
const domain = require('./domain')
const oss = require('./oss')

const COMPANY_FEATURES = ['免押金', '不分佣']
const MISSING_VIDEO_MATERIAL_STATUS = '缺视频素材'
const VIDEO_EXT_PATTERN = /\.(mp4|mov|m4v|avi|webm)$/i
const DOWN_STATUS_PATTERN = /下架|已租|已成交|成交|关闭|无效|删除|暂停|不可租|停租|down|off|inactive|rented|closed/i
const UP_STATUS_PATTERN = /上架|在租|待租|空置|可租|有效|up|on|active/i
const NOT_UP_PATTERN = /未上架|不上架|否|false|no|0/i
const SENSITIVE_FEISHU_FIELD_PATTERN = /(看房方式密码|看房方式|看房密码|门锁密码|密码|联系方式|联系电话|房东联系方式|房东电话|联系人电话|手机号|手机|电话|微信|身份证|证件)/i

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function sheetColumnNumber(label) {
  return String(label || '').toUpperCase().split('').reduce((sum, char) => {
    const code = char.charCodeAt(0)
    if (code < 65 || code > 90) return sum
    return sum * 26 + code - 64
  }, 0)
}

function widenSheetRange(rawRange) {
  const source = normalizeText(rawRange) || 'A1:ZZ1000'
  const bangIndex = source.lastIndexOf('!')
  const sheetName = bangIndex === -1 ? '' : source.slice(0, bangIndex)
  const cellRange = bangIndex === -1 ? source : source.slice(bangIndex + 1)
  const matched = cellRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i)
  if (!matched) return source

  const endColumn = sheetColumnNumber(matched[3]) < sheetColumnNumber('ZZ') ? 'ZZ' : matched[3].toUpperCase()
  const nextRange = `${matched[1].toUpperCase()}${matched[2]}:${endColumn}${matched[4]}`
  return sheetName ? `${sheetName}!${nextRange}` : nextRange
}

function id(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function readJson(filePath) {
  const target = path.isAbsolute(filePath) ? filePath : path.resolve(config.rootDir, '..', filePath)
  const content = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')
  const data = JSON.parse(content)
  return Array.isArray(data) ? data : (data.records || data.rows || data.items || data.candidates || data.materials || data.files || data.successes || [])
}

function normalizeText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim()
  }
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean).join(' ').trim()
  }
  if (typeof value === 'object') {
    const directKeys = ['text', 'name', 'value', 'phone', 'email', 'url', 'link', 'token']
    for (const key of directKeys) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
        const text = normalizeText(value[key])
        if (text) return text
      }
    }
    return Object.keys(value)
      .map((key) => normalizeText(value[key]))
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  return ''
}

function normalizedKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[|\s·,，。；;:：/\\_\-（）()【】\[\]{}#号幢栋单元室房]/g, '')
}

function firstField(fields, names) {
  const source = fields || {}
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(source, name)) {
      const value = normalizeText(source[name])
      if (value) return value
    }
  }
  const keys = Object.keys(source)
  for (const name of names) {
    const targetKey = normalizedKey(name)
    if (targetKey.length < 2) continue
    const matched = keys.find((key) => {
      const currentKey = normalizedKey(key)
      return currentKey.length >= 2 && currentKey === targetKey
    })
    if (matched) {
      const value = normalizeText(source[matched])
      if (value) return value
    }
  }
  return ''
}

function numberFrom(value) {
  const direct = Number(value)
  if (Number.isFinite(direct)) return direct
  const matched = normalizeText(value).match(/(\d+(?:\.\d+)?)/)
  return matched ? Number(matched[1]) : 0
}

function unique(values) {
  const seen = new Set()
  return (values || []).map(normalizeText).filter(Boolean).filter((item) => {
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
}

function configuredDistrictName(value) {
  const text = normalizeText(value)
  if (!text) return ''
  const districts = Object.keys((config.location && config.location.districtBlocks) || {})
  return districts.find((district) => district === text || district.replace(/区$/, '') === text.replace(/区$/, '')) || ''
}

function districtForBlock(block, fallback) {
  const matchedDistrict = configuredDistrictName(fallback) || configuredDistrictName(block)
  if (matchedDistrict) return matchedDistrict
  const blockMap = (config.location && config.location.blockDistrictMap) || {}
  return blockMap[normalizeText(block)] || fallback || '待分区'
}

function normalizeLocationFields(fields = {}) {
  const explicitDistrict = firstField(fields, ['行政区', '城区', '城市区域', 'districtName'])
  const block = firstField(fields, ['板块', '商圈', '区域', '区', 'district', 'area']) || '待板块'
  return {
    area: districtForBlock(block, explicitDistrict),
    block
  }
}

function isSensitiveFeishuField(name) {
  return SENSITIVE_FEISHU_FIELD_PATTERN.test(normalizeText(name).replace(/\s+/g, ''))
}

function stripSensitiveFields(fields = {}) {
  return Object.keys(fields || {}).reduce((next, key) => {
    if (!isSensitiveFeishuField(key)) next[key] = fields[key]
    return next
  }, {})
}

function stripSensitiveSheetRows(rows = []) {
  const headerIndex = rows.findIndex((row) => (row || []).some((cell) => isSensitiveFeishuField(cell)))
  const header = headerIndex >= 0 ? (rows[headerIndex] || []) : defaultSheetHeaders
  const sensitiveIndexes = new Set((header || [])
    .map((cell, index) => (isSensitiveFeishuField(cell) ? index : -1))
    .filter((index) => index >= 0))
  if (!sensitiveIndexes.size) return rows
  return rows.map((row = []) => row.filter((_, index) => !sensitiveIndexes.has(index)))
}

function normalizeRoomPart(value, type) {
  let text = normalizeText(value).replace(/\s+/g, '')
  if (!text) return ''
  text = text.replace(/[，,。；;:：]/g, '')
  if (type === 'building') return text.replace(/^(第)/, '').replace(/(?:号楼|楼|幢|栋|号)$/g, '')
  if (type === 'unit') return text.replace(/^(第)/, '').replace(/(?:单元)$/g, '')
  return text.replace(/^(第)/, '').replace(/(?:房间|房|室)$/g, '')
}

function parseRoomText(value) {
  const text = normalizeText(value).replace(/\s+/g, '')
  if (!text) return null
  const dashed = text.split(/[-－—]/).map((item) => item.trim()).filter(Boolean)
  if (dashed.length >= 3) {
    return {
      building: normalizeRoomPart(dashed[0], 'building'),
      unit: normalizeRoomPart(dashed[1], 'unit'),
      roomNumber: normalizeRoomPart(dashed.slice(2).join('-'), 'room')
    }
  }
  const matched = text.match(/^(.+?)(?:号楼|楼|幢|栋)(.+?)单元(.+?)(?:房间|房|室)?$/)
  if (!matched) return null
  return {
    building: normalizeRoomPart(matched[1], 'building'),
    unit: normalizeRoomPart(matched[2], 'unit'),
    roomNumber: normalizeRoomPart(matched[3], 'room')
  }
}

function parseRoomParts(fields) {
  const building = firstField(fields, ['几栋', '楼栋', '栋', '幢', '楼号', 'building', 'buildingNo'])
  const unit = firstField(fields, ['几单元', '单元', 'unit', 'unitNo'])
  const roomNumber = firstField(fields, ['房间号', '房号', '门牌号', '室', 'roomNumber', 'roomNo'])
  if ((building || unit) && roomNumber) {
    return {
      building: normalizeRoomPart(building, 'building'),
      unit: normalizeRoomPart(unit, 'unit'),
      roomNumber: normalizeRoomPart(roomNumber, 'room')
    }
  }

  const rawRoom = roomNumber || firstField(fields, ['房间', '房源房号', '房源编号', '编号', 'room', '房号'])
  const parsedRoom = parseRoomText(rawRoom)
  if (parsedRoom) return parsedRoom
  const parts = rawRoom.split(/[-－—]/).map((item) => item.trim()).filter(Boolean)
  if (parts.length >= 3) {
    return {
      building: normalizeRoomPart(parts[0], 'building'),
      unit: normalizeRoomPart(parts[1], 'unit'),
      roomNumber: normalizeRoomPart(parts.slice(2).join('-'), 'room')
    }
  }
  if (parts.length === 2) {
    return { building: normalizeRoomPart(parts[0], 'building'), unit: '', roomNumber: normalizeRoomPart(parts[1], 'room') }
  }
  return { building: '', unit: '', roomNumber: normalizeRoomPart(rawRoom, 'room') }
}

function inferRoom(layoutText) {
  const text = normalizeText(layoutText)
  if (/六室|6室/.test(text)) return '六室'
  if (/五室|5室/.test(text)) return '五室'
  if (/四室|4室/.test(text)) return '四室'
  if (/三室|3室/.test(text)) return '三室'
  if (/两室|二室|2室/.test(text)) return '二室'
  return '一室'
}

function inferHall(layoutText) {
  const text = normalizeText(layoutText)
  const matched = text.match(/([0-6一二三四五六两])\s*厅/)
  if (!matched) return '0厅'
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
  const value = map[matched[1]] || Number(matched[1]) || 0
  return `${Math.min(6, value)}厅`
}

function inferBath(layoutText) {
  const text = normalizeText(layoutText)
  if (/公卫/.test(text)) return '公卫'
  const matched = text.match(/([0-6一二三四五六两])\s*卫/)
  if (!matched) return '1卫'
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
  const value = map[matched[1]] || Number(matched[1]) || 1
  return `${Math.min(6, value)}卫`
}

function inferRentMode(fields, layoutText) {
  const text = [
    firstField(fields, ['出租方式', '租赁方式', '类型', '整合租', 'type', 'rentMode']),
    layoutText
  ].join(' ')
  if (/合租|单间|独卫|公卫|[A-Z]室/i.test(text)) return '合租'
  if (/整租|整套/.test(text)) return '整租'
  return '整租'
}

function parseLayoutDescription(fields) {
  const description = firstField(fields, ['户型描述', '描述', '房源描述', '户型信息', '房源信息', '房源详情', 'layoutDescription', 'description'])
  const fallback = firstField(fields, ['户型', '格局', 'layout', 'category']) || firstField(fields, ['备注', 'remark'])
  const source = description || fallback
  const wholeRentPrefix = /^\s*[（(]\s*整\s*[）)]\s*/
  if (description) {
    return {
      layoutText: source.replace(wholeRentPrefix, '').trim(),
      rentMode: wholeRentPrefix.test(source) ? '整租' : '合租'
    }
  }
  return {
    layoutText: source,
    rentMode: inferRentMode(fields, source)
  }
}

const CONTACT_FIELD_ALIASES = ['联系方式', '联系电话', '房东联系方式', '房东电话', '联系人电话', '手机号', '手机', '电话', '微信', 'contact', 'phone', 'mobile', 'wechat']
const VIEWING_PASSWORD_FIELD_ALIASES = ['看房方式密码', '看房密码', '门锁密码', '密码', 'viewingPassword', 'showingPassword', 'password']
const REMARK_FIELD_ALIASES = ['备注', '说明', '备注说明', '水电', 'note', 'remark', 'memo']

function roomAddressFromParts(parts = {}) {
  return [parts.building, parts.unit, parts.roomNumber].filter(Boolean).join('-')
}

function normalizeRecord(rawRecord, index) {
  const fields = rawRecord.fields || rawRecord
  const community = firstField(fields, ['小区名称', '小区', '楼盘', 'community', 'sourceCommunity'])
  const location = normalizeLocationFields(fields)
  const roomParts = parseRoomParts(fields)
  const fallbackKey = [community, roomParts.building, roomParts.unit, roomParts.roomNumber].filter(Boolean).join('|')
  const externalId = firstField(fields, ['房源编号', '唯一编号', '编号', 'ID', 'id', 'importKey', 'record_id']) || rawRecord.record_id || fallbackKey
  const parsedLayout = parseLayoutDescription(fields)
  const layoutText = parsedLayout.layoutText
  const statusText = firstField(fields, ['状态', '房源状态', '出租状态', '上下架', '是否上架', '是否下架', 'status'])
  const upFlagText = firstField(fields, ['是否上架', '上架'])
  const downFlagText = firstField(fields, ['是否下架', '下架'])
  const rentMode = parsedLayout.rentMode
  const room = firstField(fields, ['室', '卧室', 'room', 'bedroom']) || inferRoom(layoutText)
  const hall = firstField(fields, ['厅', 'hall', 'livingRoom']) || inferHall(layoutText)
  const bath = firstField(fields, ['卫', 'bath', 'bathroom']) || inferBath(layoutText)
  const featureText = firstField(fields, ['标签', '房源特点', '特点', 'featureTags', 'features'])
  const contact = firstField(fields, CONTACT_FIELD_ALIASES)
  const viewingPassword = firstField(fields, VIEWING_PASSWORD_FIELD_ALIASES)
  const remark = firstField(fields, REMARK_FIELD_ALIASES)
  const video = rawRecord.video || fields.video || fields.视频 || null
  return {
    raw: rawRecord,
    rowNumber: rawRecord.rowNumber || rawRecord.row_number || index + 1,
    externalId,
    matchKey: externalId || fallbackKey,
    city: firstField(fields, ['城市', 'city']) || '杭州',
    area: location.area,
    block: location.block,
    community,
    building: roomParts.building,
    unit: roomParts.unit,
    roomNumber: roomParts.roomNumber,
    roomAddress: roomAddressFromParts(roomParts),
    contact: contact || '公司统一维护',
    viewingPassword,
    showingPassword: viewingPassword,
    remark,
    rent: numberFrom(firstField(fields, ['租金', '月租', '价格', '押一付一', '押二付一', '月付价', '押一', '押二', 'rent', 'price'])),
    layout: layoutText || [room, hall, bath].filter(Boolean).join(''),
    rentMode,
    room,
    hall,
    bath,
    statusText,
    isDown: Boolean(
      (DOWN_STATUS_PATTERN.test(statusText) && !UP_STATUS_PATTERN.test(statusText)) ||
      NOT_UP_PATTERN.test(upFlagText) ||
      (/是|true|yes|1/.test(downFlagText) && !/否|false|no|0/.test(downFlagText))
    ),
    tags: unique(featureText.split(/[、,，\s]+/).concat(COMPANY_FEATURES)),
    video
  }
}

function materialFromRaw(raw, parentPath = '') {
  const name = normalizeText(raw.name || raw.file_name || raw.filename || raw.title || raw.path)
  const token = normalizeText(raw.token || raw.file_token || raw.sourceVideoToken || raw.obj_token || raw.id)
  const filePath = normalizeText(raw.localFilePath || raw.filePath || raw.path)
  const url = normalizeText(raw.videoUrl || raw.url || raw.fileUrl || raw.web_url || raw.downloadUrl)
  const type = normalizeText(raw.type || raw.file_type || raw.mime_type)
  const existingSourcePath = normalizeText(raw.sourcePath || raw.source_path || raw.drivePath || raw.folderPath)
  const sourcePath = existingSourcePath || [parentPath, name].filter(Boolean).join('/')
  return {
    raw,
    name,
    token,
    type,
    url,
    videoUrl: normalizeText(raw.videoUrl || raw.fileUrl || raw.url),
    videoKey: normalizeText(raw.videoKey || raw.objectKey || raw.ossKey),
    localFilePath: filePath && fs.existsSync(filePath) ? filePath : '',
    sourcePath,
    key: normalizedKey([sourcePath, name, token, filePath].filter(Boolean).join(' '))
  }
}

function findLocalVideoByToken(token) {
  if (!token) return ''
  const dir = path.resolve(config.rootDir, '..', '.tmp', 'feishu-import', 'videos')
  if (!fs.existsSync(dir)) return ''
  const file = fs.readdirSync(dir).find((name) => name.indexOf(token) !== -1 && VIDEO_EXT_PATTERN.test(name))
  return file ? path.join(dir, file) : ''
}

function materialCandidatesFromRecord(row) {
  if (!row.video) return []
  const direct = materialFromRaw(row.video)
  const localFilePath = direct.localFilePath || findLocalVideoByToken(direct.token)
  return [{ ...direct, localFilePath }]
}

function createMaterialMatcher(materials) {
  const normalized = (materials || []).map((item) => (
    item && item.key && item.sourcePath ? item : materialFromRaw(item)
  ))
  const byToken = new Map()
  normalized.forEach((item) => {
    if (item.token) byToken.set(item.token, item)
  })
  return (row) => {
    const direct = materialCandidatesFromRecord(row).find((item) => item.videoUrl || item.url || item.localFilePath || item.token)
    if (direct) return direct
    const keys = unique([
      row.matchKey,
      row.externalId,
      row.roomNumber,
      [row.building, row.unit, row.roomNumber].filter(Boolean).join(''),
      [row.building, row.roomNumber].filter(Boolean).join(''),
      [row.community, row.building, row.unit, row.roomNumber].filter(Boolean).join(''),
      [row.community, row.roomNumber].filter(Boolean).join('')
    ]).map(normalizedKey).filter((key) => key.length >= 3)
    return normalized.find((item) => {
      if (!VIDEO_EXT_PATTERN.test(item.name || '') && !/^video\//.test(item.type || '')) return false
      if (item.token && keys.some((key) => byToken.has(key))) return true
      return keys.some((key) => item.key.indexOf(key) !== -1 || key.indexOf(item.key) !== -1)
    }) || null
  }
}

async function feishuJson(pathname, token, options = {}) {
  const response = await fetch(`${trimSlash(config.feishu.baseUrl)}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || (body.code !== undefined && body.code !== 0)) {
    const error = new Error(body.msg || body.message || `飞书接口请求失败：${response.status}`)
    error.statusCode = response.status || 502
    throw error
  }
  return body.data || body
}

async function tenantAccessToken() {
  if (!config.feishu.appId || !config.feishu.appSecret) {
    const error = new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET')
    error.statusCode = 503
    throw error
  }
  const data = await feishuJson('/auth/v3/tenant_access_token/internal', '', {
    method: 'POST',
    body: {
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret
    }
  })
  return data.tenant_access_token
}

async function loadBitableRecords(token) {
  const appToken = config.feishu.bitableAppToken
  const tableId = config.feishu.bitableTableId
  if (!appToken || !tableId) return []
  let pageToken = ''
  const records = []
  do {
    const params = new URLSearchParams({ page_size: String(config.feishu.pageSize) })
    if (pageToken) params.set('page_token', pageToken)
    const data = await feishuJson(`/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${params.toString()}`, token)
    records.push(...(data.items || []))
    pageToken = data.page_token || ''
    if (!data.has_more) break
  } while (pageToken)
  return records
}

async function loadSheetMeta(token) {
  const sheetToken = config.feishu.sheetToken
  if (!sheetToken) return null
  const data = await feishuJson(`/sheets/v2/spreadsheets/${encodeURIComponent(sheetToken)}/metainfo`, token)
  const sheets = data.sheets || data.sheet || []
  return Array.isArray(sheets) && sheets.length ? sheets[0] : null
}

async function resolveSheetRange(token) {
  const sheetToken = config.feishu.sheetToken
  if (!sheetToken) {
    const error = new Error('未配置飞书表格，无法生成实时截图')
    error.statusCode = 503
    throw error
  }

  let sheetId = config.feishu.sheetId
  if (!sheetId) {
    const firstSheet = await loadSheetMeta(token)
    sheetId = firstSheet && (firstSheet.sheetId || firstSheet.sheet_id || firstSheet.id)
  }
  if (!sheetId) {
    const error = new Error('未找到飞书房源表工作表 ID，请配置 FEISHU_SHEET_ID')
    error.statusCode = 503
    throw error
  }

  const rawRange = widenSheetRange(config.feishu.sheetRange || 'A1:ZZ1000')
  return rawRange.indexOf('!') !== -1 ? rawRange : `${sheetId}!${rawRange}`
}

async function loadSheetValues(token) {
  const sheetToken = config.feishu.sheetToken
  const range = await resolveSheetRange(token)
  const data = await feishuJson(`/sheets/v2/spreadsheets/${encodeURIComponent(sheetToken)}/values/${encodeURIComponent(range)}`, token)
  const valueRange = data.valueRange || data.value_range || {}
  return {
    range,
    values: valueRange.values || data.values || []
  }
}

function isSheetHeaderRow(row = []) {
  const text = row.map((item) => normalizeText(item)).join('|')
  return /区域/.test(text) && /小区/.test(text) && /房号|房间号/.test(text)
}

const defaultSheetHeaders = ['区域', '小区', '房号', '户型描述', '户型分类', '押一付一', '押二付一', '看房方式密码', '备注']

function snapshotColumnIndex(header = [], matcher) {
  return (header || []).findIndex((item) => matcher(normalizeText(item)))
}

function normalizeSnapshotRows(rows = []) {
  const sourceRows = (Array.isArray(rows) ? rows : [])
    .map((row) => (Array.isArray(row) ? row : []))
  const columnCount = Math.max(0, ...sourceRows.map((row) => row.length))
  if (!columnCount) return []

  const paddedRows = sourceRows.map((row) => {
    return Array.from({ length: columnCount }).map((_, index) => normalizeText(row[index]))
  })
  const headerIndex = paddedRows.findIndex(isSheetHeaderRow)
  if (headerIndex < 0) return paddedRows

  const header = paddedRows[headerIndex] || []
  const areaIndex = snapshotColumnIndex(header, (text) => text === '区域' || text === '区' || /片区|商圈/.test(text))
  const communityIndex = snapshotColumnIndex(header, (text) => /小区|楼盘|社区/.test(text))
  let lastArea = ''
  let lastCommunity = ''

  return paddedRows.map((row, index) => {
    if (index <= headerIndex) return row
    const next = row.slice()
    const hasRowValue = next.some((cell) => normalizeText(cell))
    if (!hasRowValue) return next
    const hasListingValue = next.some((cell, colIndex) => {
      if (colIndex === areaIndex || colIndex === communityIndex) return false
      return Boolean(normalizeText(cell))
    })

    if (areaIndex >= 0) {
      if (next[areaIndex]) {
        lastArea = next[areaIndex]
        if (!hasListingValue) lastCommunity = ''
      } else if (lastArea && hasListingValue) {
        next[areaIndex] = lastArea
      }
    }
    if (communityIndex >= 0) {
      if (next[communityIndex]) {
        lastCommunity = next[communityIndex]
      } else if (lastCommunity && hasListingValue) {
        next[communityIndex] = lastCommunity
      }
    }
    return next
  })
}

function sheetContactFromIntro(rows = []) {
  const text = rows.map((row) => (row || []).map((item) => normalizeText(item)).join(' ')).join(' ')
  const matched = text.match(/(?:联系方式|电话|联系)[:：]?\s*([0-9/\-\s]{8,})/)
  return matched ? matched[1].replace(/\s+/g, '') : ''
}

function sheetRowsToRecords(values = []) {
  const rows = Array.isArray(values) ? values : []
  const foundHeaderIndex = rows.findIndex(isSheetHeaderRow)
  const hasHeader = foundHeaderIndex >= 0
  const headerIndex = hasHeader ? foundHeaderIndex : -1
  const headers = hasHeader ? (rows[headerIndex] || []).map((item) => normalizeText(item)) : defaultSheetHeaders
  const areaHeader = headers.find((item) => item === '区域' || item === '区') || '区域'
  const communityHeader = headers.find((item) => /小区/.test(item)) || '小区'
  const records = []
  let lastArea = ''
  let lastCommunity = ''

  const dataRows = hasHeader ? rows.slice(headerIndex + 1) : rows
  dataRows.forEach((cells, index) => {
    const fields = {}
    let hasRowValue = false
    let hasListingValue = false
    headers.forEach((header, colIndex) => {
      if (!header) return
      const value = cells[colIndex]
      fields[header] = value
      if (normalizeText(value)) hasRowValue = true
      if (colIndex > 0 && normalizeText(value)) hasListingValue = true
    })
    if (!hasRowValue) return

    const currentArea = normalizeText(fields[areaHeader])
    const currentCommunity = normalizeText(fields[communityHeader])
    if (currentArea) {
      lastArea = currentArea
      if (!hasListingValue) lastCommunity = ''
    }
    if (currentCommunity) lastCommunity = currentCommunity
    if (!hasListingValue) return
    if (!currentArea && lastArea) fields[areaHeader] = lastArea
    if (!currentCommunity && lastCommunity) fields[communityHeader] = lastCommunity
    const explicitRecordId = firstField(fields, ['房源编号', '编号', 'ID', 'id'])
    records.push({
      record_id: explicitRecordId,
      rowNumber: (hasHeader ? headerIndex + 2 : 1) + index,
      fields
    })
  })
  return records
}

async function loadSheetRecords(token) {
  const sheetToken = config.feishu.sheetToken
  if (!sheetToken) return []
  const sheetData = await loadSheetValues(token)
  return sheetRowsToRecords(sheetData.values)
}

function trimSheetValues(values = []) {
  const rows = Array.isArray(values) ? values : []
  let minRow = -1
  let maxRow = -1
  let minCol = -1
  let maxCol = -1

  rows.forEach((row, rowIndex) => {
    const cells = Array.isArray(row) ? row : []
    cells.forEach((cell, colIndex) => {
      if (!normalizeText(cell)) return
      if (minRow === -1 || rowIndex < minRow) minRow = rowIndex
      if (maxRow === -1 || rowIndex > maxRow) maxRow = rowIndex
      if (minCol === -1 || colIndex < minCol) minCol = colIndex
      if (maxCol === -1 || colIndex > maxCol) maxCol = colIndex
    })
  })

  if (minRow === -1) {
    return {
      rows: [],
      startRow: 0,
      startCol: 0,
      rowCount: 0,
      columnCount: 0
    }
  }

  const columnCount = maxCol - minCol + 1
  const trimmedRows = rows.slice(minRow, maxRow + 1).map((row) => {
    const cells = Array.isArray(row) ? row : []
    return Array.from({ length: columnCount }).map((_, index) => normalizeText(cells[minCol + index]))
  })
  const normalizedRows = normalizeSnapshotRows(trimmedRows)

  return {
    rows: normalizedRows,
    startRow: minRow + 1,
    startCol: minCol + 1,
    rowCount: normalizedRows.length,
    columnCount: normalizedRows[0] ? normalizedRows[0].length : 0
  }
}

function sanitizeSheetSnapshot(snapshot = {}) {
  const rows = normalizeSnapshotRows(Array.isArray(snapshot.rows) ? snapshot.rows : [])
  return {
    ...snapshot,
    rows,
    rowCount: rows.length,
    columnCount: rows[0] ? rows[0].length : 0,
    sensitiveStripped: false
  }
}

async function sheetSnapshot(options = {}) {
  const token = options.feishuToken || await tenantAccessToken()
  const sheetData = await loadSheetValues(token)
  const snapshot = trimSheetValues(sheetData.values)
  return {
    title: '寓你住一起房源表',
    sheetUrl: config.feishu.sheetUrl,
    range: sheetData.range,
    updatedAt: nowText(),
    ...snapshot
  }
}

function cachedSheetSnapshot(db = {}) {
  const snapshot = db.companySheetSnapshot
  return snapshot && Array.isArray(snapshot.rows) && snapshot.rows.length ? sanitizeSheetSnapshot(snapshot) : null
}

async function refreshSheetSnapshot(db = {}, options = {}) {
  const snapshot = await sheetSnapshot(options)
  db.companySheetSnapshot = sanitizeSheetSnapshot({
    ...snapshot,
    cachedAt: nowText()
  })
  return db.companySheetSnapshot
}

async function loadFolderMaterials(token, folderToken, parentPath = '', depth = 0) {
  if (!folderToken || depth > config.feishu.maxFolderDepth) return []
  let pageToken = ''
  const materials = []
  do {
    const params = new URLSearchParams({
      folder_token: folderToken,
      page_size: String(config.feishu.pageSize)
    })
    if (pageToken) params.set('page_token', pageToken)
    const data = await feishuJson(`/drive/v1/files?${params.toString()}`, token)
    const files = data.files || data.items || []
    for (const file of files) {
      const name = normalizeText(file.name || file.file_name)
      const type = normalizeText(file.type || file.file_type)
      if (/folder/i.test(type)) {
        const childToken = file.token || file.file_token
        const children = await loadFolderMaterials(token, childToken, [parentPath, name].filter(Boolean).join('/'), depth + 1)
        materials.push(...children)
      } else if (VIDEO_EXT_PATTERN.test(name) || /^video\//i.test(type)) {
        materials.push(materialFromRaw(file, parentPath))
      }
    }
    pageToken = data.page_token || ''
    if (!data.has_more) break
  } while (pageToken)
  return materials
}

async function downloadFeishuMaterial(token, material) {
  if (material.localFilePath) {
    return {
      buffer: fs.readFileSync(material.localFilePath),
      contentType: 'video/mp4'
    }
  }
  if (!material.token) {
    const error = new Error('素材缺少飞书 token，无法下载到 OSS')
    error.statusCode = 400
    throw error
  }
  const endpoints = [
    `/drive/v1/medias/${encodeURIComponent(material.token)}/download`,
    `/drive/v1/files/${encodeURIComponent(material.token)}/download`
  ]
  let lastStatus = 0
  let lastText = ''
  for (const endpoint of endpoints) {
    const response = await fetch(`${trimSlash(config.feishu.baseUrl)}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (response.ok) {
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'video/mp4'
      }
    }
    lastStatus = response.status
    lastText = await response.text().catch(() => '')
  }
  const error = new Error(`飞书素材下载失败：${lastStatus}${lastText ? ` ${lastText.slice(0, 120)}` : ''}`)
  error.statusCode = lastStatus
  throw error
}

async function ensureMaterialVideo(token, material, options = {}) {
  if (options.dryRun) {
    return {
      videoKey: material.videoKey || '',
      videoUrl: material.videoUrl || material.url || 'dry-run://matched-material',
      materialUrl: material.videoUrl || material.url || material.sourcePath || material.name || ''
    }
  }
  if (material.videoKey && material.videoUrl) {
    return { videoKey: material.videoKey, videoUrl: material.videoUrl, materialUrl: material.videoUrl }
  }
  if (!config.feishu.uploadToOss && (material.videoUrl || material.url)) {
    return { videoKey: '', videoUrl: material.videoUrl || material.url, materialUrl: material.videoUrl || material.url }
  }
  if (config.feishu.uploadToOss && (material.localFilePath || material.token)) {
    const policy = oss.createVideoUploadPolicy({ fileName: material.name || 'feishu-video.mp4' })
    if (policy.uploadMode === 'oss-post') {
      const downloaded = await downloadFeishuMaterial(token, material)
      const saved = await oss.putObjectBuffer(policy.objectKey, downloaded.buffer, downloaded.contentType)
      return { videoKey: saved.objectKey, videoUrl: saved.fileUrl, materialUrl: material.url || '' }
    }
    if (material.videoUrl || material.url) {
      return { videoKey: '', videoUrl: material.videoUrl || material.url, materialUrl: material.videoUrl || material.url }
    }
  }
  const videoUrl = material.videoUrl || material.url || ''
  if (!videoUrl) {
    const error = new Error('素材已匹配，但没有可用视频地址；请开启 FEISHU_UPLOAD_TO_OSS 并补齐 OSS/RAM 配置')
    error.statusCode = 400
    throw error
  }
  return { videoKey: '', videoUrl, materialUrl: videoUrl }
}

function downListing(db, listing, reason, adminId) {
  if (!listing || listing.lifecycleStatus === 'expired' || listing.status === '已下架') return false
  const now = nowText()
  listing.lifecycleStatus = 'expired'
  listing.status = '已下架'
  listing.expiredAt = now
  listing.expiredBy = adminId || 'feishu-sync'
  listing.expiredPool = '后台废房源池'
  listing.expiredReason = reason
  listing.updatedAt = now
  db.footprints = db.footprints || []
  db.footprints.unshift({
    id: id('F'),
    listingId: listing.id,
    viewerId: adminId || 'feishu-sync',
    action: '飞书同步下架',
    time: now,
    sync: reason
  })
  return true
}

function existingByExternalId(db) {
  const map = new Map()
  ;(db.listings || []).forEach((listing) => {
    if (listing.externalSource === 'feishu' && listing.feishuRecordId) {
      map.set(String(listing.feishuRecordId), listing)
    }
  })
  return map
}

function buildListingPayload(row, video) {
  return {
    city: row.city || '杭州',
    district: row.area || '待分区',
    area: row.area || '待分区',
    block: row.block || row.area || '待板块',
    communityName: row.community,
    community: row.community,
    building: row.building,
    unit: row.unit,
    roomNumber: row.roomNumber,
    roomAddress: row.roomAddress,
    contact: row.contact || '公司统一维护',
    rent: row.rent,
    layout: row.layout,
    rentMode: row.rentMode,
    type: row.rentMode,
    room: row.room,
    hall: row.hall,
    bath: row.bath,
    commissionRate: 0,
    features: row.tags,
    companyListing: true,
    source: '公司房源',
    videoUrl: video.videoUrl || '',
    videoKey: video.videoKey || '',
    viewingPassword: row.viewingPassword || '',
    showingPassword: row.showingPassword || row.viewingPassword || '',
    remark: row.remark || '',
    note: row.remark || ''
  }
}

function attachFeishuFields(listing, row, material, video) {
  listing.externalSource = 'feishu'
  listing.feishuRecordId = String(row.externalId)
  listing.feishuMatchKey = row.matchKey
  listing.feishuRowNumber = row.rowNumber
  listing.feishuStatusText = row.statusText
  listing.landlordPhone = row.contact || listing.landlordPhone || ''
  listing.contact = row.contact || listing.contact || listing.landlordPhone || ''
  listing.viewingPassword = row.viewingPassword || ''
  listing.showingPassword = row.showingPassword || row.viewingPassword || ''
  listing.remark = row.remark || ''
  listing.note = row.remark || ''
  listing.roomAddress = row.roomAddress || roomAddressFromParts(row)
  const hasMaterial = Boolean(material)
  listing.sourceMaterialToken = hasMaterial ? (material.token || '') : ''
  listing.sourceMaterialName = hasMaterial ? (material.name || '') : ''
  listing.sourceMaterialPath = hasMaterial ? (material.sourcePath || '') : ''
  listing.sourceMaterialUrl = hasMaterial ? (video.materialUrl || material.url || '') : ''
  listing.syncStatus = hasMaterial ? '已同步飞书' : MISSING_VIDEO_MATERIAL_STATUS
  listing.videoMaterialStatus = hasMaterial ? '已匹配视频素材' : MISSING_VIDEO_MATERIAL_STATUS
  listing.missingVideoMaterial = !hasMaterial
  listing.syncedAt = nowText()
  listing.status = '在租'
  listing.lifecycleStatus = 'active'
  listing.reviewStatus = '无需审核'
  listing.lastVerifiedAt = listing.syncedAt
  listing.updatedAt = listing.syncedAt
  delete listing.expiredAt
  delete listing.expiredBy
  delete listing.expiredPool
  delete listing.expiredReason
  delete listing.expiredStaleDays
}

async function applySync(db, rows, materials, adminId, options = {}) {
  db.listings = db.listings || []
  db.feishuSyncLogs = db.feishuSyncLogs || []
  const matcher = createMaterialMatcher(materials)
  const byExternalId = existingByExternalId(db)
  const seen = new Set()
  const result = {
    dryRun: Boolean(options.dryRun),
    startedAt: nowText(),
    finishedAt: '',
    sourceRecordCount: rows.length,
    materialCount: materials.length,
    created: 0,
    updated: 0,
    down: 0,
    skippedNoMaterial: 0,
    missingVideoMaterial: 0,
    skippedInvalid: 0,
    failed: 0,
    messages: []
  }

  for (const [rowIndex, rawRow] of rows.entries()) {
    const row = normalizeRecord(rawRow, rowIndex)
    if (!row.externalId) {
      result.skippedInvalid += 1
      result.messages.push(`第 ${row.rowNumber} 行缺少房源编号或小区房号，已跳过`)
      continue
    }
    seen.add(String(row.externalId))
    const existing = byExternalId.get(String(row.externalId))
    if (row.isDown) {
      if (existing && downListing(db, existing, '飞书房源表已下架，自动同步下架', adminId)) result.down += 1
      continue
    }

    if (!row.community || !row.building || !row.roomNumber || !row.rent || !row.layout) {
      result.skippedInvalid += 1
      result.messages.push(`第 ${row.rowNumber} 行字段不完整，需小区、几栋、房间号、租金、户型`)
      continue
    }
    const material = matcher(row)
    if (!material) {
      result.skippedNoMaterial += 1
      result.missingVideoMaterial += 1
      if (result.messages.length < 20) {
        result.messages.push(`第 ${row.rowNumber} 行未匹配素材，已标记缺视频素材：${[row.community, row.building, row.unit, row.roomNumber].filter(Boolean).join('-') || row.matchKey}`)
      }
    }

    try {
      const video = material
        ? await ensureMaterialVideo(options.feishuToken || '', material, options)
        : { videoKey: '', videoUrl: '', materialUrl: '' }
      const payload = buildListingPayload(row, video)
      if (existing) {
        if (existing.lifecycleStatus === 'expired' || existing.status === '已下架') {
          existing.lifecycleStatus = 'active'
          existing.status = '在租'
        }
        domain.updateNormalListing(db, adminId, existing.id, payload, { admin: true })
        attachFeishuFields(existing, row, material, video)
        result.updated += 1
      } else {
        const detail = domain.addNormalListing(db, adminId, payload, { admin: true, skipPointLog: true })
        const listing = db.listings.find((item) => item.id === detail.id)
        attachFeishuFields(listing, row, material, video)
        result.created += 1
      }
    } catch (error) {
      result.failed += 1
      result.messages.push(`第 ${row.rowNumber} 行同步失败：${error.message}`)
    }
  }

  db.listings.forEach((listing) => {
    if (listing.externalSource !== 'feishu' || !listing.feishuRecordId) return
    if (seen.has(String(listing.feishuRecordId))) return
    if (downListing(db, listing, '飞书房源表未返回该房源，自动同步下架', adminId)) result.down += 1
  })

  result.finishedAt = nowText()
  db.feishuSyncLogs.unshift({
    id: id('FS'),
    ...result,
    messages: result.messages.slice(0, 20)
  })
  db.feishuSyncLogs = db.feishuSyncLogs.slice(0, 30)
  return result
}

async function loadRowsAndMaterials(options = {}) {
  if (options.rows && options.materials) {
    return { rows: options.rows, materials: options.materials, feishuToken: '' }
  }
  if (config.feishu.recordsFile && config.feishu.materialsFile) {
    return {
      rows: readJson(config.feishu.recordsFile),
      materials: readJson(config.feishu.materialsFile),
      feishuToken: ''
    }
  }
  const token = await tenantAccessToken()
  const rows = config.feishu.bitableAppToken && config.feishu.bitableTableId
    ? await loadBitableRecords(token)
    : await loadSheetRecords(token)
  const materials = await loadFolderMaterials(token, config.feishu.folderToken)
  return { rows, materials, feishuToken: token }
}

async function sync(db, adminId, options = {}) {
  const loaded = await loadRowsAndMaterials(options)
  const result = await applySync(db, loaded.rows, loaded.materials, adminId, {
    ...options,
    feishuToken: loaded.feishuToken
  })
  if (config.feishu.sheetToken && !options.skipSheetSnapshot && !options.dryRun) {
    try {
      const snapshot = await refreshSheetSnapshot(db, { feishuToken: loaded.feishuToken })
      result.sheetSnapshot = {
        updated: true,
        rowCount: snapshot.rowCount,
        columnCount: snapshot.columnCount,
        updatedAt: snapshot.updatedAt,
        cachedAt: snapshot.cachedAt
      }
    } catch (error) {
      result.sheetSnapshot = {
        updated: false,
        error: error.message
      }
      if (result.messages.length < 20) {
        result.messages.push(`房源表快照更新失败：${error.message}`)
      }
    }
  }
  return result
}

function status(db = {}) {
  const hasLocalFiles = Boolean(config.feishu.recordsFile && config.feishu.materialsFile)
  const hasBitable = Boolean(config.feishu.appId && config.feishu.appSecret && config.feishu.bitableAppToken && config.feishu.bitableTableId)
  const hasSheet = Boolean(config.feishu.appId && config.feishu.appSecret && config.feishu.sheetToken)
  const hasFolder = Boolean(config.feishu.folderToken || config.feishu.materialsFile)
  const sourceReady = (hasLocalFiles || hasBitable || hasSheet) && hasFolder
  return {
    ready: sourceReady,
    mode: hasLocalFiles ? '本地文件导入' : (hasBitable ? '飞书多维表' : '飞书表格'),
    recordsReady: hasLocalFiles || hasBitable || hasSheet,
    sheetReady: hasSheet,
    materialsReady: hasFolder,
    uploadToOss: config.feishu.uploadToOss,
    syncIntervalMinutes: config.feishu.syncIntervalMinutes,
    folderToken: config.feishu.folderToken ? `${config.feishu.folderToken.slice(0, 6)}...` : '',
    bitableAppToken: config.feishu.bitableAppToken ? `${config.feishu.bitableAppToken.slice(0, 6)}...` : '',
    bitableTableId: config.feishu.bitableTableId || '',
    sheetToken: config.feishu.sheetToken ? `${config.feishu.sheetToken.slice(0, 6)}...` : '',
    sheetRange: config.feishu.sheetRange,
    sheetSnapshotUpdatedAt: db.companySheetSnapshot ? (db.companySheetSnapshot.cachedAt || db.companySheetSnapshot.updatedAt || '') : '',
    sheetSnapshotRowCount: db.companySheetSnapshot ? (db.companySheetSnapshot.rowCount || 0) : 0,
    lastLog: (db.feishuSyncLogs || [])[0] || null,
    missingVideoMaterialCount: (db.listings || []).filter((item) => item.externalSource === 'feishu' && item.missingVideoMaterial && item.lifecycleStatus !== 'expired' && item.status !== '已下架').length,
    feishuListingCount: (db.listings || []).filter((item) => item.externalSource === 'feishu' && item.lifecycleStatus !== 'expired' && item.status !== '已下架').length
  }
}

module.exports = {
  sync,
  status,
  sheetSnapshot,
  cachedSheetSnapshot,
  refreshSheetSnapshot,
  normalizeRecord,
  applySync,
  sanitizeSheetSnapshot
}
