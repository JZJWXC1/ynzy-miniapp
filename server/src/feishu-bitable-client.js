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

function fieldContractChangedError(message) {
  const error = new Error(message)
  error.name = 'FieldContractChangedError'
  error.code = 'FIELD_CONTRACT_CHANGED'
  error.statusCode = 409
  error.safeBeforeWrite = true
  return error
}

function assertExpectedSchemaFingerprint(expected, actual) {
  if (expected === undefined) return
  const expectedText = typeof expected === 'string' ? expected : ''
  const actualText = typeof actual === 'string' ? actual : ''
  if (!/^[0-9a-f]{64}$/.test(expectedText) || !/^[0-9a-f]{64}$/.test(actualText) ||
      !crypto.timingSafeEqual(Buffer.from(expectedText, 'hex'), Buffer.from(actualText, 'hex'))) {
    throw fieldContractChangedError('飞书字段契约已变化，schema 指纹与已批准版本不一致')
  }
}

function isEmptyRequiredValue(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function stableTextValue(value, semantic, recordId) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error(`飞书记录 ${recordId} 的多选字段 ${semantic} 类型无效`)
  }
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function normalizeMultiSelectValue(value, semantic, recordId) {
  if (!Array.isArray(value)) {
    throw new Error(`飞书记录 ${recordId} 的多选字段 ${semantic} 必须是数组`)
  }
  return [...new Set(value.map((item) => stableTextValue(item, semantic, recordId)).filter(Boolean))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function normalizedOptionalEmptyValue(fieldType) {
  return ['4', '17'].includes(String(fieldType)) ? [] : ''
}

function stableDigestValue(value, fieldType) {
  const normalizedType = String(fieldType)
  if (normalizedType === '4') {
    return Array.isArray(value)
      ? [...new Set(value)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      : value
  }
  if (normalizedType !== '17' || value === undefined || value === null || value === '') return value
  const attachments = Array.isArray(value) ? value : [value]
  return attachments.map((attachment) => {
    const token = normalizeFieldId(attachment && (attachment.file_token || attachment.token || attachment.obj_token))
    if (!token) throw new Error('飞书附件字段缺少稳定 file_token')
    return { file_token: token }
  }).sort((left, right) => left.file_token.localeCompare(right.file_token))
}

function rebuildValidatedTableSnapshot(snapshot, records, options = {}) {
  const source = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot
    : null
  if (!source || !Array.isArray(records) || !Array.isArray(source.schemaBindings)) {
    throw new Error('飞书快照摘要重建缺少完整 snapshot、records 或 schemaBindings')
  }
  if (typeof options.includeCreatedTime !== 'boolean') {
    throw new Error('飞书快照摘要重建 includeCreatedTime 必须是布尔值')
  }
  const types = new Map()
  source.schemaBindings.forEach((binding) => {
    const semantic = normalizeFieldId(binding && binding.semantic)
    const type = normalizeFieldType(binding && binding.type)
    if (!semantic || !type || types.has(semantic)) {
      throw new Error('飞书快照摘要重建的字段类型绑定不完整或重复')
    }
    types.set(semantic, type)
  })
  if (!types.size) throw new Error('飞书快照摘要重建缺少字段类型绑定')

  const seenRecordIds = new Set()
  const normalizedRecords = records.map((record) => {
    const recordId = normalizeFieldId(record && record.recordId)
    const fields = record && record.fields && typeof record.fields === 'object' &&
      !Array.isArray(record.fields)
      ? record.fields
      : null
    if (!recordId || !fields || seenRecordIds.has(recordId)) {
      throw new Error('飞书快照摘要重建存在无效或重复 recordId')
    }
    seenRecordIds.add(recordId)
    const normalized = {
      recordId,
      fields: Object.keys(fields).sort().reduce((result, semantic) => {
        if (!types.has(semantic)) {
          throw new Error(`飞书快照摘要重建缺少字段类型绑定：${semantic}`)
        }
        result[semantic] = fields[semantic]
        return result
      }, {})
    }
    if (Object.prototype.hasOwnProperty.call(record, 'createdTimeMs')) {
      normalized.createdTimeMs = normalizePositiveIntegerMillis(
        record.createdTimeMs,
        `飞书记录 ${recordId} createdTimeMs`
      )
    }
    return normalized
  })
  const digestRecords = normalizedRecords.map((record) => {
    const digestRecord = {
      recordId: record.recordId,
      fields: Object.keys(record.fields).sort().reduce((result, semantic) => {
        result[semantic] = stableDigestValue(record.fields[semantic], types.get(semantic))
        return result
      }, {})
    }
    if (options.includeCreatedTime === true && record.createdTimeMs !== undefined) {
      digestRecord.createdTimeMs = record.createdTimeMs
    }
    return digestRecord
  }).sort((left, right) => left.recordId.localeCompare(right.recordId))

  return {
    ...source,
    records: normalizedRecords,
    recordCount: normalizedRecords.length,
    digest: sha256(digestRecords)
  }
}

function normalizeCellValue(value, fieldType, semantic, recordId, required) {
  const normalizedType = String(fieldType)
  if (required !== true && isEmptyRequiredValue(value)) {
    return normalizedOptionalEmptyValue(normalizedType)
  }
  if (normalizedType === '4') return normalizeMultiSelectValue(value, semantic, recordId)
  if (normalizedType !== '2' || value === undefined || value === null || value === '') return value
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`飞书记录 ${recordId} 的数值字段 ${semantic} 类型无效`)
  }
  if (typeof value === 'string' &&
      (value !== value.trim() || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))) {
    throw new Error(`飞书记录 ${recordId} 的数值字段 ${semantic} 不是标准十进制数字`)
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new Error(`飞书记录 ${recordId} 的数值字段 ${semantic} 不是有效数字`)
  }
  return numeric
}

