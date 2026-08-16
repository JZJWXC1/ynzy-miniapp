'use strict'

const assert = require('assert')
const crypto = require('crypto')

const config = require('../src/config')
const bitableClient = require('../src/feishu-bitable-client')
const feishuSync = require('../src/feishu-sync')
const noteMaterialSync = require('../src/feishu-note-material-sync')
const {
  syncNoteMaterialsForInventory
} = noteMaterialSync
const {
  buildContentPlanSummary,
  buildNoteMaterialSourceFieldPlan
} = noteMaterialSync._internal
const {
  buildCompanySheetSnapshot,
  buildLocationCatalog,
  prepareSourceSnapshotForCompatibility
} = require('../src/feishu-source-mirror')

const PROFILE = 'employee-ai-foundation-v1'
const SOURCE_CREATED_TIME_MS = Date.UTC(2026, 6, 22, 0, 0, 0)
const FIXED_NOW_MS = Date.UTC(2026, 6, 24, 0, 0, 0)

const FOUNDATION_MINI_FIELDS = Object.freeze([
  'foundationListingId',
  'temporaryListingId',
  'yuxiaoerListingId',
  'yuxiaoerRoomId',
  'identityType',
  'physicalUnitKey',
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
  'identityAliases',
  'lifecycleVersion'
])

// “已出租”保存每个待租周期结束时的不可变快照；archiveKey 是跨重跑幂等键。
const RENTED_REQUIRED_FIELDS = Object.freeze([
  'archiveKey',
  'foundationListingId',
  'temporaryListingId',
  'yuxiaoerListingId',
  'yuxiaoerRoomId',
  'identityType',
  'physicalUnitKey',
  'sourceRecordId',
  'availabilityCycleNo',
  'availabilityCycleId',
  'lifecycleStatusText',
  'vacancyNote',
  'sourceCreatedAt',
  'metricKind',
  'lifecycleDays',
  'listingOwner',
  'ownerDepartment',
  'identityAliases',
  'lifecycleVersion',
  'previousLifecycleStatusText',
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
  'sourcePresent',
  'archivedAt'
])

// “状态流水”只追加事实事件；historyEventId 是事件幂等键，不能由随机同步批次代替。
const HISTORY_REQUIRED_FIELDS = Object.freeze([
  'historyEventId',
  'foundationListingId',
  'sourceRecordId',
  'availabilityCycleNo',
  'availabilityCycleId',
  'eventType',
  'fromLifecycleStatusText',
  'toLifecycleStatusText',
  'eventAt',
  'runId',
  'listingOwner',
  'ownerDepartment',
  'lifecycleVersion'
])

const EXISTING_MINI_FIELDS = Object.freeze([
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
  'layoutDescription',
  'layoutCategory',
  'monthlyRent',
  'rentMode',
  'viewingMethod',
  'viewingPassword',
  'contact',
  'landlordCommissionPercent',
  'tags',
  'video',
  'remark',
  'listingStatus',
  'published',
  'canonical',
  'enabled'
])

function binding(fieldId, required) {
  const result = { fieldId }
  if (required !== undefined) result.required = required
  return result
}

function bindingsFor(names, prefix) {
  return names.reduce((result, name) => {
    result[name] = binding(`${prefix}-${name}`)
    return result
  }, {})
}

function sourceBindings(options = {}) {
  const result = {
    community: binding('src-community'),
    roomLabel: binding('src-room-label'),
    layoutDescription: binding('src-layout-description'),
    layoutCategory: binding('src-layout-category'),
    monthlyRent: binding('src-monthly-rent'),
    viewingMethod: binding('src-viewing-method'),
    remark: binding('src-remark')
  }
  if (options.includeVacancyNote === true) {
    result.vacancyNote = binding('src-vacancy-note', false)
  }
  if (options.includeNoteMaterial === true) {
    result.noteMaterialLink = binding('src-note-material', false)
  }
  return result
}

function miniBindings() {
  return bindingsFor([...EXISTING_MINI_FIELDS, ...FOUNDATION_MINI_FIELDS], 'mini')
}

function rentedBindings() {
  return bindingsFor(RENTED_REQUIRED_FIELDS, 'rented')
}

function historyBindings() {
  return bindingsFor(HISTORY_REQUIRED_FIELDS, 'history')
}

function locationBindings() {
  return bindingsFor([
    'locationId',
    'city',
    'district',
    'block',
    'community',
    'latitude',
    'longitude',
    'enabled'
  ], 'location')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function restoreObject(target, value) {
  Object.keys(target).forEach((key) => delete target[key])
  Object.assign(target, value)
}

function stableFixtureValue(value) {
  if (Array.isArray(value)) return value.map(stableFixtureValue)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableFixtureValue(value[key])
      return result
    }, {})
  }
  return value
}

function fixtureSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableFixtureValue(value))).digest('hex')
}

function snapshot(records, fieldNames = {}) {
  const normalizedRecords = clone(records).sort((left, right) => (
    String(left && left.recordId || '').localeCompare(String(right && right.recordId || ''))
  ))
  return {
    complete: true,
    records: normalizedRecords,
    recordCount: normalizedRecords.length,
    digest: fixtureSha256(normalizedRecords),
    schemaFingerprint: fixtureSha256({ fieldNames }),
    fieldNames: clone(fieldNames)
  }
}

function fixtureFieldType(semantic) {
  if (semantic === 'tags') return '4'
  if (semantic === 'video') return '17'
  if ([
    'latitude',
    'longitude',
    'monthlyRent',
    'landlordCommissionPercent',
    'availabilityCycleNo',
    'lifecycleDays',
    'lifecycleVersion',
    'archivedAt',
    'eventAt'
  ].includes(semantic)) return '2'
  return '1'
}

function validatedTargetSnapshot(records, bindings) {
  const fieldNames = semanticFieldNames(bindings)
  const schemaBindings = Object.keys(bindings).sort().map((semantic) => ({
    semantic,
    fieldId: bindings[semantic].fieldId,
    type: fixtureFieldType(semantic)
  }))
  const normalizedRecords = records.map((record) => ({
    ...clone(record),
    fields: schemaBindings.reduce((result, binding) => {
      const value = record && record.fields && record.fields[binding.semantic]
      result[binding.semantic] = value === undefined || value === null || value === ''
        ? (['4', '17'].includes(binding.type) ? [] : '')
        : clone(value)
      return result
    }, {})
  }))
  const base = {
    ...snapshot([], fieldNames),
    schemaBindings,
    schemaFingerprint: fixtureSha256(schemaBindings)
  }
  return bitableClient._internal.rebuildValidatedTableSnapshot(base, normalizedRecords, {
    includeCreatedTime: false
  })
}

function semanticFieldNames(bindings) {
  return Object.keys(bindings).reduce((result, semantic) => {
    result[semantic] = semantic
    return result
  }, {})
}

function sourceSnapshot() {
  return snapshot([{
    recordId: 'source-record-foundation-1',
    createdTimeMs: SOURCE_CREATED_TIME_MS,
    fields: {
      community: '风雅乐府',
      roomLabel: '风雅乐府 1幢1单元101',
      layoutDescription: '2室1厅',
      layoutCategory: '两室',
      monthlyRent: 3200,
      viewingMethod: '8.1空出，看房提前联系',
      remark: '公开备注'
    }
  }])
}

function sourceRecord(recordId, roomNumber, overrides = {}) {
  return {
    recordId,
    createdTimeMs: SOURCE_CREATED_TIME_MS,
    fields: {
      community: '风雅乐府',
      roomLabel: `风雅乐府 1幢1单元${roomNumber}`,
      layoutDescription: '2室1厅',
      layoutCategory: '两室',
      monthlyRent: 3200,
      viewingMethod: '',
      remark: '公开备注',
      ...overrides
    }
  }
}

function sourceSnapshotOf(records) {
  return snapshot(records)
}

function legacyMiniRecord(recordId, sourceRecordId, roomNumber, overrides = {}) {
  return {
    recordId,
    fields: {
      sourceRecordId,
      locationId: 'LOC-FENGYA',
      locationRecordId: 'location-record-foundation-1',
      city: '杭州市',
      district: '余杭区',
      block: '城北万象城',
      community: '风雅乐府',
      latitude: 30.345286,
      longitude: 120.121984,
      roomLabel: `风雅乐府 1幢1单元${roomNumber}`,
      building: '1',
      unit: '1',
      roomNumber,
      layoutDescription: '2室1厅',
      layoutCategory: '两室',
      monthlyRent: 3200,
      rentMode: '整租',
      viewingMethod: '',
      remark: '历史公开备注',
      listingStatus: '待出租',
      published: true,
      canonical: true,
      enabled: true,
      ...overrides
    }
  }
}

function locationSnapshot() {
  return snapshot([{
    recordId: 'location-record-foundation-1',
    fields: {
      locationId: 'LOC-FENGYA',
      city: '杭州市',
      district: '余杭区',
      block: '城北万象城',
      community: '风雅乐府',
      latitude: 30.345286,
      longitude: 120.121984,
      aliases: ['风雅乐府小区'],
      enabled: true
    }
  }])
}

function makeLifecycleClients(options = {}) {
  const calls = []
  let currentSourceSnapshot = clone(options.sourceSnapshot || sourceSnapshot())
  let failNextMiniUpdate = false
  let failNextCreateTableId = ''
  let failCreateOnCall = null
  let uncertainCreateTableId = ''
  const idempotentCreates = new Map()
  const temporarilyHiddenRecordIds = new Map()
  const tableIds = {
    source: 'tbl-source',
    location: 'tbl-location',
    mini: 'tbl-mini',
    rented: 'tbl-rented',
    history: 'tbl-history',
    ...(options.tableIds || {})
  }
  const tableBindings = {
    [tableIds.mini]: miniBindings(),
    [tableIds.rented]: rentedBindings(),
    [tableIds.history]: historyBindings()
  }
  const tableRecords = {
    [tableIds.mini]: clone(options.miniRecords || []),
    [tableIds.rented]: clone(options.rentedRecords || []),
    [tableIds.history]: clone(options.historyRecords || [])
  }
  let nextRecordNo = 1

  const sourceClient = {
    async readValidatedTableSnapshot(readOptions) {
      calls.push({
        client: 'source',
        action: 'read',
        tableId: readOptions.tableId,
        readOptions: clone(readOptions)
      })
      assert.strictEqual(readOptions.tableId, tableIds.source, '员工源客户端只能读取员工源表')
      return clone(currentSourceSnapshot)
    },
    async batchCreateRecords(tableId) {
      calls.push({ client: 'source', action: 'create', tableId })
      throw new Error('员工源客户端禁止新增')
    },
    async batchUpdateRecords(tableId) {
      calls.push({ client: 'source', action: 'update', tableId })
      throw new Error('员工源客户端禁止更新')
    },
    async batchDeleteRecords(tableId) {
      calls.push({ client: 'source', action: 'delete', tableId })
      throw new Error('员工源客户端禁止删除')
    }
  }

  const targetClient = {
    writeDispatchEvidenceVersion: 1,
    async readValidatedTableSnapshot(readOptions) {
      calls.push({ client: 'target', action: 'read', tableId: readOptions.tableId })
      if (readOptions.tableId === tableIds.location) return locationSnapshot()
      assert.ok(
        Object.prototype.hasOwnProperty.call(tableRecords, readOptions.tableId),
        `目标客户端读取了未声明的数据表：${readOptions.tableId}`
      )
      let visibleRecords = tableRecords[readOptions.tableId]
      const hidden = temporarilyHiddenRecordIds.get(readOptions.tableId)
      if (hidden && hidden.remainingReads > 0) {
        hidden.remainingReads -= 1
        visibleRecords = visibleRecords.filter((record) => !hidden.recordIds.has(record.recordId))
      }
      return validatedTargetSnapshot(
        visibleRecords,
        tableBindings[readOptions.tableId]
      )
    },
    async batchCreateRecords(tableId, records, writeOptions = {}) {
      if (typeof writeOptions.onWriteDispatched === 'function') {
        writeOptions.onWriteDispatched()
      }
      calls.push({
        client: 'target',
        action: 'create',
        tableId,
        records: clone(records),
        clientToken: writeOptions.clientToken
      })
      assert.ok(
        Object.prototype.hasOwnProperty.call(tableRecords, tableId),
        `正式新增只能写目标 Base 的当前表、已出租表或流水表：${tableId}`
      )
      const clientToken = String(writeOptions.clientToken || '')
      assert.match(
        clientToken,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        '每条目标表新增必须携带稳定 UUIDv4 形状的 client_token'
      )
      if (failNextCreateTableId === tableId) {
        failNextCreateTableId = ''
        throw new Error('合成的目标表新增失败')
      }
      if (failCreateOnCall && failCreateOnCall.tableId === tableId) {
        failCreateOnCall.remaining -= 1
        if (failCreateOnCall.remaining === 0) {
          failCreateOnCall = null
          throw new Error('合成的目标表指定新增失败')
        }
      }
      if (idempotentCreates.has(clientToken)) {
        return clone(idempotentCreates.get(clientToken))
      }
      const created = records.map((record) => ({
        recordId: `${tableId}-record-${nextRecordNo++}`,
        fields: clone(record.fields)
      }))
      tableRecords[tableId].push(...created)
      idempotentCreates.set(clientToken, clone(created))
      if (uncertainCreateTableId === tableId) {
        uncertainCreateTableId = ''
        temporarilyHiddenRecordIds.set(tableId, {
          remainingReads: 1,
          recordIds: new Set(created.map((record) => record.recordId))
        })
        throw new Error('合成的飞书新增结果不确定')
      }
      return clone(created)
    },
    async batchUpdateRecords(tableId, records, writeOptions = {}) {
      if (typeof writeOptions.onWriteDispatched === 'function') {
        writeOptions.onWriteDispatched()
      }
      calls.push({
        client: 'target',
        action: 'update',
        tableId,
        records: clone(records)
      })
      assert.ok(
        Object.prototype.hasOwnProperty.call(tableRecords, tableId),
        `正式更新只能写目标 Base 的当前表、已出租表或流水表：${tableId}`
      )
      if (tableId === tableIds.mini && failNextMiniUpdate) {
        failNextMiniUpdate = false
        throw new Error('合成的当前状态更新失败')
      }
      const byRecordId = new Map(tableRecords[tableId].map((record) => [record.recordId, record]))
      records.forEach((record) => {
        const existing = byRecordId.get(record.record_id)
        assert.ok(existing, `目标更新必须命中已有记录：${record.record_id}`)
        Object.assign(existing.fields, clone(record.fields))
      })
      return { records: clone(records) }
    }
  }

  return {
    calls,
    sourceClient,
    targetClient,
    tableIds,
    tableRecords,
    setSourceSnapshot(nextSnapshot) {
      currentSourceSnapshot = clone(nextSnapshot)
    },
    failNextMiniUpdate() {
      failNextMiniUpdate = true
    },
    failNextCreate(tableId) {
      failNextCreateTableId = tableId
    },
    failCreateAt(tableId, callNo) {
      assert.ok(Number.isInteger(callNo) && callNo > 0, '指定失败调用序号必须是正整数')
      failCreateOnCall = { tableId, remaining: callNo }
    },
    armUncertainCreate(tableId) {
      uncertainCreateTableId = tableId
    }
  }
}

function executeOptions(clients, overrides = {}) {
  return {
    sourceClient: clients.sourceClient,
    targetClient: clients.targetClient,
    sourceTableId: clients.tableIds.source,
    locationTableId: clients.tableIds.location,
    miniTableId: clients.tableIds.mini,
    rentedTableId: clients.tableIds.rented,
    historyTableId: clients.tableIds.history,
    sourceBindings: sourceBindings(),
    locationBindings: locationBindings(),
    miniBindings: miniBindings(),
    rentedBindings: rentedBindings(),
    historyBindings: historyBindings(),
    sourceCompatibilityProfile: PROFILE,
    nowMs: FIXED_NOW_MS,
    runId: 'foundation-contract-run',
    maxDeactivateCount: 10,
    maxDeactivateRatio: 0.35,
    ...overrides
  }
}

function assertNoWrites(calls, message) {
  assert.deepStrictEqual(
    calls.filter((call) => ['create', 'update', 'delete'].includes(call.action)),
    [],
    message
  )
}

