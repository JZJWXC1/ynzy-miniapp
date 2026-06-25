const crypto = require('crypto')
const https = require('https')
const path = require('path')
const config = require('./config')

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function safeName(fileName, defaultExt) {
  const ext = path.extname(fileName || '').toLowerCase() || defaultExt || '.mp4'
  const base = path
    .basename(fileName || 'listing-video', ext)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${base || 'listing-video'}${ext}`
}

function createObjectKey(fileName, uploadDir, defaultExt) {
  const date = new Date()
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`
  return `${uploadDir || config.oss.uploadDir}/${y}${m}${d}/${stamp}-${safeName(fileName, defaultExt)}`
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

function missingConfigKeys() {
  const missing = []
  if (!config.oss.bucket) missing.push('ALI_OSS_BUCKET')
  if (!config.oss.region) missing.push('ALI_OSS_REGION')
  if (!config.oss.accessKeyId) missing.push('ALI_OSS_ACCESS_KEY_ID')
  if (!config.oss.accessKeySecret) missing.push('ALI_OSS_ACCESS_KEY_SECRET')
  return missing
}

function createSignedReadUrl(objectKey, expiresInSeconds) {
  if (!objectKey || missingConfigKeys().length) {
    return objectKey ? publicFileUrl(objectKey) : ''
  }

  const expires = Math.floor(Date.now() / 1000) + (expiresInSeconds || config.oss.readUrlExpireSeconds)
  const resourcePath = `/${config.oss.bucket}/${objectKey}`
  const stringToSign = ['GET', '', '', String(expires), resourcePath].join('\n')
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

function putObjectBuffer(objectKey, buffer, contentType) {
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
  const stringToSign = ['PUT', '', type, date, resourcePath].join('\n')
  const signature = signOssString(stringToSign)
  const encodedPath = `/${encodeObjectPath(objectKey)}`

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'PUT',
      hostname: `${config.oss.bucket}.${config.oss.region}.aliyuncs.com`,
      path: encodedPath,
      headers: {
        Authorization: `OSS ${config.oss.accessKeyId}:${signature}`,
        Date: date,
        'Content-Type': type,
        'Content-Length': body.length
      }
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
        const error = new Error(raw || `OSS 上传失败：${res.statusCode}`)
        error.statusCode = res.statusCode || 502
        reject(error)
      })
    })
    req.on('error', reject)
    req.end(body)
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
      ['starts-with', '$key', `${config.oss.uploadDir}/`],
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
      ['starts-with', '$key', `${uploadDir}/`],
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
  putObjectBuffer
}
