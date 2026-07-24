'use strict'

const PRIVATE_MAPPING_FIELDS = Object.freeze([
  'sourceRecordId',
  'yuxiaoerListingId',
  'yuxiaoerRoomId',
  'listingOwner',
  'ownerDepartment'
])
const PRIVATE_MAPPING_FIELD_SET = new Set(PRIVATE_MAPPING_FIELDS)
const ENRICHMENT_FIELDS = Object.freeze([
  'yuxiaoerListingId',
  'yuxiaoerRoomId',
  'identityType',
  'listingOwner',
  'ownerDepartment',
  'identityAliases',
  'lifecycleVersion'
])
const PLAN_INPUT_FIELDS = new Set([
  'privateMappings',
  'currentStateSnapshot'
])

function normalizeText(value) {
  if (value === undefined || value === null) return ''
  return String(value).normalize('NFKC').trim()
}

function normalizedKey(value) {
  return normalizeText(value).toLocaleLowerCase('zh-CN')
}

function fieldsOf(record) {
  if (!record || typeof record !== 'object') return {}
  return record.fields && typeof record.fields === 'object' && !Array.isArray(record.fields)
    ? record.fields
    : record
}

function recordIdOf(record) {
  return normalizeText(record && (record.recordId || record.record_id))
}

function assertCompleteSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('当前主档完整快照不存在')
  }
  if (snapshot.complete !== true) {
    throw new Error('当前主档快照不完整，禁止生成身份责任补全计划')
  }
  if (!Array.isArray(snapshot.records)) {
    throw new Error('当前主档快照 records 必须是数组')
  }
  if (snapshot.recordCount !== undefined && snapshot.recordCount !== snapshot.records.length) {
    throw new Error('当前主档快照记录数不一致，禁止生成补全计划')
  }
}

function assertPlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('身份责任补全参数必须是普通对象')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('身份责任补全参数必须是普通对象')
  }
  const forbiddenKey = Object.keys(input).find((key) => !PLAN_INPUT_FIELDS.has(key))
  if (forbiddenKey) {
    throw new Error(`身份责任补全参数包含白名单外字段：${forbiddenKey}`)
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'privateMappings')) {
    throw new Error('身份责任补全参数缺少 privateMappings')
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'currentStateSnapshot')) {
    throw new Error('身份责任补全参数缺少 currentStateSnapshot')
  }
}

function assertPlainMapping(mapping, index) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error(`私有映射第 ${index + 1} 行必须是普通对象`)
  }
  const prototype = Object.getPrototypeOf(mapping)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`私有映射第 ${index + 1} 行必须是普通对象`)
  }

  const keys = Object.keys(mapping)
  const forbiddenKey = keys.find((key) => !PRIVATE_MAPPING_FIELD_SET.has(key))
  if (forbiddenKey) {
    throw new Error(`私有映射第 ${index + 1} 行包含白名单外字段：${forbiddenKey}`)
  }
  const missingKey = PRIVATE_MAPPING_FIELDS.find((key) => !Object.prototype.hasOwnProperty.call(mapping, key))
  if (missingKey) {
    throw new Error(`私有映射第 ${index + 1} 行缺少字段：${missingKey}`)
  }
}

function normalizeMappingValue(value, field, index) {
  const valueType = typeof value
  if (
    value !== undefined &&
    value !== null &&
    valueType !== 'string' &&
    valueType !== 'number'
  ) {
    throw new Error(`私有映射第 ${index + 1} 行字段 ${field} 只能是文本或数字`)
  }
  if (valueType === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`私有映射第 ${index + 1} 行字段 ${field} 必须是文本或安全整数`)
  }
  return normalizeText(value)
}

function canonicalYuxiaoerIdentity(rentMode, listingId, roomId, sourceRecordId) {
  const normalizedMode = normalizeText(rentMode)
  const normalizedListingId = normalizeText(listingId)
  const normalizedRoomId = normalizeText(roomId)
  const sourceLabel = normalizeText(sourceRecordId) || '未知记录'

  if (!normalizedListingId) {
    throw new Error(`映射 sourceRecordId=${sourceLabel} 缺少寓小二房源 ID`)
  }
  if (normalizedMode === '整租') {
    if (normalizedRoomId) {
      throw new Error(`整租 sourceRecordId=${sourceLabel} 必须使用房源 ID + WHOLE，房间 ID 必须为空`)
    }
    return `YX2:${normalizedListingId}:WHOLE`
  }
  if (normalizedMode === '合租') {
    if (!normalizedRoomId) {
      throw new Error(`合租 sourceRecordId=${sourceLabel} 必须同时提供房源 ID 和房间 ID`)
    }
    return `YX2:${normalizedListingId}:${normalizedRoomId}`
  }
  throw new Error(`当前主档 sourceRecordId=${sourceLabel} 的 rentMode 必须是整租或合租`)
}

