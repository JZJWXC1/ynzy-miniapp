const crypto = require('crypto')
const path = require('path')

const PLAN_VERSION = 1
const RECEIPT_VERSION = 3
const uncertainCopyErrors = new WeakSet()
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm'])
const VIDEO_EXTENSION_SUFFIX_PATTERN = /\.(?:mp4|mov|m4v|avi|webm)$/i
const PENDING_REASONS = new Set([
  '已知重复',
  '缺小区',
  '未知别名',
  '别名冲突',
  '身份冲突',
  '房源键格式异常',
  '未匹配房源',
  '房源重复'
])

function normalizeText(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim()
}

function normalizeComparable(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
}

function stableSort(values, selector = (value) => value) {
  return [...values].sort((left, right) => (
    String(selector(left)).localeCompare(String(selector(right)), 'zh-CN')
  ))
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function safeFingerprint(value, length = 12) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

function sanitizeSegment(value, label = '路径片段') {
  const normalized = normalizeText(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (!normalized) throw new Error(`${label}不能为空`)
  if (normalized === '.' || normalized === '..') throw new Error(`${label}非法`)
  return normalized.slice(0, 120)
}

function normalizeRoomPart(value, label, options = {}) {
  const text = normalizeText(value)
    .replace(/(?:幢|栋|号楼|单元|室)$/g, '')
    .replace(/\s+/g, '')
  if (!text && options.optional === true) return ''
  if (!text) throw new Error(`${label}不能为空`)
  if (!/^[0-9A-Za-z\u4e00-\u9fff-]+$/.test(text)) throw new Error(`${label}格式非法`)
  return text
}

function buildListingMaterialKey(listing = {}) {
  const building = normalizeRoomPart(listing.building, '楼栋')
  const unit = normalizeRoomPart(listing.unit, '单元', { optional: true })
  const roomNumber = normalizeRoomPart(listing.roomNumber, '房号')
  return [building, ...(unit ? [unit] : []), roomNumber]
    .map((item) => sanitizeSegment(item))
    .join('__')
}

function physicalKey(locationId, listing = {}) {
  return [
    normalizeText(locationId),
    normalizeRoomPart(listing.building, '楼栋'),
    normalizeRoomPart(listing.unit, '单元', { optional: true }),
    normalizeRoomPart(listing.roomNumber, '房号')
  ].join('\u001f')
}

function normalizeDriveItem(item = {}) {
  const token = normalizeText(item.token || item.file_token || item.folder_token)
  const name = normalizeText(item.name)
  const type = normalizeText(item.type || item.file_type).toLowerCase()
  const modifiedTime = normalizeText(
    item.modifiedTime ||
    item.modified_time ||
    item.modifiedAt ||
    item.modified_at ||
    item.updatedAt ||
    item.updated_at
  )
  if (!token) throw new Error('飞书目录清单存在缺少 token 的项目')
  if (!name) throw new Error('飞书目录清单存在缺少名称的项目')
  if (!type) throw new Error('飞书目录清单存在缺少原始类型的项目')
  return { token, name, type, modifiedTime }
}

function assertDriveInterface(drive, options = {}) {
  if (!drive || typeof drive.listFolder !== 'function') {
    throw new Error('素材复制工具缺少只读 listFolder 接口')
  }
  if (options.mutating === true) {
    if (typeof drive.createFolder !== 'function') throw new Error('素材复制工具缺少 createFolder 接口')
    if (typeof drive.copyFile !== 'function') throw new Error('素材复制工具缺少 copyFile 接口')
  }
}

async function walkFolder(drive, rootToken, options = {}) {
  assertDriveInterface(drive)
  const maxDepth = Number.isFinite(Number(options.maxDepth))
    ? Math.max(1, Math.min(32, Number(options.maxDepth)))
    : 12
  const visited = new Set()
  const entries = []

  async function visit(folderToken, parentSegments, depth) {
    if (depth > maxDepth) throw new Error(`素材目录深度超过安全上限 ${maxDepth}`)
    if (visited.has(folderToken)) throw new Error('素材目录存在循环引用')
    visited.add(folderToken)
    const children = stableSort(
      (await drive.listFolder(folderToken)).map(normalizeDriveItem),
      (item) => `${item.name}\u001f${item.type}\u001f${item.token}`
    )
    for (const child of children) {
      const segments = [...parentSegments, child.name]
      entries.push({
        token: child.token,
        name: child.name,
        type: child.type,
        modifiedTime: child.modifiedTime,
        parentToken: folderToken,
        parentSegments: [...parentSegments],
        segments
      })
      if (child.type === 'folder') await visit(child.token, segments, depth + 1)
    }
  }

  await visit(normalizeText(rootToken), [], 0)
  return entries
}

function normalizeLocation(location = {}) {
  const locationId = normalizeText(location.locationId)
  const city = normalizeText(location.city)
  const district = normalizeText(location.district)
  const block = normalizeText(location.block)
  const community = normalizeText(location.community)
  if (!locationId || !city || !district || !block || !community) {
    throw new Error('位置字典启用行必须包含位置ID、城市、行政区、板块和标准小区')
  }
  const aliases = new Set([community])
  const rawAliases = Array.isArray(location.aliases)
    ? location.aliases
    : normalizeText(location.aliases).split(/[，,、;\n]/)
  rawAliases.forEach((alias) => {
    const text = normalizeText(alias)
    if (text) aliases.add(text)
  })
  return {
    locationId,
    city,
    district,
    block,
    community,
    aliases: stableSort([...aliases], (item) => normalizeComparable(item))
  }
}

function buildLocationIndex(locations = []) {
  const byId = new Map()
  const byAlias = new Map()
  locations.forEach((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('位置字典记录必须是对象且 enabled 必须是布尔值')
    }
    if (typeof raw.enabled !== 'boolean') {
      throw new Error('位置字典 enabled 必须是布尔值')
    }
    if (raw.enabled !== true) return
    const location = normalizeLocation(raw)
    if (byId.has(location.locationId)) throw new Error(`位置ID重复：${location.locationId}`)
    byId.set(location.locationId, location)
    location.aliases.forEach((alias) => {
      const key = normalizeComparable(alias)
      if (!byAlias.has(key)) byAlias.set(key, [])
      byAlias.get(key).push({ alias, location })
    })
  })
  return {
    byId,
    aliasEntries: stableSort(
      [...byAlias.entries()].flatMap(([key, matches]) => (
        matches.map((match) => ({ ...match, key, conflict: matches.length > 1 }))
      )),
      (item) => `${String(9999 - item.key.length).padStart(4, '0')}\u001f${item.key}\u001f${item.location.locationId}`
    )
  }
}

function parseRoomRemainder(value) {
  const text = normalizeText(value)
    .replace(/^[-_\s]+/, '')
    .replace(VIDEO_EXTENSION_SUFFIX_PATTERN, '')
  const three = text.match(/^([0-9A-Za-z\u4e00-\u9fff-]+?)(?:幢|栋|号楼)?[-_]([0-9A-Za-z\u4e00-\u9fff-]+?)(?:单元)?[-_]([0-9A-Za-z\u4e00-\u9fff-]+?)(?:室)?$/)
  if (three) {
    return {
      building: normalizeRoomPart(three[1], '楼栋'),
      unit: normalizeRoomPart(three[2], '单元'),
      roomNumber: normalizeRoomPart(three[3], '房号')
    }
  }
  const two = text.match(/^([0-9A-Za-z\u4e00-\u9fff-]+?)(?:幢|栋|号楼)?[-_]([0-9A-Za-z\u4e00-\u9fff-]+?)(?:室)?$/)
  if (two) {
    return {
      building: normalizeRoomPart(two[1], '楼栋'),
      unit: '',
      roomNumber: normalizeRoomPart(two[2], '房号')
    }
  }
  return null
}

function leadingCommunityCandidate(value) {
  const text = normalizeText(value).replace(VIDEO_EXTENSION_SUFFIX_PATTERN, '')
  if (/^[-_\s]/.test(text)) return ''
  const match = text.match(/^(.+?)(?=[0-9A-Za-z]+(?:幢|栋|号楼)?[-_])/)
  return match ? normalizeText(match[1]).replace(/[-_\s]+$/g, '') : ''
}

function parseIdentityCandidate(candidate, locationIndex) {
  const text = normalizeText(candidate).replace(VIDEO_EXTENSION_SUFFIX_PATTERN, '')
  if (!text) return { ok: false, reason: '缺小区' }
  const comparable = normalizeComparable(text)
  const matchingAliases = locationIndex.aliasEntries.filter((entry) => comparable.startsWith(entry.key))
  if (matchingAliases.length) {
    const longestLength = matchingAliases[0].key.length
    const longest = matchingAliases.filter((entry) => entry.key.length === longestLength)
    const locationIds = new Set(longest.map((entry) => entry.location.locationId))
    if (locationIds.size !== 1 || longest.some((entry) => entry.conflict)) {
      return { ok: false, reason: '别名冲突' }
    }
    const selected = longest[0]
    const normalizedAlias = normalizeText(selected.alias)
    let remainder = text
    if (normalizeComparable(text.slice(0, normalizedAlias.length)) === selected.key) {
      remainder = text.slice(normalizedAlias.length)
    } else {
      const compactAliasLength = selected.key.length
      let seen = 0
      let cutAt = 0
      for (const character of text) {
        cutAt += character.length
        if (!/\s/.test(character)) seen += normalizeComparable(character).length
        if (seen >= compactAliasLength) break
      }
      remainder = text.slice(cutAt)
    }
    const room = parseRoomRemainder(remainder)
    if (!room) return { ok: false, reason: '房源键格式异常' }
    return {
      ok: true,
      location: selected.location,
      ...room,
      physicalKey: physicalKey(selected.location.locationId, room)
    }
  }
  const communityCandidate = leadingCommunityCandidate(text)
  return {
    ok: false,
    reason: communityCandidate ? '未知别名' : '缺小区'
  }
}

function parseMaterialIdentity(material, locationIndex) {
  const fileStem = path.basename(material.name, path.extname(material.name))
  const parentSegments = material.parentSegments || []
  const leafFolder = parentSegments.length ? parentSegments[parentSegments.length - 1] : ''
  const candidates = [...new Set([leafFolder, fileStem].filter(Boolean))]
  const successes = []
  let strongestFailure = { ok: false, reason: '缺小区' }
  const priority = {
    别名冲突: 5,
    房源键格式异常: 4,
    未知别名: 3,
    缺小区: 2
  }
  for (const candidate of candidates) {
    const parsed = parseIdentityCandidate(candidate, locationIndex)
    if (parsed.ok) {
      successes.push(parsed)
      continue
    }
    if ((priority[parsed.reason] || 0) > (priority[strongestFailure.reason] || 0)) {
      strongestFailure = parsed
    }
  }
  const physicalKeys = new Set(successes.map((parsed) => parsed.physicalKey))
  if (physicalKeys.size > 1) return { ok: false, reason: '身份冲突' }
  if (successes.length) return successes[0]
  return strongestFailure
}

function normalizeListing(raw, byId) {
  const sourceRecordId = normalizeText(raw.sourceRecordId)
  const locationId = normalizeText(raw.locationId)
  if (!sourceRecordId) throw new Error('启用房源缺少源记录ID')
  const location = byId.get(locationId)
  if (!location) throw new Error(`启用房源位置ID未命中字典：${locationId || '空'}`)
  const building = normalizeRoomPart(raw.building, '楼栋')
  const unit = normalizeRoomPart(raw.unit, '单元', { optional: true })
  const roomNumber = normalizeRoomPart(raw.roomNumber, '房号')
  return {
    sourceRecordId,
    locationId,
    location,
    building,
    unit,
    roomNumber,
    published: raw.published === true,
    canonical: raw.canonical === true,
    enabled: raw.enabled === true,
    materialKey: buildListingMaterialKey({ building, unit, roomNumber }),
    physicalKey: physicalKey(locationId, { building, unit, roomNumber })
  }
}

function isVideoFile(item) {
  return item.type === 'file' && VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase())
}

