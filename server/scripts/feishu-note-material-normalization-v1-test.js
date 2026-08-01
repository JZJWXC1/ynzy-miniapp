'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough, Readable } = require('stream')
const {
  PROFILE_ID,
  buildProbeArgs,
  createFeishuNoteMaterialNormalizer
} = require('../src/feishu-note-material-normalizer')

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function mp4Bytes(label = 'source') {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.from(`0000${label}`, 'ascii')
  ])
}

function pngChunk(type, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), body, Buffer.alloc(4)])
}

function pngBytes(size = 32) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const minimum = signature.length + 25 + 12
  const idatPayload = Buffer.alloc(Math.max(1, size - minimum - 12), 0x41)
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatPayload),
    pngChunk('IEND')
  ])
}

function gifBytes(size = 32) {
  return Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(Math.max(0, size - 6), 0x42)])
}

function webpChunk(type, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(body.length, 0)
  return Buffer.concat([
    Buffer.from(type, 'ascii'),
    length,
    body,
    body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)
  ])
}

function webpContainer(chunks) {
  const payload = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks])
  const size = Buffer.alloc(4)
  size.writeUInt32LE(payload.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, payload])
}

function webpBytes(size = 32) {
  return webpContainer([webpChunk('VP8 ', Buffer.alloc(Math.max(10, size - 20), 0x43))])
}

function animatedPngBytes() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const animationControl = Buffer.alloc(8)
  animationControl.writeUInt32BE(2, 0)
  const frameControlOne = Buffer.alloc(26)
  const frameControlTwo = Buffer.alloc(26)
  const frameData = Buffer.alloc(8)
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('acTL', animationControl),
    pngChunk('fcTL', frameControlOne),
    pngChunk('IDAT', Buffer.from([0x00])),
    pngChunk('fcTL', frameControlTwo),
    pngChunk('fdAT', frameData),
    pngChunk('IEND')
  ])
}

function animatedWebpBytes() {
  const vp8x = Buffer.alloc(10)
  vp8x[0] = 0x02
  return webpContainer([
    webpChunk('VP8X', vp8x),
    webpChunk('ANIM', Buffer.alloc(6)),
    webpChunk('ANMF', Buffer.alloc(16)),
    webpChunk('ANMF', Buffer.alloc(16))
  ])
}

function jpegBytes(label = 'static') {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x16]),
    Buffer.from(`Exif\0\0${label}`, 'binary'),
    Buffer.from([0xff, 0xd9])
  ])
}

function videoProbe(options = {}) {
  const streams = [{
    codec_type: 'video',
    codec_name: options.codec || 'h264',
    pix_fmt: options.pixelFormat || 'yuv420p',
    width: options.width || 1280,
    height: options.height || 720,
    avg_frame_rate: options.fps || '30/1'
  }]
  if (options.audio !== false) {
    streams.push({ codec_type: 'audio', codec_name: options.audioCodec || 'aac' })
  }
  return {
    streams,
    format: {
      format_name: options.formatName || 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: String(options.duration === undefined ? 30 : options.duration)
    }
  }
}

function imageProbe(format, width, height, options = {}) {
  const codec = format === 'jpeg' ? 'mjpeg' : format
  const frameCount = options.frameCount === undefined ? 1 : options.frameCount
  return {
    streams: [{
      codec_type: 'video',
      codec_name: codec,
      width,
      height,
      avg_frame_rate: '0/0',
      nb_frames: String(frameCount),
      nb_read_frames: String(frameCount)
    }],
    format: { format_name: format === 'gif' ? 'gif' : 'image2' }
  }
}

function writeTool(filePath, content) {
  fs.writeFileSync(filePath, Buffer.from(content))
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o755)
}

function createToolFixture(tempRoot, options = {}) {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const ffmpegPath = path.join(tempRoot, `ffmpeg${suffix}`)
  const ffprobePath = path.join(tempRoot, `ffprobe${suffix}`)
  writeTool(ffmpegPath, options.ffmpegTool || 'fake-ffmpeg-v1')
  writeTool(ffprobePath, options.ffprobeTool || 'fake-ffprobe-v1')
  return { ffmpegPath, ffprobePath }
}

function fakeProcessFactory({
  ffmpegPath,
  ffprobePath,
  probes = [],
  outputs = [],
  holdFfmpeg = false,
  holdProbe = false,
  killCloseDelayMs = 0,
  postKillOutputBytes = 0
}) {
  const calls = []
  const held = []
  let probeIndex = 0
  let outputIndex = 0
  const spawnImpl = (command, args, spawnOptions) => {
    const inputFd = spawnOptions && spawnOptions.stdio && spawnOptions.stdio[3]
    assert.ok(Number.isSafeInteger(inputFd) && inputFd >= 0, 'ffmpeg/ffprobe 必须通过继承 fd 3 读取私有临时文件')
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.killedByNormalizer = false
    child.input = fs.readFileSync(inputFd)
    child.inputMode = fs.fstatSync(inputFd).mode & 0o777
    child.kill = () => {
      if (child.killed) return false
      child.killed = true
      child.killedByNormalizer = true
      if (postKillOutputBytes > 0) child.stdout.write(Buffer.alloc(postKillOutputBytes, 0x58))
      child.stdout.end()
      child.stderr.end()
      if (killCloseDelayMs > 0) {
        setTimeout(() => child.emit('close', null, 'SIGKILL'), killCloseDelayMs)
      } else {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
      }
      return true
    }
    const call = { command, args: [...args], spawnOptions, child }
    calls.push(call)
    const isProbe = path.resolve(command) === path.resolve(ffprobePath)
    const isFfmpeg = path.resolve(command) === path.resolve(ffmpegPath)
    assert.ok(isProbe || isFfmpeg, '只允许启动固定的 ffmpeg/ffprobe 绝对路径')
    const heldByScenario = (isProbe && holdProbe) || (isFfmpeg && holdFfmpeg)
    if (heldByScenario) {
      held.push({
        call,
        complete(value, code = 0) {
          const output = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''))
          child.stdout.end(output)
          child.stderr.end()
          queueMicrotask(() => child.emit('close', code, null))
        }
      })
      queueMicrotask(() => child.emit('spawn'))
      return child
    }
    queueMicrotask(() => {
      child.emit('spawn')
      if (isProbe) {
        const probe = probes[probeIndex++]
        child.stdout.end(Buffer.from(JSON.stringify(probe || {})))
      } else {
        const output = Buffer.from(outputs[outputIndex++] || [])
        if (postKillOutputBytes > 0) child.stdout.write(output)
        else child.stdout.end(output)
      }
      child.stderr.end()
      setImmediate(() => {
        if (!child.killed && (!isFfmpeg || postKillOutputBytes <= 0)) child.emit('close', 0, null)
      })
    })
    return child
  }
  return { spawnImpl, calls, held }
}

