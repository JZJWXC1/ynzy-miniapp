'use strict'

const crypto = require('crypto')

const COMPANY_SHEET_TITLE = '寓你住一起房源表'
const COMPANY_SHEET_HEADERS = Object.freeze([
  '行政区',
  '板块/商圈',
  '小区',
  '小区+房号',
  '户型描述',
  '户型分类',
  '月租金',
  '看房方式',
  '备注',
  '房源状态'
])

const MIRROR_SOURCE_FIELDS = Object.freeze([
  'rentMode',
  'layoutDescription',
  'layoutCategory',
  'monthlyRent',
  'viewingMethod',
  'remark',
  'vacancyNote',
  'listingStatus',
  'contact',
  'viewingPassword',
  'landlordCommissionPercent',
  'tags'
])

const FOUNDATION_MIRROR_FIELDS = Object.freeze([
  'foundationListingId',
  'temporaryListingId',
  'yuxiaoerListingId',
  'yuxiaoerRoomId',
  'identityType',
  'physicalUnitKey',
  'lifecycleStatusText',
  'sourceCreatedAt',
  'availabilityCycleNo',
  'availabilityCycleId',
  'metricKind',
  'lifecycleDays',
  'listingOwner',
  'ownerDepartment',
  'sourcePresent',
  'identityAliases',
  'lifecycleVersion'
])

const MANAGED_MIRROR_FIELDS = Object.freeze([
  'sourceRecordId',
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
  ...MIRROR_SOURCE_FIELDS,
  'video',
  'published',
  'canonical',
  'enabled'
])
const ACTIVE_LISTING_STATUS_PATTERN = /^(?:上架|已上架|在租|待租|待出租|即将空出|空置|可租|有效|开放|可看|可出租|up|on|active)$/i
const INACTIVE_LISTING_STATUS_PATTERN = /^(?:下架|已下架|已租|已出租|已成交|成交|关闭|已关闭|无效|删除|已删除|暂停|暂缓|维修中|不可租|停租|未上架|不上架|未在租|不在租|down|off|inactive|rented|closed)$/i
const EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE = 'employee-current-stock-v1'
const EMPLOYEE_AI_FOUNDATION_PROFILE = 'employee-ai-foundation-v1'

function normalizeText(value) {
  if (value === undefined || value === null) return ''
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function identityKey(value) {
  return normalizeText(value).toLocaleLowerCase('zh-CN')
}

function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (value && typeof value === 'object') {
    const output = {}
    Object.keys(value).forEach((key) => {
      if (value[key] !== undefined) output[key] = clonePlain(value[key])
    })
    return output
  }
  return value
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const output = {}
    Object.keys(value).sort().forEach((key) => {
      if (value[key] !== undefined) output[key] = stableValue(value[key])
    })
    return output
  }
  return value
}

function stableSha256(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

function exactObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort())
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function validDigestCount(value) {
  return exactObjectKeys(value, ['count', 'digest']) &&
    Number.isSafeInteger(value.count) && value.count >= 0 && validSha256(value.digest)
}

function validComponentEvidence(evidence, expectedSha256) {
  if (!exactObjectKeys(evidence, [
    'baselineMarker',
    'companySheet',
    'contract',
    'legacyMaterials',
    'operations',
    'snapshots'
  ]) || evidence.contract !== 'feishu-mirror-component-evidence-v1' ||
      !Array.isArray(evidence.snapshots) ||
      !exactObjectKeys(evidence.operations, ['archive', 'history', 'main']) ||
      !validDigestCount(evidence.operations.main) ||
      !validDigestCount(evidence.operations.archive) ||
      !validDigestCount(evidence.operations.history) ||
      !validDigestCount(evidence.baselineMarker) ||
      !validDigestCount(evidence.legacyMaterials) ||
      !exactObjectKeys(evidence.companySheet, ['columnCount', 'digest', 'rowCount']) ||
      !Number.isSafeInteger(evidence.companySheet.rowCount) || evidence.companySheet.rowCount < 0 ||
      !Number.isSafeInteger(evidence.companySheet.columnCount) ||
      evidence.companySheet.columnCount < 0 || !validSha256(evidence.companySheet.digest)) return false
  const roles = evidence.snapshots.map((snapshot) => snapshot && snapshot.role)
  const validRoleSequences = [
    ['source', 'location', 'mini'],
    ['source', 'location', 'mini', 'rented'],
    ['source', 'location', 'mini', 'history'],
    ['source', 'location', 'mini', 'rented', 'history']
  ]
  if (!validRoleSequences.some((expected) => JSON.stringify(roles) === JSON.stringify(expected)) ||
      evidence.snapshots.some((snapshot) => (
        !exactObjectKeys(snapshot, ['digest', 'recordCount', 'role']) ||
        !['source', 'location', 'mini', 'rented', 'history'].includes(snapshot.role) ||
        !validSha256(snapshot.digest) ||
        !Number.isSafeInteger(snapshot.recordCount) || snapshot.recordCount < 0
      ))) return false
  return validSha256(expectedSha256) && stableSha256(evidence) === expectedSha256
}

function publicInventorySummary(result = {}) {
  const summary = result && typeof result === 'object' && !Array.isArray(result)
    ? clonePlain(result)
    : {}
  delete summary.componentEvidence
  delete summary.componentEvidenceSha256
  return summary
}

