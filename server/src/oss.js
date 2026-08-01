const crypto = require('crypto')
const fs = require('fs')
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

const OSS_OBJECT_REQUEST_TIMEOUT_MS = 30000
const OSS_ERROR_RESPONSE_MAX_BYTES = 64 * 1024

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
  if (options.forbidOverwrite === true) {
    headers['x-oss-forbid-overwrite'] = 'true'
  }
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
    let settled = false
    const resolveOnce = (value) => {
      if (settled) return false
      settled = true
      resolve(value)
      return true
    }
    const rejectOnce = (error) => {
      if (settled) return false
      settled = true
      reject(error)
      return true
    }
    const req = https.request({
      method: 'PUT',
      hostname: `${config.oss.bucket}.${config.oss.region}.aliyuncs.com`,
      path: encodedPath,
      headers
    }, (res) => {
      let raw = ''
      let responseBytes = 0
      const rejectResponseFailure = () => {
        const error = new Error('OSS 上传响应中断')
        error.statusCode = 502
        rejectOnce(error)
      }
      res.on('aborted', rejectResponseFailure)
      res.on('error', rejectResponseFailure)
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        if (settled) return
        responseBytes += Buffer.byteLength(chunk)
        if (responseBytes > OSS_ERROR_RESPONSE_MAX_BYTES) {
          const error = new Error('OSS 上传响应超过允许大小')
          error.statusCode = 502
          if (rejectOnce(error)) req.destroy()
          return
        }
        raw += chunk
      })
      res.on('end', () => {
        if (settled) return
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolveOnce({ objectKey, fileUrl: publicFileUrl(objectKey), statusCode: res.statusCode })
          return
        }
        const error = new Error(sanitizeOssErrorText(raw) || `OSS 上传失败：${res.statusCode}`)
        error.statusCode = res.statusCode || 502
        rejectOnce(error)
      })
    })
    req.setTimeout(OSS_OBJECT_REQUEST_TIMEOUT_MS, () => {
      const error = new Error('OSS 上传请求超时')
      error.statusCode = 504
      if (rejectOnce(error)) req.destroy(error)
    })
    req.on('error', rejectOnce)
    req.end(body)
  })
}

