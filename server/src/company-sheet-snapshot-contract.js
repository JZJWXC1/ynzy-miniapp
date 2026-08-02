const crypto = require('crypto')

const CONTRACT = 'ynzy.company-sheet.snapshot'
const SOURCE_MODE = 'feishu-mini-mirror-v2'
const SCHEMA_VERSION = 2
const MIN_READER_VERSION = 2
const TITLE = '寓你住一起房源表'
const LEGACY_SOURCE_MODE = 'feishu-mini-mirror-v1'

const COLUMN_KEYS = Object.freeze([
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
])

const DISPLAY_HEADERS = Object.freeze([
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
])

const OUTPUT_FIELDS = Object.freeze([
  'contract',
  'sourceMode',
  'schemaVersion',
  'minReaderVersion',
  'columnKeys',
  'title',
  'updatedAt',
  'unavailable',
  'rows',
  'dataRowCount',
  'columnCount',
  'contentSha256',
  'snapshotId',
  'sensitiveStripped'
])

const REQUIRED_COLUMN_COUNT = 4
const COLUMN_COUNT = COLUMN_KEYS.length
const MAX_ROWS = 10000
const MAX_CELL_LENGTH = 2000

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeCell(value, rowIndex, columnIndex) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`第 ${rowIndex + 1} 行 ${COLUMN_KEYS[columnIndex]} 不是有限值`)
    value = String(value)
  }
  if (typeof value !== 'string') {
    throw new Error(`第 ${rowIndex + 1} 行 ${COLUMN_KEYS[columnIndex]} 必须是字符串或有限数字`)
  }
  const normalized = value.normalize('NFKC').replace(/\r\n?/g, '\n').trim()
  if (normalized.length > MAX_CELL_LENGTH) {
    throw new Error(`第 ${rowIndex + 1} 行 ${COLUMN_KEYS[columnIndex]} 超过长度限制`)
  }
  return normalized
}

function normalizeRow(row, rowIndex) {
  if (!Array.isArray(row) || row.length !== COLUMN_COUNT) {
    throw new Error(`第 ${rowIndex + 1} 行必须精确包含 ${COLUMN_COUNT} 列`)
  }
  if (sameArray(row, DISPLAY_HEADERS)) throw new Error(`第 ${rowIndex + 1} 行数据区混入表头`)
  const normalized = row.map((value, columnIndex) => normalizeCell(value, rowIndex, columnIndex))
  if (sameArray(normalized, DISPLAY_HEADERS)) throw new Error(`第 ${rowIndex + 1} 行数据区混入表头`)
  for (let index = 0; index < REQUIRED_COLUMN_COUNT; index += 1) {
    if (!normalized[index]) throw new Error(`第 ${rowIndex + 1} 行 ${COLUMN_KEYS[index]} 不能为空`)
  }
  return normalized
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new Error('v2 rows 必须是数组')
  if (rows.length > MAX_ROWS) throw new Error(`v2 rows 不得超过 ${MAX_ROWS} 行`)
  return rows.map(normalizeRow)
}

function normalizeUpdatedAt(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error('updatedAt 必须是字符串')
  const normalized = value.trim()
  const supported = /^\d{4}(?:(?:[-/]\d{1,2}){2}|\d{4})(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?)?$/
  if (!supported.test(normalized)) throw new Error('updatedAt 格式不受支持')
  return normalized
}

function canonicalCompanySheetContent(snapshot) {
  return JSON.stringify({
    contract: CONTRACT,
    sourceMode: SOURCE_MODE,
    schemaVersion: SCHEMA_VERSION,
    minReaderVersion: MIN_READER_VERSION,
    columnKeys: COLUMN_KEYS,
    title: TITLE,
    unavailable: snapshot && snapshot.unavailable === true,
    rows: snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : []
  })
}

function contentSha256Of(snapshot) {
  return crypto.createHash('sha256').update(canonicalCompanySheetContent(snapshot), 'utf8').digest('hex')
}

