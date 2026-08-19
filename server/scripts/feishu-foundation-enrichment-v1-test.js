'use strict'

const assert = require('assert')
const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  planFoundationEnrichment
} = require('../src/feishu-foundation-enrichment')
const config = require('../src/config')
const feishuSync = require('../src/feishu-sync')
const enrichmentCli = require('./feishu-foundation-enrich')

function snapshot(records, overrides = {}) {
  return {
    complete: true,
    recordCount: records.length,
    records,
    ...overrides
  }
}

function current(recordId, sourceRecordId, rentMode, overrides = {}) {
  const temporaryListingId = `TMP-${sourceRecordId}`
  return {
    recordId,
    fields: {
      foundationListingId: temporaryListingId,
      sourceRecordId,
      rentMode,
      yuxiaoerListingId: '',
      yuxiaoerRoomId: '',
      temporaryListingId,
      identityType: 'temporary',
      identityAliases: JSON.stringify([
        { aliasType: 'sourceRecord', aliasValue: sourceRecordId },
        { aliasType: 'temporary', aliasValue: temporaryListingId }
      ]),
      lifecycleVersion: 1,
      listingOwner: '',
      ownerDepartment: '',
      lifecycleStatusText: '待出租',
      availabilityCycleNo: 1,
      availabilityCycleId: `${temporaryListingId}:available:1`,
      sourcePresent: true,
      published: true,
      enabled: true,
      ...overrides
    }
  }
}

function mapping(sourceRecordId, overrides = {}) {
  return {
    sourceRecordId,
    yuxiaoerListingId: 'listing-default',
    yuxiaoerRoomId: '',
    listingOwner: '',
    ownerDepartment: '',
    ...overrides
  }
}

function operationFor(plan, sourceRecordId) {
  return plan.updateOperations.find((item) => item.sourceRecordId === sourceRecordId)
}

function expectedAliasText(sourceRecordId, listingId, roomId = '') {
  const yuxiaoer = roomId
    ? `YX2:${listingId}:${roomId}`
    : `YX2:${listingId}:WHOLE`
  return JSON.stringify([
    { aliasType: 'sourceRecord', aliasValue: sourceRecordId },
    { aliasType: 'temporary', aliasValue: `TMP-${sourceRecordId}` },
    { aliasType: 'yuxiaoer', aliasValue: yuxiaoer }
  ])
}

function testPlansOnlyWhitelistedCurrentTableUpdates() {
  const currentStateSnapshot = snapshot([
    current('cur-whole', 'src-whole', '整租', {
      community: '不会进入更新补丁'
    }),
    current('cur-shared', 'src-shared', '合租'),
    current('cur-unlisted', 'src-unlisted', '整租')
  ])
  const before = JSON.parse(JSON.stringify(currentStateSnapshot))
  const plan = planFoundationEnrichment({
    privateMappings: [
      mapping('src-whole', {
        yuxiaoerListingId: ' listing-whole ',
        listingOwner: ' 负责人甲 ',
        ownerDepartment: ' 运营一部 '
      }),
      mapping('src-shared', {
        yuxiaoerListingId: 'listing-shared',
        yuxiaoerRoomId: 'room-A',
        listingOwner: '负责人乙',
        ownerDepartment: '运营二部'
      })
    ],
    currentStateSnapshot
  })

  assert.strictEqual(plan.target, 'currentState', '计划只能面向当前主档表')
  assert.strictEqual(plan.updateOperations.length, 2, '仅映射中列出的两条房源可以生成更新')
  assert.deepStrictEqual(
    operationFor(plan, 'src-whole'),
    {
      type: 'update',
      target: 'currentState',
      recordId: 'cur-whole',
      sourceRecordId: 'src-whole',
      fields: {
        yuxiaoerListingId: 'listing-whole',
        yuxiaoerRoomId: '',
        identityType: 'yuxiaoer',
        listingOwner: '负责人甲',
        ownerDepartment: '运营一部',
        identityAliases: expectedAliasText('src-whole', 'listing-whole'),
        lifecycleVersion: 2
      }
    },
    '整租只能补入房源 ID + WHOLE 语义和责任字段'
  )
  assert.deepStrictEqual(
    operationFor(plan, 'src-shared').fields,
    {
      yuxiaoerListingId: 'listing-shared',
      yuxiaoerRoomId: 'room-A',
      identityType: 'yuxiaoer',
      listingOwner: '负责人乙',
      ownerDepartment: '运营二部',
      identityAliases: expectedAliasText('src-shared', 'listing-shared', 'room-A'),
      lifecycleVersion: 2
    },
    '合租必须补入房源 ID + 房间 ID 和责任字段'
  )
  assert.strictEqual(operationFor(plan, 'src-unlisted'), undefined, '未列出的临时房源必须保持不动')
  assert.deepStrictEqual(currentStateSnapshot, before, '纯计划函数不得修改输入快照')
}