function pendingOperation(material, reason) {
  const extension = VIDEO_EXTENSIONS.has(path.extname(material.name).toLowerCase())
    ? path.extname(material.name).toLowerCase()
    : '.mp4'
  const fingerprint = safeFingerprint(`${material.token}\u001f${material.segments.join('\u001f')}`)
  return {
    kind: 'copy',
    bucket: 'pending',
    reason: PENDING_REASONS.has(reason) ? reason : '房源键格式异常',
    sourceToken: material.token,
    sourceFingerprint: fingerprint,
    targetSegments: [sanitizeSegment(reason), fingerprint],
    targetName: `source-${fingerprint}${extension}`
  }
}

function activeOperation(material, listing) {
  const location = listing.location
  const extension = path.extname(material.name).toLowerCase()
  return {
    kind: 'copy',
    bucket: 'active',
    reason: '唯一精确匹配',
    sourceToken: material.token,
    sourceFingerprint: safeFingerprint(`${material.token}\u001f${material.segments.join('\u001f')}`),
    targetSegments: [
      sanitizeSegment(location.city, '城市'),
      sanitizeSegment(location.district, '行政区'),
      sanitizeSegment(location.block, '板块'),
      sanitizeSegment(`${location.locationId}__${location.community}`, '位置目录'),
      sanitizeSegment(listing.materialKey, '房源键')
    ],
    targetName: sanitizeSegment(`${location.community}-${listing.materialKey}${extension}`, '目标视频名')
  }
}

function inventorySnapshot(entries = []) {
  return stableSort(entries.map((entry) => ({
    token: entry.token,
    name: entry.name,
    type: entry.type,
    modifiedTime: entry.modifiedTime,
    segments: [...entry.segments]
  })), (entry) => `${entry.segments.join('\u001f')}\u001f${entry.type}\u001f${entry.token}`)
}

