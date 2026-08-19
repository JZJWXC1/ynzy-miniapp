'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const {
  boundedInteger,
  isAbsolutePathForPlatform,
  buildFfmpegSpawnOptions,
  safeDestroy,
  safeKill,
  safeCloseFd
} = require('./ffmpeg-sandbox')

const MEBIBYTE = 1024 * 1024
const GIBIBYTE = 1024 * MEBIBYTE
const PROFILE_ID = 'feishu-note-serving-v2'
const TEMP_PREFIX = 'ynzy-note-material-normalize-'
const PREPARED_FILE_HANDLE = Symbol('ynzyPreparedMaterialFile')
const CHILD_CLEANUP_TIMEOUT_MS = 5000
const VIDEO_OUTPUT_BUDGET_RATIO = 0.85
const VIDEO_AUDIO_BITRATE = 128000
const VIDEO_MIN_BITRATE = 32000
const VIDEO_MAX_BITRATE = 6000000
const VIDEO_MAX_RATE_RATIO = 1.15
const VIDEO_BUFFER_RATIO = 2
const DEFAULT_MIN_FREE_BYTES = 256 * MEBIBYTE
const STALE_DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000
const STALE_RECOVERY_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_FFMPEG_PATH = process.platform === 'win32'
  ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ffmpeg.exe')
  : '/usr/bin/ffmpeg'
const DEFAULT_FFPROBE_PATH = process.platform === 'win32'
  ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ffprobe.exe')
  : '/usr/bin/ffprobe'

function normalizationError(code, statusCode, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key])
    return result
  }, {})
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function normalizeExtension(value) {
  const extension = String(value || '').trim().toLowerCase().replace(/^\./, '')
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : ''
}

function normalizeMimeType(value) {
  const mimeType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType) ? mimeType : ''
}

function normalizeSha256(value) {
  const digest = String(value || '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(digest) ? digest : ''
}

function configuredExtension(input) {
  const asset = input && input.asset && typeof input.asset === 'object' ? input.asset : {}
  const explicit = normalizeExtension(input && (input.extension || asset.extension))
  if (explicit) return explicit
  const name = String(asset.name || asset.fileName || '').trim()
  return normalizeExtension(path.extname(name))
}

function configuredMimeType(input) {
  const asset = input && input.asset && typeof input.asset === 'object' ? input.asset : {}
  const sourceEvidence = input && input.sourceEvidence && typeof input.sourceEvidence === 'object'
    ? input.sourceEvidence
    : {}
  return normalizeMimeType(
    sourceEvidence.contentType
      || sourceEvidence.mimeType
      || input.contentType
      || input.mimeType
      || asset.contentType
      || asset.mimeType
  )
}

function configuredKind(input, declaredMimeType) {
  const asset = input && input.asset && typeof input.asset === 'object' ? input.asset : {}
  const kind = String(input.kind || asset.kind || '').trim().toLowerCase()
  if (kind === 'video' || kind === 'image') return kind
  if (declaredMimeType.startsWith('video/')) return 'video'
  if (declaredMimeType.startsWith('image/')) return 'image'
  return ''
}

function sourceEvidenceFor(input) {
  const sourceEvidence = input && input.sourceEvidence && typeof input.sourceEvidence === 'object'
    ? input.sourceEvidence
    : {}
  return {
    ...sourceEvidence,
    downloadToFile: sourceEvidence.downloadToFile || input.downloadToFile
  }
}

function sniffFormat(header) {
  if (!Buffer.isBuffer(header)) return null
  if (header.length >= 12 && header.toString('ascii', 4, 8) === 'ftyp') {
    return {
      kind: 'video',
      format: 'mp4',
      extension: 'mp4',
      mimeType: 'video/mp4',
      demuxer: 'mov'
    }
  }
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return {
      kind: 'video',
      format: 'webm',
      extension: 'webm',
      mimeType: 'video/webm',
      demuxer: 'matroska,webm'
    }
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return {
      kind: 'image',
      format: 'jpeg',
      extension: 'jpg',
      mimeType: 'image/jpeg',
      demuxer: 'image2pipe'
    }
  }
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      kind: 'image',
      format: 'png',
      extension: 'png',
      mimeType: 'image/png',
      demuxer: 'image2pipe'
    }
  }
  if (
    header.length >= 12
    && header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return {
      kind: 'image',
      format: 'webp',
      extension: 'webp',
      mimeType: 'image/webp',
      demuxer: 'image2pipe'
    }
  }
  if (header.length >= 6 && /^(?:GIF87a|GIF89a)$/.test(header.toString('ascii', 0, 6))) {
    return {
      kind: 'image',
      format: 'gif',
      extension: 'gif',
      mimeType: 'image/gif',
      demuxer: 'gif'
    }
  }
  return null
}

function mimeMatchesFormat(mimeType, format) {
  if (!mimeType || mimeType === 'application/octet-stream') return true
  const allowed = {
    mp4: new Set(['video/mp4', 'video/quicktime', 'video/x-m4v']),
    webm: new Set(['video/webm']),
    jpeg: new Set(['image/jpeg', 'image/jpg']),
    png: new Set(['image/png']),
    webp: new Set(['image/webp']),
    gif: new Set(['image/gif'])
  }
  return Boolean(allowed[format] && allowed[format].has(mimeType))
}

function parseRate(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  const match = text.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
  if (!match) return 0
  const denominator = Number(match[2])
  return denominator > 0 ? Number(match[1]) / denominator : 0
}

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function summarizeProbe(rawProbe, detectedFormat) {
  if (!rawProbe || typeof rawProbe !== 'object' || !Array.isArray(rawProbe.streams)) {
    throw normalizationError('MATERIAL_PROBE_INVALID', 422, '素材格式无法安全识别')
  }
  if (rawProbe.streams.length < 1 || rawProbe.streams.length > 8) {
    throw normalizationError('MATERIAL_STREAMS_INVALID', 422, '素材轨道数量不受支持')
  }
  const videoStreams = rawProbe.streams.filter((stream) => stream && stream.codec_type === 'video')
  const audioStreams = rawProbe.streams.filter((stream) => stream && stream.codec_type === 'audio')
  if (videoStreams.length !== 1) {
    throw normalizationError('MATERIAL_VIDEO_TRACK_INVALID', 422, '素材必须且只能包含一个画面轨道')
  }
  const video = videoStreams[0]
  const width = Number(video.width)
  const height = Number(video.height)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw normalizationError('MATERIAL_DIMENSIONS_INVALID', 422, '素材画面尺寸无效')
  }
  const durationSeconds = safeNumber(
    rawProbe.format && rawProbe.format.duration !== undefined
      ? rawProbe.format.duration
      : video.duration
  )
  const fps = parseRate(video.avg_frame_rate || video.r_frame_rate)
  const rawFrameCount = video.nb_read_frames !== undefined && video.nb_read_frames !== 'N/A'
    ? video.nb_read_frames
    : video.nb_frames
  const frameCount = Number(rawFrameCount)
  return {
    formatName: String(rawProbe.format && rawProbe.format.format_name || '').toLowerCase(),
    detectedFormat: detectedFormat.format,
    codec: String(video.codec_name || '').toLowerCase(),
    pixelFormat: String(video.pix_fmt || '').toLowerCase(),
    width,
    height,
    durationSeconds,
    fps,
    frameCount: Number.isSafeInteger(frameCount) && frameCount > 0 ? frameCount : 0,
    audioCodecs: audioStreams.map((stream) => String(stream.codec_name || '').toLowerCase()),
    streamCount: rawProbe.streams.length
  }
}

function assertProbeMatchesDetected(probe, detectedFormat) {
  const names = probe.formatName.split(',').map((name) => name.trim()).filter(Boolean)
  if (detectedFormat.format === 'mp4' && !names.some((name) => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name))) {
    throw normalizationError('MATERIAL_CONTAINER_MISMATCH', 422, '素材真实容器与文件声明不一致')
  }
  if (detectedFormat.format === 'webm' && !names.some((name) => ['matroska', 'webm'].includes(name))) {
    throw normalizationError('MATERIAL_CONTAINER_MISMATCH', 422, '素材真实容器与文件声明不一致')
  }
  const expectedImageCodec = {
    jpeg: 'mjpeg',
    png: 'png',
    webp: 'webp',
    gif: 'gif'
  }[detectedFormat.format]
  if (expectedImageCodec && probe.codec !== expectedImageCodec) {
    throw normalizationError('MATERIAL_CODEC_MISMATCH', 422, '素材真实编码与文件声明不一致')
  }
}

function buildProbeArgs(format) {
  const codecWhitelist = format.kind === 'video'
    ? 'h264,hevc,vp8,vp9,av1,aac,opus,mp3'
    : 'mjpeg,png,webp,gif'
  return [
    '-v', 'error',
    '-max_alloc', String(256 * MEBIBYTE),
    '-protocol_whitelist', 'fd,pipe',
    '-probesize', String(10 * MEBIBYTE),
    '-analyzeduration', '10000000',
    '-max_streams', '8',
    '-codec_whitelist', codecWhitelist,
    ...(format.kind === 'image' ? ['-count_frames'] : []),
    '-f', format.demuxer,
    '-fd', '3',
    '-i', 'fd:',
    '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,pix_fmt,width,height,duration,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames',
    '-of', 'json'
  ]
}

