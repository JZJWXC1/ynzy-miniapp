'use strict'

const crypto = require('crypto')
const http = require('http')
const https = require('https')
const { URL } = require('url')

// 公开视频用于播放、转发和保存；能力地址本身不暴露对象键，且每次请求仍会重验房源状态。
// 默认覆盖六小时长驻页面/弱网播放窗口，客户端 binderror 再做一次受控刷新。
const DEFAULT_TTL_SECONDS = 6 * 60 * 60
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BYTES = 300 * 1024 * 1024
const DEFAULT_MAX_CONCURRENT = 24
const VIDEO_EXTENSION_RE = /\.(mp4|mov|m4v|webm)$/i

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.username || url.password) return ''
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return url.origin
  } catch (error) {
    return ''
  }
}

function isSecureSameOrigin(left, right) {
  try {
    const requestUrl = new URL(String(left || ''))
    const downloadUrl = new URL(String(right || ''))
    return requestUrl.protocol === 'https:' &&
      downloadUrl.protocol === 'https:' &&
      !requestUrl.username &&
      !requestUrl.password &&
      !downloadUrl.username &&
      !downloadUrl.password &&
      requestUrl.origin === downloadUrl.origin
  } catch (error) {
    return false
  }
}

function normalizedAllowedOrigins(values) {
  return Array.from(new Set((values || []).map(normalizedOrigin).filter(Boolean)))
}

function normalizeUploadDir(value) {
  return String(value || 'house-videos').replace(/^\/+|\/+$/g, '') || 'house-videos'
}

function normalizeManagedObjectKey(value, uploadDir) {
  const key = String(value || '').trim()
  const root = normalizeUploadDir(uploadDir)
  if (!key || key.length > 512) return ''
  if (/[\\\0\r\n?#]/.test(key) || key.startsWith('/') || !key.startsWith(`${root}/`)) return ''
  const segments = key.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return ''
  if (!VIDEO_EXTENSION_RE.test(key)) return ''
  return key
}

function managedObjectKeyFromUrl(value, options = {}) {
  const allowedOrigins = normalizedAllowedOrigins(options.allowedOrigins)
  if (!allowedOrigins.length) return ''
  try {
    const url = new URL(String(value || ''))
    if (url.username || url.password || !allowedOrigins.includes(url.origin)) return ''
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch (error) {
      return ''
    }
    return normalizeManagedObjectKey(pathname.replace(/^\/+/, ''), options.uploadDir)
  } catch (error) {
    return ''
  }
}

function resolveManagedVideoObjectKey(listing = {}, options = {}) {
  const storedKey = String(listing.videoKey || '').trim()
  if (storedKey) {
    const normalizedKey = normalizeManagedObjectKey(storedKey, options.uploadDir)
    if (normalizedKey) return normalizedKey
  }
  return managedObjectKeyFromUrl(listing.videoUrl, options)
}

function mediaError(statusCode, message) {
  const error = new Error(message || '媒体不可用')
  error.statusCode = statusCode
  return error
}

function secretBuffer(secret) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ''), 'utf8')
  if (!value.length) throw mediaError(503, '媒体能力未配置')
  return crypto.createHmac('sha256', value).update('ynzy-public-listing-media-v1').digest()
}

function mediaFingerprint(objectKey) {
  return crypto.createHash('sha256').update(String(objectKey || '')).digest('hex')
}

function normalizedCapabilityScope(options = {}) {
  const scope = options.scope === 'owner' ? 'owner' : 'public'
  const audience = scope === 'owner' ? String(options.audience || '').trim() : ''
  const stateKey = scope === 'owner' ? String(options.stateKey || '') : ''
  return { scope, audience, stateKey }
}

function capabilityPayload(listingId, kind, expiresAt, objectKey, options = {}) {
  const capability = normalizedCapabilityScope(options)
  return [
    'v2',
    String(kind || ''),
    String(listingId || ''),
    String(expiresAt || ''),
    mediaFingerprint(objectKey),
    capability.scope,
    mediaFingerprint(capability.audience),
    mediaFingerprint(capability.stateKey)
  ].join('\n')
}