function manifestSnapshot(manifest, locations, listings) {
  return {
    sourceRootToken: normalizeText(manifest.sourceRootToken),
    activeRootToken: normalizeText(manifest.activeRootToken),
    pendingRootToken: normalizeText(manifest.pendingRootToken),
    maxDepth: Number.isFinite(Number(manifest.maxDepth))
      ? Math.max(1, Math.min(32, Number(manifest.maxDepth)))
      : 12,
    locations: stableSort(locations, (item) => item.locationId).map((item) => ({
      locationId: item.locationId,
      city: item.city,
      district: item.district,
      block: item.block,
      community: item.community,
      aliases: [...item.aliases],
      enabled: true
    })),
    listings: stableSort(listings, (item) => item.sourceRecordId).map((item) => ({
      sourceRecordId: item.sourceRecordId,
      locationId: item.locationId,
      building: item.building,
      unit: item.unit,
      roomNumber: item.roomNumber,
      published: true,
      canonical: true,
      enabled: true
    }))
  }
}

function itemByRelativePath(entries = []) {
  const index = new Map()
  entries.forEach((entry) => {
    const key = entry.segments.join('\u001f')
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(entry)
  })
  return index
}

function operationDestinationKey(operation) {
  return [...operation.targetSegments, operation.targetName].join('\u001f')
}

function operationDestinationFingerprint(operation) {
  return sha256(operationDestinationKey(operation))
}

function operationReceiptIdentity(operation) {
  return {
    sourceFingerprint: normalizeText(operation.sourceFingerprint),
    destinationFingerprint: operationDestinationFingerprint(operation),
    bucket: normalizeText(operation.bucket)
  }
}

function receiptPlanBindingSha256(receipt) {
  return sha256({
    version: receipt.version,
    originalPlanSha256: receipt.originalPlanSha256,
    sourcePlanFingerprint: receipt.sourcePlanFingerprint
  })
}

function normalizeReceiptOperationIdentity(item, label = '素材续传动作') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`${label}必须是对象`)
  }
  const identity = {
    sourceFingerprint: normalizeText(item.sourceFingerprint),
    destinationFingerprint: normalizeText(item.destinationFingerprint).toLowerCase(),
    bucket: normalizeText(item.bucket)
  }
  if (Object.prototype.hasOwnProperty.call(item, 'phase')) {
    identity.phase = normalizeText(item.phase)
  }
  return identity
}

function receiptStateSha256(receipt) {
  return sha256({
    version: receipt.version,
    planBindingSha256: receipt.planBindingSha256,
    completed: receipt.completed,
    inFlight: receipt.inFlight
  })
}

function createMaterialReceipt(plan, completed = [], inFlight = null) {
  const originalPlanProof = plan.originalPlanProof || plan.resumeProof
  const receiptBase = {
    version: RECEIPT_VERSION,
    originalPlanSha256: normalizeText(plan.originalPlanSha256 || plan.planSha256).toLowerCase(),
    sourcePlanFingerprint: normalizeText(plan.sourcePlanFingerprint).toLowerCase(),
    originalPlanProof: originalPlanProof && typeof originalPlanProof === 'object'
      ? JSON.parse(JSON.stringify(originalPlanProof))
      : null,
    completed: completed.map((item) => ({
      sourceFingerprint: normalizeText(item.sourceFingerprint),
      destinationFingerprint: normalizeText(item.destinationFingerprint).toLowerCase(),
      bucket: normalizeText(item.bucket),
      targetToken: normalizeText(item.targetToken)
    })),
    inFlight: inFlight === null
      ? null
      : normalizeReceiptOperationIdentity(inFlight, '素材续传未决动作')
  }
  const receipt = {
    ...receiptBase,
    planBindingSha256: receiptPlanBindingSha256(receiptBase)
  }
  return {
    ...receipt,
    stateSha256: receiptStateSha256(receipt)
  }
}

function normalizeMaterialReceipt(rawReceipt) {
  if (!rawReceipt || typeof rawReceipt !== 'object' || Array.isArray(rawReceipt)) {
    throw new Error('素材续传状态必须是 JSON 对象')
  }
  const receipt = createMaterialReceipt({
    planSha256: rawReceipt.originalPlanSha256,
    sourcePlanFingerprint: rawReceipt.sourcePlanFingerprint,
    resumeProof: rawReceipt.originalPlanProof
  }, Array.isArray(rawReceipt.completed) ? rawReceipt.completed : [], rawReceipt.inFlight || null)
  if (rawReceipt.version !== RECEIPT_VERSION) throw new Error('素材续传状态版本不受支持')
  if (!Array.isArray(rawReceipt.completed)) throw new Error('素材续传状态 completed 必须是数组')
  if (!Object.prototype.hasOwnProperty.call(rawReceipt, 'inFlight')) {
    throw new Error('素材续传状态缺少 inFlight')
  }
  if (rawReceipt.inFlight !== null) {
    if (
      !rawReceipt.inFlight ||
      typeof rawReceipt.inFlight !== 'object' ||
      Array.isArray(rawReceipt.inFlight) ||
      Object.keys(rawReceipt.inFlight).sort().join(',') !==
        'bucket,destinationFingerprint,phase,sourceFingerprint'
    ) {
      throw new Error('素材续传状态 inFlight 结构非法')
    }
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.originalPlanSha256)) {
    throw new Error('素材续传状态 originalPlanSha256 非法')
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.sourcePlanFingerprint)) {
    throw new Error('素材续传状态 sourcePlanFingerprint 非法')
  }
  if (!receipt.originalPlanProof || Array.isArray(receipt.originalPlanProof)) {
    throw new Error('素材续传状态缺少原计划校验材料')
  }
  if (sha256(receipt.originalPlanProof) !== receipt.originalPlanSha256) {
    throw new Error('素材续传状态 originalPlanSha256 与原计划校验材料不一致')
  }
  const proofSourceFingerprint = sha256({
    version: receipt.originalPlanProof.version,
    manifest: receipt.originalPlanProof.manifest,
    sourceInventory: receipt.originalPlanProof.sourceInventory,
    operations: receipt.originalPlanProof.operations
  })
  if (proofSourceFingerprint !== receipt.sourcePlanFingerprint) {
    throw new Error('素材续传状态源计划指纹与原计划校验材料不一致')
  }
  if (
    !/^[a-f0-9]{64}$/.test(normalizeText(rawReceipt.planBindingSha256).toLowerCase()) ||
    normalizeText(rawReceipt.planBindingSha256).toLowerCase() !== receipt.planBindingSha256
  ) {
    throw new Error('素材续传状态原计划绑定校验失败')
  }
  if (
    !/^[a-f0-9]{64}$/.test(normalizeText(rawReceipt.stateSha256).toLowerCase()) ||
    normalizeText(rawReceipt.stateSha256).toLowerCase() !== receipt.stateSha256
  ) {
    throw new Error('素材续传状态完整性 SHA 校验失败')
  }
  const seenOperations = new Set()
  const seenTargetTokens = new Set()
  receipt.completed.forEach((item) => {
    if (!item.sourceFingerprint) throw new Error('素材续传完成项缺少 sourceFingerprint')
    if (!/^[a-f0-9]{64}$/.test(item.destinationFingerprint)) {
      throw new Error('素材续传完成项 destinationFingerprint 非法')
    }
    if (item.bucket !== 'active' && item.bucket !== 'pending') {
      throw new Error('素材续传完成项 bucket 非法')
    }
    if (!item.targetToken) throw new Error('素材续传完成项缺少 targetToken')
    const operationKey = [
      item.sourceFingerprint,
      item.destinationFingerprint,
      item.bucket
    ].join('\u001f')
    if (seenOperations.has(operationKey)) throw new Error('素材续传完成项重复')
    if (seenTargetTokens.has(item.targetToken)) throw new Error('素材续传目标 token 重复')
    seenOperations.add(operationKey)
    seenTargetTokens.add(item.targetToken)
  })
  if (receipt.inFlight) {
    const inFlight = receipt.inFlight
    if (!inFlight.sourceFingerprint) throw new Error('素材续传未决动作缺少 sourceFingerprint')
    if (!/^[a-f0-9]{64}$/.test(inFlight.destinationFingerprint)) {
      throw new Error('素材续传未决动作 destinationFingerprint 非法')
    }
    if (inFlight.bucket !== 'active' && inFlight.bucket !== 'pending') {
      throw new Error('素材续传未决动作 bucket 非法')
    }
    if (inFlight.phase !== 'preparing' && inFlight.phase !== 'request-uncertain') {
      throw new Error('素材续传未决动作 phase 非法')
    }
    const operationKey = [
      inFlight.sourceFingerprint,
      inFlight.destinationFingerprint,
      inFlight.bucket
    ].join('\u001f')
    if (seenOperations.has(operationKey)) {
      throw new Error('素材续传未决动作与已完成项重复')
    }
  }
  return receipt
}

