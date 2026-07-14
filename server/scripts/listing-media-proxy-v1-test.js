'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { EventEmitter } = require('events')
const {
  createPublicListingMediaService,
  resolveManagedVideoObjectKey,
  isSecureSameOrigin
} = require('../src/public-listing-media')

const SECRET_OBJECT_KEY = 'house-videos/legacy/杭州某小区9栋8单元701室-19900008888.mp4'
const VIDEO_BODY = Buffer.from('synthetic-public-video-body')
const COVER_BODY = Buffer.from('synthetic-cover')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

function rangeSlice(body, header) {
  const matched = String(header || '').match(/^bytes=(\d+)-(\d*)$/)
  if (!matched) return null
  const start = Number(matched[1])
  const end = matched[2] ? Number(matched[2]) : body.length - 1
  if (start > end || start >= body.length) return null
  return { start, end: Math.min(end, body.length - 1) }
}

function fakeClientRequest(method = 'GET', headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  return req
}

function fakeClientResponse() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = () => { res.headersSent = true }
  res.write = () => true
  res.end = () => { res.writableEnded = true }
  res.destroy = () => {
    if (res.destroyed) return
    res.destroyed = true
    // Node 的真实 ServerResponse.destroy() 不会在当前调用栈同步触发 close。
    // 若实现先 settle 并移除 close 监听，再等待 close 清理上游，就会留下后台连接。
    setImmediate(() => res.emit('close'))
  }
  return res
}

const PENDING = Symbol('pending')

function nextTurnOutcome(promise) {
  return Promise.race([
    promise,
    new Promise((resolve) => setImmediate(() => resolve(PENDING)))
  ])
}

function directMediaService(options = {}) {
  return createPublicListingMediaService({
    secret: 'synthetic-concurrency-secret',
    baseUrl: 'https://api.example.test/',
    uploadDir: 'house-videos',
    maxBytes: 1024,
    timeoutMs: 2000,
    allowHttpUpstreamForTests: true,
    allowedOrigins: ['http://127.0.0.1:18080'],
    signVideoUrl: () => 'http://127.0.0.1:18080/video',
    signCoverUrl: () => 'http://127.0.0.1:18080/cover',
    ...options
  })
}

