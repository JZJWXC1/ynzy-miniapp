const CONTRACT = 'ynzy.company-sheet.snapshot'
const SOURCE_MODE = 'feishu-mini-mirror-v2'
const SCHEMA_VERSION = 2
const MIN_READER_VERSION = 2
const TITLE = '寓你住一起房源表'

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

const MAX_LINES = Object.freeze([1, 1, 1, 2, 2, 1, 1, 1, 2, 1])
const SHA256_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index])
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits))
}

function utf8Bytes(value) {
  const text = String(value)
  const bytes = []
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        index += 1
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >>> 18),
        0x80 | ((code >>> 12) & 0x3f),
        0x80 | ((code >>> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return bytes
}

function sha256Hex(value) {
  const bytes = utf8Bytes(value)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff)
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff)

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]
  const words = new Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4
      words[index] = (
        (bytes[start] << 24) |
        (bytes[start + 1] << 16) |
        (bytes[start + 2] << 8) |
        bytes[start + 3]
      ) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]
      const previous2 = words[index - 2]
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let a = hash[0]
    let b = hash[1]
    let c = hash[2]
    let d = hash[3]
    let e = hash[4]
    let f = hash[5]
    let g = hash[6]
    let h = hash[7]

    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + bigSigma1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (bigSigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  return hash.map((value) => value.toString(16).padStart(8, '0')).join('')
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
  return sha256Hex(canonicalCompanySheetContent(snapshot))
}

function exactOutputFields(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  return sameArray(Object.keys(snapshot).sort(), OUTPUT_FIELDS.slice().sort())
}

function validUpdatedAt(value, unavailable) {
  if (typeof value !== 'string') return false
  if (unavailable) return value === ''
  if (value === '') return true
  return /^\d{4}(?:(?:[-/]\d{1,2}){2}|\d{4})(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?)?$/.test(value)
}

function validDataRow(row) {
  if (!Array.isArray(row) || row.length !== COLUMN_KEYS.length) return false
  if (sameArray(row, DISPLAY_HEADERS)) return false
  if (row.some((cell) => typeof cell !== 'string' || cell.trim() !== cell || cell.length > 2000)) return false
  return row.slice(0, 4).every(Boolean)
}

function parseCompanySheetSnapshotV2(snapshot) {
  if (!exactOutputFields(snapshot)) return null
  if (snapshot.contract !== CONTRACT || snapshot.sourceMode !== SOURCE_MODE) return null
  if (snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.minReaderVersion !== MIN_READER_VERSION) return null
  if (!sameArray(snapshot.columnKeys, COLUMN_KEYS) || snapshot.title !== TITLE) return null
  if (typeof snapshot.unavailable !== 'boolean' || snapshot.sensitiveStripped !== true) return null
  if (!validUpdatedAt(snapshot.updatedAt, snapshot.unavailable)) return null
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 10000 || !snapshot.rows.every(validDataRow)) return null
  if (snapshot.unavailable && snapshot.rows.length > 0) return null
  if (snapshot.dataRowCount !== snapshot.rows.length || snapshot.columnCount !== COLUMN_KEYS.length) return null
  if (!/^[a-f0-9]{64}$/.test(snapshot.contentSha256)) return null
  const expectedDigest = contentSha256Of(snapshot)
  if (snapshot.contentSha256 !== expectedDigest) return null
  if (snapshot.snapshotId !== `company-sheet-v2:${expectedDigest}`) return null
  return {
    contract: snapshot.contract,
    sourceMode: snapshot.sourceMode,
    schemaVersion: snapshot.schemaVersion,
    minReaderVersion: snapshot.minReaderVersion,
    columnKeys: snapshot.columnKeys.slice(),
    title: snapshot.title,
    updatedAt: snapshot.updatedAt,
    unavailable: snapshot.unavailable,
    rows: snapshot.rows.map((row) => row.slice()),
    dataRowCount: snapshot.dataRowCount,
    columnCount: snapshot.columnCount,
    contentSha256: snapshot.contentSha256,
    snapshotId: snapshot.snapshotId,
    sensitiveStripped: true
  }
}

function validateCompanySheetSnapshotV2(snapshot) {
  return Boolean(parseCompanySheetSnapshotV2(snapshot))
}

function makeSpan(rows, columnIndex, keyBuilder) {
  const spans = []
  let current = null
  rows.forEach((row, index) => {
    const value = row.cells[columnIndex]
    const key = keyBuilder(row)
    if (current && current.key === key) {
      current.count += 1
    } else {
      current = { colIndex: columnIndex, key, value, start: index, count: 1 }
      spans.push(current)
    }
  })
  return spans
}

function emptyHomepageModel(options = {}) {
  return {
    noteRows: [],
    header: DISPLAY_HEADERS.slice(),
    dataRows: [],
    listingCount: 0,
    groupColumns: [0, 1, 2],
    districtCol: 0,
    blockCol: 1,
    communityCol: 2,
    areaCol: 0,
    maxLines: MAX_LINES.slice(),
    spans: [],
    invalidSchema: options.invalidSchema === true,
    unavailable: options.unavailable === true,
    snapshotId: '',
    contentSha256: ''
  }
}

function toHomepageCompanySheetModel(snapshot) {
  const parsed = parseCompanySheetSnapshotV2(snapshot)
  if (!parsed) return emptyHomepageModel({ invalidSchema: true })
  if (parsed.unavailable) return emptyHomepageModel({ unavailable: true })
  const dataRows = parsed.rows.map((cells) => ({
    area: cells[0],
    district: cells[0],
    block: cells[1],
    community: cells[2],
    roomLabel: cells[3],
    cells: cells.slice()
  }))
  return {
    noteRows: [],
    header: DISPLAY_HEADERS.slice(),
    dataRows,
    listingCount: dataRows.length,
    groupColumns: [0, 1, 2],
    districtCol: 0,
    blockCol: 1,
    communityCol: 2,
    areaCol: 0,
    maxLines: MAX_LINES.slice(),
    spans: [
      ...makeSpan(dataRows, 0, (row) => row.district),
      ...makeSpan(dataRows, 1, (row) => `${row.district}|${row.block}`),
      ...makeSpan(dataRows, 2, (row) => `${row.district}|${row.block}|${row.community}`)
    ],
    invalidSchema: false,
    unavailable: false,
    snapshotId: parsed.snapshotId,
    contentSha256: parsed.contentSha256
  }
}

module.exports = {
  CONTRACT,
  SOURCE_MODE,
  SCHEMA_VERSION,
  MIN_READER_VERSION,
  TITLE,
  COLUMN_KEYS: COLUMN_KEYS.slice(),
  DISPLAY_HEADERS: DISPLAY_HEADERS.slice(),
  canonicalCompanySheetContent,
  contentSha256Of,
  sha256Hex,
  parseCompanySheetSnapshotV2,
  validateCompanySheetSnapshotV2,
  toHomepageCompanySheetModel
}
