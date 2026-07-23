const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const domain = require('./domain')
const locationMap = require('./location-map')
const oss = require('./oss')
const { refreshRecommendationProfile } = require('./listing-recommendation-profile')
const { normalizeListingFeatures } = require('./listing-features')
const { resolveManagedVideoObjectKey } = require('./public-listing-media')
const { createBitableClient } = require('./feishu-bitable-client')
const {
  buildLocationCatalog,
  planMirrorSync,
  buildCompanySheetSnapshot,
  publishCompanySnapshot,
  classifyMirrorRunResult,
  runCompanySourceSync
} = require('./feishu-source-mirror')

const COMPANY_SOURCE = '公司房源'
const COMPANY_FEATURES = ['免押金', '不分佣']
const MISSING_VIDEO_MATERIAL_STATUS = '缺视频素材'
const RETAINED_VIDEO_MATERIAL_STATUS = '沿用上次视频·素材待核'
const VIDEO_EXT_PATTERN = /\.(mp4|mov|m4v|avi|webm)$/i
const DOWN_STATUS_PATTERN = /下架|已租|已成交|成交|关闭|无效|删除|暂停|不可租|停租|down|off|inactive|rented|closed/i
const UP_STATUS_PATTERN = /上架|在租|待租|空置|可租|有效|up|on|active/i
const NOT_UP_PATTERN = /未上架|不上架|否|false|no|0/i
const RETAINABLE_ACTIVE_STATUS_PATTERN = /^(?:上架|已上架|在租|待租|空置|可租|有效|up|on|active)$/i
const SENSITIVE_FEISHU_FIELD_PATTERN = /(看房方式密码|看房方式|看房密码|门锁密码|密码|联系方式|联系电话|房东联系方式|房东电话|联系人电话|手机号|手机|电话|微信|身份证|证件)/i
const MIRROR_REQUIRED_BINDINGS = Object.freeze({
  source: ['community', 'roomLabel', 'layoutDescription', 'monthlyRent', 'rentMode', 'listingStatus'],
  mini: [
    'sourceRecordId', 'locationId', 'locationRecordId', 'city', 'district', 'block', 'community',
    'latitude', 'longitude', 'roomLabel', 'building', 'roomNumber', 'layoutDescription', 'layoutCategory',
    'monthlyRent', 'rentMode', 'listingStatus',
    'published', 'canonical', 'enabled'
  ],
  location: ['locationId', 'city', 'district', 'block', 'community', 'latitude', 'longitude', 'enabled']
})
const MIRROR_REQUIRED_OPTIONAL_VALUE_BINDINGS = Object.freeze({
  source: ['viewingMethod', 'remark'],
  mini: ['unit', 'viewingMethod', 'remark'],
  location: []
})
const MIRROR_PAIRED_SOURCE_FIELDS = Object.freeze([
  'rentMode', 'roomLabel', 'building', 'unit', 'roomNumber', 'layoutDescription', 'layoutCategory',
  'monthlyRent', 'viewingMethod', 'remark', 'listingStatus', 'contact', 'viewingPassword',
  'landlordCommissionPercent', 'tags', 'video'
])
const MIRROR_FIELD_TYPE_CONTRACTS = Object.freeze({
  source: Object.freeze({
    community: [1, 3], roomLabel: [1], building: [1, 2], unit: [1, 2], roomNumber: [1, 2],
    layoutDescription: [1], layoutCategory: [1, 3], monthlyRent: [1, 2], rentMode: [1, 3],
    viewingMethod: [1, 3], remark: [1], listingStatus: [1, 3], contact: [1, 13],
    viewingPassword: [1], landlordCommissionPercent: [1, 2], tags: [1, 4], video: [17]
  }),
  mini: Object.freeze({
    sourceRecordId: [1], locationId: [1], locationRecordId: [1], city: [1], district: [1, 3],
    block: [1, 3], community: [1], latitude: [2], longitude: [2], roomLabel: [1], building: [1],
    unit: [1], roomNumber: [1], layoutDescription: [1], layoutCategory: [1, 3], monthlyRent: [2],
    rentMode: [1, 3], viewingMethod: [1, 3], remark: [1], listingStatus: [1, 3], contact: [1, 13],
    viewingPassword: [1], landlordCommissionPercent: [2], tags: [4], video: [17],
    published: [7], canonical: [7], enabled: [7]
  }),
  location: Object.freeze({
    locationId: [1], city: [1], district: [1, 3], block: [1, 3], community: [1], aliases: [1, 4],
    latitude: [2], longitude: [2], enabled: [7]
  })
})
const MIRROR_WRITE_BATCH_SIZE = 500

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