function buildVideoEncodingBudget({ durationSeconds, hasAudio, maxOutputBytes }) {
  const duration = Number(durationSeconds)
  const outputBytes = Number(maxOutputBytes)
  if (!(duration > 0) || !Number.isSafeInteger(outputBytes) || outputBytes <= 0) {
    throw normalizationError('MATERIAL_OUTPUT_BUDGET_INVALID', 422, '视频压缩预算无效')
  }
  const totalBitsPerSecond = Math.floor((outputBytes * 8 * VIDEO_OUTPUT_BUDGET_RATIO) / duration)
  const audioBitsPerSecond = hasAudio ? VIDEO_AUDIO_BITRATE : 0
  const availableVideoBitsPerSecond = totalBitsPerSecond - audioBitsPerSecond
  if (availableVideoBitsPerSecond < VIDEO_MIN_BITRATE) {
    throw normalizationError('MATERIAL_OUTPUT_BUDGET_TOO_SMALL', 413, '视频时长与目标大小无法同时满足，请先缩短视频')
  }
  const videoBitsPerSecond = Math.min(VIDEO_MAX_BITRATE, availableVideoBitsPerSecond)
  return {
    videoBitsPerSecond,
    maxRateBitsPerSecond: Math.max(videoBitsPerSecond, Math.floor(videoBitsPerSecond * VIDEO_MAX_RATE_RATIO)),
    bufferBits: Math.max(videoBitsPerSecond, Math.floor(videoBitsPerSecond * VIDEO_BUFFER_RATIO)),
    audioBitsPerSecond
  }
}

function buildVideoTranscodeArgs(format, encoding = {}) {
  const videoBitsPerSecond = boundedInteger(
    encoding.videoBitsPerSecond,
    VIDEO_MAX_BITRATE,
    VIDEO_MIN_BITRATE,
    VIDEO_MAX_BITRATE
  )
  const maxRateBitsPerSecond = boundedInteger(
    encoding.maxRateBitsPerSecond,
    VIDEO_MAX_BITRATE,
    videoBitsPerSecond,
    VIDEO_MAX_BITRATE * 2
  )
  const bufferBits = boundedInteger(
    encoding.bufferBits,
    VIDEO_MAX_BITRATE * 2,
    videoBitsPerSecond,
    VIDEO_MAX_BITRATE * 4
  )
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-max_alloc', String(256 * MEBIBYTE),
    '-filter_threads', '1',
    '-filter_complex_threads', '1',
    '-protocol_whitelist', 'fd,pipe',
    '-probesize', String(10 * MEBIBYTE),
    '-analyzeduration', '10000000',
    '-max_streams', '8',
    '-threads', '1',
    '-codec_whitelist', 'h264,hevc,vp8,vp9,av1,aac,opus,mp3',
    '-max_pixels', String(4096 * 4096),
    '-f', format.demuxer,
    '-fd', '3',
    '-i', 'fd:',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-sn',
    '-dn',
    '-threads', '1',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', String(videoBitsPerSecond),
    '-pix_fmt', 'yuv420p',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-fpsmax', '30',
    '-maxrate', String(maxRateBitsPerSecond),
    '-bufsize', String(bufferBits),
    '-c:a', 'aac',
    '-b:a', String(VIDEO_AUDIO_BITRATE),
    '-max_muxing_queue_size', '1024',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  ]
}

function buildVideoSanitizeArgs(format, encoding = {}) {
  // 兼容 MP4 也必须重编码；仅转封装无法清除 H.264/AAC 码流包内的 SEI/user-data。
  return buildVideoTranscodeArgs(format, encoding)
}

function buildImageCompressArgs(format, options = {}) {
  const outputFormat = String(options.outputFormat || format.format)
  const codecArgs = outputFormat === 'jpeg'
    ? ['-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe']
    : outputFormat === 'png'
      ? ['-c:v', 'png', '-compression_level', '7', '-f', 'image2pipe']
      : ['-c:v', 'libwebp', '-quality', '82', '-f', 'webp']
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-max_alloc', String(256 * MEBIBYTE),
    '-filter_threads', '1',
    '-protocol_whitelist', 'fd,pipe',
    '-probesize', String(4 * MEBIBYTE),
    '-analyzeduration', '5000000',
    '-max_streams', '2',
    '-threads', '1',
    '-codec_whitelist', 'mjpeg,png,webp,gif',
    '-max_pixels', String(64 * 1024 * 1024),
    '-f', format.demuxer,
    '-fd', '3',
    '-i', 'fd:',
    '-map', '0:v:0',
    '-map_metadata', '-1',
    '-frames:v', '1',
    '-vf', "scale=w='min(2048,iw)':h='min(2048,ih)':force_original_aspect_ratio=decrease",
    '-threads', '1',
    ...codecArgs,
    'pipe:1'
  ]
}

function createSizeLimiter(maxBytes, onLimit) {
  let bytes = 0
  return new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        callback(onLimit())
        return
      }
      callback(null, chunk)
    }
  })
}

function remainingMilliseconds(deadline) {
  return Math.max(0, deadline - Date.now())
}

function deadlineRace(promise, deadline, onTimeout) {
  const remaining = remainingMilliseconds(deadline)
  if (remaining <= 0) {
    if (typeof onTimeout === 'function') onTimeout()
    return Promise.reject(normalizationError('MATERIAL_NORMALIZATION_TIMEOUT', 504, '素材处理超时，请稍后重试'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (typeof onTimeout === 'function') onTimeout()
      reject(normalizationError('MATERIAL_NORMALIZATION_TIMEOUT', 504, '素材处理超时，请稍后重试'))
    }, remaining)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve(promise).then((value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function hashFile(filePath, deadline) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  try {
    await deadlineRace((async () => {
      for await (const chunk of stream) hash.update(chunk)
    })(), deadline, () => safeDestroy(stream))
  } finally {
    safeDestroy(stream)
  }
  return hash.digest('hex')
}

async function readHeader(filePath) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function readFileRange(handle, length, position) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) {
    throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, '图片容器结构不完整')
  }
  return buffer
}

async function inspectPngContainer(filePath, fileSize) {
  const handle = await fs.promises.open(filePath, 'r')
  let position = 8
  let seenIhdr = false
  let seenIdat = false
  let seenIend = false
  let animationControl = false
  let animationFrames = 0
  let frameControlCount = 0
  let frameDataCount = 0
  try {
    while (position < fileSize) {
      if (fileSize - position < 12) {
        throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'PNG 容器尾部不完整')
      }
      const chunkHeader = await readFileRange(handle, 8, position)
      const chunkLength = chunkHeader.readUInt32BE(0)
      const chunkType = chunkHeader.toString('ascii', 4, 8)
      if (!/^[A-Za-z]{4}$/.test(chunkType) || chunkLength > fileSize - position - 12) {
        throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'PNG chunk 边界无效')
      }
      if (!seenIhdr && (chunkType !== 'IHDR' || chunkLength !== 13)) {
        throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'PNG 缺少有效 IHDR')
      }
      if (chunkType === 'IHDR') {
        if (seenIhdr || position !== 8 || chunkLength !== 13) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'PNG IHDR 重复或位置无效')
        }
        seenIhdr = true
      } else if (chunkType === 'IDAT') {
        if (!seenIhdr || seenIend) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'PNG IDAT 顺序无效')
        }
        seenIdat = true
      } else if (chunkType === 'acTL') {
        if (animationControl || seenIdat || chunkLength !== 8) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'APNG 动画控制块无效')
        }
        const payload = await readFileRange(handle, 8, position + 8)
        animationFrames = payload.readUInt32BE(0)
        if (animationFrames < 1) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'APNG 帧数无效')
        }
        animationControl = true
      } else if (chunkType === 'fcTL') {
        if (!animationControl || chunkLength !== 26 || seenIend) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'APNG 帧控制块无效')
        }
        frameControlCount += 1
      } else if (chunkType === 'fdAT') {
        if (!animationControl || chunkLength < 4 || seenIend) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'APNG 帧数据块无效')
        }
        frameDataCount += 1
      } else if (chunkType === 'IEND') {
        if (chunkLength !== 0 || seenIend || position + 12 !== fileSize) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'PNG IEND 边界无效')
        }
        seenIend = true
      }
      position += chunkLength + 12
    }
  } finally {
    await handle.close()
  }
  if (!seenIhdr || !seenIdat || !seenIend || position !== fileSize) {
    throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'PNG 容器结构不完整')
  }
  // 动画结构只负责严格验真；后续受控重编码固定 `-frames:v 1`，仅发布首帧静态预览。
  if ((animationControl || frameControlCount || frameDataCount)
    && (!animationControl || frameControlCount !== animationFrames || (animationFrames > 1 && frameDataCount < 1))) {
    throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'APNG 帧结构不一致')
  }
}

