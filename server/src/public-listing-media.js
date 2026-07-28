'use strict'

const crypto = require('crypto')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const { normalizePrivateListingMediaAssets } = require('./domain')

// 公开视频用于播放、转发和保存；能力地址本身不暴露对象键，且每次请求仍会重验房源状态。
// 默认覆盖六小时长驻页面/弱网播放窗口，客户端 binderror 再做一次受控刷新。
const DEFAULT_TTL_SECONDS = 6 * 60 * 60
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_BYTES = 300 * 1024 * 1024
const DEFAULT_MAX_CONCURRENT = 24
const DEFAULT_MAX_CONCURRENT_PER_CLIENT = 6
const VIDEO_EXTENSION_RE = /\.(mp4|mov|m4v|webm)$/i
const IMAGE_EXTENSION_RE = /\.(jpg|jpeg|png|webp|gif)$/i
const MEDIA_ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,95}$/

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

function normalizeManagedObjectKey(value, uploadDir, kind = 'video') {
  const key = String(value || '').trim()
  const root = normalizeUploadDir(uploadDir)
  if (!key || key.length > 512) return ''
  if (/[\\\0\r\n?#]/.test(key) || key.startsWith('/') || !key.startsWith(`${root}/`)) return ''
  const segments = key.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return ''
  if (kind === 'video' && !VIDEO_EXTENSION_RE.test(key)) return ''
  if (kind === 'image' && !IMAGE_EXTENSION_RE.test(key)) return ''
  if (!['video', 'image'].includes(kind)) return ''
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

function normalizedListingMediaAssets(listing = {}, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(listing, 'mediaAssets')) return null
  let assets
  try {
    // 公共媒体代理直接复用领域层的完整 canonical 校验，避免来源摘要、目标回读摘要、
    // MIME 或大小在两层之间产生“领域已关闭、代理仍放行”的漂移。
    assets = normalizePrivateListingMediaAssets(listing.mediaAssets)
  } catch (error) {
    return []
  }
  const managed = assets.map((asset) => ({
    ...asset,
    objectKey: normalizeManagedObjectKey(asset.objectKey, options.uploadDir, asset.kind)
  }))
  return managed.some((asset) => {
    if (!asset.objectKey) return true
    if (asset.kind !== 'image') return false
    const metadata = imageMediaMetadata(asset.objectKey)
    return !metadata || metadata.contentType !== asset.mimeType
  }) ? [] : managed
}

function mediaAssetStateKey(asset = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    assetId: String(asset.assetId || ''),
    kind: String(asset.kind || ''),
    objectKey: String(asset.objectKey || ''),
    contentSha256: String(asset.contentSha256 || ''),
    sourceFingerprint: String(asset.sourceFingerprint || ''),
    targetDriveFingerprint: String(asset.targetDriveFingerprint || ''),
    displayOrder: Number(asset.displayOrder),
    mimeType: String(asset.mimeType || ''),
    size: Number(asset.size),
    verified: asset.verified === true
  })).digest('hex')
}

function mediaManifestStateKey(assets = []) {
  return crypto.createHash('sha256')
    .update(JSON.stringify((Array.isArray(assets) ? assets : []).map(mediaAssetStateKey)))
    .digest('hex')
}

function resolveListingMediaSource(listing = {}, assetIdValue = '', options = {}) {
  const assetId = String(assetIdValue || '').trim()
  const assets = normalizedListingMediaAssets(listing, options)
  if (assets) {
    if (!assetId) return null
    const asset = assets.find((item) => item.assetId === assetId)
    if (!asset) return null
    return {
      assetId: asset.assetId,
      kind: asset.kind,
      objectKey: asset.objectKey,
      mediaStateKey: mediaManifestStateKey(assets)
    }
  }
  if (assetId) return null
  const objectKey = resolveManagedVideoObjectKey(listing, options)
  return objectKey ? { assetId: '', kind: 'video', objectKey, mediaStateKey: '' } : null
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
  const assetId = String(options.assetId || '').trim()
  const mediaStateKey = String(options.mediaStateKey || '')
  return { scope, audience, stateKey, assetId, mediaStateKey }
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
    mediaFingerprint(capability.stateKey),
    mediaFingerprint(capability.assetId),
    mediaFingerprint(capability.mediaStateKey)
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

function imageMediaMetadata(objectKey) {
  const matched = String(objectKey || '').toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/)
  if (!matched) return null
  const extension = matched[1]
  if (extension === 'jpg' || extension === 'jpeg') return { contentType: 'image/jpeg', extension }
  if (extension === 'png') return { contentType: 'image/png', extension }
  if (extension === 'gif') return { contentType: 'image/gif', extension: 'gif' }
  return { contentType: 'image/webp', extension: 'webp' }
}