function buildSnapshot(rows, options = {}) {
  const unavailable = options.unavailable === true
  if (unavailable && rows.length > 0) throw new Error('不可用快照不得携带数据行')
  const contentSource = { unavailable, rows }
  const contentSha256 = contentSha256Of(contentSource)
  return {
    contract: CONTRACT,
    sourceMode: SOURCE_MODE,
    schemaVersion: SCHEMA_VERSION,
    minReaderVersion: MIN_READER_VERSION,
    columnKeys: COLUMN_KEYS.slice(),
    title: TITLE,
    updatedAt: unavailable ? '' : normalizeUpdatedAt(options.updatedAt),
    unavailable,
    rows: rows.map((row) => row.slice()),
    dataRowCount: rows.length,
    columnCount: COLUMN_COUNT,
    contentSha256,
    snapshotId: `company-sheet-v2:${contentSha256}`,
    sensitiveStripped: true
  }
}

function createCompanySheetSnapshotV2(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('v2 快照输入必须是对象')
  if (input.sensitiveStripped !== true) throw new Error('v2 快照输入必须先完成脱敏')
  return buildSnapshot(normalizeRows(input.rows), { updatedAt: input.updatedAt, unavailable: false })
}

function createUnavailableCompanySheetSnapshotV2() {
  return buildSnapshot([], { unavailable: true, updatedAt: '' })
}

function parseCompanySheetSnapshotV2(snapshot) {
  try {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
    if (!sameArray(Object.keys(snapshot).sort(), OUTPUT_FIELDS.slice().sort())) return null
    const rebuilt = snapshot.unavailable === true
      ? createUnavailableCompanySheetSnapshotV2()
      : createCompanySheetSnapshotV2({
          updatedAt: snapshot.updatedAt,
          rows: snapshot.rows,
          sensitiveStripped: snapshot.sensitiveStripped
        })
    if (OUTPUT_FIELDS.some((field) => JSON.stringify(snapshot[field]) !== JSON.stringify(rebuilt[field]))) {
      return null
    }
    return rebuilt
  } catch (error) {
    return null
  }
}

function validateCompanySheetSnapshotV2(snapshot) {
  return Boolean(parseCompanySheetSnapshotV2(snapshot))
}

function assertTrustedV1Snapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('可信 v1 快照必须是对象')
  }
  if (snapshot.sourceMode !== LEGACY_SOURCE_MODE || Number(snapshot.schemaVersion) !== 1) {
    throw new Error('只允许转换固定可信 v1 快照')
  }
  if (snapshot.sensitiveStripped !== true) throw new Error('可信 v1 快照必须已脱敏')
  if (snapshot.title !== TITLE) throw new Error('可信 v1 标题不匹配')
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length < 1) throw new Error('可信 v1 缺少精确表头')
  if (!sameArray(snapshot.rows[0], DISPLAY_HEADERS)) throw new Error('可信 v1 表头不匹配')
  if (Number(snapshot.columnCount) !== COLUMN_COUNT) throw new Error('可信 v1 列数不匹配')
  if (Number(snapshot.rowCount) !== snapshot.rows.length) throw new Error('可信 v1 行数不匹配')
}

function convertTrustedV1SnapshotToV2(snapshot) {
  assertTrustedV1Snapshot(snapshot)
  if (snapshot.unavailable === true) {
    if (snapshot.rows.length !== 1) throw new Error('不可用 v1 快照不得携带数据行')
    return createUnavailableCompanySheetSnapshotV2()
  }
  return createCompanySheetSnapshotV2({
    updatedAt: snapshot.updatedAt,
    rows: snapshot.rows.slice(1),
    sensitiveStripped: true
  })
}

module.exports = {
  CONTRACT,
  SOURCE_MODE,
  SCHEMA_VERSION,
  MIN_READER_VERSION,
  TITLE,
  LEGACY_SOURCE_MODE,
  COLUMN_KEYS: COLUMN_KEYS.slice(),
  DISPLAY_HEADERS: DISPLAY_HEADERS.slice(),
  canonicalCompanySheetContent,
  contentSha256Of,
  createCompanySheetSnapshotV2,
  createUnavailableCompanySheetSnapshotV2,
  parseCompanySheetSnapshotV2,
  validateCompanySheetSnapshotV2,
  convertTrustedV1SnapshotToV2
}
