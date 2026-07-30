'use strict'

const assert = require('assert')

const {
  buildLocationCatalog,
  planMirrorSync,
  prepareSourceSnapshotForCompatibility
} = require('../src/feishu-source-mirror')

const EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE = 'employee-current-stock-v1'
const EMPLOYEE_AI_FOUNDATION_PROFILE = 'employee-ai-foundation-v1'

function location(overrides = {}) {
  return {
    recordId: 'loc-record-fengya',
    locationId: 'LOC-FENGYA',
    city: '杭州市',
    district: '余杭区',
    block: '城北万象城',
    community: '风雅乐府',
    latitude: 30.345286,
    longitude: 120.121984,
    aliases: ['风雅', '风雅乐府小区'],
    enabled: true,
    ...overrides
  }
}

function source(recordId, overrides = {}) {
  const fields = {
    community: '风雅乐府',
    roomLabel: '风雅乐府 1幢1单元101',
    building: '1',
    unit: '1',
    roomNumber: '101',
    monthlyRent: 3200,
    layoutDescription: '2室1厅',
    rentMode: '整租',
    listingStatus: '可租',
    video: [{ file_token: 'mock-video-token', name: 'room.mp4' }],
    ...overrides
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'community') &&
      !Object.prototype.hasOwnProperty.call(overrides, 'roomLabel')) {
    fields.roomLabel = `${fields.community} 1幢1单元101`
  }
  return {
    recordId,
    fields
  }
}

function canonicalMirrorFields(sourceRecordId, overrides = {}) {
  return {
    sourceRecordId,
    locationId: 'LOC-FENGYA',
    locationRecordId: 'loc-record-fengya',
    city: '杭州市',
    district: '余杭区',
    block: '城北万象城',
    community: '风雅乐府',
    roomLabel: '风雅乐府 1幢1单元101',
    building: '1',
    unit: '1',
    roomNumber: '101',
    latitude: 30.345286,
    longitude: 120.121984,
    monthlyRent: 3200,
    layoutDescription: '2室1厅',
    layoutCategory: '两室',
    rentMode: '整租',
    listingStatus: '可租',
    video: [{ file_token: 'mock-video-token', name: 'room.mp4' }],
    published: true,
    canonical: true,
    enabled: true,
    ...overrides
  }
}

function mirror(recordId, sourceRecordId, overrides = {}) {
  return {
    recordId,
    fields: canonicalMirrorFields(sourceRecordId, overrides)
  }
}

function snapshot(records, complete = true) {
  return {
    complete,
    records,
    recordCount: records.length,
    digest: `synthetic-digest-${records.length}`,
    schemaFingerprint: 'synthetic-schema-fingerprint'
  }
}

function operations(plan) {
  assert.ok(plan && typeof plan === 'object', '镜像同步必须返回计划对象')
  assert.strictEqual(plan.complete, true, '可执行计划必须显式标记 complete=true')
  assert.ok(Array.isArray(plan.operations), '计划必须用 operations 数组完整表达待写动作')
  return plan.operations
}

function operationFor(plan, sourceRecordId) {
  return operations(plan).find((item) => item.sourceRecordId === sourceRecordId)
}

function assertOperation(plan, sourceRecordId, type, message) {
  const operation = operationFor(plan, sourceRecordId)
  assert.ok(operation, `${message}：必须生成动作`)
  assert.strictEqual(operation.type, type, `${message}：动作类型必须为 ${type}`)
  assert.strictEqual(operation.sourceRecordId, sourceRecordId, `${message}：必须以源 recordId 为唯一关联键`)
  return operation
}

