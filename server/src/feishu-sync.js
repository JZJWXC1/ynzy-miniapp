const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const companySheetSnapshotContract = require('./company-sheet-snapshot-contract')
const domain = require('./domain')
const locationMap = require('./location-map')
const oss = require('./oss')
const { refreshRecommendationProfile } = require('./listing-recommendation-profile')
const { normalizeListingFeatures } = require('./listing-features')
const { resolveManagedVideoObjectKey } = require('./public-listing-media')
const bitableClient = require('./feishu-bitable-client')
const { createBitableClient } = bitableClient
const { rebuildValidatedTableSnapshot } = bitableClient._internal
const { createFeishuNoteMaterialClient } = require('./feishu-note-material-client')
const { createFeishuNoteMaterialNormalizer } = require('./feishu-note-material-normalizer')
const noteMaterialSync = require('./feishu-note-material-sync')
const { syncNoteMaterialsForInventory } = noteMaterialSync
const {
  rememberContentPlanConfirmation,
  recallContentPlanConfirmation,
  isContentPlanConfirmationError,
  isKnownMaterialRowWarningReport,
  externalWriteStateUnknownError,
  isExternalWriteStateUnknownError,
  isExternalWriteIntentPersistenceError,
  buildContentPlanSummary,
  buildNoteMaterialSourceFieldPlan
} = noteMaterialSync._internal
const sourceMirror = require('./feishu-source-mirror')
const {
  buildLocationCatalog,
  prepareSourceSnapshotForCompatibility,
  planMirrorSync,
  buildCompanySheetSnapshot,
  publishCompanySnapshot,
  classifyMirrorRunResult,
  runCompanySourceSync
} = sourceMirror
const { managedFieldNames, managedFieldsOf } = sourceMirror._internal
const {
  planListingLifecycle,
  yuxiaoerIdentityKey
} = require('./feishu-listing-lifecycle')
const {
  planFoundationEnrichment
} = require('./feishu-foundation-enrichment')