function assertInternalValuesAbsent(value, message) {
  const json = JSON.stringify(value)
  ;[
    'FOUNDATION-ID-PRIVATE',
    'TEMPORARY-ID-PRIVATE',
    'YUXIAOER-LISTING-ID-PRIVATE',
    'YUXIAOER-ROOM-ID-PRIVATE',
    'PHYSICAL-UNIT-KEY-PRIVATE',
    'OWNER-NAME-PRIVATE',
    'OWNER-DEPARTMENT-PRIVATE',
    'VACANCY-NOTE-PRIVATE'
  ].forEach((privateValue) => {
    assert.strictEqual(
      json.includes(privateValue),
      false,
      `${message}不得出现内部值 ${privateValue}`
    )
  })
}

function testFoundationBindingContracts() {
  const bindingContractStatus = feishuSync._internal.bindingContractStatus
  assert.strictEqual(typeof bindingContractStatus, 'function', '测试前置：字段契约入口必须存在')

  const source = sourceBindings()
  assert.deepStrictEqual(
    bindingContractStatus('source', source, { sourceCompatibilityProfile: PROFILE }),
    { ready: true, issues: [] },
    'employee-ai-foundation-v1 必须支持当前 17 列员工源表，不要求独立 vacancyNote 列'
  )
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(source, 'vacancyNote'),
    false,
    '当前员工源表只绑定一次看房方式，不得把同一列重复绑定为 vacancyNote'
  )

  const sourceWithoutViewingMethod = { ...source }
  delete sourceWithoutViewingMethod.viewingMethod
  assert.strictEqual(
    bindingContractStatus('source', sourceWithoutViewingMethod, {
      sourceCompatibilityProfile: PROFILE
    }).ready,
    false,
    'employee-ai-foundation-v1 必须保留看房方式字段，供看房规则与空出语义共同解析'
  )
  assert.ok(
    bindingContractStatus('source', sourceWithoutViewingMethod, {
      sourceCompatibilityProfile: PROFILE
    }).issues.includes('viewingMethod:missing'),
    '看房方式缺列必须给出稳定的 missing 诊断'
  )

  const sourceWithVacancyNote = sourceBindings({ includeVacancyNote: true })
  assert.deepStrictEqual(
    bindingContractStatus('source', sourceWithVacancyNote, {
      sourceCompatibilityProfile: PROFILE
    }),
    { ready: true, issues: [] },
    '未来标准源表若显式绑定独立 vacancyNote 文本列，仍必须通过契约'
  )

  const sourceWithRequiredVacancyNote = {
    ...sourceWithVacancyNote,
    vacancyNote: binding('src-vacancy-note', true)
  }
  assert.strictEqual(
    bindingContractStatus('source', sourceWithRequiredVacancyNote, {
      sourceCompatibilityProfile: PROFILE
    }).ready,
    false,
    '“备注多久空出”允许空单元格，不得误设为单元格必填'
  )

  const mini = miniBindings()
  assert.strictEqual(
    bindingContractStatus('mini', mini, { sourceCompatibilityProfile: PROFILE }).ready,
    true,
    '数据底座当前状态表完整 18 个内部字段时必须通过契约'
  )
  FOUNDATION_MINI_FIELDS.forEach((semantic) => {
    const incomplete = { ...mini }
    delete incomplete[semantic]
    const state = bindingContractStatus('mini', incomplete, {
      sourceCompatibilityProfile: PROFILE
    })
    assert.strictEqual(state.ready, false, `当前状态表缺少 ${semantic} 必须阻断`)
    assert.ok(state.issues.includes(`${semantic}:missing`), `${semantic} 必须返回稳定 missing 诊断`)
  })

  const rented = rentedBindings()
  assert.strictEqual(
    bindingContractStatus('rented', rented, { sourceCompatibilityProfile: PROFILE }).ready,
    true,
    '已出租周期表完整契约必须可用'
  )
  RENTED_REQUIRED_FIELDS.forEach((semantic) => {
    const incomplete = { ...rented }
    delete incomplete[semantic]
    assert.strictEqual(
      bindingContractStatus('rented', incomplete, {
        sourceCompatibilityProfile: PROFILE
      }).ready,
      false,
      `已出租周期表缺少 ${semantic} 必须阻断`
    )
  })

  const history = historyBindings()
  assert.strictEqual(
    bindingContractStatus('history', history, { sourceCompatibilityProfile: PROFILE }).ready,
    true,
    '状态流水表完整契约必须可用'
  )
  HISTORY_REQUIRED_FIELDS.forEach((semantic) => {
    const incomplete = { ...history }
    delete incomplete[semantic]
    assert.strictEqual(
      bindingContractStatus('history', incomplete, {
        sourceCompatibilityProfile: PROFILE
      }).ready,
      false,
      `状态流水表缺少 ${semantic} 必须阻断`
    )
  })
}

function testViewingMethodDerivesVacancyNoteWithoutConfusingDoorCodes() {
  const catalog = buildLocationCatalog(locationSnapshot().records.map((record) => ({
    recordId: record.recordId,
    ...record.fields
  })))
  const prepared = prepareSourceSnapshotForCompatibility(sourceSnapshotOf([
    sourceRecord('source-vacancy-810', '810', {
      viewingMethod: '8.10空出，不配合提前联系'
    }),
    sourceRecord('source-vacancy-819', '819', {
      viewingMethod: '  8.19空出（配合搬家）   看房提前联系  '
    }),
    sourceRecord('source-sublet', '820', {
      viewingMethod: '租客转租，看房提前联系'
    }),
    sourceRecord('source-door-code', '821', {
      viewingMethod: '336699#'
    }),
    sourceRecord('source-short-code', '822', {
      viewingMethod: '1581'
    }),
    sourceRecord('source-code-note', '823', {
      viewingMethod: '111111（六个1）'
    })
  ]), {
    profile: PROFILE,
    sourceBindings: sourceBindings(),
    locationCatalog: catalog
  })
  const byId = new Map(prepared.records.map((record) => [record.recordId, record.fields]))

  ;[
    ['source-vacancy-810', '8.10空出,不配合提前联系'],
    ['source-vacancy-819', '8.19空出(配合搬家) 看房提前联系']
  ].forEach(([recordId, expectedNote]) => {
    const fields = byId.get(recordId)
    assert.strictEqual(fields.vacancyNote, expectedNote, '明确含“空出”的看房方式必须完整规范化保留')
    assert.strictEqual(fields.listingStatus, '即将空出', '明确含“空出”的记录必须标为即将空出')
    assert.strictEqual(fields.viewingMethod, '联系房东', '空出说明处理后仍须归一为安全看房方式')
    assert.strictEqual(
      fields.viewingPassword,
      '',
      '空出说明只形成明确空密码，不得进入敏感内容'
    )
    assert.strictEqual(fields.remark, '公开备注', '空出说明不得拼入公开备注')
  })

  ;['source-sublet', 'source-code-note'].forEach((recordId) => {
    const fields = byId.get(recordId)
    assert.strictEqual(fields.vacancyNote, '', '不含“空出”的联系或说明文字不得猜成空出备注')
    assert.strictEqual(fields.listingStatus, '待出租', '不含“空出”的员工源记录仍是待出租')
  })

  ;[
    ['source-door-code', '336699#'],
    ['source-short-code', '1581']
  ].forEach(([recordId, password]) => {
    const fields = byId.get(recordId)
    assert.strictEqual(fields.vacancyNote, '', '门锁密码不得因数字或符号被误判为空出时间')
    assert.strictEqual(fields.listingStatus, '待出租', '门锁密码记录仍是待出租')
    assert.strictEqual(fields.viewingMethod, '密码', '已验证门锁码必须继续归一为密码看房')
    assert.strictEqual(fields.viewingPassword, password, '已验证门锁码必须继续进入专用密码字段')
  })

  const explicitPrepared = prepareSourceSnapshotForCompatibility(sourceSnapshotOf([
    sourceRecord('source-explicit-empty', '824', {
      viewingMethod: '8.24空出，看房提前联系',
      vacancyNote: ''
    }),
    sourceRecord('source-explicit-value', '825', {
      viewingMethod: '336699#',
      vacancyNote: '  9.1空出  '
    })
  ]), {
    profile: PROFILE,
    sourceBindings: sourceBindings({ includeVacancyNote: true }),
    locationCatalog: catalog
  })
  const explicitById = new Map(explicitPrepared.records.map((record) => [record.recordId, record.fields]))
  assert.strictEqual(
    explicitById.get('source-explicit-empty').vacancyNote,
    '',
    '显式独立 vacancyNote 列即使为空也必须保持权威，不得回退猜看房方式'
  )
  assert.strictEqual(
    explicitById.get('source-explicit-empty').listingStatus,
    '待出租',
    '显式独立 vacancyNote 为空时必须标为待出租'
  )
  assert.strictEqual(
    explicitById.get('source-explicit-value').vacancyNote,
    '9.1空出',
    '显式独立 vacancyNote 非空时必须规范化并完整保留'
  )
  assert.strictEqual(
    explicitById.get('source-explicit-value').listingStatus,
    '即将空出',
    '显式独立 vacancyNote 非空时必须标为即将空出'
  )
  assert.strictEqual(
    explicitById.get('source-explicit-value').viewingPassword,
    '336699#',
    '显式 vacancyNote 与看房密码必须可独立共存'
  )
}

function testBaselineMarkerAndHistoryIdsFailClosed() {
  const invalidMarker = snapshot([{
    recordId: 'history-invalid-baseline',
    fields: {
      historyEventId: 'HIST-FOUNDATION-BASELINE-V1',
      foundationListingId: 'WRONG-ENTITY',
      availabilityCycleNo: 1,
      availabilityCycleId: 'FOUNDATION-BASELINE-V1',
      eventType: '初始化基线',
      toLifecycleStatusText: '基线完成',
      lifecycleVersion: 0
    }
  }])
  assert.throws(
    () => feishuSync._internal.foundationBaselineCompleted(invalidMarker),
    /基线.*无效|标记.*无效|初始化基线/,
    '仅伪造固定 historyEventId 而业务字段不一致时，不得被认可为已完成基线'
  )

  const duplicateHistory = snapshot([
    {
      recordId: 'history-duplicate-1',
      fields: { historyEventId: 'HIST-DUPLICATE' }
    },
    {
      recordId: 'history-duplicate-2',
      fields: { historyEventId: 'hist-duplicate' }
    }
  ])
  assert.throws(
    () => feishuSync._internal.lifecycleHistoryOperations(
      snapshot([]),
      [],
      duplicateHistory,
      'history-duplicate-run',
      FIXED_NOW_MS
    ),
    /流水.*重复|historyEventId.*重复/,
    '状态流水 historyEventId 被人工复制成重复行时必须整批阻断'
  )
}

function testConfiguredFoundationRequiresAllResources() {
  const previous = clone(config.feishu)
  try {
    Object.assign(config.feishu, {
      appId: 'synthetic-app-id',
      appSecret: 'synthetic-app-secret',
      sourceBitableAppToken: 'synthetic-source-base',
      targetBitableAppToken: 'synthetic-target-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      locationTableId: 'tbl-location',
      miniTableId: 'tbl-mini',
      rentedTableId: 'tbl-rented',
      historyTableId: 'tbl-history',
      sourceCompatibilityProfile: PROFILE,
      sourceFieldBindings: sourceBindings(),
      locationFieldBindings: locationBindings(),
      miniFieldBindings: miniBindings(),
      rentedFieldBindings: rentedBindings(),
      historyFieldBindings: historyBindings(),
      folderToken: 'synthetic-material-folder',
      materialsFile: ''
    })
    const ready = feishuSync._internal.mirrorConfigurationStatus()
    assert.strictEqual(ready.ready, true, '五表、字段契约和跨 Base 边界完整时必须可进入 dry-run')
    assert.strictEqual(ready.aiFoundationEnabled, true, '管理状态必须显式暴露 AI 数据底座已启用')

    config.feishu.rentedTableId = 'tbl-mini'
    assert.strictEqual(
      feishuSync._internal.mirrorConfigurationStatus().tableResourcesDistinct,
      false,
      '当前状态表与已出租表配置成同一资源必须 fail-closed'
    )
    config.feishu.rentedTableId = 'tbl-rented'
    config.feishu.historyTableId = ''
    const missingHistory = feishuSync._internal.mirrorConfigurationStatus()
    assert.strictEqual(missingHistory.ready, false, '缺少状态流水表不得把数据底座标记为 ready')
    assert.strictEqual(missingHistory.historyTableReady, false, '缺失诊断必须精确落到状态流水表')
  } finally {
    restoreObject(config.feishu, previous)
  }
}

async function testConfiguredFoundationForwardsPartialReconciliationCapture() {
  const previous = clone(config.feishu)
  const clients = makeLifecycleClients()
  let captureCount = 0
  try {
    Object.assign(config.feishu, {
      appId: 'synthetic-app-id',
      appSecret: 'synthetic-app-secret',
      sourceBitableAppToken: 'synthetic-source-base',
      targetBitableAppToken: 'synthetic-target-base',
      crossBaseTokenPartial: false,
      sourceTableId: clients.tableIds.source,
      locationTableId: clients.tableIds.location,
      miniTableId: clients.tableIds.mini,
      rentedTableId: clients.tableIds.rented,
      historyTableId: clients.tableIds.history,
      sourceCompatibilityProfile: PROFILE,
      sourceFieldBindings: sourceBindings(),
      locationFieldBindings: locationBindings(),
      miniFieldBindings: miniBindings(),
      rentedFieldBindings: rentedBindings(),
      historyFieldBindings: historyBindings(),
      noteMaterialSyncEnabled: false,
      folderToken: 'synthetic-material-folder',
      materialsFile: ''
    })
    const result = await feishuSync._internal.configuredMirrorTableSync({
      feishuToken: 'synthetic-tenant-token',
      sourceClient: clients.sourceClient,
      targetClient: clients.targetClient,
      disableLegacyMaterials: true,
      dryRun: true,
      runId: 'foundation-configured-partial-capture',
      nowMs: FIXED_NOW_MS,
      _capturePartialReconciliationState(capture) {
        captureCount += 1
        assert.strictEqual(capture.sourceSnapshot.complete, true)
        assert.strictEqual(capture.mirrorSnapshot.complete, true)
        assert.strictEqual(capture.rentedSnapshot.complete, true)
        assert.strictEqual(capture.historySnapshot.complete, true)
      }
    })
    assert.strictEqual(result.dryRun, true)
    assert.strictEqual(captureCount, 1, '真实 configured 入口必须把内部对账捕获回调精确转发一次')
    assertNoWrites(clients.calls, 'configured 对账捕获只能读取五表，禁止写入')
  } finally {
    restoreObject(config.feishu, previous)
  }
}