function equalPlain(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

function aliasesOf(location) {
  if (Array.isArray(location.aliases)) return location.aliases
  if (typeof location.aliases === 'string') return location.aliases.split(/[\n,，;；]+/)
  return []
}

function normalizeRoomPart(value, type) {
  let text = normalizeText(value).replace(/\s+/g, '').replace(/[，,。；;:：]/g, '')
  if (!text) return ''
  if (type === 'building') return text.replace(/^第/, '').replace(/(?:号楼|楼|幢|栋|号)$/g, '')
  if (type === 'unit') return text.replace(/^第/, '').replace(/单元$/g, '')
  return text.replace(/^第/, '').replace(/(?:房间|房|室)$/g, '')
}

function validRoomPart(value) {
  return /^[0-9A-Za-z一二三四五六七八九十百]+$/.test(value)
}

function validRoomNumber(value) {
  return validRoomPart(value) || /^[0-9]+-[0-9]+$/.test(value)
}

function stripTrailingChineseRoomAnnotation(value) {
  const text = normalizeText(value).replace(/\s+/g, '')
  const fullWidth = text.match(/^(.*)（[\u3400-\u4DBF\u4E00-\u9FFF]{1,12}）$/)
  if (fullWidth && fullWidth[1]) return fullWidth[1]
  const halfWidth = text.match(/^(.*)\([\u3400-\u4DBF\u4E00-\u9FFF]{1,12}\)$/)
  if (halfWidth && halfWidth[1]) return halfWidth[1]
  return text
}

function parseRoomIdentity(value) {
  const text = stripTrailingChineseRoomAnnotation(value)
  if (!text) return null
  let parts = null
  const dashed = text.split(/[-－—_/]/).map((item) => item.trim())
  if (dashed.length > 1 && dashed.some((item) => !item)) return null
  if (dashed.length === 4) {
    if (!dashed.every((item) => /^[0-9]+$/.test(item))) return null
    parts = {
      building: dashed[0],
      unit: dashed[1],
      roomNumber: `${dashed[2]}-${dashed[3]}`
    }
  } else if (dashed.length > 4) {
    return null
  } else if (dashed.length === 3) {
    parts = { building: dashed[0], unit: dashed[1], roomNumber: dashed[2] }
  } else if (dashed.length === 2) {
    parts = { building: dashed[0], unit: '', roomNumber: dashed[1] }
  } else {
    const withUnit = text.match(/^(.+?)(?:号楼|楼|幢|栋)(.+?)单元(.+?)(?:房间|房|室)?$/)
    const withoutUnit = text.match(/^(.+?)(?:号楼|楼|幢|栋)[-－—_/]*(.+?)(?:房间|房|室)?$/)
    if (withUnit) parts = { building: withUnit[1], unit: withUnit[2], roomNumber: withUnit[3] }
    else if (withoutUnit) parts = { building: withoutUnit[1], unit: '', roomNumber: withoutUnit[2] }
  }
  if (!parts) return null
  const normalized = {
    building: normalizeRoomPart(parts.building, 'building'),
    unit: normalizeRoomPart(parts.unit, 'unit'),
    roomNumber: normalizeRoomPart(parts.roomNumber, 'room')
  }
  if (!normalized.building || !normalized.roomNumber || !validRoomPart(normalized.building) ||
      (normalized.unit && !validRoomPart(normalized.unit)) || !validRoomNumber(normalized.roomNumber)) return null
  return normalized
}

function canonicalRoomIdentity(sourceFields, location, sourceRecordId) {
  const rawRoomLabel = normalizeText(sourceFields.roomLabel)
  const prefixCandidates = [sourceFields.community, location.community, ...aliasesOf(location)]
    .map(normalizeText)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const matchedPrefix = prefixCandidates.find((prefix) => identityKey(rawRoomLabel).startsWith(identityKey(prefix)))
  if (!matchedPrefix) throw new Error(`源记录 ${sourceRecordId} 的小区+房号不属于位置字典小区`)
  const roomText = rawRoomLabel.slice(matchedPrefix.length).replace(/^[\s·,，。；;:：/\\_\-－—（）()【】\[\]]+/, '')
  const parsed = parseRoomIdentity(roomText)
  if (!parsed) throw new Error(`源记录 ${sourceRecordId} 的小区+房号格式无法确定解析`)

  const explicit = {
    building: normalizeRoomPart(sourceFields.building, 'building'),
    unit: normalizeRoomPart(sourceFields.unit, 'unit'),
    roomNumber: normalizeRoomPart(sourceFields.roomNumber, 'room')
  }
  const explicitValues = [explicit.building, explicit.unit, explicit.roomNumber].filter(Boolean)
  if (explicitValues.length && (explicit.building !== parsed.building || explicit.unit !== parsed.unit ||
      explicit.roomNumber !== parsed.roomNumber)) {
    throw new Error(`源记录 ${sourceRecordId} 的显式楼栋/单元/房号与小区+房号不一致`)
  }
  return {
    ...parsed,
    roomLabel: `${location.community} ${parsed.building}幢${parsed.unit ? `${parsed.unit}单元` : ''}${parsed.roomNumber}`
  }
}

function optionalCoordinate(value, label) {
  if (value === undefined || value === null || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) throw new Error(`位置字典${label}不是有效数字`)
  return numeric
}

function buildLocationCatalog(locationRecords) {
  if (!Array.isArray(locationRecords)) throw new Error('位置字典必须是记录数组')

  const byName = new Map()
  const locationIds = new Set()
  const recordIds = new Set()
  const locations = []

  locationRecords.forEach((rawLocation, index) => {
    if (!rawLocation || rawLocation.enabled !== true) return

    const location = {
      recordId: normalizeText(rawLocation.recordId || rawLocation.record_id),
      locationId: normalizeText(rawLocation.locationId),
      city: normalizeText(rawLocation.city),
      district: normalizeText(rawLocation.district),
      block: normalizeText(rawLocation.block),
      community: normalizeText(rawLocation.community),
      aliases: aliasesOf(rawLocation).map(normalizeText).filter(Boolean),
      latitude: optionalCoordinate(rawLocation.latitude, '纬度'),
      longitude: optionalCoordinate(rawLocation.longitude, '经度'),
      enabled: true
    }

    if (!location.recordId || !location.locationId || !location.city || !location.district || !location.block || !location.community) {
      throw new Error(`位置字典第 ${index + 1} 行缺少 recordId、locationId、城市、行政区、板块或小区`)
    }
    if (location.latitude === null || location.longitude === null) {
      throw new Error(`位置字典第 ${index + 1} 行缺少经纬度，新增小区将无法上图`)
    }
    if (location.latitude !== null && (location.latitude < -90 || location.latitude > 90)) {
      throw new Error(`位置字典第 ${index + 1} 行纬度超出范围`)
    }
    if (location.longitude !== null && (location.longitude < -180 || location.longitude > 180)) {
      throw new Error(`位置字典第 ${index + 1} 行经度超出范围`)
    }
    if (recordIds.has(location.recordId)) throw new Error(`位置字典 recordId 重复：${location.recordId}`)
    if (locationIds.has(location.locationId)) throw new Error(`位置字典 locationId 重复：${location.locationId}`)
    recordIds.add(location.recordId)
    locationIds.add(location.locationId)

    const names = [location.community, ...location.aliases]
    const localNames = new Set()
    names.forEach((name) => {
      const key = identityKey(name)
      if (!key || localNames.has(key)) return
      localNames.add(key)
      const occupied = byName.get(key)
      if (occupied && occupied.locationId !== location.locationId) {
        throw new Error(`位置字典标准名或别名冲突：${name}`)
      }
      byName.set(key, location)
    })
    locations.push(location)
  })

  if (!locations.length) throw new Error('位置字典没有启用的有效记录')
  return { locations, byName }
}

function assertSnapshot(snapshot, label, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`${label}不存在`)
  if (snapshot.complete !== true) throw new Error(`${label}不完整，禁止生成写入计划`)
  if (!Array.isArray(snapshot.records)) throw new Error(`${label} records 不是数组`)
  if (snapshot.recordCount !== undefined && snapshot.recordCount !== snapshot.records.length) {
    throw new Error(`${label}记录数不一致，禁止生成写入计划`)
  }
  if (options.nonEmpty && snapshot.records.length === 0) throw new Error(`${label}为空，禁止覆盖现有数据`)
}

