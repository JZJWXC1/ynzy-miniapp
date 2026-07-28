'use strict'

const crypto = require('crypto')
const path = require('path')
const { MAX_LISTING_MEDIA_ASSETS } = require('./domain')

const VIDEO_EXTENSION_RE = /\.(mp4|mov|m4v|webm)$/i
const VIDEO_MIME_RE = /^video\/(?:mp4|quicktime|x-m4v|webm)(?:;|$)/i
const IMAGE_EXTENSION_RE = /\.(jpe?g|png|webp|gif)$/i
const IMAGE_MIME_TO_EXTENSION = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
])
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_ITEMS = 5000
const CONTENT_PLAN_SCHEMA_VERSION = 'feishu-note-content-plan-v2'
const CONTENT_PLAN_EVIDENCE = Symbol('contentPlanEvidence')

function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).normalize('NFKC').trim()
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((output, key) => {
      output[key] = canonicalJson(value[key])
      return output
    }, {})
  }
  return value
}

function digest(value) {
  return sha256Text(JSON.stringify(canonicalJson(value)))
}

function allowedHostSet(values) {
  const hosts = (Array.isArray(values) ? values : String(values || '').split(','))
    .map((item) => normalizeText(item).toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
  if (!hosts.length) throw new Error('房源笔记链接缺少飞书域名白名单')
  hosts.forEach((host) => {
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
      throw new Error('房源笔记飞书域名白名单无效')
    }
  })
  return new Set(hosts)
}

function cellLink(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return normalizeText(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('房源笔记超链接单元格结构无效')
  }
  const link = normalizeText(value.link || value.url)
  if (!link) throw new Error('房源笔记超链接缺少 link')
  return link
}

function parseNoteMaterialLink(value, options = {}) {
  const rawLink = cellLink(value)
  if (!rawLink) return null
  let url
  try {
    url = new URL(rawLink)
  } catch (error) {
    throw new Error('房源笔记超链接 URL 无效')
  }
  if (url.protocol !== 'https:') throw new Error('房源笔记链接只允许 HTTPS')
  if (url.username || url.password) throw new Error('房源笔记链接不得包含账号凭据')
  if (url.port && url.port !== '443') throw new Error('房源笔记链接不得使用非标准端口')
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!allowedHostSet(options.allowedHosts).has(hostname)) {
    throw new Error('房源笔记链接域名不在白名单')
  }
  if (/%2f|%5c/i.test(url.pathname)) throw new Error('房源笔记链接资源路径包含编码分隔符')
  const segments = url.pathname.split('/').filter(Boolean)
  let kind = ''
  let rawToken = ''
  if (segments.length === 3 && segments[0] === 'drive' && segments[1] === 'folder') {
    kind = 'folder'
    rawToken = segments[2]
  } else if (segments.length === 2 && segments[0] === 'folder') {
    kind = 'folder'
    rawToken = segments[1]
  } else if (segments.length === 3 && segments[0] === 'drive' && segments[1] === 'file') {
    kind = 'file'
    rawToken = segments[2]
  } else if (segments.length === 2 && segments[0] === 'file') {
    kind = 'file'
    rawToken = segments[1]
  } else if (segments.length === 2 && segments[0] === 'docx') {
    kind = 'docx'
    rawToken = segments[1]
  } else if (segments.length === 2 && segments[0] === 'wiki') {
    kind = 'wiki'
    rawToken = segments[1]
  } else {
    throw new Error('房源笔记链接不是受支持的飞书资源路径')
  }
  let token
  try {
    token = decodeURIComponent(rawToken)
  } catch (error) {
    throw new Error('房源笔记链接 token 编码无效')
  }
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(token)) throw new Error('房源笔记链接 token 格式无效')
  const canonicalPath = kind === 'folder'
    ? `/drive/folder/${token}`
    : `/${kind}/${token}`
  return {
    kind,
    token,
    canonicalUrl: `https://${hostname}${canonicalPath}`
  }
}

function normalizeNoteMaterialLinkCell(value, options = {}) {
  const parsed = parseNoteMaterialLink(value, options)
  if (!parsed) return null
  return {
    link: parsed.canonicalUrl,
    text: '房源素材'
  }
}

function videoMetadata(name, type) {
  const safeName = normalizeText(name)
  const safeType = normalizeText(type).split(';')[0].trim().toLowerCase()
  const extensionMatch = safeName.toLowerCase().match(/\.(mp4|mov|m4v|webm)$/)
  if (!extensionMatch && !VIDEO_MIME_RE.test(safeType)) return null
  let extension = extensionMatch ? extensionMatch[1] : 'mp4'
  let mimeType = safeType
  if (!VIDEO_MIME_RE.test(mimeType)) {
    if (extension === 'mov') mimeType = 'video/quicktime'
    else if (extension === 'webm') mimeType = 'video/webm'
    else mimeType = 'video/mp4'
  }
  if (extension === 'm4v' && mimeType === 'video/mp4') mimeType = 'video/x-m4v'
  return { extension, mimeType }
}

function normalizedImageExtension(value) {
  const extension = normalizeText(value).toLowerCase()
  return extension === 'jpeg' ? 'jpg' : extension
}

function imageMimeForExtension(value) {
  const extension = normalizedImageExtension(value)
  if (extension === 'jpg') return 'image/jpeg'
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return ''
}

function imageMetadata(name, type, allowUndeclared = false) {
  const safeName = normalizeText(name)
  const extensionMatch = safeName.toLowerCase().match(IMAGE_EXTENSION_RE)
  const extension = extensionMatch ? normalizedImageExtension(extensionMatch[1]) : ''
  const safeType = normalizeText(type).split(';')[0].trim().toLowerCase()
  const mimeExtension = IMAGE_MIME_TO_EXTENSION.get(safeType) || ''
  if (!extension && !mimeExtension && !(allowUndeclared && (!safeType || safeType === 'image/*'))) return null
  if (extension && mimeExtension && imageMimeForExtension(extension) !== safeType) {
    throw new Error('房源笔记图片扩展名与 MIME 类型不一致')
  }
  const resolvedExtension = extension || mimeExtension
  return {
    kind: 'image',
    extension: resolvedExtension,
    mimeType: resolvedExtension ? imageMimeForExtension(resolvedExtension) : 'image/*'
  }
}

function sourceAssetMetadata(raw, sourceKind) {
  const name = normalizeText(raw && (raw.name || raw.file_name || raw.filename))
  const type = normalizeText(raw && (raw.type || raw.file_type || raw.mime_type))
  const video = videoMetadata(name, type)
  if (video) return { kind: 'video', ...video }
  return imageMetadata(name, type, sourceKind === 'docx-image' || Boolean(raw && raw.image))
}

function normalizeSourceAsset(raw, sourceKind, sourceOrder) {
  const token = normalizeText(raw && (raw.token || raw.file_token || raw.fileToken))
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(token)) throw new Error('房源笔记素材缺少稳定 token')
  const name = normalizeText(raw.name || raw.file_name || raw.filename)
  const type = normalizeText(raw.type || raw.file_type || raw.mime_type)
  const metadata = sourceAssetMetadata(raw, sourceKind)
  if (!metadata) return null
  const size = raw.size === undefined || raw.size === null || raw.size === ''
    ? null
    : Number(raw.size)
  if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw new Error('房源笔记素材大小无效')
  const modifiedTime = normalizeText(raw.modifiedTime || raw.modified_time || raw.modified_at)
  const sourceFingerprint = digest({
    sourceKind,
    token,
    modifiedTime,
    size,
    kind: metadata.kind,
    extension: metadata.extension,
    mimeType: metadata.mimeType
  })
  return {
    sourceToken: token,
    sourceKind,
    name: name || (metadata.extension ? `material.${metadata.extension}` : 'material'),
    kind: metadata.kind,
    extension: metadata.extension,
    mimeType: metadata.mimeType,
    modifiedTime,
    size,
    sourceOrder,
    sourceFingerprint
  }
}

