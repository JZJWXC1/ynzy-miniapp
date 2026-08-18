'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const domain = require('../src/domain')
const {
  createFeishuNoteMaterialClient,
  SMALL_UPLOAD_LIMIT
} = require('../src/feishu-note-material-client')
const noteMaterialSync = require('../src/feishu-note-material-sync')
const {
  assertIsolatedStatePaths,
  assertMaterialSetEquality,
  stableAssetId,
  syncNoteMaterialVideos,
  syncNoteMaterialsForInventory
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
    const responses = []
    let requestCount = 0
    const client = createStreamingClient(async () => {
      assert.strictEqual((await fileHandle.stat()).size, 0, `${input.message}，每次请求前必须清空目标文件`)
      requestCount += 1
      const response = typeof input.responseFactory === 'function'
        ? input.responseFactory(requestCount)
        : input.response
      responses.push(response)
      return response
    }, { downloadTimeoutMs: input.downloadTimeoutMs })
    await assert.rejects(
      client.downloadTokenToFile('streamToken123', 'drive-file', {
        fileHandle,
        maxBytes: input.maxBytes
      }),
      (error) => error && error.statusCode === input.statusCode && error.code === input.code &&
        (input.sourceDownloadAttempts === undefined ||
          error.sourceDownloadAttempts === input.sourceDownloadAttempts),
      input.message
    )
    assert.strictEqual(requestCount, input.expectedRequests || 1, `${input.message}，请求次数必须符合重试合同`)
    assert.strictEqual((await fileHandle.stat()).size, 0, `${input.message}，失败后必须清空目标文件`)
    for (const response of responses) {
      assert.strictEqual(response.wasCancelled(), true, `${input.message}，失败后必须取消每次响应正文`)
    }
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
    responseFactory: () => createStreamingResponse([Buffer.from('short')], {
      'content-length': '6',
      'content-type': 'video/mp4'
    }),
    expectedRequests: 3,
    downloadTimeoutMs: 10000,
    maxBytes: 10,
    statusCode: 502,
    code: 'FEISHU_MATERIAL_SOURCE_GET_RETRY_EXHAUSTED',
    sourceDownloadAttempts: 3,
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
    const mediaResponses = []
    const requestedUrls = []
    const fallbackClient = createStreamingClient(async (url) => {
      assert.strictEqual((await fileHandle.stat()).size, 0, 'fallback 每次请求前必须清空复用目标文件')
      requestedUrls.push(url)
      if (url.includes('/drive/v1/medias/')) {
        const response = createStreamingResponse([], {}, { status: 404 })
        mediaResponses.push(response)
        return response
      }
      return createStreamingResponse([fallbackBody], {
        'content-length': fallbackBody.length,
        'content-type': 'video/quicktime'
      })
    }, { downloadTimeoutMs: 10000 })
    const result = await fallbackClient.downloadTokenToFile('fallbackToken123', '', {
      fileHandle,
      maxBytes: 1024
    })
    assert.strictEqual(requestedUrls.length, 3, '媒体端点必须同端点重读一次，再在总预算内回退文件端点')
    assert.match(requestedUrls[0], /\/drive\/v1\/medias\//, '默认下载必须先尝试媒体端点')
    assert.match(requestedUrls[1], /\/drive\/v1\/medias\//, '首次 404 后只允许同媒体端点重读一次')
    assert.match(requestedUrls[2], /\/drive\/v1\/files\//, '第二次 404 后必须在总预算内回退文件端点')
    assert.strictEqual(mediaResponses.length, 2)
    for (const response of mediaResponses) {
      assert.strictEqual(response.wasCancelled(), true, '回退前必须取消每次失败端点的响应正文')
    }
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

async function testBitableAttachmentUploadUsesDedicatedMediaScope() {
  const body = Buffer.from('standardized-primary-video-for-bitable')
  const contentSha256 = crypto.createHash('sha256').update(body).digest('hex')
  const requests = []
  const client = createStreamingClient(async (url, options) => {
    const chunks = []
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk))
    requests.push({ url, options, multipartBody: Buffer.concat(chunks).toString('utf8') })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          data: { file_token: 'bitableAttachmentToken123' }
        }
      }
    }
  })

  await withTemporaryFile(async (fileHandle, targetPath) => {
    await fileHandle.write(body, 0, body.length, 0)
    await fileHandle.sync()
    const result = await client.uploadBitableFileDescriptor({
      filePath: targetPath,
      size: body.length,
      contentType: 'video/mp4',
      contentSha256
    }, 'targetBitableAppToken123', `YNZY-${contentSha256}.mp4`)

    assert.strictEqual(requests.length, 1, '小于 20 MiB 的附件只允许一次完整素材上传')
    assert.match(requests[0].url, /\/drive\/v1\/medias\/upload_all$/, 'Base 附件必须走 medias 而不是 explorer files 接口')
    assert.match(requests[0].multipartBody, /name="parent_type"\r\n\r\nbitable_file\r\n/, 'Base 视频必须上传为 bitable_file')
    assert.match(requests[0].multipartBody, /name="parent_node"\r\n\r\ntargetBitableAppToken123\r\n/, 'parent_node 必须是目标 Base app_token')
    assert.match(
      requests[0].multipartBody,
      /name="extra"\r\n\r\n\{"drive_route_token":"targetBitableAppToken123"\}\r\n/,
      'Base 小附件必须携带精确 drive_route_token 路由'
    )
    assert.notStrictEqual(
      result.fileToken,
      'explorerDriveFileTokenMustNotBeReused',
      'Explorer 云盘 token 不能直接复用为 Base 附件 token'
    )
    assert.strictEqual(result.contentSha256, contentSha256, '附件上传结果必须绑定同一标准化成品摘要')
    assert.strictEqual(result.size, body.length, '附件上传结果必须绑定同一标准化成品大小')
  })
}