function startDirectServe(service, listing, capabilityUrl, options = {}) {
  const parsed = new URL(capabilityUrl)
  const kind = options.kind || (parsed.pathname.endsWith('/cover') ? 'cover' : 'video')
  const req = fakeClientRequest(options.method || 'GET', options.headers || {})
  const res = fakeClientResponse()
  const promise = service.serve(req, res, {
    listing,
    listingId: listing.id,
    kind,
    token: parsed.searchParams.get('token') || '',
    clientKey: options.clientKey || ''
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  )
  return { req, res, promise }
}

async function cleanupDirectAttempts(attempts) {
  attempts.forEach((attempt) => attempt.req.emit('aborted'))
  await Promise.all(attempts.map((attempt) => attempt.promise))
}

async function assertPerClientConcurrencyFairness(listing) {
  const pendingUpstreams = []
  const service = directMediaService({
    maxConcurrent: 3,
    maxConcurrentPerClient: 2,
    requestImpl: (url, requestOptions, callback) => {
      const upstreamReq = new EventEmitter()
      upstreamReq.destroyed = false
      upstreamReq.destroy = () => { upstreamReq.destroyed = true }
      upstreamReq.setTimeout = () => upstreamReq
      upstreamReq.end = () => pendingUpstreams.push({ upstreamReq, url, requestOptions, callback })
      return upstreamReq
    }
  })
  const urls = service.urlsForListing(listing)
  const attempts = []
  try {
    const first = startDirectServe(service, listing, urls.videoUrl, { clientKey: 'client-a', method: 'GET' })
    const second = startDirectServe(service, listing, urls.coverUrl, { clientKey: 'client-a', method: 'HEAD', kind: 'cover' })
    attempts.push(first, second)
    assert.strictEqual(await nextTurnOutcome(first.promise), PENDING, '首个 GET 应占用媒体槽位')
    assert.strictEqual(await nextTurnOutcome(second.promise), PENDING, '同 IP 的 HEAD/封面也必须占用同一并发桶')

    const sameClientOverflow = startDirectServe(service, listing, urls.videoUrl, {
      clientKey: 'client-a',
      method: 'GET',
      headers: { range: 'bytes=0-1' }
    })
    attempts.push(sameClientOverflow)
    const sameClientOutcome = await nextTurnOutcome(sameClientOverflow.promise)
    assert.notStrictEqual(sameClientOutcome, PENDING, '同 IP 超过子上限必须立即拒绝，不能继续占全局槽')
    assert.strictEqual(sameClientOutcome.error && sameClientOutcome.error.statusCode, 429, '同 IP 并发超限必须返回 429')

    const otherClient = startDirectServe(service, listing, urls.coverUrl, { clientKey: 'client-b', kind: 'cover' })
    attempts.push(otherClient)
    assert.strictEqual(await nextTurnOutcome(otherClient.promise), PENDING, 'A 达到子上限后，B 仍须能使用剩余全局槽')

    const globalOverflow = startDirectServe(service, listing, urls.videoUrl, { clientKey: 'client-c' })
    attempts.push(globalOverflow)
    const globalOutcome = await nextTurnOutcome(globalOverflow.promise)
    assert.strictEqual(globalOutcome.error && globalOutcome.error.statusCode, 503, '全局并发满时必须返回 503')

    first.req.emit('aborted')
    const firstOutcome = await first.promise
    assert.strictEqual(firstOutcome.error && firstOutcome.error.statusCode, 499, '客户端断开必须释放全局与单 IP 槽')
    const afterRelease = startDirectServe(service, listing, urls.videoUrl, { clientKey: 'client-c' })
    attempts.push(afterRelease)
    assert.strictEqual(await nextTurnOutcome(afterRelease.promise), PENDING, '任一连接释放后其他 IP 必须立即可进入')
  } finally {
    await cleanupDirectAttempts(attempts)
  }
  assert.deepStrictEqual(service.concurrencyState(), { activeRequests: 0, activeClients: 0 }, '连接全部结束后不得残留客户端并发桶')
}

async function assertSynchronousFailureReleasesSlot(listing, stage) {
  let callCount = 0
  const service = directMediaService({
    maxConcurrent: 1,
    maxConcurrentPerClient: 1,
    requestImpl: () => {
      callCount += 1
      const call = callCount
      if (stage === 'requestImpl' && call === 1) throw new Error('synthetic requestImpl failure')
      const upstreamReq = new EventEmitter()
      upstreamReq.destroy = () => {}
      upstreamReq.setTimeout = () => {
        if (stage === 'setTimeout' && call === 1) throw new Error('synthetic setTimeout failure')
        return upstreamReq
      }
      upstreamReq.end = () => {
        if (stage === 'end' && call === 1) throw new Error('synthetic end failure')
      }
      return upstreamReq
    }
  })
  const url = service.urlsForListing(listing).videoUrl
  const first = startDirectServe(service, listing, url, { clientKey: `failure-${stage}` })
  const firstOutcome = await first.promise
  assert.ok(firstOutcome.error, `${stage} 同步异常必须返回失败`)
  const second = startDirectServe(service, listing, url, { clientKey: `failure-${stage}` })
  try {
    assert.strictEqual(await nextTurnOutcome(second.promise), PENDING, `${stage} 同步异常后必须释放槽位`)
  } finally {
    await cleanupDirectAttempts([first, second])
  }
  assert.deepStrictEqual(service.concurrencyState(), { activeRequests: 0, activeClients: 0 }, `${stage} 后不得残留并发计数`)
}

async function assertInvalidUpstreamDestroyed(listing) {
  let invalidResponse = null
  const service = directMediaService({
    maxConcurrent: 1,
    maxConcurrentPerClient: 1,
    requestImpl: (url, requestOptions, callback) => {
      const upstreamReq = new EventEmitter()
      upstreamReq.destroy = () => {}
      upstreamReq.setTimeout = () => upstreamReq
      upstreamReq.end = () => {
        invalidResponse = new EventEmitter()
        invalidResponse.statusCode = 302
        invalidResponse.headers = { location: 'http://127.0.0.1:18080/redirect' }
        invalidResponse.destroyed = false
        invalidResponse.resume = () => {}
        invalidResponse.destroy = () => { invalidResponse.destroyed = true }
        callback(invalidResponse)
      }
      return upstreamReq
    }
  })
  const url = service.urlsForListing(listing).videoUrl
  const attempt = startDirectServe(service, listing, url, { clientKey: 'invalid-upstream' })
  const outcome = await attempt.promise
  assert.strictEqual(outcome.error && outcome.error.statusCode, 502, '非法上游响应必须失败')
  assert.strictEqual(invalidResponse && invalidResponse.destroyed, true, '非法上游响应必须主动销毁，不能释放计数后继续后台吞流量')
  assert.deepStrictEqual(service.concurrencyState(), { activeRequests: 0, activeClients: 0 }, '非法上游响应后不得残留并发计数')
}

function syntheticValidUpstreamResponse(contentLength = 4) {
  const response = new EventEmitter()
  response.statusCode = 200
  response.headers = { 'content-type': 'video/mp4', 'content-length': String(contentLength) }
  response.destroyed = false
  response.paused = false
  response.destroy = () => { response.destroyed = true }
  response.resume = () => { response.paused = false }
  response.pause = () => { response.paused = true }
  return response
}

async function assertAsynchronousReleasePath(listing, stage) {
  const controls = []
  const service = directMediaService({
    maxConcurrent: 1,
    maxConcurrentPerClient: 1,
    requestImpl: (url, requestOptions, callback) => {
      const upstreamReq = new EventEmitter()
      const control = { upstreamReq, callback, timeout: null, upstreamRes: null }
      upstreamReq.destroyed = false
      upstreamReq.destroy = () => { upstreamReq.destroyed = true }
      upstreamReq.setTimeout = (milliseconds, handler) => {
        control.timeout = handler
        return upstreamReq
      }
      upstreamReq.end = () => {
        if (stage === 'upstream-aborted' || stage === 'upstream-error') {
          control.upstreamRes = syntheticValidUpstreamResponse()
          callback(control.upstreamRes)
        }
      }
      controls.push(control)
      return upstreamReq
    }
  })
  const url = service.urlsForListing(listing).videoUrl
  const first = startDirectServe(service, listing, url, { clientKey: `async-${stage}` })
  assert.strictEqual(await nextTurnOutcome(first.promise), PENDING, `${stage} 触发前应占用唯一媒体槽位`)
  const control = controls[0]
  if (stage === 'timeout') control.timeout()
  else if (stage === 'request-error') control.upstreamReq.emit('error', new Error('synthetic async request error'))
  else if (stage === 'response-close') first.res.emit('close')
  else if (stage === 'upstream-aborted') control.upstreamRes.emit('aborted')
  else if (stage === 'upstream-error') control.upstreamRes.emit('error', new Error('synthetic async response error'))
  const outcome = await first.promise
  assert.ok(outcome.error, `${stage} 必须以失败结束`)
  if (stage === 'timeout') assert.strictEqual(outcome.error.statusCode, 504, '真实 timeout 回调必须返回 504')
  if (stage === 'request-error') assert.strictEqual(outcome.error.statusCode, 502, '上游请求异步 error 必须返回 502')
  if (stage === 'response-close') assert.strictEqual(outcome.error.statusCode, 499, '客户端响应关闭必须返回 499')
  assert.strictEqual(control.upstreamReq.destroyed, true, `${stage} 必须销毁上游请求`)
  if (control.upstreamRes) assert.strictEqual(control.upstreamRes.destroyed, true, `${stage} 必须销毁上游响应`)

  const afterRelease = startDirectServe(service, listing, url, { clientKey: `async-${stage}` })
  try {
    assert.strictEqual(await nextTurnOutcome(afterRelease.promise), PENDING, `${stage} 后下一请求必须立即获得已释放槽位`)
  } finally {
    afterRelease.req.emit('aborted')
    await afterRelease.promise
  }
  assert.deepStrictEqual(service.concurrencyState(), { activeRequests: 0, activeClients: 0 }, `${stage} 后不得残留并发计数`)
}

async function assertSuccessfulCompletionReleasesSlot(listing, method) {
  const service = directMediaService({
    maxConcurrent: 1,
    maxConcurrentPerClient: 1,
    requestImpl: (url, requestOptions, callback) => {
      const upstreamReq = new EventEmitter()
      upstreamReq.destroy = () => {}
      upstreamReq.setTimeout = () => upstreamReq
      upstreamReq.end = () => {
        const upstreamRes = syntheticValidUpstreamResponse(4)
        callback(upstreamRes)
        if (method === 'GET') {
          upstreamRes.emit('data', Buffer.from('test'))
          upstreamRes.emit('end')
        }
      }
      return upstreamReq
    }
  })
  const attempt = startDirectServe(service, listing, service.urlsForListing(listing).videoUrl, {
    clientKey: `success-${method}`,
    method
  })
  const outcome = await attempt.promise
  assert.strictEqual(outcome.ok, true, `正常 ${method} 必须成功完成`)
  assert.deepStrictEqual(service.concurrencyState(), { activeRequests: 0, activeClients: 0 }, `正常 ${method} 完成后不得残留并发计数`)
}

async function run() {
  assert.strictEqual(
    isSecureSameOrigin('https://api.example.test/mini', 'https://api.example.test/download'),
    true,
    '微信 request/downloadFile 域名必须允许合法 HTTPS 同源配置'
  )
  ;[
    ['http://api.example.test', 'http://api.example.test'],
    ['https://api.example.test', 'http://api.example.test'],
    ['https://api.example.test', 'https://download.example.test'],
    ['https://user@api.example.test', 'https://api.example.test'],
    ['not-a-url', 'not-a-url']
  ].forEach(([requestDomain, downloadDomain]) => {
    assert.strictEqual(
      isSecureSameOrigin(requestDomain, downloadDomain),
      false,
      `微信媒体域名门禁必须拒绝不安全或不同源配置：${requestDomain} / ${downloadDomain}`
    )
  })

  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: `http://127.0.0.1:${upstream.address().port}/${encodeURIComponent(SECRET_OBJECT_KEY)}` })
      res.end()
      return
    }
    const kind = url.searchParams.get('kind')
    const body = kind === 'cover' ? COVER_BODY : VIDEO_BODY
    const range = rangeSlice(body, req.headers.range)
    if (req.headers.range && !range) {
      res.writeHead(416, { 'Content-Range': `bytes */${body.length}` })
      res.end()
      return
    }
    const selected = range ? body.subarray(range.start, range.end + 1) : body
    const headers = {
      'Content-Type': kind === 'cover' ? 'image/jpeg' : (kind === 'octet' ? 'application/octet-stream' : 'video/mp4'),
      'Content-Length': String(selected.length),
      'Accept-Ranges': 'bytes',
      'Set-Cookie': 'must-not-leak=1',
      'X-Upstream-Object-Key': 'house-videos/legacy/9-8-701-19900008888.mp4'
    }
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${body.length}`
    res.writeHead(range ? 206 : 200, headers)
    if (req.method !== 'HEAD') res.end(selected)
    else res.end()
  })
  const upstreamPort = await listen(upstream)
  let now = Date.UTC(2026, 6, 14, 2, 0, 0)
  const service = createPublicListingMediaService({
    secret: 'synthetic-public-media-secret',
    baseUrl: 'https://api.example.test/',
    uploadDir: 'house-videos',
    maxBytes: 1024,
    timeoutMs: 2000,
    now: () => now,
    allowHttpUpstreamForTests: true,
    allowedOrigins: [`http://127.0.0.1:${upstreamPort}`],
    signVideoUrl: (objectKey) => `http://127.0.0.1:${upstreamPort}/object?kind=${String(objectKey).endsWith('.mov') ? 'octet' : 'video'}`,
    signCoverUrl: () => `http://127.0.0.1:${upstreamPort}/object?kind=cover`
  })
  const listing = {
    id: 'L-MEDIA-1',
    videoKey: SECRET_OBJECT_KEY,
    lifecycleStatus: 'active',
    status: '在租'
  }
  const urls = service.urlsForListing(listing)
  const ownerCapabilityOptions = {
    scope: 'owner',
    audience: 'SYNTHETIC-OWNER-001',
    stateKey: 'pending-review\n2026-07-14T02:00:00.000Z'
  }
  const ownerUrls = service.urlsForListing(listing, ownerCapabilityOptions)
  const ownerVideoCapability = new URL(ownerUrls.videoUrl)
  assert.strictEqual(ownerVideoCapability.searchParams.get('scope'), 'owner', '本人待审媒体能力必须显式绑定 owner scope')
  assert.ok(!JSON.stringify(ownerUrls).includes(ownerCapabilityOptions.audience), 'owner 媒体 URL 不得明文泄露账号标识')
  assert.ok(!JSON.stringify(ownerUrls).includes(ownerCapabilityOptions.stateKey), 'owner 媒体 URL 不得明文泄露房源状态键')
  const serializedUrls = JSON.stringify(urls)
  assert.ok(/^https:\/\/api\.example\.test\/mini\/listings\/L-MEDIA-1\/media\/video\?token=/.test(urls.videoUrl), '视频必须使用 API 域不透明能力 URL')
  assert.ok(/^https:\/\/api\.example\.test\/mini\/listings\/L-MEDIA-1\/media\/cover\?token=/.test(urls.coverUrl), '封面必须使用 API 域不透明能力 URL')
  assert.ok(!serializedUrls.includes('house-videos'), '能力 URL 不得包含对象目录')
  assert.ok(!serializedUrls.includes('701'), '能力 URL 不得包含历史房号文件名')
  assert.ok(!serializedUrls.includes('19900008888'), '能力 URL 不得包含历史手机号文件名')
  assert.ok(!/OSSAccessKeyId|Signature/.test(serializedUrls), '客户端不得直接拿 OSS 签名参数')

  await assertPerClientConcurrencyFairness(listing)
  for (const stage of ['requestImpl', 'setTimeout', 'end']) {
    await assertSynchronousFailureReleasesSlot(listing, stage)
  }
  await assertInvalidUpstreamDestroyed(listing)
  for (const stage of ['timeout', 'request-error', 'response-close', 'upstream-aborted', 'upstream-error']) {
    await assertAsynchronousReleasePath(listing, stage)
  }
  await assertSuccessfulCompletionReleasesSlot(listing, 'GET')
  await assertSuccessfulCompletionReleasesSlot(listing, 'HEAD')

  const videoCapability = new URL(urls.videoUrl)
  const coverCapability = new URL(urls.coverUrl)
  const capabilityExpiresAt = Number(String(videoCapability.searchParams.get('token') || '').split('.')[0])
  assert.ok(
    capabilityExpiresAt - Math.floor(now / 1000) >= 6 * 60 * 60,
    '公开视频能力地址默认至少覆盖六小时播放窗口，并由播放器失败时再刷新'
  )
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
  assert.ok(
    !indexSource.includes('ttlSeconds: config.oss.readUrlExpireSeconds'),
    '公开能力地址有效期不得继续误绑上游 OSS 单次签名的 900 秒配置'
  )
  assert.ok(indexSource.includes('isSecureSameOrigin(miniProgram.requestDomain, miniProgram.downloadDomain)'), '发布门禁必须使用 HTTPS 同源校验')
  assert.ok(!indexSource.includes('function sameConfiguredOrigin('), '不得保留仅比较 origin、会放行 HTTP 的旧门禁')
  assert.ok(indexSource.includes('if (res.headersSent || res.destroyed)'), '流式响应发头后异常不得二次 writeHead')
  assert.ok(indexSource.includes('clientKey: requestClientKey(req)'), '媒体并发客户端键必须由服务端可信网络键注入')
  let currentOwnerAudience = ownerCapabilityOptions.audience
  let currentOwnerStateKey = ownerCapabilityOptions.stateKey
  const mediaServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const matched = url.pathname.match(/^\/mini\/listings\/([^/]+)\/media\/(video|cover)$/)
    try {
      if (!matched) throw Object.assign(new Error('not found'), { statusCode: 404 })
      await service.serve(req, res, {
        listing,
        listingId: decodeURIComponent(matched[1]),
        kind: matched[2],
        token: url.searchParams.get('token') || '',
        scope: url.searchParams.get('scope') === 'owner' ? 'owner' : 'public',
        audience: url.searchParams.get('scope') === 'owner' ? currentOwnerAudience : '',
        stateKey: url.searchParams.get('scope') === 'owner' ? currentOwnerStateKey : ''
      })
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(error.statusCode || 502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(error.message)
    }
  })
  const mediaPort = await listen(mediaServer)

  try {
    const videoPath = `${videoCapability.pathname}${videoCapability.search}`
    const full = await request(mediaPort, videoPath)
    assert.strictEqual(full.statusCode, 200, '匿名 GET 必须流式返回公开视频')
    assert.deepStrictEqual(full.body, VIDEO_BODY, '代理必须原样流式返回视频字节')
    assert.strictEqual(full.headers['content-type'], 'video/mp4')
    assert.strictEqual(full.headers['accept-ranges'], 'bytes', '视频代理必须支持拖动播放所需的 Range')
    assert.ok(!full.headers.location, '代理不得用重定向暴露上游对象 URL')
    assert.ok(!full.headers['set-cookie'], '代理不得透传上游 Cookie')
    assert.ok(!full.headers['x-upstream-object-key'], '代理不得透传上游对象键响应头')
    assert.ok(!JSON.stringify(full.headers).includes(SECRET_OBJECT_KEY), '代理响应头不得包含对象键')

    const head = await request(mediaPort, videoPath, { method: 'HEAD' })
    assert.strictEqual(head.statusCode, 200, '匿名 HEAD 必须返回媒体元数据')
    assert.strictEqual(head.body.length, 0, 'HEAD 不得返回视频体')
    assert.strictEqual(Number(head.headers['content-length']), VIDEO_BODY.length)

    const partial = await request(mediaPort, videoPath, { headers: { Range: 'bytes=2-7' } })
    assert.strictEqual(partial.statusCode, 206, '单段 Range 必须返回 206')
    assert.strictEqual(partial.headers['content-range'], `bytes 2-7/${VIDEO_BODY.length}`)
    assert.deepStrictEqual(partial.body, VIDEO_BODY.subarray(2, 8))

    const multiRange = await request(mediaPort, videoPath, { headers: { Range: 'bytes=0-1,3-4' } })
    assert.strictEqual(multiRange.statusCode, 416, '多段或畸形 Range 必须在访问上游前拒绝')

    const coverPath = `${coverCapability.pathname}${coverCapability.search}`
    const cover = await request(mediaPort, coverPath)
    assert.strictEqual(cover.statusCode, 200, '匿名封面能力 URL 必须可读取')
    assert.strictEqual(cover.headers['content-type'], 'image/jpeg')
    assert.deepStrictEqual(cover.body, COVER_BODY)

    const ownerVideoPath = `${ownerVideoCapability.pathname}${ownerVideoCapability.search}`
    const ownerBearerRead = await request(mediaPort, ownerVideoPath)
    assert.strictEqual(ownerBearerRead.statusCode, 200, '微信 video/image 无法附 Authorization，已签 owner bearer URL 必须可匿名读取')
    assert.deepStrictEqual(ownerBearerRead.body, VIDEO_BODY)
    const ownerWithoutScope = await request(mediaPort, ownerVideoPath.replace('&scope=owner', ''))
    assert.strictEqual(ownerWithoutScope.statusCode, 404, 'owner token 不得降级为公共 token 重放')
    currentOwnerAudience = 'SYNTHETIC-OTHER-002'
    const wrongOwner = await request(mediaPort, ownerVideoPath)
    assert.strictEqual(wrongOwner.statusCode, 404, 'owner token 必须绑定签发账号，不能跨账号验证')
    currentOwnerAudience = ownerCapabilityOptions.audience
    currentOwnerStateKey = 'approved\n2026-07-14T02:01:00.000Z'
    const staleOwnerState = await request(mediaPort, ownerVideoPath)
    assert.strictEqual(staleOwnerState.statusCode, 404, '房源审核或维护状态变化后旧 owner token 必须立即失效')
    currentOwnerStateKey = ownerCapabilityOptions.stateKey

    const movListing = { ...listing, id: 'L-MEDIA-MOV', videoKey: 'house-videos/legacy/random-object.mov' }
    const movCapability = new URL(service.urlsForListing(movListing).videoUrl)
    const movServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      try {
        await service.serve(req, res, {
          listing: movListing,
          listingId: movListing.id,
          kind: 'video',
          token: url.searchParams.get('token') || ''
        })
      } catch (error) {
        if (!res.headersSent) res.writeHead(error.statusCode || 502)
        res.end()
      }
    })
    const movPort = await listen(movServer)
    try {
      const mov = await request(movPort, `${movCapability.pathname}${movCapability.search}`)
      assert.strictEqual(mov.statusCode, 200, 'octet-stream 存量 MOV 必须仍可匿名读取')
      assert.strictEqual(mov.headers['content-type'], 'video/quicktime', 'MOV 必须按白名单扩展名归一 MIME')
      assert.strictEqual(mov.headers['content-disposition'], 'inline; filename="listing-video.mov"', '下载文件扩展名必须与真实白名单对象类型一致')
    } finally {
      await close(movServer)
    }

    const tampered = await request(mediaPort, videoPath.replace('L-MEDIA-1', 'L-MEDIA-2'))
    assert.strictEqual(tampered.statusCode, 404, '能力令牌不得跨房源重放')
    const wrongKind = await request(mediaPort, videoPath.replace('/video?', '/cover?'))
    assert.strictEqual(wrongKind.statusCode, 404, '能力令牌不得跨媒体类型重放')
    now += 7 * 60 * 60 * 1000
    const expired = await request(mediaPort, videoPath)
    assert.strictEqual(expired.statusCode, 404, '过期能力令牌必须拒绝')
  } finally {
    await close(mediaServer)
    await close(upstream)
  }

  const allowedOrigin = `https://bucket.oss-cn-example.aliyuncs.com`
  assert.strictEqual(resolveManagedVideoObjectKey({ videoKey: SECRET_OBJECT_KEY }, {
    uploadDir: 'house-videos',
    allowedOrigins: [allowedOrigin]
  }), SECRET_OBJECT_KEY, '受控目录内的持久 videoKey 可作为服务端媒体源')
  assert.strictEqual(resolveManagedVideoObjectKey({
    videoUrl: `${allowedOrigin}/${encodeURI(SECRET_OBJECT_KEY)}`
  }, {
    uploadDir: 'house-videos',
    allowedOrigins: [allowedOrigin]
  }), SECRET_OBJECT_KEY, '同源历史 OSS URL 可安全还原受控对象键')
  assert.strictEqual(resolveManagedVideoObjectKey({
    videoKey: 'legacy-invalid-key.mp4',
    videoUrl: `${allowedOrigin}/${encodeURI(SECRET_OBJECT_KEY)}`
  }, {
    uploadDir: 'house-videos',
    allowedOrigins: [allowedOrigin]
  }), SECRET_OBJECT_KEY, '非法旧 videoKey 不得阻止从同源合法 videoUrl 恢复受控对象键')
  ;[
    'https://evil.example/house-videos/legacy/video.mp4',
    'https://bucket.oss-cn-example.aliyuncs.com.evil.example/house-videos/video.mp4',
    'https://user@bucket.oss-cn-example.aliyuncs.com/house-videos/video.mp4',
    'https://bucket.oss-cn-example.aliyuncs.com/other/video.mp4'
  ].forEach((videoUrl) => {
    assert.strictEqual(resolveManagedVideoObjectKey({ videoUrl }, {
      uploadDir: 'house-videos',
      allowedOrigins: [allowedOrigin]
    }), '', `非受控历史 URL 必须 fail-closed：${videoUrl}`)
  })

  console.log('listing-media-proxy-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