function docxBlockMaterial(block) {
  const source = block && typeof block === 'object' ? block : {}
  if (source.file && typeof source.file === 'object') {
    return {
      token: source.file.token || source.file.file_token,
      name: source.file.name || source.file.file_name,
      type: source.file.mime_type || source.file.type
    }
  }
  if (source.image && typeof source.image === 'object') {
    return {
      token: source.image.token || source.image.file_token,
      name: source.image.name || 'image',
      type: source.image.mime_type || 'image/*',
      image: true
    }
  }
  return null
}

async function resolveNoteMaterialVideos(input = {}) {
  const parsed = parseNoteMaterialLink(input.value, { allowedHosts: input.allowedHosts })
  if (!parsed) {
    return {
      resource: null,
      assets: [],
      digest: digest([]),
      counts: { video: 0, image: 0, unsupported: 0, nonVideo: 0, duplicateReference: 0 }
    }
  }
  const client = input.client
  if (!client || typeof client !== 'object') throw new Error('房源笔记素材解析缺少客户端')
  const maxDepth = Number(input.maxDepth || DEFAULT_MAX_DEPTH)
  const maxItems = Number(input.maxItems || DEFAULT_MAX_ITEMS)
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) throw new Error('房源笔记最大目录深度无效')
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100000) throw new Error('房源笔记最大素材数无效')
  const assets = []
  const recursionStack = new Set()
  const visitedResourceKeys = new Set()
  const seenAssetTokens = new Set()
  const counts = { video: 0, image: 0, unsupported: 0, nonVideo: 0, duplicateReference: 0 }
  let inspectedItems = 0

  function inspectOne() {
    inspectedItems += 1
    if (inspectedItems > maxItems) throw new Error('房源笔记素材数量超过安全上限')
  }

  function addMaterial(raw, sourceKind, alreadyInspected = false) {
    if (!alreadyInspected) inspectOne()
    const next = normalizeSourceAsset(raw, sourceKind, assets.length)
    if (!next) {
      counts.unsupported += 1
      counts.nonVideo += 1
      return
    }
    if (seenAssetTokens.has(next.sourceToken)) {
      counts.duplicateReference += 1
      return
    }
    seenAssetTokens.add(next.sourceToken)
    assets.push(next)
    counts[next.kind] += 1
  }

  async function visit(resource, depth) {
    if (depth > maxDepth) throw new Error('房源笔记文件夹深度超过安全上限')
    const resourceKey = `${resource.kind}:${resource.token}`
    if (recursionStack.has(resourceKey)) throw new Error('房源笔记资源引用形成循环')
    if (visitedResourceKeys.has(resourceKey)) {
      counts.duplicateReference += 1
      return
    }
    recursionStack.add(resourceKey)
    visitedResourceKeys.add(resourceKey)
    try {
      if (resource.kind === 'wiki') {
        if (typeof client.resolveWikiNode !== 'function') throw new Error('飞书素材客户端不支持 Wiki')
        const node = await client.resolveWikiNode(resource.token)
        const kind = normalizeText(node.objType).toLowerCase()
        if (!['docx', 'file', 'folder'].includes(kind)) {
          throw new Error(`房源笔记 Wiki 节点类型不支持：${kind || '未知'}`)
        }
        await visit({ kind, token: normalizeText(node.objToken) }, depth)
        return
      }
      if (resource.kind === 'file') {
        if (typeof client.getFile !== 'function') throw new Error('飞书素材客户端不支持文件元数据')
        addMaterial(await client.getFile(resource.token), 'drive-file')
        return
      }
      if (resource.kind === 'docx') {
        if (typeof client.listDocxBlocks !== 'function') throw new Error('飞书素材客户端不支持 Docx')
        const blocks = await client.listDocxBlocks(resource.token)
        if (!Array.isArray(blocks)) throw new Error('飞书文档块响应必须是数组')
        blocks.forEach((block) => {
          const material = docxBlockMaterial(block)
          if (material) addMaterial(material, material.image ? 'docx-image' : 'docx-file')
        })
        return
      }
      if (resource.kind === 'folder') {
        if (typeof client.listFolder !== 'function') throw new Error('飞书素材客户端不支持文件夹')
        const children = await client.listFolder(resource.token)
        if (!Array.isArray(children)) throw new Error('飞书文件夹响应必须是数组')
        const ordered = children.slice().sort((left, right) => {
          const leftFolder = /folder/.test(normalizeText(left && (left.type || left.file_type)).toLowerCase())
          const rightFolder = /folder/.test(normalizeText(right && (right.type || right.file_type)).toLowerCase())
          if (leftFolder !== rightFolder) return leftFolder ? 1 : -1
          const leftKey = `${normalizeText(left && left.name).toLocaleLowerCase('zh-CN')}\u0000${normalizeText(left && left.token)}`
          const rightKey = `${normalizeText(right && right.name).toLocaleLowerCase('zh-CN')}\u0000${normalizeText(right && right.token)}`
          return leftKey.localeCompare(rightKey, 'zh-CN')
        })
        for (const child of ordered) {
          inspectOne()
          const childType = normalizeText(child && (child.type || child.file_type)).toLowerCase()
          const token = normalizeText(child && (child.token || child.file_token))
          if (/folder/.test(childType)) {
            await visit({ kind: 'folder', token }, depth + 1)
          } else if (childType === 'docx') {
            await visit({ kind: 'docx', token }, depth + 1)
          } else {
            addMaterial(child, 'drive-file', true)
          }
        }
        return
      }
      throw new Error('房源笔记资源类型不支持')
    } finally {
      // 这里只阻断真实递归环；同一容器在另一路重复引用仍由素材 token 去重。
      recursionStack.delete(resourceKey)
    }
  }

  await visit(parsed, 0)
  assets.forEach((asset, index) => { asset.sourceOrder = index })
  return {
    resource: parsed,
    assets,
    digest: digest(assets.map((asset) => ({
      sourceToken: asset.sourceToken,
      sourceKind: asset.sourceKind,
      sourceFingerprint: asset.sourceFingerprint,
      sourceOrder: asset.sourceOrder
    }))),
    counts
  }
}

function stableAssetId(sourceRecordId, asset) {
  const sourceId = normalizeText(sourceRecordId)
  const sourceToken = normalizeText(asset && asset.sourceToken)
  const sourceKind = normalizeText(asset && asset.sourceKind)
  if (!sourceId || !sourceToken || !sourceKind) throw new Error('生成素材 ID 的稳定身份不完整')
  return `MAT-${sha256Text(`${sourceId}\n${sourceKind}\n${sourceToken}`).slice(0, 32)}`
}

function normalizedSet(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label}素材集合必须是数组`)
  const normalized = values.map(normalizeText)
  if (normalized.some((value) => !value)) throw new Error(`${label}素材集合包含空 ID`)
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label}素材集合包含重复 ID`)
  return normalized.sort()
}