async function inspectWebpContainer(filePath, fileSize) {
  if (fileSize < 20) {
    throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP 容器结构不完整')
  }
  const handle = await fs.promises.open(filePath, 'r')
  let position = 12
  let firstChunk = true
  let hasImagePayload = false
  let animationFlag = false
  let animationHeaderCount = 0
  let animationFrameCount = 0
  try {
    const header = await readFileRange(handle, 12, 0)
    if (header.toString('ascii', 0, 4) !== 'RIFF'
      || header.toString('ascii', 8, 12) !== 'WEBP'
      || header.readUInt32LE(4) + 8 !== fileSize) {
      throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP RIFF 大小无效')
    }
    while (position < fileSize) {
      if (fileSize - position < 8) {
        throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP chunk 尾部不完整')
      }
      const chunkHeader = await readFileRange(handle, 8, position)
      const chunkType = chunkHeader.toString('ascii', 0, 4)
      const chunkLength = chunkHeader.readUInt32LE(4)
      const paddedLength = chunkLength + (chunkLength % 2)
      if (!/^[ -~]{4}$/.test(chunkType) || paddedLength > fileSize - position - 8) {
        throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP chunk 边界无效')
      }
      if (firstChunk && !['VP8 ', 'VP8L', 'VP8X'].includes(chunkType)) {
        throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP 首个图像块无效')
      }
      if (chunkType === 'VP8X') {
        if (!firstChunk || chunkLength !== 10) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP VP8X 块无效')
        }
        const payload = await readFileRange(handle, 10, position + 8)
        animationFlag = (payload[0] & 0x02) !== 0
      } else if (chunkType === 'VP8 ' || chunkType === 'VP8L') {
        hasImagePayload = true
      } else if (chunkType === 'ANIM') {
        if (chunkLength !== 6) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP ANIM 块无效')
        }
        animationHeaderCount += 1
      } else if (chunkType === 'ANMF') {
        if (chunkLength < 16) {
          throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP ANMF 块无效')
        }
        animationFrameCount += 1
        hasImagePayload = true
      }
      firstChunk = false
      position += 8 + paddedLength
    }
  } finally {
    await handle.close()
  }
  if (!hasImagePayload || position !== fileSize) {
    throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP 容器缺少有效图像数据')
  }
  const hasAnimationChunks = animationHeaderCount > 0 || animationFrameCount > 0
  if (animationFlag !== hasAnimationChunks
    || animationHeaderCount > 1
    || (hasAnimationChunks && (animationHeaderCount !== 1 || animationFrameCount < 1))) {
    throw normalizationError('MATERIAL_IMAGE_CONTAINER_INVALID', 422, 'WebP 动画标志与帧结构不一致')
  }
  // 合法动画继续交给固定 `-frames:v 1` 的受控重编码，只发布首帧静态预览。
}

async function inspectImageContainer(filePath, format, fileSize) {
  if (format.format === 'png') return inspectPngContainer(filePath, fileSize)
  if (format.format === 'webp') return inspectWebpContainer(filePath, fileSize)
  return null
}

async function assertFreeSpace(statfsImpl, rootPath, requiredBytes) {
  let stats
  try {
    stats = await statfsImpl(rootPath)
  } catch (error) {
    throw normalizationError('MATERIAL_STORAGE_CAPACITY_UNKNOWN', 507, '无法确认素材临时存储剩余空间')
  }
  const blockSize = Number(stats && (stats.bsize || stats.frsize))
  const availableBlocks = Number(stats && (stats.bavail === undefined ? stats.bfree : stats.bavail))
  const availableBytes = blockSize * availableBlocks
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 1
    || !Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw normalizationError('MATERIAL_STORAGE_CAPACITY_LOW', 507, '素材临时存储空间不足，请稍后重试')
  }
  return availableBytes
}

async function fingerprintFile(filePath, platform, deadline) {
  if (!isAbsolutePathForPlatform(filePath, platform)) {
    throw normalizationError('MATERIAL_TOOL_UNAVAILABLE', 503, '服务器素材处理组件配置无效')
  }
  let realPath
  let stats
  try {
    realPath = await fs.promises.realpath(filePath)
    stats = await fs.promises.stat(realPath)
  } catch (error) {
    throw normalizationError('MATERIAL_TOOL_UNAVAILABLE', 503, '服务器素材处理组件不可用')
  }
  if (!stats.isFile() || stats.size <= 0 || (platform !== 'win32' && (stats.mode & 0o111) === 0)) {
    throw normalizationError('MATERIAL_TOOL_UNAVAILABLE', 503, '服务器素材处理组件不可用')
  }
  const digest = await hashFile(realPath, deadline)
  return { digest, bytes: stats.size }
}

async function cleanupPrivateDirectory(directory, tempRoot) {
  if (!directory) return
  const resolved = path.resolve(directory)
  const root = path.resolve(tempRoot)
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw normalizationError('MATERIAL_STORAGE_CLEANUP_FAILED', 507, '服务器素材临时文件清理边界无效')
  }
  try {
    await fs.promises.rm(resolved, { recursive: true, force: true })
  } catch (error) {
    throw normalizationError('MATERIAL_STORAGE_CLEANUP_FAILED', 507, '服务器素材临时文件清理失败')
  }
}

function processAppearsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

async function createPrivateDirectory(tempRoot) {
  let rootStats
  let realRoot
  try {
    realRoot = await fs.promises.realpath(tempRoot)
    rootStats = await fs.promises.stat(realRoot)
  } catch (error) {
    throw normalizationError('MATERIAL_STORAGE_UNAVAILABLE', 507, '服务器素材临时存储不可用')
  }
  if (!rootStats.isDirectory() || !path.isAbsolute(realRoot)) {
    throw normalizationError('MATERIAL_STORAGE_UNAVAILABLE', 507, '服务器素材临时存储不可用')
  }
  let directory = ''
  try {
    directory = await fs.promises.mkdtemp(path.join(realRoot, `${TEMP_PREFIX}${process.pid}-`))
    await fs.promises.chmod(directory, 0o700)
    return { directory, realRoot }
  } catch (error) {
    if (directory) {
      try {
        await cleanupPrivateDirectory(directory, realRoot)
      } catch (cleanupError) {
        throw cleanupError
      }
    }
    throw normalizationError('MATERIAL_STORAGE_UNAVAILABLE', 507, '服务器素材临时存储不可用')
  }
}

function declaredSourceEvidence(input, sourceEvidence) {
  const asset = input.asset && typeof input.asset === 'object' ? input.asset : {}
  const declaredSizeValue = sourceEvidence.size === undefined ? asset.size : sourceEvidence.size
  const declaredSize = declaredSizeValue === undefined || declaredSizeValue === null || declaredSizeValue === ''
    ? null
    : Number(declaredSizeValue)
  if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize <= 0)) {
    throw normalizationError('MATERIAL_SOURCE_EVIDENCE_INVALID', 422, '素材大小凭据无效')
  }
  const rawDigest = sourceEvidence.contentSha256 || sourceEvidence.sha256 || asset.contentSha256 || ''
  const declaredDigest = rawDigest ? normalizeSha256(rawDigest) : ''
  if (rawDigest && !declaredDigest) {
    throw normalizationError('MATERIAL_SOURCE_EVIDENCE_INVALID', 422, '素材摘要凭据无效')
  }
  return { declaredSize, declaredDigest }
}

