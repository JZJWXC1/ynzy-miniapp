'use strict'

const assert = require('assert')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  validateFieldContract,
  createBitableClient
} = require('../src/feishu-bitable-client')

const BINDINGS = Object.freeze({
  community: { fieldId: 'fld-community-canonical', type: 1, required: true },
  rent: { fieldId: 'fld-rent-canonical', type: 2, required: true },
  video: { fieldId: 'fld-video-canonical', type: 17, required: false }
})

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

function field(fieldId, fieldName, type) {
  return { field_id: fieldId, field_name: fieldName, type }
}

function success(body) {
  return response(200, { code: 0, msg: 'success', data: body })
}

function requestMethod(options) {
  return String((options && options.method) || 'GET').toUpperCase()
}

function assertOnlyGets(calls, message) {
  assert.ok(calls.length > 0, `${message}：测试前置必须实际发起读取请求`)
  calls.forEach((call) => {
    assert.strictEqual(call.method, 'GET', `${message}：失败链路不得发起写请求`)
  })
}

async function expectReject(factory, pattern, message) {
  let error = null
  try {
    await factory()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  if (pattern) {
    assert.match(String(error.message || error), pattern, `${message}；实际错误：${error && error.message}`)
  }
  return error
}

function makeClient(fetchImpl, pageSize = 2, overrides = {}) {
  return createBitableClient({
    baseUrl: 'https://open.feishu.example.test/open-apis',
    appToken: 'app-token-for-test-only',
    accessToken: 'access-token-for-test-only',
    pageSize,
    fetchImpl,
    maxRetries: 0,
    ...overrides
  })
}

function makeRenameSafeFetch({ canonicalName, communityValue, videoValue, rentValue = 3200 }) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url))
    calls.push({ url: parsed.toString(), method: requestMethod(options) })

    if (parsed.pathname.endsWith('/fields')) {
      return success({
        items: [
          field('fld-community-canonical', canonicalName, 1),
          field('fld-rent-canonical', '押一付一月租金', 2),
          field('fld-video-canonical', '视频链接', 17),
          field('fld-community-decoy', '小区', 1)
        ],
        has_more: false
      })
    }

    if (parsed.pathname.endsWith('/records')) {
      return success({
        items: [{
          record_id: 'rec-source-001',
          fields: {
            [canonicalName]: communityValue,
            小区: '显示名诱饵小区',
            押一付一月租金: rentValue,
            视频链接: videoValue || [{ file_token: 'mock-file-token', name: 'room.mp4' }]
          }
        }],
        has_more: false
      })
    }

    throw new Error(`测试触达了非预期接口：${parsed.pathname}`)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

async function testFieldIdSurvivesDisplayRename() {
  const beforeFetch = makeRenameSafeFetch({
    canonicalName: '小区（旧显示名）',
    communityValue: '风雅乐府'
  })
  const afterFetch = makeRenameSafeFetch({
    canonicalName: '小区（员工改名后）',
    communityValue: '风雅乐府'
  })

  const before = await makeClient(beforeFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false
  })
  const after = await makeClient(afterFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false
  })

  assert.strictEqual(before.complete, true, '完整读取必须显式标记 complete=true')
  assert.strictEqual(after.complete, true, '字段显示名变化后仍必须完整读取')
  assert.strictEqual(after.recordCount, 1, 'recordCount 必须等于完整分页后的记录数')
  assert.deepStrictEqual(after.records, [{
    recordId: 'rec-source-001',
    fields: {
      community: '风雅乐府',
      rent: 3200,
      video: [{ file_token: 'mock-file-token', name: 'room.mp4' }]
    }
  }], '读取结果必须按 semantic 输出，不能泄漏或依赖当前显示名')
  assert.notStrictEqual(after.records[0].fields.community, '显示名诱饵小区', '同名诱饵字段不得覆盖绑定 field_id')
  assert.strictEqual(typeof after.digest, 'string', '完整快照必须返回 digest')
  assert.ok(after.digest.length >= 8, 'digest 不得为空壳')
  assert.strictEqual(typeof after.schemaFingerprint, 'string', '完整快照必须返回 schemaFingerprint')
  assert.ok(after.schemaFingerprint.length >= 8, 'schemaFingerprint 不得为空壳')
  assert.strictEqual(after.schemaFingerprint, before.schemaFingerprint, '只改显示名不得改变按 field_id 建立的契约指纹')
  assert.strictEqual(after.digest, before.digest, '同一语义数据只改显示名不得改变快照摘要')
  assert.strictEqual(after.fieldNames.community, '小区（员工改名后）', '写入映射必须来自本轮 field_id 对应的当前显示名')
  assertOnlyGets(beforeFetch.calls.concat(afterFetch.calls), '字段改名兼容读取')
}