function assertMaterialSetEquality(sets = {}) {
  const labels = Object.keys(sets)
  if (labels.length < 2) throw new Error('素材集合一致性至少需要两组证据')
  const baseline = normalizedSet(sets[labels[0]], labels[0])
  labels.slice(1).forEach((label) => {
    const current = normalizedSet(sets[label], label)
    if (JSON.stringify(current) !== JSON.stringify(baseline)) {
      throw new Error(`素材集合不一致：${labels[0]} 与 ${label}`)
    }
  })
  return true
}

function assertIsolatedStatePaths(legacyStatePath, noteStatePath) {
  const legacy = normalizeText(legacyStatePath)
  const note = normalizeText(noteStatePath)
  if (!legacy || !note) throw new Error('素材回执路径必须完整')
  const legacyResolved = path.resolve(legacy).replace(/\\/g, '/').toLowerCase()
  const noteResolved = path.resolve(note).replace(/\\/g, '/').toLowerCase()
  if (legacyResolved === noteResolved) throw new Error('房源笔记素材回执必须与旧迁移回执独立且不得重合')
  return true
}

function contentSha256(value) {
  const hash = normalizeText(value).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('房源笔记素材内容 SHA-256 无效')
  return hash
}

function normalizeContentMimeType(value) {
  const mimeType = normalizeText(value).toLowerCase()
  if (!mimeType || mimeType.length > 256 || /[\0\r\n]/.test(mimeType)) {
    throw new Error('房源笔记素材内容 MIME 类型无效')
  }
  return mimeType
}

function normalizeContentPlanEvidence(raw = {}) {
  const sourceRecordFingerprint = contentSha256(raw.sourceRecordFingerprint)
  const assetId = normalizeText(raw.assetId)
  if (!/^MAT-[a-f0-9]{32}$/i.test(assetId)) throw new Error('房源笔记内容计划素材 ID 无效')
  const rawMimeType = normalizeContentMimeType(raw.mimeType)
  const kind = normalizeText(raw.kind) || (rawMimeType.startsWith('image/') ? 'image' : 'video')
  if (!['video', 'image'].includes(kind)) throw new Error('房源笔记内容计划素材类型无效')
  const size = Number(raw.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('房源笔记内容计划素材大小无效')
  const displayOrder = Number(raw.displayOrder)
  if (!Number.isSafeInteger(displayOrder) || displayOrder < 0) {
    throw new Error('房源笔记内容计划展示顺序无效')
  }
  return {
    sourceRecordFingerprint,
    assetId,
    kind,
    contentSha256: contentSha256(raw.contentSha256),
    size,
    mimeType: rawMimeType,
    displayOrder
  }
}

function normalizedContentPlanEvidence(values) {
  if (!Array.isArray(values)) throw new Error('房源笔记内容计划证据必须是数组')
  const evidence = values.map(normalizeContentPlanEvidence)
  const identityKeys = evidence.map((item) => `${item.sourceRecordFingerprint}\n${item.assetId}`)
  if (new Set(identityKeys).size !== identityKeys.length) {
    throw new Error('房源笔记内容计划包含重复素材身份')
  }
  return evidence.sort((left, right) => (
    left.sourceRecordFingerprint.localeCompare(right.sourceRecordFingerprint) ||
    left.displayOrder - right.displayOrder ||
    left.assetId.localeCompare(right.assetId)
  ))
}

function buildContentPlanSummary(values) {
  const evidence = normalizedContentPlanEvidence(values)
  return {
    contentPlanSha256: digest({
      schemaVersion: CONTENT_PLAN_SCHEMA_VERSION,
      assetCount: evidence.length,
      assets: evidence
    }),
    contentPlanAssetCount: evidence.length
  }
}

function contentPlanConfirmationError(message, statusCode = 409) {
  const error = new Error(message)
  error.name = 'ContentPlanConfirmationError'
  error.code = 'CONTENT_PLAN_CONFIRMATION_FAILED'
  error.statusCode = statusCode
  return error
}

function isContentPlanConfirmationError(error) {
  return Boolean(error && error.code === 'CONTENT_PLAN_CONFIRMATION_FAILED')
}

function expectedContentPlanFromInput(input = {}) {
  if (input.contentPlanConfirmationRequired !== true || input.dryRun === true) return null
  const hash = input.expectedContentPlanSha256
  const count = input.expectedContentAssetCount
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    throw contentPlanConfirmationError('房源笔记素材正式同步缺少合法内容计划确认摘要', 400)
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw contentPlanConfirmationError('房源笔记素材正式同步缺少合法内容计划确认数量', 400)
  }
  if (!Array.isArray(input.expectedContentPlanEvidence)) {
    throw contentPlanConfirmationError('房源笔记素材正式同步缺少同次预检的行级内容计划', 400)
  }
  const evidence = normalizedContentPlanEvidence(input.expectedContentPlanEvidence)
  const summary = buildContentPlanSummary(evidence)
  if (summary.contentPlanSha256 !== hash || summary.contentPlanAssetCount !== count) {
    throw contentPlanConfirmationError('房源笔记素材确认摘要与行级内容计划不一致', 400)
  }
  return {
    expectedContentPlanSha256: hash,
    expectedContentAssetCount: count,
    expectedContentPlanEvidence: evidence
  }
}

function assertContentPlanMatchesExpected(values, expected, message) {
  if (!expected) return
  const evidence = normalizedContentPlanEvidence(values)
  const summary = buildContentPlanSummary(evidence)
  if (summary.contentPlanSha256 !== expected.expectedContentPlanSha256 ||
      summary.contentPlanAssetCount !== expected.expectedContentAssetCount ||
      JSON.stringify(evidence) !== JSON.stringify(expected.expectedContentPlanEvidence)) {
    throw contentPlanConfirmationError(message || '房源笔记素材内容计划与确认预检不一致')
  }
}

function expectedEvidenceForSourceRecord(expected, sourceRecordId) {
  if (!expected) return null
  const sourceRecordFingerprint = sha256Text(normalizeText(sourceRecordId))
  return expected.expectedContentPlanEvidence.filter((item) => (
    item.sourceRecordFingerprint === sourceRecordFingerprint
  ))
}

function attachContentPlanEvidence(target, values) {
  const evidence = normalizedContentPlanEvidence(values)
  Object.defineProperty(target, CONTENT_PLAN_EVIDENCE, {
    value: evidence,
    enumerable: false,
    configurable: false,
    writable: false
  })
  return target
}

function contentPlanConfirmationFromReport(report) {
  if (!report || report.complete !== true ||
      typeof report.contentPlanSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(report.contentPlanSha256) ||
      !Number.isSafeInteger(report.contentPlanAssetCount) ||
      report.contentPlanAssetCount < 0 ||
      !Array.isArray(report[CONTENT_PLAN_EVIDENCE])) {
    throw contentPlanConfirmationError('房源笔记素材预检未生成可确认的完整内容计划')
  }
  const evidence = normalizedContentPlanEvidence(report[CONTENT_PLAN_EVIDENCE])
  const summary = buildContentPlanSummary(evidence)
  if (summary.contentPlanSha256 !== report.contentPlanSha256 ||
      summary.contentPlanAssetCount !== report.contentPlanAssetCount) {
    throw contentPlanConfirmationError('房源笔记素材预检摘要与私有行级计划不一致')
  }
  return {
    expectedContentPlanSha256: summary.contentPlanSha256,
    expectedContentAssetCount: summary.contentPlanAssetCount,
    expectedContentPlanEvidence: evidence
  }
}