function expectBlockedWithoutMutation(factory, inputs, pattern, message) {
  const before = JSON.stringify(inputs)
  let error = null
  try {
    factory()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  if (pattern) {
    assert.match(String(error.message || error), pattern, `${message}；实际错误：${error && error.message}`)
  }
  assert.strictEqual(JSON.stringify(inputs), before, `${message}：阻断时不得修改源快照、镜像快照或位置字典`)
}

function testLifecyclePlanUsesStableSourceRecordId() {
  const catalog = buildLocationCatalog([location()])
  const sourceSnapshot = snapshot([
    source('src-create'),
    source('src-update', { monthlyRent: 3500 }),
    source('src-noop'),
    source('src-restore')
  ])
  const mirrorSnapshot = snapshot([
    mirror('mir-update', 'src-update', { monthlyRent: 3200 }),
    mirror('mir-noop', 'src-noop'),
    mirror('mir-restore', 'src-restore', { enabled: false }),
    mirror('mir-deactivate', 'src-deactivate'),
    mirror('mir-already-disabled', 'src-already-disabled', { enabled: false })
  ])

  const plan = planMirrorSync({
    sourceSnapshot,
    mirrorSnapshot,
    locationCatalog: catalog,
    runId: 'mirror-run-20260723-test'
  })

  const create = assertOperation(plan, 'src-create', 'create', '新源记录')
  assert.strictEqual(create.recordId == null || create.recordId === '', true, 'create 动作不得伪造镜像 recordId')
  assert.strictEqual(create.fields.sourceRecordId, 'src-create', '新建镜像必须落盘源 recordId')
  assert.strictEqual(create.fields.enabled, true, '新建镜像默认必须启用')

  const update = assertOperation(plan, 'src-update', 'update', '已有源记录字段变化')
  assert.strictEqual(update.recordId, 'mir-update', '更新必须指向原镜像 recordId')
  assert.strictEqual(update.fields.monthlyRent, 3500, '更新计划必须带入源表的新租金')

  assert.strictEqual(operationFor(plan, 'src-noop'), undefined, '语义内容未变化时必须 no-op，不能制造无意义写入')

  const deactivate = assertOperation(plan, 'src-deactivate', 'deactivate', '完整源快照中已消失的记录')
  assert.strictEqual(deactivate.recordId, 'mir-deactivate', '软停用必须指向原镜像 recordId')
  assert.strictEqual(deactivate.fields.listingStatus, '已下架', '源记录消失必须原子写入已下架房态')
  assert.strictEqual(deactivate.fields.published, false, '源记录消失必须原子关闭公开状态')
  assert.strictEqual(deactivate.fields.enabled, false, '源记录消失只能软停用，不得删除镜像记录')

  const restore = assertOperation(plan, 'src-restore', 'restore', '重新出现在源表的软停用记录')
  assert.strictEqual(restore.recordId, 'mir-restore', '恢复必须复用原镜像 recordId')
  assert.strictEqual(restore.fields.listingStatus, '可租', '恢复必须写回源记录的有效房态')
  assert.strictEqual(restore.fields.published, true, '恢复必须原子恢复公开状态')
  assert.strictEqual(restore.fields.enabled, true, '恢复动作必须重新启用原镜像记录')

  assert.strictEqual(operationFor(plan, 'src-already-disabled'), undefined, '源表仍不存在且镜像已停用时必须 no-op')
  assert.strictEqual(operations(plan).length, 4, '新建、更新、软停用、恢复各一次之外不得有额外写入')
}

function profileBindings(overrides = {}) {
  return {
    community: { fieldId: 'src-community' },
    roomLabel: { fieldId: 'src-room-label' },
    layoutDescription: { fieldId: 'src-layout-description' },
    layoutCategory: { fieldId: 'src-layout-category' },
    monthlyRent: { fieldId: 'src-monthly-rent' },
    viewingMethod: { fieldId: 'src-viewing-method' },
    remark: { fieldId: 'src-remark' },
    ...overrides
  }
}

function prepareEmployeeSnapshot(records, sourceBindings = profileBindings(), locationCatalog) {
  return prepareSourceSnapshotForCompatibility(snapshot(records), {
    profile: EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
    sourceBindings,
    locationCatalog
  })
}

function testEmployeeProfileClassifiesAllThirtyFourVerifiedShapes() {
  const records = []
  for (let index = 0; index < 5; index += 1) {
    records.push(source(`whole-word-${index}`, {
      roomLabel: `风雅乐府 1幢1单元10${index}`,
      roomNumber: `10${index}`,
      layoutDescription: '两室一厅整租',
      layoutCategory: '两室',
      rentMode: undefined,
      listingStatus: undefined
    }))
  }
  for (let index = 0; index < 5; index += 1) {
    records.push(source(`whole-parentheses-${index}`, {
      roomLabel: `风雅乐府 2幢1单元20${index}`,
      roomNumber: `20${index}`,
      layoutDescription: index % 2 === 0 ? '两室一厅（整）' : '两室一厅(整)',
      layoutCategory: '两室',
      rentMode: undefined,
      listingStatus: undefined
    }))
  }
  ;['一室', '两室', '三室', '四室', '五室', '六室'].forEach((layoutCategory, index) => {
    records.push(source(`whole-numeric-${index}`, {
      roomLabel: `风雅乐府 3幢1单元30${index}`,
      roomNumber: `30${index}`,
      layoutDescription: `${index + 1}室1厅`,
      layoutCategory,
      rentMode: undefined,
      listingStatus: undefined
    }))
  })
  for (let index = 0; index < 9; index += 1) {
    records.push(source(`shared-single-${index}`, {
      roomLabel: `风雅乐府 4幢1单元40${index}`,
      roomNumber: `40${index}`,
      layoutDescription: '单间',
      layoutCategory: '单间',
      rentMode: undefined,
      listingStatus: undefined
    }))
  }
  for (let index = 0; index < 9; index += 1) {
    const suffix = String.fromCharCode(65 + index)
    records.push(source(`shared-letter-${index}`, {
      roomLabel: index === 0
        ? `风雅乐府 5幢1单元50${index}${suffix}室`
        : `风雅乐府 5幢1单元50${index}${suffix}`,
      roomNumber: index === 0 ? `50${index}${suffix}室` : `50${index}${suffix}`,
      layoutDescription: '一室',
      layoutCategory: '一室',
      rentMode: undefined,
      listingStatus: undefined
    }))
  }

  assert.strictEqual(records.length, 34, '分类合成样本必须与真实有效员工源记录数一致')
  const prepared = prepareEmployeeSnapshot(records)
  assert.strictEqual(prepared.records.length, 34, '34 条有效记录不得被兼容层误忽略')
  const counts = prepared.records.reduce((result, record) => {
    const expectedRentMode = record.recordId.startsWith('whole-') ? '整租' : '合租'
    assert.strictEqual(
      record.fields.rentMode,
      expectedRentMode,
      `记录 ${record.recordId} 必须按所属规则分组逐条得到 ${expectedRentMode}，不能只靠汇总数量过关`
    )
    result[record.fields.rentMode] = (result[record.fields.rentMode] || 0) + 1
    assert.strictEqual(record.fields.listingStatus, '在租', '缺失房态必须按当前在架快照派生为在租')
    return result
  }, {})
  assert.deepStrictEqual(counts, { 整租: 16, 合租: 18 }, '34 条规则样本必须稳定分类为 16 整租、18 合租')
}

function testEmployeeProfileNormalizesLegacyLayoutGranularitySafely() {
  const cases = [
    { sourceRecordId: 'legacy-layout-one', roomLabel: '风雅乐府 9幢901', description: '一室一厅', category: '一室一厅', expected: '一室' },
    { sourceRecordId: 'legacy-layout-two', roomLabel: '风雅乐府 9幢902', description: '两室一厅', category: '两室一厅', expected: '两室' },
    { sourceRecordId: 'legacy-layout-three', roomLabel: '风雅乐府 9幢903', description: '三室一厅', category: '三室一厅', expected: '三室' },
    { sourceRecordId: 'legacy-layout-single', roomLabel: '风雅乐府 9幢904A', description: '单间', category: '单间', expected: '一室' }
  ]
  const prepared = prepareEmployeeSnapshot(cases.map((item) => source(item.sourceRecordId, {
    roomLabel: item.roomLabel,
    building: '9',
    unit: '',
    roomNumber: item.roomLabel.replace(/^.*幢/, ''),
    layoutDescription: item.description,
    layoutCategory: item.category,
    rentMode: undefined,
    listingStatus: undefined
  })))

  cases.forEach((item, index) => {
    assert.strictEqual(
      prepared.records[index].fields.layoutCategory,
      item.expected,
      `员工旧表 ${item.category} 必须仅在与户型描述室数一致时归一为 ${item.expected}`
    )
  })

  const plan = planMirrorSync({
    sourceSnapshot: prepared,
    mirrorSnapshot: snapshot([]),
    locationCatalog: buildLocationCatalog([location()]),
    runId: 'legacy-layout-granularity'
  })
  cases.forEach((item) => {
    assert.strictEqual(
      assertOperation(plan, item.sourceRecordId, 'create', item.category).fields.layoutCategory,
      item.expected,
      '规范后的专用表户型分类必须只保留一至六室标准值'
    )
  })

  const conflict = prepareEmployeeSnapshot([
    source('legacy-layout-real-conflict', {
      roomLabel: '风雅乐府 9幢905',
      building: '9',
      unit: '',
      roomNumber: '905',
      layoutDescription: '三室一厅',
      layoutCategory: '两室一厅',
      rentMode: undefined,
      listingStatus: undefined
    })
  ])
  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: conflict,
      mirrorSnapshot: snapshot([]),
      locationCatalog: buildLocationCatalog([location()]),
      runId: 'legacy-layout-real-conflict'
    }),
    /户型描述|户型分类|不一致/i,
    '员工旧表户型分类与描述的真实室数冲突不得被兼容层静默改写'
  )

  ;['十一室一厅', '十二室一厅', '十六室', '22室1厅'].forEach((unsupported, index) => {
    assert.throws(
      () => {
        const highRoomPrepared = prepareEmployeeSnapshot([
          source(`legacy-layout-unsupported-${index}`, {
            roomLabel: `风雅乐府 10幢${1001 + index}`,
            building: '10',
            unit: '',
            roomNumber: String(1001 + index),
            layoutDescription: unsupported,
            layoutCategory: unsupported,
            rentMode: undefined,
            listingStatus: undefined
          })
        ])
        return planMirrorSync({
          sourceSnapshot: highRoomPrepared,
          mirrorSnapshot: snapshot([]),
          locationCatalog: buildLocationCatalog([location()]),
          runId: `legacy-layout-unsupported-${index}`
        })
      },
      /户型|分类|描述|派生/i,
      `员工兼容 profile 不得把未知高室数“${unsupported}”静默降级为一至六室`
    )
  })

  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: snapshot([
        source('strict-layout-unsupported', {
          roomLabel: '风雅乐府 11幢1101',
          building: '11',
          unit: '',
          roomNumber: '1101',
          layoutDescription: '十一室一厅',
          layoutCategory: '十一室'
        })
      ]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: buildLocationCatalog([location()]),
      runId: 'strict-layout-unsupported'
    }),
    /户型|分类|描述|派生/i,
    '严格链路也不得用子串把十一室识别成一室'
  )
}