function allowedContentType(kind, value, objectKey) {
  const type = String(value || '').split(';')[0].trim().toLowerCase()
  if (kind === 'cover') return ['image/jpeg', 'image/png', 'image/webp'].includes(type) ? type : ''
  if (kind === 'image') {
    const metadata = imageMediaMetadata(objectKey)
    return metadata && metadata.contentType === type ? type : ''
  }
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
  const maxConcurrentPerClient = Math.max(1, Math.min(
    maxConcurrent,
    Number(options.maxConcurrentPerClient) || DEFAULT_MAX_CONCURRENT_PER_CLIENT
  ))
  const allowedOrigins = normalizedAllowedOrigins(options.allowedOrigins)
  const sourceOptions = { uploadDir: options.uploadDir, allowedOrigins }
  let activeRequests = 0
  const activeRequestsByClient = new Map()

  function normalizedClientKey(value) {
    const key = String(value || '').trim()
    // 键只用于进程内公平限流；限制长度，避免异常代理头制造大键驻留。
    return (key || 'unknown').slice(0, 256)
  }

  function acquireConcurrency(clientKeyValue) {
    const clientKey = normalizedClientKey(clientKeyValue)
    const clientActive = activeRequestsByClient.get(clientKey) || 0
    if (clientActive >= maxConcurrentPerClient) throw mediaError(429, '当前网络媒体连接过多，请稍后重试')
    if (activeRequests >= maxConcurrent) throw mediaError(503, '媒体服务繁忙')
    activeRequests += 1
    activeRequestsByClient.set(clientKey, clientActive + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      activeRequests = Math.max(0, activeRequests - 1)
      const nextClientActive = Math.max(0, (activeRequestsByClient.get(clientKey) || 0) - 1)
      if (nextClientActive === 0) activeRequestsByClient.delete(clientKey)
      else activeRequestsByClient.set(clientKey, nextClientActive)
    }
  }

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
    if (capability.assetId && !MEDIA_ASSET_ID_RE.test(capability.assetId)) return ''
    url.searchParams.set('token', capabilityToken(listingId, kind, objectKey, capability))
    if (capability.assetId) url.searchParams.set('assetId', capability.assetId)
    if (capability.scope === 'owner') url.searchParams.set('scope', 'owner')
    return url.toString()
  }

  function urlsForListing(listing = {}, capabilityOptions = {}) {
    const assets = normalizedListingMediaAssets(listing, sourceOptions)
    if (!listing.id) return { videoUrl: '', coverUrl: '', mediaAssets: [] }
    if (assets) {
      const mediaStateKey = mediaManifestStateKey(assets)
      let imageIndex = 0
      let videoIndex = 0
      const mediaAssets = assets.map((asset) => {
        const boundOptions = {
          ...capabilityOptions,
          assetId: asset.assetId,
          mediaStateKey
        }
        if (asset.kind === 'image') {
          imageIndex += 1
          const imageUrl = publicUrl(listing.id, 'image', asset.objectKey, boundOptions)
          return {
            assetId: asset.assetId,
            kind: 'image',
            displayOrder: asset.displayOrder,
            label: `图片 ${imageIndex}`,
            imageUrl,
            coverUrl: imageUrl
          }
        }
        videoIndex += 1
        return {
          assetId: asset.assetId,
          kind: 'video',
          displayOrder: asset.displayOrder,
          label: `视频 ${videoIndex}`,
          videoUrl: publicUrl(listing.id, 'video', asset.objectKey, boundOptions),
          coverUrl: publicUrl(listing.id, 'cover', asset.objectKey, boundOptions)
        }
      }).filter((asset) => asset.coverUrl && (
        (asset.kind === 'image' && asset.imageUrl) ||
        (asset.kind === 'video' && asset.videoUrl)
      ))
      const primary = mediaAssets[0] || {}
      const primaryVideo = mediaAssets.find((asset) => asset.kind === 'video') || {}
      return {
        videoUrl: primaryVideo.videoUrl || '',
        coverUrl: primary.coverUrl || '',
        mediaAssets
      }
    }
    const objectKey = resolveManagedVideoObjectKey(listing, sourceOptions)
    if (!objectKey) return { videoUrl: '', coverUrl: '', mediaAssets: [] }
    return {
      videoUrl: publicUrl(listing.id, 'video', objectKey, capabilityOptions),
      coverUrl: publicUrl(listing.id, 'cover', objectKey, capabilityOptions),
      mediaAssets: []
    }
  }

  function upstreamSignedUrl(objectKey, kind, method) {
    const signer = kind === 'cover'
      ? options.signCoverUrl
      : (kind === 'image' ? (options.signImageUrl || options.signVideoUrl) : options.signVideoUrl)
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
    if (!['video', 'cover', 'image'].includes(kind)) return Promise.reject(mediaError(404, '媒体不存在'))
    const listing = input.listing || {}
    const listingId = String(input.listingId || '')
    if (!listing.id || listingId !== String(listing.id)) return Promise.reject(mediaError(404, '媒体不存在'))
    const source = resolveListingMediaSource(listing, input.assetId, sourceOptions)
    const sourceKindMatches = source && (
      (source.kind === 'image' && kind === 'image') ||
      (source.kind === 'video' && (kind === 'video' || kind === 'cover'))
    )
    if (!sourceKindMatches || !verifyCapability(listingId, kind, source.objectKey, input.token, {
      scope: input.scope,
      audience: input.audience,
      stateKey: input.stateKey,
      assetId: source.assetId,
      mediaStateKey: source.mediaStateKey
    })) {
      return Promise.reject(mediaError(404, '媒体不存在'))
    }
    const objectKey = source.objectKey
    const requestedRange = parseSingleRange(req.headers && req.headers.range)
    if (requestedRange === false) {
      writeRangeRejected(res)
      return Promise.resolve()
    }
    let upstreamUrl
    let releaseConcurrency = null
    try {
      // 公共/owner、游客/登录、GET/HEAD、视频/封面和 Range 全部共享同一可信网络桶。
      releaseConcurrency = acquireConcurrency(input.clientKey)
      upstreamUrl = upstreamSignedUrl(objectKey, kind, method)
    } catch (error) {
      if (releaseConcurrency) releaseConcurrency()
      return Promise.reject(error)
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let upstreamReq = null
      let upstreamRes = null
      const cleanupListeners = () => {
        req.removeListener('aborted', onRequestAborted)
        res.removeListener('close', onResponseClose)
        res.removeListener('drain', onDrain)
      }
      const settle = (error) => {
        if (settled) return
        settled = true
        cleanupListeners()
        releaseConcurrency()
        if (error) reject(error)
        else resolve()
      }
      const abortUpstream = () => {
        try {
          if (upstreamReq && typeof upstreamReq.destroy === 'function') upstreamReq.destroy()
        } catch (error) {
          // 释放并发槽优先，销毁异常不得打断 settle。
        }
        try {
          if (upstreamRes && typeof upstreamRes.destroy === 'function') upstreamRes.destroy()
        } catch (error) {
          // 同上。
        }
      }
      const onRequestAborted = () => {
        abortUpstream()
        settle(mediaError(499, '客户端已断开'))
      }
      const onResponseClose = () => {
        if (!res.writableEnded) {
          abortUpstream()
          settle(mediaError(499, '客户端已断开'))
        }
      }
      const onDrain = () => {
        try {
          if (upstreamRes && !settled) upstreamRes.resume()
        } catch (error) {
          abortUpstream()
          settle(mediaError(502, '媒体源读取失败'))
        }
      }
      req.once('aborted', onRequestAborted)
      res.once('close', onResponseClose)
      res.on('drain', onDrain)

      const requestImpl = typeof options.requestImpl === 'function'
        ? options.requestImpl
        : (upstreamUrl.protocol === 'https:' ? https.request : http.request)
      const headers = {}
      if (requestedRange) headers.Range = requestedRange
      const handleUpstreamResponse = (received) => {
        if (settled) {
          try {
            received.destroy()
          } catch (error) {
            // 已结算的迟到响应只需尽力销毁。
          }
          return
        }
        upstreamRes = received
        try {
          const statusCode = Number(received.statusCode || 0)
          if (statusCode >= 300 && statusCode < 400) {
            abortUpstream()
            settle(mediaError(502, '媒体源不可用'))
            return
          }
          if (statusCode === 416 && requestedRange) {
            const total = parseUnsatisfiedContentRange(received.headers['content-range'])
            abortUpstream()
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
            abortUpstream()
            settle(mediaError(502, '媒体源响应无效'))
            return
          }
          const contentType = allowedContentType(kind, received.headers['content-type'], objectKey)
          const contentLength = parseContentLength(received.headers['content-length'])
          if (!contentType || contentLength === null || contentLength > maxBytes) {
            abortUpstream()
            settle(mediaError(502, '媒体源响应无效'))
            return
          }
          let contentRange = null
          if (statusCode === 206) {
            contentRange = parseContentRange(received.headers['content-range'])
            if (!contentRange || contentRange.total > maxBytes || contentRange.end - contentRange.start + 1 !== contentLength) {
              abortUpstream()
              settle(mediaError(502, '媒体源响应无效'))
              return
            }
          }
          const videoMetadata = videoMediaMetadata(objectKey)
          const imageMetadata = imageMediaMetadata(objectKey)
          const responseHeaders = {
            'Content-Type': contentType,
            'Content-Length': String(contentLength),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-store, no-transform',
            'Content-Disposition': kind === 'cover'
              ? 'inline; filename="listing-cover.jpg"'
              : (kind === 'image'
                  ? `inline; filename="listing-image.${imageMetadata.extension}"`
                  : `inline; filename="listing-video.${videoMetadata.extension}"`),
            Vary: 'Range',
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*'
          }
          if (contentRange) responseHeaders['Content-Range'] = `bytes ${contentRange.start}-${contentRange.end}/${contentRange.total}`
          res.writeHead(statusCode, responseHeaders)
          if (method === 'HEAD') {
            abortUpstream()
            res.end()
            settle()
            return
          }

          let bytesWritten = 0
          received.on('data', (chunk) => {
            if (settled) return
            try {
              bytesWritten += chunk.length
              if (bytesWritten > contentLength || bytesWritten > maxBytes) {
                abortUpstream()
                res.destroy()
                settle(mediaError(502, '媒体源响应无效'))
                return
              }
              if (!res.write(chunk)) received.pause()
            } catch (error) {
              abortUpstream()
              res.destroy()
              settle(mediaError(502, '媒体源读取失败'))
            }
          })
          received.on('end', () => {
            if (settled) return
            try {
              if (bytesWritten !== contentLength) {
                res.destroy()
                settle(mediaError(502, '媒体源响应无效'))
                return
              }
              res.end()
              settle()
            } catch (error) {
              abortUpstream()
              res.destroy()
              settle(mediaError(502, '媒体源读取失败'))
            }
          })
          received.on('aborted', () => {
            if (!settled) {
              abortUpstream()
              res.destroy()
              settle(mediaError(502, '媒体源响应中断'))
            }
          })
          received.on('error', () => {
            if (!settled) {
              abortUpstream()
              res.destroy()
              settle(mediaError(502, '媒体源读取失败'))
            }
          })
        } catch (error) {
          abortUpstream()
          if (res.headersSent && !res.destroyed) res.destroy()
          settle(mediaError(502, '媒体源响应无效'))
        }
      }

      try {
        upstreamReq = requestImpl(upstreamUrl, { method, headers }, handleUpstreamResponse)
        if (!upstreamReq || typeof upstreamReq.on !== 'function' || typeof upstreamReq.end !== 'function') {
          throw new Error('invalid upstream request')
        }
        upstreamReq.setTimeout(timeoutMs, () => {
          abortUpstream()
          settle(mediaError(504, '媒体源响应超时'))
        })
        upstreamReq.on('error', () => {
          abortUpstream()
          settle(mediaError(502, '媒体源连接失败'))
        })
        upstreamReq.end()
      } catch (error) {
        abortUpstream()
        settle(mediaError(502, '媒体源连接失败'))
      }
    })
  }

  return {
    urlsForListing,
    verifyCapability,
    serve,
    concurrencyState: () => ({ activeRequests, activeClients: activeRequestsByClient.size })
  }
}

module.exports = {
  createPublicListingMediaService,
  resolveManagedVideoObjectKey,
  normalizedListingMediaAssets,
  resolveListingMediaSource,
  normalizeManagedObjectKey,
  parseSingleRange,
  isSecureSameOrigin
}