function putObjectFile(objectKey, file, contentType, options = {}) {
  const missing = missingConfigKeys()
  if (missing.length) {
    const error = new Error(`OSS 配置缺少 ${missing.join('、')}，无法保存飞书素材`)
    error.statusCode = 503
    throw error
  }
  if (!file || !file.handle || !Number.isSafeInteger(file.size) || file.size < 1) {
    throw new Error('OSS 流式上传文件凭据无效')
  }

  const type = contentType || 'application/octet-stream'
  const date = new Date().toUTCString()
  const resourcePath = `/${config.oss.bucket}/${objectKey}`
  const headers = {
    Date: date,
    'Content-Type': type,
    'Content-Length': file.size
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
  if (options.forbidOverwrite === true) headers['x-oss-forbid-overwrite'] = 'true'
  if (config.oss.securityToken) headers['x-oss-security-token'] = config.oss.securityToken
  const stringToSign = [
    'PUT',
    '',
    type,
    date,
    `${canonicalizedOssHeaders(headers)}${resourcePath}`
  ].join('\n')
  headers.Authorization = `OSS ${config.oss.accessKeyId}:${signOssString(stringToSign)}`

  return new Promise((resolve, reject) => {
    let settled = false
    let source = null
    let streamedBytes = 0
    let sourceEnded = false
    let streamedSha256 = ''
    const sourceHash = crypto.createHash('sha256')
    const stopSource = () => {
      if (source && typeof source.destroy === 'function' && !source.destroyed) source.destroy()
    }
    const resolveOnce = (value) => {
      if (settled) return false
      settled = true
      stopSource()
      resolve(value)
      return true
    }
    const rejectOnce = (error) => {
      if (settled) return false
      settled = true
      stopSource()
      reject(error)
      return true
    }
    const req = https.request({
      method: 'PUT',
      hostname: `${config.oss.bucket}.${config.oss.region}.aliyuncs.com`,
      path: `/${encodeObjectPath(objectKey)}`,
      headers
    }, (res) => {
      let raw = ''
      let responseBytes = 0
      const rejectResponseFailure = () => {
        const error = new Error('OSS 上传响应中断')
        error.statusCode = 502
        rejectOnce(error)
      }
      res.on('aborted', rejectResponseFailure)
      res.on('error', rejectResponseFailure)
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        if (settled) return
        responseBytes += Buffer.byteLength(chunk)
        if (responseBytes > OSS_ERROR_RESPONSE_MAX_BYTES) {
          const error = new Error('OSS 上传响应超过允许大小')
          error.statusCode = 502
          if (rejectOnce(error)) req.destroy()
          return
        }
        raw += chunk
      })
      res.on('end', () => {
        if (settled) return
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!sourceEnded || streamedBytes !== file.size) {
            const error = new Error('OSS 流式上传字节数与受信文件大小不一致')
            error.statusCode = 422
            if (rejectOnce(error)) req.destroy(error)
            return
          }
          if (options.expectedSha256 && streamedSha256 !== options.expectedSha256) {
            const error = new Error('OSS 流式上传期间本地文件内容发生变化')
            error.statusCode = 422
            if (rejectOnce(error)) req.destroy(error)
            return
          }
          resolveOnce({ objectKey, fileUrl: publicFileUrl(objectKey), statusCode: res.statusCode })
          return
        }
        const error = new Error(sanitizeOssErrorText(raw) || `OSS 上传失败：${res.statusCode}`)
        error.statusCode = res.statusCode || 502
        if (rejectOnce(error)) req.destroy()
      })
    })
    req.setTimeout(OSS_OBJECT_REQUEST_TIMEOUT_MS, () => {
      const error = new Error('OSS 上传请求超时')
      error.statusCode = 504
      if (rejectOnce(error)) req.destroy(error)
    })
    req.on('error', rejectOnce)
    try {
      source = fs.createReadStream(file.filePath, {
        fd: file.handle.fd,
        autoClose: false,
        start: 0,
        end: file.size - 1,
        highWaterMark: 64 * 1024
      })
    } catch (error) {
      const failure = new Error('OSS 流式上传无法打开受信文件')
      failure.statusCode = 422
      rejectOnce(failure)
      req.destroy()
      return
    }
    source.on('data', (chunk) => {
      streamedBytes += chunk.length
      sourceHash.update(chunk)
      if (streamedBytes > file.size) {
        const error = new Error('OSS 流式上传超过受信文件大小')
        error.statusCode = 422
        if (rejectOnce(error)) req.destroy(error)
      }
    })
    source.once('error', () => {
      const error = new Error('OSS 流式上传读取受信文件失败')
      error.statusCode = 422
      if (rejectOnce(error)) req.destroy(error)
    })
    source.once('end', () => {
      sourceEnded = true
      streamedSha256 = sourceHash.digest('hex')
      if (settled) return
      if (streamedBytes !== file.size) {
        const error = new Error('OSS 流式上传字节数与受信文件大小不一致')
        error.statusCode = 422
        if (rejectOnce(error)) req.destroy(error)
        return
      }
      if (options.expectedSha256 && streamedSha256 !== options.expectedSha256) {
        const error = new Error('OSS 流式上传期间本地文件内容发生变化')
        error.statusCode = 422
        if (rejectOnce(error)) req.destroy(error)
      }
    })
    source.pipe(req)
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
    let settled = false
    const resolveOnce = (value) => {
      if (settled) return false
      settled = true
      resolve(value)
      return true
    }
    const rejectOnce = (error) => {
      if (settled) return false
      settled = true
      reject(error)
      return true
    }
    const req = https.request({
      method: 'GET',
      hostname: `${config.oss.bucket}.${config.oss.region}.aliyuncs.com`,
      path: `/${encodeObjectPath(objectKey)}`,
      headers
    }, (res) => {
      const rejectResponseFailure = () => {
        const error = new Error('OSS 回读素材响应中断')
        error.statusCode = 502
        rejectOnce(error)
      }
      res.on('aborted', rejectResponseFailure)
      res.on('error', rejectResponseFailure)
      const declaredLength = Number(res.headers && res.headers['content-length'])
      if (Number.isFinite(declaredLength) && declaredLength > safeMaxBytes) {
        const error = new Error('OSS 回读素材超过允许大小')
        error.statusCode = 413
        if (rejectOnce(error)) {
          res.resume()
          req.destroy()
        }
        return
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > safeMaxBytes) {
          const error = new Error('OSS 回读素材超过允许大小')
          error.statusCode = 413
          if (rejectOnce(error)) req.destroy()
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      res.on('end', () => {
        if (settled) return
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`OSS 回读素材失败：${res.statusCode}`)
          error.statusCode = res.statusCode || 502
          rejectOnce(error)
          return
        }
        const buffer = Buffer.concat(chunks, size)
        resolveOnce({
          buffer,
          size,
          contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
          metadataSha256: String(res.headers && res.headers['x-oss-meta-content-sha256'] || '').trim(),
          contentType: String(res.headers && res.headers['content-type'] || '')
            .split(';')[0]
            .trim()
            .toLowerCase()
        })
      })
    })
    req.setTimeout(OSS_OBJECT_REQUEST_TIMEOUT_MS, () => {
      const error = new Error('OSS 回读素材请求超时')
      error.statusCode = 504
      if (rejectOnce(error)) req.destroy(error)
    })
    req.on('error', rejectOnce)
    req.end()
  })
}