const COMPANY_SOURCE = '公司房源'
const COMPANY_FEATURES = ['免押金', '不分佣']
const MISSING_VIDEO_MATERIAL_STATUS = '缺视频素材'
const RETAINED_VIDEO_MATERIAL_STATUS = '沿用上次视频·素材待核'
const DISABLED_MATERIAL_POLICY = 'disabled'
const NOTE_MANAGED_MATERIAL_POLICY = 'note-managed'
const MIRROR_NOTE_TARGET_CONTEXT = Symbol('mirror-note-target-context')
const REACTIVATED_NOTE_SOURCE_IDS = Symbol('reactivated-note-source-ids')
const VIDEO_EXT_PATTERN = /\.(mp4|mov|m4v|avi|webm)$/i
const DOWN_STATUS_PATTERN = /下架|已租|已成交|成交|关闭|无效|删除|暂停|不可租|停租|down|off|inactive|rented|closed/i
const UP_STATUS_PATTERN = /上架|在租|待租|待出租|即将空出|空置|可租|有效|up|on|active/i
const NOT_UP_PATTERN = /未上架|不上架|否|false|no|0/i
const RETAINABLE_ACTIVE_STATUS_PATTERN = /^(?:上架|已上架|在租|待租|待出租|即将空出|空置|可租|有效|up|on|active)$/i
const SENSITIVE_FEISHU_FIELD_PATTERN = /(看房方式密码|看房方式|看房密码|门锁密码|密码|联系方式|联系电话|房东联系方式|房东电话|联系人电话|手机号|手机|电话|微信|身份证|证件)/i
const MIRROR_REQUIRED_BINDINGS = Object.freeze({
  source: ['community', 'roomLabel', 'layoutDescription', 'monthlyRent', 'rentMode', 'listingStatus'],
  mini: [
    'sourceRecordId', 'locationId', 'locationRecordId', 'city', 'district', 'block', 'community',
    'latitude', 'longitude', 'roomLabel', 'building', 'roomNumber', 'layoutDescription', 'layoutCategory',
    'monthlyRent', 'rentMode', 'listingStatus',
    'published', 'canonical', 'enabled'
  ],
  location: ['locationId', 'city', 'district', 'block', 'community', 'latitude', 'longitude', 'enabled'],
  rented: ['archiveKey', 'foundationListingId', 'availabilityCycleId', 'lifecycleStatusText', 'archivedAt'],
  history: ['historyEventId', 'foundationListingId', 'availabilityCycleId', 'eventType', 'toLifecycleStatusText', 'eventAt']
})
const MIRROR_REQUIRED_OPTIONAL_VALUE_BINDINGS = Object.freeze({
  source: ['viewingMethod', 'remark'],
  mini: ['unit', 'viewingMethod', 'remark'],
  location: [],
  rented: [
    'temporaryListingId', 'yuxiaoerListingId', 'yuxiaoerRoomId', 'identityType',
    'physicalUnitKey', 'sourceRecordId', 'availabilityCycleNo', 'vacancyNote',
    'sourceCreatedAt', 'metricKind', 'lifecycleDays', 'listingOwner', 'ownerDepartment',
    'identityAliases', 'lifecycleVersion', 'previousLifecycleStatusText',
    'locationId', 'locationRecordId', 'city', 'district', 'block', 'community',
    'latitude', 'longitude', 'roomLabel', 'building', 'unit', 'roomNumber',
    'layoutDescription', 'layoutCategory', 'monthlyRent', 'rentMode',
    'viewingMethod', 'remark', 'listingStatus', 'tags', 'video',
    'published', 'enabled', 'sourcePresent'
  ],
  history: [
    'sourceRecordId', 'availabilityCycleNo', 'fromLifecycleStatusText',
    'runId', 'listingOwner', 'ownerDepartment', 'lifecycleVersion'
  ]
})
const FOUNDATION_MINI_FIELDS = Object.freeze([
  'foundationListingId', 'temporaryListingId', 'yuxiaoerListingId', 'yuxiaoerRoomId',
  'identityType', 'physicalUnitKey', 'lifecycleStatusText', 'vacancyNote',
  'sourceCreatedAt', 'availabilityCycleNo', 'availabilityCycleId', 'metricKind',
  'lifecycleDays', 'listingOwner', 'ownerDepartment', 'sourcePresent',
  'identityAliases', 'lifecycleVersion'
])
const LEGACY_PROTECTED_FOUNDATION_FIELD_SET = new Set(
  FOUNDATION_MINI_FIELDS.filter((semantic) => semantic !== 'vacancyNote')
)
const MIRROR_PAIRED_SOURCE_FIELDS = Object.freeze([
  'rentMode', 'roomLabel', 'building', 'unit', 'roomNumber', 'layoutDescription', 'layoutCategory',
  'monthlyRent', 'viewingMethod', 'remark', 'vacancyNote', 'listingStatus', 'contact', 'viewingPassword',
  'landlordCommissionPercent', 'tags', 'video'
])
const MIRROR_FIELD_TYPE_CONTRACTS = Object.freeze({
  source: Object.freeze({
    community: [1, 3], roomLabel: [1], building: [1, 2], unit: [1, 2], roomNumber: [1, 2],
    layoutDescription: [1], layoutCategory: [1, 3], monthlyRent: [1, 2], rentMode: [1, 3],
    viewingMethod: [1, 3], remark: [1], vacancyNote: [1], listingStatus: [1, 3], contact: [1, 13],
    viewingPassword: [1], landlordCommissionPercent: [1, 2], tags: [1, 4], video: [17],
    noteMaterialLink: [15]
  }),
  mini: Object.freeze({
    sourceRecordId: [1], locationId: [1], locationRecordId: [1], city: [1], district: [1, 3],
    block: [1, 3], community: [1], latitude: [2], longitude: [2], roomLabel: [1], building: [1],
    unit: [1], roomNumber: [1], layoutDescription: [1], layoutCategory: [1, 3], monthlyRent: [2],
    rentMode: [1, 3], viewingMethod: [1, 3], remark: [1], vacancyNote: [1], listingStatus: [1, 3], contact: [1, 13],
    viewingPassword: [1], landlordCommissionPercent: [2], tags: [4], video: [17],
    foundationListingId: [1], temporaryListingId: [1], yuxiaoerListingId: [1],
    yuxiaoerRoomId: [1], identityType: [1, 3], physicalUnitKey: [1],
    lifecycleStatusText: [1, 3], sourceCreatedAt: [5], availabilityCycleNo: [2],
    availabilityCycleId: [1], metricKind: [1, 3], lifecycleDays: [2],
    listingOwner: [1], ownerDepartment: [1], sourcePresent: [7],
    identityAliases: [1], lifecycleVersion: [2],
    published: [7], canonical: [7], enabled: [7]
  }),
  location: Object.freeze({
    locationId: [1], city: [1], district: [1, 3], block: [1, 3], community: [1], aliases: [1, 4],
    latitude: [2], longitude: [2], enabled: [7]
  }),
  rented: Object.freeze({
    archiveKey: [1], foundationListingId: [1], temporaryListingId: [1],
    yuxiaoerListingId: [1], yuxiaoerRoomId: [1], identityType: [1, 3],
    physicalUnitKey: [1], sourceRecordId: [1], availabilityCycleNo: [2],
    availabilityCycleId: [1], lifecycleStatusText: [1, 3], vacancyNote: [1],
    sourceCreatedAt: [5], metricKind: [1, 3], lifecycleDays: [2],
    listingOwner: [1], ownerDepartment: [1], archivedAt: [5],
    identityAliases: [1], lifecycleVersion: [2], previousLifecycleStatusText: [1, 3],
    locationId: [1], locationRecordId: [1], city: [1], district: [1, 3],
    block: [1, 3], community: [1], latitude: [2], longitude: [2],
    roomLabel: [1], building: [1], unit: [1], roomNumber: [1],
    layoutDescription: [1], layoutCategory: [1, 3], monthlyRent: [2],
    rentMode: [1, 3], viewingMethod: [1, 3], remark: [1],
    listingStatus: [1, 3], tags: [4], video: [17],
    published: [7], enabled: [7], sourcePresent: [7]
  }),
  history: Object.freeze({
    historyEventId: [1], foundationListingId: [1], sourceRecordId: [1],
    availabilityCycleNo: [2], availabilityCycleId: [1], eventType: [1, 3],
    fromLifecycleStatusText: [1, 3], toLifecycleStatusText: [1, 3],
    eventAt: [5], runId: [1], listingOwner: [1], ownerDepartment: [1],
    lifecycleVersion: [2]
  })
})
const MIRROR_WRITE_BATCH_SIZE = 500
const EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE = 'employee-current-stock-v1'
const EMPLOYEE_AI_FOUNDATION_PROFILE = 'employee-ai-foundation-v1'
const FOUNDATION_BASELINE_EVENT_ID = 'HIST-FOUNDATION-BASELINE-V1'
const FOUNDATION_BASELINE_ENTITY_ID = 'SYSTEM:FOUNDATION-BASELINE'
const RENTED_BUSINESS_SNAPSHOT_FIELDS = Object.freeze([
  'locationId',
  'locationRecordId',
  'city',
  'district',
  'block',
  'community',
  'latitude',
  'longitude',
  'roomLabel',
  'building',
  'unit',
  'roomNumber',
  'layoutDescription',
  'layoutCategory',
  'monthlyRent',
  'rentMode',
  'viewingMethod',
  'remark',
  'listingStatus',
  'tags',
  'video',
  'published',
  'enabled',
  'sourcePresent'
])

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
  const timeout = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : materialTimeoutMs()
  const operation = normalizeText(options.operation) || '请求'
  const consume = typeof options.consume === 'function' ? options.consume : null
  let timedOut = false
  let timer
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      const timeoutError = new Error(`${operation}超过 ${Math.round(timeout / 1000)} 秒未完成`)
      timeoutError.statusCode = 504
      timeoutError.code = 'FEISHU_REQUEST_TIMEOUT'
      reject(timeoutError)
    }, timeout)
  })
  try {
    const requestOptions = { ...options }
    delete requestOptions.timeoutMs
    delete requestOptions.operation
    delete requestOptions.consume
    const response = await Promise.race([
      fetch(url, {
        ...requestOptions,
        signal: controller.signal
      }),
      timeoutPromise
    ])
    if (!consume) return response
    return await Promise.race([
      Promise.resolve().then(() => consume(response)),
      timeoutPromise
    ])
  } catch (error) {
    if (timedOut || (error && error.name === 'AbortError')) {
      const timeoutError = new Error(`${operation}超过 ${Math.round(timeout / 1000)} 秒未完成`)
      timeoutError.statusCode = 504
      timeoutError.code = 'FEISHU_REQUEST_TIMEOUT'
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

function normalizeResourceIdentifier(value) {
  return String(value === undefined || value === null ? '' : value).trim()
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
  const withUnit = text.match(/^(.+?)(?:号楼|楼|幢|栋)(.+?)单元(.+?)(?:房间|房|室)?$/)
  const hasBoundarySeparator = withUnit &&
    (/^[-－—]/.test(withUnit[2]) || /^[-－—]/.test(withUnit[3]))
  if (withUnit && !hasBoundarySeparator) {
    return {
      building: normalizeRoomPart(withUnit[1], 'building'),
      unit: normalizeRoomPart(withUnit[2], 'unit'),
      roomNumber: normalizeRoomPart(withUnit[3], 'room')
    }
  }
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
  const method = String(options.method || 'GET').toUpperCase()
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : Number(config.feishu.requestTimeoutMs || 30000)
  const configuredRetries = Number.isSafeInteger(Number(options.maxRetries))
    ? Number(options.maxRetries)
    : Number(config.feishu.requestMaxRetries || 0)
  const maxRetries = Math.max(0, Math.min(5, configuredRetries))
  const retrySafe = method === 'GET' || pathname === '/auth/v3/tenant_access_token/internal'
  let lastError = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fetchWithTimeout(`${trimSlash(config.feishu.baseUrl)}${pathname}`, {
        method,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        timeoutMs,
        operation: '飞书接口请求',
        consume: async (response) => {
          let body
          try {
            body = await response.json()
          } catch (error) {
            const invalid = new Error('飞书接口响应不是有效 JSON')
            invalid.statusCode = Number(response && response.status) || 502
            invalid.code = 'FEISHU_RESPONSE_INVALID'
            throw invalid
          }
          if (!response.ok || !body || (body.code !== undefined && Number(body.code) !== 0)) {
            const failure = new Error('飞书接口请求失败')
            failure.statusCode = Number(response && response.status) || 502
            failure.apiCode = Number(body && body.code) || 0
            failure.code = 'FEISHU_REQUEST_FAILED'
            throw failure
          }
          return body.data || body
        }
      })
    } catch (error) {
      lastError = error
      const status = Number(error && error.statusCode) || 0
      const retryable = retrySafe && (
        !status || status === 408 || status === 429 || status >= 500 ||
        (error && error.code === 'FEISHU_REQUEST_TIMEOUT')
      )
      if (!retryable || attempt >= maxRetries) throw error
      const delayBase = Math.max(0, Number(config.feishu.requestRetryDelayMs || 0))
      if (delayBase > 0) await sleep(delayBase * (attempt + 1))
    }
  }
  throw lastError || new Error('飞书接口请求失败')
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
  const sourceRows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  const rows = options.fillMergedCells === false
    ? (() => {
        const columnCount = Math.max(0, ...sourceRows.map((row) => Array.isArray(row) ? row.length : 0))
        return sourceRows.map((row) => Array.from({ length: columnCount }).map(
          (_, index) => normalizeText(Array.isArray(row) ? row[index] : '')
        ))
      })()
    : normalizeSnapshotRows(sourceRows)
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

function cachedSheetSnapshotV2(db = {}) {
  const hasStoredV2 = Object.prototype.hasOwnProperty.call(db, 'companySheetSnapshotV2')
  const stored = companySheetSnapshotContract.parseCompanySheetSnapshotV2(db.companySheetSnapshotV2)
  if (stored) return stored
  // 仅“从未写过 v2 字段”允许一次旧缓存迁移；字段已经存在却验签失败代表损坏，必须
  // fail-closed，不能用旧 v1 静默掩盖摘要、列键或行数据被破坏。
  if (hasStoredV2) return null
  // 首次升级期间允许把数据库内“精确 v1 固定十列快照”只读转换为 v2；任何旧表头别名、
  // 错列、合并单元格空值或摘要损坏都会失败并返回 unavailable，不做猜测和填充。
  try {
    const rawLegacy = db.companySheetSnapshot
    const legacy = rawLegacy && Array.isArray(rawLegacy.rows) && rawLegacy.rows.length
      ? sanitizeSheetSnapshot(rawLegacy, { fillMergedCells: false })
      : null
    return legacy ? companySheetSnapshotContract.convertTrustedV1SnapshotToV2(legacy) : null
  } catch (error) {
    return null
  }
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

function unavailableSheetSnapshotV2() {
  return companySheetSnapshotContract.createUnavailableCompanySheetSnapshotV2()
}

async function refreshSheetSnapshot(db = {}, options = {}) {
  const snapshot = await sheetSnapshot(options)
  db.companySheetSnapshot = sanitizeSheetSnapshot({
    ...snapshot,
    cachedAt: nowText()
  })
  return db.companySheetSnapshot
}

async function loadFolderMaterials(token, folderToken, parentPath = '', depth = 0, traversal = null) {
  if (!folderToken) return []
  if (depth > config.feishu.maxFolderDepth) {
    const error = new Error('旧素材目录层级超过安全上限')
    error.statusCode = 409
    error.safeBeforeWrite = true
    throw error
  }
  const state = traversal || {
    pages: 0,
    items: 0,
    visitedFolders: new Set()
  }
  const folderIdentity = normalizeText(folderToken)
  if (state.visitedFolders.has(folderIdentity)) {
    const error = new Error('旧素材目录存在重复或循环引用')
    error.statusCode = 409
    error.safeBeforeWrite = true
    throw error
  }
  state.visitedFolders.add(folderIdentity)
  let pageToken = ''
  const materials = []
  const seenPageTokens = new Set()
  let folderPage = 0
  while (true) {
    folderPage += 1
    state.pages += 1
    if (state.pages > 10000) {
      const error = new Error('旧素材目录分页超过安全上限')
      error.statusCode = 409
      error.safeBeforeWrite = true
      throw error
    }
    const params = new URLSearchParams({
      folder_token: folderToken,
      page_size: String(config.feishu.pageSize)
    })
    if (pageToken) params.set('page_token', pageToken)
    const data = await feishuJson(`/drive/v1/files?${params.toString()}`, token)
    if (typeof data.has_more !== 'boolean') {
      const error = new Error('旧素材目录分页缺少严格 has_more')
      error.statusCode = 502
      error.safeBeforeWrite = true
      throw error
    }
    let files = Array.isArray(data.files)
      ? data.files
      : (Array.isArray(data.items) ? data.items : null)
    if (!files) {
      const firstEmpty = folderPage === 1 && data.has_more === false && Number(data.total || 0) === 0
      if (!firstEmpty) {
        const error = new Error('旧素材目录分页缺少项目数组')
        error.statusCode = 502
        error.safeBeforeWrite = true
        throw error
      }
      files = []
    }
    state.items += files.length
    if (state.items > Number(config.feishu.noteMaterialMaxItems || 5000)) {
      const error = new Error('旧素材目录项目数量超过安全上限')
      error.statusCode = 409
      error.safeBeforeWrite = true
      throw error
    }
    for (const file of files) {
      const name = normalizeText(file.name || file.file_name)
      const type = normalizeText(file.type || file.file_type)
      if (/folder/i.test(type)) {
        const childToken = file.token || file.file_token
        if (!childToken) {
          const error = new Error('旧素材子目录缺少稳定标识')
          error.statusCode = 502
          error.safeBeforeWrite = true
          throw error
        }
        const children = await loadFolderMaterials(
          token,
          childToken,
          [parentPath, name].filter(Boolean).join('/'),
          depth + 1,
          state
        )
        materials.push(...children)
      } else if (VIDEO_EXT_PATTERN.test(name) || /^video\//i.test(type)) {
        materials.push(materialFromRaw(file, parentPath))
      }
    }
    if (!data.has_more) break
    const nextPageToken = normalizeText(data.next_page_token || data.page_token)
    if (!nextPageToken) {
      const error = new Error('旧素材目录声明 has_more 但缺少 page_token')
      error.statusCode = 502
      error.safeBeforeWrite = true
      throw error
    }
    if (seenPageTokens.has(nextPageToken)) {
      const error = new Error('旧素材目录分页 token 循环')
      error.statusCode = 502
      error.safeBeforeWrite = true
      throw error
    }
    seenPageTokens.add(nextPageToken)
    pageToken = nextPageToken
  }
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
  const materialDisabled = mirrorMaterialValuesExcluded(options.materialPolicy)
  const previousPrimaryTargetAttachment = options.materialPolicy === NOTE_MANAGED_MATERIAL_POLICY &&
    listing.noteMaterialState && typeof listing.noteMaterialState === 'object' &&
    listing.noteMaterialState.primaryTargetAttachment &&
    typeof listing.noteMaterialState.primaryTargetAttachment === 'object'
    ? clone(listing.noteMaterialState.primaryTargetAttachment)
    : null
  const hasMaterial = !materialDisabled && Boolean(material)
  const materialReady = hasMaterial && !materialFailureReason
  // domain.updateNormalListing 会在本轮视频字段为空时保留旧值，因此这里仍能先验证并快照最后一份有效视频。
  // 只接受受控 uploadDir/OSS 源；任意外链、客户端 URL 或畸形 object key 均不得进入沿用路径。
  const retainedManagedVideo = materialDisabled || materialReady || options.allowRetainedVideo === false
    ? null
    : managedVideoSnapshot(listing)
  if (!materialDisabled) {
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
  }
  listing.syncedAt = nowText()
  listing.feishuLastSyncAt = listing.syncedAt
  listing.feishuLastSyncReason = combineFailureReasons(materialFailureReason, contact ? '' : '联系电话待补充')
  listing.status = '在租'
  listing.lifecycleStatus = 'active'
  listing.reviewStatus = '无需审核'
  listing.lastVerifiedAt = listing.syncedAt
  listing.updatedAt = listing.syncedAt
  if (materialDisabled) {
    if (options.allowRetainedVideo === true) {
      // 纯房源模式只更新房源事实；同一套持续在租房源的已有媒体包和素材状态保持原样。
      // 请求级签名 URL 不属于持久事实，仍应随本轮库存刷新失效并由读取链重新签发。
      clearListingDerivedVideoFields(listing)
    } else {
      // 新房源、重新上架或物理身份变化不得从旧对象继承视频及确定性素材状态。
      clearListingVideoFields(listing)
      listing.sourceMaterialToken = ''
      listing.sourceMaterialName = ''
      listing.sourceMaterialPath = ''
      listing.sourceMaterialUrl = ''
      listing.syncStatus = '已同步飞书'
      delete listing.videoMaterialStatus
      delete listing.missingVideoMaterial
      delete listing.videoMaterialFailureReason
      delete listing.mediaAssets
      delete listing.noteMaterialState
      if (previousPrimaryTargetAttachment) {
        listing.noteMaterialState = {
          primaryTargetAttachment: previousPrimaryTargetAttachment
        }
      }
      delete listing.videoLabel
      refreshRecommendationProfile(listing, { generatedAt: listing.updatedAt })
    }
  } else if (!materialReady) {
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

function upsertFeishuListing(db, adminId, existing, byExternalId, row, material, video, materialFailureReason = '', options = {}) {
  const payload = buildListingPayload(row, video)
  if (existing) {
    const snapshot = clone(existing)
    try {
      // 必须在 updateNormalListing/attachFeishuFields 改写状态和物理字段之前冻结资格。
      // “持续在架”与“同一物理房源”缺一不可；成交/签单/暂停/失效、来源不明、物理键变化或不完整均清旧视频。
      const wasContinuouslyActive = wasContinuouslyActiveFeishuListing(existing)
      const allowRetainedVideo = wasContinuouslyActive && hasSamePhysicalRoomIdentity(existing, row)
      const reactivated = !wasContinuouslyActive
      const wasExplicitlyDown = existing.lifecycleStatus === 'expired' || existing.status === '已下架'
      if (wasExplicitlyDown) {
        existing.lifecycleStatus = 'active'
        existing.status = '在租'
      }
      domain.updateNormalListing(db, adminId, existing.id, payload, { admin: true, allowMissingLandlordPhone: true })
      // 曾下架后重新出现的房源可能已换租客/装修/拍摄内容；没有本轮素材时不能复活旧视频。
      // 只有持续在架的同一房源遇到瞬时漏素材/转存失败，才允许沿用上次受控视频。
      attachFeishuFields(existing, row, material, video, materialFailureReason, {
        allowRetainedVideo,
        materialPolicy: options.materialPolicy
      })
      existing.feishuLastSyncAction = 'updated'
      return { action: 'updated', listing: existing, reactivated }
    } catch (error) {
      // 领域校验或后续字段挂载失败时，必须恢复同一个对象实例。否则调用方虽然收到失败，
      // 列表数组里却会残留“已复活但未更新完整”的半成品，并被重新公开。
      restoreClonedObject(existing, snapshot)
      throw error
    }
  }
  const detail = domain.addNormalListing(db, adminId, payload, { admin: true, skipPointLog: true, allowMissingLandlordPhone: true })
  const listing = db.listings.find((item) => item.id === detail.id)
  attachFeishuFields(listing, row, material, video, materialFailureReason, {
    allowRetainedVideo: false,
    materialPolicy: options.materialPolicy
  })
  if (listing) listing.feishuLastSyncAction = 'created'
  if (listing && row.externalId) byExternalId.set(String(row.externalId), listing)
  if (listing && row.roomIdentityKey) byExternalId.set(String(row.roomIdentityKey), listing)
  return { action: 'created', listing, reactivated: false }
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
  const materialDisabled = mirrorMaterialValuesExcluded(options.materialPolicy)
  const effectiveMaterials = materialDisabled ? [] : materials
  const matcher = materialDisabled ? () => null : createMaterialMatcher(effectiveMaterials)
  const byExternalId = existingByExternalId(db)
  const seen = new Set()
  const reactivatedNoteSourceIds = new Set()
  const result = {
    dryRun: Boolean(options.dryRun),
    startedAt: nowText(),
    finishedAt: '',
    sourceRecordCount: rows.length,
    materialCount: effectiveMaterials.length,
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
    if (!materialDisabled && !material) {
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
      const upsert = upsertFeishuListing(db, actorId, existing, byExternalId, row, material, video, '', {
        materialPolicy: options.materialPolicy
      })
      if (upsert.action === 'updated') {
        result.updated += 1
      } else {
        result.created += 1
      }
      if (upsert.reactivated === true) reactivatedNoteSourceIds.add(String(row.externalId))
      result.auditRows.push(buildAuditRow(
        row,
        material,
        materialDisabled
          ? '上架-仅同步房源信息'
          : material
          ? '上架-已配视频'
          : (isRetainingManagedVideo(upsert.listing) ? '上架-沿用上次视频·素材待核' : '上架-缺视频素材'),
        combineFailureReasons(
          materialDisabled || material ? '' : (materialAmbiguous ? '素材匹配歧义' : '未匹配素材'),
          missingContactReason
        )
      ))
    } catch (error) {
      if (material) {
        const failureReason = shortError(error)
        const video = { videoKey: '', videoUrl: '', materialUrl: material.url || material.videoUrl || material.sourcePath || material.name || '' }
        // 降级重试也可能因校验/判重（400/409）再次失败——必须自行兜住，
        // 否则异常穿出 applySync：整轮同步中断、后续行不处理、自动下架与同步日志全部丢失
        try {
          const upsert = upsertFeishuListing(db, actorId, existing, byExternalId, row, material, video, failureReason, {
            materialPolicy: options.materialPolicy
          })
          if (upsert.action === 'updated') {
            result.updated += 1
          } else {
            result.created += 1
          }
          if (upsert.reactivated === true) reactivatedNoteSourceIds.add(String(row.externalId))
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
  Object.defineProperty(result, REACTIVATED_NOTE_SOURCE_IDS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: reactivatedNoteSourceIds
  })
  return result
}

function bindingTypes(binding) {
  if (!binding || !Object.prototype.hasOwnProperty.call(binding, 'type')) return []
  const values = Array.isArray(binding.type) ? binding.type : [binding.type]
  return values.map((value) => String(value).trim()).filter(Boolean)
}

function bindingContractStatus(role, bindings, options = {}) {
  const contracts = MIRROR_FIELD_TYPE_CONTRACTS[role] || {}
  const source = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {}
  const sourceCompatibilityProfile = normalizeText(options.sourceCompatibilityProfile)
  const employeeCompatibilityEnabled =
    sourceCompatibilityProfile === EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE ||
    sourceCompatibilityProfile === EMPLOYEE_AI_FOUNDATION_PROFILE
  const aiFoundationEnabled = sourceCompatibilityProfile === EMPLOYEE_AI_FOUNDATION_PROFILE
  const compatibilityEnabled = role === 'source' && employeeCompatibilityEnabled
  const requiredValues = new Set(MIRROR_REQUIRED_BINDINGS[role] || [])
  const requiredSchema = new Set([
    ...(MIRROR_REQUIRED_BINDINGS[role] || []),
    ...(MIRROR_REQUIRED_OPTIONAL_VALUE_BINDINGS[role] || [])
  ])
  if (compatibilityEnabled) {
    requiredSchema.delete('rentMode')
    requiredSchema.delete('listingStatus')
  }
  if (role === 'mini' && aiFoundationEnabled) {
    FOUNDATION_MINI_FIELDS.forEach((semantic) => requiredSchema.add(semantic))
  }
  if (role === 'mini' && employeeCompatibilityEnabled) {
    requiredSchema.add('viewingPassword')
  }
  const issues = []
  if (role === 'source' && sourceCompatibilityProfile && !employeeCompatibilityEnabled) {
    issues.push(`compatibilityProfile:${sourceCompatibilityProfile}:unsupported`)
  }

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

function resolvedContractBindings(role, bindings, options = {}) {
  const state = bindingContractStatus(role, bindings, options)
  if (!state.ready) throw new Error(`飞书 ${role} 字段契约无效：${state.issues.join('、')}`)
  const contracts = MIRROR_FIELD_TYPE_CONTRACTS[role]
  const requiredValues = new Set(MIRROR_REQUIRED_BINDINGS[role] || [])
  const compatibilityEnabled = role === 'source' &&
    [
      EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
      EMPLOYEE_AI_FOUNDATION_PROFILE
    ].includes(normalizeText(options.sourceCompatibilityProfile))
  return Object.keys(bindings || {}).sort().reduce((result, semantic) => {
    const configured = bindings[semantic]
    const allowedTypes = contracts[semantic]
    result[semantic] = {
      fieldId: String(configured.fieldId || configured.field_id).trim(),
      type: allowedTypes.length === 1 ? allowedTypes[0] : allowedTypes.slice(),
      // 员工现表兼容模式需要先读取全空模板行，再由规范化层精确忽略；
      // 非空/半填记录仍由 canonical 层整批阻断，显式房态/出租方式也绝不回退。
      required: compatibilityEnabled ? false : requiredValues.has(semantic),
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
  const hasApplicationCredentials = Boolean(config.feishu.appId && config.feishu.appSecret)
  const sourceBaseToken = normalizeResourceIdentifier(config.feishu.sourceBitableAppToken)
  const targetBaseToken = normalizeResourceIdentifier(config.feishu.targetBitableAppToken)
  const sourceTableId = normalizeResourceIdentifier(config.feishu.sourceTableId)
  const miniTableId = normalizeResourceIdentifier(config.feishu.miniTableId)
  const locationTableId = normalizeResourceIdentifier(config.feishu.locationTableId)
  const rentedTableId = normalizeResourceIdentifier(config.feishu.rentedTableId)
  const historyTableId = normalizeResourceIdentifier(config.feishu.historyTableId)
  const sourceBaseReady = Boolean(sourceBaseToken)
  const targetBaseReady = Boolean(targetBaseToken)
  const crossBaseTokensReady = sourceBaseReady && targetBaseReady && config.feishu.crossBaseTokenPartial !== true
  const employeeCompatibilityEnabled =
    config.feishu.sourceCompatibilityProfile === EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE ||
    config.feishu.sourceCompatibilityProfile === EMPLOYEE_AI_FOUNDATION_PROFILE
  const aiFoundationEnabled =
    config.feishu.sourceCompatibilityProfile === EMPLOYEE_AI_FOUNDATION_PROFILE
  const sourceBaseReadOnlyBoundaryReady = !employeeCompatibilityEnabled ||
    sourceBaseToken !== targetBaseToken
  const hasAuth = hasApplicationCredentials && crossBaseTokensReady
  const sourceTableReady = Boolean(sourceTableId)
  const miniTableReady = Boolean(miniTableId)
  const locationTableReady = Boolean(locationTableId)
  const rentedTableReady = !aiFoundationEnabled || Boolean(rentedTableId)
  const historyTableReady = !aiFoundationEnabled || Boolean(historyTableId)
  const configuredResources = [
    [sourceBaseToken, sourceTableId],
    [targetBaseToken, miniTableId],
    [targetBaseToken, locationTableId],
    [targetBaseToken, rentedTableId],
    [targetBaseToken, historyTableId]
  ].filter(([appToken, tableId]) => appToken && tableId)
  const resourceKeys = configuredResources.map(([appToken, tableId]) => `${appToken}\u0000${tableId}`)
  const tableResourcesDistinct = new Set(resourceKeys).size === resourceKeys.length
  // 保留旧状态字段名称，判定已升级为“Base token + table ID”的真实资源唯一性。
  const tableIdsDistinct = tableResourcesDistinct
  const sourceContract = bindingContractStatus('source', config.feishu.sourceFieldBindings, {
    sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
  })
  const miniContract = bindingContractStatus('mini', config.feishu.miniFieldBindings, {
    sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
  })
  const locationContract = bindingContractStatus('location', config.feishu.locationFieldBindings)
  const rentedContract = aiFoundationEnabled
    ? bindingContractStatus('rented', config.feishu.rentedFieldBindings, {
      sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
    })
    : { ready: true, issues: [] }
  const historyContract = aiFoundationEnabled
    ? bindingContractStatus('history', config.feishu.historyFieldBindings, {
      sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
    })
    : { ready: true, issues: [] }
  const sourceBindingsReady = sourceContract.ready
  const miniBindingsReady = miniContract.ready
  const locationBindingsReady = locationContract.ready
  const rentedBindingsReady = rentedContract.ready
  const historyBindingsReady = historyContract.ready
  const pairedBindingsReady = pairedMirrorBindingsReady(config.feishu.sourceFieldBindings, config.feishu.miniFieldBindings)
  const noteMaterialModeRequested = config.feishu.noteMaterialSyncEnabled === true
  const noteMaterialsReady = noteMaterialModeRequested && effectiveNoteMaterialSyncEnabled() &&
    formalNoteMaterialConfigurationReady()
  // 启用新房源笔记管线后，只认正式 field_id、域名、独立目标目录和 OSS 契约；遗留
  // 目录不得把错误 profile 或缺失新配置伪装成 ready。未启用时就是纯房源信息模式，
  // 不得再要求或读取任何 legacy 素材目录、清单或视频字段。
  const materialsReady = noteMaterialModeRequested ? noteMaterialsReady : true
  return {
    ready: hasAuth && sourceBaseReadOnlyBoundaryReady &&
      sourceTableReady && miniTableReady && locationTableReady && tableResourcesDistinct &&
      rentedTableReady && historyTableReady &&
      sourceBindingsReady && miniBindingsReady && locationBindingsReady &&
      rentedBindingsReady && historyBindingsReady && pairedBindingsReady && materialsReady,
    hasAuth,
    hasApplicationCredentials,
    sourceBaseReady,
    targetBaseReady,
    crossBaseTokensReady,
    sourceBaseReadOnlyBoundaryReady,
    sourceTableReady,
    miniTableReady,
    locationTableReady,
    rentedTableReady,
    historyTableReady,
    tableIdsDistinct,
    tableResourcesDistinct,
    sourceBindingsReady,
    miniBindingsReady,
    locationBindingsReady,
    rentedBindingsReady,
    historyBindingsReady,
    aiFoundationEnabled,
    pairedBindingsReady,
    materialsReady,
    noteMaterialsReady
  }
}

function assertMirrorConfiguration() {
  const state = mirrorConfigurationStatus()
  if (state.ready) return state
  const missing = []
  if (!state.hasApplicationCredentials) missing.push('飞书应用凭据')
  if (!state.sourceBaseReady) missing.push('员工源 Base app token')
  if (!state.targetBaseReady) missing.push('小程序目标 Base app token')
  if (!state.crossBaseTokensReady && state.sourceBaseReady && state.targetBaseReady) {
    missing.push('源 Base 与目标 Base token 必须成对配置')
  }
  if (!state.sourceBaseReadOnlyBoundaryReady) missing.push('员工现表兼容模式要求源 Base 与目标 Base 分离')
  if (!state.sourceTableReady) missing.push('员工源表 ID')
  if (!state.miniTableReady) missing.push('小程序专用源表 ID')
  if (!state.locationTableReady) missing.push('小程序位置字典 ID')
  if (!state.rentedTableReady) missing.push('已出租房源表 ID')
  if (!state.historyTableReady) missing.push('房源状态流水表 ID')
  if (!state.tableResourcesDistinct) missing.push('员工源表、专用源表、位置字典、已出租表和流水表不得指向同一 Base 表资源')
  if (!state.sourceBindingsReady) missing.push('员工源表 field_id 绑定')
  if (!state.miniBindingsReady) missing.push('专用源表 field_id 绑定')
  if (!state.locationBindingsReady) missing.push('位置字典 field_id 绑定')
  if (!state.rentedBindingsReady) missing.push('已出租房源表 field_id 绑定')
  if (!state.historyBindingsReady) missing.push('房源状态流水表 field_id 绑定')
  if (!state.pairedBindingsReady) missing.push('员工源表与专用源表字段配对')
  if (!state.materialsReady) missing.push('附件字段或素材目录')
  const error = new Error(`飞书镜像同步配置不完整：${missing.join('、')}`)
  error.statusCode = 503
  throw error
}

function assertFoundationEnrichmentConfiguration() {
  const state = mirrorConfigurationStatus()
  const sourceBaseToken = normalizeResourceIdentifier(config.feishu.sourceBitableAppToken)
  const targetBaseToken = normalizeResourceIdentifier(config.feishu.targetBitableAppToken)
  const sourceTableId = normalizeResourceIdentifier(config.feishu.sourceTableId)
  const miniTableId = normalizeResourceIdentifier(config.feishu.miniTableId)
  const historyTableId = normalizeResourceIdentifier(config.feishu.historyTableId)
  const resources = [
    `${sourceBaseToken}\u0000${sourceTableId}`,
    `${targetBaseToken}\u0000${miniTableId}`,
    `${targetBaseToken}\u0000${historyTableId}`
  ]
  const resourcesReady = resources.every((value) => !value.startsWith('\u0000') && !value.endsWith('\u0000'))
  const resourcesDistinct = resourcesReady && new Set(resources).size === resources.length
  const ready = state.aiFoundationEnabled &&
    state.hasApplicationCredentials &&
    state.crossBaseTokensReady &&
    state.sourceBaseReadOnlyBoundaryReady &&
    state.sourceTableReady &&
    state.miniTableReady &&
    state.historyTableReady &&
    state.miniBindingsReady &&
    state.historyBindingsReady &&
    resourcesDistinct
  if (ready) return {
    sourceBaseToken,
    targetBaseToken,
    sourceTableId,
    miniTableId,
    historyTableId
  }
  const reasons = []
  if (!state.aiFoundationEnabled) reasons.push('仅允许 AI 数据底座配置')
  if (!state.hasApplicationCredentials) reasons.push('飞书应用凭据不完整')
  if (!state.crossBaseTokensReady) reasons.push('源 Base 与目标 Base token 必须成对配置')
  if (!state.sourceBaseReadOnlyBoundaryReady) reasons.push('员工源 Base 与目标 Base 必须分离以保持只读边界')
  if (!state.sourceTableReady) reasons.push('员工源表资源缺失')
  if (!state.miniTableReady) reasons.push('目标当前主档资源缺失')
  if (!state.historyTableReady) reasons.push('目标状态流水资源缺失')
  if (!state.miniBindingsReady) reasons.push('目标当前主档字段契约无效')
  if (!state.historyBindingsReady) reasons.push('目标状态流水字段契约无效')
  if (!resourcesDistinct) reasons.push('员工源、当前主档与状态流水资源必须独立')
  const error = new Error(`飞书身份责任补全资源边界不安全：${reasons.join('、')}`)
  error.statusCode = 503
  throw error
}

function semanticFieldsForWrite(fieldNames, fields) {
  const names = fieldNames && typeof fieldNames === 'object' ? fieldNames : {}
  const source = fields && typeof fields === 'object' ? fields : {}
  const output = {}
  Object.keys(names).sort().forEach((semantic) => {
    if (Object.prototype.hasOwnProperty.call(source, semantic)) {
      if (source[semantic] === undefined || source[semantic] === null) {
        const error = new Error(`飞书写入字段 ${semantic} 缺少类型正确的空值`)
        error.code = 'FEISHU_WRITE_FIELD_VALUE_INVALID'
        error.statusCode = 400
        error.safeBeforeWrite = true
        throw error
      }
      output[names[semantic]] = clone(source[semantic])
    }
  })
  return output
}

function semanticFieldsForCreate(fieldNames, fields) {
  const source = fields && typeof fields === 'object' ? fields : {}
  const compact = {}
  Object.keys(source).forEach((semantic) => {
    const value = source[semantic]
    if (value === undefined || value === null) return
    if (typeof value === 'string' && !value.trim()) return
    if (Array.isArray(value) && value.length === 0) return
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === 0
    ) return
    compact[semantic] = value
  })
  return semanticFieldsForWrite(fieldNames, compact)
}

function semanticUpdateRecordForWrite(snapshot, fieldNames, operation) {
  const recordId = normalizeText(operation && operation.recordId)
  const current = (snapshot.records || []).find((record) => (
    normalizeText(record && record.recordId) === recordId
  ))
  if (!recordId || !current || !current.fields || typeof current.fields !== 'object') {
    const error = new Error('飞书更新计划无法命中当前快照记录')
    error.code = 'FEISHU_UPDATE_SNAPSHOT_MISMATCH'
    error.statusCode = 409
    error.safeBeforeWrite = true
    throw error
  }
  const desired = operation && operation.fields && typeof operation.fields === 'object'
    ? operation.fields
    : {}
  const changed = {}
  Object.keys(fieldNames || {}).sort().forEach((semantic) => {
    if (!Object.prototype.hasOwnProperty.call(desired, semantic)) return
    const before = JSON.stringify(stablePlanValue(current.fields[semantic]))
    const after = JSON.stringify(stablePlanValue(desired[semantic]))
    if (before !== after) changed[semantic] = clone(desired[semantic])
  })
  const fields = semanticFieldsForWrite(fieldNames, changed)
  if (Object.keys(fields).length === 0) {
    const error = new Error('飞书更新计划没有可写的真实字段差异')
    error.code = 'FEISHU_UPDATE_PLAN_EMPTY'
    error.statusCode = 409
    error.safeBeforeWrite = true
    throw error
  }
  return { record_id: recordId, fields }
}

function legacyMirrorFieldNames(fieldNames, sourceBindings) {
  const source = fieldNames && typeof fieldNames === 'object' ? fieldNames : {}
  const hasExplicitVacancyNote = Boolean(
    sourceBindings &&
    typeof sourceBindings === 'object' &&
    Object.prototype.hasOwnProperty.call(sourceBindings, 'vacancyNote')
  )
  return Object.keys(source).sort().reduce((result, semantic) => {
    const protectedVacancyNote = semantic === 'vacancyNote' && !hasExplicitVacancyNote
    if (!LEGACY_PROTECTED_FOUNDATION_FIELD_SET.has(semantic) && !protectedVacancyNote) {
      result[semantic] = source[semantic]
    }
    return result
  }, {})
}

function chunksOf(items, size = MIRROR_WRITE_BATCH_SIZE) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function stableUuidV4(value) {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16)
  // 飞书要求 client_token 为 UUIDv4 形状。这里固定 version/variant 位，
  // 其余位由业务幂等键派生，使跨进程重试仍使用同一个 token。
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function semanticCreateOperationKey(operation = {}) {
  const candidates = [
    operation.archiveKey,
    operation.historyEventId,
    operation.foundationListingId,
    operation.sourceRecordId,
    operation.fields && operation.fields.archiveKey,
    operation.fields && operation.fields.historyEventId,
    operation.fields && operation.fields.foundationListingId
  ]
  const key = candidates.map(normalizeText).find(Boolean)
  if (!key) throw new Error('飞书新增记录缺少稳定业务幂等键')
  return key
}

function stableCreateClientToken(tableId, operation) {
  const normalizedTableId = normalizeResourceIdentifier(tableId)
  if (!normalizedTableId) throw new Error('飞书新增记录缺少目标表 ID')
  return stableUuidV4(`ynzy-feishu-create-v1\u0000${normalizedTableId}\u0000${semanticCreateOperationKey(operation)}`)
}

function stableUpdateClientToken(tableId, records, scope) {
  const normalizedTableId = normalizeResourceIdentifier(tableId)
  const normalizedScope = scope && typeof scope === 'object' && !Array.isArray(scope)
    ? scope
    : null
  const scopeKeys = normalizedScope ? Object.keys(normalizedScope).sort() : []
  const phase = normalizeText(normalizedScope && normalizedScope.phase)
  const runId = normalizeText(normalizedScope && normalizedScope.runId)
  const runNowMs = normalizedScope && normalizedScope.runNowMs
  if (!normalizedTableId || !Array.isArray(records) || records.length === 0) {
    throw new Error('飞书更新批次缺少目标表 ID 或记录')
  }
  if (JSON.stringify(scopeKeys) !== JSON.stringify(['phase', 'runId', 'runNowMs']) ||
      !/^[a-z][a-z0-9-]{2,63}$/.test(phase) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(runId) ||
      !Number.isSafeInteger(runNowMs) || runNowMs <= 0) {
    throw new Error('飞书更新批次缺少完整持久 run 作用域（phase/runId/runNowMs）')
  }
  const seenRecordIds = new Set()
  const normalizedRecords = records.map((record) => {
    const recordId = normalizeText(record && (record.record_id || record.recordId))
    const fields = record && record.fields && typeof record.fields === 'object' &&
      !Array.isArray(record.fields)
      ? record.fields
      : null
    if (!recordId || !fields || seenRecordIds.has(recordId)) {
      throw new Error('飞书更新批次存在无效或重复 record_id')
    }
    seenRecordIds.add(recordId)
    return { recordId, fields: stablePlanValue(fields) }
  }).sort((left, right) => left.recordId.localeCompare(right.recordId))
  return stableUuidV4(
    `ynzy-feishu-update-v2\u0000${phase}\u0000${runId}\u0000${runNowMs}\u0000` +
      `${normalizedTableId}\u0000${JSON.stringify(normalizedRecords)}`
  )
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

function foundationRecordIdentity(record) {
  const fields = record && record.fields || {}
  return normalizeText(fields.foundationListingId) ||
    yuxiaoerIdentityKey({
      rentMode: fields.rentMode,
      yuxiaoerListingId: fields.yuxiaoerListingId,
      yuxiaoerRoomId: fields.yuxiaoerRoomId
    }) ||
    normalizeText(fields.temporaryListingId) ||
    foundationPhysicalUnitKey(fields)
}

function foundationIdentityIndexKey(value) {
  return normalizeText(value).toLocaleLowerCase('zh-CN')
}

function publishedFoundationIdentities(records, label) {
  const identities = (records || []).filter((record) => (
    record && record.fields && record.fields.enabled === true && record.fields.published === true
  )).map((record) => foundationIdentityIndexKey(foundationRecordIdentity(record)))
  const unique = new Set(identities)
  if (unique.size !== identities.length) {
    throw new Error(`AI 数据底座${label}存在重复实体身份`)
  }
  return unique
}

function assertMirrorDeactivateSafety(mirrorSnapshot, plannedRecords, options = {}) {
  const foundationIdentityMode = options.foundationIdentityMode === true
  if (foundationIdentityMode) {
    // foundationListingId（或旧表的受控身份回退）与线上库存物理键不是同一身份域，
    // 不能合并成一个 Set。目标主档按实体身份比较前后；线上库存仅作为独立数量下限，
    // 既能容忍源表复制和区域/板块调整，又能在目标主档意外缺行时阻断真实缩量。
    const publishedBefore = publishedFoundationIdentities(mirrorSnapshot.records, '当前主档')
    const publishedAfter = publishedFoundationIdentities(plannedRecords, '计划主档')
    const targetWithdrawCount = Array.from(publishedBefore)
      .filter((identityKey) => !publishedAfter.has(identityKey))
      .length
    const baselineCount = new Set(
      (Array.isArray(options.baselinePublishedFoundationIdentityKeys)
        ? options.baselinePublishedFoundationIdentityKeys
        : [])
        .map(foundationIdentityIndexKey)
        .filter(Boolean)
    ).size
    const activeBefore = Math.max(publishedBefore.size, baselineCount)
    const baselineCoverageWithdrawCount = Math.max(0, baselineCount - publishedBefore.size)
    const countFloorWithdrawCount = Math.max(0, activeBefore - publishedAfter.size)
    const withdrawCount = Math.max(
      targetWithdrawCount,
      baselineCoverageWithdrawCount,
      countFloorWithdrawCount
    )
    if (withdrawCount === 0 || options.allowMassDeactivate === true) return
    return assertMirrorDeactivateThreshold(withdrawCount, activeBefore, options)
  }

  const recordIdentity = (record) => {
    const fields = record && record.fields || {}
    return normalizeText(fields.sourceRecordId)
  }
  const publishedBefore = new Set((mirrorSnapshot.records || []).filter((record) => (
    record && record.fields && record.fields.enabled === true && record.fields.published === true
  )).map(recordIdentity).filter(Boolean))
  const baselineIdentities = options.baselinePublishedSourceIds
  ;(Array.isArray(baselineIdentities) ? baselineIdentities : [])
    .map(normalizeText)
    .filter(Boolean)
    .forEach((identityKey) => publishedBefore.add(identityKey))
  const publishedAfter = new Set((plannedRecords || []).filter((record) => (
    record && record.fields && record.fields.enabled === true && record.fields.published === true
  )).map(recordIdentity).filter(Boolean))
  const withdrawCount = Array.from(publishedBefore).filter((identityKey) => !publishedAfter.has(identityKey)).length
  if (withdrawCount === 0 || options.allowMassDeactivate === true) return
  return assertMirrorDeactivateThreshold(withdrawCount, publishedBefore.size, options)
}

function assertMirrorDeactivateThreshold(withdrawCount, activeBefore, options = {}) {
  const maxCount = options.maxDeactivateCount == null ? 10 : Number(options.maxDeactivateCount)
  const maxRatio = options.maxDeactivateRatio == null ? 0.35 : Number(options.maxDeactivateRatio)
  if (!Number.isInteger(maxCount) || maxCount < 1 || !Number.isFinite(maxRatio) || maxRatio <= 0 || maxRatio > 1) {
    throw new Error('飞书镜像批量停用熔断配置无效')
  }
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

function activeFeishuFoundationIdentityKeys(db = {}) {
  return Array.from(new Set((db.listings || []).filter((listing) => (
    listing && listing.externalSource === 'feishu' &&
    listing.lifecycleStatus !== 'expired' && listing.status !== '已下架'
  )).map((listing) => foundationPhysicalUnitKey({
    city: listing.city,
    district: listing.district || listing.area,
    block: listing.block,
    community: listing.community,
    building: listing.building,
    unit: listing.unit,
    roomNumber: listing.roomNumber,
    rentMode: listing.rentMode
  })))).sort()
}

function activeMirrorRecords(snapshot) {
  return (snapshot.records || []).filter((record) => record && record.fields && record.fields.enabled === true)
}

function aiFoundationProfileEnabled(profile) {
  return normalizeText(profile) === EMPLOYEE_AI_FOUNDATION_PROFILE
}

function assertLifecycleTableResourcesDistinct(options = {}) {
  if (!aiFoundationProfileEnabled(options.sourceCompatibilityProfile)) return
  const resources = [
    ['位置字典', options.locationTableId],
    ['当前状态表', options.miniTableId],
    ['已出租表', options.rentedTableId],
    ['状态流水表', options.historyTableId]
  ].map(([label, tableId]) => [label, normalizeResourceIdentifier(tableId)])
  const missing = resources.filter(([, tableId]) => !tableId).map(([label]) => label)
  if (missing.length) throw new Error(`AI 数据底座缺少${missing.join('、')}资源`)
  const occupied = new Map()
  resources.forEach(([label, tableId]) => {
    if (occupied.has(tableId)) {
      throw new Error(`AI 数据底座表资源必须独立：${occupied.get(tableId)}与${label}不得指向同一表`)
    }
    occupied.set(tableId, label)
  })
}

function foundationPhysicalUnitKey(fields = {}) {
  const parts = [
    fields.city,
    fields.community,
    fields.building,
    fields.unit,
    fields.roomNumber,
    fields.rentMode
  ].map((value) => normalizeText(value).toLocaleLowerCase('zh-CN'))
  if (!parts[1] || !parts[2] || !parts[4] || !/^(?:整租|合租)$/.test(normalizeText(fields.rentMode))) {
    throw new Error('AI 数据底座无法生成唯一物理房源键')
  }
  return `UNIT-${crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24).toUpperCase()}`
}

function deterministicTemporaryListingId({ physicalUnitKey, sourceRecordId } = {}) {
  const physical = normalizeText(physicalUnitKey)
  const source = normalizeText(sourceRecordId)
  if (!physical && !source) throw new Error('临时房源 ID 缺少稳定输入')
  return `TMP-${crypto.createHash('sha256').update(`${physical}\u0000${source}`).digest('hex').slice(0, 24).toUpperCase()}`
}

function normalizedFoundationCurrentSnapshot(snapshot, nowMs) {
  const records = (snapshot.records || []).map((record) => {
    const fields = clone(record && record.fields && typeof record.fields === 'object' ? record.fields : {})
    // 物理键是可升级的派生值，不信任旧表中可能仍包含行政区/板块的历史哈希。
    // 每次按当前规范字段重算，foundationListingId 和身份别名继续承载持久实体身份。
    const physicalUnitKey = foundationPhysicalUnitKey(fields)
    const realIdentity = yuxiaoerIdentityKey({
      rentMode: fields.rentMode,
      yuxiaoerListingId: fields.yuxiaoerListingId,
      yuxiaoerRoomId: fields.yuxiaoerRoomId
    })
    const generatedTemporaryId = deterministicTemporaryListingId({
      physicalUnitKey,
      sourceRecordId: fields.sourceRecordId
    })
    const foundationListingId = normalizeText(fields.foundationListingId) ||
      realIdentity ||
      normalizeText(fields.temporaryListingId) ||
      generatedTemporaryId
    const temporaryListingId = normalizeText(fields.temporaryListingId) ||
      (/^TMP-/i.test(foundationListingId) || !realIdentity ? foundationListingId : '')
    const active = fields.enabled === true
    const lifecycleStatusText = normalizeText(fields.lifecycleStatusText) ||
      (active
        ? (normalizeText(fields.listingStatus) === '即将空出' ? '即将空出' : '待出租')
        : '')
    const sourceCreatedAt = Number(fields.sourceCreatedAt)
    const hasSourceCreatedAt = Number.isSafeInteger(sourceCreatedAt) && sourceCreatedAt > 0 &&
      sourceCreatedAt <= nowMs
    const availabilityCycleNo = Number.isInteger(Number(fields.availabilityCycleNo)) &&
      Number(fields.availabilityCycleNo) > 0
      ? Number(fields.availabilityCycleNo)
      : 1
    const normalizedFields = {
      ...fields,
      foundationListingId,
      temporaryListingId,
      identityType: realIdentity ? 'yuxiaoer' : 'temporary',
      physicalUnitKey,
      lifecycleStatusText,
      vacancyNote: normalizeText(fields.vacancyNote),
      availabilityCycleNo,
      availabilityCycleId: normalizeText(fields.availabilityCycleId) ||
        `${foundationListingId}:available:${availabilityCycleNo}`,
      metricKind: normalizeText(fields.metricKind) ||
        (lifecycleStatusText === '即将空出' ? '提前挂出天数' : '待租天数'),
      listingOwner: normalizeText(fields.listingOwner),
      ownerDepartment: normalizeText(fields.ownerDepartment),
      sourcePresent: typeof fields.sourcePresent === 'boolean' ? fields.sourcePresent : active,
      identityAliases: normalizeText(fields.identityAliases),
      lifecycleVersion: Number.isInteger(Number(fields.lifecycleVersion)) &&
        Number(fields.lifecycleVersion) >= 0
        ? Number(fields.lifecycleVersion)
        : 0
    }
    if (hasSourceCreatedAt) normalizedFields.sourceCreatedAt = sourceCreatedAt
    else delete normalizedFields.sourceCreatedAt
    if (!Number.isFinite(Number(normalizedFields.lifecycleDays)) && hasSourceCreatedAt) {
      normalizedFields.lifecycleDays = Math.floor((nowMs - sourceCreatedAt) / (24 * 60 * 60 * 1000))
    }
    return {
      ...clone(record),
      fields: normalizedFields
    }
  })
  return {
    ...clone(snapshot),
    complete: true,
    records,
    recordCount: records.length
  }
}

function synthesizedAliasSnapshot(currentStateSnapshot) {
  const records = []
  const seen = new Map()
  function add(aliasType, aliasValue, foundationListingId) {
    const value = normalizeText(aliasValue)
    const foundationId = normalizeText(foundationListingId)
    if (!value || !foundationId) return
    const aliasKey = `${aliasType}:${value.toLocaleLowerCase('zh-CN')}`
    const occupied = seen.get(aliasKey)
    if (occupied && occupied !== foundationId) {
      throw new Error(`AI 数据底座身份别名冲突：${aliasType}/${value}`)
    }
    if (occupied) return
    seen.set(aliasKey, foundationId)
    records.push({
      recordId: `alias-${records.length + 1}`,
      fields: { aliasType, aliasValue: value, foundationListingId: foundationId }
    })
  }
  ;(currentStateSnapshot.records || []).forEach((record) => {
    const fields = record.fields || {}
    const foundationListingId = fields.foundationListingId
    const serializedAliases = normalizeText(fields.identityAliases)
    if (serializedAliases) {
      let parsed
      try {
        parsed = JSON.parse(serializedAliases)
      } catch (_) {
        throw new Error(`AI 数据底座身份别名不是合法 JSON：${foundationListingId || '未知房源'}`)
      }
      if (!Array.isArray(parsed) || parsed.some((item) => (
        !item || typeof item !== 'object' || Array.isArray(item) ||
        !normalizeText(item.aliasType) || !normalizeText(item.aliasValue)
      ))) {
        throw new Error(`AI 数据底座身份别名结构无效：${foundationListingId || '未知房源'}`)
      }
      parsed.forEach((item) => add(
        normalizeText(item.aliasType),
        normalizeText(item.aliasValue),
        foundationListingId
      ))
    }
    add('sourceRecord', fields.sourceRecordId, foundationListingId)
    add('temporary', fields.temporaryListingId, foundationListingId)
    add('yuxiaoer', yuxiaoerIdentityKey({
      rentMode: fields.rentMode,
      yuxiaoerListingId: fields.yuxiaoerListingId,
      yuxiaoerRoomId: fields.yuxiaoerRoomId
    }), foundationListingId)
  })
  return { complete: true, records, recordCount: records.length }
}

function rentedSnapshotForLifecycle(snapshot) {
  const records = (snapshot.records || []).map((record) => ({
    ...clone(record),
    fields: {
      ...clone(record.fields || {}),
      rentalEventId: normalizeText(record.fields && (
        record.fields.archiveKey || record.fields.rentalEventId
      ))
    }
  }))
  return { ...clone(snapshot), complete: true, records, recordCount: records.length }
}

function foundationBaselineCompleted(historySnapshot) {
  const matches = (historySnapshot.records || []).filter((record) => (
    normalizeText(record.fields && record.fields.historyEventId) === FOUNDATION_BASELINE_EVENT_ID
  ))
  if (matches.length > 1) throw new Error('AI 数据底座初始化基线标记重复')
  if (matches.length === 0) return false
  const fields = matches[0].fields || {}
  const valid = normalizeText(fields.foundationListingId) === FOUNDATION_BASELINE_ENTITY_ID &&
    Number(fields.availabilityCycleNo) === 1 &&
    normalizeText(fields.availabilityCycleId) === 'FOUNDATION-BASELINE-V1' &&
    normalizeText(fields.eventType) === '初始化基线' &&
    normalizeText(fields.toLifecycleStatusText) === '基线完成' &&
    Number.isSafeInteger(Number(fields.eventAt)) &&
    Number(fields.eventAt) >= 1_000_000_000_000 &&
    Boolean(normalizeText(fields.runId)) &&
    Number(fields.lifecycleVersion) === 0
  if (!valid) throw new Error('AI 数据底座初始化基线标记内容无效')
  return true
}

function foundationBaselineMarkerOperation(runId, nowMs) {
  return {
    type: 'create',
    historyEventId: FOUNDATION_BASELINE_EVENT_ID,
    foundationListingId: FOUNDATION_BASELINE_ENTITY_ID,
    fields: {
      historyEventId: FOUNDATION_BASELINE_EVENT_ID,
      foundationListingId: FOUNDATION_BASELINE_ENTITY_ID,
      sourceRecordId: '',
      availabilityCycleNo: 1,
      availabilityCycleId: 'FOUNDATION-BASELINE-V1',
      eventType: '初始化基线',
      fromLifecycleStatusText: '',
      toLifecycleStatusText: '基线完成',
      eventAt: nowMs,
      runId: normalizeText(runId),
      listingOwner: '',
      ownerDepartment: '',
      lifecycleVersion: 0
    }
  }
}

function canonicalLifecycleSourceSnapshot(sourceSnapshot, plannedCanonicalRecords) {
  const sourceById = new Map((sourceSnapshot.records || []).map((record) => [
    normalizeText(record.recordId),
    record
  ]))
  const records = (plannedCanonicalRecords || []).map((record) => {
    const fields = clone(record.fields || {})
    const sourceRecordId = normalizeText(fields.sourceRecordId)
    const sourceRecord = sourceById.get(sourceRecordId)
    if (!sourceRecord) throw new Error(`AI 数据底座缺少源记录创建时间：${sourceRecordId}`)
    fields.physicalUnitKey = foundationPhysicalUnitKey(fields)
    return {
      recordId: sourceRecordId,
      createdTimeMs: sourceRecord.createdTimeMs,
      fields
    }
  })
  return { complete: true, records, recordCount: records.length }
}

function equalManagedMirrorFields(left, right) {
  return JSON.stringify(managedFieldsOf(left || {}, { includeFoundation: true })) ===
    JSON.stringify(managedFieldsOf(right || {}, { includeFoundation: true }))
}

function foundationArchiveFields(operation, currentFields, nowMs) {
  const current = currentFields && typeof currentFields === 'object' ? currentFields : {}
  const eventFields = operation && operation.fields && typeof operation.fields === 'object'
    ? operation.fields
    : {}
  function eventFieldOrCurrent(semantic) {
    return Object.prototype.hasOwnProperty.call(eventFields, semantic)
      ? eventFields[semantic]
      : current[semantic]
  }
  const archiveFields = {
    archiveKey: normalizeText(operation && (operation.rentalEventId || operation.archiveKey)),
    foundationListingId: normalizeText(operation && operation.foundationListingId),
    temporaryListingId: normalizeText(eventFieldOrCurrent('temporaryListingId')),
    yuxiaoerListingId: normalizeText(eventFieldOrCurrent('yuxiaoerListingId')),
    yuxiaoerRoomId: normalizeText(eventFieldOrCurrent('yuxiaoerRoomId')),
    identityType: normalizeText(eventFieldOrCurrent('identityType')),
    physicalUnitKey: normalizeText(eventFieldOrCurrent('physicalUnitKey')),
    sourceRecordId: normalizeText(eventFieldOrCurrent('sourceRecordId')),
    availabilityCycleNo: Number(eventFieldOrCurrent('availabilityCycleNo') || 1),
    availabilityCycleId: normalizeText(eventFieldOrCurrent('availabilityCycleId')),
    lifecycleStatusText: '已出租',
    previousLifecycleStatusText: Object.prototype.hasOwnProperty.call(
      eventFields,
      'previousLifecycleStatusText'
    )
      ? normalizeText(eventFields.previousLifecycleStatusText)
      : normalizeText(current.lifecycleStatusText),
    vacancyNote: normalizeText(eventFieldOrCurrent('vacancyNote')),
    sourceCreatedAt: eventFieldOrCurrent('sourceCreatedAt'),
    metricKind: normalizeText(eventFieldOrCurrent('metricKind')),
    lifecycleDays: Object.prototype.hasOwnProperty.call(eventFields, 'elapsedDaysAtExit')
      ? eventFields.elapsedDaysAtExit
      : current.lifecycleDays,
    listingOwner: normalizeText(eventFieldOrCurrent('listingOwner')),
    ownerDepartment: normalizeText(eventFieldOrCurrent('ownerDepartment')),
    identityAliases: normalizeText(eventFieldOrCurrent('identityAliases')),
    lifecycleVersion: Number(eventFieldOrCurrent('lifecycleVersion') || 1),
    archivedAt: nowMs
  }
  RENTED_BUSINESS_SNAPSHOT_FIELDS.forEach((semantic) => {
    if (Object.prototype.hasOwnProperty.call(current, semantic)) {
      archiveFields[semantic] = clone(current[semantic])
    }
  })
  archiveFields.listingStatus = '已出租'
  archiveFields.published = false
  archiveFields.enabled = false
  archiveFields.sourcePresent = false
  return archiveFields
}

function buildFoundationMirrorPlan({
  sourceSnapshot,
  mirrorSnapshot,
  rentedSnapshot,
  locationCatalog,
  runId,
  nowMs,
  baseline = false
}) {
  const preliminaryPlan = planMirrorSync({ sourceSnapshot, mirrorSnapshot, locationCatalog, runId })
  const preliminaryRecords = plannedActiveMirrorRecords(sourceSnapshot, mirrorSnapshot, preliminaryPlan)
  const normalizedCurrent = normalizedFoundationCurrentSnapshot(mirrorSnapshot, nowMs)
  const persistedCurrentByRecordId = new Map((mirrorSnapshot.records || []).map((record) => [
    normalizeText(record && record.recordId),
    record && record.fields && typeof record.fields === 'object' ? record.fields : {}
  ]))
  const lifecycleSource = canonicalLifecycleSourceSnapshot(sourceSnapshot, preliminaryRecords)
  const lifecyclePlan = planListingLifecycle({
    sourceSnapshot: lifecycleSource,
    currentStateSnapshot: normalizedCurrent,
    rentedEventSnapshot: rentedSnapshotForLifecycle(rentedSnapshot),
    aliasSnapshot: synthesizedAliasSnapshot(normalizedCurrent),
    runId,
    observedAt: nowMs,
    baseline: baseline === true,
    allocateTemporaryId: deterministicTemporaryListingId
  })
  const currentByFoundationId = new Map((normalizedCurrent.records || []).map((record) => [
    normalizeText(record.fields && record.fields.foundationListingId),
    record
  ]))
  const canonicalBySourceId = new Map((preliminaryRecords || []).map((record) => [
    normalizeText(record.fields && record.fields.sourceRecordId),
    record.fields || {}
  ]))
  const operations = []
  const plannedRecords = []
  const counts = { create: 0, update: 0, deactivate: 0, restore: 0, noop: 0 }

  lifecyclePlan.desiredStates.forEach((state) => {
    const existing = currentByFoundationId.get(normalizeText(state.foundationListingId))
    const persistedFields = existing
      ? (persistedCurrentByRecordId.get(normalizeText(existing.recordId)) || existing.fields)
      : null
    const canonicalFields = canonicalBySourceId.get(normalizeText(state.sourceRecordId))
    if (!canonicalFields) throw new Error(`AI 数据底座缺少 canonical 房源：${state.sourceRecordId}`)
    const fields = {
      ...(persistedFields ? clone(persistedFields) : {}),
      ...clone(canonicalFields),
      ...clone(state),
      listingStatus: state.lifecycleStatusText,
      published: true,
      canonical: true,
      enabled: true
    }
    const plannedRecord = {
      recordId: existing ? existing.recordId : `dry-run-${state.foundationListingId}`,
      fields
    }
    plannedRecords.push(plannedRecord)
    if (!existing) {
      operations.push({
        type: 'create',
        sourceRecordId: state.sourceRecordId,
        foundationListingId: state.foundationListingId,
        fields
      })
      counts.create += 1
    } else if (existing.fields.enabled !== true) {
      operations.push({
        type: 'restore',
        recordId: existing.recordId,
        sourceRecordId: state.sourceRecordId,
        foundationListingId: state.foundationListingId,
        fields
      })
      counts.restore += 1
    } else if (!equalManagedMirrorFields(persistedFields, fields)) {
      operations.push({
        type: 'update',
        recordId: existing.recordId,
        sourceRecordId: state.sourceRecordId,
        foundationListingId: state.foundationListingId,
        fields
      })
      counts.update += 1
    } else {
      counts.noop += 1
    }
  })

  lifecyclePlan.currentStateOperations
    .filter((operation) => operation.type === 'markRented')
    .forEach((operation) => {
      const existing = currentByFoundationId.get(normalizeText(operation.foundationListingId))
      if (!existing) throw new Error(`AI 数据底座找不到待归档当前记录：${operation.foundationListingId}`)
      const fields = {
        ...clone(existing.fields),
        ...clone(operation.fields),
        listingStatus: '已出租',
        lifecycleStatusText: '已出租',
        sourcePresent: false,
        published: false,
        enabled: false
      }
      if (!equalManagedMirrorFields(existing.fields, fields)) {
        operations.push({
          type: 'deactivate',
          recordId: existing.recordId,
          sourceRecordId: normalizeText(fields.sourceRecordId),
          foundationListingId: operation.foundationListingId,
          fields
        })
        counts.deactivate += 1
      } else {
        counts.noop += 1
      }
  })

  if (baseline === true) {
    const desiredFoundationIds = new Set(lifecyclePlan.desiredStates.map((state) => (
      normalizeText(state.foundationListingId)
    )))
    ;(normalizedCurrent.records || []).forEach((record) => {
      const fields = record.fields || {}
      const foundationListingId = normalizeText(fields.foundationListingId)
      if (!foundationListingId || desiredFoundationIds.has(foundationListingId)) return
      if (fields.enabled !== true && fields.published !== true && fields.sourcePresent !== true) return
      operations.push({
        type: 'baselineDeactivate',
        recordId: record.recordId,
        sourceRecordId: normalizeText(fields.sourceRecordId),
        foundationListingId,
        fields: {
          ...clone(fields),
          listingStatus: '已下架',
          lifecycleStatusText: '基线外',
          sourcePresent: false,
          published: false,
          enabled: false
        }
      })
      counts.deactivate += 1
    })
  }

  const fullCurrentByFoundationId = new Map((normalizedCurrent.records || []).map((record) => [
    normalizeText(record.fields && record.fields.foundationListingId),
    record.fields || {}
  ]))
  const archiveOperations = lifecyclePlan.rentalEventOperations.map((operation) => {
    const currentFields = fullCurrentByFoundationId.get(normalizeText(operation.foundationListingId)) || {}
    return {
      type: 'create',
      archiveKey: operation.rentalEventId,
      foundationListingId: operation.foundationListingId,
      fields: foundationArchiveFields(operation, currentFields, nowMs)
    }
  })

  return {
    complete: true,
    operations,
    plannedRecords,
    archiveOperations,
    lifecyclePlan,
    counts,
    noop: operations.length === 0 && archiveOperations.length === 0
  }
}

function lifecycleHistoryOperations(
  currentSnapshot,
  currentOperations,
  historySnapshot,
  runId,
  nowMs,
  options = {}
) {
  const existingIds = new Set()
  ;(historySnapshot.records || []).forEach((record, index) => {
    const historyEventId = normalizeText(record.fields && record.fields.historyEventId)
    if (!historyEventId) throw new Error(`AI 数据底座状态流水第 ${index + 1} 行缺少 historyEventId`)
    const historyEventKey = historyEventId.toLocaleLowerCase('zh-CN')
    if (existingIds.has(historyEventKey)) {
      throw new Error(`AI 数据底座状态流水 historyEventId 重复：${historyEventId}`)
    }
    existingIds.add(historyEventKey)
  })
  if (options.suppressEvents === true) return []
  const currentByFoundationId = new Map((currentSnapshot.records || []).map((record) => [
    normalizeText(record.fields && record.fields.foundationListingId),
    record.fields || {}
  ]))
  const operations = []
  const historyCandidates = []

  function appendHistory(fields, seedParts, stage) {
    const seed = seedParts.map(normalizeText).join('\u0000')
    const historyEventId = `HIST-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32).toUpperCase()}`
    historyCandidates.push({
      stage,
      type: 'create',
      historyEventId,
      fields: {
        historyEventId,
        ...fields
      }
    })
  }

  const archiveHistoryCandidates = new Map()
  ;(options.archiveOperations || []).forEach((operation) => {
    const fields = operation.fields || {}
    const archiveKey = normalizeText(operation.archiveKey || fields.archiveKey)
    if (!archiveKey) throw new Error('AI 数据底座归档流水候选缺少 archiveKey')
    archiveHistoryCandidates.set(archiveKey, operation)
  })
  const persistedArchives = new Map()
  ;((options.rentedSnapshot && options.rentedSnapshot.records) || []).forEach((record) => {
    const fields = record && record.fields && typeof record.fields === 'object' ? record.fields : {}
    const archiveKey = normalizeText(fields.archiveKey || fields.rentalEventId)
    if (!archiveKey) return
    if (persistedArchives.has(archiveKey)) {
      throw new Error(`AI 数据底座已出租归档键重复：${archiveKey}`)
    }
    persistedArchives.set(archiveKey, {
      type: 'create',
      archiveKey,
      foundationListingId: normalizeText(fields.foundationListingId),
      fields
    })
  })
  ;(currentOperations || []).forEach((operation) => {
    const foundationListingId = normalizeText(operation.foundationListingId)
    const before = currentByFoundationId.get(foundationListingId) || {}
    const after = operation.fields || {}
    const beforeCycleNo = Number(before.availabilityCycleNo || 0)
    const afterCycleNo = Number(after.availabilityCycleNo || 0)
    if (!foundationListingId ||
        !Number.isInteger(beforeCycleNo) ||
        beforeCycleNo < 1 ||
        afterCycleNo !== beforeCycleNo + 1) {
      return
    }
    const archiveKey = `${foundationListingId}:rented:${beforeCycleNo}`
    if (archiveHistoryCandidates.has(archiveKey)) return
    const persisted = persistedArchives.get(archiveKey)
    if (!persisted) return
    const fields = persisted.fields || {}
    if (normalizeText(fields.foundationListingId) !== foundationListingId ||
        Number(fields.availabilityCycleNo || 0) !== beforeCycleNo) {
      throw new Error('AI 数据底座已出租归档与待租周期不一致')
    }
    archiveHistoryCandidates.set(archiveKey, persisted)
  })

  const currentOperationTypes = new Map((currentOperations || []).map((operation) => [
    normalizeText(operation.foundationListingId),
    operation.type
  ]))
  ;Array.from(archiveHistoryCandidates.values()).sort((left, right) => {
    const leftKey = normalizeText(left.archiveKey || (left.fields && left.fields.archiveKey))
    const rightKey = normalizeText(right.archiveKey || (right.fields && right.fields.archiveKey))
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  }).forEach((operation) => {
    const fields = operation.fields || {}
    const foundationListingId = normalizeText(operation.foundationListingId || fields.foundationListingId)
    if (['deactivate', 'markRented'].includes(currentOperationTypes.get(foundationListingId))) return
    const lifecycleVersion = Number(fields.lifecycleVersion || 0)
    appendHistory({
      foundationListingId,
      sourceRecordId: normalizeText(fields.sourceRecordId),
      availabilityCycleNo: Number(fields.availabilityCycleNo || 1),
      availabilityCycleId: normalizeText(fields.availabilityCycleId),
      eventType: '检测已出租',
      fromLifecycleStatusText: normalizeText(fields.previousLifecycleStatusText),
      toLifecycleStatusText: '已出租',
      runId: normalizeText(runId),
      listingOwner: normalizeText(fields.listingOwner),
      ownerDepartment: normalizeText(fields.ownerDepartment),
      lifecycleVersion
    }, [
      operation.archiveKey,
      lifecycleVersion,
      '检测已出租'
    ], 0)
  })

  ;(currentOperations || []).forEach((operation) => {
    const before = currentByFoundationId.get(normalizeText(operation.foundationListingId)) || {}
    const after = operation.fields || {}
    const fromStatus = normalizeText(before.lifecycleStatusText)
    const toStatus = normalizeText(after.lifecycleStatusText)
    const ownerChanged = normalizeText(before.listingOwner) !== normalizeText(after.listingOwner) ||
      normalizeText(before.ownerDepartment) !== normalizeText(after.ownerDepartment)
    const cycleChanged = Number(before.availabilityCycleNo || 0) !== Number(after.availabilityCycleNo || 0)
    let eventType = ''
    if (operation.type === 'create') eventType = '进入待租'
    else if (operation.type === 'deactivate') eventType = '检测已出租'
    else if (operation.type === 'restore' || cycleChanged) eventType = '重新进入待租'
    else if (fromStatus !== toStatus) eventType = '房态变化'
    else if (ownerChanged) eventType = '责任归属变化'
    if (!eventType) return
    const lifecycleVersion = Number(after.lifecycleVersion || 0)
    const seedParts = eventType === '检测已出租'
      ? [
          `${operation.foundationListingId}:rented:${Number(after.availabilityCycleNo || 1)}`,
          lifecycleVersion,
          '检测已出租'
        ]
      : [
          operation.foundationListingId,
          after.availabilityCycleId,
          lifecycleVersion,
          eventType,
          fromStatus,
          toStatus,
          after.sourceRecordId,
          before.listingOwner,
          before.ownerDepartment,
          after.listingOwner,
          after.ownerDepartment
        ]
    appendHistory({
      foundationListingId: normalizeText(operation.foundationListingId),
      sourceRecordId: normalizeText(after.sourceRecordId),
      availabilityCycleNo: Number(after.availabilityCycleNo || 1),
      availabilityCycleId: normalizeText(after.availabilityCycleId),
      eventType,
      fromLifecycleStatusText: fromStatus,
      toLifecycleStatusText: toStatus,
      runId: normalizeText(runId),
      listingOwner: normalizeText(after.listingOwner),
      ownerDepartment: normalizeText(after.ownerDepartment),
      lifecycleVersion
    }, seedParts, 1)
  })

  const scheduledIds = new Set()
  historyCandidates.sort((left, right) => {
    if (left.stage !== right.stage) return left.stage - right.stage
    return left.historyEventId.localeCompare(right.historyEventId)
  }).forEach((candidate, index) => {
    const historyEventKey = candidate.historyEventId.toLocaleLowerCase('zh-CN')
    if (scheduledIds.has(historyEventKey)) return
    scheduledIds.add(historyEventKey)
    // 已经落盘的候选仍占据规范序号，确保部分成功后重跑时后续事件时间不前移。
    if (existingIds.has(historyEventKey)) return
    existingIds.add(historyEventKey)
    operations.push({
      type: candidate.type,
      historyEventId: candidate.historyEventId,
      fields: {
        ...candidate.fields,
        eventAt: Number(nowMs) + index
      }
    })
  })
  return operations
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

function validateCanonicalMirrorRecords(records, options = {}) {
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
    if (!mirrorMaterialValuesExcluded(options.materialPolicy)) canonicalVideoAttachment(fields.video)
    const hasLatitude = fields.latitude !== undefined && fields.latitude !== null && fields.latitude !== ''
    const hasLongitude = fields.longitude !== undefined && fields.longitude !== null && fields.longitude !== ''
    if (hasLatitude !== hasLongitude) throw new Error(`专用源表 ${sourceRecordId} 经纬度必须成对出现`)
  })
  return records
}

function canonicalMirrorRecordToSyncRow(record, index, options = {}) {
  const fields = record && record.fields && typeof record.fields === 'object' ? record.fields : (record || {})
  const sourceRecordId = normalizeText(fields.sourceRecordId)
  const roomParts = canonicalRoomParts(fields)
  return {
    record_id: sourceRecordId,
    rowNumber: index + 1,
    video: mirrorMaterialValuesExcluded(options.materialPolicy)
      ? null
      : canonicalVideoAttachment(fields.video),
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

function externalWriteOptions(options = {}) {
  if (options.onExternalWriteDispatched != null &&
      typeof options.onExternalWriteDispatched !== 'function') {
    const error = new Error('外部写派发回调必须是同步函数')
    error.code = 'EXTERNAL_WRITE_DISPATCH_CALLBACK_INVALID'
    error.statusCode = 400
    error.safeBeforeWrite = true
    throw error
  }
  return typeof options.onExternalWriteDispatched === 'function'
    ? { onWriteDispatched: options.onExternalWriteDispatched }
    : {}
}

async function createSemanticRecords(targetClient, tableId, snapshot, operations, options = {}) {
  // batch_create 只有一个 client_token。若把多条业务记录合在同一个随机批次，
  // “服务端已落盘但响应丢失”后下一进程无法稳定重建同一批次，可能重复建行。
  // 因此创建阶段按业务幂等键逐条提交；吞吐让位于跨进程确定性。
  const serializeFields = options.omitEmptyFields === true
    ? semanticFieldsForCreate
    : semanticFieldsForWrite
  for (const operation of operations) {
    await targetClient.batchCreateRecords(tableId, [{
      fields: serializeFields(snapshot.fieldNames, operation.fields)
    }], {
      clientToken: stableCreateClientToken(tableId, operation),
      ...externalWriteOptions(options)
    })
  }
}

async function writeFoundationCurrentRecords(targetClient, tableId, snapshot, operations, options = {}) {
  const creates = operations.filter((operation) => operation.type === 'create')
  const updates = operations.filter((operation) => operation.type !== 'create')
  await createSemanticRecords(targetClient, tableId, snapshot, creates, {
    ...options,
    omitEmptyFields: true
  })
  for (const batch of chunksOf(updates)) {
    const records = batch.map((operation) => (
      semanticUpdateRecordForWrite(snapshot, snapshot.fieldNames, operation)
    ))
    await targetClient.batchUpdateRecords(tableId, records, {
      clientToken: stableUpdateClientToken(tableId, records, {
        phase: 'foundation-current',
        runId: options.runId,
        runNowMs: options.nowMs
      }),
      ...externalWriteOptions(options)
    })
  }
}

function stablePlanValue(value) {
  if (Array.isArray(value)) return value.map(stablePlanValue)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stablePlanValue(value[key])
      return result
    }, {})
  }
  return value
}

function snapshotForPlanDigest(snapshot = {}) {
  const records = (snapshot.records || []).map((record) => ({
    recordId: normalizeText(record && (record.recordId || record.record_id)),
    fields: stablePlanValue(record && record.fields && typeof record.fields === 'object'
      ? record.fields
      : {})
  }))
  records.sort((left, right) => {
    if (left.recordId < right.recordId) return -1
    if (left.recordId > right.recordId) return 1
    const leftFields = JSON.stringify(left.fields)
    const rightFields = JSON.stringify(right.fields)
    return leftFields < rightFields ? -1 : leftFields > rightFields ? 1 : 0
  })
  return {
    complete: snapshot.complete === true,
    recordCount: records.length,
    schemaFingerprint: normalizeText(snapshot.schemaFingerprint),
    fieldNames: stablePlanValue(snapshot.fieldNames || {}),
    records
  }
}

function operationsForPlanDigest(operations = [], options = {}) {
  return operations.map((operation) => {
    const normalized = clone(operation)
    if (options.history === true && normalized.fields) {
      normalized.fields.eventAt = 0
      normalized.fields.runId = ''
    }
    if (options.archive === true && normalized.fields) {
      normalized.fields.archivedAt = 0
    }
    return stablePlanValue(normalized)
  }).sort((left, right) => {
    const leftText = JSON.stringify(left)
    const rightText = JSON.stringify(right)
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
  })
}

function semanticMirrorFieldsForConvergence(fields = {}) {
  const managed = managedFieldsOf(
    fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {},
    { includeFoundation: true }
  )
  const normalized = clone(managed)
  delete normalized.lifecycleDays
  return stablePlanValue(normalized)
}

function semanticPlanFieldsForConvergence(fields = {}) {
  const normalized = clone(
    fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}
  )
  delete normalized.lifecycleDays
  return stablePlanValue(normalized)
}

function exactSemanticOperationKeys(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return false
  return JSON.stringify(Object.keys(operation).sort()) === JSON.stringify([
    'fields',
    'foundationListingId',
    'recordId',
    'sourceRecordId',
    'type'
  ])
}

function operationsForSemanticConvergenceDigest(
  operations = [],
  mirrorSnapshot = {},
  plannedRecords = []
) {
  const allowedFieldNames = new Set(managedFieldNames({ includeFoundation: true }))
  const currentByRecordId = new Map((mirrorSnapshot.records || []).map((record) => [
    normalizeText(record && (record.recordId || record.record_id)),
    record && record.fields && typeof record.fields === 'object' ? record.fields : {}
  ]))
  const plannedByRecordId = new Map((plannedRecords || []).map((record) => [
    normalizeText(record && (record.recordId || record.record_id)),
    record && record.fields && typeof record.fields === 'object' ? record.fields : {}
  ]))
  return operations.reduce((result, operation) => {
    const recordId = normalizeText(operation && operation.recordId)
    const currentFields = recordId ? currentByRecordId.get(recordId) : null
    const plannedFields = recordId ? plannedByRecordId.get(recordId) : null
    const operationFields = operation && operation.fields &&
      typeof operation.fields === 'object' && !Array.isArray(operation.fields)
      ? operation.fields
      : null
    const semanticOperationFields = semanticPlanFieldsForConvergence(operationFields)
    const semanticManagedOperationFields = semanticMirrorFieldsForConvergence(operationFields)
    const exactManagedFields = operationFields && Object.keys(operationFields).every((field) => (
      field === 'lifecycleDays' || allowedFieldNames.has(field)
    ))
    const exactIdentities = operationFields &&
      normalizeText(operation.sourceRecordId) &&
      normalizeText(operation.foundationListingId) &&
      normalizeText(operation.sourceRecordId) === normalizeText(operationFields.sourceRecordId) &&
      normalizeText(operation.foundationListingId) ===
        normalizeText(operationFields.foundationListingId)
    if (operation && operation.type === 'update' && exactSemanticOperationKeys(operation) &&
        currentFields && plannedFields && exactIdentities && exactManagedFields &&
        JSON.stringify(semanticOperationFields) ===
          JSON.stringify(semanticPlanFieldsForConvergence(plannedFields)) &&
        JSON.stringify(semanticManagedOperationFields) ===
          JSON.stringify(semanticMirrorFieldsForConvergence(currentFields))) {
      // lifecycleDays 是按本次 runNowMs 推导的展示值。若一次 update 除它之外没有任何
      // 托管字段变化，且 operation / planned record / 当前记录三方身份和字段精确闭合，
      // 跨运行身份才把该操作视为 noop；任何额外字段或未知结构都会保留并阻断。
      return result
    }
    const normalized = clone(operation)
    if (normalized && normalized.fields) {
      normalized.fields = semanticPlanFieldsForConvergence(normalized.fields)
    }
    result.push(stablePlanValue(normalized))
    return result
  }, []).sort((left, right) => {
    const leftText = JSON.stringify(left)
    const rightText = JSON.stringify(right)
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
  })
}

function plannedRecordsForSemanticConvergenceDigest(records = []) {
  return records.map((record) => ({
    recordId: normalizeText(record && (record.recordId || record.record_id)),
    fields: semanticPlanFieldsForConvergence(record && record.fields)
  })).sort((left, right) => {
    const leftText = JSON.stringify(left)
    const rightText = JSON.stringify(right)
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
  })
}

function foundationEnrichmentPlanSha256({
  targetBaseToken,
  miniTableId,
  historyTableId,
  mappingSha256,
  currentSnapshot,
  historySnapshot,
  updateOperations,
  historyOperations
}) {
  const normalizedMappingSha = normalizeText(mappingSha256).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalizedMappingSha)) {
    throw new Error('身份责任补全缺少合法的私有映射字节摘要')
  }
  const targetToken = normalizeResourceIdentifier(targetBaseToken)
  const currentTable = normalizeResourceIdentifier(miniTableId)
  const historyTable = normalizeResourceIdentifier(historyTableId)
  if (!targetToken || !currentTable || !historyTable || currentTable === historyTable) {
    throw new Error('身份责任补全目标 Base、当前主档与状态流水资源无效')
  }
  const digestInput = stablePlanValue({
    version: 'foundation-enrichment-plan-v1',
    targetBaseTokenSha256: crypto.createHash('sha256').update(targetToken).digest('hex'),
    miniTableId: currentTable,
    historyTableId: historyTable,
    mappingSha256: normalizedMappingSha,
    currentSnapshot: snapshotForPlanDigest(currentSnapshot),
    historySnapshot: snapshotForPlanDigest(historySnapshot),
    updateOperations: operationsForPlanDigest(updateOperations),
    historyOperations: operationsForPlanDigest(historyOperations, { history: true })
  })
  return crypto.createHash('sha256').update(JSON.stringify(digestInput)).digest('hex')
}

function secureDigestEqual(left, right) {
  const leftText = normalizeText(left).toLowerCase()
  const rightText = normalizeText(right).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(leftText) || !/^[0-9a-f]{64}$/.test(rightText)) return false
  return crypto.timingSafeEqual(Buffer.from(leftText, 'hex'), Buffer.from(rightText, 'hex'))
}

function stableSha256(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stablePlanValue(value)))
    .digest('hex')
}

function resourceTokenSha256(value) {
  const token = normalizeResourceIdentifier(value)
  return token ? crypto.createHash('sha256').update(token).digest('hex') : ''
}

async function sha256LegacyMaterialFile(filePath) {
  const resolved = path.resolve(filePath)
  const pathStat = await fs.promises.lstat(resolved)
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    const error = new Error('旧素材本地路径必须是普通文件')
    error.statusCode = 409
    error.safeBeforeWrite = true
    throw error
  }
  const handle = await fs.promises.open(resolved, 'r')
  try {
    const before = await handle.stat()
    const hash = crypto.createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) hash.update(chunk)
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        (before.ino && after.ino && before.ino !== after.ino)) {
      const error = new Error('旧素材本地文件在摘要计算期间发生变化')
      error.statusCode = 409
      error.safeBeforeWrite = true
      throw error
    }
    return {
      size: before.size,
      contentSha256: hash.digest('hex')
    }
  } finally {
    await handle.close()
  }
}

function automaticWorkerConfigurationStatus(options = {}) {
  const mirrorState = mirrorConfigurationStatus()
  const noteMaterialsEnabled = config.feishu.noteMaterialSyncEnabled === true
  const noteMaterialsReady = !noteMaterialsEnabled || formalNoteMaterialConfigurationReady(options)
  const controllerReady = config.feishu.syncControllerMode === 'worker-v2'
  const schemaApproved = /^[a-f0-9]{64}$/.test(String(config.feishu.approvedSchemaSha256 || ''))
  const resourceApproved = /^[a-f0-9]{64}$/.test(
    String(config.feishu.approvedResourceIdentitySha256 || '')
  )
  return {
    ready: config.feishu.syncEnabled === true &&
      config.feishu.mirrorSyncEnabled === true &&
      mirrorState.ready && noteMaterialsReady && controllerReady &&
      schemaApproved && resourceApproved,
    mirrorReady: mirrorState.ready,
    noteMaterialsReady,
    controllerReady,
    schemaApproved,
    resourceApproved
  }
}

async function buildLegacyMaterialEvidence(materials = [], options = {}) {
  if (!Array.isArray(materials)) {
    const error = new Error('旧素材清单必须是数组')
    error.statusCode = 409
    error.safeBeforeWrite = true
    throw error
  }
  const manifest = []
  for (const raw of materials) {
    const material = materialFromRaw(raw || {})
    const localFile = material.localFilePath
      ? await sha256LegacyMaterialFile(material.localFilePath)
      : null
    manifest.push({
      name: material.name,
      token: material.token,
      type: material.type,
      url: material.url,
      videoUrl: material.videoUrl,
      videoKey: material.videoKey,
      sourcePath: material.sourcePath,
      localFile
    })
  }
  manifest.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return {
    enabled: options.enabled === true || manifest.length > 0,
    count: manifest.length,
    manifestSha256: stableSha256({
      version: 'legacy-material-manifest-v1',
      materials: manifest
    })
  }
}

function normalizeLegacyMaterialEvidence(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const enabled = source.enabled === true
  const count = Number(source.count)
  const manifestSha256 = normalizeText(source.manifestSha256).toLowerCase()
  if (!Number.isSafeInteger(count) || count < 0 || !/^[0-9a-f]{64}$/.test(manifestSha256)) {
    const error = new Error('旧素材清单缺少完整内容摘要')
    error.statusCode = 409
    error.safeBeforeWrite = true
    throw error
  }
  return { enabled, count, manifestSha256 }
}

function mirrorSafetyResources(options = {}) {
  const explicit = options.mirrorSafetyResources && typeof options.mirrorSafetyResources === 'object'
    ? options.mirrorSafetyResources
    : {}
  return {
    sourceBaseToken: explicit.sourceBaseToken,
    targetBaseToken: explicit.targetBaseToken,
    sourceTableId: explicit.sourceTableId || options.sourceTableId,
    locationTableId: explicit.locationTableId || options.locationTableId,
    miniTableId: explicit.miniTableId || options.miniTableId,
    rentedTableId: explicit.rentedTableId || options.rentedTableId,
    historyTableId: explicit.historyTableId || options.historyTableId,
    feishuApiBaseUrl: explicit.feishuApiBaseUrl,
    legacyMaterialFolderToken: explicit.legacyMaterialFolderToken,
    noteMaterialSyncEnabled: explicit.noteMaterialSyncEnabled === true,
    noteMaterialTargetRootFolderToken: explicit.noteMaterialTargetRootFolderToken,
    noteMaterialAllowedHosts: Array.isArray(explicit.noteMaterialAllowedHosts)
      ? explicit.noteMaterialAllowedHosts
      : [],
    uploadToOss: explicit.uploadToOss === true,
    ossBucket: explicit.ossBucket,
    ossRegion: explicit.ossRegion,
    ossUploadDir: explicit.ossUploadDir,
    ossPublicBaseUrl: explicit.ossPublicBaseUrl
  }
}

function mirrorSafetySnapshot(role, snapshot) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {}
  return {
    role,
    schemaFingerprint: normalizeText(input.schemaFingerprint).toLowerCase(),
    digest: normalizeText(input.digest).toLowerCase(),
    recordCount: Number.isSafeInteger(input.recordCount)
      ? input.recordCount
      : (Array.isArray(input.records) ? input.records.length : 0)
  }
}

