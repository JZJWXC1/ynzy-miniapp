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
const CONTENT_PLAN_SCHEMA_VERSION = 'feishu-note-content-plan-v3'
const PARTIAL_CONTENT_PLAN_SCHEMA_VERSION = 'feishu-note-content-plan-v4-partial'
const CONTENT_PLAN_EVIDENCE = Symbol('contentPlanEvidence')
const DEFERRED_MATERIAL_EVIDENCE = Symbol('deferredMaterialEvidence')
const KNOWN_DEFERRED_MATERIAL_STATUSES = new Set([
  'listing-missing',
  'media-limit-exceeded',
  'unsupported-non-video',
  'retained-temporary-failure',
  'failed'
])
const CONTENT_PLAN_CONFIRMATION_CACHE_TTL_MS = 15 * 60 * 1000
const CONTENT_PLAN_CONFIRMATION_CACHE_LIMIT = 16
const contentPlanConfirmationCache = new Map()
const LEGACY_TRANSFORM_PROFILE_VERSION = 'legacy-source-passthrough-v1'
const LEGACY_TRANSFORM_PROFILE_SHA256 = sha256Text('ynzy-legacy-source-passthrough-profile-v1')
const LEGACY_TRANSFORM_TOOL_FINGERPRINT = sha256Text('ynzy-legacy-source-validator-v1')

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