function readObjectEvidenceAuthenticated(objectKey, expectedSize) {
  const missing = missingConfigKeys()
  if (missing.length) {
    const error = new Error(`OSS 配置缺少 ${missing.join('、')}，无法回读素材`)
    error.statusCode = 503
    throw error
  }
  const safeExpectedSize = Number(expectedSize)
  if (!Number.isSafeInteger(safeExpectedSize) || safeExpectedSize < 1 || safeExpectedSize > config.oss.maxVideoSize) {
    throw new Error('房源笔记素材大小无效')
  }
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
    let settled = false
    const resolveOnce = (value) => {
      if (settled) return false
      settled = true
      resolve(value)
      return true
    }
    const rejectOnce = (error) => {
      if (settled) return false
      settled = true
      reject(error)
      return true
    }
    const req = https.request({
      method: 'GET',
      hostname: `${config.oss.bucket}.${config.oss.region}.aliyuncs.com`,
      path: `/${encodeObjectPath(objectKey)}`,
      headers
    }, (res) => {
      const rejectResponseFailure = () => {
        const error = new Error('OSS 回读素材响应中断')
        error.statusCode = 502
        rejectOnce(error)
      }
      res.on('aborted', rejectResponseFailure)
      res.on('error', rejectResponseFailure)

      if (res.statusCode < 200 || res.statusCode >= 300) {
        let responseBytes = 0
        res.on('data', (chunk) => {
          if (settled) return
          responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
          if (responseBytes > OSS_ERROR_RESPONSE_MAX_BYTES) {
            const error = new Error('OSS 回读失败响应超过允许大小')
            error.statusCode = 502
            if (rejectOnce(error)) {
              if (typeof res.destroy === 'function') res.destroy(error)
              req.destroy(error)
            }
          }
        })
        res.on('end', () => {
          if (settled) return
          const error = new Error(`OSS 回读素材失败：${res.statusCode}`)
          error.statusCode = res.statusCode || 502
          rejectOnce(error)
        })
        return
      }

      const rawDeclaredLength = res.headers && res.headers['content-length']
      const declaredLength = rawDeclaredLength === undefined || rawDeclaredLength === ''
        ? null
        : Number(rawDeclaredLength)
      if (declaredLength !== null &&
          (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        const error = new Error('OSS 回读素材 Content-Length 无效')
        error.statusCode = 502
        if (rejectOnce(error)) req.destroy(error)
        return
      }
      if (declaredLength !== null && declaredLength > safeExpectedSize) {
        const error = new Error('OSS 回读素材超过允许大小')
        error.statusCode = 413
        if (rejectOnce(error)) {
          if (typeof res.destroy === 'function') res.destroy(error)
          req.destroy(error)
        }
        return
      }

      let size = 0
      const hash = crypto.createHash('sha256')
      res.on('data', (chunk) => {
        if (settled) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > safeExpectedSize) {
          const error = new Error('OSS 回读素材超过允许大小')
          error.statusCode = 413
          if (rejectOnce(error)) req.destroy(error)
          return
        }
        hash.update(bytes)
      })
      res.on('end', () => {
        if (settled) return
        resolveOnce({
          size,
          contentSha256: hash.digest('hex'),
          metadataSha256: String(res.headers && res.headers['x-oss-meta-content-sha256'] || '').trim(),
          contentType: String(res.headers && res.headers['content-type'] || '')
            .split(';')[0]
            .trim()
            .toLowerCase()
        })
      })
    })
    req.setTimeout(OSS_OBJECT_REQUEST_TIMEOUT_MS, () => {
      const error = new Error('OSS 回读素材请求超时')
      error.statusCode = 504
      if (rejectOnce(error)) req.destroy(error)
    })
    req.on('error', rejectOnce)
    req.end()
  })
}

