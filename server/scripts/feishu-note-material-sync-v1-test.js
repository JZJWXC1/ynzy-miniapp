'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const domain = require('../src/domain')
const { createFeishuNoteMaterialClient } = require('../src/feishu-note-material-client')
const noteMaterialSync = require('../src/feishu-note-material-sync')
const {
  assertIsolatedStatePaths,
  assertMaterialSetEquality,
  stableAssetId,
  syncNoteMaterialVideos
} = noteMaterialSync

function syntheticAssets() {
  return [
    {
      sourceToken: 'boxSourceA123456',
      sourceKind: 'drive-file',
      name: 'A.mp4',
      extension: 'mp4',
      mimeType: 'video/mp4',
      modifiedTime: '10',
      size: 101,
      sourceOrder: 0,
      sourceFingerprint: 'source-fingerprint-a'
    },
    {
      sourceToken: 'mediaSourceB123456',
      sourceKind: 'docx-file',
      name: 'B.mov',
      extension: 'mov',
      mimeType: 'video/quicktime',
      modifiedTime: '',
      size: 202,
      sourceOrder: 1,
      sourceFingerprint: 'source-fingerprint-b'
    }
  ]
}

function createStreamingResponse(chunks = [], headers = {}, options = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [String(name).toLowerCase(), String(value)])
  )
  const bodyChunks = chunks.map((chunk) => Buffer.from(chunk))
  let index = 0
  let cancelled = false
  const reader = {
    async read() {
      if (options.hangBody === true) return new Promise(() => {})
      if (index >= bodyChunks.length) return { done: true, value: undefined }
      const value = bodyChunks[index]
      index += 1
      return { done: false, value }
    },
    async cancel() {
      cancelled = true
    },
    releaseLock() {}
  }
  return {
    ok: options.status === undefined ? true : Number(options.status) >= 200 && Number(options.status) < 300,
    status: options.status === undefined ? 200 : Number(options.status),
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) || null
      }
    },
    body: {
      getReader() {
        return reader
      },
      async cancel() {
        cancelled = true
      }
    },
    wasCancelled() {
      return cancelled
    }
  }
}

function createStreamingClient(fetchImpl, options = {}) {
  return createFeishuNoteMaterialClient({
    fetchImpl,
    accessToken: 'test-access-token',
    baseUrl: 'http://127.0.0.1/open-apis',
    allowHttpForTests: true,
    timeoutMs: options.timeoutMs || 1000,
    downloadTimeoutMs: options.downloadTimeoutMs,
    maxBytes: options.maxBytes || 1024 * 1024
  })
}

async function withTemporaryFile(run) {
  const targetPath = path.join(
    os.tmpdir(),
    `ynzy-note-material-stream-${process.pid}-${crypto.randomUUID()}.tmp`
  )
  const fileHandle = await fs.open(targetPath, 'w+')
  try {
    await run(fileHandle, targetPath)
  } finally {
    await fileHandle.close()
    await fs.rm(targetPath, { force: true })
  }
}

async function writeStaleFile(fileHandle) {
  const stale = Buffer.from('stale-content-that-must-not-survive')
  await fileHandle.truncate(0)
  await fileHandle.write(stale, 0, stale.length, 0)
}

async function assertDownloadFailureClearsFile(input) {
  await withTemporaryFile(async (fileHandle) => {
    await writeStaleFile(fileHandle)
    const response = input.response
    const client = createStreamingClient(async () => response)
    await assert.rejects(
      client.downloadTokenToFile('streamToken123', 'drive-file', {
        fileHandle,
        maxBytes: input.maxBytes
      }),
      (error) => error && error.statusCode === input.statusCode && error.code === input.code,
      input.message
    )
    assert.strictEqual((await fileHandle.stat()).size, 0, `${input.message}，失败后必须清空目标文件`)
    assert.strictEqual(response.wasCancelled(), true, `${input.message}，失败后必须取消响应正文`)
  })
}