function normalizePositiveIntegerMillis(value, label) {
  let numeric
  if (typeof value === 'number') {
    numeric = value
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    numeric = Number(value)
  } else {
    throw new Error(`${label}必须是严格正整数毫秒时间戳`)
  }
  if (!Number.isSafeInteger(numeric) || numeric < 1_000_000_000_000) {
    throw new Error(`${label}必须是严格正整数毫秒时间戳`)
  }
  return numeric
}

function normalizeRecordCreatedTime(record, recordId, { requireCreatedTime, nowMs }) {
  const source = record && typeof record === 'object' ? record : {}
  const hasSnakeCase = Object.prototype.hasOwnProperty.call(source, 'created_time')
  const hasCamelCase = Object.prototype.hasOwnProperty.call(source, 'createdTime')
  if (!hasSnakeCase && !hasCamelCase) {
    if (requireCreatedTime) throw new Error(`飞书记录 ${recordId} 缺少创建时间 created_time`)
    return undefined
  }

  const snakeCaseValue = hasSnakeCase
    ? normalizePositiveIntegerMillis(source.created_time, `飞书记录 ${recordId} 的创建时间 created_time`)
    : undefined
  const camelCaseValue = hasCamelCase
    ? normalizePositiveIntegerMillis(source.createdTime, `飞书记录 ${recordId} 的创建时间 createdTime`)
    : undefined
  if (hasSnakeCase && hasCamelCase && snakeCaseValue !== camelCaseValue) {
    throw new Error(`飞书记录 ${recordId} 的创建时间 created_time 与 createdTime 冲突`)
  }
  const createdTimeMs = hasSnakeCase ? snakeCaseValue : camelCaseValue
  if (createdTimeMs > nowMs) throw new Error(`飞书记录 ${recordId} 的创建时间不得晚于当前时间`)
  return createdTimeMs
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
    retryDelayMs,
    readOnly: opts.readOnly === true
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

  async function requestJson(url, requestOptions, operation, allowRetry = false) {
    let lastError
    const maxAttempts = allowRetry === true ? config.maxRetries + 1 : 1
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await requestJsonOnce(url, requestOptions, operation)
      } catch (error) {
        lastError = error
        if (attempt >= maxAttempts - 1 || !retryableRequestError(error)) throw error
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

  async function readAllPages(tableId, resource, readOptions = {}) {
    const items = []
    const seenTokens = new Set()
    let nextToken = ''
    let pageCount = 0

    while (true) {
      pageCount += 1
      if (pageCount > MAX_PAGES) throw new Error('飞书分页超过安全上限')
      const url = new URL(endpoint(tableId, resource))
      url.searchParams.set('page_size', String(config.pageSize))
      // 飞书只有显式请求 automatic_fields 才返回 created_time。只在计时必需的员工源快照
      // 开启，避免无条件扩大其他表响应并改变既有目标表摘要。
      if (resource === 'records' && readOptions.automaticFields === true) {
        url.searchParams.set('automatic_fields', 'true')
      }
      if (nextToken) url.searchParams.set('page_token', nextToken)
      const data = await requestJson(url.toString(), {
        method: 'GET',
        headers: authHeaders()
      }, '读取', true)
      if (typeof data.has_more !== 'boolean') throw new Error('飞书分页响应 has_more 缺失或类型错误')
      const isFirstEmptyPageWithoutItems =
        data.items === undefined &&
        pageCount === 1 &&
        data.has_more === false &&
        data.total === 0
      const pageItems = Array.isArray(data.items)
        ? data.items
        : (isFirstEmptyPageWithoutItems ? [] : null)
      if (!pageItems) throw new Error('飞书分页响应缺少 items')
      pageItems.forEach((item) => items.push(item))
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

  async function readValidatedTableSnapshot({
    tableId,
    bindings,
    allowEmpty = false,
    requireCreatedTime = false,
    nowMs,
    createdTimeCutoffMs,
    expectedSchemaFingerprint
  }) {
    if (typeof requireCreatedTime !== 'boolean') {
      throw new Error('飞书快照 requireCreatedTime 必须是布尔值')
    }
    if (createdTimeCutoffMs !== undefined && requireCreatedTime !== true) {
      throw new Error('飞书快照 createdTimeCutoffMs 只能与 requireCreatedTime=true 同时使用')
    }
    const explicitSnapshotNowMs = nowMs === undefined
      ? null
      : normalizePositiveIntegerMillis(nowMs, '飞书快照 nowMs')
    const normalizedCreatedTimeCutoffMs = createdTimeCutoffMs === undefined
      ? null
      : normalizePositiveIntegerMillis(
          createdTimeCutoffMs,
          '飞书快照 createdTimeCutoffMs'
        )
    const fields = await readAllPages(tableId, 'fields')
    const contract = validateFieldContract({ fields, bindings })
    // 字段契约必须在读取任何业务记录前与获批指纹比较。显示名不进入指纹，员工改列名仍兼容；
    // semantic 与同类型 field_id 互换则会在这里 fail-closed，避免把完整错误列读成合法快照。
    assertExpectedSchemaFingerprint(expectedSchemaFingerprint, contract.schemaFingerprint)
    const rawRecords = await readAllPages(tableId, 'records', {
      automaticFields: requireCreatedTime
    })
    // 默认实时校验时钟必须在 fields/records 全部分页读取完成后采样。否则读取期间
    // 刚创建的合法记录会因为早于网络请求完成、晚于请求开始而被误判为“未来”。
    const snapshotNowMs = explicitSnapshotNowMs == null
      ? normalizePositiveIntegerMillis(Date.now(), '飞书快照 nowMs')
      : explicitSnapshotNowMs
    if (
      normalizedCreatedTimeCutoffMs != null &&
      normalizedCreatedTimeCutoffMs > snapshotNowMs
    ) {
      throw new Error('飞书快照 createdTimeCutoffMs 不得晚于实时校验时间')
    }

    const seenRecordIds = new Set()
    const validatedRecords = rawRecords.map((record) => {
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
        const normalizedValue = normalizeCellValue(
          value,
          contractField.type,
          semantic,
          recordId,
          contractField.required
        )
        if (contractField.required && isEmptyRequiredValue(normalizedValue)) {
          throw new Error(`飞书记录 ${recordId} 的必填字段 ${semantic} 归一后为空`)
        }
        semanticFields[semantic] = normalizedValue
      })
      const createdTimeMs = normalizeRecordCreatedTime(record, recordId, {
        requireCreatedTime,
        nowMs: snapshotNowMs
      })
      const normalizedRecord = { recordId, fields: semanticFields }
      if (createdTimeMs !== undefined) normalizedRecord.createdTimeMs = createdTimeMs
      return normalizedRecord
    })
    // 批次截止只负责稳定本轮输入，不得绕过任何源记录校验。所有原始记录先完成
    // record_id、字段类型、附件和真实未来校验，再延后本轮开始后新增的合法记录。
    const records = normalizedCreatedTimeCutoffMs == null
      ? validatedRecords
      : validatedRecords.filter((record) => (
          record.createdTimeMs <= normalizedCreatedTimeCutoffMs
        ))
    if (!allowEmpty && records.length === 0) {
      if (rawRecords.length > 0 && normalizedCreatedTimeCutoffMs != null) {
        throw new Error('飞书批次截止时间内的有效源表快照为空，已阻断同步')
      }
      throw new Error('飞书源表为空，已阻断同步')
    }

    const fieldNames = Object.keys(contract.bySemantic).sort().reduce((result, semantic) => {
      result[semantic] = contract.bySemantic[semantic].fieldName
      return result
    }, {})
    const schemaBindings = Object.keys(contract.bySemantic).sort().map((semantic) => ({
      semantic,
      fieldName: contract.bySemantic[semantic].fieldName,
      type: contract.bySemantic[semantic].type
    }))
    return rebuildValidatedTableSnapshot({
      complete: true,
      schemaFingerprint: contract.schemaFingerprint,
      schemaBindings,
      ...(normalizedCreatedTimeCutoffMs == null
        ? {}
        : { deferredRecordCount: validatedRecords.length - records.length }),
      // 飞书记录写接口仍以当前显示名为 fields 键；该映射每轮由稳定 field_id
      // 重新解析，员工改列名不会让镜像写回绑到同名诱饵列。
      fieldNames
    }, records, { includeCreatedTime: requireCreatedTime })
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

  function validateWriteDispatchCallback(onWriteDispatched) {
    if (onWriteDispatched == null) return null
    if (typeof onWriteDispatched !== 'function') {
      throw new Error('飞书批量写 onWriteDispatched 必须是同步函数')
    }
    return onWriteDispatched
  }

  function writeIntentPersistenceError() {
    const error = new Error('飞书目标 Base 写入意图未能在 POST 前持久化')
    error.name = 'ExternalWriteIntentPersistenceError'
    error.code = 'EXTERNAL_WRITE_INTENT_PERSISTENCE_FAILED'
    error.statusCode = 503
    error.safeBeforeWrite = true
    return error
  }

  function dispatchWriteIntent(onWriteDispatched, evidence) {
    if (!onWriteDispatched) return
    try {
      const result = onWriteDispatched(Object.freeze(evidence))
      if (result && typeof result.then === 'function') {
        // 写意图必须在真正 POST 前同步持久化。异步回调无法证明先后顺序，且其
        // Promise 即使稍后拒绝也不能让进程产生未处理拒绝，因此在此失败关闭。
        Promise.resolve(result).catch(() => {})
        throw new Error('飞书批量写 onWriteDispatched 必须同步完成，不得返回 Promise')
      }
    } catch (_) {
      throw writeIntentPersistenceError()
    }
  }

  async function writeBatch(tableId, records, suffix, operation, clientToken, onWriteDispatched) {
    if (config.readOnly) {
      const error = new Error('员工源表客户端为硬只读，禁止任何新增或更新请求')
      error.statusCode = 403
      throw error
    }
    validateBatchRecords(records, operation)
    const normalizedTableId = safeTableId(tableId)
    if (records.length === 0) return []
    const url = new URL(endpoint(normalizedTableId, suffix))
    const normalizedClientToken = clientToken == null ? '' : String(clientToken).trim()
    if (normalizedClientToken) {
      url.searchParams.set('client_token', normalizedClientToken)
    }
    const requestOptions = {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ records })
    }
    dispatchWriteIntent(onWriteDispatched, {
      operation,
      tableId: normalizedTableId,
      recordCount: records.length,
      clientToken: normalizedClientToken
    })
    const data = await requestJson(
      url.toString(),
      requestOptions,
      `批量${operation}`,
      Boolean(normalizedClientToken)
    )
    if (!Array.isArray(data.records)) throw new Error(`飞书批量${operation}响应缺少 records`)
    if (data.records.length !== records.length) throw new Error(`飞书批量${operation}响应数量不一致`)
    return data.records
  }

  async function batchCreateRecords(tableId, records, { clientToken, onWriteDispatched } = {}) {
    if (clientToken != null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(clientToken).trim())) {
      throw new Error('飞书批量新增 client_token 必须是 UUIDv4')
    }
    const normalizedCallback = validateWriteDispatchCallback(onWriteDispatched)
    return writeBatch(tableId, records, 'records/batch_create', '新增', clientToken, normalizedCallback)
  }

  async function batchUpdateRecords(tableId, records, {
    clientToken = crypto.randomUUID(),
    onWriteDispatched
  } = {}) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(clientToken).trim())) {
      throw new Error('飞书批量更新 client_token 必须是 UUIDv4')
    }
    const normalizedCallback = validateWriteDispatchCallback(onWriteDispatched)
    // batch_update 同样支持 client_token。一次调用只生成一个令牌并在有限重试中固定复用，
    // 因此“远端已提交、响应超时”不会把同一批更新及其自动化副作用重复执行。
    return writeBatch(
      tableId,
      records,
      'records/batch_update',
      '更新',
      clientToken,
      normalizedCallback
    )
  }

  return {
    readOnly: config.readOnly,
    writeDispatchEvidenceVersion: 1,
    readValidatedTableSnapshot,
    batchCreateRecords,
    batchUpdateRecords
  }
}

module.exports = {
  validateFieldContract,
  createBitableClient,
  _internal: {
    rebuildValidatedTableSnapshot
  }
}