async function testAttachmentDigestIgnoresTemporaryMetadata() {
  const first = await makeClient(makeRenameSafeFetch({
    canonicalName: '小区（附件摘要）',
    communityValue: '风雅乐府',
    videoValue: [{ file_token: 'same-token', name: 'room.mp4', tmp_url: 'https://temporary.invalid/first', size: 100 }]
  })).readValidatedTableSnapshot({ tableId: 'tbl-source', bindings: BINDINGS, allowEmpty: false })
  const second = await makeClient(makeRenameSafeFetch({
    canonicalName: '小区（附件摘要）',
    communityValue: '风雅乐府',
    videoValue: [{ file_token: 'same-token', name: 'renamed.mp4', tmp_url: 'https://temporary.invalid/second', size: 999 }]
  })).readValidatedTableSnapshot({ tableId: 'tbl-source', bindings: BINDINGS, allowEmpty: false })
  assert.notDeepStrictEqual(first.records[0].fields.video, second.records[0].fields.video, '测试前置必须真的改变附件临时元数据')
  assert.strictEqual(first.digest, second.digest, '完整快照摘要只能依赖稳定 file_token，不能被 tmp_url、文件名或大小制造假变化')
}

async function testNumberFieldStringReadbackNormalizesAtContractBoundary() {
  const numericStringFetch = makeRenameSafeFetch({
    canonicalName: '小区（数字回读）',
    communityValue: '风雅乐府',
    rentValue: '3200'
  })
  const snapshot = await makeClient(numericStringFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false
  })
  assert.strictEqual(
    snapshot.records[0].fields.rent,
    3200,
    '飞书数值字段以数字字符串回读时必须在字段契约边界归一为有限数字'
  )

  for (const [invalidValue, label] of [
    ['not-a-number', '非数字文本'],
    ['0x10', '十六进制文本'],
    ['0b10', '二进制文本'],
    [' 3200 ', '带首尾空白的数字文本'],
    ['   ', '纯空白文本']
  ]) {
    const invalidNumericFetch = makeRenameSafeFetch({
      canonicalName: `小区（非法数字回读-${label}）`,
      communityValue: '风雅乐府',
      rentValue: invalidValue
    })
    await expectReject(
      () => makeClient(invalidNumericFetch).readValidatedTableSnapshot({
        tableId: 'tbl-source',
        bindings: BINDINGS,
        allowEmpty: false
      }),
      /数字|数值|number|rent|必填|为空/i,
      `飞书数值字段回读为${label}时必须整批阻断`
    )
    assertOnlyGets(invalidNumericFetch.calls, `非法数字回读-${label}`)
  }
}

function testSchemaValidationFailsClosed() {
  const validFields = [
    field('fld-community-canonical', '任意小区显示名', 1),
    field('fld-rent-canonical', '任意租金显示名', 2),
    field('fld-video-canonical', '任意视频显示名', 17)
  ]

  const validated = validateFieldContract({ fields: validFields, bindings: BINDINGS })
  assert.ok(validated, '合法字段契约必须返回可供读取阶段使用的校验结果')

  const nullableButRequiredInSchema = {
    ...BINDINGS,
    remark: {
      fieldId: 'fld-remark-nullable',
      type: 1,
      required: false,
      schemaRequired: true
    }
  }
  assert.throws(
    () => validateFieldContract({ fields: validFields, bindings: nullableButRequiredInSchema }),
    /remark|字段|缺少|missing/i,
    '必建但单元格可空的 field_id 被删除时也必须整批阻断'
  )
  assert.doesNotThrow(
    () => validateFieldContract({
      fields: validFields.concat(field('fld-remark-nullable', '备注（可空）', 1)),
      bindings: nullableButRequiredInSchema
    }),
    '必建可空字段存在时不得被误判为逐行必填'
  )

  assert.throws(
    () => validateFieldContract({
      fields: validFields.filter((item) => item.field_id !== 'fld-rent-canonical'),
      bindings: BINDINGS
    }),
    /field|字段|缺少|missing/i,
    'required field_id 缺失必须整批阻断'
  )

  assert.throws(
    () => validateFieldContract({
      fields: validFields.map((item) => item.field_id === 'fld-rent-canonical' ? { ...item, type: 1 } : item),
      bindings: BINDINGS
    }),
    /type|类型|field|字段/i,
    'field_id 命中但类型错误必须整批阻断'
  )

  assert.throws(
    () => validateFieldContract({
      fields: validFields.concat(field('fld-rent-canonical', '重复租金字段', 2)),
      bindings: BINDINGS
    }),
    /重复|duplicate|field/i,
    '字段元数据出现重复 field_id 必须整批阻断'
  )

  assert.throws(
    () => validateFieldContract({
      fields: validFields,
      bindings: {
        ...BINDINGS,
        anotherRent: { fieldId: 'fld-rent-canonical', type: 2, required: true }
      }
    }),
    /重复|duplicate|field/i,
    '两个 semantic 绑定同一 field_id 必须整批阻断'
  )

  assert.throws(
    () => validateFieldContract({
      fields: [
        field('fld-community-canonical', '同名字段', 1),
        field('fld-rent-canonical', '同名字段', 2),
        field('fld-video-canonical', '视频', 17)
      ],
      bindings: BINDINGS
    }),
    /显示名|覆盖|重复/i,
    '两个 field_id 解析到同一当前显示名必须阻断，避免 fields map 坍缩'
  )
}