function testIdempotentAndBlankResponsibilityDoesNotClear() {
  const plan = planFoundationEnrichment({
    privateMappings: [
      mapping('src-existing', {
        yuxiaoerListingId: 'listing-existing',
        listingOwner: '',
        ownerDepartment: ''
      })
    ],
    currentStateSnapshot: snapshot([
      current('cur-existing', 'src-existing', '整租', {
        yuxiaoerListingId: 'listing-existing',
        identityType: 'yuxiaoer',
        identityAliases: expectedAliasText('src-existing', 'listing-existing'),
        listingOwner: '既有负责人',
        ownerDepartment: '既有部门'
      })
    ])
  })
  assert.strictEqual(plan.updateOperations.length, 0, '相同身份且映射责任字段为空时不得清空既有值')
  assert.strictEqual(plan.noop, true, '无实际补全内容时必须是 no-op')
}

function testStrictPrivateMappingShapeAndNoSensitiveEcho() {
  const secretSentinel = '禁止回显的敏感值'
  let thrown
  try {
    planFoundationEnrichment({
      privateMappings: [{
        ...mapping('src-1'),
        tenantName: secretSentinel
      }],
      currentStateSnapshot: snapshot([current('cur-1', 'src-1', '整租')])
    })
  } catch (error) {
    thrown = error
  }
  assert(thrown, '白名单外字段必须整批阻断')
  assert.match(thrown.message, /字段|白名单|允许/, '错误应明确指出输入字段越界')
  assert(!thrown.message.includes(secretSentinel), '错误不得回显白名单外字段的值')

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [{
        sourceRecordId: 'src-1',
        yuxiaoerListingId: 'listing-1',
        yuxiaoerRoomId: '',
        listingOwner: ''
      }],
      currentStateSnapshot: snapshot([current('cur-1', 'src-1', '整租')])
    }),
    /ownerDepartment|字段/,
    '五个白名单字段必须全部显式提供'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-1')],
      currentStateSnapshot: snapshot([current('cur-1', 'src-1', '整租')]),
      tenantRecords: [secretSentinel]
    }),
    /参数|白名单|允许/,
    '顶层输入也只能包含私有映射和当前主档快照'
  )
}

function testIdentityRulesAndUniqueness() {
  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [
        mapping('src-1', { yuxiaoerListingId: 'listing-1' }),
        mapping(' src-1 ', { yuxiaoerListingId: 'listing-2' })
      ],
      currentStateSnapshot: snapshot([
        current('cur-1', 'src-1', '整租'),
        current('cur-2', 'src-2', '整租')
      ])
    }),
    /sourceRecordId.*重复|重复.*sourceRecordId/i,
    '映射 sourceRecordId 必须规范化后唯一'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [
        mapping('src-1', { yuxiaoerListingId: 'listing-1' }),
        mapping('src-2', { yuxiaoerListingId: 'listing-1' })
      ],
      currentStateSnapshot: snapshot([
        current('cur-1', 'src-1', '整租'),
        current('cur-2', 'src-2', '整租')
      ])
    }),
    /真实身份.*重复|重复.*真实身份/,
    '两条映射不得占用同一个寓小二真实身份'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-whole', {
        yuxiaoerListingId: 'listing-1',
        yuxiaoerRoomId: 'room-should-be-empty'
      })],
      currentStateSnapshot: snapshot([current('cur-whole', 'src-whole', '整租')])
    }),
    /整租.*房间 ID|整租.*WHOLE/,
    '整租映射不得携带房间 ID'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-shared', {
        yuxiaoerListingId: 'listing-1',
        yuxiaoerRoomId: ''
      })],
      currentStateSnapshot: snapshot([current('cur-shared', 'src-shared', '合租')])
    }),
    /合租.*房间 ID/,
    '合租映射必须同时提供房源 ID 和房间 ID'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-whole', {
        yuxiaoerListingId: Number.MAX_SAFE_INTEGER + 1
      })],
      currentStateSnapshot: snapshot([current('cur-whole', 'src-whole', '整租')])
    }),
    /安全整数|文本|有效值/,
    '超过 JavaScript 安全整数范围的数字 ID 必须在规范化前阻断'
  )
}

