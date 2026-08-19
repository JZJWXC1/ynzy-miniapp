'use strict'

const fs = require('fs')
const path = require('path')
const { Transform } = require('stream')

function boundedInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
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
    // 清理失败不能覆盖原始业务结论。
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

module.exports = {
  boundedInteger,
  isAbsolutePathForPlatform,
  nonRootIdentity,
  buildFfmpegSpawnOptions,
  createByteLimitTransform,
  safeDestroy,
  safeKill,
  safeCloseFd,
  destroyAndWaitForClose
}