async function testRequiredCellValueMustExist() {
  const fetchImpl = makeRenameSafeFetch({
    canonicalName: '小区（员工源列）',
    communityValue: '   '
  })
  await expectReject(
    () => makeClient(fetchImpl).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false
    }),
    /必填|required|community|为空/i,
    '字段元数据存在但必填单元格为空时也必须整批阻断'
  )
  assertOnlyGets(fetchImpl.calls, '必填单元格为空')
}

async function testBatchWriteRequestContract() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url))
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url: parsed, method: requestMethod(options), body })
    const records = body && Array.isArray(body.records) ? body.records : []
    return success({ records: records.map((record, index) => ({
      record_id: record.record_id || `mir-created-${index + 1}`,
      fields: record.fields
    })) })
  }
  const client = makeClient(fetchImpl)
  const clientToken = '123e4567-e89b-42d3-a456-426614174000'
  await client.batchCreateRecords('tbl-mini-only', [{ fields: { 当前小区列名: '风雅乐府' } }], { clientToken })
  await client.batchUpdateRecords('tbl-mini-only', [{ record_id: 'mir-one', fields: { 当前租金列名: 3500 } }])

  assert.strictEqual(calls.length, 2, '批量新增与更新必须各发起一次请求')
  assert.strictEqual(calls[0].method, 'POST', '批量新增必须使用 POST')
  assert.ok(calls[0].url.pathname.endsWith('/tables/tbl-mini-only/records/batch_create'), '批量新增只能指向显式传入的专用表')
  assert.strictEqual(calls[0].url.searchParams.get('client_token'), clientToken, '批量新增必须携带 UUIDv4 client_token')
  assert.deepStrictEqual(calls[0].body, { records: [{ fields: { 当前小区列名: '风雅乐府' } }] }, '批量新增请求体必须保持 records/fields 官方结构')
  assert.ok(calls[1].url.pathname.endsWith('/tables/tbl-mini-only/records/batch_update'), '批量更新只能指向显式传入的专用表')
  assert.deepStrictEqual(calls[1].body.records[0], { record_id: 'mir-one', fields: { 当前租金列名: 3500 } }, '批量更新必须带镜像 record_id')

  const beforeInvalidUuid = calls.length
  await expectReject(
    () => client.batchCreateRecords('tbl-mini-only', [{ fields: { 小区: '甲' } }], { clientToken: 'mirror-not-a-uuid' }),
    /UUIDv4|client_token/i,
    '非 UUIDv4 client_token 必须在发请求前阻断'
  )
  assert.strictEqual(calls.length, beforeInvalidUuid, '非法 client_token 不得触发远端写')

  const mismatchClient = makeClient(async () => success({ records: [] }))
  await expectReject(
    () => mismatchClient.batchUpdateRecords('tbl-mini-only', [{ record_id: 'mir-one', fields: { 租金: 3600 } }]),
    /数量|records/i,
    '飞书批量写响应数量不一致必须阻断，不能假报成功'
  )
}

async function testTransientWriteRetriesAreBounded() {
  const calls = []
  const client = makeClient(async (url, options = {}) => {
    calls.push({ url: String(url), method: requestMethod(options) })
    if (calls.length <= 2) return response(200, { code: 1254290, msg: 'synthetic transient conflict', data: {} })
    const body = JSON.parse(options.body)
    return success({ records: body.records })
  }, 2, { maxRetries: 2, retryDelayMs: 1 })
  const result = await client.batchUpdateRecords('tbl-mini-only', [{ record_id: 'mir-retry', fields: { 租金: 3300 } }])
  assert.strictEqual(result.length, 1, '飞书短暂冲突恢复后必须返回完整批量结果')
  assert.strictEqual(calls.length, 3, '可重试飞书错误必须有限重试且成功后立即停止')
  calls.forEach((call) => assert.strictEqual(call.method, 'POST', '批量更新重试必须保持同一写方法'))

  let exhaustedCalls = 0
  const exhausted = makeClient(async () => {
    exhaustedCalls += 1
    return response(504, { code: 504, msg: 'synthetic gateway timeout', data: {} })
  }, 2, { maxRetries: 2, retryDelayMs: 1 })
  await expectReject(
    () => exhausted.batchUpdateRecords('tbl-mini-only', [{ record_id: 'mir-retry', fields: { 租金: 3400 } }]),
    /504|请求失败/i,
    '短暂错误超过有限次数后必须失败，不能无限占用同步锁'
  )
  assert.strictEqual(exhaustedCalls, 3, 'maxRetries=2 时总请求次数必须严格为 3')
}

function makePagedFetch(recordPageHandler) {
  const calls = []
  let recordCalls = 0
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url))
    const call = { url: parsed.toString(), method: requestMethod(options) }
    calls.push(call)

    if (parsed.pathname.endsWith('/fields')) {
      return success({
        items: [
          field('fld-community-canonical', '小区', 1),
          field('fld-rent-canonical', '月租金', 2),
          field('fld-video-canonical', '视频', 17)
        ],
        has_more: false
      })
    }

    if (parsed.pathname.endsWith('/records')) {
      recordCalls += 1
      return recordPageHandler({
        callNumber: recordCalls,
        pageToken: parsed.searchParams.get('page_token') || ''
      })
    }

    throw new Error(`测试触达了非预期接口：${parsed.pathname}`)
  }
  fetchImpl.calls = calls
  fetchImpl.recordCalls = () => recordCalls
  return fetchImpl
}