function testNoAddressGuessingAndCurrentSnapshotIntegrity() {
  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-missing')],
      currentStateSnapshot: snapshot([
        current('cur-other', 'src-other', '整租', {
          physicalUnitKey: '与映射地址相同也不能猜'
        })
      ])
    }),
    /未命中.*sourceRecordId|sourceRecordId.*(?:未命中|不存在)/,
    '只能按 sourceRecordId 命中，不得按地址或其他字段猜测'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-1')],
      currentStateSnapshot: snapshot([
        current('cur-1', 'src-1', '整租'),
        current('cur-2', ' src-1 ', '整租')
      ])
    }),
    /当前主档.*sourceRecordId.*重复|sourceRecordId.*重复/,
    '当前主档 sourceRecordId 歧义必须整批阻断'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-1')],
      currentStateSnapshot: snapshot(
        [current('cur-1', 'src-1', '整租')],
        { complete: false }
      )
    }),
    /当前主档.*不完整|完整快照/,
    '当前主档不完整时不得生成补全计划'
  )
}

function testIdentityConflictsBlockButResponsibilityChangesAreAudited() {
  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-1', { yuxiaoerListingId: 'listing-new' })],
      currentStateSnapshot: snapshot([
        current('cur-1', 'src-1', '整租', {
          yuxiaoerListingId: 'listing-old',
          identityType: 'yuxiaoer'
        })
      ])
    }),
    /身份.*冲突|房源 ID.*冲突/,
    '现有真实身份与映射不一致时必须整批阻断'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-1', { yuxiaoerListingId: 'listing-used' })],
      currentStateSnapshot: snapshot([
        current('cur-1', 'src-1', '整租'),
        current('cur-used', 'src-used', '整租', {
          yuxiaoerListingId: 'listing-used',
          identityType: 'yuxiaoer'
        })
      ])
    }),
    /真实身份.*占用|真实身份.*重复|身份.*冲突/,
    '真实身份已归属另一主档记录时必须整批阻断'
  )

  assert.throws(
    () => planFoundationEnrichment({
      privateMappings: [mapping('src-1', { yuxiaoerListingId: 'listing-alias-used' })],
      currentStateSnapshot: snapshot([
        current('cur-1', 'src-1', '整租'),
        current('cur-alias-used', 'src-alias-used', '整租', {
          identityAliases: JSON.stringify([
            { aliasType: 'sourceRecord', aliasValue: 'src-alias-used' },
            { aliasType: 'temporary', aliasValue: 'TMP-src-alias-used' },
            { aliasType: 'yuxiaoer', aliasValue: 'YX2:listing-alias-used:WHOLE' }
          ])
        })
      ])
    }),
    /真实身份.*占用|真实身份.*重复|身份.*冲突/,
    '即使另一主档只在历史别名中占用真实身份，也必须整批阻断重复归属'
  )

  const responsibilityPlan = planFoundationEnrichment({
    privateMappings: [mapping('src-1', {
      yuxiaoerListingId: 'listing-1',
      listingOwner: '负责人乙',
      ownerDepartment: '部门乙'
    })],
    currentStateSnapshot: snapshot([
      current('cur-1', 'src-1', '整租', {
        listingOwner: '负责人甲',
        ownerDepartment: '部门甲',
        lifecycleVersion: 7
      })
    ])
  })
  const responsibilityOperation = operationFor(responsibilityPlan, 'src-1')
  assert.strictEqual(
    responsibilityOperation.fields.lifecycleVersion,
    8,
    '负责人或部门真实变化必须推进生命周期版本'
  )
  assert.strictEqual(
    responsibilityOperation.fields.listingOwner,
    '负责人乙',
    '合同白名单补全允许负责人发生可审计交接'
  )
  assert.strictEqual(
    responsibilityOperation.fields.ownerDepartment,
    '部门乙',
    '合同白名单补全允许所属部门发生可审计交接'
  )
}