function publicSchemaBindings(role, snapshot) {
  const raw = snapshot && Array.isArray(snapshot.schemaBindings)
    ? snapshot.schemaBindings
    : []
  return {
    role,
    bindings: raw.map((binding) => ({
      semantic: normalizeText(binding && binding.semantic),
      fieldName: normalizeText(binding && binding.fieldName),
      type: normalizeText(binding && binding.type)
    })).filter((binding) => binding.semantic && binding.fieldName && binding.type)
      .sort((left, right) => left.semantic.localeCompare(right.semantic))
  }
}

function buildMirrorSafetyDigests(input = {}) {
  const snapshotRoles = [
    ['source', input.sourceSnapshot],
    ['location', input.locationSnapshot],
    ['mini', input.mirrorSnapshot]
  ]
  if (input.rentedSnapshot) snapshotRoles.push(['rented', input.rentedSnapshot])
  if (input.historySnapshot) snapshotRoles.push(['history', input.historySnapshot])
  const snapshots = snapshotRoles.map(([role, snapshot]) => mirrorSafetySnapshot(role, snapshot))
  const schemaBindings = snapshotRoles.map(([role, snapshot]) => publicSchemaBindings(role, snapshot))
  const schemaSha256 = stableSha256({
    version: 'feishu-mirror-schema-v1',
    schemas: snapshots.map(({ role, schemaFingerprint }) => ({ role, schemaFingerprint }))
  })

  const resources = input.resources && typeof input.resources === 'object'
    ? input.resources
    : {}
  const legacyMaterialEvidence = normalizeLegacyMaterialEvidence(
    input.legacyMaterialEvidence || {
      enabled: false,
      count: 0,
      manifestSha256: stableSha256({ version: 'legacy-material-manifest-v1', materials: [] })
    }
  )
  const noteMaterialSyncEnabled = resources.noteMaterialSyncEnabled === true
  // 房源笔记发布链无论旧 FEISHU_UPLOAD_TO_OSS 开关如何都会把同一压缩成品写入 OSS；
  // 因此资源身份必须描述“真实会写入的目的地”，不能用旧开关把 Bucket/Region/目录从摘要中抹掉。
  const legacyUploadToOss = legacyMaterialEvidence.enabled && resources.uploadToOss === true
  const ossDeliveryRequired = noteMaterialSyncEnabled || legacyUploadToOss
  const allowedHosts = Array.isArray(resources.noteMaterialAllowedHosts)
    ? resources.noteMaterialAllowedHosts
      .map((value) => normalizeResourceIdentifier(value).toLowerCase())
      .filter(Boolean)
      .sort()
    : []
  const resourceIdentitySha256 = stableSha256({
    version: 'feishu-mirror-resource-identity-v1',
    resources: [
      {
        role: 'source',
        baseTokenSha256: resourceTokenSha256(resources.sourceBaseToken),
        tableId: normalizeResourceIdentifier(resources.sourceTableId)
      },
      {
        role: 'location',
        baseTokenSha256: resourceTokenSha256(resources.targetBaseToken),
        tableId: normalizeResourceIdentifier(resources.locationTableId)
      },
      {
        role: 'mini',
        baseTokenSha256: resourceTokenSha256(resources.targetBaseToken),
        tableId: normalizeResourceIdentifier(resources.miniTableId)
      },
      ...(input.rentedSnapshot ? [{
        role: 'rented',
        baseTokenSha256: resourceTokenSha256(resources.targetBaseToken),
        tableId: normalizeResourceIdentifier(resources.rentedTableId)
      }] : []),
      ...(input.historySnapshot ? [{
        role: 'history',
        baseTokenSha256: resourceTokenSha256(resources.targetBaseToken),
        tableId: normalizeResourceIdentifier(resources.historyTableId)
      }] : [])
    ],
    delivery: {
      feishuApiBaseUrlSha256: resourceTokenSha256(resources.feishuApiBaseUrl),
      legacyMaterialSourceEnabled: legacyMaterialEvidence.enabled,
      legacyMaterialFolderSha256: legacyMaterialEvidence.enabled
        ? resourceTokenSha256(resources.legacyMaterialFolderToken)
        : '',
      legacyUploadToOss,
      noteMaterialSyncEnabled,
      noteMaterialTargetRootSha256: noteMaterialSyncEnabled
        ? resourceTokenSha256(resources.noteMaterialTargetRootFolderToken)
        : '',
      noteMaterialAllowedHostsSha256: noteMaterialSyncEnabled ? stableSha256(allowedHosts) : '',
      ossDeliveryRequired,
      ossBucketSha256: ossDeliveryRequired ? resourceTokenSha256(resources.ossBucket) : '',
      ossRegionSha256: ossDeliveryRequired ? resourceTokenSha256(resources.ossRegion) : '',
      ossUploadDirSha256: ossDeliveryRequired ? resourceTokenSha256(resources.ossUploadDir) : '',
      ossPublicBaseUrlSha256: ossDeliveryRequired
        ? resourceTokenSha256(resources.ossPublicBaseUrl)
        : ''
    }
  })

  const plannedRecords = Array.isArray(input.plannedRecords) ? input.plannedRecords : []
  const publicCompanySheetSnapshot = buildCompanySheetSnapshot(plannedRecords)
  const planOperations = operationsForPlanDigest(input.operations || [])
  const semanticPlanOperations = operationsForSemanticConvergenceDigest(
    input.operations || [],
    input.mirrorSnapshot || {},
    plannedRecords
  )
  const semanticPlannedRecords = plannedRecordsForSemanticConvergenceDigest(plannedRecords)
  const archiveOperations = operationsForPlanDigest(input.archiveOperations || [], { archive: true })
  const historyOperations = operationsForPlanDigest(input.historyOperations || [], { history: true })
  const baselineMarkerOperations = input.baselineMarkerOperation
    ? operationsForPlanDigest([input.baselineMarkerOperation], { history: true })
    : []
  const publicCompanySheet = stablePlanValue(publicCompanySheetSnapshot)
  // 分项证据只保存摘要和数量，不保存源表正文。总摘要变化时，运维可以直接看出是
  // 哪张表、哪类操作、素材清单还是首页房源表发生变化，避免再次靠反复正式尝试定位。
  const componentEvidence = {
    contract: 'feishu-mirror-component-evidence-v1',
    snapshots: snapshots.map(({ role, digest, recordCount }) => ({ role, digest, recordCount })),
    operations: {
      main: { count: planOperations.length, digest: stableSha256(planOperations) },
      archive: { count: archiveOperations.length, digest: stableSha256(archiveOperations) },
      history: { count: historyOperations.length, digest: stableSha256(historyOperations) }
    },
    baselineMarker: {
      count: baselineMarkerOperations.length,
      digest: stableSha256(baselineMarkerOperations)
    },
    legacyMaterials: {
      count: legacyMaterialEvidence.count,
      digest: stableSha256(legacyMaterialEvidence)
    },
    companySheet: {
      rowCount: Math.max(0, publicCompanySheetSnapshot.rows.length - 1),
      columnCount: Array.isArray(publicCompanySheetSnapshot.rows[0])
        ? publicCompanySheetSnapshot.rows[0].length
        : 0,
      digest: stableSha256(publicCompanySheet)
    }
  }
  const componentEvidenceSha256 = stableSha256(componentEvidence)
  const mirrorPlanSha256 = stableSha256({
    version: 'feishu-mirror-plan-v1',
    schemaSha256,
    resourceIdentitySha256,
    snapshots: snapshots.map(({ role, digest, recordCount }) => ({ role, digest, recordCount })),
    operations: planOperations,
    archiveOperations,
    historyOperations,
    baselineMarkerOperation: baselineMarkerOperations[0] || null,
    legacyMaterialEvidence,
    publicCompanySheetSnapshot: publicCompanySheet
  })
  const semanticMirrorPlanSha256 = stableSha256({
    version: 'feishu-mirror-semantic-plan-v1',
    schemaSha256,
    resourceIdentitySha256,
    snapshots: snapshots.map(({ role, digest, recordCount }) => ({ role, digest, recordCount })),
    operations: semanticPlanOperations,
    plannedRecords: semanticPlannedRecords,
    archiveOperations,
    historyOperations,
    baselineMarkerOperation: baselineMarkerOperations[0] || null,
    legacyMaterialEvidence,
    publicCompanySheetSnapshot: publicCompanySheet
  })
  return {
    schemaSha256,
    resourceIdentitySha256,
    mirrorPlanSha256,
    semanticMirrorPlanSha256,
    schemaBindings,
    componentEvidence,
    componentEvidenceSha256
  }
}