async function spoolSource({ input, sourceEvidence, sourcePath, maxBytes, deadline }) {
  const declarations = declaredSourceEvidence(input, sourceEvidence)
  if (declarations.declaredSize !== null && declarations.declaredSize > maxBytes) {
    throw normalizationError('MATERIAL_SOURCE_TOO_LARGE', 413, '源素材超过处理大小限制')
  }

  let receipt = null
  if (typeof sourceEvidence.downloadToFile === 'function') {
    let handle = null
    const controller = new AbortController()
    try {
      handle = await fs.promises.open(sourcePath, 'wx', 0o600)
      receipt = await deadlineRace(
        sourceEvidence.downloadToFile({
          fileHandle: handle,
          maxBytes,
          signal: controller.signal
        }),
        deadline,
        () => {
          controller.abort()
          if (handle) handle.close().catch(() => {})
        }
      )
      await handle.sync()
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
    if (!receipt || typeof receipt !== 'object') {
      throw normalizationError('MATERIAL_SOURCE_EVIDENCE_INVALID', 422, '源素材下载缺少完整回执')
    }
  } else {
    let source = null
    if (Buffer.isBuffer(sourceEvidence.buffer)) {
      source = Readable.from([Buffer.from(sourceEvidence.buffer)])
    } else if (typeof sourceEvidence.createReadStream === 'function') {
      source = sourceEvidence.createReadStream({ maxBytes })
    } else if (sourceEvidence.stream && typeof sourceEvidence.stream.pipe === 'function') {
      source = sourceEvidence.stream
    }
    if (!source || typeof source.pipe !== 'function') {
      throw normalizationError('MATERIAL_SOURCE_MISSING', 422, '缺少可读取的源素材')
    }
    const writer = fs.createWriteStream(sourcePath, { flags: 'wx', mode: 0o600 })
    const limiter = createSizeLimiter(maxBytes, () => normalizationError(
      'MATERIAL_SOURCE_TOO_LARGE',
      413,
      '源素材超过处理大小限制'
    ))
    await deadlineRace(
      pipeline(source, limiter, writer),
      deadline,
      () => {
        safeDestroy(source)
        safeDestroy(limiter)
        safeDestroy(writer)
      }
    )
  }

  let stats
  try {
    stats = await fs.promises.stat(sourcePath)
  } catch (error) {
    throw normalizationError('MATERIAL_SOURCE_UNAVAILABLE', 422, '源素材下载未形成完整文件')
  }
  if (!stats.isFile() || stats.size <= 0) {
    throw normalizationError('MATERIAL_SOURCE_EMPTY', 422, '源素材内容为空')
  }
  if (stats.size > maxBytes) {
    throw normalizationError('MATERIAL_SOURCE_TOO_LARGE', 413, '源素材超过处理大小限制')
  }
  if ((stats.mode & 0o077) !== 0) {
    await fs.promises.chmod(sourcePath, 0o600)
  }
  const digest = await hashFile(sourcePath, deadline)
  if (declarations.declaredSize !== null && declarations.declaredSize !== stats.size) {
    throw normalizationError('MATERIAL_SOURCE_SIZE_MISMATCH', 422, '源素材大小与下载凭据不一致')
  }
  if (declarations.declaredDigest && declarations.declaredDigest !== digest) {
    throw normalizationError('MATERIAL_SOURCE_DIGEST_MISMATCH', 422, '源素材摘要与下载凭据不一致')
  }
  if (receipt) {
    const receiptSize = Number(receipt.size)
    const receiptDigest = normalizeSha256(receipt.contentSha256)
    const receiptType = normalizeMimeType(receipt.contentType || receipt.mimeType)
    if (!Number.isSafeInteger(receiptSize) || receiptSize <= 0 || !receiptDigest || !receiptType) {
      throw normalizationError('MATERIAL_SOURCE_EVIDENCE_INVALID', 422, '源素材下载回执不完整')
    }
    if (receiptSize !== stats.size) {
      throw normalizationError('MATERIAL_SOURCE_SIZE_MISMATCH', 422, '源素材大小与下载回执不一致')
    }
    if (receiptDigest !== digest) {
      throw normalizationError('MATERIAL_SOURCE_DIGEST_MISMATCH', 422, '源素材摘要与下载回执不一致')
    }
  }
  return {
    size: stats.size,
    contentSha256: digest,
    receiptContentType: normalizeMimeType(receipt && (receipt.contentType || receipt.mimeType))
  }
}

function runChildProcessCapture({
  command,
  args,
  inputPath,
  maxStdoutBytes,
  maxStderrBytes,
  deadline,
  spawnImpl,
  spawnContext
}) {
  return new Promise((resolve, reject) => {
    let inputFd = null
    let child = null
    let settled = false
    let finishing = false
    let childClosed = false
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutChunks = []
    let timer = null
    let cleanupTimer = null

    const settle = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (cleanupTimer) clearTimeout(cleanupTimer)
      safeCloseFd(inputFd)
      inputFd = null
      if (error) reject(error)
      else resolve(value)
    }

    const finish = (error, value) => {
      if (settled || finishing) return
      if (!error) {
        settle(null, value)
        return
      }
      if (!child || childClosed || typeof child.once !== 'function') {
        safeKill(child)
        settle(error)
        return
      }
      finishing = true
      if (timer) clearTimeout(timer)
      safeCloseFd(inputFd)
      inputFd = null
      const concludeAfterClose = () => {
        childClosed = true
        settle(error)
      }
      child.once('close', concludeAfterClose)
      cleanupTimer = setTimeout(() => {
        settle(normalizationError(
          'MATERIAL_TOOL_CLEANUP_TIMEOUT',
          507,
          '素材处理进程未能安全退出，已停止本次同步'
        ))
      }, CHILD_CLEANUP_TIMEOUT_MS)
      safeDestroy(child.stdout)
      safeDestroy(child.stderr)
      safeKill(child)
    }

    try {
      inputFd = fs.openSync(inputPath, 'r')
      const spawnOptions = buildFfmpegSpawnOptions({
        ...spawnContext,
        inputFd
      })
      child = spawnImpl(command, args, spawnOptions)
      safeCloseFd(inputFd)
      inputFd = null
    } catch (error) {
      finish(normalizationError('MATERIAL_TOOL_START_FAILED', 503, '服务器素材处理组件启动失败'))
      return
    }

    if (!child || !child.stdout || !child.stderr || typeof child.once !== 'function') {
      finish(normalizationError('MATERIAL_TOOL_START_FAILED', 503, '服务器素材处理组件启动失败'))
      return
    }

    const remaining = remainingMilliseconds(deadline)
    if (remaining <= 0) {
      finish(normalizationError('MATERIAL_NORMALIZATION_TIMEOUT', 504, '素材处理超时，请稍后重试'))
      return
    }
    timer = setTimeout(() => {
      finish(normalizationError('MATERIAL_NORMALIZATION_TIMEOUT', 504, '素材处理超时，请稍后重试'))
    }, remaining)
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout.on('data', (chunk) => {
      if (settled || finishing) return
      const buffer = Buffer.from(chunk)
      stdoutBytes += buffer.length
      if (stdoutBytes > maxStdoutBytes) {
        finish(normalizationError('MATERIAL_OUTPUT_TOO_LARGE', 413, '处理后的素材仍超过上传大小限制'))
        return
      }
      stdoutChunks.push(buffer)
    })
    child.stderr.on('data', (chunk) => {
      if (settled || finishing) return
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > maxStderrBytes) {
        finish(normalizationError('MATERIAL_TOOL_DIAGNOSTIC_OVERFLOW', 422, '素材处理组件返回异常'))
      }
    })
    child.stdout.once('error', () => {
      finish(normalizationError('MATERIAL_TOOL_FAILED', 422, '素材处理失败，请检查源文件'))
    })
    child.stderr.once('error', () => {
      finish(normalizationError('MATERIAL_TOOL_FAILED', 422, '素材处理失败，请检查源文件'))
    })
    child.once('error', () => {
      finish(normalizationError('MATERIAL_TOOL_START_FAILED', 503, '服务器素材处理组件启动失败'))
    })
    child.once('close', (code) => {
      childClosed = true
      if (settled || finishing) return
      if (code !== 0) {
        finish(normalizationError('MATERIAL_TOOL_FAILED', 422, '素材处理失败，请检查源文件'))
        return
      }
      finish(null, Buffer.concat(stdoutChunks, stdoutBytes))
    })
  })
}

