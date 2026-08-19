'use strict'

// 请求链路日志 request-log.js 的锁定测试。用 mock req/res 单测，不起真实服务器。
// 覆盖：回 X-Trace-Id 头、finish 打一行结构化日志、字段正确、IP 口径、REQUEST_LOG=0 关闭、
//       finish+close 只打一行、状态码分级、**不含 PII（无 query/body 字段、path 不带查询串）**。

const assert = require('assert')
const rlog = require('../src/request-log')

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    handlers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
    getHeader(k) { return this.headers[String(k).toLowerCase()] },
    on(event, cb) { this.handlers[event] = cb },
    finish() { if (this.handlers.finish) this.handlers.finish() },
    close() { if (this.handlers.close) this.handlers.close() }
  }
}

function mockReq(opts) {
  const o = opts || {}
  const headers = {}
  if (o.xff) headers['x-forwarded-for'] = o.xff
  return { method: o.method || 'GET', url: o.url || '/mini/x', headers, socket: { remoteAddress: o.remote || '10.0.0.1' } }
}

function run() {
  // 1) 回 X-Trace-Id 头 + finish 打一行、字段正确、无 PII。
  {
    const res = mockRes()
    const req = mockReq({ method: 'GET' })
    const lines = []
    const ctx = rlog.startRequestLog(req, res, { trustProxy: true, sink: (l) => lines.push(l) })
    assert.ok(/^[0-9a-f]{16}$/.test(res.getHeader('X-Trace-Id')), 'X-Trace-Id 应为 16 位 hex')
    assert.strictEqual(ctx.traceId, res.getHeader('X-Trace-Id'), 'ctx.traceId 与响应头一致')
    assert.strictEqual(lines.length, 0, 'finish 前不应打日志')

    ctx.path = '/mini/listings'
    res.statusCode = 200
    res.finish()
    assert.strictEqual(lines.length, 1, 'finish 应打一行')
    const entry = JSON.parse(lines[0])
    assert.strictEqual(entry.trace, ctx.traceId, 'trace 一致')
    assert.strictEqual(entry.method, 'GET', 'method')
    assert.strictEqual(entry.path, '/mini/listings', 'path 为 pathname')
    assert.strictEqual(entry.status, 200, 'status')
    assert.strictEqual(entry.lvl, 'info', 'lvl')
    assert.ok(typeof entry.ms === 'number' && entry.ms >= 0, 'ms 应为非负数')
    // 红线：不得含 query/body 字段，path 不带查询串。
    assert.ok(!('query' in entry) && !('body' in entry), '日志不得含 query/body 字段')
    assert.ok(!/\?/.test(entry.path), 'path 不含查询串')
  }

  // 2) IP 口径：信任代理取 XFF 末段，否则取 socket 远端。
  {
    const req = mockReq({ xff: '1.1.1.1, 2.2.2.2, 3.3.3.3', remote: '10.0.0.1' })
    assert.strictEqual(rlog.clientIpOf(req, true), '3.3.3.3', 'trustProxy 取 XFF 末段')
    assert.strictEqual(rlog.clientIpOf(req, false), '10.0.0.1', '不信任代理取 socket 远端')
    // 日志里的 ip 与口径一致
    const res = mockRes(); const lines = []
    rlog.startRequestLog(req, res, { trustProxy: true, sink: (l) => lines.push(l) })
    res.statusCode = 200; res.finish()
    assert.strictEqual(JSON.parse(lines[0]).ip, '3.3.3.3', '日志 ip 取 XFF 末段')
  }

  // 3) finish + close 只打一行（客户端断开不重复打）。
  {
    const res = mockRes(); const lines = []
    rlog.startRequestLog(mockReq(), res, { sink: (l) => lines.push(l) })
    res.statusCode = 200
    res.finish()
    res.close()
    assert.strictEqual(lines.length, 1, 'finish+close 只打一行')
  }

  // 4) REQUEST_LOG=0 关闭日志：不打日志，但仍回 X-Trace-Id 头（便于关联）。
  {
    process.env.REQUEST_LOG = '0'
    const res = mockRes(); const lines = []
    rlog.startRequestLog(mockReq(), res, { sink: (l) => lines.push(l) })
    res.statusCode = 200; res.finish()
    assert.strictEqual(lines.length, 0, 'REQUEST_LOG=0 不打日志')
    assert.ok(res.getHeader('X-Trace-Id'), '关闭日志仍应回 X-Trace-Id 头')
    delete process.env.REQUEST_LOG
  }

  // 5) 状态码分级 lvl：2xx=info、4xx=warn、5xx=error。
  {
    for (const pair of [[200, 'info'], [404, 'warn'], [500, 'error']]) {
      const res = mockRes(); const lines = []
      rlog.startRequestLog(mockReq(), res, { sink: (l) => lines.push(l) })
      res.statusCode = pair[0]
      res.finish()
      assert.strictEqual(JSON.parse(lines[0]).lvl, pair[1], `status ${pair[0]} → lvl ${pair[1]}`)
    }
  }

  console.log('request-log-v1-test unit passed')
}

