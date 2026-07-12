const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { Transform, pipeline } = require('stream')
const config = require('./config')
const oss = require('./oss')

const MEBIBYTE = 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 200 * MEBIBYTE
const DEFAULT_FFMPEG_PATH = process.platform === 'win32'
  ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ffmpeg.exe')
  : '/usr/bin/ffmpeg'

function boundedInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function previewError(code, statusCode, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function normalizeUploadDir(value) {
  const uploadDir = String(value || '').trim().replace(/^\/+|\/+$/g, '')
  if (!uploadDir || uploadDir.length > 160) return ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(uploadDir)) return ''
  const segments = uploadDir.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return ''
  return uploadDir
}

function isManagedVideoObjectKey(value, uploadDir = config.oss.uploadDir) {
  const key = String(value || '')
  if (!key || key !== key.trim() || key.length > 512) return false
  if (/[\\?#%\u0000-\u001f\u007f]/.test(key)) return false
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) return false
  if (!/\.(?:mp4|mov|m4v)$/i.test(key)) return false
  const managedDir = normalizeUploadDir(uploadDir)
  if (!managedDir || !key.startsWith(`${managedDir}/`)) return false
  const segments = key.split('/')
  return !segments.some((segment) => !segment || segment === '.' || segment === '..')
}

function encodedObjectPath(objectKey) {
  return `/${String(objectKey || '').split('/').map((part) => encodeURIComponent(part)).join('/')}`
}

function configuredOssHost() {
  const bucket = String(config.oss.bucket || '').trim().toLowerCase()
  const region = String(config.oss.region || '').trim().toLowerCase()
  if (!bucket || !region) return ''
  return `${bucket}.${region}.aliyuncs.com`
}

function isAllowedSignedReadUrl(value, objectKey, allowedHost = configuredOssHost()) {
  const expectedHost = String(allowedHost || '').trim().toLowerCase()
  if (!expectedHost || /[:/@\\]/.test(expectedHost)) return false
  try {
    const parsed = new URL(String(value || ''))
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && !parsed.hash
      && parsed.hostname.toLowerCase() === expectedHost
      && parsed.pathname === encodedObjectPath(objectKey)
  } catch (error) {
    return false
  }
}

function isAbsolutePathForPlatform(value, platform = process.platform) {
  return platform === 'win32'
    ? path.win32.isAbsolute(value)
    : path.posix.isAbsolute(value)
}

function nonRootIdentity(value, fallback = 65534) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 && number <= 2147483647 ? number : fallback
}

function buildFfmpegSpawnOptions(options = {}) {
  const platform = options.platform || process.platform
  const runtimeEnv = options.env || process.env
  const inputFd = Number(options.inputFd)
  if (!Number.isSafeInteger(inputFd) || inputFd < 0) {
    throw new TypeError('ffmpeg 输入文件描述符无效')
  }
  const spawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe', inputFd],
    windowsHide: true,
    shell: false,
    cwd: platform === 'win32'
      ? (runtimeEnv.SystemRoot || path.win32.parse(process.cwd()).root)
      : '/',
    env: {
      PATH: String(runtimeEnv.PATH || (platform === 'win32' ? '' : '/usr/bin:/bin')),
      LANG: 'C',
      LC_ALL: 'C'
    }
  }

  if (platform === 'win32') {
    spawnOptions.env.SystemRoot = String(runtimeEnv.SystemRoot || path.win32.parse(process.cwd()).root)
    return spawnOptions
  }

  const currentUid = options.currentUid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid() : null)
    : Number(options.currentUid)
  if (currentUid === 0) {
    spawnOptions.uid = nonRootIdentity(options.uid === undefined ? runtimeEnv.VIDEO_PREVIEW_UID : options.uid)
    spawnOptions.gid = nonRootIdentity(options.gid === undefined ? runtimeEnv.VIDEO_PREVIEW_GID : options.gid)
  }
  return spawnOptions
}