function sourceEvidenceForAsset(asset, evidence) {
  if (!evidence || !Buffer.isBuffer(evidence.buffer) || !evidence.buffer.length) {
    throw new Error('房源笔记源素材缺少受限下载内容')
  }
  // downloadToken 已返回本次调用独占的 Buffer；这里只读核验并沿用同一引用，
  // 避免单个大视频因防御性复制瞬间占用双倍内存。
  const buffer = evidence.buffer
  const actualHash = crypto.createHash('sha256').update(buffer).digest('hex')
  if (evidence.contentSha256 && contentSha256(evidence.contentSha256) !== actualHash) {
    throw new Error('房源笔记源素材摘要与下载内容不一致')
  }
  if (evidence.size !== undefined && evidence.size !== null && evidence.size !== '' &&
      Number(evidence.size) !== buffer.length) {
    throw new Error('房源笔记源素材大小与下载内容不一致')
  }
  const upstreamContentType = normalizeContentMimeType(
    evidence.contentType || (asset && asset.mimeType) || 'application/octet-stream'
  ).split(';')[0].trim().toLowerCase()
  const kind = normalizeText(asset && asset.kind) || 'video'
  let extension = normalizeText(asset && asset.extension).toLowerCase()
  let contentType = ''
  if (kind === 'image') {
    let detected = null
    if (buffer.length >= 4 &&
        buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      detected = { extension: 'jpg', contentType: 'image/jpeg' }
    } else if (buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      detected = { extension: 'png', contentType: 'image/png' }
    } else if (buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      detected = { extension: 'webp', contentType: 'image/webp' }
    } else if (buffer.length >= 6 &&
        ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
      detected = { extension: 'gif', contentType: 'image/gif' }
    }
    if (!detected) throw new Error('房源笔记图片真实字节类型不受支持')
    const declaredMime = normalizeText(asset && asset.mimeType).split(';')[0].trim().toLowerCase()
    if (extension && normalizedImageExtension(extension) !== detected.extension) {
      throw new Error('房源笔记图片扩展名与真实字节类型不一致')
    }
    if (declaredMime && declaredMime !== 'image/*' && declaredMime !== detected.contentType) {
      throw new Error('房源笔记图片 MIME 与真实字节类型不一致')
    }
    if (upstreamContentType !== 'application/octet-stream' &&
        upstreamContentType !== 'image/*' &&
        upstreamContentType !== detected.contentType) {
      throw new Error('房源笔记图片下载响应类型与真实字节不一致')
    }
    extension = detected.extension
    contentType = detected.contentType
  } else if (kind === 'video') {
    const declaredMetadata = videoMetadata(
      normalizeText(asset && asset.name) || `material.${extension || 'mp4'}`,
      normalizeText(asset && asset.mimeType)
    )
    if (!declaredMetadata) throw new Error('房源笔记视频类型不受支持')
    if (upstreamContentType !== 'application/octet-stream' && !VIDEO_MIME_RE.test(upstreamContentType)) {
      throw new Error('房源笔记视频下载响应类型无效')
    }
    let metadata = declaredMetadata
    if (upstreamContentType !== 'application/octet-stream') {
      if (upstreamContentType === 'video/quicktime') metadata = { extension: 'mov', mimeType: upstreamContentType }
      else if (upstreamContentType === 'video/webm') metadata = { extension: 'webm', mimeType: upstreamContentType }
      else if (upstreamContentType === 'video/x-m4v') metadata = { extension: 'm4v', mimeType: upstreamContentType }
      else metadata = {
        extension: declaredMetadata.extension === 'm4v' ? 'm4v' : 'mp4',
        mimeType: declaredMetadata.extension === 'm4v' ? 'video/x-m4v' : 'video/mp4'
      }
    }
    extension = metadata.extension
    contentType = metadata.mimeType
  } else {
    throw new Error('房源笔记素材类型不受支持')
  }
  return {
    buffer,
    kind,
    extension,
    contentSha256: actualHash,
    size: buffer.length,
    contentType
  }
}

function targetNameForAsset(assetId, extension, hash) {
  return `${normalizeText(assetId)}-${contentSha256(hash)}.${normalizeText(extension)}`
}