function sourceRecordIdOf(record) {
  return normalizeText(record && (record.recordId || record.record_id))
}

function mirrorFieldsOf(record) {
  return record && record.fields && typeof record.fields === 'object' ? record.fields : {}
}

function assertUniqueSourceRecords(records) {
  const seen = new Set()
  records.forEach((record, index) => {
    const recordId = sourceRecordIdOf(record)
    if (!recordId) throw new Error(`源记录第 ${index + 1} 行缺少 recordId`)
    if (seen.has(recordId)) throw new Error(`源 recordId 重复：${recordId}`)
    seen.add(recordId)
  })
}

function indexMirrorRecords(records) {
  const bySourceRecordId = new Map()
  const mirrorRecordIds = new Set()
  records.forEach((record, index) => {
    const recordId = sourceRecordIdOf(record)
    const sourceRecordId = normalizeText(mirrorFieldsOf(record).sourceRecordId)
    if (!recordId) throw new Error(`镜像记录第 ${index + 1} 行缺少 recordId`)
    if (!sourceRecordId) throw new Error(`镜像记录 ${recordId} 缺少 sourceRecordId`)
    if (mirrorRecordIds.has(recordId)) throw new Error(`镜像 recordId 重复：${recordId}`)
    if (bySourceRecordId.has(sourceRecordId)) throw new Error(`镜像 sourceRecordId 重复：${sourceRecordId}`)
    mirrorRecordIds.add(recordId)
    bySourceRecordId.set(sourceRecordId, record)
  })
  return bySourceRecordId
}

function resolveLocation(locationCatalog, sourceRecord) {
  if (!locationCatalog || !(locationCatalog.byName instanceof Map)) throw new Error('位置字典尚未构建')
  const fields = mirrorFieldsOf(sourceRecord)
  const sourceCommunity = normalizeText(fields.community)
  const location = locationCatalog.byName.get(identityKey(sourceCommunity))
  if (!location) {
    throw new Error(`位置字典未匹配小区：${sourceCommunity || '空值'}`)
  }
  return location
}

function layoutCategoryFromDescription(value) {
  const text = normalizeText(value)
  const categories = {
    '1': '一室',
    一: '一室',
    '2': '两室',
    二: '两室',
    两: '两室',
    '3': '三室',
    三: '三室',
    '4': '四室',
    四: '四室',
    '5': '五室',
    五: '五室',
    '6': '六室',
    六: '六室'
  }
  const tokens = [...text.matchAll(/([0-9]+|[零〇一二两三四五六七八九十百]+)(?:室|房)/g)]
    .map((match) => match[1])
  if (tokens.some((token) => !categories[token])) return ''
  const derived = new Set(tokens.map((token) => categories[token]))
  if (derived.size > 1) return ''
  if (derived.size === 1) return [...derived][0]
  return /单间/.test(text) ? '一室' : ''
}

function stableVideoAttachments(value) {
  if (value === undefined || value === null || value === '') return []
  const attachments = Array.isArray(value) ? value : [value]
  const tokens = attachments.map((attachment) => {
    if (!attachment || typeof attachment !== 'object') throw new Error('视频附件结构无效')
    const token = normalizeText(attachment.file_token || attachment.token || attachment.obj_token)
    const name = normalizeText(attachment.name || attachment.file_name || attachment.filename)
    const type = normalizeText(attachment.type || attachment.file_type || attachment.mime_type)
    if (!token) throw new Error('视频附件缺少 file_token')
    if ((name || type) && !/\.(mp4|mov|m4v|avi|webm)$/i.test(name) && !/^video\//i.test(type)) {
      throw new Error('视频附件字段包含非视频文件')
    }
    return token
  })
  if (new Set(tokens).size !== tokens.length) throw new Error('视频附件 file_token 重复')
  if (tokens.length > 1) throw new Error('同一房源存在多个视频附件，禁止先到先得')
  return tokens.sort().map((fileToken) => ({ file_token: fileToken }))
}

function canonicalTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[、,，;；\n]+/)
  const seen = new Set()
  return values.map(normalizeText).filter(Boolean).filter((item) => {
    const key = identityKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hasBusinessValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return normalizeText(value) !== ''
  if (Array.isArray(value)) return value.some(hasBusinessValue)
  if (typeof value === 'object') return Object.values(value).some(hasBusinessValue)
  return true
}

function deriveEmployeeCurrentStockRentMode(fields, sourceRecordId) {
  const layoutDescription = normalizeText(fields.layoutDescription)
  const layoutCategory = normalizeText(fields.layoutCategory)
  const roomTail = stripTrailingChineseRoomAnnotation(fields.roomNumber || fields.roomLabel)
    .replace(/(?:房间|房|室)$/g, '')
  if (/整租|\(整\)/.test(layoutDescription)) return '整租'
  if (/单间/.test(layoutCategory) || /[A-Za-z]$/.test(roomTail)) return '合租'
  if (/\d$/.test(roomTail) && /(?:一|二|两|三|四|五|六)室/.test(layoutCategory)) return '整租'
  throw new Error(`源记录 ${sourceRecordId} 无法按员工现表规则派生出租方式`)
}

function normalizeEmployeeCurrentStockRoomLabel(fields) {
  const roomLabel = normalizeText(fields.roomLabel)
  const normalizedRoomLabel = roomLabel
    .replace(/\s*(?:\d+(?:\.\d+)?%\s*)?月佣\s*$/u, '')
    .trim()
  if (/月佣/u.test(normalizedRoomLabel)) {
    throw new Error('员工现表房号中的月佣注记只能位于末尾')
  }
  fields.roomLabel = normalizedRoomLabel
}

function normalizeEmployeeCurrentStockCommunity(fields, locationCatalog, sourceRecordId) {
  const sourceCommunity = normalizeText(fields.community)
  if (sourceCommunity) {
    // 生产镜像始终会传入本轮完整、已校验的位置字典。非空小区也必须在这里
    // 命中并归一，避免未知新小区绕过来源契约、拖到计划阶段才变成模糊失败。
    if (!locationCatalog || !(locationCatalog.byName instanceof Map)) {
      const error = new Error('本轮缺少已校验位置字典，禁止处理员工源小区')
      error.code = 'SOURCE_LOCATION_CATALOG_REQUIRED'
      throw error
    }
    const location = locationCatalog.byName.get(identityKey(sourceCommunity))
    if (!location) {
      const error = new Error('员工源存在未收录位置字典的小区，已在来源校验阶段阻断')
      error.code = 'SOURCE_COMMUNITY_UNMAPPED'
      throw error
    }
    fields.community = location.community
    return
  }
  if (!locationCatalog || !(locationCatalog.byName instanceof Map)) {
    throw new Error(`源记录 ${sourceRecordId} 的小区列为空且缺少已校验位置字典`)
  }
  const roomLabelKey = identityKey(fields.roomLabel)
  const prefixMatches = []
  locationCatalog.byName.forEach((location, nameKey) => {
    if (nameKey && roomLabelKey.startsWith(nameKey)) {
      prefixMatches.push({ nameKey, location })
    }
  })
  if (!prefixMatches.length) {
    throw new Error(`源记录 ${sourceRecordId} 的小区列为空且房号前缀未匹配位置字典`)
  }
  const longestLength = Math.max(...prefixMatches.map((item) => item.nameKey.length))
  const longestLocations = new Map()
  prefixMatches.filter((item) => item.nameKey.length === longestLength).forEach((item) => {
    longestLocations.set(item.location.locationId, item.location)
  })
  if (longestLocations.size !== 1) {
    throw new Error(`源记录 ${sourceRecordId} 的房号前缀在位置字典中不唯一`)
  }
  fields.community = Array.from(longestLocations.values())[0].community
}

function looksLikeEmployeeContactNumber(value) {
  const text = normalizeText(value).toLowerCase()
  return /(?<!\d)(?:(?:\+?86|0086)\D*)?1[3-9](?:\D*\d){9}(?!\d)/.test(text) ||
    /(?<!\d)(?:(?:\+?86|0086)\D*)?0(?:\D*\d){9,11}(?!\d)/.test(text) ||
    /(?<!\d)(?:(?:\+?86|0086)\D*)?(?:400|800)(?:\D*\d){7}(?!\d)/.test(text)
}

function looksLikeSensitiveViewingCredential(value) {
  const text = normalizeText(value).toLowerCase()
  if (!text) return false
  return looksLikeEmployeeContactNumber(text) ||
    /(?:wxid|wechat|weixin|微信|加微|vx|qq)/i.test(text) ||
    /(?:联系|电话|手机|房东|管家|空出|退租|到期|搬离|可看|钥匙)/.test(text) ||
    /^(?:19|20)\d{2}$/.test(text) ||
    /(?:19|20)\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?/.test(text) ||
    /(?:19|20)\d{6}/.test(text) ||
    /\d{1,2}月\d{1,2}日/.test(text)
}

function isVerifiedEmployeeLegacyDoorCode(value) {
  const text = normalizeText(value)
  if (/^\d{4}$/.test(text)) return !/^(?:19|20)\d{2}$/.test(text)
  return /^(?=[0-9#]{7}$)(?=.*\d)(?=.*#)[0-9#]{7}$/.test(text)
}

function normalizeEmployeeCurrentStockViewingAccess(fields, sourceBindings, sourceRecordId) {
  const sourceViewingMethod = normalizeText(fields.viewingMethod)
  const hasExplicitViewingPassword = Object.prototype.hasOwnProperty.call(sourceBindings, 'viewingPassword')
  const explicitViewingPassword = normalizeText(fields.viewingPassword)
  const explicitPasswordSemantics = (
    hasExplicitViewingPassword &&
    !looksLikeSensitiveViewingCredential(sourceViewingMethod) &&
    /^[0-9#*A-Za-z._-]{3,20}$/.test(sourceViewingMethod)
  )

  if (/钥匙/.test(sourceViewingMethod)) {
    if (hasExplicitViewingPassword && explicitViewingPassword) {
      throw new Error(`源记录 ${sourceRecordId} 的看房方式为钥匙但显式密码列非空`)
    }
    fields.viewingMethod = '钥匙'
    fields.viewingPassword = ''
    return
  }
  if (isVerifiedEmployeeLegacyDoorCode(sourceViewingMethod) || explicitPasswordSemantics) {
    fields.viewingMethod = '密码'
    if (hasExplicitViewingPassword) {
      if (!explicitViewingPassword) {
        throw new Error(`源记录 ${sourceRecordId} 的看房方式为密码但显式密码列为空`)
      }
      fields.viewingPassword = explicitViewingPassword
    } else {
      fields.viewingPassword = sourceViewingMethod
    }
    return
  }
  if (hasExplicitViewingPassword && explicitViewingPassword) {
    throw new Error(`源记录 ${sourceRecordId} 的看房方式为联系房东但显式密码列非空`)
  }
  fields.viewingMethod = '联系房东'
  fields.viewingPassword = ''
}

function prepareSourceSnapshotForCompatibility(sourceSnapshot, options = {}) {
  const profile = normalizeText(options.profile)
  if (!profile) return sourceSnapshot
  const isCurrentStockProfile = profile === EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE
  const isAiFoundationProfile = profile === EMPLOYEE_AI_FOUNDATION_PROFILE
  if (!isCurrentStockProfile && !isAiFoundationProfile) {
    throw new Error(`未知员工源兼容配置：${profile}`)
  }
  const sourceBindings = options.sourceBindings && typeof options.sourceBindings === 'object' &&
    !Array.isArray(options.sourceBindings)
    ? options.sourceBindings
    : {}
  const boundFields = Object.keys(sourceBindings)
  if (!boundFields.length) throw new Error('员工源兼容配置缺少字段绑定')

  const records = (sourceSnapshot && Array.isArray(sourceSnapshot.records) ? sourceSnapshot.records : [])
    .reduce((prepared, record) => {
      const sourceRecordId = sourceRecordIdOf(record)
      const sourceFields = mirrorFieldsOf(record)
      const isEmptyTemplate = boundFields.every((field) => !hasBusinessValue(sourceFields[field]))
      if (isEmptyTemplate) return prepared
      if (!hasBusinessValue(sourceFields.roomLabel)) {
        throw new Error(`源记录 ${sourceRecordId || '未知'} 为半填行，缺少小区+房号`)
      }

      const fields = clonePlain(sourceFields)
      normalizeEmployeeCurrentStockCommunity(fields, options.locationCatalog, sourceRecordId)
      normalizeEmployeeCurrentStockRoomLabel(fields)
      if (!Object.prototype.hasOwnProperty.call(sourceBindings, 'rentMode')) {
        fields.rentMode = deriveEmployeeCurrentStockRentMode(fields, sourceRecordId)
      }
      if (isAiFoundationProfile) {
        const hasExplicitVacancyNote = Object.prototype.hasOwnProperty.call(sourceBindings, 'vacancyNote')
        const sourceViewingMethod = normalizeText(fields.viewingMethod)
        fields.vacancyNote = hasExplicitVacancyNote
          ? normalizeText(fields.vacancyNote)
          : (sourceViewingMethod.includes('空出') ? sourceViewingMethod : '')
        fields.listingStatus = fields.vacancyNote ? '即将空出' : '待出租'
      } else if (!Object.prototype.hasOwnProperty.call(sourceBindings, 'listingStatus')) {
        fields.listingStatus = '在租'
      }
      normalizeEmployeeCurrentStockViewingAccess(fields, sourceBindings, sourceRecordId)
      // 员工现表分类保存“一室一厅 / 两室一厅 / 单间”等完整粒度，专用表只保存
      // 一至六室。只有分类与描述可独立派生且室数一致时才归一，真实冲突留给严格层阻断。
      const sourceLayoutCategory = normalizeText(fields.layoutCategory)
      const normalizedSourceLayoutCategory = layoutCategoryFromDescription(sourceLayoutCategory)
      const descriptionLayoutCategory = layoutCategoryFromDescription(fields.layoutDescription)
      if (sourceLayoutCategory &&
          normalizedSourceLayoutCategory &&
          normalizedSourceLayoutCategory === descriptionLayoutCategory) {
        fields.layoutCategory = descriptionLayoutCategory
      }
      prepared.push({
        ...clonePlain(record),
        fields
      })
      return prepared
    }, [])

  const digestRecords = records.map((record) => {
    const digestRecord = {
      recordId: sourceRecordIdOf(record),
      fields: stableValue(mirrorFieldsOf(record))
    }
    if (record && record.createdTimeMs !== undefined) {
      digestRecord.createdTimeMs = Number(record.createdTimeMs)
    }
    return digestRecord
  }).sort((left, right) => left.recordId.localeCompare(right.recordId))
  const digest = crypto.createHash('sha256').update(JSON.stringify(stableValue({
    version: 'feishu-employee-compatible-source-v1',
    records: digestRecords
  }))).digest('hex')

  return {
    ...clonePlain(sourceSnapshot),
    records,
    recordCount: records.length,
    // 原始 Base 快照可能包含会被兼容层明确丢弃的空模板；后续镜像计划只绑定
    // 实际参与业务投影的规范记录，避免空行或返回顺序制造假漂移。
    digest
  }
}

function canonicalMirrorFields(sourceRecord, location) {
  const sourceRecordId = sourceRecordIdOf(sourceRecord)
  const sourceFields = mirrorFieldsOf(sourceRecord)
  const roomIdentity = canonicalRoomIdentity(sourceFields, location, sourceRecordId)
  const fields = {
    sourceRecordId,
    locationId: location.locationId,
    locationRecordId: location.recordId,
    city: location.city,
    district: location.district,
    block: location.block,
    community: location.community,
    roomLabel: roomIdentity.roomLabel,
    building: roomIdentity.building,
    unit: roomIdentity.unit,
    roomNumber: roomIdentity.roomNumber
  }
  if (location.latitude !== null) fields.latitude = location.latitude
  if (location.longitude !== null) fields.longitude = location.longitude

  MIRROR_SOURCE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(sourceFields, field) && sourceFields[field] !== undefined) {
      fields[field] = clonePlain(sourceFields[field])
    }
  })
  if (Object.prototype.hasOwnProperty.call(sourceFields, 'video')) {
    fields.video = stableVideoAttachments(sourceFields.video)
  }
  fields.layoutDescription = clonePlain(
    sourceFields.layoutDescription !== undefined ? sourceFields.layoutDescription : sourceFields.layout
  )
  fields.layoutDescription = normalizeText(fields.layoutDescription)
  fields.rentMode = normalizeText(sourceFields.rentMode)
  ;['viewingMethod', 'remark', 'vacancyNote', 'contact', 'viewingPassword'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(sourceFields, field)) fields[field] = normalizeText(sourceFields[field])
  })
  if (fields.viewingPassword && looksLikeSensitiveViewingCredential(fields.viewingPassword)) {
    throw new Error(`源记录 ${sourceRecordId} 的看房密码包含联系电话、社交账号或日期说明`)
  }
  if (Object.prototype.hasOwnProperty.call(sourceFields, 'landlordCommissionPercent')) {
    const commissionText = normalizeText(sourceFields.landlordCommissionPercent)
    const commission = commissionText ? Number(commissionText.replace(/%$/, '')) : 50
    if (!Number.isFinite(commission) || commission < 0 || commission > 100) {
      throw new Error(`源记录 ${sourceRecordId} 的房东佣金比例无效`)
    }
    fields.landlordCommissionPercent = commission
  }
  if (Object.prototype.hasOwnProperty.call(sourceFields, 'tags')) fields.tags = canonicalTags(sourceFields.tags)
  const sourceLayoutCategory = normalizeText(sourceFields.layoutCategory)
  const derivedLayoutCategory = layoutCategoryFromDescription(fields.layoutDescription)
  if (!derivedLayoutCategory) throw new Error(`源记录 ${sourceRecordId} 无法从户型描述派生户型分类`)
  if (sourceLayoutCategory && sourceLayoutCategory !== derivedLayoutCategory) {
    throw new Error(`源记录 ${sourceRecordId} 的户型描述与户型分类不一致`)
  }
  fields.layoutCategory = derivedLayoutCategory
  const monthlyRent = Number(sourceFields.monthlyRent !== undefined ? sourceFields.monthlyRent : sourceFields.rent)
  fields.monthlyRent = monthlyRent
  fields.listingStatus = normalizeText(
    sourceFields.listingStatus !== undefined ? sourceFields.listingStatus : sourceFields.status
  )
  if (!fields.roomLabel || !fields.layoutDescription || !fields.listingStatus || !Number.isFinite(monthlyRent) || monthlyRent <= 0) {
    throw new Error(`源记录 ${sourceRecordId} 缺少小区+房号、户型、状态或有效月租金`)
  }
  if (!/^(?:整租|合租)$/.test(fields.rentMode)) {
    throw new Error(`源记录 ${sourceRecordId} 的出租方式必须明确为整租或合租`)
  }
  const statusText = normalizeText(fields.listingStatus)
  if (!ACTIVE_LISTING_STATUS_PATTERN.test(statusText) && !INACTIVE_LISTING_STATUS_PATTERN.test(statusText)) {
    throw new Error(`源记录 ${sourceRecordId} 的房源状态未配置：${statusText}`)
  }
  fields.published = ACTIVE_LISTING_STATUS_PATTERN.test(statusText)
  fields.canonical = true
  fields.enabled = true
  return fields
}