async function testWorkerV2CanSyncFiveTablesWhenNoteMaterialsAreDisabled() {
  const previousFeishu = clone(config.feishu)
  const previousOss = clone(config.oss)
  let materialProcessingCalls = 0
  const forbiddenMaterialAdapter = new Proxy({}, {
    get() {
      materialProcessingCalls += 1
      throw new Error('素材关闭时不得访问 Drive 或 OSS 适配器')
    }
  })
  const expectedEmptyPlan = buildContentPlanSummary(
    [],
    [],
    buildNoteMaterialSourceFieldPlan([])
  )
  const createDb = () => ({
    users: [{ id: 'A1', name: '管理员', role: '管理员', isAdmin: true }],
    listings: [],
    footprints: [],
    pointLogs: [],
    feishuSyncLogs: []
  })
  const assertDisabledMaterialReport = (result, label) => {
    assert.ok(result && result.noteMaterials, `${label}必须返回素材关闭报告`)
    assert.strictEqual(result.noteMaterials.skipped, true, `${label}必须明确跳过素材处理`)
    assert.strictEqual(result.noteMaterials.failed, 0, `${label}素材关闭不得产生失败`)
    assert.strictEqual(result.noteMaterials.contentPlanAssetCount, 0, `${label}空内容计划素材数必须为 0`)
    assert.strictEqual(
      result.noteMaterials.contentPlanSha256,
      expectedEmptyPlan.contentPlanSha256,
      `${label}必须复用素材模块的稳定空内容计划摘要`
    )
  }
  const configure = (clients) => {
    Object.assign(config.feishu, {
      appId: 'synthetic-app-id',
      appSecret: 'synthetic-app-secret',
      syncEnabled: true,
      autoSyncEnabled: true,
      mirrorSyncEnabled: true,
      syncControllerMode: 'worker-v2',
      approvedSchemaSha256: 'a'.repeat(64),
      approvedResourceIdentitySha256: 'b'.repeat(64),
      sourceBitableAppToken: 'synthetic-source-base',
      targetBitableAppToken: 'synthetic-target-base',
      crossBaseTokenPartial: false,
      sourceTableId: clients.tableIds.source,
      locationTableId: clients.tableIds.location,
      miniTableId: clients.tableIds.mini,
      rentedTableId: clients.tableIds.rented,
      historyTableId: clients.tableIds.history,
      sourceCompatibilityProfile: PROFILE,
      sourceFieldBindings: sourceBindings(),
      locationFieldBindings: locationBindings(),
      miniFieldBindings: miniBindings(),
      rentedFieldBindings: rentedBindings(),
      historyFieldBindings: historyBindings(),
      noteMaterialSyncEnabled: false,
      noteMaterialFieldId: '',
      noteMaterialTargetRootFolderToken: '',
      noteMaterialAllowedHosts: [],
      folderToken: '',
      materialsFile: ''
    })
    Object.assign(config.oss, {
      bucket: '',
      region: '',
      accessKeyId: '',
      accessKeySecret: ''
    })
  }
  const syncOptions = (clients, patch = {}) => ({
    syncController: 'worker-v2',
    disableLegacyMaterials: true,
    feishuToken: 'synthetic-tenant-token',
    clientFactory(options) {
      if (options.appToken === 'synthetic-source-base') return clients.sourceClient
      if (options.appToken === 'synthetic-target-base') return clients.targetClient
      throw new Error(`创建了非预期 Base 客户端：${options.appToken}`)
    },
    noteMaterialDrive: forbiddenMaterialAdapter,
    noteMaterialOss: forbiddenMaterialAdapter,
    prepareMaterial() {
      materialProcessingCalls += 1
      throw new Error('素材关闭时不得准备素材')
    },
    ...patch
  })
  try {
    const dryClients = makeLifecycleClients()
    configure(dryClients)
    assert.strictEqual(
      feishuSync.automaticWorkerConfigurationStatus().ready,
      true,
      '素材开关关闭时，完整房源五表配置必须允许每天三次 worker 运行'
    )
    const dryResult = await feishuSync.sync(createDb(), 'A1', syncOptions(dryClients, {
      dryRun: true,
      runId: 'worker-v2-listing-only-dry',
      nowMs: FIXED_NOW_MS
    }))
    assert.strictEqual(dryResult.status, 'success-dry-run', '素材关闭时 worker-v2 必须完成五表 dry-run')
    assertDisabledMaterialReport(dryResult, 'worker-v2 dry-run')
    assertNoWrites(dryClients.calls, '素材关闭的 worker-v2 dry-run 必须保持五表零写')
    assert.deepStrictEqual(
      [...new Set(dryClients.calls.filter((call) => call.action === 'read').map((call) => call.tableId))].sort(),
      Object.values(dryClients.tableIds).sort(),
      '素材关闭的 worker-v2 dry-run 必须完整读取员工源与目标四表'
    )

    const applyClients = makeLifecycleClients()
    configure(applyClients)
    let frozenCount = 0
    let writeIntentCount = 0
    const applyResult = await feishuSync.sync(createDb(), 'A1', syncOptions(applyClients, {
      dryRun: false,
      runId: 'worker-v2-listing-only-apply',
      nowMs: FIXED_NOW_MS,
      onApplyPlanFrozen(plan) {
        frozenCount += 1
        assert.match(plan.mirrorPlanSha256, /^[0-9a-f]{64}$/)
      },
      onExternalWriteDispatched() {
        writeIntentCount += 1
      }
    }))
    assert.ok(/^success(?:-|$)/.test(applyResult.status), '素材关闭时 worker-v2 必须完成五表正式同步')
    assertDisabledMaterialReport(applyResult, 'worker-v2 正式同步')
    assert.strictEqual(frozenCount, 1, '正式写前必须仍冻结一次权威镜像计划')
    assert.ok(writeIntentCount > 0, '房源正式同步必须真实产生目标 Base 写意图')
    assert.ok(
      applyClients.calls.some((call) => call.client === 'target' && ['create', 'update'].includes(call.action)),
      '素材关闭不得阻断房源与五表正式写入'
    )
    assert.deepStrictEqual(
      [...new Set(applyClients.calls.filter((call) => call.action === 'read').map((call) => call.tableId))].sort(),
      Object.values(applyClients.tableIds).sort(),
      '素材关闭的正式预检与写入必须继续覆盖员工源与目标四表'
    )
    assert.strictEqual(
      applyClients.calls.some((call) => call.client === 'source' && call.action !== 'read'),
      false,
      '员工源表在素材关闭的正式同步中仍必须严格只读'
    )
    assert.strictEqual(materialProcessingCalls, 0, 'dry/apply 全程不得处理 Drive、OSS 或素材字节')
  } finally {
    restoreObject(config.feishu, previousFeishu)
    restoreObject(config.oss, previousOss)
  }
}

async function testLifecycleTableResourcesMustBeDistinct() {
  for (const [overrides, label] of [
    [{ rentedTableId: 'tbl-mini' }, '当前表与已出租表重叠'],
    [{ historyTableId: 'tbl-mini' }, '当前表与流水表重叠'],
    [{ historyTableId: 'tbl-rented' }, '已出租表与流水表重叠']
  ]) {
    const clients = makeLifecycleClients()
    await assert.rejects(
      feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
        ...overrides,
        dryRun: true
      })),
      /资源|独立|重叠|重复|不得.*同一/i,
      `${label}必须在生成任何生命周期计划前 fail-closed`
    )
    assertNoWrites(clients.calls, `${label}不得产生任何写入`)
  }
}

function testInternalFoundationFieldsStayOutOfPublicProjection() {
  const canonicalRecord = {
    recordId: 'mirror-public-projection',
    fields: {
      sourceRecordId: 'source-public-projection',
      locationId: 'LOC-FENGYA',
      locationRecordId: 'location-record-foundation-1',
      city: '杭州市',
      district: '余杭区',
      block: '城北万象城',
      community: '风雅乐府',
      latitude: 30.345286,
      longitude: 120.121984,
      roomLabel: '风雅乐府 1幢1单元101',
      building: '1',
      unit: '1',
      roomNumber: '101',
      layoutDescription: '2室1厅',
      layoutCategory: '两室',
      monthlyRent: 3200,
      rentMode: '整租',
      viewingMethod: '联系房东',
      remark: '公开备注',
      vacancyNote: 'VACANCY-NOTE-PRIVATE',
      listingStatus: '即将空出',
      published: true,
      canonical: true,
      enabled: true,
      foundationListingId: 'FOUNDATION-ID-PRIVATE',
      temporaryListingId: 'TEMPORARY-ID-PRIVATE',
      yuxiaoerListingId: 'YUXIAOER-LISTING-ID-PRIVATE',
      yuxiaoerRoomId: 'YUXIAOER-ROOM-ID-PRIVATE',
      physicalUnitKey: 'PHYSICAL-UNIT-KEY-PRIVATE',
      listingOwner: 'OWNER-NAME-PRIVATE',
      ownerDepartment: 'OWNER-DEPARTMENT-PRIVATE'
    }
  }

  const syncRow = feishuSync._internal.canonicalMirrorRecordToSyncRow(canonicalRecord, 0)
  assert.strictEqual(syncRow.fields.备注, '公开备注', '服务器公开库存备注必须只取公开 remark')
  assertInternalValuesAbsent(
    syncRow,
    'canonicalMirrorRecordToSyncRow 的服务器库存投影（含私有空出原文）'
  )

  const sheet = buildCompanySheetSnapshot([canonicalRecord])
  assert.deepStrictEqual(
    sheet.rows[0],
    ['行政区', '板块/商圈', '小区', '小区+房号', '户型描述', '户型分类', '月租金', '看房方式', '备注', '房源状态'],
    '小程序公司房源表必须继续固定十列'
  )
  assert.strictEqual(sheet.rows.length, 2, '公开投影必须包含一条有效房源')
  assert.strictEqual(sheet.rows[1].length, 10, '公开房源行不得因数据底座扩列')
  assertInternalValuesAbsent(sheet, '固定十列公开投影')
}

function assertFoundationPlannedRecord(result) {
  assert.strictEqual(Array.isArray(result.records), true, '镜像结果必须返回计划后的当前记录')
  assert.strictEqual(result.records.length, 1, '单条员工待租记录必须形成一条当前状态')
  const fields = result.records[0].fields
  assert.strictEqual(fields.lifecycleStatusText, '即将空出', '备注多久空出非空必须派生为即将空出')
  assert.strictEqual(fields.vacancyNote, '8.1空出,看房提前联系', '看房方式中的空出说明必须完整保留')
  assert.strictEqual(fields.viewingMethod, '联系房东', '空出说明必须继续归一为安全看房方式')
  assert.strictEqual(
    String(fields.viewingPassword || ''),
    '',
    '空出说明不得进入看房密码'
  )
  assert.strictEqual(fields.sourceCreatedAt, SOURCE_CREATED_TIME_MS, '计时起点必须使用飞书 created_time')
  assert.strictEqual(fields.metricKind, '提前挂出天数', '即将空出不得冒充真实空置天数')
  assert.strictEqual(fields.lifecycleDays, 2, '提前挂出天数必须按固定 now 与创建时间计算')
  assert.strictEqual(fields.availabilityCycleNo, 1, '首次进入员工源表必须开启第一个待租周期')
  assert.ok(String(fields.availabilityCycleId || '').trim(), '待租周期必须有稳定 cycle ID')
  assert.strictEqual(fields.sourcePresent, true, '员工源表存在时必须显式标记 sourcePresent=true')
  assert.strictEqual(fields.lifecycleVersion, 1, '首次进入当前主档时生命周期版本必须从 1 开始')
  const aliases = JSON.parse(fields.identityAliases)
  assert.ok(
    aliases.some((item) => item.aliasType === 'sourceRecord' && item.aliasValue === 'source-record-foundation-1'),
    '当前主档必须持久化源记录身份别名'
  )
  assert.ok(String(fields.foundationListingId || '').startsWith('TMP-'), '缺寓小二 ID 必须生成临时底座 ID')
  assert.strictEqual(
    fields.temporaryListingId,
    fields.foundationListingId,
    '首次无寓小二 ID 时临时 ID 与底座 ID 必须一致并持久化'
  )
}

async function testDryRunReadsAllLifecycleTablesAndWritesNone() {
  const clients = makeLifecycleClients()
  const result = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true
  }))

  assert.strictEqual(result.status, 'success-dry-run', '数据底座 dry-run 必须完成全链路预演')
  assert.deepStrictEqual(
    result.lifecycleCounts,
    { rentedArchived: 0, historyAppended: 0, baselineInitialized: 1 },
    '首次 dry-run 必须只计划初始化基线，不追认历史出租或业务流水'
  )
  assertFoundationPlannedRecord(result)
  assertNoWrites(
    clients.calls,
    'dry-run 对员工源表、当前状态表、已出租表和状态流水表必须全部零写'
  )
  assert.deepStrictEqual(
    Array.from(new Set(clients.calls
      .filter((call) => call.client === 'target' && call.action === 'read')
      .map((call) => call.tableId))).sort(),
    ['tbl-history', 'tbl-location', 'tbl-mini', 'tbl-rented'].sort(),
    'dry-run 必须真实读取位置字典、当前状态、已出租和流水四张目标表'
  )
}

async function testSourceSnapshotSeparatesCutoffFromLiveValidationClock() {
  const clients = makeLifecycleClients()
  const cutoffMs = FIXED_NOW_MS + 1234
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true,
    nowMs: cutoffMs
  }))
  const sourceReads = clients.calls.filter((call) => (
    call.client === 'source' &&
    call.action === 'read'
  ))
  assert.strictEqual(sourceReads.length, 1, '每轮只能读取一次员工源完整快照')
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(sourceReads[0].readOptions, 'nowMs'),
    false,
    '冻结批次时间不得冒充员工源表读取时的实时未来校验时钟'
  )
  assert.strictEqual(
    sourceReads[0].readOptions.requireCreatedTime,
    true,
    'AI 数据底座必须强制读取 created_time，才能安全应用本轮批次截止'
  )
  assert.strictEqual(
    sourceReads[0].readOptions.createdTimeCutoffMs,
    cutoffMs,
    '员工源表必须单独携带本轮冻结的 created_time 截止时间'
  )
}

async function testEmptyTemplateCannotPoisonNoteMaterialSync() {
  const noteSourceBindings = sourceBindings({ includeNoteMaterial: true })
  const emptyBoundFields = Object.keys(noteSourceBindings).reduce((fields, semantic) => {
    fields[semantic] = ''
    return fields
  }, {})
  const validSource = sourceRecord('source-note-valid', '102', {
    noteMaterialLink: ''
  })
  const emptyTemplate = {
    recordId: 'source-empty-template',
    createdTimeMs: SOURCE_CREATED_TIME_MS,
    fields: emptyBoundFields
  }
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([validSource, emptyTemplate])
  })
  const result = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true,
    sourceBindings: noteSourceBindings,
    noteMaterialSyncEnabled: true
  }))

  assert.deepStrictEqual(
    result.records.map((record) => record.fields.sourceRecordId),
    ['source-note-valid'],
    '全空模板不得进入有效房源计划'
  )
  assert.deepStrictEqual(
    result.sourceNoteMaterials.map((row) => row.sourceRecordId),
    ['source-note-valid'],
    '房源笔记素材必须与兼容过滤后的有效房源使用同一权威源记录集合'
  )

  const materialReport = await syncNoteMaterialsForInventory({
    db: {
      listings: [{
        id: 'listing-note-valid',
        externalSource: 'feishu',
        feishuRecordId: 'source-note-valid',
        sourceRecordId: 'source-note-valid',
        mediaAssets: []
      }]
    },
    sourceRows: result.sourceNoteMaterials,
    dryRun: true,
    allowedHosts: ['example.feishu.test']
  })
  assert.strictEqual(materialReport.sourceRecordCount, 1, '素材预演只能处理一条有效房源')
  assert.strictEqual(materialReport.failed, 0, '全空模板不得制造 listing-missing')
  assert.strictEqual(
    materialReport.rows.some((row) => row.status === 'listing-missing'),
    false,
    '素材预演中不得出现全空模板对应的 listing-missing'
  )

  const materialOnlyFields = { ...emptyBoundFields }
  materialOnlyFields.noteMaterialLink = 'https://example.feishu.test/file/mock-material'
  const halfFilledClients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([{
      recordId: 'source-material-without-room',
      createdTimeMs: SOURCE_CREATED_TIME_MS,
      fields: materialOnlyFields
    }])
  })
  await assert.rejects(
    () => feishuSync._internal.executeMirrorTableSync(executeOptions(halfFilledClients, {
      dryRun: true,
      sourceBindings: noteSourceBindings,
      noteMaterialSyncEnabled: true
    })),
    /房号|roomLabel|源记录/u,
    '只有素材但没有房号的半填行必须失败关闭，不能伪装成空模板'
  )
  assertNoWrites(
    halfFilledClients.calls,
    '半填素材行阻断时不得写目标当前状态、已出租或流水表'
  )
}