function createdTimeRecord(recordId, createdTimeFields = {}) {
  return {
    record_id: recordId,
    fields: { 小区: '甲小区', 月租金: 3000, 视频: [] },
    ...createdTimeFields
  }
}

async function testRecordCreatedTimeContract() {
  const fixedNowMs = 1784822400000
  const snakeCaseFetch = makePagedFetch(() => success({
    items: [createdTimeRecord('rec-created-snake', { created_time: '1784736000000' })],
    has_more: false
  }))
  const snakeCaseSnapshot = await makeClient(snakeCaseFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: fixedNowMs
  })
  assert.strictEqual(
    snakeCaseSnapshot.records[0].createdTimeMs,
    1784736000000,
    '飞书 created_time 数字字符串必须规范化为严格的毫秒整数'
  )
  const requiredCreatedTimeRecordCalls = snakeCaseFetch.calls
    .filter((call) => new URL(call.url).pathname.endsWith('/records'))
  assert.ok(requiredCreatedTimeRecordCalls.length > 0, '创建时间必需模式必须真实读取记录接口')
  requiredCreatedTimeRecordCalls.forEach((call) => {
    assert.strictEqual(
      new URL(call.url).searchParams.get('automatic_fields'),
      'true',
      '创建时间必需模式必须向飞书显式请求 automatic_fields=true'
    )
  })
  const requiredCreatedTimeFieldCalls = snakeCaseFetch.calls
    .filter((call) => new URL(call.url).pathname.endsWith('/fields'))
  assert.ok(requiredCreatedTimeFieldCalls.length > 0, '创建时间必需模式必须先读取字段契约')
  requiredCreatedTimeFieldCalls.forEach((call) => {
    assert.strictEqual(
      new URL(call.url).searchParams.has('automatic_fields'),
      false,
      'automatic_fields 只能用于记录接口，不得扩大字段接口请求'
    )
  })

  const pagedCreatedTimeFetch = makePagedFetch(({ callNumber, pageToken }) => {
    if (callNumber === 1) {
      assert.strictEqual(pageToken, '', '创建时间分页第一页不得携带 page_token')
      return success({
        items: [createdTimeRecord('rec-created-page-1', { created_time: '1784649600000' })],
        has_more: true,
        page_token: 'created-page-2'
      })
    }
    assert.strictEqual(pageToken, 'created-page-2', '创建时间分页第二页必须沿用服务端 token')
    return success({
      items: [createdTimeRecord('rec-created-page-2', { created_time: '1784736000000' })],
      has_more: false
    })
  })
  const pagedCreatedTimeSnapshot = await makeClient(pagedCreatedTimeFetch, 1)
    .readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false,
      requireCreatedTime: true,
      nowMs: fixedNowMs
    })
  assert.strictEqual(pagedCreatedTimeSnapshot.recordCount, 2, '创建时间模式必须完整读取全部记录分页')
  const pagedCreatedTimeRecordCalls = pagedCreatedTimeFetch.calls
    .filter((call) => new URL(call.url).pathname.endsWith('/records'))
  assert.strictEqual(pagedCreatedTimeRecordCalls.length, 2, '创建时间分页用例必须真实读取两页')
  pagedCreatedTimeRecordCalls.forEach((call) => {
    assert.strictEqual(
      new URL(call.url).searchParams.get('automatic_fields'),
      'true',
      '创建时间模式的每一页记录请求都必须保留 automatic_fields=true'
    )
  })

  const camelCaseFetch = makePagedFetch(() => success({
    items: [createdTimeRecord('rec-created-camel', { createdTime: 1784736000000 })],
    has_more: false
  }))
  const camelCaseSnapshot = await makeClient(camelCaseFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: fixedNowMs
  })
  assert.strictEqual(
    camelCaseSnapshot.records[0].createdTimeMs,
    1784736000000,
    '兼容形态 createdTime 也必须规范化为 createdTimeMs'
  )

  const optionalMissingFetch = makePagedFetch(() => success({
    items: [createdTimeRecord('rec-created-optional', { last_modified_time: '1784736000000' })],
    has_more: false
  }))
  const optionalMissingSnapshot = await makeClient(optionalMissingFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    nowMs: fixedNowMs
  })
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(optionalMissingSnapshot.records[0], 'createdTimeMs'),
    false,
    '默认可选模式缺少创建时间时不得伪造 createdTimeMs，last_modified_time 也不得替代'
  )
  const optionalCreatedTimeRecordCalls = optionalMissingFetch.calls
    .filter((call) => new URL(call.url).pathname.endsWith('/records'))
  optionalCreatedTimeRecordCalls.forEach((call) => {
    assert.strictEqual(
      new URL(call.url).searchParams.has('automatic_fields'),
      false,
      '创建时间可选模式不得无条件扩大飞书自动字段响应'
    )
  })

  const firstDigestFetch = makePagedFetch(() => success({
    items: [createdTimeRecord('rec-created-digest', { created_time: '1784649600000' })],
    has_more: false
  }))
  const secondDigestFetch = makePagedFetch(() => success({
    items: [createdTimeRecord('rec-created-digest', { created_time: '1784736000000' })],
    has_more: false
  }))
  const firstDigest = await makeClient(firstDigestFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: fixedNowMs
  })
  const secondDigest = await makeClient(secondDigestFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: fixedNowMs
  })
  assert.notStrictEqual(
    firstDigest.digest,
    secondDigest.digest,
    '同一记录字段相同但 createdTimeMs 不同时，完整快照 digest 必须变化'
  )

  for (const [createdTimeFields, requireCreatedTime, label] of [
    [{}, true, '必需模式缺失'],
    [{ last_modified_time: '1784736000000' }, true, '仅有最后修改时间'],
    [{ created_time: 0 }, true, '零值'],
    [{ created_time: -1 }, true, '负数'],
    [{ created_time: 1784736000000.5 }, true, '小数'],
    [{ created_time: 1784736000 }, true, '秒级时间戳'],
    [{ created_time: ' 1784736000000 ' }, true, '带空白字符串'],
    [{ created_time: '1.784736e12' }, true, '指数格式字符串'],
    [{ created_time: '1784908800000' }, true, '未来时间'],
    [{ created_time: 'not-a-time' }, false, '可选模式非法值']
  ]) {
    const invalidFetch = makePagedFetch(() => success({
      items: [createdTimeRecord(`rec-created-invalid-${label}`, createdTimeFields)],
      has_more: false
    }))
    await expectReject(
      () => makeClient(invalidFetch).readValidatedTableSnapshot({
        tableId: 'tbl-source',
        bindings: BINDINGS,
        allowEmpty: false,
        requireCreatedTime,
        nowMs: fixedNowMs
      }),
      /创建时间|created_time|createdTime|毫秒|未来|缺失|非法/i,
      `${label}必须整批阻断`
    )
    assertOnlyGets(invalidFetch.calls, `创建时间契约-${label}`)
  }
}