async function testExecuteEnrichmentWritesOnlyTargetCurrentTableAndReadsBack() {
  const records = [
    current('cur-1', 'src-1', '整租', {
      community: '不可覆盖的小区'
    })
  ]
  const historyRecords = []
  const calls = []
  let discardHistoryCreates = false
  const fieldNames = {
    sourceRecordId: '源记录ID',
    rentMode: '出租方式',
    yuxiaoerListingId: '寓小二房源ID',
    yuxiaoerRoomId: '寓小二房间ID',
    identityType: '身份类型',
    identityAliases: '身份别名',
    lifecycleVersion: '生命周期版本',
    listingOwner: '房源负责人',
    ownerDepartment: '所属部门'
  }
  const historyFieldNames = {
    historyEventId: '流水事件ID',
    foundationListingId: '底座房源ID',
    sourceRecordId: '源记录ID',
    availabilityCycleNo: '待租周期号',
    availabilityCycleId: '待租周期ID',
    eventType: '事件类型',
    fromLifecycleStatusText: '原生命周期状态',
    toLifecycleStatusText: '新生命周期状态',
    eventAt: '事件时间',
    runId: '同步批次ID',
    listingOwner: '房源负责人',
    ownerDepartment: '所属部门',
    lifecycleVersion: '生命周期版本'
  }
  const targetClient = {
    async readValidatedTableSnapshot({ tableId }) {
      calls.push({ action: 'read', tableId })
      if (['tbl-current', 'tbl-current-alternate'].includes(tableId)) {
        return {
          ...snapshot(JSON.parse(JSON.stringify(records))),
          fieldNames
        }
      }
      assert.ok(
        ['tbl-history', 'tbl-history-alternate'].includes(tableId),
        '补全链路除当前主档外只允许读取状态流水'
      )
      return {
        ...snapshot(JSON.parse(JSON.stringify(historyRecords))),
        fieldNames: historyFieldNames
      }
    },
    async batchCreateRecords(tableId, creates) {
      calls.push({ action: 'create', tableId, records: JSON.parse(JSON.stringify(creates)) })
      assert.strictEqual(tableId, 'tbl-history', '补全产生的事实事件只能追加到状态流水')
      if (discardHistoryCreates) return creates
      creates.forEach((create) => {
        const fields = {}
        Object.entries(create.fields).forEach(([fieldName, value]) => {
          const semantic = Object.keys(historyFieldNames).find((key) => historyFieldNames[key] === fieldName)
          assert(semantic, `状态流水不得写入契约外字段：${fieldName}`)
          fields[semantic] = value
        })
        historyRecords.push({
          recordId: `history-${historyRecords.length + 1}`,
          fields
        })
      })
      return creates
    },
    async batchUpdateRecords(tableId, updates) {
      calls.push({ action: 'update', tableId, records: JSON.parse(JSON.stringify(updates)) })
      assert.strictEqual(tableId, 'tbl-current', '补全链路只能更新目标当前主档')
      updates.forEach((update) => {
        const record = records.find((item) => item.recordId === update.record_id)
        assert(record, '更新必须命中现有当前主档 recordId')
        Object.entries(update.fields).forEach(([fieldName, value]) => {
          const semantic = Object.keys(fieldNames).find((key) => fieldNames[key] === fieldName)
          assert(semantic, `不得写入契约外字段：${fieldName}`)
          record.fields[semantic] = value
        })
      })
      return updates
    }
  }
  const privateMappings = [mapping('src-1', {
    yuxiaoerListingId: 'listing-1',
    listingOwner: '负责人甲',
    ownerDepartment: '部门甲'
  })]
  await assert.rejects(
    feishuSync._internal.executeFoundationEnrichment({
      targetClient,
      targetBaseToken: 'target-base-token-for-test',
      miniTableId: 'tbl-current',
      miniBindings: {},
      historyTableId: 'tbl-history',
      historyBindings: {},
      privateMappings,
      mappingSha256: 'a'.repeat(64),
      dryRun: false
    }),
    /确认.*计划摘要|confirm|dry-run.*摘要/,
    '任何直接正式调用也必须显式确认 dry-run 的实际计划摘要'
  )
  assert.strictEqual(calls.length, 0, '缺少计划确认时必须在读取飞书前阻断')

  const dryRun = await feishuSync._internal.executeFoundationEnrichment({
    targetClient,
    targetBaseToken: 'target-base-token-for-test',
    miniTableId: 'tbl-current',
    miniBindings: {},
    historyTableId: 'tbl-history',
    historyBindings: {},
    privateMappings,
    mappingSha256: 'a'.repeat(64),
    runId: 'enrichment-test-run',
    nowMs: Date.parse('2026-07-24T08:00:00.000Z'),
    dryRun: true
  })
  assert.strictEqual(dryRun.updateCount, 1, 'dry-run 必须返回一条补全计划')
  assert.strictEqual(dryRun.historyAppendCount, 1, '负责人补全必须规划一条责任归属流水')
  assert.match(dryRun.planSha256, /^[0-9a-f]{64}$/, 'dry-run 必须返回绑定当前快照的计划摘要')
  assert.strictEqual(
    calls.filter((call) => ['create', 'update'].includes(call.action)).length,
    0,
    'dry-run 必须零写'
  )

  records[0].fields.community = '当前快照已变化'
  await assert.rejects(
    feishuSync._internal.executeFoundationEnrichment({
      targetClient,
      targetBaseToken: 'target-base-token-for-test',
      miniTableId: 'tbl-current',
      miniBindings: {},
      historyTableId: 'tbl-history',
      historyBindings: {},
      privateMappings,
      mappingSha256: 'a'.repeat(64),
      confirmPlanSha256: dryRun.planSha256,
      runId: 'enrichment-test-run',
      nowMs: Date.parse('2026-07-24T08:00:01.000Z'),
      dryRun: false
    }),
    /计划摘要|快照.*变化|摘要不匹配/,
    'dry-run 后当前主档任一业务值变化都必须在首笔写前阻断'
  )
  assert.strictEqual(
    calls.filter((call) => ['create', 'update'].includes(call.action)).length,
    0,
    '计划摘要不匹配时状态流水和当前主档都必须零写'
  )
  records[0].fields.community = '不可覆盖的小区'

  historyRecords.push({
    recordId: 'history-snapshot-drift',
    fields: {
      historyEventId: 'HIST-UNRELATED-DRIFT',
      foundationListingId: 'OTHER',
      sourceRecordId: '',
      availabilityCycleNo: 1,
      availabilityCycleId: 'OTHER:available:1',
      eventType: '房态变化',
      fromLifecycleStatusText: '待出租',
      toLifecycleStatusText: '即将空出',
      eventAt: Date.parse('2026-07-24T07:59:00.000Z'),
      runId: 'other-run',
      listingOwner: '',
      ownerDepartment: '',
      lifecycleVersion: 2
    }
  })
  await assert.rejects(
    feishuSync._internal.executeFoundationEnrichment({
      targetClient,
      targetBaseToken: 'target-base-token-for-test',
      miniTableId: 'tbl-current',
      miniBindings: {},
      historyTableId: 'tbl-history',
      historyBindings: {},
      privateMappings,
      mappingSha256: 'a'.repeat(64),
      confirmPlanSha256: dryRun.planSha256,
      runId: 'enrichment-test-run',
      nowMs: Date.parse('2026-07-24T08:00:01.000Z'),
      dryRun: false
    }),
    /计划摘要|快照.*变化|摘要不匹配/,
    'dry-run 后状态流水快照变化也必须在首笔写前阻断'
  )
  historyRecords.pop()

  await assert.rejects(
    feishuSync._internal.executeFoundationEnrichment({
      targetClient,
      targetBaseToken: 'different-target-base-token',
      miniTableId: 'tbl-current',
      miniBindings: {},
      historyTableId: 'tbl-history',
      historyBindings: {},
      privateMappings,
      mappingSha256: 'a'.repeat(64),
      confirmPlanSha256: dryRun.planSha256,
      runId: 'enrichment-test-run',
      nowMs: Date.parse('2026-07-24T08:00:01.000Z'),
      dryRun: false
    }),
    /计划摘要|快照.*变化|摘要不匹配/,
    'dry-run 摘要必须绑定目标 Base，不能跨 Base 复用'
  )
  for (const [overrides, message] of [
    [{ mappingSha256: 'b'.repeat(64) }, '映射原始字节摘要'],
    [{ miniTableId: 'tbl-current-alternate' }, '当前主档表资源'],
    [{ historyTableId: 'tbl-history-alternate' }, '状态流水表资源']
  ]) {
    await assert.rejects(
      feishuSync._internal.executeFoundationEnrichment({
        targetClient,
        targetBaseToken: 'target-base-token-for-test',
        miniTableId: 'tbl-current',
        miniBindings: {},
        historyTableId: 'tbl-history',
        historyBindings: {},
        privateMappings,
        mappingSha256: 'a'.repeat(64),
        confirmPlanSha256: dryRun.planSha256,
        runId: 'enrichment-test-run',
        nowMs: Date.parse('2026-07-24T08:00:01.000Z'),
        dryRun: false,
        ...overrides
      }),
      /计划摘要|快照.*变化|摘要不匹配/,
      `dry-run 摘要必须绑定${message}`
    )
  }
  assert.strictEqual(
    calls.filter((call) => ['create', 'update'].includes(call.action)).length,
    0,
    '任一快照或目标资源摘要不匹配时必须保持两表零写'
  )

  const freshDryRun = await feishuSync._internal.executeFoundationEnrichment({
    targetClient,
    targetBaseToken: 'target-base-token-for-test',
    miniTableId: 'tbl-current',
    miniBindings: {},
    historyTableId: 'tbl-history',
    historyBindings: {},
    privateMappings,
    mappingSha256: 'a'.repeat(64),
    runId: 'enrichment-test-run',
    nowMs: Date.parse('2026-07-24T08:00:02.000Z'),
    dryRun: true
  })
  discardHistoryCreates = true
  await assert.rejects(
    feishuSync._internal.executeFoundationEnrichment({
      targetClient,
      targetBaseToken: 'target-base-token-for-test',
      miniTableId: 'tbl-current',
      miniBindings: {},
      historyTableId: 'tbl-history',
      historyBindings: {},
      privateMappings,
      mappingSha256: 'a'.repeat(64),
      confirmPlanSha256: freshDryRun.planSha256,
      runId: 'enrichment-test-run',
      nowMs: Date.parse('2026-07-24T08:00:03.000Z'),
      dryRun: false
    }),
    /状态流水.*写后回读不一致/,
    '流水创建接口返回成功但回读不可见时必须阻断当前主档更新'
  )
  assert.strictEqual(
    calls.filter((call) => call.action === 'update').length,
    0,
    '流水尚未真实落盘并回读时当前主档必须零写'
  )
  discardHistoryCreates = false
  calls.length = 0

  const applied = await feishuSync._internal.executeFoundationEnrichment({
    targetClient,
    targetBaseToken: 'target-base-token-for-test',
    miniTableId: 'tbl-current',
    miniBindings: {},
    historyTableId: 'tbl-history',
    historyBindings: {},
    privateMappings,
    mappingSha256: 'a'.repeat(64),
    confirmPlanSha256: freshDryRun.planSha256,
    runId: 'enrichment-test-run',
    nowMs: Date.parse('2026-07-24T08:00:03.000Z'),
    dryRun: false
  })
  assert.strictEqual(applied.remainingUpdateCount, 0, '正式补全必须写后回读为 no-op')
  const currentWrites = calls.filter((call) => call.action === 'update' && call.tableId === 'tbl-current')
  const historyWrites = calls.filter((call) => call.action === 'create' && call.tableId === 'tbl-history')
  assert.strictEqual(currentWrites.length, 1, '正式补全只允许一批目标当前主档更新')
  assert.strictEqual(historyWrites.length, 1, '责任变化必须先追加一条状态流水')
  assert.deepStrictEqual(
    Object.keys(currentWrites[0].records[0].fields).sort(),
    [
      '寓小二房源ID',
      '寓小二房间ID',
      '房源负责人',
      '所属部门',
      '身份类型',
      '身份别名',
      '生命周期版本'
    ].sort(),
    '补全写入必须严格限制为身份、责任、别名和版本字段'
  )
  assert.strictEqual(historyRecords[0].fields.eventType, '责任归属变化', '补全责任字段必须留下事实流水')
  assert.strictEqual(historyRecords[0].fields.lifecycleVersion, 2, '流水与当前主档必须使用同一新版本')
  assert.ok(
    calls.findIndex((call) => call.action === 'create' && call.tableId === 'tbl-history') <
      calls.findIndex((call) => call.action === 'update' && call.tableId === 'tbl-current'),
    '正式补全必须先写并回读流水，再更新当前主档'
  )
  assert.strictEqual(records[0].fields.community, '不可覆盖的小区', '补全不得改写当前主档其他业务字段')
}