function buildFfmpegArgs(options = {}) {
  const maxDurationSeconds = boundedInteger(options.maxDurationSeconds, 300, 1, 300)
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1, config.oss.maxVideoSize)
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
    '-codec_whitelist', 'hevc,h264,aac',
    '-max_pixels', String(4096 * 4096),
    '-fd', '3',
    '-f', 'mov',
    '-i', 'fd:',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-map_metadata', '-1',
    '-sn',
    '-dn',
    '-threads', '1',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-fpsmax', '30',
    '-maxrate', '6M',
    '-bufsize', '12M',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-t', String(maxDurationSeconds),
    '-fs', String(maxOutputBytes),
    '-max_muxing_queue_size', '1024',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  ]
}

function createByteLimitTransform(maxBytes, createLimitError, onFirstChunk) {
  let totalBytes = 0
  let sawFirstChunk = false
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        callback(createLimitError())
        return
      }
      if (!sawFirstChunk) {
        sawFirstChunk = true
        try {
          if (typeof onFirstChunk === 'function') onFirstChunk()
        } catch (error) {
          callback(error)
          return
        }
      }
      callback(null, chunk)
    }
  })
  Object.defineProperty(transform, 'byteCount', {
    enumerable: false,
    get: () => totalBytes
  })
  return transform
}

function safeDestroy(stream) {
  if (!stream || typeof stream.destroy !== 'function' || stream.destroyed) return
  try {
    stream.destroy()
  } catch (error) {
    // 清理失败不能覆盖原始转码结论。
  }
}

function safeKill(child) {
  if (!child || typeof child.kill !== 'function' || child.killed) return
  try {
    child.kill('SIGKILL')
  } catch (error) {
    // 子进程可能已经退出，释放并发名额即可。
  }
}

function safeCloseFd(fd) {
  if (!Number.isSafeInteger(fd) || fd < 0) return
  try {
    fs.closeSync(fd)
  } catch (error) {
    // 文件描述符可能已经关闭；清理阶段不覆盖原始业务结论。
  }
}

function destroyAndWaitForClose(stream) {
  if (!stream || stream.closed) return Promise.resolve()
  return new Promise((resolve) => {
    let completed = false
    const finish = () => {
      if (completed) return
      completed = true
      resolve()
    }
    stream.once('close', finish)
    safeDestroy(stream)
    if (stream.closed) finish()
  })
}