async function testCreatedTimeCutoffSeparatesLiveValidationClock() {
  const callStartedAt = 1784822400000
  const recordCreatedAt = callStartedAt + 1000
  let liveNowMs = callStartedAt
  const originalDateNow = Date.now
  const liveClockFetch = makePagedFetch(() => {
    liveNowMs = recordCreatedAt + 1000
    return success({
      items: [createdTimeRecord('rec-created-during-read', {
        created_time: String(recordCreatedAt)
      })],
      has_more: false
    })
  })
  Date.now = () => liveNowMs
  try {
    const snapshot = await makeClient(liveClockFetch).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false,
      requireCreatedTime: true
    })
    assert.strictEqual(
      snapshot.records[0].createdTimeMs,
      recordCreatedAt,
      '默认实时校验时钟必须在完整读取后采样，读取期间合法新增的记录不得被误判为未来'
    )
  } finally {
    Date.now = originalDateNow
  }

  const cutoffMs = 1784822400000
  const validationNowMs = cutoffMs + 10_000
  const earlyRecord = createdTimeRecord('rec-before-cutoff', {
    created_time: String(cutoffMs - 1000)
  })
  const boundaryRecord = createdTimeRecord('rec-at-cutoff', {
    created_time: String(cutoffMs)
  })
  const deferredRecord = createdTimeRecord('rec-after-cutoff', {
    created_time: String(cutoffMs + 1000)
  })
  const cutoffFetch = makePagedFetch(() => success({
    items: [earlyRecord, boundaryRecord, deferredRecord],
    has_more: false
  }))
  const cutoffSnapshot = await makeClient(cutoffFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: validationNowMs,
    createdTimeCutoffMs: cutoffMs
  })
  assert.strictEqual(cutoffSnapshot.recordCount, 2, '批次截止时间之后的合法新增行必须延后到下一批')
  assert.strictEqual(
    cutoffSnapshot.deferredRecordCount,
    1,
    '快照必须只暴露脱敏的延后记录计数，供同步证据核对'
  )
  assert.deepStrictEqual(
    cutoffSnapshot.records.map((record) => record.recordId),
    ['rec-before-cutoff', 'rec-at-cutoff'],
    '截止时刻等于 created_time 的记录必须纳入，有效快照只排除严格晚于截止的记录'
  )

  const futureCutoffFetch = makePagedFetch(() => success({
    items: [earlyRecord],
    has_more: false
  }))
  await expectReject(
    () => makeClient(futureCutoffFetch).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false,
      requireCreatedTime: true,
      nowMs: validationNowMs,
      createdTimeCutoffMs: validationNowMs + 1
    }),
    /createdTimeCutoffMs|截止|实时校验时间|未来/i,
    '批次截止时间不得晚于实时校验时钟，避免未来 observedAt 污染生命周期'
  )

  const earlyOnlyFetch = makePagedFetch(() => success({
    items: [earlyRecord, boundaryRecord],
    has_more: false
  }))
  const earlyOnlySnapshot = await makeClient(earlyOnlyFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: validationNowMs
  })
  assert.strictEqual(
    cutoffSnapshot.digest,
    earlyOnlySnapshot.digest,
    '批次截止过滤后必须按有效记录重算摘要，保证双预演与正式提交使用同一输入'
  )

  const repeatedCutoffFetch = makePagedFetch(() => success({
    items: [earlyRecord, boundaryRecord, deferredRecord],
    has_more: false
  }))
  const repeatedCutoffSnapshot = await makeClient(repeatedCutoffFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: validationNowMs,
    createdTimeCutoffMs: cutoffMs
  })
  assert.deepStrictEqual(
    {
      records: repeatedCutoffSnapshot.records,
      recordCount: repeatedCutoffSnapshot.recordCount,
      digest: repeatedCutoffSnapshot.digest
    },
    {
      records: cutoffSnapshot.records,
      recordCount: cutoffSnapshot.recordCount,
      digest: cutoffSnapshot.digest
    },
    '同一批次 cutoff 下，后来出现的合法新行不得改变 dry-run 与 apply 的有效快照'
  )

  const nextRunFetch = makePagedFetch(() => success({
    items: [earlyRecord, boundaryRecord, deferredRecord],
    has_more: false
  }))
  const nextRunSnapshot = await makeClient(nextRunFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: validationNowMs,
    createdTimeCutoffMs: cutoffMs + 1000
  })
  assert.strictEqual(nextRunSnapshot.recordCount, 3, '下一批提高 cutoff 后必须接住上一批延后的合法新增行')
  assert.notStrictEqual(nextRunSnapshot.digest, cutoffSnapshot.digest, '下一批纳入新行后摘要必须变化')

  const changedOldRecordFetch = makePagedFetch(() => success({
    items: [
      {
        ...earlyRecord,
        fields: { ...earlyRecord.fields, 月租金: 3200 }
      },
      boundaryRecord,
      deferredRecord
    ],
    has_more: false
  }))
  const changedOldRecordSnapshot = await makeClient(changedOldRecordFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: false,
    requireCreatedTime: true,
    nowMs: validationNowMs,
    createdTimeCutoffMs: cutoffMs
  })
  assert.notStrictEqual(
    changedOldRecordSnapshot.digest,
    cutoffSnapshot.digest,
    'cutoff 只能延后新行，不能掩盖截止前既有行的字段修改'
  )

  const invalidDeferredFetch = makePagedFetch(() => success({
    items: [
      earlyRecord,
      {
        ...deferredRecord,
        fields: { ...deferredRecord.fields, 小区: '' }
      }
    ],
    has_more: false
  }))
  await expectReject(
    () => makeClient(invalidDeferredFetch).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false,
      requireCreatedTime: true,
      nowMs: validationNowMs,
      createdTimeCutoffMs: cutoffMs
    }),
    /必填|为空|小区|community/i,
    'cutoff 后准备延后的行也必须先完成字段契约校验'
  )

  const trulyFutureFetch = makePagedFetch(() => success({
    items: [createdTimeRecord('rec-truly-future-after-cutoff', {
      created_time: String(validationNowMs + 1)
    })],
    has_more: false
  }))
  await expectReject(
    () => makeClient(trulyFutureFetch).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false,
      requireCreatedTime: true,
      nowMs: validationNowMs,
      createdTimeCutoffMs: cutoffMs
    }),
    /创建时间|未来|当前时间/i,
    '截止时间之后的记录也必须先完成真实未来校验，不得被过滤逻辑藏掉'
  )

  const missingCreatedTimeFetch = makePagedFetch(() => success({
    items: [createdTimeRecord('rec-cutoff-without-created-time')],
    has_more: false
  }))
  await expectReject(
    () => makeClient(missingCreatedTimeFetch).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false,
      createdTimeCutoffMs: cutoffMs
    }),
    /截止|创建时间|requireCreatedTime/i,
    '没有强制 created_time 的快照不得启用批次截止过滤'
  )

  const nullCutoffFetch = makePagedFetch(() => success({
    items: [earlyRecord],
    has_more: false
  }))
  await expectReject(
    () => makeClient(nullCutoffFetch).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false,
      requireCreatedTime: true,
      createdTimeCutoffMs: null
    }),
    /createdTimeCutoffMs|正整数|毫秒/i,
    '显式 null 截止时间不得被当成“未提供”而绕过严格类型门'
  )

  const allDeferredFetch = makePagedFetch(() => success({
    items: [deferredRecord],
    has_more: false
  }))
  await expectReject(
    () => makeClient(allDeferredFetch).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false,
      requireCreatedTime: true,
      nowMs: validationNowMs,
      createdTimeCutoffMs: cutoffMs
    }),
    /为空|截止|有效快照/i,
    '原表非空但本批有效快照为空时仍必须 fail-closed，不能误触发批量撤下'
  )
}