function restoreClonedObject(target, snapshot) {
  Object.keys(target).forEach((key) => delete target[key])
  Object.assign(target, snapshot)
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shortError(error) {
  return String(error && error.message ? error.message : error || '').replace(/\s+/g, ' ').trim()
}

function materialRetryCount() {
  const count = Number(config.feishu.materialTransferRetryCount || 0)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

function materialTimeoutMs() {
  const timeout = Number(config.feishu.materialTransferTimeoutMs || 0)
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 120000
}

async function withMaterialRetry(label, action) {
  const retries = materialRetryCount()
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await action(attempt + 1)
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      const baseDelay = Number(config.feishu.materialTransferRetryDelayMs || 800)
      const delayMs = Math.max(100, baseDelay) * (attempt + 1)
      await sleep(delayMs)
    }
  }
  const message = shortError(lastError) || '未知错误'
  const error = new Error(`${label}失败${retries ? `（已重试 ${retries} 次）` : ''}：${message}`)
  error.statusCode = lastError && lastError.statusCode ? lastError.statusCode : 502
  throw error
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = materialTimeoutMs()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error(`请求超过 ${Math.round(timeout / 1000)} 秒未返回`)
      timeoutError.statusCode = 504
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
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

function optionalNumberFrom(value) {
  const text = normalizeText(value)
  if (!text) return ''
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : ''
}

function unique(values) {
  const seen = new Set()
  return (values || []).map(normalizeText).filter(Boolean).filter((item) => {
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
}

function normalizeLocationFields(fields = {}, community = '') {
  const canonicalDistrict = firstField(fields, ['canonicalDistrict'])
  const canonicalBlock = firstField(fields, ['canonicalBlock'])
  if (canonicalDistrict && canonicalBlock) {
    return { area: canonicalDistrict, block: canonicalBlock }
  }
  const explicitDistrict = firstField(fields, ['行政区', '城区', '城市区域', 'districtName'])
  const rawBlock = firstField(fields, ['板块', '商圈', '区域', '区', 'district', 'area']) || '待板块'
  const block = locationMap.blockForLocation({
    community,
    block: rawBlock
  })
  return {
    area: locationMap.districtForLocation({
      community,
      block,
      district: explicitDistrict
    }),
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
  if (dashed.length === 2) {
    return {
      building: normalizeRoomPart(dashed[0], 'building'),
      unit: '',
      roomNumber: normalizeRoomPart(dashed[1], 'room')
    }
  }
  const withUnit = text.match(/^(.+?)(?:号楼|楼|幢|栋)(.+?)单元(.+?)(?:房间|房|室)?$/)
  if (withUnit) {
    return {
      building: normalizeRoomPart(withUnit[1], 'building'),
      unit: normalizeRoomPart(withUnit[2], 'unit'),
      roomNumber: normalizeRoomPart(withUnit[3], 'room')
    }
  }
  const withoutUnit = text.match(/^(.+?)(?:号楼|楼|幢|栋)(.+?)(?:房间|房|室)?$/)
  if (!withoutUnit) return null
  return {
    building: normalizeRoomPart(withoutUnit[1], 'building'),
    unit: '',
    roomNumber: normalizeRoomPart(withoutUnit[2], 'room')
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

const CONTACT_FIELD_ALIASES = ['联系方式', '联系电话', '房东联系方式', '房东电话', '联系人电话', '手机号', '手机', '电话', 'contact', 'phone', 'mobile']
const VIEWING_PASSWORD_FIELD_ALIASES = ['看房方式密码', '看房密码', '门锁密码', '密码', 'viewingPassword', 'showingPassword', 'password']
const REMARK_FIELD_ALIASES = ['备注', '说明', '备注说明', '水电', 'note', 'remark', 'memo']
const LANDLORD_COMMISSION_FIELD_ALIASES = ['房东佣金占月租比例', '房东佣金比例', '房东佣金%', 'landlordCommissionPercent']

function roomAddressFromParts(parts = {}) {
  return [parts.building, parts.unit, parts.roomNumber].filter(Boolean).join('-')
}

function roomIdentityPart(value) {
  const text = normalizeText(value)
  if (!text || /^(-|无|null)$/i.test(text)) return ''
  return text
}

function roomIdentityKey(parts = {}) {
  const community = roomIdentityPart(parts.community)
  const building = roomIdentityPart(parts.building)
  const unit = roomIdentityPart(parts.unit)
  const roomNumber = roomIdentityPart(parts.roomNumber)
  if (!community || !building || !roomNumber) return ''
  return [community, building, unit, roomNumber].filter(Boolean).join('|')
}

function normalizeRecord(rawRecord, index, options = {}) {
  const fields = rawRecord.fields || rawRecord
  const community = firstField(fields, ['小区名称', '小区', '楼盘', 'community', 'sourceCommunity'])
  const location = normalizeLocationFields(fields, community)
  const roomParts = parseRoomParts(fields)
  const fallbackKey = roomIdentityKey({ community, ...roomParts })
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
  const landlordCommissionPercent = firstField(fields, LANDLORD_COMMISSION_FIELD_ALIASES)
  const video = rawRecord.video || fields.video || fields.视频 || null
  return {
    raw: rawRecord,
    rowNumber: rawRecord.rowNumber || rawRecord.row_number || index + 1,
    externalId,
    matchKey: externalId || fallbackKey,
    roomIdentityKey: fallbackKey,
    city: firstField(fields, ['城市', 'city']) || '杭州',
    // 经纬度只接受已完成位置字典校验的内部 canonical 适配器；旧员工表即使出现同名列也
    // 不能自行把任意坐标升级成 admin-verified-coordinate。
    latitude: options.trustedCanonicalCoordinates === true
      ? optionalNumberFrom(firstField(fields, ['mapLatitude', 'latitude']))
      : '',
    longitude: options.trustedCanonicalCoordinates === true
      ? optionalNumberFrom(firstField(fields, ['mapLongitude', 'longitude']))
      : '',
    area: location.area,
    block: location.block,
    community,
    building: roomParts.building,
    unit: roomParts.unit,
    roomNumber: roomParts.roomNumber,
    roomAddress: roomAddressFromParts(roomParts),
    contact,
    viewingPassword,
    showingPassword: viewingPassword,
    remark,
    landlordCommissionPercent: landlordCommissionPercent === '' ? 50 : landlordCommissionPercent,
    rent: numberFrom(firstField(fields, ['租金', '月租金', '月租', '价格', '押一付一', '押二付一', '月付价', '押一', '押二', 'rent', 'price'])),
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
  const candidates = Array.isArray(row.video) ? row.video : [row.video]
  return candidates.map((raw) => {
    const direct = materialFromRaw(raw)
    const localFilePath = direct.localFilePath || findLocalVideoByToken(direct.token)
    return { ...direct, localFilePath }
  })
}

function createMaterialMatcher(materials) {
  const normalized = (materials || []).map((item) => (
    item && item.key && item.sourcePath ? item : materialFromRaw(item)
  ))
  const isVideoMaterial = (item) => VIDEO_EXT_PATTERN.test(item.name || '') || /^video\//.test(item.type || '') ||
    Boolean(item.token && !item.name && !item.type)
  const searchableKey = (item) => normalizedKey([
    item.sourcePath,
    item.name,
    item.localFilePath,
    item.url,
    item.videoUrl
  ].filter(Boolean).join(' '))
  const fileNameKey = (item) => normalizedKey(item.name || path.basename(item.sourcePath || ''))
  const includesAny = (text, keys) => keys.some((key) => text.indexOf(key) !== -1)
  const uniqueMatch = (items, predicate, reason) => {
    const matches = items.filter(predicate)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) return { ambiguous: true, reason, candidateCount: matches.length }
    return null
  }
  return (row) => {
    const directCandidates = materialCandidatesFromRecord(row).filter((item) => (
      isVideoMaterial(item) && (item.videoUrl || item.url || item.localFilePath || item.token)
    ))
    if (directCandidates.length) {
      return directCandidates.length === 1
        ? directCandidates[0]
        : { ambiguous: true, reason: '附件字段包含多个视频', candidateCount: directCandidates.length }
    }
    const communityKey = normalizedKey(row.community)
    const strongKeys = unique([
      [row.community, row.building, row.unit, row.roomNumber].filter(Boolean).join(''),
      [row.community, row.roomNumber].filter(Boolean).join('')
    ]).map(normalizedKey).filter((key) => key.length >= 3)
    const roomNumberKey = normalizedKey(row.roomNumber)
    const allowRoomOnlyFallback = /[A-Za-z]/.test(String(row.roomNumber || ''))
    const communityRoomKeys = unique([
      [row.building, row.unit, row.roomNumber].filter(Boolean).join(''),
      [row.building, row.roomNumber].filter(Boolean).join(''),
      allowRoomOnlyFallback ? row.roomNumber : ''
    ]).map(normalizedKey).filter((key) => key.length >= 3)

    const strongMatch = uniqueMatch(normalized, (item) => {
      if (!isVideoMaterial(item)) return false
      return includesAny(searchableKey(item), strongKeys)
    }, '完整房源标识命中多个素材')
    if (strongMatch) return strongMatch

    if (communityKey && communityRoomKeys.length) {
      const communityRoomMatch = uniqueMatch(normalized, (item) => {
        if (!isVideoMaterial(item)) return false
        const text = searchableKey(item)
        return text.indexOf(communityKey) !== -1 && includesAny(text, communityRoomKeys)
      }, '小区房号命中多个素材')
      if (communityRoomMatch) return communityRoomMatch
    }

    const roomOnlyMatches = allowRoomOnlyFallback
      ? normalized.filter((item) => {
        if (!isVideoMaterial(item)) return false
        const text = fileNameKey(item)
        return text.indexOf(roomNumberKey) !== -1
      })
      : []
    if (roomOnlyMatches.length === 1) return roomOnlyMatches[0]
    if (roomOnlyMatches.length > 1) {
      return { ambiguous: true, reason: '房号命中多个素材', candidateCount: roomOnlyMatches.length }
    }
    return null
  }
}

function isAmbiguousMaterialMatch(value) {
  return Boolean(value && value.ambiguous === true)
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
  return /区域|行政区/.test(text) && /小区/.test(text) && /房号|房间号/.test(text)
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

function normalizedSnapshotContactPhones(options = {}) {
  const configured = Object.prototype.hasOwnProperty.call(options, 'contactPhones')
    ? options.contactPhones
    : (config.company && config.company.contactPhones)
  const values = Array.isArray(configured) ? configured : String(configured || '').split(',')
  return Array.from(new Set(values
    .map((item) => normalizeText(item))
    .filter((item) => /^1[3-9]\d{9}$/.test(item))))
}

function snapshotContactColumnIndexes(header = []) {
  const aliases = new Set(CONTACT_FIELD_ALIASES
    .concat(['微信', '微信号', '联系微信', '联系人微信', 'wechat', 'weChatId', 'wx', 'vx'])
    .map((item) => contactAddressProjection(item).skeleton.replace(/\u0001/g, '').toLowerCase()))
  return new Set(header.reduce((indexes, value, index) => {
    const normalized = contactAddressProjection(value).skeleton.replace(/\u0001/g, '').toLowerCase()
    if (aliases.has(normalized) || /(?:微信|微号|联系|聯繫|聯絡|电话|電話|手机|手機|座机|座機|房东微信|房東微信|wechat|weixin|wx|vx)/i.test(normalized)) indexes.push(index)
    return indexes
  }, []))
}

function snapshotAccessColumnIndexes(header = []) {
  return new Set(header.reduce((indexes, value, index) => {
    const normalized = contactAddressProjection(value).skeleton.replace(/\u0001/g, '').toLowerCase()
    if (/(?:看房|开门|門鎖|门锁|门禁|門禁|password).*(?:密码|密碼|码|碼)?|(?:密码|密碼)/i.test(normalized)) indexes.push(index)
    return indexes
  }, []))
}

function contactDigitValue(character) {
  const normalized = String(character || '').normalize('NFKC')
  if (/^[0-9]$/.test(normalized)) return normalized
  const map = {
    '零': '0', '〇': '0', '○': '0',
    '一': '1', '壹': '1', '幺': '1',
    '二': '2', '两': '2', '兩': '2', '贰': '2', '貳': '2',
    '三': '3', '叁': '3', '參': '3', '四': '4', '肆': '4',
    '五': '5', '伍': '5', '六': '6', '陆': '6', '陸': '6',
    '七': '7', '柒': '7', '八': '8', '捌': '8', '九': '9', '玖': '9'
  }
  if (Object.prototype.hasOwnProperty.call(map, character)) return map[character]
  const codePoint = String(character || '').codePointAt(0)
  const decimalBases = [
    0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66,
    0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0DE6, 0x0E50, 0x0ED0, 0x0F20,
    0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90,
    0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0,
    0xA9F0, 0xAA50, 0xABF0, 0x104A0, 0x10D30, 0x10D40, 0x11066, 0x110F0,
    0x11136, 0x111D0, 0x112F0, 0x11450, 0x114D0, 0x11650, 0x116C0,
    0x116D0, 0x116DA, 0x11730, 0x118E0, 0x11950, 0x11BF0, 0x11C50,
    0x11D50, 0x11DA0, 0x11DE0, 0x11F50, 0x16130, 0x16A60, 0x16AC0,
    0x16B50, 0x16D70, 0x1E140, 0x1E2F0, 0x1E4F0, 0x1E5F1, 0x1E950,
    0x1FBF0
  ]
  const base = decimalBases.find((item) => codePoint >= item && codePoint <= item + 9)
  return base === undefined ? '' : String(codePoint - base)
}

function contactChineseDigitValue(character) {
  const map = {
    '零': '0', '〇': '0', '○': '0', '一': '1', '壹': '1', '幺': '1',
    '二': '2', '两': '2', '兩': '2', '贰': '2', '貳': '2', '三': '3', '叁': '3', '參': '3',
    '四': '4', '肆': '4', '五': '5', '伍': '5', '六': '6', '陆': '6', '陸': '6',
    '七': '7', '柒': '7', '八': '8', '捌': '8', '九': '9', '玖': '9'
  }
  return Object.prototype.hasOwnProperty.call(map, character) ? map[character] : ''
}

function contactInvisibleOrCombiningCodePoint(codePoint) {
  return codePoint === 0x00AD || (codePoint >= 0x0300 && codePoint <= 0x036F) || codePoint === 0x061C ||
    (codePoint >= 0x115F && codePoint <= 0x1160) || (codePoint >= 0x17B4 && codePoint <= 0x17B5) ||
    (codePoint >= 0x180B && codePoint <= 0x180F) || (codePoint >= 0x1AB0 && codePoint <= 0x1AFF) ||
    (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) || (codePoint >= 0x200B && codePoint <= 0x200F) ||
    (codePoint >= 0x202A && codePoint <= 0x202E) || (codePoint >= 0x2060 && codePoint <= 0x206F) ||
    (codePoint >= 0x20D0 && codePoint <= 0x20FF) || codePoint === 0x3164 ||
    (codePoint >= 0xFE00 && codePoint <= 0xFE0F) || (codePoint >= 0xFE20 && codePoint <= 0xFE2F) ||
    codePoint === 0xFEFF || codePoint === 0xFFA0 || (codePoint >= 0xFFF0 && codePoint <= 0xFFFB) ||
    (codePoint >= 0x1BCA0 && codePoint <= 0x1BCA3) || (codePoint >= 0x1D173 && codePoint <= 0x1D17A) ||
    (codePoint >= 0xE0000 && codePoint <= 0xE0FFF)
}

function contactSecurityNoise(character) {
  const codePoint = String(character || '').codePointAt(0)
  if (contactInvisibleOrCombiningCodePoint(codePoint) || /\s/.test(character)) return true
  if ((codePoint >= 0x21 && codePoint <= 0x2F) || (codePoint >= 0x3A && codePoint <= 0x40) ||
    (codePoint >= 0x5B && codePoint <= 0x60) || (codePoint >= 0x7B && codePoint <= 0x7E)) return true
  return (codePoint >= 0x2000 && codePoint <= 0x2BFF) || (codePoint >= 0x3000 && codePoint <= 0x303F) ||
    (codePoint >= 0x3200 && codePoint <= 0x33FF) || (codePoint >= 0xFE10 && codePoint <= 0xFE6F) ||
    (codePoint >= 0x1F000 && codePoint <= 0x1FAFF)
}

function contactProjectionContext(source) {
  return {
    chineseDigitCount: source.reduce((count, item) => (
      count + (contactChineseDigitValue(item) ? 1 : 0)
    ), 0)
  }
}

function contactProjectedDigit(source, sourceIndex, context) {
  const character = source[sourceIndex]
  const digit = contactDigitValue(character)
  const chineseDigit = contactChineseDigitValue(character)
  if (digit && !chineseDigit) return digit
  if (chineseDigit) {
    const chineseDigitCount = context && Number.isInteger(context.chineseDigitCount)
      ? context.chineseDigitCount
      : contactProjectionContext(source).chineseDigitCount
    return chineseDigitCount >= 7 ? chineseDigit : ''
  }
  const normalized = String(character || '').normalize('NFKC')
  if (normalized !== 'O' && normalized !== 'o') return ''
  let previousIndex = sourceIndex - 1
  while (previousIndex >= 0 && contactSecurityNoise(source[previousIndex])) previousIndex -= 1
  let nextIndex = sourceIndex + 1
  while (nextIndex < source.length && contactSecurityNoise(source[nextIndex])) nextIndex += 1
  return previousIndex >= 0 && nextIndex < source.length &&
    contactDigitValue(source[previousIndex]) && contactDigitValue(source[nextIndex]) ? '0' : ''
}

function contactSecurityProjection(value) {
  const source = Array.from(String(value || '').normalize('NFC'))
    .filter((character) => !contactInvisibleOrCombiningCodePoint(character.codePointAt(0)))
  const context = contactProjectionContext(source)
  let skeleton = ''
  const positions = []
  source.forEach((character, sourceIndex) => {
    const digit = contactProjectedDigit(source, sourceIndex, context)
    if (digit) {
      skeleton += digit
      positions.push(sourceIndex)
      return
    }
    if (character === '㎡') {
      skeleton += character
      positions.push(sourceIndex)
      return
    }
    if (contactSecurityNoise(character)) return
    skeleton += character
    positions.push(sourceIndex)
  })
  return { source, skeleton, positions }
}

function contactAddressProjection(value) {
  const source = Array.from(String(value || '').normalize('NFC'))
    .filter((character) => !contactInvisibleOrCombiningCodePoint(character.codePointAt(0)))
  const context = contactProjectionContext(source)
  let skeleton = ''
  const positions = []
  source.forEach((character, sourceIndex) => {
    const digit = contactProjectedDigit(source, sourceIndex, context)
    if (digit) {
      skeleton += digit
      positions.push(sourceIndex)
      return
    }
    const normalized = character.normalize('NFKC')
    if (/^[A-Za-z]$/.test(normalized)) {
      skeleton += normalized.toLowerCase()
      positions.push(sourceIndex)
      return
    }
    if (!/[\u3400-\u9fff]/u.test(character)) return
    skeleton += character
    positions.push(sourceIndex)
  })
  return { source, skeleton, positions }
}

function contactDigitOnlyProjection(value) {
  const source = Array.from(String(value || '').normalize('NFC'))
    .filter((character) => !contactInvisibleOrCombiningCodePoint(character.codePointAt(0)))
  const context = contactProjectionContext(source)
  let skeleton = ''
  const positions = []
  source.forEach((character, sourceIndex) => {
    const digit = contactProjectedDigit(source, sourceIndex, context)
    if (!digit) return
    skeleton += digit
    positions.push(sourceIndex)
  })
  return { source, skeleton, positions }
}

function contactLocalPhoneProjection(value) {
  const source = Array.from(String(value || '').normalize('NFC'))
    .filter((character) => !contactInvisibleOrCombiningCodePoint(character.codePointAt(0)))
  const context = contactProjectionContext(source)
  let skeleton = ''
  const positions = []
  source.forEach((character, sourceIndex) => {
    const digit = contactProjectedDigit(source, sourceIndex, context)
    if (digit) {
      skeleton += digit
      positions.push(sourceIndex)
      return
    }
    if (contactSecurityNoise(character)) return
    if (!skeleton.endsWith('\u0001')) {
      skeleton += '\u0001'
      positions.push(sourceIndex)
    }
  })
  return { source, skeleton, positions }
}

function contactDateProjection(value) {
  const source = Array.from(String(value || '').normalize('NFC'))
    .filter((character) => !contactInvisibleOrCombiningCodePoint(character.codePointAt(0)))
  const context = contactProjectionContext(source)
  let skeleton = ''
  const positions = []
  source.forEach((character, sourceIndex) => {
    const digit = contactProjectedDigit(source, sourceIndex, context)
    if (digit) {
      skeleton += digit
      positions.push(sourceIndex)
      return
    }
    const normalized = character.normalize('NFKC')
    if (/^[-/:.TtZz ]$/.test(normalized)) {
      skeleton += normalized.toLowerCase()
      positions.push(sourceIndex)
      return
    }
    if (!skeleton.endsWith('\u0001')) {
      skeleton += '\u0001'
      positions.push(sourceIndex)
    }
  })
  return { source, skeleton, positions }
}

function contactProtectedNumericGroups(value) {
  const groups = []
  const addressGroups = []
  const matchDigitPositions = (targetProjection, match) => {
    const positions = new Set()
    for (let index = match.index; index < match.index + match[0].length; index += 1) {
      if (/\d/.test(targetProjection.skeleton[index] || '')) positions.add(targetProjection.positions[index])
    }
    return positions
  }
  const addGroup = (targetProjection, match) => {
    const positions = matchDigitPositions(targetProjection, match)
    if (positions.size) groups.push(positions)
  }
  const securityProjection = contactSecurityProjection(value)
  const dateProjection = contactDateProjection(value)
  const addValidDateMatches = (pattern) => {
    let match
    while ((match = pattern.exec(dateProjection.skeleton)) !== null) {
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      const hour = match[4] === undefined ? 0 : Number(match[4])
      const minute = match[5] === undefined ? 0 : Number(match[5])
      const second = match[6] === undefined ? 0 : Number(match[6])
      const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0
      if (year >= 1900 && year <= 2200 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59) {
        addGroup(dateProjection, match)
      }
    }
  }
  addValidDateMatches(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?z?)?/g)
  addValidDateMatches(/(?:^|\u0001)(\d{4})(\d{2})(\d{2})(?=$|\u0001)/g)
  const businessPattern = /(\d{1,3})号板块(\d{1,2})号(?:线|地铁)(\d{1,3})分钟(\d{1,2})室(\d{1,2})厅(\d{1,2})卫(\d{4})年/g
  let business
  while ((business = businessPattern.exec(securityProjection.skeleton)) !== null) {
    const block = Number(business[1])
    const transit = Number(business[2])
    const minutes = Number(business[3])
    const room = Number(business[4])
    const hall = Number(business[5])
    const bath = Number(business[6])
    const year = Number(business[7])
    if (block <= 999 && transit >= 1 && transit <= 30 && minutes <= 300 &&
      room >= 1 && room <= 20 && hall >= 1 && hall <= 20 && bath >= 1 && bath <= 20 &&
      year >= 1900 && year <= 2200) addGroup(securityProjection, business)
  }
  const layoutCountValue = (value) => {
    const text = String(value || '')
    const chinese = { 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    return Object.prototype.hasOwnProperty.call(chinese, text) ? chinese[text] : Number(text)
  }
  const layoutSequencePattern = /(?:\d{1,5}(?:㎡|m2|平方米)(?:\d{1,2}|[一二两兩三四五六七八九])室(?:(?:\d{1,2}|[一二两兩三四五六七八九])厅)?(?:(?:\d{1,2}|[一二两兩三四五六七八九])卫)?)+/gi
  let sequence
  while ((sequence = layoutSequencePattern.exec(securityProjection.skeleton)) !== null) {
    const tokenPattern = /(\d{1,5})(?:㎡|m2|平方米)(\d{1,2}|[一二两兩三四五六七八九])室(?:(\d{1,2}|[一二两兩三四五六七八九])厅)?(?:(\d{1,2}|[一二两兩三四五六七八九])卫)?/gi
    let token
    let cursor = 0
    let valid = true
    while ((token = tokenPattern.exec(sequence[0])) !== null) {
      if (token.index !== cursor) {
        valid = false
        break
      }
      cursor = token.index + token[0].length
      const area = Number(token[1])
      const room = layoutCountValue(token[2])
      const hall = token[3] ? layoutCountValue(token[3]) : 0
      const bath = token[4] ? layoutCountValue(token[4]) : 0
      if (!(area > 0 && area <= 10000 && room >= 1 && room <= 20 && hall <= 20 && bath <= 20)) {
        valid = false
        break
      }
    }
    if (valid && cursor === sequence[0].length) addGroup(securityProjection, sequence)
  }
  const transitPattern = /(\d{1,2})号(?:线|地铁)(\d{1,3})分钟(?:到|至)?(\d{1,4})路(?:公交|公交站|车)/g
  let transitMatch
  while ((transitMatch = transitPattern.exec(securityProjection.skeleton)) !== null) {
    if (Number(transitMatch[1]) >= 1 && Number(transitMatch[1]) <= 30 && Number(transitMatch[2]) <= 300 && Number(transitMatch[3]) <= 9999) {
      addGroup(securityProjection, transitMatch)
    }
  }
  // 只把经过整段语义校验的日期、面积户型、板块/地铁组合加入保护组。
  // 单独保护每个“18㎡”“700公里”等片段会允许攻击者把一串合法单位拼成
  // 11 位手机号后完整穿透；这与前台公共投影的 fail-closed 规则不一致。
  const addressProjection = contactAddressProjection(value)
  ;[
    /(?:第)?\d{1,4}(?:栋|棟|幢|座|号楼|號樓|楼|樓|单元|單元)/g,
    /\d{3,4}(?:室|房|号房|號房|户|戶|门|門)/g,
    /(?:房号|房號|房间号|房間號|房间|房間|室号|室號|门牌号|門牌號|楼栋|樓棟|楼号|樓號|栋号|棟號|幢号|幢號|单元号|單元號)\d{1,4}/gi,
    /(?:路|街|巷|弄|道)\d{1,4}(?:号|號)/g,
    /(?:room|apartment|apt|unit|building|bldg|house|door|suite|no)\d{1,4}(?!\d)/gi
  ].forEach((pattern) => {
    let match
    while ((match = pattern.exec(addressProjection.skeleton)) !== null) {
      const positions = matchDigitPositions(addressProjection, match)
      if (positions.size) addressGroups.push(positions)
    }
  })
  return { groups, addressGroups }
}

function replaceUnconfiguredMobileNumbers(value, replacement, allowedPhones, options = {}) {
  if (typeof value !== 'string') return value
  if (options.kind === 'access' && /^\d{7,8}[#*]?$/.test(value.trim())) return value
  // 电话形状只依赖数字序列，不枚举分隔符；任意 Unicode 标点、字母、emoji 或
  // 私用区字符都不能把 3-4-4 手机号或座机拆开后绕过快照脱敏。
  const safeAllowedPhones = allowedPhones instanceof Set ? allowedPhones : new Set()
  const protectedPhones = []
  let candidate = value.normalize('NFC')
  Array.from(safeAllowedPhones).forEach((phone, index) => {
    let token = `\uE000${String.fromCodePoint(0xE100 + index)}\uE001`
    while (candidate.includes(token)) token += '\uE002'
    candidate = candidate.replace(new RegExp(`(^|\\D)${phone}(?!\\d)`, 'g'), (matched, prefix) => `${prefix}${token}`)
    protectedPhones.push({ token, phone })
  })
  const restoreProtectedPhones = (text) => {
    let restored = text
    protectedPhones.forEach(({ token, phone }) => {
      restored = restored.split(token).join(phone)
    })
    return restored
  }
  const sanitizeSegment = (unprotectedCandidate) => {
    const projection = contactDigitOnlyProjection(unprotectedCandidate)
    const localPhoneProjection = contactLocalPhoneProjection(unprotectedCandidate)
    const protectedNumeric = contactProtectedNumericGroups(unprotectedCandidate)
    const contactProjection = contactAddressProjection(unprotectedCandidate)
    const securityProjection = contactSecurityProjection(unprotectedCandidate)
  const patterns = [
    { projection, pattern: /(?:86)?1[3-9]\d{9}/g, numericContact: true, overlap: true },
    { projection, pattern: /0\d{9,11}/g, numericContact: true, overlap: true },
    { projection, pattern: /(?:400|800)\d{7}/g, numericContact: true, overlap: true },
    { projection: localPhoneProjection, pattern: /\d{7,8}/g, numericContact: true, protectAddress: true },
    {
      projection: contactProjection,
      pattern: /(?:(?:联系电话|联络电话|聯絡電話|联系方式|联系方法|联络方式|聯繫方式|聯絡方式|联系房东|联络房东|聯絡房東|房东电话|房東電話|手机号|手機號|手机|手機|电话|電話|座机|座機|热线|熱線|客服|联络|聯絡|联系|聯繫)|(?:^|[^a-z])(?:telephone|phone|mobile|contact|call|tel))[^\d]{0,12}\d(?:[^\d]{0,8}\d){4,7}/gi,
      preserveEnglishBoundary: true
    },
    {
      projection: contactProjection,
      pattern: /(?:微(?:[\u3400-\u9fff]{0,4})?信号?|微号|(?:^|[^a-z])(?:weixin|wechat|wx|vx)|v信)([a-z][a-z0-9]{3,31})/gi,
      contactIdentifier: true,
      preserveEnglishBoundary: true
    },
    {
      projection: contactProjection,
      pattern: /(?:(?:联系方式|联系方法|联络方式|聯繫方式|聯絡方式|联系房东|联络房东|聯絡房東|房东微信|房東微信|微信号?|微号)|(?:^|[^a-z])(?:telephone|phone|mobile|contact|call|tel))([a-z][a-z0-9]{3,31})/gi,
      contactIdentifier: true,
      preserveEnglishBoundary: true
    }
  ]
  const spans = []
  const numericRemovePositions = new Set()
  patterns.forEach(({ projection: targetProjection, pattern, overlap, contactIdentifier, numericContact, protectAddress, preserveEnglishBoundary }) => {
    let match
    while ((match = pattern.exec(targetProjection.skeleton)) !== null) {
      let start = targetProjection.positions[match.index]
      if (preserveEnglishBoundary && /^[^a-z]/i.test(match[0][0] || '') &&
        /^(?:telephone|phone|mobile|contact|call|tel|weixin|wechat|wx|vx)/i.test(match[0].slice(1))) {
        start = targetProjection.positions[match.index + 1]
      }
      const originalMatchEndIndex = match.index + match[0].length - 1
      let matchEndIndex = originalMatchEndIndex
      if (contactIdentifier && match[1]) {
        const identifierStartIndex = match.index + match[0].lastIndexOf(match[1])
        for (let index = identifierStartIndex + 1; index <= originalMatchEndIndex; index += 1) {
          const previousSourcePosition = targetProjection.positions[index - 1]
          const currentSourcePosition = targetProjection.positions[index]
          const sourceGap = targetProjection.source.slice(previousSourcePosition + 1, currentSourcePosition).join('')
          if (!/\s/u.test(sourceGap) || /^[a-z]$/i.test(targetProjection.skeleton[index] || '')) continue
          matchEndIndex = index - 1
          break
        }
        if (matchEndIndex < originalMatchEndIndex) pattern.lastIndex = matchEndIndex + 1
      }
      const end = targetProjection.positions[matchEndIndex]
      if (numericContact) {
        const numericPositions = targetProjection.positions.slice(match.index, matchEndIndex + 1)
        const containedByOneGroup = protectedNumeric.groups.some((group) => numericPositions.every((position) => group.has(position)))
        const containedByOneAddress = protectedNumeric.addressGroups.some((group) => numericPositions.every((position) => group.has(position)))
        if (containedByOneGroup || containedByOneAddress) {
          if (overlap) pattern.lastIndex = match.index + 1
          continue
        }
        const belongsToGroup = (position) => protectedNumeric.groups.some((group) => group.has(position))
        const belongsToAddress = (position) => protectedNumeric.addressGroups.some((group) => group.has(position))
        const removablePositions = numericPositions.filter((position) => (
          !belongsToGroup(position) && !belongsToAddress(position)
        ))
        if (!removablePositions.length) {
          if (overlap) pattern.lastIndex = match.index + 1
          continue
        }
        removablePositions.forEach((position) => numericRemovePositions.add(position))
        if (overlap) pattern.lastIndex = match.index + 1
        continue
      }
      if (Number.isInteger(start) && Number.isInteger(end)) spans.push({ start, end })
      if (overlap) pattern.lastIndex = match.index + 1
    }
  })
  if (!spans.length && !numericRemovePositions.size) return securityProjection.source.join('')
  spans.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged = []
  spans.forEach((span) => {
    const previous = merged[merged.length - 1]
    if (previous && span.start <= previous.end + 1) previous.end = Math.max(previous.end, span.end)
    else merged.push({ ...span })
  })
  let spanIndex = 0
  let result = ''
  let replacementInserted = false
  securityProjection.source.forEach((character, index) => {
    const span = merged[spanIndex]
    if (span && index >= span.start && index <= span.end) {
      if (index === span.start && !replacementInserted) {
        result += replacement
        replacementInserted = true
      }
      if (index === span.end) spanIndex += 1
      return
    }
    if (numericRemovePositions.has(index)) {
      if (!replacementInserted) {
        result += replacement
        replacementInserted = true
      }
      return
    }
    result += character
  })
    return result
  }
  if (!protectedPhones.length) return sanitizeSegment(candidate)
  const tokenLookup = new Set(protectedPhones.map((entry) => entry.token))
  const tokenPattern = new RegExp(`(${protectedPhones.map((entry) => (
    entry.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )).join('|')})`, 'g')
  const sanitized = candidate.split(tokenPattern).map((segment) => (
    tokenLookup.has(segment) ? segment : sanitizeSegment(segment)
  )).join('')
  return restoreProtectedPhones(sanitized)
}

function replaceUnconfiguredContactValues(value, replacement, allowedPhones, options = {}) {
  if (typeof value !== 'string') return value
  const protectedPhones = []
  const phonePattern = /(?:\+?86[\s\-()./—–·]*)?1[3-9](?:[\s\-()./—–·]*\d){9}|(?:(?:\(\s*0\d{2,3}\s*\))|(?:0\d{2,3}))(?:[\s\-()./—–·]*\d){7,8}/g
  let channelSafeValue = value.replace(phonePattern, (matched) => {
    // 联系标签投影会忽略纯私用区字符；加入超过 contactBridge 上限的中文正文，
    // 防止“联系电话<占位> 普通文案”越过占位把后续普通文案误认成账号。
    let token = `\uE200临时占位甲乙丙丁戊己庚辛${String.fromCodePoint(0xE300 + protectedPhones.length)}\uE201`
    while (value.includes(token)) token += '\uE202'
    protectedPhones.push({ token, matched })
    return token
  })
  if (typeof domain.sanitizeCompanyPublicText === 'function') {
    channelSafeValue = domain.sanitizeCompanyPublicText(channelSafeValue, '', {
      kind: options.kind === 'access' ? 'access' : 'generic',
      allowedPhones: Array.from(allowedPhones || [])
    })
  }
  protectedPhones.forEach(({ token, matched }) => {
    channelSafeValue = channelSafeValue.split(token).join(matched)
  })
  let sanitized = replaceUnconfiguredMobileNumbers(channelSafeValue, replacement, allowedPhones, options)
  sanitized = sanitized.replace(/(^|[^A-Za-z0-9_-])(?:vx|wx|wei\s*xin|we\s*chat|weixin|wechat)\s*[:：号]?\s*[A-Za-z][A-Za-z0-9_-]{3,31}/gi, (matched, prefix) => `${prefix}联系方式：${replacement}`)
  sanitized = sanitized.replace(/(?:联\s*系\s*微\s*信|微\s*信(?:\s*号)?|微\s*号|v\s*信)\s*[:：号]?\s*[A-Za-z][A-Za-z0-9_-]{3,31}/gi, `联系方式：${replacement}`)
  sanitized = sanitized.replace(/(^|[^A-Za-z0-9_])(?:telephone|phone|mobile|contact|call|tel|wechat|weixin|wx|vx)\b[^A-Za-z0-9_\u3400-\u9fff]{1,8}[A-Za-z][A-Za-z0-9_-]{3,31}(?:[^A-Za-z0-9_\u3400-\u9fff]{1,8}[A-Za-z][A-Za-z0-9_-]{3,31}){0,3}/gi, '$1 ')
  sanitized = sanitized.replace(/(^|[^A-Za-z0-9_])p[^A-Za-z0-9_\u3400-\u9fff]{1,4}h[^A-Za-z0-9_\u3400-\u9fff]{1,4}o[^A-Za-z0-9_\u3400-\u9fff]{1,4}n[^A-Za-z0-9_\u3400-\u9fff]{1,4}e[^A-Za-z0-9_\u3400-\u9fff]{1,8}[A-Za-z][A-Za-z0-9_-]{3,31}(?:[^A-Za-z0-9_\u3400-\u9fff]{1,8}[A-Za-z][A-Za-z0-9_-]{3,31}){0,3}/gi, '$1 ')
  sanitized = sanitized.replace(/(^|[^A-Za-z0-9_])(?:w[^A-Za-z0-9_\u3400-\u9fff]{1,4}x|v[^A-Za-z0-9_\u3400-\u9fff]{1,4}x|we[^A-Za-z0-9_\u3400-\u9fff]{1,4}chat|wei[^A-Za-z0-9_\u3400-\u9fff]{1,4}xin)[^A-Za-z0-9_\u3400-\u9fff]{1,8}[A-Za-z][A-Za-z0-9_-]{3,31}(?:[^A-Za-z0-9_\u3400-\u9fff]{1,8}[A-Za-z][A-Za-z0-9_-]{3,31}){0,3}/gi, '$1 ')
  sanitized = sanitized.replace(/(?:联\s*系\s*(?:方\s*式|方\s*法|房\s*东)?|联\s*络\s*(?:方\s*式|房\s*东)?|聯\s*[繫絡]\s*(?:方\s*式|房\s*東)?|微[\s·・]{0,4}信(?:\s*号)?|微\s*号|v\s*信)[^A-Za-z0-9_\u3400-\u9fff]{0,8}[A-Za-z][A-Za-z0-9_-]{3,31}(?:[^A-Za-z0-9_\u3400-\u9fff]{1,8}[A-Za-z][A-Za-z0-9_-]{3,31}){0,3}/gi, ' ')
  sanitized = sanitized.replace(/(^|[^A-Za-z0-9_])(?:telephone|phone|mobile|contact|call|tel|wechat|weixin|wx|vx)\b\s*[:：号]?\s*[A-Za-z][A-Za-z0-9_-]{3,31}/gi, '$1 ')
  sanitized = sanitized.replace(/(^|[^A-Za-z0-9_])(?:p\s+h\s+o\s+n\s+e|w\s+x|v\s+x|we\s+chat|wei\s+xin)\s*[:：号]?\s*[A-Za-z][A-Za-z0-9_-]{3,31}/gi, '$1 ')
  sanitized = sanitized.replace(/(?:联\s*系\s*(?:方\s*式|方\s*法|房\s*东)?|联\s*络\s*(?:方\s*式|房\s*东)?|聯\s*[繫絡]\s*(?:方\s*式|房\s*東)?)\s*[:：号]?\s*[A-Za-z][A-Za-z0-9_-]{3,31}/gi, ' ')
  sanitized = sanitized.replace(/(^|[^A-Za-z0-9_])(?:telephone|phone|mobile|contact|call|tel|wechat|weixin|wx|vx)\b(?:\s*[:：号])?/gi, '$1 ')
  sanitized = sanitized.replace(/(^|[^A-Za-z0-9_])(?:p\s+h\s+o\s+n\s+e|w\s+x|v\s+x|we\s+chat|wei\s+xin)(?:\s*[:：号])?/gi, '$1 ')
  return sanitized
}

function publicSnapshotDateTime(value) {
  const text = normalizeText(value)
  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z?)?$/)
  if (!match) match = text.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = match[4] === undefined ? 0 : Number(match[4])
  const minute = match[5] === undefined ? 0 : Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return ''
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return ''
  return text
}

function sanitizeSheetSnapshot(snapshot = {}, options = {}) {
  const rows = normalizeSnapshotRows(Array.isArray(snapshot.rows) ? snapshot.rows : [])
  const contactPhones = normalizedSnapshotContactPhones(options)
  const contactText = contactPhones.join(' / ')
  const allowedPhones = new Set(contactPhones)
  let headerIndex = rows.findIndex(isSheetHeaderRow)
  if (headerIndex < 0) {
    headerIndex = rows.findIndex((row) => (
      snapshotContactColumnIndexes(row).size > 0 || snapshotAccessColumnIndexes(row).size > 0
    ))
  }
  const contactColumns = snapshotContactColumnIndexes(headerIndex >= 0 ? rows[headerIndex] : [])
  const accessColumns = snapshotAccessColumnIndexes(headerIndex >= 0 ? rows[headerIndex] : [])
  const sanitizedRows = rows.map((row, rowIndex) => row.map((value, columnIndex) => {
    if (headerIndex >= 0 && rowIndex > headerIndex && contactColumns.has(columnIndex)) return contactText
    const sanitized = replaceUnconfiguredContactValues(value, contactText, allowedPhones, {
      kind: headerIndex >= 0 && rowIndex > headerIndex && accessColumns.has(columnIndex) ? 'access' : 'generic'
    })
    return typeof sanitized === 'string'
      ? sanitized
        .replace(/\b(?:https?|ftp|file|feishu|lark):\/\/[^\s，。；;]+/gi, '')
        .replace(/\b(?:data|javascript|mailto|tel):[^\s，。；;]+/gi, '')
        .replace(/\bwww\.[^\s，。；;]+/gi, '')
        .trim()
      : sanitized
  }))
  const sanitizedTitle = replaceUnconfiguredContactValues(normalizeText(snapshot.title), contactText, allowedPhones)
  const result = {
    title: typeof sanitizedTitle === 'string'
      ? sanitizedTitle
        .replace(/\b(?:https?|ftp|file|feishu|lark):\/\/[^\s，。；;]+/gi, '')
        .replace(/\b(?:data|javascript|mailto|tel):[^\s，。；;]+/gi, '')
        .replace(/\bwww\.[^\s，。；;]+/gi, '')
        .trim()
      : sanitizedTitle,
    updatedAt: publicSnapshotDateTime(snapshot.updatedAt),
    rows: sanitizedRows,
    rowCount: sanitizedRows.length,
    columnCount: sanitizedRows[0] ? sanitizedRows[0].length : 0,
    sensitiveStripped: true
  }
  if (snapshot.unavailable === true) result.unavailable = true
  if (snapshot.sourceMode === 'feishu-mini-mirror-v1') result.sourceMode = snapshot.sourceMode
  if (snapshot.schemaVersion === 1) result.schemaVersion = 1
  return result
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
  if (config.feishu.mirrorSyncEnabled && snapshot && snapshot.sourceMode !== 'feishu-mini-mirror-v1') return null
  return snapshot && Array.isArray(snapshot.rows) && snapshot.rows.length ? sanitizeSheetSnapshot(snapshot) : null
}

function unavailableSheetSnapshot() {
  const snapshot = buildCompanySheetSnapshot([])
  return sanitizeSheetSnapshot({
    ...snapshot,
    sourceMode: 'feishu-mini-mirror-v1',
    schemaVersion: 1,
    unavailable: true,
    updatedAt: ''
  })
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

async function downloadFeishuMaterialOnce(token, material) {
  if (material.localFilePath) {
    const stat = fs.statSync(material.localFilePath)
    if (stat.size > config.oss.maxVideoSize) {
      const sizeMb = Math.ceil(stat.size / 1024 / 1024)
      const limitMb = Math.floor(config.oss.maxVideoSize / 1024 / 1024)
      const error = new Error(`本地素材 ${sizeMb}MB 超过当前 OSS 视频上限 ${limitMb}MB`)
      error.statusCode = 413
      throw error
    }
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
    const response = await fetchWithTimeout(`${trimSlash(config.feishu.baseUrl)}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (response.ok) {
      const downloaded = {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'video/mp4'
      }
      if (downloaded.buffer.length > config.oss.maxVideoSize) {
        const sizeMb = Math.ceil(downloaded.buffer.length / 1024 / 1024)
        const limitMb = Math.floor(config.oss.maxVideoSize / 1024 / 1024)
        const error = new Error(`飞书素材 ${sizeMb}MB 超过当前 OSS 视频上限 ${limitMb}MB`)
        error.statusCode = 413
        throw error
      }
      return downloaded
    }
    lastStatus = response.status
    lastText = await response.text().catch(() => '')
  }
  const error = new Error(`飞书素材下载失败：${lastStatus}${lastText ? ` ${lastText.slice(0, 120)}` : ''}`)
  error.statusCode = lastStatus
  throw error
}

async function downloadFeishuMaterial(token, material) {
  return withMaterialRetry('飞书素材下载', () => downloadFeishuMaterialOnce(token, material))
}

async function ensureMaterialVideo(token, material, options = {}) {
  if (options.dryRun) {
    return {
      videoKey: material.videoKey || '',
      videoUrl: material.videoUrl || material.url || 'dry-run://matched-material',
      materialUrl: material.videoUrl || material.url || material.sourcePath || material.name || ''
    }
  }
  // 本轮素材若已经携带完整视频结果，必须优先于任何旧 token 复用；否则同 token 会把旧对象
  // 抢在新对象之前返回，令本轮明确的新视频永远无法生效。
  if (material.videoKey && material.videoUrl) {
    return { videoKey: material.videoKey, videoUrl: material.videoUrl, materialUrl: material.videoUrl }
  }
  // 复用：目标房源若已保存过同一素材（token 一致）的视频且有 OSS videoKey，直接沿用，避免
  // 每轮同步都重新下载整只视频再重传 OSS。原跳过条件 material.videoKey 来自 drive 文件列表恒为
  // 空、从不命中，导致每次同步对每个匹配素材全量下载+重传，产生 GB 级重复流量与孤儿对象。
  const reuseTarget = options.existing
  if (reuseTarget && options.allowExistingVideoReuse === true && material.token && reuseTarget.sourceMaterialToken === material.token) {
    const snapshot = managedVideoSnapshot(reuseTarget)
    if (snapshot) {
      return {
        videoKey: snapshot.videoKey,
        videoUrl: '',
        materialUrl: '',
        reusedExisting: true
      }
    }
  }
  if (!config.feishu.uploadToOss && (material.videoUrl || material.url)) {
    return { videoKey: '', videoUrl: material.videoUrl || material.url, materialUrl: material.videoUrl || material.url }
  }
  if (config.feishu.uploadToOss && (material.localFilePath || material.token)) {
    const policy = oss.createVideoUploadPolicy({ fileName: material.name || 'feishu-video.mp4' })
    if (policy.uploadMode === 'oss-post') {
      const downloaded = await downloadFeishuMaterial(token, material)
      const saved = await withMaterialRetry('OSS 素材转存', () => oss.putObjectBuffer(policy.objectKey, downloaded.buffer, downloaded.contentType))
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
  listing.feishuLastSyncAction = 'down'
  listing.feishuLastSyncAt = now
  listing.feishuLastSyncReason = reason
  domain.recordSystemFootprint(db, adminId || 'feishu-sync', listing.id, 'listing_feishu_removed')
  return true
}

function existingByExternalId(db) {
  const map = new Map()
  ;(db.listings || []).forEach((listing) => {
    if (listing.externalSource === 'feishu' && listing.feishuRecordId) {
      map.set(String(listing.feishuRecordId), listing)
    }
    if (listing.externalSource === 'feishu' && listing.feishuRoomIdentityKey) {
      map.set(String(listing.feishuRoomIdentityKey), listing)
    }
    const physicalKey = roomIdentityKey(listing)
    if (listing.externalSource === 'feishu' && physicalKey) {
      map.set(String(physicalKey), listing)
    }
  })
  return map
}

function syncActorId(db = {}, adminId = '') {
  const requested = String(adminId || '').trim()
  const users = db.users || []
  if (requested && users.some((user) => String(user.id || user.userId || '') === requested)) return requested
  const admin = users.find((user) => user && (user.isAdmin || user.role === '管理员'))
  return admin ? (admin.id || admin.userId || requested || 'feishu-sync') : (requested || 'feishu-sync')
}

function buildListingPayload(row, video) {
  const normalizedTags = normalizeListingFeatures(row.tags)
  const hasCoordinate = row.latitude !== '' && row.longitude !== '' &&
    Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
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
    contact: row.contact || '',
    rent: row.rent,
    layout: row.layout,
    rentMode: row.rentMode,
    type: row.rentMode,
    room: row.room,
    hall: row.hall,
    bath: row.bath,
    commissionRate: 0,
    landlordCommissionPercent: row.landlordCommissionPercent,
    features: normalizedTags,
    rawFeatures: row.tags,
    companyListing: true,
    source: '公司房源',
    videoUrl: video.videoUrl || '',
    videoKey: video.videoKey || '',
    viewingPassword: row.viewingPassword || '',
    showingPassword: row.showingPassword || row.viewingPassword || '',
    remark: row.remark || '',
    note: row.remark || '',
    mapLatitude: hasCoordinate ? Number(row.latitude) : '',
    mapLongitude: hasCoordinate ? Number(row.longitude) : '',
    coordinateVerified: hasCoordinate,
    coordinateSource: hasCoordinate ? 'admin-verified-coordinate' : ''
  }
}

function roomLabel(row = {}) {
  return [row.community, row.building, row.unit, row.roomNumber].filter(Boolean).join('-') || row.matchKey || `第 ${row.rowNumber} 行`
}

function materialLabel(material = null) {
  if (!material) return ''
  return material.sourcePath || material.name || material.url || material.videoUrl || material.token || ''
}

function clearListingVideoFields(listing = {}) {
  listing.videoUrl = ''
  listing.videoKey = ''
  clearListingDerivedVideoFields(listing)
}

function clearListingDerivedVideoFields(listing = {}) {
  delete listing.videoSignedUrl
  delete listing.signedVideoUrl
  delete listing.videoPreviewUrl
}

function managedVideoSnapshot(listing = {}) {
  const sourceOptions = {
    uploadDir: config.oss && config.oss.uploadDir,
    allowedOrigins: typeof oss.readSourceOrigins === 'function' ? oss.readSourceOrigins() : []
  }
  const videoKey = resolveManagedVideoObjectKey(listing, sourceOptions)
  if (!videoKey) return null
  return {
    videoKey,
    // object key 是公开代理唯一需要的可信根。旧 URL/素材 URL 可能携带短签 query，保留会把临时能力延寿并下发后台；
    // 即使 URL 自身来自受控 origin，也只取出规范化 key，所有 URL 一律清空。
    videoUrl: '',
    sourceMaterialToken: String(listing.sourceMaterialToken || ''),
    sourceMaterialName: String(listing.sourceMaterialName || ''),
    sourceMaterialPath: String(listing.sourceMaterialPath || ''),
    sourceMaterialUrl: ''
  }
}

function restoreManagedVideoSnapshot(listing, snapshot) {
  listing.videoKey = snapshot.videoKey
  listing.videoUrl = snapshot.videoUrl
  listing.sourceMaterialToken = snapshot.sourceMaterialToken
  listing.sourceMaterialName = snapshot.sourceMaterialName
  listing.sourceMaterialPath = snapshot.sourceMaterialPath
  listing.sourceMaterialUrl = snapshot.sourceMaterialUrl
  clearListingDerivedVideoFields(listing)
}

function isRetainingManagedVideo(listing = {}) {
  return listing.videoMaterialStatus === RETAINED_VIDEO_MATERIAL_STATUS
}

function wasContinuouslyActiveFeishuListing(listing = {}) {
  if (listing.externalSource !== 'feishu') return false
  const lifecycleStatus = normalizeText(listing.lifecycleStatus)
  if (lifecycleStatus && lifecycleStatus !== 'active') return false
  const status = normalizeText(listing.status)
  // 这里不能复用“包含式”UP_STATUS_PATTERN：未上架/未在租同样包含正向词，会把否定状态误判为持续在架。
  // 飞书同步成功后本来就会固化为“在租”，因此保留资格使用完整值白名单并 fail-closed。
  if (!RETAINABLE_ACTIVE_STATUS_PATTERN.test(status)) return false
  if (listing.reviewStatus === '待审核' || listing.requiresManualReview || listing.manualReviewRequired) return false
  return true
}

function hasSamePhysicalRoomIdentity(listing = {}, row = {}) {
  const nextIdentity = normalizeText(row.roomIdentityKey)
  if (!nextIdentity) return false
  const previousIdentities = unique([
    normalizeText(listing.feishuRoomIdentityKey),
    roomIdentityKey(listing)
  ])
  // 旧存量若“持久化物理键”和当前字段互相矛盾，也必须 fail-closed；只要任一旧证据不等于
  // 本轮完整小区/楼栋/单元/房号，就不能把旧套视频带到本轮房源。
  return previousIdentities.length > 0 && previousIdentities.every((identity) => identity === nextIdentity)
}

function buildAuditRow(row, material, syncResult, failureReason = '') {
  return {
    rowNumber: row.rowNumber,
    room: roomLabel(row),
    tableStatus: row.isDown ? '下架' : (row.statusText || '在租'),
    matchedMaterialName: materialLabel(material),
    syncResult,
    failureReason
  }
}

function validLandlordPhone(value) {
  const phone = String(value || '').trim()
  return /^1[3-9]\d{9}$/.test(phone) ? phone : ''
}

function combineFailureReasons(...reasons) {
  return reasons.map((item) => String(item || '').trim()).filter(Boolean).join('；')
}

function attachFeishuFields(listing, row, material, video, materialFailureReason = '', options = {}) {
  listing.externalSource = 'feishu'
  listing.feishuRecordId = String(row.externalId)
  listing.feishuMatchKey = row.matchKey
  listing.feishuRoomIdentityKey = row.roomIdentityKey || ''
  listing.feishuRowNumber = row.rowNumber
  listing.feishuStatusText = row.statusText
  listing.source = COMPANY_SOURCE
  listing.ownerType = COMPANY_SOURCE
  listing.houseSourceType = COMPANY_SOURCE
  listing.companyListing = true
  listing.isCompanyListing = true
  listing.noCommission = true
  listing.requiresManualReview = false
  listing.manualReviewRequired = false
  listing.manualReviewReason = ''
  listing.communityMatched = true
  listing.communityMatchStatus = '已匹配'
  const contact = validLandlordPhone(row.contact) || validLandlordPhone(listing.landlordPhone) || validLandlordPhone(listing.contact)
  listing.landlordPhone = contact
  listing.contact = contact
  listing.missingLandlordPhone = !contact
  listing.feishuContactStatus = contact ? '已配置' : '待补充'
  listing.viewingPassword = row.viewingPassword || ''
  listing.showingPassword = row.showingPassword || row.viewingPassword || ''
  listing.remark = row.remark || ''
  listing.note = row.remark || ''
  listing.landlordCommissionPercent = listing.landlordCommissionPercent === undefined || listing.landlordCommissionPercent === null
    ? 50
    : Number(listing.landlordCommissionPercent)
  listing.roomAddress = row.roomAddress || roomAddressFromParts(row)
  const hasMaterial = Boolean(material)
  const materialReady = hasMaterial && !materialFailureReason
  // domain.updateNormalListing 会在本轮视频字段为空时保留旧值，因此这里仍能先验证并快照最后一份有效视频。
  // 只接受受控 uploadDir/OSS 源；任意外链、客户端 URL 或畸形 object key 均不得进入沿用路径。
  const retainedManagedVideo = materialReady || options.allowRetainedVideo === false
    ? null
    : managedVideoSnapshot(listing)
  listing.sourceMaterialToken = hasMaterial ? (material.token || '') : ''
  listing.sourceMaterialName = hasMaterial ? (material.name || '') : ''
  listing.sourceMaterialPath = hasMaterial ? (material.sourcePath || '') : ''
  listing.sourceMaterialUrl = hasMaterial && !video.reusedExisting ? (video.materialUrl || material.url || '') : ''
  if (materialReady) {
    // updateNormalListing 为普通编辑兼容“空值不覆盖”，但飞书同步必须让本轮素材成为唯一真相：
    // URL-only 新素材要显式清旧 key，key-only/受控复用要显式清旧 URL，避免新旧两个房源媒体拼接。
    listing.videoKey = String(video.videoKey || '')
    listing.videoUrl = video.reusedExisting ? '' : String(video.videoUrl || '')
    clearListingDerivedVideoFields(listing)
  }
  listing.syncStatus = materialReady ? '已同步飞书' : MISSING_VIDEO_MATERIAL_STATUS
  listing.videoMaterialStatus = materialReady ? '已匹配视频素材' : (hasMaterial ? '素材转存失败' : MISSING_VIDEO_MATERIAL_STATUS)
  listing.missingVideoMaterial = !materialReady
  if (materialFailureReason) {
    listing.videoMaterialFailureReason = materialFailureReason
  } else {
    delete listing.videoMaterialFailureReason
  }
  listing.syncedAt = nowText()
  listing.feishuLastSyncAt = listing.syncedAt
  listing.feishuLastSyncReason = combineFailureReasons(materialFailureReason, contact ? '' : '联系电话待补充')
  listing.status = '在租'
  listing.lifecycleStatus = 'active'
  listing.reviewStatus = '无需审核'
  listing.lastVerifiedAt = listing.syncedAt
  listing.updatedAt = listing.syncedAt
  if (!materialReady) {
    if (retainedManagedVideo) {
      restoreManagedVideoSnapshot(listing, retainedManagedVideo)
      listing.syncStatus = '视频沿用待核'
      listing.videoMaterialStatus = RETAINED_VIDEO_MATERIAL_STATUS
    } else {
      clearListingVideoFields(listing)
    }
    refreshRecommendationProfile(listing, { generatedAt: listing.updatedAt })
  }
  delete listing.expiredAt
  delete listing.expiredBy
  delete listing.expiredPool
  delete listing.expiredReason
  delete listing.expiredStaleDays
}

function upsertFeishuListing(db, adminId, existing, byExternalId, row, material, video, materialFailureReason = '') {
  const payload = buildListingPayload(row, video)
  if (existing) {
    const snapshot = clone(existing)
    try {
      // 必须在 updateNormalListing/attachFeishuFields 改写状态和物理字段之前冻结资格。
      // “持续在架”与“同一物理房源”缺一不可；成交/签单/暂停/失效、来源不明、物理键变化或不完整均清旧视频。
      const allowRetainedVideo = wasContinuouslyActiveFeishuListing(existing) && hasSamePhysicalRoomIdentity(existing, row)
      const wasInactive = existing.lifecycleStatus === 'expired' || existing.status === '已下架'
      if (wasInactive) {
        existing.lifecycleStatus = 'active'
        existing.status = '在租'
      }
      domain.updateNormalListing(db, adminId, existing.id, payload, { admin: true, allowMissingLandlordPhone: true })
      // 曾下架后重新出现的房源可能已换租客/装修/拍摄内容；没有本轮素材时不能复活旧视频。
      // 只有持续在架的同一房源遇到瞬时漏素材/转存失败，才允许沿用上次受控视频。
      attachFeishuFields(existing, row, material, video, materialFailureReason, { allowRetainedVideo })
      existing.feishuLastSyncAction = 'updated'
      return { action: 'updated', listing: existing }
    } catch (error) {
      // 领域校验或后续字段挂载失败时，必须恢复同一个对象实例。否则调用方虽然收到失败，
      // 列表数组里却会残留“已复活但未更新完整”的半成品，并被重新公开。
      restoreClonedObject(existing, snapshot)
      throw error
    }
  }
  const detail = domain.addNormalListing(db, adminId, payload, { admin: true, skipPointLog: true, allowMissingLandlordPhone: true })
  const listing = db.listings.find((item) => item.id === detail.id)
  attachFeishuFields(listing, row, material, video, materialFailureReason, { allowRetainedVideo: false })
  if (listing) listing.feishuLastSyncAction = 'created'
  if (listing && row.externalId) byExternalId.set(String(row.externalId), listing)
  if (listing && row.roomIdentityKey) byExternalId.set(String(row.roomIdentityKey), listing)
  return { action: 'created', listing }
}

function prevalidateFeishuUpsertBeforeMaterialTransfer(db, adminId, existing, row, material) {
  // 视频转存是不可自动补偿的外部写：OSS 当前没有删除接口，上传后再发现佣金/重复房源等
  // 领域错误会永久留下孤儿对象。先在隔离副本里执行同一条完整 upsert，让所有可预见的
  // 业务校验和字段挂载都在下载、上传之前完成；只复制会被领域层读写的热集合，避免把
  // 90 天足迹与历史同步日志按每行整库复制。
  const validationDb = {
    ...db,
    users: clone(db.users || []),
    listings: clone(db.listings || []),
    pointLogs: [],
    footprints: []
  }
  const validationExisting = existing
    ? validationDb.listings.find((item) => String(item.id || '') === String(existing.id || ''))
    : null
  if (existing && !validationExisting) {
    const error = new Error('飞书同步预校验无法定位存量房源')
    error.statusCode = 409
    throw error
  }
  upsertFeishuListing(
    validationDb,
    adminId,
    validationExisting,
    existingByExternalId(validationDb),
    row,
    material,
    { videoKey: '', videoUrl: '', materialUrl: '' }
  )
}

async function applySync(db, rows, materials, adminId, options = {}) {
  db.listings = db.listings || []
  db.feishuSyncLogs = db.feishuSyncLogs || []
  const actorId = syncActorId(db, adminId)
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
    ambiguousVideoMaterial: 0,
    materialTransferFailed: 0,
    missingLandlordPhone: 0,
    skippedInvalid: 0,
    failed: 0,
    auditRows: [],
    messages: []
  }

  for (const [rowIndex, rawRow] of rows.entries()) {
    const row = normalizeRecord(rawRow, rowIndex, {
      trustedCanonicalCoordinates: options.trustedCanonicalCoordinates === true
    })
    if (!row.externalId) {
      result.skippedInvalid += 1
      result.messages.push(`第 ${row.rowNumber} 行缺少房源编号或小区房号，已跳过`)
      result.auditRows.push(buildAuditRow(row, null, '跳过-缺少房源编号或小区房号', '关键字段缺失'))
      continue
    }
    seen.add(String(row.externalId))
    const existing = byExternalId.get(String(row.externalId)) ||
      (row.roomIdentityKey ? byExternalId.get(String(row.roomIdentityKey)) : null)
    if (row.isDown) {
      if (existing && downListing(db, existing, '飞书房源表已下架，自动同步下架', actorId)) result.down += 1
      result.auditRows.push(buildAuditRow(row, null, existing ? '下架' : '跳过-表内下架且线上不存在', '表内状态为下架/已租/关闭'))
      continue
    }

    if (!row.community || !row.building || !row.roomNumber || !row.rent || !row.layout) {
      result.skippedInvalid += 1
      result.messages.push(`第 ${row.rowNumber} 行字段不完整，需小区、几栋、房间号、租金、户型`)
      result.auditRows.push(buildAuditRow(row, null, '跳过-字段不完整', '缺少小区/楼栋/房号/租金/户型之一'))
      continue
    }
    // 飞书公司库存允许表内暂缺电话，但无效原值绝不能落库。优先采用本行合法号码，
    // 其次保留线上已有合法号码；两者都没有时写空并显式标记待补，公开租金/房态仍继续同步。
    const rowContact = validLandlordPhone(row.contact)
    const existingContact = validLandlordPhone(existing && existing.landlordPhone) || validLandlordPhone(existing && existing.contact)
    row.contact = rowContact || existingContact
    const missingContactReason = row.contact ? '' : '联系电话待补充'
    if (missingContactReason) {
      result.missingLandlordPhone += 1
      if (result.messages.length < 20) {
        result.messages.push(`第 ${row.rowNumber} 行联系电话待补充；公开库存字段继续同步`)
      }
    }
    const matchedMaterial = matcher(row)
    const materialAmbiguous = isAmbiguousMaterialMatch(matchedMaterial)
    const material = materialAmbiguous ? null : matchedMaterial
    if (!material) {
      result.skippedNoMaterial += 1
      result.missingVideoMaterial += 1
      if (materialAmbiguous) result.ambiguousVideoMaterial += 1
      if (result.messages.length < 20) {
        result.messages.push(materialAmbiguous
          ? `第 ${row.rowNumber} 行素材匹配存在歧义，已阻断先到先得并标记缺视频素材`
          : `第 ${row.rowNumber} 行未匹配素材，已标记缺视频素材：${[row.community, row.building, row.unit, row.roomNumber].filter(Boolean).join('-') || row.matchKey}`)
      }
    }

    try {
      if (material && !options.dryRun) {
        prevalidateFeishuUpsertBeforeMaterialTransfer(db, actorId, existing, row, material)
      }
      const video = material
        ? await ensureMaterialVideo(options.feishuToken || '', material, {
          ...options,
          existing,
          allowExistingVideoReuse: Boolean(existing) &&
            wasContinuouslyActiveFeishuListing(existing) &&
            hasSamePhysicalRoomIdentity(existing, row)
        })
        : { videoKey: '', videoUrl: '', materialUrl: '' }
      const upsert = upsertFeishuListing(db, actorId, existing, byExternalId, row, material, video)
      if (upsert.action === 'updated') {
        result.updated += 1
      } else {
        result.created += 1
      }
      result.auditRows.push(buildAuditRow(
        row,
        material,
        material
          ? '上架-已配视频'
          : (isRetainingManagedVideo(upsert.listing) ? '上架-沿用上次视频·素材待核' : '上架-缺视频素材'),
        combineFailureReasons(material ? '' : (materialAmbiguous ? '素材匹配歧义' : '未匹配素材'), missingContactReason)
      ))
    } catch (error) {
      if (material) {
        const failureReason = shortError(error)
        const video = { videoKey: '', videoUrl: '', materialUrl: material.url || material.videoUrl || material.sourcePath || material.name || '' }
        // 降级重试也可能因校验/判重（400/409）再次失败——必须自行兜住，
        // 否则异常穿出 applySync：整轮同步中断、后续行不处理、自动下架与同步日志全部丢失
        try {
          const upsert = upsertFeishuListing(db, actorId, existing, byExternalId, row, material, video, failureReason)
          if (upsert.action === 'updated') {
            result.updated += 1
          } else {
            result.created += 1
          }
          result.materialTransferFailed += 1
          result.missingVideoMaterial += 1
          if (result.messages.length < 20) {
            result.messages.push(`第 ${row.rowNumber} 行素材匹配但搬运失败，已降级上架并标记缺视频素材：${failureReason}`)
          }
          result.auditRows.push(buildAuditRow(
            row,
            material,
            isRetainingManagedVideo(upsert.listing)
              ? '上架-沿用上次视频·转存待核'
              : '上架-素材失败降级缺视频素材',
            combineFailureReasons(failureReason, missingContactReason)
          ))
        } catch (retryError) {
          result.failed += 1
          result.messages.push(`第 ${row.rowNumber} 行同步失败：${retryError.message}`)
          result.auditRows.push(buildAuditRow(row, material, '失败', combineFailureReasons(shortError(retryError), missingContactReason)))
        }
      } else {
        result.failed += 1
        result.messages.push(`第 ${row.rowNumber} 行同步失败：${error.message}`)
        result.auditRows.push(buildAuditRow(row, material, '失败', combineFailureReasons(shortError(error), missingContactReason)))
      }
    }
  }

  db.listings.forEach((listing) => {
    if (listing.externalSource !== 'feishu' || !listing.feishuRecordId) return
    if (seen.has(String(listing.feishuRecordId))) return
    if (downListing(db, listing, '飞书房源表未返回该房源，自动同步下架', actorId)) result.down += 1
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

function bindingTypes(binding) {
  if (!binding || !Object.prototype.hasOwnProperty.call(binding, 'type')) return []
  const values = Array.isArray(binding.type) ? binding.type : [binding.type]
  return values.map((value) => String(value).trim()).filter(Boolean)
}

function bindingContractStatus(role, bindings) {
  const contracts = MIRROR_FIELD_TYPE_CONTRACTS[role] || {}
  const source = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {}
  const requiredValues = new Set(MIRROR_REQUIRED_BINDINGS[role] || [])
  const requiredSchema = new Set([
    ...(MIRROR_REQUIRED_BINDINGS[role] || []),
    ...(MIRROR_REQUIRED_OPTIONAL_VALUE_BINDINGS[role] || [])
  ])
  const issues = []

  requiredSchema.forEach((semantic) => {
    const binding = source[semantic]
    if (!binding || !String(binding.fieldId || binding.field_id || '').trim()) issues.push(`${semantic}:missing`)
  })
  Object.keys(source).forEach((semantic) => {
    const binding = source[semantic]
    const allowedTypes = (contracts[semantic] || []).map((value) => String(value))
    const fieldId = String(binding && (binding.fieldId || binding.field_id) || '').trim()
    if (!allowedTypes.length) {
      issues.push(`${semantic}:unsupported`)
      return
    }
    if (!fieldId) issues.push(`${semantic}:field_id`)
    const declaredTypes = bindingTypes(binding)
    if (declaredTypes.some((type) => !allowedTypes.includes(type))) issues.push(`${semantic}:type`)
    if (binding && Object.prototype.hasOwnProperty.call(binding, 'required') &&
        binding.required !== requiredValues.has(semantic)) {
      issues.push(`${semantic}:required`)
    }
  })
  return { ready: issues.length === 0, issues }
}

function resolvedContractBindings(role, bindings) {
  const state = bindingContractStatus(role, bindings)
  if (!state.ready) throw new Error(`飞书 ${role} 字段契约无效：${state.issues.join('、')}`)
  const contracts = MIRROR_FIELD_TYPE_CONTRACTS[role]
  const requiredValues = new Set(MIRROR_REQUIRED_BINDINGS[role] || [])
  return Object.keys(bindings || {}).sort().reduce((result, semantic) => {
    const configured = bindings[semantic]
    const allowedTypes = contracts[semantic]
    result[semantic] = {
      fieldId: String(configured.fieldId || configured.field_id).trim(),
      type: allowedTypes.length === 1 ? allowedTypes[0] : allowedTypes.slice(),
      required: requiredValues.has(semantic),
      // 是否必须建列与单元格是否必填分离；所有已配置 field_id 都必须真实存在。
      schemaRequired: true
    }
    return result
  }, {})
}

function pairedMirrorBindingsReady(sourceBindings, miniBindings) {
  const source = sourceBindings && typeof sourceBindings === 'object' ? sourceBindings : {}
  const mini = miniBindings && typeof miniBindings === 'object' ? miniBindings : {}
  return MIRROR_PAIRED_SOURCE_FIELDS.every((semantic) => (
    !source[semantic] || Boolean(mini[semantic] && String(mini[semantic].fieldId || mini[semantic].field_id || '').trim())
  ))
}

function mirrorConfigurationStatus() {
  const hasAuth = Boolean(config.feishu.appId && config.feishu.appSecret && config.feishu.bitableAppToken)
  const sourceTableReady = Boolean(config.feishu.sourceTableId)
  const miniTableReady = Boolean(config.feishu.miniTableId)
  const locationTableReady = Boolean(config.feishu.locationTableId)
  const configuredTableIds = [config.feishu.sourceTableId, config.feishu.miniTableId, config.feishu.locationTableId].filter(Boolean)
  const tableIdsDistinct = new Set(configuredTableIds).size === configuredTableIds.length
  const sourceContract = bindingContractStatus('source', config.feishu.sourceFieldBindings)
  const miniContract = bindingContractStatus('mini', config.feishu.miniFieldBindings)
  const locationContract = bindingContractStatus('location', config.feishu.locationFieldBindings)
  const sourceBindingsReady = sourceContract.ready
  const miniBindingsReady = miniContract.ready
  const locationBindingsReady = locationContract.ready
  const pairedBindingsReady = pairedMirrorBindingsReady(config.feishu.sourceFieldBindings, config.feishu.miniFieldBindings)
  const materialsReady = Boolean(config.feishu.folderToken || config.feishu.materialsFile || config.feishu.sourceFieldBindings.video)
  return {
    ready: hasAuth && sourceTableReady && miniTableReady && locationTableReady && tableIdsDistinct &&
      sourceBindingsReady && miniBindingsReady && locationBindingsReady && pairedBindingsReady && materialsReady,
    hasAuth,
    sourceTableReady,
    miniTableReady,
    locationTableReady,
    tableIdsDistinct,
    sourceBindingsReady,
    miniBindingsReady,
    locationBindingsReady,
    pairedBindingsReady,
    materialsReady
  }
}

function assertMirrorConfiguration() {
  const state = mirrorConfigurationStatus()
  if (state.ready) return state
  const missing = []
  if (!state.hasAuth) missing.push('飞书应用凭据或多维表 app token')
  if (!state.sourceTableReady) missing.push('员工源表 ID')
  if (!state.miniTableReady) missing.push('小程序专用源表 ID')
  if (!state.locationTableReady) missing.push('小程序位置字典 ID')
  if (!state.tableIdsDistinct) missing.push('三个表 ID 必须互不相同')
  if (!state.sourceBindingsReady) missing.push('员工源表 field_id 绑定')
  if (!state.miniBindingsReady) missing.push('专用源表 field_id 绑定')
  if (!state.locationBindingsReady) missing.push('位置字典 field_id 绑定')
  if (!state.pairedBindingsReady) missing.push('员工源表与专用源表字段配对')
  if (!state.materialsReady) missing.push('附件字段或素材目录')
  const error = new Error(`飞书镜像同步配置不完整：${missing.join('、')}`)
  error.statusCode = 503
  throw error
}

function semanticFieldsForWrite(fieldNames, fields, options = {}) {
  const names = fieldNames && typeof fieldNames === 'object' ? fieldNames : {}
  const source = fields && typeof fields === 'object' ? fields : {}
  const output = {}
  Object.keys(names).sort().forEach((semantic) => {
    if (Object.prototype.hasOwnProperty.call(source, semantic)) {
      output[names[semantic]] = clone(source[semantic])
    } else if (options.full === true) {
      output[names[semantic]] = null
    }
  })
  return output
}

function chunksOf(items, size = MIRROR_WRITE_BATCH_SIZE) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function flattenLocationSnapshot(snapshot) {
  return (snapshot.records || []).map((record) => ({
    recordId: record.recordId,
    ...(record.fields || {})
  }))
}

function plannedActiveMirrorRecords(sourceSnapshot, mirrorSnapshot, plan) {
  const existingBySourceId = new Map((mirrorSnapshot.records || []).map((record) => [
    normalizeText(record && record.fields && record.fields.sourceRecordId),
    record
  ]))
  const operationBySourceId = new Map((plan.operations || [])
    .filter((operation) => operation.type !== 'deactivate')
    .map((operation) => [operation.sourceRecordId, operation]))

  return (sourceSnapshot.records || []).map((sourceRecord) => {
    const sourceRecordId = normalizeText(sourceRecord.recordId)
    const operation = operationBySourceId.get(sourceRecordId)
    if (operation) {
      return {
        recordId: operation.recordId || `dry-run-${sourceRecordId}`,
        fields: clone(operation.fields)
      }
    }
    const existing = existingBySourceId.get(sourceRecordId)
    if (!existing) throw new Error(`镜像计划缺少源记录投影：${sourceRecordId}`)
    return clone(existing)
  })
}

function assertMirrorDeactivateSafety(mirrorSnapshot, plannedRecords, options = {}) {
  const publishedBefore = new Set((mirrorSnapshot.records || []).filter((record) => (
    record && record.fields && record.fields.enabled === true && record.fields.published === true
  )).map((record) => normalizeText(record.fields.sourceRecordId)).filter(Boolean))
  ;(Array.isArray(options.baselinePublishedSourceIds) ? options.baselinePublishedSourceIds : [])
    .map(normalizeText)
    .filter(Boolean)
    .forEach((sourceRecordId) => publishedBefore.add(sourceRecordId))
  const publishedAfter = new Set((plannedRecords || []).filter((record) => (
    record && record.fields && record.fields.enabled === true && record.fields.published === true
  )).map((record) => normalizeText(record.fields.sourceRecordId)).filter(Boolean))
  const withdrawCount = Array.from(publishedBefore).filter((sourceRecordId) => !publishedAfter.has(sourceRecordId)).length
  if (withdrawCount === 0 || options.allowMassDeactivate === true) return

  const maxCount = options.maxDeactivateCount == null ? 10 : Number(options.maxDeactivateCount)
  const maxRatio = options.maxDeactivateRatio == null ? 0.35 : Number(options.maxDeactivateRatio)
  if (!Number.isInteger(maxCount) || maxCount < 1 || !Number.isFinite(maxRatio) || maxRatio <= 0 || maxRatio > 1) {
    throw new Error('飞书镜像批量停用熔断配置无效')
  }
  const activeBefore = publishedBefore.size
  const ratio = activeBefore > 0 ? withdrawCount / activeBefore : 0
  const countExceeded = withdrawCount > maxCount
  const ratioExceeded = ratio > maxRatio
  if (countExceeded || ratioExceeded) {
    const error = new Error(
      `飞书源表拟撤下 ${withdrawCount}/${activeBefore} 条公开房源，超过安全阈值，已阻断专用源表、库存与待租表发布`
    )
    error.statusCode = 409
    throw error
  }
}

function activeFeishuSourceRecordIds(db = {}) {
  return Array.from(new Set((db.listings || []).filter((listing) => (
    listing && listing.externalSource === 'feishu' &&
    listing.lifecycleStatus !== 'expired' && listing.status !== '已下架'
  )).map((listing) => normalizeText(listing.feishuRecordId)).filter(Boolean))).sort()
}

function activeMirrorRecords(snapshot) {
  return (snapshot.records || []).filter((record) => record && record.fields && record.fields.enabled === true)
}

function canonicalRoomParts(fields = {}) {
  const explicit = {
    building: normalizeRoomPart(fields.building, 'building'),
    unit: normalizeRoomPart(fields.unit, 'unit'),
    roomNumber: normalizeRoomPart(fields.roomNumber, 'room')
  }
  const community = normalizeText(fields.community)
  let roomLabel = normalizeText(fields.roomLabel)
  if (community && roomLabel.indexOf(community) === 0) {
    roomLabel = roomLabel.slice(community.length).replace(/^[\s·,，。；;:：/\\_\-（）()【】\[\]]+/, '')
  }
  const parsed = parseRoomText(roomLabel)
  if (!parsed || !parsed.building || !parsed.roomNumber) {
    throw new Error('专用源表小区+房号格式无法确定解析')
  }
  if (explicit.building || explicit.unit || explicit.roomNumber) {
    if (!explicit.building || !explicit.roomNumber) throw new Error('专用源表显式楼栋/单元/房号不完整')
    const sameRoom = explicit.building === parsed.building && explicit.unit === parsed.unit &&
      explicit.roomNumber === parsed.roomNumber
    if (!sameRoom) throw new Error('专用源表显式楼栋/单元/房号与小区+房号不一致')
  }
  if (explicit.building && explicit.roomNumber) return explicit
  return parsed || explicit
}

function canonicalVideoAttachment(value) {
  if (value === undefined || value === null || value === '') return null
  const attachments = Array.isArray(value) ? value : [value]
  if (attachments.length === 0) return null
  const candidates = attachments.filter((attachment) => {
    if (!attachment || typeof attachment !== 'object') return false
    const name = normalizeText(attachment.name || attachment.file_name || attachment.filename)
    const type = normalizeText(attachment.type || attachment.file_type || attachment.mime_type)
    const token = normalizeText(attachment.file_token || attachment.token || attachment.obj_token)
    return VIDEO_EXT_PATTERN.test(name) || /^video\//i.test(type) || Boolean(token && !name && !type)
  })
  if (candidates.length !== 1) {
    throw new Error(candidates.length > 1
      ? '同一房源附件字段存在多个视频，已阻断先到先得匹配'
      : '房源附件字段非空但没有可识别的视频')
  }
  return candidates[0]
}

function validateCanonicalMirrorRecords(records) {
  const seen = new Set()
  records.forEach((record, index) => {
    const fields = record && record.fields && typeof record.fields === 'object' ? record.fields : {}
    const sourceRecordId = normalizeText(fields.sourceRecordId)
    if (!sourceRecordId || seen.has(sourceRecordId)) {
      throw new Error(`专用源表第 ${index + 1} 行 sourceRecordId 缺失或重复`)
    }
    seen.add(sourceRecordId)
    if (fields.canonical !== true) throw new Error(`专用源表 ${sourceRecordId} 未通过 canonical 校验`)
    if (!normalizeText(fields.district) || !normalizeText(fields.block) || !normalizeText(fields.community) ||
        !normalizeText(fields.roomLabel) || !normalizeText(fields.layoutDescription) ||
        !Number.isFinite(Number(fields.monthlyRent)) || Number(fields.monthlyRent) <= 0) {
      throw new Error(`专用源表 ${sourceRecordId} 缺少位置、房号、户型或有效租金`)
    }
    if (!/^(?:整租|合租)$/.test(normalizeText(fields.rentMode))) {
      throw new Error(`专用源表 ${sourceRecordId} 的出租方式必须明确为整租或合租`)
    }
    const roomParts = canonicalRoomParts(fields)
    if (!roomParts.building || !roomParts.roomNumber) {
      throw new Error(`专用源表 ${sourceRecordId} 无法从房号字段解析楼栋与房间号`)
    }
    canonicalVideoAttachment(fields.video)
    const hasLatitude = fields.latitude !== undefined && fields.latitude !== null && fields.latitude !== ''
    const hasLongitude = fields.longitude !== undefined && fields.longitude !== null && fields.longitude !== ''
    if (hasLatitude !== hasLongitude) throw new Error(`专用源表 ${sourceRecordId} 经纬度必须成对出现`)
  })
  return records
}

function canonicalMirrorRecordToSyncRow(record, index) {
  const fields = record && record.fields && typeof record.fields === 'object' ? record.fields : (record || {})
  const sourceRecordId = normalizeText(fields.sourceRecordId)
  const roomParts = canonicalRoomParts(fields)
  return {
    record_id: sourceRecordId,
    rowNumber: index + 1,
    video: canonicalVideoAttachment(fields.video),
    fields: {
      房源编号: sourceRecordId,
      importKey: sourceRecordId,
      城市: fields.city,
      canonicalDistrict: fields.district,
      canonicalBlock: fields.block,
      行政区: fields.district,
      板块: fields.block,
      小区: fields.community,
      几栋: roomParts.building,
      几单元: roomParts.unit,
      房间号: roomParts.roomNumber,
      户型: fields.layoutDescription !== undefined ? fields.layoutDescription : fields.layout,
      户型分类: fields.layoutCategory,
      月租金: fields.monthlyRent !== undefined ? fields.monthlyRent : fields.rent,
      出租方式: fields.rentMode,
      看房方式: fields.viewingMethod,
      备注: fields.remark,
      房源状态: fields.published === true
        ? (fields.listingStatus !== undefined ? fields.listingStatus : (fields.status || '在租'))
        : '下架',
      联系电话: fields.contact,
      看房方式密码: fields.viewingPassword,
      房东佣金占月租比例: fields.landlordCommissionPercent,
      标签: fields.tags,
      mapLatitude: fields.latitude,
      mapLongitude: fields.longitude
    }
  }
}

async function executeMirrorTableSync(options = {}) {
  const client = options.client
  if (!client || typeof client.readValidatedTableSnapshot !== 'function') {
    throw new Error('飞书镜像同步缺少受校验的多维表客户端')
  }
  const sourceSnapshot = await client.readValidatedTableSnapshot({
    tableId: options.sourceTableId,
    bindings: options.sourceBindings,
    allowEmpty: false
  })
  const locationSnapshot = await client.readValidatedTableSnapshot({
    tableId: options.locationTableId,
    bindings: options.locationBindings,
    allowEmpty: false
  })
  const mirrorSnapshot = await client.readValidatedTableSnapshot({
    tableId: options.miniTableId,
    bindings: options.miniBindings,
    allowEmpty: true
  })
  const locationCatalog = buildLocationCatalog(flattenLocationSnapshot(locationSnapshot))
  const runId = normalizeText(options.runId) || `mirror-${Date.now()}-${Math.floor(Math.random() * 100000)}`
  const plan = planMirrorSync({ sourceSnapshot, mirrorSnapshot, locationCatalog, runId })
  const plannedRecords = activeMirrorRecords({
    records: plannedActiveMirrorRecords(sourceSnapshot, mirrorSnapshot, plan)
  })
  validateCanonicalMirrorRecords(plannedRecords)
  assertMirrorDeactivateSafety(mirrorSnapshot, plannedRecords, {
    baselinePublishedSourceIds: options.baselinePublishedSourceIds,
    maxDeactivateCount: options.maxDeactivateCount,
    maxDeactivateRatio: options.maxDeactivateRatio,
    allowMassDeactivate: options.allowMassDeactivate === true
  })

  if (options.dryRun === true) {
    return {
      complete: true,
      published: false,
      validated: true,
      planned: true,
      failed: 0,
      schemaInvalid: false,
      mirrorIncomplete: false,
      dryRun: true,
      noop: plan.noop,
      status: 'success-dry-run',
      counts: clone(plan.counts),
      records: plannedRecords,
      materials: options.materials || []
    }
  }

  const creates = plan.operations.filter((operation) => operation.type === 'create')
  const updates = plan.operations.filter((operation) => operation.type !== 'create')
  for (const batch of chunksOf(creates)) {
    await client.batchCreateRecords(options.miniTableId, batch.map((operation) => ({
      fields: semanticFieldsForWrite(mirrorSnapshot.fieldNames, operation.fields, { full: true })
    })), {
      clientToken: crypto.randomUUID()
    })
  }
  for (const batch of chunksOf(updates)) {
    await client.batchUpdateRecords(options.miniTableId, batch.map((operation) => ({
      record_id: operation.recordId,
      fields: semanticFieldsForWrite(mirrorSnapshot.fieldNames, operation.fields, {
        full: operation.type !== 'deactivate'
      })
    })))
  }

  const readback = await client.readValidatedTableSnapshot({
    tableId: options.miniTableId,
    bindings: options.miniBindings,
    allowEmpty: false
  })
  const remainingPlan = planMirrorSync({
    sourceSnapshot,
    mirrorSnapshot: readback,
    locationCatalog,
    runId: `${runId}-readback`
  })
  if (!remainingPlan.noop) {
    const error = new Error('飞书专用源表写后回读不一致，已阻断库存与待租表发布')
    error.statusCode = 502
    throw error
  }

  return {
    complete: true,
    published: true,
    validated: true,
    planned: true,
    failed: 0,
    schemaInvalid: false,
    mirrorIncomplete: false,
    dryRun: false,
    noop: plan.noop,
    status: plan.noop ? 'success-noop' : 'success',
    counts: clone(plan.counts),
    records: activeMirrorRecords(readback),
    materials: options.materials || []
  }
}

async function loadConfiguredMirrorMaterials(token, options = {}) {
  if (Array.isArray(options.materials)) return options.materials
  if (config.feishu.materialsFile) return readJson(config.feishu.materialsFile)
  if (config.feishu.folderToken) return loadFolderMaterials(token, config.feishu.folderToken)
  return []
}

async function configuredMirrorTableSync(options = {}) {
  assertMirrorConfiguration()
  const token = options.feishuToken || await tenantAccessToken()
  const client = options.client || createBitableClient({
    baseUrl: config.feishu.baseUrl,
    appToken: config.feishu.bitableAppToken,
    accessToken: token,
    pageSize: config.feishu.pageSize,
    requestTimeoutMs: config.feishu.requestTimeoutMs,
    maxRetries: config.feishu.requestMaxRetries,
    retryDelayMs: config.feishu.requestRetryDelayMs,
    fetchImpl: fetch
  })
  const materials = await loadConfiguredMirrorMaterials(token, options)
  const sourceBindings = resolvedContractBindings('source', config.feishu.sourceFieldBindings)
  const miniBindings = resolvedContractBindings('mini', config.feishu.miniFieldBindings)
  const locationBindings = resolvedContractBindings('location', config.feishu.locationFieldBindings)
  const result = await executeMirrorTableSync({
    client,
    sourceTableId: config.feishu.sourceTableId,
    miniTableId: config.feishu.miniTableId,
    locationTableId: config.feishu.locationTableId,
    sourceBindings,
    miniBindings,
    locationBindings,
    maxDeactivateCount: config.feishu.mirrorMaxDeactivateCount,
    maxDeactivateRatio: config.feishu.mirrorMaxDeactivateRatio,
    allowMassDeactivate: config.feishu.mirrorAllowMassDeactivate,
    baselinePublishedSourceIds: options.baselinePublishedSourceIds,
    dryRun: options.dryRun === true,
    runId: options.runId,
    materials
  })
  return { ...result, feishuToken: token }
}

async function syncViaMirror(db, adminId, options = {}) {
  const baselinePublishedSourceIds = activeFeishuSourceRecordIds(db)
  const run = await runCompanySourceSync({
    db,
    mirrorSync: () => configuredMirrorTableSync({ ...options, baselinePublishedSourceIds }),
    applyInventory: async (workingDb, records, mirrorResult) => {
      const rows = validateCanonicalMirrorRecords(records).map(canonicalMirrorRecordToSyncRow)
      const inventory = await applySync(workingDb, rows, mirrorResult.materials || [], adminId, {
        ...options,
        dryRun: options.dryRun === true,
        skipSheetSnapshot: true,
        feishuToken: mirrorResult.feishuToken || options.feishuToken || '',
        trustedCanonicalCoordinates: true
      })
      const complete = inventory.failed === 0 && inventory.skippedInvalid === 0
      return {
        ...inventory,
        complete,
        published: complete,
        noop: inventory.created === 0 && inventory.updated === 0 && inventory.down === 0
      }
    },
    publishSnapshot: async (workingDb, records) => {
      const before = JSON.stringify(workingDb.companySheetSnapshot || null)
      // 镜像阶段已按“此前公开 ID → 本轮公开 ID”执行批量撤下熔断；小批明确房态变更后
      // 允许合法发布仅含表头的零房源快照，不能因旧的非空保护让已租房源继续公开。
      const snapshot = publishCompanySnapshot(workingDb, records, { complete: true, allowEmptyPublic: true })
      const sanitized = sanitizeSheetSnapshot({
        ...snapshot,
        sourceMode: 'feishu-mini-mirror-v1',
        schemaVersion: 1,
        updatedAt: nowText()
      })
      workingDb.companySheetSnapshot = sanitized
      return {
        complete: true,
        published: true,
        failed: 0,
        noop: before === JSON.stringify(sanitized),
        rowCount: sanitized.rowCount,
        columnCount: sanitized.columnCount,
        updatedAt: sanitized.updatedAt
      }
    },
    // DB 原子提交仍由 index.js 在最终分类成功后执行；dry-run 同样调用此阶段但不落盘。
    commit: async () => ({ complete: true, noop: true, dryRun: options.dryRun === true })
  })

  const inventory = run.inventory && typeof run.inventory === 'object' ? run.inventory : {}
  return {
    ...inventory,
    complete: run.complete,
    published: run.published,
    validated: run.validated,
    planned: run.planned,
    failed: run.failed,
    schemaInvalid: run.schemaInvalid,
    mirrorIncomplete: run.mirrorIncomplete,
    success: run.success,
    status: run.status,
    noop: run.noop,
    dryRun: run.dryRun,
    mirror: run.mirror,
    sheetSnapshot: run.snapshot
  }
}

function isCommittableSyncResult(result) {
  if (!config.feishu.mirrorSyncEnabled) return true
  const classified = classifyMirrorRunResult(result)
  return classified.success && classified.dryRun !== true
}

function parseAdminDryRun(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('飞书同步请求体必须是 JSON 对象')
    error.statusCode = 400
    throw error
  }
  if (Object.prototype.hasOwnProperty.call(body, 'dryRun') && typeof body.dryRun !== 'boolean') {
    const error = new Error('dryRun 必须是 JSON 布尔值')
    error.statusCode = 400
    throw error
  }
  return body.dryRun === true
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
  if (!config.feishu.syncEnabled) {
    const error = new Error('飞书房源同步已由服务端配置停用')
    error.statusCode = 503
    throw error
  }
  if (config.feishu.mirrorSyncEnabled) return syncViaMirror(db, adminId, options)

  const loaded = await loadRowsAndMaterials(options)
  const result = await applySync(db, loaded.rows, loaded.materials, adminId, {
    ...options,
    feishuToken: loaded.feishuToken,
    trustedCanonicalCoordinates: false
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
  const legacyReady = (hasLocalFiles || hasBitable || hasSheet) && hasFolder
  const mirrorState = mirrorConfigurationStatus()
  const sourceReady = config.feishu.syncEnabled && (config.feishu.mirrorSyncEnabled ? mirrorState.ready : legacyReady)
  return {
    ready: sourceReady,
    mode: config.feishu.mirrorSyncEnabled
      ? '飞书专用源表镜像'
      : (hasLocalFiles ? '本地文件导入' : (hasBitable ? '飞书多维表' : '飞书表格')),
    syncEnabled: config.feishu.syncEnabled,
    autoSyncEnabled: config.feishu.autoSyncEnabled,
    mirrorSyncEnabled: config.feishu.mirrorSyncEnabled,
    recordsReady: config.feishu.mirrorSyncEnabled
      ? mirrorState.sourceTableReady && mirrorState.miniTableReady && mirrorState.locationTableReady
      : (hasLocalFiles || hasBitable || hasSheet),
    sheetReady: hasSheet,
    materialsReady: config.feishu.mirrorSyncEnabled ? mirrorState.materialsReady : hasFolder,
    sourceTableReady: mirrorState.sourceTableReady,
    miniTableReady: mirrorState.miniTableReady,
    locationTableReady: mirrorState.locationTableReady,
    tableIdsDistinct: mirrorState.tableIdsDistinct,
    sourceBindingsReady: mirrorState.sourceBindingsReady,
    miniBindingsReady: mirrorState.miniBindingsReady,
    locationBindingsReady: mirrorState.locationBindingsReady,
    pairedBindingsReady: mirrorState.pairedBindingsReady,
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
    missingLandlordPhoneCount: (db.listings || []).filter((item) => (
      item.externalSource === 'feishu' &&
      item.lifecycleStatus !== 'expired' &&
      item.status !== '已下架' &&
      !validLandlordPhone(item.landlordPhone) &&
      !validLandlordPhone(item.contact)
    )).length,
    feishuListingCount: (db.listings || []).filter((item) => item.externalSource === 'feishu' && item.lifecycleStatus !== 'expired' && item.status !== '已下架').length
  }
}

module.exports = {
  sync,
  status,
  sheetSnapshot,
  cachedSheetSnapshot,
  unavailableSheetSnapshot,
  refreshSheetSnapshot,
  normalizeRecord,
  applySync,
  isCommittableSyncResult,
  parseAdminDryRun,
  sanitizeSheetSnapshot,
  _internal: {
    roomIdentityKey,
    existingByExternalId,
    createMaterialMatcher,
    canonicalMirrorRecordToSyncRow,
    executeMirrorTableSync,
    mirrorConfigurationStatus,
    bindingContractStatus,
    resolvedContractBindings,
    pairedMirrorBindingsReady,
    loadConfiguredMirrorMaterials,
    semanticFieldsForWrite,
    activeFeishuSourceRecordIds
  }
}