async function testApplyWritesOnlyTargetClient() {
  const clients = makeLifecycleClients()
  let writeIntentCount = 0
  const result = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    onExternalWriteDispatched() {
      writeIntentCount += 1
    }
  }))

  assert.ok(/^success(?:-|$)/.test(result.status), '正式数据底座同步必须完成写后回读')
  assert.deepStrictEqual(
    result.lifecycleCounts,
    { rentedArchived: 0, historyAppended: 0, baselineInitialized: 1 },
    '首次正式同步必须建立持久初始化基线且不追认历史出租'
  )
  assertFoundationPlannedRecord(result)
  assert.deepStrictEqual(
    clients.calls.filter((call) => call.client === 'source').map((call) => call.action),
    ['read'],
    '正式同步中员工源客户端只能 GET/读，不得出现 POST、更新或删除'
  )

  const targetWrites = clients.calls.filter((call) => (
    call.client === 'target' && ['create', 'update', 'delete'].includes(call.action)
  ))
  assert.ok(targetWrites.length >= 1, '正式同步必须真实走目标客户端写入当前状态或流水')
  assert.strictEqual(
    writeIntentCount,
    targetWrites.length,
    '每个目标 Base 写请求都必须先上报精确外部写意图'
  )
  targetWrites.forEach((call) => {
    assert.ok(
      ['tbl-mini', 'tbl-rented', 'tbl-history'].includes(call.tableId),
      `正式同步不得写出目标三张业务表边界：${call.tableId}`
    )
  })
  assert.ok(
    targetWrites.some((call) => call.tableId === 'tbl-mini'),
    '首次正式同步必须写目标当前状态表'
  )
  assert.ok(
    targetWrites.some((call) => call.tableId === 'tbl-history'),
    '首次正式同步必须写目标状态流水表'
  )

  const unsupported = makeLifecycleClients()
  delete unsupported.targetClient.writeDispatchEvidenceVersion
  let unsupportedIntents = 0
  await assert.rejects(
    () => feishuSync._internal.executeMirrorTableSync(executeOptions(unsupported, {
      dryRun: false,
      onExternalWriteDispatched() { unsupportedIntents += 1 }
    })),
    (error) => error && error.code === 'TARGET_WRITE_DISPATCH_EVIDENCE_REQUIRED',
    'worker 正式链路不得接受无法证明写派发时点的目标 Base 适配器'
  )
  assert.deepStrictEqual(unsupported.calls, [], '证据能力缺失必须在读取或写入任何表前失败关闭')
  assert.strictEqual(unsupportedIntents, 0)

  const invalidCallback = makeLifecycleClients()
  await assert.rejects(
    () => feishuSync._internal.executeMirrorTableSync(executeOptions(invalidCallback, {
      dryRun: false,
      onExternalWriteDispatched: 'not-a-function'
    })),
    (error) => error && error.code === 'EXTERNAL_WRITE_DISPATCH_CALLBACK_INVALID' &&
      error.safeBeforeWrite === true,
    '非法写派发回调必须在读取或写入任何表前失败关闭'
  )
  assert.deepStrictEqual(invalidCallback.calls, [])
}

async function testCreateOmitsMissingOptionalFieldsAndUpdateKeepsClearSemantics() {
  const clients = makeLifecycleClients()
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    runId: 'foundation-create-without-null-run'
  }))

  const miniCreate = clients.calls.find((call) => (
    call.client === 'target' && call.action === 'create' && call.tableId === 'tbl-mini'
  ))
  assert.ok(miniCreate && miniCreate.records.length === 1, '测试前置：首次同步必须新增一条当前主档')
  const createFields = miniCreate.records[0].fields
  Object.entries(createFields).forEach(([fieldName, value]) => {
    assert.notStrictEqual(value, null, `新增载荷不得把缺失字段 ${fieldName} 序列化为 null`)
    assert.notStrictEqual(value, undefined, `新增载荷不得把缺失字段 ${fieldName} 序列化为 undefined`)
    if (typeof value === 'string') {
      assert.notStrictEqual(value.trim(), '', `新增载荷不得夹带空文本字段 ${fieldName}`)
    }
    if (Array.isArray(value)) {
      assert.ok(value.length > 0, `新增载荷不得夹带空数组字段 ${fieldName}`)
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assert.ok(Object.keys(value).length > 0, `新增载荷不得夹带空对象字段 ${fieldName}`)
    }
  })
  ;['viewingPassword', 'contact', 'landlordCommissionPercent', 'tags', 'video'].forEach((semantic) => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(createFields, semantic),
      false,
      `新增载荷必须省略未提供的可选字段 ${semantic}`
    )
  })

  const persisted = clients.tableRecords['tbl-mini'][0]
  persisted.fields.viewingPassword = '336699#'
  persisted.fields.landlordCommissionPercent = 65
  persisted.fields.tags = ['电梯', '整租']
  persisted.fields.video = [{ file_token: 'target-owned-video-token' }]
  persisted.fields.yuxiaoerListingId = 'YXL-TARGET-ONLY'
  persisted.fields.yuxiaoerRoomId = 'YXR-TARGET-ONLY'
  persisted.fields.listingOwner = '目标负责人'
  persisted.fields.ownerDepartment = '目标部门'
  clients.calls.length = 0
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    runId: 'foundation-update-clear-run'
  }))
  const miniUpdate = clients.calls.find((call) => (
    call.client === 'target' && call.action === 'update' && call.tableId === 'tbl-mini'
  ))
  assert.ok(miniUpdate && miniUpdate.records.length === 1, '源记录明确无密码时必须更新并清除旧密码')
  assert.strictEqual(
    miniUpdate.records[0].fields.viewingPassword,
    '',
    '更新载荷必须用类型正确的空文本明确清除旧密码'
  )
  assert.deepStrictEqual(
    Object.keys(miniUpdate.records[0].fields).sort(),
    ['identityAliases', 'identityType', 'viewingPassword'],
    '补入目标内部 ID 后，只能更新随身份确实变化的字段和待清空密码，不得夹带未变化或目标表专有字段'
  )
  ;['landlordCommissionPercent', 'tags', 'video'].forEach((semantic) => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(miniUpdate.records[0].fields, semantic),
      false,
      `员工源未拥有的目标专有字段 ${semantic} 不得进入更新载荷`
    )
  })
  assert.strictEqual(persisted.fields.landlordCommissionPercent, 65, '更新后必须保留目标表佣金比例')
  assert.deepStrictEqual(persisted.fields.tags, ['电梯', '整租'], '更新后必须保留目标表标签')
  assert.deepStrictEqual(
    persisted.fields.video,
    [{ file_token: 'target-owned-video-token' }],
    '更新后必须保留目标表视频附件'
  )
  assert.strictEqual(persisted.fields.yuxiaoerListingId, 'YXL-TARGET-ONLY')
  assert.strictEqual(persisted.fields.yuxiaoerRoomId, 'YXR-TARGET-ONLY')
  assert.strictEqual(persisted.fields.listingOwner, '目标负责人')
  assert.strictEqual(persisted.fields.ownerDepartment, '目标部门')
}

async function testFeishuApiFailureExposesOnlySanitizedMachineCode() {
  const client = bitableClient.createBitableClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          code: 1254063,
          msg: '合成错误正文不得进入持久错误码',
          data: {}
        }
      }
    }),
    baseUrl: 'https://open.feishu.invalid/open-apis',
    appToken: 'app-test-only',
    accessToken: 'tenant-test-only',
    requestTimeoutMs: 1000,
    maxRetries: 0,
    retryDelayMs: 0
  })
  await assert.rejects(
    () => client.batchCreateRecords('tbl-test-only', [{ fields: { 名称: '合成记录' } }], {
      clientToken: '11111111-1111-4111-8111-111111111111'
    }),
    (error) => error && error.code === 'FEISHU_API_1254063' &&
      !String(error.message || '').includes('合成错误正文'),
    '飞书业务失败必须提供脱敏、可分类的机器错误码，且不得携带响应正文'
  )

  const sensitiveMarker = 'synthetic-sensitive-code-marker'
  const nonnumericClient = bitableClient.createBitableClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { code: sensitiveMarker, msg: '同样不得泄露', data: {} }
      }
    }),
    baseUrl: 'https://open.feishu.invalid/open-apis',
    appToken: 'app-test-only',
    accessToken: 'tenant-test-only',
    requestTimeoutMs: 1000,
    maxRetries: 0,
    retryDelayMs: 0
  })
  await assert.rejects(
    () => nonnumericClient.batchCreateRecords('tbl-test-only', [{ fields: { 名称: '合成记录' } }], {
      clientToken: '22222222-2222-4222-8222-222222222222'
    }),
    (error) => error && error.code === 'FEISHU_API_ERROR' &&
      !String(error.message || '').includes(sensitiveMarker) &&
      String(error.message || '').includes('code=unknown'),
    '非数字业务错误码必须同时从机器码与异常文本中脱敏'
  )
}

async function testLegacyProfileCannotEraseFoundationFields() {
  const clients = makeLifecycleClients()
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))
  const current = clients.tableRecords['tbl-mini'][0]
  assert.ok(current, '测试前置：AI 数据底座必须已建立当前主档')
  current.fields.listingStatus = '在租'
  const internalBefore = FOUNDATION_MINI_FIELDS.reduce((result, semantic) => {
    result[semantic] = current.fields[semantic] === undefined
      ? undefined
      : clone(current.fields[semantic])
    return result
  }, {})

  clients.calls.length = 0
  const legacyNoop = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    sourceCompatibilityProfile: 'employee-current-stock-v1',
    dryRun: false
  }))
  const legacySourceReads = clients.calls.filter((call) => (
    call.client === 'source' &&
    call.action === 'read'
  ))
  assert.strictEqual(legacySourceReads.length, 1, '旧 profile 每轮只能读取一次员工源完整快照')
  assert.strictEqual(
    legacySourceReads[0].readOptions.requireCreatedTime,
    false,
    '旧 profile 不依赖 created_time，不得擅自升级员工源契约'
  )
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      legacySourceReads[0].readOptions,
      'createdTimeCutoffMs'
    ),
    false,
    '批次 created_time 截止只属于 AI 数据底座，旧 profile 不得携带'
  )
  assert.strictEqual(
    legacyNoop.noop,
    true,
    '当前 17 列源表误切旧 profile 时，不得因源未绑定 vacancyNote 制造虚假更新'
  )
  assert.strictEqual(
    clients.calls.some((call) => call.client === 'target' && call.action === 'update'),
    false,
    '仅因当前主档含底座字段不得触发旧 profile 更新'
  )
  assert.deepStrictEqual(
    FOUNDATION_MINI_FIELDS.reduce((result, semantic) => {
      result[semantic] = current.fields[semantic]
      return result
    }, {}),
    internalBefore,
    '旧 profile no-op 不得清空或改写任何底座字段'
  )

  const changedSource = sourceSnapshot()
  changedSource.records[0].fields.monthlyRent = 3300
  clients.setSourceSnapshot(changedSource)
  clients.calls.length = 0
  const legacyUpdate = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    sourceCompatibilityProfile: 'employee-current-stock-v1',
    dryRun: false
  }))
  assert.strictEqual(legacyUpdate.counts.update, 1, '旧 profile 的普通租金变化仍应更新业务字段')
  assert.strictEqual(current.fields.monthlyRent, 3300, '普通业务字段更新必须真实落盘')
  assert.deepStrictEqual(
    FOUNDATION_MINI_FIELDS.reduce((result, semantic) => {
      result[semantic] = current.fields[semantic]
      return result
    }, {}),
    internalBefore,
    '当前 17 列源表误切旧 profile 后，普通业务更新不得清空包括 vacancyNote 在内的 18 个底座字段'
  )

  const protectedBeforeVacancyChange = FOUNDATION_MINI_FIELDS
    .filter((semantic) => semantic !== 'vacancyNote')
    .reduce((result, semantic) => {
      result[semantic] = current.fields[semantic]
      return result
    }, {})
  const legacyBindings = sourceBindings({ includeVacancyNote: true })
  changedSource.records[0].fields.vacancyNote = '下月中旬空出'
  clients.setSourceSnapshot(changedSource)
  clients.calls.length = 0
  const legacyVacancyUpdate = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    sourceCompatibilityProfile: 'employee-current-stock-v1',
    sourceBindings: legacyBindings,
    dryRun: false
  }))
  assert.strictEqual(legacyVacancyUpdate.counts.update, 1, '旧 profile 仍须同步员工修改的“备注多久空出”')
  assert.strictEqual(current.fields.vacancyNote, '下月中旬空出', 'vacancyNote 必须真实写入并通过回读')
  assert.deepStrictEqual(
    FOUNDATION_MINI_FIELDS
      .filter((semantic) => semantic !== 'vacancyNote')
      .reduce((result, semantic) => {
        result[semantic] = current.fields[semantic]
        return result
      }, {}),
    protectedBeforeVacancyChange,
    '旧 profile 同步 vacancyNote 时不得改写其余 17 个底座专有字段'
  )
}

async function testArchiveIdempotencyAndReappearance() {
  const first = sourceRecord('source-cycle-1', '101')
  const second = sourceRecord('source-cycle-2', '102')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([first, second])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  const initialCurrent = clone(clients.tableRecords['tbl-mini'])
  const firstCurrent = initialCurrent.find((record) => record.fields.sourceRecordId === first.recordId)
  assert.ok(firstCurrent, '首次同步必须建立待出租当前状态')
  const stableFoundationId = firstCurrent.fields.foundationListingId
  const stableRecordId = firstCurrent.recordId

  clients.setSourceSnapshot(sourceSnapshotOf([second]))
  const rented = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  assert.deepStrictEqual(
    rented.lifecycleCounts,
    { rentedArchived: 1, historyAppended: 1, baselineInitialized: 0 },
    '完整快照中一套房消失时必须归档一个周期并追加一条状态流水'
  )
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 1, '已出租表必须只新增一个周期快照')
  const archived = clients.tableRecords['tbl-rented'][0].fields
  assert.strictEqual(archived.foundationListingId, stableFoundationId, '出租快照必须继续引用稳定底座 ID')
  assert.strictEqual(archived.lifecycleStatusText, '已出租', '出租快照必须冻结为已出租')
  assert.strictEqual(archived.lifecycleDays, 2, '出租快照必须冻结本周期累计天数')
  assert.strictEqual(archived.district, '余杭区', '出租快照必须冻结当期行政区')
  assert.strictEqual(archived.block, '城北万象城', '出租快照必须冻结当期板块')
  assert.strictEqual(archived.community, '风雅乐府', '出租快照必须冻结当期小区')
  assert.strictEqual(archived.roomLabel, '风雅乐府 1幢1单元101', '出租快照必须冻结当期标准房号')
  assert.strictEqual(archived.layoutDescription, '2室1厅', '出租快照必须冻结当期户型')
  assert.strictEqual(archived.monthlyRent, 3200, '出租快照必须冻结当期挂牌租金')
  assert.strictEqual(archived.rentMode, '整租', '出租快照必须冻结当期出租方式')
  assert.strictEqual(archived.listingStatus, '已出租', '出租快照必须明确是否已出租')
  assert.strictEqual(archived.published, false, '出租快照必须明确不再展示上架')
  const immutableArchive = clone(archived)
  const disabled = clients.tableRecords['tbl-mini'].find((record) => record.recordId === stableRecordId)
  assert.strictEqual(disabled.fields.sourcePresent, false, '消失房源必须标记源表已不存在')
  assert.strictEqual(disabled.fields.published, false, '消失房源必须关闭公开展示')
  assert.strictEqual(disabled.fields.enabled, false, '消失房源必须软停用')

  const writeCountBeforeRepeat = clients.calls.filter((call) => (
    ['create', 'update', 'delete'].includes(call.action)
  )).length
  const repeat = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  assert.deepStrictEqual(
    repeat.lifecycleCounts,
    { rentedArchived: 0, historyAppended: 0, baselineInitialized: 0 },
    '同一完整快照重跑不得重复归档或重复追加流水'
  )
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 1, '重复同步不得制造第二条出租周期')
  assert.strictEqual(
    clients.calls.filter((call) => ['create', 'update', 'delete'].includes(call.action)).length,
    writeCountBeforeRepeat,
    '同一出租状态重跑必须成为真正的零写入'
  )

  clients.setSourceSnapshot(sourceSnapshotOf([first, second]))
  const restored = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  const restoredRecord = clients.tableRecords['tbl-mini'].find((record) => record.recordId === stableRecordId)
  assert.strictEqual(restoredRecord.fields.foundationListingId, stableFoundationId, '重新出现必须复用同一底座实体')
  assert.strictEqual(restoredRecord.fields.availabilityCycleNo, 2, '重新出现必须开启第二个待租周期')
  assert.strictEqual(restoredRecord.fields.sourcePresent, true, '重新出现必须恢复源表存在状态')
  assert.strictEqual(restoredRecord.fields.published, true, '重新出现必须恢复公开展示')
  assert.strictEqual(restored.lifecycleCounts.historyAppended, 1, '重新进入待租必须追加一条状态流水')
  assert.deepStrictEqual(
    clients.tableRecords['tbl-rented'][0].fields,
    immutableArchive,
    '当前房源重新出现和进入新周期后不得改写上一周期出租快照'
  )
}

async function testArchiveFirstCurrentWriteFailureCanRecover() {
  const first = sourceRecord('source-recovery-1', '201')
  const second = sourceRecord('source-recovery-2', '202')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([first, second])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  clients.setSourceSnapshot(sourceSnapshotOf([second]))
  clients.failNextMiniUpdate()
  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
      dryRun: false,
      maxDeactivateRatio: 0.75
    })),
    /当前状态更新失败/,
    '出租周期和流水落盘后当前状态写失败必须显式抛错'
  )
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 1, '失败前已写入的出租周期必须保留用于补偿')
  assert.strictEqual(
    clients.tableRecords['tbl-history'].filter((record) => (
      record.fields.toLifecycleStatusText === '已出租'
    )).length,
    1,
    '失败前已写入的已出租流水必须保持唯一'
  )

  const recovered = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  assert.strictEqual(recovered.status, 'success', '重跑必须补齐当前状态并成功')
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 1, '补偿重跑不得重复新增出租周期')
  assert.strictEqual(
    clients.tableRecords['tbl-history'].filter((record) => (
      record.fields.toLifecycleStatusText === '已出租'
    )).length,
    1,
    '补偿重跑不得重复新增已出租流水'
  )
}