function testEmployeeProfileStripsOnlyLegacyCommissionRoomSuffix() {
  const prepared = prepareEmployeeSnapshot([
    source('legacy-room-monthly-commission', {
      roomLabel: '风雅乐府 1-101 月佣',
      building: undefined,
      unit: undefined,
      roomNumber: undefined,
      layoutDescription: '两室一厅',
      layoutCategory: '两室一厅',
      rentMode: undefined,
      listingStatus: undefined
    }),
    source('legacy-room-percent-commission', {
      roomLabel: '风雅乐府 2-202 100%月佣',
      building: undefined,
      unit: undefined,
      roomNumber: undefined,
      layoutDescription: '两室一厅',
      layoutCategory: '两室一厅',
      rentMode: undefined,
      listingStatus: undefined
    })
  ])
  assert.deepStrictEqual(
    prepared.records.map((record) => record.fields.roomLabel),
    ['风雅乐府 1-101', '风雅乐府 2-202'],
    '员工旧表只允许从房号末尾剥离精确月佣运营尾注'
  )
  prepared.records.forEach((record) => {
    assert.strictEqual(record.fields.rentMode, '整租', '剥离月佣尾注后必须继续按纯房号派生出租方式')
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(record.fields, 'landlordCommissionPercent'),
      false,
      '房号尾注不得转换为客户端可控分佣字段'
    )
    assert.ok(!/月佣/.test(String(record.fields.remark || '')), '房号尾注不得泄漏到专用表备注')
  })

  const plan = planMirrorSync({
    sourceSnapshot: prepared,
    mirrorSnapshot: snapshot([]),
    locationCatalog: buildLocationCatalog([location()]),
    runId: 'legacy-room-commission-suffix'
  })
  assert.strictEqual(
    assertOperation(plan, 'legacy-room-monthly-commission', 'create', '月佣尾注').fields.roomLabel,
    '风雅乐府 1幢101',
    '去除尾注后必须重建规范房号'
  )
  assert.strictEqual(
    assertOperation(plan, 'legacy-room-percent-commission', 'create', '百分比月佣尾注').fields.roomLabel,
    '风雅乐府 2幢202',
    '百分比月佣尾注不得改变规范房号'
  )

  assert.throws(
    () => prepareEmployeeSnapshot([
      source('legacy-room-unknown-suffix', {
        roomLabel: '风雅乐府 3-303 其他尾注',
        building: undefined,
        unit: undefined,
        roomNumber: undefined,
        layoutDescription: '两室一厅',
        layoutCategory: '两室一厅',
        rentMode: undefined,
        listingStatus: undefined
      })
    ]),
    /出租方式|房号|员工现表规则/i,
    '员工兼容层不得把未知房号尾注当作月佣静默剥离'
  )

  assert.throws(
    () => prepareEmployeeSnapshot([
      source('legacy-room-commission-not-at-end', {
        roomLabel: '风雅乐府 3-月佣303',
        building: undefined,
        unit: undefined,
        roomNumber: undefined,
        layoutDescription: '两室一厅',
        layoutCategory: '两室一厅',
        rentMode: undefined,
        listingStatus: undefined
      })
    ]),
    /出租方式|房号|员工现表规则/i,
    '“月佣”只有位于整个房号末尾时才允许剥离，嵌在房号中间必须阻断'
  )

  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: snapshot([
        source('strict-room-commission-suffix', {
          roomLabel: '风雅乐府 4-404 月佣',
          building: undefined,
          unit: undefined,
          roomNumber: undefined
        })
      ]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: buildLocationCatalog([location()]),
      runId: 'strict-room-commission-suffix'
    }),
    /房号|格式|解析/i,
    '未启用员工兼容 profile 时不得放宽带运营尾注的房号'
  )
}

function testEmployeeProfilesDeriveRentModeAfterStrictChineseRoomAnnotation() {
  const catalog = buildLocationCatalog([location()])
  const cases = [
    {
      key: 'numeric-full-width',
      roomLabel: '风雅乐府 12-345（状态注）',
      layoutDescription: '两室一厅',
      layoutCategory: '两室',
      expectedRentMode: '整租',
      expectedRoomNumber: '345'
    },
    {
      key: 'letter-half-width',
      roomLabel: '风雅乐府 13-346A(运营注)',
      layoutDescription: '一室',
      layoutCategory: '一室',
      expectedRentMode: '合租',
      expectedRoomNumber: '346A'
    }
  ]

  ;[
    EMPLOYEE_SOURCE_COMPATIBILITY_PROFILE,
    EMPLOYEE_AI_FOUNDATION_PROFILE
  ].forEach((profile) => {
    const records = cases.map((item) => source(`${profile}-${item.key}`, {
      roomLabel: item.roomLabel,
      building: undefined,
      unit: undefined,
      roomNumber: undefined,
      layoutDescription: item.layoutDescription,
      layoutCategory: item.layoutCategory,
      rentMode: undefined,
      listingStatus: undefined
    }))
    const prepared = prepareSourceSnapshotForCompatibility(snapshot(records), {
      profile,
      sourceBindings: profileBindings(),
      locationCatalog: catalog
    })

    cases.forEach((item, index) => {
      assert.strictEqual(
        prepared.records[index].fields.rentMode,
        item.expectedRentMode,
        `${profile} 必须先按严格中文尾注规则还原房号，再派生${item.expectedRentMode}`
      )
    })

    const plan = planMirrorSync({
      sourceSnapshot: prepared,
      mirrorSnapshot: snapshot([]),
      locationCatalog: catalog,
      runId: `${profile}-annotated-rent-mode`
    })
    cases.forEach((item) => {
      const operation = assertOperation(
        plan,
        `${profile}-${item.key}`,
        'create',
        `${profile} 中文尾注房号`
      )
      assert.strictEqual(operation.fields.rentMode, item.expectedRentMode, '专用表计划不得丢失派生出租方式')
      assert.strictEqual(operation.fields.roomNumber, item.expectedRoomNumber, '中文尾注不得进入规范房号身份')
    })
  })

  ;[
    '风雅乐府 14-347（状态1）',
    '风雅乐府 14-347（status）',
    '风雅乐府 14-347（状态注',
    '风雅乐府 14-347状态注'
  ].forEach((roomLabel, index) => {
    assert.throws(
      () => prepareEmployeeSnapshot([
        source(`employee-unsafe-rent-annotation-${index}`, {
          roomLabel,
          building: undefined,
          unit: undefined,
          roomNumber: undefined,
          layoutDescription: '两室一厅',
          layoutCategory: '两室',
          rentMode: undefined,
          listingStatus: undefined
        })
      ], profileBindings(), catalog),
      /出租方式|房号|员工现表规则/i,
      '出租方式派生不得剥离含数字、字母、缺括号或裸尾注'
    )
  })
}

function testEmployeeProfileDerivesBlankCommunityFromValidatedLocationCatalog() {
  const catalog = buildLocationCatalog([location()])
  const prepared = prepareEmployeeSnapshot([
    source('legacy-blank-community', {
      community: '',
      roomLabel: '风雅乐府小区 8幢1单元801',
      building: '8',
      unit: '1',
      roomNumber: '801',
      layoutDescription: '两室一厅',
      layoutCategory: '两室一厅',
      rentMode: undefined,
      listingStatus: undefined
    })
  ], profileBindings(), catalog)
  assert.strictEqual(
    prepared.records[0].fields.community,
    '风雅乐府',
    '员工旧表独立小区列为空时，只能由完整位置字典的唯一别名前缀恢复标准小区'
  )
  const plan = planMirrorSync({
    sourceSnapshot: prepared,
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'legacy-blank-community'
  })
  assert.strictEqual(
    assertOperation(plan, 'legacy-blank-community', 'create', '空小区列').fields.roomLabel,
    '风雅乐府 8幢1单元801',
    '别名前缀恢复后必须重建标准小区房号'
  )

  assert.throws(
    () => prepareEmployeeSnapshot([
      source('legacy-blank-community-without-catalog', {
        community: '',
        roomLabel: '风雅乐府小区 8幢1单元802',
        building: '8',
        unit: '1',
        roomNumber: '802',
        rentMode: undefined,
        listingStatus: undefined
      })
    ]),
    /位置字典|小区|前缀/i,
    '员工旧表空小区列缺少本轮位置字典时必须阻断'
  )
  assert.throws(
    () => prepareEmployeeSnapshot([
      source('legacy-blank-community-unknown-prefix', {
        community: '',
        roomLabel: '未入字典小区 8幢1单元803',
        building: '8',
        unit: '1',
        roomNumber: '803',
        rentMode: undefined,
        listingStatus: undefined
      })
    ], profileBindings(), catalog),
    /位置字典|小区|前缀|匹配/i,
    '员工旧表空小区列的房号前缀未入字典时不得猜测'
  )

  const longestCatalog = buildLocationCatalog([
    location({
      recordId: 'loc-record-short-prefix',
      locationId: 'LOC-SHORT-PREFIX',
      community: '风雅',
      aliases: []
    }),
    location({
      recordId: 'loc-record-long-prefix',
      locationId: 'LOC-LONG-PREFIX',
      community: '风雅乐府',
      aliases: ['风雅乐府小区']
    })
  ])
  const longestPrepared = prepareEmployeeSnapshot([
    source('legacy-blank-community-longest-prefix', {
      community: '',
      roomLabel: '风雅乐府小区 9幢901',
      building: '9',
      unit: '',
      roomNumber: '901',
      layoutDescription: '两室一厅',
      layoutCategory: '两室一厅',
      rentMode: undefined,
      listingStatus: undefined
    })
  ], profileBindings(), longestCatalog)
  assert.strictEqual(
    longestPrepared.records[0].fields.community,
    '风雅乐府',
    '短前缀和长前缀同时命中时必须选择唯一最长位置，不能取字典遍历到的首项'
  )
}