async function testStreamingMaterialClient() {
  const body = Buffer.from('streaming-video-source-with-partial-writes')
  const contentSha256 = crypto.createHash('sha256').update(body).digest('hex')
  const requests = []
  let partialWriteCalls = 0
  const successResponse = createStreamingResponse([
    body.subarray(0, 7),
    body.subarray(7, 19),
    body.subarray(19)
  ], {
    'content-length': body.length,
    'content-type': 'video/mp4'
  })
  const client = createStreamingClient(async (url, options) => {
    requests.push({ url, headers: options.headers })
    return successResponse
  })

  await withTemporaryFile(async (fileHandle, targetPath) => {
    const partialFileHandle = {
      truncate(size) {
        return fileHandle.truncate(size)
      },
      write(buffer, offset, length, position) {
        partialWriteCalls += 1
        return fileHandle.write(buffer, offset, Math.min(length, 3), position)
      }
    }
    const originalConcat = Buffer.concat
    Buffer.concat = () => {
      throw new Error('流式下载不得拼接完整源文件 Buffer')
    }
    let result
    try {
      result = await client.downloadTokenToFile('streamToken123', 'drive-file', {
        fileHandle: partialFileHandle,
        maxBytes: body.length + 1
      })
    } finally {
      Buffer.concat = originalConcat
    }

    assert.ok(partialWriteCalls > 3, 'FileHandle 部分写入时必须循环写完每个分块')
    assert.deepStrictEqual(
      Object.keys(result).sort(),
      ['contentSha256', 'contentType', 'size'],
      '流式下载结果不得夹带完整 buffer'
    )
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'buffer'), false, '流式下载不得返回完整 buffer')
    assert.strictEqual(result.size, body.length, '流式下载必须返回累计实际字节数')
    assert.strictEqual(result.contentType, 'video/mp4', '流式下载必须保留响应 MIME')
    assert.strictEqual(result.contentSha256, contentSha256, '流式下载必须增量计算准确 SHA-256')
    assert.deepStrictEqual(await fs.readFile(targetPath), body, '流式下载落盘内容必须与响应正文一致')
  })
  assert.strictEqual(requests.length, 1, 'drive-file 下载只允许请求文件端点一次')
  assert.match(requests[0].url, /\/drive\/v1\/files\/streamToken123\/download$/, 'drive-file 必须使用文件下载端点')
  assert.strictEqual(requests[0].headers['Accept-Encoding'], 'identity', '流式下载必须禁止传输层压缩干扰大小校验')

  await assertDownloadFailureClearsFile({
    response: createStreamingResponse([], {
      'content-length': '11',
      'content-type': 'video/mp4'
    }),
    maxBytes: 10,
    statusCode: 413,
    code: 'FEISHU_MATERIAL_TOO_LARGE',
    message: 'Content-Length 声明超过上限必须拒绝'
  })
  await assertDownloadFailureClearsFile({
    response: createStreamingResponse([Buffer.alloc(6), Buffer.alloc(5)], {
      'content-type': 'video/mp4'
    }),
    maxBytes: 10,
    statusCode: 413,
    code: 'FEISHU_MATERIAL_TOO_LARGE',
    message: '无长度声明时实际累计超过上限必须拒绝'
  })
  await assertDownloadFailureClearsFile({
    response: createStreamingResponse([Buffer.from('short')], {
      'content-length': '6',
      'content-type': 'video/mp4'
    }),
    maxBytes: 10,
    statusCode: 502,
    code: 'FEISHU_MATERIAL_LENGTH_MISMATCH',
    message: '实际大小与 Content-Length 不符必须拒绝'
  })
  await assertDownloadFailureClearsFile({
    response: createStreamingResponse([Buffer.from('encoded')], {
      'content-encoding': 'gzip',
      'content-type': 'video/mp4'
    }),
    maxBytes: 10,
    statusCode: 502,
    code: 'FEISHU_MATERIAL_CONTENT_ENCODING_UNSUPPORTED',
    message: '非 identity 编码响应必须拒绝'
  })

  await withTemporaryFile(async (fileHandle, targetPath) => {
    await writeStaleFile(fileHandle)
    const fallbackBody = Buffer.from('fallback-file-body')
    const mediaResponse = createStreamingResponse([], {}, { status: 404 })
    const requestedUrls = []
    const fallbackClient = createStreamingClient(async (url) => {
      requestedUrls.push(url)
      if (url.includes('/drive/v1/medias/')) return mediaResponse
      return createStreamingResponse([fallbackBody], {
        'content-length': fallbackBody.length,
        'content-type': 'video/quicktime'
      })
    })
    const result = await fallbackClient.downloadTokenToFile('fallbackToken123', '', {
      fileHandle,
      maxBytes: 1024
    })
    assert.strictEqual(requestedUrls.length, 2, '媒体端点失败后必须且仅回退一次文件端点')
    assert.match(requestedUrls[0], /\/drive\/v1\/medias\//, '默认下载必须先尝试媒体端点')
    assert.match(requestedUrls[1], /\/drive\/v1\/files\//, '媒体端点失败后必须回退文件端点')
    assert.strictEqual(mediaResponse.wasCancelled(), true, '回退前必须取消失败端点的响应正文')
    assert.strictEqual(result.size, fallbackBody.length)
    assert.deepStrictEqual(await fs.readFile(targetPath), fallbackBody, '回退成功不得残留前一次尝试内容')
  })

  let invalidFileFetchCalls = 0
  const invalidFileClient = createStreamingClient(async () => {
    invalidFileFetchCalls += 1
    throw new Error('无效 FileHandle 不应发起网络请求')
  })
  await assert.rejects(
    invalidFileClient.downloadTokenToFile('invalidFileToken123', '', { fileHandle: {} }),
    TypeError,
    '无效 FileHandle 必须在请求前失败'
  )
  assert.strictEqual(invalidFileFetchCalls, 0, '无效 FileHandle 必须保持零请求')

  await withTemporaryFile(async (fileHandle) => {
    await writeStaleFile(fileHandle)
    const timeoutMs = 180
    const headerDelayMs = 110
    const nativeSetTimeout = global.setTimeout
    let deadlineTimerCount = 0
    const timeoutResponse = createStreamingResponse([], {}, { hangBody: true })
    const timeoutClient = createStreamingClient(async () => {
      await new Promise((resolve) => nativeSetTimeout(resolve, headerDelayMs))
      return timeoutResponse
    }, { timeoutMs })
    const startedAt = Date.now()
    global.setTimeout = function trackedSetTimeout(handler, delay, ...args) {
      if (Number(delay) === timeoutMs) deadlineTimerCount += 1
      return nativeSetTimeout(handler, delay, ...args)
    }
    try {
      await assert.rejects(
        timeoutClient.downloadTokenToFile('timeoutToken123', 'drive-file', {
          fileHandle,
          maxBytes: 1024
        }),
        (error) => error && error.statusCode === 504 && error.code === 'FEISHU_MATERIAL_DOWNLOAD_TIMEOUT',
        '响应头耗时与正文读取必须共用一个总超时'
      )
    } finally {
      global.setTimeout = nativeSetTimeout
    }
    const elapsedMs = Date.now() - startedAt
    assert.strictEqual(deadlineTimerCount, 1, '请求响应头和正文读取必须共用同一个截止计时器')
    assert.ok(elapsedMs < timeoutMs + headerDelayMs - 20, '正文超时不得在收到响应头后重新计时')
    assert.strictEqual(timeoutResponse.wasCancelled(), true, '正文超时必须取消响应流')
    assert.strictEqual((await fileHandle.stat()).size, 0, '正文超时必须清空目标文件')
  })

  await withTemporaryFile(async (fileHandle) => {
    await writeStaleFile(fileHandle)
    const externalController = new AbortController()
    let cancelled = false
    const abortClient = createStreamingClient(async (url, options) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            read() {
              return new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                  const error = new Error('aborted')
                  error.name = 'AbortError'
                  reject(error)
                }, { once: true })
              })
            },
            async cancel() {
              cancelled = true
            },
            releaseLock() {}
          }
        },
        async cancel() {
          cancelled = true
        }
      }
    }), { timeoutMs: 1000, downloadTimeoutMs: 900 })
    const pending = abortClient.downloadTokenToFile('externalAbortToken123', 'drive-file', {
      fileHandle,
      maxBytes: 1024,
      signal: externalController.signal
    })
    setTimeout(() => externalController.abort(), 20)
    await assert.rejects(
      pending,
      (error) => error && error.statusCode === 499 && error.code === 'FEISHU_MATERIAL_DOWNLOAD_ABORTED',
      '标准化总截止时间取消后必须立即终止底层流式下载且不得回退第二端点'
    )
    assert.strictEqual(cancelled, true, '外部取消必须取消响应正文')
    assert.strictEqual((await fileHandle.stat()).size, 0, '外部取消必须清空临时文件')
  })

  const legacyBody = Buffer.from('legacy-buffer-download')
  const legacyClient = createStreamingClient(async () => createStreamingResponse([legacyBody], {
    'content-length': legacyBody.length,
    'content-type': 'video/mp4'
  }))
  const legacyResult = await legacyClient.downloadToken('legacyToken123', 'drive-file')
  assert.ok(Buffer.isBuffer(legacyResult.buffer), '旧 downloadToken 必须继续返回 Buffer')
  assert.deepStrictEqual(legacyResult.buffer, legacyBody, '旧 downloadToken 返回内容不得改变')
  assert.strictEqual(legacyResult.size, legacyBody.length, '旧 downloadToken 大小语义不得改变')
  assert.strictEqual(legacyResult.contentType, 'video/mp4', '旧 downloadToken MIME 语义不得改变')
  assert.strictEqual(
    legacyResult.contentSha256,
    crypto.createHash('sha256').update(legacyBody).digest('hex'),
    '旧 downloadToken SHA-256 语义不得改变'
  )
}

function preparedVideoFixture() {
  const sourceBuffer = Buffer.from('prepared-source-video')
  const outputBuffer = Buffer.from('prepared-output-video')
  return {
    sourceBuffer,
    outputBuffer,
    prepared: {
      temporaryPath: 'isolated-prepared-video.tmp',
      buffer: outputBuffer,
      sourceContentSha256: crypto.createHash('sha256').update(sourceBuffer).digest('hex'),
      sourceSize: sourceBuffer.length,
      sourceMimeType: 'video/mp4',
      kind: 'video',
      extension: 'mp4',
      contentSha256: crypto.createHash('sha256').update(outputBuffer).digest('hex'),
      size: outputBuffer.length,
      contentType: 'video/mp4',
      transformProfileVersion: 'test-video-profile-v1',
      transformProfileSha256: crypto.createHash('sha256').update('test-video-profile-v1').digest('hex'),
      transformToolFingerprint: crypto.createHash('sha256').update('test-ffmpeg-tool').digest('hex'),
      transformAction: 'compress'
    }
  }
}