function mirrorSafetyDigestError(code, message) {
  const error = new Error(message)
  error.name = 'MirrorSafetyDigestError'
  error.code = code
  error.statusCode = 409
  error.safeBeforeWrite = true
  // 字段契约或物理资源身份变化不会靠下一次自动重读自行恢复，必须锁住调度等待人工批准。
  if (code === 'MIRROR_SCHEMA_CHANGED' || code === 'MIRROR_RESOURCE_CHANGED') {
    error.blocked = true
  }
  return error
}

function assertMirrorSafetyDigestConfirmation(options = {}, digests = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'expectedSchemaSha256') &&
      options.expectedSchemaSha256 !== undefined &&
      !secureDigestEqual(options.expectedSchemaSha256, digests.schemaSha256)) {
    throw mirrorSafetyDigestError('MIRROR_SCHEMA_CHANGED', '飞书镜像字段契约摘要已变化，已在写入前阻断')
  }
  if (Object.prototype.hasOwnProperty.call(options, 'expectedMirrorPlanSha256') &&
      options.expectedMirrorPlanSha256 !== undefined &&
      !secureDigestEqual(options.expectedMirrorPlanSha256, digests.mirrorPlanSha256)) {
    throw mirrorSafetyDigestError('MIRROR_PLAN_CHANGED', '飞书镜像源数据或写入计划已变化，已在写入前阻断')
  }
  if (Object.prototype.hasOwnProperty.call(options, 'expectedResourceIdentitySha256') &&
      options.expectedResourceIdentitySha256 !== undefined &&
      !secureDigestEqual(options.expectedResourceIdentitySha256, digests.resourceIdentitySha256)) {
    throw mirrorSafetyDigestError('MIRROR_RESOURCE_CHANGED', '飞书源表或目标表身份已变化，已在写入前阻断')
  }
  if (Object.prototype.hasOwnProperty.call(options, 'expectedComponentEvidenceSha256') &&
      options.expectedComponentEvidenceSha256 !== undefined &&
      !secureDigestEqual(
        options.expectedComponentEvidenceSha256,
        digests.componentEvidenceSha256
      )) {
    throw mirrorSafetyDigestError('MIRROR_PLAN_CHANGED', '飞书镜像分项证据已变化，已在写入前阻断')
  }
  return true
}

function enrichmentCurrentOperations(currentSnapshot, plan) {
  const byRecordId = new Map((currentSnapshot.records || []).map((record) => [
    normalizeText(record && (record.recordId || record.record_id)),
    record
  ]))
  return (plan.updateOperations || []).map((operation) => {
    const current = byRecordId.get(normalizeText(operation.recordId))
    if (!current) throw new Error('身份责任补全计划未命中当前主档记录')
    const fields = {
      ...clone(current.fields || {}),
      ...clone(operation.fields || {})
    }
    const foundationListingId = normalizeText(fields.foundationListingId)
    if (!foundationListingId) throw new Error('身份责任补全当前主档缺少底座房源 ID')
    return {
      type: 'update',
      target: 'currentState',
      recordId: operation.recordId,
      sourceRecordId: operation.sourceRecordId,
      foundationListingId,
      fields
    }
  })
}

async function executeFoundationEnrichment({
  targetClient,
  targetBaseToken,
  miniTableId,
  miniBindings,
  historyTableId,
  historyBindings,
  privateMappings,
  mappingSha256,
  confirmPlanSha256,
  runId,
  nowMs,
  dryRun = true
} = {}) {
  if (typeof dryRun !== 'boolean') {
    throw new Error('飞书身份责任补全 dryRun 必须是布尔值')
  }
  const normalizedMiniTableId = normalizeResourceIdentifier(miniTableId)
  const normalizedHistoryTableId = normalizeResourceIdentifier(historyTableId)
  if (!normalizeResourceIdentifier(targetBaseToken) ||
      !normalizedMiniTableId ||
      !normalizedHistoryTableId ||
      normalizedMiniTableId === normalizedHistoryTableId) {
    throw new Error('飞书身份责任补全目标资源必须完整且相互独立')
  }
  if (dryRun === false && !/^[0-9a-f]{64}$/.test(normalizeText(confirmPlanSha256).toLowerCase())) {
    throw new Error('正式身份责任补全必须确认 dry-run 输出的计划摘要')
  }
  if (!targetClient || typeof targetClient.readValidatedTableSnapshot !== 'function') {
    throw new Error('飞书身份责任补全缺少目标 Base 客户端')
  }
  const currentSnapshot = await targetClient.readValidatedTableSnapshot({
    tableId: normalizedMiniTableId,
    bindings: miniBindings,
    allowEmpty: false
  })
  const historySnapshot = await targetClient.readValidatedTableSnapshot({
    tableId: normalizedHistoryTableId,
    bindings: historyBindings,
    allowEmpty: true
  })
  const plan = planFoundationEnrichment({
    privateMappings,
    currentStateSnapshot: currentSnapshot
  })
  const effectiveNowMs = nowMs == null ? Date.now() : Number(nowMs)
  if (!Number.isSafeInteger(effectiveNowMs) || effectiveNowMs <= 0) {
    throw new Error('飞书身份责任补全 nowMs 必须是正整数毫秒时间戳')
  }
  const effectiveRunId = normalizeText(runId) || `foundation-enrichment-${effectiveNowMs}`
  const fullCurrentOperations = enrichmentCurrentOperations(currentSnapshot, plan)
  const historyOperations = lifecycleHistoryOperations(
    currentSnapshot,
    fullCurrentOperations,
    historySnapshot,
    effectiveRunId,
    effectiveNowMs
  )
  const planSha256 = foundationEnrichmentPlanSha256({
    targetBaseToken,
    miniTableId: normalizedMiniTableId,
    historyTableId: normalizedHistoryTableId,
    mappingSha256,
    currentSnapshot,
    historySnapshot,
    updateOperations: plan.updateOperations,
    historyOperations
  })
  if (dryRun === true) {
    return {
      complete: true,
      dryRun: true,
      published: false,
      ...clone(plan),
      historyAppendCount: historyOperations.length,
      planSha256
    }
  }
  if (!secureDigestEqual(confirmPlanSha256, planSha256)) {
    throw new Error('身份责任补全目标快照或计划已变化，计划摘要不匹配')
  }
  if (typeof targetClient.batchCreateRecords !== 'function' ||
      typeof targetClient.batchUpdateRecords !== 'function') {
    throw new Error('飞书身份责任补全缺少目标 Base 写客户端')
  }

  await createSemanticRecords(
    targetClient,
    normalizedHistoryTableId,
    historySnapshot,
    historyOperations
  )
  const historyReadback = await targetClient.readValidatedTableSnapshot({
    tableId: normalizedHistoryTableId,
    bindings: historyBindings,
    allowEmpty: true
  })
  const remainingHistoryOperations = lifecycleHistoryOperations(
    currentSnapshot,
    fullCurrentOperations,
    historyReadback,
    effectiveRunId,
    effectiveNowMs
  )
  if (remainingHistoryOperations.length) {
    const error = new Error('飞书身份责任补全状态流水写后回读不一致')
    error.statusCode = 502
    throw error
  }

  for (const batch of chunksOf(plan.updateOperations)) {
    const records = batch.map((operation) => ({
      record_id: operation.recordId,
      fields: semanticFieldsForWrite(currentSnapshot.fieldNames, operation.fields)
    }))
    await targetClient.batchUpdateRecords(normalizedMiniTableId, records, {
      clientToken: stableUpdateClientToken(normalizedMiniTableId, records, {
        phase: 'foundation-enrichment-current',
        runId: effectiveRunId,
        runNowMs: effectiveNowMs
      })
    })
  }
  const readback = await targetClient.readValidatedTableSnapshot({
    tableId: normalizedMiniTableId,
    bindings: miniBindings,
    allowEmpty: false
  })
  const remaining = planFoundationEnrichment({
    privateMappings,
    currentStateSnapshot: readback
  })
  if (!remaining.noop) {
    const error = new Error('飞书身份责任补全写后回读不一致')
    error.statusCode = 502
    throw error
  }
  return {
    complete: true,
    dryRun: false,
    published: true,
    ...clone(plan),
    historyAppendCount: historyOperations.length,
    remainingUpdateCount: 0,
    planSha256
  }
}