function testEmployeeProfileExplicitBindingsTakePriorityAndNeverFallback() {
  const explicitBindings = profileBindings({
    rentMode: { fieldId: 'src-rent-mode' },
    listingStatus: { fieldId: 'src-listing-status' }
  })
  const explicit = prepareEmployeeSnapshot([
    source('explicit-valid', {
      roomLabel: '风雅乐府 6幢1单元601',
      roomNumber: '601',
      layoutDescription: '两室一厅（整）',
      layoutCategory: '两室',
      rentMode: '合租',
      listingStatus: '暂停'
    })
  ], explicitBindings)
  assert.strictEqual(explicit.records[0].fields.rentMode, '合租', '显式合法出租方式必须优先于派生规则')
  assert.strictEqual(explicit.records[0].fields.listingStatus, '暂停', '显式合法房态必须优先于当前集合派生值')

  ;[
    { field: 'rentMode', value: '', pattern: /出租方式|整租|合租/i },
    { field: 'rentMode', value: '整合租', pattern: /出租方式|整租|合租/i },
    { field: 'listingStatus', value: '', pattern: /状态|房态|缺少/i },
    { field: 'listingStatus', value: '待核验', pattern: /状态未配置|状态/i }
  ].forEach(({ field, value, pattern }, index) => {
    const prepared = prepareEmployeeSnapshot([
      source(`explicit-invalid-${index}`, {
        roomLabel: `风雅乐府 7幢1单元70${index}`,
        building: '7',
        roomNumber: `70${index}`,
        layoutDescription: '两室一厅（整）',
        layoutCategory: '两室',
        rentMode: field === 'rentMode' ? value : '整租',
        listingStatus: field === 'listingStatus' ? value : '在租'
      })
    ], explicitBindings)
    assert.throws(
      () => planMirrorSync({
        sourceSnapshot: prepared,
        mirrorSnapshot: snapshot([]),
        locationCatalog: buildLocationCatalog([location()]),
        runId: `explicit-invalid-${index}`
      }),
      pattern,
      `显式 ${field} 为空或非法时必须由严格 canonical 层整批阻断，不能回退派生`
    )
  })
}

function testEmployeeProfileNormalizesViewingAccessWithoutLeakingSourceNotes() {
  const codeCases = ['2468', '135790#']
  const sensitiveCases = [
    { value: '钥匙在管家处', expectedMethod: '钥匙' },
    { value: '联系房东取钥匙', expectedMethod: '钥匙' },
    { value: '7月30日空出可看', expectedMethod: '联系房东' },
    { value: '本周空置', expectedMethod: '联系房东' },
    { value: '8月1日退租到期', expectedMethod: '联系房东' },
    { value: '月底退租，搬离后可看', expectedMethod: '联系房东' },
    { value: '请电话联系', expectedMethod: '联系房东' },
    { value: '手机联系确认', expectedMethod: '联系房东' },
    { value: '加微信确认', expectedMethod: '联系房东' },
    { value: 'wxid_abcd1234', expectedMethod: '联系房东' },
    { value: 'wechat12345', expectedMethod: '联系房东' },
    { value: 'VX123456', expectedMethod: '联系房东' },
    { value: 'qq123456', expectedMethod: '联系房东' },
    { value: '2026-07-31', expectedMethod: '联系房东' },
    { value: '13800138000', expectedMethod: '联系房东' },
    { value: '138-0013-8000', expectedMethod: '联系房东' },
    { value: '13800138000-1', expectedMethod: '联系房东' },
    { value: '13800138000x', expectedMethod: '联系房东' },
    { value: '13800138000#1', expectedMethod: '联系房东' },
    { value: '13800138000*1', expectedMethod: '联系房东' },
    { value: 'abc13800138000', expectedMethod: '联系房东' },
    { value: '0571-87654321', expectedMethod: '联系房东' },
    { value: '86057112345678', expectedMethod: '联系房东' },
    { value: '0086057112345678', expectedMethod: '联系房东' },
    { value: '0571-12345678-123', expectedMethod: '联系房东' },
    { value: '0571-12345678#123', expectedMethod: '联系房东' },
    { value: '400-800-1234', expectedMethod: '联系房东' },
    { value: '864001234567', expectedMethod: '联系房东' },
    { value: '400-123-4567-1', expectedMethod: '联系房东' },
    { value: '400-123-4567#1', expectedMethod: '联系房东' },
    { value: '特殊情况待确认', expectedMethod: '联系房东' },
    { value: '123', expectedMethod: '联系房东' },
    { value: 'A9#*._-', expectedMethod: '联系房东' },
    { value: '12345678901234567890', expectedMethod: '联系房东' },
    { value: '12', expectedMethod: '联系房东' },
    { value: '123456789012345678901', expectedMethod: '联系房东' }
  ]
  const records = [
    ...codeCases.map((value, index) => source(`viewing-code-${index}`, {
      viewingMethod: value,
      layoutCategory: '两室',
      remark: '员工公开备注'
    })),
    ...sensitiveCases.map(({ value }, index) => source(`viewing-note-${index}`, {
      viewingMethod: value,
      layoutCategory: '两室',
      remark: '员工公开备注'
    }))
  ]
  const prepared = prepareEmployeeSnapshot(records)

  codeCases.forEach((value, index) => {
    const fields = prepared.records.find((record) => record.recordId === `viewing-code-${index}`).fields
    assert.strictEqual(fields.viewingMethod, '密码', '纯门锁码样式必须转换为统一看房方式“密码”')
    assert.strictEqual(fields.viewingPassword, value, '未单独绑定密码列时，纯门锁码必须进入专用密码字段')
    assert.strictEqual(fields.remark, '员工公开备注', '门锁码不得拼接或覆盖公开备注')
  })

  sensitiveCases.forEach(({ value, expectedMethod }, index) => {
    const fields = prepared.records.find((record) => record.recordId === `viewing-note-${index}`).fields
    assert.strictEqual(fields.viewingMethod, expectedMethod, `“${value}”必须收敛为安全的标准看房方式`)
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(fields, 'viewingPassword'),
      false,
      '钥匙、腾房日期、联系说明及无法确认文本不得写入密码字段'
    )
    assert.strictEqual(fields.remark, '员工公开备注', '腾房或联系说明不得拼接或覆盖公开备注')
    assert.strictEqual(JSON.stringify(fields).includes(value), false, '员工看房说明原文不得残留在专用表其他字段')
  })

  const strictSnapshot = snapshot([source('viewing-no-profile', { viewingMethod: 'A9#*' })])
  const unprepared = prepareSourceSnapshotForCompatibility(strictSnapshot)
  assert.strictEqual(unprepared.records[0].fields.viewingMethod, 'A9#*', '未启用员工兼容 profile 时不得改写严格源字段')
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(unprepared.records[0].fields, 'viewingPassword'),
    false,
    '未启用员工兼容 profile 时不得派生密码字段'
  )
}