function signCapability(secret, listingId, kind, expiresAt, objectKey, options = {}) {
  return crypto.createHmac('sha256', secretBuffer(secret))
    .update(capabilityPayload(listingId, kind, expiresAt, objectKey, options))
    .digest('base64url')
}

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8')
  const rightBuffer = Buffer.from(String(right || ''), 'utf8')
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function parseCapabilityToken(token) {
  const matched = String(token || '').match(/^(\d{10})\.([A-Za-z0-9_-]{43})$/)
  if (!matched) return null
  return { expiresAt: Number(matched[1]), signature: matched[2] }
}

function parseSingleRange(value) {
  const text = String(value || '').trim()
  if (!text) return null
  if (text.includes(',')) return false
  const matched = text.match(/^bytes=(\d*)-(\d*)$/i)
  if (!matched || (!matched[1] && !matched[2])) return false
  if (matched[1] && !Number.isSafeInteger(Number(matched[1]))) return false
  if (matched[2] && !Number.isSafeInteger(Number(matched[2]))) return false
  if (matched[1] && matched[2] && Number(matched[1]) > Number(matched[2])) return false
  return `bytes=${matched[1]}-${matched[2]}`
}

function parseContentLength(value) {
  if (!/^\d+$/.test(String(value || ''))) return null
  const length = Number(value)
  return Number.isSafeInteger(length) && length >= 0 ? length : null
}

function parseContentRange(value) {
  const matched = String(value || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
  if (!matched) return null
  const start = Number(matched[1])
  const end = Number(matched[2])
  const total = Number(matched[3])
  if (![start, end, total].every(Number.isSafeInteger)) return null
  if (start < 0 || end < start || total <= end) return null
  return { start, end, total }
}

function parseUnsatisfiedContentRange(value) {
  const matched = String(value || '').match(/^bytes \*\/(\d+)$/i)
  if (!matched) return null
  const total = Number(matched[1])
  return Number.isSafeInteger(total) && total >= 0 ? total : null
}

function videoMediaMetadata(objectKey) {
  const matched = String(objectKey || '').toLowerCase().match(/\.(mp4|mov|m4v|webm)$/)
  const extension = matched ? matched[1] : 'mp4'
  if (extension === 'mov') return { contentType: 'video/quicktime', extension: 'mov' }
  if (extension === 'webm') return { contentType: 'video/webm', extension: 'webm' }
  return { contentType: 'video/mp4', extension: extension === 'm4v' ? 'm4v' : 'mp4' }
}

function allowedContentType(kind, value, objectKey) {
  const type = String(value || '').split(';')[0].trim().toLowerCase()
  if (kind === 'cover') return ['image/jpeg', 'image/png', 'image/webp'].includes(type) ? type : ''
  if (!type.startsWith('video/') && type !== 'application/octet-stream') return ''
  // OSS 存量对象可能统一标为 octet-stream；按已白名单的服务端对象键扩展名归一 MIME，
  // 避免 nosniff 下 MOV/WEBM 被微信当未知文件，同时不信任上游自报的任意视频类型。
  return videoMediaMetadata(objectKey).contentType
}

function writeRangeRejected(res, total) {
  const headers = {
    'Cache-Control': 'private, no-store, no-transform',
    'Accept-Ranges': 'bytes',
    'Content-Length': '0',
    Vary: 'Range',
    'X-Content-Type-Options': 'nosniff'
  }
  if (Number.isSafeInteger(total) && total >= 0) headers['Content-Range'] = `bytes */${total}`
  res.writeHead(416, headers)
  res.end()
}

function validateUpstreamUrl(value, options) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch (error) {
    throw mediaError(502, '媒体源不可用')
  }
  const allowedOrigins = normalizedAllowedOrigins(options.allowedOrigins)
  if (url.username || url.password || !allowedOrigins.includes(url.origin)) throw mediaError(502, '媒体源不可用')
  if (url.protocol !== 'https:' && !(options.allowHttpUpstreamForTests && url.protocol === 'http:')) {
    throw mediaError(502, '媒体源不可用')
  }
  return url
}