function createNormalizer(tempRoot, tools, processes, overrides = {}) {
  return createFeishuNoteMaterialNormalizer({
    ...tools,
    tempRoot,
    spawnImpl: processes.spawnImpl,
    env: {
      PATH: 'SAFE_TOOL_PATH',
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      SECRET_SHOULD_NOT_LEAK: 'hidden'
    },
    timeoutMs: 2000,
    maxVideoSourceBytes: 1024 * 1024,
    maxImageSourceBytes: 1024 * 1024,
    maxVideoPassthroughBytes: 256 * 1024,
    maxVideoOutputBytes: 32 * 1024 * 1024,
    maxImageOutputBytes: 64 * 1024,
    ...overrides
  })
}

function assertNoMaterialTempDirectories(tempRoot) {
  const leftovers = fs.readdirSync(tempRoot).filter((name) => name.startsWith('ynzy-note-material-normalize-'))
  assert.deepStrictEqual(leftovers, [], '成功、失败和超时后都必须清理私有临时目录')
}

async function assertRejectsCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.strictEqual(error && error.code, expectedCode)
    assert.ok(Number.isSafeInteger(error.statusCode), '标准化错误必须携带稳定 HTTP 状态')
    assert.strictEqual(/stderr|token|secret|\\Users\\|\/tmp\//i.test(String(error.message)), false, '错误不得泄露诊断、凭据或临时路径')
    return true
  })
}

