const crypto = require('crypto')
const https = require('https')
const path = require('path')
const { URL } = require('url')
const config = require('./config')

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function safeExtension(fileName, defaultExt) {
  const fallback = String(defaultExt || '.mp4').toLowerCase()
  const candidate = path.extname(fileName || '').toLowerCase()
  const allowed = fallback === '.jpg'
    ? new Set(['.jpg', '.jpeg', '.png', '.webp'])
    : new Set(['.mp4', '.mov', '.m4v', '.webm'])
  return allowed.has(candidate) ? candidate : fallback
}

function createObjectKey(fileName, uploadDir, defaultExt) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`
  // 对象键只保留服务端时间随机串和白名单扩展名；客户端原文件名可能含手机号、房号或姓名，
  // 不能进入公开封面/视频签名 URL 的路径。
  return `${uploadDir || config.oss.uploadDir}/${y}${m}${d}/${stamp}${safeExtension(fileName, defaultExt)}`
}

function ossHost() {
  if (!config.oss.bucket || !config.oss.region) return ''
  return `https://${config.oss.bucket}.${config.oss.region}.aliyuncs.com`
}

function publicFileUrl(objectKey) {
  if (config.oss.publicBaseUrl) {
    return `${trimSlash(config.oss.publicBaseUrl)}/${objectKey}`
  }
  if (ossHost()) {
    return `${ossHost()}/${objectKey}`
  }
  return `${trimSlash(config.oss.homeUrl)}/${objectKey}`
}