function cloneMaterialReceipt(receipt) {
  return createMaterialReceipt(receipt, receipt.completed, receipt.inFlight)
}

function assertRootFoldersNotNested(rootInventories) {
  for (const parent of rootInventories) {
    for (const child of rootInventories) {
      if (parent === child) continue
      const containsChildRoot = parent.entries.some((entry) => (
        entry.type === 'folder' &&
        entry.token === child.token
      ))
      if (containsChildRoot) {
        throw new Error('源素材、在架素材和待确认根目录必须相互独立，禁止祖先或嵌套配置')
      }
    }
  }
}

function findTargetBlockers(operations, activeEntries, pendingEntries) {
  const blockers = []
  const roots = {
    active: itemByRelativePath(activeEntries),
    pending: itemByRelativePath(pendingEntries)
  }
  const planned = new Map()
  for (const operation of operations) {
    const root = roots[operation.bucket]
    const segments = []
    for (const segment of operation.targetSegments) {
      segments.push(segment)
      const matches = root.get(segments.join('\u001f')) || []
      if (matches.some((item) => item.type !== 'folder')) {
        blockers.push({
          code: 'TARGET_PATH_CONFLICT',
          bucket: operation.bucket,
          destinationFingerprint: operationDestinationFingerprint(operation)
        })
      }
      if (matches.filter((item) => item.type === 'folder').length > 1) {
        blockers.push({
          code: 'TARGET_FOLDER_DUPLICATE',
          bucket: operation.bucket,
          destinationFingerprint: operationDestinationFingerprint(operation)
        })
      }
    }
    const destination = operationDestinationKey(operation)
    const targetMatches = root.get(destination) || []
    if (targetMatches.length) {
      blockers.push({
        code: 'TARGET_CONFLICT',
        bucket: operation.bucket,
        destinationFingerprint: operationDestinationFingerprint(operation)
      })
    }
    if (planned.has(`${operation.bucket}\u001f${destination}`)) {
      blockers.push({
        code: 'PLAN_TARGET_DUPLICATE',
        bucket: operation.bucket,
        destinationFingerprint: operationDestinationFingerprint(operation)
      })
    }
    planned.set(`${operation.bucket}\u001f${destination}`, operation)
  }
  return stableSort(blockers, (item) => `${item.code}\u001f${item.bucket}\u001f${item.destinationFingerprint}`)
}

async function buildMaterialCopyPlan({ drive, manifest = {} } = {}) {
  assertDriveInterface(drive)
  const sourceRootToken = normalizeText(manifest.sourceRootToken)
  const activeRootToken = normalizeText(manifest.activeRootToken)
  const pendingRootToken = normalizeText(manifest.pendingRootToken)
  if (!sourceRootToken || !activeRootToken || !pendingRootToken) {
    throw new Error('素材计划必须提供源素材、在架素材和待确认三个根目录 token')
  }
  if (new Set([sourceRootToken, activeRootToken, pendingRootToken]).size !== 3) {
    throw new Error('源素材、在架素材和待确认根目录必须相互独立')
  }

  const locationIndex = buildLocationIndex(Array.isArray(manifest.locations) ? manifest.locations : [])
  const locations = [...locationIndex.byId.values()]
  if (!locations.length) throw new Error('位置字典没有启用记录')
  const listings = (Array.isArray(manifest.listings) ? manifest.listings : [])
    .filter((item) => (
      item &&
      item.enabled === true &&
      item.canonical === true &&
      item.published === true
    ))
    .map((item) => normalizeListing(item, locationIndex.byId))

  const maxDepth = Number.isFinite(Number(manifest.maxDepth))
    ? Math.max(1, Math.min(32, Number(manifest.maxDepth)))
    : 12
  const [sourceEntries, activeEntries, pendingEntries] = await Promise.all([
    walkFolder(drive, sourceRootToken, { maxDepth }),
    walkFolder(drive, activeRootToken, { maxDepth }),
    walkFolder(drive, pendingRootToken, { maxDepth })
  ])
  assertRootFoldersNotNested([
    { token: sourceRootToken, entries: sourceEntries },
    { token: activeRootToken, entries: activeEntries },
    { token: pendingRootToken, entries: pendingEntries }
  ])
  const materials = sourceEntries.filter(isVideoFile)
  const sourceBlockers = []
  sourceEntries.filter((item) => (
    item.type !== 'file' &&
    VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase())
  )).forEach((item) => {
    sourceBlockers.push({
      code: 'UNSUPPORTED_VIDEO_OBJECT',
      sourceFingerprint: safeFingerprint(`${item.token}\u001f${item.segments.join('\u001f')}`)
    })
  })
  materials.filter((item) => !item.modifiedTime).forEach((item) => {
    sourceBlockers.push({
      code: 'SOURCE_VERSION_MISSING',
      sourceFingerprint: safeFingerprint(`${item.token}\u001f${item.segments.join('\u001f')}`)
    })
  })
  const listingsByKey = new Map()
  listings.forEach((listing) => {
    if (!listingsByKey.has(listing.physicalKey)) listingsByKey.set(listing.physicalKey, [])
    listingsByKey.get(listing.physicalKey).push(listing)
  })

  const parsedByKey = new Map()
  const operations = []
  for (const material of materials) {
    const parsed = parseMaterialIdentity(material, locationIndex)
    if (!parsed.ok) {
      operations.push(pendingOperation(material, parsed.reason))
      continue
    }
    if (!parsedByKey.has(parsed.physicalKey)) parsedByKey.set(parsed.physicalKey, [])
    parsedByKey.get(parsed.physicalKey).push({ material, parsed })
  }

  const matchedListingKeys = new Set()
  for (const [key, matchedMaterials] of parsedByKey.entries()) {
    const matchingListings = listingsByKey.get(key) || []
    if (matchedMaterials.length > 1) {
      matchedMaterials.forEach(({ material }) => operations.push(pendingOperation(material, '已知重复')))
      continue
    }
    const { material } = matchedMaterials[0]
    if (matchingListings.length === 0) {
      operations.push(pendingOperation(material, '未匹配房源'))
      continue
    }
    if (matchingListings.length > 1) {
      operations.push(pendingOperation(material, '房源重复'))
      continue
    }
    operations.push(activeOperation(material, matchingListings[0]))
    matchedListingKeys.add(key)
  }

  const orderedOperations = stableSort(
    operations,
    (item) => `${item.bucket}\u001f${item.targetSegments.join('\u001f')}\u001f${item.targetName}\u001f${item.sourceFingerprint}`
  )
  const blockers = stableSort([
    ...sourceBlockers,
    ...findTargetBlockers(orderedOperations, activeEntries, pendingEntries)
  ], (item) => (
    `${item.code}\u001f${item.bucket || ''}\u001f${item.destinationFingerprint || item.sourceFingerprint || ''}`
  ))
  const summary = {
    sourceVideos: materials.length,
    activeCopies: orderedOperations.filter((item) => item.bucket === 'active').length,
    pendingCopies: orderedOperations.filter((item) => item.bucket === 'pending').length,
    listingsMissingMaterial: listings.filter((item) => !matchedListingKeys.has(item.physicalKey)).length,
    blockers: blockers.length,
    pendingByReason: {}
  }
  orderedOperations.filter((item) => item.bucket === 'pending').forEach((item) => {
    summary.pendingByReason[item.reason] = (summary.pendingByReason[item.reason] || 0) + 1
  })

  const normalizedManifest = manifestSnapshot(manifest, locations, listings)
  const hashInput = {
    version: PLAN_VERSION,
    manifest: normalizedManifest,
    sourceInventory: inventorySnapshot(sourceEntries),
    activeInventory: inventorySnapshot(activeEntries),
    pendingInventory: inventorySnapshot(pendingEntries),
    operations: orderedOperations,
    blockers
  }
  const planSha256 = sha256(hashInput)
  const sourcePlanFingerprint = sha256({
    version: PLAN_VERSION,
    manifest: normalizedManifest,
    sourceInventory: hashInput.sourceInventory,
    operations: orderedOperations
  })
  return {
    version: PLAN_VERSION,
    planSha256,
    sourcePlanFingerprint,
    resumeProof: hashInput,
    manifestSnapshot: normalizedManifest,
    operations: orderedOperations,
    blockers,
    summary,
    inputFingerprint: sha256({
      manifest: normalizedManifest,
      sourceInventory: hashInput.sourceInventory,
      activeInventory: hashInput.activeInventory,
      pendingInventory: hashInput.pendingInventory
    })
  }
}