async function main() {
  assert.strictEqual(PROFILE_ID, 'feishu-note-serving-v2')
  assert.strictEqual(
    buildProbeArgs({ kind: 'image', demuxer: 'image2pipe' }).includes('-nostdin'),
    false,
    'ffprobe 不支持 ffmpeg 的 -nostdin 参数；stdin 已由子进程层固定为 ignore'
  )
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-note-normalizer-test-'))
  // 未完成的 Promise 本身不会阻止 Node 退出；保持事件循环可观察，避免异步测试假绿。
  const keepAlive = setInterval(() => {}, 100)
  try {
    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-invalid-limits', ffprobeTool: 'fake-ffprobe-invalid-limits' })
      const processes = fakeProcessFactory({ ...tools })
      assert.throws(() => createNormalizer(tempRoot, tools, processes, {
        maxVideoPassthroughBytes: 2 * 1024 * 1024,
        maxVideoOutputBytes: 1024 * 1024
      }), (error) => {
        assert.strictEqual(error && error.code, 'MATERIAL_CONFIGURATION_INVALID')
        assert.strictEqual(error && error.statusCode, 500)
        return true
      })
      assert.strictEqual(processes.calls.length, 0, '矛盾的视频大小配置必须在启动任何外部进程前拒绝')
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-sanitize-mp4', ffprobeTool: 'fake-ffprobe-sanitize-mp4' })
      const hiddenMarker = 'location=+30.2741+120.1551/device=iPhone'
      const source = mp4Bytes(hiddenMarker)
      const output = mp4Bytes('metadata-cleared')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [videoProbe(), videoProbe()],
        outputs: [output]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const prepared = await normalizer.prepareMaterial({
        keepPreparedFile: true,
        asset: { name: 'room.mp4', kind: 'video' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: source, contentType: 'video/mp4' }
      })
      assert.strictEqual(prepared.transformAction, 'sanitize', '兼容 MP4 也必须重编码清除容器与码流中的隐藏信息')
      assert.strictEqual(prepared.normalized, true)
      const preparedFile = await normalizer.openPreparedFile(prepared)
      assert.strictEqual(preparedFile.size, output.length)
      assert.strictEqual(preparedFile.contentSha256, sha256(output))
      assert.strictEqual(fs.readFileSync(preparedFile.filePath).includes(Buffer.from(hiddenMarker)), false)
      const sanitizeCall = processes.calls.find((call) => call.command === tools.ffmpegPath)
      assert.ok(sanitizeCall.args.includes('-map_metadata') && sanitizeCall.args.includes('-1'), '兼容 MP4 重编码必须显式清除容器元数据')
      assert.strictEqual(sanitizeCall.args.includes('copy'), false, '兼容 MP4 禁止流复制，以免保留 H.264/AAC 码流私有数据')
      assert.ok(sanitizeCall.args.includes('libx264') && sanitizeCall.args.includes('aac'), '兼容 MP4 必须重编码为受控 H.264/AAC 成品')
      await normalizer.disposePreparedMaterial(prepared)
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-strip-image', ffprobeTool: 'fake-ffprobe-strip-image' })
      const hiddenMarker = 'GPSLatitude=30.2741;Make=Phone;DateTimeOriginal=2026'
      const source = jpegBytes(hiddenMarker)
      const output = jpegBytes('metadata-cleared')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [imageProbe('jpeg', 800, 600), imageProbe('jpeg', 800, 600)],
        outputs: [output]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const prepared = await normalizer.prepareMaterial({
        keepPreparedFile: true,
        asset: { name: 'room.jpg', kind: 'image' },
        mimeType: 'image/jpeg',
        sourceEvidence: { buffer: source, contentType: 'image/jpeg' }
      })
      assert.strictEqual(prepared.transformAction, 'compress', '小图也必须重编码清除 EXIF/GPS/XMP 等隐藏元数据')
      const preparedFile = await normalizer.openPreparedFile(prepared)
      assert.strictEqual(fs.readFileSync(preparedFile.filePath).includes(Buffer.from(hiddenMarker)), false)
      await normalizer.disposePreparedMaterial(prepared)
      assertNoMaterialTempDirectories(tempRoot)
    }

    for (const scenario of [
      { name: 'animated.png', mimeType: 'image/png', bytes: animatedPngBytes() },
      { name: 'animated.webp', mimeType: 'image/webp', bytes: animatedWebpBytes() }
    ]) {
      const tools = createToolFixture(tempRoot, { ffmpegTool: `fake-ffmpeg-${scenario.name}`, ffprobeTool: `fake-ffprobe-${scenario.name}` })
      const processes = fakeProcessFactory({ ...tools })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { name: scenario.name, kind: 'image' },
        mimeType: scenario.mimeType,
        sourceEvidence: { buffer: scenario.bytes, contentType: scenario.mimeType }
      }), 'MATERIAL_ANIMATED_IMAGE_UNSUPPORTED')
      assert.strictEqual(processes.calls.length, 0, '动画容器必须由真实 chunk 结构在 ffprobe/ffmpeg 前识别并拒绝')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot)
      const source = mp4Bytes('small-compatible')
      const output = mp4Bytes('small-compatible-sanitized')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [videoProbe(), videoProbe()],
        outputs: [output]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const profile = await normalizer.describeProfile()
      assert.strictEqual(profile.transformProfileVersion, PROFILE_ID)
      assert.match(profile.transformProfileSha256, /^[a-f0-9]{64}$/)
      assert.strictEqual(
        profile.transformProfileSha256,
        '25ca53badd591947f9a94ed6d7e5f9fa67527c775da36376601db07a304e5046',
        '任何探测/转码/压缩参数变化都必须显式更新转换档案摘要，防止内容计划静默复用旧规则'
      )
      assert.match(profile.transformToolFingerprint, /^[a-f0-9]{64}$/)
      assert.strictEqual(profile.limits.maxVideoSourceBytes, 1024 * 1024)

      let downloadCalls = 0
      let privateMode = null
      const prepared = await normalizer.prepareMaterial({
        keepPreparedFile: true,
        asset: { name: 'room.mp4', kind: 'video' },
        extension: 'mp4',
        mimeType: 'video/mp4',
        sourceEvidence: {
          size: source.length,
          contentSha256: sha256(source),
          contentType: 'video/mp4',
          async downloadToFile(context) {
            downloadCalls += 1
            assert.deepStrictEqual(
              Object.keys(context).sort(),
              ['fileHandle', 'maxBytes', 'signal'],
              '下载适配器只能拿私有句柄、上限和取消信号，不能拿任意磁盘路径'
            )
            privateMode = (await context.fileHandle.stat()).mode & 0o777
            await context.fileHandle.writeFile(source)
            return {
              size: source.length,
              contentSha256: sha256(source),
              contentType: 'video/mp4'
            }
          }
        }
      })
      assert.strictEqual(downloadCalls, 1)
      if (process.platform !== 'win32') {
        assert.strictEqual(privateMode, 0o600, '源文件在 POSIX 上必须使用 0600 私有权限')
      }
      assert.strictEqual(prepared.transformAction, 'sanitize')
      assert.strictEqual(prepared.normalized, true)
      assert.strictEqual(Object.prototype.hasOwnProperty.call(prepared, 'buffer'), false, '处理结果不得把完整文件装入 Buffer')
      assert.strictEqual(prepared.sourceContentSha256, sha256(source))
      assert.strictEqual(prepared.contentSha256, sha256(output))
      assert.strictEqual(prepared.contentType, 'video/mp4')
      assert.strictEqual(prepared.extension, 'mp4')
      assert.strictEqual(prepared.kind, 'video')
      assert.strictEqual(processes.calls.length, 3, '兼容 MP4 必须按源探测、去元数据重编码、成品复验三步执行')
      assert.strictEqual(processes.calls[0].command, tools.ffprobePath)
      assert.strictEqual(processes.calls[0].spawnOptions.shell, false)
      assert.strictEqual(processes.calls[0].spawnOptions.env.SECRET_SHOULD_NOT_LEAK, undefined)
      assert.deepStrictEqual(
        Object.keys(processes.calls[0].spawnOptions.env).sort(),
        process.platform === 'win32'
          ? ['LANG', 'LC_ALL', 'PATH', 'SystemRoot'].sort()
          : ['LANG', 'LC_ALL', 'PATH'].sort(),
        '子进程环境必须最小化'
      )
      assert.ok(processes.calls[0].args.includes('fd:'), '探测器必须通过 fd 输入')
      assert.strictEqual(processes.calls[0].args.some((arg) => /https?:|secret|token|ynzy-note-material/i.test(String(arg))), false)

      const verified = await normalizer.verifyPreparedMaterial(prepared)
      assert.strictEqual(verified.verified, true)
      prepared.contentType = 'image/png'
      await assertRejectsCode(
        normalizer.verifyPreparedMaterial(prepared),
        'MATERIAL_PREPARED_MISMATCH'
      )
      prepared.contentType = 'video/mp4'
      const preparedFile = await normalizer.openPreparedFile(prepared)
      assert.strictEqual(preparedFile.size, output.length)
      assert.strictEqual(preparedFile.contentSha256, sha256(output))
      assert.deepStrictEqual(fs.readFileSync(preparedFile.filePath), output)
      assert.strictEqual(await normalizer.disposePreparedMaterial(prepared), true)

      const sourceVerification = await normalizer.verifySource({
        asset: { kind: 'video', name: 'room.mp4' },
        prepared,
        async downloadToFile({ fileHandle }) {
          await fileHandle.writeFile(source)
          return { size: source.length, contentSha256: sha256(source), contentType: 'video/mp4' }
        }
      })
      assert.deepStrictEqual(sourceVerification, {
        verified: true,
        sourceContentSha256: sha256(source),
        sourceSize: source.length,
        sourceMimeType: 'video/mp4'
      })
      assertNoMaterialTempDirectories(tempRoot)
      assert.strictEqual(await normalizer.disposePreparedMaterial(prepared), false)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-transcode', ffprobeTool: 'fake-ffprobe-transcode' })
      const source = mp4Bytes('hevc-source')
      const output = mp4Bytes('h264-normalized')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [
          videoProbe({ codec: 'hevc', pixelFormat: 'yuv420p10le', width: 3840, height: 2160, fps: '60/1', duration: 91 }),
          videoProbe({ codec: 'h264', pixelFormat: 'yuv420p', width: 1920, height: 1080, fps: '30/1', duration: 91 })
        ],
        outputs: [output]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const prepared = await normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'phone.mov' },
        extension: 'mov',
        mimeType: 'video/quicktime',
        sourceEvidence: {
          buffer: source,
          size: source.length,
          contentSha256: sha256(source),
          contentType: 'video/quicktime'
        }
      })
      assert.strictEqual(prepared.transformAction, 'transcode')
      assert.strictEqual(prepared.normalized, true)
      assert.strictEqual(prepared.contentSha256, sha256(output))
      assert.strictEqual(Object.prototype.hasOwnProperty.call(prepared, 'buffer'), false)
      assert.strictEqual(prepared.extension, 'mp4')
      assert.strictEqual(prepared.contentType, 'video/mp4')
      assert.strictEqual(prepared.probe.codec, 'h264')
      assert.strictEqual(prepared.probe.pixelFormat, 'yuv420p')
      assert.strictEqual(processes.calls.length, 3, '视频必须按源探测、转码、成品复验三步执行')
      const transcodeCall = processes.calls[1]
      assert.strictEqual(transcodeCall.command, tools.ffmpegPath)
      assert.ok(transcodeCall.args.includes('libx264'))
      assert.ok(transcodeCall.args.includes('yuv420p'))
      assert.ok(transcodeCall.args.includes('aac'))
      const videoBitrateIndex = transcodeCall.args.indexOf('-b:v')
      assert.ok(videoBitrateIndex >= 0, '视频必须按时长和成品字节上限计算平均码率')
      const plannedVideoBitrate = Number(transcodeCall.args[videoBitrateIndex + 1])
      const plannedTotalBytes = ((plannedVideoBitrate + 128000) * 91) / 8
      assert.ok(plannedTotalBytes <= 32 * 1024 * 1024 * 0.85, '长视频的目标码率必须预留容器开销并落在最终大小预算内')
      assert.ok(transcodeCall.args.includes('-fpsmax'))
      assert.strictEqual(transcodeCall.args.includes('-t'), false, '不得用 -t 截断超时长视频伪装成功')
      assert.strictEqual(transcodeCall.args.includes('-fs'), false, '不得用 -fs 产出截断文件伪装压缩成功')
      if (process.platform !== 'win32') assert.strictEqual(transcodeCall.inputMode, 0o600)
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-image', ffprobeTool: 'fake-ffprobe-image' })
      const source = pngBytes(160)
      const output = pngBytes(40)
      const processes = fakeProcessFactory({
        ...tools,
        probes: [imageProbe('png', 4096, 2048), imageProbe('png', 2048, 1024)],
        outputs: [output]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes, { maxImageOutputBytes: 64 })
      const prepared = await normalizer.prepareMaterial({
        asset: { kind: 'image', name: 'room.png' },
        sourceEvidence: {
          stream: Readable.from([source.subarray(0, 50), source.subarray(50)]),
          size: source.length,
          contentSha256: sha256(source),
          contentType: 'image/png'
        }
      })
      assert.strictEqual(prepared.transformAction, 'compress')
      assert.strictEqual(prepared.contentSha256, sha256(output))
      assert.strictEqual(Object.prototype.hasOwnProperty.call(prepared, 'buffer'), false)
      assert.strictEqual(prepared.contentType, 'image/png')
      assert.strictEqual(prepared.probe.width, 2048)
      assert.strictEqual(processes.calls.length, 3, '大图必须按源探测、压缩、成品复验三步执行')
      const sourceProbeCall = processes.calls[0]
      const sourceInputIndex = sourceProbeCall.args.indexOf('-i')
      assert.ok(sourceProbeCall.args.indexOf('-count_frames') >= 0, '图片探测必须实际统计帧数，不能仅相信容器声明')
      assert.ok(sourceProbeCall.args.indexOf('-count_frames') < sourceInputIndex, '帧数统计选项必须作用于本次图片输入')
      assert.strictEqual(sourceProbeCall.args[sourceInputIndex - 4], '-f')
      assert.strictEqual(sourceProbeCall.args[sourceInputIndex - 3], 'image2pipe', '单张图片 fd 输入必须使用 image2pipe，不能误用文件序列 image2')
      const imageCall = processes.calls[1]
      const imageInputIndex = imageCall.args.indexOf('-i')
      assert.strictEqual(imageCall.args[imageInputIndex - 4], '-f')
      assert.strictEqual(imageCall.args[imageInputIndex - 3], 'image2pipe')
      assert.ok(imageCall.args.includes('-frames:v'))
      assert.ok(imageCall.args.some((arg) => String(arg).includes('2048')))
      assert.ok(imageCall.args.includes('-map_metadata'))
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-png-fallback', ffprobeTool: 'fake-ffprobe-png-fallback' })
      const source = pngBytes(160)
      const oversizedLosslessPng = pngBytes(96)
      const webpOutput = webpBytes(40)
      const processes = fakeProcessFactory({
        ...tools,
        probes: [imageProbe('png', 4096, 3072), imageProbe('webp', 2048, 1536)],
        outputs: [oversizedLosslessPng, webpOutput]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes, { maxImageOutputBytes: 64 })
      const prepared = await normalizer.prepareMaterial({
        asset: { kind: 'image', name: 'high-entropy.png' },
        sourceEvidence: { buffer: source, contentType: 'image/png' }
      })
      assert.strictEqual(prepared.transformAction, 'compress')
      assert.strictEqual(prepared.extension, 'webp', '无损 PNG 仍超限时必须确定性降级为保留透明通道的 WebP')
      assert.strictEqual(prepared.contentType, 'image/webp')
      assert.strictEqual(prepared.contentSha256, sha256(webpOutput))
      assert.strictEqual(Object.prototype.hasOwnProperty.call(prepared, 'buffer'), false)
      assert.strictEqual(processes.calls.length, 4, 'PNG 二次降级必须经过源探测、无损尝试、WebP 降级和成品复验')
      assert.ok(processes.calls[1].args.includes('png'))
      assert.ok(processes.calls[2].args.includes('libwebp'))
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-retained', ffprobeTool: 'fake-ffprobe-retained' })
      const sourceOne = mp4Bytes('retained-one')
      const sourceTwo = mp4Bytes('retained-two')
      const outputOne = mp4Bytes('retained-one-sanitized')
      const outputTwo = mp4Bytes('retained-two-sanitized')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [videoProbe(), videoProbe(), videoProbe(), videoProbe()],
        outputs: [outputOne, outputTwo]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const retainedOne = await normalizer.prepareMaterial({
        keepPreparedFile: true,
        asset: { kind: 'video', name: 'retained-one.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: sourceOne, contentType: 'video/mp4' }
      })
      await assertRejectsCode(normalizer.prepareMaterial({
        keepPreparedFile: true,
        asset: { kind: 'video', name: 'retained-two.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: sourceTwo, contentType: 'video/mp4' }
      }), 'MATERIAL_NORMALIZATION_BUSY')
      assert.strictEqual(Object.prototype.hasOwnProperty.call(retainedOne, 'buffer'), false, '生产保留模式不得把最终 Buffer 堆在计划数组')
      assert.strictEqual(/ynzy-note-material|source-material|normalized-material|tmp/i.test(JSON.stringify(retainedOne)), false, '私有路径和句柄不得进入 JSON 计划或报告')
      assert.strictEqual(
        fs.readdirSync(tempRoot).filter((name) => name.startsWith('ynzy-note-material-normalize-')).length,
        1,
        '同一时刻最多只能保留一个私有成品目录，防止大批素材耗尽磁盘'
      )

      // 同步层会规范化字段并展开对象；私有 Symbol 句柄必须跟随展开，但不会进入 JSON。
      const normalizedClone = { ...retainedOne }
      const openedOne = await normalizer.openPreparedFile(normalizedClone)
      assert.deepStrictEqual(fs.readFileSync(openedOne.filePath), outputOne, '写单件时必须打开已复验的磁盘成品，不能退回完整 Buffer')
      assert.strictEqual(await normalizer.disposePreparedMaterial(normalizedClone), true)
      await assertRejectsCode(normalizer.openPreparedFile(retainedOne), 'MATERIAL_PREPARED_INVALID')

      const retainedTwo = await normalizer.prepareMaterial({
        keepPreparedFile: true,
        asset: { kind: 'video', name: 'retained-two.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: sourceTwo, contentType: 'video/mp4' }
      })
      const openedTwo = await normalizer.openPreparedFile(retainedTwo)
      assert.deepStrictEqual(fs.readFileSync(openedTwo.filePath), outputTwo)
      const originalRm = fs.promises.rm
      let injectedCleanupFailure = true
      fs.promises.rm = async (target, rmOptions) => {
        if (injectedCleanupFailure && path.basename(String(target)).startsWith('ynzy-note-material-normalize-')) {
          injectedCleanupFailure = false
          throw new Error('injected cleanup failure must stay private')
        }
        return originalRm.call(fs.promises, target, rmOptions)
      }
      try {
        await assertRejectsCode(
          normalizer.disposePreparedMaterial(retainedTwo),
          'MATERIAL_STORAGE_CLEANUP_FAILED'
        )
        assert.strictEqual(normalizer.retainedCount(), 1, '清理失败后必须保留私有注册项以便安全重试')
        assert.strictEqual(
          fs.readdirSync(tempRoot).filter((name) => name.startsWith('ynzy-note-material-normalize-')).length,
          1,
          '首次清理失败时目录仍在，结论不得伪装为已清理'
        )
      } finally {
        fs.promises.rm = originalRm
      }
      assert.strictEqual(await normalizer.disposePreparedMaterial(retainedTwo), true, '清理失败后第二次 dispose 必须可重试成功')
      assert.strictEqual(normalizer.retainedCount(), 0)
      assert.strictEqual(await normalizer.disposePreparedMaterial(retainedTwo), false, '磁盘素材清理必须幂等')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-retained-output', ffprobeTool: 'fake-ffprobe-retained-output' })
      const source = mp4Bytes('retained-hevc')
      const output = mp4Bytes('retained-h264')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [videoProbe({ codec: 'hevc', duration: 44 }), videoProbe({ codec: 'h264', duration: 44 })],
        outputs: [output]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const prepared = await normalizer.prepareMaterial({
        keepPreparedFile: true,
        asset: { kind: 'video', name: 'retained.mov' },
        mimeType: 'video/quicktime',
        sourceEvidence: { buffer: source, contentType: 'video/quicktime' }
      })
      assert.strictEqual(prepared.transformAction, 'transcode')
      assert.strictEqual(prepared.buffer, undefined)
      const preparedFile = await normalizer.openPreparedFile(prepared)
      assert.deepStrictEqual(fs.readFileSync(preparedFile.filePath), output, '保留模式必须打开已复验的转码成品，不得退回源文件或完整 Buffer')
      assert.strictEqual(await normalizer.disposePreparedMaterial(prepared), true)
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-gif', ffprobeTool: 'fake-ffprobe-gif' })
      const source = gifBytes(80)
      const processes = fakeProcessFactory({ ...tools, probes: [imageProbe('gif', 1200, 900, { frameCount: 2 })] })
      const normalizer = createNormalizer(tempRoot, tools, processes, { maxImageOutputBytes: 32 })
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'image', name: 'animated.gif' },
        sourceEvidence: { buffer: source, contentType: 'image/gif' }
      }), 'MATERIAL_ANIMATED_IMAGE_UNSUPPORTED')
      assert.strictEqual(processes.calls.filter((call) => call.command === tools.ffmpegPath).length, 0, '超标 GIF 不得被静默压成静态图')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-animated-webp', ffprobeTool: 'fake-ffprobe-animated-webp' })
      const source = webpBytes(80)
      const processes = fakeProcessFactory({
        ...tools,
        probes: [imageProbe('webp', 1200, 900, { frameCount: 3 })]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes, { maxImageOutputBytes: 32 })
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'image', name: 'animated.webp' },
        sourceEvidence: { buffer: source, contentType: 'image/webp' }
      }), 'MATERIAL_ANIMATED_IMAGE_UNSUPPORTED')
      assert.strictEqual(processes.calls.filter((call) => call.command === tools.ffmpegPath).length, 0, '超标多帧 WebP 不得被静默压成单帧')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-apng', ffprobeTool: 'fake-ffprobe-apng' })
      const source = pngBytes(80)
      const processes = fakeProcessFactory({
        ...tools,
        probes: [imageProbe('png', 1200, 900, { frameCount: 2 })]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes, { maxImageOutputBytes: 32 })
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'image', name: 'animated.png' },
        sourceEvidence: { buffer: source, contentType: 'image/png' }
      }), 'MATERIAL_ANIMATED_IMAGE_UNSUPPORTED')
      assert.strictEqual(processes.calls.filter((call) => call.command === tools.ffmpegPath).length, 0, '超标 APNG 不得被静默压成静态 PNG 或 WebP')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-docx', ffprobeTool: 'fake-ffprobe-docx' })
      const source = pngBytes(40)
      const output = pngBytes(32)
      const processes = fakeProcessFactory({
        ...tools,
        probes: [imageProbe('png', 800, 600), imageProbe('png', 800, 600)],
        outputs: [output]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const prepared = await normalizer.prepareMaterial({
        asset: { kind: 'image', sourceKind: 'docx-image', name: '文档内图片', mimeType: 'image/*' },
        sourceEvidence: {
          async downloadToFile({ fileHandle }) {
            await fileHandle.writeFile(source)
            return { size: source.length, contentSha256: sha256(source), contentType: 'image/png' }
          }
        }
      })
      assert.strictEqual(prepared.transformAction, 'compress', 'docx-image 的 image/* 声明必须依赖真实回执和字节探测，并重编码清除隐藏元数据')
      assert.strictEqual(prepared.sourceMimeType, 'image/png')
      assert.strictEqual(prepared.contentType, 'image/png')
      assert.strictEqual(prepared.contentSha256, sha256(output))
      const verified = await normalizer.verifySource({
        asset: { kind: 'image', sourceKind: 'docx-image', name: '文档内图片', mimeType: 'image/*' },
        prepared,
        async downloadToFile({ fileHandle }) {
          await fileHandle.writeFile(source)
          return { size: source.length, contentSha256: sha256(source), contentType: 'image/png' }
        }
      })
      assert.strictEqual(verified.verified, true, 'docx-image 的源文件二次流式复验必须通过')
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'image', sourceKind: 'docx-image', name: '文档内图片', mimeType: 'image/*' },
        sourceEvidence: {
          async downloadToFile({ fileHandle }) {
            await fileHandle.writeFile(source)
            return { size: source.length, contentSha256: sha256(source), contentType: 'video/mp4' }
          }
        }
      }), 'MATERIAL_MIME_MISMATCH')
      await assertRejectsCode(normalizer.verifySource({
        asset: { kind: 'image', sourceKind: 'docx-image', name: '文档内图片', mimeType: 'image/*' },
        prepared,
        async downloadToFile({ fileHandle }) {
          await fileHandle.writeFile(source)
          return { size: source.length, contentSha256: sha256(source), contentType: 'video/mp4' }
        }
      }), 'MATERIAL_SOURCE_REVERIFY_MISMATCH')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-magic', ffprobeTool: 'fake-ffprobe-magic' })
      const processes = fakeProcessFactory({ ...tools })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'spoof.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: pngBytes(), contentType: 'video/mp4' }
      }), 'MATERIAL_FORMAT_INVALID')
      assert.strictEqual(processes.calls.length, 0, '魔数与声明冲突时必须在启动探测器前拒绝')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-evidence', ffprobeTool: 'fake-ffprobe-evidence' })
      const source = mp4Bytes('evidence')
      const processes = fakeProcessFactory({ ...tools })
      const normalizer = createNormalizer(tempRoot, tools, processes, { maxVideoSourceBytes: source.length })
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'evidence.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: source, size: source.length - 1, contentType: 'video/mp4' }
      }), 'MATERIAL_SOURCE_SIZE_MISMATCH')
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'too-large.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: Buffer.concat([source, Buffer.from('x')]), contentType: 'video/mp4' }
      }), 'MATERIAL_SOURCE_TOO_LARGE')
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'missing-receipt.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: {
          async downloadToFile({ fileHandle }) {
            await fileHandle.writeFile(source)
          }
        }
      }), 'MATERIAL_SOURCE_EVIDENCE_INVALID')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-overflow', ffprobeTool: 'fake-ffprobe-overflow' })
      const source = mp4Bytes('overflow-source')
      const oversizedOutput = Buffer.concat([mp4Bytes('overflow-output'), Buffer.alloc(64 * 1024)])
      const processes = fakeProcessFactory({
        ...tools,
        probes: [videoProbe({ codec: 'hevc', duration: 0.1 })],
        outputs: [oversizedOutput],
        killCloseDelayMs: 30,
        postKillOutputBytes: 1024 * 1024
      })
      const normalizer = createNormalizer(tempRoot, tools, processes, {
        maxVideoPassthroughBytes: 32 * 1024,
        maxVideoOutputBytes: 32 * 1024,
        maxVideoDurationSeconds: 1
      })
      const startedAt = Date.now()
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'overflow.mov' },
        mimeType: 'video/quicktime',
        sourceEvidence: { buffer: source, contentType: 'video/quicktime' }
      }), 'MATERIAL_OUTPUT_TOO_LARGE')
      assert.ok(Date.now() - startedAt >= 25, '超限后必须等待子进程 close/stdio 释放，不能立刻删除仍被占用的临时文件')
      const transcodeCall = processes.calls.find((call) => call.command === tools.ffmpegPath)
      assert.ok(transcodeCall.child.killedByNormalizer, '输出超过硬上限时必须立即杀死转码进程')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-timeout', ffprobeTool: 'fake-ffprobe-timeout' })
      const source = mp4Bytes('timeout-source')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [videoProbe({ codec: 'hevc' })],
        holdFfmpeg: true
      })
      const normalizer = createNormalizer(tempRoot, tools, processes, { timeoutMs: 40 })
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'timeout.mov' },
        mimeType: 'video/quicktime',
        sourceEvidence: { buffer: source, contentType: 'video/quicktime' }
      }), 'MATERIAL_NORMALIZATION_TIMEOUT')
      assert.ok(processes.held[0].call.child.killedByNormalizer, '超时必须杀死仍运行的转码进程')
      assert.strictEqual(normalizer.activeCount(), 0, '超时后必须释放唯一并发名额')
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-cleanup-slot', ffprobeTool: 'fake-ffprobe-cleanup-slot' })
      const source = mp4Bytes('cleanup-slot')
      const firstOutput = mp4Bytes('cleanup-slot-first')
      const secondOutput = mp4Bytes('cleanup-slot-second')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [videoProbe(), videoProbe(), videoProbe(), videoProbe()],
        outputs: [firstOutput, secondOutput]
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const originalRm = fs.promises.rm
      let failNextCleanup = true
      fs.promises.rm = async (target, rmOptions) => {
        if (failNextCleanup && path.basename(String(target)).startsWith('ynzy-note-material-normalize-')) {
          failNextCleanup = false
          throw new Error('injected cleanup failure must stay private')
        }
        return originalRm.call(fs.promises, target, rmOptions)
      }
      try {
        await assertRejectsCode(normalizer.prepareMaterial({
          asset: { kind: 'video', name: 'cleanup-failure.mp4' },
          mimeType: 'video/mp4',
          sourceEvidence: { buffer: source, contentType: 'video/mp4' }
        }), 'MATERIAL_STORAGE_CLEANUP_FAILED')
      } finally {
        fs.promises.rm = originalRm
      }
      assert.strictEqual(normalizer.activeCount(), 0, '临时目录清理失败也必须释放唯一并发名额')
      const prepared = await normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'cleanup-retry.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: source, contentType: 'video/mp4' }
      })
      assert.strictEqual(prepared.transformAction, 'sanitize', '清理异常后下一件素材必须仍能正常进入处理')
      for (const name of fs.readdirSync(tempRoot).filter((entry) => entry.startsWith('ynzy-note-material-normalize-'))) {
        fs.rmSync(path.join(tempRoot, name), { recursive: true, force: true })
      }
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-verify-cleanup-slot', ffprobeTool: 'fake-ffprobe-verify-cleanup-slot' })
      const source = mp4Bytes('verify-cleanup-slot')
      const output = mp4Bytes('verify-cleanup-slot-sanitized')
      const processes = fakeProcessFactory({ ...tools, probes: [videoProbe(), videoProbe()], outputs: [output] })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const prepared = await normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'verify-cleanup.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: source, contentType: 'video/mp4' }
      })
      const originalRm = fs.promises.rm
      let failNextCleanup = true
      fs.promises.rm = async (target, rmOptions) => {
        if (failNextCleanup && path.basename(String(target)).startsWith('ynzy-note-material-normalize-')) {
          failNextCleanup = false
          throw new Error('injected verify cleanup failure must stay private')
        }
        return originalRm.call(fs.promises, target, rmOptions)
      }
      try {
        await assertRejectsCode(normalizer.verifySource({
          asset: { kind: 'video', name: 'verify-cleanup.mp4' },
          prepared,
          sourceEvidence: { buffer: source, contentType: 'video/mp4' }
        }), 'MATERIAL_STORAGE_CLEANUP_FAILED')
      } finally {
        fs.promises.rm = originalRm
      }
      assert.strictEqual(normalizer.activeCount(), 0, '源素材复验清理失败也必须释放唯一并发名额')
      const verified = await normalizer.verifySource({
        asset: { kind: 'video', name: 'verify-cleanup-retry.mp4' },
        prepared,
        sourceEvidence: { buffer: source, contentType: 'video/mp4' }
      })
      assert.strictEqual(verified.verified, true, '复验清理异常后下一次源素材复验必须仍能正常进入')
      for (const name of fs.readdirSync(tempRoot).filter((entry) => entry.startsWith('ynzy-note-material-normalize-'))) {
        fs.rmSync(path.join(tempRoot, name), { recursive: true, force: true })
      }
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-busy', ffprobeTool: 'fake-ffprobe-busy' })
      const source = mp4Bytes('busy-source')
      const output = mp4Bytes('busy-output')
      const processes = fakeProcessFactory({
        ...tools,
        probes: [
          videoProbe({ codec: 'hevc', duration: 20 }),
          videoProbe({ codec: 'h264', duration: 20 })
        ],
        outputs: [output],
        holdFfmpeg: true
      })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const first = normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'busy.mov' },
        mimeType: 'video/quicktime',
        sourceEvidence: { buffer: source, contentType: 'video/quicktime' }
      })
      const deadline = Date.now() + 1000
      while (processes.held.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      assert.strictEqual(normalizer.activeCount(), 1)
      await assertRejectsCode(normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'second.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: source, contentType: 'video/mp4' }
      }), 'MATERIAL_NORMALIZATION_BUSY')
      processes.held[0].complete(output)
      const prepared = await first
      assert.strictEqual(prepared.transformAction, 'transcode')
      assert.strictEqual(normalizer.activeCount(), 0)
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-profile-1', ffprobeTool: 'fake-ffprobe-profile' })
      const first = createNormalizer(tempRoot, tools, fakeProcessFactory({ ...tools }))
      const firstProfile = await first.describeProfile()
      writeTool(tools.ffmpegPath, 'fake-ffmpeg-profile-2')
      const second = createNormalizer(tempRoot, tools, fakeProcessFactory({ ...tools }))
      const secondProfile = await second.describeProfile()
      assert.notStrictEqual(
        firstProfile.transformToolFingerprint,
        secondProfile.transformToolFingerprint,
        '工具二进制变化必须改变工具指纹'
      )
      assert.notStrictEqual(
        firstProfile.transformProfileSha256,
        secondProfile.transformProfileSha256,
        '工具二进制变化必须改变完整转换档案摘要'
      )
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-recovery', ffprobeTool: 'fake-ffprobe-recovery' })
      const normalizer = createNormalizer(tempRoot, tools, fakeProcessFactory({ ...tools }))
      const staleDirectory = path.join(tempRoot, 'ynzy-note-material-normalize-stale-crash')
      const freshDirectory = path.join(tempRoot, 'ynzy-note-material-normalize-fresh-run')
      fs.mkdirSync(staleDirectory, { mode: 0o700 })
      fs.writeFileSync(path.join(staleDirectory, 'source-material'), Buffer.from('stale-sensitive-bytes'), { mode: 0o600 })
      fs.mkdirSync(freshDirectory, { mode: 0o700 })
      const staleAt = new Date(Date.now() - (25 * 60 * 60 * 1000))
      fs.utimesSync(staleDirectory, staleAt, staleAt)
      const recovered = await normalizer.recoverStaleDirectories()
      assert.strictEqual(recovered.removed, 1, '进程崩溃遗留超过 24 小时的私有目录必须可回收')
      assert.strictEqual(fs.existsSync(staleDirectory), false)
      assert.strictEqual(fs.existsSync(freshDirectory), true, '新鲜目录可能属于并行任务，不得误删')
      fs.rmSync(freshDirectory, { recursive: true, force: true })
      assertNoMaterialTempDirectories(tempRoot)
    }

    {
      const tools = createToolFixture(tempRoot, { ffmpegTool: 'fake-ffmpeg-reverify', ffprobeTool: 'fake-ffprobe-reverify' })
      const source = mp4Bytes('reverify-source')
      const output = mp4Bytes('reverify-sanitized')
      const processes = fakeProcessFactory({ ...tools, probes: [videoProbe(), videoProbe()], outputs: [output] })
      const normalizer = createNormalizer(tempRoot, tools, processes)
      const prepared = await normalizer.prepareMaterial({
        asset: { kind: 'video', name: 'reverify.mp4' },
        mimeType: 'video/mp4',
        sourceEvidence: { buffer: source, contentType: 'video/mp4' }
      })
      const changed = mp4Bytes('changed-source')
      await assertRejectsCode(normalizer.verifySource({
        asset: { kind: 'video', name: 'reverify.mp4' },
        prepared,
        sourceEvidence: {
          async downloadToFile({ fileHandle }) {
            await fileHandle.writeFile(changed)
            return { size: changed.length, contentSha256: sha256(changed), contentType: 'video/mp4' }
          }
        }
      }), 'MATERIAL_SOURCE_REVERIFY_MISMATCH')
      assertNoMaterialTempDirectories(tempRoot)
    }

    console.log('feishu-note-material-normalization-v1-test passed')
  } finally {
    clearInterval(keepAlive)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`feishu-note-material-normalization-v1-test failed: ${error.stack || error.message}`)
  process.exit(1)
})