function encodeObjectPath(objectKey) {
  return String(objectKey || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function signOssString(text) {
  return crypto.createHmac('sha1', config.oss.accessKeySecret).update(text).digest('base64')
}

function canonicalizedResource(objectKey, subresources = {}) {
  const resourcePath = `/${config.oss.bucket}/${objectKey}`
  const query = Object.keys(subresources)
    .filter((key) => subresources[key] !== undefined && subresources[key] !== null && subresources[key] !== '')
    .sort()
    .map((key) => `${key}=${subresources[key]}`)
    .join('&')
  return query ? `${resourcePath}?${query}` : resourcePath
}

function canonicalizedOssHeaders(headers = {}) {
  return Object.keys(headers)
    .filter((key) => /^x-oss-/i.test(key))
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map((key) => `${key.toLowerCase()}:${String(headers[key]).trim()}\n`)
    .join('')
}

function stsSubresources(subresources = {}) {
  if (!config.oss.securityToken) return { ...subresources }
  return {
    ...subresources,
    'security-token': config.oss.securityToken
  }
}

function sanitizeOssErrorText(value) {
  let text = String(value || '')
  const configuredToken = String(config.oss.securityToken || '')
  if (configuredToken) text = text.split(configuredToken).join('[STS_TOKEN_REDACTED]')
  return text
    .replace(/(x-oss-security-token\s*[:=]\s*)[^\s<&"']+/ig, '$1[STS_TOKEN_REDACTED]')
    .replace(/(security-token\s*=\s*)[^&\s<"']+/ig, '$1[STS_TOKEN_REDACTED]')
}

function missingConfigKeys() {
  const missing = []
  if (!config.oss.bucket) missing.push('ALI_OSS_BUCKET')
  if (!config.oss.region) missing.push('ALI_OSS_REGION')
  if (!config.oss.accessKeyId) missing.push('ALI_OSS_ACCESS_KEY_ID')
  if (!config.oss.accessKeySecret) missing.push('ALI_OSS_ACCESS_KEY_SECRET')
  return missing
}

function createSignedReadUrl(objectKey, expiresInSeconds, method) {
  if (!objectKey || missingConfigKeys().length) {
    return objectKey ? publicFileUrl(objectKey) : ''
  }

  const expires = Math.floor(Date.now() / 1000) + (expiresInSeconds || config.oss.readUrlExpireSeconds)
  // STS token 不只是 URL 参数，也是 OSS V1 CanonicalizedResource 的 subresource。
  // 仅拼到 URL 而不参与签名会被私有桶判为 SignatureDoesNotMatch。
  const resourcePath = canonicalizedResource(objectKey, stsSubresources())
  const readMethod = String(method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET'
  const stringToSign = [readMethod, '', '', String(expires), resourcePath].join('\n')
  const params = {
    OSSAccessKeyId: config.oss.accessKeyId,
    Expires: String(expires),
    Signature: signOssString(stringToSign)
  }

  if (config.oss.securityToken) {
    params['security-token'] = config.oss.securityToken
  }

  const query = Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&')

  return `${ossHost()}/${encodeObjectPath(objectKey)}?${query}`
}

// 视频首帧封面：阿里云 OSS 私有桶对视频对象用 x-oss-process=video/snapshot 实时截帧成 JPG。
// 私有桶必须把 x-oss-process 作为 subresource 一并纳入 V1 签名的 CanonicalizedResource，否则
// 返回 SignatureDoesNotMatch。t_0=首帧、m_fast=取最近关键帧（更快、更省）、w_640 控制列表缩略图大小。
// 固定时间点截帧是 OSS 原生能力，无需开通 IMM（智能选封面等高级能力才要）——2026-07-10 生产实测：
// 真实 videoKey 经本签名 URL 返回 200 + image/jpeg 真图。个别编码不支持时取图失败，前端退占位图兜底。
const VIDEO_SNAPSHOT_PROCESS = 'video/snapshot,t_0,f_jpg,w_640,h_0,m_fast'

function createVideoSnapshotUrl(objectKey, expiresInSeconds, method) {
  if (!objectKey || missingConfigKeys().length || !looksLikeVideoPath(objectKey)) return ''

  const expires = Math.floor(Date.now() / 1000) + (expiresInSeconds || config.oss.readUrlExpireSeconds)
  // subresource 必须按名称排序后以字面值进入签名；STS 下顺序为 security-token、x-oss-process。
  const resourcePath = canonicalizedResource(objectKey, stsSubresources({
    'x-oss-process': VIDEO_SNAPSHOT_PROCESS
  }))
  const readMethod = String(method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET'
  const stringToSign = [readMethod, '', '', String(expires), resourcePath].join('\n')
  const signature = signOssString(stringToSign)

  // x-oss-process 的值只含 /、,、_ 与字母数字，都是 query 合法字符，保持字面以匹配签名串。
  const parts = [
    `x-oss-process=${VIDEO_SNAPSHOT_PROCESS}`,
    `OSSAccessKeyId=${encodeURIComponent(config.oss.accessKeyId)}`,
    `Expires=${expires}`,
    `Signature=${encodeURIComponent(signature)}`
  ]
  if (config.oss.securityToken) {
    parts.push(`security-token=${encodeURIComponent(config.oss.securityToken)}`)
  }
  return `${ossHost()}/${encodeObjectPath(objectKey)}?${parts.join('&')}`
}

// 判断对象键是否是可截帧的视频（与 domain.looksLikeVideoPath 同口径：含 #/? 结尾兜底）。
function looksLikeVideoPath(value) {
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(String(value || '').trim())
}

function hasReadConfig() {
  return missingConfigKeys().length === 0
}

function readSourceOrigins() {
  return [ossHost(), config.oss.publicBaseUrl, config.oss.homeUrl]
    .map((value) => {
      try {
        return new URL(String(value || '')).origin
      } catch (error) {
        return ''
      }
    })
    .filter(Boolean)
}

function putObjectBuffer(objectKey, buffer, contentType, options = {}) {
  const missing = missingConfigKeys()
  if (missing.length) {
    const error = new Error(`OSS 配置缺少 ${missing.join('、')}，无法保存飞书素材`)
    error.statusCode = 503
    throw error
  }

  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  const type = contentType || 'application/octet-stream'
  const date = new Date().toUTCString()
  const resourcePath = `/${config.oss.bucket}/${objectKey}`
  const headers = {
    Date: date,
    'Content-Type': type,
    'Content-Length': body.length
  }
  const metadata = options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
    ? options.metadata
    : {}
  Object.keys(metadata).sort().forEach((key) => {
    const normalizedKey = String(key || '').trim().toLowerCase()
    const value = String(metadata[key] || '').trim()
    if (!/^x-oss-meta-[a-z0-9-]+$/.test(normalizedKey) || !value || /[\r\n]/.test(value)) {
      throw new Error('OSS 自定义元数据无效')
    }
    headers[normalizedKey] = value
  })
  if (config.oss.securityToken) {
    headers['x-oss-security-token'] = config.oss.securityToken
  }
  const stringToSign = [
    'PUT',
    '',
    type,
    date,
    `${canonicalizedOssHeaders(headers)}${resourcePath}`
  ].join('\n')
  const signature = signOssString(stringToSign)
  headers.Authorization = `OSS ${config.oss.accessKeyId}:${signature}`
  const encodedPath = `/${encodeObjectPath(objectKey)}`

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'PUT',
      hostname: `${config.oss.bucket}.${config.oss.region}.aliyuncs.com`,
      path: encodedPath,
      headers
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ objectKey, fileUrl: publicFileUrl(objectKey), statusCode: res.statusCode })
          return
        }
        const error = new Error(sanitizeOssErrorText(raw) || `OSS 上传失败：${res.statusCode}`)
        error.statusCode = res.statusCode || 502
        reject(error)
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

function readObjectBufferAuthenticated(objectKey, maxBytes) {
  const missing = missingConfigKeys()
  if (missing.length) {
    const error = new Error(`OSS 配置缺少 ${missing.join('、')}，无法回读素材`)
    error.statusCode = 503
    throw error
  }
  const safeMaxBytes = Number(maxBytes || config.oss.maxVideoSize)
  if (!Number.isSafeInteger(safeMaxBytes) || safeMaxBytes < 1) throw new Error('OSS 回读大小上限无效')
  const date = new Date().toUTCString()
  const resourcePath = `/${config.oss.bucket}/${objectKey}`
  const headers = { Date: date }
  if (config.oss.securityToken) headers['x-oss-security-token'] = config.oss.securityToken
  const stringToSign = [
    'GET',
    '',
    '',
    date,
    `${canonicalizedOssHeaders(headers)}${resourcePath}`
  ].join('\n')
  headers.Authorization = `OSS ${config.oss.accessKeyId}:${signOssString(stringToSign)}`
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      hostname: `${config.oss.bucket}.${config.oss.region}.aliyuncs.com`,
      path: `/${encodeObjectPath(objectKey)}`,
      headers
    }, (res) => {
      const declaredLength = Number(res.headers && res.headers['content-length'])
      if (Number.isFinite(declaredLength) && declaredLength > safeMaxBytes) {
        res.resume()
        const error = new Error('OSS 回读素材超过允许大小')
        error.statusCode = 413
        reject(error)
        return
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > safeMaxBytes) {
          req.destroy()
          const error = new Error('OSS 回读素材超过允许大小')
          error.statusCode = 413
          reject(error)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`OSS 回读素材失败：${res.statusCode}`)
          error.statusCode = res.statusCode || 502
          reject(error)
          return
        }
        const buffer = Buffer.concat(chunks, size)
        resolve({
          buffer,
          size,
          contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
          metadataSha256: String(res.headers && res.headers['x-oss-meta-content-sha256'] || '').trim()
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function validateDeterministicVideoInput(input = {}) {
  const objectKey = String(input.objectKey || '').trim()
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : (input.buffer == null ? null : Buffer.from(input.buffer))
  const contentSha256 = String(input.contentSha256 || '').trim().toLowerCase()
  if (!objectKey || !/\/feishu-note-v1\/.+\.(?:mp4|mov|m4v|webm)$/i.test(objectKey) ||
      objectKey.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\\?#\0\r\n]/.test(objectKey)) {
    throw new Error('房源笔记 OSS 对象键无效')
  }
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) throw new Error('房源笔记内容哈希无效')
  if (buffer && (!buffer.length || buffer.length > config.oss.maxVideoSize)) {
    throw new Error('房源笔记视频大小无效')
  }
  if (buffer && crypto.createHash('sha256').update(buffer).digest('hex') !== contentSha256) {
    throw new Error('房源笔记上传内容与声明哈希不一致')
  }
  return { objectKey, buffer, contentSha256 }
}

async function verifyVideoDeterministic(asset = {}) {
  const normalized = validateDeterministicVideoInput({
    objectKey: asset.objectKey,
    contentSha256: asset.contentSha256
  })
  const readback = await readObjectBufferAuthenticated(normalized.objectKey, config.oss.maxVideoSize)
  return {
    objectKey: normalized.objectKey,
    contentSha256: readback.contentSha256,
    size: readback.size,
    verified: readback.contentSha256 === normalized.contentSha256 &&
      (!readback.metadataSha256 || readback.metadataSha256 === normalized.contentSha256) &&
      (!Number(asset.size) || readback.size === Number(asset.size))
  }
}

async function putVideoDeterministic(input = {}) {
  const normalized = validateDeterministicVideoInput(input)
  await putObjectBuffer(
    normalized.objectKey,
    normalized.buffer,
    input.contentType || 'video/mp4',
    { metadata: { 'x-oss-meta-content-sha256': normalized.contentSha256 } }
  )
  const verified = await verifyVideoDeterministic({
    objectKey: normalized.objectKey,
    contentSha256: normalized.contentSha256,
    size: normalized.buffer.length
  })
  if (verified.verified !== true) throw new Error('房源笔记 OSS 写后 GET 内容哈希回读不一致')
  return verified
}

function createVideoUploadPolicy(input = {}) {
  const objectKey = input.objectKey || createObjectKey(input.fileName || 'listing-video.mp4')
  const mimeType = input.mimeType || 'video/mp4'
  const fileUrl = publicFileUrl(objectKey)
  const missing = missingConfigKeys()

  if (missing.length) {
    return {
      uploadMode: 'oss-config-missing',
      uploadUrl: '',
      objectKey,
      fileUrl,
      maxSize: config.oss.maxVideoSize,
      missing,
      formData: {},
      note: `已使用你提供的 OSS 地址生成视频路径，但还缺少 ${missing.join('、')}，暂不能真实直传。`
    }
  }

  const host = ossHost()
  const expiration = new Date(Date.now() + config.oss.policyExpireSeconds * 1000).toISOString()
  const policy = {
    expiration,
    conditions: [
      ['content-length-range', 1, config.oss.maxVideoSize],
      // 每张策略只允许上传到这一条服务端生成的 key；目录前缀条件会允许客户端改成同目录
      // 任意已知对象并覆盖他人文件。
      { key: objectKey },
      ['starts-with', '$Content-Type', 'video/'],
      { bucket: config.oss.bucket },
      { success_action_status: '200' }
    ]
  }
  const policyText = Buffer.from(JSON.stringify(policy)).toString('base64')
  const signature = signOssString(policyText)
  const formData = {
    key: objectKey,
    policy: policyText,
    OSSAccessKeyId: config.oss.accessKeyId,
    signature,
    success_action_status: '200',
    'Content-Type': mimeType
  }

  if (config.oss.securityToken) {
    formData['x-oss-security-token'] = config.oss.securityToken
  }

  return {
    uploadMode: 'oss-post',
    uploadUrl: host,
    objectKey,
    fileUrl,
    maxSize: config.oss.maxVideoSize,
    expiresAt: expiration,
    formData,
    note: '请使用 wx.uploadFile 直传 OSS，成功后把 fileUrl 和 objectKey 写入房源。'
  }
}

function createImageUploadPolicy(input = {}, options = {}) {
  const uploadDir = options.uploadDir || 'images'
  const defaultName = options.defaultName || 'image.jpg'
  const note = options.note || '请使用 wx.uploadFile 直传 OSS，成功后把 fileUrl 和 objectKey 写入记录。'
  const missingNote = options.missingNote || '已生成图片路径，但 OSS 配置不完整，暂不能真实直传。'
  const objectKey = input.objectKey || createObjectKey(input.fileName || defaultName, uploadDir, '.jpg')
  const mimeType = input.mimeType || 'image/jpeg'
  const fileUrl = publicFileUrl(objectKey)
  const maxSize = options.maxSize || 20 * 1024 * 1024
  const missing = missingConfigKeys()

  if (missing.length) {
    return {
      uploadMode: 'oss-config-missing',
      uploadUrl: '',
      objectKey,
      fileUrl,
      maxSize,
      missing,
      formData: {},
      note: `${missingNote}还缺少 ${missing.join('、')}。`
    }
  }

  const host = ossHost()
  const expiration = new Date(Date.now() + config.oss.policyExpireSeconds * 1000).toISOString()
  const policy = {
    expiration,
    conditions: [
      ['content-length-range', 1, maxSize],
      { key: objectKey },
      ['starts-with', '$Content-Type', 'image/'],
      { bucket: config.oss.bucket },
      { success_action_status: '200' }
    ]
  }
  const policyText = Buffer.from(JSON.stringify(policy)).toString('base64')
  const formData = {
    key: objectKey,
    policy: policyText,
    OSSAccessKeyId: config.oss.accessKeyId,
    signature: signOssString(policyText),
    success_action_status: '200',
    'Content-Type': mimeType
  }

  if (config.oss.securityToken) {
    formData['x-oss-security-token'] = config.oss.securityToken
  }

  return {
    uploadMode: 'oss-post',
    uploadUrl: host,
    objectKey,
    fileUrl,
    maxSize,
    expiresAt: expiration,
    formData,
    note
  }
}

function createGroupScreenshotUploadPolicy(input = {}) {
  return createImageUploadPolicy(input, {
    uploadDir: 'group-screenshots',
    defaultName: 'group-chat.jpg',
    missingNote: '已生成群聊截图路径，但 OSS 配置不完整，暂不能真实直传。',
    note: '请使用 wx.uploadFile 直传 OSS，成功后把截图 fileUrl 和 objectKey 写入群聊上传记录。'
  })
}

function createShowingPhotoUploadPolicy(input = {}) {
  return createImageUploadPolicy(input, {
    uploadDir: 'showing-photos',
    defaultName: 'showing-proof.jpg',
    missingNote: '已生成带看水印照片路径，但 OSS 配置不完整，暂不能真实直传。',
    note: '请使用 wx.uploadFile 直传 OSS，成功后把水印照片 fileUrl 和 objectKey 写入带看审核记录。'
  })
}

module.exports = {
  createVideoUploadPolicy,
  createGroupScreenshotUploadPolicy,
  createShowingPhotoUploadPolicy,
  createSignedReadUrl,
  createVideoSnapshotUrl,
  hasReadConfig,
  readSourceOrigins,
  putObjectBuffer,
  putVideoDeterministic,
  verifyVideoDeterministic,
  readObjectBufferAuthenticated,
  sanitizeOssErrorText
}