async function testPaginationMustBeComplete() {
  {
    const fetchImpl = makePagedFetch(({ callNumber, pageToken }) => {
      if (callNumber === 1) {
        assert.strictEqual(pageToken, '', '第一页不得凭空携带 page_token')
        return success({
          items: [{ record_id: 'rec-1', fields: { 小区: '甲小区', 月租金: 3000, 视频: [] } }],
          has_more: true,
          page_token: 'next-page'
        })
      }
      assert.strictEqual(pageToken, 'next-page', '第二页必须使用服务端返回的 page_token')
      return response(503, { code: 503, msg: 'synthetic second page failure' })
    })
    await expectReject(
      () => makeClient(fetchImpl, 1).readValidatedTableSnapshot({ tableId: 'tbl-source', bindings: BINDINGS, allowEmpty: false }),
      /503|请求|分页|page/i,
      '第二页失败时不得把第一页伪装成完整快照'
    )
    assert.strictEqual(fetchImpl.recordCalls(), 2, '第二页失败用例必须真实触达第二页')
    assertOnlyGets(fetchImpl.calls, '第二页失败')
  }

  {
    const fetchImpl = makePagedFetch(() => success({
      items: [{ record_id: 'rec-1', fields: { 小区: '甲小区', 月租金: 3000, 视频: [] } }],
      has_more: true
    }))
    await expectReject(
      () => makeClient(fetchImpl).readValidatedTableSnapshot({ tableId: 'tbl-source', bindings: BINDINGS, allowEmpty: false }),
      /token|分页|page/i,
      'has_more=true 却没有下一页 token 必须阻断'
    )
    assert.strictEqual(fetchImpl.recordCalls(), 1, '缺 token 应在第一页立即阻断')
    assertOnlyGets(fetchImpl.calls, '缺少下一页 token')
  }

  {
    const fetchImpl = makePagedFetch(() => success({
      items: [{ record_id: 'rec-1', fields: { 小区: '甲小区', 月租金: 3000, 视频: [] } }]
    }))
    await expectReject(
      () => makeClient(fetchImpl, 1).readValidatedTableSnapshot({ tableId: 'tbl-source', bindings: BINDINGS, allowEmpty: false }),
      /has_more|分页|类型|缺失/i,
      'has_more 缺失时不得把当前页伪装成完整快照'
    )
    assert.strictEqual(fetchImpl.recordCalls(), 1, 'has_more 缺失应在第一页立即阻断')
    assertOnlyGets(fetchImpl.calls, 'has_more 缺失')
  }

  {
    const fetchImpl = makePagedFetch(({ callNumber, pageToken }) => {
      if (callNumber > 2) throw new Error('测试防死循环：客户端未识别重复 page_token')
      if (callNumber === 1) {
        return success({
          items: [{ record_id: 'rec-1', fields: { 小区: '甲小区', 月租金: 3000, 视频: [] } }],
          has_more: true,
          page_token: 'loop-token'
        })
      }
      assert.strictEqual(pageToken, 'loop-token', '第二页前置必须真实使用 loop-token')
      return success({
        items: [{ record_id: 'rec-2', fields: { 小区: '乙小区', 月租金: 3100, 视频: [] } }],
        has_more: true,
        page_token: 'loop-token'
      })
    })
    await expectReject(
      () => makeClient(fetchImpl, 1).readValidatedTableSnapshot({ tableId: 'tbl-source', bindings: BINDINGS, allowEmpty: false }),
      /重复|循环|token/i,
      '服务端重复 page_token 必须主动阻断，不能无限循环'
    )
    assert.strictEqual(fetchImpl.recordCalls(), 2, '重复 token 必须在第二次出现时阻断')
    assertOnlyGets(fetchImpl.calls, '重复下一页 token')
  }
}

