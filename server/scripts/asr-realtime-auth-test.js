// 回归测试：实时 ASR 的 upgrade 鉴权钩子契约。每条连接都用服务端密钥开一路付费上游，
// 未授权客户端必须在升级阶段被拒（socket 销毁、不握手、不创建上游），且授权回调抛错也
// 必须兜住成「拒绝」而非放行或崩进程。
const assert = require('assert')
const http = require('http')
const WebSocket = require('ws')
const { WebSocketServer } = WebSocket
const asrRealtime = require('../src/asr-realtime')

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

// 返回 'open'（握手成功）或 'rejected'（socket 被销毁 → 客户端 error/close/异常响应）。
function tryConnect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try { ws.terminate() } catch (error) { /* 已断开 */ }
      resolve(result)
    }
    ws.on('open', () => done('open'))
    ws.on('error', () => done('rejected'))
    ws.on('unexpected-response', () => done('rejected'))
    ws.on('close', () => done('rejected'))
  })
}

async function main() {
  const oldEnv = {
    ASR_API_KEY: process.env.ASR_API_KEY,
    ASR_REALTIME_URL: process.env.ASR_REALTIME_URL
  }

  let uncaught = null
  const onUncaught = (error) => { uncaught = error }
  process.on('uncaughtException', onUncaught)

  const upstreamServer = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(upstreamServer, 'listening')
  const upstreamPort = upstreamServer.address().port

  let mode = 'allow' // 'allow' | 'deny' | 'throw'
  const httpServer = http.createServer()

  try {
    process.env.ASR_API_KEY = 'test-asr-key'
    process.env.ASR_REALTIME_URL = `ws://127.0.0.1:${upstreamPort}`

    asrRealtime.attachRealtimeAsr(httpServer, {
      db: {},
      authorizeUpgrade: () => {
        if (mode === 'throw') throw new Error('authorize boom')
        return mode === 'allow'
      }
    })
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const port = httpServer.address().port
    const url = `ws://127.0.0.1:${port}${asrRealtime.CLIENT_PATH}`

    mode = 'allow'
    assert.strictEqual(await tryConnect(url), 'open', 'authorizeUpgrade 放行时应能完成握手')

    mode = 'deny'
    assert.strictEqual(await tryConnect(url), 'rejected', 'authorizeUpgrade 拒绝时必须拒绝升级（未认证/超限不得建连）')

    mode = 'throw'
    assert.strictEqual(await tryConnect(url), 'rejected', 'authorizeUpgrade 抛错必须兜成拒绝，不得放行')

    assert.strictEqual(uncaught, null, `鉴权回调异常不得逃逸成 uncaughtException：${uncaught && uncaught.message}`)

    // 拒绝后进程仍存活：放行模式再连一次应能握手。
    mode = 'allow'
    assert.strictEqual(await tryConnect(url), 'open', '拒绝连接后进程应存活、后续放行连接仍能握手')
  } finally {
    await new Promise((resolve) => httpServer.close(resolve))
    await new Promise((resolve) => upstreamServer.close(resolve))
    process.removeListener('uncaughtException', onUncaught)
    Object.keys(oldEnv).forEach((key) => {
      if (oldEnv[key] === undefined) delete process.env[key]
      else process.env[key] = oldEnv[key]
    })
  }
}

main()
  .then(() => console.log('asr-realtime-auth-test passed'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
