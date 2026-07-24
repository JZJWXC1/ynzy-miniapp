'use strict'

const DAY_MS = 24 * 60 * 60 * 1000
const CURRENT_STATE_FIELDS = Object.freeze([
  'foundationListingId',
  'sourceRecordId',
  'yuxiaoerListingId',
  'yuxiaoerRoomId',
  'temporaryListingId',
  'identityType',
  'rentMode',
  'physicalUnitKey',
  'identityAliases',
  'lifecycleVersion',
  'lifecycleStatusText',
  'vacancyNote',
  'sourceCreatedAt',
  'availabilityCycleNo',
  'availabilityCycleId',
  'metricKind',
  'lifecycleDays',
  'listingOwner',
  'ownerDepartment',
  'sourcePresent',
  'published',
  'enabled'
])

function normalizeText(value) {
  if (value === undefined || value === null) return ''
  return String(value).normalize('NFKC').trim()
}

function identityIndexKey(value) {
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

function equalPlain(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
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

function assertSnapshot(snapshot, label) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`${label}不存在`)
  if (snapshot.complete !== true) throw new Error(`${label}不完整，禁止规划房源生命周期`)
  if (!Array.isArray(snapshot.records)) throw new Error(`${label} records 必须是数组`)
  if (snapshot.recordCount !== undefined && snapshot.recordCount !== snapshot.records.length) {
    throw new Error(`${label}记录数不一致，禁止规划房源生命周期`)
  }
}

function timestampMs(value, label) {
  const numeric = typeof value === 'number' ? value : (
    typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
  )
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label}不是合法时间`)
  return parsed
}

function observedTime(observedAt) {
  return timestampMs(observedAt, 'observedAt')
}

function sourceCreatedTime(record, observedAtMs) {
  const raw = record && (
    record.createdTimeMs !== undefined
      ? record.createdTimeMs
      : (record.created_time !== undefined ? record.created_time : record.createdAt)
  )
  const createdTimeMs = timestampMs(raw, `源记录 ${recordIdOf(record) || '未知'} 的 createdTimeMs`)
  if (!Number.isSafeInteger(createdTimeMs) || createdTimeMs < 1_000_000_000_000) {
    throw new Error(`源记录 ${recordIdOf(record) || '未知'} 的 createdTimeMs 必须是毫秒时间戳`)
  }
  if (createdTimeMs > observedAtMs) {
    throw new Error(`源记录 ${recordIdOf(record) || '未知'} 的 createdTimeMs 位于未来`)
  }
  return createdTimeMs
}

function lifecycleStatusOf(vacancyNote) {
  return normalizeText(vacancyNote) ? '即将空出' : '待出租'
}

function yuxiaoerIdentityKey({ rentMode, yuxiaoerListingId, yuxiaoerRoomId } = {}) {
  const mode = normalizeText(rentMode)
  const listingId = normalizeText(yuxiaoerListingId)
  const roomId = normalizeText(yuxiaoerRoomId)
  if (!listingId) return ''
  if (mode === '整租') return `YX2:${listingId}:WHOLE`
  if (mode === '合租') return roomId ? `YX2:${listingId}:${roomId}` : ''
  if (!mode) return ''
  throw new Error(`未知出租方式：${mode}`)
}

function currentYuxiaoerIdentityKey(fields) {
  const rentMode = normalizeText(fields.rentMode)
  const strictIdentity = yuxiaoerIdentityKey({
    rentMode,
    yuxiaoerListingId: fields.yuxiaoerListingId,
    yuxiaoerRoomId: fields.yuxiaoerRoomId
  })
  if (strictIdentity) return strictIdentity
  if (rentMode) return ''
  const listingId = normalizeText(fields.yuxiaoerListingId)
  const roomId = normalizeText(fields.yuxiaoerRoomId)
  return listingId ? `YX2:${listingId}:${roomId || 'WHOLE'}` : ''
}

function calculateLifecycleDays(sourceCreatedAt, asOf) {
  const startMs = timestampMs(sourceCreatedAt, 'sourceCreatedAt')
  const asOfMs = timestampMs(asOf, 'asOf')
  if (startMs > asOfMs) throw new Error('sourceCreatedAt 位于未来')
  return Math.floor((asOfMs - startMs) / DAY_MS)
}

function aliasIndexKey(aliasType, aliasValue) {
  return `${normalizeText(aliasType)}:${identityIndexKey(aliasValue)}`
}

function canonicalAliasType(value) {
  const type = normalizeText(value)
  if (type === 'sourceRecord' || type === 'yuxiaoer' || type === 'temporary') return type
  throw new Error(`未知身份别名类型：${type || '空'}`)
}

function normalizeIdentityAlias(alias, label) {
  if (!alias || typeof alias !== 'object' || Array.isArray(alias)) {
    throw new Error(`${label}必须是对象`)
  }
  const aliasType = canonicalAliasType(alias.aliasType)
  const aliasValue = normalizeText(alias.aliasValue)
  if (!aliasValue) throw new Error(`${label}缺少 aliasValue`)
  return { aliasType, aliasValue }
}

function parseIdentityAliases(value, label) {
  if (value === undefined || value === null || normalizeText(value) === '') return []
  if (typeof value !== 'string') throw new Error(`${label}必须是 JSON 文本`)
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (_) {
    throw new Error(`${label}不是合法 JSON 文本`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 数组文本`)
  return parsed.map((alias, index) => normalizeIdentityAlias(alias, `${label}第 ${index + 1} 项`))
}

