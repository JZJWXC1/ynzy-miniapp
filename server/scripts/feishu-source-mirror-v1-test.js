'use strict'

const assert = require('assert')

const {
  buildLocationCatalog,
  planMirrorSync
} = require('../src/feishu-source-mirror')

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
  assert.strictEqual(deactivate.fields.enabled, false, '源记录消失只能软停用，不得删除镜像记录')

  const restore = assertOperation(plan, 'src-restore', 'restore', '重新出现在源表的软停用记录')
  assert.strictEqual(restore.recordId, 'mir-restore', '恢复必须复用原镜像 recordId')
  assert.strictEqual(restore.fields.enabled, true, '恢复动作必须重新启用原镜像记录')

  assert.strictEqual(operationFor(plan, 'src-already-disabled'), undefined, '源表仍不存在且镜像已停用时必须 no-op')
  assert.strictEqual(operations(plan).length, 4, '新建、更新、软停用、恢复各一次之外不得有额外写入')
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

function main() {
  testLifecyclePlanUsesStableSourceRecordId()
  testDynamicLocationCatalogNeedsNoCodeConfiguration()
  testDuplicateIdentityAndAliasConflictsFailClosed()
  testIncompleteOrEmptySourceCannotProduceWrites()
  testUnknownCommunityFailsClosed()
  testCanonicalDerivationAndAttachmentProjection()
  testLocationCoordinatesAreMandatory()
  testRoomLabelCommunityAndUnitNormalization()
  console.log('feishu-source-mirror-v1-test passed')
}

try {
  main()
} catch (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
}