function noteMaterialSourceValueFingerprint(value) {
  return digest({
    schemaVersion: 'feishu-note-source-value-v1',
    value: value === undefined ? null : canonicalJson(value)
  })
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

function strictLowercaseSha256(value, label) {
  const hash = normalizeText(value)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} SHA-256 无效`)
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
  const sourceContentSha256 = contentSha256(raw.sourceContentSha256)
  const sourceSize = Number(raw.sourceSize)
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 1) {
    throw new Error('房源笔记内容计划源素材大小无效')
  }
  const sourceMimeType = normalizeContentMimeType(raw.sourceMimeType)
  const rawMimeType = normalizeContentMimeType(raw.mimeType)
  const kind = normalizeText(raw.kind) || (rawMimeType.startsWith('image/') ? 'image' : 'video')
  if (!['video', 'image'].includes(kind)) throw new Error('房源笔记内容计划素材类型无效')
  const size = Number(raw.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('房源笔记内容计划素材大小无效')
  const displayOrder = Number(raw.displayOrder)
  if (!Number.isSafeInteger(displayOrder) || displayOrder < 0) {
    throw new Error('房源笔记内容计划展示顺序无效')
  }
  const transformProfileVersion = normalizeText(raw.transformProfileVersion)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(transformProfileVersion)) {
    throw new Error('房源笔记内容计划转换规则版本无效')
  }
  const transformProfileSha256 = strictLowercaseSha256(raw.transformProfileSha256, '房源笔记内容计划转换规则')
  const transformToolFingerprint = contentSha256(raw.transformToolFingerprint)
  const transformAction = normalizeText(raw.transformAction).toLowerCase()
  if (!['passthrough', 'sanitize', 'transcode', 'compress'].includes(transformAction)) {
    throw new Error('房源笔记内容计划转换动作无效')
  }
  return {
    sourceRecordFingerprint,
    assetId,
    kind,
    sourceContentSha256,
    sourceSize,
    sourceMimeType,
    contentSha256: contentSha256(raw.contentSha256),
    size,
    mimeType: rawMimeType,
    transformProfileVersion,
    transformProfileSha256,
    transformToolFingerprint,
    transformAction,
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

function normalizeDeferredMaterialEvidence(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const sourceRecordFingerprint = normalizeText(input.sourceRecordFingerprint).toLowerCase()
  const sourceValueFingerprint = normalizeText(input.sourceValueFingerprint).toLowerCase()
  const sourceLinkFingerprint = normalizeText(input.sourceLinkFingerprint).toLowerCase()
  const status = normalizeText(input.status)
  const deferredAction = normalizeText(input.deferredAction)
  const mediaStateFingerprint = normalizeText(input.mediaStateFingerprint).toLowerCase()
  const physicalUnitFingerprint = normalizeText(input.physicalUnitFingerprint).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sourceRecordFingerprint)) {
    throw new Error('房源笔记延期素材缺少合法源记录指纹')
  }
  if (!KNOWN_DEFERRED_MATERIAL_STATUSES.has(status)) {
    throw new Error('房源笔记延期素材状态不受信')
  }
  if (!/^[0-9a-f]{64}$/.test(sourceValueFingerprint)) {
    throw new Error('房源笔记延期素材缺少合法源值指纹')
  }
  if (sourceLinkFingerprint && !/^[0-9a-f]{64}$/.test(sourceLinkFingerprint)) {
    throw new Error('房源笔记延期素材源链接指纹无效')
  }
  if (!new Set(['none', 'retain', 'clear']).has(deferredAction)) {
    throw new Error('房源笔记延期素材本地处置动作无效')
  }
  if (deferredAction === 'none') {
    if (status !== 'listing-missing' || mediaStateFingerprint || physicalUnitFingerprint) {
      throw new Error('无房源延期素材不得绑定本地媒体处置状态')
    }
  } else if (!/^[0-9a-f]{64}$/.test(mediaStateFingerprint)) {
    throw new Error('房源笔记延期素材缺少合法媒体状态指纹')
  }
  if (physicalUnitFingerprint && !/^[0-9a-f]{64}$/.test(physicalUnitFingerprint)) {
    throw new Error('房源笔记延期素材物理房间指纹无效')
  }
  if (deferredAction === 'retain' && !physicalUnitFingerprint) {
    throw new Error('保留旧素材必须绑定非空物理房间指纹')
  }
  return {
    sourceRecordFingerprint,
    sourceValueFingerprint,
    sourceLinkFingerprint,
    status,
    deferredAction,
    mediaStateFingerprint,
    physicalUnitFingerprint
  }
}

function normalizedDeferredMaterialEvidence(values) {
  if (!Array.isArray(values)) throw new Error('房源笔记延期素材证据必须是数组')
  const evidence = values.map(normalizeDeferredMaterialEvidence)
  const fingerprints = evidence.map((item) => item.sourceRecordFingerprint)
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error('房源笔记延期素材包含重复源记录身份')
  }
  return evidence.sort((left, right) => (
    left.sourceRecordFingerprint.localeCompare(right.sourceRecordFingerprint) ||
    left.status.localeCompare(right.status)
  ))
}

function materialFailureRowIsDeferred(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const status = normalizeText(row.status)
  if (!KNOWN_DEFERRED_MATERIAL_STATUSES.has(status)) return false
  if (!normalizeText(row.sourceRecordId)) return false
  if (!/^[0-9a-f]{64}$/.test(normalizeText(row.sourceValueFingerprint).toLowerCase())) return false
  const sourceLinkFingerprint = normalizeText(row.sourceLinkFingerprint).toLowerCase()
  if (sourceLinkFingerprint && !/^[0-9a-f]{64}$/.test(sourceLinkFingerprint)) return false
  try {
    normalizeDeferredMaterialEvidence({
      sourceRecordFingerprint: sha256Text(normalizeText(row.sourceRecordId)),
      sourceValueFingerprint: row.sourceValueFingerprint,
      sourceLinkFingerprint,
      status,
      deferredAction: row.deferredAction,
      mediaStateFingerprint: row.mediaStateFingerprint,
      physicalUnitFingerprint: row.physicalUnitFingerprint
    })
  } catch (_error) {
    return false
  }
  return row.deferred === true
}

function isKnownMaterialRowWarningReport(report, options = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      report.complete !== false || report.published !== false ||
      report.externalWriteStateUnknown === true) return false
  if (Object.prototype.hasOwnProperty.call(options, 'dryRun') &&
      report.dryRun !== options.dryRun) return false
  const failed = Number(report.failed)
  if (!Number.isSafeInteger(failed) || failed <= 0 || !Array.isArray(report.rows)) return false
  const successStatuses = report.dryRun === true
    ? new Set(['planned', 'cleared'])
    : new Set(['verified', 'cleared'])
  const failureRows = report.rows.filter(materialFailureRowIsDeferred)
  const rowsKnown = report.rows.every((row) => {
    const status = normalizeText(row && row.status)
    return materialFailureRowIsDeferred(row) || successStatuses.has(status)
  })
  const reportStatus = normalizeText(report.status)
  return rowsKnown && failureRows.length === failed &&
    (!reportStatus || reportStatus === 'unsupported-non-video')
}

function deferredMaterialEvidenceFromReport(report) {
  if (!isKnownMaterialRowWarningReport(report)) {
    throw contentPlanConfirmationError('房源笔记素材失败不属于可延期的逐行告警')
  }
  return normalizedDeferredMaterialEvidence(report.rows
    .filter(materialFailureRowIsDeferred)
    .map((row) => ({
      sourceRecordFingerprint: sha256Text(normalizeText(row.sourceRecordId)),
      sourceValueFingerprint: normalizeText(row.sourceValueFingerprint).toLowerCase(),
      sourceLinkFingerprint: normalizeText(row.sourceLinkFingerprint).toLowerCase(),
      status: normalizeText(row.status),
      deferredAction: normalizeText(row.deferredAction),
      mediaStateFingerprint: normalizeText(row.mediaStateFingerprint).toLowerCase(),
      physicalUnitFingerprint: normalizeText(row.physicalUnitFingerprint).toLowerCase()
    })))
}

function buildContentPlanSummary(values, deferredValues = []) {
  const evidence = normalizedContentPlanEvidence(values)
  const deferred = normalizedDeferredMaterialEvidence(deferredValues)
  const body = deferred.length
    ? {
        schemaVersion: PARTIAL_CONTENT_PLAN_SCHEMA_VERSION,
        assetCount: evidence.length,
        assets: evidence,
        deferredCount: deferred.length,
        deferredRows: deferred
      }
    : {
        schemaVersion: CONTENT_PLAN_SCHEMA_VERSION,
        assetCount: evidence.length,
        assets: evidence
      }
  return {
    contentPlanSha256: digest(body),
    contentPlanAssetCount: evidence.length,
    contentPlanDeferredCount: deferred.length
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

function externalWriteStateUnknownError(error, stage = '') {
  const wrapped = new Error('房源笔记素材外部写入状态待核对')
  wrapped.name = 'MaterialExternalWriteStateUnknownError'
  wrapped.code = 'MATERIAL_EXTERNAL_WRITE_STATE_UNKNOWN'
  wrapped.externalWriteStateUnknown = true
  wrapped.stage = normalizeText(stage).slice(0, 48)
  if (error && error.code === 'CONTENT_PLAN_CONFIRMATION_FAILED') {
    wrapped.contentPlanConfirmationFailed = true
  }
  return wrapped
}

function isExternalWriteStateUnknownError(error) {
  return Boolean(error && (
    error.externalWriteStateUnknown === true ||
    error.code === 'MATERIAL_EXTERNAL_WRITE_STATE_UNKNOWN'
  ))
}

function expectedContentPlanFromInput(input = {}) {
  const verificationDryRun = input.dryRun === true && input.verifyExpectedContentPlan === true
  if (input.contentPlanConfirmationRequired !== true ||
      (input.dryRun === true && !verificationDryRun)) return null
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
  const deferred = normalizedDeferredMaterialEvidence(
    Array.isArray(input.expectedDeferredMaterialEvidence)
      ? input.expectedDeferredMaterialEvidence
      : []
  )
  const summary = buildContentPlanSummary(evidence, deferred)
  if (summary.contentPlanSha256 !== hash || summary.contentPlanAssetCount !== count) {
    throw contentPlanConfirmationError('房源笔记素材确认摘要与行级内容计划不一致', 400)
  }
  return {
    expectedContentPlanSha256: hash,
    expectedContentAssetCount: count,
    expectedContentPlanEvidence: evidence,
    expectedDeferredMaterialEvidence: deferred
  }
}

function assertContentPlanMatchesExpected(values, expected, message, deferredValues = []) {
  if (!expected) return
  const evidence = normalizedContentPlanEvidence(values)
  const deferred = normalizedDeferredMaterialEvidence(deferredValues)
  const summary = buildContentPlanSummary(evidence, deferred)
  if (summary.contentPlanSha256 !== expected.expectedContentPlanSha256 ||
      summary.contentPlanAssetCount !== expected.expectedContentAssetCount ||
      JSON.stringify(evidence) !== JSON.stringify(expected.expectedContentPlanEvidence) ||
      JSON.stringify(deferred) !== JSON.stringify(expected.expectedDeferredMaterialEvidence || [])) {
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

function attachContentPlanEvidence(target, values, deferredValues = []) {
  const evidence = normalizedContentPlanEvidence(values)
  const deferred = normalizedDeferredMaterialEvidence(deferredValues)
  Object.defineProperty(target, CONTENT_PLAN_EVIDENCE, {
    value: evidence,
    enumerable: false,
    configurable: false,
    writable: false
  })
  Object.defineProperty(target, DEFERRED_MATERIAL_EVIDENCE, {
    value: deferred,
    enumerable: false,
    configurable: false,
    writable: false
  })
  return target
}

function contentPlanConfirmationFromReport(report) {
  const reportAccepted = report && (
    report.complete === true || isKnownMaterialRowWarningReport(report)
  )
  if (!reportAccepted ||
      typeof report.contentPlanSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(report.contentPlanSha256) ||
      !Number.isSafeInteger(report.contentPlanAssetCount) ||
      report.contentPlanAssetCount < 0 ||
      !Array.isArray(report[CONTENT_PLAN_EVIDENCE]) ||
      !Array.isArray(report[DEFERRED_MATERIAL_EVIDENCE])) {
    throw contentPlanConfirmationError('房源笔记素材预检未生成可确认的完整内容计划')
  }
  const evidence = normalizedContentPlanEvidence(report[CONTENT_PLAN_EVIDENCE])
  const deferred = normalizedDeferredMaterialEvidence(report[DEFERRED_MATERIAL_EVIDENCE])
  const summary = buildContentPlanSummary(evidence, deferred)
  if (summary.contentPlanSha256 !== report.contentPlanSha256 ||
      summary.contentPlanAssetCount !== report.contentPlanAssetCount) {
    throw contentPlanConfirmationError('房源笔记素材预检摘要与私有行级计划不一致')
  }
  return {
    expectedContentPlanSha256: summary.contentPlanSha256,
    expectedContentAssetCount: summary.contentPlanAssetCount,
    expectedContentPlanEvidence: evidence,
    expectedDeferredMaterialEvidence: deferred
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

function cloneContentPlanConfirmation(confirmation) {
  if (!confirmation || typeof confirmation !== 'object') return null
  const evidence = normalizedContentPlanEvidence(
    Array.isArray(confirmation.expectedContentPlanEvidence)
      ? confirmation.expectedContentPlanEvidence.map((item) => ({ ...item }))
      : []
  )
  const deferred = normalizedDeferredMaterialEvidence(
    Array.isArray(confirmation.expectedDeferredMaterialEvidence)
      ? confirmation.expectedDeferredMaterialEvidence.map((item) => ({ ...item }))
      : []
  )
  const summary = buildContentPlanSummary(evidence, deferred)
  if (summary.contentPlanSha256 !== confirmation.expectedContentPlanSha256 ||
      summary.contentPlanAssetCount !== confirmation.expectedContentAssetCount) {
    throw contentPlanConfirmationError('房源笔记素材缓存确认与私有内容计划不一致')
  }
  return {
    expectedContentPlanSha256: summary.contentPlanSha256,
    expectedContentAssetCount: summary.contentPlanAssetCount,
    expectedContentPlanEvidence: evidence,
    expectedDeferredMaterialEvidence: deferred
  }
}

function contentPlanConfirmationCacheKey(hash, count) {
  return `${normalizeText(hash)}:${Number(count)}`
}

function pruneContentPlanConfirmationCache(nowMs = Date.now()) {
  for (const [key, entry] of contentPlanConfirmationCache.entries()) {
    if (!entry || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= nowMs) {
      contentPlanConfirmationCache.delete(key)
    }
  }
}

function rememberContentPlanConfirmation(report, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error('房源笔记素材确认缓存时间无效')
  }
  const confirmation = contentPlanConfirmationFromReport(report)
  pruneContentPlanConfirmationCache(nowMs)
  const key = contentPlanConfirmationCacheKey(
    confirmation.expectedContentPlanSha256,
    confirmation.expectedContentAssetCount
  )
  contentPlanConfirmationCache.delete(key)
  while (contentPlanConfirmationCache.size >= CONTENT_PLAN_CONFIRMATION_CACHE_LIMIT) {
    const oldestKey = contentPlanConfirmationCache.keys().next().value
    if (oldestKey === undefined) break
    contentPlanConfirmationCache.delete(oldestKey)
  }
  contentPlanConfirmationCache.set(key, {
    confirmation: cloneContentPlanConfirmation(confirmation),
    expiresAt: nowMs + CONTENT_PLAN_CONFIRMATION_CACHE_TTL_MS
  })
  return cloneContentPlanConfirmation(confirmation)
}

function recallContentPlanConfirmation(hash, count, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return null
  pruneContentPlanConfirmationCache(nowMs)
  const key = contentPlanConfirmationCacheKey(hash, count)
  const entry = contentPlanConfirmationCache.get(key)
  if (!entry) return null
  return cloneContentPlanConfirmation(entry.confirmation)
}

function legacyPreparedMaterial(asset, evidence) {
  const source = sourceEvidenceForAsset(asset, evidence)
  return {
    ...source,
    sourceContentSha256: source.contentSha256,
    sourceSize: source.size,
    sourceMimeType: source.contentType,
    transformProfileVersion: LEGACY_TRANSFORM_PROFILE_VERSION,
    transformProfileSha256: LEGACY_TRANSFORM_PROFILE_SHA256,
    transformToolFingerprint: LEGACY_TRANSFORM_TOOL_FINGERPRINT,
    transformAction: 'passthrough'
  }
}

function normalizedPreparedMaterial(asset, prepared) {
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
    throw new Error('房源笔记处理后素材缺少受信内容')
  }
  const sourceContentSha256 = contentSha256(prepared.sourceContentSha256)
  const sourceSize = Number(prepared.sourceSize)
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 1) throw new Error('房源笔记源素材大小凭据无效')
  const sourceMimeType = normalizeContentMimeType(prepared.sourceMimeType)
  const kind = normalizeText(prepared.kind || (asset && asset.kind)).toLowerCase()
  const declaredKind = normalizeText(asset && asset.kind).toLowerCase()
  if (!['video', 'image'].includes(kind) || (declaredKind && kind !== declaredKind)) {
    throw new Error('房源笔记处理后素材类型无效')
  }
  const extension = normalizeText(prepared.extension).toLowerCase().replace(/^\./, '')
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('房源笔记处理后素材扩展名无效')
  const contentType = normalizeContentMimeType(prepared.contentType || prepared.mimeType)
  if (kind === 'image' && imageMimeForExtension(extension) !== contentType) {
    throw new Error('房源笔记处理后图片扩展名与 MIME 不一致')
  }
  if (kind === 'video' && !videoMetadata(`material.${extension}`, contentType)) {
    throw new Error('房源笔记处理后视频扩展名与 MIME 不一致')
  }
  const expectedHash = contentSha256(prepared.contentSha256)
  const expectedSize = Number(prepared.size)
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) {
    throw new Error('房源笔记处理后素材摘要或大小无效')
  }
  if (prepared.buffer !== undefined && prepared.buffer !== null) {
    if (!Buffer.isBuffer(prepared.buffer) || !prepared.buffer.length) {
      throw new Error('房源笔记处理后素材内容无效')
    }
    const actualHash = crypto.createHash('sha256').update(prepared.buffer).digest('hex')
    if (expectedHash !== actualHash || expectedSize !== prepared.buffer.length) {
      throw new Error('房源笔记处理后素材摘要或大小无效')
    }
  }
  let transformProfileVersion
  let transformProfileSha256
  let transformToolFingerprint
  let transformAction
  try {
    transformProfileVersion = normalizeText(prepared.transformProfileVersion)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(transformProfileVersion)) {
      throw new Error('房源笔记处理规则版本无效')
    }
    transformProfileSha256 = strictLowercaseSha256(prepared.transformProfileSha256, '房源笔记处理规则')
    transformToolFingerprint = contentSha256(prepared.transformToolFingerprint)
    transformAction = normalizeText(prepared.transformAction).toLowerCase()
    if (!['passthrough', 'sanitize', 'transcode', 'compress'].includes(transformAction)) {
      throw new Error('房源笔记处理动作无效')
    }
  } catch (_error) {
    throw contentPlanConfirmationError('房源笔记素材处理器合同无效', 500)
  }
  return {
    ...prepared,
    sourceContentSha256,
    sourceSize,
    sourceMimeType,
    kind,
    extension,
    contentSha256: expectedHash,
    size: expectedSize,
    contentType,
    mimeType: contentType,
    transformProfileVersion,
    transformProfileSha256,
    transformToolFingerprint,
    transformAction
  }
}

function validatedPreparedWriteEvidence(writeEvidence, plan, requireStreamingSource) {
  if (!writeEvidence || typeof writeEvidence !== 'object' || Array.isArray(writeEvidence)) {
    throw contentPlanConfirmationError('房源笔记处理后素材缺少受信写入凭据')
  }
  const hasBuffer = Object.prototype.hasOwnProperty.call(writeEvidence, 'buffer')
  const filePath = typeof writeEvidence.filePath === 'string'
    ? writeEvidence.filePath.trim()
    : ''
  const usesPreparedFile = Boolean(filePath)
  if (requireStreamingSource === true && (!usesPreparedFile || hasBuffer)) {
    throw contentPlanConfirmationError('房源笔记处理后素材缺少纯流式文件凭据')
  }
  if (usesPreparedFile && !path.isAbsolute(filePath)) {
    throw contentPlanConfirmationError('房源笔记处理后素材文件路径无效')
  }
  if (!usesPreparedFile && !Buffer.isBuffer(writeEvidence.buffer)) {
    throw contentPlanConfirmationError('房源笔记处理后素材缺少受信读取内容')
  }

  let descriptorHash = ''
  try {
    descriptorHash = contentSha256(writeEvidence.contentSha256)
  } catch (_error) {
    throw contentPlanConfirmationError('房源笔记处理后素材写入摘要无效')
  }
  const descriptorSize = Number(writeEvidence.size)
  const descriptorMimeType = normalizeContentMimeType(
    writeEvidence.contentType || writeEvidence.mimeType
  ).split(';')[0]
  const descriptorKind = normalizeText(writeEvidence.kind).toLowerCase()
  const descriptorExtension = normalizeText(writeEvidence.extension).toLowerCase().replace(/^\./, '')
  if (!Number.isSafeInteger(descriptorSize) || descriptorSize < 1 ||
      descriptorHash !== plan.contentSha256 ||
      descriptorSize !== plan.size ||
      descriptorMimeType !== plan.mimeType ||
      descriptorKind !== plan.kind ||
      descriptorExtension !== plan.extension) {
    throw contentPlanConfirmationError('房源笔记处理后素材写入凭据与已确认内容计划不一致')
  }
  return {
    writeEvidence: usesPreparedFile
      ? { ...writeEvidence, filePath }
      : writeEvidence,
    usesPreparedFile
  }
}

function streamingSourceEvidence(input, asset) {
  if (!input.drive || typeof input.drive.downloadTokenToFile !== 'function') return null
  return {
    downloadToFile: ({ fileHandle, maxBytes, signal }) => input.drive.downloadTokenToFile(
      asset.sourceToken,
      asset.sourceKind,
      { fileHandle, maxBytes, signal }
    )
  }
}

async function downloadedSourceEvidence(input, asset) {
  const streamed = streamingSourceEvidence(input, asset)
  if (streamed) return streamed
  if (input.requireStreamingSource === true) {
    throw new Error('房源笔记素材正式同步缺少流式下载适配器')
  }
  if (!input.drive || typeof input.drive.downloadToken !== 'function') {
    throw new Error('房源笔记素材同步缺少源内容受限下载适配器')
  }
  return input.drive.downloadToken(asset.sourceToken, asset.sourceKind)
}

async function prepareMaterialForAsset(input, asset, options = {}) {
  const sourceEvidence = await downloadedSourceEvidence(input, asset)
  if (typeof input.prepareMaterial !== 'function') {
    if (!Buffer.isBuffer(sourceEvidence && sourceEvidence.buffer)) {
      throw new Error('房源笔记素材正式同步缺少标准化处理器')
    }
    return legacyPreparedMaterial(asset, sourceEvidence)
  }
  let prepared = null
  try {
    prepared = await input.prepareMaterial({
      asset,
      sourceEvidence,
      keepPreparedFile: options.keepPreparedFile === true
    })
    if (options.keepPreparedFile === true && typeof input.verifyPreparedMaterial === 'function') {
      await input.verifyPreparedMaterial(prepared)
    }
    return normalizedPreparedMaterial(asset, prepared)
  } catch (err) {
    if (prepared && typeof input.disposePreparedMaterial === 'function') {
      try {
        await input.disposePreparedMaterial(prepared)
      } catch (_cleanupErr) {
        try {
          await input.disposePreparedMaterial(prepared)
        } catch (cleanupRetryError) {
          throw cleanupRetryError
        }
      }
    }
    throw err
  }
}

async function verifyPreparedSource(input, asset, prepared, failureMessage) {
  const sourceEvidence = await downloadedSourceEvidence(input, asset)
  if (typeof input.verifySource === 'function') {
    const verified = await input.verifySource({ asset, prepared, sourceEvidence })
    if (!verified || verified.verified !== true ||
        contentSha256(verified.sourceContentSha256) !== prepared.sourceContentSha256 ||
        Number(verified.sourceSize) !== prepared.sourceSize ||
        normalizeContentMimeType(verified.sourceMimeType) !== prepared.sourceMimeType) {
      throw contentPlanConfirmationError(failureMessage)
    }
    return verified
  }
  if (!Buffer.isBuffer(sourceEvidence && sourceEvidence.buffer)) {
    throw new Error('房源笔记源素材复验缺少可读取内容')
  }
  const source = sourceEvidenceForAsset(asset, sourceEvidence)
  if (source.contentSha256 !== prepared.sourceContentSha256 ||
      source.size !== prepared.sourceSize || source.contentType !== prepared.sourceMimeType) {
    throw contentPlanConfirmationError(failureMessage)
  }
  return {
    verified: true,
    sourceContentSha256: source.contentSha256,
    sourceSize: source.size,
    sourceMimeType: source.contentType
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

function extensionForPlannedMaterial(kind, mimeType) {
  const normalizedKind = normalizeText(kind).toLowerCase()
  const normalizedMimeType = normalizeContentMimeType(mimeType)
  if (normalizedKind === 'video' && normalizedMimeType === 'video/mp4') return 'mp4'
  if (normalizedKind === 'image') {
    const extension = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp'
    }[normalizedMimeType]
    if (extension) return extension
  }
  throw contentPlanConfirmationError('房源笔记已确认内容计划的成品类型无效')
}

function confirmedPlansForAssets(input, sourceRecordId, orderedAssets) {
  const expectedEvidence = normalizedContentPlanEvidence(input.expectedContentPlanEvidence)
  const sourceRecordFingerprint = sha256Text(sourceRecordId)
  if (expectedEvidence.length !== orderedAssets.length ||
      expectedEvidence.some((item) => item.sourceRecordFingerprint !== sourceRecordFingerprint)) {
    throw contentPlanConfirmationError('房源笔记已确认内容计划与当前素材数量不一致')
  }
  return orderedAssets.map((asset, index) => {
    const expected = expectedEvidence[index]
    const assetId = stableAssetId(sourceRecordId, asset)
    const kind = normalizeText(asset.kind).toLowerCase()
    if (expected.assetId !== assetId || expected.displayOrder !== index || expected.kind !== kind) {
      throw contentPlanConfirmationError('房源笔记已确认内容计划与当前素材身份或顺序不一致')
    }
    const extension = extensionForPlannedMaterial(expected.kind, expected.mimeType)
    return {
      asset,
      assetId,
      prepared: expected,
      sourceContentSha256: expected.sourceContentSha256,
      sourceSize: expected.sourceSize,
      sourceMimeType: expected.sourceMimeType,
      kind: expected.kind,
      extension,
      mimeType: expected.mimeType,
      targetName: targetNameForAsset(assetId, extension, expected.contentSha256),
      objectKey: objectKeyForAsset(
        input.uploadDir,
        sourceRecordId,
        assetId,
        extension,
        expected.contentSha256
      ),
      contentSha256: expected.contentSha256,
      size: expected.size,
      contentType: expected.mimeType,
      transformProfileVersion: expected.transformProfileVersion,
      transformProfileSha256: expected.transformProfileSha256,
      transformToolFingerprint: expected.transformToolFingerprint,
      transformAction: expected.transformAction,
      displayOrder: index
    }
  })
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
  if (orderedAssets.length && (!input.drive || (
    typeof input.drive.downloadToken !== 'function' &&
    typeof input.drive.downloadTokenToFile !== 'function'
  ))) {
    throw new Error('房源笔记素材同步缺少源内容受限下载适配器')
  }
  const preparedMaterials = []
  let externalWriteDispatched = false
  const driveHasExactWriteDispatchEvidence = Boolean(
    input.drive && input.drive.writeDispatchEvidenceVersion === 1
  )
  const ossHasExactWriteDispatchEvidence = Boolean(
    input.oss && input.oss.writeDispatchEvidenceVersion === 1
  )
  const markExternalWriteDispatched = () => {
    externalWriteDispatched = true
  }
  const markExternalWriteVerified = () => {
    externalWriteDispatched = false
  }
  try {
  // dry-run 逐件压缩、立即清理，只留下摘要计划；正式同步直接使用人类已确认的同次计划，
  // 先全局复验源文件，真正需要写入的素材才在写前压缩一次并只保留一个临时成品。
  const useConfirmedPlan = Array.isArray(input.expectedContentPlanEvidence) &&
    (input.dryRun !== true || input.verifyExpectedContentPlan === true)
  const planned = useConfirmedPlan
    ? confirmedPlansForAssets(input, sourceRecordId, orderedAssets)
    : []
  if (!useConfirmedPlan) {
    for (let index = 0; index < orderedAssets.length; index += 1) {
      const asset = orderedAssets[index]
      const assetId = stableAssetId(sourceRecordId, asset)
      const prepared = await prepareMaterialForAsset(input, asset, { keepPreparedFile: false })
      const plannedPrepared = {
        sourceContentSha256: prepared.sourceContentSha256,
        sourceSize: prepared.sourceSize,
        sourceMimeType: prepared.sourceMimeType,
        kind: prepared.kind,
        extension: prepared.extension,
        contentSha256: prepared.contentSha256,
        size: prepared.size,
        contentType: prepared.contentType,
        mimeType: prepared.mimeType,
        transformProfileVersion: prepared.transformProfileVersion,
        transformProfileSha256: prepared.transformProfileSha256,
        transformToolFingerprint: prepared.transformToolFingerprint,
        transformAction: prepared.transformAction
      }
      planned.push({
        asset,
        assetId,
        prepared: plannedPrepared,
        sourceContentSha256: prepared.sourceContentSha256,
        sourceSize: prepared.sourceSize,
        sourceMimeType: prepared.sourceMimeType,
        kind: prepared.kind,
        extension: prepared.extension,
        mimeType: prepared.contentType,
        targetName: targetNameForAsset(assetId, prepared.extension, prepared.contentSha256),
        objectKey: objectKeyForAsset(
          input.uploadDir,
          sourceRecordId,
          assetId,
          prepared.extension,
          prepared.contentSha256
        ),
        contentSha256: prepared.contentSha256,
        size: prepared.size,
        contentType: prepared.contentType,
        transformProfileVersion: prepared.transformProfileVersion,
        transformProfileSha256: prepared.transformProfileSha256,
        transformToolFingerprint: prepared.transformToolFingerprint,
        transformAction: prepared.transformAction,
        displayOrder: index
      })
    }
  }
  let contentPlanEvidence
  try {
    contentPlanEvidence = planned.map((plan) => normalizeContentPlanEvidence({
      sourceRecordFingerprint: sha256Text(sourceRecordId),
      assetId: plan.assetId,
      kind: plan.kind,
      sourceContentSha256: plan.sourceContentSha256,
      sourceSize: plan.sourceSize,
      sourceMimeType: plan.sourceMimeType,
      contentSha256: plan.contentSha256,
      size: plan.size,
      mimeType: plan.contentType,
      transformProfileVersion: plan.transformProfileVersion,
      transformProfileSha256: plan.transformProfileSha256,
      transformToolFingerprint: plan.transformToolFingerprint,
      transformAction: plan.transformAction,
      displayOrder: plan.displayOrder
    }))
  } catch (error) {
    if (isContentPlanConfirmationError(error)) throw error
    throw contentPlanConfirmationError('房源笔记素材未形成完整内容计划', 500)
  }
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
    if (!driveHasExactWriteDispatchEvidence) externalWriteDispatched = true
    targetFolder = await input.drive.ensureListingFolder({
      parentFolderToken: input.targetRootFolderToken,
      sourceRecordId,
      ...(input.folderContext || {}),
      onWriteDispatched: markExternalWriteDispatched,
      onWriteVerified: markExternalWriteVerified
    })
    if (!targetFolder || !normalizeText(targetFolder.token)) throw new Error('房源笔记目标目录未通过回读')
    externalWriteDispatched = false
    return targetFolder
  }

  async function verifyMatchingPlannedSource(plan, failureMessage) {
    return verifyPreparedSource(input, plan.asset, plan.prepared, failureMessage)
  }

  async function releasePreparedMaterial(prepared) {
    if (!prepared || typeof input.disposePreparedMaterial !== 'function') return
    const index = preparedMaterials.indexOf(prepared)
    if (index >= 0) preparedMaterials.splice(index, 1)
    try {
      await input.disposePreparedMaterial(prepared)
    } catch (_cleanupError) {
      await input.disposePreparedMaterial(prepared)
    }
  }

  const sourceVerifications = new Map()
  // 独立调用时仍在首个写入前复验整批源文件；库存级正式同步已在所有房源之间完成同一门禁，
  // 通过 sourcesGloballyVerified 复用该结论，避免同一素材在写前无意义地重复下载。
  if (input.dryRun !== true && input.sourcesGloballyVerified !== true) {
    for (const plan of planned) {
      sourceVerifications.set(
        plan.assetId,
        await verifyMatchingPlannedSource(plan, '房源笔记源素材在同步计划执行前发生变化')
      )
    }
  }

  for (const plan of planned) {
    let sourceVerification = null
    if (input.dryRun !== true) {
      sourceVerification = input.sourcesGloballyVerified === true
        ? {
            verified: true,
            sourceContentSha256: plan.sourceContentSha256,
            sourceSize: plan.sourceSize,
            sourceMimeType: plan.sourceMimeType
          }
        : sourceVerifications.get(plan.assetId)
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
        sourceEvidence: sourceVerification,
        sourceContentSha256: plan.sourceContentSha256,
        sourceSize: plan.sourceSize,
        sourceMimeType: plan.sourceMimeType,
        outputContentSha256: plan.contentSha256,
        outputSize: plan.size,
        outputMimeType: plan.mimeType
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
    let retainedForWrite = null
    try {
      let preparedForWrite = plan.prepared
      if (typeof input.prepareMaterial === 'function') {
        preparedForWrite = await prepareMaterialForAsset(input, plan.asset, { keepPreparedFile: true })
        retainedForWrite = preparedForWrite
        preparedMaterials.push(preparedForWrite)
      } else {
        preparedForWrite = await prepareMaterialForAsset(input, plan.asset, { keepPreparedFile: false })
      }
      const outputEvidence = normalizedPreparedMaterial(plan.asset, preparedForWrite)
      if (outputEvidence.sourceContentSha256 !== plan.sourceContentSha256 ||
          outputEvidence.sourceSize !== plan.sourceSize ||
          outputEvidence.sourceMimeType !== plan.sourceMimeType ||
          outputEvidence.contentSha256 !== plan.contentSha256 ||
          outputEvidence.size !== plan.size || outputEvidence.contentType !== plan.mimeType ||
          outputEvidence.extension !== plan.extension || outputEvidence.kind !== plan.kind ||
          outputEvidence.transformProfileVersion !== plan.transformProfileVersion ||
          outputEvidence.transformProfileSha256 !== plan.transformProfileSha256 ||
          outputEvidence.transformToolFingerprint !== plan.transformToolFingerprint ||
          outputEvidence.transformAction !== plan.transformAction) {
        throw contentPlanConfirmationError('房源笔记处理后素材与已确认内容计划不一致')
      }
      let writeEvidence = outputEvidence
      if (typeof input.openPreparedFile === 'function') {
        writeEvidence = await input.openPreparedFile(preparedForWrite)
      }
      const validatedWriteEvidence = validatedPreparedWriteEvidence(
        writeEvidence,
        plan,
        input.requireStreamingSource === true
      )
      writeEvidence = validatedWriteEvidence.writeEvidence
      const usesPreparedFile = validatedWriteEvidence.usesPreparedFile
      await ensureTargetFolder()
      if (!driveHasExactWriteDispatchEvidence) externalWriteDispatched = true
      const driveResult = await materializeAsset.call(input.drive, {
        asset: plan.asset,
        targetFolderToken: targetFolder.token,
        targetName: plan.targetName,
        sourceEvidence: writeEvidence,
        onWriteDispatched: markExternalWriteDispatched,
        onWriteVerified: markExternalWriteVerified
      })
      if (!driveResult || driveResult.verified !== true ||
          !normalizeText(driveResult.contentSha256) || !normalizeText(driveResult.targetToken) ||
          normalizeText(driveResult.targetName) !== plan.targetName ||
          contentSha256(driveResult.contentSha256) !== plan.contentSha256 ||
          Number(driveResult.size) !== plan.size ||
          normalizeContentMimeType(driveResult.contentType || plan.mimeType).split(';')[0] !== plan.mimeType) {
        throw new Error('房源笔记 Drive 素材未通过内容回读')
      }
      externalWriteDispatched = false
      driveVerifiedIds.push(plan.assetId)
      const ossWriteInput = {
        kind: plan.kind,
        objectKey: plan.objectKey,
        size: plan.size,
        contentType: plan.mimeType,
        contentSha256: driveResult.contentSha256
      }
      if (usesPreparedFile) ossWriteInput.filePath = writeEvidence.filePath
      else ossWriteInput.buffer = writeEvidence.buffer
      ossWriteInput.onWriteDispatched = markExternalWriteDispatched
      ossWriteInput.onWriteVerified = markExternalWriteVerified
      if (!ossHasExactWriteDispatchEvidence) externalWriteDispatched = true
      const saved = await putMaterialDeterministic.call(input.oss, ossWriteInput)
      if (!saved || saved.verified !== true || normalizeText(saved.objectKey) !== plan.objectKey ||
          normalizeText(saved.contentSha256) !== normalizeText(driveResult.contentSha256) ||
          Number(saved.size) !== plan.size) {
        throw new Error('房源笔记 OSS 素材未通过写后回读')
      }
      externalWriteDispatched = false
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
        size: plan.size,
        verified: true
      })
      manifestIds.push(plan.assetId)
      transferred += 1
    } finally {
      await releasePreparedMaterial(retainedForWrite)
    }
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
    normalization: {
      passthrough: planned.filter((item) => item.transformAction === 'passthrough').length,
      sanitized: planned.filter((item) => item.transformAction === 'sanitize').length,
      transcoded: planned.filter((item) => item.transformAction === 'transcode').length,
      compressed: planned.filter((item) => item.transformAction === 'compress').length,
      sourceBytes: planned.reduce((total, item) => total + item.sourceSize, 0),
      outputBytes: planned.reduce((total, item) => total + item.size, 0),
      bytesSaved: planned.reduce((total, item) => total + Math.max(0, item.sourceSize - item.size), 0)
    },
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
  } catch (error) {
    if (externalWriteDispatched && !isExternalWriteStateUnknownError(error)) {
      throw externalWriteStateUnknownError(error, 'material-publish')
    }
    throw error
  } finally {
    if (typeof input.disposePreparedMaterial === 'function') {
      let cleanupError = null
      for (const prepared of preparedMaterials) {
        try {
          await input.disposePreparedMaterial(prepared)
        } catch (error) {
          try {
            await input.disposePreparedMaterial(prepared)
          } catch (cleanupRetryError) {
            if (!cleanupError) cleanupError = cleanupRetryError
          }
        }
      }
      if (cleanupError) {
        if (externalWriteDispatched) {
          throw externalWriteStateUnknownError(cleanupError, 'prepared-material-cleanup')
        }
        throw cleanupError
      }
    }
  }
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
  if ([401, 403, 408, 413, 425, 429].includes(statusCode) || (statusCode >= 500 && statusCode <= 599)) return true
  const code = normalizeText(error && error.code).toUpperCase()
  if (/^(?:MATERIAL_|FEISHU_MATERIAL_)/.test(code)) return true
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

function appendStateConflict(report, row, error, options = {}) {
  report.failed += 1
  if (options.dryRun !== true) report.externalWriteStateUnknown = true
  report.rows.push({
    sourceRecordId: normalizeText(row && row.sourceRecordId),
    status: 'state-conflict',
    deferred: false,
    sourceValueFingerprint: normalizeText(row && row.sourceValueFingerprint),
    sourceLinkFingerprint: normalizeText(row && row.linkFingerprint),
    error: safeFailureMessage(error)
  })
}

function mediaStateFingerprintForListing(listing = {}, stateKey = '') {
  const normalizedStateKey = normalizeText(stateKey)
  return digest({
    mediaAssetsStateKey: normalizedStateKey || digest(
      (Array.isArray(listing.mediaAssets) ? listing.mediaAssets : []).map(cloneMediaAsset)
    ),
    videoKey: normalizeText(listing.videoKey),
    noteMaterialState: listing.noteMaterialState && typeof listing.noteMaterialState === 'object'
      ? canonicalJson(listing.noteMaterialState)
      : null
  })
}

function hasVerifiedNoteManagedMedia(listing = {}) {
  return (Array.isArray(listing.mediaAssets) ? listing.mediaAssets : []).some((asset) => (
    asset && asset.verified === true &&
    /\/feishu-note-v1\//.test(normalizeText(asset.objectKey))
  ))
}

function deferredLocalAction(listing, linkFingerprint, expectedStateKey, error, forceClear = false) {
  if (!listing) {
    return {
      deferredAction: 'none',
      mediaStateFingerprint: '',
      physicalUnitFingerprint: ''
    }
  }
  const currentPhysical = physicalUnitFingerprint(listing)
  const previous = listing.noteMaterialState && typeof listing.noteMaterialState === 'object'
    ? listing.noteMaterialState
    : {}
  const mayRetain = !forceClear &&
    normalizeText(previous.sourceLinkFingerprint) === normalizeText(linkFingerprint) &&
    normalizeText(previous.physicalUnitFingerprint) === currentPhysical &&
    Boolean(currentPhysical) && temporaryNoteMaterialFailure(error) &&
    activeInventoryListing(listing) && hasVerifiedNoteManagedMedia(listing)
  return {
    deferredAction: mayRetain ? 'retain' : 'clear',
    mediaStateFingerprint: mediaStateFingerprintForListing(listing, expectedStateKey),
    physicalUnitFingerprint: currentPhysical
  }
}

async function syncNoteMaterialsForInventory(input = {}) {
  const db = input.db
  if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('房源笔记素材同步缺少库存数据库')
  // 正式确认字段必须在源表、工作 DB、Drive 或 OSS 的任何读取/写入之前完成形状校验。
  // dry-run 与未启用确认门的旧链路不会被扩大契约。
  const expectedContentPlan = expectedContentPlanFromInput(input)
  const expectedDeferredByFingerprint = new Map((
    expectedContentPlan && expectedContentPlan.expectedDeferredMaterialEvidence || []
  ).map((item) => [item.sourceRecordFingerprint, item]))
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
    passthrough: 0,
    sanitized: 0,
    transcoded: 0,
    compressed: 0,
    sourceBytes: 0,
    outputBytes: 0,
    bytesSaved: 0,
    rows: []
  }
  const contentPlanEvidence = []

  runningInventoryDatabases.add(db)
  try {
    const resolvedRows = []
    const pendingClears = []
    const pendingFailures = []
    const pendingDeferredActions = []
    const matchedDeferredFingerprints = new Set()
    for (const row of rows) {
      const sourceRecordId = normalizeText(row && row.sourceRecordId)
      if (!sourceRecordId) throw new Error('房源笔记素材源记录缺少 sourceRecordId')
      const sourceRecordFingerprint = sha256Text(sourceRecordId)
      const sourceValueFingerprint = noteMaterialSourceValueFingerprint(row && row.value)
      const expectedDeferred = expectedDeferredByFingerprint.get(sourceRecordFingerprint)
      if (expectedDeferred) {
        if (matchedDeferredFingerprints.has(sourceRecordFingerprint)) {
          throw contentPlanConfirmationError('房源笔记素材延期计划命中重复源记录')
        }
        if (sourceValueFingerprint !== expectedDeferred.sourceValueFingerprint) {
          throw contentPlanConfirmationError('房源笔记延期素材源值在预检与执行之间发生变化')
        }
        let currentLinkFingerprint = ''
        if (expectedDeferred.sourceLinkFingerprint) {
          let currentDeferredLink
          try {
            currentDeferredLink = parseNoteMaterialLink(row.value, { allowedHosts: input.allowedHosts })
          } catch (_error) {
            throw contentPlanConfirmationError('房源笔记延期素材源链接无法重新确认')
          }
          currentLinkFingerprint = currentDeferredLink
            ? sha256Text(currentDeferredLink.canonicalUrl)
            : ''
          if (currentLinkFingerprint !== expectedDeferred.sourceLinkFingerprint) {
            throw contentPlanConfirmationError('房源笔记延期素材源链接在预检与执行之间发生变化')
          }
        }
        const listing = sourceListing(db, sourceRecordId)
        if (expectedDeferred.deferredAction === 'none') {
          if (listing) {
            throw contentPlanConfirmationError('延期计划中的缺失房源在执行时已出现')
          }
        } else {
          if (!listing) {
            throw contentPlanConfirmationError('延期计划绑定的房源在执行时缺失')
          }
          const expectedStateKey = typeof input.mediaAssetsStateKey === 'function'
            ? input.mediaAssetsStateKey(listing)
            : ''
          if (mediaStateFingerprintForListing(listing, expectedStateKey) !==
                expectedDeferred.mediaStateFingerprint ||
              physicalUnitFingerprint(listing) !== expectedDeferred.physicalUnitFingerprint) {
            throw contentPlanConfirmationError('延期素材的房源媒体状态在预检与执行之间发生变化')
          }
          if (expectedDeferred.deferredAction === 'retain') report.retained += 1
          if (input.dryRun !== true) {
            pendingDeferredActions.push({
              listing,
              expectedStateKey,
              sourceLinkFingerprint: currentLinkFingerprint,
              ...expectedDeferred
            })
          }
        }
        matchedDeferredFingerprints.add(sourceRecordFingerprint)
        report.failed += 1
        report.rows.push({
          sourceRecordId,
          status: expectedDeferred.status,
          deferred: true,
          sourceValueFingerprint,
          sourceLinkFingerprint: currentLinkFingerprint,
          deferredAction: expectedDeferred.deferredAction,
          mediaStateFingerprint: expectedDeferred.mediaStateFingerprint,
          physicalUnitFingerprint: expectedDeferred.physicalUnitFingerprint
        })
        continue
      }
      let parsed
      let linkFingerprint = ''
      try {
        parsed = parseNoteMaterialLink(row.value, { allowedHosts: input.allowedHosts })
        linkFingerprint = parsed ? sha256Text(parsed.canonicalUrl) : ''
      } catch (error) {
        const listing = sourceListing(db, sourceRecordId)
        if (!listing) {
          report.failed += 1
          report.rows.push({
            sourceRecordId,
            status: 'listing-missing',
            deferred: true,
            sourceValueFingerprint,
            sourceLinkFingerprint: '',
            deferredAction: 'none',
            mediaStateFingerprint: '',
            physicalUnitFingerprint: ''
          })
          continue
        }
        const expectedStateKey = listing && typeof input.mediaAssetsStateKey === 'function'
          ? input.mediaAssetsStateKey(listing)
          : ''
        pendingFailures.push({
          sourceRecordId,
          sourceValueFingerprint,
          listing,
          linkFingerprint,
          expectedStateKey,
          error
        })
        continue
      }
      const listing = sourceListing(db, sourceRecordId)
      if (!listing) {
        report.failed += 1
        report.rows.push({
          sourceRecordId,
          status: 'listing-missing',
          deferred: true,
          sourceValueFingerprint,
          sourceLinkFingerprint: linkFingerprint,
          deferredAction: 'none',
          mediaStateFingerprint: '',
          physicalUnitFingerprint: ''
        })
        continue
      }
      const expectedStateKey = typeof input.mediaAssetsStateKey === 'function'
        ? input.mediaAssetsStateKey(listing)
        : ''
      if (!parsed) {
        pendingClears.push({ sourceRecordId, sourceValueFingerprint, listing, expectedStateKey })
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
        resolvedRows.push({
          sourceRecordId,
          sourceValueFingerprint,
          listing,
          resolved,
          linkFingerprint,
          expectedStateKey
        })
        report.resolved += 1
        report.video += resolved.counts.video
        report.image += resolved.counts.image
        report.unsupported += resolved.counts.unsupported
        report.nonVideo += resolved.counts.nonVideo
        report.duplicateReference += resolved.counts.duplicateReference
      } catch (error) {
        pendingFailures.push({
          sourceRecordId,
          sourceValueFingerprint,
          listing,
          linkFingerprint,
          expectedStateKey,
          error
        })
      }
    }
    if (matchedDeferredFingerprints.size !== expectedDeferredByFingerprint.size) {
      throw contentPlanConfirmationError('房源笔记素材延期计划与当前源记录集合不一致')
    }

    const overLimitRows = resolvedRows.filter((row) => row.resolved.assets.length > MAX_LISTING_MEDIA_ASSETS)
    overLimitRows.forEach((row) => pendingFailures.push({
      ...row,
      failureStatus: 'media-limit-exceeded',
      forceClear: true,
      error: new Error(`单套房源视频素材超过安全上限 ${MAX_LISTING_MEDIA_ASSETS}`),
      failureDetails: {
        mediaCount: row.resolved.assets.length,
        limit: MAX_LISTING_MEDIA_ASSETS
      }
    }))

    const withinLimitRows = resolvedRows.filter((row) => row.resolved.assets.length <= MAX_LISTING_MEDIA_ASSETS)
    const unsupportedRows = withinLimitRows.filter((row) => Number(
      row.resolved.counts.unsupported || row.resolved.counts.nonVideo || 0
    ) > 0)
    if (unsupportedRows.length) {
      report.status = 'unsupported-non-video'
      unsupportedRows.forEach((row) => pendingFailures.push({
        ...row,
        failureStatus: 'unsupported-non-video',
        forceClear: true,
        error: new Error('房源笔记包含不受支持的非图片视频素材'),
        failureDetails: {
          unsupported: Number(row.resolved.counts.unsupported || row.resolved.counts.nonVideo || 0),
          nonVideo: Number(row.resolved.counts.nonVideo || 0)
        }
      }))
    }
    const actionableResolvedRows = withinLimitRows.filter((row) => Number(
      row.resolved.counts.unsupported || row.resolved.counts.nonVideo || 0
    ) === 0)

    // 正式同步不再重复转码整批素材：先验证当前工具档案，再对全部源文件做一次流式摘要复验。
    // 只有所有房源、素材身份、顺序和源字节都与人类确认的 dry-run 计划一致，才允许任何写入；
    // 后续仅对确需上传的单件素材压缩一次并立即释放临时文件。
    if (expectedContentPlan) {
      if (typeof input.describeProfile !== 'function') {
        throw contentPlanConfirmationError('房源笔记素材正式同步缺少当前压缩规则校验器', 500)
      }
      const currentProfile = await input.describeProfile()
      const profileVersion = normalizeText(currentProfile && currentProfile.transformProfileVersion)
      const profileSha256 = normalizeText(currentProfile && currentProfile.transformProfileSha256)
      const toolFingerprint = normalizeText(currentProfile && currentProfile.transformToolFingerprint)
      if (!profileVersion || !/^[a-f0-9]{64}$/.test(profileSha256) || !/^[a-f0-9]{64}$/.test(toolFingerprint) ||
          expectedContentPlan.expectedContentPlanEvidence.some((item) => (
            item.transformProfileVersion !== profileVersion ||
            item.transformProfileSha256 !== profileSha256 ||
            item.transformToolFingerprint !== toolFingerprint
          ))) {
        throw contentPlanConfirmationError('房源笔记素材压缩规则或处理工具在确认后发生变化')
      }
      const inventoryPlanEvidence = []
      for (const row of actionableResolvedRows) {
        const evidence = expectedEvidenceForSourceRecord(expectedContentPlan, row.sourceRecordId)
        const orderedAssets = row.resolved.assets.slice().sort((left, right) => (
          Number(left.sourceOrder || 0) - Number(right.sourceOrder || 0) ||
          normalizeText(left.sourceToken).localeCompare(normalizeText(right.sourceToken))
        ))
        const plans = confirmedPlansForAssets({
          ...input,
          expectedContentPlanEvidence: evidence
        }, row.sourceRecordId, orderedAssets)
        if (input.sourcesGloballyVerified !== true) {
          for (const plan of plans) {
            await verifyPreparedSource(
              input,
              plan.asset,
              plan.prepared,
              '房源笔记源素材与已确认内容计划不一致'
            )
          }
        }
        inventoryPlanEvidence.push(...evidence)
      }
      assertContentPlanMatchesExpected(
        inventoryPlanEvidence,
        expectedContentPlan,
        '房源笔记素材正式全局预检与已确认内容计划不一致',
        expectedContentPlan.expectedDeferredMaterialEvidence
      )
    }

    for (const action of pendingDeferredActions) {
      try {
        assertMediaAssetsStateUnchanged(
          action.listing,
          action.expectedStateKey,
          input.mediaAssetsStateKey
        )
        if (mediaStateFingerprintForListing(action.listing, action.expectedStateKey) !==
              action.mediaStateFingerprint ||
            physicalUnitFingerprint(action.listing) !== action.physicalUnitFingerprint) {
          throw contentPlanConfirmationError('延期素材的房源媒体状态在本地处置前发生变化')
        }
        if (action.deferredAction === 'clear') {
          await clearNoteManagedMedia(action.listing, {
            sourceLinkFingerprint: action.sourceLinkFingerprint,
            physicalUnitFingerprint: action.physicalUnitFingerprint,
            updatedAt: now
          }, {
            replaceMediaAssets: input.replaceMediaAssets,
            expectedStateKey: action.expectedStateKey
          })
        } else {
          const previous = action.listing.noteMaterialState &&
            typeof action.listing.noteMaterialState === 'object'
            ? action.listing.noteMaterialState
            : {}
          action.listing.noteMaterialState = {
            ...previous,
            status: 'retained-temporary-failure',
            updatedAt: now
          }
        }
      } catch (error) {
        if (mediaAssetsStateConflict(error) || isContentPlanConfirmationError(error)) {
          throw externalWriteStateUnknownError(error, 'inventory-state-conflict')
        }
        throw error
      }
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
          appendStateConflict(report, row, error, { dryRun: input.dryRun === true })
          continue
        }
      }
      report.cleared += 1
      report.rows.push({ sourceRecordId: row.sourceRecordId, status: 'cleared' })
    }

    for (const row of pendingFailures) {
      if (mediaAssetsStateConflict(row.error)) {
        appendStateConflict(report, row, row.error, { dryRun: input.dryRun === true })
        continue
      }
      if (input.dryRun !== true) {
        try {
          assertMediaAssetsStateUnchanged(row.listing, row.expectedStateKey, input.mediaAssetsStateKey)
        } catch (error) {
          if (!mediaAssetsStateConflict(error)) throw error
          appendStateConflict(report, row, error, { dryRun: input.dryRun === true })
          continue
        }
      }
      const currentPhysical = physicalUnitFingerprint(row.listing)
      const previous = row.listing.noteMaterialState && typeof row.listing.noteMaterialState === 'object'
        ? row.listing.noteMaterialState
        : {}
      const deferredActionEvidence = deferredLocalAction(
        row.listing,
        row.linkFingerprint,
        row.expectedStateKey,
        row.error,
        row.forceClear === true
      )
      const mayRetain = deferredActionEvidence.deferredAction === 'retain'
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
          appendStateConflict(report, row, error, { dryRun: input.dryRun === true })
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
        status: row.failureStatus || (mayRetain ? 'retained-temporary-failure' : 'failed'),
        deferred: true,
        sourceValueFingerprint: row.sourceValueFingerprint,
        sourceLinkFingerprint: row.linkFingerprint,
        ...deferredActionEvidence,
        ...(row.failureDetails || {}),
        error: safeFailureMessage(row.error)
      })
    }

    for (const row of actionableResolvedRows) {
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
          prepareMaterial: input.prepareMaterial,
          verifyPreparedMaterial: input.verifyPreparedMaterial,
          openPreparedFile: input.openPreparedFile,
          disposePreparedMaterial: input.disposePreparedMaterial,
          verifySource: input.verifySource,
          requireStreamingSource: input.requireStreamingSource === true,
          dryRun: input.dryRun === true,
          verifyExpectedContentPlan: input.verifyExpectedContentPlan === true,
          expectedContentPlanEvidence: expectedEvidenceForSourceRecord(
            expectedContentPlan,
            row.sourceRecordId
          ),
          sourcesGloballyVerified: Boolean(expectedContentPlan),
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
            const sourceVerified = target.sourceEvidence && target.sourceEvidence.verified === true &&
              normalizeText(target.sourceEvidence.sourceContentSha256) === normalizeText(target.sourceContentSha256) &&
              Number(target.sourceEvidence.sourceSize) === Number(target.sourceSize) &&
              normalizeText(target.sourceEvidence.sourceMimeType) === normalizeText(target.sourceMimeType) &&
              normalizeText(asset.contentSha256) === normalizeText(target.outputContentSha256) &&
              Number(asset.size) === Number(target.outputSize) &&
              normalizeText(asset.mimeType) === normalizeText(target.outputMimeType)
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
        report.passthrough += Number(result.normalization && result.normalization.passthrough || 0)
        report.sanitized += Number(result.normalization && result.normalization.sanitized || 0)
        report.transcoded += Number(result.normalization && result.normalization.transcoded || 0)
        report.compressed += Number(result.normalization && result.normalization.compressed || 0)
        report.sourceBytes += Number(result.normalization && result.normalization.sourceBytes || 0)
        report.outputBytes += Number(result.normalization && result.normalization.outputBytes || 0)
        report.bytesSaved += Number(result.normalization && result.normalization.bytesSaved || 0)
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
        if (isContentPlanConfirmationError(error) || isExternalWriteStateUnknownError(error)) throw error
        if (mediaAssetsStateConflict(error) ||
            (input.dryRun !== true &&
              typeof input.mediaAssetsStateKey === 'function' &&
              normalizeText(input.mediaAssetsStateKey(row.listing)) !== normalizeText(row.expectedStateKey))) {
          appendStateConflict(report, row, error, { dryRun: input.dryRun === true })
          continue
        }
        const previous = row.listing.noteMaterialState && typeof row.listing.noteMaterialState === 'object'
          ? row.listing.noteMaterialState
          : {}
        const deferredActionEvidence = deferredLocalAction(
          row.listing,
          row.linkFingerprint,
          row.expectedStateKey,
          error
        )
        const mayRetain = deferredActionEvidence.deferredAction === 'retain'
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
            appendStateConflict(report, row, clearError, { dryRun: input.dryRun === true })
            continue
          }
        }
        if (mayRetain) report.retained += 1
        report.failed += 1
        report.rows.push({
          sourceRecordId: row.sourceRecordId,
          status: mayRetain ? 'retained-temporary-failure' : 'failed',
          deferred: true,
          sourceValueFingerprint: row.sourceValueFingerprint,
          sourceLinkFingerprint: row.linkFingerprint,
          ...deferredActionEvidence,
          error: safeFailureMessage(error)
        })
      }
    }
    report.complete = report.failed === 0
    report.published = input.dryRun !== true && report.failed === 0
    const committableWarning = isKnownMaterialRowWarningReport(report, {
      dryRun: input.dryRun === true
    })
    if (report.externalWriteStateUnknown === true) {
      throw externalWriteStateUnknownError(null, 'inventory-state-conflict')
    }
    if (expectedContentPlan && !report.complete && !committableWarning) {
      throw contentPlanConfirmationError('房源笔记素材正式响应包含不可延期失败')
    }
    if (report.complete || committableWarning) {
      const deferredMaterialEvidence = report.complete
        ? []
        : (expectedContentPlan
            ? expectedContentPlan.expectedDeferredMaterialEvidence
            : deferredMaterialEvidenceFromReport(report))
      assertContentPlanMatchesExpected(
        contentPlanEvidence,
        expectedContentPlan,
        '房源笔记素材正式响应与已确认内容计划不一致',
        deferredMaterialEvidence
      )
      Object.assign(report, buildContentPlanSummary(contentPlanEvidence, deferredMaterialEvidence))
      attachContentPlanEvidence(report, contentPlanEvidence, deferredMaterialEvidence)
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
    isKnownMaterialRowWarningReport,
    isExternalWriteStateUnknownError,
    contentPlanConfirmationFromReport,
    rememberContentPlanConfirmation,
    recallContentPlanConfirmation,
    isContentPlanConfirmationError
  }
}
