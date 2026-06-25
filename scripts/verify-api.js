const http = require('http')
const https = require('https')

const baseUrl = String(process.argv[2] || '').trim().replace(/\/+$/, '')

if (!/^https?:\/\/[^/]+/.test(baseUrl)) {
  console.error('用法：node scripts/verify-api.js http://公网入口地址')
  process.exit(1)
}

function request(method, pathname, body) {
  const url = new URL(pathname, baseUrl)
  const payload = body ? JSON.stringify(body) : ''
  const client = url.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-User-Id': 'U001'
      }
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = {}
        try {
          parsed = text ? JSON.parse(text) : {}
        } catch (error) {
          parsed = { raw: text }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(parsed.message || `HTTP ${res.statusCode}`)
          err.statusCode = res.statusCode
          err.body = parsed
          reject(err)
          return
        }
        resolve(parsed && Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed)
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('请求超时，请检查服务器安全组和端口'))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function check(name, fn) {
  try {
    const detail = await fn()
    console.log(`PASS ${name}: ${detail || 'ok'}`)
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

async function main() {
  await check('服务探活', async () => {
    const health = await request('GET', '/healthz')
    if (!health.ok) throw new Error('healthz 未返回 ok')
    return health.service || 'ok'
  })

  await check('上线就绪检查', async () => {
    const ready = await request('GET', '/readyz')
    if (ready.checks && ready.checks.todo > 0) throw new Error(`仍有 ${ready.checks.todo} 个需处理项`)
    return ready.checks ? `pass=${ready.checks.pass}, pending=${ready.checks.pending}` : 'ok'
  })

  await check('小程序房源接口', async () => {
    const rows = await request('GET', '/mini/home/listings')
    if (!Array.isArray(rows)) throw new Error('首页房源接口未返回数组')
    return `${rows.length} 套`
  })

  await check('OSS 上传策略接口', async () => {
    const policy = await request('POST', '/mini/uploads/video-policy', { fileName: 'verify.mp4' })
    if (policy.uploadMode !== 'oss-post') throw new Error(policy.note || '未返回 OSS 直传策略')
    return policy.uploadMode
  })
}

main().catch((error) => {
  console.error(`FAIL 公网接口体检失败: ${error.message}`)
  process.exit(1)
})
