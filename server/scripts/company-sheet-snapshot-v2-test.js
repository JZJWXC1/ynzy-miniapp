const assert = require('assert')
const crypto = require('crypto')

const serverContract = require('../src/company-sheet-snapshot-contract')
const feishuSync = require('../src/feishu-sync')
const clientContract = require('../../utils/company-sheet-snapshot-contract')

const EXPECTED_KEYS = [
  'district',
  'block',
  'community',
  'roomLabel',
  'layoutDescription',
  'layoutCategory',
  'monthlyRent',
  'viewingMethod',
  'remark',
  'listingStatus'
]

const EXPECTED_HEADERS = [
  '行政区',
  '板块/商圈',
  '小区',
  '小区+房号',
  '户型描述',
  '户型分类',
  '月租金',
  '看房方式',
  '备注',
  '房源状态'
]

const EXPECTED_OUTPUT_FIELDS = [
  'columnCount',
  'columnKeys',
  'contentSha256',
  'contract',
  'dataRowCount',
  'minReaderVersion',
  'rows',
  'schemaVersion',
  'sensitiveStripped',
  'snapshotId',
  'sourceMode',
  'title',
  'unavailable',
  'updatedAt'
]

function listingRow(overrides = {}) {
  const values = Object.assign({
    district: '拱墅区',
    block: '祥符',
    community: '棠润府',
    roomLabel: '棠润府 1幢101',
    layoutDescription: '两室一厅整租',
    layoutCategory: '两室',
    monthlyRent: '3200',
    viewingMethod: '密码',
    remark: '公开备注',
    listingStatus: '即将空出'
  }, overrides)
  return EXPECTED_KEYS.map((key) => values[key])
}

