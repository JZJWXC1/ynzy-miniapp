'use strict'

const assert = require('assert')
const path = require('path')
const { spawnSync } = require('child_process')

const config = require('../src/config')
const feishuSync = require('../src/feishu-sync')

const repoRoot = path.resolve(__dirname, '..', '..')
const EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE = 'employee-current-stock-v1'
const EMPLOYEE_AI_FOUNDATION_PROFILE = 'employee-ai-foundation-v1'

function configTokens(envOverrides) {
  const env = {
    ...process.env,
    FEISHU_BITABLE_APP_TOKEN: '',
    FEISHU_SOURCE_BITABLE_APP_TOKEN: '',
    FEISHU_TARGET_BITABLE_APP_TOKEN: '',
    FEISHU_SOURCE_COMPATIBILITY_PROFILE: '',
    ...envOverrides
  }
  const code = [
    "const config = require('./server/src/config')",
    'process.stdout.write(JSON.stringify({',
    'legacy: config.feishu.bitableAppToken,',
    'source: config.feishu.sourceBitableAppToken,',
    'target: config.feishu.targetBitableAppToken,',
    'partial: config.feishu.crossBaseTokenPartial',
    '}))'
  ].join('\n')
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: repoRoot,
    env,
    encoding: 'utf8'
  })
  assert.strictEqual(result.status, 0, `配置子进程必须成功：${result.stderr}`)
  return JSON.parse(result.stdout)
}

function configProfile(profile) {
  const result = spawnSync(process.execPath, ['-e', [
    "const config = require('./server/src/config')",
    'process.stdout.write(JSON.stringify(config.feishu.sourceCompatibilityProfile))'
  ].join('\n')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FEISHU_SOURCE_COMPATIBILITY_PROFILE: profile
    },
    encoding: 'utf8'
  })
  return result
}

function configTableIds(envOverrides) {
  const result = spawnSync(process.execPath, ['-e', [
    "const config = require('./server/src/config')",
    'process.stdout.write(JSON.stringify({',
    'source: config.feishu.sourceTableId,',
    'mini: config.feishu.miniTableId,',
    'location: config.feishu.locationTableId,',
    'rented: config.feishu.rentedTableId,',
    'history: config.feishu.historyTableId',
    '}))'
  ].join('\n')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FEISHU_BITABLE_TABLE_ID: '',
      FEISHU_SOURCE_TABLE_ID: '',
      FEISHU_MINI_TABLE_ID: '',
      FEISHU_LOCATION_TABLE_ID: '',
      FEISHU_RENTED_TABLE_ID: '',
      FEISHU_HISTORY_TABLE_ID: '',
      ...envOverrides
    },
    encoding: 'utf8'
  })
  assert.strictEqual(result.status, 0, `表资源配置子进程必须成功：${result.stderr}`)
  return JSON.parse(result.stdout)
}

function fieldBinding(fieldId, type, required) {
  return { fieldId, type, required }
}

function validBindings() {
  return {
    source: {
      community: fieldBinding('src-community', 1, true),
      roomLabel: fieldBinding('src-room-label', 1, true),
      layoutDescription: fieldBinding('src-layout', 1, true),
      monthlyRent: fieldBinding('src-rent', 2, true),
      rentMode: fieldBinding('src-rent-mode', 1, true),
      viewingMethod: fieldBinding('src-viewing-method', 1, false),
      remark: fieldBinding('src-remark', 1, false),
      listingStatus: fieldBinding('src-status', 1, true)
    },
    mini: {
      sourceRecordId: fieldBinding('mini-source-record', 1, true),
      locationId: fieldBinding('mini-location-id', 1, true),
      locationRecordId: fieldBinding('mini-location-record', 1, true),
      city: fieldBinding('mini-city', 1, true),
      district: fieldBinding('mini-district', 1, true),
      block: fieldBinding('mini-block', 1, true),
      community: fieldBinding('mini-community', 1, true),
      latitude: fieldBinding('mini-latitude', 2, true),
      longitude: fieldBinding('mini-longitude', 2, true),
      roomLabel: fieldBinding('mini-room-label', 1, true),
      building: fieldBinding('mini-building', 1, true),
      unit: fieldBinding('mini-unit', 1, false),
      roomNumber: fieldBinding('mini-room-number', 1, true),
      layoutDescription: fieldBinding('mini-layout', 1, true),
      layoutCategory: fieldBinding('mini-layout-category', 1, true),
      monthlyRent: fieldBinding('mini-rent', 2, true),
      rentMode: fieldBinding('mini-rent-mode', 1, true),
      viewingMethod: fieldBinding('mini-viewing-method', 1, false),
      viewingPassword: fieldBinding('mini-viewing-password', 1, false),
      remark: fieldBinding('mini-remark', 1, false),
      listingStatus: fieldBinding('mini-status', 1, true),
      published: fieldBinding('mini-published', 7, true),
      canonical: fieldBinding('mini-canonical', 7, true),
      enabled: fieldBinding('mini-enabled', 7, true)
    },
    location: {
      locationId: fieldBinding('loc-id', 1, true),
      city: fieldBinding('loc-city', 1, true),
      district: fieldBinding('loc-district', 1, true),
      block: fieldBinding('loc-block', 1, true),
      community: fieldBinding('loc-community', 1, true),
      latitude: fieldBinding('loc-latitude', 2, true),
      longitude: fieldBinding('loc-longitude', 2, true),
      enabled: fieldBinding('loc-enabled', 7, true)
    }
  }
}

function employeeSourceBindings() {
  const bindings = validBindings().source
  delete bindings.rentMode
  delete bindings.listingStatus
  bindings.layoutCategory = fieldBinding('src-layout-category', 1, false)
  return bindings
}

function snapshot(records, fieldNames = {}) {
  return {
    complete: true,
    records,
    recordCount: records.length,
    digest: `digest-${records.length}`,
    schemaFingerprint: 'schema-fingerprint',
    fieldNames
  }
}

function sourceSnapshot(overrides = {}) {
  return snapshot([{
    recordId: 'source-record-1',
    fields: {
      community: '风雅乐府',
      roomLabel: '风雅乐府 1幢1单元101',
      building: '1',
      unit: '1',
      roomNumber: '101',
      layoutDescription: '2室1厅',
      monthlyRent: 3200,
      rentMode: '整租',
      viewingMethod: '',
      remark: '',
      listingStatus: '可租',
      ...overrides
    }
  }])
}