function testEmployeeProfileNeverOverridesExplicitViewingPasswordBinding() {
  const explicitBindings = profileBindings({
    viewingPassword: { fieldId: 'src-viewing-password' }
  })
  const prepared = prepareEmployeeSnapshot([
    source('viewing-explicit-password', {
      viewingMethod: 'A9#*',
      layoutCategory: '两室',
      viewingPassword: 'EXPLICIT_987'
    })
  ], explicitBindings)

  const explicit = prepared.records.find((record) => record.recordId === 'viewing-explicit-password').fields
  assert.strictEqual(explicit.viewingMethod, '密码', '显式密码列不影响看房方式标准化')
  assert.strictEqual(explicit.viewingPassword, 'EXPLICIT_987', '显式密码列必须优先，兼容推导不得覆盖')

  ;[
    {
      recordId: 'viewing-explicit-blank',
      viewingMethod: 'B8#*',
      viewingPassword: '',
      pattern: /密码|为空|缺少|不一致/i,
      message: '显式密码列为空时不得从看房方式静默回填'
    },
    {
      recordId: 'viewing-key-with-password',
      viewingMethod: '联系管家取钥匙',
      viewingPassword: 'STALE_KEY_123',
      pattern: /钥匙|密码|冲突|不一致/i,
      message: '钥匙方式不得夹带显式密码列残留'
    },
    {
      recordId: 'viewing-contact-with-password',
      viewingMethod: '请电话联系',
      viewingPassword: 'STALE_CONTACT_123',
      pattern: /联系房东|密码|冲突|不一致/i,
      message: '联系房东方式不得夹带显式密码列残留'
    }
  ].forEach(({ recordId, viewingMethod, viewingPassword, pattern, message }) => {
    assert.throws(
      () => prepareEmployeeSnapshot([
        source(recordId, {
          viewingMethod,
          viewingPassword,
          layoutCategory: '两室'
        })
      ], explicitBindings),
      pattern,
      message
    )
  })

  const nonPassword = prepareEmployeeSnapshot([
    source('viewing-key-blank-password', {
      viewingMethod: '取钥匙',
      viewingPassword: '',
      layoutCategory: '两室'
    }),
    source('viewing-contact-blank-password', {
      viewingMethod: '月底空出可看',
      viewingPassword: '',
      layoutCategory: '两室'
    })
  ], explicitBindings)
  assert.deepStrictEqual(
    nonPassword.records.map((record) => record.fields.viewingMethod),
    ['钥匙', '联系房东'],
    '钥匙或联系说明配空显式密码列时必须允许安全标准化'
  )
  assert.ok(
    nonPassword.records.every((record) => !record.fields.viewingPassword),
    '钥匙或联系房东方式不得在规范结果中保留空密码字段'
  )

  const catalog = buildLocationCatalog([location()])
  ;[
    {
      runId: 'viewing-explicit-phone-password',
      sourceSnapshot: prepareEmployeeSnapshot([
        source('viewing-explicit-phone-password', {
          viewingMethod: '1234',
          viewingPassword: '13800138000',
          layoutCategory: '两室'
        })
      ], explicitBindings)
    },
    {
      runId: 'viewing-strict-phone-password',
      sourceSnapshot: snapshot([
        source('viewing-strict-phone-password', {
          viewingMethod: '密码',
          viewingPassword: '0571-12345678'
        })
      ])
    }
  ].forEach(({ runId, sourceSnapshot }) => {
    assert.throws(
      () => planMirrorSync({
        sourceSnapshot,
        mirrorSnapshot: snapshot([]),
        locationCatalog: catalog,
        runId
      }),
      /密码.*(?:电话|联系)|联系电话/,
      '显式密码字段无论来自兼容源还是标准源，都不得包含联系电话主体'
    )
  })
}

function testExplicitViewingPasswordRejectsSeparatedContactNumbersBeforeAnyWrite() {
  const explicitBindings = profileBindings({
    viewingPassword: { fieldId: 'src-viewing-password' }
  })
  const catalog = buildLocationCatalog([location()])
  const separators = [
    { label: '空格', value: ' ' },
    { label: '圆点', value: '.' },
    { label: '下划线', value: '_' },
    { label: '半角短横线', value: '-' },
    { label: '全角短横线', value: '－' },
    { label: '长横线', value: '—' },
    { label: '短横线', value: '–' },
    { label: '斜杠', value: '/' },
    { label: '间隔号', value: '·' },
    { label: '半角逗号', value: ',' },
    { label: '全角逗号', value: '，' },
    { label: '顿号', value: '、' },
    { label: '半角分号', value: ';' },
    { label: '全角分号', value: '；' },
    { label: '半角冒号', value: ':' },
    { label: '全角冒号', value: '：' },
    { label: '反斜杠', value: '\\' },
    { label: '竖线', value: '|' },
    { label: '圆点符号', value: '•' },
    { label: '字母伪装', value: 'abc' }
  ]
  const contactShapes = [
    { label: '手机号', groups: ['138', '0013', '8000'] },
    { label: '座机号', groups: ['0571', '8765', '4321'] },
    { label: '400 号码', groups: ['400', '800', '1234'] },
    { label: '800 号码', groups: ['800', '123', '4567'] }
  ]
  const separatedContacts = []
  separators.forEach((separator) => {
    contactShapes.forEach((shape) => {
      separatedContacts.push({
        label: `${shape.label}-${separator.label}`,
        value: shape.groups.join(separator.value)
      })
    })
  })
  ;[
    { label: '手机号-括号', value: '(138) 0013 8000' },
    { label: '座机号-括号', value: '(0571) 87654321' },
    { label: '400 号码-括号', value: '(400) 800 1234' },
    { label: '800 号码-括号', value: '(800) 123 4567' }
  ].forEach((item) => separatedContacts.push(item))

  separatedContacts.forEach(({ label, value }, index) => {
    let targetWrites = 0
    assert.throws(
      () => {
        const sourceSnapshot = prepareEmployeeSnapshot([
          source(`safe-before-sensitive-${index}`, {
            roomLabel: `风雅乐府 8幢1单元${100 + index}`,
            building: '8',
            roomNumber: String(100 + index),
            viewingMethod: '2468',
            viewingPassword: '2468',
            layoutCategory: '两室'
          }),
          source(`sensitive-separated-${index}`, {
            roomLabel: `风雅乐府 9幢1单元${100 + index}`,
            building: '9',
            roomNumber: String(100 + index),
            viewingMethod: '2468',
            viewingPassword: value,
            layoutCategory: '两室'
          })
        ], explicitBindings)
        const plan = planMirrorSync({
          sourceSnapshot,
          mirrorSnapshot: snapshot([]),
          locationCatalog: catalog,
          runId: `separated-contact-${index}`
        })
        plan.operations.forEach(() => {
          targetWrites += 1
        })
      },
      /密码.*(?:电话|联系)|联系电话/,
      `显式密码列中的${label}必须在整批计划返回前阻断`
    )
    assert.strictEqual(targetWrites, 0, `显式密码列中的${label}不得让同批任一目标写动作开始`)
  })

  const allowed = prepareEmployeeSnapshot([
    source('explicit-four-digit-code', {
      viewingMethod: '2468',
      viewingPassword: '2468',
      layoutCategory: '两室'
    }),
    source('explicit-seven-char-code', {
      roomLabel: '风雅乐府 2幢1单元202',
      building: '2',
      roomNumber: '202',
      viewingMethod: '135790#',
      viewingPassword: '135790#',
      layoutCategory: '两室'
    })
  ], explicitBindings)
  const allowedPlan = planMirrorSync({
    sourceSnapshot: allowed,
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'explicit-safe-door-codes'
  })
  assert.strictEqual(allowedPlan.counts.create, 2, '正常 4 位和 7 字符数字+#密码必须继续允许')

  ;['2026', '2026/07/31'].forEach((value, index) => {
    assert.throws(
      () => planMirrorSync({
        sourceSnapshot: prepareEmployeeSnapshot([
          source(`explicit-date-password-${index}`, {
            viewingMethod: '2468',
            viewingPassword: value,
            layoutCategory: '两室'
          })
        ], explicitBindings),
        mirrorSnapshot: snapshot([]),
        locationCatalog: catalog,
        runId: `explicit-date-password-${index}`
      }),
      /密码.*日期|日期说明/,
      '年份或日期不得因号码分隔符修复而被放行'
    )
  })
}

function testEmployeeProfileIgnoresOnlyFullyEmptyTemplate() {
  const emptyTemplate = {
    recordId: 'empty-template',
    fields: {}
  }
  const valid = source('valid-after-template', {
    rentMode: undefined,
    listingStatus: undefined,
    layoutDescription: '2室1厅（整）',
    layoutCategory: '两室'
  })
  const prepared = prepareEmployeeSnapshot([emptyTemplate, valid])
  assert.deepStrictEqual(
    prepared.records.map((record) => record.recordId),
    ['valid-after-template'],
    '只有全部已绑定业务字段为空的模板记录可以忽略'
  )
  assert.strictEqual(prepared.recordCount, 1, '忽略模板后快照记录数必须同步重算')

  assert.throws(
    () => prepareEmployeeSnapshot([{
      recordId: 'half-filled-template',
      fields: {
        layoutDescription: '2室1厅'
      }
    }]),
    /roomLabel|小区\+房号|房号|半填/i,
    '任一业务字段有值但缺少房号的半填行必须整批阻断'
  )
}

function testEmployeeProfileRestoreWritesActiveTriplet() {
  const prepared = prepareEmployeeSnapshot([
    source('profile-restore', {
      rentMode: undefined,
      listingStatus: undefined,
      layoutDescription: '2室1厅（整）',
      layoutCategory: '两室'
    })
  ])
  const plan = planMirrorSync({
    sourceSnapshot: prepared,
    mirrorSnapshot: snapshot([
      mirror('mirror-profile-restore', 'profile-restore', {
        listingStatus: '已下架',
        published: false,
        enabled: false
      })
    ]),
    locationCatalog: buildLocationCatalog([location()]),
    runId: 'profile-restore'
  })
  const restore = assertOperation(plan, 'profile-restore', 'restore', '员工现表兼容记录恢复')
  assert.strictEqual(restore.fields.listingStatus, '在租', '兼容记录恢复必须写回当前集合房态在租')
  assert.strictEqual(restore.fields.published, true, '兼容记录恢复必须重新公开')
  assert.strictEqual(restore.fields.enabled, true, '兼容记录恢复必须重新启用')
}