async function testExactPartialPrefixKeepsStableReadOnlyContinuationPlan() {
  const initialSources = Array.from({ length: 40 }, (_, index) => (
    sourceRecord(`source-exact-partial-${index + 1}`, String(1101 + index))
  ))
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf(initialSources)
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    runId: 'foundation-exact-partial-baseline',
    nowMs: FIXED_NOW_MS,
    maxDeactivateRatio: 0.75
  }))
  const miniBeforePartial = clone(clients.tableRecords['tbl-mini'])
  const rentedBeforePartial = clients.tableRecords['tbl-rented'].length
  const historyBeforePartial = clients.tableRecords['tbl-history'].length

  const retainedSources = initialSources.slice(0, 37).map((record, index) => (
    sourceRecord(record.recordId, String(1101 + index), {
      monthlyRent: 3300,
      ...(index === 0 ? { viewingMethod: '8.10空出，看房提前联系' } : {})
    })
  ))
  const addedSources = Array.from({ length: 6 }, (_, index) => (
    sourceRecord(`source-exact-partial-new-${index + 1}`, String(2101 + index), {
      monthlyRent: 3300
    })
  ))
  clients.setSourceSnapshot(sourceSnapshotOf([...retainedSources, ...addedSources]))

  const oldRunId = 'foundation-exact-partial-run-20260807'
  const oldRunNowMs = FIXED_NOW_MS + 60_000
  const expectedMainCounts = { create: 6, update: 37, restore: 0, deactivate: 3, noop: 0 }
  clients.calls.length = 0
  const authorizedPlan = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true,
    runId: oldRunId,
    nowMs: oldRunNowMs,
    maxDeactivateRatio: 0.75
  }))
  assert.deepStrictEqual(
    authorizedPlan.counts,
    expectedMainCounts,
    '旧 run 的权威计划必须精确为新增 6、更新 37、撤下 3'
  )
  assert.deepStrictEqual(
    authorizedPlan.lifecycleCounts,
    { rentedArchived: 3, historyAppended: 10, baselineInitialized: 0 },
    '旧 run 首次计划必须精确生成 3 条归档和 10 条流水'
  )
  assertNoWrites(clients.calls, '旧 run 的权威 dry-run 只能读取五表，不能提前写入')

  clients.calls.length = 0
  clients.failNextCreate('tbl-mini')
  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
      dryRun: false,
      runId: oldRunId,
      nowMs: oldRunNowMs,
      maxDeactivateRatio: 0.75
    })),
    /目标表新增失败/,
    '3 条归档和 10 条流水落盘后，第一条 mini 新增失败必须立即停止'
  )
  assert.deepStrictEqual(
    clients.tableRecords['tbl-mini'],
    miniBeforePartial,
    '部分写入失败窗口不得让 mini 主表落盘任何新增、更新或撤下'
  )
  assert.strictEqual(
    clients.tableRecords['tbl-rented'].length - rentedBeforePartial,
    3,
    '部分写入失败窗口必须且只能落盘 3 条归档'
  )
  assert.strictEqual(
    clients.tableRecords['tbl-history'].length - historyBeforePartial,
    10,
    '部分写入失败窗口必须且只能落盘 10 条状态流水'
  )
  assert.strictEqual(
    clients.tableRecords['tbl-rented'].filter((record) => (
      Number(record.fields.archivedAt) === oldRunNowMs
    )).length,
    3,
    '3 条归档必须绑定旧 run 的精确 nowMs'
  )
  assert.strictEqual(
    clients.tableRecords['tbl-history'].filter((record) => (
      record.fields.runId === oldRunId
    )).length,
    10,
    '10 条流水必须绑定同一个旧 runId'
  )
  const failedApplyMiniWrites = clients.calls.filter((call) => (
    ['create', 'update', 'delete'].includes(call.action) && call.tableId === 'tbl-mini'
  ))
  assert.strictEqual(failedApplyMiniWrites.length, 1, '失败窗口只能派发第一条 mini 新增请求')
  assert.strictEqual(failedApplyMiniWrites[0].action, 'create', 'mini 必须在第一条新增落盘前失败')

  clients.calls.length = 0
  let firstCapture = null
  const firstContinuationPlan = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true,
    runId: oldRunId,
    nowMs: oldRunNowMs,
    maxDeactivateRatio: 0.75,
    _capturePartialReconciliationState(value) {
      assert.strictEqual(firstCapture, null, '单次 dry-run 只能捕获一份部分写入对账快照')
      firstCapture = value
    }
  }))
  let secondCapture = null
  const secondContinuationPlan = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true,
    runId: oldRunId,
    nowMs: oldRunNowMs,
    maxDeactivateRatio: 0.75,
    _capturePartialReconciliationState(value) {
      assert.strictEqual(secondCapture, null, '第二次 dry-run 也只能捕获一份部分写入对账快照')
      secondCapture = value
    }
  }))
  assert.ok(firstCapture && secondCapture, '连续两次 dry-run 都必须形成完整对账快照')
  assert.deepStrictEqual(
    secondContinuationPlan,
    firstContinuationPlan,
    '同一旧 runId/nowMs 连续两次 dry-run 必须返回完全相同的续跑计划'
  )
  assert.deepStrictEqual(
    firstContinuationPlan.counts,
    expectedMainCounts,
    '识别已落盘前缀后，mini 剩余计划仍必须是新增 6、更新 37、撤下 3'
  )
  assert.deepStrictEqual(
    firstContinuationPlan.lifecycleCounts,
    { rentedArchived: 0, historyAppended: 0, baselineInitialized: 0 },
    '已落盘的 3 条归档和 10 条流水必须全部幂等识别，续跑生命周期计划为 0/0'
  )
  assertNoWrites(clients.calls, '连续两次续跑 dry-run 必须保持所有目标表零写')
  assert.deepStrictEqual(
    clients.tableRecords['tbl-mini'],
    miniBeforePartial,
    '连续只读对账不得改变仍未推进的 mini 主表'
  )

  assert.strictEqual(
    typeof feishuSync._internal.buildPartialBaseReconciliationEvidence,
    'function',
    '部分写入恢复必须提供纯内存证据构建器供行为测试复验'
  )
  const frozenRunEvidence = {
    runId: oldRunId,
    runNowMs: oldRunNowMs,
    expectedMirrorPlanSha256: authorizedPlan.mirrorPlanSha256,
    expectedSchemaSha256: authorizedPlan.schemaSha256,
    expectedResourceIdentitySha256: authorizedPlan.resourceIdentitySha256
  }
  const firstEvidence = feishuSync._internal.buildPartialBaseReconciliationEvidence({
    run: frozenRunEvidence,
    capture: firstCapture
  })
  const secondEvidence = feishuSync._internal.buildPartialBaseReconciliationEvidence({
    run: frozenRunEvidence,
    capture: secondCapture
  })
  assert.deepStrictEqual(secondEvidence, firstEvidence, '连续两次快照必须生成同一份部分写入对账证据')
  assert.strictEqual(firstEvidence.archiveCount, 3, '对账证据必须精确确认已落盘 3 条归档')
  assert.strictEqual(firstEvidence.historyCount, 10, '对账证据必须精确确认已落盘 10 条流水')
  assert.deepStrictEqual(
    firstEvidence.currentPlan,
    expectedMainCounts,
    '过滤回写前快照命中旧权威摘要后，证据必须保留完整 mini 续跑计划'
  )

  for (const tamper of [
    {
      label: '已出租前缀非身份字段',
      mutate(capture) {
        const record = capture.rentedSnapshot.records.find((item) => (
          Number(item.fields.archivedAt) === oldRunNowMs
        ))
        record.fields.remark = `${record.fields.remark || ''}-tampered`
      }
    },
    {
      label: '状态流水前缀非身份字段',
      mutate(capture) {
        const record = capture.historySnapshot.records.find((item) => item.fields.runId === oldRunId)
        record.fields.eventType = `${record.fields.eventType}-tampered`
      }
    }
  ]) {
    const tamperedCapture = clone(firstCapture)
    tamper.mutate(tamperedCapture)
    assert.throws(
      () => feishuSync._internal.buildPartialBaseReconciliationEvidence({
        run: frozenRunEvidence,
        capture: tamperedCapture
      }),
      /字段不一致|对账.*失败|摘要未命中/i,
      `${tamper.label}被改动时不得只靠身份和旧 B 假装对账成功`
    )
  }

  assert.strictEqual(
    typeof feishuSync._internal.reconcilePartialBaseWritesWithConfiguredSync,
    'function',
    '顶层部分写入恢复必须可行为验证两次真实 configured 读取'
  )
  clients.calls.length = 0
  let configuredRounds = 0
  const serviceEvidence = await feishuSync._internal.reconcilePartialBaseWritesWithConfiguredSync(
    { listings: [] },
    {
      externalWriteIntentAt: oldRunNowMs + 1,
      expectedMirrorPlanSha256: authorizedPlan.mirrorPlanSha256,
      expectedResourceIdentitySha256: authorizedPlan.resourceIdentitySha256,
      expectedSchemaSha256: authorizedPlan.schemaSha256,
      runId: oldRunId,
      runNowMs: oldRunNowMs
    },
    async (options) => {
      configuredRounds += 1
      return feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
        ...options,
        maxDeactivateRatio: 0.75
      }))
    }
  )
  assert.deepStrictEqual(serviceEvidence, firstEvidence, '服务端双读入口必须返回同一份已验证证据')
  assert.strictEqual(configuredRounds, 2, '服务端必须真实执行两轮 configured dry-run，不得复用首轮缓存')
  assert.strictEqual(
    clients.calls.filter((call) => call.action === 'read').length,
    10,
    '每轮必须分别读取员工源、位置、主表、已出租、流水五表'
  )
  assertNoWrites(clients.calls, '服务端双读对账不得产生任何目标写入')

  const zeroWriteRunId = 'foundation-exact-zero-write-run-20260807'
  const zeroWriteRunNowMs = oldRunNowMs + 90_000
  clients.calls.length = 0
  const zeroWriteAuthorizedPlan = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true,
    runId: zeroWriteRunId,
    nowMs: zeroWriteRunNowMs,
    maxDeactivateRatio: 0.75
  }))
  assert.deepStrictEqual(zeroWriteAuthorizedPlan.counts, expectedMainCounts)
  assert.deepStrictEqual(
    zeroWriteAuthorizedPlan.lifecycleCounts,
    { rentedArchived: 0, historyAppended: 0, baselineInitialized: 0 },
    '旧前缀已由生命周期幂等识别时，新 UNKNOWN 可以真实形成五表零业务增量'
  )
  let zeroWriteConfiguredRounds = 0
  clients.calls.length = 0
  const zeroWriteEvidence = await feishuSync._internal.reconcilePartialBaseWritesWithConfiguredSync(
    { listings: [] },
    {
      externalWriteIntentAt: zeroWriteRunNowMs + 1,
      expectedMirrorPlanSha256: zeroWriteAuthorizedPlan.mirrorPlanSha256,
      expectedResourceIdentitySha256: zeroWriteAuthorizedPlan.resourceIdentitySha256,
      expectedSchemaSha256: zeroWriteAuthorizedPlan.schemaSha256,
      runId: zeroWriteRunId,
      runNowMs: zeroWriteRunNowMs
    },
    async (options) => {
      zeroWriteConfiguredRounds += 1
      return feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
        ...options,
        maxDeactivateRatio: 0.75
      }))
    }
  )
  assert.strictEqual(zeroWriteConfiguredRounds, 2, '零写入对账也必须真实双读 configured 生产路径')
  assert.strictEqual(zeroWriteEvidence.archiveCount, 0)
  assert.strictEqual(zeroWriteEvidence.historyCount, 0)
  assert.strictEqual(zeroWriteEvidence.archiveEvidenceSha256, fixtureSha256([]))
  assert.strictEqual(zeroWriteEvidence.historyEvidenceSha256, fixtureSha256([]))
  assert.deepStrictEqual(zeroWriteEvidence.currentPlan, expectedMainCounts)
  assertNoWrites(clients.calls, '零写入 configured 双读不得产生任何目标写入')

  const freshRunId = 'foundation-exact-partial-fresh-20260807'
  const freshRunNowMs = oldRunNowMs + 120_000
  clients.calls.length = 0
  const freshDryRun = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true,
    runId: freshRunId,
    nowMs: freshRunNowMs,
    maxDeactivateRatio: 0.75
  }))
  assert.deepStrictEqual(freshDryRun.counts, expectedMainCounts, '全新 run 必须继承同一份剩余主表计划')
  assert.deepStrictEqual(
    freshDryRun.lifecycleCounts,
    { rentedArchived: 0, historyAppended: 0, baselineInitialized: 0 },
    '生命周期幂等身份不得绑定旧 runId/nowMs，全新 run 也必须识别 3/10 已落盘前缀'
  )
  assertNoWrites(clients.calls, '全新 run 的预演必须保持零写')

  clients.calls.length = 0
  const freshApply = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    runId: freshRunId,
    nowMs: freshRunNowMs,
    maxDeactivateRatio: 0.75
  }))
  assert.strictEqual(freshApply.published, true, '全新 run 必须能完成剩余主表写入')
  assert.deepStrictEqual(freshApply.lifecycleCounts, {
    rentedArchived: 0,
    historyAppended: 0,
    baselineInitialized: 0
  })
  assert.strictEqual(
    clients.tableRecords['tbl-rented'].length - rentedBeforePartial,
    3,
    '全新 run 完成后已出租表仍只能保留原 3 条前缀'
  )
  assert.strictEqual(
    clients.tableRecords['tbl-history'].length - historyBeforePartial,
    10,
    '全新 run 完成后状态流水仍只能保留原 10 条前缀'
  )
}

async function testDeactivateFuseBlocksAllThreeWrites() {
  const first = sourceRecord('source-fuse-1', '301')
  const second = sourceRecord('source-fuse-2', '302')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([first, second])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))
  clients.calls.length = 0
  clients.setSourceSnapshot(sourceSnapshotOf([second]))
  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
      dryRun: false
    })),
    /超过安全阈值|阻断/,
    '撤下比例超过阈值时必须在第一笔生命周期写入前熔断'
  )
  assertNoWrites(clients.calls, '熔断时当前表、已出租表和流水表必须全部零写')
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 0, '熔断不得抢先写入出租周期')
  assert.strictEqual(
    clients.tableRecords['tbl-history'].filter((record) => (
      record.fields.toLifecycleStatusText === '已出租'
    )).length,
    0,
    '熔断不得抢先写入已出租流水'
  )
}

