'use strict'

const crypto = require('crypto')

const MAX_BATCH_RECORDS = 1000
const MAX_PAGES = 10000

function normalizeFieldId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeFieldType(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return ''
}

function expectedTypes(binding) {
  const raw = binding && Array.isArray(binding.type) ? binding.type : [binding && binding.type]
  return raw.map(normalizeFieldType).filter(Boolean)
}

function validateFieldContract({ fields, bindings }) {
  if (!Array.isArray(fields)) throw new Error('字段契约校验失败：字段元数据必须是数组')
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new Error('字段契约校验失败：bindings 必须是对象')
  }

  const fieldsById = new Map()
  fields.forEach((item) => {
    const fieldId = normalizeFieldId(item && (item.field_id || item.fieldId))
    const fieldName = typeof (item && (item.field_name || item.fieldName)) === 'string'
      ? String(item.field_name || item.fieldName).trim()
      : ''
    const type = normalizeFieldType(item && item.type)
    if (!fieldId || !fieldName || !type) throw new Error('字段契约校验失败：字段元数据不完整')
    if (fieldsById.has(fieldId)) throw new Error('字段契约校验失败：存在重复 field_id')
    fieldsById.set(fieldId, { fieldId, fieldName, type })
  })

  const bindingFieldIds = new Set()
  const bySemantic = {}
  Object.keys(bindings).sort().forEach((semantic) => {
    const binding = bindings[semantic]
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error(`字段契约校验失败：${semantic} 绑定无效`)
    }
    const fieldId = normalizeFieldId(binding.fieldId || binding.field_id)
    const types = expectedTypes(binding)
    if (!fieldId || types.length === 0) throw new Error(`字段契约校验失败：${semantic} 绑定不完整`)
    if (bindingFieldIds.has(fieldId)) throw new Error('字段契约校验失败：bindings 存在重复 field_id')
    bindingFieldIds.add(fieldId)

    const metadata = fieldsById.get(fieldId)
    // binding 本身就是“这个稳定 field_id 必须存在”的声明；required 只负责逐行单元格
    // 是否允许为空。否则备注/看房方式/单元等可空列被删除后，会被误判成合法缺省并清空镜像。
    if (!metadata) throw new Error(`字段契约缺少已绑定字段：${semantic}`)
    if (!types.includes(metadata.type)) throw new Error(`字段契约类型不匹配：${semantic}`)
    bySemantic[semantic] = {
      semantic,
      fieldId,
      fieldName: metadata.fieldName,
      type: metadata.type,
      required: binding.required === true
    }
  })

  const schemaDefinition = Object.keys(bindings).sort().map((semantic) => {
    const binding = bindings[semantic]
    const validated = bySemantic[semantic]
    return {
      semantic,
      fieldId: normalizeFieldId(binding && (binding.fieldId || binding.field_id)),
      types: expectedTypes(binding).sort(),
      required: Boolean(binding && binding.required),
      schemaRequired: true,
      present: Boolean(validated),
      actualType: validated ? validated.type : ''
    }
  })

  const displayNames = new Set()
  Object.keys(bySemantic).sort().forEach((semantic) => {
    const displayName = bySemantic[semantic].fieldName.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
    if (displayNames.has(displayName)) {
      throw new Error('字段契约校验失败：不同 field_id 解析到相同显示名，记录读写会发生覆盖')
    }
    displayNames.add(displayName)
  })

  return {
    bySemantic,
    schemaFingerprint: sha256(schemaDefinition)
  }
}

function canonicalize(value) {
  if (value === undefined) return { __ynzyUndefined: true }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    const result = {}
    Object.keys(value).sort().forEach((key) => {
      result[key] = canonicalize(value[key])
    })
    return result
  }
  return String(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function isEmptyRequiredValue(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function stableDigestValue(value, fieldType) {
  if (String(fieldType) !== '17' || value === undefined || value === null || value === '') return value
  const attachments = Array.isArray(value) ? value : [value]
  return attachments.map((attachment) => {
    const token = normalizeFieldId(attachment && (attachment.file_token || attachment.token || attachment.obj_token))
    if (!token) throw new Error('飞书附件字段缺少稳定 file_token')
    return { file_token: token }
  }).sort((left, right) => left.file_token.localeCompare(right.file_token))
}

function validateClientOptions(options) {
  const opts = options && typeof options === 'object' ? options : {}
  if (typeof opts.fetchImpl !== 'function') throw new Error('飞书客户端缺少 fetchImpl')
  if (typeof opts.baseUrl !== 'string' || !opts.baseUrl.trim()) throw new Error('飞书客户端缺少 baseUrl')
  if (typeof opts.appToken !== 'string' || !opts.appToken.trim()) throw new Error('飞书客户端缺少 appToken')
  if (typeof opts.accessToken !== 'string' || !opts.accessToken.trim()) throw new Error('飞书客户端缺少 accessToken')
  const pageSize = opts.pageSize == null ? 500 : Number(opts.pageSize)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error('飞书客户端 pageSize 必须在 1 到 500 之间')
  }
  const requestTimeoutMs = opts.requestTimeoutMs == null ? 30000 : Number(opts.requestTimeoutMs)
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300000) {
    throw new Error('飞书客户端 requestTimeoutMs 必须在 1 到 300000 之间')
  }
  const maxRetries = opts.maxRetries == null ? 2 : Number(opts.maxRetries)
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    throw new Error('飞书客户端 maxRetries 必须在 0 到 5 之间')
  }
  const retryDelayMs = opts.retryDelayMs == null ? 200 : Number(opts.retryDelayMs)
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5000) {
    throw new Error('飞书客户端 retryDelayMs 必须在 0 到 5000 之间')
  }
  let baseUrl
  try {
    baseUrl = new URL(opts.baseUrl.trim().replace(/\/+$/, ''))
  } catch (_) {
    throw new Error('飞书客户端 baseUrl 无效')
  }
  return {
    fetchImpl: opts.fetchImpl,
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    appToken: opts.appToken.trim(),
    accessToken: opts.accessToken.trim(),
    pageSize,
    requestTimeoutMs,
    maxRetries,
    retryDelayMs
  }
}