function addIndexedAlias(index, aliasType, aliasValue, foundationListingId, conflictLabel) {
  const normalizedAlias = normalizeIdentityAlias({ aliasType, aliasValue }, conflictLabel)
  const normalizedFoundationId = normalizeText(foundationListingId)
  if (!normalizedFoundationId) throw new Error(`${conflictLabel}缺少 foundationListingId`)
  const key = aliasIndexKey(normalizedAlias.aliasType, normalizedAlias.aliasValue)
  const occupied = index.get(key)
  if (occupied && identityIndexKey(occupied.foundationListingId) !== identityIndexKey(normalizedFoundationId)) {
    throw new Error(`${conflictLabel}冲突：${normalizedAlias.aliasType}/${normalizedAlias.aliasValue}`)
  }
  const candidate = {
    foundationListingId: normalizedFoundationId,
    aliasType: normalizedAlias.aliasType,
    aliasValue: normalizedAlias.aliasValue
  }
  if (!occupied) {
    index.set(key, candidate)
    return
  }
  const occupiedText = `${occupied.aliasType}\u0000${occupied.aliasValue}`
  const candidateText = `${candidate.aliasType}\u0000${candidate.aliasValue}`
  if (candidateText < occupiedText) index.set(key, candidate)
}

function mergeAliasIndexes(target, source, conflictLabel) {
  source.forEach((alias) => {
    addIndexedAlias(
      target,
      alias.aliasType,
      alias.aliasValue,
      alias.foundationListingId,
      conflictLabel
    )
  })
  return target
}

function identityAliasesText(aliasIndex, foundationListingId) {
  const foundationKey = identityIndexKey(foundationListingId)
  const aliases = []
  aliasIndex.forEach((alias) => {
    if (identityIndexKey(alias.foundationListingId) !== foundationKey) return
    aliases.push({
      aliasType: alias.aliasType,
      aliasValue: alias.aliasValue
    })
  })
  aliases.sort((left, right) => {
    const leftKey = aliasIndexKey(left.aliasType, left.aliasValue)
    const rightKey = aliasIndexKey(right.aliasType, right.aliasValue)
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    const leftText = `${left.aliasType}\u0000${left.aliasValue}`
    const rightText = `${right.aliasType}\u0000${right.aliasValue}`
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
  })
  return JSON.stringify(aliases)
}

function managedCurrentFields(fields) {
  const output = {}
  CURRENT_STATE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(fields, field)) output[field] = clonePlain(fields[field])
  })
  return output
}