async function executeAiFoundationSync({
  targetClient,
  sourceSnapshot,
  locationSnapshot,
  mirrorSnapshot,
  rentedSnapshot,
  historySnapshot,
  locationCatalog,
  options,
  runId,
  nowMs
}) {
  const baseline = !foundationBaselineCompleted(historySnapshot)
  const plan = buildFoundationMirrorPlan({
    sourceSnapshot,
    mirrorSnapshot,
    rentedSnapshot,
    locationCatalog,
    runId,
    nowMs,
    baseline
  })
  const normalizedCurrent = normalizedFoundationCurrentSnapshot(mirrorSnapshot, nowMs)
  const historyOperations = lifecycleHistoryOperations(
    normalizedCurrent,
    plan.operations,
    historySnapshot,
    runId,
    nowMs,
    {
      archiveOperations: plan.archiveOperations,
      rentedSnapshot,
      suppressEvents: baseline
    }
  )
  validateCanonicalMirrorRecords(plan.plannedRecords, { materialPolicy: options.materialPolicy })
  const sourceNoteMaterials = options.noteMaterialSyncEnabled === true
    ? activeSourceNoteMaterialRows(options.sourceNoteMaterials, plan.plannedRecords)
    : []
  assertNoteMaterialSourceFieldPlan(
    options,
    buildNoteMaterialSourceFieldPlan(sourceNoteMaterials)
  )
  // 旧专用表可能尚未持久化底座 ID。熔断必须比较同一轮规范化后的稳定实体身份，
  // 否则会把 UNIT 物理键升级为 TMP/寓小二 ID 误判成整批撤下。
  assertMirrorDeactivateSafety(normalizedCurrent, plan.plannedRecords, {
    foundationIdentityMode: true,
    baselinePublishedSourceIds: options.baselinePublishedSourceIds,
    baselinePublishedFoundationIdentityKeys: options.baselinePublishedFoundationIdentityKeys,
    maxDeactivateCount: options.maxDeactivateCount,
    maxDeactivateRatio: options.maxDeactivateRatio,
    allowMassDeactivate: options.allowMassDeactivate === true
  })

  const lifecycleCounts = {
    rentedArchived: plan.archiveOperations.length,
    historyAppended: historyOperations.length,
    baselineInitialized: baseline ? 1 : 0
  }
  const noop = plan.operations.length === 0 &&
    plan.archiveOperations.length === 0 &&
    historyOperations.length === 0 &&
    baseline === false
  const baselineMarkerOperation = baseline
    ? foundationBaselineMarkerOperation(runId, nowMs)
    : null
  const safetyDigests = buildMirrorSafetyDigests({
    sourceSnapshot,
    locationSnapshot,
    mirrorSnapshot,
    rentedSnapshot,
    historySnapshot,
    resources: mirrorSafetyResources(options),
    legacyMaterialEvidence: options.legacyMaterialEvidence,
    operations: plan.operations,
    archiveOperations: plan.archiveOperations,
    historyOperations,
    baselineMarkerOperation,
    plannedRecords: plan.plannedRecords
  })
  // dry-run 与 apply 都产出同一组三摘要；调用方提供确认摘要时，任何漂移都必须在
  // 飞书首个目标写请求前失败。这样同类型字段互换也不能伪装成合法业务变化。
  assertMirrorSafetyDigestConfirmation(options, safetyDigests)
  if (options._capturePartialReconciliationState != null) {
    if (options.dryRun !== true || typeof options._capturePartialReconciliationState !== 'function') {
      const error = new Error('部分写入对账快照捕获只允许内部 dry-run 同步函数')
      error.code = 'PARTIAL_RECONCILIATION_FAILED'
      error.safeBeforeWrite = true
      throw error
    }
    const captureResult = options._capturePartialReconciliationState(clone({
      sourceSnapshot,
      locationSnapshot,
      mirrorSnapshot,
      rentedSnapshot,
      historySnapshot,
      resources: mirrorSafetyResources(options),
      legacyMaterialEvidence: options.legacyMaterialEvidence,
      safetyDigests,
      baseline
    }))
    if (captureResult && typeof captureResult.then === 'function') {
      Promise.resolve(captureResult).catch(() => {})
      const error = new Error('部分写入对账快照捕获不得异步执行')
      error.code = 'PARTIAL_RECONCILIATION_FAILED'
      error.safeBeforeWrite = true
      throw error
    }
  }
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
      noop,
      status: 'success-dry-run',
      counts: clone(plan.counts),
      lifecycleCounts,
      baseline,
      ...safetyDigests,
      records: clone(plan.plannedRecords),
      materials: options.materials || [],
      sourceNoteMaterials
    }
  }

  if (typeof targetClient.batchCreateRecords !== 'function' ||
      typeof targetClient.batchUpdateRecords !== 'function') {
    throw new Error('飞书 AI 数据底座同步缺少目标 Base 写客户端')
  }

  // 飞书多表没有事务。先确保不可变的出租周期和流水事件已落盘并回读，
  // 再改变当前状态；中途失败时下一轮按稳定事件 ID 只补缺口。
  await createSemanticRecords(
    targetClient,
    options.rentedTableId,
    rentedSnapshot,
    plan.archiveOperations,
    options
  )
  await createSemanticRecords(
    targetClient,
    options.historyTableId,
    historySnapshot,
    historyOperations,
    options
  )

  const rawRentedReadback = await targetClient.readValidatedTableSnapshot({
    tableId: options.rentedTableId,
    bindings: options.rentedBindings,
    allowEmpty: true,
    ...(mirrorMaterialValuesExcluded(options.materialPolicy)
      ? { excludedRecordSemantics: ['video'] }
      : {})
  })
  const rentedReadback = snapshotWithoutVideoFields(rawRentedReadback, options.materialPolicy)
  const historyReadback = await targetClient.readValidatedTableSnapshot({
    tableId: options.historyTableId,
    bindings: options.historyBindings,
    allowEmpty: true
  })
  const afterEventPlan = buildFoundationMirrorPlan({
    sourceSnapshot,
    mirrorSnapshot,
    rentedSnapshot: rentedReadback,
    locationCatalog,
    runId,
    nowMs,
    baseline
  })
  const afterEventHistory = lifecycleHistoryOperations(
    normalizedCurrent,
    afterEventPlan.operations,
    historyReadback,
    runId,
    nowMs,
    {
      archiveOperations: afterEventPlan.archiveOperations,
      rentedSnapshot: rentedReadback,
      suppressEvents: baseline
    }
  )
  if (afterEventPlan.archiveOperations.length || afterEventHistory.length) {
    const error = new Error('飞书出租周期或状态流水写后回读不一致，当前状态保持不变')
    error.statusCode = 502
    throw error
  }

  await writeFoundationCurrentRecords(
    targetClient,
    options.miniTableId,
    mirrorSnapshot,
    plan.operations,
    { ...options, runId, nowMs }
  )
  const rawMirrorReadback = await targetClient.readValidatedTableSnapshot({
    tableId: options.miniTableId,
    bindings: options.miniBindings,
    allowEmpty: false,
    ...(mirrorMaterialValuesExcluded(options.materialPolicy)
      ? { excludedRecordSemantics: ['video'] }
      : {})
  })
  const mirrorReadback = snapshotWithoutVideoFields(rawMirrorReadback, options.materialPolicy)
  const remainingPlan = buildFoundationMirrorPlan({
    sourceSnapshot,
    mirrorSnapshot: mirrorReadback,
    rentedSnapshot: rentedReadback,
    locationCatalog,
    runId,
    nowMs,
    baseline
  })
  const remainingHistory = lifecycleHistoryOperations(
    normalizedFoundationCurrentSnapshot(mirrorReadback, nowMs),
    remainingPlan.operations,
    historyReadback,
    runId,
    nowMs,
    {
      archiveOperations: remainingPlan.archiveOperations,
      rentedSnapshot: rentedReadback,
      suppressEvents: baseline
    }
  )
  if (remainingPlan.operations.length ||
      remainingPlan.archiveOperations.length ||
      remainingHistory.length) {
    const error = new Error('飞书 AI 数据底座当前状态写后回读不一致，已阻断库存与待租表发布')
    error.statusCode = 502
    throw error
  }

  let finalHistorySnapshot = historyReadback
  if (baseline) {
    await createSemanticRecords(
      targetClient,
      options.historyTableId,
      historyReadback,
      [baselineMarkerOperation],
      options
    )
    finalHistorySnapshot = await targetClient.readValidatedTableSnapshot({
      tableId: options.historyTableId,
      bindings: options.historyBindings,
      allowEmpty: false
    })
    if (!foundationBaselineCompleted(finalHistorySnapshot)) {
      const error = new Error('飞书 AI 数据底座初始化基线标记写后回读不一致')
      error.statusCode = 502
      throw error
    }
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
    noop,
    status: baseline ? 'success-baseline' : (noop ? 'success-noop' : 'success'),
    counts: clone(plan.counts),
    lifecycleCounts,
    baseline,
    ...safetyDigests,
    records: clone(remainingPlan.plannedRecords),
    materials: options.materials || [],
    sourceNoteMaterials
  }
}

function partialReconciliationError(message) {
  const error = new Error(message || '飞书部分写入只读对账失败')
  error.code = 'PARTIAL_RECONCILIATION_FAILED'
  error.statusCode = 409
  error.safeBeforeWrite = true
  return error
}

function normalizedExpectedOperationFields(snapshot, fields) {
  const bindings = snapshot && Array.isArray(snapshot.schemaBindings)
    ? snapshot.schemaBindings
    : []
  const source = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}
  if (!bindings.length) throw partialReconciliationError('部分写入对账缺少字段类型绑定')
  return bindings.slice().sort((left, right) => (
    normalizeText(left && left.semantic).localeCompare(normalizeText(right && right.semantic))
  )).reduce((result, binding) => {
    const semantic = normalizeText(binding && binding.semantic)
    const type = normalizeText(binding && binding.type)
    if (!semantic || !type || Object.prototype.hasOwnProperty.call(result, semantic)) {
      throw partialReconciliationError('部分写入对账字段类型绑定无效')
    }
    result[semantic] = Object.prototype.hasOwnProperty.call(source, semantic)
      ? clone(source[semantic])
      : (['4', '17'].includes(type) ? [] : '')
    return result
  }, {})
}

function indexedUniqueRecords(records, semantic, label) {
  const indexed = new Map()
  ;(records || []).forEach((record) => {
    const key = normalizeText(record && record.fields && record.fields[semantic])
    if (!key || indexed.has(key)) {
      throw partialReconciliationError(`部分写入对账${label}身份缺失或重复`)
    }
    indexed.set(key, record)
  })
  return indexed
}

function assertPartialPrefixMatchesOperations(snapshot, records, operations, semantic, label) {
  const actual = indexedUniqueRecords(records, semantic, label)
  const expected = new Map()
  ;(operations || []).forEach((operation) => {
    const key = normalizeText(
      operation && (operation[semantic] || (operation.fields && operation.fields[semantic]))
    )
    if (!key || expected.has(key)) {
      throw partialReconciliationError(`部分写入对账预期${label}身份缺失或重复`)
    }
    expected.set(key, operation)
  })
  if (actual.size !== expected.size || [...actual.keys()].some((key) => !expected.has(key))) {
    throw partialReconciliationError(`部分写入对账${label}身份集合不一致`)
  }
  for (const [key, record] of actual.entries()) {
    const expectedFields = normalizedExpectedOperationFields(snapshot, expected.get(key).fields)
    if (!secureDigestEqual(stableSha256(record.fields || {}), stableSha256(expectedFields))) {
      throw partialReconciliationError(`部分写入对账${label}字段不一致`)
    }
  }
}

function buildPartialBaseReconciliationEvidence(input = {}) {
  const run = input.run && typeof input.run === 'object' && !Array.isArray(input.run)
    ? input.run
    : {}
  const capture = input.capture && typeof input.capture === 'object' && !Array.isArray(input.capture)
    ? input.capture
    : {}
  const runId = normalizeText(run.runId)
  const runNowMs = Number(run.runNowMs)
  const expectedMirrorPlanSha256 = normalizeText(run.expectedMirrorPlanSha256).toLowerCase()
  const expectedSchemaSha256 = normalizeText(run.expectedSchemaSha256).toLowerCase()
  const expectedResourceIdentitySha256 = normalizeText(
    run.expectedResourceIdentitySha256
  ).toLowerCase()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(runId) ||
      !Number.isSafeInteger(runNowMs) || runNowMs <= 0 ||
      !/^[0-9a-f]{64}$/.test(expectedMirrorPlanSha256) ||
      !/^[0-9a-f]{64}$/.test(expectedSchemaSha256) ||
      !/^[0-9a-f]{64}$/.test(expectedResourceIdentitySha256)) {
    throw partialReconciliationError('部分写入对账缺少旧 run 的完整冻结证据')
  }
  const requiredSnapshots = [
    'sourceSnapshot',
    'locationSnapshot',
    'mirrorSnapshot',
    'rentedSnapshot',
    'historySnapshot'
  ]
  requiredSnapshots.forEach((key) => {
    const snapshot = capture[key]
    if (!snapshot || snapshot.complete !== true || !Array.isArray(snapshot.records) ||
        !Number.isSafeInteger(snapshot.recordCount) || !/^[0-9a-f]{64}$/.test(String(snapshot.digest || ''))) {
      throw partialReconciliationError(`部分写入对账缺少完整 ${key}`)
    }
  })
  if (capture.baseline === true) {
    throw partialReconciliationError('初始化基线任务不得使用部分写入解阻')
  }

  const locationCatalog = buildLocationCatalog(flattenLocationSnapshot(capture.locationSnapshot))
  const currentPlan = buildFoundationMirrorPlan({
    sourceSnapshot: capture.sourceSnapshot,
    mirrorSnapshot: capture.mirrorSnapshot,
    rentedSnapshot: capture.rentedSnapshot,
    locationCatalog,
    runId,
    nowMs: runNowMs,
    baseline: false
  })
  const normalizedCurrent = normalizedFoundationCurrentSnapshot(capture.mirrorSnapshot, runNowMs)
  const currentHistory = lifecycleHistoryOperations(
    normalizedCurrent,
    currentPlan.operations,
    capture.historySnapshot,
    runId,
    runNowMs,
    {
      archiveOperations: currentPlan.archiveOperations,
      rentedSnapshot: capture.rentedSnapshot,
      suppressEvents: false
    }
  )
  if (currentPlan.archiveOperations.length !== 0 || currentHistory.length !== 0) {
    throw partialReconciliationError('当前 Base 仍存在未落盘的归档或流水前缀')
  }
  const outstandingMainWriteCount = ['create', 'update', 'restore', 'deactivate']
    .reduce((sum, key) => sum + Number(currentPlan.counts && currentPlan.counts[key] || 0), 0)
  if (!Number.isSafeInteger(outstandingMainWriteCount) || outstandingMainWriteCount <= 0) {
    throw partialReconciliationError('当前 Base 没有可证明尚未推进的主表写计划')
  }

  const archiveRecords = capture.rentedSnapshot.records.filter((record) => (
    Number(record && record.fields && record.fields.archivedAt) === runNowMs
  ))
  const historyRecords = capture.historySnapshot.records.filter((record) => (
    normalizeText(record && record.fields && record.fields.runId) === runId
  ))
  const archiveRecordIds = new Set(archiveRecords.map((record) => record.recordId))
  const historyRecordIds = new Set(historyRecords.map((record) => record.recordId))
  const priorRentedSnapshot = rebuildValidatedTableSnapshot(
    capture.rentedSnapshot,
    capture.rentedSnapshot.records.filter((record) => !archiveRecordIds.has(record.recordId)),
    { includeCreatedTime: false }
  )
  const priorHistorySnapshot = rebuildValidatedTableSnapshot(
    capture.historySnapshot,
    capture.historySnapshot.records.filter((record) => !historyRecordIds.has(record.recordId)),
    { includeCreatedTime: false }
  )
  const priorPlan = buildFoundationMirrorPlan({
    sourceSnapshot: capture.sourceSnapshot,
    mirrorSnapshot: capture.mirrorSnapshot,
    rentedSnapshot: priorRentedSnapshot,
    locationCatalog,
    runId,
    nowMs: runNowMs,
    baseline: false
  })
  const priorHistory = lifecycleHistoryOperations(
    normalizedCurrent,
    priorPlan.operations,
    priorHistorySnapshot,
    runId,
    runNowMs,
    {
      archiveOperations: priorPlan.archiveOperations,
      rentedSnapshot: priorRentedSnapshot,
      suppressEvents: false
    }
  )
  assertPartialPrefixMatchesOperations(
    capture.rentedSnapshot,
    archiveRecords,
    priorPlan.archiveOperations,
    'archiveKey',
    '归档'
  )
  assertPartialPrefixMatchesOperations(
    capture.historySnapshot,
    historyRecords,
    priorHistory,
    'historyEventId',
    '流水'
  )
  const currentOperationsSha256 = stableSha256(operationsForPlanDigest(currentPlan.operations))
  const priorOperationsSha256 = stableSha256(operationsForPlanDigest(priorPlan.operations))
  if (!secureDigestEqual(currentOperationsSha256, priorOperationsSha256)) {
    throw partialReconciliationError('部分写入前后主表计划不一致')
  }

  const currentSafety = buildMirrorSafetyDigests({
    sourceSnapshot: capture.sourceSnapshot,
    locationSnapshot: capture.locationSnapshot,
    mirrorSnapshot: capture.mirrorSnapshot,
    rentedSnapshot: capture.rentedSnapshot,
    historySnapshot: capture.historySnapshot,
    resources: capture.resources,
    legacyMaterialEvidence: capture.legacyMaterialEvidence,
    operations: currentPlan.operations,
    archiveOperations: currentPlan.archiveOperations,
    historyOperations: currentHistory,
    baselineMarkerOperation: null,
    plannedRecords: currentPlan.plannedRecords
  })
  const priorSafety = buildMirrorSafetyDigests({
    sourceSnapshot: capture.sourceSnapshot,
    locationSnapshot: capture.locationSnapshot,
    mirrorSnapshot: capture.mirrorSnapshot,
    rentedSnapshot: priorRentedSnapshot,
    historySnapshot: priorHistorySnapshot,
    resources: capture.resources,
    legacyMaterialEvidence: capture.legacyMaterialEvidence,
    operations: priorPlan.operations,
    archiveOperations: priorPlan.archiveOperations,
    historyOperations: priorHistory,
    baselineMarkerOperation: null,
    plannedRecords: priorPlan.plannedRecords
  })
  if (!capture.safetyDigests ||
      !secureDigestEqual(currentSafety.schemaSha256, capture.safetyDigests.schemaSha256) ||
      !secureDigestEqual(currentSafety.resourceIdentitySha256, capture.safetyDigests.resourceIdentitySha256) ||
      !secureDigestEqual(currentSafety.mirrorPlanSha256, capture.safetyDigests.mirrorPlanSha256) ||
      !secureDigestEqual(priorSafety.schemaSha256, expectedSchemaSha256) ||
      !secureDigestEqual(priorSafety.resourceIdentitySha256, expectedResourceIdentitySha256) ||
      !secureDigestEqual(priorSafety.mirrorPlanSha256, expectedMirrorPlanSha256)) {
    throw partialReconciliationError('部分写入对账摘要未命中旧 run 权威 B')
  }

  const evidenceBody = {
    contract: 'feishu-partial-base-write-reconciliation-v1',
    runIdSha256: crypto.createHash('sha256').update(runId).digest('hex'),
    priorMirrorPlanSha256: priorSafety.mirrorPlanSha256,
    currentMirrorPlanSha256: currentSafety.mirrorPlanSha256,
    schemaSha256: currentSafety.schemaSha256,
    resourceIdentitySha256: currentSafety.resourceIdentitySha256,
    archiveCount: archiveRecords.length,
    historyCount: historyRecords.length,
    archiveEvidenceSha256: stableSha256(archiveRecords.map((record) => ({
      archiveKey: normalizeText(record.fields && record.fields.archiveKey),
      fields: stablePlanValue(record.fields || {})
    })).sort((left, right) => left.archiveKey.localeCompare(right.archiveKey))),
    historyEvidenceSha256: stableSha256(historyRecords.map((record) => ({
      historyEventId: normalizeText(record.fields && record.fields.historyEventId),
      fields: stablePlanValue(record.fields || {})
    })).sort((left, right) => left.historyEventId.localeCompare(right.historyEventId))),
    currentOperationsSha256,
    currentPlan: clone(currentPlan.counts)
  }
  return {
    ...evidenceBody,
    evidenceSha256: stableSha256(evidenceBody)
  }
}

async function reconcilePartialBaseWritesWithConfiguredSync(db, input = {}, configuredSync) {
  if (!db || typeof db !== 'object' || Array.isArray(db)) {
    throw partialReconciliationError('部分写入对账缺少业务数据库快照')
  }
  if (typeof configuredSync !== 'function') {
    throw partialReconciliationError('部分写入对账缺少正式 configured 同步入口')
  }
  const expectedKeys = [
    'externalWriteIntentAt',
    'expectedMirrorPlanSha256',
    'expectedResourceIdentitySha256',
    'expectedSchemaSha256',
    'runId',
    'runNowMs'
  ]
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedKeys.slice().sort())) {
    throw partialReconciliationError('部分写入对账输入字段不符合内部契约')
  }
  const externalWriteIntentAt = input.externalWriteIntentAt
  if (!Number.isSafeInteger(externalWriteIntentAt) ||
      !Number.isSafeInteger(input.runNowMs) ||
      externalWriteIntentAt < input.runNowMs) {
    throw partialReconciliationError('部分写入对账缺少有效首写时间')
  }
  const run = {
    runId: input.runId,
    runNowMs: input.runNowMs,
    expectedMirrorPlanSha256: input.expectedMirrorPlanSha256,
    expectedSchemaSha256: input.expectedSchemaSha256,
    expectedResourceIdentitySha256: input.expectedResourceIdentitySha256
  }
  const baselinePublishedSourceIds = activeFeishuSourceRecordIds(db)
  const baselinePublishedFoundationIdentityKeys = activeFeishuFoundationIdentityKeys(db)
  let feishuToken = ''
  const readRound = async () => {
    let captured = null
    let captureCount = 0
    const result = await configuredSync({
      dryRun: true,
      disableLegacyMaterials: true,
      runId: input.runId,
      nowMs: input.runNowMs,
      expectedSchemaSha256: input.expectedSchemaSha256,
      expectedResourceIdentitySha256: input.expectedResourceIdentitySha256,
      baselinePublishedSourceIds,
      baselinePublishedFoundationIdentityKeys,
      feishuToken,
      _capturePartialReconciliationState(value) {
        captureCount += 1
        captured = value
      }
    })
    feishuToken = result && result.feishuToken || feishuToken
    if (captureCount !== 1 || !captured || !result || result.complete !== true ||
        result.dryRun !== true || result.failed !== 0) {
      throw partialReconciliationError('部分写入对账未形成唯一完整只读快照')
    }
    const evidence = buildPartialBaseReconciliationEvidence({ run, capture: captured })
    if (!secureDigestEqual(evidence.currentMirrorPlanSha256, result.mirrorPlanSha256)) {
      throw partialReconciliationError('部分写入对账当前镜像摘要与正式 dry-run 不一致')
    }
    return evidence
  }
  const first = await readRound()
  const second = await readRound()
  if (!secureDigestEqual(first.evidenceSha256, second.evidenceSha256)) {
    throw partialReconciliationError('部分写入对账连续两次只读结果不一致')
  }
  return second
}

async function reconcilePartialBaseWrites(db, input = {}) {
  return reconcilePartialBaseWritesWithConfiguredSync(db, input, configuredMirrorTableSync)
}

function sourceNoteMaterialRows(sourceSnapshot = {}) {
  return (Array.isArray(sourceSnapshot.records) ? sourceSnapshot.records : []).map((record) => {
    const value = record && record.fields && record.fields.noteMaterialLink
    return {
      sourceRecordId: normalizeText(record && (record.recordId || record.record_id)),
      value: value === undefined ? null : clone(value)
    }
  })
}

function assertNoteMaterialSourceFieldPlan(options = {}, sourceFieldPlan = {}) {
  const hasHash = Object.prototype.hasOwnProperty.call(options, 'expectedSourceMaterialFieldSha256') &&
    options.expectedSourceMaterialFieldSha256 !== undefined
  const hasCount = Object.prototype.hasOwnProperty.call(options, 'expectedSourceMaterialFieldRecordCount') &&
    options.expectedSourceMaterialFieldRecordCount !== undefined
  if (hasHash !== hasCount) {
    throw mirrorSafetyDigestError(
      'NOTE_MATERIAL_SOURCE_FIELD_CHANGED',
      '房源笔记源字段确认摘要与数量不完整，已在写入前阻断'
    )
  }
  if (!hasHash) return
  const hash = normalizeText(options.expectedSourceMaterialFieldSha256).toLowerCase()
  const count = Number(options.expectedSourceMaterialFieldRecordCount)
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(count) || count < 0 ||
      !secureDigestEqual(hash, sourceFieldPlan.sourceMaterialFieldSha256) ||
      count !== sourceFieldPlan.sourceMaterialFieldRecordCount) {
    throw mirrorSafetyDigestError(
      'NOTE_MATERIAL_SOURCE_FIELD_CHANGED',
      '房源笔记源字段在素材确认后发生变化，已在写入前阻断'
    )
  }
}

function sourceBindingsWithNoteMaterial(bindings, options = {}) {
  const source = bindings && typeof bindings === 'object' && !Array.isArray(bindings)
    ? { ...bindings }
    : {}
  if (options.enabled !== true) return source
  const fieldId = normalizeText(options.fieldId)
  if (!fieldId) throw new Error('房源笔记稳定 field_id 未配置')
  source.noteMaterialLink = {
    fieldId,
    type: 15,
    required: false
  }
  return source
}

function noteMaterialFieldContractReady() {
  const fieldId = normalizeText(config.feishu.noteMaterialFieldId)
  if (!fieldId) return false
  try {
    const bindings = sourceBindingsWithNoteMaterial(config.feishu.sourceFieldBindings, {
      enabled: true,
      fieldId
    })
    const materialBinding = bindings.noteMaterialLink
    const allowedTypes = (MIRROR_FIELD_TYPE_CONTRACTS.source.noteMaterialLink || [])
      .map((value) => String(value))
    return normalizeText(materialBinding && materialBinding.fieldId) === fieldId &&
      String(materialBinding && materialBinding.type) === '15' &&
      allowedTypes.includes('15')
  } catch (_) {
    return false
  }
}

function mirrorMaterialPolicy(options = {}) {
  if (options.disableLegacyMaterials !== true) return 'enabled'
  return effectiveNoteMaterialSyncEnabled()
    ? NOTE_MANAGED_MATERIAL_POLICY
    : DISABLED_MATERIAL_POLICY
}

function mirrorMaterialValuesExcluded(materialPolicy = '') {
  return [DISABLED_MATERIAL_POLICY, NOTE_MANAGED_MATERIAL_POLICY].includes(materialPolicy)
}

function snapshotWithoutVideoFields(snapshot = {}, materialPolicy = '') {
  if (!mirrorMaterialValuesExcluded(materialPolicy) || !Array.isArray(snapshot.records)) return snapshot
  const records = snapshot.records.map((record) => {
    const fields = record && record.fields && typeof record.fields === 'object'
      ? { ...record.fields }
      : {}
    delete fields.video
    return { ...record, fields }
  })
  const schemaBindings = Array.isArray(snapshot.schemaBindings)
    ? snapshot.schemaBindings
    : null
  const fieldNames = snapshot.fieldNames && typeof snapshot.fieldNames === 'object'
    ? { ...snapshot.fieldNames }
    : null
  if (fieldNames && materialPolicy === DISABLED_MATERIAL_POLICY) delete fieldNames.video
  const sanitized = {
    ...snapshot,
    records,
    ...(schemaBindings ? { schemaBindings } : {}),
    ...(fieldNames ? { fieldNames } : {})
  }
  if (schemaBindings && schemaBindings.length) {
    return rebuildValidatedTableSnapshot(sanitized, records, {
      includeCreatedTime: records.some((record) => Object.prototype.hasOwnProperty.call(record, 'createdTimeMs'))
    })
  }
  const digestRecords = records.map((record) => ({
    recordId: normalizeText(record && (record.recordId || record.record_id)),
    fields: record && record.fields && typeof record.fields === 'object' ? record.fields : {},
    ...(Object.prototype.hasOwnProperty.call(record || {}, 'createdTimeMs')
      ? { createdTimeMs: record.createdTimeMs }
      : {})
  })).sort((left, right) => left.recordId.localeCompare(right.recordId))
  return { ...sanitized, digest: stableSha256(digestRecords) }
}