function locationSnapshot() {
  return snapshot([{
    recordId: 'location-record-1',
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

function mirrorFieldNames() {
  return [
    'sourceRecordId', 'locationId', 'locationRecordId', 'city', 'district', 'block',
    'community', 'latitude', 'longitude', 'roomLabel', 'building', 'unit', 'roomNumber',
    'layoutDescription', 'layoutCategory', 'monthlyRent', 'rentMode', 'viewingMethod',
    'viewingPassword', 'remark', 'listingStatus', 'published', 'canonical', 'enabled'
  ].reduce((result, name) => {
    result[name] = name
    return result
  }, {})
}

function mirrorRecord(recordId, sourceRecordId, overrides = {}) {
  return {
    recordId,
    fields: {
      sourceRecordId,
      locationId: 'LOC-FENGYA',
      locationRecordId: 'location-record-1',
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
      viewingMethod: '',
      remark: '',
      listingStatus: '可租',
      published: true,
      canonical: true,
      enabled: true,
      ...overrides
    }
  }
}

function makeClients(options = {}) {
  const calls = []
  let mirrorRecords = JSON.parse(JSON.stringify(options.initialMirrorRecords || []))
  const sourceClient = {
    async readValidatedTableSnapshot(readOptions) {
      calls.push({
        client: 'source',
        action: 'read',
        tableId: readOptions.tableId,
        bindings: JSON.parse(JSON.stringify(readOptions.bindings || {})),
        excludedRecordSemantics: JSON.parse(JSON.stringify(readOptions.excludedRecordSemantics || []))
      })
      assert.strictEqual(readOptions.tableId, 'tbl-source', '源客户端只能读取员工源表')
      return options.sourceSnapshot || sourceSnapshot()
    },
    async batchCreateRecords() {
      calls.push({ client: 'source', action: 'create' })
      throw new Error('员工源表客户端禁止写入')
    },
    async batchUpdateRecords() {
      calls.push({ client: 'source', action: 'update' })
      throw new Error('员工源表客户端禁止写入')
    },
    async batchDeleteRecords() {
      calls.push({ client: 'source', action: 'delete' })
      throw new Error('员工源表客户端禁止删除')
    }
  }
  const targetClient = {
    writeDispatchEvidenceVersion: 1,
    async readValidatedTableSnapshot(readOptions) {
      calls.push({
        client: 'target',
        action: 'read',
        tableId: readOptions.tableId,
        bindings: JSON.parse(JSON.stringify(readOptions.bindings || {})),
        excludedRecordSemantics: JSON.parse(JSON.stringify(readOptions.excludedRecordSemantics || []))
      })
      if (readOptions.tableId === 'tbl-location') return locationSnapshot()
      assert.strictEqual(readOptions.tableId, 'tbl-mini', '目标客户端只能读取位置字典或专用表')
      return snapshot(mirrorRecords, mirrorFieldNames())
    },
    async batchCreateRecords(tableId, records, writeOptions = {}) {
      if (typeof writeOptions.onWriteDispatched === 'function') writeOptions.onWriteDispatched()
      calls.push({
        client: 'target',
        action: 'create',
        tableId,
        count: records.length,
        records: JSON.parse(JSON.stringify(records))
      })
      assert.strictEqual(tableId, 'tbl-mini', '目标新增只能写专用表')
      const created = records.map((record, index) => ({
        recordId: `mirror-record-${mirrorRecords.length + index + 1}`,
        fields: JSON.parse(JSON.stringify(record.fields))
      }))
      mirrorRecords.push(...created)
      return { records: created }
    },
    async batchUpdateRecords(tableId, records, writeOptions = {}) {
      if (typeof writeOptions.onWriteDispatched === 'function') writeOptions.onWriteDispatched()
      calls.push({
        client: 'target',
        action: 'update',
        tableId,
        records: JSON.parse(JSON.stringify(records))
      })
      assert.strictEqual(tableId, 'tbl-mini', '目标更新只能写专用表')
      const byRecordId = new Map(mirrorRecords.map((record) => [record.recordId, record]))
      records.forEach((record) => {
        const existing = byRecordId.get(record.record_id)
        assert.ok(existing, `目标更新必须命中已有专用表记录：${record.record_id}`)
        Object.assign(existing.fields, JSON.parse(JSON.stringify(record.fields)))
      })
      return { records }
    }
  }
  return {
    sourceClient,
    targetClient,
    calls,
    mirrorRecords: () => JSON.parse(JSON.stringify(mirrorRecords))
  }
}

function restore(target, snapshotValue) {
  Object.keys(target).forEach((key) => delete target[key])
  Object.assign(target, snapshotValue)
}

async function testTokenResolutionFailsClosed() {
  assert.deepStrictEqual(
    configTokens({ FEISHU_BITABLE_APP_TOKEN: 'legacy-app-token' }),
    {
      legacy: 'legacy-app-token',
      source: 'legacy-app-token',
      target: 'legacy-app-token',
      partial: false
    },
    '未启用新变量时必须完整兼容旧单 Base token'
  )
  assert.deepStrictEqual(
    configTokens({
      FEISHU_BITABLE_APP_TOKEN: 'legacy-app-token',
      FEISHU_SOURCE_BITABLE_APP_TOKEN: ' source-app-token ',
      FEISHU_TARGET_BITABLE_APP_TOKEN: '\ttarget-app-token\t'
    }),
    {
      legacy: 'legacy-app-token',
      source: 'source-app-token',
      target: 'target-app-token',
      partial: false
    },
    '源 Base 与目标 Base 必须分别解析'
  )
  assert.deepStrictEqual(
    configTokens({
      FEISHU_BITABLE_APP_TOKEN: 'legacy-app-token',
      FEISHU_SOURCE_BITABLE_APP_TOKEN: 'source-app-token'
    }),
    {
      legacy: 'legacy-app-token',
      source: 'source-app-token',
      target: '',
      partial: true
    },
    '只配置一个新 token 时不得偷偷回退旧 Base'
  )

  assert.deepStrictEqual(
    configTableIds({
      FEISHU_SOURCE_TABLE_ID: ' tbl-source ',
      FEISHU_MINI_TABLE_ID: '\ttbl-mini\t',
      FEISHU_LOCATION_TABLE_ID: ' tbl-location ',
      FEISHU_RENTED_TABLE_ID: ' tbl-rented ',
      FEISHU_HISTORY_TABLE_ID: '\ttbl-history\t'
    }),
    {
      source: 'tbl-source',
      mini: 'tbl-mini',
      location: 'tbl-location',
      rented: 'tbl-rented',
      history: 'tbl-history'
    },
    '五个表 ID 必须在资源比较和真实请求前统一去除前后空白'
  )
}

function testCompatibilityProfileConfigurationFailsClosed() {
  const empty = configProfile('')
  assert.strictEqual(empty.status, 0, `空兼容配置必须保持严格默认模式：${empty.stderr}`)
  assert.strictEqual(JSON.parse(empty.stdout), '', '默认不得静默启用员工现表兼容规则')

  const allowed = configProfile(EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE)
  assert.strictEqual(allowed.status, 0, `已批准兼容配置必须可解析：${allowed.stderr}`)
  assert.strictEqual(
    JSON.parse(allowed.stdout),
    EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
    '兼容配置必须原样进入飞书同步配置'
  )
  const aiFoundation = configProfile(EMPLOYEE_AI_FOUNDATION_PROFILE)
  assert.strictEqual(aiFoundation.status, 0, `AI 数据底座配置必须可解析：${aiFoundation.stderr}`)
  assert.strictEqual(
    JSON.parse(aiFoundation.stdout),
    EMPLOYEE_AI_FOUNDATION_PROFILE,
    'AI 数据底座配置必须原样进入飞书同步配置'
  )

  const unknown = configProfile('guess-current-stock-v2')
  assert.notStrictEqual(unknown.status, 0, '未知兼容配置必须在加载配置时 fail-closed')
  assert.match(
    `${unknown.stdout}\n${unknown.stderr}`,
    /FEISHU_SOURCE_COMPATIBILITY_PROFILE|兼容|employee-current-stock-v1|employee-ai-foundation-v1/i,
    '未知兼容配置错误必须指出允许值'
  )
}

function testSourceBindingContractOnlyRelaxesWithExplicitProfile() {
  const bindings = employeeSourceBindings()
  const strictState = feishuSync._internal.bindingContractStatus('source', bindings)
  assert.strictEqual(strictState.ready, false, '未启用兼容配置时缺出租方式、房源状态绑定必须失败')
  assert.ok(
    strictState.issues.includes('rentMode:missing') && strictState.issues.includes('listingStatus:missing'),
    '严格模式必须精确报告两项缺失绑定'
  )

  const compatibleState = feishuSync._internal.bindingContractStatus('source', bindings, {
    sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE
  })
  assert.strictEqual(compatibleState.ready, true, '只有显式员工现表兼容配置才允许省略两项绑定')

  const resolved = feishuSync._internal.resolvedContractBindings('source', bindings, {
    sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE
  })
  assert.strictEqual(resolved.rentMode, undefined, '缺失的出租方式不得伪造字段绑定')
  assert.strictEqual(resolved.listingStatus, undefined, '缺失的房源状态不得伪造字段绑定')
  assert.ok(
    Object.values(resolved).every((binding) => binding.required === false && binding.schemaRequired === true),
    '兼容读取必须允许识别全空模板行，同时所有已绑定列仍必须真实存在'
  )
}

function testEmployeeProfileRequiresSeparateReadOnlySourceBase() {
  const previous = JSON.parse(JSON.stringify(config.feishu))
  const bindings = validBindings()
  try {
    const baseConfiguration = {
      appId: 'app-id',
      appSecret: 'app-secret',
      sourceBitableAppToken: 'same-base-token',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-mini',
      locationTableId: 'tbl-location',
      sourceFieldBindings: employeeSourceBindings(),
      miniFieldBindings: bindings.mini,
      locationFieldBindings: bindings.location,
      sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
      folderToken: 'folder-token'
    }
    ;['same-base-token', ' same-base-token ', '\tsame-base-token\t'].forEach((targetToken) => {
      Object.assign(config.feishu, baseConfiguration, { targetBitableAppToken: targetToken })
      const state = feishuSync._internal.mirrorConfigurationStatus()
      assert.strictEqual(state.ready, false, '员工现表兼容模式不得把只读源 Base 同时当成写目标 Base')
      assert.strictEqual(
        state.sourceBaseReadOnlyBoundaryReady,
        false,
        '源/目标 token 仅有前后空白差异时也必须暴露明确的只读边界诊断'
      )
      config.feishu.mirrorSyncEnabled = true
      assert.strictEqual(
        feishuSync.status({}).sourceBaseReadOnlyBoundaryReady,
        false,
        '管理状态必须直接返回源 Base 只读边界，便于定位 profile 配置失败'
      )
    })
  } finally {
    restore(config.feishu, previous)
  }
}

async function testEmployeeProfileRequiresTargetViewingPasswordBeforeAnyRequest() {
  const previous = JSON.parse(JSON.stringify(config.feishu))
  try {
    for (const scenario of [
      {
        name: '漏配',
        mutate(miniBindings) {
          delete miniBindings.viewingPassword
        },
        issue: 'viewingPassword:missing'
      },
      {
        name: '类型错误',
        mutate(miniBindings) {
          miniBindings.viewingPassword = fieldBinding('mini-viewing-password', 2, false)
        },
        issue: 'viewingPassword:type'
      }
    ]) {
      const bindings = validBindings()
      scenario.mutate(bindings.mini)
      const clients = makeClients()
      Object.assign(config.feishu, {
        appId: 'app-id',
        appSecret: 'app-secret',
        sourceBitableAppToken: 'source-base',
        targetBitableAppToken: 'target-base',
        crossBaseTokenPartial: false,
        sourceTableId: 'tbl-source',
        miniTableId: 'tbl-mini',
        locationTableId: 'tbl-location',
        sourceFieldBindings: employeeSourceBindings(),
        miniFieldBindings: bindings.mini,
        locationFieldBindings: bindings.location,
        sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
        folderToken: 'folder-token'
      })

      const miniContract = feishuSync._internal.bindingContractStatus('mini', bindings.mini, {
        sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE
      })
      assert.strictEqual(miniContract.ready, false, `员工兼容 profile 下目标密码列${scenario.name}必须阻断配置`)
      assert.ok(
        miniContract.issues.includes(scenario.issue),
        `员工兼容 profile 下目标密码列${scenario.name}必须报告 ${scenario.issue}`
      )
      assert.strictEqual(
        feishuSync._internal.mirrorConfigurationStatus().ready,
        false,
        `员工兼容 profile 下目标密码列${scenario.name}不得进入可运行状态`
      )
      await assert.rejects(
        feishuSync._internal.configuredMirrorTableSync({
          feishuToken: 'tenant-token-for-test',
          dryRun: true,
          materials: [],
          sourceClient: clients.sourceClient,
          targetClient: clients.targetClient
        }),
        /专用源表 field_id|配置不完整|viewingPassword|密码/i,
        `员工兼容 profile 下目标密码列${scenario.name}必须在同步入口 fail-closed`
      )
      assert.deepStrictEqual(
        clients.calls,
        [],
        `员工兼容 profile 下目标密码列${scenario.name}必须在任何飞书 GET/POST 前失败`
      )
    }
  } finally {
    restore(config.feishu, previous)
  }
}

async function testResourceIdentityAndPartialConfiguration() {
  const previous = JSON.parse(JSON.stringify(config.feishu))
  const bindings = validBindings()
  try {
    Object.assign(config.feishu, {
      appId: 'app-id',
      appSecret: 'app-secret',
      bitableAppToken: 'legacy-token',
      sourceBitableAppToken: 'source-base',
      targetBitableAppToken: 'target-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-shared-id',
      miniTableId: 'tbl-shared-id',
      locationTableId: 'tbl-location',
      sourceFieldBindings: bindings.source,
      miniFieldBindings: bindings.mini,
      locationFieldBindings: bindings.location,
      folderToken: 'folder-token'
    })
    let state = feishuSync._internal.mirrorConfigurationStatus()
    assert.strictEqual(state.ready, true, '不同 Base 中相同 table ID 是不同资源，不得误拦')
    assert.strictEqual(state.tableResourcesDistinct, true, '资源唯一性必须同时比较 Base token 与 table ID')

    config.feishu.locationTableId = ' tbl-shared-id '
    state = feishuSync._internal.mirrorConfigurationStatus()
    assert.strictEqual(state.ready, false, '同一目标 Base 内仅有空白差异的 table ID 必须按同一资源阻断')
    assert.strictEqual(state.tableResourcesDistinct, false, '表资源身份比较必须使用去空白后的 table ID')

    config.feishu.locationTableId = 'tbl-location'
    config.feishu.targetBitableAppToken = 'source-base'
    state = feishuSync._internal.mirrorConfigurationStatus()
    assert.strictEqual(state.ready, false, '同 Base 的源表与专用表重叠必须阻断')
    assert.strictEqual(state.tableResourcesDistinct, false, '资源重叠必须有显式状态')

    config.feishu.targetBitableAppToken = ''
    config.feishu.crossBaseTokenPartial = true
    state = feishuSync._internal.mirrorConfigurationStatus()
    assert.strictEqual(state.ready, false, '半配置跨 Base token 必须 fail-closed')
    assert.strictEqual(state.crossBaseTokensReady, false, '半配置必须有显式诊断状态')
  } finally {
    restore(config.feishu, previous)
  }
}

async function testSeparateClientsRouteReadsAndWrites() {
  const clients = makeClients()
  const result = await feishuSync._internal.executeMirrorTableSync({
    sourceClient: clients.sourceClient,
    targetClient: clients.targetClient,
    sourceTableId: 'tbl-source',
    miniTableId: 'tbl-mini',
    locationTableId: 'tbl-location',
    sourceBindings: {},
    miniBindings: {},
    locationBindings: {},
    dryRun: false,
    runId: 'cross-base-write-test'
  })
  assert.strictEqual(result.status, 'success', '跨 Base 正式同步必须完成写后回读')
  assert.deepStrictEqual(
    clients.calls.filter((call) => call.client === 'source').map(({ client, action, tableId }) => ({ client, action, tableId })),
    [{ client: 'source', action: 'read', tableId: 'tbl-source' }],
    '员工源 Base 必须只有一次只读调用'
  )
  assert.ok(
    clients.calls.some((call) => call.client === 'target' && call.action === 'read' && call.tableId === 'tbl-location'),
    '位置字典必须由目标 Base 客户端读取'
  )
  assert.ok(
    clients.calls.some((call) => call.client === 'target' && call.action === 'create' && call.tableId === 'tbl-mini'),
    '专用表新增必须由目标 Base 客户端执行'
  )
  assert.ok(
    clients.calls.filter((call) => call.client === 'target' && call.action === 'read' && call.tableId === 'tbl-mini').length >= 2,
    '专用表写前与写后回读都必须走目标 Base'
  )
}

async function testConfiguredSyncCreatesSeparateBaseClients() {
  const previous = JSON.parse(JSON.stringify(config.feishu))
  const bindings = validBindings()
  const clients = makeClients()
  const createdFor = []
  try {
    Object.assign(config.feishu, {
      appId: 'app-id',
      appSecret: 'app-secret',
      bitableAppToken: 'legacy-token',
      sourceBitableAppToken: 'source-base',
      targetBitableAppToken: 'target-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-mini',
      locationTableId: 'tbl-location',
      sourceFieldBindings: bindings.source,
      miniFieldBindings: bindings.mini,
      locationFieldBindings: bindings.location,
      folderToken: 'folder-token'
    })
    const result = await feishuSync._internal.configuredMirrorTableSync({
      feishuToken: 'tenant-token-for-test',
      dryRun: true,
      materials: [],
      clientFactory(options) {
        createdFor.push(options.appToken)
        if (options.appToken === 'source-base') return clients.sourceClient
        if (options.appToken === 'target-base') return clients.targetClient
        throw new Error(`创建了非预期 Base 客户端：${options.appToken}`)
      }
    })
    assert.strictEqual(result.status, 'success-dry-run')
    assert.deepStrictEqual(
      createdFor,
      ['source-base', 'target-base'],
      '配置入口必须用源 token 与目标 token 分别创建两个客户端'
    )
    assert.deepStrictEqual(
      clients.calls.filter((call) => call.client === 'source').map(({ client, action, tableId }) => ({ client, action, tableId })),
      [{ client: 'source', action: 'read', tableId: 'tbl-source' }],
      '配置入口同样必须保证员工源 Base 只有只读调用'
    )
  } finally {
    restore(config.feishu, previous)
  }
}

async function testWorkerV2DisablesLegacyMaterialSourceBehaviorally() {
  const previousFeishu = JSON.parse(JSON.stringify(config.feishu))
  const previousOss = JSON.parse(JSON.stringify(config.oss))
  const previousFetch = global.fetch
  const bindings = validBindings()
  bindings.mini.video = fieldBinding('mini-video', 17, false)
  const poisonMaterials = []
  Object.defineProperty(poisonMaterials, Symbol.iterator, {
    value() {
      throw new Error('worker-v2 不得枚举旧素材清单')
    }
  })
  const sourceRecords = snapshot([
    {
      recordId: 'source-record-listing-only-with-target-video',
      fields: {
        community: '风雅乐府',
        roomLabel: '风雅乐府 1幢1单元101',
        layoutDescription: '2室1厅（整）',
        layoutCategory: '两室',
        monthlyRent: 3200,
        viewingMethod: '',
        remark: '',
        video: [{ name: '员工源畸形旧附件.mp4' }]
      }
    },
    {
      recordId: 'source-record-listing-only-without-target-video',
      fields: {
        community: '风雅乐府',
        roomLabel: '风雅乐府 1幢1单元101A',
        layoutDescription: '单间',
        layoutCategory: '单间',
        monthlyRent: 1800,
        viewingMethod: '',
        remark: ''
      }
    },
    {
      recordId: 'source-record-listing-only-new',
      fields: {
        community: '风雅乐府',
        roomLabel: '风雅乐府 1幢1单元102',
        layoutDescription: '单间',
        layoutCategory: '单间',
        monthlyRent: 2100,
        viewingMethod: '',
        remark: ''
      }
    },
    {
      recordId: 'source-record-listing-only-video-only-template',
      fields: {
        video: [{ name: '仅视频模板行且无稳定 token.mp4' }]
      }
    }
  ])
  const initialMirrorRecords = [
    mirrorRecord(
      'mini-record-listing-only-with-target-video',
      'source-record-listing-only-with-target-video',
      {
        monthlyRent: 3100,
        listingStatus: '在租',
        video: [
          {
            file_token: 'synthetic-current-stock-target-video-token',
            name: 'existing-target-video.mp4',
            type: 'video/mp4'
          },
          { name: 'target-malformed-video-without-token.mp4' }
        ]
      }
    ),
    mirrorRecord(
      'mini-record-listing-only-without-target-video',
      'source-record-listing-only-without-target-video',
      {
        roomLabel: '风雅乐府 1幢1单元101A',
        roomNumber: '101A',
        layoutDescription: '单间',
        layoutCategory: '单间',
        monthlyRent: 1700,
        rentMode: '合租',
        listingStatus: '在租'
      }
    )
  ]
  const videoFields = [
    'videoUrl', 'videoKey', 'sourceMaterialToken', 'sourceMaterialName',
    'sourceMaterialPath', 'sourceMaterialUrl', 'videoMaterialStatus', 'syncStatus',
    'missingVideoMaterial', 'videoMaterialFailureReason', 'videoLabel', 'mediaAssets', 'noteMaterialState'
  ]
  const preservedRecordIds = [
    'source-record-listing-only-with-target-video',
    'source-record-listing-only-without-target-video'
  ]
  const existingListing = (sourceRecordId, roomNumber, rentMode) => ({
    id: `listing-${sourceRecordId}`,
    uploaderId: 'A1',
    externalSource: 'feishu',
    feishuRecordId: sourceRecordId,
    feishuRoomIdentityKey: `风雅乐府|1|1|${roomNumber}`,
    city: '杭州市',
    district: '余杭区',
    area: '余杭区',
    block: '城北万象城',
    community: '风雅乐府',
    building: '1',
    unit: '1',
    roomNumber,
    address: `1-1-${roomNumber}`,
    roomAddress: `1-1-${roomNumber}`,
    layout: roomNumber === '101A' ? '单间' : '2室1厅（整）',
    rent: roomNumber === '101A' ? 1700 : 3100,
    landlordPhone: '',
    contact: '',
    landlordCommissionPercent: 50,
    commissionRate: 0,
    source: '公司房源',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    noCommission: true,
    type: rentMode,
    rentMode,
    room: roomNumber === '101A' ? '1' : '2',
    hall: roomNumber === '101A' ? '' : '1',
    bath: '',
    features: ['免押金', '不分佣'],
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '无需审核',
    requiresManualReview: false,
    manualReviewRequired: false,
    communityMatched: true,
    communityMatchStatus: '已匹配',
    videoUrl: `https://video.example.test/${roomNumber}.mp4`,
    videoKey: '',
    sourceMaterialToken: `synthetic-local-${roomNumber}`,
    sourceMaterialName: `${roomNumber}.mp4`,
    sourceMaterialPath: `风雅乐府/1/1/${roomNumber}.mp4`,
    sourceMaterialUrl: `https://material.example.test/${roomNumber}.mp4`,
    videoMaterialStatus: '已匹配视频素材',
    syncStatus: '已同步飞书',
    missingVideoMaterial: false,
    videoMaterialFailureReason: `既有状态-${roomNumber}`,
    videoLabel: '既有房源实拍',
    mediaAssets: [{ assetId: `asset-${roomNumber}`, kind: 'video' }],
    noteMaterialState: { version: 1, contentSha256: 'd'.repeat(64) }
  })
  const createDb = () => ({
    users: [{ id: 'A1', name: '管理员', role: '管理员', isAdmin: true }],
    listings: [
      existingListing('source-record-listing-only-with-target-video', '101', '整租'),
      existingListing('source-record-listing-only-without-target-video', '101A', '合租')
    ],
    footprints: [],
    pointLogs: [],
    feishuSyncLogs: []
  })
  const videoState = (db) => preservedRecordIds.map((recordId) => db.listings.find((listing) => (
    listing.feishuRecordId === recordId
  ))).map((listing) => videoFields.reduce((state, field) => {
    state[field] = Object.prototype.hasOwnProperty.call(listing, field)
      ? JSON.parse(JSON.stringify(listing[field]))
      : undefined
    return state
  }, {}))
  const assertListingOnlyResult = (result, label) => {
    ;['materialCount', 'skippedNoMaterial', 'missingVideoMaterial', 'ambiguousVideoMaterial', 'materialTransferFailed']
      .forEach((field) => assert.strictEqual(result[field], 0, `${label}的 ${field} 必须为 0`))
    assert.strictEqual(
      (result.auditRows || []).some((row) => /缺视频素材|沿用上次视频|素材转存|未匹配素材|素材匹配/.test(`${row.syncResult} ${row.failureReason}`)),
      false,
      `${label}逐行结果不得出现素材处理`
    )
    assert.strictEqual(
      (result.messages || []).some((message) => /缺视频素材|沿用上次视频|素材转存|未匹配素材|素材匹配/.test(String(message))),
      false,
      `${label}摘要不得出现素材处理`
    )
  }
  let materialProcessingCalls = 0
  const forbiddenMaterialAdapter = new Proxy({}, {
    get() {
      materialProcessingCalls += 1
      throw new Error('纯房源模式不得访问 Drive 或 OSS 适配器')
    }
  })
  try {
    const sourceFieldBindings = employeeSourceBindings()
    sourceFieldBindings.video = fieldBinding('src-video', 17, false)
    const miniFieldBindings = { ...bindings.mini, video: fieldBinding('mini-video', 17, false) }
    Object.assign(config.feishu, {
      appId: 'app-id',
      appSecret: 'app-secret',
      syncEnabled: true,
      autoSyncEnabled: true,
      mirrorSyncEnabled: true,
      syncControllerMode: 'worker-v2',
      approvedSchemaSha256: 'a'.repeat(64),
      approvedResourceIdentitySha256: 'b'.repeat(64),
      sourceBitableAppToken: 'source-base',
      targetBitableAppToken: 'target-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-mini',
      locationTableId: 'tbl-location',
      rentedTableId: '',
      historyTableId: '',
      sourceFieldBindings,
      miniFieldBindings,
      locationFieldBindings: bindings.location,
      sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
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
    global.fetch = async () => {
      materialProcessingCalls += 1
      throw new Error('纯房源模式不得请求旧素材 Drive')
    }
    const syncOptions = (clients, patch = {}) => ({
      syncController: 'worker-v2',
      disableLegacyMaterials: true,
      feishuToken: 'tenant-token-for-test',
      materials: poisonMaterials,
      clientFactory(options) {
        if (options.appToken === 'source-base') return clients.sourceClient
        if (options.appToken === 'target-base') return clients.targetClient
        throw new Error(`创建了非预期 Base 客户端：${options.appToken}`)
      },
      noteMaterialDrive: forbiddenMaterialAdapter,
      noteMaterialOss: forbiddenMaterialAdapter,
      prepareMaterial() {
        materialProcessingCalls += 1
        throw new Error('纯房源模式不得准备素材')
      },
      ...patch
    })

    const dryClients = makeClients({ sourceSnapshot: sourceRecords, initialMirrorRecords })
    const dryDb = createDb()
    const expectedDryVideoState = videoState(dryDb)
    const dryResult = await feishuSync.sync(dryDb, 'A1', syncOptions(dryClients, {
      dryRun: true,
      runId: 'current-stock-listing-only-dry'
    }))
    assert.strictEqual(dryResult.status, 'success-dry-run', 'current-stock 三表纯房源 dry-run 必须成功')
    assertListingOnlyResult(dryResult, 'current-stock dry-run')
    assert.deepStrictEqual(videoState(dryDb), expectedDryVideoState, 'current-stock dry-run 必须逐字段保留两套本地既有媒体')
    assert.strictEqual(
      dryClients.calls.some((call) => ['create', 'update'].includes(call.action)),
      false,
      'current-stock dry-run 必须保持三表零写'
    )
    assert.ok(
      dryClients.calls.filter((call) => call.action === 'read' && ['tbl-source', 'tbl-mini'].includes(call.tableId))
        .every((call) => JSON.stringify(call.excludedRecordSemantics) === JSON.stringify(['video'])),
      '纯房源 dry-run 的员工源与目标表读取必须在记录归一前排除 video 值'
    )

    const videoChangedMirrorRecords = JSON.parse(JSON.stringify(initialMirrorRecords))
    videoChangedMirrorRecords[0].fields.video = [{ file_token: 'another-target-video-token' }]
    const videoChangedClients = makeClients({ sourceSnapshot: sourceRecords, initialMirrorRecords: videoChangedMirrorRecords })
    const videoChangedResult = await feishuSync.sync(createDb(), 'A1', syncOptions(videoChangedClients, {
      dryRun: true,
      runId: 'current-stock-listing-only-dry'
    }))
    assert.strictEqual(videoChangedResult.mirrorPlanSha256, dryResult.mirrorPlanSha256, '仅目标 video 变化不得改变纯房源镜像计划摘要')
    assert.strictEqual(videoChangedResult.semanticMirrorPlanSha256, dryResult.semanticMirrorPlanSha256, '仅目标 video 变化不得改变语义计划摘要')

    const applyClients = makeClients({ sourceSnapshot: sourceRecords, initialMirrorRecords })
    const applyDb = createDb()
    const expectedApplyVideoState = videoState(applyDb)
    let frozenCount = 0
    let writeIntentCount = 0
    const applyResult = await feishuSync.sync(applyDb, 'A1', syncOptions(applyClients, {
      dryRun: false,
      runId: 'current-stock-listing-only-apply',
      onApplyPlanFrozen() {
        frozenCount += 1
      },
      onExternalWriteDispatched() {
        writeIntentCount += 1
      }
    }))
    assert.ok(/^success(?:-|$)/.test(applyResult.status), 'current-stock 三表纯房源正式同步必须成功')
    assertListingOnlyResult(applyResult, 'current-stock 正式同步')
    assert.deepStrictEqual(videoState(applyDb), expectedApplyVideoState, 'current-stock 正式同步必须逐字段保留两套本地既有媒体')
    assert.strictEqual(frozenCount, 1, 'current-stock 正式写前必须冻结一次权威镜像计划')
    assert.ok(writeIntentCount > 0, 'current-stock 房源事实差异必须继续产生目标表写意图')
    assert.deepStrictEqual(
      applyDb.listings.map((listing) => listing.rent).sort((left, right) => left - right),
      [1800, 2100, 3200],
      '员工源租金事实必须真实更新到本地既有房源并新增房源'
    )
    const targetUpdates = applyClients.calls.filter((call) => call.client === 'target' && call.action === 'update')
    assert.ok(targetUpdates.length > 0, 'current-stock 正式同步必须真实更新目标房源事实')
    assert.ok(
      targetUpdates.every((call) => call.records.every((record) => !Object.prototype.hasOwnProperty.call(record.fields, 'video'))),
      '纯房源模式的目标表更新载荷不得写 video 字段'
    )
    const targetCreates = applyClients.calls.filter((call) => call.client === 'target' && call.action === 'create')
    assert.ok(targetCreates.length > 0, 'current-stock 新房源必须真实走目标表 create')
    assert.ok(
      targetCreates.every((call) => call.records.every((record) => !Object.prototype.hasOwnProperty.call(record.fields, 'video'))),
      '纯房源模式的目标表新增载荷不得写 video 字段'
    )
    const finalTargetRecords = applyClients.mirrorRecords()
    assert.deepStrictEqual(
      finalTargetRecords.map((record) => record.fields.monthlyRent).sort((left, right) => left - right),
      [1800, 2100, 3200],
      '员工源租金事实必须真实更新到目标当前表并新增房源'
    )
    assert.deepStrictEqual(
      finalTargetRecords.find((record) => record.recordId === 'mini-record-listing-only-with-target-video').fields.video,
      initialMirrorRecords[0].fields.video,
      '目标表既有附件必须原样保留'
    )
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        finalTargetRecords.find((record) => record.recordId === 'mini-record-listing-only-without-target-video').fields,
        'video'
      ),
      false,
      '目标表原本没有附件的房源不得被补写 video'
    )
    const createdListing = applyDb.listings.find((listing) => listing.feishuRecordId === 'source-record-listing-only-new')
    assert.ok(createdListing, 'current-stock 正式同步必须在本地创建员工源新房源')
    assert.strictEqual(createdListing.videoUrl, '', '本地新房源不得生成 videoUrl')
    assert.strictEqual(createdListing.videoKey, '', '本地新房源不得生成 videoKey')
    ;['videoLabel', 'mediaAssets', 'noteMaterialState', 'videoMaterialStatus', 'missingVideoMaterial', 'videoMaterialFailureReason']
      .forEach((field) => assert.strictEqual(Object.prototype.hasOwnProperty.call(createdListing, field), false, `本地新房源不得生成 ${field}`))
    assert.strictEqual(createdListing.recommendationProfile.hasVideo, false, '本地新房源推荐画像不得标记有视频')

    const inventoryRow = (sourceRecordId, roomNumber) => ({
      record_id: sourceRecordId,
      fields: {
        房源编号: sourceRecordId,
        城市: '杭州市',
        canonicalDistrict: '余杭区',
        canonicalBlock: '城北万象城',
        小区: '风雅乐府',
        几栋: '1',
        几单元: '1',
        房间号: roomNumber,
        户型: '2室1厅（整）',
        月租金: 3200,
        出租方式: '整租',
        房源状态: '在租'
      }
    })
    const assertOldMediaCleared = (listing, label) => {
      assert.strictEqual(listing.videoUrl, '', `${label}不得继承旧 videoUrl`)
      assert.strictEqual(listing.videoKey, '', `${label}不得继承旧 videoKey`)
      ;['sourceMaterialToken', 'sourceMaterialName', 'sourceMaterialPath', 'sourceMaterialUrl']
        .forEach((field) => assert.strictEqual(listing[field], '', `${label}不得继承 ${field}`))
      assert.strictEqual(Object.prototype.hasOwnProperty.call(listing, 'mediaAssets'), false, `${label}不得继承 mediaAssets`)
      assert.strictEqual(Object.prototype.hasOwnProperty.call(listing, 'noteMaterialState'), false, `${label}不得继承 noteMaterialState`)
      assert.strictEqual(Object.prototype.hasOwnProperty.call(listing, 'videoLabel'), false, `${label}不得继承 videoLabel`)
      ;['videoMaterialStatus', 'missingVideoMaterial', 'videoMaterialFailureReason']
        .forEach((field) => assert.strictEqual(Object.prototype.hasOwnProperty.call(listing, field), false, `${label}不得继承 ${field}`))
      assert.strictEqual(listing.syncStatus, '已同步飞书', `${label}只允许保留本轮纯房源同步状态`)
      assert.strictEqual(listing.recommendationProfile.hasVideo, false, `${label}推荐画像不得残留 hasVideo=true`)
      assert.doesNotMatch(listing.recommendationProfile.searchText, /有视频/, `${label}推荐搜索词不得残留“有视频”`)
    }
    const changedIdentityDb = createDb()
    changedIdentityDb.listings = [changedIdentityDb.listings[0]]
    changedIdentityDb.listings[0].feishuRecordId = 'source-record-listing-only-changed-identity'
    await feishuSync.applySync(
      changedIdentityDb,
      [inventoryRow('source-record-listing-only-changed-identity', '102')],
      [],
      'A1',
      { dryRun: true, trustedCanonicalCoordinates: true, materialPolicy: 'disabled' }
    )
    assertOldMediaCleared(changedIdentityDb.listings[0], '物理身份变化的房源')

    const reactivatedDb = createDb()
    reactivatedDb.listings = [reactivatedDb.listings[0]]
    reactivatedDb.listings[0].feishuRecordId = 'source-record-listing-only-reactivated'
    reactivatedDb.listings[0].status = '已下架'
    reactivatedDb.listings[0].lifecycleStatus = 'expired'
    await feishuSync.applySync(
      reactivatedDb,
      [inventoryRow('source-record-listing-only-reactivated', '101')],
      [],
      'A1',
      { dryRun: true, trustedCanonicalCoordinates: true, materialPolicy: 'disabled' }
    )
    assertOldMediaCleared(reactivatedDb.listings[0], '重新上架的房源')
    assert.strictEqual(materialProcessingCalls, 0, 'current-stock dry/apply 全程必须保持下载、Drive、OSS、prepare 调用为 0')
  } finally {
    global.fetch = previousFetch
    restore(config.feishu, previousFeishu)
    restore(config.oss, previousOss)
  }
}

async function testAutomaticWorkerRequiresFormalNoteMaterialMode() {
  const previousFeishu = JSON.parse(JSON.stringify(config.feishu))
  const previousOss = JSON.parse(JSON.stringify(config.oss))
  const previousFetch = global.fetch
  const bindings = validBindings()
  let fetchCalls = 0
  try {
    Object.assign(config.feishu, {
      appId: 'app-id',
      appSecret: 'app-secret',
      syncEnabled: true,
      autoSyncEnabled: true,
      mirrorSyncEnabled: true,
      syncControllerMode: 'worker-v2',
      approvedSchemaSha256: 'a'.repeat(64),
      approvedResourceIdentitySha256: 'b'.repeat(64),
      sourceBitableAppToken: 'source-base',
      targetBitableAppToken: 'target-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-mini',
      locationTableId: 'tbl-location',
      sourceFieldBindings: bindings.source,
      miniFieldBindings: bindings.mini,
      locationFieldBindings: bindings.location,
      sourceCompatibilityProfile: '',
      noteMaterialSyncEnabled: true,
      folderToken: 'legacy-folder-must-not-mask-invalid-profile',
      noteMaterialFieldId: 'fld-note-material',
      noteMaterialAllowedHosts: ['tenant.example'],
      noteMaterialTargetRootFolderToken: 'targetFolder12345'
    })
    global.fetch = async () => {
      fetchCalls += 1
      throw new Error('错误素材 profile 不得开始任何飞书或素材 I/O')
    }
    assert.strictEqual(feishuSync.status({}).ready, false, '自动模式不得被旧素材目录伪装成就绪')
    await assert.rejects(
      () => feishuSync.sync({ users: [], listings: [] }, 'system:test', {
        syncController: 'worker-v2',
        dryRun: true
      }),
      (error) => error && error.code === 'WORKER_NOTE_MATERIAL_MODE_REQUIRED' && error.safeBeforeWrite === true,
      'worker-v2 错误或空 profile 必须在任何外部 I/O 前阻断'
    )
    assert.strictEqual(fetchCalls, 0, '素材模式配置失败必须保持 Base、Drive 与 OSS 零 I/O')

    Object.assign(config.feishu, {
      sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
      sourceFieldBindings: employeeSourceBindings(),
      folderToken: '',
      materialsFile: ''
    })
    Object.assign(config.oss, {
      bucket: 'synthetic-bucket',
      region: 'oss-cn-hangzhou',
      accessKeyId: 'synthetic-access-key-id',
      accessKeySecret: 'synthetic-access-key-secret'
    })
    assert.strictEqual(
      feishuSync._internal.mirrorConfigurationStatus().materialsReady,
      true,
      '正式房源笔记配置完整时不得再依赖旧素材目录'
    )
    assert.strictEqual(
      feishuSync.automaticWorkerConfigurationStatus().ready,
      true,
      '字段、资源、控制器、素材模式均批准后自动 worker 才能显示就绪'
    )
    assert.strictEqual(feishuSync.status({}).ready, true, '自动状态与真实 worker 前置门必须使用同一就绪口径')
  } finally {
    global.fetch = previousFetch
    restore(config.feishu, previousFeishu)
    restore(config.oss, previousOss)
  }
}

async function testLegacySameBaseStillUsesSeparateReadOnlySourceAndWritableTarget() {
  const previous = JSON.parse(JSON.stringify(config.feishu))
  const bindings = validBindings()
  const clients = makeClients()
  const createdClients = []
  try {
    Object.assign(config.feishu, {
      appId: 'app-id',
      appSecret: 'app-secret',
      bitableAppToken: 'shared-legacy-base',
      sourceBitableAppToken: 'shared-legacy-base',
      targetBitableAppToken: 'shared-legacy-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-mini',
      locationTableId: 'tbl-location',
      sourceFieldBindings: bindings.source,
      miniFieldBindings: bindings.mini,
      locationFieldBindings: bindings.location,
      sourceCompatibilityProfile: '',
      noteMaterialSyncEnabled: false,
      folderToken: 'folder-token'
    })
    const result = await feishuSync._internal.configuredMirrorTableSync({
      feishuToken: 'tenant-token-for-test',
      dryRun: false,
      materials: [],
      runId: 'legacy-same-base-formal-test',
      clientFactory(options) {
        createdClients.push({
          appToken: options.appToken,
          readOnly: options.readOnly === true
        })
        if (createdClients.length === 1) return clients.sourceClient
        if (createdClients.length === 2) return clients.targetClient
        throw new Error('同 Base 兼容同步创建了多余客户端')
      }
    })
    assert.strictEqual(result.status, 'success', '旧单 Base 配置的正式同步必须继续可用')
    assert.deepStrictEqual(
      createdClients,
      [
        { appToken: 'shared-legacy-base', readOnly: true },
        { appToken: 'shared-legacy-base', readOnly: false }
      ],
      '同 Base 也必须分别创建硬只读源客户端和可写目标客户端'
    )
    assert.deepStrictEqual(
      clients.calls.filter((call) => call.client === 'source').map((call) => call.action),
      ['read'],
      '旧单 Base 正式同步仍不得通过源客户端写入'
    )
    assert.ok(
      clients.calls.some((call) => call.client === 'target' && call.action === 'create' && call.tableId === 'tbl-mini'),
      '旧单 Base 正式同步必须由独立目标客户端写入专用表'
    )
  } finally {
    restore(config.feishu, previous)
  }
}

async function testEmployeeCurrentStockProfileDryRunIsReadOnly() {
  const bindings = validBindings()
  const sourceBindings = employeeSourceBindings()
  const employeeSnapshot = snapshot([
    {
      recordId: 'source-record-whole',
      fields: {
        community: '风雅乐府',
        roomLabel: '风雅乐府 1幢1单元101',
        layoutDescription: '2室1厅（整）',
        layoutCategory: '两室',
        monthlyRent: 3200,
        viewingMethod: '135790#',
        remark: ''
      }
    },
    {
      recordId: 'source-record-shared',
      fields: {
        community: '',
        roomLabel: '风雅乐府小区 1幢1单元101A',
        layoutDescription: '单间',
        layoutCategory: '单间',
        monthlyRent: 1800,
        viewingMethod: '7月30日空出可看',
        remark: ''
      }
    },
    {
      recordId: 'source-record-four-segment',
      fields: {
        community: '风雅乐府',
        roomLabel: '风雅乐府 6-2-301-01',
        layoutDescription: '2室1厅（整）',
        layoutCategory: '两室',
        monthlyRent: 3300,
        viewingMethod: '联系房东',
        remark: ''
      }
    },
    {
      recordId: 'source-empty-template',
      fields: {}
    }
  ])
  const clients = makeClients({ sourceSnapshot: employeeSnapshot })
  const previous = JSON.parse(JSON.stringify(config.feishu))
  try {
    Object.assign(config.feishu, {
      appId: 'app-id',
      appSecret: 'app-secret',
      sourceBitableAppToken: 'source-base',
      targetBitableAppToken: 'target-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-mini',
      locationTableId: 'tbl-location',
      sourceFieldBindings: sourceBindings,
      miniFieldBindings: bindings.mini,
      locationFieldBindings: bindings.location,
      sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
      folderToken: 'folder-token'
    })
    const state = feishuSync._internal.mirrorConfigurationStatus()
    assert.strictEqual(state.ready, true, '17 列员工现表风格绑定在显式兼容配置下必须通过配置门禁')

    const result = await feishuSync._internal.configuredMirrorTableSync({
      feishuToken: 'tenant-token-for-test',
      dryRun: true,
      materials: [],
      sourceClient: clients.sourceClient,
      targetClient: clients.targetClient
    })
    assert.strictEqual(result.status, 'success-dry-run', '员工现表兼容模式必须先支持完整 dry-run')
    assert.strictEqual(result.counts.create, 3, '全空模板行必须忽略，三个有效员工源记录必须进入计划')
    assert.deepStrictEqual(
      result.records.map((record) => record.fields.rentMode).sort(),
      ['合租', '整租', '整租'],
      '兼容规则必须派生明确出租方式'
    )
    assert.ok(
      result.records.every((record) => record.fields.listingStatus === '在租'),
      '当前在架集合的缺失房态必须派生为在租'
    )
    const wholeRecord = result.records.find((record) => record.recordId === 'dry-run-source-record-whole')
    const sharedRecord = result.records.find((record) => record.recordId === 'dry-run-source-record-shared')
    const fourSegmentRecord = result.records.find((record) => (
      record.recordId === 'dry-run-source-record-four-segment'
    ))
    assert.strictEqual(wholeRecord.fields.viewingMethod, '密码', '纯门锁码必须经完整配置链路标准化为密码')
    assert.strictEqual(wholeRecord.fields.viewingPassword, '135790#', '纯门锁码必须经完整配置链路拆入目标密码字段')
    assert.strictEqual(sharedRecord.fields.viewingMethod, '联系房东', '腾房说明必须经完整配置链路收敛为联系房东')
    assert.strictEqual(sharedRecord.fields.community, '风雅乐府', '兼容链路必须用已校验位置字典唯一别名恢复空小区列')
    assert.strictEqual(sharedRecord.fields.roomLabel, '风雅乐府 1幢1单元101A', '恢复小区后必须写入规范房号')
    assert.strictEqual(fourSegmentRecord.fields.building, '6', '四段房号必须在真实配置链路保留楼栋')
    assert.strictEqual(fourSegmentRecord.fields.unit, '2', '四段房号必须在真实配置链路保留单元')
    assert.strictEqual(
      fourSegmentRecord.fields.roomNumber,
      '301-01',
      '四段房号必须在真实配置链路把末两段完整保存为房号'
    )
    assert.strictEqual(
      fourSegmentRecord.fields.roomLabel,
      '风雅乐府 6幢2单元301-01',
      '四段房号必须在真实配置链路重建规范展示值'
    )
    const fourSegmentInventoryRow = feishuSync._internal.canonicalMirrorRecordToSyncRow(
      fourSegmentRecord,
      2
    )
    assert.deepStrictEqual(
      {
        building: fourSegmentInventoryRow.fields.几栋,
        unit: fourSegmentInventoryRow.fields.几单元,
        roomNumber: fourSegmentInventoryRow.fields.房间号
      },
      {
        building: '6',
        unit: '2',
        roomNumber: '301-01'
      },
      '四段房号进入最终库存投影时必须继续完整保留楼栋、单元和复合房号'
    )
    const normalizedFourSegment = feishuSync.normalizeRecord(
      fourSegmentInventoryRow,
      2,
      { trustedCanonicalCoordinates: true }
    )
    assert.deepStrictEqual(
      {
        building: normalizedFourSegment.building,
        unit: normalizedFourSegment.unit,
        roomNumber: normalizedFourSegment.roomNumber
      },
      {
        building: '6',
        unit: '2',
        roomNumber: '301-01'
      },
      '四段房号经过库存规范化层后不得丢失复合房号'
    )
    const inventoryDb = {
      users: [{ id: 'A1', name: '管理员', role: '管理员', isAdmin: true }],
      listings: [],
      footprints: [],
      pointLogs: []
    }
    const inventoryResult = await feishuSync.applySync(
      inventoryDb,
      [fourSegmentInventoryRow],
      [],
      'A1',
      {
        dryRun: true,
        trustedCanonicalCoordinates: true
      }
    )
    assert.strictEqual(inventoryResult.created, 1, '四段房号必须真实进入最终库存同步')
    assert.deepStrictEqual(
      {
        building: inventoryDb.listings[0].building,
        unit: inventoryDb.listings[0].unit,
        roomNumber: inventoryDb.listings[0].roomNumber
      },
      {
        building: '6',
        unit: '2',
        roomNumber: '301-01'
      },
      '四段房号落入最终库存后必须仍完整保留楼栋、单元和复合房号'
    )
    assert.strictEqual(
      sharedRecord.fields.viewingPassword,
      '',
      '腾房说明经完整配置链路只能形成明确空密码'
    )
    assert.deepStrictEqual(
      clients.calls.filter((call) => call.client === 'source').map((call) => call.action),
      ['read'],
      '员工源 Base 在兼容 dry-run 中必须严格零 POST/PATCH/DELETE'
    )
    assert.strictEqual(
      clients.calls.filter((call) => ['create', 'update', 'delete'].includes(call.action)).length,
      0,
      'dry-run 对源与目标 Base 均必须零写'
    )
    const sourceRead = clients.calls.find((call) => call.client === 'source' && call.action === 'read')
    assert.ok(
      Object.values(sourceRead.bindings).every((binding) => binding.required === false),
      '兼容读取必须先读入全空模板，随后由规范化层精确忽略'
    )
    const miniRead = clients.calls.find((call) => (
      call.client === 'target' && call.action === 'read' && call.tableId === 'tbl-mini'
    ))
    assert.strictEqual(
      miniRead.bindings.viewingPassword.schemaRequired,
      true,
      '兼容 profile 的专用表读取必须真实校验目标密码列存在'
    )
    assert.deepStrictEqual(
      miniRead.bindings.viewingPassword.type,
      1,
      '兼容 profile 的目标密码列必须按文本类型契约读取'
    )
  } finally {
    restore(config.feishu, previous)
  }
}

async function testEmployeeUnknownCommunityStopsAfterLocationRead() {
  const previous = JSON.parse(JSON.stringify(config.feishu))
  const bindings = validBindings()
  const sourceBindings = employeeSourceBindings()
  const clients = makeClients({
    sourceSnapshot: sourceSnapshot({
      community: '未收录新小区'
    })
  })
  try {
    Object.assign(config.feishu, {
      appId: 'app-id',
      appSecret: 'app-secret',
      sourceBitableAppToken: 'source-base',
      targetBitableAppToken: 'target-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-mini',
      locationTableId: 'tbl-location',
      sourceFieldBindings: sourceBindings,
      miniFieldBindings: bindings.mini,
      locationFieldBindings: bindings.location,
      sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
      folderToken: 'folder-token'
    })

    await assert.rejects(
      feishuSync._internal.configuredMirrorTableSync({
        feishuToken: 'tenant-token-for-test',
        dryRun: true,
        materials: [],
        sourceClient: clients.sourceClient,
        targetClient: clients.targetClient
      }),
      (error) => (
        error &&
        error.code === 'SOURCE_COMMUNITY_UNMAPPED' &&
        error.message === '员工源存在未收录位置字典的小区，已在来源校验阶段阻断'
      ),
      '员工源出现未收录小区时必须在来源契约阶段明确阻断'
    )
    assert.deepStrictEqual(
      clients.calls
        .filter((call) => call.action === 'read')
        .map((call) => call.tableId),
      ['tbl-source', 'tbl-location'],
      '未知小区只允许读取员工源与位置字典，不得继续读取专用表或其他业务表'
    )
    assert.strictEqual(
      clients.calls.filter((call) => (
        ['create', 'update', 'delete'].includes(call.action)
      )).length,
      0,
      '未知小区阻断期间源 Base 与目标 Base 必须保持零写入'
    )
  } finally {
    restore(config.feishu, previous)
  }
}

async function testEmployeeInvalidFourSegmentStopsBeforeAnyTargetWrite() {
  const previous = JSON.parse(JSON.stringify(config.feishu))
  const bindings = validBindings()
  const sourceBindings = employeeSourceBindings()
  const clients = makeClients({
    sourceSnapshot: snapshot([{
      recordId: 'source-record-four-segment-empty',
      fields: {
        community: '风雅乐府',
        roomLabel: '风雅乐府 6--301-01',
        layoutDescription: '2室1厅（整）',
        layoutCategory: '两室',
        monthlyRent: 3300,
        viewingMethod: '联系房东',
        remark: ''
      }
    }])
  })
  try {
    Object.assign(config.feishu, {
      appId: 'app-id',
      appSecret: 'app-secret',
      sourceBitableAppToken: 'source-base',
      targetBitableAppToken: 'target-base',
      crossBaseTokenPartial: false,
      sourceTableId: 'tbl-source',
      miniTableId: 'tbl-mini',
      locationTableId: 'tbl-location',
      sourceFieldBindings: sourceBindings,
      miniFieldBindings: bindings.mini,
      locationFieldBindings: bindings.location,
      sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
      folderToken: 'folder-token'
    })

    await assert.rejects(
      feishuSync._internal.configuredMirrorTableSync({
        feishuToken: 'tenant-token-for-test',
        dryRun: false,
        materials: [],
        sourceClient: clients.sourceClient,
        targetClient: clients.targetClient
      }),
      /房号|格式|解析/i,
      '含空段的四段房号必须在目标写入前整批阻断'
    )
    assert.deepStrictEqual(
      clients.calls.filter((call) => call.client === 'source').map((call) => call.action),
      ['read'],
      '四段房号非法时员工源 Base 必须始终只有一次读取'
    )
    assert.strictEqual(
      clients.calls.filter((call) => (
        call.client === 'target' && ['create', 'update', 'delete'].includes(call.action)
      )).length,
      0,
      '四段房号非法时目标 Base 必须保持零写'
    )
  } finally {
    restore(config.feishu, previous)
  }
}

async function testEmployeeProfileExplicitPasswordConflictsStopBeforeTargetWrite() {
  const previous = JSON.parse(JSON.stringify(config.feishu))
  try {
    for (const scenario of [
      {
        recordId: 'explicit-password-blank',
        viewingMethod: 'A9#*',
        viewingPassword: '',
        pattern: /密码|为空|缺少|不一致/i
      },
      {
        recordId: 'explicit-password-with-key',
        viewingMethod: '联系管家取钥匙',
        viewingPassword: 'STALE_KEY_123',
        pattern: /钥匙|密码|冲突|不一致/i
      },
      {
        recordId: 'explicit-password-with-contact',
        viewingMethod: '请电话联系',
        viewingPassword: 'STALE_CONTACT_123',
        pattern: /联系房东|密码|冲突|不一致/i
      }
    ]) {
      const bindings = validBindings()
      const sourceBindings = employeeSourceBindings()
      sourceBindings.viewingPassword = fieldBinding('src-viewing-password', 1, false)
      const clients = makeClients({
        sourceSnapshot: snapshot([{
          recordId: scenario.recordId,
          fields: {
            community: '风雅乐府',
            roomLabel: '风雅乐府 1幢1单元101',
            layoutDescription: '2室1厅（整）',
            layoutCategory: '两室',
            monthlyRent: 3200,
            viewingMethod: scenario.viewingMethod,
            viewingPassword: scenario.viewingPassword,
            remark: ''
          }
        }])
      })
      Object.assign(config.feishu, {
        appId: 'app-id',
        appSecret: 'app-secret',
        sourceBitableAppToken: 'source-base',
        targetBitableAppToken: 'target-base',
        crossBaseTokenPartial: false,
        sourceTableId: 'tbl-source',
        miniTableId: 'tbl-mini',
        locationTableId: 'tbl-location',
        sourceFieldBindings: sourceBindings,
        miniFieldBindings: bindings.mini,
        locationFieldBindings: bindings.location,
        sourceCompatibilityProfile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
        folderToken: 'folder-token'
      })

      await assert.rejects(
        feishuSync._internal.configuredMirrorTableSync({
          feishuToken: 'tenant-token-for-test',
          dryRun: false,
          materials: [],
          sourceClient: clients.sourceClient,
          targetClient: clients.targetClient
        }),
        scenario.pattern,
        '显式密码列与看房方式矛盾时必须整批阻断'
      )
      assert.deepStrictEqual(
        clients.calls.filter((call) => call.client === 'source').map((call) => call.action),
        ['read'],
        '冲突校验只允许读取员工源表一次'
      )
      assert.strictEqual(
        clients.calls.filter((call) => (
          call.client === 'target' && ['create', 'update', 'delete'].includes(call.action)
        )).length,
        0,
        '显式密码列冲突必须在目标 Base 首个写请求前失败'
      )
    }
  } finally {
    restore(config.feishu, previous)
  }
}

async function testDeactivateWritesOnlyMiniTableAndAllThreeFields() {
  const clients = makeClients({
    initialMirrorRecords: [
      mirrorRecord('mirror-current', 'source-record-1'),
      mirrorRecord('mirror-disappeared', 'source-record-disappeared')
    ]
  })
  const result = await feishuSync._internal.executeMirrorTableSync({
    sourceClient: clients.sourceClient,
    targetClient: clients.targetClient,
    sourceTableId: 'tbl-source',
    miniTableId: 'tbl-mini',
    locationTableId: 'tbl-location',
    sourceBindings: {},
    miniBindings: {},
    locationBindings: {},
    allowMassDeactivate: true,
    dryRun: false,
    runId: 'cross-base-deactivate-test'
  })
  assert.strictEqual(result.status, 'success', '源记录消失的软停用必须通过写后回读')
  assert.strictEqual(result.counts.deactivate, 1, '消失的源记录必须恰好产生一次软停用')
  assert.deepStrictEqual(
    clients.calls.filter((call) => call.client === 'source').map((call) => call.action),
    ['read'],
    '软停用也不得向员工源 Base 发出任何写或删请求'
  )
  const updates = clients.calls.filter((call) => call.client === 'target' && call.action === 'update')
  assert.strictEqual(updates.length, 1, '软停用必须由目标客户端执行一次更新')
  assert.strictEqual(updates[0].tableId, 'tbl-mini', '软停用唯一写目标必须是 miniTableId')
  assert.deepStrictEqual(
    updates[0].records[0].fields,
    {
      listingStatus: '已下架',
      published: false,
      enabled: false
    },
    '软停用必须在同一目标更新中原子写入房态、公开状态和启用状态'
  )
}

async function testDryRunWritesNeitherBase() {
  const clients = makeClients()
  const result = await feishuSync._internal.executeMirrorTableSync({
    sourceClient: clients.sourceClient,
    targetClient: clients.targetClient,
    sourceTableId: 'tbl-source',
    miniTableId: 'tbl-mini',
    locationTableId: 'tbl-location',
    sourceBindings: {},
    miniBindings: {},
    locationBindings: {},
    dryRun: true,
    runId: 'cross-base-dry-run-test'
  })
  assert.strictEqual(result.status, 'success-dry-run')
  assert.strictEqual(
    clients.calls.filter((call) => call.action === 'create' || call.action === 'update').length,
    0,
    'dry-run 对源 Base 与目标 Base 都必须零写'
  )
}

async function testReadOnlyTargetSupportsDryRunButBlocksApplyBeforeWrite() {
  const clients = makeClients()
  const readOnlyTarget = {
    readValidatedTableSnapshot: clients.targetClient.readValidatedTableSnapshot
  }
  const sharedOptions = {
    sourceClient: clients.sourceClient,
    targetClient: readOnlyTarget,
    sourceTableId: 'tbl-source',
    miniTableId: 'tbl-mini',
    locationTableId: 'tbl-location',
    sourceBindings: {},
    miniBindings: {},
    locationBindings: {}
  }

  const dryRun = await feishuSync._internal.executeMirrorTableSync({
    ...sharedOptions,
    dryRun: true,
    runId: 'cross-base-read-only-target-dry-run'
  })
  assert.strictEqual(dryRun.status, 'success-dry-run', '目标 Base 只有读取能力时仍必须允许完整预演')
  assert.strictEqual(
    clients.calls.filter((call) => call.action === 'create' || call.action === 'update').length,
    0,
    '只读目标客户端的 dry-run 必须保持零写'
  )

  await assert.rejects(
    feishuSync._internal.executeMirrorTableSync({
      ...sharedOptions,
      dryRun: false,
      runId: 'cross-base-read-only-target-apply'
    }),
    /缺少小程序目标 Base 写客户端/,
    '正式同步缺少目标 Base 写能力时必须在首个写请求前失败'
  )
  assert.strictEqual(
    clients.calls.filter((call) => call.action === 'create' || call.action === 'update').length,
    0,
    '正式同步能力校验失败不得产生任何源 Base 或目标 Base 写请求'
  )
}

async function main() {
  await testTokenResolutionFailsClosed()
  testCompatibilityProfileConfigurationFailsClosed()
  testSourceBindingContractOnlyRelaxesWithExplicitProfile()
  testEmployeeProfileRequiresSeparateReadOnlySourceBase()
  await testEmployeeProfileRequiresTargetViewingPasswordBeforeAnyRequest()
  await testResourceIdentityAndPartialConfiguration()
  await testSeparateClientsRouteReadsAndWrites()
  await testConfiguredSyncCreatesSeparateBaseClients()
  await testWorkerV2DisablesLegacyMaterialSourceBehaviorally()
  await testAutomaticWorkerRequiresFormalNoteMaterialMode()
  await testLegacySameBaseStillUsesSeparateReadOnlySourceAndWritableTarget()
  await testEmployeeCurrentStockProfileDryRunIsReadOnly()
  await testEmployeeUnknownCommunityStopsAfterLocationRead()
  await testEmployeeInvalidFourSegmentStopsBeforeAnyTargetWrite()
  await testEmployeeProfileExplicitPasswordConflictsStopBeforeTargetWrite()
  await testDeactivateWritesOnlyMiniTableAndAllThreeFields()
  await testDryRunWritesNeitherBase()
  await testReadOnlyTargetSupportsDryRunButBlocksApplyBeforeWrite()
  console.log('feishu-cross-base-source-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
