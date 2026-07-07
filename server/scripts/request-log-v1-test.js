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

  console.log('request-log-v1-test passed')
}

run()