function positiveCycleNo(value) {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 1
}

function lifecycleVersionOf(value) {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0
}

function responsibilityFor(responsibilityIndex, realIdentityKey) {
  if (!realIdentityKey || !responsibilityIndex) return null
  if (responsibilityIndex instanceof Map) {
    return responsibilityIndex.get(realIdentityKey) ||
      responsibilityIndex.get(identityIndexKey(realIdentityKey)) ||
      null
  }
  if (typeof responsibilityIndex === 'object' && !Array.isArray(responsibilityIndex)) {
    return responsibilityIndex[realIdentityKey] ||
      responsibilityIndex[identityIndexKey(realIdentityKey)] ||
      null
  }
  throw new Error('responsibilityIndex 必须是 Map 或普通对象')
}

function indexCurrentStates(currentStateSnapshot) {
  const byFoundationId = new Map()
  const bySourceRecordId = new Map()
  const byRealIdentity = new Map()
  const byPhysicalUnit = new Map()
  const byIdentityAlias = new Map()

  currentStateSnapshot.records.forEach((record, index) => {
    const fields = fieldsOf(record)
    const foundationListingId = normalizeText(fields.foundationListingId)
    if (!foundationListingId) throw new Error(`当前状态第 ${index + 1} 行缺少 foundationListingId`)
    const foundationKey = identityIndexKey(foundationListingId)
    if (byFoundationId.has(foundationKey)) {
      throw new Error(`当前状态 foundationListingId 重复：${foundationListingId}`)
    }
    const item = {
      recordId: recordIdOf(record),
      fields: clonePlain(fields)
    }
    byFoundationId.set(foundationKey, item)

    const sourceRecordId = normalizeText(fields.sourceRecordId)
    if (sourceRecordId) {
      const sourceKey = identityIndexKey(sourceRecordId)
      const occupied = bySourceRecordId.get(sourceKey)
      if (occupied && identityIndexKey(occupied.fields.foundationListingId) !== foundationKey) {
        throw new Error(`当前状态源 recordId 重复：${sourceRecordId}`)
      }
      bySourceRecordId.set(sourceKey, item)
      addIndexedAlias(
        byIdentityAlias,
        'sourceRecord',
        sourceRecordId,
        foundationListingId,
        '当前状态源记录别名'
      )
    }

    const realIdentity = currentYuxiaoerIdentityKey(fields)
    if (realIdentity) {
      const realKey = identityIndexKey(realIdentity)
      const occupied = byRealIdentity.get(realKey)
      if (occupied && identityIndexKey(occupied.fields.foundationListingId) !== foundationKey) {
        throw new Error(`当前状态寓小二身份重复：${realIdentity}`)
      }
      byRealIdentity.set(realKey, item)
      addIndexedAlias(
        byIdentityAlias,
        'yuxiaoer',
        realIdentity,
        foundationListingId,
        '当前状态寓小二别名'
      )
    }

    const temporaryListingId = normalizeText(fields.temporaryListingId)
    if (temporaryListingId) {
      addIndexedAlias(
        byIdentityAlias,
        'temporary',
        temporaryListingId,
        foundationListingId,
        '当前状态临时身份别名'
      )
    }

    parseIdentityAliases(
      fields.identityAliases,
      `当前状态 ${foundationListingId} 的 identityAliases`
    ).forEach((alias) => {
      addIndexedAlias(
        byIdentityAlias,
        alias.aliasType,
        alias.aliasValue,
        foundationListingId,
        '当前状态内嵌身份别名'
      )
    })

    const physicalUnitKey = normalizeText(fields.physicalUnitKey)
    if (physicalUnitKey) {
      const physicalKey = identityIndexKey(physicalUnitKey)
      const occupied = byPhysicalUnit.get(physicalKey)
      if (occupied && identityIndexKey(occupied.fields.foundationListingId) !== foundationKey) {
        throw new Error(`当前状态物理房源键重复或歧义：${physicalUnitKey}`)
      }
      byPhysicalUnit.set(physicalKey, item)
    }
  })

  return { byFoundationId, bySourceRecordId, byRealIdentity, byPhysicalUnit, byIdentityAlias }
}