function operationMatchesReceipt(operation, completed) {
  const identity = operationReceiptIdentity(operation)
  return (
    identity.sourceFingerprint === completed.sourceFingerprint &&
    identity.destinationFingerprint === completed.destinationFingerprint &&
    identity.bucket === completed.bucket
  )
}

async function buildMaterialResumePlan({
  drive,
  manifest = {},
  resumeReceipt
} = {}) {
  assertDriveInterface(drive)
  let receipt = normalizeMaterialReceipt(resumeReceipt)
  const currentPlan = await buildMaterialCopyPlan({ drive, manifest })
  if (currentPlan.sourcePlanFingerprint !== receipt.sourcePlanFingerprint) {
    throw new Error('素材续传源计划已变化，拒绝沿用旧断点')
  }
  if (receipt.completed.length > currentPlan.operations.length) {
    throw new Error('素材续传完成项超过当前计划动作数')
  }
  receipt.completed.forEach((completed, index) => {
    if (!operationMatchesReceipt(currentPlan.operations[index], completed)) {
      throw new Error('素材续传完成项不是原计划严格前缀')
    }
  })

  if (receipt.inFlight) {
    if (receipt.completed.length >= currentPlan.operations.length) {
      throw new Error('素材续传未决动作超过当前计划动作数')
    }
    if (!operationMatchesReceipt(currentPlan.operations[receipt.completed.length], receipt.inFlight)) {
      throw new Error('素材续传未决动作不是已完成前缀后的下一动作')
    }
    if (receipt.inFlight.phase !== 'request-uncertain') {
      throw new Error('素材续传准备阶段目标来源不可信，禁止自动晋升或重发')
    }
  }

  const maxDepth = currentPlan.manifestSnapshot.maxDepth
  const [activeEntries, pendingEntries] = await Promise.all([
    walkFolder(drive, currentPlan.manifestSnapshot.activeRootToken, { maxDepth }),
    walkFolder(drive, currentPlan.manifestSnapshot.pendingRootToken, { maxDepth })
  ])
  const targetIndexes = {
    active: itemByRelativePath(activeEntries),
    pending: itemByRelativePath(pendingEntries)
  }

  if (receipt.inFlight) {
    const operation = currentPlan.operations[receipt.completed.length]
    const targetIndex = targetIndexes[receipt.inFlight.bucket]
    const traversed = []
    for (const segment of operation.targetSegments) {
      traversed.push(segment)
      const matches = targetIndex.get(traversed.join('\u001f')) || []
      if (matches.some((item) => item.type !== 'folder') || matches.length > 1) {
        throw new Error('素材续传结果不确定目标路径存在非文件夹或重复目录，禁止重发')
      }
      if (matches.length === 0) {
        throw new Error('素材续传结果不确定仍不可见，禁止重发')
      }
    }
    const targetMatches = targetIndex.get(operationDestinationKey(operation)) || []
    if (targetMatches.length === 0) {
      throw new Error('素材续传结果不确定仍不可见，禁止重发')
    }
    if (targetMatches.length !== 1 || targetMatches[0].type !== 'file') {
      throw new Error('素材续传结果不确定目标不是唯一文件，禁止重发')
    }
    receipt = createMaterialReceipt(receipt, [
      ...receipt.completed,
      {
        ...operationReceiptIdentity(operation),
        targetToken: targetMatches[0].token
      }
    ], null)
  }

  const expectedConflicts = new Set(receipt.completed.map((item) => (
    `${item.bucket}\u001f${item.destinationFingerprint}`
  )))
  const actualConflicts = new Set()
  currentPlan.blockers.forEach((blocker) => {
    const key = `${normalizeText(blocker.bucket)}\u001f${normalizeText(blocker.destinationFingerprint)}`
    if (
      blocker.code !== 'TARGET_CONFLICT' ||
      !expectedConflicts.has(key) ||
      actualConflicts.has(key)
    ) {
      throw new Error('素材续传目标出现已完成项之外的额外阻断')
    }
    actualConflicts.add(key)
  })
  if (actualConflicts.size !== expectedConflicts.size) {
    throw new Error('素材续传已完成目标缺少精确 TARGET_CONFLICT 证据')
  }

  receipt.completed.forEach((completed, index) => {
    const operation = currentPlan.operations[index]
    const matches = targetIndexes[completed.bucket].get(operationDestinationKey(operation)) || []
    if (
      matches.length !== 1 ||
      matches[0].type !== 'file' ||
      matches[0].token !== completed.targetToken
    ) {
      throw new Error('素材续传已完成目标回读或 token 校验失败')
    }
  })

  const remainingOperations = currentPlan.operations.slice(receipt.completed.length)
  const summary = {
    sourceVideos: currentPlan.summary.sourceVideos,
    activeCopies: remainingOperations.filter((item) => item.bucket === 'active').length,
    pendingCopies: remainingOperations.filter((item) => item.bucket === 'pending').length,
    listingsMissingMaterial: currentPlan.summary.listingsMissingMaterial,
    blockers: 0,
    pendingByReason: {}
  }
  remainingOperations.filter((item) => item.bucket === 'pending').forEach((item) => {
    summary.pendingByReason[item.reason] = (summary.pendingByReason[item.reason] || 0) + 1
  })
  const planSha256 = sha256({
    version: PLAN_VERSION,
    mode: 'resume',
    originalPlanSha256: receipt.originalPlanSha256,
    sourcePlanFingerprint: receipt.sourcePlanFingerprint,
    completed: receipt.completed,
    inputFingerprint: currentPlan.inputFingerprint,
    operations: remainingOperations
  })
  return {
    version: PLAN_VERSION,
    mode: 'resume',
    planSha256,
    originalPlanSha256: receipt.originalPlanSha256,
    sourcePlanFingerprint: receipt.sourcePlanFingerprint,
    manifestSnapshot: currentPlan.manifestSnapshot,
    operations: remainingOperations,
    blockers: [],
    summary,
    inputFingerprint: currentPlan.inputFingerprint,
    resumeReceipt: receipt,
    completedCount: receipt.completed.length,
    totalPlanned: currentPlan.operations.length
  }
}