function existingYuxiaoerIdentity(fields, sourceRecordId) {
  const listingId = normalizeText(fields.yuxiaoerListingId)
  const roomId = normalizeText(fields.yuxiaoerRoomId)
  if (!listingId && !roomId) return ''
  if (!listingId && roomId) {
    throw new Error(`当前主档 sourceRecordId=${sourceRecordId} 的真实身份不完整`)
  }
  return canonicalYuxiaoerIdentity(fields.rentMode, listingId, roomId, sourceRecordId)
}

function indexCurrentState(snapshot) {
  const bySourceRecordId = new Map()
  const byRealIdentity = new Map()

  function occupyRealIdentity(realIdentity, item) {
    const identityKey = normalizedKey(realIdentity)
    const occupied = byRealIdentity.get(identityKey)
    if (
      occupied &&
      normalizedKey(occupied.sourceRecordId) !== normalizedKey(item.sourceRecordId)
    ) {
      throw new Error(`当前主档真实身份重复：${realIdentity}`)
    }
    if (!occupied) byRealIdentity.set(identityKey, item)
  }

  snapshot.records.forEach((record, index) => {
    const fields = fieldsOf(record)
    const sourceRecordId = normalizeText(fields.sourceRecordId)
    if (!sourceRecordId) {
      throw new Error(`当前主档第 ${index + 1} 行缺少 sourceRecordId`)
    }
    const sourceKey = normalizedKey(sourceRecordId)
    if (bySourceRecordId.has(sourceKey)) {
      throw new Error(`当前主档 sourceRecordId 重复：${sourceRecordId}`)
    }
    const item = {
      record,
      recordId: recordIdOf(record),
      sourceRecordId,
      fields
    }
    bySourceRecordId.set(sourceKey, item)

    const realIdentity = existingYuxiaoerIdentity(fields, sourceRecordId)
    if (!realIdentity) {
      if (normalizeText(fields.identityType) === 'yuxiaoer') {
        throw new Error(`当前主档 sourceRecordId=${sourceRecordId} 标记为真实身份但缺少完整寓小二 ID`)
      }
    } else {
      occupyRealIdentity(realIdentity, item)
    }

    parseIdentityAliases(
      fields.identityAliases,
      `当前主档 sourceRecordId=${sourceRecordId} 的 identityAliases`
    )
      .filter((alias) => alias.aliasType === 'yuxiaoer')
      .forEach((alias) => occupyRealIdentity(alias.aliasValue, item))
  })

  return { bySourceRecordId, byRealIdentity }
}

function normalizePrivateMappings(privateMappings, currentIndex) {
  if (!Array.isArray(privateMappings)) {
    throw new Error('privateMappings 必须是私有映射数组')
  }

  const sourceIds = new Set()
  const realIdentities = new Set()
  return privateMappings.map((mapping, index) => {
    assertPlainMapping(mapping, index)
    const normalized = {}
    PRIVATE_MAPPING_FIELDS.forEach((field) => {
      normalized[field] = normalizeMappingValue(mapping[field], field, index)
    })
    if (!normalized.sourceRecordId) {
      throw new Error(`私有映射第 ${index + 1} 行缺少 sourceRecordId`)
    }

    const sourceKey = normalizedKey(normalized.sourceRecordId)
    if (sourceIds.has(sourceKey)) {
      throw new Error(`私有映射 sourceRecordId 重复：${normalized.sourceRecordId}`)
    }
    sourceIds.add(sourceKey)

    const current = currentIndex.bySourceRecordId.get(sourceKey)
    if (!current) {
      throw new Error(`私有映射 sourceRecordId=${normalized.sourceRecordId} 未命中当前主档；禁止按地址猜测`)
    }
    const realIdentity = canonicalYuxiaoerIdentity(
      current.fields.rentMode,
      normalized.yuxiaoerListingId,
      normalized.yuxiaoerRoomId,
      normalized.sourceRecordId
    )
    const identityKey = normalizedKey(realIdentity)
    if (realIdentities.has(identityKey)) {
      throw new Error(`私有映射真实身份重复：${realIdentity}`)
    }
    realIdentities.add(identityKey)

    return {
      ...normalized,
      current,
      realIdentity,
      identityKey
    }
  })
}