function indexAliases(aliasSnapshot) {
  const aliases = new Map()
  aliasSnapshot.records.forEach((record, index) => {
    const fields = fieldsOf(record)
    const aliasType = normalizeText(fields.aliasType)
    const aliasValue = normalizeText(fields.aliasValue)
    const foundationListingId = normalizeText(fields.foundationListingId)
    if (!aliasType || !aliasValue || !foundationListingId) {
      throw new Error(`身份别名快照第 ${index + 1} 行缺少 aliasType、aliasValue 或 foundationListingId`)
    }
    addIndexedAlias(aliases, aliasType, aliasValue, foundationListingId, '身份别名')
  })
  return aliases
}

function indexRentalEvents(rentedEventSnapshot) {
  const events = new Map()
  rentedEventSnapshot.records.forEach((record, index) => {
    const fields = fieldsOf(record)
    const rentalEventId = normalizeText(fields.rentalEventId)
    if (!rentalEventId) throw new Error(`已出租事件第 ${index + 1} 行缺少 rentalEventId`)
    const key = identityIndexKey(rentalEventId)
    if (events.has(key)) throw new Error(`已出租事件 rentalEventId 重复：${rentalEventId}`)
    events.set(key, fields)
  })
  return events
}

function existingFoundationFromAliases(aliases, aliasType, aliasValue) {
  if (!aliasValue) return ''
  const alias = aliases.get(aliasIndexKey(aliasType, aliasValue))
  return alias ? normalizeText(alias.foundationListingId) : ''
}

function candidateFoundationId(item) {
  return item ? normalizeText(item.fields.foundationListingId) : ''
}

function sourceRows(sourceSnapshot, observedAtMs) {
  const sourceIds = new Set()
  const realIdentities = new Set()
  const physicalUnits = new Set()

  return sourceSnapshot.records.map((record, index) => {
    const fields = fieldsOf(record)
    const sourceRecordId = recordIdOf(record)
    if (!sourceRecordId) throw new Error(`源快照第 ${index + 1} 行缺少 recordId`)
    const sourceIdKey = identityIndexKey(sourceRecordId)
    if (sourceIds.has(sourceIdKey)) throw new Error(`源 recordId 重复：${sourceRecordId}`)
    sourceIds.add(sourceIdKey)

    const rentMode = normalizeText(fields.rentMode)
    if (!/^(?:整租|合租)$/.test(rentMode)) {
      throw new Error(`源记录 ${sourceRecordId} 的出租方式必须是整租或合租`)
    }
    const physicalUnitKey = normalizeText(fields.physicalUnitKey)
    if (!physicalUnitKey) throw new Error(`源记录 ${sourceRecordId} 缺少 physicalUnitKey`)
    const physicalKey = identityIndexKey(physicalUnitKey)
    if (physicalUnits.has(physicalKey)) throw new Error(`源快照物理房源键重复：${physicalUnitKey}`)
    physicalUnits.add(physicalKey)

    const realIdentityKey = yuxiaoerIdentityKey({
      rentMode,
      yuxiaoerListingId: fields.yuxiaoerListingId,
      yuxiaoerRoomId: fields.yuxiaoerRoomId
    })
    if (realIdentityKey) {
      const realKey = identityIndexKey(realIdentityKey)
      if (realIdentities.has(realKey)) throw new Error(`源快照寓小二身份重复：${realIdentityKey}`)
      realIdentities.add(realKey)
    }

    const createdTimeMs = sourceCreatedTime(record, observedAtMs)
    return {
      record,
      fields,
      sourceRecordId,
      physicalUnitKey,
      realIdentityKey,
      createdTimeMs,
      sourceCreatedAt: new Date(createdTimeMs).toISOString()
    }
  })
}