function guardedMaterialTargets(writeCalls) {
  return {
    drive: {
      async downloadToken() {
        const sourceBuffer = preparedVideoFixture().sourceBuffer
        return {
          buffer: sourceBuffer,
          size: sourceBuffer.length,
          contentType: 'video/mp4',
          contentSha256: crypto.createHash('sha256').update(sourceBuffer).digest('hex')
        }
      },
      async ensureListingFolder() {
        writeCalls.push('drive-folder')
        throw new Error('清理失败用例不得创建 Drive 目录')
      },
      async materializeAsset() {
        writeCalls.push('drive-material')
        throw new Error('清理失败用例不得写入 Drive 素材')
      }
    },
    oss: {
      async putMaterialDeterministic() {
        writeCalls.push('oss-material')
        throw new Error('清理失败用例不得写入 OSS 素材')
      }
    }
  }
}

async function testPreparedMaterialFailureDisposal() {
  const asset = {
    ...syntheticAssets()[0],
    kind: 'video'
  }

  {
    const { prepared } = preparedVideoFixture()
    const verifierFailure = new Error('受信处理产物复验失败')
    const disposed = []
    const firstCleanupFailure = new Error('第一次清理暂时失败')
    const writeCalls = []
    const targets = guardedMaterialTargets(writeCalls)
    await assert.rejects(
      syncNoteMaterialVideos({
        sourceRecordId: 'dispose-after-verifier-failure',
        assets: [asset],
        uploadDir: 'house-videos',
        drive: targets.drive,
        oss: targets.oss,
        async prepareMaterial() {
          return prepared
        },
        async verifyPreparedMaterial(received) {
          assert.strictEqual(received, prepared, '复验必须接收处理器返回的同一受信对象')
          throw verifierFailure
        },
        async disposePreparedMaterial(received) {
          disposed.push(received)
          if (disposed.length === 1) throw firstCleanupFailure
        }
      }),
      (error) => error === verifierFailure,
      '处理产物复验失败必须保留原始错误'
    )
    assert.deepStrictEqual(disposed, [prepared, prepared], '复验失败后的清理首次失败时必须重试且恰好两次')
    assert.deepStrictEqual(writeCalls, [], '复验失败不得发生 Drive 或 OSS 写入')
  }

  {
    const { prepared } = preparedVideoFixture()
    const invalidPrepared = {
      ...prepared,
      size: 0
    }
    const disposed = []
    const firstCleanupFailure = new Error('第一次清理暂时失败')
    const writeCalls = []
    const targets = guardedMaterialTargets(writeCalls)
    await assert.rejects(
      syncNoteMaterialVideos({
        sourceRecordId: 'dispose-after-normalization-failure',
        assets: [asset],
        uploadDir: 'house-videos',
        drive: targets.drive,
        oss: targets.oss,
        async prepareMaterial() {
          return invalidPrepared
        },
        async disposePreparedMaterial(received) {
          disposed.push(received)
          if (disposed.length === 1) throw firstCleanupFailure
        }
      }),
      /大小|摘要|无效/,
      '处理产物字段规范化失败必须拒绝同步'
    )
    assert.deepStrictEqual(disposed, [invalidPrepared, invalidPrepared], '字段规范化失败后的清理首次失败时必须重试且恰好两次')
    assert.deepStrictEqual(writeCalls, [], '字段规范化失败不得发生 Drive 或 OSS 写入')
  }
}

function successfulPreparedMaterialTargets(writeCalls, outputBuffer) {
  return {
    drive: {
      async downloadToken() {
        const sourceBuffer = preparedVideoFixture().sourceBuffer
        return {
          buffer: sourceBuffer,
          size: sourceBuffer.length,
          contentType: 'video/mp4',
          contentSha256: crypto.createHash('sha256').update(sourceBuffer).digest('hex')
        }
      },
      async ensureListingFolder() {
        writeCalls.push('drive-folder')
        return { token: 'cleanupRetryTargetFolder123' }
      },
      async materializeAsset(input) {
        writeCalls.push('drive-material')
        assert.strictEqual(input.sourceEvidence.buffer, outputBuffer, 'Drive 必须接收受信处理后的同一 Buffer')
        return {
          targetToken: 'cleanupRetryTargetFile123',
          targetName: input.targetName,
          buffer: input.sourceEvidence.buffer,
          contentType: input.sourceEvidence.contentType,
          contentSha256: input.sourceEvidence.contentSha256,
          size: input.sourceEvidence.size,
          verified: true
        }
      }
    },
    oss: {
      async putMaterialDeterministic(input) {
        writeCalls.push('oss-material')
        assert.strictEqual(input.buffer, outputBuffer, 'OSS 必须沿用 Drive 回读的同一处理后 Buffer')
        return {
          objectKey: input.objectKey,
          contentSha256: input.contentSha256,
          size: input.buffer.length,
          verified: true
        }
      }
    }
  }
}

async function testPreparedMaterialFinallyDisposalRetry() {
  const asset = {
    ...syntheticAssets()[0],
    kind: 'video'
  }

  {
    const { prepared, outputBuffer } = preparedVideoFixture()
    const writeCalls = []
    const targets = successfulPreparedMaterialTargets(writeCalls, outputBuffer)
    let cleanupAttempts = 0
    let cleanupTarget = null
    const result = await syncNoteMaterialVideos({
      sourceRecordId: 'dispose-retry-after-success',
      assets: [asset],
      uploadDir: 'house-videos',
      drive: targets.drive,
      oss: targets.oss,
      async prepareMaterial() {
        return prepared
      },
      async disposePreparedMaterial(received) {
        if (!cleanupTarget) cleanupTarget = received
        assert.strictEqual(received, cleanupTarget, 'finally 两次清理必须接收同一规范化受信对象')
        cleanupAttempts += 1
        if (cleanupAttempts === 1) throw new Error('第一次清理暂时失败')
      }
    })
    assert.strictEqual(cleanupAttempts, 2, '正常处理完成后首次清理失败必须重试且恰好两次')
    assert.strictEqual(result.mediaAssets.length, 1, '第二次清理成功后允许返回完整媒体清单')
    assert.deepStrictEqual(
      writeCalls,
      ['drive-folder', 'drive-material', 'oss-material'],
      '清理重试不得导致 Drive 或 OSS 重复写入'
    )
  }

  {
    const { prepared, outputBuffer } = preparedVideoFixture()
    const writeCalls = []
    const targets = successfulPreparedMaterialTargets(writeCalls, outputBuffer)
    const cleanupFailures = [
      new Error('第一次清理失败'),
      new Error('第二次清理仍失败')
    ]
    let cleanupAttempts = 0
    let cleanupTarget = null
    let publishedResult = null
    await assert.rejects(
      async () => {
        publishedResult = await syncNoteMaterialVideos({
          sourceRecordId: 'dispose-fail-closed-after-success',
          assets: [asset],
          uploadDir: 'house-videos',
          drive: targets.drive,
          oss: targets.oss,
          async prepareMaterial() {
            return prepared
          },
          async disposePreparedMaterial(received) {
            if (!cleanupTarget) cleanupTarget = received
            assert.strictEqual(received, cleanupTarget, '失败清理必须始终针对同一规范化受信对象')
            const failure = cleanupFailures[cleanupAttempts]
            cleanupAttempts += 1
            throw failure
          }
        })
      },
      (error) => error === cleanupFailures[1],
      '两次清理都失败时必须以第二次确定性清理错误 fail-closed'
    )
    assert.strictEqual(cleanupAttempts, 2, '清理连续失败时最多且必须尝试两次')
    assert.strictEqual(publishedResult, null, '清理未完成不得伪装成功或提交媒体清单')
    assert.deepStrictEqual(
      writeCalls,
      ['drive-folder', 'drive-material', 'oss-material'],
      '外部内容寻址写已完成时只保留既有语义，不得因清理失败伪造回滚或重复写入'
    )
  }
}