async function executeMirrorTableSync(options = {}) {
  const legacyMaterialEvidence = options.legacyMaterialEvidence
    ? normalizeLegacyMaterialEvidence(options.legacyMaterialEvidence)
    : await buildLegacyMaterialEvidence(options.materials || [], {
      enabled: options.legacyMaterialSourceConfigured === true
    })
  options = { ...options, legacyMaterialEvidence }
  assertLifecycleTableResourcesDistinct(options)
  const sourceClient = options.sourceClient || options.client
  const targetClient = options.targetClient || options.client
  if (!sourceClient || typeof sourceClient.readValidatedTableSnapshot !== 'function') {
    throw new Error('飞书镜像同步缺少员工源 Base 只读客户端')
  }
  if (!targetClient || typeof targetClient.readValidatedTableSnapshot !== 'function') {
    throw new Error('飞书镜像同步缺少小程序目标 Base 只读客户端')
  }
  externalWriteOptions(options)
  if (options.dryRun !== true && typeof options.onExternalWriteDispatched === 'function' &&
      targetClient.writeDispatchEvidenceVersion !== 1) {
    const error = new Error('飞书目标 Base 客户端缺少精确写派发证据')
    error.code = 'TARGET_WRITE_DISPATCH_EVIDENCE_REQUIRED'
    error.statusCode = 503
    error.safeBeforeWrite = true
    throw error
  }
  const nowMs = options.nowMs == null ? Date.now() : Number(options.nowMs)
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('飞书同步 nowMs 必须是正整数毫秒时间戳')
  const runId = normalizeText(options.runId) || `mirror-${nowMs}-${Math.floor(Math.random() * 100000)}`
  const foundationProfile = aiFoundationProfileEnabled(options.sourceCompatibilityProfile)
  const sourceBindings = options.sourceBindings
  const miniBindings = options.miniBindings
  const excludedVideoReadOption = mirrorMaterialValuesExcluded(options.materialPolicy)
    ? { excludedRecordSemantics: ['video'] }
    : {}
  const rawSourceSnapshot = await sourceClient.readValidatedTableSnapshot({
    tableId: options.sourceTableId,
    bindings: sourceBindings,
    allowEmpty: false,
    requireCreatedTime: foundationProfile,
    ...(foundationProfile ? { createdTimeCutoffMs: nowMs } : {}),
    ...excludedVideoReadOption
  })
  const locationSnapshot = await targetClient.readValidatedTableSnapshot({
    tableId: options.locationTableId,
    bindings: options.locationBindings,
    allowEmpty: false
  })
  const locationCatalog = buildLocationCatalog(flattenLocationSnapshot(locationSnapshot))
  const inventoryRawSourceSnapshot = snapshotWithoutVideoFields(rawSourceSnapshot, options.materialPolicy)
  const sourceSnapshot = prepareSourceSnapshotForCompatibility(inventoryRawSourceSnapshot, {
    profile: options.sourceCompatibilityProfile,
    sourceBindings,
    locationCatalog
  })
  const rawSourceNoteMaterials = options.noteMaterialSyncEnabled === true
    ? sourceNoteMaterialRows(sourceSnapshot)
    : []
  const rawMirrorSnapshot = await targetClient.readValidatedTableSnapshot({
    tableId: options.miniTableId,
    bindings: miniBindings,
    allowEmpty: true,
    ...excludedVideoReadOption
  })
  // 原始员工源快照已在兼容投影前完成 video 排除；兼容层随后会补 listingStatus、rentMode 等
  // 业务语义并生成自己的去视频摘要，不能再按原始 Base schemaBindings 重建第二次。
  const inventorySourceSnapshot = sourceSnapshot
  const mirrorSnapshot = snapshotWithoutVideoFields(rawMirrorSnapshot, options.materialPolicy)
  if (foundationProfile) {
    const rawRentedSnapshot = await targetClient.readValidatedTableSnapshot({
      tableId: options.rentedTableId,
      bindings: options.rentedBindings,
      allowEmpty: true,
      ...excludedVideoReadOption
    })
    const rentedSnapshot = snapshotWithoutVideoFields(rawRentedSnapshot, options.materialPolicy)
    const historySnapshot = await targetClient.readValidatedTableSnapshot({
      tableId: options.historyTableId,
      bindings: options.historyBindings,
      allowEmpty: true
    })
    const foundationResult = await executeAiFoundationSync({
      targetClient,
      sourceSnapshot: inventorySourceSnapshot,
      locationSnapshot,
      mirrorSnapshot,
      rentedSnapshot,
      historySnapshot,
      locationCatalog,
      options: {
        ...options,
        sourceBindings,
        miniBindings,
        sourceNoteMaterials: rawSourceNoteMaterials
      },
      runId,
      nowMs
    })
    return foundationResult
  }
  const hasExplicitVacancyNote = Object.prototype.hasOwnProperty.call(
    options.sourceBindings && typeof options.sourceBindings === 'object' ? options.sourceBindings : {},
    'vacancyNote'
  )
  const ignoreVacancyNote = !hasExplicitVacancyNote
  const plan = planMirrorSync({
    sourceSnapshot: inventorySourceSnapshot,
    mirrorSnapshot,
    locationCatalog,
    runId,
    ignoreVacancyNote
  })
  const plannedRecords = activeMirrorRecords({
    records: plannedActiveMirrorRecords(inventorySourceSnapshot, mirrorSnapshot, plan)
  })
  const sourceNoteMaterials = options.noteMaterialSyncEnabled === true
    ? activeSourceNoteMaterialRows(rawSourceNoteMaterials, plannedRecords)
    : []
  assertNoteMaterialSourceFieldPlan(
    options,
    buildNoteMaterialSourceFieldPlan(sourceNoteMaterials)
  )
  validateCanonicalMirrorRecords(plannedRecords, { materialPolicy: options.materialPolicy })
  assertMirrorDeactivateSafety(mirrorSnapshot, plannedRecords, {
    baselinePublishedSourceIds: options.baselinePublishedSourceIds,
    maxDeactivateCount: options.maxDeactivateCount,
    maxDeactivateRatio: options.maxDeactivateRatio,
    allowMassDeactivate: options.allowMassDeactivate === true
  })

  const safetyDigests = buildMirrorSafetyDigests({
    sourceSnapshot: inventorySourceSnapshot,
    locationSnapshot,
    mirrorSnapshot,
    resources: mirrorSafetyResources(options),
    legacyMaterialEvidence: options.legacyMaterialEvidence,
    operations: plan.operations,
    plannedRecords
  })
  assertMirrorSafetyDigestConfirmation(options, safetyDigests)

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
      ...safetyDigests,
      records: plannedRecords,
      materials: options.materials || []
      ,
      sourceNoteMaterials
    }
  }

  if (typeof targetClient.batchCreateRecords !== 'function' ||
      typeof targetClient.batchUpdateRecords !== 'function') {
    throw new Error('飞书镜像同步缺少小程序目标 Base 写客户端')
  }

  const creates = plan.operations.filter((operation) => operation.type === 'create')
  const updates = plan.operations.filter((operation) => operation.type !== 'create')
  // AI 数据底座启用后若误切回旧 profile，环境中可能仍保留 18 个内部字段绑定。
  // 旧镜像只能管理原业务列；即便本轮有普通业务更新，也不得以 full write 把底座列清空。
  const writableFieldNames = legacyMirrorFieldNames(mirrorSnapshot.fieldNames, sourceBindings)
  for (const batch of chunksOf(creates)) {
    await targetClient.batchCreateRecords(options.miniTableId, batch.map((operation) => ({
      fields: semanticFieldsForCreate(writableFieldNames, operation.fields)
    })), {
      clientToken: crypto.randomUUID(),
      ...externalWriteOptions(options)
    })
  }
  for (const batch of chunksOf(updates)) {
    const records = batch.map((operation) => (
      semanticUpdateRecordForWrite(mirrorSnapshot, writableFieldNames, operation)
    ))
    await targetClient.batchUpdateRecords(options.miniTableId, records, {
      clientToken: stableUpdateClientToken(options.miniTableId, records, {
        phase: 'legacy-current',
        runId,
        runNowMs: nowMs
      }),
      ...externalWriteOptions(options)
    })
  }

  const rawReadback = await targetClient.readValidatedTableSnapshot({
    tableId: options.miniTableId,
    bindings: miniBindings,
    allowEmpty: false,
    ...excludedVideoReadOption
  })
  const readback = snapshotWithoutVideoFields(rawReadback, options.materialPolicy)
  const remainingPlan = planMirrorSync({
    sourceSnapshot: inventorySourceSnapshot,
    mirrorSnapshot: readback,
    locationCatalog,
    runId: `${runId}-readback`,
    ignoreVacancyNote
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
    ...safetyDigests,
    records: activeMirrorRecords(readback),
    materials: options.materials || []
    ,
    sourceNoteMaterials
  }
}

async function loadConfiguredMirrorMaterials(token, options = {}) {
  if (options.disableLegacyMaterials === true) return []
  if (Array.isArray(options.materials)) return options.materials
  if (config.feishu.materialsFile) return readJson(config.feishu.materialsFile)
  if (config.feishu.folderToken) return loadFolderMaterials(token, config.feishu.folderToken)
  return []
}

async function configuredMirrorTableSync(options = {}) {
  assertMirrorConfiguration()
  const token = options.feishuToken || await tenantAccessToken()
  const clientFactory = options.clientFactory || createBitableClient
  const sourceBaseToken = normalizeResourceIdentifier(config.feishu.sourceBitableAppToken)
  const targetBaseToken = normalizeResourceIdentifier(config.feishu.targetBitableAppToken)
  const sourceTableId = normalizeResourceIdentifier(config.feishu.sourceTableId)
  const miniTableId = normalizeResourceIdentifier(config.feishu.miniTableId)
  const locationTableId = normalizeResourceIdentifier(config.feishu.locationTableId)
  const rentedTableId = normalizeResourceIdentifier(config.feishu.rentedTableId)
  const historyTableId = normalizeResourceIdentifier(config.feishu.historyTableId)
  const commonClientOptions = {
    baseUrl: config.feishu.baseUrl,
    accessToken: token,
    pageSize: config.feishu.pageSize,
    requestTimeoutMs: config.feishu.requestTimeoutMs,
    maxRetries: config.feishu.requestMaxRetries,
    retryDelayMs: config.feishu.requestRetryDelayMs,
    fetchImpl: fetch
  }
  const employeeSourceProfile = [
    EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
    EMPLOYEE_AI_FOUNDATION_PROFILE
  ].includes(config.feishu.sourceCompatibilityProfile)
  const noteMaterialSyncEnabled = config.feishu.noteMaterialSyncEnabled === true && employeeSourceProfile
  // 新“房源笔记”确定性管线是 worker-v2 唯一允许的素材写通道。启用它或由 worker-v2
  // 发起时，旧目录/本地清单不得再参与匹配、随机 OSS 上传或数据库视频地址写入。
  const disableLegacyMaterials = noteMaterialSyncEnabled || options.disableLegacyMaterials === true
  const materialPolicy = mirrorMaterialPolicy({ disableLegacyMaterials })
  const legacyMaterialSourceConfigured = !disableLegacyMaterials && (
    Array.isArray(options.materials) || Boolean(config.feishu.materialsFile || config.feishu.folderToken)
  )
  const sourceClient = options.sourceClient || options.client || clientFactory({
    ...commonClientOptions,
    appToken: sourceBaseToken,
    readOnly: true
  })
  // 即便 legacy 配置的源、目标仍在同一 Base，也必须把读源与写目标拆成两只客户端。
  // 复用硬只读源客户端会让正式同步首个目标写请求固定失败；把源客户端改回可写又会破坏只读边界。
  const targetClient = options.targetClient || options.client || clientFactory({
    ...commonClientOptions,
    appToken: targetBaseToken
  })
  const materials = await loadConfiguredMirrorMaterials(token, {
    ...options,
    disableLegacyMaterials
  })
  const legacyMaterialEvidence = await buildLegacyMaterialEvidence(materials, {
    enabled: legacyMaterialSourceConfigured
  })
  const configuredSourceBindings = sourceBindingsWithNoteMaterial(config.feishu.sourceFieldBindings, {
    enabled: noteMaterialSyncEnabled,
    fieldId: config.feishu.noteMaterialFieldId
  })
  const sourceBindings = resolvedContractBindings('source', configuredSourceBindings, {
    sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
  })
  const miniBindings = resolvedContractBindings('mini', config.feishu.miniFieldBindings, {
    sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
  })
  const locationBindings = resolvedContractBindings('location', config.feishu.locationFieldBindings)
  const aiFoundationEnabled = aiFoundationProfileEnabled(config.feishu.sourceCompatibilityProfile)
  const rentedBindings = aiFoundationEnabled
    ? resolvedContractBindings('rented', config.feishu.rentedFieldBindings, {
      sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
    })
    : {}
  const historyBindings = aiFoundationEnabled
    ? resolvedContractBindings('history', config.feishu.historyFieldBindings, {
      sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
    })
    : {}
  const result = await executeMirrorTableSync({
    sourceClient,
    targetClient,
    sourceTableId,
    miniTableId,
    locationTableId,
    rentedTableId,
    historyTableId,
    sourceBindings,
    sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile,
    miniBindings,
    locationBindings,
    rentedBindings,
    historyBindings,
    maxDeactivateCount: config.feishu.mirrorMaxDeactivateCount,
    maxDeactivateRatio: config.feishu.mirrorMaxDeactivateRatio,
    allowMassDeactivate: config.feishu.mirrorAllowMassDeactivate,
    baselinePublishedSourceIds: options.baselinePublishedSourceIds,
    baselinePublishedFoundationIdentityKeys: options.baselinePublishedFoundationIdentityKeys,
    dryRun: options.dryRun === true,
    nowMs: options.nowMs,
    runId: options.runId,
    expectedSchemaSha256: options.expectedSchemaSha256,
    expectedResourceIdentitySha256: options.expectedResourceIdentitySha256,
    expectedMirrorPlanSha256: options.expectedMirrorPlanSha256,
    expectedSourceMaterialFieldSha256: options.expectedSourceMaterialFieldSha256,
    expectedSourceMaterialFieldRecordCount: options.expectedSourceMaterialFieldRecordCount,
    onExternalWriteDispatched: options.onExternalWriteDispatched,
    _capturePartialReconciliationState: options._capturePartialReconciliationState,
    mirrorSafetyResources: {
      sourceBaseToken,
      targetBaseToken,
      sourceTableId,
      miniTableId,
      locationTableId,
      rentedTableId,
      historyTableId,
      feishuApiBaseUrl: config.feishu.baseUrl,
      legacyMaterialFolderToken: config.feishu.folderToken,
      noteMaterialSyncEnabled,
      noteMaterialTargetRootFolderToken: config.feishu.noteMaterialTargetRootFolderToken,
      noteMaterialAllowedHosts: config.feishu.noteMaterialAllowedHosts,
      uploadToOss: config.feishu.uploadToOss === true,
      ossBucket: config.oss.bucket,
      ossRegion: config.oss.region,
      ossUploadDir: config.oss.uploadDir,
      ossPublicBaseUrl: config.oss.publicBaseUrl || (
        config.oss.bucket && config.oss.region
          ? `https://${config.oss.bucket}.${config.oss.region}.aliyuncs.com`
          : config.oss.homeUrl
      )
    },
    materials,
    legacyMaterialSourceConfigured,
    legacyMaterialEvidence,
    noteMaterialSyncEnabled,
    materialPolicy
  })
  const output = { ...result, feishuToken: token }
  Object.defineProperty(output, MIRROR_NOTE_TARGET_CONTEXT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: {
      targetClient,
      targetBaseToken,
      miniTableId,
      miniBindings,
      plannedCreateSourceRecordFingerprints: new Set(
        result && result.dryRun === true && Array.isArray(result.records)
          ? result.records
              .filter((record) => /^dry-run-/.test(normalizeText(record && record.recordId)))
              .map((record) => privateTextSha256(
                record && record.fields && record.fields.sourceRecordId
              ))
          : []
      )
    }
  })
  return output
}

async function configuredFoundationEnrichment(options = {}) {
  const resources = assertFoundationEnrichmentConfiguration()
  const targetBaseToken = resources.targetBaseToken
  const miniTableId = resources.miniTableId
  const historyTableId = resources.historyTableId
  const miniBindings = resolvedContractBindings('mini', config.feishu.miniFieldBindings, {
    sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
  })
  const historyBindings = resolvedContractBindings('history', config.feishu.historyFieldBindings, {
    sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile
  })
  const token = options.feishuToken || await tenantAccessToken()
  const clientFactory = options.clientFactory || createBitableClient
  const targetClient = options.targetClient || clientFactory({
    baseUrl: config.feishu.baseUrl,
    accessToken: token,
    appToken: targetBaseToken,
    pageSize: config.feishu.pageSize,
    requestTimeoutMs: config.feishu.requestTimeoutMs,
    maxRetries: config.feishu.requestMaxRetries,
    retryDelayMs: config.feishu.requestRetryDelayMs,
    fetchImpl: fetch
  })
  return executeFoundationEnrichment({
    targetClient,
    targetBaseToken,
    miniTableId,
    miniBindings,
    historyTableId,
    historyBindings,
    privateMappings: options.privateMappings,
    mappingSha256: options.mappingSha256,
    confirmPlanSha256: options.confirmPlanSha256,
    runId: options.runId,
    nowMs: options.nowMs,
    dryRun: options.dryRun !== false
  })
}

function effectiveNoteMaterialSyncEnabled() {
  return config.feishu.noteMaterialSyncEnabled === true &&
    [
      EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
      EMPLOYEE_AI_FOUNDATION_PROFILE
    ].includes(config.feishu.sourceCompatibilityProfile)
}

function contentPlanConfirmationRequired() {
  return config.feishu.mirrorSyncEnabled === true && effectiveNoteMaterialSyncEnabled()
}

function contentPlanConfirmationError(message, statusCode = 409) {
  const error = new Error(message)
  error.name = 'ContentPlanConfirmationError'
  error.code = 'CONTENT_PLAN_CONFIRMATION_FAILED'
  error.statusCode = statusCode
  return error
}

function validatedExpectedContentPlan(options = {}, required = true) {
  const hasHash = Object.prototype.hasOwnProperty.call(options, 'expectedContentPlanSha256') &&
    options.expectedContentPlanSha256 !== undefined
  const hasCount = Object.prototype.hasOwnProperty.call(options, 'expectedContentAssetCount') &&
    options.expectedContentAssetCount !== undefined
  if (hasHash !== hasCount) {
    throw contentPlanConfirmationError('素材内容计划确认摘要与数量必须同时提供', 400)
  }
  if (!hasHash) {
    if (required) throw contentPlanConfirmationError('正式飞书同步缺少素材内容计划确认', 400)
    return null
  }
  if (typeof options.expectedContentPlanSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(options.expectedContentPlanSha256)) {
    throw contentPlanConfirmationError('expectedContentPlanSha256 必须是 64 位小写十六进制摘要', 400)
  }
  if (!Number.isSafeInteger(options.expectedContentAssetCount) ||
      options.expectedContentAssetCount < 0) {
    throw contentPlanConfirmationError('expectedContentAssetCount 必须是非负安全整数', 400)
  }
  return {
    expectedContentPlanSha256: options.expectedContentPlanSha256,
    expectedContentAssetCount: options.expectedContentAssetCount
  }
}

async function prepareMirrorContentPlanConfirmation(input = {}) {
  const expected = validatedExpectedContentPlan(input, true)
  if (typeof input.runPreflight !== 'function') {
    throw contentPlanConfirmationError('正式飞书同步缺少素材内容只读预检器', 500)
  }
  const cachedConfirmation = typeof input.loadCachedConfirmation === 'function'
    ? await input.loadCachedConfirmation(expected)
    : recallContentPlanConfirmation(
        expected.expectedContentPlanSha256,
        expected.expectedContentAssetCount
      )
  if (!cachedConfirmation ||
      cachedConfirmation.expectedContentPlanSha256 !== expected.expectedContentPlanSha256 ||
      cachedConfirmation.expectedContentAssetCount !== expected.expectedContentAssetCount ||
      !/^[0-9a-f]{64}$/.test(String(cachedConfirmation.expectedSourceMaterialFieldSha256 || '')) ||
      !Number.isSafeInteger(cachedConfirmation.expectedSourceMaterialFieldRecordCount) ||
      cachedConfirmation.expectedSourceMaterialFieldRecordCount < 0 ||
      !Array.isArray(cachedConfirmation.expectedContentPlanEvidence)) {
    throw contentPlanConfirmationError('素材内容计划的私有确认已过期，请重新完成两次 dry-run 后再正式同步', 409)
  }
  const preflight = await input.runPreflight({
    db: input.db,
    adminId: input.adminId,
    runId: input.runId,
    nowMs: input.nowMs,
    expectedContentPlanSha256: expected.expectedContentPlanSha256,
    expectedContentAssetCount: expected.expectedContentAssetCount,
    expectedContentPlanEvidence: cachedConfirmation.expectedContentPlanEvidence,
    expectedDeferredMaterialEvidence: Array.isArray(cachedConfirmation.expectedDeferredMaterialEvidence)
      ? cachedConfirmation.expectedDeferredMaterialEvidence
      : [],
    expectedSourceMaterialFieldSha256: cachedConfirmation.expectedSourceMaterialFieldSha256,
    expectedSourceMaterialFieldRecordCount: cachedConfirmation.expectedSourceMaterialFieldRecordCount,
    verifyExpectedContentPlan: true
  })
  const preflightAccepted = preflight && (
    preflight.complete === true || isKnownMaterialRowWarningReport(preflight, { dryRun: true })
  )
  if (!preflightAccepted || preflight.dryRun !== true ||
      preflight.sourcesGloballyVerified !== true ||
      preflight.contentPlanSha256 !== expected.expectedContentPlanSha256 ||
      preflight.contentPlanAssetCount !== expected.expectedContentAssetCount) {
    throw contentPlanConfirmationError('正式飞书同步只读预检与已确认素材内容计划不一致')
  }
  const privateConfirmation = preflight.privateConfirmation
  if (!privateConfirmation ||
      privateConfirmation.expectedContentPlanSha256 !== expected.expectedContentPlanSha256 ||
      privateConfirmation.expectedContentAssetCount !== expected.expectedContentAssetCount ||
      privateConfirmation.expectedSourceMaterialFieldSha256 !==
        cachedConfirmation.expectedSourceMaterialFieldSha256 ||
      privateConfirmation.expectedSourceMaterialFieldRecordCount !==
        cachedConfirmation.expectedSourceMaterialFieldRecordCount ||
      !Array.isArray(privateConfirmation.expectedContentPlanEvidence)) {
    throw contentPlanConfirmationError('正式飞书同步只读预检缺少同次行级内容计划')
  }
  return {
    ...expected,
    expectedContentPlanEvidence: privateConfirmation.expectedContentPlanEvidence,
    expectedDeferredMaterialEvidence: Array.isArray(privateConfirmation.expectedDeferredMaterialEvidence)
      ? privateConfirmation.expectedDeferredMaterialEvidence
      : [],
    expectedSourceMaterialFieldSha256: privateConfirmation.expectedSourceMaterialFieldSha256,
    expectedSourceMaterialFieldRecordCount: privateConfirmation.expectedSourceMaterialFieldRecordCount,
    sourcesGloballyVerified: true
  }
}

function fixedMirrorRunCoordinates(options = {}) {
  const nowMs = options.nowMs == null ? Date.now() : Number(options.nowMs)
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw contentPlanConfirmationError('飞书同步 nowMs 必须是正整数毫秒时间戳', 400)
  }
  const runId = normalizeText(options.runId) ||
    `mirror-${nowMs}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  return { runId, nowMs }
}

function noteMaterialRunTime(options = {}) {
  const nowMs = Number(options.nowMs)
  return Number.isSafeInteger(nowMs) && nowMs > 0
    ? new Date(nowMs).toISOString()
    : nowText()
}

function adapterImplements(adapter, methods) {
  return Boolean(adapter) && methods.every((method) => typeof adapter[method] === 'function')
}

function strictPrivateSha256(value, label) {
  const normalized = normalizeText(value)
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label}无效`)
  return normalized
}

function privateTextSha256(value) {
  return crypto.createHash('sha256').update(normalizeText(value)).digest('hex')
}

function privateNoteTargetState(listing = {}) {
  const noteState = listing.noteMaterialState && typeof listing.noteMaterialState === 'object' &&
    !Array.isArray(listing.noteMaterialState)
    ? listing.noteMaterialState
    : {}
  const state = noteState.primaryTargetAttachment
  if (state === undefined || state === null) return null
  if (!state || typeof state !== 'object' || Array.isArray(state) || Number(state.version) !== 1) {
    throw new Error('房源主视频目标附件私有状态无效')
  }
  const size = Number(state.size)
  const contentType = normalizeText(state.contentType).toLowerCase().split(';')[0]
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('房源主视频目标附件私有大小无效')
  if (!/^video\//.test(contentType)) throw new Error('房源主视频目标附件私有类型无效')
  return {
    version: 1,
    sourceRecordFingerprint: strictPrivateSha256(
      state.sourceRecordFingerprint,
      '房源主视频源记录私有指纹'
    ),
    physicalUnitFingerprint: strictPrivateSha256(
      state.physicalUnitFingerprint,
      '房源主视频物理房源私有指纹'
    ),
    targetRecordFingerprint: strictPrivateSha256(
      state.targetRecordFingerprint,
      '房源主视频目标记录私有指纹'
    ),
    attachmentTokenFingerprint: strictPrivateSha256(
      state.attachmentTokenFingerprint,
      '房源主视频附件 token 私有指纹'
    ),
    contentSha256: strictPrivateSha256(
      state.contentSha256,
      '房源主视频内容私有摘要'
    ),
    size,
    contentType
  }
}

function targetAttachmentExtra(attachment = {}) {
  const direct = normalizeText(attachment.extra)
  if (direct) return direct
  for (const key of ['tmp_url', 'url', 'download_url']) {
    const value = normalizeText(attachment[key])
    if (!value) continue
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue
      const extra = normalizeText(parsed.searchParams.get('extra'))
      if (extra) return extra
    } catch (_) {}
  }
  return ''
}

function targetVideoAttachments(value) {
  if (value === undefined || value === null || value === '') return []
  const values = Array.isArray(value) ? value : [value]
  if (values.length > 1) throw new Error('小程序专用表同一房源存在多个主视频附件')
  return values.map((attachment) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw new Error('小程序专用表主视频附件结构无效')
    }
    const token = normalizeText(
      attachment.file_token || attachment.token || attachment.obj_token
    )
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(token)) {
      throw new Error('小程序专用表主视频附件缺少稳定 token')
    }
    const size = Number(attachment.size)
    const rawContentType = normalizeText(
      attachment.mime_type || attachment.mimeType || attachment.type || attachment.file_type
    ).toLowerCase().split(';')[0]
    const contentType = rawContentType.includes('/') ? rawContentType : ''
    return {
      token,
      tokenFingerprint: privateTextSha256(token),
      extra: targetAttachmentExtra(attachment),
      size: Number.isSafeInteger(size) && size > 0 ? size : null,
      contentType
    }
  })
}

function activeSourceNoteMaterialRows(sourceRows, activeRecords) {
  const rowBySourceId = new Map()
  for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
    const sourceRecordId = normalizeText(row && row.sourceRecordId)
    if (!sourceRecordId || rowBySourceId.has(sourceRecordId)) {
      throw new Error('房源笔记源记录 ID 缺失或重复')
    }
    rowBySourceId.set(sourceRecordId, row)
  }
  const activeSourceIds = new Set()
  for (const record of Array.isArray(activeRecords) ? activeRecords : []) {
    const sourceRecordId = normalizeText(record && record.fields && record.fields.sourceRecordId)
    if (!sourceRecordId || activeSourceIds.has(sourceRecordId) || !rowBySourceId.has(sourceRecordId)) {
      throw new Error('在租房源笔记无法唯一绑定员工源记录')
    }
    activeSourceIds.add(sourceRecordId)
  }
  return (Array.isArray(sourceRows) ? sourceRows : []).filter((row) => (
    activeSourceIds.has(normalizeText(row && row.sourceRecordId))
  ))
}

function assertTargetVideoSnapshotContract(snapshot, context) {
  if (!snapshot || !Array.isArray(snapshot.records) ||
      !snapshot.fieldNames || typeof snapshot.fieldNames !== 'object' ||
      !Array.isArray(snapshot.schemaBindings)) {
    throw new Error('小程序专用表主视频快照不完整')
  }
  const videoSchemas = snapshot.schemaBindings.filter((binding) => (
    normalizeText(binding && binding.semantic) === 'video'
  ))
  const videoFieldName = normalizeText(snapshot.fieldNames.video)
  if (videoSchemas.length !== 1 || String(videoSchemas[0].type) !== '17' ||
      !videoFieldName || normalizeText(videoSchemas[0].fieldName) !== videoFieldName ||
      normalizeText(context.miniBindings && context.miniBindings.video &&
        context.miniBindings.video.fieldId) !== normalizeText(
        config.feishu.miniFieldBindings && config.feishu.miniFieldBindings.video && (
          config.feishu.miniFieldBindings.video.fieldId ||
          config.feishu.miniFieldBindings.video.field_id
        )
      )) {
    throw new Error('小程序专用表主视频 type17 字段合同漂移')
  }
}

async function readNoteTargetVideoState(context, sourceRecordId, physicalUnitFingerprint) {
  const trustedPlannedCreate = context.dryRun === true &&
    context.plannedCreateSourceRecordFingerprints instanceof Set &&
    context.plannedCreateSourceRecordFingerprints.has(privateTextSha256(sourceRecordId))
  const snapshot = await context.targetClient.readValidatedTableSnapshot({
    tableId: context.miniTableId,
    bindings: context.miniBindings,
    allowEmpty: trustedPlannedCreate
  })
  assertTargetVideoSnapshotContract(snapshot, context)
  const matches = snapshot.records.filter((record) => (
    normalizeText(record && record.fields && record.fields.sourceRecordId) === sourceRecordId
  ))
  if (matches.length === 0 && trustedPlannedCreate) {
    return {
      recordId: '',
      targetRecordFingerprint: '',
      videoFieldName: normalizeText(snapshot.fieldNames.video),
      attachments: [],
      plannedCreate: true,
      expectedStateKey: stableSha256({
        sourceRecordFingerprint: privateTextSha256(sourceRecordId),
        physicalUnitFingerprint,
        plannedCreate: true
      })
    }
  }
  if (matches.length !== 1) throw new Error('小程序专用表主视频无法唯一命中房源记录')
  const record = matches[0]
  const recordId = normalizeText(record.recordId || record.record_id)
  if (!recordId) throw new Error('小程序专用表主视频目标记录 ID 无效')
  const attachments = targetVideoAttachments(record.fields && record.fields.video)
  const targetRecordFingerprint = privateTextSha256(recordId)
  return {
    recordId,
    targetRecordFingerprint,
    videoFieldName: normalizeText(snapshot.fieldNames.video),
    attachments,
    expectedStateKey: stableSha256({
      sourceRecordFingerprint: privateTextSha256(sourceRecordId),
      physicalUnitFingerprint,
      targetRecordFingerprint,
      attachmentTokenFingerprints: attachments.map((item) => item.tokenFingerprint)
    })
  }
}

