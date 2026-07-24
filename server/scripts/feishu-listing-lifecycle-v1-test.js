'use strict'

const assert = require('assert')
const {
  calculateLifecycleDays,
  lifecycleStatusOf,
  planListingLifecycle,
  yuxiaoerIdentityKey
} = require('../src/feishu-listing-lifecycle')

const OBSERVED_AT = '2026-07-24T12:00:00.000Z'
const CREATED_TIME_MS = Date.parse('2026-07-22T11:59:59.000Z')
const DEFAULT_IDENTITY_ALIASES = '[{"aliasType":"sourceRecord","aliasValue":"src-1"},{"aliasType":"yuxiaoer","aliasValue":"YX2:listing-1:WHOLE"}]'

function snapshot(records, overrides = {}) {
  return {
    complete: true,
    recordCount: records.length,
    records,
    ...overrides
  }
}

function source(recordId, overrides = {}) {
  return {
    recordId,
    createdTimeMs: CREATED_TIME_MS,
    fields: {
      rentMode: '整租',
      yuxiaoerListingId: 'listing-1',
      yuxiaoerRoomId: '',
      physicalUnitKey: '杭州/拱墅/祥符/测试小区/1/1/101/整租',
      vacancyNote: '',
      listingOwner: '测试负责人',
      ownerDepartment: '测试部门',
      ...overrides
    }
  }
}