async function testConfirmedFormalSyncStreamsOneCompressedFileOnce() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ynzy-note-material-confirmed-'))
  const sourceBuffer = Buffer.from('oversized-source-video-that-needs-compression')
  const outputBuffer = Buffer.from('compressed-video')
  const sourceContentSha256 = crypto.createHash('sha256').update(sourceBuffer).digest('hex')
  const outputContentSha256 = crypto.createHash('sha256').update(outputBuffer).digest('hex')
  const transformProfileVersion = 'test-streaming-compression-v1'
  const transformProfileSha256 = crypto.createHash('sha256').update(transformProfileVersion).digest('hex')
  const transformToolFingerprint = crypto.createHash('sha256').update('test-streaming-ffmpeg').digest('hex')
  const asset = {
    ...syntheticAssets()[0],
    kind: 'video',
    size: sourceBuffer.length,
    mimeType: 'video/mp4'
  }
  let sourceDownloads = 0
  let prepareCalls = 0
  let retainedFiles = 0
  let maximumRetainedFiles = 0
  let disposedFiles = 0
  let driveDescriptor = null
  let ossDescriptor = null
  let folderWrites = 0
  let driveWrites = 0
  let ossWrites = 0
  let lastPreparedPath = ''

  const drive = {
    async downloadTokenToFile(sourceToken, sourceKind, options = {}) {
      assert.strictEqual(sourceToken, asset.sourceToken, '流式源下载必须绑定当前素材 token')
      assert.strictEqual(sourceKind, asset.sourceKind, '流式源下载必须绑定当前素材类型')
      assert.ok(options.fileHandle && typeof options.fileHandle.write === 'function', '流式源下载必须写入受信文件句柄')
      sourceDownloads += 1
      await options.fileHandle.truncate(0)
      await options.fileHandle.write(sourceBuffer, 0, sourceBuffer.length, 0)
      await options.fileHandle.sync()
      return {
        size: sourceBuffer.length,
        contentType: 'video/mp4',
        contentSha256: sourceContentSha256
      }
    },
    async ensureListingFolder() {
      folderWrites += 1
      return { token: 'confirmedStreamingFolder123' }
    },
    async materializeAsset(input) {
      driveWrites += 1
      assert.ok(input.sourceEvidence && typeof input.sourceEvidence.filePath === 'string', 'Drive 必须接收压缩后文件路径')
      assert.strictEqual(Object.prototype.hasOwnProperty.call(input.sourceEvidence, 'buffer'), false, 'Drive 输入不得携带整文件 Buffer')
      assert.strictEqual(await fs.readFile(input.sourceEvidence.filePath, 'utf8'), outputBuffer.toString('utf8'), 'Drive 必须读取压缩后的同一临时文件')
      driveDescriptor = {
        filePath: input.sourceEvidence.filePath,
        size: input.sourceEvidence.size,
        contentSha256: input.sourceEvidence.contentSha256
      }
      return {
        targetToken: 'confirmedStreamingTarget123',
        targetName: input.targetName,
        contentType: input.sourceEvidence.contentType,
        contentSha256: input.sourceEvidence.contentSha256,
        size: input.sourceEvidence.size,
        verified: true
      }
    }
  }

  const oss = {
    async putMaterialDeterministic(input) {
      ossWrites += 1
      assert.strictEqual(Object.prototype.hasOwnProperty.call(input, 'buffer'), false, 'OSS 输入不得携带整文件 Buffer')
      assert.strictEqual(await fs.readFile(input.filePath, 'utf8'), outputBuffer.toString('utf8'), 'OSS 必须复用 Drive 已读取的同一压缩文件')
      ossDescriptor = {
        filePath: input.filePath,
        size: input.size,
        contentSha256: input.contentSha256
      }
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.size,
        verified: true
      }
    }
  }

  async function prepareMaterial({ sourceEvidence, keepPreparedFile }) {
    prepareCalls += 1
    const sourcePath = path.join(tempRoot, `source-${prepareCalls}.tmp`)
    const sourceHandle = await fs.open(sourcePath, 'w+')
    let receipt
    try {
      receipt = await sourceEvidence.downloadToFile({
        fileHandle: sourceHandle,
        maxBytes: 1024 * 1024
      })
    } finally {
      await sourceHandle.close()
      await fs.rm(sourcePath, { force: true })
    }
    assert.deepStrictEqual(
      [receipt.size, receipt.contentSha256, receipt.contentType],
      [sourceBuffer.length, sourceContentSha256, 'video/mp4'],
      '压缩器必须先完整核验源文件大小、摘要与类型'
    )
    let temporaryPath = ''
    if (keepPreparedFile === true) {
      temporaryPath = path.join(tempRoot, `prepared-${prepareCalls}.mp4`)
      await fs.writeFile(temporaryPath, outputBuffer, { flag: 'wx' })
      lastPreparedPath = temporaryPath
      retainedFiles += 1
      maximumRetainedFiles = Math.max(maximumRetainedFiles, retainedFiles)
    }
    return {
      temporaryPath,
      sourceContentSha256,
      sourceSize: sourceBuffer.length,
      sourceMimeType: 'video/mp4',
      kind: 'video',
      extension: 'mp4',
      contentSha256: outputContentSha256,
      size: outputBuffer.length,
      contentType: 'video/mp4',
      transformProfileVersion,
      transformProfileSha256,
      transformToolFingerprint,
      transformAction: 'transcode'
    }
  }

  async function openPreparedFile(prepared) {
    assert.ok(prepared.temporaryPath, '正式同步必须保留且只保留当前压缩成品')
    return {
      filePath: prepared.temporaryPath,
      size: prepared.size,
      contentSha256: prepared.contentSha256,
      contentType: prepared.contentType,
      extension: prepared.extension,
      kind: prepared.kind
    }
  }

  async function disposePreparedMaterial(prepared) {
    if (!prepared.temporaryPath) return
    await fs.rm(prepared.temporaryPath, { force: true })
    retainedFiles -= 1
    disposedFiles += 1
  }

  try {
    const dryRun = await syncNoteMaterialVideos({
      sourceRecordId: 'confirmed-streaming-record',
      assets: [asset],
      existingMediaAssets: [],
      uploadDir: 'house-videos',
      dryRun: true,
      drive,
      oss,
      prepareMaterial,
      openPreparedFile,
      disposePreparedMaterial,
      requireStreamingSource: true
    })
    dryRun.complete = true
    const confirmation = noteMaterialSync._internal.contentPlanConfirmationFromReport(dryRun)
    assert.deepStrictEqual(
      [dryRun.normalization.transcoded, dryRun.normalization.sourceBytes, dryRun.normalization.outputBytes],
      [1, sourceBuffer.length, outputBuffer.length],
      'dry-run 必须形成可确认的大视频压缩计划'
    )

    sourceDownloads = 0
    prepareCalls = 0
    maximumRetainedFiles = 0
    disposedFiles = 0
    const formal = await syncNoteMaterialVideos({
      sourceRecordId: 'confirmed-streaming-record',
      assets: [asset],
      existingMediaAssets: [],
      uploadDir: 'house-videos',
      drive,
      oss,
      prepareMaterial,
      openPreparedFile,
      disposePreparedMaterial,
      requireStreamingSource: true,
      sourcesGloballyVerified: true,
      expectedContentPlanEvidence: confirmation.expectedContentPlanEvidence
    })

    assert.deepStrictEqual(
      [prepareCalls, sourceDownloads, maximumRetainedFiles, retainedFiles, disposedFiles],
      [1, 1, 1, 0, 1],
      '确认后的正式同步必须只下载和压缩一次、最多保留一个临时成品并立即清理'
    )
    assert.deepStrictEqual(ossDescriptor, driveDescriptor, '飞书云盘与 OSS 必须复用同一文件路径、大小和摘要')
    assert.strictEqual(await fs.stat(driveDescriptor.filePath).then(() => true, () => false), false, '双目标回读完成后必须立即删除压缩临时文件')
    assert.deepStrictEqual(
      [formal.counts.source, formal.counts.transferred, formal.counts.driveVerified, formal.counts.ossVerified],
      [1, 1, 1, 1],
      '压缩素材必须在飞书云盘、OSS 与最终清单中同时验收通过'
    )

    const descriptorMutations = [
      ['contentSha256', crypto.createHash('sha256').update('wrong-output').digest('hex')],
      ['size', outputBuffer.length + 1],
      ['contentType', 'image/jpeg'],
      ['kind', 'image'],
      ['extension', 'webm'],
      ['filePath', ''],
      ['buffer', Buffer.from('descriptor-must-not-carry-buffer')]
    ]
    for (const [field, value] of descriptorMutations) {
      sourceDownloads = 0
      prepareCalls = 0
      retainedFiles = 0
      maximumRetainedFiles = 0
      disposedFiles = 0
      folderWrites = 0
      driveWrites = 0
      ossWrites = 0
      lastPreparedPath = ''
      await assert.rejects(
        () => syncNoteMaterialVideos({
          sourceRecordId: 'confirmed-streaming-record',
          assets: [asset],
          existingMediaAssets: [],
          uploadDir: 'house-videos',
          drive,
          oss,
          prepareMaterial,
          openPreparedFile: async (prepared) => ({
            ...await openPreparedFile(prepared),
            [field]: value
          }),
          disposePreparedMaterial,
          requireStreamingSource: true,
          sourcesGloballyVerified: true,
          expectedContentPlanEvidence: confirmation.expectedContentPlanEvidence
        }),
        `写入描述符 ${field} 被变异时必须在任何目标写入前拒绝`
      )
      assert.deepStrictEqual(
        [folderWrites, driveWrites, ossWrites, prepareCalls, retainedFiles, disposedFiles],
        [0, 0, 0, 1, 0, 1],
        `写入描述符 ${field} 被变异时不得创建目录或写入 Drive/OSS，且必须清理临时文件`
      )
      assert.strictEqual(
        await fs.stat(lastPreparedPath).then(() => true, () => false),
        false,
        `写入描述符 ${field} 被拒绝后不得残留压缩临时文件`
      )
    }

    const sourceIdentityMutations = [
      ['sourceContentSha256', crypto.createHash('sha256').update('changed-source').digest('hex')],
      ['sourceSize', sourceBuffer.length + 1],
      ['sourceMimeType', 'video/quicktime']
    ]
    for (const [field, value] of sourceIdentityMutations) {
      sourceDownloads = 0
      prepareCalls = 0
      retainedFiles = 0
      maximumRetainedFiles = 0
      disposedFiles = 0
      folderWrites = 0
      driveWrites = 0
      ossWrites = 0
      lastPreparedPath = ''
      await assert.rejects(
        () => syncNoteMaterialVideos({
          sourceRecordId: 'confirmed-streaming-record',
          assets: [asset],
          existingMediaAssets: [],
          uploadDir: 'house-videos',
          drive,
          oss,
          prepareMaterial: async (input) => ({
            ...await prepareMaterial(input),
            [field]: value
          }),
          openPreparedFile,
          disposePreparedMaterial,
          requireStreamingSource: true,
          sourcesGloballyVerified: true,
          expectedContentPlanEvidence: confirmation.expectedContentPlanEvidence
        }),
        `压缩结果携带的源身份 ${field} 发生变化时必须在任何目标写入前拒绝`
      )
      assert.deepStrictEqual(
        [folderWrites, driveWrites, ossWrites, prepareCalls, retainedFiles, disposedFiles],
        [0, 0, 0, 1, 0, 1],
        `源身份 ${field} 变化时不得创建目录或写入 Drive/OSS，且必须清理临时文件`
      )
      assert.strictEqual(
        await fs.stat(lastPreparedPath).then(() => true, () => false),
        false,
        `源身份 ${field} 变化被拒绝后不得残留压缩临时文件`
      )
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

function assertBoundedMaterialMemory() {
  const syncModulePath = require.resolve('../src/feishu-note-material-sync')
  const probe = `
    'use strict'
    const crypto = require('crypto')
    const { syncNoteMaterialVideos } = require(${JSON.stringify(syncModulePath)})
    const ONE_MB = 1024 * 1024
    ;(async () => {
      if (typeof global.gc !== 'function') throw new Error('内存探针缺少显式 GC')
      for (let index = 0; index < 3; index += 1) global.gc()
      const baselineExternal = process.memoryUsage().external
      let peakExternal = baselineExternal
      const assets = Array.from({ length: 64 }, (_, index) => ({
        sourceToken: 'memoryVideoToken' + String(index).padStart(3, '0'),
        sourceKind: 'drive-file',
        name: 'memory-' + index + '.mp4',
        extension: 'mp4',
        mimeType: 'video/mp4',
        sourceOrder: index,
        sourceFingerprint: 'memory-source-' + index
      }))
      const result = await syncNoteMaterialVideos({
        sourceRecordId: 'memory-record-64',
        assets,
        uploadDir: 'house-videos',
        dryRun: true,
        drive: {
          async downloadToken(sourceToken) {
            global.gc()
            const buffer = Buffer.alloc(ONE_MB, sourceToken.charCodeAt(sourceToken.length - 1))
            peakExternal = Math.max(peakExternal, process.memoryUsage().external)
            return {
              buffer,
              size: buffer.length,
              contentType: 'video/mp4',
              contentSha256: crypto.createHash('sha256').update(buffer).digest('hex')
            }
          }
        }
      })
      process.stdout.write(JSON.stringify({
        count: result.mediaAssets.length,
        peakExternalDelta: peakExternal - baselineExternal
      }))
    })().catch((error) => {
      process.stderr.write(error && error.stack || String(error))
      process.exit(1)
    })
  `
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', probe], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  assert.strictEqual(child.status, 0, `素材有界内存探针必须成功：${String(child.stderr || '').slice(0, 300)}`)
  const measured = JSON.parse(String(child.stdout || '{}'))
  assert.strictEqual(measured.count, 64, '有界内存探针必须真实处理满额 64 个视频')
  assert.ok(
    Number(measured.peakExternalDelta) < 8 * 1024 * 1024,
    `64 个视频 dry-run 的存活 Buffer 峰值必须保持单文件级，实际 ${measured.peakExternalDelta} 字节`
  )

  const formalProbe = `
    'use strict'
    const crypto = require('crypto')
    const { syncNoteMaterialVideos } = require(${JSON.stringify(syncModulePath)})
    const ONE_MB = 1024 * 1024
    ;(async () => {
      if (typeof global.gc !== 'function') throw new Error('正式同步内存探针缺少显式 GC')
      for (let index = 0; index < 3; index += 1) global.gc()
      const baselineExternal = process.memoryUsage().external
      let peakExternal = baselineExternal
      let sourceReads = 0
      const assets = Array.from({ length: 64 }, (_, index) => ({
        sourceToken: 'formalMemoryToken' + String(index).padStart(3, '0'),
        sourceKind: 'drive-file',
        name: 'formal-memory-' + index + '.mp4',
        extension: 'mp4',
        mimeType: 'video/mp4',
        sourceOrder: index,
        sourceFingerprint: 'formal-memory-source-' + index
      }))
      const result = await syncNoteMaterialVideos({
        sourceRecordId: 'formal-memory-record-64',
        assets,
        uploadDir: 'house-videos',
        drive: {
          async downloadToken(sourceToken) {
            sourceReads += 1
            global.gc()
            const buffer = Buffer.alloc(ONE_MB, sourceToken.charCodeAt(sourceToken.length - 1))
            peakExternal = Math.max(peakExternal, process.memoryUsage().external)
            return {
              buffer,
              size: buffer.length,
              contentType: 'video/mp4',
              contentSha256: crypto.createHash('sha256').update(buffer).digest('hex')
            }
          },
          async ensureListingFolder() {
            return { token: 'formalMemoryFolder123' }
          },
          async materializeVideo(input) {
            return {
              targetToken: 'formalMemoryTarget' + input.asset.sourceOrder,
              targetName: input.targetName,
              buffer: input.sourceEvidence.buffer,
              contentType: input.sourceEvidence.contentType,
              contentSha256: input.sourceEvidence.contentSha256,
              size: input.sourceEvidence.size,
              verified: true
            }
          }
        },
        oss: {
          async putVideoDeterministic(input) {
            return {
              objectKey: input.objectKey,
              contentSha256: input.contentSha256,
              size: input.buffer.length,
              verified: true
            }
          }
        }
      })
      process.stdout.write(JSON.stringify({
        count: result.mediaAssets.length,
        sourceReads,
        peakExternalDelta: peakExternal - baselineExternal
      }))
    })().catch((error) => {
      process.stderr.write(error && error.stack || String(error))
      process.exit(1)
    })
  `
  const formalChild = spawnSync(process.execPath, ['--expose-gc', '-e', formalProbe], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  assert.strictEqual(formalChild.status, 0, `正式素材有界内存探针必须成功：${String(formalChild.stderr || '').slice(0, 300)}`)
  const formalMeasured = JSON.parse(String(formalChild.stdout || '{}'))
  assert.deepStrictEqual(
    [formalMeasured.count, formalMeasured.sourceReads],
    [64, 192],
    '正式内存探针必须真实处理满额 64 个视频并完成三遍受限读取'
  )
  assert.ok(
    Number(formalMeasured.peakExternalDelta) < 8 * 1024 * 1024,
    `64 个视频正式同步的存活 Buffer 峰值必须保持单文件级，实际 ${formalMeasured.peakExternalDelta} 字节`
  )
}

async function run() {
  await testStreamingMaterialClient()
  await testPreparedMaterialFailureDisposal()
  await testPreparedMaterialFinallyDisposalRetry()
  await testConfirmedFormalSyncStreamsOneCompressedFileOnce()
  assert.strictEqual(domain.MAX_LISTING_MEDIA_ASSETS, 64, '单套房源视频素材安全上限必须固定为 64')
  assert.throws(
    () => assertIsolatedStatePaths('D:\\state\\legacy.json', 'D:\\state\\legacy.json'),
    /独立|重合/,
    '新链路不得复用旧素材迁移回执'
  )
  assert.doesNotThrow(
    () => assertIsolatedStatePaths('D:\\state\\legacy.json', 'D:\\state\\note-v1.json'),
    '独立状态文件应允许使用'
  )

  const stableA = stableAssetId('source-record-1', syntheticAssets()[0])
  assert.strictEqual(stableA, stableAssetId('source-record-1', syntheticAssets()[0]), 'assetId 必须稳定')
  assert.notStrictEqual(stableA, stableAssetId('source-record-2', syntheticAssets()[0]), '跨房源不得共享素材身份')
  assert.strictEqual(
    stableA,
    stableAssetId('source-record-1', {
      ...syntheticAssets()[0],
      sourceFingerprint: 'source-fingerprint-a-version-2',
      modifiedTime: '99',
      size: 999
    }),
    '同一源 token 内容或元数据更新时匿名 assetId 必须保持稳定'
  )

  assert.doesNotThrow(() => assertMaterialSetEquality({
    source: ['a', 'b'],
    drive: ['b', 'a'],
    oss: ['a', 'b'],
    manifest: ['a', 'b']
  }))
  assert.throws(() => assertMaterialSetEquality({
    source: ['a', 'b'],
    drive: ['a'],
    oss: ['a', 'b'],
    manifest: ['a', 'b']
  }), /集合|一致/, '只比数量或漏掉任一目标素材必须失败')

  const calls = []
  const sourceBodies = new Map(syntheticAssets().map((asset) => [
    asset.sourceToken,
    Buffer.from(`body:${asset.sourceToken}`)
  ]))
  let sourceReadCalls = 0
  const sourceLifecycle = []
  const latestDownloadedBuffer = new Map()
  const drive = {
    async downloadToken(sourceToken) {
      sourceReadCalls += 1
      sourceLifecycle.push(`download:${sourceToken}`)
      const buffer = Buffer.from(sourceBodies.get(sourceToken))
      latestDownloadedBuffer.set(sourceToken, buffer)
      return {
        buffer,
        contentType: 'video/mp4',
        contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        size: buffer.length
      }
    },
    async ensureListingFolder(input) {
      calls.push(['folder', input.sourceRecordId])
      return { token: 'fldTargetListing123' }
    },
    async materializeVideo(input) {
      sourceLifecycle.push(`consume:${input.asset.sourceToken}`)
      assert.strictEqual(
        input.sourceEvidence.buffer,
        latestDownloadedBuffer.get(input.asset.sourceToken),
        '素材适配器之间必须沿用同一独占 Buffer 引用，不得为单个大视频再复制整段内存'
      )
      calls.push(['drive', input.asset.sourceToken, input.targetName])
      const buffer = Buffer.from(input.sourceEvidence.buffer)
      return {
        targetToken: `target-${input.asset.sourceToken}`,
        targetName: input.targetName,
        buffer,
        contentType: input.sourceEvidence.contentType,
        contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        size: buffer.length,
        verified: true
      }
    }
  }
  const oss = {
    async putVideoDeterministic(input) {
      calls.push(['oss', input.objectKey, input.contentSha256])
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    }
  }

  const result = await syncNoteMaterialVideos({
    sourceRecordId: 'source-record-1',
    assets: syntheticAssets(),
    existingMediaAssets: [],
    uploadDir: 'house-videos',
    drive,
    oss
  })
  assert.strictEqual(result.mediaAssets.length, 2, '全部视频必须进入私有素材数组')
  assert.strictEqual(result.primaryVideo.assetId, result.mediaAssets[0].assetId, '首个稳定顺序视频作为兼容主视频')
  assert.ok(result.mediaAssets.every((asset) => !asset.sourceToken), '落库素材不得保留原始飞书 token')
  assert.ok(result.mediaAssets.every((asset) => /^house-videos\/feishu-note-v1\//.test(asset.objectKey)), 'OSS 对象键必须确定且位于专用目录')
  assert.deepStrictEqual(result.counts, {
    source: 2,
    driveVerified: 2,
    ossVerified: 2,
    manifest: 2,
    reused: 0,
    transferred: 2
  })
  assert.deepStrictEqual(
    sourceLifecycle,
    [
      'download:boxSourceA123456',
      'download:mediaSourceB123456',
      'download:boxSourceA123456',
      'download:mediaSourceB123456',
      'download:boxSourceA123456',
      'consume:boxSourceA123456',
      'download:mediaSourceB123456',
      'consume:mediaSourceB123456'
    ],
    '正式同步必须先形成无 Buffer 计划、再全批预检，全部通过后才逐项重下、消费并释放'
  )
  const initialDriveTargetName = calls.find((call) => call[0] === 'drive')[2]
  assert.ok(
    initialDriveTargetName.includes(result.mediaAssets[0].contentSha256),
    '目标 Drive 文件名必须包含真实内容 SHA-256'
  )

  const mixedAssets = [
    {
      sourceToken: 'mediaMixedImage123456',
      sourceKind: 'docx-image',
      name: 'image',
      extension: '',
      kind: 'image',
      mimeType: 'image/*',
      modifiedTime: '',
      size: null,
      sourceOrder: 0,
      sourceFingerprint: 'mixed-image-source'
    },
    {
      ...syntheticAssets()[0],
      sourceOrder: 1
    }
  ]
  const mixedBodies = new Map([
    ['mediaMixedImage123456', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('mixed-image')])],
    [syntheticAssets()[0].sourceToken, Buffer.from('mixed-video')]
  ])
  const mixedDrive = {
    async downloadToken(sourceToken) {
      const buffer = Buffer.from(mixedBodies.get(sourceToken))
      return {
        buffer,
        contentType: sourceToken === 'mediaMixedImage123456' ? 'application/octet-stream' : 'video/mp4',
        contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        size: buffer.length
      }
    },
    async ensureListingFolder() {
      return { token: 'mixedTargetFolder123' }
    },
    async materializeAsset(input) {
      return {
        targetToken: `mixed-target-${input.asset.sourceOrder}`,
        targetName: input.targetName,
        buffer: input.sourceEvidence.buffer,
        contentType: input.sourceEvidence.contentType,
        contentSha256: input.sourceEvidence.contentSha256,
        size: input.sourceEvidence.size,
        verified: true
      }
    }
  }
  const mixedOss = {
    async putMaterialDeterministic(input) {
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.buffer.length,
        verified: true
      }
    }
  }
  const mixedResult = await syncNoteMaterialVideos({
    sourceRecordId: 'source-record-mixed',
    assets: mixedAssets,
    existingMediaAssets: [],
    uploadDir: 'house-videos',
    drive: mixedDrive,
    oss: mixedOss
  })
  assert.deepStrictEqual(mixedResult.mediaAssets.map((asset) => asset.kind), ['image', 'video'])
  assert.deepStrictEqual(mixedResult.mediaAssets.map((asset) => asset.mimeType), ['image/jpeg', 'video/mp4'])
  assert.ok(mixedResult.mediaAssets[0].objectKey.endsWith('.jpg'), 'Docx 图片必须根据真实字节签名确定安全扩展名')
  await assert.rejects(
    () => syncNoteMaterialVideos({
      sourceRecordId: 'record-invalid-image-bytes',
      assets: [{
        ...mixedAssets[0],
        sourceToken: 'mediaInvalidImage123',
        name: 'invalid.jpg',
        extension: 'jpg',
        mimeType: 'image/jpeg'
      }],
      uploadDir: 'house-videos',
      dryRun: true,
      drive: {
        async downloadToken() {
          const buffer = Buffer.from('not-an-image')
          return {
            buffer,
            contentType: 'image/jpeg',
            contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            size: buffer.length
          }
        }
      }
    }),
    /真实字节类型不受支持/,
    '声明为 JPEG 的普通文档或伪造字节必须在任何 Drive/OSS 写入前 fail-closed'
  )
  assert.strictEqual(mixedResult.primaryVideo.assetId, mixedResult.mediaAssets[1].assetId, '兼容主视频必须跳过排在前面的图片')

  calls.length = 0
  sourceLifecycle.length = 0
  const changedVersion = await syncNoteMaterialVideos({
    sourceRecordId: 'source-record-1',
    assets: [{
      ...syntheticAssets()[0],
      sourceFingerprint: 'source-fingerprint-a-version-2',
      modifiedTime: '99',
      size: 999
    }],
    existingMediaAssets: [result.mediaAssets[0]],
    uploadDir: 'house-videos',
    drive,
    oss,
    verifyExisting: async () => ({ sourceVerified: true, driveVerified: true, ossVerified: true })
  })
  assert.strictEqual(changedVersion.mediaAssets[0].assetId, result.mediaAssets[0].assetId)
  assert.strictEqual(changedVersion.mediaAssets[0].objectKey, result.mediaAssets[0].objectKey, '元数据变化但内容未变时内容地址必须稳定')
  assert.strictEqual(changedVersion.mediaAssets[0].sourceFingerprint, 'source-fingerprint-a-version-2', '复用内容时仍应更新当前源元数据指纹')
  assert.strictEqual(changedVersion.counts.reused, 1)

  calls.length = 0
  sourceLifecycle.length = 0
  const sourceReadsBeforeDryRun = sourceReadCalls
  const dryRun = await syncNoteMaterialVideos({
    sourceRecordId: 'source-record-1',
    assets: syntheticAssets(),
    existingMediaAssets: [],
    uploadDir: 'house-videos',
    drive,
    oss,
    dryRun: true
  })
  assert.strictEqual(calls.length, 0, 'dry-run 必须对 Drive 与 OSS 零写')
  assert.strictEqual(sourceReadCalls - sourceReadsBeforeDryRun, 2, 'dry-run 必须只读下载全部源内容，生成真实内容寻址计划')
  assert.deepStrictEqual(
    sourceLifecycle,
    ['download:boxSourceA123456', 'download:mediaSourceB123456'],
    'dry-run 只允许一次逐项源读取，不得为写阶段重复下载或持久化'
  )
  assert.strictEqual(dryRun.mediaAssets.length, 2, 'dry-run 仍应返回完整确定性计划')
  assert.ok(dryRun.mediaAssets.every((asset) => asset.contentSha256 && asset.objectKey.includes(asset.contentSha256)), 'dry-run 计划必须包含真实内容 SHA 和最终 OSS 键')

  calls.length = 0
  sourceLifecycle.length = 0
  const repeated = await syncNoteMaterialVideos({
    sourceRecordId: 'source-record-1',
    assets: syntheticAssets(),
    existingMediaAssets: result.mediaAssets,
    uploadDir: 'house-videos',
    drive,
    oss,
    verifyExisting: async () => ({ sourceVerified: true, driveVerified: true, ossVerified: true })
  })
  assert.deepStrictEqual(
    calls,
    [['folder', 'source-record-1']],
    '素材集合未变时只允许回读稳定目录，不得重复复制 Drive 文件或覆盖 OSS'
  )
  assert.strictEqual(repeated.counts.reused, 2)
  assert.strictEqual(repeated.counts.transferred, 0)

  calls.length = 0
  sourceLifecycle.length = 0
  syntheticAssets().forEach((asset) => {
    sourceBodies.set(asset.sourceToken, Buffer.from(`changed:${asset.sourceToken}`))
  })
  const sourceChangedWithoutMetadataChange = await syncNoteMaterialVideos({
    sourceRecordId: 'source-record-1',
    assets: syntheticAssets(),
    existingMediaAssets: result.mediaAssets,
    uploadDir: 'house-videos',
    drive,
    oss,
    verifyExisting: async () => ({ sourceVerified: true, driveVerified: true, ossVerified: true })
  })
  assert.strictEqual(sourceChangedWithoutMetadataChange.counts.reused, 0, '源内容未回读一致时不得复用旧素材')
  assert.strictEqual(sourceChangedWithoutMetadataChange.counts.transferred, 2, '同 token 元数据未变但源内容变化时必须重新物化')
  assert.strictEqual(calls.filter((call) => call[0] === 'drive').length, 2)

  const changingSourceReads = new Map()
  let writesAfterSourceChanged = 0
  const changingAssets = syntheticAssets()
  await assert.rejects(
    () => syncNoteMaterialVideos({
      sourceRecordId: 'source-record-changing',
      assets: changingAssets,
      existingMediaAssets: [],
      uploadDir: 'house-videos',
      drive: {
        async downloadToken(sourceToken) {
          const readCount = (changingSourceReads.get(sourceToken) || 0) + 1
          changingSourceReads.set(sourceToken, readCount)
          const secondToken = changingAssets[1].sourceToken
          const body = sourceToken === secondToken && readCount === 2
            ? 'second-source-changed-before-any-write'
            : `stable-source:${sourceToken}`
          const buffer = Buffer.from(body)
          return {
            buffer,
            contentType: 'video/mp4',
            contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            size: buffer.length
          }
        },
        async ensureListingFolder() {
          writesAfterSourceChanged += 1
          return { token: 'fldChangingSource123' }
        },
        async materializeVideo() {
          writesAfterSourceChanged += 1
          throw new Error('源变化后不得进入物化')
        }
      },
      oss: {
        async putVideoDeterministic() {
          writesAfterSourceChanged += 1
          throw new Error('源变化后不得写 OSS')
        }
      }
    }),
    /源素材在同步计划执行前发生变化/,
    '第二个源文件在全批预检时变化，必须在首个外部写入前失败'
  )
  assert.deepStrictEqual(
    changingAssets.map((asset) => changingSourceReads.get(asset.sourceToken)),
    [2, 2],
    '写入前必须先完成全部素材的第二遍内容预检'
  )
  assert.strictEqual(writesAfterSourceChanged, 0, '任一源文件在全批预检时变化不得产生 Drive/OSS 外部写入')

  let partialCalls = 0
  await assert.rejects(
    () => syncNoteMaterialVideos({
      sourceRecordId: 'source-record-1',
      assets: syntheticAssets(),
      existingMediaAssets: result.mediaAssets,
      uploadDir: 'house-videos',
      drive: {
        async downloadToken(sourceToken) {
          return drive.downloadToken(sourceToken)
        },
        async ensureListingFolder() {
          return { token: 'fldTargetListing123' }
        },
        async materializeVideo(input) {
          partialCalls += 1
          if (partialCalls === 2) throw new Error('第二个视频失败')
          const buffer = Buffer.from(input.sourceEvidence.buffer)
          return {
            targetToken: 'target-first',
            targetName: input.targetName,
            buffer,
            contentType: input.sourceEvidence.contentType,
            contentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            size: buffer.length,
            verified: true
          }
        }
      },
      oss,
      verifyExisting: async () => false
    }),
    /第二个视频失败/,
    '任何一个视频失败时不得返回半个可发布数组'
  )
  assert.strictEqual(result.mediaAssets.length, 2, '失败不得原地修改既有素材数组')

  const m4vSource = {
    ...syntheticAssets()[0],
    sourceToken: 'boxSourceM4v123456',
    name: '房源全景.m4v',
    extension: 'm4v',
    mimeType: 'video/x-m4v',
    sourceFingerprint: 'd'.repeat(64)
  }
  const m4vBody = Buffer.from('valid-m4v-body')
  const m4vContentSha256 = crypto.createHash('sha256').update(m4vBody).digest('hex')
  const m4vResult = await syncNoteMaterialVideos({
    sourceRecordId: 'source-record-m4v',
    assets: [m4vSource],
    existingMediaAssets: [],
    uploadDir: 'house-videos',
    drive: {
      async downloadToken() {
        return {
          buffer: m4vBody,
          contentType: 'video/x-m4v',
          contentSha256: m4vContentSha256,
          size: m4vBody.length
        }
      },
      async ensureListingFolder() {
        return { token: 'fldM4vTarget123' }
      },
      async materializeVideo(input) {
        return {
          targetToken: 'targetM4v123',
          targetName: input.targetName,
          buffer: m4vBody,
          contentType: 'video/x-m4v',
          contentSha256: m4vContentSha256,
          size: m4vBody.length,
          verified: true
        }
      }
    },
    oss: {
      async putVideoDeterministic(input) {
        return {
          objectKey: input.objectKey,
          contentSha256: input.contentSha256,
          size: input.buffer.length,
          verified: true
        }
      }
    }
  })
  assert.doesNotThrow(
    () => domain.normalizePrivateListingMediaAssets(m4vResult.mediaAssets),
    '房源笔记允许发现的 .m4v 必须能通过唯一领域落库门，不能在管线末端自相矛盾'
  )
  assertBoundedMaterialMemory()

  console.log('feishu-note-material-sync-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