async function testEmptyTablePolicy() {
  const fetchImpl = makePagedFetch(() => success({ items: [], has_more: false }))
  await expectReject(
    () => makeClient(fetchImpl).readValidatedTableSnapshot({ tableId: 'tbl-source', bindings: BINDINGS, allowEmpty: false }),
    /空|empty|0/i,
    'allowEmpty=false 时空源表必须 fail-closed'
  )
  assertOnlyGets(fetchImpl.calls, '空源表阻断')

  const allowedFetch = makePagedFetch(() => success({ items: [], has_more: false }))
  const allowed = await makeClient(allowedFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: true
  })
  assert.strictEqual(allowed.complete, true, '显式 allowEmpty=true 时空表仍是完整读取')
  assert.deepStrictEqual(allowed.records, [], '显式允许空表时 records 必须为空数组')
  assert.strictEqual(allowed.recordCount, 0, '显式允许空表时 recordCount 必须为 0')
  assertOnlyGets(allowedFetch.calls, '允许空源表读取')

  const omittedItemsFetch = makePagedFetch(() => success({ has_more: false, total: 0 }))
  const omittedItemsAllowed = await makeClient(omittedItemsFetch).readValidatedTableSnapshot({
    tableId: 'tbl-source',
    bindings: BINDINGS,
    allowEmpty: true
  })
  assert.strictEqual(omittedItemsAllowed.complete, true, '飞书首次空表省略 items 时仍必须形成完整快照')
  assert.deepStrictEqual(omittedItemsAllowed.records, [], '仅 total=0 的首个终止页可把省略 items 解释为空数组')
  assert.strictEqual(omittedItemsAllowed.recordCount, 0, '省略 items 的合法首次空表计数必须为 0')
  assertOnlyGets(omittedItemsFetch.calls, '飞书首次空表省略 items')

  const laterPageOmittedItemsFetch = makePagedFetch(({ callNumber, pageToken }) => {
    if (callNumber === 1) {
      assert.strictEqual(pageToken, '', '后续页缺 items 用例的第一页不得携带 page_token')
      return success({
        items: [{ record_id: 'rec-first-page', fields: { 小区: '甲小区', 月租金: 3000, 视频: [] } }],
        has_more: true,
        page_token: 'second-page'
      })
    }
    assert.strictEqual(pageToken, 'second-page', '后续页缺 items 用例必须真实进入第二页')
    return success({ has_more: false, total: 0 })
  })
  await expectReject(
    () => makeClient(laterPageOmittedItemsFetch, 1).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: true
    }),
    /items|分页|响应/i,
    '只有首个空表终止页可以省略 items，已有数据后的第二页即使 total=0 也必须阻断'
  )
  assert.strictEqual(laterPageOmittedItemsFetch.recordCalls(), 2, '后续页缺 items 用例必须真实触达第二页')
  assertOnlyGets(laterPageOmittedItemsFetch.calls, '后续页缺 items')

  for (const [payload, message] of [
    [{ has_more: false, total: 1 }, 'total 非零'],
    [{ has_more: false }, 'total 缺失'],
    [{ has_more: true, total: 0, page_token: 'unexpected-next' }, '仍声明继续分页']
  ]) {
    const malformedFetch = makePagedFetch(() => success(payload))
    await expectReject(
      () => makeClient(malformedFetch).readValidatedTableSnapshot({
        tableId: 'tbl-source',
        bindings: BINDINGS,
        allowEmpty: true
      }),
      /items|分页|响应/i,
      `缺少 items 且${message}时必须阻断`
    )
    assertOnlyGets(malformedFetch.calls, `缺少 items 且${message}`)
  }
}