function createNotePrimaryVideoAttachmentAdapter(options = {}) {
  const context = options.context && typeof options.context === 'object' ? options.context : {}
  const listing = options.listing
  const sourceRecordId = normalizeText(options.sourceRecordId)
  const expectedLocalStateKey = normalizeText(options.expectedLocalStateKey)
  const physicalUnitFingerprint = strictPrivateSha256(
    options.physicalUnitFingerprint,
    '房源主视频物理身份指纹'
  )
  if (!listing || !sourceRecordId || typeof options.localStateKey !== 'function' ||
      typeof options.currentPhysicalUnitFingerprint !== 'function' ||
      !adapterImplements(context.targetClient, ['readValidatedTableSnapshot', 'batchUpdateRecords']) ||
      context.targetClient.writeDispatchEvidenceVersion !== 1 ||
      !adapterImplements(context.drive, [
        'uploadBitableFileDescriptor',
        'downloadTokenDigestExact'
      ])) {
    throw new Error('小程序专用表主视频适配器配置不完整')
  }
  const targetBaseToken = normalizeResourceIdentifier(context.targetBaseToken)
  const miniTableId = normalizeResourceIdentifier(context.miniTableId)
  const runId = normalizeText(context.runId) ||
    `note-target-${stableSha256(sourceRecordId).slice(0, 24)}`
  const nowMs = Number(context.nowMs || Date.now())
  if (!targetBaseToken || !miniTableId || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error('小程序专用表主视频资源坐标无效')
  }

  function assertLocalStateUnchanged() {
    if (normalizeText(options.localStateKey(listing)) !== expectedLocalStateKey ||
        normalizeText(options.currentPhysicalUnitFingerprint(listing)) !== physicalUnitFingerprint) {
      const error = new Error('房源主视频本地状态在目标附件同步期间发生变化')
      error.statusCode = 409
      throw error
    }
  }

  function managedStateMatchesTarget(managed, targetState) {
    return Boolean(managed) &&
      managed.sourceRecordFingerprint === privateTextSha256(sourceRecordId) &&
      managed.physicalUnitFingerprint === physicalUnitFingerprint &&
      managed.targetRecordFingerprint === targetState.targetRecordFingerprint &&
      targetState.attachments.length === 1 &&
      managed.attachmentTokenFingerprint === targetState.attachments[0].tokenFingerprint
  }

  function managedTargetIdentityMatches(managed, targetState) {
    return Boolean(managed) &&
      managed.targetRecordFingerprint === targetState.targetRecordFingerprint &&
      targetState.attachments.length === 1 &&
      managed.attachmentTokenFingerprint === targetState.attachments[0].tokenFingerprint
  }

  function managedPhysicalLineageMatches(managed, targetState) {
    return Boolean(managed) &&
      managed.physicalUnitFingerprint === physicalUnitFingerprint &&
      managed.targetRecordFingerprint === targetState.targetRecordFingerprint &&
      targetState.attachments.length === 1 &&
      managed.attachmentTokenFingerprint === targetState.attachments[0].tokenFingerprint
  }

  async function digestTargetAttachment(attachment, size) {
    try {
      return await context.drive.downloadTokenDigestExact(
        attachment.token,
        'bitable-file',
        size,
        attachment.extra ? { extra: attachment.extra } : {}
      )
    } catch (error) {
      if (['FEISHU_MATERIAL_TARGET_TOO_LARGE', 'FEISHU_MATERIAL_TARGET_SIZE_MISMATCH']
        .includes(normalizeText(error && error.code))) {
        return { sizeMismatch: true }
      }
      throw error
    }
  }

  function safeEvidence(targetState, values = {}) {
    return {
      verified: true,
      attachmentTokenFingerprint: normalizeText(values.attachmentTokenFingerprint),
      contentSha256: normalizeText(values.contentSha256),
      size: Number(values.size || 0),
      contentType: normalizeText(values.contentType).toLowerCase().split(';')[0],
      targetRecordFingerprint: targetState.targetRecordFingerprint,
      preserved: values.preserved === true,
      cleared: values.cleared === true,
      expectedStateKey: targetState.expectedStateKey,
      mediaUploaded: values.mediaUploaded === true,
      recordUpdated: values.recordUpdated === true
    }
  }

  function uploadedAttachmentDownloadExtra(targetState, fileToken) {
    const videoFieldId = normalizeText(
      context.miniBindings && context.miniBindings.video && (
        context.miniBindings.video.fieldId || context.miniBindings.video.field_id
      )
    )
    const targetRecordId = normalizeText(targetState && targetState.recordId)
    if (!videoFieldId || !targetRecordId || !normalizeText(fileToken)) {
      throw new Error('小程序专用表主视频高级权限回读坐标不完整')
    }
    return JSON.stringify({
      bitablePerm: {
        tableId: miniTableId,
        attachments: {
          [videoFieldId]: {
            [targetRecordId]: [normalizeText(fileToken)]
          }
        }
      }
    })
  }

  async function verifyExact(input = {}) {
    if (normalizeText(input.sourceRecordId) !== sourceRecordId) {
      throw new Error('小程序专用表主视频适配器源记录不一致')
    }
    assertLocalStateUnchanged()
    const targetState = await readNoteTargetVideoState(context, sourceRecordId, physicalUnitFingerprint)
    const primaryVideo = input.primaryVideo && typeof input.primaryVideo === 'object'
      ? input.primaryVideo
      : null
    if (primaryVideo) {
      const expectedHash = strictPrivateSha256(primaryVideo.contentSha256, '房源主视频期望摘要')
      const expectedSize = Number(primaryVideo.size)
      const expectedContentType = normalizeText(primaryVideo.contentType).toLowerCase().split(';')[0]
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) {
        throw new Error('房源主视频期望大小无效')
      }
      if (!/^video\//.test(expectedContentType)) throw new Error('房源主视频期望类型无效')
      if (targetState.attachments.length === 1) {
        const attachment = targetState.attachments[0]
        if ((attachment.size !== null && attachment.size !== expectedSize) ||
            (attachment.contentType && attachment.contentType !== expectedContentType)) {
          return { verified: false, expectedStateKey: targetState.expectedStateKey }
        }
        const downloaded = await digestTargetAttachment(attachment, expectedSize)
        if (downloaded.sizeMismatch !== true &&
            Number(downloaded.size) === expectedSize &&
            normalizeText(downloaded.contentSha256) === expectedHash &&
            normalizeText(downloaded.contentType).toLowerCase().split(';')[0] === expectedContentType) {
          return safeEvidence(targetState, {
            attachmentTokenFingerprint: attachment.tokenFingerprint,
            contentSha256: expectedHash,
            size: expectedSize,
            contentType: expectedContentType
          })
        }
      }
      return { verified: false, expectedStateKey: targetState.expectedStateKey }
    }

    if (targetState.attachments.length === 0) {
      return safeEvidence(targetState, { cleared: true })
    }
    const managed = privateNoteTargetState(listing)
    const ordinaryManaged = managedStateMatchesTarget(managed, targetState) ||
      managedPhysicalLineageMatches(managed, targetState)
    const identityChangedManaged = managedTargetIdentityMatches(managed, targetState) &&
      managed.physicalUnitFingerprint !== physicalUnitFingerprint
    const withdrawnManaged = options.withdrawn === true &&
      managedTargetIdentityMatches(managed, targetState)
    const reactivatedManaged = options.reactivated === true &&
      managedPhysicalLineageMatches(managed, targetState)
    if (options.failureCleanup === true && !identityChangedManaged &&
        !withdrawnManaged && !reactivatedManaged) {
      return safeEvidence(targetState, {
        attachmentTokenFingerprint: targetState.attachments[0].tokenFingerprint,
        preserved: true
      })
    }
    if (!ordinaryManaged && !identityChangedManaged && !withdrawnManaged) {
      return safeEvidence(targetState, {
        attachmentTokenFingerprint: targetState.attachments[0].tokenFingerprint,
        preserved: true
      })
    }
    const downloaded = await digestTargetAttachment(targetState.attachments[0], managed.size)
    if (downloaded.sizeMismatch === true || Number(downloaded.size) !== managed.size ||
        normalizeText(downloaded.contentSha256) !== managed.contentSha256 ||
        normalizeText(downloaded.contentType).toLowerCase().split(';')[0] !== managed.contentType) {
      throw new Error('房源主视频已管理附件内容回读不一致')
    }
    return {
      verified: false,
      expectedStateKey: targetState.expectedStateKey,
      forceClearForIdentityChange: identityChangedManaged,
      forceClearForWithdrawn: withdrawnManaged,
      forceClearForReactivation: reactivatedManaged
    }
  }

  async function updateTargetRecord(targetState, value, input, phase) {
    const fieldName = normalizeText(targetState.videoFieldName)
    if (!fieldName) throw new Error('小程序专用表主视频显示字段名缺失')
    const records = [{
      record_id: targetState.recordId,
      fields: { [fieldName]: value }
    }]
    await context.targetClient.batchUpdateRecords(miniTableId, records, {
      clientToken: stableUpdateClientToken(miniTableId, records, {
        phase,
        runId,
        runNowMs: nowMs
      }),
      onWriteDispatched: input.onWriteDispatched
    })
  }

  async function publishExact(input = {}) {
    assertLocalStateUnchanged()
    const before = await readNoteTargetVideoState(context, sourceRecordId, physicalUnitFingerprint)
    if (before.expectedStateKey !== normalizeText(input.expectedStateKey)) {
      const error = new Error('小程序专用表主视频写前状态已变化')
      error.statusCode = 409
      throw error
    }
    const contentSha256 = strictPrivateSha256(input.contentSha256, '房源主视频发布摘要')
    const size = Number(input.size)
    const contentType = normalizeText(input.contentType).toLowerCase().split(';')[0]
    if (!Number.isSafeInteger(size) || size < 1 || !input.writeEvidence ||
        typeof input.writeEvidence.filePath !== 'string' || !/^video\//.test(contentType)) {
      throw new Error('小程序专用表主视频缺少流式标准化成品')
    }
    let mediaWriteDispatched = false
    let uploaded
    let fileToken = ''
    try {
      uploaded = await context.drive.uploadBitableFileDescriptor(
        input.writeEvidence,
        targetBaseToken,
        input.fileName,
        () => {
          if (typeof input.onWriteDispatched === 'function') input.onWriteDispatched()
          mediaWriteDispatched = true
        }
      )
      if (!mediaWriteDispatched) {
        throw externalWriteStateUnknownError(null, 'target-video-media-dispatch-evidence')
      }
      fileToken = normalizeText(uploaded && uploaded.fileToken)
      if (!/^[A-Za-z0-9_-]{8,160}$/.test(fileToken) ||
          normalizeText(uploaded.contentSha256) !== contentSha256 ||
          Number(uploaded.size) !== size ||
          normalizeText(uploaded.contentType).toLowerCase().split(';')[0] !== contentType) {
        throw new Error('小程序专用表主视频上传响应证据无效')
      }
      const mediaReadback = await context.drive.downloadTokenDigestExact(
        fileToken,
        'bitable-file',
        size,
        { extra: uploadedAttachmentDownloadExtra(before, fileToken) }
      )
      if (Number(mediaReadback && mediaReadback.size) !== size ||
          normalizeText(mediaReadback && mediaReadback.contentSha256) !== contentSha256 ||
          normalizeText(mediaReadback && mediaReadback.contentType).toLowerCase().split(';')[0] !== contentType) {
        throw new Error('小程序专用表主视频上传后内容回读不一致')
      }
      if (typeof input.onWriteVerified === 'function') input.onWriteVerified()
      mediaWriteDispatched = false
    } catch (error) {
      if (mediaWriteDispatched && !isExternalWriteStateUnknownError(error)) {
        throw externalWriteStateUnknownError(error, 'target-video-media-readback')
      }
      throw error
    }

    const beforeUpdate = await readNoteTargetVideoState(context, sourceRecordId, physicalUnitFingerprint)
    if (beforeUpdate.expectedStateKey !== before.expectedStateKey) {
      throw externalWriteStateUnknownError(null, 'target-video-cas-after-media')
    }
    let baseWriteDispatched = false
    let after
    const tokenFingerprint = privateTextSha256(fileToken)
    try {
      await updateTargetRecord(beforeUpdate, [{ file_token: fileToken }], {
        ...input,
        onWriteDispatched: () => {
          if (typeof input.onWriteDispatched === 'function') input.onWriteDispatched()
          baseWriteDispatched = true
        }
      }, 'note-primary-video')
      if (!baseWriteDispatched) {
        throw externalWriteStateUnknownError(null, 'target-video-base-dispatch-evidence')
      }
      after = await readNoteTargetVideoState(context, sourceRecordId, physicalUnitFingerprint)
      if (after.attachments.length !== 1 ||
          after.attachments[0].tokenFingerprint !== tokenFingerprint) {
        throw new Error('小程序专用表主视频记录写后回读不一致')
      }
      assertLocalStateUnchanged()
      if (typeof input.onWriteVerified === 'function') input.onWriteVerified()
      baseWriteDispatched = false
    } catch (error) {
      if (baseWriteDispatched && !isExternalWriteStateUnknownError(error)) {
        throw externalWriteStateUnknownError(error, 'target-video-base-readback')
      }
      throw error
    }
    return safeEvidence(after, {
      attachmentTokenFingerprint: tokenFingerprint,
      contentSha256,
      size,
      contentType,
      mediaUploaded: true,
      recordUpdated: true
    })
  }

  async function clearExact(input = {}) {
    assertLocalStateUnchanged()
    const before = await readNoteTargetVideoState(context, sourceRecordId, physicalUnitFingerprint)
    if (before.expectedStateKey !== normalizeText(input.expectedStateKey)) {
      const error = new Error('小程序专用表主视频清空前状态已变化')
      error.statusCode = 409
      throw error
    }
    const managed = privateNoteTargetState(listing)
    const ordinaryManaged = managedStateMatchesTarget(managed, before) ||
      managedPhysicalLineageMatches(managed, before)
    const identityChangedManaged = input.forceClearForIdentityChange === true &&
      managedTargetIdentityMatches(managed, before) &&
      managed.physicalUnitFingerprint !== physicalUnitFingerprint
    const withdrawnManaged = input.forceClearForWithdrawn === true && options.withdrawn === true &&
      managedTargetIdentityMatches(managed, before)
    const reactivatedManaged = input.forceClearForReactivation === true &&
      options.reactivated === true && managedPhysicalLineageMatches(managed, before)
    if (!ordinaryManaged && !identityChangedManaged && !withdrawnManaged && !reactivatedManaged) {
      return safeEvidence(before, {
        attachmentTokenFingerprint: before.attachments[0] && before.attachments[0].tokenFingerprint,
        preserved: true
      })
    }
    let baseWriteDispatched = false
    let after
    try {
      await updateTargetRecord(before, [], {
        ...input,
        onWriteDispatched: () => {
          if (typeof input.onWriteDispatched === 'function') input.onWriteDispatched()
          baseWriteDispatched = true
        }
      }, 'note-primary-clear')
      if (!baseWriteDispatched) {
        throw externalWriteStateUnknownError(null, 'target-video-clear-dispatch-evidence')
      }
      after = await readNoteTargetVideoState(context, sourceRecordId, physicalUnitFingerprint)
      if (after.attachments.length !== 0) {
        throw new Error('小程序专用表主视频清空写后回读不一致')
      }
      assertLocalStateUnchanged()
      if (typeof input.onWriteVerified === 'function') input.onWriteVerified()
      baseWriteDispatched = false
    } catch (error) {
      if (baseWriteDispatched && !isExternalWriteStateUnknownError(error)) {
        throw externalWriteStateUnknownError(error, 'target-video-clear-readback')
      }
      throw error
    }
    return safeEvidence(after, { cleared: true, recordUpdated: true })
  }

  return {
    writeDispatchEvidenceVersion: 1,
    verifyExact,
    publishExact,
    clearExact
  }
}

function formalNoteMaterialConfigurationReady(options = {}) {
  const targetRoot = String(config.feishu.noteMaterialTargetRootFolderToken || '').trim()
  const legacySourceRoot = String(config.feishu.folderToken || '').trim()
  const targetBaseToken = String(config.feishu.targetBitableAppToken || '').trim()
  const miniTableId = String(config.feishu.miniTableId || '').trim()
  const configuredVideoBinding = config.feishu.miniFieldBindings &&
    typeof config.feishu.miniFieldBindings === 'object'
    ? config.feishu.miniFieldBindings.video
    : null
  const videoFieldId = String(configuredVideoBinding && (
    configuredVideoBinding.fieldId || configuredVideoBinding.field_id
  ) || '').trim()
  const videoTypes = bindingTypes(configuredVideoBinding)
  const targetVideoReady = Boolean(videoFieldId) &&
    videoTypes.length === 1 && videoTypes[0] === '17'
  const explicitDrive = options.noteMaterialDrive
  const explicitTargetClient = options.noteMaterialTargetClient
  const explicitOss = options.noteMaterialOss
  const driveReady = !explicitDrive || (
    explicitDrive.writeDispatchEvidenceVersion === 1 &&
    adapterImplements(explicitDrive, [
      'listFolder',
      'downloadTokenDigestExact',
      'ensureListingFolder',
      'uploadBitableFileDescriptor'
    ]) &&
    (typeof explicitDrive.downloadToken === 'function' ||
      typeof explicitDrive.downloadTokenToFile === 'function') &&
    (typeof explicitDrive.materializeAsset === 'function' ||
      typeof explicitDrive.materializeVideo === 'function') &&
    (typeof explicitDrive.verifyMaterializedAsset === 'function' ||
      typeof explicitDrive.verifyMaterializedVideo === 'function')
  )
  const targetClientReady = !explicitTargetClient || (
    explicitTargetClient.writeDispatchEvidenceVersion === 1 &&
    adapterImplements(explicitTargetClient, [
      'readValidatedTableSnapshot',
      'batchUpdateRecords'
    ])
  )
  const ossReady = explicitOss
    ? adapterImplements(explicitOss, [
        'putVideoDeterministic',
        'verifyVideoDeterministic'
      ])
    : oss.hasReadConfig()
  return noteMaterialFieldContractReady() &&
    Array.isArray(config.feishu.noteMaterialAllowedHosts) &&
    config.feishu.noteMaterialAllowedHosts.length > 0 &&
    /^[A-Za-z0-9_-]{8,160}$/.test(targetRoot) &&
    (!legacySourceRoot || targetRoot !== legacySourceRoot) &&
    /^[A-Za-z0-9_-]{8,160}$/.test(targetBaseToken) &&
    /^[A-Za-z0-9_-]{8,160}$/.test(miniTableId) &&
    targetVideoReady &&
    driveReady &&
    targetClientReady &&
    ossReady
}

function assertFormalNoteMaterialConfiguration(options = {}) {
  if (formalNoteMaterialConfigurationReady(options)) return true
  const error = new Error('房源笔记素材正式同步配置未就绪，已在镜像读写前阻断')
  error.statusCode = 503
  throw error
}

async function syncMirrorNoteMaterials(workingDb, mirrorResult, options = {}) {
  const sourceRows = Array.isArray(mirrorResult && mirrorResult.sourceNoteMaterials)
    ? mirrorResult.sourceNoteMaterials
    : []
  if (!effectiveNoteMaterialSyncEnabled()) {
    const report = {
      complete: true,
      published: options.dryRun !== true,
      dryRun: options.dryRun === true,
      sourceRecordCount: sourceRows.length,
      synced: 0,
      cleared: 0,
      retained: 0,
      failed: 0,
      skipped: true,
      rows: []
    }
    Object.assign(report, buildContentPlanSummary(
      [],
      [],
      buildNoteMaterialSourceFieldPlan([])
    ))
    return report
  }
  if (sourceRows.length === 0) {
    const emptyPlan = await syncNoteMaterialsForInventory({
      db: workingDb,
      sourceRows: [],
      dryRun: options.dryRun === true,
      contentPlanConfirmationRequired: options.contentPlanConfirmationRequired === true,
      verifyExpectedContentPlan: options.verifyExpectedContentPlan === true,
      sourcesGloballyVerified: options.sourcesGloballyVerified === true,
      expectedContentPlanSha256: options.expectedContentPlanSha256,
      expectedContentAssetCount: options.expectedContentAssetCount,
      expectedContentPlanEvidence: options.expectedContentPlanEvidence,
      expectedDeferredMaterialEvidence: options.expectedDeferredMaterialEvidence,
      expectedSourceMaterialFieldSha256: options.expectedSourceMaterialFieldSha256,
      expectedSourceMaterialFieldRecordCount: options.expectedSourceMaterialFieldRecordCount,
      onExternalWriteDispatched: options.onExternalWriteDispatched
    })
    emptyPlan.skipped = true
    return emptyPlan
  }
  if (options.dryRun !== true && !formalNoteMaterialConfigurationReady(options)) {
    return {
      complete: false,
      published: false,
      dryRun: false,
      sourceRecordCount: sourceRows.length,
      synced: 0,
      cleared: 0,
      retained: 0,
      failed: sourceRows.length,
      status: 'configuration-not-ready',
      rows: []
    }
  }
  try {
    const normalizer = options.noteMaterialNormalizer || (
      typeof options.prepareMaterial !== 'function'
        ? createFeishuNoteMaterialNormalizer({
            ffmpegPath: config.feishu.noteMaterialFfmpegPath,
            ffprobePath: config.feishu.noteMaterialFfprobePath,
            tempRoot: config.feishu.noteMaterialTempRoot,
            timeoutMs: config.feishu.noteMaterialNormalizationTimeoutMs,
            maxVideoSourceBytes: config.feishu.noteMaterialMaxVideoSourceBytes,
            maxImageSourceBytes: config.feishu.noteMaterialMaxImageSourceBytes,
            maxVideoPassthroughBytes: config.feishu.noteMaterialMaxVideoPassthroughBytes,
            maxVideoOutputBytes: config.feishu.noteMaterialMaxVideoOutputBytes,
            maxImageOutputBytes: config.feishu.noteMaterialMaxImageOutputBytes,
            maxVideoDurationSeconds: config.feishu.noteMaterialMaxVideoDurationSeconds,
            minFreeBytes: config.feishu.noteMaterialMinFreeBytes
          })
        : null
    )
    const drive = options.noteMaterialDrive || createFeishuNoteMaterialClient({
      fetchImpl: options.fetchImpl || fetch,
      accessToken: mirrorResult.feishuToken || options.feishuToken,
      baseUrl: config.feishu.baseUrl,
      pageSize: config.feishu.pageSize,
      maxItems: config.feishu.noteMaterialMaxItems,
      timeoutMs: config.feishu.materialTransferTimeoutMs,
      downloadTimeoutMs: config.feishu.noteMaterialNormalizationTimeoutMs,
      maxBytes: Math.max(
        config.feishu.noteMaterialMaxVideoSourceBytes,
        config.feishu.noteMaterialMaxImageSourceBytes
      ),
      targetRootFolderToken: config.feishu.noteMaterialTargetRootFolderToken
    })
    const mirrorTargetContext = mirrorResult && mirrorResult[MIRROR_NOTE_TARGET_CONTEXT] &&
      typeof mirrorResult[MIRROR_NOTE_TARGET_CONTEXT] === 'object'
      ? mirrorResult[MIRROR_NOTE_TARGET_CONTEXT]
      : {}
    const noteAccessToken = mirrorResult.feishuToken || options.feishuToken
    const targetBaseToken = normalizeResourceIdentifier(
      mirrorTargetContext.targetBaseToken || config.feishu.targetBitableAppToken
    )
    const miniTableId = normalizeResourceIdentifier(
      mirrorTargetContext.miniTableId || config.feishu.miniTableId
    )
    const miniBindings = mirrorTargetContext.miniBindings || resolvedContractBindings(
      'mini',
      config.feishu.miniFieldBindings,
      { sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile }
    )
    const targetClient = options.noteMaterialTargetClient || mirrorTargetContext.targetClient || (
      noteAccessToken
        ? createBitableClient({
            baseUrl: config.feishu.baseUrl,
            accessToken: noteAccessToken,
            appToken: targetBaseToken,
            pageSize: config.feishu.pageSize,
            requestTimeoutMs: config.feishu.requestTimeoutMs,
            maxRetries: config.feishu.requestMaxRetries,
            retryDelayMs: config.feishu.requestRetryDelayMs,
            fetchImpl: options.fetchImpl || fetch
          })
        : null
    )
    const noteTargetContext = targetClient
      ? {
          targetClient,
          drive,
          targetBaseToken,
          miniTableId,
          miniBindings,
          runId: options.runId,
          nowMs: options.nowMs,
          dryRun: options.dryRun === true,
          plannedCreateSourceRecordFingerprints:
            mirrorTargetContext.plannedCreateSourceRecordFingerprints
        }
      : null
    if (options.dryRun !== true && !noteTargetContext) {
      throw new Error('房源笔记正式同步缺少小程序专用表主视频目标客户端')
    }
    return await syncNoteMaterialsForInventory({
      db: workingDb,
      sourceRows,
      allowedHosts: config.feishu.noteMaterialAllowedHosts,
      maxDepth: config.feishu.noteMaterialMaxDepth,
      maxItems: config.feishu.noteMaterialMaxItems,
      targetRootFolderToken: config.feishu.noteMaterialTargetRootFolderToken,
      uploadDir: config.oss.uploadDir,
      drive,
      oss: options.noteMaterialOss || oss,
      prepareMaterial: options.prepareMaterial || (normalizer && normalizer.prepareMaterial),
      verifyPreparedMaterial: options.verifyPreparedMaterial || (normalizer && normalizer.verifyPreparedMaterial),
      openPreparedFile: options.openPreparedFile || (normalizer && normalizer.openPreparedFile),
      disposePreparedMaterial: options.disposePreparedMaterial || (normalizer && normalizer.disposePreparedMaterial),
      verifySource: options.verifySource || (normalizer && normalizer.verifySource),
      describeProfile: options.describeProfile || (normalizer && normalizer.describeProfile),
      requireStreamingSource: Boolean(normalizer),
      dryRun: options.dryRun === true,
      nowText: noteMaterialRunTime(options),
      contentPlanConfirmationRequired: options.contentPlanConfirmationRequired === true,
      verifyExpectedContentPlan: options.verifyExpectedContentPlan === true,
      sourcesGloballyVerified: options.sourcesGloballyVerified === true,
      expectedContentPlanSha256: options.expectedContentPlanSha256,
      expectedContentAssetCount: options.expectedContentAssetCount,
      expectedContentPlanEvidence: options.expectedContentPlanEvidence,
      expectedDeferredMaterialEvidence: options.expectedDeferredMaterialEvidence,
      expectedSourceMaterialFieldSha256: options.expectedSourceMaterialFieldSha256,
      expectedSourceMaterialFieldRecordCount: options.expectedSourceMaterialFieldRecordCount,
      onExternalWriteDispatched: options.onExternalWriteDispatched,
      reactivatedSourceRecordIds: options.reactivatedSourceRecordIds,
      primaryVideoAttachmentForListing: noteTargetContext
        ? (targetOptions) => createNotePrimaryVideoAttachmentAdapter({
            context: noteTargetContext,
            listing: targetOptions.listing,
            sourceRecordId: targetOptions.sourceRecordId,
            expectedLocalStateKey: targetOptions.expectedStateKey,
            physicalUnitFingerprint: targetOptions.physicalUnitFingerprint,
            withdrawn: targetOptions.withdrawn === true,
            reactivated: targetOptions.reactivated === true,
            failureCleanup: targetOptions.failureCleanup === true,
            localStateKey: targetOptions.mediaAssetsStateKey,
            currentPhysicalUnitFingerprint: targetOptions.currentPhysicalUnitFingerprint
          })
        : undefined,
      mediaAssetsStateKey: (listing) => domain.listingMediaAssetsStateKey(listing),
      replaceMediaAssets: (listing, mediaAssets, context = {}) => domain.replaceListingMediaAssets(
        workingDb,
        listing.id,
        mediaAssets,
        {
          expectedStateKey: context.expectedStateKey,
          updatedAt: context.updatedAt
        }
      )
    })
  } catch (error) {
    if (isExternalWriteIntentPersistenceError(error)) throw error
    const externalWriteStateUnknown = isExternalWriteStateUnknownError(error)
    const status = externalWriteStateUnknown
      ? 'external-write-state-unknown'
      : (isContentPlanConfirmationError(error) ? 'content-plan-confirmation-failed' : 'pipeline-failed')
    return {
      complete: false,
      published: false,
      dryRun: options.dryRun === true,
      sourceRecordCount: sourceRows.length,
      synced: 0,
      cleared: 0,
      retained: 0,
      failed: Math.max(1, sourceRows.length),
      status,
      externalWriteStateUnknown,
      rows: [{
        status,
        error: externalWriteStateUnknown
          ? '房源笔记素材外部写入状态待核对'
          : shortError(error)
      }]
    }
  }
}

async function syncNoteMaterialsAfterInventory(workingDb, inventory, mirrorResult, options = {}) {
  const inventoryComplete = inventory && inventory.failed === 0 && inventory.skippedInvalid === 0
  if (inventoryComplete) {
    return syncMirrorNoteMaterials(workingDb, mirrorResult, {
      ...options,
      reactivatedSourceRecordIds: inventory[REACTIVATED_NOTE_SOURCE_IDS]
    })
  }
  return {
    complete: false,
    published: false,
    dryRun: options.dryRun === true,
    sourceRecordCount: Array.isArray(mirrorResult && mirrorResult.sourceNoteMaterials)
      ? mirrorResult.sourceNoteMaterials.length
      : 0,
    synced: 0,
    cleared: 0,
    retained: 0,
    failed: 0,
    skipped: true,
    status: 'skipped-inventory-failed',
    rows: []
  }
}