async function testFoundationFuseUsesStablePhysicalIdentityAcrossSourceRecordRotation() {
  const currentSourceRecords = Array.from({ length: 12 }, (_, index) => (
    sourceRecord(`source-rotation-current-${index + 1}`, String(501 + index))
  ))
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf(currentSourceRecords)
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))

  assert.strictEqual(
    typeof feishuSync._internal.activeFeishuFoundationIdentityKeys,
    'function',
    'AI 数据底座必须导出线上库存稳定物理身份基线'
  )
  const currentRecords = clone(clients.tableRecords['tbl-mini'])
  const baselineListings = currentRecords.map((record, index) => {
    const fields = record.fields || {}
    return {
      externalSource: 'feishu',
      lifecycleStatus: 'active',
      status: '在租',
      feishuRecordId: `source-rotation-old-inventory-${index + 1}`,
      city: fields.city,
      district: fields.district,
      area: fields.district,
      block: fields.block,
      community: fields.community,
      building: fields.building,
      unit: fields.unit,
      roomNumber: fields.roomNumber,
      rentMode: fields.rentMode
    }
  })
  const baselineIdentityKeys = feishuSync._internal.activeFeishuFoundationIdentityKeys({
    listings: baselineListings
  })
  assert.strictEqual(
    baselineIdentityKeys.length,
    12,
    '线上库存第二基线必须为每个物理房间生成一个稳定身份'
  )
  const legacyIdentityClients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf(currentSourceRecords),
    miniRecords: currentRecords.map((record, index) => ({
      ...clone(record),
      fields: {
        ...clone(record.fields),
        foundationListingId: '',
        temporaryListingId: '',
        identityType: '',
        physicalUnitKey: `UNIT-LEGACY-${String(index + 1).padStart(4, '0')}`
      }
    })),
    historyRecords: clone(clients.tableRecords['tbl-history'])
  })
  const legacyIdentityUpgrade = await feishuSync._internal.executeMirrorTableSync(
    executeOptions(legacyIdentityClients, {
      dryRun: true,
      baselinePublishedSourceIds: baselineListings.map((listing) => listing.feishuRecordId),
      baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
    })
  )
  assert.strictEqual(
    legacyIdentityUpgrade.counts.deactivate,
    0,
    '旧主档缺少底座 ID 时，规范化身份升级不得误算为批量撤下'
  )
  assert.strictEqual(
    legacyIdentityUpgrade.counts.update,
    12,
    '旧主档补齐底座 ID 与新版物理键必须形成持久化更新，不能只在内存中规范化'
  )
  assert.strictEqual(
    new Set(legacyIdentityUpgrade.records.map((record) => (
      record.fields.foundationListingId
    ))).size,
    12,
    '旧主档身份升级后必须得到十二个唯一且稳定的底座房源 ID'
  )
  assertNoWrites(
    legacyIdentityClients.calls,
    '旧主档身份升级预演必须保持员工源和三张目标业务表零写'
  )
  const legacyIdentityApplied = await feishuSync._internal.executeMirrorTableSync(
    executeOptions(legacyIdentityClients, {
      dryRun: false,
      baselinePublishedSourceIds: baselineListings.map((listing) => listing.feishuRecordId),
      baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
    })
  )
  assert.strictEqual(legacyIdentityApplied.status, 'success', '旧主档身份升级必须完整写回并通过回读')
  const persistedLegacyFields = legacyIdentityClients.tableRecords['tbl-mini']
    .map((record) => record.fields)
  assert.strictEqual(
    new Set(persistedLegacyFields.map((fields) => fields.foundationListingId)).size,
    12,
    '正式升级后目标主档必须持久化十二个唯一底座房源 ID'
  )
  assert.ok(
    persistedLegacyFields.every((fields) => (
      fields.physicalUnitKey.startsWith('UNIT-') &&
      !fields.physicalUnitKey.startsWith('UNIT-LEGACY-')
    )),
    '正式升级后目标主档必须持久化新版物理键'
  )
  legacyIdentityClients.calls.length = 0
  const legacyIdentityReadback = await feishuSync._internal.executeMirrorTableSync(
    executeOptions(legacyIdentityClients, {
      dryRun: true,
      baselinePublishedSourceIds: baselineListings.map((listing) => listing.feishuRecordId),
      baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
    })
  )
  assert.strictEqual(legacyIdentityReadback.counts.update, 0, '身份升级回读后不得重复更新')
  assert.strictEqual(legacyIdentityReadback.counts.noop, 12, '身份升级回读后十二条主档必须全部幂等')
  assertNoWrites(legacyIdentityClients.calls, '身份升级回读预演必须保持四表零写')
  const retaggedBaselineIdentityKeys = feishuSync._internal.activeFeishuFoundationIdentityKeys({
    listings: baselineListings.map((listing) => ({
      ...listing,
      district: '新行政区',
      area: '新行政区',
      block: '新板块'
    }))
  })
  assert.deepStrictEqual(
    retaggedBaselineIdentityKeys,
    baselineIdentityKeys,
    '行政区和板块是可变分类，不能改变同一物理房间的稳定身份'
  )
  ;[
    ['city', '宁波市', '城市'],
    ['community', '另一小区', '小区'],
    ['building', '99', '楼栋'],
    ['unit', '9', '单元'],
    ['roomNumber', '999', '房号'],
    ['rentMode', '合租', '出租方式']
  ].forEach(([field, changedValue, label]) => {
    assert.notDeepStrictEqual(
      feishuSync._internal.activeFeishuFoundationIdentityKeys({
        listings: baselineListings.map((listing, index) => (
          index === 0 ? { ...listing, [field]: changedValue } : listing
        ))
      }),
      baselineIdentityKeys,
      `${label}发生变化时必须改变物理房间身份，不能从稳定物理键中漏掉该轴`
    )
  })
  assert.strictEqual(
    typeof feishuSync._internal.assertMirrorDeactivateSafety,
    'function',
    '测试必须能直接验证正式写前的撤下熔断'
  )
  const duplicateEntityRecord = {
    ...clone(currentRecords[1]),
    recordId: 'duplicate-foundation-entity',
    fields: {
      ...clone(currentRecords[1].fields),
      foundationListingId: currentRecords[0].fields.foundationListingId.toLocaleLowerCase('zh-CN')
    }
  }
  assert.throws(
    () => feishuSync._internal.assertMirrorDeactivateSafety(
      { records: [currentRecords[0], duplicateEntityRecord] },
      [currentRecords[0]],
      { foundationIdentityMode: true }
    ),
    /重复实体身份/,
    '同步前目标主档出现重复底座实体时必须在熔断计算前失败关闭'
  )
  assert.throws(
    () => feishuSync._internal.assertMirrorDeactivateSafety(
      { records: [currentRecords[0]] },
      [currentRecords[0], duplicateEntityRecord],
      { foundationIdentityMode: true }
    ),
    /重复实体身份/,
    '计划结果出现重复底座实体时必须在熔断计算前失败关闭'
  )
  assert.doesNotThrow(
    () => feishuSync._internal.assertMirrorDeactivateSafety(
      { records: currentRecords },
      currentRecords.map((record, index) => ({
        ...clone(record),
        fields: {
          ...clone(record.fields),
          district: '新行政区',
          block: '新板块',
          community: `修正后小区-${index + 1}`
        }
      })),
      {
        foundationIdentityMode: true,
        baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
      }
    ),
    '同一 foundationListingId 只发生分类或地址展示修正时不得误算为整批撤下'
  )
  assert.throws(
    () => feishuSync._internal.assertMirrorDeactivateSafety(
      { records: [] },
      currentRecords,
      {
        foundationIdentityMode: true,
        baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
      }
    ),
    /拟撤下 12\/12 条公开房源.*超过安全阈值/,
    '目标主档被清空或重建时，即使计划数量与线上库存相同也不得绕过第二基线'
  )
  const replacedEntityRecords = currentRecords.map((record, index) => ({
    ...clone(record),
    recordId: `replaced-foundation-entity-${index + 1}`,
    fields: {
      ...clone(record.fields),
      foundationListingId: `REPLACED-FOUNDATION-${index + 1}`
    }
  }))
  assert.throws(
    () => feishuSync._internal.assertMirrorDeactivateSafety(
      { records: currentRecords },
      replacedEntityRecords,
      {
        foundationIdentityMode: true,
        baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
      }
    ),
    /拟撤下 12\/12 条公开房源.*超过安全阈值/,
    '计划数量不变但全部 foundation 实体被替换时，必须由目标主档实体差集精确阻断 12/12'
  )
  assert.throws(
    () => feishuSync._internal.assertMirrorDeactivateSafety(
      { records: currentRecords.slice(0, 8) },
      currentRecords.slice(0, 7),
      {
        foundationIdentityMode: true,
        baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
      }
    ),
    /拟撤下 5\/12 条公开房源.*超过安全阈值/,
    '目标主档撤下一条且 DB 基线覆盖缺口为五条时，必须由最终数量下限精确阻断 5/12'
  )
  assert.throws(
    () => feishuSync._internal.assertMirrorDeactivateSafety(
      { records: [currentRecords[0]] },
      [currentRecords[0]],
      {
        foundationIdentityMode: true,
        baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
      }
    ),
    /拟撤下 11\/12 条公开房源.*超过安全阈值/,
    '线上库存十二条稳定身份而计划只剩一条时必须精确按 11/12 阻断'
  )

  const foundationIdsBefore = currentRecords
    .map((record) => record.fields.foundationListingId)
    .sort()
  clients.calls.length = 0
  const rotated = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: true,
    baselinePublishedSourceIds: baselineListings.map((listing) => listing.feishuRecordId),
    baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
  }))
  assert.strictEqual(rotated.counts.deactivate, 0, '仅线上旧库存保留上一张源表 record_id 时不得误判为真实撤下')
  assert.strictEqual(rotated.counts.noop, 12, '当前专用表与员工源一致时必须保持十二条 no-op')
  assert.strictEqual(rotated.lifecycleCounts.rentedArchived, 0, '旧库存 record_id 轮换不得生成虚假已出租归档')
  assert.strictEqual(rotated.lifecycleCounts.historyAppended, 0, '旧库存 record_id 轮换不得生成虚假生命周期流水')
  assert.deepStrictEqual(
    rotated.records.map((record) => record.fields.foundationListingId).sort(),
    foundationIdsBefore,
    '旧库存 record_id 全量轮换后必须沿用同一批底座房源身份'
  )
  assertNoWrites(clients.calls, 'record_id 轮换预演必须保持员工源和三张目标业务表零写')

  const migratedSourceRecords = currentSourceRecords.map((record, index) => ({
    ...clone(record),
    recordId: `source-rotation-migrated-${index + 1}`
  }))
  const migratedClients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf(migratedSourceRecords),
    miniRecords: currentRecords.map((record, index) => ({
      ...clone(record),
      fields: {
        ...clone(record.fields),
        district: '旧行政区',
        block: '旧板块',
        physicalUnitKey: `UNIT-LEGACY-${String(index + 1).padStart(4, '0')}`
      }
    })),
    historyRecords: clone(clients.tableRecords['tbl-history'])
  })
  const migrated = await feishuSync._internal.executeMirrorTableSync(executeOptions(migratedClients, {
    dryRun: true,
    baselinePublishedSourceIds: baselineListings.map((listing) => listing.feishuRecordId),
    baselinePublishedFoundationIdentityKeys: retaggedBaselineIdentityKeys
  }))
  assert.strictEqual(migrated.baseline, false, 'recordId 迁移回归必须在已完成持久基线后执行')
  assert.strictEqual(migrated.counts.create, 0, '源表复制且区域板块改名时不得为原房间新建第二个底座实体')
  assert.strictEqual(migrated.counts.deactivate, 0, '源表复制且区域板块改名时不得把原房间误归档')
  assert.strictEqual(migrated.lifecycleCounts.rentedArchived, 0, '源表 recordId 轮换不得制造虚假已出租周期')
  assert.strictEqual(migrated.lifecycleCounts.historyAppended, 0, '源表 recordId 轮换不得制造虚假生命周期流水')
  assert.deepStrictEqual(
    migrated.records.map((record) => record.fields.foundationListingId).sort(),
    foundationIdsBefore,
    '旧版物理键必须按当前房间字段升级，并在源记录轮换后继续沿用原底座实体'
  )
  const lifecycleBefore = currentRecords
    .map((record) => ({
      foundationListingId: record.fields.foundationListingId,
      availabilityCycleNo: record.fields.availabilityCycleNo,
      availabilityCycleId: record.fields.availabilityCycleId,
      lifecycleVersion: record.fields.lifecycleVersion,
      sourceCreatedAt: record.fields.sourceCreatedAt
    }))
    .sort((left, right) => left.foundationListingId.localeCompare(right.foundationListingId))
  const lifecycleAfter = migrated.records
    .map((record) => ({
      foundationListingId: record.fields.foundationListingId,
      availabilityCycleNo: record.fields.availabilityCycleNo,
      availabilityCycleId: record.fields.availabilityCycleId,
      lifecycleVersion: record.fields.lifecycleVersion,
      sourceCreatedAt: record.fields.sourceCreatedAt
    }))
    .sort((left, right) => left.foundationListingId.localeCompare(right.foundationListingId))
  assert.deepStrictEqual(
    lifecycleAfter,
    lifecycleBefore,
    '源表复制只允许更新来源追溯键，不得重置待租计时、周期或生命周期版本'
  )
  assertNoWrites(migratedClients.calls, '区域板块改名与源记录轮换预演必须保持四表零写')

  const incompleteMirrorClients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([currentSourceRecords[0]]),
    miniRecords: [currentRecords[0]]
  })
  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync(executeOptions(incompleteMirrorClients, {
      dryRun: true,
      baselinePublishedSourceIds: [],
      baselinePublishedFoundationIdentityKeys: baselineIdentityKeys
    })),
    /拟撤下 11\/12 条公开房源.*超过安全阈值|阻断/,
    '即使目标主表只剩一条，线上库存额外 11 条稳定身份第二基线仍必须阻断真实异常缩量'
  )
  assertNoWrites(
    incompleteMirrorClients.calls,
    '稳定身份第二基线触发熔断后，员工源和三张目标业务表必须全部零写'
  )
}

async function testTargetIdentityAndResponsibilityEnrichmentIsPreserved() {
  const sourceRow = sourceRecord('source-enrichment-1', '401')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([sourceRow])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))
  const current = clients.tableRecords['tbl-mini'][0]
  const stableFoundationId = current.fields.foundationListingId
  assert.ok(stableFoundationId.startsWith('TMP-'), '首次缺少寓小二 ID 必须使用临时底座 ID')
  Object.assign(current.fields, {
    yuxiaoerListingId: 'YX2-LISTING-SYNTHETIC',
    yuxiaoerRoomId: '',
    listingOwner: '合成负责人',
    ownerDepartment: '合成部门'
  })

  clients.setSourceSnapshot(sourceSnapshotOf([
    sourceRecord('source-enrichment-1', '401', { viewingMethod: '月底空出，看房提前联系' })
  ]))
  const updated = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))
  const fields = clients.tableRecords['tbl-mini'][0].fields
  assert.strictEqual(fields.foundationListingId, stableFoundationId, '补入真实 ID 后不得更换底座 ID')
  assert.strictEqual(fields.temporaryListingId, stableFoundationId, '原临时 ID 必须保留为历史别名')
  assert.strictEqual(fields.identityType, 'yuxiaoer', '补入真实 ID 后身份类型必须升级')
  assert.strictEqual(fields.yuxiaoerListingId, 'YX2-LISTING-SYNTHETIC', '真实房源 ID 必须保留')
  assert.strictEqual(fields.listingOwner, '合成负责人', '房源负责人必须保留在内部主档')
  assert.strictEqual(fields.ownerDepartment, '合成部门', '所属部门必须保留在内部主档')
  assert.strictEqual(fields.lifecycleStatusText, '即将空出', '员工源备注变化仍必须更新规范房态')
  const publicJson = JSON.stringify(
    feishuSync._internal.canonicalMirrorRecordToSyncRow(updated.records[0], 0)
  )
  ;['YX2-LISTING-SYNTHETIC', '合成负责人', '合成部门'].forEach((privateValue) => {
    assert.strictEqual(
      publicJson.includes(privateValue),
      false,
      `身份和责任字段更新后的公开库存投影不得出现 ${privateValue}`
    )
  })
}

async function testFirstApplyCreatesPersistentBaselineWithoutHistoricalRental() {
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([sourceRecord('source-baseline-current', '502')]),
    miniRecords: [
      legacyMiniRecord('legacy-missing-record', 'source-baseline-missing', '501')
    ]
  })
  const result = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    allowMassDeactivate: true
  }))

  assert.strictEqual(result.status, 'success-baseline', '首次正式同步必须显式返回基线初始化状态')
  assert.strictEqual(result.baseline, true, '首次正式同步必须暴露本轮处于初始化基线')
  assert.deepStrictEqual(
    result.lifecycleCounts,
    { rentedArchived: 0, historyAppended: 0, baselineInitialized: 1 },
    '初始化基线不得追认历史已出租或制造业务流水'
  )
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 0, '基线外旧记录不得写入已出租表')
  const history = clients.tableRecords['tbl-history'].map((record) => record.fields)
  assert.strictEqual(
    history.filter((fields) => fields.eventType === '初始化基线').length,
    1,
    '基线成功后必须持久化且只持久化一个初始化标记'
  )
  const baselineHistoryCreate = clients.calls
    .filter((call) => call.client === 'target' && call.action === 'create' && call.tableId === 'tbl-history')
    .flatMap((call) => call.records || [])
    .find((record) => record.fields && record.fields.eventType === '初始化基线')
  assert.ok(baselineHistoryCreate, '初始化基线必须经过真实流水创建载荷写入')
  ;['sourceRecordId', 'fromLifecycleStatusText', 'listingOwner', 'ownerDepartment'].forEach((semantic) => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(baselineHistoryCreate.fields, semantic),
      true,
      `生命周期流水的明确空前态 ${semantic} 不得按新增主档规则省略`
    )
    assert.strictEqual(
      baselineHistoryCreate.fields[semantic],
      '',
      `生命周期流水的明确空前态 ${semantic} 必须按字段类型写为空文本`
    )
  })
  assert.strictEqual(
    history.some((fields) => fields.eventType === '检测已出租'),
    false,
    '初始化时不得把首次观察前消失的旧记录追认为已出租'
  )
  const historical = clients.tableRecords['tbl-mini'].find((record) => (
    record.recordId === 'legacy-missing-record'
  ))
  assert.strictEqual(historical.fields.sourcePresent, false, '基线外旧记录必须停止充当当前源记录')
  assert.strictEqual(historical.fields.published, false, '基线外旧记录必须停止公开')
  assert.strictEqual(historical.fields.enabled, false, '基线外旧记录必须软停用')

  const repeat = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    allowMassDeactivate: true
  }))
  assert.strictEqual(repeat.baseline, false, '持久基线标记存在后不得重复进入初始化模式')
  assert.strictEqual(
    clients.tableRecords['tbl-history'].filter((record) => (
      record.fields.eventType === '初始化基线'
    )).length,
    1,
    '重跑不得重复创建初始化基线标记'
  )
}