function makeAliasOperation(aliasType, aliasValue, foundationListingId) {
  return {
    type: 'create',
    aliasKey: aliasIndexKey(aliasType, aliasValue),
    foundationListingId,
    fields: {
      foundationListingId,
      aliasType,
      aliasValue
    }
  }
}

function planListingLifecycle({
  sourceSnapshot,
  currentStateSnapshot = { complete: true, recordCount: 0, records: [] },
  rentedEventSnapshot = { complete: true, recordCount: 0, records: [] },
  aliasSnapshot = { complete: true, recordCount: 0, records: [] },
  responsibilityIndex,
  runId,
  observedAt,
  baseline = false,
  allocateTemporaryId
} = {}) {
  assertSnapshot(sourceSnapshot, '源快照')
  assertSnapshot(currentStateSnapshot, '当前状态快照')
  assertSnapshot(rentedEventSnapshot, '已出租事件快照')
  assertSnapshot(aliasSnapshot, '身份别名快照')
  if (typeof allocateTemporaryId !== 'function') throw new Error('缺少 allocateTemporaryId')

  const observedAtMs = observedTime(observedAt)
  const observedAtIso = new Date(observedAtMs).toISOString()
  const normalizedRunId = normalizeText(runId)
  if (!normalizedRunId) throw new Error('runId 不能为空')

  const currentIndex = indexCurrentStates(currentStateSnapshot)
  const existingAliases = indexAliases(aliasSnapshot)
  mergeAliasIndexes(existingAliases, currentIndex.byIdentityAlias, '身份别名快照与当前状态内嵌别名')
  const existingEvents = indexRentalEvents(rentedEventSnapshot)
  const preparedSourceRows = sourceRows(sourceSnapshot, observedAtMs)
  const desiredStates = []
  const currentStateOperations = []
  const rentalEventOperations = []
  const aliasOperations = []
  const plannedAliases = new Map(existingAliases)
  const usedFoundationIds = new Set()

  function ensureAlias(aliasType, aliasValue, foundationListingId) {
    const normalizedValue = normalizeText(aliasValue)
    if (!normalizedValue) return
    const key = aliasIndexKey(aliasType, normalizedValue)
    const occupied = plannedAliases.get(key)
    if (occupied &&
      identityIndexKey(occupied.foundationListingId) !== identityIndexKey(foundationListingId)) {
      throw new Error(`身份别名冲突：${aliasType}/${normalizedValue}`)
    }
    if (occupied) return
    addIndexedAlias(
      plannedAliases,
      aliasType,
      normalizedValue,
      foundationListingId,
      '计划身份别名'
    )
    aliasOperations.push(makeAliasOperation(aliasType, normalizedValue, foundationListingId))
  }

  function ensureRentalEvent(existingFields, foundationListingId, lifecycleVersion, identityAliases) {
    const availabilityCycleNo = positiveCycleNo(existingFields.availabilityCycleNo)
    const availabilityCycleId = normalizeText(existingFields.availabilityCycleId) ||
      `${foundationListingId}:available:${availabilityCycleNo}`
    const rentalEventId = `${foundationListingId}:rented:${availabilityCycleNo}`
    if (existingEvents.has(identityIndexKey(rentalEventId))) return
    const sourceCreatedAt = existingFields.sourceCreatedAt
    const elapsedDaysAtExit = sourceCreatedAt
      ? calculateLifecycleDays(sourceCreatedAt, observedAtIso)
      : null
    rentalEventOperations.push({
      type: 'create',
      rentalEventId,
      foundationListingId,
      fields: {
        rentalEventId,
        foundationListingId,
        availabilityCycleNo,
        availabilityCycleId,
        sourceRecordId: normalizeText(existingFields.sourceRecordId),
        yuxiaoerListingId: normalizeText(existingFields.yuxiaoerListingId),
        yuxiaoerRoomId: normalizeText(existingFields.yuxiaoerRoomId),
        temporaryListingId: normalizeText(existingFields.temporaryListingId),
        identityType: normalizeText(existingFields.identityType),
        rentMode: normalizeText(existingFields.rentMode),
        physicalUnitKey: normalizeText(existingFields.physicalUnitKey),
        identityAliases,
        lifecycleVersion,
        previousLifecycleStatusText: existingFields.lifecycleStatusText === '已出租'
          ? ''
          : normalizeText(existingFields.lifecycleStatusText),
        sourceCreatedAt,
        rentedDetectedAt: observedAtIso,
        elapsedDaysAtExit,
        vacancyNote: normalizeText(existingFields.vacancyNote),
        listingOwner: normalizeText(existingFields.listingOwner),
        ownerDepartment: normalizeText(existingFields.ownerDepartment),
        runId: normalizedRunId
      }
    })
  }

  preparedSourceRows.forEach((sourceRow) => {
    const {
      fields,
      sourceRecordId,
      physicalUnitKey,
      realIdentityKey
    } = sourceRow
    const candidates = new Map()

    function addCandidate(foundationListingId, source) {
      const normalized = normalizeText(foundationListingId)
      if (normalized) candidates.set(identityIndexKey(normalized), { foundationListingId: normalized, source })
    }

    if (realIdentityKey) {
      addCandidate(
        existingFoundationFromAliases(existingAliases, 'yuxiaoer', realIdentityKey),
        '寓小二别名'
      )
      addCandidate(
        candidateFoundationId(currentIndex.byRealIdentity.get(identityIndexKey(realIdentityKey))),
        '当前寓小二身份'
      )
    }
    addCandidate(
      existingFoundationFromAliases(existingAliases, 'sourceRecord', sourceRecordId),
      '源记录别名'
    )
    addCandidate(
      candidateFoundationId(currentIndex.bySourceRecordId.get(identityIndexKey(sourceRecordId))),
      '当前源记录'
    )
    addCandidate(
      candidateFoundationId(currentIndex.byPhysicalUnit.get(identityIndexKey(physicalUnitKey))),
      '唯一物理房源键'
    )

    if (candidates.size > 1) {
      throw new Error(`源记录 ${sourceRecordId} 的真实身份、源别名或物理房源键互相冲突`)
    }

    const matchedCandidate = candidates.size ? Array.from(candidates.values())[0] : null
    let foundationListingId = matchedCandidate ? matchedCandidate.foundationListingId : ''
    let existing = foundationListingId
      ? currentIndex.byFoundationId.get(identityIndexKey(foundationListingId))
      : null
    let allocatedTemporaryId = false
    if (!foundationListingId) {
      if (realIdentityKey) {
        foundationListingId = realIdentityKey
      } else {
        foundationListingId = normalizeText(allocateTemporaryId({
          sourceRecordId,
          physicalUnitKey
        }))
        if (!foundationListingId) throw new Error(`源记录 ${sourceRecordId} 未能分配临时 ID`)
        allocatedTemporaryId = true
      }
      existing = currentIndex.byFoundationId.get(identityIndexKey(foundationListingId)) || null
      if (allocatedTemporaryId && existing) {
        throw new Error(`源记录 ${sourceRecordId} 分配的临时 ID 与既有实体冲突：${foundationListingId}`)
      }
    }

    const foundationKey = identityIndexKey(foundationListingId)
    if (usedFoundationIds.has(foundationKey)) {
      throw new Error(`多个源记录命中同一房源身份：${foundationListingId}`)
    }
    usedFoundationIds.add(foundationKey)

    const existingFields = existing ? existing.fields : {}
    const wasRented = existingFields.lifecycleStatusText === '已出租' || existingFields.sourcePresent === false
    const previousSourceRecordId = normalizeText(existingFields.sourceRecordId)
    const sourceReplaced = Boolean(
      existing &&
      previousSourceRecordId &&
      identityIndexKey(previousSourceRecordId) !== identityIndexKey(sourceRecordId)
    )
    const previousCycleNo = positiveCycleNo(existingFields.availabilityCycleNo)
    const opensNewCycle = Boolean(existing && baseline !== true && (wasRented || sourceReplaced))
    const availabilityCycleNo = existing
      ? (opensNewCycle ? previousCycleNo + 1 : previousCycleNo)
      : 1
    const availabilityCycleId = `${foundationListingId}:available:${availabilityCycleNo}`

    const rentMode = normalizeText(fields.rentMode)
    const sourceListingId = normalizeText(fields.yuxiaoerListingId)
    const sourceRoomId = normalizeText(fields.yuxiaoerRoomId)
    const yuxiaoerListingId = sourceListingId || normalizeText(existingFields.yuxiaoerListingId)
    const yuxiaoerRoomId = sourceRoomId || normalizeText(existingFields.yuxiaoerRoomId)
    const resolvedRealIdentity = realIdentityKey || currentYuxiaoerIdentityKey({
      rentMode,
      yuxiaoerListingId,
      yuxiaoerRoomId
    })
    const existingTemporaryId = normalizeText(existingFields.temporaryListingId)
    const temporaryListingId = existingTemporaryId ||
      (!resolvedRealIdentity ? foundationListingId : '')
    const identityType = resolvedRealIdentity ? 'yuxiaoer' : 'temporary'
    const vacancyNote = normalizeText(fields.vacancyNote)
    const lifecycleStatusText = lifecycleStatusOf(vacancyNote)
    const responsibility = responsibilityFor(responsibilityIndex, resolvedRealIdentity)
    const listingOwner = responsibility
      ? normalizeText(responsibility.listingOwner)
      : (normalizeText(fields.listingOwner) || normalizeText(existingFields.listingOwner))
    const ownerDepartment = responsibility
      ? normalizeText(responsibility.ownerDepartment)
      : (normalizeText(fields.ownerDepartment) || normalizeText(existingFields.ownerDepartment))

    ensureAlias('sourceRecord', sourceRecordId, foundationListingId)
    if (resolvedRealIdentity) ensureAlias('yuxiaoer', resolvedRealIdentity, foundationListingId)
    if (temporaryListingId) ensureAlias('temporary', temporaryListingId, foundationListingId)
    const identityAliases = identityAliasesText(plannedAliases, foundationListingId)
    const previousLifecycleVersion = existing ? lifecycleVersionOf(existingFields.lifecycleVersion) : 0
    const statusChanged = Boolean(
      existing &&
      normalizeText(existingFields.lifecycleStatusText) !== lifecycleStatusText
    )
    const responsibilityChanged = Boolean(
      existing &&
      (
        normalizeText(existingFields.listingOwner) !== listingOwner ||
        normalizeText(existingFields.ownerDepartment) !== ownerDepartment
      )
    )
    const lifecycleVersion = existing
      ? previousLifecycleVersion + (
        wasRented || sourceReplaced || statusChanged || responsibilityChanged ? 1 : 0
      )
      : 1

    if (baseline !== true && (wasRented || sourceReplaced)) {
      const previousIdentityAliases = identityAliasesText(existingAliases, foundationListingId)
      ensureRentalEvent(
        existingFields,
        foundationListingId,
        wasRented ? previousLifecycleVersion : lifecycleVersion,
        previousIdentityAliases
      )
    }

    const desired = {
      foundationListingId,
      sourceRecordId,
      yuxiaoerListingId,
      yuxiaoerRoomId,
      temporaryListingId,
      identityType,
      rentMode,
      physicalUnitKey,
      identityAliases,
      lifecycleVersion,
      lifecycleStatusText,
      vacancyNote,
      sourceCreatedAt: sourceRow.createdTimeMs,
      availabilityCycleNo,
      availabilityCycleId,
      metricKind: lifecycleStatusText === '即将空出' ? '提前挂出天数' : '待租天数',
      lifecycleDays: calculateLifecycleDays(sourceRow.createdTimeMs, observedAtMs),
      listingOwner,
      ownerDepartment,
      sourcePresent: true,
      published: true,
      enabled: true
    }
    desiredStates.push(desired)

    if (!existing) {
      currentStateOperations.push({
        type: 'create',
        foundationListingId,
        sourceRecordId,
        fields: clonePlain(desired)
      })
    } else if (!equalPlain(managedCurrentFields(existingFields), desired)) {
      currentStateOperations.push({
        type: wasRented || sourceReplaced ? 'restore' : 'update',
        recordId: existing.recordId,
        foundationListingId,
        sourceRecordId,
        fields: clonePlain(desired)
      })
    }
  })

  currentIndex.byFoundationId.forEach((existing, foundationKey) => {
    if (usedFoundationIds.has(foundationKey) || baseline === true) return
    const existingFields = existing.fields
    const isTracked = existingFields.sourcePresent === true ||
      existingFields.lifecycleStatusText === '已出租' ||
      existingFields.published === true ||
      existingFields.enabled === true
    if (!isTracked) return

    const foundationListingId = normalizeText(existingFields.foundationListingId)
    const alreadyRented = existingFields.lifecycleStatusText === '已出租' &&
      existingFields.sourcePresent === false &&
      existingFields.published === false &&
      existingFields.enabled === false
    const previousLifecycleVersion = lifecycleVersionOf(existingFields.lifecycleVersion)
    const lifecycleVersion = alreadyRented
      ? previousLifecycleVersion
      : previousLifecycleVersion + 1
    const identityAliases = identityAliasesText(existingAliases, foundationListingId)
    const rentedFields = {
      ...clonePlain(existingFields),
      identityAliases,
      lifecycleVersion,
      lifecycleStatusText: '已出租',
      sourcePresent: false,
      published: false,
      enabled: false
    }

    if (!equalPlain(managedCurrentFields(existingFields), managedCurrentFields(rentedFields))) {
      currentStateOperations.push({
        type: 'markRented',
        recordId: existing.recordId,
        foundationListingId,
        sourceRecordId: normalizeText(existingFields.sourceRecordId),
        fields: rentedFields
      })
    }

    ensureRentalEvent(existingFields, foundationListingId, lifecycleVersion, identityAliases)
  })

  desiredStates.sort((left, right) => (
    left.foundationListingId < right.foundationListingId ? -1 :
      left.foundationListingId > right.foundationListingId ? 1 : 0
  ))
  currentStateOperations.sort((left, right) => (
    left.foundationListingId < right.foundationListingId ? -1 :
      left.foundationListingId > right.foundationListingId ? 1 : 0
  ))
  rentalEventOperations.sort((left, right) => (
    left.rentalEventId < right.rentalEventId ? -1 :
      left.rentalEventId > right.rentalEventId ? 1 : 0
  ))
  aliasOperations.sort((left, right) => (
    left.aliasKey < right.aliasKey ? -1 : left.aliasKey > right.aliasKey ? 1 : 0
  ))

  const counts = {
    desired: desiredStates.length,
    currentCreate: currentStateOperations.filter((item) => item.type === 'create').length,
    currentUpdate: currentStateOperations.filter((item) => item.type === 'update').length,
    currentRestore: currentStateOperations.filter((item) => item.type === 'restore').length,
    currentMarkRented: currentStateOperations.filter((item) => item.type === 'markRented').length,
    rentalEventCreate: rentalEventOperations.length,
    aliasCreate: aliasOperations.length
  }
  const noop = currentStateOperations.length === 0 &&
    rentalEventOperations.length === 0 &&
    aliasOperations.length === 0

  return {
    complete: true,
    runId: normalizedRunId,
    observedAt: observedAtIso,
    baseline: baseline === true,
    desiredStates,
    currentStateOperations,
    rentalEventOperations,
    aliasOperations,
    counts,
    noop
  }
}

module.exports = {
  calculateLifecycleDays,
  lifecycleStatusOf,
  planListingLifecycle,
  yuxiaoerIdentityKey
}