function sameNonEmptyValue(left, right) {
  return normalizedKey(left) === normalizedKey(right)
}

function assertNoExistingConflict(prepared, currentIndex) {
  const {
    current,
    realIdentity,
    identityKey,
    sourceRecordId,
    yuxiaoerListingId,
    yuxiaoerRoomId
  } = prepared
  const fields = current.fields
  const existingIdentity = existingYuxiaoerIdentity(fields, sourceRecordId)
  if (existingIdentity && normalizedKey(existingIdentity) !== identityKey) {
    throw new Error(`sourceRecordId=${sourceRecordId} 的现有真实身份与补全身份冲突`)
  }

  const existingFoundationId = normalizeText(fields.foundationListingId)
  if (
    /^yx2:/i.test(existingFoundationId) &&
    normalizedKey(existingFoundationId) !== identityKey
  ) {
    throw new Error(`sourceRecordId=${sourceRecordId} 的既有房源身份与补全身份冲突`)
  }

  const occupied = currentIndex.byRealIdentity.get(identityKey)
  if (occupied && normalizedKey(occupied.sourceRecordId) !== normalizedKey(sourceRecordId)) {
    throw new Error(`真实身份 ${realIdentity} 已被其他当前主档记录占用`)
  }

  const existingListingId = normalizeText(fields.yuxiaoerListingId)
  if (existingListingId && !sameNonEmptyValue(existingListingId, yuxiaoerListingId)) {
    throw new Error(`sourceRecordId=${sourceRecordId} 的寓小二房源 ID 冲突`)
  }
  const existingRoomId = normalizeText(fields.yuxiaoerRoomId)
  if (existingRoomId && !sameNonEmptyValue(existingRoomId, yuxiaoerRoomId)) {
    throw new Error(`sourceRecordId=${sourceRecordId} 的寓小二房间 ID 冲突`)
  }

  const aliasRealIdentities = parseIdentityAliases(
    fields.identityAliases,
    `当前主档 sourceRecordId=${sourceRecordId} 的 identityAliases`
  ).filter((alias) => alias.aliasType === 'yuxiaoer')
  if (aliasRealIdentities.some((alias) => normalizedKey(alias.aliasValue) !== identityKey)) {
    throw new Error(`sourceRecordId=${sourceRecordId} 的既有真实身份别名与补全身份冲突`)
  }
}

function normalizeAliasType(value, label) {
  const aliasType = normalizeText(value)
  if (!['sourceRecord', 'temporary', 'yuxiaoer'].includes(aliasType)) {
    throw new Error(`${label}包含未知身份别名类型`)
  }
  return aliasType
}

function parseIdentityAliases(value, label) {
  const text = normalizeText(value)
  if (!text) return []
  if (typeof value !== 'string') throw new Error(`${label}必须是 JSON 文本`)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (_) {
    throw new Error(`${label}不是合法 JSON 文本`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 数组文本`)
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label}第 ${index + 1} 项必须是对象`)
    }
    const aliasType = normalizeAliasType(item.aliasType, `${label}第 ${index + 1} 项`)
    const aliasValue = normalizeText(item.aliasValue)
    if (!aliasValue) throw new Error(`${label}第 ${index + 1} 项缺少 aliasValue`)
    return { aliasType, aliasValue }
  })
}

