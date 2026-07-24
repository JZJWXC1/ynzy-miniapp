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
