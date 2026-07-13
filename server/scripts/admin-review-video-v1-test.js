const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const vm = require('vm')
const http = require('http')
const net = require('net')
const { EventEmitter } = require('events')
const { PassThrough, Readable } = require('stream')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')

const root = path.resolve(__dirname, '..', '..')
const adminSource = fs.readFileSync(path.join(root, 'admin-web', 'index.html'), 'utf8')
const indexSource = fs.readFileSync(path.join(root, 'server', 'src', 'index.js'), 'utf8')

function extractFunction(source, marker) {
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `缺少函数：${marker}`)
  const braceStart = source.indexOf('{', start)
  assert.ok(braceStart >= 0, `函数缺少函数体：${marker}`)
  let depth = 0
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`函数未闭合：${marker}`)
}

function fakeUpstream(statusCode = 200, body = 'source-hevc-bytes', options = {}) {
  const stream = Readable.from([Buffer.from(body)])
  stream.statusCode = statusCode
  stream.headers = {
    'content-type': statusCode === 200 ? 'video/mp4' : 'application/xml'
  }
  if (!options.omitContentLength) {
    stream.headers['content-length'] = String(options.contentLength === undefined
      ? Buffer.byteLength(body)
      : options.contentLength)
  }
  return stream
}

function requestFactory(options = {}) {
  const calls = []
  const requestImpl = (url, requestOptions, callback) => {
    const request = new EventEmitter()
    request.destroyedByPreview = false
    request.setTimeout = (timeout, onTimeout) => {
      request.timeout = timeout
      request.onTimeout = onTimeout
      return request
    }
    request.destroy = () => {
      request.destroyedByPreview = true
    }
    calls.push({ url, requestOptions, request })
    queueMicrotask(() => callback(fakeUpstream(options.statusCode || 200, options.body, options)))
    return request
  }
  return { requestImpl, calls }
}

function processFactory(options = {}) {
  const calls = []
  const spawnImpl = (command, args, spawnOptions) => {
    const inheritedFd = spawnOptions && spawnOptions.stdio && spawnOptions.stdio[3]
    assert.ok(Number.isSafeInteger(inheritedFd) && inheritedFd >= 0, '测试转码器必须通过 fd 3 接收可寻址输入')
    const child = new EventEmitter()
    child.stdin = null
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.input = [fs.readFileSync(inheritedFd)]
    child.inputMode = fs.fstatSync(inheritedFd).mode & 0o777
    child.killedByPreview = false
    if (options.prebufferOutput) child.stdout.write(Buffer.from(options.prebufferOutput))
    child.kill = () => {
      child.killedByPreview = true
      child.stdout.end()
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
      return true
    }
    calls.push({ command, args, spawnOptions, child })
    queueMicrotask(() => {
      if (options.spawnError) child.emit('error', new Error('spawn detail must stay private'))
      else {
        child.emit('spawn')
        if (!options.holdOpen) {
          child.stdout.end(Buffer.from(options.output || 'compatible-h264-mp4'))
          queueMicrotask(() => child.emit('close', 0, null))
        }
      }
    })
    return child
  }
  return { spawnImpl, calls }
}

class FakeResponse extends PassThrough {
  constructor() {
    super()
    this.statusCode = 0
    this.headers = {}
    this.headersSent = false
    this.chunks = []
    this.destroyedByPreview = false
    this.on('data', (chunk) => this.chunks.push(Buffer.from(chunk)))
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode
    this.headers = { ...headers }
    this.headersSent = true
    return this
  }

  destroy(error) {
    this.destroyedByPreview = true
    this.previewError = error || null
    this.end()
    return this
  }
}

function waitTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitUntil(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  if (predicate()) return
  throw new Error(message)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function httpCall(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body))
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
        ...(options.headers || {})
      }
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }))
    })
    request.once('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${stderr.slice(0, 500)}`)), 10000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (!stdout.includes('后端已启动')) return
      clearTimeout(timer)
      resolve()
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`服务提前退出 code=${code}：${stderr.slice(0, 500)}`))
    })
  })
}

