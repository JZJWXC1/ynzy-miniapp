'use strict'

const assert = require('assert')
const crypto = require('crypto')

const {
  buildLocationCatalog,
  planMirrorSync
} = require('../src/feishu-source-mirror')
const { buildMirrorSafetyDigests } = require('../src/feishu-sync')._internal

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function locationCatalog() {
  return buildLocationCatalog([{
    recordId: 'loc-contact-normalization',
    locationId: 'LOC-CONTACT-NORMALIZATION',
    city: '杭州市',
    district: '余杭区',
    block: '测试板块',
    community: '测试小区',
    latitude: 30.1,
    longitude: 120.1,
    aliases: [],
    enabled: true
  }])
}

function sourceRecord(contact, overrides = {}) {
  const fields = {
    community: '测试小区',
    roomLabel: '测试小区 1幢1单元101',
    monthlyRent: 3200,
    layoutDescription: '2室1厅',
    rentMode: '整租',
    listingStatus: '可租',
    ...overrides
  }
  if (contact !== undefined) fields.contact = contact
  return { recordId: 'src-contact-normalization', fields }
}

function canonicalMirrorFields(contact, overrides = {}) {
  const fields = {
    sourceRecordId: 'src-contact-normalization',
    locationId: 'LOC-CONTACT-NORMALIZATION',
    locationRecordId: 'loc-contact-normalization',
    city: '杭州市',
    district: '余杭区',
    block: '测试板块',
    community: '测试小区',
    roomLabel: '测试小区 1幢1单元101',
    building: '1',
    unit: '1',
    roomNumber: '101',
    latitude: 30.1,
    longitude: 120.1,
    monthlyRent: 3200,
    layoutDescription: '2室1厅',
    layoutCategory: '两室',
    rentMode: '整租',
    listingStatus: '可租',
    published: true,
    canonical: true,
    enabled: true,
    ...overrides
  }
  if (contact !== undefined) fields.contact = contact
  return fields
}

function snapshot(records, label, schemaBindings = []) {
  return {
    complete: true,
    records,
    recordCount: records.length,
    digest: sha256({ label, records }),
    schemaFingerprint: sha256({ label, schemaBindings }),
    schemaBindings
  }
}

function plan(contact, mirrorFields, sourceOverrides = {}, sourceContactType = '1') {
  const source = snapshot([sourceRecord(contact, sourceOverrides)], `source-${String(contact)}`, [{
    semantic: 'contact',
    fieldName: '联系电话',
    type: sourceContactType
  }])
  const mirrorRecords = mirrorFields
    ? [{ recordId: 'mir-contact-normalization', fields: mirrorFields }]
    : []
  const mirror = snapshot(mirrorRecords, 'mini-contact-type-13', [{
    semantic: 'contact',
    fieldName: '联系电话',
    type: '13'
  }])
  return {
    source,
    mirror,
    result: planMirrorSync({
      sourceSnapshot: source,
      mirrorSnapshot: mirror,
      locationCatalog: locationCatalog(),
      runId: 'contact-normalization-test'
    })
  }
}

function operationOf(result) {
  return (result.operations || []).find((operation) => operation.sourceRecordId === 'src-contact-normalization')
}

function assertNoPhoneWrite(operation, message) {
  if (!operation) return
  assert.ok(
    !Object.prototype.hasOwnProperty.call(operation.fields || {}, 'contact'),
    message
  )
}

function testInvalidValuesNeverReachPhoneField() {
  ;[
    '',
    '待补',
    '138 0000 0000',
    '138-0000-0000',
    '+8613800000000',
    '座机88888888'
  ].forEach((invalidContact, index) => {
    const { source, mirror, result } = plan(invalidContact, null, {}, index % 2 === 0 ? '1' : '13')
    assert.ok(['1', '13'].includes(source.schemaBindings[0].type), '测试前提必须覆盖源联系电话允许的文本/手机号字段')
    assert.strictEqual(mirror.schemaBindings[0].type, '13', '测试前提必须锁定目标联系电话是多维表 phone 字段')
    const operation = operationOf(result)
    assert.ok(operation && operation.type === 'create', '新源记录仍应生成 create')
    assertNoPhoneWrite(operation, `非法或占位联系电话不得进入 phone 字段：${invalidContact}`)
  })
}

function testExistingValidContactIsPreserved() {
  const existingPhone = '19900000001'
  const existing = canonicalMirrorFields(existingPhone)

  const update = operationOf(plan('待补', existing, { monthlyRent: 3300 }).result)
  assert.ok(update && update.type === 'update', '其他业务字段变化仍应生成 update')
  assertNoPhoneWrite(update, '非法源值触发的 update 必须省略 phone 字段')
  assert.strictEqual({ ...existing, ...update.fields }.contact, existingPhone, 'update 省略字段后必须保留目标快照已有合法联系电话')

  const restore = operationOf(plan('+8619900000001', { ...existing, enabled: false }).result)
  assert.ok(restore && restore.type === 'restore', '停用记录重新出现仍应生成 restore')
  assertNoPhoneWrite(restore, '非法源值触发的 restore 必须省略 phone 字段')
  assert.strictEqual({ ...existing, ...restore.fields }.contact, existingPhone, 'restore 省略字段后必须保留目标快照已有合法联系电话')
}