function toSafePlanSummary(plan = {}) {
  const summary = plan.summary || {}
  return {
    mode: 'dry-run',
    planVersion: plan.version || PLAN_VERSION,
    planSha256: normalizeText(plan.planSha256),
    inputFingerprint: normalizeText(plan.inputFingerprint),
    counts: {
      sourceVideos: Number(summary.sourceVideos || 0),
      activeCopies: Number(summary.activeCopies || 0),
      pendingCopies: Number(summary.pendingCopies || 0),
      listingsMissingMaterial: Number(summary.listingsMissingMaterial || 0),
      blockers: Number(summary.blockers || 0)
    },
    pendingByReason: Object.fromEntries(
      Object.entries(summary.pendingByReason || {})
        .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
        .map(([reason, count]) => [reason, Number(count || 0)])
    ),
    blockerCodes: [...new Set((plan.blockers || []).map((item) => item.code))].sort()
  }
}

function waitMs(durationMs) {
  if (durationMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function readbackPolicy(attempts, delayMs) {
  return {
    attempts: Number.isFinite(Number(attempts))
      ? Math.max(1, Math.min(30, Math.trunc(Number(attempts))))
      : 12,
    delayMs: Number.isFinite(Number(delayMs))
      ? Math.max(0, Math.min(5000, Math.trunc(Number(delayMs))))
      : 1000
  }
}

async function pollFolderItemsByName(drive, folderToken, name, policy) {
  const targetName = normalizeText(name)
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const matches = (await drive.listFolder(folderToken))
      .map(normalizeDriveItem)
      .filter((item) => item.name === targetName)
    if (matches.length) return matches
    if (attempt < policy.attempts) await waitMs(policy.delayMs)
  }
  return []
}

async function resolveTargetFolder(drive, rootToken, segments, policy) {
  let folderToken = rootToken
  for (const segment of segments) {
    const children = (await drive.listFolder(folderToken)).map(normalizeDriveItem)
    const sameName = children.filter((item) => item.name === segment)
    if (sameName.some((item) => item.type !== 'folder')) {
      throw new Error('目标冲突：目录位置已有同名文件')
    }
    const folders = sameName.filter((item) => item.type === 'folder')
    if (folders.length > 1) throw new Error('目标冲突：同级存在多个同名目录')
    if (folders.length === 1) {
      folderToken = folders[0].token
      continue
    }
    const created = normalizeDriveItem(await drive.createFolder(folderToken, segment))
    if (created.type !== 'folder') throw new Error('创建目录接口未返回文件夹')
    const readBack = await pollFolderItemsByName(
      drive,
      folderToken,
      segment,
      policy
    )
    if (
      readBack.length !== 1 ||
      readBack[0].type !== 'folder' ||
      readBack[0].token !== created.token
    ) {
      throw new Error('目录创建回读校验失败')
    }
    folderToken = created.token
  }
  return folderToken
}

async function executeVerifiedOperations({
  drive,
  plan,
  receipt,
  result,
  onIntent,
  onProgress,
  readbackAttempts,
  readbackDelayMs
}) {
  const roots = {
    active: plan.manifestSnapshot.activeRootToken,
    pending: plan.manifestSnapshot.pendingRootToken
  }
  const policy = readbackPolicy(readbackAttempts, readbackDelayMs)
  let currentReceipt = normalizeMaterialReceipt(receipt)
  result.receipt = cloneMaterialReceipt(currentReceipt)
  for (const operation of plan.operations) {
    currentReceipt = createMaterialReceipt(
      currentReceipt,
      currentReceipt.completed,
      {
        ...operationReceiptIdentity(operation),
        phase: 'preparing'
      }
    )
    result.receipt = cloneMaterialReceipt(currentReceipt)
    try {
      if (typeof onIntent === 'function') {
        await onIntent(cloneMaterialReceipt(currentReceipt), {
          copied: result.copied,
          readBackVerified: result.readBackVerified,
          activeCopied: result.activeCopied,
          pendingCopied: result.pendingCopied
        })
      }
      const targetFolderToken = await resolveTargetFolder(
        drive,
        roots[operation.bucket],
        operation.targetSegments,
        policy
      )
      const before = (await drive.listFolder(targetFolderToken)).map(normalizeDriveItem)
      if (before.some((item) => item.name === operation.targetName)) {
        throw new Error('目标冲突：复制前发现同名项目')
      }
      const copied = normalizeDriveItem(await drive.copyFile(
        operation.sourceToken,
        targetFolderToken,
        operation.targetName
      ))
      if (copied.type !== 'file') throw new Error('复制接口未返回文件')
      const after = await pollFolderItemsByName(
        drive,
        targetFolderToken,
        operation.targetName,
        policy
      )
      if (
        after.length !== 1 ||
        after[0].type !== 'file' ||
        after[0].token !== copied.token
      ) {
        throw new Error('复制回读校验失败')
      }
      const completed = {
        ...operationReceiptIdentity(operation),
        targetToken: after[0].token
      }
      currentReceipt = createMaterialReceipt(currentReceipt, [
        ...currentReceipt.completed,
        completed
      ], null)
      result.copied += 1
      result.readBackVerified += 1
      if (operation.bucket === 'active') result.activeCopied += 1
      else result.pendingCopied += 1
      result.receipt = cloneMaterialReceipt(currentReceipt)
      if (typeof onProgress === 'function') {
        await onProgress(cloneMaterialReceipt(currentReceipt), {
          copied: result.copied,
          readBackVerified: result.readBackVerified,
          activeCopied: result.activeCopied,
          pendingCopied: result.pendingCopied
        })
      }
    } catch (error) {
      if (
        uncertainCopyErrors.has(error) &&
        currentReceipt.inFlight &&
        currentReceipt.inFlight.phase === 'preparing'
      ) {
        currentReceipt = createMaterialReceipt(
          currentReceipt,
          currentReceipt.completed,
          {
            ...currentReceipt.inFlight,
            phase: 'request-uncertain'
          }
        )
        result.receipt = cloneMaterialReceipt(currentReceipt)
        if (typeof onIntent === 'function') {
          try {
            await onIntent(cloneMaterialReceipt(currentReceipt), {
              copied: result.copied,
              readBackVerified: result.readBackVerified,
              activeCopied: result.activeCopied,
              pendingCopied: result.pendingCopied
            })
          } catch (persistError) {
            persistError.partialResult = {
              ...result,
              receipt: cloneMaterialReceipt(currentReceipt)
            }
            throw persistError
          }
        }
      }
      error.partialResult = {
        ...result,
        receipt: cloneMaterialReceipt(currentReceipt)
      }
      throw error
    }
  }
  return result
}

async function executeMaterialCopyPlan({
  drive,
  plan,
  apply = false,
  confirmPlanSha256 = '',
  readbackAttempts,
  readbackDelayMs,
  onBeforeWrite,
  onIntent,
  onProgress
} = {}) {
  assertDriveInterface(drive, { mutating: apply === true })
  if (!plan || !normalizeText(plan.planSha256)) throw new Error('缺少可执行的素材复制计划')
  if (apply !== true) {
    return {
      dryRun: true,
      applied: false,
      planSha256: plan.planSha256,
      ...toSafePlanSummary(plan).counts
    }
  }

  const confirmed = normalizeText(confirmPlanSha256).toLowerCase()
  if (!confirmed) throw new Error('真实复制必须提供 confirm 计划 SHA-256')
  if (!/^[a-f0-9]{64}$/.test(confirmed) || confirmed !== plan.planSha256) {
    throw new Error('计划输入已变化或确认 SHA-256 不一致，拒绝执行')
  }

  const refreshed = await buildMaterialCopyPlan({
    drive,
    manifest: plan.manifestSnapshot
  })
  if (refreshed.planSha256 !== plan.planSha256) {
    const error = new Error('计划输入已变化，旧摘要失效；请重新 dry-run 并人工确认')
    error.safeSummary = toSafePlanSummary(refreshed)
    throw error
  }
  if (refreshed.blockers.length) {
    const error = new Error('素材复制计划存在目标冲突或其他阻断，未执行任何写动作')
    error.safeSummary = toSafePlanSummary(refreshed)
    throw error
  }

  const result = {
    dryRun: false,
    applied: true,
    planSha256: refreshed.planSha256,
    planned: refreshed.operations.length,
    copied: 0,
    readBackVerified: 0,
    activeCopied: 0,
    pendingCopied: 0
  }
  const receipt = createMaterialReceipt(refreshed)
  if (typeof onBeforeWrite === 'function') {
    await onBeforeWrite(cloneMaterialReceipt(receipt), {
      copied: 0,
      readBackVerified: 0,
      activeCopied: 0,
      pendingCopied: 0
    })
  }
  return executeVerifiedOperations({
    drive,
    plan: refreshed,
    receipt,
    result,
    onIntent,
    onProgress,
    readbackAttempts,
    readbackDelayMs
  })
}

async function executeMaterialResumePlan({
  drive,
  plan,
  apply = false,
  confirmPlanSha256 = '',
  readbackAttempts,
  readbackDelayMs,
  onBeforeWrite,
  onIntent,
  onProgress
} = {}) {
  assertDriveInterface(drive, { mutating: apply === true })
  if (!plan || plan.mode !== 'resume' || !normalizeText(plan.planSha256)) {
    throw new Error('缺少可执行的素材续传计划')
  }
  if (apply !== true) {
    return {
      dryRun: true,
      applied: false,
      resumed: true,
      planSha256: plan.planSha256,
      previouslyCompleted: Number(plan.completedCount || 0),
      remaining: Array.isArray(plan.operations) ? plan.operations.length : 0,
      ...toSafePlanSummary(plan).counts
    }
  }
  const confirmed = normalizeText(confirmPlanSha256).toLowerCase()
  if (!confirmed) throw new Error('真实续传必须提供 confirm 计划 SHA-256')
  if (!/^[a-f0-9]{64}$/.test(confirmed) || confirmed !== plan.planSha256) {
    throw new Error('续传计划输入已变化或确认 SHA-256 不一致，拒绝执行')
  }
  const refreshed = await buildMaterialResumePlan({
    drive,
    manifest: plan.manifestSnapshot,
    resumeReceipt: plan.resumeReceipt
  })
  if (refreshed.planSha256 !== plan.planSha256) {
    const error = new Error('续传计划输入已变化，旧摘要失效；请重新 dry-run 并人工确认')
    error.safeSummary = toSafePlanSummary(refreshed)
    throw error
  }
  const result = {
    dryRun: false,
    applied: true,
    resumed: true,
    planSha256: refreshed.planSha256,
    planned: refreshed.operations.length,
    previouslyCompleted: refreshed.completedCount,
    totalPlanned: refreshed.totalPlanned,
    copied: 0,
    readBackVerified: 0,
    activeCopied: 0,
    pendingCopied: 0
  }
  if (typeof onBeforeWrite === 'function') {
    await onBeforeWrite(cloneMaterialReceipt(refreshed.resumeReceipt), {
      copied: 0,
      readBackVerified: 0,
      activeCopied: 0,
      pendingCopied: 0
    })
  }
  return executeVerifiedOperations({
    drive,
    plan: refreshed,
    receipt: refreshed.resumeReceipt,
    result,
    onIntent,
    onProgress,
    readbackAttempts,
    readbackDelayMs
  })
}

function normalizeApiBaseUrl(value) {
  return normalizeText(value || 'https://open.feishu.cn/open-apis').replace(/\/+$/, '')
}

function safeApiError(status, body) {
  const code = body && Number.isFinite(Number(body.code)) ? Number(body.code) : 'unknown'
  const error = new Error(`飞书素材接口失败（HTTP ${Number(status) || 0}，code=${code}）`)
  error.status = Number(status) || 0
  error.apiCode = code
  return error
}

function createFeishuDriveClient(options = {}) {
  const appId = normalizeText(options.appId)
  const appSecret = normalizeText(options.appSecret)
  const fetchImpl = options.fetchImpl || global.fetch
  const baseUrl = normalizeApiBaseUrl(options.baseUrl)
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.min(120000, Number(options.timeoutMs)))
    : 30000
  const driveQps = Number.isFinite(Number(options.driveQps))
    ? Math.max(1, Math.min(4, Number(options.driveQps)))
    : 4
  const minimumDriveIntervalMs = Math.ceil(1000 / driveQps)
  const ambiguousCopyPolicy = readbackPolicy(
    options.ambiguousCopyReadbackAttempts,
    options.ambiguousCopyReadbackDelayMs
  )
  if (!appId || !appSecret) throw new Error('缺少飞书应用凭据，无法读取素材清单')
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch')
  let accessToken = ''
  let accessTokenPromise = null
  let driveQueue = Promise.resolve()
  let lastDriveRequestAt = 0

  async function requestJson(url, requestOptions = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        ...requestOptions,
        signal: controller.signal
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || (body && Number(body.code || 0) !== 0)) {
        throw safeApiError(response.status, body)
      }
      return body.data || body
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('飞书素材接口超时')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function getAccessToken() {
    if (accessToken) return accessToken
    if (!accessTokenPromise) {
      accessTokenPromise = requestJson(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret })
      }).then((data) => {
        accessToken = normalizeText(data.tenant_access_token)
        if (!accessToken) throw new Error('飞书鉴权响应缺少 tenant_access_token')
        return accessToken
      }).finally(() => {
        accessTokenPromise = null
      })
    }
    return accessTokenPromise
  }

  function scheduleDriveRequest(callback) {
    const scheduled = driveQueue.then(async () => {
      const waitFor = minimumDriveIntervalMs - (Date.now() - lastDriveRequestAt)
      if (waitFor > 0) await waitMs(waitFor)
      lastDriveRequestAt = Date.now()
      return callback()
    })
    driveQueue = scheduled.catch(() => undefined)
    return scheduled
  }

  async function driveRequest(apiPath, requestOptions = {}, lifecycle = null) {
    const allowed = (
      (requestOptions.method === 'GET' && apiPath.startsWith('/drive/v1/files?')) ||
      (requestOptions.method === 'POST' && apiPath === '/drive/v1/files/create_folder') ||
      (requestOptions.method === 'POST' && /^\/drive\/v1\/files\/[^/]+\/copy$/.test(apiPath))
    )
    if (!allowed) throw new Error('素材工具拒绝非 list/create_folder/copy 的 Drive 操作')
    const token = await getAccessToken()
    return scheduleDriveRequest(() => {
      if (lifecycle && typeof lifecycle === 'object') lifecycle.requestStarted = true
      return requestJson(`${baseUrl}${apiPath}`, {
        ...requestOptions,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
          ...(requestOptions.headers || {})
        }
      })
    })
  }

  async function listFolder(folderToken) {
    const token = normalizeText(folderToken)
    const items = []
    let pageToken = ''
    let pageCount = 0
    const seenPageTokens = new Set()
    do {
      pageCount += 1
      if (pageCount > 1000) throw new Error('飞书素材目录分页超过安全上限')
      const params = new URLSearchParams({
        folder_token: token,
        page_size: '200'
      })
      if (pageToken) params.set('page_token', pageToken)
      const data = await driveRequest(`/drive/v1/files?${params.toString()}`, { method: 'GET' })
      const pageItems = Array.isArray(data.files)
        ? data.files
        : (Array.isArray(data.items) ? data.items : null)
      if (!pageItems) throw new Error('飞书素材目录分页响应缺少 files/items 数组')
      if (typeof data.has_more !== 'boolean') {
        throw new Error('飞书素材目录分页响应 has_more 缺失或类型错误')
      }
      pageItems.forEach((item) => {
        items.push(normalizeDriveItem({
          token: item.token || item.file_token,
          name: item.name,
          type: item.type || item.file_type,
          modifiedTime: item.modified_time || item.modifiedTime || item.modified_at
        }))
      })
      const rawNextPageToken = data.next_page_token !== undefined
        ? data.next_page_token
        : data.page_token
      if (
        data.has_more &&
        (typeof rawNextPageToken !== 'string' || !normalizeText(rawNextPageToken))
      ) {
        throw new Error('飞书素材目录分页响应 next_page_token 必须是非空字符串')
      }
      pageToken = data.has_more ? normalizeText(rawNextPageToken) : ''
      if (pageToken && seenPageTokens.has(pageToken)) {
        throw new Error('飞书素材目录分页返回重复 page_token')
      }
      if (pageToken) seenPageTokens.add(pageToken)
    } while (pageToken)
    return items
  }

  async function createFolder(parentToken, name) {
    const data = await driveRequest('/drive/v1/files/create_folder', {
      method: 'POST',
      body: JSON.stringify({
        name: sanitizeSegment(name),
        folder_token: normalizeText(parentToken)
      })
    })
    return normalizeDriveItem({
      token: data.token || data.folder_token,
      name: data.name || name,
      type: 'folder'
    })
  }

  async function copyFile(sourceToken, targetFolderToken, name) {
    const encodedToken = encodeURIComponent(normalizeText(sourceToken))
    const targetName = sanitizeSegment(name)
    const lifecycle = {
      requestStarted: false,
      responseAccepted: false
    }
    try {
      const data = await driveRequest(`/drive/v1/files/${encodedToken}/copy`, {
        method: 'POST',
        body: JSON.stringify({
          name: targetName,
          type: 'file',
          folder_token: normalizeText(targetFolderToken)
        })
      }, lifecycle)
      lifecycle.responseAccepted = true
      const copied = data.file || data
      return normalizeDriveItem({
        token: copied.token || copied.file_token,
        name: copied.name || targetName,
        type: 'file'
      })
    } catch (error) {
      const status = Number(error && error.status)
      const apiCode = Number(error && error.apiCode)
      const definitiveClientFailure = (
        status >= 400 &&
        status < 500 &&
        apiCode !== 1061001
      )
      const ambiguousFailure = lifecycle.requestStarted && (
        lifecycle.responseAccepted ||
        !definitiveClientFailure
      )
      if (!ambiguousFailure) throw error
      const uncertainError = (
        error &&
        (typeof error === 'object' || typeof error === 'function')
      )
        ? error
        : new Error('飞书复制请求结果不确定')
      uncertainCopyErrors.add(uncertainError)
      try {
        for (let attempt = 1; attempt <= ambiguousCopyPolicy.attempts; attempt += 1) {
          const matches = (await listFolder(targetFolderToken))
            .filter((item) => item.name === targetName)
          if (matches.length > 1) {
            const conflictError = new Error('目标冲突：不确定复制结果出现多个同名文件或项目')
            uncertainCopyErrors.add(conflictError)
            throw conflictError
          }
          if (matches.length === 1) {
            if (matches[0].type !== 'file') {
              const conflictError = new Error('目标冲突：不确定复制结果出现同名非文件项目')
              uncertainCopyErrors.add(conflictError)
              throw conflictError
            }
            return matches[0]
          }
          if (attempt < ambiguousCopyPolicy.attempts) {
            await waitMs(ambiguousCopyPolicy.delayMs)
          }
        }
      } catch (readbackError) {
        if (uncertainCopyErrors.has(readbackError)) throw readbackError
        throw uncertainError
      }
      throw uncertainError
    }
  }

  return Object.freeze({ listFolder, createFolder, copyFile })
}

module.exports = {
  PLAN_VERSION,
  RECEIPT_VERSION,
  VIDEO_EXTENSIONS,
  buildListingMaterialKey,
  buildMaterialCopyPlan,
  buildMaterialResumePlan,
  createFeishuDriveClient,
  executeMaterialCopyPlan,
  executeMaterialResumePlan,
  sanitizeSegment,
  toSafePlanSummary
}