function testCanonicalLayerRemainsStrictWithoutProfilePreparation() {
  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: snapshot([source('strict-no-defaults', {
        rentMode: undefined,
        listingStatus: undefined
      })]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: buildLocationCatalog([location()]),
      runId: 'strict-no-defaults'
    }),
    /状态|出租方式|整租|合租|缺少/i,
    '直接调用 canonical 规划层时不得无条件默认出租方式或房态'
  )
}

function testDynamicLocationCatalogNeedsNoCodeConfiguration() {
  const catalog = buildLocationCatalog([
    location(),
    location({
      recordId: 'loc-record-xingqiao',
      locationId: 'LOC-XINGQIAO',
      district: '临平区',
      block: '星桥',
      community: '星桥花苑',
      aliases: ['星桥花苑一期']
    }),
    location({
      recordId: 'loc-record-wanxiang',
      locationId: 'LOC-WANXIANG',
      district: '拱墅区',
      block: '城北万象城',
      community: '城北万象中心',
      aliases: []
    })
  ])

  const plan = planMirrorSync({
    sourceSnapshot: snapshot([
      source('src-xingqiao', {
        community: '星桥花苑一期',
        monthlyRent: 2800
      }),
      source('src-yuhang-wanxiang', {
        community: '风雅乐府',
        listingStatus: '可租'
      }),
      source('src-gongshu-wanxiang', {
        community: '城北万象中心',
        listingStatus: '可租'
      })
    ]),
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'dynamic-location-test'
  })

  const dynamic = assertOperation(plan, 'src-xingqiao', 'create', '位置字典新增区域与板块')
  assert.strictEqual(dynamic.fields.locationId, 'LOC-XINGQIAO', '别名命中后必须绑定稳定 locationId')
  assert.strictEqual(dynamic.fields.locationRecordId, 'loc-record-xingqiao', '镜像必须保留位置字典 recordId')
  assert.strictEqual(dynamic.fields.district, '临平区', '新增行政区必须直接来自位置字典，无需代码配置')
  assert.strictEqual(dynamic.fields.block, '星桥', '新增板块必须直接来自位置字典，无需代码配置')
  assert.strictEqual(dynamic.fields.community, '星桥花苑', '源表别名必须归一到字典标准小区名')
  assert.strictEqual(dynamic.fields.roomLabel, '星桥花苑 1幢1单元101', '别名房号必须重建成标准小区房号，库存与待租表不得分裂')

  const yuhang = assertOperation(plan, 'src-yuhang-wanxiang', 'create', '余杭区城北万象城小区')
  const gongshu = assertOperation(plan, 'src-gongshu-wanxiang', 'create', '拱墅区城北万象城小区')
  assert.strictEqual(yuhang.fields.block, '城北万象城', '同名板块前置必须成立')
  assert.strictEqual(gongshu.fields.block, '城北万象城', '同名板块前置必须成立')
  assert.strictEqual(yuhang.fields.district, '余杭区', '风雅乐府必须按小区字典归属余杭区')
  assert.strictEqual(gongshu.fields.district, '拱墅区', '城北万象中心必须按小区字典归属拱墅区')
}

function testDuplicateIdentityAndAliasConflictsFailClosed() {
  const catalog = buildLocationCatalog([location()])

  {
    const sourceSnapshot = snapshot([
      source('src-duplicate'),
      source('src-duplicate', { monthlyRent: 3600 })
    ])
    const mirrorSnapshot = snapshot([])
    const inputs = { sourceSnapshot, mirrorSnapshot, catalog }
    expectBlockedWithoutMutation(
      () => planMirrorSync({ sourceSnapshot, mirrorSnapshot, locationCatalog: catalog, runId: 'duplicate-source' }),
      inputs,
      /重复|duplicate|source|record/i,
      '源快照重复 recordId 必须整批阻断'
    )
  }

  {
    const sourceSnapshot = snapshot([source('src-one')])
    const mirrorSnapshot = snapshot([
      mirror('mir-one', 'src-one'),
      mirror('mir-two', 'src-one', { monthlyRent: 3300 })
    ])
    const inputs = { sourceSnapshot, mirrorSnapshot, catalog }
    expectBlockedWithoutMutation(
      () => planMirrorSync({ sourceSnapshot, mirrorSnapshot, locationCatalog: catalog, runId: 'duplicate-mirror' }),
      inputs,
      /重复|duplicate|mirror|sourceRecordId|record/i,
      '镜像表重复 sourceRecordId 必须整批阻断'
    )
  }

  assert.throws(
    () => buildLocationCatalog([
      location({ recordId: 'loc-a', locationId: 'LOC-A', community: '甲小区', aliases: ['共同别名'] }),
      location({ recordId: 'loc-b', locationId: 'LOC-B', community: '乙小区', aliases: [' 共同别名 '] })
    ]),
    /别名|alias|冲突|重复/i,
    '启用位置记录的标准名或别名冲突必须整批阻断，不能先到先得'
  )
}

function testIncompleteOrEmptySourceCannotProduceWrites() {
  const catalog = buildLocationCatalog([location()])

  {
    const sourceSnapshot = snapshot([source('src-partial')], false)
    const mirrorSnapshot = snapshot([mirror('mir-still-active', 'src-still-active')])
    const inputs = { sourceSnapshot, mirrorSnapshot, catalog }
    expectBlockedWithoutMutation(
      () => planMirrorSync({ sourceSnapshot, mirrorSnapshot, locationCatalog: catalog, runId: 'incomplete-source' }),
      inputs,
      /完整|incomplete|complete|源/i,
      '分页不完整的源快照必须在计划阶段阻断，绝不能据此批量停用'
    )
  }

  {
    const sourceSnapshot = snapshot([])
    const mirrorSnapshot = snapshot([mirror('mir-still-active', 'src-still-active')])
    const inputs = { sourceSnapshot, mirrorSnapshot, catalog }
    expectBlockedWithoutMutation(
      () => planMirrorSync({ sourceSnapshot, mirrorSnapshot, locationCatalog: catalog, runId: 'empty-source' }),
      inputs,
      /空|empty|0|源/i,
      '空源快照必须阻断，绝不能把全部镜像软停用'
    )
  }
}

function testUnknownCommunityFailsClosed() {
  const catalog = buildLocationCatalog([location()])
  const sourceSnapshot = snapshot([
    source('src-unknown', { community: '未入位置字典的新小区' })
  ])
  const mirrorSnapshot = snapshot([])
  const inputs = { sourceSnapshot, mirrorSnapshot, catalog }
  expectBlockedWithoutMutation(
    () => planMirrorSync({ sourceSnapshot, mirrorSnapshot, locationCatalog: catalog, runId: 'unknown-location' }),
    inputs,
    /位置|location|小区|字典|匹配/i,
    '新小区未进入位置字典时必须整批阻断，不能靠模糊板块猜行政区'
  )
}