function createPublicListingMediaService(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const ttlSeconds = Math.max(60, Math.min(24 * 60 * 60, Number(options.ttlSeconds) || DEFAULT_TTL_SECONDS))
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_BYTES)
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent) || DEFAULT_MAX_CONCURRENT)
  const allowedOrigins = normalizedAllowedOrigins(options.allowedOrigins)
  const sourceOptions = { uploadDir: options.uploadDir, allowedOrigins }
  let activeRequests = 0

  function capabilityToken(listingId, kind, objectKey, capabilityOptions = {}) {
    const expiresAt = Math.floor(now() / 1000) + ttlSeconds
    return `${expiresAt}.${signCapability(options.secret, listingId, kind, expiresAt, objectKey, capabilityOptions)}`
  }

  function verifyCapability(listingId, kind, objectKey, token, capabilityOptions = {}) {
    const parsed = parseCapabilityToken(token)
    if (!parsed || parsed.expiresAt < Math.floor(now() / 1000)) return false
    const expected = signCapability(options.secret, listingId, kind, parsed.expiresAt, objectKey, capabilityOptions)
    return safeEqualText(expected, parsed.signature)
  }

  function publicUrl(listingId, kind, objectKey, capabilityOptions = {}) {
    let baseUrl
    try {
      baseUrl = new URL(String(options.baseUrl || ''))
    } catch (error) {
      return ''
    }
    if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') return ''
    const pathname = `/mini/listings/${encodeURIComponent(String(listingId || ''))}/media/${kind}`
    const url = new URL(pathname, baseUrl)
    const capability = normalizedCapabilityScope(capabilityOptions)
    if (capability.scope === 'owner' && (!capability.audience || !capability.stateKey)) return ''
    url.searchParams.set('token', capabilityToken(listingId, kind, objectKey, capability))
    if (capability.scope === 'owner') url.searchParams.set('scope', 'owner')
    return url.toString()
  }

  function urlsForListing(listing = {}, capabilityOptions = {}) {
    const objectKey = resolveManagedVideoObjectKey(listing, sourceOptions)
    if (!objectKey || !listing.id) return { videoUrl: '', coverUrl: '' }
    return {
      videoUrl: publicUrl(listing.id, 'video', objectKey, capabilityOptions),
      coverUrl: publicUrl(listing.id, 'cover', objectKey, capabilityOptions)
    }
  }

  function upstreamSignedUrl(objectKey, kind, method) {
    const signer = kind === 'cover' ? options.signCoverUrl : options.signVideoUrl
    if (typeof signer !== 'function') throw mediaError(503, '媒体能力未配置')
    return validateUpstreamUrl(signer(objectKey, method), {
      allowedOrigins,
      allowHttpUpstreamForTests: options.allowHttpUpstreamForTests
    })
  }

  function serve(req, res, input = {}) {
    const method = String(req.method || 'GET').toUpperCase()
    const kind = String(input.kind || '')
    if (!['GET', 'HEAD'].includes(method)) return Promise.reject(mediaError(405, '请求方式不支持'))
    if (!['video', 'cover'].includes(kind)) return Promise.reject(mediaError(404, '媒体不存在'))
    const listing = input.listing || {}
    const listingId = String(input.listingId || '')
    if (!listing.id || listingId !== String(listing.id)) return Promise.reject(mediaError(404, '媒体不存在'))
    const objectKey = resolveManagedVideoObjectKey(listing, sourceOptions)
    if (!objectKey || !verifyCapability(listingId, kind, objectKey, input.token, {
      scope: input.scope,
      audience: input.audience,
      stateKey: input.stateKey
    })) {
      return Promise.reject(mediaError(404, '媒体不存在'))
    }
    const requestedRange = parseSingleRange(req.headers && req.headers.range)
    if (requestedRange === false) {
      writeRangeRejected(res)
      return Promise.resolve()
    }
    if (activeRequests >= maxConcurrent) return Promise.reject(mediaError(503, '媒体服务繁忙'))

    let upstreamUrl
    try {
      upstreamUrl = upstreamSignedUrl(objectKey, kind, method)
    } catch (error) {
      return Promise.reject(error)
    }
    activeRequests += 1
    return new Promise((resolve, reject) => {
      let settled = false
      let upstreamReq = null
      let upstreamRes = null
      const settle = (error) => {
        if (settled) return
        settled = true
        activeRequests = Math.max(0, activeRequests - 1)
        if (error) reject(error)
        else resolve()
      }
      const abortUpstream = () => {
        if (upstreamReq) upstreamReq.destroy()
        if (upstreamRes) upstreamRes.destroy()
      }
      req.once('aborted', () => {
        abortUpstream()
        settle(mediaError(499, '客户端已断开'))
      })
      res.once('close', () => {
        if (!res.writableEnded) {
          abortUpstream()
          settle(mediaError(499, '客户端已断开'))
        }
      })

      const requestImpl = typeof options.requestImpl === 'function'
        ? options.requestImpl
        : (upstreamUrl.protocol === 'https:' ? https.request : http.request)
      const headers = {}
      if (requestedRange) headers.Range = requestedRange
      upstreamReq = requestImpl(upstreamUrl, { method, headers }, (received) => {
        upstreamRes = received
        const statusCode = Number(received.statusCode || 0)
        if (statusCode >= 300 && statusCode < 400) {
          received.resume()
          settle(mediaError(502, '媒体源不可用'))
          return
        }
        if (statusCode === 416 && requestedRange) {
          const total = parseUnsatisfiedContentRange(received.headers['content-range'])
          received.resume()
          if (total === null || total > maxBytes) {
            settle(mediaError(502, '媒体源响应无效'))
            return
          }
          writeRangeRejected(res, total)
          settle()
          return
        }
        const expectedStatus = requestedRange ? 206 : 200
        if (statusCode !== expectedStatus) {
          received.resume()
          settle(mediaError(502, '媒体源响应无效'))
          return
        }
        const contentType = allowedContentType(kind, received.headers['content-type'], objectKey)
        const contentLength = parseContentLength(received.headers['content-length'])
        if (!contentType || contentLength === null || contentLength > maxBytes) {
          received.resume()
          settle(mediaError(502, '媒体源响应无效'))
          return
        }
        let contentRange = null
        if (statusCode === 206) {
          contentRange = parseContentRange(received.headers['content-range'])
          if (!contentRange || contentRange.total > maxBytes || contentRange.end - contentRange.start + 1 !== contentLength) {
            received.resume()
            settle(mediaError(502, '媒体源响应无效'))
            return
          }
        }
        const videoMetadata = videoMediaMetadata(objectKey)
        const responseHeaders = {
          'Content-Type': contentType,
          'Content-Length': String(contentLength),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store, no-transform',
          'Content-Disposition': kind === 'cover'
            ? 'inline; filename="listing-cover.jpg"'
            : `inline; filename="listing-video.${videoMetadata.extension}"`,
          Vary: 'Range',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*'
        }
        if (contentRange) responseHeaders['Content-Range'] = `bytes ${contentRange.start}-${contentRange.end}/${contentRange.total}`
        res.writeHead(statusCode, responseHeaders)
        if (method === 'HEAD') {
          received.resume()
          res.end()
          settle()
          return
        }

        let bytesWritten = 0
        received.on('data', (chunk) => {
          if (settled) return
          bytesWritten += chunk.length
          if (bytesWritten > contentLength || bytesWritten > maxBytes) {
            abortUpstream()
            res.destroy()
            settle(mediaError(502, '媒体源响应无效'))
            return
          }
          if (!res.write(chunk)) received.pause()
        })
        res.on('drain', () => {
          if (upstreamRes && !settled) upstreamRes.resume()
        })
        received.on('end', () => {
          if (settled) return
          if (bytesWritten !== contentLength) {
            res.destroy()
            settle(mediaError(502, '媒体源响应无效'))
            return
          }
          res.end()
          settle()
        })
        received.on('aborted', () => {
          if (!settled) {
            res.destroy()
            settle(mediaError(502, '媒体源响应中断'))
          }
        })
        received.on('error', (error) => {
          if (!settled) {
            res.destroy()
            settle(mediaError(502, '媒体源读取失败'))
          }
        })
      })
      upstreamReq.setTimeout(timeoutMs, () => {
        abortUpstream()
        settle(mediaError(504, '媒体源响应超时'))
      })
      upstreamReq.on('error', () => settle(mediaError(502, '媒体源连接失败')))
      upstreamReq.end()
    })
  }

  return {
    urlsForListing,
    verifyCapability,
    serve
  }
}

module.exports = {
  createPublicListingMediaService,
  resolveManagedVideoObjectKey,
  normalizeManagedObjectKey,
  parseSingleRange,
  isSecureSameOrigin
}
