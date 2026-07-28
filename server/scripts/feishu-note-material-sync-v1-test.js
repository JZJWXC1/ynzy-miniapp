'use strict'

const assert = require('assert')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const domain = require('../src/domain')
const {
  assertIsolatedStatePaths,
  assertMaterialSetEquality,
  stableAssetId,
  syncNoteMaterialVideos
} = require('../src/feishu-note-material-sync')

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