function objectKeyForAsset(uploadDir, sourceRecordId, assetId, extension, hash) {
  const root = normalizeText(uploadDir || 'house-videos').replace(/^\/+|\/+$/g, '')
  if (!root || /[\\?#\0\r\n]/.test(root) || root.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('素材 OSS 上传目录无效')
  }
  const sourceRecordFingerprint = sha256Text(normalizeText(sourceRecordId)).slice(0, 24)
  return `${root}/feishu-note-v1/${sourceRecordFingerprint}/${assetId}-${contentSha256(hash)}.${extension}`
}

function cloneMediaAsset(asset) {
  const kind = normalizeText(asset.kind) === 'image' ? 'image' : 'video'
  return {
    assetId: normalizeText(asset.assetId),
    kind,
    objectKey: normalizeText(asset.objectKey),
    contentSha256: normalizeText(asset.contentSha256),
    sourceFingerprint: normalizeText(asset.sourceFingerprint),
    targetDriveFingerprint: normalizeText(asset.targetDriveFingerprint),
    displayOrder: Number(asset.displayOrder) || 0,
    mimeType: normalizeText(asset.mimeType) || (kind === 'image' ? 'image/jpeg' : 'video/mp4'),
    size: Number(asset.size) || 0,
    verified: asset.verified === true
  }
}

async function syncNoteMaterialVideos(input = {}) {
  const sourceRecordId = normalizeText(input.sourceRecordId)
  if (!sourceRecordId) throw new Error('房源笔记素材同步缺少 sourceRecordId')
  if (!Array.isArray(input.assets)) throw new Error('房源笔记素材同步缺少素材数组')
  const orderedAssets = input.assets.slice().sort((left, right) => (
    Number(left.sourceOrder || 0) - Number(right.sourceOrder || 0) ||
    normalizeText(left.sourceToken).localeCompare(normalizeText(right.sourceToken))
  ))
  if (orderedAssets.length > MAX_LISTING_MEDIA_ASSETS) {
    throw new Error(`单套房源视频素材超过安全上限 ${MAX_LISTING_MEDIA_ASSETS}`)
  }
  const sourceTokens = orderedAssets.map((asset) => normalizeText(asset.sourceToken))
  if (sourceTokens.some((token) => !token) || new Set(sourceTokens).size !== sourceTokens.length) {
    throw new Error('房源笔记素材 token 缺失或重复')
  }
  if (orderedAssets.length && (!input.drive || typeof input.drive.downloadToken !== 'function')) {
    throw new Error('房源笔记素材同步缺少源内容受限下载适配器')
  }
  // 数量、token 和上层跨记录冲突门禁全部通过后，先逐个只读下载源文件并计算真实内容摘要，
  // 计划中只保留摘要、大小和类型，不保留 Buffer。这样既能在首个外部写入前验证全部源文件，
  // 又不会把最多 64 个大视频同时常驻内存。
  const planned = []
  for (let index = 0; index < orderedAssets.length; index += 1) {
    const asset = orderedAssets[index]
    const assetId = stableAssetId(sourceRecordId, asset)
    const sourceEvidence = sourceEvidenceForAsset(
      asset,
      await input.drive.downloadToken(asset.sourceToken, asset.sourceKind)
    )
    planned.push({
      asset,
      assetId,
      kind: sourceEvidence.kind,
      extension: sourceEvidence.extension,
      mimeType: sourceEvidence.contentType,
      targetName: targetNameForAsset(assetId, sourceEvidence.extension, sourceEvidence.contentSha256),
      objectKey: objectKeyForAsset(
        input.uploadDir,
        sourceRecordId,
        assetId,
        sourceEvidence.extension,
        sourceEvidence.contentSha256
      ),
      contentSha256: sourceEvidence.contentSha256,
      size: sourceEvidence.size,
      contentType: sourceEvidence.contentType,
      displayOrder: index
    })
  }
  const contentPlanEvidence = planned.map((plan) => normalizeContentPlanEvidence({
    sourceRecordFingerprint: sha256Text(sourceRecordId),
    assetId: plan.assetId,
    kind: plan.kind,
    contentSha256: plan.contentSha256,
    size: plan.size,
    mimeType: plan.contentType,
    displayOrder: plan.displayOrder
  }))
  const contentPlanSummary = buildContentPlanSummary(contentPlanEvidence)
  if (Array.isArray(input.expectedContentPlanEvidence)) {
    const expectedEvidence = normalizedContentPlanEvidence(input.expectedContentPlanEvidence)
    if (JSON.stringify(contentPlanEvidence) !== JSON.stringify(expectedEvidence)) {
      throw contentPlanConfirmationError('房源笔记素材内容计划确认在全局预检与逐行正式读取之间发生变化')
    }
  }
  const existingById = new Map((Array.isArray(input.existingMediaAssets) ? input.existingMediaAssets : [])
    .map((asset) => [normalizeText(asset && asset.assetId), asset]))
  const resultAssets = []
  const driveVerifiedIds = []
  const ossVerifiedIds = []
  const manifestIds = []
  let targetFolder = null
  let reused = 0
  let transferred = 0

  async function ensureTargetFolder() {
    if (targetFolder) return targetFolder
    if (!input.drive || typeof input.drive.ensureListingFolder !== 'function') {
      throw new Error('房源笔记素材同步缺少 Drive 写后回读适配器')
    }
    targetFolder = await input.drive.ensureListingFolder({
      parentFolderToken: input.targetRootFolderToken,
      sourceRecordId,
      ...(input.folderContext || {})
    })
    if (!targetFolder || !normalizeText(targetFolder.token)) throw new Error('房源笔记目标目录未通过回读')
    return targetFolder
  }

  async function downloadMatchingPlannedSource(plan, failureMessage) {
    const sourceEvidence = sourceEvidenceForAsset(
      plan.asset,
      await input.drive.downloadToken(plan.asset.sourceToken, plan.asset.sourceKind)
    )
    if (sourceEvidence.contentSha256 !== plan.contentSha256 ||
        sourceEvidence.size !== plan.size ||
        sourceEvidence.kind !== plan.kind ||
        sourceEvidence.extension !== plan.extension ||
        sourceEvidence.contentType !== plan.mimeType) {
      throw new Error(failureMessage)
    }
    return sourceEvidence
  }

  // 正式写入前先对整批素材再做一次无 Buffer 留存的全局预检。
  // 只有所有素材都与计划一致，才允许创建目录或写入任一 Drive/OSS 对象。
  if (input.dryRun !== true) {
    for (const plan of planned) {
      await downloadMatchingPlannedSource(plan, '房源笔记源素材在同步计划执行前发生变化')
    }
  }

  for (const plan of planned) {
    let sourceEvidence = null
    if (input.dryRun !== true) {
      // 全批预检与首个外部写之间仍可能发生源内容变化，因此写每个素材前重新下载，
      // 并把这份刚校验的独占 Buffer 直接交给 Drive 与 OSS，避免按可变 token 再复制。
      sourceEvidence = await downloadMatchingPlannedSource(
        plan,
        '房源笔记源素材在同步写入前发生变化'
      )
    }
    const existing = existingById.get(plan.assetId)
    if (existing &&
        normalizeText(existing.contentSha256) === plan.contentSha256 &&
        normalizeText(existing.objectKey) === plan.objectKey &&
        typeof input.verifyExisting === 'function' &&
        input.dryRun !== true) {
      const folder = await ensureTargetFolder()
      const evidence = await input.verifyExisting(cloneMediaAsset(existing), {
        targetFolderToken: folder.token,
        targetName: plan.targetName,
        sourceToken: plan.asset.sourceToken,
        sourceKind: plan.asset.sourceKind,
        sourceEvidence
      })
      if (evidence && evidence.sourceVerified === true &&
          evidence.driveVerified === true && evidence.ossVerified === true) {
        resultAssets.push({
          ...cloneMediaAsset(existing),
          kind: plan.kind,
          contentSha256: plan.contentSha256,
          sourceFingerprint: plan.asset.sourceFingerprint,
          mimeType: plan.mimeType,
          size: plan.size,
          displayOrder: plan.displayOrder
        })
        driveVerifiedIds.push(plan.assetId)
        ossVerifiedIds.push(plan.assetId)
        manifestIds.push(plan.assetId)
        reused += 1
        continue
      }
    }

    if (input.dryRun === true) {
      resultAssets.push({
        assetId: plan.assetId,
        kind: plan.kind,
        objectKey: plan.objectKey,
        contentSha256: plan.contentSha256,
        sourceFingerprint: plan.asset.sourceFingerprint,
        targetDriveFingerprint: '',
        displayOrder: plan.displayOrder,
        mimeType: plan.mimeType,
        size: plan.size,
        verified: false
      })
      manifestIds.push(plan.assetId)
      continue
    }

    const materializeAsset = input.drive && (
      typeof input.drive.materializeAsset === 'function'
        ? input.drive.materializeAsset
        : input.drive.materializeVideo
    )
    const putMaterialDeterministic = input.oss && (
      typeof input.oss.putMaterialDeterministic === 'function'
        ? input.oss.putMaterialDeterministic
        : input.oss.putVideoDeterministic
    )
    if (!input.drive || typeof input.drive.ensureListingFolder !== 'function' ||
        typeof materializeAsset !== 'function') {
      throw new Error('房源笔记素材同步缺少 Drive 写后回读适配器')
    }
    if (!input.oss || typeof putMaterialDeterministic !== 'function') {
      throw new Error('房源笔记素材同步缺少 OSS 写后回读适配器')
    }
    await ensureTargetFolder()
    const driveResult = await materializeAsset.call(input.drive, {
      asset: plan.asset,
      targetFolderToken: targetFolder.token,
      targetName: plan.targetName,
      sourceEvidence
    })
    if (!driveResult || driveResult.verified !== true || !Buffer.isBuffer(driveResult.buffer) ||
        !normalizeText(driveResult.contentSha256) || !normalizeText(driveResult.targetToken) ||
        normalizeText(driveResult.targetName) !== plan.targetName ||
        contentSha256(driveResult.contentSha256) !== plan.contentSha256 ||
        crypto.createHash('sha256').update(driveResult.buffer).digest('hex') !== plan.contentSha256 ||
        driveResult.buffer.length !== plan.size ||
        normalizeContentMimeType(driveResult.contentType || plan.mimeType).split(';')[0] !== plan.mimeType) {
      throw new Error('房源笔记 Drive 素材未通过内容回读')
    }
    driveVerifiedIds.push(plan.assetId)
    const saved = await putMaterialDeterministic.call(input.oss, {
      kind: plan.kind,
      objectKey: plan.objectKey,
      buffer: driveResult.buffer,
      contentType: plan.mimeType,
      contentSha256: driveResult.contentSha256
    })
    if (!saved || saved.verified !== true || normalizeText(saved.objectKey) !== plan.objectKey ||
        normalizeText(saved.contentSha256) !== normalizeText(driveResult.contentSha256) ||
        Number(saved.size) !== driveResult.buffer.length) {
      throw new Error('房源笔记 OSS 素材未通过写后回读')
    }
    ossVerifiedIds.push(plan.assetId)
    resultAssets.push({
      assetId: plan.assetId,
      kind: plan.kind,
      objectKey: plan.objectKey,
      contentSha256: driveResult.contentSha256,
      sourceFingerprint: plan.asset.sourceFingerprint,
      targetDriveFingerprint: sha256Text(driveResult.targetToken),
      displayOrder: plan.displayOrder,
      mimeType: plan.mimeType,
      size: driveResult.buffer.length,
      verified: true
    })
    manifestIds.push(plan.assetId)
    transferred += 1
  }

  const sourceIds = planned.map((item) => item.assetId)
  if (input.dryRun !== true) {
    assertMaterialSetEquality({
      source: sourceIds,
      drive: driveVerifiedIds,
      oss: ossVerifiedIds,
      manifest: manifestIds
    })
  } else {
    assertMaterialSetEquality({ source: sourceIds, manifest: manifestIds })
  }
  const mediaAssets = resultAssets.map(cloneMediaAsset)
  const result = {
    mediaAssets,
    primaryVideo: mediaAssets.find((asset) => asset.kind === 'video') || null,
    noop: transferred === 0 && input.dryRun !== true,
    dryRun: input.dryRun === true,
    ...contentPlanSummary,
    counts: {
      source: planned.length,
      driveVerified: driveVerifiedIds.length,
      ossVerified: ossVerifiedIds.length,
      manifest: mediaAssets.length,
      reused,
      transferred
    }
  }
  return attachContentPlanEvidence(result, contentPlanEvidence)
}

const runningInventoryDatabases = new WeakSet()

function physicalUnitFingerprint(listing = {}) {
  const explicit = normalizeText(listing.physicalUnitKey)
  const parts = explicit ? [explicit] : [
    listing.district,
    listing.block || listing.area,
    listing.community,
    listing.building,
    listing.unit,
    listing.roomNumber
  ].map(normalizeText)
  if (!parts.some(Boolean)) return ''
  return sha256Text(parts.join('\n'))
}

function activeInventoryListing(listing = {}) {
  const status = normalizeText(listing.status || listing.listingStatus || listing.lifecycleStatus)
  return !/(已下架|已出租|已成交|关闭|无效|删除|暂停|expired|inactive|rented|closed)/i.test(status)
}

function sourceListing(db, sourceRecordId) {
  return (db.listings || []).find((listing) => (
    normalizeText(listing && (listing.feishuRecordId || listing.externalId || listing.sourceRecordId)) === sourceRecordId
  )) || null
}

function noteManagedPrimaryKey(listing = {}) {
  const keys = new Set((Array.isArray(listing.mediaAssets) ? listing.mediaAssets : [])
    .filter((asset) => /\/feishu-note-v1\//.test(normalizeText(asset && asset.objectKey)))
    .map((asset) => normalizeText(asset && asset.objectKey))
    .filter(Boolean))
  return keys.has(normalizeText(listing.videoKey)) ? normalizeText(listing.videoKey) : ''
}

async function replaceNoteManagedMedia(listing, mediaAssets, options = {}) {
  if (typeof options.replaceMediaAssets === 'function') {
    await options.replaceMediaAssets(listing, mediaAssets, {
      expectedStateKey: normalizeText(options.expectedStateKey),
      updatedAt: normalizeText(options.updatedAt)
    })
    return
  }
  listing.mediaAssets = mediaAssets.map(cloneMediaAsset)
  const primaryVideo = listing.mediaAssets.find((asset) => asset.kind === 'video')
  listing.videoKey = primaryVideo ? primaryVideo.objectKey : ''
  listing.videoUrl = ''
}

async function clearNoteManagedMedia(listing, state, options = {}) {
  if (!listing) return false
  const currentAssets = Array.isArray(listing.mediaAssets) ? listing.mediaAssets : []
  const noteAssets = currentAssets.filter((asset) => /\/feishu-note-v1\//.test(normalizeText(asset && asset.objectKey)))
  const remainingAssets = currentAssets
    .filter((asset) => !/\/feishu-note-v1\//.test(normalizeText(asset && asset.objectKey)))
    .map((asset, index) => ({ ...asset, displayOrder: index }))
  const hadAssets = noteAssets.length > 0
  const managedPrimary = noteManagedPrimaryKey(listing)
  if (hadAssets) {
    await replaceNoteManagedMedia(listing, remainingAssets, {
      ...options,
      updatedAt: normalizeText(state && state.updatedAt)
    })
  }
  listing.noteMaterialState = {
    sourceLinkFingerprint: normalizeText(state && state.sourceLinkFingerprint),
    physicalUnitFingerprint: normalizeText(state && state.physicalUnitFingerprint),
    digest: '',
    status: 'cleared',
    counts: { video: 0, image: 0, unsupported: 0, nonVideo: 0, duplicateReference: 0 },
    updatedAt: normalizeText(state && state.updatedAt)
  }
  return hadAssets || Boolean(managedPrimary)
}

function safeFailureMessage(error) {
  return normalizeText(error && error.message)
    .replace(/[A-Za-z0-9_-]{16,}/g, '[标识已脱敏]')
    .slice(0, 180) || '素材同步失败'
}

function temporaryNoteMaterialFailure(error) {
  const statusCode = Number(error && (error.statusCode || error.status))
  if ([401, 403, 408, 425, 429].includes(statusCode) || (statusCode >= 500 && statusCode <= 599)) return true
  const code = normalizeText(error && error.code).toUpperCase()
  if (/^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR_[A-Z_]+)$/.test(code)) return true
  return Boolean(error && error.name === 'AbortError')
}

function mediaAssetsStateConflict(error) {
  return Number(error && (error.statusCode || error.status)) === 409
}

function assertMediaAssetsStateUnchanged(listing, expectedStateKey, stateKeyFactory) {
  if (typeof stateKeyFactory !== 'function') return
  const currentStateKey = normalizeText(stateKeyFactory(listing))
  if (currentStateKey === normalizeText(expectedStateKey)) return
  const error = new Error('房源素材已被其他同步任务更新，请基于最新状态重试')
  error.statusCode = 409
  throw error
}

function appendStateConflict(report, row, error) {
  report.failed += 1
  report.rows.push({
    sourceRecordId: normalizeText(row && row.sourceRecordId),
    status: 'state-conflict',
    error: safeFailureMessage(error)
  })
}

async function syncNoteMaterialsForInventory(input = {}) {
  const db = input.db
  if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('房源笔记素材同步缺少库存数据库')
  // 正式确认字段必须在源表、工作 DB、Drive 或 OSS 的任何读取/写入之前完成形状校验。
  // dry-run 与未启用确认门的旧链路不会被扩大契约。
  const expectedContentPlan = expectedContentPlanFromInput(input)
  if (runningInventoryDatabases.has(db)) {
    const error = new Error('房源笔记素材同步正在执行，禁止并发覆盖独立素材状态')
    error.statusCode = 409
    throw error
  }
  const rows = Array.isArray(input.sourceRows) ? input.sourceRows : []
  const now = normalizeText(input.nowText) || new Date().toISOString()
  const report = {
    complete: true,
    published: false,
    dryRun: input.dryRun === true,
    sourceRecordCount: rows.length,
    resolved: 0,
    synced: 0,
    cleared: 0,
    retained: 0,
    failed: 0,
    video: 0,
    image: 0,
    unsupported: 0,
    nonVideo: 0,
    duplicateReference: 0,
    rows: []
  }
  const contentPlanEvidence = []

  runningInventoryDatabases.add(db)
  try {
    const resolvedRows = []
    const pendingClears = []
    const pendingFailures = []
    for (const row of rows) {
      const sourceRecordId = normalizeText(row && row.sourceRecordId)
      if (!sourceRecordId) throw new Error('房源笔记素材源记录缺少 sourceRecordId')
      const listing = sourceListing(db, sourceRecordId)
      if (!listing) {
        report.failed += 1
        report.rows.push({ sourceRecordId, status: 'listing-missing' })
        continue
      }
      const expectedStateKey = typeof input.mediaAssetsStateKey === 'function'
        ? input.mediaAssetsStateKey(listing)
        : ''
      let parsed
      let linkFingerprint = ''
      try {
        parsed = parseNoteMaterialLink(row.value, { allowedHosts: input.allowedHosts })
        linkFingerprint = parsed ? sha256Text(parsed.canonicalUrl) : ''
      } catch (error) {
        pendingFailures.push({ sourceRecordId, listing, linkFingerprint, expectedStateKey, error })
        continue
      }
      if (!parsed) {
        pendingClears.push({ sourceRecordId, listing, expectedStateKey })
        continue
      }
      try {
        const resolved = await resolveNoteMaterialVideos({
          value: row.value,
          allowedHosts: input.allowedHosts,
          client: input.drive,
          maxDepth: input.maxDepth,
          maxItems: input.maxItems
        })
        resolvedRows.push({ sourceRecordId, listing, resolved, linkFingerprint, expectedStateKey })
        report.resolved += 1
        report.video += resolved.counts.video
        report.image += resolved.counts.image
        report.unsupported += resolved.counts.unsupported
        report.nonVideo += resolved.counts.nonVideo
        report.duplicateReference += resolved.counts.duplicateReference
      } catch (error) {
        pendingFailures.push({ sourceRecordId, listing, linkFingerprint, expectedStateKey, error })
      }
    }

    const overLimitRows = resolvedRows.filter((row) => row.resolved.assets.length > MAX_LISTING_MEDIA_ASSETS)
    if (overLimitRows.length) {
      report.failed += overLimitRows.length
      report.complete = false
      report.published = false
      report.rows.push(...overLimitRows.map((row) => ({
        sourceRecordId: row.sourceRecordId,
        status: 'media-limit-exceeded',
        mediaCount: row.resolved.assets.length,
        limit: MAX_LISTING_MEDIA_ASSETS
      })))
      return report
    }

    const unsupportedRows = resolvedRows.filter((row) => Number(
      row.resolved.counts.unsupported || row.resolved.counts.nonVideo || 0
    ) > 0)
    if (unsupportedRows.length) {
      report.failed += unsupportedRows.length
      report.complete = false
      report.published = false
      report.status = 'unsupported-non-video'
      report.rows.push(...unsupportedRows.map((row) => ({
        sourceRecordId: row.sourceRecordId,
        status: 'unsupported-non-video',
        unsupported: Number(row.resolved.counts.unsupported || row.resolved.counts.nonVideo || 0),
        nonVideo: Number(row.resolved.counts.nonVideo || 0)
      })))
      return report
    }

    // 正式同步先对全部可解析行执行一次完整只读计划，聚合结果与人类确认的同次预检
    // 精确一致后，才允许清理 DB、创建 Drive 目录或写入任一素材。计划只保留摘要，
    // 不持有 Buffer、token、URL、路径或对象 key。
    if (expectedContentPlan) {
      const inventoryPlanEvidence = []
      for (const row of resolvedRows) {
        const planned = await syncNoteMaterialVideos({
          sourceRecordId: row.sourceRecordId,
          assets: row.resolved.assets,
          existingMediaAssets: row.listing.mediaAssets,
          uploadDir: input.uploadDir,
          targetRootFolderToken: input.targetRootFolderToken,
          folderContext: {
            district: row.listing.district,
            block: row.listing.block || row.listing.area,
            locationId: row.listing.locationId,
            community: row.listing.community,
            building: row.listing.building,
            unit: row.listing.unit,
            roomNumber: row.listing.roomNumber
          },
          drive: input.drive,
          oss: input.oss,
          dryRun: true
        })
        const evidence = planned[CONTENT_PLAN_EVIDENCE]
        if (!Array.isArray(evidence) ||
            evidence.length !== Number(planned.counts && planned.counts.source)) {
          throw contentPlanConfirmationError('房源笔记素材正式全局预检缺少完整行级内容计划')
        }
        inventoryPlanEvidence.push(...evidence)
      }
      assertContentPlanMatchesExpected(
        inventoryPlanEvidence,
        expectedContentPlan,
        '房源笔记素材正式全局预检与已确认内容计划不一致'
      )
    }

    for (const row of pendingClears) {
      if (input.dryRun !== true) {
        try {
          assertMediaAssetsStateUnchanged(row.listing, row.expectedStateKey, input.mediaAssetsStateKey)
          await clearNoteManagedMedia(row.listing, {
            sourceLinkFingerprint: '',
            physicalUnitFingerprint: physicalUnitFingerprint(row.listing),
            updatedAt: now
          }, {
            replaceMediaAssets: input.replaceMediaAssets,
            expectedStateKey: row.expectedStateKey
          })
        } catch (error) {
          if (!mediaAssetsStateConflict(error)) throw error
          appendStateConflict(report, row, error)
          continue
        }
      }
      report.cleared += 1
      report.rows.push({ sourceRecordId: row.sourceRecordId, status: 'cleared' })
    }

    for (const row of pendingFailures) {
      if (mediaAssetsStateConflict(row.error)) {
        appendStateConflict(report, row, row.error)
        continue
      }
      if (input.dryRun !== true) {
        try {
          assertMediaAssetsStateUnchanged(row.listing, row.expectedStateKey, input.mediaAssetsStateKey)
        } catch (error) {
          if (!mediaAssetsStateConflict(error)) throw error
          appendStateConflict(report, row, error)
          continue
        }
      }
      const currentPhysical = physicalUnitFingerprint(row.listing)
      const previous = row.listing.noteMaterialState && typeof row.listing.noteMaterialState === 'object'
        ? row.listing.noteMaterialState
        : {}
      const mayRetain = normalizeText(previous.sourceLinkFingerprint) === row.linkFingerprint &&
        normalizeText(previous.physicalUnitFingerprint) === currentPhysical &&
        Boolean(currentPhysical) &&
        temporaryNoteMaterialFailure(row.error) &&
        activeInventoryListing(row.listing) &&
        Array.isArray(row.listing.mediaAssets) && row.listing.mediaAssets.length > 0
      if (input.dryRun !== true && !mayRetain) {
        try {
          await clearNoteManagedMedia(row.listing, {
            sourceLinkFingerprint: row.linkFingerprint,
            physicalUnitFingerprint: currentPhysical,
            updatedAt: now
          }, {
            replaceMediaAssets: input.replaceMediaAssets,
            expectedStateKey: row.expectedStateKey
          })
        } catch (error) {
          if (!mediaAssetsStateConflict(error)) throw error
          appendStateConflict(report, row, error)
          continue
        }
      } else if (input.dryRun !== true && mayRetain) {
        row.listing.noteMaterialState = {
          ...previous,
          status: 'retained-temporary-failure',
          updatedAt: now
        }
      }
      if (mayRetain) report.retained += 1
      report.failed += 1
      report.rows.push({
        sourceRecordId: row.sourceRecordId,
        status: mayRetain ? 'retained-temporary-failure' : 'failed',
        error: safeFailureMessage(row.error)
      })
    }

    for (const row of resolvedRows) {
      const currentPhysical = physicalUnitFingerprint(row.listing)
      try {
        if (input.dryRun !== true) {
          assertMediaAssetsStateUnchanged(row.listing, row.expectedStateKey, input.mediaAssetsStateKey)
        }
        const result = await syncNoteMaterialVideos({
          sourceRecordId: row.sourceRecordId,
          assets: row.resolved.assets,
          existingMediaAssets: row.listing.mediaAssets,
          uploadDir: input.uploadDir,
          targetRootFolderToken: input.targetRootFolderToken,
          folderContext: {
            district: row.listing.district,
            block: row.listing.block || row.listing.area,
            locationId: row.listing.locationId,
            community: row.listing.community,
            building: row.listing.building,
            unit: row.listing.unit,
            roomNumber: row.listing.roomNumber
          },
          drive: input.drive,
          oss: input.oss,
          dryRun: input.dryRun === true,
          expectedContentPlanEvidence: expectedEvidenceForSourceRecord(
            expectedContentPlan,
            row.sourceRecordId
          ),
          verifyExisting: async (asset, target) => {
            const verifyMaterializedAsset = input.drive && (
              typeof input.drive.verifyMaterializedAsset === 'function'
                ? input.drive.verifyMaterializedAsset
                : input.drive.verifyMaterializedVideo
            )
            const verifyMaterialDeterministic = input.oss && (
              typeof input.oss.verifyMaterialDeterministic === 'function'
                ? input.oss.verifyMaterialDeterministic
                : input.oss.verifyVideoDeterministic
            )
            if (!input.drive || typeof verifyMaterializedAsset !== 'function' ||
                !input.oss || typeof verifyMaterialDeterministic !== 'function') {
              return { sourceVerified: false, driveVerified: false, ossVerified: false }
            }
            // syncNoteMaterialVideos 已在任何写入前下载并校验当前源内容；复用校验必须绑定同一份证据，
            // 避免第二次下载期间源文件再次变化，也避免同 token 原位替换继续命中旧版本。
            const sourceVerified = target.sourceEvidence &&
              normalizeText(target.sourceEvidence.contentSha256) === normalizeText(asset.contentSha256) &&
              Number(target.sourceEvidence.size) === Number(asset.size)
            if (!sourceVerified) {
              return { sourceVerified: false, driveVerified: false, ossVerified: false }
            }
            const driveEvidence = await verifyMaterializedAsset.call(input.drive, {
              ...target,
              contentSha256: asset.contentSha256,
              size: asset.size
            })
            const ossEvidence = await verifyMaterialDeterministic.call(input.oss, asset)
            return {
              sourceVerified: true,
              driveVerified: driveEvidence && driveEvidence.verified === true,
              ossVerified: ossEvidence && ossEvidence.verified === true
            }
          }
        })
        const rowContentPlanEvidence = result[CONTENT_PLAN_EVIDENCE]
        if (!Array.isArray(rowContentPlanEvidence) ||
            rowContentPlanEvidence.length !== Number(result.counts && result.counts.source)) {
          throw new Error('房源笔记内容计划证据不完整')
        }
        contentPlanEvidence.push(...rowContentPlanEvidence)
        if (input.dryRun !== true) {
          assertMediaAssetsStateUnchanged(row.listing, row.expectedStateKey, input.mediaAssetsStateKey)
          const nextAssets = result.mediaAssets.map(cloneMediaAsset)
          await replaceNoteManagedMedia(row.listing, nextAssets, {
            replaceMediaAssets: input.replaceMediaAssets,
            expectedStateKey: row.expectedStateKey,
            updatedAt: now
          })
          row.listing.noteMaterialState = {
            sourceLinkFingerprint: row.linkFingerprint,
            physicalUnitFingerprint: currentPhysical,
            digest: row.resolved.digest,
            status: 'verified',
            counts: { ...row.resolved.counts },
            updatedAt: now
          }
        }
        report.synced += 1
        report.rows.push({
          sourceRecordId: row.sourceRecordId,
          status: input.dryRun === true ? 'planned' : 'verified',
          counts: result.counts
        })
      } catch (error) {
        // 确认预检后的内容漂移是整轮安全门，不得降级为普通素材失败后清空/沿用，
        // 更不得继续处理后续行并产生部分 Drive/OSS 写入。
        if (isContentPlanConfirmationError(error)) throw error
        if (mediaAssetsStateConflict(error) ||
            (input.dryRun !== true &&
              typeof input.mediaAssetsStateKey === 'function' &&
              normalizeText(input.mediaAssetsStateKey(row.listing)) !== normalizeText(row.expectedStateKey))) {
          appendStateConflict(report, row, error)
          continue
        }
        const previous = row.listing.noteMaterialState && typeof row.listing.noteMaterialState === 'object'
          ? row.listing.noteMaterialState
          : {}
        const mayRetain = normalizeText(previous.sourceLinkFingerprint) === row.linkFingerprint &&
          normalizeText(previous.physicalUnitFingerprint) === currentPhysical &&
          Boolean(currentPhysical) &&
          temporaryNoteMaterialFailure(error) &&
          activeInventoryListing(row.listing) &&
          Array.isArray(row.listing.mediaAssets) && row.listing.mediaAssets.length > 0
        if (input.dryRun !== true && mayRetain) {
          row.listing.noteMaterialState = {
            ...previous,
            status: 'retained-temporary-failure',
            updatedAt: now
          }
        } else if (input.dryRun !== true) {
          try {
            await clearNoteManagedMedia(row.listing, {
              sourceLinkFingerprint: row.linkFingerprint,
              physicalUnitFingerprint: currentPhysical,
              updatedAt: now
            }, {
              replaceMediaAssets: input.replaceMediaAssets,
              expectedStateKey: row.expectedStateKey
            })
          } catch (clearError) {
            if (!mediaAssetsStateConflict(clearError)) throw clearError
            appendStateConflict(report, row, clearError)
            continue
          }
        }
        if (mayRetain) report.retained += 1
        report.failed += 1
        report.rows.push({
          sourceRecordId: row.sourceRecordId,
          status: mayRetain ? 'retained-temporary-failure' : 'failed',
          error: safeFailureMessage(error)
        })
      }
    }
    report.complete = report.failed === 0
    report.published = input.dryRun !== true && report.failed === 0
    if (report.complete) {
      assertContentPlanMatchesExpected(
        contentPlanEvidence,
        expectedContentPlan,
        '房源笔记素材正式响应与已确认内容计划不一致'
      )
      Object.assign(report, buildContentPlanSummary(contentPlanEvidence))
      attachContentPlanEvidence(report, contentPlanEvidence)
    }
    return report
  } finally {
    runningInventoryDatabases.delete(db)
  }
}

module.exports = {
  normalizeNoteMaterialLinkCell,
  parseNoteMaterialLink,
  resolveNoteMaterialVideos,
  stableAssetId,
  syncNoteMaterialVideos,
  assertMaterialSetEquality,
  assertIsolatedStatePaths,
  syncNoteMaterialsForInventory,
  _internal: {
    cellLink,
    videoMetadata,
    normalizeSourceAsset,
    objectKeyForAsset,
    digest,
    temporaryNoteMaterialFailure,
    buildContentPlanSummary,
    contentPlanConfirmationFromReport,
    isContentPlanConfirmationError
  }
}