function safeTableId(tableId) {
  if (typeof tableId !== 'string' || !tableId.trim()) throw new Error('飞书请求缺少 tableId')
  return tableId.trim()
}

function createBitableClient(options) {
  const config = validateClientOptions(options)

  function endpoint(tableId, suffix) {
    return `${config.baseUrl}/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(safeTableId(tableId))}/${suffix}`
  }

  async function requestJsonOnce(url, requestOptions, operation) {
    const controller = new AbortController()
    let timedOut = false
    let timer
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new Error('timeout'))
      }, config.requestTimeoutMs)
    })
    try {
      let response
      try {
        response = await Promise.race([
          config.fetchImpl(url, { ...requestOptions, signal: controller.signal }),
          timeoutPromise
        ])
      } catch (error) {
        if (timedOut || controller.signal.aborted) throw new Error(`飞书${operation}请求超时`)
        throw new Error(`飞书${operation}请求失败`)
      }

      const status = Number(response && response.status)
      const ok = response && typeof response.ok === 'boolean'
        ? response.ok
        : Number.isFinite(status) && status >= 200 && status < 300
      if (!ok) throw new Error(`飞书${operation}请求失败：HTTP ${Number.isFinite(status) ? status : 'unknown'}`)

      let payload
      try {
        payload = await Promise.race([
          Promise.resolve().then(() => response.json()),
          timeoutPromise
        ])
      } catch (error) {
        if (timedOut || controller.signal.aborted) throw new Error(`飞书${operation}请求超时`)
        throw new Error(`飞书${operation}响应不是合法 JSON`)
      }
      if (!payload || (payload.code !== 0 && payload.code !== '0')) {
        const code = payload && (typeof payload.code === 'number' || typeof payload.code === 'string')
          ? String(payload.code)
          : 'unknown'
        throw new Error(`飞书${operation}失败：code=${code}`)
      }
      if (!payload.data || typeof payload.data !== 'object') throw new Error(`飞书${operation}响应缺少 data`)
      return payload.data
    } finally {
      clearTimeout(timer)
    }
  }

  function retryableRequestError(error) {
    const message = String(error && error.message || error)
    return /HTTP (?:429|500|502|503|504)\b/.test(message) ||
      /code=(?:1254290|1254291|1254607|504)\b/.test(message) ||
      /请求超时|请求失败$/.test(message)
  }

  async function requestJson(url, requestOptions, operation) {
    let lastError
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      try {
        return await requestJsonOnce(url, requestOptions, operation)
      } catch (error) {
        lastError = error
        if (attempt >= config.maxRetries || !retryableRequestError(error)) throw error
        const waitMs = Math.min(config.retryDelayMs * (2 ** attempt), 5000)
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }
    throw lastError
  }

  function authHeaders(extra) {
    return {
      Authorization: `Bearer ${config.accessToken}`,
      ...(extra || {})
    }
  }

  async function readAllPages(tableId, resource) {
    const items = []
    const seenTokens = new Set()
    let nextToken = ''
    let pageCount = 0

    while (true) {
      pageCount += 1
      if (pageCount > MAX_PAGES) throw new Error('飞书分页超过安全上限')
      const url = new URL(endpoint(tableId, resource))
      url.searchParams.set('page_size', String(config.pageSize))
      if (nextToken) url.searchParams.set('page_token', nextToken)
      const data = await requestJson(url.toString(), {
        method: 'GET',
        headers: authHeaders()
      }, '读取')
      if (!Array.isArray(data.items)) throw new Error('飞书分页响应缺少 items')
      if (typeof data.has_more !== 'boolean') throw new Error('飞书分页响应 has_more 缺失或类型错误')
      data.items.forEach((item) => items.push(item))
      if (data.has_more !== true) break

      const returnedToken = typeof (data.page_token || data.next_page_token) === 'string'
        ? String(data.page_token || data.next_page_token).trim()
        : ''
      if (!returnedToken) throw new Error('飞书分页返回 has_more 但缺少 page_token')
      if (seenTokens.has(returnedToken)) throw new Error('飞书分页返回重复 page_token，已阻断循环')
      seenTokens.add(returnedToken)
      nextToken = returnedToken
    }

    return items
  }

  async function readValidatedTableSnapshot({ tableId, bindings, allowEmpty = false }) {
    const fields = await readAllPages(tableId, 'fields')
    const contract = validateFieldContract({ fields, bindings })
    const rawRecords = await readAllPages(tableId, 'records')
    if (!allowEmpty && rawRecords.length === 0) throw new Error('飞书源表为空，已阻断同步')

    const seenRecordIds = new Set()
    const records = rawRecords.map((record) => {
      const recordId = normalizeFieldId(record && (record.record_id || record.recordId))
      if (!recordId) throw new Error('飞书记录缺少 record_id')
      if (seenRecordIds.has(recordId)) throw new Error('飞书完整快照存在重复 record_id')
      seenRecordIds.add(recordId)
      const rawFields = record && record.fields && typeof record.fields === 'object' && !Array.isArray(record.fields)
        ? record.fields
        : {}
      const semanticFields = {}
      Object.keys(contract.bySemantic).sort().forEach((semantic) => {
        const contractField = contract.bySemantic[semantic]
        const value = rawFields[contractField.fieldName]
        if (contractField.required && isEmptyRequiredValue(value)) {
          throw new Error(`飞书记录 ${recordId} 的必填字段 ${semantic} 为空`)
        }
        semanticFields[semantic] = value
      })
      return { recordId, fields: semanticFields }
    })

    const digestRecords = records.map((record) => ({
      recordId: record.recordId,
      fields: Object.keys(record.fields).sort().reduce((result, semantic) => {
        result[semantic] = stableDigestValue(record.fields[semantic], contract.bySemantic[semantic].type)
        return result
      }, {})
    })).sort((left, right) => left.recordId.localeCompare(right.recordId))
    const fieldNames = Object.keys(contract.bySemantic).sort().reduce((result, semantic) => {
      result[semantic] = contract.bySemantic[semantic].fieldName
      return result
    }, {})
    return {
      complete: true,
      records,
      recordCount: records.length,
      digest: sha256(digestRecords),
      schemaFingerprint: contract.schemaFingerprint,
      // 飞书记录写接口仍以当前显示名为 fields 键；该映射每轮由稳定 field_id
      // 重新解析，员工改列名不会让镜像写回绑到同名诱饵列。
      fieldNames
    }
  }

  function validateBatchRecords(records, operation) {
    if (!Array.isArray(records)) throw new Error(`飞书批量${operation} records 必须是数组`)
    if (records.length > MAX_BATCH_RECORDS) throw new Error(`飞书批量${operation}单批不得超过 ${MAX_BATCH_RECORDS} 条`)
    records.forEach((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`飞书批量${operation}记录结构无效`)
      }
      if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
        throw new Error(`飞书批量${operation}记录缺少 fields`)
      }
      if (operation === '更新' && !normalizeFieldId(record.record_id || record.recordId)) {
        throw new Error('飞书批量更新记录缺少 record_id')
      }
    })
  }

  async function writeBatch(tableId, records, suffix, operation, clientToken) {
    validateBatchRecords(records, operation)
    if (records.length === 0) return []
    const url = new URL(endpoint(tableId, suffix))
    if (clientToken != null && String(clientToken).trim()) {
      url.searchParams.set('client_token', String(clientToken).trim())
    }
    const data = await requestJson(url.toString(), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ records })
    }, `批量${operation}`)
    if (!Array.isArray(data.records)) throw new Error(`飞书批量${operation}响应缺少 records`)
    if (data.records.length !== records.length) throw new Error(`飞书批量${operation}响应数量不一致`)
    return data.records
  }

  async function batchCreateRecords(tableId, records, { clientToken } = {}) {
    if (clientToken != null && String(clientToken).trim() &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(clientToken).trim())) {
      throw new Error('飞书批量新增 client_token 必须是 UUIDv4')
    }
    return writeBatch(tableId, records, 'records/batch_create', '新增', clientToken)
  }

  async function batchUpdateRecords(tableId, records) {
    return writeBatch(tableId, records, 'records/batch_update', '更新')
  }

  return {
    readValidatedTableSnapshot,
    batchCreateRecords,
    batchUpdateRecords
  }
}

module.exports = {
  validateFieldContract,
  createBitableClient
}