async function testResponseBodyTimeoutCoversWholeRequest() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: requestMethod(options), signal: options.signal })
    return {
      ok: true,
      status: 200,
      json: () => new Promise(() => {})
    }
  }
  const startedAt = Date.now()
  await expectReject(
    () => makeClient(fetchImpl, 2, { requestTimeoutMs: 20 }).readValidatedTableSnapshot({
      tableId: 'tbl-source',
      bindings: BINDINGS,
      allowEmpty: false
    }),
    /超时|timeout/i,
    '飞书已返回响应头但响应体卡住时也必须按统一超时释放同步锁'
  )
  assert.ok(Date.now() - startedAt < 1000, '响应体超时必须有界，不能永久占住同步互斥锁')
  assert.strictEqual(calls.length, 1, '响应体超时时不得继续读取记录或发起写请求')
  assert.strictEqual(calls[0].method, 'GET', '响应体超时链路必须保持只读')
  assert.strictEqual(calls[0].signal.aborted, true, '超时时必须中止底层飞书请求')
}

function testEnvironmentBindingParserRejectsStringBoolean() {
  const configPath = path.resolve(__dirname, '..', 'src', 'config.js')
  const invalid = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      FEISHU_SOURCE_FIELD_BINDINGS: JSON.stringify({
        community: { fieldId: 'fld-community', required: 'false' }
      })
    }
  })
  assert.notStrictEqual(invalid.status, 0, 'required="false" 不得被 JavaScript truthy 规则误当 true')
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /required|布尔/i, '错误必须明确指出 required 只能使用 JSON 布尔值')

  const valid = spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(configPath)});process.stdout.write(JSON.stringify(c.feishu.sourceFieldBindings))`], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      FEISHU_SOURCE_FIELD_BINDINGS: JSON.stringify({ community: 'fld-community-only' })
    }
  })
  assert.strictEqual(valid.status, 0, `只提供稳定 field_id 的绑定必须可解析：${valid.stderr}`)
  assert.deepStrictEqual(JSON.parse(valid.stdout), { community: { fieldId: 'fld-community-only' } }, '环境只负责 field_id，类型与必填规则由代码契约补齐')
}

async function main() {
  testSchemaValidationFailsClosed()
  await testFieldIdSurvivesDisplayRename()
  await testAttachmentDigestIgnoresTemporaryMetadata()
  await testNumberFieldStringReadbackNormalizesAtContractBoundary()
  await testRequiredCellValueMustExist()
  await testRecordCreatedTimeContract()
  await testCreatedTimeCutoffSeparatesLiveValidationClock()
  await testPaginationMustBeComplete()
  await testEmptyTablePolicy()
  await testBatchWriteRequestContract()
  await testTransientWriteRetriesAreBounded()
  await testResponseBodyTimeoutCoversWholeRequest()
  testEnvironmentBindingParserRejectsStringBoolean()
  console.log('feishu-source-contract-v1-test passed')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