function defaultIdentityAliases(fields) {
  const aliases = []
  if (fields.sourceRecordId) {
    aliases.push({ aliasType: 'sourceRecord', aliasValue: fields.sourceRecordId })
  }
  const realIdentity = yuxiaoerIdentityKey({
    rentMode: fields.rentMode,
    yuxiaoerListingId: fields.yuxiaoerListingId,
    yuxiaoerRoomId: fields.yuxiaoerRoomId
  })
  if (realIdentity) aliases.push({ aliasType: 'yuxiaoer', aliasValue: realIdentity })
  if (fields.temporaryListingId) {
    aliases.push({ aliasType: 'temporary', aliasValue: fields.temporaryListingId })
  }
  aliases.sort((left, right) => {
    const leftKey = `${left.aliasType}:${String(left.aliasValue).toLocaleLowerCase('zh-CN')}`
    const rightKey = `${right.aliasType}:${String(right.aliasValue).toLocaleLowerCase('zh-CN')}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  return JSON.stringify(aliases)
}

function current(recordId, overrides = {}) {
  const fields = {
    foundationListingId: 'YX2:listing-1:WHOLE',
    sourceRecordId: 'src-1',
    yuxiaoerListingId: 'listing-1',
    yuxiaoerRoomId: '',
    temporaryListingId: '',
    identityType: 'yuxiaoer',
    rentMode: '整租',
    physicalUnitKey: '杭州/拱墅/祥符/测试小区/1/1/101/整租',
    lifecycleVersion: 1,
    lifecycleStatusText: '待出租',
    vacancyNote: '',
    sourceCreatedAt: CREATED_TIME_MS,
    availabilityCycleNo: 1,
    availabilityCycleId: 'YX2:listing-1:WHOLE:available:1',
    metricKind: '待租天数',
    lifecycleDays: 2,
    listingOwner: '测试负责人',
    ownerDepartment: '测试部门',
    sourcePresent: true,
    published: true,
    enabled: true,
    lastSeenRunId: 'run-before',
    lastSeenAt: '2026-07-23T12:00:00.000Z',
    statusChangedAt: '2026-07-22T12:00:00.000Z',
    ...overrides
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'identityAliases')) {
    fields.identityAliases = defaultIdentityAliases(fields)
  }
  return {
    recordId,
    fields
  }
}

function alias(aliasType, aliasValue, foundationListingId = 'YX2:listing-1:WHOLE') {
  return {
    recordId: `alias-${aliasType}-${aliasValue}`,
    fields: { aliasType, aliasValue, foundationListingId }
  }
}

function event(rentalEventId, overrides = {}) {
  return {
    recordId: `event-${rentalEventId}`,
    fields: {
      rentalEventId,
      foundationListingId: 'YX2:listing-1:WHOLE',
      availabilityCycleNo: 1,
      availabilityCycleId: 'YX2:listing-1:WHOLE:available:1',
      ...overrides
    }
  }
}

function baseInput(overrides = {}) {
  return {
    sourceSnapshot: snapshot([source('src-1')]),
    currentStateSnapshot: snapshot([]),
    rentedEventSnapshot: snapshot([]),
    aliasSnapshot: snapshot([]),
    runId: 'run-now',
    observedAt: OBSERVED_AT,
    allocateTemporaryId() {
      return 'TMP-allocated'
    },
    ...overrides
  }
}

function desiredState(plan, foundationListingId) {
  return plan.desiredStates.find((item) => item.foundationListingId === foundationListingId)
}

function currentOperation(plan, foundationListingId) {
  return plan.currentStateOperations.find((item) => item.foundationListingId === foundationListingId)
}

function testPureStatusIdentityAndDays() {
  assert.strictEqual(lifecycleStatusOf(''), '待出租', '空备注必须规范为待出租')
  assert.strictEqual(lifecycleStatusOf('  \n '), '待出租', '纯空白备注必须规范为待出租')
  assert.strictEqual(lifecycleStatusOf('月底空出'), '即将空出', '非空备注必须规范为即将空出')
  assert.strictEqual(
    yuxiaoerIdentityKey({ rentMode: '整租', yuxiaoerListingId: ' L-1 ', yuxiaoerRoomId: 'ignored' }),
    'YX2:L-1:WHOLE',
    '整租必须使用房源 ID + WHOLE'
  )
  assert.strictEqual(
    yuxiaoerIdentityKey({ rentMode: '合租', yuxiaoerListingId: 'L-1', yuxiaoerRoomId: 'R-A' }),
    'YX2:L-1:R-A',
    '合租必须使用房源 ID + 房间 ID'
  )
  assert.strictEqual(
    yuxiaoerIdentityKey({ rentMode: '合租', yuxiaoerListingId: 'L-1', yuxiaoerRoomId: '' }),
    '',
    '合租缺房间 ID 时不得伪造真实身份'
  )
  assert.strictEqual(
    calculateLifecycleDays(CREATED_TIME_MS, OBSERVED_AT),
    2,
    '计时必须按源表 createdTimeMs 的完整 24 小时向下取整'
  )
}

function testPresentRowsAndRequiredFields() {
  let temporaryAllocations = 0
  const plan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-1', { vacancyNote: '  7月30日空出可看  ' })]),
    allocateTemporaryId() {
      temporaryAllocations += 1
      return 'TMP-unexpected'
    }
  }))
  const state = desiredState(plan, 'YX2:listing-1:WHOLE')
  assert(state, '真实整租身份必须生成期望状态')
  assert.deepStrictEqual(
    state,
    {
      foundationListingId: 'YX2:listing-1:WHOLE',
      sourceRecordId: 'src-1',
      yuxiaoerListingId: 'listing-1',
      yuxiaoerRoomId: '',
      temporaryListingId: '',
      identityType: 'yuxiaoer',
      rentMode: '整租',
      physicalUnitKey: '杭州/拱墅/祥符/测试小区/1/1/101/整租',
      identityAliases: DEFAULT_IDENTITY_ALIASES,
      lifecycleVersion: 1,
      lifecycleStatusText: '即将空出',
      vacancyNote: '7月30日空出可看',
      sourceCreatedAt: CREATED_TIME_MS,
      availabilityCycleNo: 1,
      availabilityCycleId: 'YX2:listing-1:WHOLE:available:1',
      metricKind: '提前挂出天数',
      lifecycleDays: 2,
      listingOwner: '测试负责人',
      ownerDepartment: '测试部门',
      sourcePresent: true,
      published: true,
      enabled: true
    },
    '当前状态字段必须完整且只使用冻结口径'
  )
  assert.strictEqual(temporaryAllocations, 0, '真实身份不得分配临时 ID')
  assert.strictEqual(currentOperation(plan, state.foundationListingId).type, 'create', '首次出现必须创建当前状态')
  assert(plan.aliasOperations.some((item) => item.fields.aliasType === 'sourceRecord' && item.fields.aliasValue === 'src-1'),
    '首次出现必须持久化源 recordId 别名')
  assert(plan.aliasOperations.some((item) => item.fields.aliasType === 'yuxiaoer' &&
    item.fields.aliasValue === 'YX2:listing-1:WHOLE'), '真实身份必须持久化寓小二别名')
}

function testSharedRoomIdentity() {
  const plan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-room', {
      rentMode: '合租',
      yuxiaoerListingId: 'listing-shared',
      yuxiaoerRoomId: 'room-A',
      physicalUnitKey: '杭州/拱墅/祥符/测试小区/1/1/101A/合租'
    })])
  }))
  assert(desiredState(plan, 'YX2:listing-shared:room-A'), '合租必须按房源 ID + 房间 ID 建立真实身份')

  const partialPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-shared-partial', {
      rentMode: '合租',
      yuxiaoerListingId: 'listing-shared',
      yuxiaoerRoomId: '',
      physicalUnitKey: '杭州/拱墅/祥符/测试小区/1/1/101B/合租'
    })]),
    allocateTemporaryId() {
      return 'TMP-shared-partial'
    }
  }))
  const partial = desiredState(partialPlan, 'TMP-shared-partial')
  assert(partial, '合租缺房间 ID 时必须保留临时身份')
  assert.strictEqual(partial.identityType, 'temporary', '合租缺房间 ID 时不得标记为真实寓小二身份')
  assert.strictEqual(partial.yuxiaoerListingId, 'listing-shared', '部分寓小二 ID 仍应保留供后续补全')
  assert.strictEqual(partial.yuxiaoerRoomId, '', '缺失房间 ID 不得伪造')
  assert.strictEqual(
    desiredState(partialPlan, 'YX2:listing-shared:WHOLE'),
    undefined,
    '合租缺房间 ID 时绝不得回退成 WHOLE'
  )
  assert(!partialPlan.aliasOperations.some((item) => item.fields.aliasValue === 'YX2:listing-shared:WHOLE'),
    '合租缺房间 ID 时不得持久化伪造的 WHOLE 别名')

  const persistedPartial = current('cur-shared-partial', {
    foundationListingId: 'TMP-shared-partial',
    sourceRecordId: 'src-shared-partial',
    yuxiaoerListingId: 'listing-shared',
    yuxiaoerRoomId: '',
    temporaryListingId: 'TMP-shared-partial',
    identityType: 'temporary',
    rentMode: '合租',
    physicalUnitKey: '杭州/拱墅/祥符/测试小区/1/1/101B/合租',
    availabilityCycleId: 'TMP-shared-partial:available:1'
  })
  const persistedPartialPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-shared-partial', {
      rentMode: '合租',
      yuxiaoerListingId: 'listing-shared',
      yuxiaoerRoomId: '',
      physicalUnitKey: '杭州/拱墅/祥符/测试小区/1/1/101B/合租'
    })]),
    currentStateSnapshot: snapshot([persistedPartial]),
    allocateTemporaryId() {
      throw new Error('已持久化的部分合租身份不得重新分配')
    }
  }))
  const persistedPartialState = desiredState(persistedPartialPlan, 'TMP-shared-partial')
  assert.strictEqual(persistedPartialState.identityType, 'temporary',
    '已持久化的合租部分身份重跑仍不得被误判成 WHOLE 真实身份')
  assert(!persistedPartialState.identityAliases.includes('YX2:listing-shared:WHOLE'),
    '当前状态已有部分寓小二 ID 时仍不得生成 WHOLE 内嵌别名')
}

function testTemporaryIdentityReuseAndUpgrade() {
  let allocationCount = 0
  const firstPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-temp', {
      yuxiaoerListingId: '',
      yuxiaoerRoomId: ''
    })]),
    allocateTemporaryId() {
      allocationCount += 1
      return 'TMP-stable-1'
    }
  }))
  const firstState = desiredState(firstPlan, 'TMP-stable-1')
  assert(firstState, '无寓小二 ID 的房源必须分配临时身份')
  assert.strictEqual(firstState.temporaryListingId, 'TMP-stable-1', '临时 ID 必须持久化到当前状态')
  assert.strictEqual(firstState.identityType, 'temporary', '无真实 ID 时身份类型必须为 temporary')

  const persistedCurrent = current('cur-temp', {
    ...firstState,
    lastSeenRunId: 'run-first',
    lastSeenAt: OBSERVED_AT,
    statusChangedAt: OBSERVED_AT
  })
  const persistedAliases = snapshot(firstPlan.aliasOperations.map((operation, index) => ({
    recordId: `persisted-alias-${index}`,
    fields: operation.fields
  })))
  const repeatPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-temp', {
      yuxiaoerListingId: '',
      yuxiaoerRoomId: ''
    })]),
    currentStateSnapshot: snapshot([persistedCurrent]),
    aliasSnapshot: persistedAliases,
    allocateTemporaryId() {
      throw new Error('重跑不得重新分配临时 ID')
    }
  }))
  assert(desiredState(repeatPlan, 'TMP-stable-1'), '重跑必须复用已持久化临时身份')

  const upgradedPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-temp', {
      yuxiaoerListingId: 'listing-upgraded',
      yuxiaoerRoomId: ''
    })]),
    currentStateSnapshot: snapshot([persistedCurrent]),
    aliasSnapshot: persistedAliases,
    allocateTemporaryId() {
      throw new Error('升级真实身份不得创建新实体')
    }
  }))
  const upgraded = desiredState(upgradedPlan, 'TMP-stable-1')
  assert(upgraded, '升级真实身份后 foundationListingId 必须保持不变')
  assert.strictEqual(upgraded.temporaryListingId, 'TMP-stable-1', '升级后必须保留临时 ID 历史')
  assert.strictEqual(upgraded.identityType, 'yuxiaoer', '升级后身份类型必须变为 yuxiaoer')
  assert.strictEqual(upgraded.yuxiaoerListingId, 'listing-upgraded', '升级后必须补入寓小二房源 ID')
  assert.strictEqual(upgraded.lifecycleVersion, 1, '只补全身份别名不得推进业务生命周期版本')
  assert(upgradedPlan.aliasOperations.some((item) => item.fields.aliasValue === 'YX2:listing-upgraded:WHOLE'),
    '升级后必须新增真实身份别名')
  assert.strictEqual(allocationCount, 1, '临时 ID 在整个生命周期只能首次分配一次')
}

function testSourceAliasAndPhysicalIdentityMatching() {
  const existing = current('cur-existing', {
    foundationListingId: 'TMP-existing',
    sourceRecordId: 'src-old',
    yuxiaoerListingId: '',
    temporaryListingId: 'TMP-existing',
    identityType: 'temporary',
    identityAliases: '[{"aliasType":"sourceRecord","aliasValue":"src-old"},{"aliasType":"temporary","aliasValue":"TMP-existing"}]',
    availabilityCycleId: 'TMP-existing:available:1'
  })
  const byAlias = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-old', {
      yuxiaoerListingId: '',
      yuxiaoerRoomId: ''
    })]),
    currentStateSnapshot: snapshot([existing]),
    allocateTemporaryId() {
      throw new Error('源别名命中后不得分配临时 ID')
    }
  }))
  assert(desiredState(byAlias, 'TMP-existing'), '源 recordId 别名必须命中既有实体')

  const replacementCreatedAt = Date.parse('2026-07-24T11:00:00.000Z')
  const replacementSource = source('src-new', {
    yuxiaoerListingId: '',
    yuxiaoerRoomId: ''
  })
  replacementSource.createdTimeMs = replacementCreatedAt
  const byPhysical = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([replacementSource]),
    currentStateSnapshot: snapshot([existing]),
    allocateTemporaryId() {
      throw new Error('唯一物理键命中后不得分配临时 ID')
    }
  }))
  const physicalState = desiredState(byPhysical, 'TMP-existing')
  assert(physicalState, '源记录重建后必须通过唯一物理键复用实体')
  assert.strictEqual(physicalState.sourceRecordId, 'src-new', '当前源 recordId 必须更新为新记录')
  assert.strictEqual(
    physicalState.availabilityCycleNo,
    2,
    '源行删除后以新 recordId 重建，必须结束旧周期并开启新待租周期'
  )
  assert.strictEqual(physicalState.sourceCreatedAt, replacementCreatedAt, '新周期必须按新源行录入时间重新计时')
  assert.strictEqual(physicalState.lifecycleDays, 0, '新周期的待租计时必须从新源行录入时间开始')
  assert.strictEqual(physicalState.lifecycleVersion, 2, '源行更换必须把生命周期版本推进一次')
  assert.strictEqual(currentOperation(byPhysical, 'TMP-existing').type, 'restore',
    '源行更换必须以新周期恢复操作落盘')
  assert.strictEqual(byPhysical.rentalEventOperations.length, 1, '源行更换必须生成旧周期出租归档')
  assert.deepStrictEqual(
    byPhysical.rentalEventOperations[0].fields,
    {
      rentalEventId: 'TMP-existing:rented:1',
      foundationListingId: 'TMP-existing',
      availabilityCycleNo: 1,
      availabilityCycleId: 'TMP-existing:available:1',
      sourceRecordId: 'src-old',
      yuxiaoerListingId: '',
      yuxiaoerRoomId: '',
      temporaryListingId: 'TMP-existing',
      identityType: 'temporary',
      rentMode: '整租',
      physicalUnitKey: '杭州/拱墅/祥符/测试小区/1/1/101/整租',
      identityAliases: '[{"aliasType":"sourceRecord","aliasValue":"src-old"},{"aliasType":"temporary","aliasValue":"TMP-existing"}]',
      lifecycleVersion: 2,
      previousLifecycleStatusText: '待出租',
      sourceCreatedAt: CREATED_TIME_MS,
      rentedDetectedAt: OBSERVED_AT,
      elapsedDaysAtExit: 2,
      vacancyNote: '',
      listingOwner: '测试负责人',
      ownerDepartment: '测试部门',
      runId: 'run-now'
    },
    '源行更换归档必须冻结旧周期身份、计时、责任与版本'
  )
  assert(byPhysical.aliasOperations.some((item) => item.fields.aliasType === 'sourceRecord' &&
    item.fields.aliasValue === 'src-new'), '新源 recordId 必须追加为别名')

  const replacementRetry = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([replacementSource]),
    currentStateSnapshot: snapshot([current('cur-existing', physicalState)]),
    rentedEventSnapshot: snapshot([event('TMP-existing:rented:1', {
      foundationListingId: 'TMP-existing'
    })]),
    allocateTemporaryId() {
      throw new Error('源行更换重试不得重新分配临时 ID')
    }
  }))
  assert.strictEqual(desiredState(replacementRetry, 'TMP-existing').lifecycleVersion, 2,
    '同一次源行更换重试必须保持相同生命周期版本')
  assert.strictEqual(replacementRetry.rentalEventOperations.length, 0, '同一旧周期归档重试不得重复创建')
  assert.strictEqual(replacementRetry.currentStateOperations.length, 0, '新周期当前状态已落盘后重试必须为 no-op')

  const persistedSourceAlias = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-persisted-alias', {
      yuxiaoerListingId: '',
      yuxiaoerRoomId: '',
      physicalUnitKey: '杭州/拱墅/祥符/测试小区/9/9/999/整租'
    })]),
    currentStateSnapshot: snapshot([existing]),
    aliasSnapshot: snapshot([
      alias('sourceRecord', 'src-persisted-alias', 'TMP-existing')
    ]),
    allocateTemporaryId() {
      throw new Error('已持久化源别名命中后不得分配临时 ID')
    }
  }))
  assert(
    desiredState(persistedSourceAlias, 'TMP-existing'),
    '源记录即使物理字段修正，也必须能通过已持久化源别名命中原实体'
  )
}

function testEmbeddedIdentityAliasesAreDeterministicAndRecoverable() {
  const existing = current('cur-alias-recovery', {
    foundationListingId: 'TMP-alias-recovery',
    sourceRecordId: 'src-current',
    yuxiaoerListingId: '',
    temporaryListingId: 'TMP-alias-recovery',
    identityType: 'temporary',
    physicalUnitKey: '杭州/拱墅/祥符/旧小区/1/1/101/整租',
    identityAliases: '[{"aliasValue":"TMP-alias-recovery","aliasType":"temporary"},{"aliasValue":"src-legacy","aliasType":"sourceRecord"},{"aliasValue":"src-current","aliasType":"sourceRecord"}]',
    availabilityCycleId: 'TMP-alias-recovery:available:1'
  })
  const plan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-legacy', {
      yuxiaoerListingId: '',
      yuxiaoerRoomId: '',
      physicalUnitKey: '杭州/拱墅/祥符/修正后小区/1/1/101/整租'
    })]),
    currentStateSnapshot: snapshot([existing]),
    aliasSnapshot: snapshot([]),
    allocateTemporaryId() {
      throw new Error('内嵌旧别名命中后不得重新分配临时 ID')
    }
  }))
  const recovered = desiredState(plan, 'TMP-alias-recovery')
  assert(recovered, '物理字段修正后必须能从当前状态内嵌旧别名恢复同一实体')
  assert.strictEqual(
    recovered.identityAliases,
    '[{"aliasType":"sourceRecord","aliasValue":"src-current"},{"aliasType":"sourceRecord","aliasValue":"src-legacy"},{"aliasType":"temporary","aliasValue":"TMP-alias-recovery"}]',
    '当前状态身份别名必须规范化为字段顺序和数组顺序都确定的 JSON 文本'
  )

  const retry = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-legacy', {
      yuxiaoerListingId: '',
      yuxiaoerRoomId: '',
      physicalUnitKey: '杭州/拱墅/祥符/修正后小区/1/1/101/整租'
    })]),
    currentStateSnapshot: snapshot([current('cur-alias-recovery', recovered)]),
    rentedEventSnapshot: snapshot([event('TMP-alias-recovery:rented:1', {
      foundationListingId: 'TMP-alias-recovery'
    })]),
    aliasSnapshot: snapshot([]),
    allocateTemporaryId() {
      throw new Error('内嵌别名重跑不得重新分配临时 ID')
    }
  }))
  assert.strictEqual(desiredState(retry, 'TMP-alias-recovery').identityAliases, recovered.identityAliases,
    '相同别名集合重跑必须输出逐字节一致的 JSON 文本')
}

function testRentedEventIdempotencyAndReappearance() {
  const existing = current('cur-1')
  const missingPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([]),
    currentStateSnapshot: snapshot([existing])
  }))
  const rentedOperation = currentOperation(missingPlan, 'YX2:listing-1:WHOLE')
  assert.strictEqual(rentedOperation.type, 'markRented', '完整快照消失必须把当前状态标记为已出租')
  assert.strictEqual(rentedOperation.fields.lifecycleStatusText, '已出租', '消失后的状态必须是已出租')
  assert.strictEqual(rentedOperation.fields.sourcePresent, false, '已出租记录必须标记源记录不存在')
  assert.strictEqual(rentedOperation.fields.published, false, '已出租记录不得继续发布')
  assert.strictEqual(rentedOperation.fields.enabled, false, '已出租记录不得保持启用')
  assert.strictEqual(rentedOperation.fields.lifecycleVersion, 2, '检测已出租属于状态变化，版本必须推进一次')
  assert.strictEqual(missingPlan.rentalEventOperations.length, 1, '首次消失必须创建一条出租事件')
  assert.strictEqual(
    missingPlan.rentalEventOperations[0].fields.rentalEventId,
    'YX2:listing-1:WHOLE:rented:1',
    '出租事件必须按实体和待租周期形成幂等键'
  )
  assert.strictEqual(missingPlan.rentalEventOperations[0].fields.lifecycleVersion, 2,
    '已出租归档必须携带本次状态变化后的生命周期版本')
  assert.strictEqual(missingPlan.rentalEventOperations[0].fields.identityAliases, DEFAULT_IDENTITY_ALIASES,
    '已出租归档必须携带确定性的历史身份别名')

  const rentedCurrent = current('cur-1', rentedOperation.fields)
  const existingEvent = event('YX2:listing-1:WHOLE:rented:1')
  const repeatPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([]),
    currentStateSnapshot: snapshot([rentedCurrent]),
    rentedEventSnapshot: snapshot([existingEvent])
  }))
  assert.strictEqual(repeatPlan.currentStateOperations.length, 0, '已出租状态重跑不得重复更新')
  assert.strictEqual(repeatPlan.rentalEventOperations.length, 0, '已存在的出租事件不得重复创建')
  assert.strictEqual(repeatPlan.noop, true, '同一消失状态重跑必须成为 no-op')

  const missingEventPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([]),
    currentStateSnapshot: snapshot([rentedCurrent]),
    rentedEventSnapshot: snapshot([])
  }))
  assert.strictEqual(missingEventPlan.currentStateOperations.length, 0, '当前状态已落盘时不得重复更新')
  assert.strictEqual(missingEventPlan.rentalEventOperations.length, 1, '状态已出租但事件缺失时必须补事件')

  const reappearPlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-return')]),
    currentStateSnapshot: snapshot([rentedCurrent]),
    rentedEventSnapshot: snapshot([existingEvent])
  }))
  const reappeared = desiredState(reappearPlan, 'YX2:listing-1:WHOLE')
  assert.strictEqual(reappeared.availabilityCycleNo, 2, '已出租后重新出现必须开启下一待租周期')
  assert.strictEqual(
    reappeared.availabilityCycleId,
    'YX2:listing-1:WHOLE:available:2',
    '新待租周期 ID 必须随周期号稳定递增'
  )
  assert.strictEqual(reappeared.lifecycleStatusText, '待出租', '重新出现后的状态必须重新由备注决定')
  assert.strictEqual(reappeared.lifecycleVersion, 3, '已出租后恢复必须在已出租版本上再推进一次')

  const reappearAfterPartialWrite = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-return')]),
    currentStateSnapshot: snapshot([rentedCurrent]),
    rentedEventSnapshot: snapshot([])
  }))
  assert.strictEqual(reappearAfterPartialWrite.rentalEventOperations.length, 1,
    '已出租当前状态先落盘但归档失败时，恢复前必须先补齐上一周期归档')
  assert.strictEqual(reappearAfterPartialWrite.rentalEventOperations[0].fields.lifecycleVersion, 2,
    '补写上一周期归档必须使用已出租状态的版本，不得误用恢复后的新版本')
  assert.strictEqual(
    desiredState(reappearAfterPartialWrite, 'YX2:listing-1:WHOLE').lifecycleVersion,
    3,
    '补归档与恢复同批发生时，当前状态仍必须推进到恢复版本'
  )
}

function testLifecycleVersionOnlyAdvancesOnBusinessTransitions() {
  const unchanged = planListingLifecycle(baseInput({
    currentStateSnapshot: snapshot([current('cur-version')])
  }))
  assert.strictEqual(desiredState(unchanged, 'YX2:listing-1:WHOLE').lifecycleVersion, 1,
    '完全相同的重跑必须保持生命周期版本')
  assert.strictEqual(unchanged.currentStateOperations.length, 0, '完全相同的重跑不得产生当前状态写入')

  const laterMetricOnly = planListingLifecycle(baseInput({
    currentStateSnapshot: snapshot([current('cur-version')]),
    observedAt: '2026-07-25T12:00:00.000Z'
  }))
  assert.strictEqual(desiredState(laterMetricOnly, 'YX2:listing-1:WHOLE').lifecycleVersion, 1,
    '仅待租天数自然增长不得推进生命周期版本')
  assert.strictEqual(currentOperation(laterMetricOnly, 'YX2:listing-1:WHOLE').type, 'update',
    '待租天数变化仍应更新当前展示值')

  const statusChanged = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-1', { vacancyNote: '月底空出' })]),
    currentStateSnapshot: snapshot([current('cur-version')])
  }))
  const changedState = desiredState(statusChanged, 'YX2:listing-1:WHOLE')
  assert.strictEqual(changedState.lifecycleVersion, 2, '待租状态变化必须推进生命周期版本')

  const statusRetry = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-1', { vacancyNote: '月底空出' })]),
    currentStateSnapshot: snapshot([current('cur-version', changedState)])
  }))
  assert.strictEqual(desiredState(statusRetry, 'YX2:listing-1:WHOLE').lifecycleVersion, 2,
    '同一状态变化已落盘后重试必须保持原版本')
  assert.strictEqual(statusRetry.currentStateOperations.length, 0, '同一状态变化重试不得重复写入')

  const responsibilityChanged = planListingLifecycle(baseInput({
    currentStateSnapshot: snapshot([current('cur-version')]),
    responsibilityIndex: new Map([
      ['YX2:listing-1:WHOLE', {
        listingOwner: '新负责人',
        ownerDepartment: '新部门'
      }]
    ])
  }))
  assert.strictEqual(desiredState(responsibilityChanged, 'YX2:listing-1:WHOLE').lifecycleVersion, 2,
    '负责人或所属部门变化必须推进生命周期版本')

  const legacyZeroChanged = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-1', { vacancyNote: '月底空出' })]),
    currentStateSnapshot: snapshot([current('cur-version-zero', { lifecycleVersion: 0 })])
  }))
  assert.strictEqual(desiredState(legacyZeroChanged, 'YX2:listing-1:WHOLE').lifecycleVersion, 1,
    '历史版本 0 首次发生业务变化时必须只推进到 1')

  const aliasesBackfilled = planListingLifecycle(baseInput({
    currentStateSnapshot: snapshot([current('cur-version', { identityAliases: '' })])
  }))
  assert.strictEqual(desiredState(aliasesBackfilled, 'YX2:listing-1:WHOLE').lifecycleVersion, 1,
    '仅回填身份别名不得推进生命周期版本')
}

function testBaselineAndFailClosedBoundaries() {
  const baselinePlan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([]),
    currentStateSnapshot: snapshot([current('cur-1')]),
    baseline: true
  }))
  assert.strictEqual(baselinePlan.currentStateOperations.length, 0, 'baseline 不得追认历史记录为已出租')
  assert.strictEqual(baselinePlan.rentalEventOperations.length, 0, 'baseline 不得补造历史出租事件')

  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([source('src-1')], { complete: false })
    })),
    /源快照.*完整/,
    '源快照不完整必须整批阻断'
  )
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([source('src-1')], { recordCount: 99 })
    })),
    /记录数/,
    '源快照记录数不一致必须整批阻断'
  )
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([source('src-1')]),
      currentStateSnapshot: snapshot([], { complete: false })
    })),
    /当前状态快照.*完整/,
    '当前状态快照不完整必须整批阻断'
  )
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([source('src-invalid', { yuxiaoerListingId: 'invalid' })].map((item) => ({
        ...item,
        createdTimeMs: 'not-a-time'
      })))
    })),
    /createdTimeMs/,
    '非法 createdTimeMs 必须整批阻断'
  )
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([{
        ...source('src-seconds'),
        createdTimeMs: 1784736000
      }])
    })),
    /createdTimeMs|毫秒/,
    '秒级 createdTimeMs 必须整批阻断'
  )
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([{
        ...source('src-future'),
        createdTimeMs: Date.parse(OBSERVED_AT) + 1
      }])
    })),
    /未来|createdTimeMs/,
    '未来 createdTimeMs 必须整批阻断'
  )
}

function testDuplicateAndAmbiguousIdentityBlocksWholePlan() {
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([
        source('src-1'),
        source('src-2', {
          physicalUnitKey: '杭州/拱墅/祥符/测试小区/2/1/201/整租'
        })
      ])
    })),
    /寓小二.*重复|重复.*寓小二|身份.*重复/,
    '同一真实身份出现在两条源记录时必须整批阻断'
  )

  const first = current('cur-a', {
    foundationListingId: 'TMP-A',
    sourceRecordId: 'old-a',
    yuxiaoerListingId: '',
    temporaryListingId: 'TMP-A',
    identityType: 'temporary',
    availabilityCycleId: 'TMP-A:available:1'
  })
  const second = current('cur-b', {
    foundationListingId: 'TMP-B',
    sourceRecordId: 'old-b',
    yuxiaoerListingId: '',
    temporaryListingId: 'TMP-B',
    identityType: 'temporary',
    availabilityCycleId: 'TMP-B:available:1'
  })
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([source('src-new', {
        yuxiaoerListingId: '',
        yuxiaoerRoomId: ''
      })]),
      currentStateSnapshot: snapshot([first, second])
    })),
    /物理.*重复|物理.*歧义|physical/i,
    '一个物理键对应多个实体时必须整批阻断'
  )

  assert.throws(
    () => planListingLifecycle(baseInput({
      currentStateSnapshot: snapshot([first]),
      aliasSnapshot: snapshot([
        alias('sourceRecord', 'src-1', 'TMP-A'),
        alias('sourceRecord', 'src-1', 'TMP-B')
      ])
    })),
    /别名.*冲突|alias/i,
    '同一别名指向两个实体时必须整批阻断'
  )

  const realEntity = current('cur-real')
  const physicalEntity = current('cur-physical', {
    foundationListingId: 'TMP-physical',
    sourceRecordId: 'old-physical',
    yuxiaoerListingId: '',
    temporaryListingId: 'TMP-physical',
    identityType: 'temporary',
    physicalUnitKey: '杭州/拱墅/祥符/测试小区/2/1/201/整租',
    availabilityCycleId: 'TMP-physical:available:1'
  })
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([source('src-conflict', {
        physicalUnitKey: '杭州/拱墅/祥符/测试小区/2/1/201/整租'
      })]),
      currentStateSnapshot: snapshot([realEntity, physicalEntity])
    })),
    /互相冲突/,
    '真实身份与唯一物理键指向不同实体时必须整批阻断'
  )

  const allocatedCollision = current('cur-collision', {
    foundationListingId: 'TMP-collision',
    sourceRecordId: 'old-collision',
    yuxiaoerListingId: '',
    temporaryListingId: 'TMP-collision',
    identityType: 'temporary',
    physicalUnitKey: '杭州/拱墅/祥符/测试小区/8/1/801/整租',
    availabilityCycleId: 'TMP-collision:available:1'
  })
  assert.throws(
    () => planListingLifecycle(baseInput({
      sourceSnapshot: snapshot([source('src-new-temp', {
        yuxiaoerListingId: '',
        yuxiaoerRoomId: '',
        physicalUnitKey: '杭州/拱墅/祥符/测试小区/7/1/701/整租'
      })]),
      currentStateSnapshot: snapshot([allocatedCollision]),
      allocateTemporaryId() {
        return 'TMP-collision'
      }
    })),
    /临时 ID.*冲突/,
    '临时 ID 分配器返回既有其他实体 ID 时必须整批阻断'
  )
}

function testResponsibilityAndStatusPrecedence() {
  const responsibilityIndex = new Map([
    ['YX2:listing-1:WHOLE', {
      listingOwner: '合同映射负责人',
      ownerDepartment: '合同映射部门'
    }]
  ])
  const plan = planListingLifecycle(baseInput({
    sourceSnapshot: snapshot([source('src-1', {
      vacancyNote: '月底空出',
      listingOwner: '',
      ownerDepartment: '',
      contractStatus: '在租中'
    })]),
    responsibilityIndex
  }))
  const state = desiredState(plan, 'YX2:listing-1:WHOLE')
  assert.strictEqual(state.lifecycleStatusText, '即将空出', '合同状态不得覆盖员工待租源表状态')
  assert.strictEqual(state.listingOwner, '合同映射负责人', '负责人必须可按寓小二身份关联')
  assert.strictEqual(state.ownerDepartment, '合同映射部门', '所属部门必须可按寓小二身份关联')
}

testPureStatusIdentityAndDays()
testPresentRowsAndRequiredFields()
testSharedRoomIdentity()
testTemporaryIdentityReuseAndUpgrade()
testSourceAliasAndPhysicalIdentityMatching()
testEmbeddedIdentityAliasesAreDeterministicAndRecoverable()
testRentedEventIdempotencyAndReappearance()
testLifecycleVersionOnlyAdvancesOnBusinessTransitions()
testBaselineAndFailClosedBoundaries()
testDuplicateAndAmbiguousIdentityBlocksWholePlan()
testResponsibilityAndStatusPrecedence()

console.log('飞书房源生命周期测试通过')