const OSS_CONTROL_REQUEST_TIMEOUT_MS = 30000
const OSS_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024

function parseBucketVersioningXml(value) {
  const xml = String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml\s+[^?]*\?>\s*/i, '')
    .trim()
  const namespace = 'http:\\/\\/doc\\.oss-cn-[a-z0-9-]+\\.aliyuncs\\.com'
  const attributes = `(?:\\s+xmlns=(?:"${namespace}"|'${namespace}'))?`
  const statusPattern = new RegExp(
    `^<VersioningConfiguration${attributes}\\s*>\\s*` +
    '<Status>\\s*(Enabled|Suspended)\\s*</Status>\\s*' +
    '</VersioningConfiguration>$'
  )
  const statusMatch = xml.match(statusPattern)
  if (statusMatch) return statusMatch[1]
  const emptyPattern = new RegExp(
    `^(?:<VersioningConfiguration${attributes}\\s*/>|` +
    `<VersioningConfiguration${attributes}\\s*>\\s*</VersioningConfiguration>)$`
  )
  if (emptyPattern.test(xml)) return 'Disabled'
  throw new Error('OSS Bucket 版本状态响应无效')
}

function readBucketVersioningState() {
  const missing = missingConfigKeys()
  if (missing.length) {
    const error = new Error(`OSS 配置缺少 ${missing.join('、')}，无法确认禁止覆盖能力`)
    error.statusCode = 503
    throw error
  }
  const date = new Date().toUTCString()
  const headers = { Date: date }
  if (config.oss.securityToken) headers['x-oss-security-token'] = config.oss.securityToken
  const resourcePath = `/${config.oss.bucket}/?versioning`
  const stringToSign = [
    'GET',
    '',
    '',
    date,
    `${canonicalizedOssHeaders(headers)}${resourcePath}`
  ].join('\n')
  headers.Authorization = `OSS ${config.oss.accessKeyId}:${signOssString(stringToSign)}`

  return new Promise((resolve, reject) => {
    let settled = false
    const resolveOnce = (value) => {
      if (settled) return false
      settled = true
      resolve(value)
      return true
    }
    const rejectOnce = (error) => {
      if (settled) return false
      settled = true
      reject(error)
      return true
    }
    const req = https.request({
      method: 'GET',
      hostname: `${config.oss.bucket}.${config.oss.region}.aliyuncs.com`,
      path: '/?versioning',
      headers
    }, (res) => {
      const rejectResponseFailure = () => {
        const error = new Error('OSS Bucket 版本状态响应中断')
        error.statusCode = 502
        rejectOnce(error)
      }
      res.on('aborted', rejectResponseFailure)
      res.on('error', rejectResponseFailure)
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > OSS_CONTROL_RESPONSE_MAX_BYTES) {
          const error = new Error('OSS Bucket 版本状态响应过大')
          error.statusCode = 502
          if (rejectOnce(error)) req.destroy()
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      res.on('end', () => {
        if (settled) return
        if (res.statusCode !== 200) {
          const error = new Error(`OSS Bucket 版本状态读取失败：${res.statusCode}`)
          error.statusCode = res.statusCode || 502
          rejectOnce(error)
          return
        }
        try {
          resolveOnce(parseBucketVersioningXml(Buffer.concat(chunks, size).toString('utf8')))
        } catch (error) {
          error.statusCode = 502
          rejectOnce(error)
        }
      })
    })
    req.setTimeout(OSS_CONTROL_REQUEST_TIMEOUT_MS, () => {
      const error = new Error('OSS Bucket 版本状态读取超时')
      error.statusCode = 504
      if (rejectOnce(error)) req.destroy(error)
    })
    req.on('error', rejectOnce)
    req.end()
  })
}

const NOTE_MATERIAL_TYPES = new Map([
  ['mp4', { kind: 'video', contentType: 'video/mp4' }],
  ['mov', { kind: 'video', contentType: 'video/quicktime' }],
  ['m4v', { kind: 'video', contentType: 'video/x-m4v' }],
  ['webm', { kind: 'video', contentType: 'video/webm' }],
  ['jpg', { kind: 'image', contentType: 'image/jpeg' }],
  ['jpeg', { kind: 'image', contentType: 'image/jpeg' }],
  ['png', { kind: 'image', contentType: 'image/png' }],
  ['webp', { kind: 'image', contentType: 'image/webp' }],
  ['gif', { kind: 'image', contentType: 'image/gif' }]
])