function createAdminVideoPreviewStreamer(options = {}) {
  const createSignedReadUrl = options.createSignedReadUrl || oss.createSignedReadUrl
  const requestImpl = options.requestImpl || https.get
  const spawnImpl = options.spawnImpl || spawn
  const platform = options.platform || process.platform
  const configuredPath = String(options.ffmpegPath || process.env.VIDEO_PREVIEW_FFMPEG_PATH || DEFAULT_FFMPEG_PATH).trim()
  const ffmpegPath = isAbsolutePathForPlatform(configuredPath, platform) ? configuredPath : ''
  const uploadDir = normalizeUploadDir(options.uploadDir || config.oss.uploadDir)
  const allowedSourceHost = String(options.allowedSourceHost || configuredOssHost()).trim().toLowerCase()
  const maxConcurrent = boundedInteger(options.maxConcurrent || process.env.VIDEO_PREVIEW_MAX_CONCURRENT, 1, 1, 2)
  const timeoutMs = boundedInteger(options.timeoutMs || process.env.VIDEO_PREVIEW_TIMEOUT_MS, 5 * 60 * 1000, 1000, 5 * 60 * 1000)
  const maxInputBytes = boundedInteger(options.maxInputBytes, config.oss.maxVideoSize, 1, config.oss.maxVideoSize)
  const envOutputMegabytes = Number(process.env.VIDEO_PREVIEW_MAX_OUTPUT_MB)
  const configuredOutputBytes = options.maxOutputBytes === undefined && Number.isFinite(envOutputMegabytes)
    ? Math.floor(envOutputMegabytes * MEBIBYTE)
    : options.maxOutputBytes
  const maxOutputBytes = boundedInteger(configuredOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1, config.oss.maxVideoSize)
  const maxDurationSeconds = boundedInteger(
    options.maxDurationSeconds || process.env.VIDEO_PREVIEW_MAX_DURATION_SECONDS,
    300,
    1,
    300
  )
  const ffmpegArgs = buildFfmpegArgs({ maxDurationSeconds, maxOutputBytes })
  const configuredTempRoot = String(options.tempRoot || os.tmpdir()).trim()
  const tempRoot = path.isAbsolute(configuredTempRoot) ? configuredTempRoot : ''
  let activeStreams = 0

  function streamCompatiblePreview({ request, response, objectKey }) {
    const key = String(objectKey || '').trim()
    if (!isManagedVideoObjectKey(key, uploadDir)) {
      return Promise.reject(previewError(
        'VIDEO_PREVIEW_MISSING',
        404,
        '房源没有可生成兼容预览的视频'
      ))
    }
    if (!ffmpegPath) {
      return Promise.reject(previewError(
        'VIDEO_PREVIEW_TRANSCODER_UNAVAILABLE',
        503,
        '服务器视频兼容组件配置无效'
      ))
    }
    if (!allowedSourceHost) {
      return Promise.reject(previewError(
        'VIDEO_PREVIEW_SOURCE_UNAVAILABLE',
        503,
        '视频存储配置不完整，暂时无法生成兼容预览'
      ))
    }
    if (!tempRoot) {
      return Promise.reject(previewError(
        'VIDEO_PREVIEW_STORAGE_UNAVAILABLE',
        503,
        '服务器视频兼容临时存储配置无效'
      ))
    }
    if (activeStreams >= maxConcurrent) {
      return Promise.reject(previewError(
        'VIDEO_PREVIEW_BUSY',
        429,
        '已有兼容预览正在生成，请稍后重试'
      ))
    }

    activeStreams += 1

    return new Promise((resolve, reject) => {
      let settled = false
      let finalizing = false
      let upstreamRequest = null
      let upstreamResponse = null
      let inputLimiter = null
      let outputLimiter = null
      let tempWriter = null
      let tempDirectory = ''
      let tempFilePath = ''
      let inputFd = null
      let transcoder = null
      let timer = null

      async function cleanupTemporaryInput() {
        if (tempWriter && !tempWriter.closed) {
          await destroyAndWaitForClose(tempWriter)
        }
        tempWriter = null
        if (inputFd !== null) {
          safeCloseFd(inputFd)
          inputFd = null
        }
        const directoryToRemove = tempDirectory
        tempDirectory = ''
        tempFilePath = ''
        if (!directoryToRemove) return
        await fs.promises.rm(directoryToRemove, { recursive: true, force: true })
      }

      function release(error, clientClosed = false) {
        if (settled || finalizing) return
        finalizing = true
        if (timer) clearTimeout(timer)
        if (request && typeof request.removeListener === 'function') request.removeListener('aborted', clientClosedHandler)
        if (response && typeof response.removeListener === 'function') response.removeListener('close', clientClosedHandler)

        if (error || clientClosed) {
          safeDestroy(upstreamRequest)
          safeDestroy(upstreamResponse)
          safeDestroy(inputLimiter)
          safeDestroy(tempWriter)
          safeDestroy(outputLimiter)
          safeKill(transcoder)
        } else {
          // 源文件已经完整落盘并核对长度；成功时只保留响应尾部继续冲刷。
          safeDestroy(upstreamRequest)
          safeDestroy(upstreamResponse)
          safeDestroy(inputLimiter)
        }

        Promise.resolve()
          .then(cleanupTemporaryInput)
          .catch(() => {
            if (!error && !clientClosed) {
              error = previewError(
                'VIDEO_PREVIEW_STORAGE_UNAVAILABLE',
                503,
                '服务器视频兼容临时存储不可用'
              )
            }
          })
          .then(() => {
            settled = true
            activeStreams = Math.max(0, activeStreams - 1)
            if (clientClosed) {
              resolve()
              return
            }
            if (!error) {
              resolve()
              return
            }
            if (response && response.headersSent) {
              if (typeof response.destroy === 'function') response.destroy()
              resolve()
              return
            }
            reject(error)
          })
      }

      function fail(code, statusCode, message) {
        release(previewError(code, statusCode, message))
      }

      function clientClosedHandler() {
        if (settled || finalizing) return
        if (response && response.writableEnded) return
        release(null, true)
      }

      if (request && typeof request.once === 'function') request.once('aborted', clientClosedHandler)
      if (response && typeof response.once === 'function') response.once('close', clientClosedHandler)

      timer = setTimeout(() => {
        fail('VIDEO_PREVIEW_TIMEOUT', 504, '兼容预览生成超时，请稍后重试')
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      let signedUrl = ''
      try {
        signedUrl = createSignedReadUrl(key)
      } catch (error) {
        fail('VIDEO_PREVIEW_SOURCE_UNAVAILABLE', 502, '原视频暂时无法读取，请稍后重试')
        return
      }
      if (!isAllowedSignedReadUrl(signedUrl, key, allowedSourceHost)) {
        fail('VIDEO_PREVIEW_SOURCE_UNAVAILABLE', 502, '原视频暂时无法读取，请稍后重试')
        return
      }

      try {
        upstreamRequest = requestImpl(signedUrl, {
          method: 'GET',
          headers: {
            Accept: 'video/mp4,video/quicktime',
            'Accept-Encoding': 'identity',
            'User-Agent': 'ynzy-admin-video-preview/2.0'
          }
        }, (source) => {
          upstreamResponse = source
          if (settled || finalizing) {
            safeDestroy(source)
            return
          }
          if (!source || Number(source.statusCode) !== 200) {
            fail('VIDEO_PREVIEW_SOURCE_UNAVAILABLE', 502, '原视频暂时无法读取，请稍后重试')
            return
          }

          const rawContentLength = String(source.headers && source.headers['content-length'] || '').trim()
          if (!/^\d+$/.test(rawContentLength)) {
            fail('VIDEO_PREVIEW_SOURCE_LENGTH_INVALID', 502, '原视频大小信息无效，请重新上传后再试')
            return
          }
          const contentLength = Number(rawContentLength)
          if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
            fail('VIDEO_PREVIEW_SOURCE_LENGTH_INVALID', 502, '原视频大小信息无效，请重新上传后再试')
            return
          }
          if (contentLength > maxInputBytes) {
            fail('VIDEO_PREVIEW_TOO_LARGE', 413, '原视频超过兼容预览大小限制')
            return
          }
          const contentEncoding = String(source.headers && source.headers['content-encoding'] || '').trim().toLowerCase()
          if (contentEncoding && contentEncoding !== 'identity') {
            fail('VIDEO_PREVIEW_SOURCE_UNAVAILABLE', 502, '原视频响应格式不受支持')
            return
          }

          try {
            tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'ynzy-admin-video-preview-'))
            fs.chmodSync(tempDirectory, 0o700)
            tempFilePath = path.join(tempDirectory, 'source-video')
            tempWriter = fs.createWriteStream(tempFilePath, {
              flags: 'wx',
              mode: 0o600
            })
          } catch (error) {
            fail('VIDEO_PREVIEW_STORAGE_UNAVAILABLE', 507, '服务器视频兼容临时存储不可用')
            return
          }

          let storageWriteFailed = false
          tempWriter.once('error', () => { storageWriteFailed = true })
          inputLimiter = createByteLimitTransform(maxInputBytes, () => previewError(
            'VIDEO_PREVIEW_TOO_LARGE',
            413,
            '原视频超过兼容预览大小限制'
          ))

          pipeline(source, inputLimiter, tempWriter, (downloadError) => {
            if (settled || finalizing) return
            if (downloadError) {
              if (downloadError.statusCode) {
                release(downloadError)
              } else if (storageWriteFailed) {
                fail('VIDEO_PREVIEW_STORAGE_UNAVAILABLE', 507, '服务器视频兼容临时存储不可用')
              } else {
                fail('VIDEO_PREVIEW_SOURCE_UNAVAILABLE', 502, '原视频读取中断，请稍后重试')
              }
              return
            }

            if (inputLimiter.byteCount !== contentLength) {
              fail('VIDEO_PREVIEW_SOURCE_LENGTH_INVALID', 502, '原视频实际大小与存储信息不一致，请重新上传后再试')
              return
            }

            try {
              fs.chmodSync(tempFilePath, 0o600)
              inputFd = fs.openSync(tempFilePath, 'r')
              fs.unlinkSync(tempFilePath)
              tempFilePath = ''
              fs.rmdirSync(tempDirectory)
              tempDirectory = ''
            } catch (error) {
              fail('VIDEO_PREVIEW_STORAGE_UNAVAILABLE', 507, '服务器视频兼容临时存储不可用')
              return
            }

            let spawnOptions
            try {
              spawnOptions = buildFfmpegSpawnOptions({
                platform,
                env: options.processEnv || process.env,
                currentUid: options.currentUid,
                uid: options.uid,
                gid: options.gid,
                inputFd
              })
              transcoder = spawnImpl(ffmpegPath, ffmpegArgs, spawnOptions)
            } catch (error) {
              safeCloseFd(inputFd)
              inputFd = null
              fail('VIDEO_PREVIEW_TRANSCODER_UNAVAILABLE', 503, '服务器暂未安装视频兼容组件')
              return
            }
            safeCloseFd(inputFd)
            inputFd = null

            let stderrBytes = 0
            transcoder.stderr.on('data', (chunk) => {
              // 只计数，不记录 ffmpeg 原始输出，避免把对象信息带进服务日志。
              stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.length)
            })
            transcoder.stdout.once('error', () => {
              fail('VIDEO_PREVIEW_TRANSCODE_FAILED', 422, '视频兼容转换失败，请重新上传通用 MP4')
            })
            transcoder.once('error', () => {
              fail('VIDEO_PREVIEW_TRANSCODER_UNAVAILABLE', 503, '服务器暂未安装视频兼容组件')
            })

            outputLimiter = createByteLimitTransform(maxOutputBytes, () => previewError(
              'VIDEO_PREVIEW_OUTPUT_TOO_LARGE',
              413,
              '兼容预览输出超过大小限制'
            ), () => {
              if (settled || finalizing || response.headersSent) return
              response.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Disposition': 'inline; filename="admin-review-preview.mp4"',
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff',
                'X-Accel-Buffering': 'no',
                'X-Admin-Video-Preview': 'h264-transcoded',
                'Accept-Ranges': 'none'
              })
            })
            outputLimiter.once('error', (error) => release(error))
            let childClosed = false
            let childExitCode = null
            let childExitSignal = null
            let responseFinished = false
            const concludeTranscode = () => {
              if (settled || finalizing || !childClosed || !responseFinished) return
              if (childExitCode === 0 && response.headersSent) {
                release()
                return
              }
              // stderrBytes 仅用于证明进程确实给出诊断，不把内容写日志或返回客户端。
              void stderrBytes
              void childExitSignal
              fail('VIDEO_PREVIEW_TRANSCODE_FAILED', 422, '视频兼容转换失败，请重新上传通用 MP4')
            }
            response.once('finish', () => {
              responseFinished = true
              concludeTranscode()
            })
            outputLimiter.pipe(response)
            transcoder.stdout.pipe(outputLimiter)

            transcoder.once('close', (code, signal) => {
              if (settled || finalizing) return
              childClosed = true
              childExitCode = code
              childExitSignal = signal
              if (code !== 0) {
                concludeTranscode()
                if (!responseFinished) fail('VIDEO_PREVIEW_TRANSCODE_FAILED', 422, '视频兼容转换失败，请重新上传通用 MP4')
                return
              }
              concludeTranscode()
            })
          })
        })
        if (upstreamRequest && typeof upstreamRequest.setTimeout === 'function') {
          upstreamRequest.setTimeout(Math.min(timeoutMs, 30 * 1000), () => {
            fail('VIDEO_PREVIEW_SOURCE_TIMEOUT', 504, '原视频读取超时，请稍后重试')
          })
        }
        if (upstreamRequest && typeof upstreamRequest.once === 'function') {
          upstreamRequest.once('error', () => {
            fail('VIDEO_PREVIEW_SOURCE_UNAVAILABLE', 502, '原视频暂时无法读取，请稍后重试')
          })
        }
      } catch (error) {
        fail('VIDEO_PREVIEW_SOURCE_UNAVAILABLE', 502, '原视频暂时无法读取，请稍后重试')
      }
    })
  }

  return {
    streamCompatiblePreview,
    activeCount: () => activeStreams
  }
}

const defaultStreamer = createAdminVideoPreviewStreamer()

module.exports = {
  buildFfmpegArgs,
  buildFfmpegSpawnOptions,
  isAllowedSignedReadUrl,
  isManagedVideoObjectKey,
  createAdminVideoPreviewStreamer,
  streamCompatiblePreview: defaultStreamer.streamCompatiblePreview
}