async function runChildProcessToFile({
  command,
  args,
  inputPath,
  outputPath,
  maxOutputBytes,
  maxStderrBytes,
  deadline,
  spawnImpl,
  spawnContext
}) {
  let inputFd = null
  let child = null
  let childClosed = false
  let outputStream = null
  let limiter = null
  let closePromise = null
  const hash = crypto.createHash('sha256')
  let outputBytes = 0
  try {
    inputFd = fs.openSync(inputPath, 'r')
    const spawnOptions = buildFfmpegSpawnOptions({
      ...spawnContext,
      inputFd
    })
    child = spawnImpl(command, args, spawnOptions)
    safeCloseFd(inputFd)
    inputFd = null
    if (!child || !child.stdout || !child.stderr || typeof child.once !== 'function') {
      throw normalizationError('MATERIAL_TOOL_START_FAILED', 503, '服务器素材处理组件启动失败')
    }

    outputStream = fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    limiter = new Transform({
      transform(chunk, encoding, callback) {
        const buffer = Buffer.from(chunk)
        if (buffer.length > maxOutputBytes - outputBytes) {
          callback(normalizationError('MATERIAL_OUTPUT_TOO_LARGE', 413, '处理后的素材仍超过上传大小限制'))
          return
        }
        outputBytes += buffer.length
        hash.update(buffer)
        callback(null, buffer)
      }
    })
    const stderrPromise = new Promise((resolve, reject) => {
      let stderrBytes = 0
      child.stderr.on('data', (chunk) => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > maxStderrBytes) {
          reject(normalizationError('MATERIAL_TOOL_DIAGNOSTIC_OVERFLOW', 422, '素材处理组件返回异常'))
        }
      })
      child.stderr.once('end', resolve)
      child.stderr.once('error', () => {
        reject(normalizationError('MATERIAL_TOOL_FAILED', 422, '素材处理失败，请检查源文件'))
      })
    })
    closePromise = new Promise((resolve, reject) => {
      child.once('error', () => {
        reject(normalizationError('MATERIAL_TOOL_START_FAILED', 503, '服务器素材处理组件启动失败'))
      })
      child.once('close', (code) => {
        childClosed = true
        resolve(code)
      })
    })
    const copyPromise = pipeline(child.stdout, limiter, outputStream)
    const [code] = await deadlineRace(
      Promise.all([closePromise, copyPromise, stderrPromise]),
      deadline,
      () => {
        safeDestroy(child.stdout)
        safeDestroy(child.stderr)
        safeDestroy(limiter)
        safeDestroy(outputStream)
        safeKill(child)
      }
    )
    if (code !== 0) {
      throw normalizationError('MATERIAL_TOOL_FAILED', 422, '素材处理失败，请检查源文件')
    }
    if (outputBytes <= 0) {
      throw normalizationError('MATERIAL_OUTPUT_INVALID', 422, '素材处理结果为空')
    }
    const stats = await fs.promises.stat(outputPath)
    if (!stats.isFile() || stats.size !== outputBytes || stats.size > maxOutputBytes) {
      throw normalizationError('MATERIAL_OUTPUT_INVALID', 422, '素材处理结果大小无效')
    }
    if ((stats.mode & 0o077) !== 0) await fs.promises.chmod(outputPath, 0o600)
    return {
      contentSha256: hash.digest('hex'),
      size: outputBytes
    }
  } catch (error) {
    safeCloseFd(inputFd)
    inputFd = null
    safeDestroy(child && child.stdout)
    safeDestroy(child && child.stderr)
    safeDestroy(limiter)
    safeDestroy(outputStream)
    safeKill(child)
    if (child && !childClosed && closePromise) {
      let cleanupTimer = null
      try {
        await Promise.race([
          closePromise.catch(() => null),
          new Promise((_, reject) => {
            cleanupTimer = setTimeout(() => reject(normalizationError(
              'MATERIAL_TOOL_CLEANUP_TIMEOUT',
              507,
              '素材处理进程未能安全退出，已停止本次同步'
            )), CHILD_CLEANUP_TIMEOUT_MS)
          })
        ])
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer)
      }
    }
    if (error && error.code && Number.isSafeInteger(error.statusCode)) throw error
    throw normalizationError('MATERIAL_TOOL_FAILED', 422, '素材处理失败，请检查源文件')
  } finally {
    safeCloseFd(inputFd)
  }
}

function assertSourceProbe(probe, format, limits) {
  assertProbeMatchesDetected(probe, format)
  if (format.kind === 'video') {
    if (probe.width > limits.maxSourceVideoEdge || probe.height > limits.maxSourceVideoEdge) {
      throw normalizationError('MATERIAL_DIMENSIONS_TOO_LARGE', 413, '源视频画面尺寸超过处理限制')
    }
    if (probe.width * probe.height > limits.maxSourceVideoPixels) {
      throw normalizationError('MATERIAL_DIMENSIONS_TOO_LARGE', 413, '源视频画面像素超过处理限制')
    }
    if (!(probe.durationSeconds > 0) || probe.durationSeconds > limits.maxVideoDurationSeconds) {
      throw normalizationError('MATERIAL_DURATION_INVALID', 413, '源视频时长超过处理限制或无法识别')
    }
    if (!(probe.fps > 0) || probe.fps > 240) {
      throw normalizationError('MATERIAL_FRAME_RATE_INVALID', 422, '源视频帧率无效')
    }
    return
  }
  if (probe.width * probe.height > limits.maxSourceImagePixels) {
    throw normalizationError('MATERIAL_DIMENSIONS_TOO_LARGE', 413, '源图片像素超过处理限制')
  }
}

function isCompatibleMp4(input, source, probe, format, limits) {
  const extension = configuredExtension(input)
  const declaredMimeType = configuredMimeType(input)
  return format.format === 'mp4'
    && extension === 'mp4'
    && declaredMimeType === 'video/mp4'
    && source.size <= limits.maxVideoPassthroughBytes
    && probe.codec === 'h264'
    && probe.pixelFormat === 'yuv420p'
    && probe.width <= limits.maxOutputVideoWidth
    && probe.height <= limits.maxOutputVideoHeight
    && probe.fps <= limits.maxOutputVideoFps
    && probe.audioCodecs.every((codec) => codec === 'aac')
}

function assertNormalizedVideo(sourceProbe, outputProbe, limits) {
  if (outputProbe.detectedFormat !== 'mp4'
    || outputProbe.codec !== 'h264'
    || outputProbe.pixelFormat !== 'yuv420p'
    || outputProbe.width > limits.maxOutputVideoWidth
    || outputProbe.height > limits.maxOutputVideoHeight
    || !(outputProbe.fps > 0)
    || outputProbe.fps > limits.maxOutputVideoFps
    || outputProbe.audioCodecs.some((codec) => codec !== 'aac')) {
    throw normalizationError('MATERIAL_OUTPUT_INVALID', 422, '处理后的视频不符合小程序播放规范')
  }
  const durationTolerance = Math.max(1, sourceProbe.durationSeconds * 0.03)
  if (!(outputProbe.durationSeconds > 0)
    || Math.abs(outputProbe.durationSeconds - sourceProbe.durationSeconds) > durationTolerance) {
    throw normalizationError('MATERIAL_OUTPUT_TRUNCATED', 422, '处理后的视频时长与源视频不一致')
  }
}

function assertNormalizedImage(outputProbe, outputFormat, limits) {
  assertProbeMatchesDetected(outputProbe, outputFormat)
  if (outputProbe.frameCount !== 1
    || outputProbe.width > limits.maxOutputImageEdge
    || outputProbe.height > limits.maxOutputImageEdge) {
    throw normalizationError('MATERIAL_OUTPUT_INVALID', 422, '处理后的图片不符合单帧与尺寸限制')
  }
}

function outputDescriptor(format, action) {
  if (action === 'transcode') {
    return { extension: 'mp4', contentType: 'video/mp4' }
  }
  return { extension: format.extension, contentType: format.mimeType }
}