function managedFieldsOf(fields, options = {}) {
  const managed = {}
  const managedFields = options.includeFoundation === true
    ? Array.from(new Set([...MANAGED_MIRROR_FIELDS, ...FOUNDATION_MIRROR_FIELDS]))
    : MANAGED_MIRROR_FIELDS.filter((field) => !FOUNDATION_MIRROR_FIELDS.includes(field))
  managedFields.forEach((field) => {
    if (options.ignoreVacancyNote === true && field === 'vacancyNote') return
    // 飞书清空单元格后会按字段类型回读为 null、省略、空字符串或空数组；这些形态
    // 与源字段未提供等价。已有非空旧值仍会保留在 managed 中并由本轮写空清除。
    const value = fields[field]
    const hasValue = value !== undefined &&
      value !== null &&
      !(typeof value === 'string' && value.trim() === '') &&
      !(Array.isArray(value) && value.length === 0)
    if (Object.prototype.hasOwnProperty.call(fields, field) && hasValue) {
      managed[field] = field === 'video' ? stableVideoAttachments(fields[field]) : clonePlain(fields[field])
    }
  })
  return managed
}

function planMirrorSync({
  sourceSnapshot,
  mirrorSnapshot,
  locationCatalog,
  runId,
  ignoreVacancyNote
} = {}) {
  assertSnapshot(sourceSnapshot, '源快照', { nonEmpty: true })
  assertSnapshot(mirrorSnapshot, '镜像快照')
  assertUniqueSourceRecords(sourceSnapshot.records)
  const mirrorBySourceRecordId = indexMirrorRecords(mirrorSnapshot.records)

  // 先完成整批位置归一和校验，再生成任何动作，避免半批计划被误执行。
  const canonicalRows = sourceSnapshot.records.map((sourceRecord) => {
    const location = resolveLocation(locationCatalog, sourceRecord)
    const sourceFields = mirrorFieldsOf(sourceRecord)
    const rawRoomLabel = normalizeText(sourceFields.roomLabel)
    const matchedPrefix = [sourceFields.community, location.community, ...aliasesOf(location)]
      .map(normalizeText)
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .find((prefix) => identityKey(rawRoomLabel).startsWith(identityKey(prefix)))
    const roomText = matchedPrefix
      ? rawRoomLabel.slice(matchedPrefix.length).replace(/^[\s·,，。；;:：/\\_\-－—（）()【】\[\]]+/, '')
      : ''
    return {
      sourceRecordId: sourceRecordIdOf(sourceRecord),
      fields: canonicalMirrorFields(sourceRecord, location),
      strippedRoomAnnotation: Boolean(roomText) && stripTrailingChineseRoomAnnotation(roomText) !== normalizeText(roomText).replace(/\s+/g, '')
    }
  })

  const physicalRoomKeys = new Map()
  canonicalRows.forEach(({ fields, strippedRoomAnnotation }) => {
    const physicalRoomKey = [
      fields.locationId,
      fields.building,
      fields.unit,
      fields.roomNumber
    ].map(identityKey).join('\u0000')
    const existing = physicalRoomKeys.get(physicalRoomKey)
    if (existing && (existing.strippedRoomAnnotation || strippedRoomAnnotation)) {
      throw new Error('源快照存在重复物理房源身份，请核对小区、楼栋、单元和房号')
    }
    if (!existing) physicalRoomKeys.set(physicalRoomKey, { strippedRoomAnnotation })
  })

  canonicalRows.sort((left, right) => left.sourceRecordId < right.sourceRecordId ? -1 : left.sourceRecordId > right.sourceRecordId ? 1 : 0)
  const operations = []
  const activeSourceRecordIds = new Set()
  const counts = { create: 0, update: 0, deactivate: 0, restore: 0, noop: 0 }

  canonicalRows.forEach(({ sourceRecordId, fields }) => {
    activeSourceRecordIds.add(sourceRecordId)
    const existing = mirrorBySourceRecordId.get(sourceRecordId)
    if (!existing) {
      operations.push({ type: 'create', sourceRecordId, fields: clonePlain(fields) })
      counts.create += 1
      return
    }

    const existingFields = mirrorFieldsOf(existing)
    const recordId = sourceRecordIdOf(existing)
    if (existingFields.enabled !== true) {
      operations.push({ type: 'restore', recordId, sourceRecordId, fields: clonePlain(fields) })
      counts.restore += 1
      return
    }

    const managedOptions = { ignoreVacancyNote }
    if (!equalPlain(managedFieldsOf(existingFields, managedOptions), managedFieldsOf(fields, managedOptions))) {
      operations.push({ type: 'update', recordId, sourceRecordId, fields: clonePlain(fields) })
      counts.update += 1
      return
    }
    counts.noop += 1
  })

  Array.from(mirrorBySourceRecordId.entries())
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .forEach(([sourceRecordId, record]) => {
      if (activeSourceRecordIds.has(sourceRecordId)) return
      const fields = mirrorFieldsOf(record)
      if (fields.enabled !== true) {
        counts.noop += 1
        return
      }
      operations.push({
        type: 'deactivate',
        recordId: sourceRecordIdOf(record),
        sourceRecordId,
        fields: {
          listingStatus: '已下架',
          published: false,
          enabled: false
        }
      })
      counts.deactivate += 1
    })

  return {
    complete: true,
    runId: normalizeText(runId),
    operations,
    counts,
    noop: operations.length === 0
  }
}