function testValidExactContactIsPropagated() {
  const exactPhone = '19900000002'
  const create = operationOf(plan(exactPhone, null).result)
  assert.strictEqual(create.fields.contact, exactPhone, '精确 11 位大陆手机号必须进入 create')

  const fullWidth = operationOf(plan('１９９０００００００３', null).result)
  assert.strictEqual(fullWidth.fields.contact, '19900000003', 'NFKC 后精确合法的全角号码必须按规范值写入')

  const update = operationOf(plan(exactPhone, canonicalMirrorFields('19900000004')).result)
  assert.ok(update && update.type === 'update', '合法源联系电话变化必须生成 update')
  assert.strictEqual(update.fields.contact, exactPhone, '合法源联系电话必须覆盖目标旧合法值')
}

function testInvalidValuesDoNotCauseUpdateLoop() {
  const existingInvalid = canonicalMirrorFields('待核验')
  const invalidPlan = plan('138-0000-0000', existingInvalid).result
  assert.strictEqual(operationOf(invalidPlan), undefined, '源与目标均无合法联系电话时不得制造循环 update')
  assert.deepStrictEqual(invalidPlan.counts, {
    create: 0,
    update: 0,
    deactivate: 0,
    restore: 0,
    noop: 1
  })

  const existingValid = canonicalMirrorFields('19900000005')
  const emptyPlan = plan('', existingValid).result
  assert.strictEqual(operationOf(emptyPlan), undefined, '空源值不得反复覆盖或刷新目标合法联系电话')
}

function digestInput({ source, mirror, operations, plannedRecords }) {
  return {
    sourceSnapshot: source,
    locationSnapshot: snapshot([], 'location'),
    mirrorSnapshot: mirror,
    operations,
    plannedRecords,
    resources: {
      sourceBaseToken: 'source-base-test',
      targetBaseToken: 'target-base-test',
      sourceTableId: 'source-table-test',
      locationTableId: 'location-table-test',
      miniTableId: 'mini-table-test',
      feishuApiBaseUrl: 'https://open.feishu.test'
    }
  }
}

function testPlanDigestsExplainBusinessIntent() {
  const invalidA = plan('待补', canonicalMirrorFields('19900000006'))
  const invalidB = plan('+8619900000006', canonicalMirrorFields('19900000006'))
  assert.strictEqual(invalidA.result.operations.length, 0)
  assert.strictEqual(invalidB.result.operations.length, 0)

  const plannedRecords = invalidA.mirror.records
  const digestsA = buildMirrorSafetyDigests(digestInput({
    source: invalidA.source,
    mirror: invalidA.mirror,
    operations: invalidA.result.operations,
    plannedRecords
  }))
  const digestsARepeat = buildMirrorSafetyDigests(digestInput({
    source: invalidA.source,
    mirror: invalidA.mirror,
    operations: invalidA.result.operations,
    plannedRecords
  }))
  assert.strictEqual(digestsA.mirrorPlanSha256, digestsARepeat.mirrorPlanSha256, '同一业务意图的完整计划摘要必须稳定')
  assert.strictEqual(digestsA.semanticMirrorPlanSha256, digestsARepeat.semanticMirrorPlanSha256, '同一业务意图的语义计划摘要必须稳定')

  const digestsB = buildMirrorSafetyDigests(digestInput({
    source: invalidB.source,
    mirror: invalidB.mirror,
    operations: invalidB.result.operations,
    plannedRecords
  }))
  assert.notStrictEqual(digestsA.mirrorPlanSha256, digestsB.mirrorPlanSha256, '原始源快照证据变化时完整摘要必须 fail-closed 地变化')
  assert.notStrictEqual(digestsA.semanticMirrorPlanSha256, digestsB.semanticMirrorPlanSha256, '语义摘要仍绑定源快照证据，非法值变化不得被静默掩盖')

  const valid = plan('19900000007', canonicalMirrorFields('19900000006'))
  const validOperation = operationOf(valid.result)
  const validDigests = buildMirrorSafetyDigests(digestInput({
    source: valid.source,
    mirror: valid.mirror,
    operations: valid.result.operations,
    plannedRecords: [{ recordId: 'mir-contact-normalization', fields: validOperation.fields }]
  }))
  assert.notStrictEqual(digestsA.mirrorPlanSha256, validDigests.mirrorPlanSha256, '合法联系电话变更必须进入完整计划摘要')
  assert.notStrictEqual(digestsA.semanticMirrorPlanSha256, validDigests.semanticMirrorPlanSha256, '合法联系电话变更必须进入语义计划摘要')
}

function main() {
  testInvalidValuesNeverReachPhoneField()
  testExistingValidContactIsPreserved()
  testValidExactContactIsPropagated()
  testInvalidValuesDoNotCauseUpdateLoop()
  testPlanDigestsExplainBusinessIntent()
  console.log('feishu-contact-value-normalization-v1-test passed')
}

main()