function testCanonicalDerivationAndAttachmentProjection() {
  const catalog = buildLocationCatalog([location()])
  const richVideo = {
    file_token: 'mock-video-token',
    name: 'room.mp4',
    size: 987654,
    type: 'video/mp4',
    tmp_url: 'https://source.invalid/temporary',
    url: 'https://source.invalid/file'
  }
  const createPlan = planMirrorSync({
    sourceSnapshot: snapshot([source('src-rich-video', {
      video: [richVideo],
      layoutCategory: '',
      published: false,
      canonical: false
    })]),
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'attachment-projection'
  })
  const created = assertOperation(createPlan, 'src-rich-video', 'create', '带只读元数据的附件')
  assert.deepStrictEqual(created.fields.video, [{ file_token: 'mock-video-token' }], '镜像写入只允许稳定 file_token，不得复制 tmp_url/url/size 等只读元数据')
  assert.strictEqual(created.fields.published, true, 'published 必须由服务端房态派生，员工同名字段不得控制')
  assert.strictEqual(created.fields.canonical, true, 'canonical 必须由服务端完整校验派生，员工同名字段不得控制')
  assert.strictEqual(created.fields.layoutCategory, '两室', '缺少户型分类时必须从同一权威户型描述派生')

  const sharedPlan = planMirrorSync({
    sourceSnapshot: snapshot([source('src-shared-rent', { rentMode: '合租' })]),
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'shared-rent-mode'
  })
  assert.strictEqual(
    assertOperation(sharedPlan, 'src-shared-rent', 'create', '合租房源').fields.rentMode,
    '合租',
    '合租必须作为权威字段原样进入专用源表，不能被后续默认成整租'
  )

  const readbackWithDifferentMetadata = mirror('mir-rich-video', 'src-rich-video', {
    video: [{
      file_token: 'mock-video-token',
      name: 'room.mp4',
      tmp_url: 'https://mirror.invalid/different-temporary-url',
      size: 123456
    }]
  })
  const noRepeatUpdate = planMirrorSync({
    sourceSnapshot: snapshot([source('src-rich-video', { video: [richVideo] })]),
    mirrorSnapshot: snapshot([readbackWithDifferentMetadata]),
    locationCatalog: catalog,
    runId: 'attachment-readback'
  })
  assert.strictEqual(noRepeatUpdate.noop, true, '附件临时 URL 和只读元数据变化不得导致每轮重复更新')

  const repairPublished = planMirrorSync({
    sourceSnapshot: snapshot([source('src-repair-published')]),
    mirrorSnapshot: snapshot([mirror('mir-repair-published', 'src-repair-published', { published: false })]),
    locationCatalog: catalog,
    runId: 'repair-published'
  })
  assert.strictEqual(
    assertOperation(repairPublished, 'src-repair-published', 'update', '镜像 published 被人工改坏').fields.published,
    true,
    'published 必须属于服务端托管字段，下一轮自动纠正'
  )

  const repairCanonical = planMirrorSync({
    sourceSnapshot: snapshot([source('src-repair-canonical')]),
    mirrorSnapshot: snapshot([mirror('mir-repair-canonical', 'src-repair-canonical', { canonical: false })]),
    locationCatalog: catalog,
    runId: 'repair-canonical'
  })
  assert.strictEqual(
    assertOperation(repairCanonical, 'src-repair-canonical', 'update', '镜像 canonical 被人工改坏').fields.canonical,
    true,
    'canonical 必须属于服务端托管字段，下一轮自动纠正'
  )

  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: snapshot([source('src-multi-video', {
        video: [richVideo, { file_token: 'second-token', name: 'second.mp4', type: 'video/mp4' }]
      })]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: catalog,
      runId: 'multiple-video'
    }),
    /多个|先到先得|附件/i,
    '同一房源多个视频附件必须整批阻断'
  )

  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: snapshot([source('src-empty-status', { listingStatus: ' ' })]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: catalog,
      runId: 'empty-status'
    }),
    /状态|缺少|源记录/i,
    '空房态不得默认派生 published=true'
  )

  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: snapshot([source('src-unknown-status', { listingStatus: '待确认' })]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: catalog,
      runId: 'unknown-status'
    }),
    /状态未配置|状态|源记录/i,
    '未知房态必须整批阻断，不能默认公开未确认房源'
  )

  ;['', '整租/合租', '未知'].forEach((rentMode) => {
    assert.throws(
      () => planMirrorSync({
        sourceSnapshot: snapshot([source(`src-invalid-rent-mode-${rentMode || 'empty'}`, { rentMode })]),
        mirrorSnapshot: snapshot([]),
        locationCatalog: catalog,
        runId: 'invalid-rent-mode'
      }),
      /出租方式|整租|合租/i,
      '出租方式为空或不明确时必须整批阻断，不能静默默认整租'
    )
  })

  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: snapshot([source('src-layout-conflict', {
        layoutDescription: '3室1厅',
        layoutCategory: '两室'
      })]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: catalog,
      runId: 'layout-conflict'
    }),
    /户型描述|户型分类|不一致/i,
    '户型描述与分类冲突时必须整批阻断，库存和待租表不能产生两个口径'
  )
}

function testLocationCoordinatesAreMandatory() {
  assert.throws(
    () => buildLocationCatalog([location({ latitude: '', longitude: '' })]),
    /经纬度|上图|坐标/i,
    '启用位置缺少坐标必须阻断，避免新小区进入列表却无法上图'
  )
}

function testRoomLabelCommunityAndUnitNormalization() {
  const catalog = buildLocationCatalog([location()])
  const plan = planMirrorSync({
    sourceSnapshot: snapshot([
      source('src-no-unit', { roomLabel: '风雅乐府1幢101室', building: '1', unit: '', roomNumber: '101' }),
      source('src-no-unit-dashed', { roomLabel: '风雅乐府-2幢-202', building: '2', unit: '', roomNumber: '202' })
    ]),
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'room-label-no-unit'
  })
  const compact = assertOperation(plan, 'src-no-unit', 'create', '无单元紧凑房号')
  assert.strictEqual(compact.fields.roomLabel, '风雅乐府 1幢101', '无单元紧凑房号必须重建为标准小区房号')
  assert.strictEqual(compact.fields.building, '1', '无单元房号仍必须解析楼栋')
  assert.strictEqual(compact.fields.unit, '', '无单元房号的 unit 必须明确为空')
  assert.strictEqual(compact.fields.roomNumber, '101', '无单元房号仍必须解析房间号')
  const dashed = assertOperation(plan, 'src-no-unit-dashed', 'create', '无单元分隔房号')
  assert.strictEqual(dashed.fields.roomLabel, '风雅乐府 2幢202', '分隔符格式也必须归一为同一标准房号')

  ;[
    { recordId: 'src-wrong-community', roomLabel: '其他小区1幢1单元101', pattern: /不属于|小区|字典/i },
    { recordId: 'src-ambiguous-room', roomLabel: '风雅乐府1幢1单元101额外', pattern: /格式|解析|房号/i }
  ].forEach(({ recordId, roomLabel, pattern }) => {
    assert.throws(
      () => planMirrorSync({
        sourceSnapshot: snapshot([source(recordId, { roomLabel })]),
        mirrorSnapshot: snapshot([]),
        locationCatalog: catalog,
        runId: recordId
      }),
      pattern,
      '错小区或含糊房号必须整批阻断，不能把小区文字误解析为楼栋'
    )
  })
}