async function main() {
  const backendTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-admin-video-spool-test-'))
  // 旧实现会稳定红在这里：只有原始 <video>，没有失败后的鉴权兼容预览。
  assert.ok(adminSource.includes('data-review-video-source='), '审核视频必须先绑定 error 监听，再加载原始地址')
  assert.ok(adminSource.includes('const sourceUrl = videoUrl;'), '新窗口原视频入口也必须优先使用签名地址')
  assert.ok(adminSource.includes('function safeReviewVideoUrl('), '原视频新窗口链接必须过滤危险协议')
  assert.ok(adminSource.includes('async function loadCompatibleReviewVideo('), '后台必须实现 H.264 兼容预览加载')
  assert.ok(adminSource.includes('/video-compatible-preview'), '前端必须请求固定的管理员兼容预览接口')
  assert.ok(adminSource.includes('URL.createObjectURL'), '兼容预览必须使用受控 Blob URL，不把后台 token 放进视频 URL')
  assert.ok(adminSource.includes('function releaseAllReviewVideoResources('), '后台必须提供跨审核栏目统一释放入口')
  assert.ok(adminSource.includes("window.addEventListener('pagehide', releaseAllReviewVideoResources)"), '离开后台页面必须中止转码并回收 Blob')
  const clearSessionSource = extractFunction(adminSource, 'function clearAdminSession(')
  assert.ok(clearSessionSource.includes('releaseAllReviewVideoResources()'), '管理员会话失效必须立即中止隐藏转码')
  const navHandlerStart = adminSource.indexOf("document.querySelectorAll('.nav-button').forEach")
  const navHandlerSource = adminSource.slice(navHandlerStart, navHandlerStart + 1200)
  assert.ok(navHandlerSource.includes('releaseAllReviewVideoResources()'), '切换任意后台栏目必须释放审核视频资源')
  const handleAdminIndex = indexSource.indexOf('async function handleAdmin(')
  const authGateIndex = indexSource.indexOf('const adminAccount = assertAdminRequest(req, db)', handleAdminIndex)
  const previewRouteIndex = indexSource.indexOf('const adminVideoPreviewMatch', handleAdminIndex)
  assert.ok(previewRouteIndex > authGateIndex && authGateIndex > handleAdminIndex, '兼容预览必须位于管理员 Bearer 鉴权之后')
  const previewRouteEnd = indexSource.indexOf('const adminExpiredRestoreMatch', previewRouteIndex)
  const previewRouteSource = indexSource.slice(previewRouteIndex, previewRouteEnd)
  assert.ok(previewRouteSource.includes('objectKey: listing.videoKey'), '兼容预览源只能取服务端房源持久 videoKey')
  assert.ok(previewRouteSource.includes('isManagedVideoObjectKey'), '路由必须拒绝非服务端上传目录的视频 Key')
  assert.strictEqual(/searchParams\.get|parseBody\(|body\.video/i.test(previewRouteSource), false, '兼容预览不得采信客户端 URL/Key')

  const {
    buildFfmpegArgs,
    buildFfmpegSpawnOptions,
    isAllowedSignedReadUrl,
    isManagedVideoObjectKey,
    createAdminVideoPreviewStreamer
  } = require('../src/admin-video-preview')

  const args = buildFfmpegArgs({ maxDurationSeconds: 300, maxOutputBytes: 8 * 1024 * 1024 })
  assert.ok(args.includes('fd:') && args.includes('pipe:1'), '输入必须走受控可寻址 fd，输出走管道，不把签名 URL 或临时路径放进参数')
  const inputIndex = args.indexOf('-i')
  const protocolIndex = args.indexOf('-protocol_whitelist')
  assert.ok(protocolIndex >= 0 && protocolIndex < inputIndex && args[protocolIndex + 1] === 'fd,pipe', 'ffmpeg 只允许受控 fd 输入与 pipe 输出协议')
  const fdIndex = args.indexOf('-fd')
  assert.ok(fdIndex >= 0 && fdIndex < inputIndex && args[fdIndex + 1] === '3', 'ffmpeg 只能读取 Node 显式继承的 fd 3')
  assert.strictEqual(args.some((item) => /(?:^|\b)(?:file|https?):/i.test(String(item))), false, 'ffmpeg 参数不得出现文件路径或网络 URL')
  assert.strictEqual(args[inputIndex - 2], '-f', 'ffmpeg 必须在输入前固定容器解析器')
  assert.strictEqual(args[inputIndex - 1], 'mov', '手机 MP4/MOV/M4V 只允许 MOV/MP4 demuxer')
  const codecWhitelistIndex = args.indexOf('-codec_whitelist')
  const maxPixelsIndex = args.indexOf('-max_pixels')
  assert.ok(codecWhitelistIndex >= 0 && codecWhitelistIndex < inputIndex, '输入前必须限制允许解码的 codec')
  assert.strictEqual(args[codecWhitelistIndex + 1], 'hevc,h264,aac', '只允许目标手机视频所需的 HEVC/H.264/AAC codec')
  assert.ok(maxPixelsIndex >= 0 && maxPixelsIndex < inputIndex, '解码前必须限制单帧像素，不能只在解码后缩放')
  assert.strictEqual(Number(args[maxPixelsIndex + 1]), 4096 * 4096, '像素上限必须精确覆盖 4K 方盒且拒绝异常超大帧')
  assert.ok(args.includes('libx264'), '兼容预览视频轨必须转为 H.264')
  assert.ok(args.includes('yuv420p'), '兼容预览必须使用浏览器通用 yuv420p 像素格式')
  assert.ok(args.includes('aac'), '兼容预览音轨必须转为 AAC')
  assert.ok(args.includes('-max_alloc') && args.includes('-max_streams'), 'ffmpeg 必须限制单次分配和流数量')
  assert.ok(args.filter((item) => item === '-threads').length >= 2, '解码与编码线程都必须受限')
  assert.ok(args.includes('-filter_threads') && args.includes('-fpsmax'), '滤镜线程与输出帧率必须受限')
  assert.ok(args.includes('-vf') && args.some((item) => String(item).includes('1920')), '输出分辨率必须限制在 1920x1080 盒内')
  assert.ok(args.includes('-maxrate') && args.includes('-bufsize'), '输出码率必须受限')
  assert.ok(args.includes('-t') && args.includes('-fs'), '输出时长与字节数必须双重受限')
  assert.ok(args.some((item) => String(item).includes('empty_moov')), '流式 MP4 必须输出前置元数据')
  assert.strictEqual(args.some((item) => /https?:|Signature|OSSAccessKeyId/i.test(String(item))), false, 'ffmpeg 参数不得包含签名 URL 或凭据')

  assert.strictEqual(isManagedVideoObjectKey('house-videos/20260713/1234-review.mp4', 'house-videos'), true)
  ;[
    'other-videos/review.mp4',
    'house-videos/../private.mp4',
    'house-videos\\review.mp4',
    'house-videos/review.mp4?x=1',
    'house-videos/review.mp4#x',
    'house-videos/review.m3u8',
    'https://private.example.test/house-videos/review.mp4'
  ].forEach((key) => assert.strictEqual(
    isManagedVideoObjectKey(key, 'house-videos'),
    false,
    `必须拒绝非受控视频 Key：${key}`
  ))
  assert.strictEqual(
    isAllowedSignedReadUrl(
      'https://private.example.test/house-videos/review.mp4?Signature=HIDDEN',
      'house-videos/review.mp4',
      'private.example.test'
    ),
    true
  )
  ;[
    'http://private.example.test/house-videos/review.mp4',
    'https://other.example.test/house-videos/review.mp4',
    'https://user:pass@private.example.test/house-videos/review.mp4',
    'https://private.example.test:8443/house-videos/review.mp4',
    'https://private.example.test/house-videos/other.mp4'
  ].forEach((url) => assert.strictEqual(
    isAllowedSignedReadUrl(url, 'house-videos/review.mp4', 'private.example.test'),
    false,
    `必须拒绝越界源地址：${url}`
  ))

  const hardenedSpawnOptions = buildFfmpegSpawnOptions({
    platform: 'linux',
    currentUid: 0,
    inputFd: 7,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/root',
      ADMIN_TOKEN_SECRET: 'must-not-reach-child',
      ALI_OSS_ACCESS_KEY_SECRET: 'must-not-reach-child'
    }
  })
  assert.deepStrictEqual(hardenedSpawnOptions.env, {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C'
  }, 'ffmpeg 子进程只能继承最小无密钥环境')
  assert.strictEqual(hardenedSpawnOptions.shell, false, 'ffmpeg 禁止经过 shell')
  assert.strictEqual(hardenedSpawnOptions.cwd, '/', 'ffmpeg 不得继承应用工作目录')
  assert.strictEqual(hardenedSpawnOptions.uid, 65534, 'root Node 必须把 ffmpeg 降权到非 root uid')
  assert.strictEqual(hardenedSpawnOptions.gid, 65534, 'root Node 必须把 ffmpeg 降权到非 root gid')
  assert.deepStrictEqual(hardenedSpawnOptions.stdio, ['ignore', 'pipe', 'pipe', 7], 'ffmpeg stdin 必须关闭且只从继承的 fd 3 读取')

  const signerCalls = []
  const requests = requestFactory()
  const processes = processFactory({ prebufferOutput: 'compatible-', output: 'h264-mp4' })
  const streamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl(objectKey) {
      signerCalls.push(objectKey)
      return 'https://private.example.test/house-videos/review.mp4?Signature=SECRET_VALUE'
    },
    requestImpl: requests.requestImpl,
    spawnImpl: processes.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxConcurrent: 1,
    timeoutMs: 5000,
    maxInputBytes: 1024 * 1024,
    tempRoot: backendTempRoot
  })
  const request = new EventEmitter()
  request.aborted = false
  const response = new FakeResponse()
  await streamer.streamCompatiblePreview({ request, response, objectKey: 'house-videos/review.mp4' })

  assert.deepStrictEqual(signerCalls, ['house-videos/review.mp4'], '对象地址只能由服务端持久 videoKey 生成')
  assert.strictEqual(requests.calls.length, 1, '兼容预览只读取一次源对象')
  assert.strictEqual(requests.calls[0].requestOptions.method, 'GET', '源对象只允许只读 GET')
  assert.strictEqual(processes.calls.length, 1, '每次兼容预览只启动一个转码进程')
  assert.strictEqual(processes.calls[0].command, path.resolve(root, 'ffmpeg-test'), '必须使用受控的绝对 ffmpeg 路径')
  assert.strictEqual(processes.calls[0].spawnOptions.env.ADMIN_TOKEN_SECRET, undefined, 'ffmpeg 环境不得携带服务端密钥')
  assert.strictEqual(Buffer.concat(processes.calls[0].child.input).toString(), 'source-hevc-bytes', '源视频必须通过可寻址只读 fd 输入转码器')
  if (process.platform !== 'win32') {
    assert.strictEqual(processes.calls[0].child.inputMode, 0o600, '临时源文件在 POSIX 上必须严格为 0600')
  }
  assert.strictEqual(processes.calls[0].spawnOptions.stdio[0], 'ignore', 'ffmpeg stdin 必须关闭')
  const inheritedFd = processes.calls[0].spawnOptions.stdio[3]
  assert.throws(() => fs.fstatSync(inheritedFd), (error) => error && error.code === 'EBADF', 'spawn 返回后父进程必须立即关闭输入 fd')
  assert.strictEqual(processes.calls[0].args.some((item) => String(item).includes(backendTempRoot)), false, '临时路径不得进入 ffmpeg 参数')
  assert.strictEqual(Object.values(processes.calls[0].spawnOptions.env).some((item) => String(item).includes(backendTempRoot)), false, '临时路径不得进入 ffmpeg 环境')
  assert.strictEqual(response.statusCode, 200, '兼容预览成功应返回 200')
  assert.strictEqual(response.headers['Content-Type'], 'video/mp4', '兼容预览必须返回 video/mp4')
  assert.strictEqual(response.headers['Cache-Control'], 'private, no-store', '兼容预览不得被公共缓存')
  assert.strictEqual(response.headers['X-Content-Type-Options'], 'nosniff', '兼容预览必须禁止 MIME 猜测')
  assert.strictEqual(response.headers['X-Accel-Buffering'], 'no', '必须关闭 Nginx 响应缓冲，使页面离开能及时终止转码')
  assert.strictEqual(response.headers['Accept-Ranges'], 'none', '按需转码不支持 Range，必须明确禁止误判')
  assert.strictEqual(Buffer.concat(response.chunks).toString(), 'compatible-h264-mp4', '浏览器应收到完整转码数据，首块不得在响应管道接通前丢失')
  assert.strictEqual(streamer.activeCount(), 0, '成功结束后必须释放并发名额')
  assert.deepStrictEqual(fs.readdirSync(backendTempRoot), [], '成功结束后临时目录必须为空')

  // 必须先完整落盘并核对长度，再启动 ffmpeg，保证 moov 位于文件尾部的普通手机 MP4 可寻址读取。
  const lingeringSource = new PassThrough()
  const stagedSourceBody = 'source-still-open'
  lingeringSource.statusCode = 200
  lingeringSource.headers = {
    'content-type': 'video/mp4',
    'content-length': String(Buffer.byteLength(stagedSourceBody))
  }
  const lingeringRequest = new EventEmitter()
  lingeringRequest.destroyedByPreview = false
  lingeringRequest.setTimeout = () => lingeringRequest
  lingeringRequest.destroy = () => { lingeringRequest.destroyedByPreview = true }
  const stagedProcesses = processFactory({ output: 'staged-compatible-output' })
  const stagedStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/early-finish.mp4?Signature=HIDDEN',
    requestImpl(url, options, callback) {
      queueMicrotask(() => callback(lingeringSource))
      return lingeringRequest
    },
    spawnImpl: stagedProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 2048,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  const stagedResponse = new FakeResponse()
  const stagedPromise = stagedStreamer.streamCompatiblePreview({
    request: new EventEmitter(),
    response: stagedResponse,
    objectKey: 'house-videos/early-finish.mp4'
  })
  await waitTurn()
  await waitTurn()
  assert.strictEqual(stagedProcesses.calls.length, 0, '源对象尚未完整下载时不得提前启动 ffmpeg')
  lingeringSource.end(Buffer.from(stagedSourceBody))
  await stagedPromise
  assert.strictEqual(Buffer.concat(stagedProcesses.calls[0].child.input).toString(), stagedSourceBody, '完整落盘后的 fd 必须保留全部源字节')
  assert.strictEqual(Buffer.concat(stagedResponse.chunks).toString(), 'staged-compatible-output', '完整落盘后必须返回兼容输出')
  assert.strictEqual(lingeringRequest.destroyedByPreview, true, '完成转码后必须关闭上游请求资源')
  assert.strictEqual(stagedProcesses.calls[0].child.killedByPreview, false, '成功退出不得误标为转码失败')
  assert.strictEqual(stagedStreamer.activeCount(), 0, '完整落盘并转码结束后必须释放并发名额')
  assert.deepStrictEqual(fs.readdirSync(backendTempRoot), [], '完整落盘成功后不得残留临时文件')

  const downloadAbortSource = new PassThrough()
  downloadAbortSource.statusCode = 200
  downloadAbortSource.headers = { 'content-type': 'video/mp4', 'content-length': '1024' }
  const downloadAbortProcesses = processFactory()
  const downloadAbortStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/download-abort.mp4?Signature=HIDDEN',
    requestImpl(url, options, callback) {
      const upstream = new EventEmitter()
      upstream.setTimeout = () => upstream
      upstream.destroy = () => downloadAbortSource.destroy()
      queueMicrotask(() => callback(downloadAbortSource))
      return upstream
    },
    spawnImpl: downloadAbortProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 2048,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  const downloadAbortRequest = new EventEmitter()
  const downloadAbortPromise = downloadAbortStreamer.streamCompatiblePreview({
    request: downloadAbortRequest,
    response: new FakeResponse(),
    objectKey: 'house-videos/download-abort.mp4'
  })
  await waitTurn()
  await waitTurn()
  assert.strictEqual(downloadAbortProcesses.calls.length, 0, '下载尚未结束时不得启动 ffmpeg')
  const downloadTempEntries = fs.readdirSync(backendTempRoot)
  assert.strictEqual(downloadTempEntries.length, 1, '下载阶段只能创建一个隔离临时目录')
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(path.join(backendTempRoot, downloadTempEntries[0])).mode & 0o777, 0o700, '临时目录在 POSIX 上必须严格为 0700')
  }
  downloadAbortRequest.emit('aborted')
  await downloadAbortPromise
  assert.strictEqual(downloadAbortStreamer.activeCount(), 0, '下载阶段客户端断开后必须释放并发名额')
  assert.deepStrictEqual(fs.readdirSync(backendTempRoot), [], '下载阶段客户端断开后必须先清理临时文件再返回')

  let lateSourceCallback = null
  const lateSourceProcesses = processFactory()
  const lateSourceStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/late-source.mp4?Signature=HIDDEN',
    requestImpl(url, options, callback) {
      lateSourceCallback = callback
      const upstream = new EventEmitter()
      upstream.setTimeout = () => upstream
      upstream.destroy = () => {}
      return upstream
    },
    spawnImpl: lateSourceProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 2048,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  const lateSourceRequest = new EventEmitter()
  const lateSourcePromise = lateSourceStreamer.streamCompatiblePreview({
    request: lateSourceRequest,
    response: new FakeResponse(),
    objectKey: 'house-videos/late-source.mp4'
  })
  lateSourceRequest.emit('aborted')
  const lateSource = fakeUpstream(200, 'late-source-bytes')
  lateSourceCallback(lateSource)
  await lateSourcePromise
  assert.strictEqual(lateSource.destroyed, true, '客户端已断开后的迟到 OSS 响应必须立即销毁')
  assert.strictEqual(lateSourceProcesses.calls.length, 0, '收口中的迟到 OSS 响应不得重新启动下载或 ffmpeg')
  assert.deepStrictEqual(fs.readdirSync(backendTempRoot), [], '收口中的迟到 OSS 响应不得重建临时目录')

  const heldRequests = requestFactory()
  const heldProcesses = processFactory({ holdOpen: true })
  const heldStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/held.mp4?Signature=HIDDEN',
    requestImpl: heldRequests.requestImpl,
    spawnImpl: heldProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxConcurrent: 1,
    timeoutMs: 5000,
    maxInputBytes: 1024 * 1024,
    tempRoot: backendTempRoot
  })
  const heldRequest = new EventEmitter()
  heldRequest.aborted = false
  const heldResponse = new FakeResponse()
  const heldPromise = heldStreamer.streamCompatiblePreview({ request: heldRequest, response: heldResponse, objectKey: 'house-videos/held.mp4' })
  await waitUntil(() => heldProcesses.calls.length === 1, '等待持有中的 ffmpeg 启动超时')
  await assert.rejects(
    () => heldStreamer.streamCompatiblePreview({ request: new EventEmitter(), response: new FakeResponse(), objectKey: 'house-videos/second.mp4' }),
    (error) => error && error.statusCode === 429 && error.code === 'VIDEO_PREVIEW_BUSY',
    '并发转码必须 fail-closed，避免拖垮服务'
  )
  heldRequest.emit('aborted')
  await heldPromise
  assert.strictEqual(heldProcesses.calls[0].child.killedByPreview, true, '客户端断开必须终止 ffmpeg')
  assert.strictEqual(heldStreamer.activeCount(), 0, '客户端断开后必须释放并发名额')

  const unavailableRequests = requestFactory()
  const unavailableProcesses = processFactory({ spawnError: true })
  const unavailableStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/unavailable.mp4?Signature=HIDDEN',
    requestImpl: unavailableRequests.requestImpl,
    spawnImpl: unavailableProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxConcurrent: 1,
    timeoutMs: 5000,
    maxInputBytes: 1024 * 1024,
    tempRoot: backendTempRoot
  })
  await assert.rejects(
    () => unavailableStreamer.streamCompatiblePreview({ request: new EventEmitter(), response: new FakeResponse(), objectKey: 'house-videos/unavailable.mp4' }),
    (error) => {
      assert.strictEqual(error.statusCode, 503)
      assert.strictEqual(error.code, 'VIDEO_PREVIEW_TRANSCODER_UNAVAILABLE')
      assert.strictEqual(String(error.message).includes('spawn detail'), false, '子进程错误细节不得返回客户端')
      return true
    },
    'ffmpeg 不可用时必须返回脱敏 503'
  )
  assert.deepStrictEqual(fs.readdirSync(backendTempRoot), [], 'ffmpeg 异步启动失败后不得残留临时文件')

  const syncThrowRequests = requestFactory()
  let syncThrowFd = null
  let syncThrowInput = ''
  const syncThrowStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/sync-throw.mp4?Signature=HIDDEN',
    requestImpl: syncThrowRequests.requestImpl,
    spawnImpl(command, childArgs, spawnOptions) {
      syncThrowFd = spawnOptions.stdio[3]
      syncThrowInput = fs.readFileSync(syncThrowFd, 'utf8')
      assert.deepStrictEqual(fs.readdirSync(backendTempRoot), [], '调用 spawn 前临时文件路径必须已经删除')
      throw new Error('synchronous spawn detail must stay private')
    },
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 1024,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  await assert.rejects(
    () => syncThrowStreamer.streamCompatiblePreview({
      request: new EventEmitter(),
      response: new FakeResponse(),
      objectKey: 'house-videos/sync-throw.mp4'
    }),
    (error) => error && error.code === 'VIDEO_PREVIEW_TRANSCODER_UNAVAILABLE' && !String(error.message).includes('synchronous')
  )
  assert.strictEqual(syncThrowInput, 'source-hevc-bytes', '同步 spawn 失败前 fd 仍须可完整读取')
  assert.throws(() => fs.fstatSync(syncThrowFd), (error) => error && error.code === 'EBADF', '同步 spawn 抛错后父进程 fd 必须关闭')
  assert.strictEqual(syncThrowStreamer.activeCount(), 0, '同步 spawn 失败后必须释放并发名额')

  const invalidTempRoot = path.join(backendTempRoot, 'not-a-directory')
  fs.writeFileSync(invalidTempRoot, 'test-only')
  const storageFailureRequests = requestFactory()
  const storageFailureProcesses = processFactory()
  const storageFailureStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/storage-failure.mp4?Signature=HIDDEN',
    requestImpl: storageFailureRequests.requestImpl,
    spawnImpl: storageFailureProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 1024,
    timeoutMs: 5000,
    tempRoot: invalidTempRoot
  })
  await assert.rejects(
    () => storageFailureStreamer.streamCompatiblePreview({
      request: new EventEmitter(),
      response: new FakeResponse(),
      objectKey: 'house-videos/storage-failure.mp4'
    }),
    (error) => error && error.code === 'VIDEO_PREVIEW_STORAGE_UNAVAILABLE' && error.statusCode === 507
  )
  assert.strictEqual(storageFailureProcesses.calls.length, 0, '临时存储不可用时不得启动 ffmpeg')
  assert.strictEqual(storageFailureStreamer.activeCount(), 0, '临时存储失败后必须释放并发名额')
  fs.unlinkSync(invalidTempRoot)

  const deniedRequests = requestFactory({ statusCode: 403, body: '<Error><Signature>SECRET_VALUE</Signature></Error>' })
  const deniedProcesses = processFactory()
  const deniedStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/denied.mp4?Signature=SECRET_VALUE',
    requestImpl: deniedRequests.requestImpl,
    spawnImpl: deniedProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxConcurrent: 1,
    timeoutMs: 5000,
    maxInputBytes: 1024 * 1024,
    tempRoot: backendTempRoot
  })
  await assert.rejects(
    () => deniedStreamer.streamCompatiblePreview({ request: new EventEmitter(), response: new FakeResponse(), objectKey: 'house-videos/denied.mp4' }),
    (error) => {
      assert.strictEqual(error.statusCode, 502)
      assert.strictEqual(error.code, 'VIDEO_PREVIEW_SOURCE_UNAVAILABLE')
      assert.strictEqual(/SECRET_VALUE|Signature|denied\.mp4/.test(String(error.message)), false, '错误不得泄露签名或对象 Key')
      return true
    }
  )
  assert.strictEqual(deniedProcesses.calls.length, 0, '源对象读取失败时不得启动 ffmpeg')

  const lowReportedRequests = requestFactory({ body: '0123456789abcdef', contentLength: 4 })
  const lowReportedProcesses = processFactory({ holdOpen: true })
  const lowReportedStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/low-reported.mp4?Signature=HIDDEN',
    requestImpl: lowReportedRequests.requestImpl,
    spawnImpl: lowReportedProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 8,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  const lowReportedResponse = new FakeResponse()
  await assert.rejects(
    () => lowReportedStreamer.streamCompatiblePreview({
      request: new EventEmitter(),
      response: lowReportedResponse,
      objectKey: 'house-videos/low-reported.mp4'
    }),
    (error) => error && error.code === 'VIDEO_PREVIEW_TOO_LARGE'
  )
  assert.strictEqual(lowReportedProcesses.calls.length, 0, 'Content-Length 低报且累计字节越界时不得启动 ffmpeg')
  assert.strictEqual(lowReportedStreamer.activeCount(), 0, '输入越界后必须释放并发名额')

  const exactLowRequests = requestFactory({ body: '12345678', contentLength: 4 })
  const exactLowProcesses = processFactory()
  const exactLowStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/exact-low.mp4?Signature=HIDDEN',
    requestImpl: exactLowRequests.requestImpl,
    spawnImpl: exactLowProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 16,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  await assert.rejects(
    () => exactLowStreamer.streamCompatiblePreview({
      request: new EventEmitter(),
      response: new FakeResponse(),
      objectKey: 'house-videos/exact-low.mp4'
    }),
    (error) => error && error.code === 'VIDEO_PREVIEW_SOURCE_LENGTH_INVALID'
  )
  assert.strictEqual(exactLowProcesses.calls.length, 0, '实际字节未超总上限但大于 Content-Length 时仍不得启动 ffmpeg')

  const exactHighRequests = requestFactory({ body: '1234', contentLength: 8 })
  const exactHighProcesses = processFactory()
  const exactHighStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/exact-high.mp4?Signature=HIDDEN',
    requestImpl: exactHighRequests.requestImpl,
    spawnImpl: exactHighProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 16,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  await assert.rejects(
    () => exactHighStreamer.streamCompatiblePreview({
      request: new EventEmitter(),
      response: new FakeResponse(),
      objectKey: 'house-videos/exact-high.mp4'
    }),
    (error) => error && error.code === 'VIDEO_PREVIEW_SOURCE_LENGTH_INVALID'
  )
  assert.strictEqual(exactHighProcesses.calls.length, 0, '实际字节少于 Content-Length 时不得启动 ffmpeg')
  assert.deepStrictEqual(fs.readdirSync(backendTempRoot), [], '长度不一致失败后不得残留临时文件')

  const missingLengthRequests = requestFactory({ omitContentLength: true })
  const missingLengthProcesses = processFactory()
  const missingLengthStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/no-length.mp4?Signature=HIDDEN',
    requestImpl: missingLengthRequests.requestImpl,
    spawnImpl: missingLengthProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 1024,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  await assert.rejects(
    () => missingLengthStreamer.streamCompatiblePreview({
      request: new EventEmitter(),
      response: new FakeResponse(),
      objectKey: 'house-videos/no-length.mp4'
    }),
    (error) => error && error.code === 'VIDEO_PREVIEW_SOURCE_LENGTH_INVALID'
  )
  assert.strictEqual(missingLengthProcesses.calls.length, 0, '缺失 Content-Length 时不得启动 ffmpeg')

  const oversizedOutputRequests = requestFactory()
  const oversizedOutputProcesses = processFactory({ output: '0123456789abcdef' })
  const oversizedOutputStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/output-limit.mp4?Signature=HIDDEN',
    requestImpl: oversizedOutputRequests.requestImpl,
    spawnImpl: oversizedOutputProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 1024,
    maxOutputBytes: 8,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  await assert.rejects(
    () => oversizedOutputStreamer.streamCompatiblePreview({
      request: new EventEmitter(),
      response: new FakeResponse(),
      objectKey: 'house-videos/output-limit.mp4'
    }),
    (error) => error && error.code === 'VIDEO_PREVIEW_OUTPUT_TOO_LARGE'
  )
  assert.strictEqual(oversizedOutputProcesses.calls[0].child.killedByPreview, true, '输出越界必须杀死 ffmpeg')
  assert.strictEqual(oversizedOutputStreamer.activeCount(), 0, '输出越界后必须释放并发名额')

  const redirectRequests = requestFactory({ statusCode: 302, body: 'redirect' })
  const redirectProcesses = processFactory()
  const redirectStreamer = createAdminVideoPreviewStreamer({
    createSignedReadUrl: () => 'https://private.example.test/house-videos/redirect.mp4?Signature=HIDDEN',
    requestImpl: redirectRequests.requestImpl,
    spawnImpl: redirectProcesses.spawnImpl,
    ffmpegPath: path.resolve(root, 'ffmpeg-test'),
    allowedSourceHost: 'private.example.test',
    maxInputBytes: 1024,
    timeoutMs: 5000,
    tempRoot: backendTempRoot
  })
  await assert.rejects(
    () => redirectStreamer.streamCompatiblePreview({
      request: new EventEmitter(),
      response: new FakeResponse(),
      objectKey: 'house-videos/redirect.mp4'
    }),
    (error) => error && error.code === 'VIDEO_PREVIEW_SOURCE_UNAVAILABLE'
  )
  assert.strictEqual(redirectProcesses.calls.length, 0, '源对象重定向不得被跟随或交给 ffmpeg')
  assert.deepStrictEqual(fs.readdirSync(backendTempRoot), [], '全部后端成功与失败路径结束后临时根目录必须为空')
  fs.rmdirSync(backendTempRoot)

  // 真实 HTTP 路由：用预加载桩替代转码器，验证 Bearer 门禁、服务端 videoKey 取源与二进制响应。
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-admin-video-preview-'))
  const dbPath = path.join(tempDir, 'db.json')
  const preloadPath = path.join(tempDir, 'preview-preload.js')
  const port = await freePort()
  fs.writeFileSync(dbPath, JSON.stringify({
    users: [],
    adminAccounts: [{
      id: 'A-VIDEO',
      account: 'video-admin',
      passwordHash: hashPassword('video-admin-pass-123'),
      permission: '全部后台权限',
      status: '启用'
    }],
    listings: [
      {
        id: 'L-HEVC',
        ownerType: '业主房源',
        reviewStatus: '待审核',
        videoKey: 'house-videos/test-hevc.mp4',
        videoUrl: 'https://example.invalid/unsigned.mp4'
      },
      {
        id: 'L-URL-ONLY',
        ownerType: '业主房源',
        reviewStatus: '待审核',
        videoUrl: 'https://example.invalid/client-controlled.mp4'
      },
      {
        id: 'L-UNMANAGED-KEY',
        ownerType: '业主房源',
        reviewStatus: '待审核',
        videoKey: 'other-videos/private.mp4'
      }
    ]
  }))
  fs.writeFileSync(preloadPath, `
const Module = require('module')
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './admin-video-preview' && parent && /server[\\\\/]src[\\\\/]index\\.js$/.test(parent.filename)) {
    return {
      isManagedVideoObjectKey(objectKey) {
        return String(objectKey || '').startsWith('house-videos/')
      },
      streamCompatiblePreview({ response, objectKey }) {
        response.writeHead(200, { 'Content-Type': 'video/mp4' })
        response.end('FAKE-H264:' + objectKey)
        return Promise.resolve()
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
`)
  const serverProcess = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(root, 'server'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_FILE: dbPath,
      NODE_ENV: 'test',
      ADMIN_TOKEN_SECRET: 'fake-admin-video-secret-for-test-only',
      AUTH_TOKEN_SECRET: 'fake-mini-video-secret-for-test-only',
      NODE_OPTIONS: `--require=${preloadPath.replace(/\\/g, '/')}`
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  try {
    await waitForStartup(serverProcess)
    const unauthorized = await httpCall(port, '/admin/listings/L-HEVC/video-compatible-preview')
    assert.strictEqual(unauthorized.statusCode, 401, '未登录不得读取兼容预览')

    const login = await httpCall(port, '/admin/auth/login', {
      method: 'POST',
      body: { account: 'video-admin', password: 'video-admin-pass-123' }
    })
    assert.strictEqual(login.statusCode, 200, '合成管理员应能登录')
    const token = JSON.parse(login.body.toString()).data.token
    const authHeaders = { Authorization: `Bearer ${token}` }

    const compatible = await httpCall(port, '/admin/listings/L-HEVC/video-compatible-preview', { headers: authHeaders })
    assert.strictEqual(compatible.statusCode, 200)
    assert.strictEqual(compatible.headers['content-type'], 'video/mp4')
    assert.strictEqual(compatible.body.toString(), 'FAKE-H264:house-videos/test-hevc.mp4', '路由必须使用 DB videoKey')

    const urlOnly = await httpCall(port, '/admin/listings/L-URL-ONLY/video-compatible-preview', { headers: authHeaders })
    assert.strictEqual(urlOnly.statusCode, 404, '只有客户端 videoUrl、没有服务端 videoKey 时必须拒绝')
    assert.strictEqual(urlOnly.body.toString().includes('client-controlled.mp4'), false, '错误不得回显客户端 URL')

    const unmanagedKey = await httpCall(port, '/admin/listings/L-UNMANAGED-KEY/video-compatible-preview', { headers: authHeaders })
    assert.strictEqual(unmanagedKey.statusCode, 404, '非服务端上传目录的持久 Key 也必须拒绝')
    assert.strictEqual(unmanagedKey.body.toString().includes('other-videos'), false, '非法 Key 不得回显')
  } finally {
    serverProcess.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  const revokedObjectUrls = []
  let createdObjectUrlCount = 0
  const frontContext = {
    adminToken: 'fake-admin-token',
    canUseAdminApi: () => true,
    fetch: async (url, options) => {
      assert.strictEqual(url, '/admin/listings/L%20review/video-compatible-preview')
      assert.strictEqual(options.headers.Authorization, 'Bearer fake-admin-token')
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'video/mp4' },
        blob: async () => ({ size: 12, type: 'video/mp4' })
      }
    },
    URL: {
      createObjectURL: () => `blob:compatible-preview-${++createdObjectUrlCount}`,
      revokeObjectURL: (url) => revokedObjectUrls.push(url)
    },
    AbortController,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    console
  }
  const loadFunction = vm.runInNewContext(`(() => {
    ${extractFunction(adminSource, 'function reviewVideoAbortError(')}
    ${extractFunction(adminSource, 'function waitForReviewVideoPlayable(')}
    ${extractFunction(adminSource, 'function isReviewVideoResponse(')}
    ${extractFunction(adminSource, 'async function loadCompatibleReviewVideo(')}
    return loadCompatibleReviewVideo;
  })()`, frontContext)

  function createVideoHarness(listingId = 'L review') {
    const status = { textContent: '', hidden: false }
    const retryButton = { disabled: false, hidden: false }
    const listeners = new Map()
    const wrapper = {
      querySelector(selector) {
        if (selector === '[data-review-video-status]') return status
        if (selector === '.review-video-compat-button') return retryButton
        return null
      }
    }
    const video = {
      dataset: { listingId, compatibilityState: '' },
      src: '',
      loadCount: 0,
      closest: () => wrapper,
      load() { this.loadCount += 1 },
      addEventListener(type, handler, options = {}) {
        if (!listeners.has(type)) listeners.set(type, [])
        listeners.get(type).push({ handler, once: Boolean(options && options.once) })
      },
      removeEventListener(type, handler) {
        listeners.set(type, (listeners.get(type) || []).filter((item) => item.handler !== handler))
      }
    }
    return {
      video,
      status,
      retryButton,
      emit(type) {
        const current = [...(listeners.get(type) || [])]
        current.forEach((item) => {
          if (item.once) video.removeEventListener(type, item.handler)
          item.handler()
        })
      }
    }
  }

  const playableHarness = createVideoHarness()
  const playablePromise = loadFunction(playableHarness.video)
  await waitTurn()
  await waitTurn()
  assert.strictEqual(playableHarness.video.dataset.compatibilityState, 'loading', '未收到播放器事件前不得误报 ready')
  assert.strictEqual(playableHarness.retryButton.hidden, false, '未确认可播放前不得隐藏重试入口')
  playableHarness.emit('loadedmetadata')
  await playablePromise
  assert.strictEqual(playableHarness.video.src, 'blob:compatible-preview-1', '前端必须切换到受控 Blob URL')
  assert.strictEqual(playableHarness.video.dataset.compatibilityState, 'ready', '播放器确认可读后才能进入 ready 状态')
  assert.strictEqual(playableHarness.video.loadCount, 1, '切换兼容预览后必须重新加载播放器')
  assert.ok(playableHarness.status.textContent.includes('兼容预览已生成'), '前端必须给出持续可见的成功状态')
  assert.strictEqual(playableHarness.retryButton.hidden, true, '确认可播放后才能隐藏重试入口')
  playableHarness.emit('error')
  assert.strictEqual(playableHarness.video.dataset.compatibilityState, 'failed', '已就绪 Blob 后续解码失败也必须恢复失败态')
  assert.strictEqual(playableHarness.retryButton.hidden, false, '已就绪 Blob 后续解码失败必须恢复重试入口')
  assert.ok(revokedObjectUrls.includes('blob:compatible-preview-1'), '已就绪 Blob 后续解码失败必须回收对象 URL')

  frontContext.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    blob: async () => ({ size: 12, type: 'text/html' })
  })
  const wrongMimeHarness = createVideoHarness('L-WRONG-MIME')
  await assert.rejects(() => loadFunction(wrongMimeHarness.video), /MP4/)
  assert.strictEqual(wrongMimeHarness.video.dataset.compatibilityState, 'failed', '错误 MIME 必须进入可重试失败态')
  assert.strictEqual(wrongMimeHarness.retryButton.hidden, false, '错误 MIME 后必须保留重试入口')
  assert.strictEqual(createdObjectUrlCount, 1, '错误 MIME 不得创建 Blob URL')

  frontContext.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'video/mp4' },
    blob: async () => ({ size: 12, type: 'video/mp4' })
  })
  const decodeFailureHarness = createVideoHarness('L-DECODE-FAIL')
  const decodeFailurePromise = loadFunction(decodeFailureHarness.video)
  await waitTurn()
  await waitTurn()
  decodeFailureHarness.emit('error')
  await assert.rejects(() => decodeFailurePromise, /无法解码/)
  assert.strictEqual(decodeFailureHarness.video.dataset.compatibilityState, 'failed', 'Blob 解码失败必须回到失败态')
  assert.strictEqual(decodeFailureHarness.retryButton.hidden, false, 'Blob 解码失败必须恢复重试入口')
  assert.ok(revokedObjectUrls.includes('blob:compatible-preview-2'), 'Blob 解码失败必须回收对象 URL')

  let resolveStaleFetch
  frontContext.adminToken = 'token-before-switch'
  frontContext.fetch = () => new Promise((resolve) => { resolveStaleFetch = resolve })
  const staleHarness = createVideoHarness('L-STALE-SESSION')
  const stalePromise = loadFunction(staleHarness.video)
  await waitTurn()
  frontContext.adminToken = 'token-after-switch'
  resolveStaleFetch({
    ok: true,
    status: 200,
    headers: { get: () => 'video/mp4' },
    blob: async () => ({ size: 12, type: 'video/mp4' })
  })
  await stalePromise
  assert.strictEqual(staleHarness.video.dataset.compatibilityState, 'idle', '旧会话迟到响应不得写入新会话页面')
  assert.strictEqual(createdObjectUrlCount, 2, '旧会话迟到响应不得创建 Blob URL')

  let rejectOldRequest
  let resolveNewRequest
  let requestOrder = 0
  frontContext.adminToken = 'same-session-token'
  frontContext.AbortController = undefined
  frontContext.fetch = () => new Promise((resolve, reject) => {
    requestOrder += 1
    if (requestOrder === 1) rejectOldRequest = reject
    else resolveNewRequest = resolve
  })
  const generationHarness = createVideoHarness('L-GENERATION-RACE')
  const oldGeneration = loadFunction(generationHarness.video)
  await waitTurn()
  generationHarness.video.dataset.compatibilityRequestId = String(
    Number(generationHarness.video.dataset.compatibilityRequestId) + 1
  )
  generationHarness.video.dataset.compatibilityState = 'idle'
  const newGeneration = loadFunction(generationHarness.video)
  await waitTurn()
  rejectOldRequest(new Error('late old request failure'))
  await oldGeneration
  assert.strictEqual(generationHarness.video.dataset.compatibilityState, 'loading', '旧代次迟到失败不得覆盖新代次 loading 状态')
  assert.strictEqual(generationHarness.retryButton.disabled, true, '旧代次迟到失败不得提前启用新代次按钮')
  resolveNewRequest({
    ok: true,
    status: 200,
    headers: { get: () => 'video/mp4' },
    blob: async () => ({ size: 12, type: 'video/mp4' })
  })
  await waitTurn()
  await waitTurn()
  generationHarness.emit('canplay')
  await newGeneration
  assert.strictEqual(generationHarness.video.dataset.compatibilityState, 'ready', '新代次应独立完成兼容预览')
  frontContext.AbortController = AbortController

  const safeUrlFunction = vm.runInNewContext(
    `(${extractFunction(adminSource, 'function safeReviewVideoUrl(')})`,
    {}
  )
  assert.strictEqual(safeUrlFunction('https://signed.example.test/video.mp4'), 'https://signed.example.test/video.mp4')
  assert.strictEqual(safeUrlFunction('javascript:alert(1)'), '', '原视频链接必须拒绝脚本协议')
  assert.strictEqual(safeUrlFunction('file:///etc/passwd'), '', '原视频链接必须拒绝本地文件协议')

  const releaseRevocations = []
  const releaseFunction = vm.runInNewContext(
    `(${extractFunction(adminSource, 'function releaseReviewVideoObjectUrls(')})`,
    {
      URL: { revokeObjectURL: (url) => releaseRevocations.push(url) }
    }
  )
  const originalVideo = {
    dataset: { compatibilityState: '' },
    src: 'https://signed.example.test/original.mp4',
    pauseCount: 0,
    pause() { this.pauseCount += 1 }
  }
  const releasedStatus = { hidden: false, textContent: '兼容预览已生成，可以播放审核。' }
  const releasedRetry = { hidden: true, disabled: true }
  const releasedVideo = {
    dataset: {
      compatibilityState: 'ready',
      compatibilityObjectUrl: 'blob:released-preview',
      compatibilityRequestId: '7'
    },
    src: 'blob:released-preview',
    pauseCount: 0,
    removeCount: 0,
    loadCount: 0,
    pause() { this.pauseCount += 1 },
    removeAttribute(name) { if (name === 'src') { this.removeCount += 1; this.src = '' } },
    load() { this.loadCount += 1 },
    closest() {
      return {
        querySelector(selector) {
          if (selector === '[data-review-video-status]') return releasedStatus
          if (selector === '.review-video-compat-button') return releasedRetry
          return null
        }
      }
    }
  }
  releaseFunction({ querySelectorAll: () => [originalVideo, releasedVideo] })
  assert.strictEqual(originalVideo.pauseCount, 1, '切换栏目时原始签名视频也必须暂停，不能在隐藏 DOM 继续播放声音')
  assert.strictEqual(originalVideo.src, 'https://signed.example.test/original.mp4', '暂停原视频不应破坏可再次手动播放的签名地址')
  assert.strictEqual(releasedVideo.pauseCount, 1, '释放兼容预览前必须先暂停播放器')
  assert.strictEqual(releasedVideo.removeCount, 1, '释放 Blob 后必须移除已失效 src')
  assert.ok(releaseRevocations.includes('blob:released-preview'), '释放兼容预览必须回收 Blob URL')
  assert.strictEqual(releasedVideo.dataset.compatibilityState, 'idle', '释放后必须回到可重试 idle 状态')
  assert.strictEqual(releasedRetry.hidden, false, 'BFCache 返回时必须恢复兼容播放入口')
  assert.strictEqual(releasedRetry.disabled, false, 'BFCache 返回时兼容播放入口必须可点击')
  assert.ok(releasedStatus.textContent.includes('已释放'), 'BFCache 返回时不得残留“已生成”的失真状态')
  assert.notStrictEqual(releasedVideo.dataset.compatibilityRequestId, '7', '释放操作必须作废无 AbortController 环境下的迟到响应')

  const activateFunction = vm.runInNewContext(
    `(${extractFunction(adminSource, 'function activateReviewVideos(')})`,
    {
      loadCompatibleReviewVideo: async () => {},
      console
    }
  )
  let listenerBound = false
  let assignedSource = ''
  const activationVideo = {
    dataset: { reviewVideoSource: 'https://signed.example.test/video.mp4' },
    addEventListener(type) { if (type === 'error') listenerBound = true },
    set src(value) {
      assert.strictEqual(listenerBound, true, '必须先绑定 error 监听再设置原始视频 src')
      assignedSource = value
    },
    load() {}
  }
  activateFunction({ querySelectorAll: () => [activationVideo] })
  assert.strictEqual(assignedSource, 'https://signed.example.test/video.mp4')

  console.log('admin-review-video-v1-test passed')
}

main().catch((error) => {
  console.error(`admin-review-video-v1-test failed: ${error.stack || error.message}`)
  process.exit(1)
})