function imageBytesMatch(buffer, extension) {
  if (!buffer) return true
  if ((extension === 'jpg' || extension === 'jpeg') &&
      buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true
  if (extension === 'png' && buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  if (extension === 'webp' && buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP') return true
  if (extension === 'gif' && buffer.length >= 6 &&
      ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return true
  return false
}

function validateDeterministicMaterialInput(input = {}, options = {}) {
  const objectKey = String(input.objectKey || '').trim()
  const size = Number(input.size)
  const filePath = String(input.filePath || '').trim()
  const contentSha256 = String(input.contentSha256 || '').trim().toLowerCase()
  const extensionMatch = objectKey.toLowerCase().match(/\.([a-z0-9]+)$/)
  const extension = extensionMatch ? extensionMatch[1] : ''
  const metadata = NOTE_MATERIAL_TYPES.get(extension)
  const kind = String(input.kind || (metadata && metadata.kind) || '').trim().toLowerCase()
  const contentType = String(input.contentType || input.mimeType || (metadata && metadata.contentType) || '')
    .split(';')[0].trim().toLowerCase()
  if (!objectKey || !/\/feishu-note-v1\/.+\.[a-z0-9]+$/i.test(objectKey) ||
      objectKey.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\\?#\0\r\n]/.test(objectKey) || !metadata) {
    throw new Error('房源笔记 OSS 对象键无效')
  }
  if (kind !== metadata.kind || contentType !== metadata.contentType) {
    throw new Error('房源笔记 OSS 素材类型与对象键扩展名不一致')
  }
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) throw new Error('房源笔记内容哈希无效')
  if (!Number.isSafeInteger(size) || size < 1 || size > config.oss.maxVideoSize) {
    throw new Error('房源笔记素材大小无效')
  }
  if (options.requireFile === true) {
    if (input.buffer !== undefined && input.buffer !== null) {
      throw new Error('房源笔记 OSS 上传必须使用受信本地文件，禁止整块 Buffer')
    }
    if (!filePath || !path.isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) {
      throw new Error('房源笔记 OSS 受信本地文件路径无效')
    }
  }
  return { objectKey, filePath, size, contentSha256, extension, kind, contentType }
}

function sameLocalPath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ''))
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function sameOpenedFile(left, right) {
  if (!left || !right || left.size !== right.size) return false
  if (Number.isFinite(left.dev) && Number.isFinite(right.dev) && left.dev !== right.dev) return false
  if (Number.isFinite(left.ino) && Number.isFinite(right.ino) && left.ino !== right.ino) return false
  return true
}

function hashOpenedFile(filePath, handle, expectedSize) {
  return new Promise((resolve, reject) => {
    let settled = false
    let size = 0
    const hash = crypto.createHash('sha256')
    const source = fs.createReadStream(filePath, {
      fd: handle.fd,
      autoClose: false,
      start: 0,
      end: expectedSize - 1,
      highWaterMark: 64 * 1024
    })
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      source.destroy()
      reject(error)
    }
    source.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > expectedSize) {
        const error = new Error('房源笔记受信本地文件超过声明大小')
        error.statusCode = 422
        rejectOnce(error)
        return
      }
      hash.update(chunk)
    })
    source.once('error', () => {
      const error = new Error('房源笔记受信本地文件读取失败')
      error.statusCode = 422
      rejectOnce(error)
    })
    source.once('end', () => {
      if (settled) return
      if (size !== expectedSize) {
        const error = new Error('房源笔记受信本地文件大小与声明不一致')
        error.statusCode = 422
        rejectOnce(error)
        return
      }
      settled = true
      resolve({ size, contentSha256: hash.digest('hex') })
    })
  })
}