function testTrailingChineseRoomAnnotationIsIgnoredWithoutCollapsingDuplicates() {
  const catalog = buildLocationCatalog([location()])
  const plan = planMirrorSync({
    sourceSnapshot: snapshot([
      source('src-annotated-no-unit', {
        roomLabel: '风雅乐府 12-345（状态注）',
        building: undefined,
        unit: undefined,
        roomNumber: undefined
      }),
      source('src-annotated-with-unit', {
        roomLabel: '风雅乐府 13-2-346(运营注)',
        building: undefined,
        unit: undefined,
        roomNumber: undefined
      })
    ]),
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'trailing-chinese-room-annotation'
  })
  const noUnit = assertOperation(plan, 'src-annotated-no-unit', 'create', '中文括号尾注无单元房号')
  assert.deepStrictEqual(
    [noUnit.fields.building, noUnit.fields.unit, noUnit.fields.roomNumber, noUnit.fields.roomLabel],
    ['12', '', '345', '风雅乐府 12幢345'],
    '全角中文括号尾注必须只作为说明剥离，稳定数字房号必须完整保留'
  )
  const withUnit = assertOperation(plan, 'src-annotated-with-unit', 'create', '中文括号尾注有单元房号')
  assert.deepStrictEqual(
    [withUnit.fields.building, withUnit.fields.unit, withUnit.fields.roomNumber, withUnit.fields.roomLabel],
    ['13', '2', '346', '风雅乐府 13幢2单元346'],
    '半角中文括号尾注也必须归一到同一房号身份'
  )

  ;[
    '风雅乐府 14-347（状态1）',
    '风雅乐府 14-347（status）',
    '风雅乐府 14-347（状态注',
    '风雅乐府 14-347状态注'
  ].forEach((roomLabel, index) => {
    assert.throws(
      () => planMirrorSync({
        sourceSnapshot: snapshot([source(`src-unsafe-annotation-${index}`, {
          roomLabel,
          building: undefined,
          unit: undefined,
          roomNumber: undefined
        })]),
        mirrorSnapshot: snapshot([]),
        locationCatalog: catalog,
        runId: `unsafe-annotation-${index}`
      }),
      /房号|格式|解析/i,
      '含数字、字母、缺括号或裸尾注不得被宽松剥离'
    )
  })

  assert.throws(
    () => planMirrorSync({
      sourceSnapshot: snapshot([
        source('src-duplicate-annotation-a', {
          roomLabel: '风雅乐府 15-348（状态注）',
          building: undefined,
          unit: undefined,
          roomNumber: undefined
        }),
        source('src-duplicate-annotation-b', {
          roomLabel: '风雅乐府 15-348（运营注）',
          building: undefined,
          unit: undefined,
          roomNumber: undefined
        })
      ]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: catalog,
      runId: 'duplicate-annotated-room'
    }),
    /重复|物理|房源|房号/i,
    '两个源行剥离尾注后落到同一物理房号时必须整批熔断，不能静默合并'
  )
}

function testFourSegmentRoomIdentityPreservesEverySegmentAndFailsClosed() {
  const catalog = buildLocationCatalog([
    location(),
    location({
      recordId: 'loc-record-xingqiao',
      locationId: 'LOC-XINGQIAO',
      district: '临平区',
      block: '星桥',
      community: '星桥花苑',
      aliases: ['星桥花苑小区']
    })
  ])
  const validInput = {
    sourceSnapshot: snapshot([source('src-four-segment', {
      roomLabel: '风雅乐府 1-2-301-01',
      building: '1',
      unit: '2',
      roomNumber: '301-01'
    })]),
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'four-segment-room'
  }
  const validPlan = planMirrorSync(validInput)
  const valid = assertOperation(validPlan, 'src-four-segment', 'create', '四段纯数字房号')
  assert.strictEqual(valid.fields.building, '1', '四段房号第一段必须完整保留为楼栋')
  assert.strictEqual(valid.fields.unit, '2', '四段房号第二段必须完整保留为单元')
  assert.strictEqual(valid.fields.roomNumber, '301-01', '四段房号第三、四段必须以单个连字符完整保留')
  assert.strictEqual(
    valid.fields.roomLabel,
    '风雅乐府 1幢2单元301-01',
    '四段房号必须重建为唯一、可回读的规范房号'
  )

  ;[
    {
      recordId: 'src-four-segment-nonnumeric',
      overrides: {
        roomLabel: '风雅乐府 1-2-A-01',
        building: undefined,
        unit: undefined,
        roomNumber: undefined
      },
      pattern: /房号|格式|解析/i,
      message: '四段格式只允许四个纯数字段'
    },
    {
      recordId: 'src-five-segment',
      overrides: {
        roomLabel: '风雅乐府 1-2-301-01-9',
        building: undefined,
        unit: undefined,
        roomNumber: undefined
      },
      pattern: /房号|格式|解析/i,
      message: '五段房号不得截断或猜测'
    },
    {
      recordId: 'src-four-segment-empty',
      overrides: {
        roomLabel: '风雅乐府 1--301-01',
        building: undefined,
        unit: undefined,
        roomNumber: undefined
      },
      pattern: /房号|格式|解析/i,
      message: '含空段的四段房号不得过滤空段后错位解析'
    },
    {
      recordId: 'src-four-segment-community-conflict',
      overrides: {
        community: '风雅乐府',
        roomLabel: '星桥花苑 1-2-301-01',
        building: undefined,
        unit: undefined,
        roomNumber: undefined
      },
      pattern: /不属于|小区|字典/i,
      message: '小区列与另一已知位置前缀冲突时不得自动改小区'
    },
    {
      recordId: 'src-four-segment-explicit-conflict',
      overrides: {
        roomLabel: '风雅乐府 1-2-301-01',
        building: '1',
        unit: '2',
        roomNumber: '301'
      },
      pattern: /显式|不一致|房号/i,
      message: '显式房号与四段解析结果冲突时必须阻断'
    }
  ].forEach(({ recordId, overrides, pattern, message }) => {
    const inputs = {
      sourceSnapshot: snapshot([source(recordId, overrides)]),
      mirrorSnapshot: snapshot([]),
      locationCatalog: catalog
    }
    expectBlockedWithoutMutation(
      () => planMirrorSync({
        ...inputs,
        runId: recordId
      }),
      inputs,
      pattern,
      message
    )
  })
}

function testReadbackMayOmitOptionalEmptyUnitWithoutRepeatUpdate() {
  const catalog = buildLocationCatalog([location()])
  const sourceRecord = source('src-readback-empty-unit', {
    roomLabel: '风雅乐府1幢101室',
    building: '1',
    unit: '',
    roomNumber: '101'
  })
  const initialPlan = planMirrorSync({
    sourceSnapshot: snapshot([sourceRecord]),
    mirrorSnapshot: snapshot([]),
    locationCatalog: catalog,
    runId: 'readback-empty-unit-create'
  })
  const expected = assertOperation(initialPlan, 'src-readback-empty-unit', 'create', '无单元房号').fields
  ;[
    { label: '省略', apply: (fields) => delete fields.unit },
    { label: 'null', apply: (fields) => { fields.unit = null } },
    { label: '空字符串', apply: (fields) => { fields.unit = '' } },
    { label: '空数组', apply: (fields) => { fields.unit = [] } }
  ].forEach(({ label, apply }, index) => {
    const readbackFields = JSON.parse(JSON.stringify(expected))
    apply(readbackFields)
    const repeatPlan = planMirrorSync({
      sourceSnapshot: snapshot([sourceRecord]),
      mirrorSnapshot: snapshot([{
        recordId: `mirror-readback-empty-unit-${index}`,
        fields: readbackFields
      }]),
      locationCatalog: catalog,
      runId: `readback-empty-unit-noop-${index}`
    })
    assert.strictEqual(
      repeatPlan.noop,
      true,
      `飞书把可选空单元回读为${label}时必须与源端空值等价，不能每轮重复更新`
    )
  })

  const staleFields = JSON.parse(JSON.stringify(expected))
  staleFields.unit = '1'
  const stalePlan = planMirrorSync({
    sourceSnapshot: snapshot([sourceRecord]),
    mirrorSnapshot: snapshot([{
      recordId: 'mirror-readback-stale-unit',
      fields: staleFields
    }]),
    locationCatalog: catalog,
    runId: 'readback-stale-unit-update'
  })
  assert.strictEqual(
    assertOperation(stalePlan, 'src-readback-empty-unit', 'update', '旧单元非空').fields.unit,
    '',
    '目标可选字段已有非空旧值时必须生成清空更新，不能把所有形态都当成空'
  )
}

function main() {
  testLifecyclePlanUsesStableSourceRecordId()
  testEmployeeProfileClassifiesAllThirtyFourVerifiedShapes()
  testEmployeeProfileNormalizesLegacyLayoutGranularitySafely()
  testEmployeeProfileStripsOnlyLegacyCommissionRoomSuffix()
  testEmployeeProfilesDeriveRentModeAfterStrictChineseRoomAnnotation()
  testEmployeeProfileDerivesBlankCommunityFromValidatedLocationCatalog()
  testEmployeeProfileExplicitBindingsTakePriorityAndNeverFallback()
  testEmployeeProfileNormalizesViewingAccessWithoutLeakingSourceNotes()
  testEmployeeProfileNeverOverridesExplicitViewingPasswordBinding()
  testExplicitViewingPasswordRejectsSeparatedContactNumbersBeforeAnyWrite()
  testEmployeeProfileIgnoresOnlyFullyEmptyTemplate()
  testEmployeeProfileRestoreWritesActiveTriplet()
  testCanonicalLayerRemainsStrictWithoutProfilePreparation()
  testDynamicLocationCatalogNeedsNoCodeConfiguration()
  testDuplicateIdentityAndAliasConflictsFailClosed()
  testIncompleteOrEmptySourceCannotProduceWrites()
  testUnknownCommunityFailsClosed()
  testCanonicalDerivationAndAttachmentProjection()
  testLocationCoordinatesAreMandatory()
  testRoomLabelCommunityAndUnitNormalization()
  testTrailingChineseRoomAnnotationIsIgnoredWithoutCollapsingDuplicates()
  testFourSegmentRoomIdentityPreservesEverySegmentAndFailsClosed()
  testReadbackMayOmitOptionalEmptyUnitWithoutRepeatUpdate()
  console.log('feishu-source-mirror-v1-test passed')
}

try {
  main()
} catch (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
}