function finalizeMirrorSyncResult(run = {}) {
  const inventory = run.inventory && typeof run.inventory === 'object' ? run.inventory : {}
  const noteMaterials = inventory.noteMaterials && typeof inventory.noteMaterials === 'object'
    ? inventory.noteMaterials
    : null
  const inventoryClassification = classifyMirrorRunResult(run)
  const inventoryCommittable = inventoryClassification.success === true && run.dryRun !== true
  const inventoryPublished = inventoryClassification.success === true && run.published === true
  const flattened = {
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
    noteMaterials,
    sheetSnapshot: run.snapshot,
    inventoryCommittable,
    inventoryPublished,
    externalWriteStateUnknown: run.externalWriteStateUnknown === true ||
      Boolean(noteMaterials && noteMaterials.externalWriteStateUnknown === true)
  }
  if (!inventoryClassification.success || !noteMaterials) return flattened

  const materialSucceeded = noteMaterials.complete === true &&
    Number(noteMaterials.failed || 0) === 0 &&
    (run.dryRun === true ? noteMaterials.dryRun === true : noteMaterials.published === true)
  if (materialSucceeded) return flattened

  const committableMaterialWarning = isKnownMaterialRowWarningReport(noteMaterials, {
    dryRun: run.dryRun === true
  }) && flattened.externalWriteStateUnknown !== true

  return {
    ...flattened,
    complete: false,
    published: false,
    success: false,
    status: run.dryRun === true
      ? 'inventory-validated-materials-failed'
      : 'inventory-published-materials-failed',
    failed: Math.max(1, Number(noteMaterials.failed || 0)),
    noop: false,
    inventoryCommittable: committableMaterialWarning ? inventoryCommittable : false,
    inventoryPublished: committableMaterialWarning ? inventoryPublished : false
  }
}

function recordMirrorSyncOutcome(db, result = {}) {
  const logs = db && Array.isArray(db.feishuSyncLogs) ? db.feishuSyncLogs : []
  const latest = logs[0]
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) return false
  const note = result.noteMaterials && typeof result.noteMaterials === 'object'
    ? result.noteMaterials
    : null
  latest.success = result.success === true
  latest.status = String(result.status || (result.success === true ? 'success' : 'failed'))
  latest.inventoryCommittable = result.inventoryCommittable === true
  latest.inventoryPublished = result.inventoryPublished === true
  for (const field of ['missingVideoMaterial', 'skippedNoMaterial', 'materialTransferFailed']) {
    if (Number.isFinite(Number(result[field]))) latest[field] = Math.max(0, Number(result[field]))
  }
  latest.noteMaterials = note
    ? {
        complete: note.complete === true,
        published: note.published === true,
        dryRun: note.dryRun === true,
        sourceRecordCount: Number(note.sourceRecordCount || 0),
        resolved: Number(note.resolved || 0),
        synced: Number(note.synced || 0),
        cleared: Number(note.cleared || 0),
        retained: Number(note.retained || 0),
        failed: Number(note.failed || 0),
        ...(Number(note.cleanupWarnings || 0) > 0
          ? { cleanupWarnings: Number(note.cleanupWarnings) }
          : {}),
        video: Number(note.video || 0),
        nonVideo: Number(note.nonVideo || 0),
        duplicateReference: Number(note.duplicateReference || 0),
        skipped: note.skipped === true,
        status: String(note.status || '')
      }
    : null
  return true
}

function reconcileInventoryVideoSummary(db, inventory = {}, noteMaterials = null) {
  const activeCompanyListings = (db && Array.isArray(db.listings) ? db.listings : []).filter((listing) => (
    listing && listing.externalSource === 'feishu' &&
    listing.lifecycleStatus !== 'expired' && listing.status !== '已下架'
  ))
  const currentMissingVideoCount = activeCompanyListings.filter((listing) => (
    !domain.hasListingVideo(listing) || listing.missingVideoMaterial === true
  )).length
  // worker-v2 已禁止 legacy 素材链；库存阶段的 skippedNoMaterial 只是旧匹配器看到空数组，
  // 最终汇总必须以房源笔记管线落库后的真实媒体状态为准。
  inventory.missingVideoMaterial = currentMissingVideoCount
  inventory.skippedNoMaterial = currentMissingVideoCount
  inventory.materialTransferFailed = Math.max(0, Number(
    noteMaterials && noteMaterials.failed || 0
  ))
  return inventory
}

async function runMirrorContentPlanPreflight(db, adminId, options = {}) {
  if (options.verifyExpectedContentPlan !== true ||
      !Array.isArray(options.expectedContentPlanEvidence)) {
    throw contentPlanConfirmationError('正式飞书同步的只读预检缺少受信私有内容计划', 500)
  }
  const previewDb = clone(db)
  let captured = null
  const previewResult = await syncViaMirror(previewDb, adminId, {
    ...options,
    dryRun: true,
    // A 的镜像摘要可能在慢素材准备期间自然过期；本层只负责复验 A 的
    // schema/resource/content 与素材来源，当前镜像事实交给随后紧邻写入的 B 冻结。
    expectedMirrorPlanSha256: undefined,
    runId: options.runId,
    nowMs: options.nowMs,
    contentPlanConfirmationRequired: true,
    verifyExpectedContentPlan: true,
    sourcesGloballyVerified: false,
    expectedContentPlanSha256: options.expectedContentPlanSha256,
    expectedContentAssetCount: options.expectedContentAssetCount,
    expectedContentPlanEvidence: options.expectedContentPlanEvidence,
    expectedDeferredMaterialEvidence: Array.isArray(options.expectedDeferredMaterialEvidence)
      ? options.expectedDeferredMaterialEvidence
      : [],
    _captureContentPlanConfirmation(value) {
      captured = value
    }
  })
  const previewAccepted = previewResult && (
    (previewResult.complete === true && previewResult.success === true &&
      Number(previewResult.failed || 0) === 0) ||
    (previewResult.status === 'inventory-validated-materials-failed' &&
      isKnownMaterialRowWarningReport(previewResult.noteMaterials, { dryRun: true }))
  )
  if (!previewAccepted || previewResult.dryRun !== true ||
      !captured || !captured.report || !captured.privateConfirmation) {
    throw contentPlanConfirmationError('正式飞书同步的完整只读预检未通过')
  }
  const noteMaterials = captured.report
  return {
    ...noteMaterials,
    privateConfirmation: captured.privateConfirmation,
    sourcesGloballyVerified: true,
    feishuToken: captured.feishuToken || options.feishuToken || ''
  }
}

function enforceFormalContentPlanResult(result, expected) {
  if (!expected) return result
  const note = result && result.noteMaterials
  const noteAccepted = note && (
    (note.complete === true && note.published === true) ||
    isKnownMaterialRowWarningReport(note, { dryRun: false })
  )
  const matched = noteAccepted && result.externalWriteStateUnknown !== true &&
    note.contentPlanSha256 === expected.expectedContentPlanSha256 &&
    note.contentPlanAssetCount === expected.expectedContentAssetCount
  if (matched) return result
  return {
    ...result,
    complete: false,
    published: false,
    success: false,
    status: 'content-plan-confirmation-failed',
    failed: Math.max(1, Number(result && result.failed || 0)),
    noop: false,
    inventoryCommittable: false,
    inventoryPublished: false
  }
}

async function syncViaMirror(db, adminId, options = {}) {
  const coordinates = fixedMirrorRunCoordinates(options)
  const formalConfirmationRequired = contentPlanConfirmationRequired() && options.dryRun !== true
  const verificationDryRun = contentPlanConfirmationRequired() &&
    options.dryRun === true && options.verifyExpectedContentPlan === true
  const baselinePublishedSourceIds = activeFeishuSourceRecordIds(db)
  const baselinePublishedFoundationIdentityKeys =
    aiFoundationProfileEnabled(config.feishu.sourceCompatibilityProfile)
      ? activeFeishuFoundationIdentityKeys(db)
      : []
  let confirmedContentPlan = null
  let preflightFeishuToken = ''
  if (formalConfirmationRequired) {
    confirmedContentPlan = await prepareMirrorContentPlanConfirmation({
      db,
      adminId,
      runId: coordinates.runId,
      nowMs: coordinates.nowMs,
      expectedContentPlanSha256: options.expectedContentPlanSha256,
      expectedContentAssetCount: options.expectedContentAssetCount,
      runPreflight: async (confirmationContext) => {
        // 确定性正式配置必须在完整 dry 预检和正式镜像的首个 Base 读取/写入前成立；
        // dry-run 本身允许用于诊断配置，但其成功不能替代正式配置门。
        assertFormalNoteMaterialConfiguration(options)
        const preflight = await runMirrorContentPlanPreflight(db, adminId, {
          ...options,
          ...coordinates,
          baselinePublishedSourceIds,
          baselinePublishedFoundationIdentityKeys,
          dryRun: true,
          expectedContentPlanSha256: confirmationContext.expectedContentPlanSha256,
          expectedContentAssetCount: confirmationContext.expectedContentAssetCount,
          expectedContentPlanEvidence: confirmationContext.expectedContentPlanEvidence,
          expectedDeferredMaterialEvidence: confirmationContext.expectedDeferredMaterialEvidence,
          expectedSourceMaterialFieldSha256: confirmationContext.expectedSourceMaterialFieldSha256,
          expectedSourceMaterialFieldRecordCount: confirmationContext.expectedSourceMaterialFieldRecordCount,
          verifyExpectedContentPlan: confirmationContext.verifyExpectedContentPlan === true
        })
        preflightFeishuToken = preflight.feishuToken || ''
        return preflight
      }
    })
  }
  let mirrorSafetyPreflight = null
  if (options.dryRun !== true) {
    // 每次正式同步都先用完全相同的 runId/nowMs、资源和基线做一次镜像只读预检。
    // B 的镜像摘要随即成为 apply 的 expected；较早 A 的 mirror 可被当前事实刷新，
    // 但 A 已批准的 schema/resource/content 与素材来源仍须逐项一致。
    mirrorSafetyPreflight = await configuredMirrorTableSync({
      ...options,
      ...coordinates,
      baselinePublishedSourceIds,
      baselinePublishedFoundationIdentityKeys,
      dryRun: true,
      // A 只绑定慢素材准备的内容/schema/resource；临写前镜像 B 必须按当前五表重新形成，
      // 不能再被较早的 A mirror 摘要提前拦截。只有显式“当前态收敛”任务会把已选择的
      // 全新 dry 基线严格绑定到 B，确保旧 UNKNOWN 解锁链没有任何静默刷新。
      expectedMirrorPlanSha256: options.strictMirrorPlanBinding === true
        ? options.expectedMirrorPlanSha256
        : undefined,
      expectedComponentEvidenceSha256: options.strictMirrorPlanBinding === true
        ? options.expectedComponentEvidenceSha256
        : undefined,
      // 源表房源笔记字段属于已确认内容计划的一部分；镜像可刷新，素材来源不可刷新。
      ...(confirmedContentPlan
        ? {
            expectedSourceMaterialFieldSha256:
              confirmedContentPlan.expectedSourceMaterialFieldSha256,
            expectedSourceMaterialFieldRecordCount:
              confirmedContentPlan.expectedSourceMaterialFieldRecordCount
          }
        : {}),
      feishuToken: options.feishuToken || preflightFeishuToken || ''
    })
    if (!mirrorSafetyPreflight || mirrorSafetyPreflight.complete !== true ||
        mirrorSafetyPreflight.dryRun !== true ||
        !/^[0-9a-f]{64}$/.test(String(mirrorSafetyPreflight.schemaSha256 || '')) ||
        !/^[0-9a-f]{64}$/.test(String(mirrorSafetyPreflight.resourceIdentitySha256 || '')) ||
        !/^[0-9a-f]{64}$/.test(String(mirrorSafetyPreflight.mirrorPlanSha256 || '')) ||
        !/^[0-9a-f]{64}$/.test(String(mirrorSafetyPreflight.semanticMirrorPlanSha256 || '')) ||
        !/^[0-9a-f]{64}$/.test(String(mirrorSafetyPreflight.componentEvidenceSha256 || ''))) {
      throw mirrorSafetyDigestError(
        'MIRROR_PREFLIGHT_FAILED',
        '飞书镜像正式同步的只读安全预检未形成完整摘要'
      )
    }
    preflightFeishuToken = mirrorSafetyPreflight.feishuToken || preflightFeishuToken
    if (options.syncController === 'worker-v2' && typeof options.onApplyPlanFrozen !== 'function') {
      throw mirrorSafetyDigestError(
        'MIRROR_PREFLIGHT_FAILED',
        '正式同步缺少临写前权威镜像冻结门'
      )
    }
    if (typeof options.onApplyPlanFrozen === 'function') {
      const freezeResult = options.onApplyPlanFrozen({
        schemaSha256: mirrorSafetyPreflight.schemaSha256,
        resourceIdentitySha256: mirrorSafetyPreflight.resourceIdentitySha256,
        mirrorPlanSha256: mirrorSafetyPreflight.mirrorPlanSha256,
        semanticMirrorPlanSha256: mirrorSafetyPreflight.semanticMirrorPlanSha256,
        componentEvidence: mirrorSafetyPreflight.componentEvidence,
        componentEvidenceSha256: mirrorSafetyPreflight.componentEvidenceSha256
      })
      if (freezeResult && typeof freezeResult.then === 'function') {
        Promise.resolve(freezeResult).catch(() => {})
        throw mirrorSafetyDigestError(
          'MIRROR_PREFLIGHT_FAILED',
          '临写前权威镜像冻结门只允许同步落盘'
        )
      }
    }
  }
  const effectiveOptions = {
    ...options,
    ...coordinates,
    ...(confirmedContentPlan || {}),
    contentPlanConfirmationRequired: formalConfirmationRequired || verificationDryRun,
    verifyExpectedContentPlan: verificationDryRun,
    // 内部预检与正式写入之间仍可能发生源文件原位替换；正式阶段必须再次核源，
    // 只复用人类确认的输出计划，不复用较早的源文件校验结论。
    sourcesGloballyVerified: false,
    expectedContentPlanEvidence: confirmedContentPlan
      ? confirmedContentPlan.expectedContentPlanEvidence
      : (verificationDryRun ? options.expectedContentPlanEvidence : undefined),
    expectedDeferredMaterialEvidence: confirmedContentPlan
      ? confirmedContentPlan.expectedDeferredMaterialEvidence
      : (verificationDryRun ? options.expectedDeferredMaterialEvidence : undefined),
    feishuToken: options.feishuToken || preflightFeishuToken || '',
    ...(mirrorSafetyPreflight
      ? {
          expectedSchemaSha256: mirrorSafetyPreflight.schemaSha256,
          expectedResourceIdentitySha256: mirrorSafetyPreflight.resourceIdentitySha256,
          expectedMirrorPlanSha256: mirrorSafetyPreflight.mirrorPlanSha256,
          expectedComponentEvidenceSha256: mirrorSafetyPreflight.componentEvidenceSha256
        }
      : {})
  }
  let pendingDryContentPlan = null
  const run = await runCompanySourceSync({
    db,
    mirrorSync: () => configuredMirrorTableSync({
      ...effectiveOptions,
      baselinePublishedSourceIds,
      baselinePublishedFoundationIdentityKeys
    }),
    applyInventory: async (workingDb, records, mirrorResult) => {
      const materialPolicy = mirrorMaterialPolicy(effectiveOptions)
      const rows = validateCanonicalMirrorRecords(records, { materialPolicy })
        .map((record, index) => canonicalMirrorRecordToSyncRow(record, index, { materialPolicy }))
      const inventory = await applySync(workingDb, rows, mirrorResult.materials || [], adminId, {
        ...effectiveOptions,
        materialPolicy,
        dryRun: effectiveOptions.dryRun === true,
        skipSheetSnapshot: true,
        feishuToken: mirrorResult.feishuToken || effectiveOptions.feishuToken || '',
        trustedCanonicalCoordinates: true
      })
      const complete = inventory.failed === 0 && inventory.skippedInvalid === 0
      const noteMaterials = await syncNoteMaterialsAfterInventory(
        workingDb,
        inventory,
        mirrorResult,
        effectiveOptions
      )
      if (effectiveNoteMaterialSyncEnabled() && effectiveOptions.dryRun !== true) {
        reconcileInventoryVideoSummary(workingDb, inventory, noteMaterials)
      }
      if (effectiveOptions.dryRun === true && contentPlanConfirmationRequired() &&
          noteMaterials && (
            (noteMaterials.complete === true && Number(noteMaterials.failed || 0) === 0) ||
            isKnownMaterialRowWarningReport(noteMaterials, { dryRun: true })
          )) {
        pendingDryContentPlan = {
          report: noteMaterials,
          feishuToken: mirrorResult.feishuToken || effectiveOptions.feishuToken || ''
        }
      }
      return {
        ...inventory,
        noteMaterials,
        complete,
        published: complete,
        noop: inventory.created === 0 && inventory.updated === 0 && inventory.down === 0 && (
          effectiveOptions.dryRun === true || !effectiveNoteMaterialSyncEnabled() ||
          noteMaterials.noop === true
        )
      }
    },
    publishSnapshot: async (workingDb, records) => {
      const before = JSON.stringify({
        v1: workingDb.companySheetSnapshot || null,
        v2: workingDb.companySheetSnapshotV2 || null
      })
      // 镜像阶段已按“此前公开 ID → 本轮公开 ID”执行批量撤下熔断；小批明确房态变更后
      // 允许合法发布仅含表头的零房源快照，不能因旧的非空保护让已租房源继续公开。
      const snapshot = publishCompanySnapshot(workingDb, records, { complete: true, allowEmptyPublic: true })
      const sanitized = sanitizeSheetSnapshot({
        ...snapshot,
        sourceMode: 'feishu-mini-mirror-v1',
        schemaVersion: 1,
        updatedAt: nowText()
      }, { fillMergedCells: false })
      workingDb.companySheetSnapshot = sanitized
      const snapshotV2 = companySheetSnapshotContract.convertTrustedV1SnapshotToV2(sanitized)
      workingDb.companySheetSnapshotV2 = snapshotV2
      return {
        complete: true,
        published: true,
        failed: 0,
        noop: before === JSON.stringify({ v1: sanitized, v2: snapshotV2 }),
        rowCount: sanitized.rowCount,
        columnCount: sanitized.columnCount,
        updatedAt: sanitized.updatedAt
      }
    },
    // DB 原子提交仍由 index.js 在最终分类成功后执行；dry-run 同样调用此阶段但不落盘。
    commit: async () => ({ complete: true, noop: true, dryRun: effectiveOptions.dryRun === true })
  })

  const result = enforceFormalContentPlanResult(
    finalizeMirrorSyncResult(run),
    confirmedContentPlan
  )
  const acceptedDryResult = result.dryRun === true && (
    (result.complete === true && result.success === true && Number(result.failed || 0) === 0) ||
    (result.status === 'inventory-validated-materials-failed' &&
      isKnownMaterialRowWarningReport(result.noteMaterials, { dryRun: true }))
  )
  if (acceptedDryResult &&
      pendingDryContentPlan) {
    const privateConfirmation = rememberContentPlanConfirmation(pendingDryContentPlan.report)
    if (typeof effectiveOptions._captureContentPlanConfirmation === 'function') {
      effectiveOptions._captureContentPlanConfirmation({
        ...pendingDryContentPlan,
        privateConfirmation
      })
    }
  }
  recordMirrorSyncOutcome(db, result)
  return result
}

function isCommittableSyncResult(result) {
  if (!config.feishu.mirrorSyncEnabled) return true
  return Boolean(result && result.inventoryCommittable === true && result.dryRun !== true)
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

function parseAdminSyncRequest(body = {}, options = {}) {
  const dryRun = parseAdminDryRun(body)
  if (options.externalWorkerRequest === true) {
    const unknownFields = Object.keys(body).filter((field) => field !== 'dryRun')
    if (unknownFields.length) {
      const error = new Error('后台同步只接受 dryRun；任务身份与全部摘要只能由服务端生成')
      error.statusCode = 400
      throw error
    }
    return { dryRun }
  }
  const allowedFields = new Set([
    'dryRun',
    'runId',
    'nowMs',
    'expectedContentPlanSha256',
    'expectedContentAssetCount',
    'expectedSchemaSha256',
    'expectedResourceIdentitySha256',
    'expectedMirrorPlanSha256'
  ])
  const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field))
  if (unknownFields.length) {
    const error = new Error('飞书同步请求包含不支持字段')
    error.statusCode = 400
    throw error
  }
  if (Object.prototype.hasOwnProperty.call(body, 'runId') &&
      (typeof body.runId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(body.runId))) {
    const error = new Error('runId 必须是 8 至 128 位 ASCII 安全标识')
    error.statusCode = 400
    throw error
  }
  if (Object.prototype.hasOwnProperty.call(body, 'nowMs') &&
      (!Number.isSafeInteger(body.nowMs) || body.nowMs <= 0)) {
    const error = new Error('nowMs 必须是正安全整数毫秒时间戳')
    error.statusCode = 400
    throw error
  }
  for (const field of ['expectedSchemaSha256', 'expectedResourceIdentitySha256', 'expectedMirrorPlanSha256']) {
    if (Object.prototype.hasOwnProperty.call(body, field) &&
        (typeof body[field] !== 'string' || !/^[0-9a-f]{64}$/.test(body[field]))) {
      const error = new Error(`${field} 必须是 64 位小写十六进制摘要`)
      error.statusCode = 400
      throw error
    }
  }
  const required = Object.prototype.hasOwnProperty.call(options, 'contentPlanConfirmationRequired')
    ? options.contentPlanConfirmationRequired === true
    : contentPlanConfirmationRequired()
  const expected = validatedExpectedContentPlan(body, dryRun !== true && required)
  return {
    dryRun,
    ...(Object.prototype.hasOwnProperty.call(body, 'runId') ? { runId: body.runId } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'nowMs') ? { nowMs: body.nowMs } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'expectedSchemaSha256')
      ? { expectedSchemaSha256: body.expectedSchemaSha256 }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'expectedResourceIdentitySha256')
      ? { expectedResourceIdentitySha256: body.expectedResourceIdentitySha256 }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'expectedMirrorPlanSha256')
      ? { expectedMirrorPlanSha256: body.expectedMirrorPlanSha256 }
      : {}),
    ...(expected || {})
  }
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
  if (options.syncController === 'worker-v2' && !config.feishu.mirrorSyncEnabled) {
    const error = new Error('worker-v2 只允许执行字段契约明确的飞书镜像同步')
    error.code = 'WORKER_MIRROR_MODE_REQUIRED'
    error.statusCode = 409
    error.safeBeforeWrite = true
    throw error
  }
  if (options.syncController === 'worker-v2' &&
      config.feishu.noteMaterialSyncEnabled === true && !formalNoteMaterialConfigurationReady(options)) {
    const error = new Error('worker-v2 只允许执行配置完整的房源笔记确定性素材管线')
    error.code = 'WORKER_NOTE_MATERIAL_MODE_REQUIRED'
    error.statusCode = 409
    error.safeBeforeWrite = true
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
  const noteMaterialsReady = effectiveNoteMaterialSyncEnabled() && formalNoteMaterialConfigurationReady()
  const automaticState = automaticWorkerConfigurationStatus()
  const sourceReady = config.feishu.syncEnabled && (config.feishu.mirrorSyncEnabled
    ? (config.feishu.autoSyncEnabled ? automaticState.ready : mirrorState.ready)
    : legacyReady)
  return {
    ready: sourceReady,
    mode: config.feishu.mirrorSyncEnabled
      ? '飞书专用源表镜像'
      : (hasLocalFiles ? '本地文件导入' : (hasBitable ? '飞书多维表' : '飞书表格')),
    syncEnabled: config.feishu.syncEnabled,
    autoSyncEnabled: config.feishu.autoSyncEnabled,
    automaticReady: automaticState.ready,
    mirrorSyncEnabled: config.feishu.mirrorSyncEnabled,
    recordsReady: config.feishu.mirrorSyncEnabled
      ? mirrorState.sourceTableReady && mirrorState.miniTableReady && mirrorState.locationTableReady
      : (hasLocalFiles || hasBitable || hasSheet),
    sheetReady: hasSheet,
    materialsReady: config.feishu.mirrorSyncEnabled ? mirrorState.materialsReady : hasFolder,
    noteMaterialsReady,
    sourceTableReady: mirrorState.sourceTableReady,
    miniTableReady: mirrorState.miniTableReady,
    locationTableReady: mirrorState.locationTableReady,
    rentedTableReady: mirrorState.rentedTableReady,
    historyTableReady: mirrorState.historyTableReady,
    tableIdsDistinct: mirrorState.tableIdsDistinct,
    tableResourcesDistinct: mirrorState.tableResourcesDistinct,
    sourceBaseReady: mirrorState.sourceBaseReady,
    targetBaseReady: mirrorState.targetBaseReady,
    crossBaseTokensReady: mirrorState.crossBaseTokensReady,
    sourceBaseReadOnlyBoundaryReady: mirrorState.sourceBaseReadOnlyBoundaryReady,
    sourceBindingsReady: mirrorState.sourceBindingsReady,
    miniBindingsReady: mirrorState.miniBindingsReady,
    locationBindingsReady: mirrorState.locationBindingsReady,
    rentedBindingsReady: mirrorState.rentedBindingsReady,
    historyBindingsReady: mirrorState.historyBindingsReady,
    aiFoundationEnabled: mirrorState.aiFoundationEnabled,
    pairedBindingsReady: mirrorState.pairedBindingsReady,
    uploadToOss: config.feishu.uploadToOss,
    syncIntervalMinutes: config.feishu.syncIntervalMinutes,
    folderToken: config.feishu.folderToken ? `${config.feishu.folderToken.slice(0, 6)}...` : '',
    bitableAppToken: config.feishu.bitableAppToken ? `${config.feishu.bitableAppToken.slice(0, 6)}...` : '',
    sourceBitableAppToken: config.feishu.sourceBitableAppToken ? `${config.feishu.sourceBitableAppToken.slice(0, 6)}...` : '',
    targetBitableAppToken: config.feishu.targetBitableAppToken ? `${config.feishu.targetBitableAppToken.slice(0, 6)}...` : '',
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
  automaticWorkerConfigurationStatus,
  sheetSnapshot,
  cachedSheetSnapshot,
  cachedSheetSnapshotV2,
  unavailableSheetSnapshot,
  unavailableSheetSnapshotV2,
  refreshSheetSnapshot,
  normalizeRecord,
  applySync,
  isCommittableSyncResult,
  parseAdminDryRun,
  parseAdminSyncRequest,
  sanitizeSheetSnapshot,
  configuredFoundationEnrichment,
  reconcilePartialBaseWrites,
  _internal: {
    roomIdentityKey,
    existingByExternalId,
    createMaterialMatcher,
    canonicalMirrorRecordToSyncRow,
    executeMirrorTableSync,
    mirrorConfigurationStatus,
    automaticWorkerConfigurationStatus,
    assertFoundationEnrichmentConfiguration,
    configuredMirrorTableSync,
    syncMirrorNoteMaterials,
    syncNoteMaterialsAfterInventory,
    finalizeMirrorSyncResult,
    recordMirrorSyncOutcome,
    reconcileInventoryVideoSummary,
    sourceBindingsWithNoteMaterial,
    noteMaterialFieldContractReady,
    mirrorMaterialPolicy,
    formalNoteMaterialConfigurationReady,
    createNotePrimaryVideoAttachmentAdapter,
    sourceNoteMaterialRows,
    bindingContractStatus,
    resolvedContractBindings,
    pairedMirrorBindingsReady,
    loadConfiguredMirrorMaterials,
    loadFolderMaterials,
    feishuJson,
    buildLegacyMaterialEvidence,
    semanticFieldsForWrite,
    assertMirrorDeactivateSafety,
    activeFeishuSourceRecordIds,
    activeFeishuFoundationIdentityKeys,
    contentPlanConfirmationRequired,
    prepareMirrorContentPlanConfirmation,
    runMirrorContentPlanPreflight,
    enforceFormalContentPlanResult,
    stableCreateClientToken,
    stableUpdateClientToken,
    foundationBaselineCompleted,
    foundationArchiveFields,
    lifecycleHistoryOperations,
    foundationEnrichmentPlanSha256,
    buildMirrorSafetyDigests,
    buildPartialBaseReconciliationEvidence,
    reconcilePartialBaseWritesWithConfiguredSync,
    assertMirrorSafetyDigestConfirmation,
    executeFoundationEnrichment
  }
}
