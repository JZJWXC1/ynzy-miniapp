'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
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