function publicCell(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? value : ''
  if (typeof value === 'string') return value.trim()
  return ''
}

function sheetFieldsOf(record) {
  return record && record.fields && typeof record.fields === 'object' ? record.fields : (record || {})
}

function snapshotRow(fields) {
  return [
    publicCell(fields.district),
    publicCell(fields.block),
    publicCell(fields.community),
    publicCell(fields.roomLabel),
    publicCell(fields.layoutDescription !== undefined ? fields.layoutDescription : fields.layout),
    publicCell(fields.layoutCategory),
    publicCell(fields.monthlyRent !== undefined ? fields.monthlyRent : fields.rent),
    publicCell(fields.viewingMethod),
    publicCell(fields.remark),
    publicCell(fields.listingStatus !== undefined ? fields.listingStatus : fields.status)
  ]
}

function compareRows(left, right) {
  const leftKey = left.map((value) => String(value)).join('\u0000')
  const rightKey = right.map((value) => String(value)).join('\u0000')
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

function buildCompanySheetSnapshot(records) {
  if (!Array.isArray(records)) throw new Error('公司房源快照输入必须是记录数组')
  const rows = records
    .map(sheetFieldsOf)
    .filter((fields) => fields.enabled === true && fields.published === true && fields.canonical === true)
    .map(snapshotRow)
    .sort(compareRows)

  return {
    title: COMPANY_SHEET_TITLE,
    rows: [COMPANY_SHEET_HEADERS.slice(), ...rows]
  }
}

function publishCompanySnapshot(db, records, options = {}) {
  if (!db || typeof db !== 'object') throw new Error('数据库对象不存在')
  if (options.complete !== true) throw new Error('本轮公司房源同步不完整，拒绝发布快照')
  if (!Array.isArray(records) || records.length === 0) throw new Error('公司房源记录为空，拒绝覆盖上一份快照')

  const snapshot = buildCompanySheetSnapshot(records, options)
  if (snapshot.rows.length <= 1 && options.allowEmptyPublic !== true) {
    throw new Error('公司房源公开记录为空，拒绝覆盖上一份快照')
  }
  db.companySheetSnapshot = snapshot
  return snapshot
}

function classifyMirrorRunResult(result) {
  const input = result && typeof result === 'object' ? result : {}
  const dryRunValidated = input.dryRun === true && input.validated === true && input.planned === true
  const success = input.complete === true &&
    (input.published === true || dryRunValidated) &&
    input.failed === 0 &&
    input.schemaInvalid === false &&
    input.mirrorIncomplete === false

  let status = 'failed'
  if (success) status = dryRunValidated ? 'success-dry-run' : (input.noop === true ? 'success-noop' : 'success')
  else if (typeof input.status === 'string' && !/^success(?:-|$)/i.test(input.status)) status = input.status

  return {
    complete: success,
    success,
    status,
    noop: success && input.noop === true,
    dryRun: success && dryRunValidated
  }
}

function stageSucceeded(result, options = {}) {
  if (!result || typeof result !== 'object' || result.complete !== true) return false
  if (options.requireFailed === true && result.failed !== 0) return false
  if (result.failed !== undefined && result.failed !== 0) return false
  if (options.published && result.published !== true) return false
  return true
}

function failedRun(stage, result) {
  return {
    complete: false,
    success: false,
    status: `failed-${stage}`,
    failedStage: stage,
    noop: false,
    failed: result && typeof result.failed === 'number' ? result.failed : 1
  }
}

function publicStageSummary(result = {}, options = {}) {
  const summary = {
    complete: result.complete === true,
    published: result.published === true,
    failed: typeof result.failed === 'number' && Number.isFinite(result.failed) ? result.failed : null,
    noop: result.noop === true,
    dryRun: result.dryRun === true,
    validated: result.validated === true,
    planned: result.planned === true,
    status: typeof result.status === 'string' ? result.status : ''
  }
  ;['schemaSha256', 'resourceIdentitySha256', 'mirrorPlanSha256'].forEach((field) => {
    if (/^[0-9a-f]{64}$/.test(String(result[field] || ''))) summary[field] = result[field]
  })
  if (options.includeComponentEvidence === true &&
      validComponentEvidence(result.componentEvidence, result.componentEvidenceSha256)) {
    summary.componentEvidence = clonePlain(result.componentEvidence)
    summary.componentEvidenceSha256 = result.componentEvidenceSha256
  }
  if (result.dryRun === true && Array.isArray(result.schemaBindings)) {
    summary.schemaBindings = result.schemaBindings.map((entry) => ({
      role: typeof (entry && entry.role) === 'string' ? entry.role : '',
      bindings: (entry && Array.isArray(entry.bindings) ? entry.bindings : []).map((binding) => ({
        semantic: typeof (binding && binding.semantic) === 'string' ? binding.semantic : '',
        fieldName: typeof (binding && binding.fieldName) === 'string' ? binding.fieldName : '',
        type: typeof (binding && binding.type) === 'string' ? binding.type : ''
      })).filter((binding) => binding.semantic && binding.fieldName && binding.type)
    })).filter((entry) => entry.role)
  }
  return summary
}

async function runCompanySourceSync({ db, mirrorSync, applyInventory, publishSnapshot, commit } = {}) {
  if (typeof mirrorSync !== 'function' || typeof applyInventory !== 'function' ||
      typeof publishSnapshot !== 'function' || typeof commit !== 'function') {
    throw new Error('公司房源同步缺少必要阶段函数')
  }

  const mirrorResult = await mirrorSync(db)
  const mirrorClassification = classifyMirrorRunResult(mirrorResult)
  if (!mirrorClassification.success) return failedRun('mirror', mirrorResult)

  const records = Array.isArray(mirrorResult.records) ? mirrorResult.records : []
  const inventoryResult = await applyInventory(db, records, mirrorResult)
  if (!stageSucceeded(inventoryResult, { published: true, requireFailed: true })) return failedRun('inventory', inventoryResult)

  const snapshotResult = await publishSnapshot(db, records, {
    complete: true,
    mirrorResult,
    inventoryResult
  })
  if (!stageSucceeded(snapshotResult, { published: true, requireFailed: true })) return failedRun('snapshot', snapshotResult)

  const commitResult = await commit(db, {
    mirrorResult,
    inventoryResult,
    snapshotResult
  })
  if (!stageSucceeded(commitResult)) return failedRun('commit', commitResult)

  const noop = mirrorResult.noop === true &&
    inventoryResult.noop === true &&
    snapshotResult.noop === true &&
    commitResult.noop === true
  const dryRun = mirrorResult.dryRun === true
  return {
    complete: true,
    published: !dryRun,
    validated: dryRun ? mirrorResult.validated === true : true,
    planned: dryRun ? mirrorResult.planned === true : true,
    failed: 0,
    schemaInvalid: false,
    mirrorIncomplete: false,
    success: true,
    status: dryRun ? 'success-dry-run' : (noop ? 'success-noop' : 'success'),
    noop,
    dryRun,
    mirror: publicStageSummary(mirrorResult, { includeComponentEvidence: true }),
    inventory: publicInventorySummary(inventoryResult),
    snapshot: publicStageSummary(snapshotResult),
    commit: publicStageSummary(commitResult)
  }
}

module.exports = {
  buildLocationCatalog,
  prepareSourceSnapshotForCompatibility,
  planMirrorSync,
  buildCompanySheetSnapshot,
  publishCompanySnapshot,
  classifyMirrorRunResult,
  runCompanySourceSync,
  _internal: {
    managedFieldsOf
  }
}