async function testUncertainCreateReusesStableTokenAcrossRun() {
  const first = sourceRecord('source-uncertain-1', '601')
  const second = sourceRecord('source-uncertain-2', '602')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([first, second])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))

  clients.calls.length = 0
  clients.setSourceSnapshot(sourceSnapshotOf([second]))
  clients.armUncertainCreate('tbl-rented')
  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
      dryRun: false,
      maxDeactivateRatio: 0.75
    })),
    /结果不确定/,
    '服务端已落盘但客户端收到不确定结果时必须停止本轮'
  )
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 1, '不确定结果前服务端已真实落盘一条归档')

  const recovered = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  assert.strictEqual(recovered.status, 'success', '跨进程语义重跑必须安全收敛')
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 1, '重跑不得形成重复归档行')
  const createCalls = clients.calls.filter((call) => (
    call.action === 'create' && call.tableId === 'tbl-rented'
  ))
  assert.strictEqual(createCalls.length, 2, '不确定创建与恢复重跑应各发起一次同业务请求')
  assert.strictEqual(
    createCalls[0].clientToken,
    createCalls[1].clientToken,
    '同一目标表和归档业务键跨进程重跑必须使用同一个 client_token'
  )
}

async function testRepeatedSameDirectionTransitionsKeepDistinctHistory() {
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([sourceRecord('source-history-loop', '701')])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))

  for (const viewingMethod of ['月底空出，看房提前联系', '', '再次月底空出，看房提前联系', '']) {
    clients.setSourceSnapshot(sourceSnapshotOf([
      sourceRecord('source-history-loop', '701', { viewingMethod })
    ]))
    const result = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
      dryRun: false
    }))
    assert.strictEqual(result.lifecycleCounts.historyAppended, 1, '每次真实房态变化都必须追加一条流水')
  }

  const statusChanges = clients.tableRecords['tbl-history']
    .map((record) => record.fields)
    .filter((fields) => fields.eventType === '房态变化')
  assert.strictEqual(statusChanges.length, 4, '同一周期内四次往返必须完整保留四条房态流水')
  assert.strictEqual(
    new Set(statusChanges.map((fields) => fields.historyEventId)).size,
    4,
    '相同方向第二次发生时必须使用新的稳定事件 ID'
  )
  assert.deepStrictEqual(
    statusChanges.map((fields) => fields.lifecycleVersion),
    [2, 3, 4, 5],
    '流水必须携带单调递增且可重试的生命周期版本'
  )

  const countBeforeRepeat = clients.tableRecords['tbl-history'].length
  const repeat = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))
  assert.strictEqual(repeat.lifecycleCounts.historyAppended, 0, '相同房态原样重跑不得新增流水')
  assert.strictEqual(clients.tableRecords['tbl-history'].length, countBeforeRepeat, '原样重跑必须保持流水数量')
}

async function testRentedReappearanceClosesOldCycleBeforeOpeningNewCycle() {
  const oldSource = sourceRecord('source-replaced-old', '801')
  const newSource = sourceRecord('source-replaced-new', '801', {
    remark: '真正出租后重新进入员工待租源表'
  })
  const keeper = sourceRecord('source-replaced-keeper', '802')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([oldSource, keeper])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))

  const historyCountBefore = clients.tableRecords['tbl-history'].length
  clients.setSourceSnapshot(sourceSnapshotOf([keeper]))
  const rented = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  assert.strictEqual(rented.lifecycleCounts.rentedArchived, 1, '完整快照真实消失必须冻结旧待租周期')
  assert.strictEqual(rented.lifecycleCounts.historyAppended, 1, '完整快照真实消失必须写入旧周期关闭流水')

  clients.setSourceSnapshot(sourceSnapshotOf([newSource, keeper]))
  const result = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75,
    nowMs: FIXED_NOW_MS + 1_000
  }))
  assert.strictEqual(result.lifecycleCounts.rentedArchived, 0, '重新出现时不得重复归档已经关闭的旧周期')
  assert.strictEqual(result.lifecycleCounts.historyAppended, 1, '重新出现必须只追加一条新周期进入流水')

  const events = clients.tableRecords['tbl-history']
    .slice(historyCountBefore)
    .map((record) => record.fields)
  assert.deepStrictEqual(
    events.map((fields) => fields.eventType),
    ['检测已出租', '重新进入待租'],
    '房源必须先在完整快照中真实消失关闭旧周期，随后重新出现才开启新周期'
  )
  assert.deepStrictEqual(
    events.map((fields) => fields.availabilityCycleNo),
    [1, 2],
    '真实出租与重新上架的两条流水必须分别属于旧周期和新周期'
  )
  assert.deepStrictEqual(
    events.map((fields) => fields.lifecycleVersion),
    [2, 3],
    '真实出租与重新上架必须把生命周期版本从关闭版本单调推进到恢复版本'
  )
  assert.ok(
    Number(events[0].eventAt) < Number(events[1].eventAt),
    '旧周期关闭与新周期开启必须有严格可排序的事件时间'
  )
}

async function testRentedReappearanceRecoversWhenArchiveSucceededBeforeHistory() {
  const oldSource = sourceRecord('source-archive-only-old', '851')
  const newSource = sourceRecord('source-archive-only-new', '851')
  const keeper = sourceRecord('source-archive-only-keeper', '852')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([oldSource, keeper])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  clients.setSourceSnapshot(sourceSnapshotOf([keeper]))
  clients.failNextCreate('tbl-history')
  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
      dryRun: false,
      maxDeactivateRatio: 0.75
    })),
    /目标表新增失败/,
    '旧周期归档落盘后流水首写失败必须停止且保持当前主档不变'
  )
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 1, '失败窗口中旧周期归档已经唯一落盘')
  assert.strictEqual(
    clients.tableRecords['tbl-history'].filter((record) => (
      record.fields.eventType !== '初始化基线'
    )).length,
    0,
    '流水首写失败时不得伪造任何业务事件'
  )

  clients.setSourceSnapshot(sourceSnapshotOf([newSource, keeper]))
  const recovered = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  assert.strictEqual(recovered.status, 'success', '归档已存在且房源重新出现时必须补齐关闭、恢复流水和当前主档')
  assert.strictEqual(clients.tableRecords['tbl-rented'].length, 1, '重跑不得重复归档旧周期')
  const businessEvents = clients.tableRecords['tbl-history']
    .map((record) => record.fields)
    .filter((fields) => fields.eventType !== '初始化基线')
  assert.deepStrictEqual(
    businessEvents.map((fields) => fields.eventType),
    ['检测已出租', '重新进入待租'],
    'archive-only 失败窗口遇到房源重新出现时，必须从归档证据重建旧周期关闭流水，再补新周期进入流水'
  )
  assert.deepStrictEqual(
    businessEvents.map((fields) => fields.lifecycleVersion),
    [2, 3],
    '当前主档仍停在旧版本时，必须以已落盘归档版本为基数恢复到下一版本'
  )
  assert.ok(
    Number(businessEvents[0].eventAt) < Number(businessEvents[1].eventAt),
    '失败恢复后的旧周期关闭与新周期开启仍必须严格可排序'
  )
}

async function testRentedReappearanceRecoversWhenRestoreHistoryFails() {
  const oldSource = sourceRecord('source-old-history-written', '861')
  const newSource = sourceRecord('source-new-history-pending', '861')
  const keeper = sourceRecord('source-history-keeper', '862')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([oldSource, keeper])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  clients.setSourceSnapshot(sourceSnapshotOf([keeper]))
  clients.failNextMiniUpdate()
  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
      dryRun: false,
      maxDeactivateRatio: 0.75
    })),
    /当前状态更新失败/,
    '归档和关闭流水成功但当前主档失败时必须保留可恢复证据'
  )
  const afterDeactivateFailure = clients.tableRecords['tbl-history']
    .map((record) => record.fields)
    .filter((fields) => fields.eventType !== '初始化基线')
  assert.deepStrictEqual(
    afterDeactivateFailure.map((fields) => fields.eventType),
    ['检测已出租'],
    '当前主档失败时只能先保留已落盘的旧周期关闭事件'
  )

  clients.setSourceSnapshot(sourceSnapshotOf([newSource, keeper]))
  clients.failNextCreate('tbl-history')
  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
      dryRun: false,
      maxDeactivateRatio: 0.75
    })),
    /目标表新增失败/,
    '恢复流水失败时必须停止且不得提前把当前主档切入新周期'
  )
  const currentBeforeRetry = clients.tableRecords['tbl-mini']
    .find((record) => record.fields.roomNumber === '861')
  assert.strictEqual(currentBeforeRetry.fields.availabilityCycleNo, 1, '恢复流水失败时当前主档必须仍停在旧周期')

  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false,
    maxDeactivateRatio: 0.75
  }))
  const recovered = clients.tableRecords['tbl-history']
    .map((record) => record.fields)
    .filter((fields) => fields.eventType !== '初始化基线')
  assert.deepStrictEqual(
    recovered.map((fields) => fields.eventType),
    ['检测已出租', '重新进入待租'],
    '重跑必须识别归档与旧周期流水已存在，只补缺失的新周期进入事件'
  )
  assert.deepStrictEqual(
    recovered.map((fields) => fields.lifecycleVersion),
    [2, 3],
    '恢复失败重试不得重复或回退生命周期版本'
  )
  assert.ok(
    Number(recovered[0].eventAt) < Number(recovered[1].eventAt),
    '第二条流水失败恢复后仍必须保持严格事件顺序'
  )
}

async function testArchiveUsesFrozenEventIdentityAndExplicitEmptyPreviousStatus() {
  const sourceRow = sourceRecord('source-partial-recovery', '901')
  const clients = makeLifecycleClients({
    sourceSnapshot: sourceSnapshotOf([sourceRow])
  })
  await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))
  const current = clients.tableRecords['tbl-mini'][0].fields
  current.identityAliases = ''
  current.lifecycleStatusText = '已出租'
  current.listingStatus = '已出租'
  current.sourcePresent = false
  current.published = false
  current.enabled = false

  const result = await feishuSync._internal.executeMirrorTableSync(executeOptions(clients, {
    dryRun: false
  }))
  assert.strictEqual(result.lifecycleCounts.rentedArchived, 1, '缺归档的已出租当前状态必须在恢复前补齐周期快照')
  const archived = clients.tableRecords['tbl-rented'][0].fields
  assert.strictEqual(
    archived.previousLifecycleStatusText,
    '',
    '生命周期事件明确给出空前态时，归档不得回退成“已出租”'
  )
  const aliases = JSON.parse(archived.identityAliases)
  assert.ok(
    aliases.some((item) => (
      item.aliasType === 'sourceRecord' &&
      item.aliasValue === sourceRow.recordId
    )),
    '归档必须优先冻结事件已重建的身份别名，不能永久保存当前表的空别名'
  )
}

function testArchiveProjectionPrioritizesEveryFrozenEventField() {
  const eventAliases = JSON.stringify([
    { aliasType: 'sourceRecord', aliasValue: 'event-source' },
    { aliasType: 'temporary', aliasValue: 'TMP-EVENT' },
    { aliasType: 'yuxiaoer', aliasValue: 'YX2:EVENT-LISTING:EVENT-ROOM' }
  ])
  const archived = feishuSync._internal.foundationArchiveFields({
    rentalEventId: 'FOUNDATION-EVENT:rented:4',
    foundationListingId: 'FOUNDATION-EVENT',
    fields: {
      temporaryListingId: 'TMP-EVENT',
      yuxiaoerListingId: 'EVENT-LISTING',
      yuxiaoerRoomId: 'EVENT-ROOM',
      identityType: 'yuxiaoer',
      physicalUnitKey: 'UNIT-EVENT',
      sourceRecordId: 'event-source',
      availabilityCycleNo: 4,
      availabilityCycleId: 'FOUNDATION-EVENT:available:4',
      previousLifecycleStatusText: '',
      vacancyNote: '事件冻结的空出备注',
      sourceCreatedAt: 1234567890,
      metricKind: '提前挂出天数',
      elapsedDaysAtExit: 9,
      listingOwner: '事件负责人',
      ownerDepartment: '事件部门',
      identityAliases: eventAliases,
      lifecycleVersion: 8
    }
  }, {
    temporaryListingId: 'TMP-CURRENT',
    yuxiaoerListingId: 'CURRENT-LISTING',
    yuxiaoerRoomId: 'CURRENT-ROOM',
    identityType: 'temporary',
    physicalUnitKey: 'UNIT-CURRENT',
    sourceRecordId: 'current-source',
    availabilityCycleNo: 99,
    availabilityCycleId: 'CURRENT:available:99',
    lifecycleStatusText: '已出租',
    vacancyNote: '当前备注',
    sourceCreatedAt: 9876543210,
    metricKind: '待租天数',
    lifecycleDays: 88,
    listingOwner: '当前负责人',
    ownerDepartment: '当前部门',
    identityAliases: '[]',
    lifecycleVersion: 99,
    community: '当前业务快照小区',
    listingStatus: '待出租',
    published: true,
    enabled: true,
    sourcePresent: true
  }, FIXED_NOW_MS)
  assert.deepStrictEqual(
    {
      temporaryListingId: archived.temporaryListingId,
      yuxiaoerListingId: archived.yuxiaoerListingId,
      yuxiaoerRoomId: archived.yuxiaoerRoomId,
      identityType: archived.identityType,
      physicalUnitKey: archived.physicalUnitKey,
      sourceRecordId: archived.sourceRecordId,
      availabilityCycleNo: archived.availabilityCycleNo,
      availabilityCycleId: archived.availabilityCycleId,
      previousLifecycleStatusText: archived.previousLifecycleStatusText,
      vacancyNote: archived.vacancyNote,
      sourceCreatedAt: archived.sourceCreatedAt,
      metricKind: archived.metricKind,
      lifecycleDays: archived.lifecycleDays,
      listingOwner: archived.listingOwner,
      ownerDepartment: archived.ownerDepartment,
      identityAliases: archived.identityAliases,
      lifecycleVersion: archived.lifecycleVersion
    },
    {
      temporaryListingId: 'TMP-EVENT',
      yuxiaoerListingId: 'EVENT-LISTING',
      yuxiaoerRoomId: 'EVENT-ROOM',
      identityType: 'yuxiaoer',
      physicalUnitKey: 'UNIT-EVENT',
      sourceRecordId: 'event-source',
      availabilityCycleNo: 4,
      availabilityCycleId: 'FOUNDATION-EVENT:available:4',
      previousLifecycleStatusText: '',
      vacancyNote: '事件冻结的空出备注',
      sourceCreatedAt: 1234567890,
      metricKind: '提前挂出天数',
      lifecycleDays: 9,
      listingOwner: '事件负责人',
      ownerDepartment: '事件部门',
      identityAliases: eventAliases,
      lifecycleVersion: 8
    },
    '归档的全部身份与生命周期字段必须优先冻结事件值，不能被当前主档覆盖'
  )
  assert.strictEqual(archived.community, '当前业务快照小区', '位置等业务快照仍必须冻结当期当前主档')
  assert.strictEqual(archived.listingStatus, '已出租', '归档必须强制标记已出租')
  assert.strictEqual(archived.published, false, '归档必须强制关闭公开展示')
  assert.strictEqual(archived.enabled, false, '归档必须强制停用')
  assert.strictEqual(archived.sourcePresent, false, '归档必须强制标记源表已不存在')
}