function availableInput(overrides = {}) {
  return Object.assign({
    updatedAt: '2026-08-02 12:30:45',
    rows: [listingRow()],
    sensitiveStripped: true
  }, overrides)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function mustReject(build, pattern, message) {
  assert.throws(build, pattern, message)
}

function mustClientReject(snapshot, message) {
  assert.strictEqual(clientContract.validateCompanySheetSnapshotV2(snapshot), false, message)
  const model = clientContract.toHomepageCompanySheetModel(snapshot)
  assert.strictEqual(model.invalidSchema, true, `${message}：首页模型必须 fail-closed`)
  assert.strictEqual(model.listingCount, 0, `${message}：不得发布部分数据`)
}

assert.deepStrictEqual(serverContract.COLUMN_KEYS, EXPECTED_KEYS, '服务端必须固定十个语义列键')
assert.deepStrictEqual(serverContract.DISPLAY_HEADERS, EXPECTED_HEADERS, '服务端必须固定十个展示表头')
assert.deepStrictEqual(clientContract.COLUMN_KEYS, EXPECTED_KEYS, '客户端必须与服务端使用同一列序')
assert.deepStrictEqual(clientContract.DISPLAY_HEADERS, EXPECTED_HEADERS, '客户端必须与服务端使用同一表头')
assert.strictEqual(serverContract.CONTRACT, 'ynzy.company-sheet.snapshot')
assert.strictEqual(serverContract.SOURCE_MODE, 'feishu-mini-mirror-v2')
assert.strictEqual(serverContract.SCHEMA_VERSION, 2)
assert.strictEqual(serverContract.MIN_READER_VERSION, 2)

const first = serverContract.createCompanySheetSnapshotV2(Object.assign(availableInput(), {
  sheetUrl: 'https://example.invalid/private',
  token: 'never-output-this'
}))
assert.deepStrictEqual(Object.keys(first).sort(), EXPECTED_OUTPUT_FIELDS, 'v2 响应只能输出固定白名单字段')
assert.strictEqual(first.contract, serverContract.CONTRACT)
assert.strictEqual(first.sourceMode, serverContract.SOURCE_MODE)
assert.strictEqual(first.schemaVersion, 2)
assert.strictEqual(first.minReaderVersion, 2)
assert.deepStrictEqual(first.columnKeys, EXPECTED_KEYS)
assert.strictEqual(first.title, '寓你住一起房源表')
assert.strictEqual(first.unavailable, false)
assert.strictEqual(first.dataRowCount, 1)
assert.strictEqual(first.columnCount, 10)
assert.strictEqual(first.sensitiveStripped, true)
assert.deepStrictEqual(first.rows, [listingRow()])
assert.ok(/^[a-f0-9]{64}$/.test(first.contentSha256), '内容摘要必须是 SHA-256')
assert.strictEqual(first.snapshotId, `company-sheet-v2:${first.contentSha256}`, '快照身份必须由内容摘要唯一决定')
assert.ok(!first.rows.some((row) => JSON.stringify(row) === JSON.stringify(EXPECTED_HEADERS)), 'v2 数据行不得混入表头')

const changedTime = serverContract.createCompanySheetSnapshotV2(availableInput({
  updatedAt: '2026-08-02 12:31:46'
}))
assert.strictEqual(changedTime.contentSha256, first.contentSha256, 'updatedAt 不得影响内容摘要')
assert.strictEqual(changedTime.snapshotId, first.snapshotId, '同一内容的快照身份必须稳定')

const changedContent = serverContract.createCompanySheetSnapshotV2(availableInput({
  rows: [listingRow({ monthlyRent: '3300' })]
}))
assert.notStrictEqual(changedContent.contentSha256, first.contentSha256, '任一业务单元格变化必须改变摘要')
assert.notStrictEqual(changedContent.snapshotId, first.snapshotId, '任一业务单元格变化必须改变快照身份')

const canonicalJson = serverContract.canonicalCompanySheetContent(first)
assert.ok(!canonicalJson.includes('2026-08-02 12:30:45'), '摘要输入必须显式排除 updatedAt')
assert.strictEqual(
  first.contentSha256,
  crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
  '服务端摘要必须来自公开的确定性内容序列化'
)
assert.strictEqual(clientContract.sha256Hex(canonicalJson), first.contentSha256, '小程序纯 JS 摘要必须与服务端一致')

const validZero = serverContract.createCompanySheetSnapshotV2(availableInput({ rows: [] }))
const unavailable = serverContract.createUnavailableCompanySheetSnapshotV2()
assert.strictEqual(validZero.unavailable, false, '合法零行是可用快照')
assert.strictEqual(validZero.dataRowCount, 0)
assert.strictEqual(unavailable.unavailable, true, '不可用必须有独立状态')
assert.strictEqual(unavailable.dataRowCount, 0)
assert.notStrictEqual(validZero.contentSha256, unavailable.contentSha256, '合法零行与不可用状态不得共用摘要')
assert.strictEqual(clientContract.toHomepageCompanySheetModel(validZero).invalidSchema, false)
assert.strictEqual(clientContract.toHomepageCompanySheetModel(validZero).unavailable, false)
assert.strictEqual(clientContract.toHomepageCompanySheetModel(unavailable).invalidSchema, false)
assert.strictEqual(clientContract.toHomepageCompanySheetModel(unavailable).unavailable, true)

EXPECTED_KEYS.slice(0, 4).forEach((key, index) => {
  const row = listingRow()
  row[index] = ''
  mustReject(
    () => serverContract.createCompanySheetSnapshotV2(availableInput({ rows: [row] })),
    new RegExp(key),
    `${key} 必须是自包含必填字段`
  )
})
mustReject(
  () => serverContract.createCompanySheetSnapshotV2(availableInput({ rows: [listingRow().slice(0, 9)] })),
  /10/,
  '数据行列数不对必须拒绝'
)
mustReject(
  () => serverContract.createCompanySheetSnapshotV2(availableInput({ rows: [EXPECTED_HEADERS] })),
  /表头/,
  '数据区混入表头必须拒绝'
)
mustReject(
  () => serverContract.createCompanySheetSnapshotV2(availableInput({ sensitiveStripped: false })),
  /脱敏/,
  '未经脱敏的输入不得发布'
)

const trustedV1 = {
  title: '寓你住一起房源表',
  updatedAt: '2026-08-02 12:30:45',
  rows: [EXPECTED_HEADERS, listingRow({ monthlyRent: 3200 })],
  rowCount: 2,
  columnCount: 10,
  sourceMode: 'feishu-mini-mirror-v1',
  schemaVersion: 1,
  sensitiveStripped: true,
  privateField: 'must-not-leak'
}
const converted = serverContract.convertTrustedV1SnapshotToV2(trustedV1)
assert.deepStrictEqual(converted.rows, [listingRow()], '可信 v1 只剥离精确表头，不得猜列')
assert.strictEqual(converted.dataRowCount, 1)
assert.ok(!Object.prototype.hasOwnProperty.call(converted, 'privateField'))

const legacyMergedRows = clone(trustedV1)
legacyMergedRows.rows.push(listingRow({
  district: '上城区',
  block: '',
  community: '',
  roomLabel: '第二行独立房号'
}))
legacyMergedRows.rowCount = legacyMergedRows.rows.length
const strictLegacy = feishuSync.sanitizeSheetSnapshot(legacyMergedRows, { fillMergedCells: false })
assert.strictEqual(strictLegacy.rows[2][1], '', 'v2 发布前不得向下继承上一行板块')
assert.strictEqual(strictLegacy.rows[2][2], '', 'v2 发布前不得向下继承上一行小区')
mustReject(
  () => serverContract.convertTrustedV1SnapshotToV2(strictLegacy),
  /block|community/,
  '缺板块/小区的第二行必须阻断 v2 签发，不能借上一行补齐'
)

const migratedFromAbsentV2 = feishuSync.cachedSheetSnapshotV2({ companySheetSnapshot: trustedV1 })
assert.ok(migratedFromAbsentV2 && migratedFromAbsentV2.unavailable === false, '真正缺失 v2 字段时允许一次严格 v1 迁移')
const damagedStoredV2 = clone(first)
damagedStoredV2.contentSha256 = '0'.repeat(64)
assert.strictEqual(
  feishuSync.cachedSheetSnapshotV2({
    companySheetSnapshot: trustedV1,
    companySheetSnapshotV2: damagedStoredV2
  }),
  null,
  'v2 字段已存在但摘要损坏时必须 fail-closed，不能回退旧 v1'
)

const wrongHeader = clone(trustedV1)
;[wrongHeader.rows[0][0], wrongHeader.rows[0][1]] = [wrongHeader.rows[0][1], wrongHeader.rows[0][0]]
mustReject(() => serverContract.convertTrustedV1SnapshotToV2(wrongHeader), /表头/, '同类型列换位也必须 fail-closed')
const guessedHeader = clone(trustedV1)
guessedHeader.rows[0][0] = '区域'
mustReject(() => serverContract.convertTrustedV1SnapshotToV2(guessedHeader), /表头/, '不得用别名猜测 v1 列语义')
const mergedV1 = clone(trustedV1)
mergedV1.rows.push(listingRow({ district: '', block: '', community: '' }))
mergedV1.rowCount = mergedV1.rows.length
mustReject(() => serverContract.convertTrustedV1SnapshotToV2(mergedV1), /district|block|community/, '不得向下填充合并单元格')
const repeatedHeader = clone(trustedV1)
repeatedHeader.rows.push(EXPECTED_HEADERS.slice())
repeatedHeader.rowCount = repeatedHeader.rows.length
mustReject(() => serverContract.convertTrustedV1SnapshotToV2(repeatedHeader), /表头/, '数据区重复表头必须拒绝')
const untrustedV1 = clone(trustedV1)
untrustedV1.sourceMode = 'legacy-sheet'
mustReject(() => serverContract.convertTrustedV1SnapshotToV2(untrustedV1), /v1/, '只允许转换固定可信 v1')
const unavailableV1 = Object.assign(clone(trustedV1), {
  unavailable: true,
  rows: [EXPECTED_HEADERS.slice()],
  rowCount: 1
})
assert.strictEqual(serverContract.convertTrustedV1SnapshotToV2(unavailableV1).unavailable, true)

assert.strictEqual(clientContract.validateCompanySheetSnapshotV2(first), true, '完整 v2 必须通过客户端校验')
assert.strictEqual(serverContract.validateCompanySheetSnapshotV2(first), true, '服务端缓存读取也必须复验完整 v2 契约')
assert.deepStrictEqual(serverContract.parseCompanySheetSnapshotV2(first), first, '服务端复验只返回固定白名单副本')
const model = clientContract.toHomepageCompanySheetModel(first)
assert.deepStrictEqual(model.header, EXPECTED_HEADERS)
assert.deepStrictEqual(model.dataRows[0].cells, listingRow())
assert.strictEqual(model.dataRows[0].district, '拱墅区')
assert.strictEqual(model.dataRows[0].block, '祥符')
assert.strictEqual(model.dataRows[0].community, '棠润府')
assert.strictEqual(model.listingCount, 1)
assert.strictEqual(model.invalidSchema, false)
assert.strictEqual(model.unavailable, false)
assert.strictEqual(model.snapshotId, first.snapshotId)

const badKeys = clone(first)
badKeys.columnKeys[0] = 'area'
mustClientReject(badKeys, '坏列键必须拒绝')
const badRow = clone(first)
badRow.rows[0] = badRow.rows[0].slice(0, 9)
mustClientReject(badRow, '坏行必须拒绝')
const blankIdentity = clone(first)
blankIdentity.rows[0][2] = ''
blankIdentity.contentSha256 = clientContract.contentSha256Of(blankIdentity)
blankIdentity.snapshotId = `company-sheet-v2:${blankIdentity.contentSha256}`
mustClientReject(blankIdentity, '缺小区的自洽摘要快照也必须拒绝')
const badDigest = clone(first)
badDigest.rows[0][6] = '9999'
mustClientReject(badDigest, '内容被改但摘要未改必须拒绝')
const badSnapshotId = clone(first)
badSnapshotId.snapshotId = `company-sheet-v2:${'0'.repeat(64)}`
mustClientReject(badSnapshotId, '坏快照身份必须拒绝')
const headerMixed = clone(first)
headerMixed.rows.push(EXPECTED_HEADERS.slice())
headerMixed.dataRowCount = 2
headerMixed.contentSha256 = clientContract.contentSha256Of(headerMixed)
headerMixed.snapshotId = `company-sheet-v2:${headerMixed.contentSha256}`
mustClientReject(headerMixed, '数据区混入表头必须拒绝')
const unknownField = Object.assign({}, first, { sheetUrl: 'https://example.invalid/private' })
mustClientReject(unknownField, '响应出现非白名单字段必须拒绝')
assert.strictEqual(serverContract.validateCompanySheetSnapshotV2(badDigest), false, '服务端缓存内容被篡改也必须 fail-closed')
assert.strictEqual(serverContract.validateCompanySheetSnapshotV2(unknownField), false, '服务端缓存夹带非白名单字段必须 fail-closed')

console.log('company-sheet-snapshot-v2-test passed')