// 轮询等待缓冲区里出现匹配文本（服务器 stdout），超时抛错。
function waitForLog(getBuf, re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (re.test(getBuf())) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('等待超时：' + re))
      setTimeout(tick, 50)
    }
    tick()
  })
}

// 6) 集成锁定：真实 index.js 服务器下，OPTIONS 预检与 GET 都必须回 X-Trace-Id 头 + 打一行 [req] 日志。
//    这是 router 注入点的回归测试——修复前 OPTIONS 在 startRequestLog 之前就提前返回，漏掉了预检链路。
async function integration() {
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const cp = require('child_process')
  const http = require('http')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-reqlog-'))
  const dataFile = path.join(tmp, 'db.json')
  const port = 3200 + (process.pid % 500)
  const srv = cp.spawn(process.execPath, [path.resolve(__dirname, '..', 'src', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_FILE: dataFile,
      AUTH_TOKEN_SECRET: 'test-auth',
      ADMIN_TOKEN_SECRET: 'test-admin',
      REQUEST_LOG: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  srv.stdout.on('data', (d) => { out += String(d) })
  srv.stderr.on('data', (d) => { out += String(d) })

  const request = (method) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/healthz', method, timeout: 4000 }, (res) => {
      res.resume()
      res.on('end', () => resolve({ headers: res.headers, status: res.statusCode }))
    })
    r.on('error', () => resolve(null))
    r.on('timeout', () => { r.destroy(); resolve(null) })
    r.end()
  })

  try {
    await waitForLog(() => out, /后端已启动/, 8000)
    const opt = await request('OPTIONS')
    const get = await request('GET')
    await waitForLog(() => out, /\[req\].*"method":"OPTIONS"/, 3000)
    await waitForLog(() => out, /\[req\].*"method":"GET"/, 3000)

    assert.ok(opt && opt.headers['x-trace-id'], 'OPTIONS 预检响应必须含 X-Trace-Id 头')
    assert.ok(get && get.headers['x-trace-id'], 'GET 响应必须含 X-Trace-Id 头')

    const reqLines = out.split('\n').filter((l) => l.startsWith('[req] ')).map((l) => JSON.parse(l.slice(6)))
    const optLog = reqLines.find((e) => e.method === 'OPTIONS')
    const getLog = reqLines.find((e) => e.method === 'GET')
    assert.ok(optLog, 'OPTIONS 应产生一行 [req] 日志')
    assert.ok(getLog, 'GET 应产生一行 [req] 日志')
    assert.strictEqual(optLog.path, '/healthz', 'OPTIONS 日志应回填 pathname')
    assert.strictEqual(optLog.trace, opt.headers['x-trace-id'], 'OPTIONS 日志 trace 与响应头一致（可对齐定位）')
    // 红线：无 query/body 字段、path 不带查询串。
    for (const e of reqLines) {
      assert.ok(!('query' in e) && !('body' in e), '[req] 不得含 query/body 字段')
      assert.ok(!/\?/.test(e.path || ''), '[req] path 不含查询串')
    }
  } finally {
    srv.kill()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (cleanupError) { /* 忽略清理失败 */ }
  }
}

async function main() {
  run()
  await integration()
  console.log('request-log-v1-test (含 OPTIONS 集成) passed')
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
