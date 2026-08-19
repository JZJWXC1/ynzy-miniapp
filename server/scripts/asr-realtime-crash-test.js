// 回归测试：升级握手成功后，客户端发一条畸形（未 mask）WS 帧不得打死整进程。
// 背景：ws 收到协议非法帧会在该连接上 emit('error')；若 clientWs 无 error 监听，
// EventEmitter 会抛出 → uncaughtException → 撞上全局 process.exit(1)，任意未认证
// 客户端一条畸形帧即可远程杀进程。修复是给 clientWs 挂 error 监听兜住。
const assert = require('assert')
const http = require('http')
const WebSocket = require('ws')
const { WebSocketServer } = WebSocket
const asrRealtime = require('../src/asr-realtime')

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const oldEnv = {
    ASR_API_KEY: process.env.ASR_API_KEY,
    ASR_REALTIME_URL: process.env.ASR_REALTIME_URL
  }

  let uncaught = null
  const onUncaught = (error) => { uncaught = error }
  process.on('uncaughtException', onUncaught)

  // 假上游 WS：让 handleRealtimeConnection 内的 upstream 连本地，不打真实 DashScope。
  const upstreamServer = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(upstreamServer, 'listening')
  const upstreamPort = upstreamServer.address().port

  const httpServer = http.createServer()

  try {
    process.env.ASR_API_KEY = 'test-asr-key'
    process.env.ASR_REALTIME_URL = `ws://127.0.0.1:${upstreamPort}`

    asrRealtime.attachRealtimeAsr(httpServer, { db: {} })
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const port = httpServer.address().port
    const clientUrl = `ws://127.0.0.1:${port}${asrRealtime.CLIENT_PATH}`

    const client = new WebSocket(clientUrl)
    await once(client, 'open')

    // 未 mask 的文本帧 [FIN|text, len=1, 'A']；RFC6455 要求客户端→服务端帧必须 mask，
    // 服务端 receiver 会因缺 mask 位而 emit('error')。直接写底层 socket 绕过 ws 客户端的
    // 正常打帧逻辑。
    client._socket.write(Buffer.from([0x81, 0x01, 0x41]))

    // 等这条畸形帧被服务端处理（触发 error 兜底并断开该连接），或超时兜底。
    await Promise.race([once(client, 'close'), delay(500)])

    assert.strictEqual(
      uncaught,
      null,
      `畸形 WS 帧逃逸成 uncaughtException（clientWs 缺 error 监听）：${uncaught && uncaught.message}`
    )

    // 进程仍存活：另开一条连接应能正常完成握手。
    const probe = new WebSocket(clientUrl)
    await once(probe, 'open')
    probe.close()

    try { client.terminate() } catch (error) { /* 已断开 */ }
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
  .then(() => console.log('asr-realtime-crash-test passed'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