async function testPrivateMappingCliRequiresDryRunDigestBeforeApply() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-foundation-enrichment-'))
  const mappingPath = path.join(tempDir, 'private-mapping.json')
  const privateMappings = [mapping('src-cli', {
    yuxiaoerListingId: 'listing-cli',
    listingOwner: '合成负责人',
    ownerDepartment: '合成部门'
  })]
  fs.writeFileSync(mappingPath, JSON.stringify(privateMappings), { encoding: 'utf8', flag: 'wx' })
  try {
    const calls = []
    const lines = []
    const execute = async (options) => {
      calls.push(JSON.parse(JSON.stringify(options)))
      const planSha256 = crypto.createHash('sha256')
        .update(`synthetic-plan:${options.mappingSha256}`)
        .digest('hex')
      if (options.dryRun === false && options.confirmPlanSha256 !== planSha256) {
        throw new Error('身份责任补全计划摘要不匹配')
      }
      return {
        dryRun: options.dryRun,
        mappingCount: 1,
        updateCount: 1,
        historyAppendCount: 1,
        unchangedCount: 0,
        skippedCurrentCount: 0,
        remainingUpdateCount: options.dryRun ? undefined : 0,
        planSha256,
        noop: false
      }
    }
    const dryRun = await enrichmentCli.runCli([
      '--mapping',
      mappingPath
    ], {
      execute,
      writeLine(value) {
        lines.push(value)
      }
    })
    assert.strictEqual(dryRun.mode, 'dry-run', 'CLI 默认必须只预演')
    assert.match(dryRun.mappingSha256, /^[0-9a-f]{64}$/, 'dry-run 必须返回私有映射摘要')
    assert.match(dryRun.planSha256, /^[0-9a-f]{64}$/, 'dry-run 必须返回绑定目标快照与写入计划的摘要')
    assert.strictEqual(calls[0].dryRun, true, 'dry-run 不得误传正式写开关')
    assert.strictEqual(calls[0].mappingSha256, dryRun.mappingSha256, '映射原始字节摘要必须传入计划层')
    assert.strictEqual(lines.length, 1, 'CLI 只输出一条脱敏汇总')
    assert.strictEqual(lines[0].includes('合成负责人'), false, 'CLI 汇总不得输出负责人')
    assert.strictEqual(lines[0].includes('listing-cli'), false, 'CLI 汇总不得输出寓小二 ID')
    assert.throws(
      () => enrichmentCli.parseCliArgs([
        '--mapping',
        mappingPath,
        '--secret-like-unknown-argument'
      ]),
      (error) => (
        /未知参数/.test(error.message) &&
        !error.message.includes('secret-like-unknown-argument')
      ),
      '未知 CLI 参数不得把可能的敏感值回显到错误信息'
    )
    const missingPrivatePath = path.join(tempDir, 'private-sensitive-name-not-found.json')
    assert.throws(
      () => enrichmentCli.assertPrivateMappingPath(missingPrivatePath),
      (error) => (
        /无法安全核验/.test(error.message) &&
        !error.message.includes(missingPrivatePath)
      ),
      '私有映射路径核验失败不得回显仓库外绝对路径'
    )

    assert.throws(
      () => enrichmentCli.parseCliArgs(['--mapping', mappingPath, '--apply']),
      /confirm-sha256|摘要/,
      '正式补全缺少 dry-run 摘要必须在读文件和访问飞书前阻断'
    )
    const applied = await enrichmentCli.runCli([
      '--mapping',
      mappingPath,
      '--apply',
      '--confirm-sha256',
      dryRun.planSha256
    ], {
      execute,
      writeLine() {}
    })
    assert.strictEqual(applied.mode, 'apply', '摘要一致后才允许正式补全')
    assert.strictEqual(calls[1].dryRun, false, '正式补全必须显式传入 dryRun=false')
    assert.strictEqual(
      calls[1].confirmPlanSha256,
      dryRun.planSha256,
      '正式补全必须把用户确认的计划摘要传给实际执行层'
    )

    fs.writeFileSync(mappingPath, `${JSON.stringify(privateMappings)}\n`, 'utf8')
    await assert.rejects(
      enrichmentCli.runCli([
        '--mapping',
        mappingPath,
        '--apply',
        '--confirm-sha256',
        dryRun.planSha256
      ], { execute, writeLine() {} }),
      /摘要不匹配|已变化/,
      'dry-run 后私有映射任一字节变化都必须拒绝正式补全'
    )

    const sentinel = 'PRIVATE-CONTROL-INJECTION'
    const spawned = childProcess.spawnSync(process.execPath, [
      path.join(__dirname, 'feishu-foundation-enrich.js'),
      '--mapping',
      mappingPath,
      `--unknown\n${sentinel}\u001b[31m`
    ], {
      encoding: 'utf8',
      windowsHide: true
    })
    assert.notStrictEqual(spawned.status, 0, '未知参数必须返回失败退出码')
    assert.strictEqual(spawned.stderr.includes(sentinel), false, 'CLI stderr 不得回显未知参数或控制字符载荷')
    assert.strictEqual(/\u001b|\r(?!\n)|\n.+\n.+/.test(spawned.stderr), false, 'CLI 错误必须是单行固定安全文案')

    const executionSentinel = 'PRIVATE-MAPPING-EXECUTION-LEAK'
    const preloadPath = path.join(tempDir, 'preload-enrichment-error.js')
    const syncModulePath = path.resolve(__dirname, '..', 'src', 'feishu-sync.js')
    fs.writeFileSync(preloadPath, [
      "'use strict'",
      `const sync = require(${JSON.stringify(syncModulePath)})`,
      'sync.configuredFoundationEnrichment = async function syntheticFailure() {',
      `  throw new Error(${JSON.stringify(`sourceRecordId 重复：${executionSentinel}\n\u001b[31m负责人私密值`)})`,
      '}'
    ].join('\n'), { encoding: 'utf8', flag: 'wx' })
    const executionFailure = childProcess.spawnSync(process.execPath, [
      '-r',
      preloadPath,
      path.join(__dirname, 'feishu-foundation-enrich.js'),
      '--mapping',
      mappingPath
    ], {
      encoding: 'utf8',
      windowsHide: true
    })
    assert.notStrictEqual(executionFailure.status, 0, '真实执行函数抛错必须返回失败退出码')
    assert.strictEqual(
      executionFailure.stderr,
      '飞书身份责任补全失败：私有映射内容未通过安全校验\n',
      '真实子进程的映射业务错误必须收敛为单行固定安全分类'
    )
    assert.strictEqual(
      executionFailure.stderr.includes(executionSentinel),
      false,
      '真实执行异常不得回显源记录、负责人或控制字符载荷'
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function testConfiguredEnrichmentRejectsUnsafeResourcesBeforeRead() {
  const previous = {
    sourceCompatibilityProfile: config.feishu.sourceCompatibilityProfile,
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    sourceBitableAppToken: config.feishu.sourceBitableAppToken,
    targetBitableAppToken: config.feishu.targetBitableAppToken,
    crossBaseTokenPartial: config.feishu.crossBaseTokenPartial,
    sourceTableId: config.feishu.sourceTableId,
    miniTableId: config.feishu.miniTableId,
    historyTableId: config.feishu.historyTableId
  }
  let readCount = 0
  const targetClient = {
    async readValidatedTableSnapshot() {
      readCount += 1
      return snapshot([])
    }
  }
  try {
    Object.assign(config.feishu, {
      sourceCompatibilityProfile: 'employee-ai-foundation-v1',
      appId: 'synthetic-app',
      appSecret: 'synthetic-secret',
      sourceBitableAppToken: 'same-base',
      targetBitableAppToken: 'same-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-current',
      historyTableId: 'tbl-history'
    })
    await assert.rejects(
      feishuSync.configuredFoundationEnrichment({
        targetClient,
        feishuToken: 'synthetic-token',
        privateMappings: [],
        mappingSha256: 'a'.repeat(64),
        dryRun: true
      }),
      /源 Base.*目标 Base.*分离|员工源.*只读|资源边界/,
      '源 Base 与目标 Base 相同时必须在解析字段和读取飞书前阻断'
    )
    assert.strictEqual(readCount, 0, '资源边界失败不得读取或写入任何飞书表')
  } finally {
    Object.assign(config.feishu, previous)
  }
}

function testSafeErrorMessageUsesFixedSingleLineCategories() {
  const secret = 'PRIVATE-SOURCE-ID'
  const unsafe = new Error(`sourceRecordId 重复：${secret}\n\u001b[31mTOKEN`)
  const safe = enrichmentCli.safeErrorMessage(unsafe)
  assert.strictEqual(safe, '私有映射内容未通过安全校验', '映射业务错误只能输出固定安全分类')
  assert.strictEqual(safe.includes(secret), false, '安全错误分类不得回显源记录 ID')
  assert.strictEqual(/[\u0000-\u001f\u007f-\u009f]/.test(safe), false, '安全错误分类不得包含控制字符')
}

async function main() {
  testPlansOnlyWhitelistedCurrentTableUpdates()
  testIdempotentAndBlankResponsibilityDoesNotClear()
  testStrictPrivateMappingShapeAndNoSensitiveEcho()
  testIdentityRulesAndUniqueness()
  testNoAddressGuessingAndCurrentSnapshotIntegrity()
  testIdentityConflictsBlockButResponsibilityChangesAreAudited()
  await testExecuteEnrichmentWritesOnlyTargetCurrentTableAndReadsBack()
  await testPrivateMappingCliRequiresDryRunDigestBeforeApply()
  await testConfiguredEnrichmentRejectsUnsafeResourcesBeforeRead()
  testSafeErrorMessageUsesFixedSingleLineCategories()
  console.log('飞书数据底座身份责任补全测试通过')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