function mergedIdentityAliases(fields, sourceRecordId, realIdentity) {
  const aliases = new Map()
  function add(aliasType, aliasValue) {
    const type = normalizeAliasType(aliasType, '身份别名')
    const value = normalizeText(aliasValue)
    if (!value) return
    const key = `${type}\u0000${normalizedKey(value)}`
    const existing = aliases.get(key)
    const candidate = { aliasType: type, aliasValue: value }
    if (!existing || `${candidate.aliasType}\u0000${candidate.aliasValue}` <
      `${existing.aliasType}\u0000${existing.aliasValue}`) {
      aliases.set(key, candidate)
    }
  }
  parseIdentityAliases(
    fields.identityAliases,
    `当前主档 sourceRecordId=${sourceRecordId} 的 identityAliases`
  ).forEach((alias) => add(alias.aliasType, alias.aliasValue))
  add('sourceRecord', sourceRecordId)
  add('temporary', fields.temporaryListingId)
  add('yuxiaoer', realIdentity)
  return JSON.stringify(Array.from(aliases.values()).sort((left, right) => {
    const leftKey = `${left.aliasType}\u0000${normalizedKey(left.aliasValue)}`
    const rightKey = `${right.aliasType}\u0000${normalizedKey(right.aliasValue)}`
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return left.aliasValue < right.aliasValue ? -1 : left.aliasValue > right.aliasValue ? 1 : 0
  }))
}

function lifecycleVersionOf(value, sourceRecordId) {
  if (value === undefined || value === null || value === '') return 0
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`当前主档 sourceRecordId=${sourceRecordId} 的 lifecycleVersion 无效`)
  }
  return numeric
}

function desiredEnrichmentFields(prepared) {
  const fields = prepared.current.fields
  const listingOwner = prepared.listingOwner || normalizeText(fields.listingOwner)
  const ownerDepartment = prepared.ownerDepartment || normalizeText(fields.ownerDepartment)
  const responsibilityChanged =
    normalizeText(fields.listingOwner) !== listingOwner ||
    normalizeText(fields.ownerDepartment) !== ownerDepartment
  const previousLifecycleVersion = lifecycleVersionOf(
    fields.lifecycleVersion,
    prepared.sourceRecordId
  )
  return {
    yuxiaoerListingId: prepared.yuxiaoerListingId,
    yuxiaoerRoomId: prepared.yuxiaoerRoomId,
    identityType: 'yuxiaoer',
    listingOwner,
    ownerDepartment,
    identityAliases: mergedIdentityAliases(
      fields,
      prepared.sourceRecordId,
      prepared.realIdentity
    ),
    lifecycleVersion: previousLifecycleVersion + (responsibilityChanged ? 1 : 0)
  }
}

function enrichmentFieldsOf(fields) {
  const output = {}
  ENRICHMENT_FIELDS.forEach((field) => {
    output[field] = field === 'lifecycleVersion'
      ? lifecycleVersionOf(fields[field], fields.sourceRecordId)
      : normalizeText(fields[field])
  })
  return output
}

function sameEnrichmentFields(left, right) {
  return ENRICHMENT_FIELDS.every((field) => normalizeText(left[field]) === normalizeText(right[field]))
}

function planFoundationEnrichment(input = {}) {
  assertPlanInput(input)
  const { privateMappings, currentStateSnapshot } = input
  assertCompleteSnapshot(currentStateSnapshot)
  const currentIndex = indexCurrentState(currentStateSnapshot)
  const preparedMappings = normalizePrivateMappings(privateMappings, currentIndex)

  // 先完成整批冲突校验，再生成任何更新计划，确保失败时没有部分结果。
  preparedMappings.forEach((prepared) => {
    assertNoExistingConflict(prepared, currentIndex)
  })

  const updateOperations = []
  preparedMappings.forEach((prepared) => {
    const desired = desiredEnrichmentFields(prepared)
    const existing = enrichmentFieldsOf(prepared.current.fields)
    if (sameEnrichmentFields(existing, desired)) return
    if (!prepared.current.recordId) {
      throw new Error(`当前主档 sourceRecordId=${prepared.sourceRecordId} 缺少 recordId，无法生成更新计划`)
    }
    updateOperations.push({
      type: 'update',
      target: 'currentState',
      recordId: prepared.current.recordId,
      sourceRecordId: prepared.sourceRecordId,
      fields: desired
    })
  })

  return {
    target: 'currentState',
    updateOperations,
    mappingCount: preparedMappings.length,
    updateCount: updateOperations.length,
    unchangedCount: preparedMappings.length - updateOperations.length,
    skippedCurrentCount: currentStateSnapshot.records.length - preparedMappings.length,
    noop: updateOperations.length === 0
  }
}

module.exports = {
  PRIVATE_MAPPING_FIELDS,
  planFoundationEnrichment
}