async function openVerifiedDeterministicMaterialFile(normalized) {
  let handle = null
  try {
    const pathStat = await fs.promises.lstat(normalized.filePath)
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('房源笔记 OSS 受信本地文件必须是普通文件')
    }
    const realPath = await fs.promises.realpath(normalized.filePath)
    if (!sameLocalPath(realPath, normalized.filePath)) {
      throw new Error('房源笔记 OSS 受信本地文件不得经过链接跳转')
    }
    handle = await fs.promises.open(realPath, 'r')
    const openedStat = await handle.stat()
    if (!openedStat.isFile() || !sameOpenedFile(pathStat, openedStat) || openedStat.size !== normalized.size) {
      throw new Error('房源笔记 OSS 受信本地文件大小或身份与声明不一致')
    }

    if (normalized.kind === 'image') {
      const header = Buffer.alloc(Math.min(16, normalized.size))
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      if (!imageBytesMatch(header.subarray(0, bytesRead), normalized.extension)) {
        throw new Error('房源笔记图片真实字节类型与对象键扩展名不一致')
      }
    }

    const evidence = await hashOpenedFile(realPath, handle, normalized.size)
    if (evidence.contentSha256 !== normalized.contentSha256) {
      throw new Error('房源笔记上传内容与声明哈希不一致')
    }
    const stableStat = await handle.stat()
    if (!sameOpenedFile(openedStat, stableStat) ||
        stableStat.mtimeMs !== openedStat.mtimeMs ||
        stableStat.ctimeMs !== openedStat.ctimeMs) {
      throw new Error('房源笔记 OSS 受信本地文件在校验期间发生变化')
    }
    return { filePath: realPath, size: normalized.size, handle }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    if (!error.statusCode) error.statusCode = 422
    throw error
  }
}

async function verifyMaterialDeterministic(asset = {}) {
  const normalized = validateDeterministicMaterialInput({
    kind: asset.kind,
    objectKey: asset.objectKey,
    contentType: asset.mimeType || asset.contentType,
    contentSha256: asset.contentSha256,
    size: asset.size
  })
  const readback = await readObjectEvidenceAuthenticated(normalized.objectKey, normalized.size)
  return {
    objectKey: normalized.objectKey,
    contentSha256: readback.contentSha256,
    size: readback.size,
    contentType: readback.contentType,
    verified: readback.contentSha256 === normalized.contentSha256 &&
      (!readback.metadataSha256 || readback.metadataSha256 === normalized.contentSha256) &&
      readback.size === normalized.size &&
      readback.contentType === normalized.contentType
  }
}

async function putMaterialDeterministic(input = {}) {
  const normalized = validateDeterministicMaterialInput(input, { requireFile: true })
  const expected = {
    kind: normalized.kind,
    objectKey: normalized.objectKey,
    mimeType: normalized.contentType,
    contentSha256: normalized.contentSha256,
    size: normalized.size
  }
  try {
    const existing = await verifyMaterialDeterministic(expected)
    if (existing.verified !== true) {
      const conflict = new Error('房源笔记 OSS 已有对象与确定性内容不一致，禁止覆盖')
      conflict.statusCode = 409
      throw conflict
    }
    return { ...existing, reused: true }
  } catch (error) {
    if (Number(error && error.statusCode) !== 404) throw error
  }

  const file = await openVerifiedDeterministicMaterialFile(normalized)
  try {
    const versioning = await readBucketVersioningState()
    if (versioning !== 'Disabled') {
      const error = new Error('OSS Bucket 版本控制已开启或暂停，禁止覆盖保护不可用')
      error.statusCode = 503
      throw error
    }

    try {
      await putObjectFile(
        normalized.objectKey,
        file,
        normalized.contentType,
        {
          metadata: { 'x-oss-meta-content-sha256': normalized.contentSha256 },
          forbidOverwrite: true,
          expectedSha256: normalized.contentSha256
        }
      )
    } catch (error) {
      if (Number(error && error.statusCode) !== 409) throw error
      try {
        const raced = await verifyMaterialDeterministic(expected)
        if (raced.verified === true) return { ...raced, reused: true }
      } catch (_) {
        // 409 后只允许精确回读复用；任何读取异常都统一拒绝，不泄露上游正文。
      }
      const conflict = new Error('房源笔记 OSS 并发目标未通过确定性回读，禁止覆盖')
      conflict.statusCode = 409
      throw conflict
    }

    const verified = await verifyMaterialDeterministic(expected)
    if (verified.verified !== true) throw new Error('房源笔记 OSS 写后 GET 内容哈希、大小或类型回读不一致')
    return { ...verified, reused: false }
  } finally {
    await file.handle.close().catch(() => {})
  }
}

async function verifyVideoDeterministic(asset = {}) {
  return verifyMaterialDeterministic({
    ...asset,
    kind: 'video',
    mimeType: asset.mimeType || asset.contentType
  })
}

async function putVideoDeterministic(input = {}) {
  return putMaterialDeterministic({
    ...input,
    kind: 'video'
  })
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
  putMaterialDeterministic,
  verifyMaterialDeterministic,
  putVideoDeterministic,
  verifyVideoDeterministic,
  readObjectBufferAuthenticated,
  sanitizeOssErrorText
}