function createFeishuNoteMaterialNormalizer(options = {}) {
  const platform = options.platform || process.platform
  const runtimeEnv = options.env || process.env
  const ffmpegPath = String(options.ffmpegPath || runtimeEnv.NOTE_MATERIAL_FFMPEG_PATH || DEFAULT_FFMPEG_PATH).trim()
  const ffprobePath = String(options.ffprobePath || runtimeEnv.NOTE_MATERIAL_FFPROBE_PATH || DEFAULT_FFPROBE_PATH).trim()
  const configuredTempRoot = String(options.tempRoot || os.tmpdir()).trim()
  const tempRoot = path.isAbsolute(configuredTempRoot) ? configuredTempRoot : ''
  const spawnImpl = options.spawnImpl || spawn
  const statfsImpl = options.statfsImpl || fs.promises.statfs.bind(fs.promises)
  const maxConcurrent = 1
  const limits = Object.freeze({
    timeoutMs: boundedInteger(options.timeoutMs, 15 * 60 * 1000, 20, 15 * 60 * 1000),
    maxVideoSourceBytes: boundedInteger(options.maxVideoSourceBytes, GIBIBYTE, 1, GIBIBYTE),
    maxImageSourceBytes: boundedInteger(options.maxImageSourceBytes, 50 * MEBIBYTE, 1, 100 * MEBIBYTE),
    maxVideoPassthroughBytes: boundedInteger(options.maxVideoPassthroughBytes, 80 * MEBIBYTE, 1, 300 * MEBIBYTE),
    maxVideoOutputBytes: boundedInteger(options.maxVideoOutputBytes, 80 * MEBIBYTE, 1, 300 * MEBIBYTE),
    maxImageOutputBytes: boundedInteger(options.maxImageOutputBytes, 8 * MEBIBYTE, 1, 50 * MEBIBYTE),
    maxVideoDurationSeconds: boundedInteger(options.maxVideoDurationSeconds, 15 * 60, 1, 15 * 60),
    maxSourceVideoEdge: boundedInteger(options.maxSourceVideoEdge, 4096, 1, 8192),
    maxSourceVideoPixels: boundedInteger(options.maxSourceVideoPixels, 4096 * 4096, 1, 8192 * 8192),
    maxSourceImagePixels: boundedInteger(options.maxSourceImagePixels, 64 * 1024 * 1024, 1, 100 * 1024 * 1024),
    maxOutputVideoWidth: boundedInteger(options.maxOutputVideoWidth, 1920, 1, 4096),
    maxOutputVideoHeight: boundedInteger(options.maxOutputVideoHeight, 1080, 1, 4096),
    maxOutputVideoFps: boundedInteger(options.maxOutputVideoFps, 30, 1, 60),
    maxOutputImageEdge: boundedInteger(options.maxOutputImageEdge, 2048, 1, 4096),
    minFreeBytes: boundedInteger(options.minFreeBytes, DEFAULT_MIN_FREE_BYTES, 1, 10 * GIBIBYTE),
    maxProbeOutputBytes: boundedInteger(options.maxProbeOutputBytes, 256 * 1024, 1024, MEBIBYTE),
    maxDiagnosticBytes: boundedInteger(options.maxDiagnosticBytes, 64 * 1024, 1024, MEBIBYTE)
  })
  if (limits.maxVideoPassthroughBytes > limits.maxVideoOutputBytes) {
    throw normalizationError(
      'MATERIAL_CONFIGURATION_INVALID',
      500,
      '视频原样通过上限不得大于统一成品上限'
    )
  }
  const spawnContext = {
    platform,
    env: runtimeEnv,
    currentUid: options.currentUid,
    uid: options.uid,
    gid: options.gid
  }
  let activeOperations = 0
  let profilePromise = null
  const preparedFiles = new Map()
  let recoveryPromise = null
  let lastRecoveryAt = 0

  async function recoverStaleDirectories(options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
    let realRoot
    let entries
    try {
      realRoot = await fs.promises.realpath(tempRoot)
      entries = await fs.promises.readdir(realRoot, { withFileTypes: true })
    } catch (error) {
      throw normalizationError('MATERIAL_STORAGE_UNAVAILABLE', 507, '服务器素材临时存储不可用')
    }
    const activeDirectories = new Set(Array.from(preparedFiles.values()).map((entry) => path.resolve(entry.directory)))
    let removed = 0
    for (const entry of entries) {
      if (!entry || !entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(TEMP_PREFIX)) continue
      const directory = path.resolve(realRoot, entry.name)
      if (activeDirectories.has(directory)) continue
      let stats
      try {
        stats = await fs.promises.lstat(directory)
      } catch (error) {
        if (error && error.code === 'ENOENT') continue
        throw normalizationError('MATERIAL_STORAGE_CLEANUP_FAILED', 507, '服务器素材临时文件巡检失败')
      }
      const currentUid = typeof process.getuid === 'function' ? process.getuid() : null
      const ownershipTrusted = platform === 'win32'
        || (Number.isSafeInteger(currentUid) && stats.uid === currentUid && (stats.mode & 0o777) === 0o700)
      if (!stats.isDirectory()
        || stats.isSymbolicLink()
        || !ownershipTrusted
        || nowMs - stats.mtimeMs < STALE_DIRECTORY_MAX_AGE_MS) continue
      const pidMatch = entry.name.match(/^ynzy-note-material-normalize-(\d+)-/)
      if (pidMatch && processAppearsAlive(Number(pidMatch[1]))) continue
      await cleanupPrivateDirectory(directory, realRoot)
      removed += 1
    }
    lastRecoveryAt = nowMs
    return { removed }
  }

  async function ensureStaleDirectoryRecovery(deadline) {
    if (Date.now() - lastRecoveryAt < STALE_RECOVERY_INTERVAL_MS) return
    if (!recoveryPromise) {
      recoveryPromise = recoverStaleDirectories().finally(() => {
        recoveryPromise = null
      })
    }
    await deadlineRace(recoveryPromise, deadline)
  }

  async function describeProfileWithDeadline(deadline) {
    if (!profilePromise) {
      profilePromise = (async () => {
        if (!tempRoot || !isAbsolutePathForPlatform(ffmpegPath, platform) || !isAbsolutePathForPlatform(ffprobePath, platform)) {
          throw normalizationError('MATERIAL_TOOL_UNAVAILABLE', 503, '服务器素材处理组件配置无效')
        }
        const [ffmpeg, ffprobe] = await Promise.all([
          fingerprintFile(ffmpegPath, platform, deadline),
          fingerprintFile(ffprobePath, platform, deadline)
        ])
        const toolFingerprint = sha256Buffer(Buffer.from(canonicalJson({ ffmpeg, ffprobe })))
        const formats = {
          gif: { kind: 'image', format: 'gif', demuxer: 'gif' },
          jpeg: { kind: 'image', format: 'jpeg', demuxer: 'image2pipe' },
          mp4: { kind: 'video', format: 'mp4', demuxer: 'mov' },
          png: { kind: 'image', format: 'png', demuxer: 'image2pipe' },
          webm: { kind: 'video', format: 'webm', demuxer: 'matroska,webm' },
          webp: { kind: 'image', format: 'webp', demuxer: 'image2pipe' }
        }
        const longestVideoBudget = buildVideoEncodingBudget({
          durationSeconds: limits.maxVideoDurationSeconds,
          hasAudio: true,
          maxOutputBytes: limits.maxVideoOutputBytes
        })
        const shortestVideoBudget = buildVideoEncodingBudget({
          durationSeconds: 1,
          hasAudio: false,
          maxOutputBytes: limits.maxVideoOutputBytes
        })
        const profileDefinition = {
          profile: PROFILE_ID,
          limits,
          commandTemplates: {
            probe: Object.fromEntries(Object.entries(formats).map(([name, format]) => [
              name,
              buildProbeArgs(format)
            ])),
            videoTranscode: {
              longestMp4WithAudio: buildVideoTranscodeArgs(formats.mp4, longestVideoBudget),
              longestWebmWithAudio: buildVideoTranscodeArgs(formats.webm, longestVideoBudget),
              shortestMp4WithoutAudio: buildVideoTranscodeArgs(formats.mp4, shortestVideoBudget),
              shortestWebmWithoutAudio: buildVideoTranscodeArgs(formats.webm, shortestVideoBudget)
            },
            videoSanitize: {
              longestMp4WithAudio: buildVideoSanitizeArgs(formats.mp4, longestVideoBudget),
              shortestMp4WithoutAudio: buildVideoSanitizeArgs(formats.mp4, shortestVideoBudget)
            },
            imageCompress: {
              gifToWebp: buildImageCompressArgs(formats.gif, { outputFormat: 'webp' }),
              jpeg: buildImageCompressArgs(formats.jpeg),
              png: buildImageCompressArgs(formats.png),
              pngFallbackWebp: buildImageCompressArgs(formats.png, { outputFormat: 'webp' }),
              webp: buildImageCompressArgs(formats.webp)
            }
          },
          rules: {
            concurrency: maxConcurrent,
            gif: 'all-images-first-frame-convert-webp-strip-metadata',
            image: 'all-images-first-frame-reencode-strip-metadata-max-edge-2048-png-overflow-fallback-webp-preserve-alpha-container-animation-validated',
            video: {
              audioBitsPerSecond: VIDEO_AUDIO_BITRATE,
              bufferRatio: VIDEO_BUFFER_RATIO,
              maxRateRatio: VIDEO_MAX_RATE_RATIO,
              maxVideoBitsPerSecond: VIDEO_MAX_BITRATE,
              minVideoBitsPerSecond: VIDEO_MIN_BITRATE,
              outputBudgetRatio: VIDEO_OUTPUT_BUDGET_RATIO,
              compatibleTarget: 'mp4-h264-yuv420p-aac-reencode-strip-container-stream-and-bitstream-private-data',
              target: 'mp4-h264-yuv420p-aac-max-1920x1080-30fps-strip-all-metadata-and-non-av-tracks'
            }
          },
          toolFingerprint
        }
        return Object.freeze({
          transformProfileVersion: PROFILE_ID,
          transformProfileSha256: sha256Buffer(Buffer.from(canonicalJson(profileDefinition))),
          transformToolFingerprint: toolFingerprint,
          limits
        })
      })().catch((error) => {
        profilePromise = null
        throw error
      })
    }
    return deadlineRace(profilePromise, deadline)
  }

  async function describeProfile() {
    return describeProfileWithDeadline(Date.now() + limits.timeoutMs)
  }

  async function probeFile(filePath, format, deadline) {
    const stdout = await runChildProcessCapture({
      command: ffprobePath,
      args: buildProbeArgs(format),
      inputPath: filePath,
      maxStdoutBytes: limits.maxProbeOutputBytes,
      maxStderrBytes: limits.maxDiagnosticBytes,
      deadline,
      spawnImpl,
      spawnContext
    })
    let rawProbe
    try {
      rawProbe = JSON.parse(stdout.toString('utf8'))
    } catch (error) {
      throw normalizationError('MATERIAL_PROBE_INVALID', 422, '素材格式无法安全识别')
    }
    const probe = summarizeProbe(rawProbe, format)
    assertProbeMatchesDetected(probe, format)
    return probe
  }

  function enterOperation() {
    if (activeOperations >= maxConcurrent || preparedFiles.size >= maxConcurrent) {
      throw normalizationError('MATERIAL_NORMALIZATION_BUSY', 429, '已有素材正在处理，请稍后重试')
    }
    activeOperations += 1
  }

  function leaveOperation() {
    activeOperations = Math.max(0, activeOperations - 1)
  }

  async function prepareMaterial(input = {}) {
    enterOperation()
    const deadline = Date.now() + limits.timeoutMs
    let privateDirectory = null
    let realTempRoot = tempRoot
    try {
      const keepPreparedFile = input.keepPreparedFile === true
      const sourceEvidence = sourceEvidenceFor(input)
      const declaredMimeType = configuredMimeType(input)
      const declaredKind = configuredKind(input, declaredMimeType)
      if (!declaredKind) {
        throw normalizationError('MATERIAL_KIND_INVALID', 422, '素材类型必须明确为图片或视频')
      }
      const maxSourceBytes = declaredKind === 'video'
        ? limits.maxVideoSourceBytes
        : limits.maxImageSourceBytes
      const profile = await describeProfileWithDeadline(deadline)
      await ensureStaleDirectoryRecovery(deadline)
      const privateLocation = await deadlineRace(createPrivateDirectory(tempRoot), deadline)
      privateDirectory = privateLocation.directory
      realTempRoot = privateLocation.realRoot
      const maxOutputBytes = declaredKind === 'video'
        ? limits.maxVideoOutputBytes
        : limits.maxImageOutputBytes
      await deadlineRace(assertFreeSpace(
        statfsImpl,
        realTempRoot,
        maxSourceBytes + maxOutputBytes + limits.minFreeBytes
      ), deadline)
      const sourcePath = path.join(privateDirectory, 'source-material')
      const source = await spoolSource({
        input,
        sourceEvidence,
        sourcePath,
        maxBytes: maxSourceBytes,
        deadline
      })
      await deadlineRace(assertFreeSpace(
        statfsImpl,
        realTempRoot,
        maxOutputBytes + limits.minFreeBytes
      ), deadline)
      const header = await deadlineRace(readHeader(sourcePath), deadline)
      const sourceFormat = sniffFormat(header)
      if (!sourceFormat || sourceFormat.kind !== declaredKind) {
        throw normalizationError('MATERIAL_FORMAT_INVALID', 422, '素材真实格式与声明类型不一致')
      }
      const receiptMimeType = source.receiptContentType
      if (!mimeMatchesFormat(declaredMimeType, sourceFormat.format)
        || !mimeMatchesFormat(receiptMimeType, sourceFormat.format)) {
        throw normalizationError('MATERIAL_MIME_MISMATCH', 422, '素材真实格式与下载类型不一致')
      }
      if (sourceFormat.kind === 'image') {
        await deadlineRace(inspectImageContainer(sourcePath, sourceFormat, source.size), deadline)
      }
      const sourceProbe = await probeFile(sourcePath, sourceFormat, deadline)
      assertSourceProbe(sourceProbe, sourceFormat, limits)

      let outputFormat = sourceFormat
      let outputProbe = null
      let action = ''
      const outputPath = path.join(privateDirectory, 'normalized-material')
      let outputEvidence = null
      if (sourceFormat.kind === 'video') {
        const compatible = isCompatibleMp4(input, source, sourceProbe, sourceFormat, limits)
        action = compatible ? 'sanitize' : 'transcode'
        const videoBudgetBytes = source.size > limits.maxVideoPassthroughBytes
          ? Math.min(limits.maxVideoOutputBytes, limits.maxVideoPassthroughBytes)
          : limits.maxVideoOutputBytes
        const encodingBudget = buildVideoEncodingBudget({
          durationSeconds: sourceProbe.durationSeconds,
          hasAudio: sourceProbe.audioCodecs.length > 0,
          maxOutputBytes: videoBudgetBytes
        })
        const args = compatible
          ? buildVideoSanitizeArgs(sourceFormat, encodingBudget)
          : buildVideoTranscodeArgs(sourceFormat, encodingBudget)
        outputEvidence = await runChildProcessToFile({
          command: ffmpegPath,
          args,
          inputPath: sourcePath,
          outputPath,
          maxOutputBytes: limits.maxVideoOutputBytes,
          maxStderrBytes: limits.maxDiagnosticBytes,
          deadline,
          spawnImpl,
          spawnContext
        })
        outputFormat = sniffFormat(await deadlineRace(readHeader(outputPath), deadline))
        if (!outputFormat || outputFormat.format !== 'mp4') {
          throw normalizationError('MATERIAL_OUTPUT_INVALID', 422, '处理后的视频格式无效')
        }
      } else {
        action = 'compress'
        const initialOutputFormat = sourceFormat.format === 'gif' ? 'webp' : sourceFormat.format
        try {
          outputEvidence = await runChildProcessToFile({
            command: ffmpegPath,
            args: buildImageCompressArgs(sourceFormat, { outputFormat: initialOutputFormat }),
            inputPath: sourcePath,
            outputPath,
            maxOutputBytes: limits.maxImageOutputBytes,
            maxStderrBytes: limits.maxDiagnosticBytes,
            deadline,
            spawnImpl,
            spawnContext
          })
        } catch (error) {
          if (!error || error.code !== 'MATERIAL_OUTPUT_TOO_LARGE' || sourceFormat.format !== 'png') throw error
          // 高熵 PNG 即使缩到 2048px 仍可能超过 8MiB；WebP 保留透明通道并提供确定性的二次降级。
          await fs.promises.unlink(outputPath).catch(() => {})
          outputEvidence = await runChildProcessToFile({
            command: ffmpegPath,
            args: buildImageCompressArgs(sourceFormat, { outputFormat: 'webp' }),
            inputPath: sourcePath,
            outputPath,
            maxOutputBytes: limits.maxImageOutputBytes,
            maxStderrBytes: limits.maxDiagnosticBytes,
            deadline,
            spawnImpl,
            spawnContext
          })
        }
        outputFormat = sniffFormat(await deadlineRace(readHeader(outputPath), deadline))
        const allowedOutputFormats = sourceFormat.format === 'png'
          ? new Set(['png', 'webp'])
          : sourceFormat.format === 'gif'
            ? new Set(['webp'])
            : new Set([sourceFormat.format])
        if (!outputFormat || !allowedOutputFormats.has(outputFormat.format)) {
          throw normalizationError('MATERIAL_OUTPUT_INVALID', 422, '处理后的图片格式无效')
        }
      }

      if (!outputEvidence || outputEvidence.size <= 0 || outputEvidence.size > maxOutputBytes) {
        throw normalizationError('MATERIAL_OUTPUT_TOO_LARGE', 413, '处理后的素材仍超过上传大小限制')
      }
      outputProbe = await probeFile(outputPath, outputFormat, deadline)
      if (sourceFormat.kind === 'video') assertNormalizedVideo(sourceProbe, outputProbe, limits)
      else assertNormalizedImage(outputProbe, outputFormat, limits)
      await deadlineRace(fs.promises.unlink(sourcePath), deadline)

      const descriptor = outputDescriptor(outputFormat, action)
      const prepared = {
        sourceContentSha256: source.contentSha256,
        sourceSize: source.size,
        sourceMimeType: sourceFormat.mimeType,
        contentSha256: outputEvidence.contentSha256,
        size: outputEvidence.size,
        contentType: descriptor.contentType,
        mimeType: descriptor.contentType,
        extension: descriptor.extension,
        kind: sourceFormat.kind,
        normalized: true,
        transformProfileVersion: profile.transformProfileVersion,
        transformProfileSha256: profile.transformProfileSha256,
        transformToolFingerprint: profile.transformToolFingerprint,
        transformAction: action,
        probe: Object.freeze({
          codec: outputProbe.codec,
          pixelFormat: outputProbe.pixelFormat,
          width: outputProbe.width,
          height: outputProbe.height,
          durationSeconds: outputProbe.durationSeconds,
          fps: outputProbe.fps,
          frameCount: outputProbe.frameCount
        })
      }
      if (!keepPreparedFile) {
        return prepared
      }

      const handleId = crypto.randomBytes(32).toString('hex')
      Object.defineProperty(prepared, PREPARED_FILE_HANDLE, {
        value: handleId,
        enumerable: true,
        configurable: true,
        writable: false
      })
      preparedFiles.set(handleId, {
        directory: privateDirectory,
        filePath: outputPath,
        realTempRoot
      })
      privateDirectory = null
      return prepared
    } catch (error) {
      if (error && error.code && Number.isSafeInteger(error.statusCode)) throw error
      throw normalizationError('MATERIAL_NORMALIZATION_FAILED', 422, '素材处理失败，请检查源文件')
    } finally {
      try {
        await cleanupPrivateDirectory(privateDirectory, realTempRoot)
      } finally {
        leaveOperation()
      }
    }
  }

  async function verifyRetainedPreparedFile(prepared, deadline) {
    const handleId = prepared && prepared[PREPARED_FILE_HANDLE]
    const retained = typeof handleId === 'string' ? preparedFiles.get(handleId) : null
    if (!retained) {
      throw normalizationError('MATERIAL_PREPARED_INVALID', 422, '处理后素材文件凭据无效')
    }
    const directory = path.resolve(retained.directory)
    const filePath = path.resolve(retained.filePath)
    const realRoot = path.resolve(retained.realTempRoot)
    if (path.dirname(directory) !== realRoot
      || !path.basename(directory).startsWith(TEMP_PREFIX)
      || path.dirname(filePath) !== directory
      || !['source-material', 'normalized-material'].includes(path.basename(filePath))) {
      throw normalizationError('MATERIAL_PREPARED_INVALID', 422, '处理后素材文件边界无效')
    }

    let directoryStats
    let fileStats
    let realDirectory
    let realFile
    try {
      [directoryStats, fileStats, realDirectory, realFile] = await Promise.all([
        fs.promises.lstat(directory),
        fs.promises.lstat(filePath),
        fs.promises.realpath(directory),
        fs.promises.realpath(filePath)
      ])
    } catch (error) {
      throw normalizationError('MATERIAL_PREPARED_INVALID', 422, '处理后素材文件已失效')
    }
    if (!directoryStats.isDirectory()
      || directoryStats.isSymbolicLink()
      || !fileStats.isFile()
      || fileStats.isSymbolicLink()
      || path.resolve(realDirectory) !== directory
      || path.resolve(realFile) !== filePath
      || Number(prepared.size) !== fileStats.size
      || (platform !== 'win32' && ((directoryStats.mode & 0o777) !== 0o700 || (fileStats.mode & 0o777) !== 0o600))) {
      throw normalizationError('MATERIAL_PREPARED_MISMATCH', 422, '处理后素材文件与受信凭据不一致')
    }
    const maxBytes = prepared.kind === 'video' ? limits.maxVideoOutputBytes : limits.maxImageOutputBytes
    if (fileStats.size <= 0 || fileStats.size > maxBytes) {
      throw normalizationError('MATERIAL_PREPARED_MISMATCH', 422, '处理后素材文件大小无效')
    }
    const actualDigest = await hashFile(filePath, deadline)
    if (actualDigest !== normalizeSha256(prepared.contentSha256)) {
      throw normalizationError('MATERIAL_PREPARED_MISMATCH', 422, '处理后素材文件摘要不一致')
    }
    return { handleId, retained, actualDigest, size: fileStats.size }
  }

  async function verifyPreparedMaterial(prepared) {
    const deadline = Date.now() + limits.timeoutMs
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
      throw normalizationError('MATERIAL_PREPARED_INVALID', 422, '处理后素材凭据无效')
    }
    const profile = await describeProfileWithDeadline(deadline)
    const expectedDigest = normalizeSha256(prepared.contentSha256)
    const verifiedFile = await verifyRetainedPreparedFile(prepared, deadline)
    const actualDigest = verifiedFile.actualDigest
    const actualSize = verifiedFile.size
    const contentType = normalizeMimeType(prepared.contentType)
    const mimeType = normalizeMimeType(prepared.mimeType)
    const extension = normalizeExtension(prepared.extension)
    const sourceDigest = normalizeSha256(prepared.sourceContentSha256)
    const sourceMimeType = normalizeMimeType(prepared.sourceMimeType)
    const action = String(prepared.transformAction || '')
    const expectedImageType = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif'
    }[extension]
    const typeBoundaryValid = prepared.kind === 'video'
      ? extension === 'mp4'
        && contentType === 'video/mp4'
        && mimeType === contentType
        && sourceMimeType.startsWith('video/')
        && ['sanitize', 'transcode'].includes(action)
      : prepared.kind === 'image'
        ? Boolean(expectedImageType)
        && contentType === expectedImageType
        && mimeType === contentType
        && sourceMimeType.startsWith('image/')
        && action === 'compress'
        : false
    if (!expectedDigest
      || expectedDigest !== actualDigest
      || Number(prepared.size) !== actualSize
      || !sourceDigest
      || !Number.isSafeInteger(Number(prepared.sourceSize))
      || Number(prepared.sourceSize) <= 0
      || !sourceMimeType
      || prepared.transformProfileVersion !== profile.transformProfileVersion
      || prepared.transformProfileSha256 !== profile.transformProfileSha256
      || prepared.transformToolFingerprint !== profile.transformToolFingerprint
      || prepared.normalized !== true
      || !typeBoundaryValid) {
      throw normalizationError('MATERIAL_PREPARED_MISMATCH', 422, '处理后素材与受信凭据不一致')
    }
    return {
      verified: true,
      contentSha256: actualDigest,
      size: actualSize,
      contentType: prepared.contentType,
      extension: prepared.extension,
      kind: prepared.kind,
      transformProfileVersion: prepared.transformProfileVersion,
      transformProfileSha256: prepared.transformProfileSha256,
      transformToolFingerprint: prepared.transformToolFingerprint,
      transformAction: prepared.transformAction
    }
  }

  async function openPreparedFile(prepared) {
    const verified = await verifyPreparedMaterial(prepared)
    const handleId = prepared && prepared[PREPARED_FILE_HANDLE]
    const retained = typeof handleId === 'string' ? preparedFiles.get(handleId) : null
    if (!retained) {
      throw normalizationError('MATERIAL_PREPARED_INVALID', 422, '处理后素材文件凭据无效')
    }
    return Object.freeze({
      filePath: retained.filePath,
      size: verified.size,
      contentSha256: verified.contentSha256,
      contentType: verified.contentType,
      extension: verified.extension,
      kind: verified.kind
    })
  }

  async function disposePreparedMaterial(prepared) {
    if (!prepared || typeof prepared !== 'object') return false
    let disposed = false
    const handleId = prepared[PREPARED_FILE_HANDLE]
    const retained = typeof handleId === 'string' ? preparedFiles.get(handleId) : null
    if (retained) {
      await cleanupPrivateDirectory(retained.directory, retained.realTempRoot)
      preparedFiles.delete(handleId)
      disposed = true
    }
    try {
      delete prepared[PREPARED_FILE_HANDLE]
    } catch (error) {
      // 私有句柄已从注册表撤销即可；不向外暴露清理实现。
    }
    return disposed
  }

  async function verifySource(input = {}) {
    enterOperation()
    const deadline = Date.now() + limits.timeoutMs
    let privateDirectory = null
    let realTempRoot = tempRoot
    try {
      const prepared = input.prepared
      if (!prepared
        || !normalizeSha256(prepared.sourceContentSha256)
        || !Number.isSafeInteger(Number(prepared.sourceSize))
        || !normalizeMimeType(prepared.sourceMimeType)) {
        throw normalizationError('MATERIAL_PREPARED_INVALID', 422, '源素材复验凭据无效')
      }
      const sourceEvidence = {
        ...(input.sourceEvidence && typeof input.sourceEvidence === 'object' ? input.sourceEvidence : {}),
        downloadToFile: input.downloadToFile
          || (input.sourceEvidence && input.sourceEvidence.downloadToFile)
      }
      const declaredMimeType = configuredMimeType({
        ...input,
        sourceEvidence,
        mimeType: input.mimeType || prepared.sourceMimeType
      })
      const declaredKind = configuredKind({ ...input, kind: input.kind || prepared.kind }, declaredMimeType)
      const maxSourceBytes = declaredKind === 'video'
        ? limits.maxVideoSourceBytes
        : limits.maxImageSourceBytes
      await ensureStaleDirectoryRecovery(deadline)
      const privateLocation = await deadlineRace(createPrivateDirectory(tempRoot), deadline)
      privateDirectory = privateLocation.directory
      realTempRoot = privateLocation.realRoot
      await deadlineRace(assertFreeSpace(
        statfsImpl,
        realTempRoot,
        maxSourceBytes + limits.minFreeBytes
      ), deadline)
      const sourcePath = path.join(privateDirectory, 'source-verification')
      const source = await spoolSource({
        input: { ...input, sourceEvidence },
        sourceEvidence,
        sourcePath,
        maxBytes: maxSourceBytes,
        deadline
      })
      const format = sniffFormat(await deadlineRace(readHeader(sourcePath), deadline))
      if (!format
        || format.kind !== prepared.kind
        || !mimeMatchesFormat(declaredMimeType, format.format)
        || !mimeMatchesFormat(source.receiptContentType, format.format)
        || source.size !== Number(prepared.sourceSize)
        || source.contentSha256 !== prepared.sourceContentSha256
        || format.mimeType !== prepared.sourceMimeType) {
        throw normalizationError('MATERIAL_SOURCE_REVERIFY_MISMATCH', 409, '源素材已变化，已阻止继续写入')
      }
      return {
        verified: true,
        sourceContentSha256: source.contentSha256,
        sourceSize: source.size,
        sourceMimeType: format.mimeType
      }
    } catch (error) {
      if (error && error.code && Number.isSafeInteger(error.statusCode)) throw error
      throw normalizationError('MATERIAL_SOURCE_REVERIFY_FAILED', 422, '源素材复验失败')
    } finally {
      try {
        await cleanupPrivateDirectory(privateDirectory, realTempRoot)
      } finally {
        leaveOperation()
      }
    }
  }

  return {
    prepareMaterial,
    normalizeAsset: prepareMaterial,
    verifyPreparedMaterial,
    openPreparedFile,
    disposePreparedMaterial,
    verifySource,
    describeProfile,
    recoverStaleDirectories,
    activeCount: () => activeOperations,
    retainedCount: () => preparedFiles.size
  }
}

module.exports = {
  PROFILE_ID,
  createFeishuNoteMaterialNormalizer,
  buildProbeArgs,
  buildVideoTranscodeArgs,
  buildImageCompressArgs,
  sniffFormat
}