async function testLargeBitableAttachmentUsesStreamingMediaParts() {
  const size = SMALL_UPLOAD_LIMIT + 1
  const zeroChunk = Buffer.alloc(64 * 1024)
  const hash = crypto.createHash('sha256')
  let remaining = size
  while (remaining > 0) {
    const chunk = remaining >= zeroChunk.length ? zeroChunk : zeroChunk.subarray(0, remaining)
    hash.update(chunk)
    remaining -= chunk.length
  }
  const contentSha256 = hash.digest('hex')
  const endpoints = []
  const partBytes = []
  let dispatches = 0
  const blockSize = 8 * 1024 * 1024
  const blockNum = Math.ceil(size / blockSize)
  const client = createStreamingClient(async (url, options) => {
    endpoints.push(url)
    if (/\/medias\/upload_prepare$/.test(url)) {
      const prepared = JSON.parse(options.body)
      assert.strictEqual(prepared.parent_type, 'bitable_file', '大附件 prepare 必须保持 bitable_file')
      assert.strictEqual(prepared.parent_node, 'targetBaseLargeMedia123', '大附件 prepare 必须绑定目标 Base')
      assert.deepStrictEqual(
        JSON.parse(prepared.extra),
        { drive_route_token: 'targetBaseLargeMedia123' },
        'Base 大附件 prepare 必须携带精确 drive_route_token 路由'
      )
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 0, data: { upload_id: 'largeMediaUpload123', block_size: blockSize, block_num: blockNum } }
        }
      }
    }
    if (/\/medias\/upload_part$/.test(url)) {
      let bytes = 0
      for await (const chunk of options.body) bytes += Buffer.byteLength(chunk)
      partBytes.push(bytes)
      return { ok: true, status: 200, async json() { return { code: 0, data: {} } } }
    }
    assert.match(url, /\/medias\/upload_finish$/, '分片上传最后必须调用 medias upload_finish')
    return {
      ok: true,
      status: 200,
      async json() { return { code: 0, data: { file_token: 'bitableLargeAttachmentToken123' } } }
    }
  }, { maxBytes: size + 1024 })

  const originalReadFile = fs.readFile
  try {
    fs.readFile = async () => { throw new Error('大附件上传禁止整文件 readFile') }
    await withTemporaryFile(async (fileHandle, targetPath) => {
      await fileHandle.truncate(size)
      await fileHandle.sync()
      const result = await client.uploadBitableFileDescriptor({
        filePath: targetPath,
        size,
        contentType: 'video/mp4',
        contentSha256
      }, 'targetBaseLargeMedia123', `YNZY-${contentSha256}.mp4`, () => {
        dispatches += 1
      })
      assert.strictEqual(result.fileToken, 'bitableLargeAttachmentToken123')
    })
  } finally {
    fs.readFile = originalReadFile
  }
  assert.strictEqual(endpoints.filter((url) => /\/medias\/upload_part$/.test(url)).length, blockNum, '大附件必须按飞书策略逐片上传')
  assert.strictEqual(dispatches, blockNum + 2, 'prepare、每个 part 与 finish 都必须逐请求派发写意图')
  assert.ok(partBytes.every((bytes) => bytes > 0 && bytes < size), '每个 multipart 请求只能流式携带当前分片')
  assert.ok(endpoints.every((url) => /\/drive\/v1\/medias\//.test(url)), 'Base 大附件全程不得调用 explorer files 接口')
}

async function testPrimaryVideoAttachmentPublishesAfterWholeMaterialSet() {
  const events = []
  const sourceBodies = new Map(syntheticAssets().map((asset) => [
    asset.sourceToken,
    Buffer.from(`target-body:${asset.sourceToken}`)
  ]))
  const result = await syncNoteMaterialVideos({
    sourceRecordId: 'source-record-primary-target',
    assets: syntheticAssets(),
    existingMediaAssets: [],
    uploadDir: 'house-videos',
    drive: {
      writeDispatchEvidenceVersion: 1,
      async downloadToken(sourceToken) {
        const buffer = Buffer.from(sourceBodies.get(sourceToken))
        return {
          buffer,
          size: buffer.length,
          contentType: 'video/mp4',
          contentSha256: crypto.createHash('sha256').update(buffer).digest('hex')
        }
      },
      async ensureListingFolder() {
        return { token: 'target-folder-primary-attachment' }
      },
      async materializeAsset(input) {
        events.push(`drive:${input.asset.sourceToken}`)
        return {
          targetToken: `explorer-${input.asset.sourceToken}`,
          targetName: input.targetName,
          contentType: input.sourceEvidence.contentType,
          contentSha256: input.sourceEvidence.contentSha256,
          size: input.sourceEvidence.size,
          verified: true
        }
      }
    },
    oss: {
      writeDispatchEvidenceVersion: 1,
      async putMaterialDeterministic(input) {
        events.push(`oss:${input.objectKey}`)
        return {
          objectKey: input.objectKey,
          contentSha256: input.contentSha256,
          size: input.size,
          verified: true
        }
      }
    },
    primaryVideoAttachment: {
      writeDispatchEvidenceVersion: 1,
      async verifyExact() {
        return { verified: false, expectedStateKey: 'target-video-state-before' }
      },
      async publishExact(input) {
        events.push(`bitable:${input.assetId}`)
        return {
          verified: true,
          contentSha256: input.contentSha256,
          size: input.size,
          contentType: input.contentType,
          attachmentTokenFingerprint: 'a'.repeat(64),
          targetRecordFingerprint: 'b'.repeat(64)
        }
      }
    }
  })

  assert.strictEqual(events.filter((item) => item.startsWith('bitable:')).length, 1, '每套房只允许主视频写入一次目标附件列')
  assert.ok(events[events.length - 1].startsWith('bitable:'), '整套其他素材全部通过 Drive/OSS 后才允许更新目标附件')
  assert.strictEqual(result.primaryTargetAttachment.verified, true, '结果必须携带已回读的目标附件内容证据')
  assert.strictEqual(
    result.primaryTargetAttachment.contentSha256,
    result.primaryVideo.contentSha256,
    '目标附件必须与确定的 primaryVideo 内容完全相同'
  )
}

async function testPrimaryTargetFailureReuseAndNoopBoundaries() {
  const assets = syntheticAssets()
  const sourceBodies = new Map(assets.map((asset) => [
    asset.sourceToken,
    Buffer.from(`target-idempotency:${asset.sourceToken}`)
  ]))
  const counters = {
    driveWrites: 0,
    ossWrites: 0,
    targetPublishes: 0,
    targetDispatches: 0
  }
  const drive = {
    writeDispatchEvidenceVersion: 1,
    async downloadToken(sourceToken) {
      const buffer = Buffer.from(sourceBodies.get(sourceToken))
      return {
        buffer,
        size: buffer.length,
        contentType: 'video/mp4',
        contentSha256: crypto.createHash('sha256').update(buffer).digest('hex')
      }
    },
    async ensureListingFolder() { return { token: 'target-idempotency-folder' } },
    async materializeAsset(input) {
      counters.driveWrites += 1
      return {
        targetToken: `target-idempotency-${input.asset.sourceToken}`,
        targetName: input.targetName,
        contentType: input.sourceEvidence.contentType,
        contentSha256: input.sourceEvidence.contentSha256,
        size: input.sourceEvidence.size,
        verified: true
      }
    }
  }
  const oss = {
    writeDispatchEvidenceVersion: 1,
    async putMaterialDeterministic(input) {
      counters.ossWrites += 1
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.size,
        verified: true
      }
    }
  }
  const publishingAttachment = {
    writeDispatchEvidenceVersion: 1,
    async verifyExact() { return { verified: false, expectedStateKey: 'target-before-first-publish' } },
    async publishExact(input) {
      counters.targetPublishes += 1
      return {
        verified: true,
        contentSha256: input.contentSha256,
        size: input.size,
        contentType: input.contentType,
        attachmentTokenFingerprint: 'd'.repeat(64),
        targetRecordFingerprint: 'e'.repeat(64)
      }
    }
  }
  const first = await syncNoteMaterialVideos({
    sourceRecordId: 'source-target-idempotency',
    assets,
    existingMediaAssets: [],
    uploadDir: 'house-videos',
    drive,
    oss,
    primaryVideoAttachment: publishingAttachment
  })
  assert.strictEqual(first.noop, false, '首次 Drive/OSS/目标表发布不得报告 noop')
  assert.strictEqual(first.counts.targetMediaUploaded, 1, '首次目标附件上传必须计数')
  assert.strictEqual(first.counts.targetRecordUpdated, 1, '首次目标记录更新必须计数')

  const exactAttachment = {
    writeDispatchEvidenceVersion: 1,
    async verifyExact() {
      return {
        verified: true,
        contentSha256: first.primaryVideo.contentSha256,
        size: first.primaryVideo.size,
        contentType: first.primaryVideo.mimeType,
        attachmentTokenFingerprint: 'd'.repeat(64),
        targetRecordFingerprint: 'e'.repeat(64)
      }
    },
    async publishExact() { throw new Error('二次精确同步不得发布目标附件') }
  }
  const driveWritesBeforeReuse = counters.driveWrites
  const ossWritesBeforeReuse = counters.ossWrites
  const publishesBeforeReuse = counters.targetPublishes
  const reused = await syncNoteMaterialVideos({
    sourceRecordId: 'source-target-idempotency',
    assets,
    existingMediaAssets: first.mediaAssets,
    uploadDir: 'house-videos',
    drive,
    oss,
    primaryVideoAttachment: exactAttachment,
    async verifyExisting() {
      return { sourceVerified: true, driveVerified: true, ossVerified: true }
    }
  })
  assert.strictEqual(reused.noop, true, '连续第二轮内容、token 与真字节一致时必须报告 noop')
  assert.strictEqual(counters.driveWrites, driveWritesBeforeReuse, '第二轮不得重复写 Drive')
  assert.strictEqual(counters.ossWrites, ossWritesBeforeReuse, '第二轮不得重复写 OSS')
  assert.strictEqual(counters.targetPublishes, publishesBeforeReuse, '第二轮不得重复上传或更新目标表')
  assert.deepStrictEqual(
    [reused.counts.targetMediaUploaded, reused.counts.targetRecordUpdated, reused.counts.targetAttachmentReused],
    [0, 0, 1],
    '第二轮计数必须明确区分目标附件复用与外写'
  )

  const missingTargetAttachment = {
    writeDispatchEvidenceVersion: 1,
    async verifyExact() { return { verified: false, expectedStateKey: 'target-before-backfill' } },
    async publishExact(input) {
      counters.targetPublishes += 1
      return {
        verified: true,
        contentSha256: input.contentSha256,
        size: input.size,
        contentType: input.contentType,
        attachmentTokenFingerprint: 'f'.repeat(64),
        targetRecordFingerprint: '1'.repeat(64)
      }
    }
  }
  const backfilled = await syncNoteMaterialVideos({
    sourceRecordId: 'source-target-idempotency',
    assets,
    existingMediaAssets: first.mediaAssets,
    uploadDir: 'house-videos',
    drive: {
      ...drive,
      async materializeAsset() { throw new Error('目标表首次补附件不得重复写 Drive') }
    },
    oss: {
      ...oss,
      async putMaterialDeterministic() { throw new Error('目标表首次补附件不得重复写 OSS') }
    },
    primaryVideoAttachment: missingTargetAttachment,
    async verifyExisting() {
      return { sourceVerified: true, driveVerified: true, ossVerified: true }
    }
  })
  assert.strictEqual(backfilled.noop, false, 'Drive/OSS 已复用但首次补目标附件不能报告 noop')
  assert.deepStrictEqual(
    [backfilled.counts.transferred, backfilled.counts.targetMediaUploaded, backfilled.counts.targetRecordUpdated],
    [0, 1, 1],
    '目标表首次补附件必须只计目标 media/Base 外写'
  )

  let dryPublishCalls = 0
  let dryDispatchCalls = 0
  const dry = await syncNoteMaterialVideos({
    sourceRecordId: 'source-target-idempotency',
    assets,
    uploadDir: 'house-videos',
    drive,
    oss,
    dryRun: true,
    onExternalWriteDispatched() { dryDispatchCalls += 1 },
    primaryVideoAttachment: {
      writeDispatchEvidenceVersion: 1,
      async verifyExact() { return { verified: false, expectedStateKey: 'dry-target-state' } },
      async publishExact() { dryPublishCalls += 1 },
      async clearExact() { dryPublishCalls += 1 }
    }
  })
  assert.strictEqual(dry.dryRun, true, '目标附件 dry-run 必须保留只读计划语义')
  assert.deepStrictEqual([dryPublishCalls, dryDispatchCalls], [0, 0], 'dry-run 的 media/Base 外写和 dispatch 必须全为 0')

  let failureTargetPublishes = 0
  await assert.rejects(
    () => syncNoteMaterialVideos({
      sourceRecordId: 'source-target-failure-before-primary',
      assets,
      uploadDir: 'house-videos',
      drive,
      oss: {
        writeDispatchEvidenceVersion: 1,
        async putMaterialDeterministic() { throw new Error('其他素材 OSS 回读失败') }
      },
      primaryVideoAttachment: {
        writeDispatchEvidenceVersion: 1,
        async verifyExact() { return { verified: false, expectedStateKey: 'target-stays-old' } },
        async publishExact() { failureTargetPublishes += 1 }
      }
    }),
    /其他素材 OSS 回读失败/,
    '其他素材失败必须在 primary 目标附件发布前中止'
  )
  assert.strictEqual(failureTargetPublishes, 0, '后续素材失败时目标旧附件必须保持未触碰')
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

async function testExactExternalWriteDispatchBoundary() {
  const asset = { ...syntheticAssets()[0], kind: 'video' }
  const { sourceBuffer, prepared } = preparedVideoFixture()
  const downloadToken = async () => ({
    buffer: Buffer.from(sourceBuffer),
    size: sourceBuffer.length,
    contentType: 'video/mp4',
    contentSha256: crypto.createHash('sha256').update(sourceBuffer).digest('hex')
  })
  const prepareMaterial = async () => ({ ...prepared, buffer: Buffer.from(prepared.buffer) })
  prepareMaterial.profile = {
    transformProfileVersion: prepared.transformProfileVersion,
    transformProfileSha256: prepared.transformProfileSha256,
    transformToolFingerprint: prepared.transformToolFingerprint
  }
  const common = {
    sourceRecordId: 'source-record-write-boundary',
    assets: [asset],
    existingMediaAssets: [],
    uploadDir: 'house-videos',
    prepareMaterial,
    disposePreparedMaterial: async () => {}
  }

  const exactDispatchOrder = []
  const exactResult = await syncNoteMaterialVideos({
    ...common,
    onExternalWriteDispatched() {
      exactDispatchOrder.push('outer')
    },
    drive: {
      writeDispatchEvidenceVersion: 1,
      downloadToken,
      async ensureListingFolder() { return { token: 'fld-exact-dispatch-target' } },
      async materializeAsset(input) {
        input.onWriteDispatched()
        exactDispatchOrder.push('drive-write')
        input.onWriteVerified()
        return {
          targetToken: 'file-exact-dispatch-target',
          targetName: input.targetName,
          contentType: input.sourceEvidence.contentType,
          contentSha256: input.sourceEvidence.contentSha256,
          size: input.sourceEvidence.size,
          verified: true
        }
      }
    },
    oss: {
      writeDispatchEvidenceVersion: 1,
      async putMaterialDeterministic(input) {
        input.onWriteDispatched()
        exactDispatchOrder.push('oss-write')
        input.onWriteVerified()
        return {
          objectKey: input.objectKey,
          contentSha256: input.contentSha256,
          size: input.size,
          verified: true
        }
      }
    }
  })
  assert.strictEqual(exactResult.counts.transferred, 1, '精确证据适配器应完成一件素材传输')
  assert.deepStrictEqual(
    exactDispatchOrder,
    ['outer', 'drive-write', 'outer', 'oss-write'],
    'Drive/OSS 精确写派发必须先同步通知外层，再进入适配器的实际写动作'
  )

  let exactWriteCalls = 0
  await assert.rejects(
    () => syncNoteMaterialVideos({
      ...common,
      onExternalWriteDispatched() {
        throw new Error('synthetic outer write-intent persistence failed')
      },
      drive: {
        writeDispatchEvidenceVersion: 1,
        downloadToken,
        async ensureListingFolder() { return { token: 'fld-exact-outer-failure' } },
        async materializeAsset(input) {
          input.onWriteDispatched()
          exactWriteCalls += 1
          throw new Error('外层写意图落盘失败后不得执行 Drive 写入')
        }
      },
      oss: {
        writeDispatchEvidenceVersion: 1,
        async putMaterialDeterministic() { throw new Error('不得进入 OSS 写入') }
      }
    }),
    (error) => error && error.code === 'EXTERNAL_WRITE_INTENT_PERSISTENCE_FAILED' &&
      error.safeBeforeWrite === true,
    '外层写意图回调失败必须被标记为可安全中止的写前错误'
  )
  assert.strictEqual(exactWriteCalls, 0, '外层写意图未落盘时不得越过精确派发回调执行实际 Drive 写入')

  let asyncBoundaryWriteCalls = 0
  await assert.rejects(
    () => syncNoteMaterialVideos({
      ...common,
      onExternalWriteDispatched: async () => {},
      drive: {
        writeDispatchEvidenceVersion: 1,
        downloadToken,
        async ensureListingFolder() { return { token: 'fld-async-boundary' } },
        async materializeAsset(input) {
          input.onWriteDispatched()
          asyncBoundaryWriteCalls += 1
          throw new Error('异步外层回调后不得执行 Drive 写入')
        }
      },
      oss: {
        writeDispatchEvidenceVersion: 1,
        async putMaterialDeterministic() { throw new Error('不得进入 OSS 写入') }
      }
    }),
    (error) => error && error.code === 'EXTERNAL_WRITE_INTENT_PERSISTENCE_FAILED' &&
      error.safeBeforeWrite === true,
    '异步外层回调无法证明先落盘，必须在适配器真实写入前失败关闭'
  )
  assert.strictEqual(asyncBoundaryWriteCalls, 0)

  const conservativeDriveFailure = new Error('synthetic conservative drive intent failed')
  let conservativeDriveCalls = 0
  await assert.rejects(
    () => syncNoteMaterialVideos({
      ...common,
      onExternalWriteDispatched() {
        throw conservativeDriveFailure
      },
      drive: {
        downloadToken,
        async ensureListingFolder() {
          conservativeDriveCalls += 1
          throw new Error('保守 Drive 适配器不得在外层写意图失败后执行')
        },
        async materializeAsset() { throw new Error('不得进入素材写入') }
      },
      oss: {
        async putMaterialDeterministic() { throw new Error('不得进入 OSS 写入') }
      }
    }),
    (error) => error && error.code === 'EXTERNAL_WRITE_INTENT_PERSISTENCE_FAILED' &&
      error.safeBeforeWrite === true,
    '没有精确证据的 Drive 适配器必须在可能写方法调用前同步通知外层'
  )
  assert.strictEqual(conservativeDriveCalls, 0, '保守 Drive 写意图未落盘时不得调用可能写方法')

  let noWriteNotifications = 0
  const dryPlan = await syncNoteMaterialVideos({
    ...common,
    dryRun: true,
    onExternalWriteDispatched() {
      noWriteNotifications += 1
    },
    drive: {
      writeDispatchEvidenceVersion: 1,
      downloadToken,
      async ensureListingFolder() { throw new Error('dry-run 不得访问目标目录') },
      async materializeAsset() { throw new Error('dry-run 不得写 Drive') }
    },
    oss: {
      writeDispatchEvidenceVersion: 1,
      async putMaterialDeterministic() { throw new Error('dry-run 不得写 OSS') }
    }
  })
  assert.strictEqual(noWriteNotifications, 0, 'dry-run 不得通知外层发生写派发')
  const reused = await syncNoteMaterialVideos({
    ...common,
    existingMediaAssets: dryPlan.mediaAssets,
    onExternalWriteDispatched() {
      noWriteNotifications += 1
    },
    drive: {
      writeDispatchEvidenceVersion: 1,
      downloadToken,
      async ensureListingFolder() { return { token: 'fld-reused-read-only-target' } },
      async materializeAsset() { throw new Error('复用素材不得写 Drive') }
    },
    oss: {
      writeDispatchEvidenceVersion: 1,
      async putMaterialDeterministic() { throw new Error('复用素材不得写 OSS') }
    },
    async verifyExisting() {
      return { sourceVerified: true, driveVerified: true, ossVerified: true }
    }
  })
  assert.strictEqual(reused.counts.reused, 1, '已存在且回读一致的素材必须走复用链路')
  assert.strictEqual(noWriteNotifications, 0, '复用与纯读取链路不得通知外层发生写派发')

  await assert.rejects(
    () => syncNoteMaterialVideos({
      ...common,
      drive: {
        writeDispatchEvidenceVersion: 1,
        downloadToken,
        async ensureListingFolder(input) {
          assert.strictEqual(typeof input.onWriteDispatched, 'function')
          const error = new Error('synthetic drive list precheck failed')
          error.statusCode = 503
          throw error
        },
        async materializeAsset() { throw new Error('不得进入素材写入') }
      },
      oss: {
        writeDispatchEvidenceVersion: 1,
        async putMaterialDeterministic() { throw new Error('不得进入 OSS 写入') }
      }
    }),
    (error) => error && error.code !== 'MATERIAL_EXTERNAL_WRITE_STATE_UNKNOWN' && error.statusCode === 503,
    'Drive 纯读取预检失败且零 POST 时必须保持可延期错误，不能误判状态未知'
  )

  await assert.rejects(
    () => syncNoteMaterialVideos({
      ...common,
      drive: {
        writeDispatchEvidenceVersion: 1,
        downloadToken,
        async ensureListingFolder(input) {
          input.onWriteDispatched()
          input.onWriteVerified()
          const error = new Error('synthetic later folder list precheck failed')
          error.statusCode = 503
          throw error
        },
        async materializeAsset() { throw new Error('不得进入素材写入') }
      },
      oss: {
        writeDispatchEvidenceVersion: 1,
        async putMaterialDeterministic() { throw new Error('不得进入 OSS 写入') }
      }
    }),
    (error) => error && error.code !== 'MATERIAL_EXTERNAL_WRITE_STATE_UNKNOWN' && error.statusCode === 503,
    '前一目录写入已完成回读后，后续纯读取失败不得沿用陈旧的未确认写标记'
  )

  await assert.rejects(
    () => syncNoteMaterialVideos({
      ...common,
      drive: {
        writeDispatchEvidenceVersion: 1,
        downloadToken,
        async ensureListingFolder() { return { token: 'fld-existing-target' } },
        async materializeAsset(input) {
          input.onWriteDispatched()
          const error = new Error('synthetic drive post result unknown')
          error.statusCode = 504
          throw error
        }
      },
      oss: {
        writeDispatchEvidenceVersion: 1,
        async putMaterialDeterministic() { throw new Error('不得进入 OSS 写入') }
      }
    }),
    (error) => error && error.code === 'MATERIAL_EXTERNAL_WRITE_STATE_UNKNOWN',
    'Drive POST 已派发后结果不明必须升级为状态未知'
  )

  await assert.rejects(
    () => syncNoteMaterialVideos({
      ...common,
      drive: {
        writeDispatchEvidenceVersion: 1,
        downloadToken,
        async ensureListingFolder() { return { token: 'fld-existing-target' } },
        async materializeAsset(input) {
          return {
            targetToken: 'file-existing-target',
            targetName: input.targetName,
            contentType: input.sourceEvidence.contentType,
            contentSha256: input.sourceEvidence.contentSha256,
            size: input.sourceEvidence.size,
            verified: true
          }
        }
      },
      oss: {
        writeDispatchEvidenceVersion: 1,
        async putMaterialDeterministic(input) {
          assert.strictEqual(typeof input.onWriteDispatched, 'function')
          const error = new Error('synthetic oss head precheck failed')
          error.statusCode = 503
          throw error
        }
      }
    }),
    (error) => error && error.code !== 'MATERIAL_EXTERNAL_WRITE_STATE_UNKNOWN' && error.statusCode === 503,
    'Drive 复用成功后 OSS 纯读取预检失败且零 PUT 时仍必须保持可延期错误'
  )
}

async function testInventoryForwardsExternalWriteDispatchBoundary() {
  const listing = {
    id: 'listing-inventory-write-boundary',
    feishuRecordId: 'record-inventory-write-boundary',
    status: '上架',
    district: '拱墅区',
    block: '新天地',
    community: '测试小区',
    building: '1幢',
    unit: '1单元',
    roomNumber: '101',
    mediaAssets: []
  }
  const sourceBuffer = Buffer.from('inventory-write-boundary-source')
  const outerFailure = new Error('synthetic inventory outer write-intent failure')
  let outerNotifications = 0
  let possibleWriteCalls = 0
  await assert.rejects(
    () => syncNoteMaterialsForInventory({
    db: { users: [], listings: [listing] },
    sourceRows: [{
      sourceRecordId: listing.feishuRecordId,
      value: 'https://example.test/drive/folder/fldInventoryBoundary123'
    }],
    allowedHosts: ['example.test'],
    uploadDir: 'house-videos',
    onExternalWriteDispatched() {
      outerNotifications += 1
      throw outerFailure
    },
    drive: {
      async listFolder() {
        return [{
          token: 'fileInventoryBoundary123',
          name: '看房视频.mp4',
          type: 'file',
          modifiedTime: '10',
          size: sourceBuffer.length
        }]
      },
      async downloadToken() {
        return {
          buffer: Buffer.from(sourceBuffer),
          contentType: 'video/mp4',
          contentSha256: crypto.createHash('sha256').update(sourceBuffer).digest('hex'),
          size: sourceBuffer.length
        }
      },
      async ensureListingFolder() {
        possibleWriteCalls += 1
        throw new Error('外层写意图失败后库存链路不得调用可能写方法')
      },
      async materializeAsset() {
        possibleWriteCalls += 1
        throw new Error('不得进入 Drive 素材写入')
      }
    },
    oss: {
      async putMaterialDeterministic() {
        possibleWriteCalls += 1
        throw new Error('不得进入 OSS 素材写入')
      }
    },
    nowText: '2026-08-06T00:00:00.000Z'
    }),
    (error) => error && error.code === 'EXTERNAL_WRITE_INTENT_PERSISTENCE_FAILED' &&
      error.safeBeforeWrite === true,
    '库存链路必须把写意图持久化失败提升为整轮致命写前错误'
  )
  assert.strictEqual(outerNotifications, 1, '库存入口必须把外层写意图回调传递到逐套素材同步')
  assert.strictEqual(possibleWriteCalls, 0, '库存入口的外层写意图未落盘时不得调用任何可能写适配器')
}

function identityChangedFailureListing(recordId, suffix = '') {
  return {
    id: `listing-note-target-failure${suffix}`,
    feishuRecordId: recordId,
    status: '在租',
    lifecycleStatus: 'active',
    district: '拱墅区',
    block: '新天地',
    community: '测试小区',
    building: '1幢',
    unit: '1单元',
    roomNumber: '101',
    videoKey: `house-videos/feishu-note-v1/old${suffix}.mp4`,
    mediaAssets: [{
      assetId: `old-note-video${suffix}`,
      kind: 'video',
      objectKey: `house-videos/feishu-note-v1/old${suffix}.mp4`,
      contentSha256: '1'.repeat(64),
      sourceFingerprint: `old-source${suffix}`,
      targetDriveFingerprint: '2'.repeat(64),
      displayOrder: 0,
      mimeType: 'video/mp4',
      size: 10,
      verified: true
    }],
    noteMaterialState: {
      sourceLinkFingerprint: '3'.repeat(64),
      physicalUnitFingerprint: '4'.repeat(64),
      status: 'verified',
      primaryTargetAttachment: {
        version: 1,
        sourceRecordFingerprint: crypto.createHash('sha256').update(recordId).digest('hex'),
        physicalUnitFingerprint: '4'.repeat(64),
        targetRecordFingerprint: '5'.repeat(64),
        attachmentTokenFingerprint: '6'.repeat(64),
        contentSha256: '1'.repeat(64),
        size: 10,
        contentType: 'video/mp4'
      }
    }
  }
}

function continuousActiveFailureListing(recordId, suffix = '') {
  const listing = identityChangedFailureListing(recordId, suffix)
  const currentPhysical = crypto.createHash('sha256').update([
    listing.district,
    listing.block,
    listing.community,
    listing.building,
    listing.unit,
    listing.roomNumber
  ].join('\n')).digest('hex')
  listing.noteMaterialState.physicalUnitFingerprint = currentPhysical
  listing.noteMaterialState.primaryTargetAttachment.physicalUnitFingerprint = currentPhysical
  return listing
}

function failureCleanupAdapter(calls, options = {}) {
  return {
    writeDispatchEvidenceVersion: 1,
    async verifyExact(input) {
      calls.push(input.primaryVideo ? 'verify-primary' : 'verify-empty')
      if (input.primaryVideo) return { verified: false, expectedStateKey: 'target-before-primary' }
      return {
        verified: false,
        expectedStateKey: 'target-before-clear',
        forceClearForIdentityChange: true
      }
    },
    async publishExact() {
      throw new Error('素材失败前不得发布目标附件')
    },
    async clearExact(input) {
      calls.push('clear')
      assert.strictEqual(input.forceClearForIdentityChange, true, '物理身份变化必须显式强制清理受管旧附件')
      input.onWriteDispatched()
      if (options.unknownAfterDispatch === true) throw new Error('synthetic target clear unknown')
      input.onWriteVerified()
      return { verified: true, cleared: true, recordUpdated: true }
    }
  }
}

async function testInactiveRowsSkipAndIdentityFailuresClearManagedTarget() {
  const inactive = identityChangedFailureListing('record-note-inactive', '-inactive')
  inactive.status = '已下架'
  inactive.lifecycleStatus = 'expired'
  const inactiveBefore = JSON.stringify(inactive)
  let inactiveReads = 0
  let inactiveAdapters = 0
  const inactiveReport = await syncNoteMaterialsForInventory({
    db: { listings: [inactive] },
    sourceRows: [{
      sourceRecordId: inactive.feishuRecordId,
      value: 'https://example.test/drive/folder/non-empty-note-must-not-be-read'
    }],
    allowedHosts: ['example.test'],
    drive: {
      async listFolder() { inactiveReads += 1; throw new Error('非在租房源不得解析 Note') }
    },
    primaryVideoAttachmentForListing() {
      inactiveAdapters += 1
      throw new Error('非在租房源不得读取或写入目标附件')
    }
  })
  assert.strictEqual(inactiveReport.complete, true, '非在租行必须从 Note 素材动作中过滤')
  assert.strictEqual(inactiveReport.rows[0].status, 'inactive-skipped')
  assert.deepStrictEqual([inactiveReads, inactiveAdapters], [0, 0], '撤下行必须零解析、零素材、零附件动作')
  assert.strictEqual(JSON.stringify(inactive), inactiveBefore, '撤下行必须保留私有附件指纹供未来安全识别')

  const deleted = identityChangedFailureListing('record-note-deleted', '-deleted')
  deleted.status = '已下架'
  deleted.lifecycleStatus = 'expired'
  const deletedBefore = JSON.stringify(deleted)
  const deletedReport = await syncNoteMaterialsForInventory({
    db: { listings: [deleted] },
    sourceRows: [],
    primaryVideoAttachmentForListing() { throw new Error('源删除不得触发 Note 附件扫描') }
  })
  assert.strictEqual(deletedReport.complete, true)
  assert.strictEqual(deletedReport.rows.length, 0, '源记录删除时 Note 不得扩展跨集合扫描')
  assert.strictEqual(JSON.stringify(deleted), deletedBefore, '源删除后附件是否公开只由普通镜像下架事实控制')

  const changedLink = continuousActiveFailureListing('record-note-changed-link', '-changed-link')
  const changedLinkAssets = JSON.stringify(changedLink.mediaAssets)
  const changedLinkVideoKey = changedLink.videoKey
  const previousLinkFingerprint = changedLink.noteMaterialState.sourceLinkFingerprint
  let changedLinkTargetCalls = 0
  const changedLinkReport = await syncNoteMaterialsForInventory({
    db: { listings: [changedLink] },
    sourceRows: [{
      sourceRecordId: changedLink.feishuRecordId,
      value: 'https://example.test/drive/folder/fldChangedNoteLink123'
    }],
    allowedHosts: ['example.test'],
    drive: {
      async listFolder() {
        const error = new Error('synthetic changed Note link temporary failure')
        error.statusCode = 503
        throw error
      }
    },
    primaryVideoAttachmentForListing() {
      changedLinkTargetCalls += 1
      throw new Error('同物理持续在租的失败不得读写目标附件')
    },
    nowText: '2026-08-17T00:00:00.000Z'
  })
  assert.strictEqual(changedLinkReport.retained, 1, 'Note 链接变化后的临时失败必须保留上次已验证素材')
  assert.strictEqual(changedLinkReport.rows[0].status, 'retained-temporary-failure')
  assert.strictEqual(JSON.stringify(changedLink.mediaAssets), changedLinkAssets, '链接变化失败不得清本地素材')
  assert.strictEqual(changedLink.videoKey, changedLinkVideoKey, '链接变化失败不得清小程序视频键')
  assert.strictEqual(
    changedLink.noteMaterialState.sourceLinkFingerprint,
    previousLinkFingerprint,
    '失败保留必须继续绑定上次成功的 Note 指纹，不能把失败链接伪装成已验证'
  )
  assert.strictEqual(changedLinkTargetCalls, 0, '失败保留不得产生目标附件读取或写入')

  for (const failureKind of ['unsupported', 'over-limit']) {
    const listing = continuousActiveFailureListing(
      `record-note-${failureKind}`,
      `-${failureKind}`
    )
    const beforeAssets = JSON.stringify(listing.mediaAssets)
    let targetCalls = 0
    const children = failureKind === 'unsupported'
      ? [{ token: 'fileUnsupportedPdf123', name: '租赁合同.pdf', type: 'file', size: 10 }]
      : Array.from({ length: domain.MAX_LISTING_MEDIA_ASSETS + 1 }, (_, index) => ({
          token: `fileOverLimit${String(index).padStart(3, '0')}Token`,
          name: `房源视频-${index}.mp4`,
          type: 'file',
          size: 10,
          modifiedTime: '10'
        }))
    const report = await syncNoteMaterialsForInventory({
      db: { listings: [listing] },
      sourceRows: [{
        sourceRecordId: listing.feishuRecordId,
        value: `https://example.test/drive/folder/fld${failureKind.replace('-', '')}123`
      }],
      allowedHosts: ['example.test'],
      drive: { async listFolder() { return children } },
      primaryVideoAttachmentForListing() {
        targetCalls += 1
        throw new Error('同物理持续在租的规则失败不得读写目标附件')
      }
    })
    assert.strictEqual(report.retained, 1, `${failureKind} 失败必须保留上次已验证素材`)
    assert.strictEqual(
      report.rows[0].status,
      failureKind === 'unsupported' ? 'unsupported-non-video' : 'media-limit-exceeded'
    )
    assert.strictEqual(JSON.stringify(listing.mediaAssets), beforeAssets, `${failureKind} 失败不得清本地素材`)
    assert.strictEqual(targetCalls, 0, `${failureKind} 失败不得产生目标附件读取或写入`)
  }

  const parseListing = identityChangedFailureListing('record-note-parse-failure', '-parse')
  const parseCalls = []
  const parseReport = await syncNoteMaterialsForInventory({
    db: { listings: [parseListing] },
    sourceRows: [{ sourceRecordId: parseListing.feishuRecordId, value: 'https://forbidden.test/note' }],
    allowedHosts: ['example.test'],
    primaryVideoAttachmentForListing(targetOptions) {
      assert.strictEqual(targetOptions.failureCleanup, true, '解析前失败必须进入专用目标清理路径')
      return failureCleanupAdapter(parseCalls)
    }
  })
  assert.deepStrictEqual(parseCalls, ['verify-empty', 'clear'], '解析前失败必须先回读再清理受管旧附件')
  assert.strictEqual(parseReport.failed, 1)
  assert.strictEqual(parseReport.targetRecordUpdated, 1, '库存汇总必须计入失败清理产生的 Base 附件更新')
  assert.strictEqual(parseReport.noop, false, '发生附件清理时库存素材报告不得误报 noop')
  assert.strictEqual(parseListing.mediaAssets.length, 0, '目标清理确认后才允许清本地旧素材')
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(parseListing.noteMaterialState, 'primaryTargetAttachment'),
    false,
    '目标附件已确认清空后不得保留陈旧私有指纹'
  )

  const executionListing = identityChangedFailureListing('record-note-execution-failure', '-execution')
  const executionCalls = []
  const executionBody = Buffer.from('execution-failure-video')
  const executionReport = await syncNoteMaterialsForInventory({
    db: { listings: [executionListing] },
    sourceRows: [{
      sourceRecordId: executionListing.feishuRecordId,
      value: 'https://example.test/drive/folder/fldExecutionFailure123'
    }],
    allowedHosts: ['example.test'],
    uploadDir: 'house-videos',
    drive: {
      writeDispatchEvidenceVersion: 1,
      async listFolder() {
        return [{
          token: 'fileExecutionFailure123',
          name: '执行期失败.mp4',
          type: 'file',
          modifiedTime: '10',
          size: executionBody.length
        }]
      },
      async downloadToken() {
        return {
          buffer: Buffer.from(executionBody),
          contentType: 'video/mp4',
          contentSha256: crypto.createHash('sha256').update(executionBody).digest('hex'),
          size: executionBody.length
        }
      },
      async ensureListingFolder() {
        const error = new Error('synthetic read-before-write failure')
        error.statusCode = 503
        throw error
      }
    },
    oss: { writeDispatchEvidenceVersion: 1 },
    primaryVideoAttachmentForListing(targetOptions) {
      executionCalls.push(targetOptions.failureCleanup === true ? 'factory-cleanup' : 'factory-primary')
      return failureCleanupAdapter(executionCalls)
    }
  })
  assert.ok(executionCalls.includes('verify-primary'), '执行期必须先形成目标附件 CAS 计划')
  assert.deepStrictEqual(
    executionCalls.slice(-3),
    ['factory-cleanup', 'verify-empty', 'clear'],
    '执行期素材失败后必须另行双回读清理受管旧附件'
  )
  assert.strictEqual(executionReport.failed, 1)
  assert.strictEqual(executionReport.targetAttachmentCleared, 1)
  assert.strictEqual(executionListing.mediaAssets.length, 0)

  const unknownListing = identityChangedFailureListing('record-note-clear-unknown', '-unknown')
  await assert.rejects(
    () => syncNoteMaterialsForInventory({
      db: { listings: [unknownListing] },
      sourceRows: [{ sourceRecordId: unknownListing.feishuRecordId, value: 'https://forbidden.test/note' }],
      allowedHosts: ['example.test'],
      primaryVideoAttachmentForListing() {
        return failureCleanupAdapter([], { unknownAfterDispatch: true })
      }
    }),
    (error) => error && error.code === 'MATERIAL_EXTERNAL_WRITE_STATE_UNKNOWN',
    '目标清空派发后结果不确定必须中止整轮，不能降级成可提交告警'
  )
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

async function testVerifiedTargetPublishCleanupWarningCommitsLocalState() {
  const sourceRecordId = 'record-note-target-cleanup-warning'
  const listing = continuousActiveFailureListing(sourceRecordId, '-cleanup-warning')
  const oldVideoKey = listing.videoKey
  const sourceBody = Buffer.from('cleanup-warning-source-video')
  const outputBody = Buffer.from('cleanup-warning-standardized-video')
  const sourceContentSha256 = crypto.createHash('sha256').update(sourceBody).digest('hex')
  const outputContentSha256 = crypto.createHash('sha256').update(outputBody).digest('hex')
  const profile = {
    transformProfileVersion: 'cleanup-warning-profile-v1',
    transformProfileSha256: crypto.createHash('sha256').update('cleanup-warning-profile').digest('hex'),
    transformToolFingerprint: crypto.createHash('sha256').update('cleanup-warning-tool').digest('hex')
  }
  const writes = { drive: 0, oss: 0, target: 0, dispatch: 0 }
  let retainedCleanupAttempts = 0
  let targetEvidence = null
  let targetFolderCreated = false

  const drive = {
    writeDispatchEvidenceVersion: 1,
    async listFolder() {
      return [{
        token: 'fileCleanupWarningPrimary123',
        name: '清理告警主视频.mp4',
        type: 'file',
        size: sourceBody.length,
        modifiedTime: '10'
      }]
    },
    async downloadToken() {
      return {
        buffer: Buffer.from(sourceBody),
        contentType: 'video/mp4',
        contentSha256: sourceContentSha256,
        size: sourceBody.length
      }
    },
    async ensureListingFolder(input) {
      if (!targetFolderCreated) {
        input.onWriteDispatched()
        writes.drive += 1
        targetFolderCreated = true
        input.onWriteVerified()
      }
      return { token: 'folderCleanupWarningTarget123' }
    },
    async materializeAsset(input) {
      input.onWriteDispatched()
      writes.drive += 1
      input.onWriteVerified()
      return {
        targetToken: 'explorerCleanupWarningFile123',
        targetName: input.targetName,
        contentType: input.sourceEvidence.contentType,
        contentSha256: input.sourceEvidence.contentSha256,
        size: input.sourceEvidence.size,
        verified: true
      }
    },
    async verifyMaterializedAsset() {
      return { verified: true }
    }
  }
  const oss = {
    writeDispatchEvidenceVersion: 1,
    async putMaterialDeterministic(input) {
      input.onWriteDispatched()
      writes.oss += 1
      input.onWriteVerified()
      return {
        objectKey: input.objectKey,
        contentSha256: input.contentSha256,
        size: input.size,
        verified: true
      }
    },
    async verifyMaterialDeterministic() {
      return { verified: true }
    }
  }
  async function prepareMaterial({ sourceEvidence, keepPreparedFile }) {
    return {
      buffer: Buffer.from(outputBody),
      keepPreparedFile: keepPreparedFile === true,
      sourceContentSha256: sourceEvidence.contentSha256,
      sourceSize: sourceEvidence.size,
      sourceMimeType: sourceEvidence.contentType,
      kind: 'video',
      extension: 'mp4',
      contentSha256: outputContentSha256,
      size: outputBody.length,
      contentType: 'video/mp4',
      ...profile,
      transformAction: 'transcode'
    }
  }
  async function disposePreparedMaterial(prepared) {
    if (prepared.keepPreparedFile !== true) return
    retainedCleanupAttempts += 1
    throw new Error('合成标准化临时文件清理失败')
  }
  function primaryVideoAttachmentForListing() {
    return {
      writeDispatchEvidenceVersion: 1,
      async verifyExact(input) {
        if (targetEvidence && input.primaryVideo &&
            input.primaryVideo.contentSha256 === targetEvidence.contentSha256) {
          return { ...targetEvidence }
        }
        return { verified: false, expectedStateKey: 'cleanup-warning-target-before' }
      },
      async publishExact(input) {
        input.onWriteDispatched()
        writes.target += 1
        targetEvidence = {
          verified: true,
          contentSha256: input.contentSha256,
          size: input.size,
          contentType: input.contentType,
          attachmentTokenFingerprint: '7'.repeat(64),
          targetRecordFingerprint: '8'.repeat(64)
        }
        input.onWriteVerified()
        return { ...targetEvidence }
      }
    }
  }
  const syncInput = {
    db: { listings: [listing] },
    sourceRows: [{
      sourceRecordId,
      value: 'https://example.test/drive/folder/fldCleanupWarningPrimary123'
    }],
    allowedHosts: ['example.test'],
    uploadDir: 'house-videos',
    targetRootFolderToken: 'fldCleanupWarningRoot123',
    drive,
    oss,
    prepareMaterial,
    disposePreparedMaterial,
    primaryVideoAttachmentForListing,
    onExternalWriteDispatched() { writes.dispatch += 1 },
    nowText: '2026-08-17T08:00:00.000Z'
  }

  const first = await syncNoteMaterialsForInventory(syncInput)
  assert.deepStrictEqual(
    [first.complete, first.published, first.failed, first.cleanupWarnings, first.externalWriteStateUnknown === true],
    [true, true, 0, 1, false],
    '目标附件已双回读后，临时文件清理失败只能形成非致命脱敏告警'
  )
  assert.strictEqual(first.status, 'cleanup-warning', '清理告警必须有固定安全状态，不得包含原始异常')
  assert.ok(!JSON.stringify(first).includes('合成标准化临时文件清理失败'), '清理告警不得回显底层异常正文')
  assert.strictEqual(retainedCleanupAttempts, 2, '已验证发布后的临时文件清理必须恰好重试一次')
  assert.notStrictEqual(listing.videoKey, oldVideoKey, '清理告警不得回退已经验证的新本地视频')
  assert.strictEqual(listing.mediaAssets[0].contentSha256, outputContentSha256, '本地媒体清单必须提交新成品摘要')
  assert.strictEqual(listing.noteMaterialState.status, 'verified', '本地 Note 状态必须提交为已验证')
  assert.strictEqual(
    listing.noteMaterialState.primaryTargetAttachment.contentSha256,
    outputContentSha256,
    '私有目标附件状态必须与新本地媒体绑定'
  )
  assert.deepStrictEqual([writes.drive, writes.oss, writes.target], [2, 1, 1], '首轮只允许目标链各写一次')

  const second = await syncNoteMaterialsForInventory({
    ...syncInput,
    nowText: '2026-08-17T14:00:00.000Z'
  })
  assert.deepStrictEqual(
    [second.complete, second.published, second.failed, Number(second.cleanupWarnings || 0), second.noop],
    [true, true, 0, 0, true],
    '第二轮必须精确复用已提交的新本地与目标状态并恢复无告警 noop'
  )
  assert.deepStrictEqual(
    [writes.drive, writes.oss, writes.target],
    [2, 1, 1],
    '清理告警后的第二轮不得重复写 Drive、OSS 或目标附件'
  )
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
  await testBitableAttachmentUploadUsesDedicatedMediaScope()
  await testLargeBitableAttachmentUsesStreamingMediaParts()
  await testPrimaryVideoAttachmentPublishesAfterWholeMaterialSet()
  await testPrimaryTargetFailureReuseAndNoopBoundaries()
  await testPreparedMaterialFailureDisposal()
  await testExactExternalWriteDispatchBoundary()
  await testInventoryForwardsExternalWriteDispatchBoundary()
  await testInactiveRowsSkipAndIdentityFailuresClearManagedTarget()
  await testPreparedMaterialFinallyDisposalRetry()
  await testVerifiedTargetPublishCleanupWarningCommitsLocalState()
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
      'download:mediaSourceB123456',
      'consume:mediaSourceB123456',
      'download:boxSourceA123456',
      'consume:boxSourceA123456'
    ],
    '正式同步必须先形成无 Buffer 计划、再全批预检，全部通过后先处理其他素材并把原始第一视频留到最后'
  )
  const initialDriveTargetName = calls.find((call) => (
    call[0] === 'drive' && call[1] === syntheticAssets()[0].sourceToken
  ))[2]
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
        writeDispatchEvidenceVersion: 1,
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
        writeDispatchEvidenceVersion: 1,
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
