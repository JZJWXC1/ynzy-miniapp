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
        bindings: JSON.parse(JSON.stringify(readOptions.bindings || {}))
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
    async readValidatedTableSnapshot(readOptions) {
      calls.push({
        client: 'target',
        action: 'read',
        tableId: readOptions.tableId,
        bindings: JSON.parse(JSON.stringify(readOptions.bindings || {}))
      })
      if (readOptions.tableId === 'tbl-location') return locationSnapshot()
      assert.strictEqual(readOptions.tableId, 'tbl-mini', '目标客户端只能读取位置字典或专用表')
      return snapshot(mirrorRecords, mirrorFieldNames())
    },
    async batchCreateRecords(tableId, records) {
      calls.push({ client: 'target', action: 'create', tableId, count: records.length })
      assert.strictEqual(tableId, 'tbl-mini', '目标新增只能写专用表')
      mirrorRecords = records.map((record, index) => ({
        recordId: `mirror-record-${index + 1}`,
        fields: JSON.parse(JSON.stringify(record.fields))
      }))
      return { records: mirrorRecords }
    },
    async batchUpdateRecords(tableId, records) {
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
  return { sourceClient, targetClient, calls }
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
    assert.strictEqual(result.counts.create, 2, '全空模板行必须忽略，两个有效员工源记录必须进入计划')
    assert.deepStrictEqual(
      result.records.map((record) => record.fields.rentMode).sort(),
      ['合租', '整租'],
      '兼容规则必须派生明确出租方式'
    )
    assert.ok(
      result.records.every((record) => record.fields.listingStatus === '在租'),
      '当前在架集合的缺失房态必须派生为在租'
    )
    const wholeRecord = result.records.find((record) => record.recordId === 'dry-run-source-record-whole')
    const sharedRecord = result.records.find((record) => record.recordId === 'dry-run-source-record-shared')
    assert.strictEqual(wholeRecord.fields.viewingMethod, '密码', '纯门锁码必须经完整配置链路标准化为密码')
    assert.strictEqual(wholeRecord.fields.viewingPassword, '135790#', '纯门锁码必须经完整配置链路拆入目标密码字段')
    assert.strictEqual(sharedRecord.fields.viewingMethod, '联系房东', '腾房说明必须经完整配置链路收敛为联系房东')
    assert.strictEqual(sharedRecord.fields.community, '风雅乐府', '兼容链路必须用已校验位置字典唯一别名恢复空小区列')
    assert.strictEqual(sharedRecord.fields.roomLabel, '风雅乐府 1幢1单元101A', '恢复小区后必须写入规范房号')
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(sharedRecord.fields, 'viewingPassword'),
      false,
      '腾房说明不得经完整配置链路泄漏到目标密码字段'
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
  await testLegacySameBaseStillUsesSeparateReadOnlySourceAndWritableTarget()
  await testEmployeeCurrentStockProfileDryRunIsReadOnly()
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