function testCompatibilityDigestUsesOnlyEffectiveRows() {
  const bindings = sourceBindings()
  const catalog = buildLocationCatalog(locationSnapshot().records.map((record) => ({
    recordId: record.recordId,
    ...record.fields
  })))
  const validRecord = sourceRecord('source-effective-digest', '901')
  const emptyTemplate = {
    recordId: 'source-empty-template',
    createdTimeMs: SOURCE_CREATED_TIME_MS,
    fields: {}
  }
  const firstRaw = sourceSnapshotOf([validRecord, emptyTemplate])
  firstRaw.digest = 'a'.repeat(64)
  const secondRaw = sourceSnapshotOf([emptyTemplate, validRecord])
  secondRaw.digest = 'b'.repeat(64)

  const firstPrepared = prepareSourceSnapshotForCompatibility(firstRaw, {
    profile: PROFILE,
    sourceBindings: bindings,
    locationCatalog: catalog
  })
  const secondPrepared = prepareSourceSnapshotForCompatibility(secondRaw, {
    profile: PROFILE,
    sourceBindings: bindings,
    locationCatalog: catalog
  })
  assert.strictEqual(firstPrepared.recordCount, 1)
  assert.strictEqual(secondPrepared.recordCount, 1)
  assert.match(firstPrepared.digest, /^[0-9a-f]{64}$/)
  assert.strictEqual(
    firstPrepared.digest,
    secondPrepared.digest,
    '被兼容层过滤的空模板及飞书返回顺序不得改变有效源表摘要'
  )

  const changedRaw = sourceSnapshotOf([
    sourceRecord('source-effective-digest', '901', { monthlyRent: 3300 })
  ])
  changedRaw.digest = firstRaw.digest
  const changedPrepared = prepareSourceSnapshotForCompatibility(changedRaw, {
    profile: PROFILE,
    sourceBindings: bindings,
    locationCatalog: catalog
  })
  assert.notStrictEqual(
    changedPrepared.digest,
    firstPrepared.digest,
    '真实有效字段变化必须改变兼容层摘要，不能沿用原始快照旧摘要'
  )
}

function testLifecycleHistoryPlanIsCanonicalAcrossOperationOrder() {
  const currentRecords = ['A', 'B'].map((suffix) => ({
    recordId: `current-history-${suffix}`,
    fields: {
      foundationListingId: `TMP-HISTORY-${suffix}`,
      sourceRecordId: `source-history-${suffix}`,
      lifecycleStatusText: '待出租',
      availabilityCycleNo: 1,
      availabilityCycleId: `TMP-HISTORY-${suffix}:available:1`,
      listingOwner: '原负责人',
      ownerDepartment: '原部门',
      lifecycleVersion: 1
    }
  }))
  const currentOperations = currentRecords.map((record) => ({
    type: 'update',
    recordId: record.recordId,
    foundationListingId: record.fields.foundationListingId,
    sourceRecordId: record.fields.sourceRecordId,
    fields: {
      ...clone(record.fields),
      listingOwner: `新负责人-${record.fields.foundationListingId}`,
      ownerDepartment: '新部门',
      lifecycleVersion: 2
    }
  }))
  const current = snapshot(currentRecords)
  const forward = feishuSync._internal.lifecycleHistoryOperations(
    current,
    currentOperations,
    snapshot([]),
    'canonical-history-run',
    FIXED_NOW_MS
  )
  const reversed = feishuSync._internal.lifecycleHistoryOperations(
    current,
    [...currentOperations].reverse(),
    snapshot([]),
    'canonical-history-run',
    FIXED_NOW_MS
  )
  assert.deepStrictEqual(
    reversed,
    forward,
    '同一组状态事件只改变飞书返回顺序时，流水计划及 eventAt 必须完全一致'
  )

  const digestInput = (historyOperations) => feishuSync._internal.buildMirrorSafetyDigests({
    sourceSnapshot: snapshot([]),
    locationSnapshot: snapshot([]),
    mirrorSnapshot: snapshot([]),
    plannedRecords: [],
    operations: [],
    archiveOperations: [],
    historyOperations,
    resources: {}
  }).mirrorPlanSha256
  assert.strictEqual(
    digestInput(reversed),
    digestInput(forward),
    '事件集合相同且仅输入顺序不同时，镜像计划摘要必须稳定'
  )
}

function testRentedReappearanceHistoryKeepsOrderAfterPartialRetry() {
  const currentSnapshot = snapshot([{
    recordId: 'current-partial-history',
    fields: {
      foundationListingId: 'TMP-PARTIAL-HISTORY',
      sourceRecordId: 'source-old',
      lifecycleStatusText: '待出租',
      availabilityCycleNo: 1,
      availabilityCycleId: 'TMP-PARTIAL-HISTORY:available:1',
      listingOwner: '',
      ownerDepartment: '',
      lifecycleVersion: 1
    }
  }])
  const currentOperations = [{
    type: 'restore',
    recordId: 'current-partial-history',
    foundationListingId: 'TMP-PARTIAL-HISTORY',
    sourceRecordId: 'source-new',
    fields: {
      foundationListingId: 'TMP-PARTIAL-HISTORY',
      sourceRecordId: 'source-new',
      lifecycleStatusText: '待出租',
      availabilityCycleNo: 2,
      availabilityCycleId: 'TMP-PARTIAL-HISTORY:available:2',
      listingOwner: '',
      ownerDepartment: '',
      lifecycleVersion: 3
    }
  }]
  const archiveOperations = [{
    type: 'create',
    archiveKey: 'TMP-PARTIAL-HISTORY:rented:1',
    foundationListingId: 'TMP-PARTIAL-HISTORY',
    fields: {
      foundationListingId: 'TMP-PARTIAL-HISTORY',
      sourceRecordId: 'source-old',
      availabilityCycleNo: 1,
      availabilityCycleId: 'TMP-PARTIAL-HISTORY:available:1',
      previousLifecycleStatusText: '待出租',
      listingOwner: '',
      ownerDepartment: '',
      lifecycleVersion: 2
    }
  }]
  const firstPlan = feishuSync._internal.lifecycleHistoryOperations(
    currentSnapshot,
    currentOperations,
    snapshot([]),
    'partial-history-run',
    FIXED_NOW_MS,
    { archiveOperations }
  )
  assert.deepStrictEqual(
    firstPlan.map((operation) => operation.fields.eventType),
    ['检测已出租', '重新进入待租'],
    '失败前完整历史计划必须先旧周期、后新周期'
  )
  assert.deepStrictEqual(
    firstPlan.map((operation) => operation.fields.lifecycleVersion),
    [2, 3],
    '归档证据恢复必须分别使用旧周期关闭版本和新周期恢复版本'
  )

  const partialHistory = snapshot([{
    recordId: 'history-old-cycle-written',
    fields: clone(firstPlan[0].fields)
  }])
  const retryPlan = feishuSync._internal.lifecycleHistoryOperations(
    currentSnapshot,
    currentOperations,
    partialHistory,
    'partial-history-run',
    FIXED_NOW_MS,
    { archiveOperations }
  )
  assert.strictEqual(retryPlan.length, 1, '部分成功重跑只能补缺失的新周期流水')
  assert.strictEqual(retryPlan[0].fields.eventType, '重新进入待租', '重跑不得倒序补写旧周期事件')
  assert.ok(
    Number(firstPlan[0].fields.eventAt) < Number(retryPlan[0].fields.eventAt),
    '即使复用同一 nowMs，部分成功重跑的新周期事件仍必须晚于已落盘旧周期事件'
  )
}

async function testMirrorMaterialIntentPersistenceFailureCannotBeDowngraded() {
  const configKeys = [
    'noteMaterialSyncEnabled',
    'sourceCompatibilityProfile',
    'noteMaterialFieldId',
    'noteMaterialTargetRootFolderToken',
    'noteMaterialAllowedHosts',
    'folderToken'
  ]
  const savedConfig = Object.fromEntries(configKeys.map((key) => [key, config.feishu[key]]))
  const sourceBuffer = Buffer.from('mirror-material-intent-source')
  const outputBuffer = Buffer.from('mirror-material-intent-output')
  const sourceSha256 = crypto.createHash('sha256').update(sourceBuffer).digest('hex')
  const outputSha256 = crypto.createHash('sha256').update(outputBuffer).digest('hex')
  const profileText = 'mirror-material-intent-profile-v1'
  const prepareMaterial = async () => ({
    buffer: Buffer.from(outputBuffer),
    sourceContentSha256: sourceSha256,
    sourceSize: sourceBuffer.length,
    sourceMimeType: 'video/mp4',
    kind: 'video',
    extension: 'mp4',
    contentSha256: outputSha256,
    size: outputBuffer.length,
    contentType: 'video/mp4',
    transformProfileVersion: profileText,
    transformProfileSha256: crypto.createHash('sha256').update(profileText).digest('hex'),
    transformToolFingerprint: crypto.createHash('sha256').update('synthetic-tool').digest('hex'),
    transformAction: 'compress'
  })
  prepareMaterial.profile = {
    transformProfileVersion: profileText,
    transformProfileSha256: crypto.createHash('sha256').update(profileText).digest('hex'),
    transformToolFingerprint: crypto.createHash('sha256').update('synthetic-tool').digest('hex')
  }
  let possibleWrites = 0
  try {
    Object.assign(config.feishu, {
      noteMaterialSyncEnabled: true,
      sourceCompatibilityProfile: PROFILE,
      noteMaterialFieldId: 'fldNoteMaterialTest123',
      noteMaterialTargetRootFolderToken: 'fldTargetRootTest123',
      noteMaterialAllowedHosts: ['example.test'],
      folderToken: 'fldLegacyRootTest123'
    })
    await assert.rejects(
      () => feishuSync._internal.syncMirrorNoteMaterials(
        {
          users: [],
          listings: [{
            id: 'listing-material-intent',
            feishuRecordId: 'record-material-intent',
            status: '上架',
            district: '拱墅区',
            block: '新天地',
            community: '测试小区',
            building: '1幢',
            unit: '1单元',
            roomNumber: '101',
            mediaAssets: []
          }]
        },
        {
          sourceNoteMaterials: [{
            sourceRecordId: 'record-material-intent',
            value: 'https://example.test/drive/folder/fldSourceMaterial123'
          }]
        },
        {
          dryRun: false,
          prepareMaterial,
          onExternalWriteDispatched() {
            throw new Error('synthetic write-intent persistence failure')
          },
          noteMaterialDrive: {
            async listFolder() {
              return [{
                token: 'fileMaterialIntent123',
                name: '看房视频.mp4',
                type: 'file',
                modifiedTime: '10',
                size: sourceBuffer.length
              }]
            },
            async downloadToken() {
              return {
                buffer: Buffer.from(sourceBuffer),
                contentType: 'video/mp4',
                contentSha256: sourceSha256,
                size: sourceBuffer.length
              }
            },
            async ensureListingFolder() {
              possibleWrites += 1
              throw new Error('写意图持久化失败后不得调用 Drive 写方法')
            },
            async materializeVideo() {
              possibleWrites += 1
              throw new Error('不得进入 Drive 素材写入')
            },
            async verifyMaterializedVideo() { return true }
          },
          noteMaterialOss: {
            async putVideoDeterministic() {
              possibleWrites += 1
              throw new Error('不得进入 OSS 素材写入')
            },
            async verifyVideoDeterministic() { return true }
          }
        }
      ),
      (error) => error && error.code === 'EXTERNAL_WRITE_INTENT_PERSISTENCE_FAILED' &&
        error.safeBeforeWrite === true,
      '素材总同步层不得把写意图持久化失败降级为普通 pipeline-failed 报告'
    )
    assert.strictEqual(possibleWrites, 0, '写意图未落盘时不得调用任何可能写适配器')
  } finally {
    Object.assign(config.feishu, savedConfig)
  }
}

async function main() {
  const failures = []
  const cases = [
    ['数据底座字段契约', testFoundationBindingContracts],
    ['看房方式空出说明与门锁密码分流', testViewingMethodDerivesVacancyNoteWithoutConfusingDoorCodes],
    ['基线标记真实性与流水 ID 唯一性', testBaselineMarkerAndHistoryIdsFailClosed],
    ['生产配置五表完整性', testConfiguredFoundationRequiresAllResources],
    ['configured 入口转发部分写入对账快照', testConfiguredFoundationForwardsPartialReconciliationCapture],
    ['素材关闭时 worker-v2 仍完整同步房源五表', testWorkerV2CanSyncFiveTablesWhenNoteMaterialsAreDisabled],
    ['三张目标业务表资源独立', testLifecycleTableResourcesMustBeDistinct],
    ['负责人部门与内部 ID 不进入公开投影', testInternalFoundationFieldsStayOutOfPublicProjection],
    ['dry-run 四表零写', testDryRunReadsAllLifecycleTablesAndWritesNone],
    ['源表实时校验时钟与批次截止分离', testSourceSnapshotSeparatesCutoffFromLiveValidationClock],
    ['全空模板不污染房源笔记素材同步', testEmptyTemplateCannotPoisonNoteMaterialSync],
    ['素材写意图落盘失败整轮中止', testMirrorMaterialIntentPersistenceFailureCannotBeDowngraded],
    ['正式写只走目标客户端', testApplyWritesOnlyTargetClient],
    ['新增省略缺失可选字段且更新保留清空语义', testCreateOmitsMissingOptionalFieldsAndUpdateKeepsClearSemantics],
    ['飞书业务错误码可诊断且不泄露正文', testFeishuApiFailureExposesOnlySanitizedMachineCode],
    ['旧 profile 回退不清空底座字段', testLegacyProfileCannotEraseFoundationFields],
    ['出租归档幂等与重新进入待租', testArchiveIdempotencyAndReappearance],
    ['出租事件先落盘后的失败补偿', testArchiveFirstCurrentWriteFailureCanRecover],
    ['精确部分写入前缀保持只读续跑计划稳定', testExactPartialPrefixKeepsStableReadOnlyContinuationPlan],
    ['批量撤下熔断三表零写', testDeactivateFuseBlocksAllThreeWrites],
    ['源表 record_id 轮换按稳定物理身份熔断', testFoundationFuseUsesStablePhysicalIdentityAcrossSourceRecordRotation],
    ['目标主档身份与责任字段保留', testTargetIdentityAndResponsibilityEnrichmentIsPreserved],
    ['首次正式同步建立持久基线', testFirstApplyCreatesPersistentBaselineWithoutHistoricalRental],
    ['不确定新增跨进程复用稳定幂等号', testUncertainCreateReusesStableTokenAcrossRun],
    ['同周期重复同向变化保留完整流水', testRepeatedSameDirectionTransitionsKeepDistinctHistory],
    ['真实出租后重新出现才开启新周期', testRentedReappearanceClosesOldCycleBeforeOpeningNewCycle],
    ['归档先成功流水失败后按出租证据恢复', testRentedReappearanceRecoversWhenArchiveSucceededBeforeHistory],
    ['旧周期关闭成功且恢复流水失败后只补缺口', testRentedReappearanceRecoversWhenRestoreHistoryFails],
    ['归档优先冻结事件身份与明确空前态', testArchiveUsesFrozenEventIdentityAndExplicitEmptyPreviousStatus],
    ['归档逐项优先冻结事件身份和生命周期字段', testArchiveProjectionPrioritizesEveryFrozenEventField],
    ['兼容层摘要只绑定有效源表行', testCompatibilityDigestUsesOnlyEffectiveRows],
    ['状态流水计划不受输入顺序影响', testLifecycleHistoryPlanIsCanonicalAcrossOperationOrder],
    ['出租恢复部分失败重跑仍保持事件顺序', testRentedReappearanceHistoryKeepsOrderAfterPartialRetry]
  ]

  for (const [name, test] of cases) {
    try {
      await test()
      console.log(`PASS ${name}`)
    } catch (error) {
      failures.push({ name, error })
      console.error(`FAIL ${name}: ${error && error.stack ? error.stack : error}`)
    }
  }

  if (failures.length) {
    const error = new Error(`feishu-ai-data-foundation-v1-test 红测：${failures.length}/${cases.length} 项未实现`)
    error.failures = failures
    throw error
  }
  console.log('feishu-ai-data-foundation-v1-test passed')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
