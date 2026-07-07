'use strict'

// HTTP 请求链路日志：每个请求分配一个 traceId、回写 X-Trace-Id 响应头、在响应结束时打一行
// 结构化 JSON 日志（方法/路径/状态码/耗时/IP）。目的是让线上问题（尤其「后端查无请求、前端只报
// 统一网络错误」）能靠日志对齐定位——前端把响应头里的 X-Trace-Id 记下来，后端 grep 同一 trace
// 就能看到这条请求是否到达、走了哪条路径、状态码与耗时。
// 红线：不记录请求体、查询串、手机号/房东电话/微信号/身份证等 PII，只记 pathname。
// 开关：REQUEST_LOG=0/off 关闭日志（仍会回 X-Trace-Id 头，便于关联）。

const crypto = require('crypto')

function logEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.REQUEST_LOG || '').trim())
}

function newTraceId() {
  return crypto.randomBytes(8).toString('hex') // 16 位 hex，够低碰撞、够短便于人读
}

// 取客户端 IP：与游客限流口径一致——信任代理时取 X-Forwarded-For 末段（由可信代理追加、
// 客户端无法伪造），否则取 socket 远端地址。
function clientIpOf(req, trustProxy) {
  if (trustProxy) {
    const xff = req && req.headers && req.headers['x-forwarded-for']
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean)
      if (parts.length) return parts[parts.length - 1]
    }
  }
  return (req && req.socket && req.socket.remoteAddress) || ''
}

// 启动一次请求的链路日志。返回可变上下文 { traceId, path, userId }，调用方拿到 pathname / userId
// 后可回填（path 用于日志，userId 可选）。同一响应无论 finish 还是 close 只打一行。
function startRequestLog(req, res, options) {
  const opts = options || {}
  const traceId = newTraceId()
  const ctx = { traceId, path: '', userId: '' }
  try { res.setHeader('X-Trace-Id', traceId) } catch (headerError) { /* 头已发出等，忽略 */ }
  try { res.__reqLog = ctx } catch (attachError) { /* 忽略 */ }
  if (!logEnabled()) return ctx

  const start = process.hrtime.bigint()
  const method = req && req.method
  const ip = clientIpOf(req, opts.trustProxy)
  const sink = opts.sink || ((line) => process.stdout.write('[req] ' + line + '\n'))
  let done = false
  const emit = () => {
    if (done) return
    done = true
    const ms = Number((process.hrtime.bigint() - start) / 1000000n)
    const status = res.statusCode
    const entry = {
      t: new Date().toISOString(),
      lvl: status >= 500 ? 'error' : (status >= 400 ? 'warn' : 'info'),
      trace: traceId,
      method,
      path: ctx.path || '', // 只记 pathname，绝不记 query/body，避免 PII
      status,
      ms,
      ip
    }
    if (ctx.userId) entry.user = ctx.userId
    sink(JSON.stringify(entry))
  }
  res.on('finish', emit) // 正常响应完成
  res.on('close', emit) // 客户端提前断开等
  return ctx
}

module.exports = {
  logEnabled,
  newTraceId,
  clientIpOf,
  startRequestLog
}
