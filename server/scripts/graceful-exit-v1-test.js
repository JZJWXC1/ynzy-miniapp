const assert = require('assert')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const serverDir = path.resolve(__dirname, '..')
const serverEntry = path.join(serverDir, 'src', 'index.js')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-graceful-exit-'))

function request(baseUrl, targetPath) {
  const url = new URL(targetPath, baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, body: raw }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitForServer(baseUrl) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 12000) {
    try {
      const res = await request(baseUrl, '/healthz')
      if (res.statusCode === 200) return true
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

// 直接用裸 TCP 发送一个畸形的 WebSocket 升级请求：路径 /%zz 会让 upgrade 处理器里的
// decodeURIComponent 抛 URIError。修复前该异常逃逸出同步 'upgrade' 监听器 → uncaughtException
// → 进程退出；修复后应被 try/catch 兜住、socket.destroy，进程存活。
function sendMalformedUpgrade(port, rawPath) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${rawPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      )
    })
    const done = () => { try { socket.destroy() } catch (error) {} resolve() }
    socket.on('close', done)
    socket.on('error', done)
    // 服务端销毁连接后我们也主动收尾，避免测试挂起。
    setTimeout(done, 500)
  })
}

// 断言 1：畸形 upgrade 不打崩进程（asr-realtime upgrade 处理器 try/catch 回归锁）
async function testMalformedUpgradeSurvives() {
  const port = 41000 + Math.floor(Math.random() * 500)
  const dataFile = path.join(tempDir, 'upgrade-db.json')
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, V1_DISABLE_LEGACY_ROUTES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk.toString() })
  server.stderr.on('data', (chunk) => { output += chunk.toString() })
  let exitedEarly = false
  server.on('exit', () => { exitedEarly = true })

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    assert.ok(await waitForServer(baseUrl), `优雅退出测试服务未启动：${output}`)

    // 畸形百分号转义路径 + 畸形 Host，均经 upgrade 处理器解析
    await sendMalformedUpgrade(port, '/%zz')
    await sendMalformedUpgrade(port, '/%')
    await sendMalformedUpgrade(port, '/mini/asr/realtime%c0')

    assert.ok(!exitedEarly, '畸形 WebSocket upgrade 不得导致进程退出（asr upgrade 处理器必须兜住 URL 解析异常）')
    const health = await request(baseUrl, '/healthz')
    assert.strictEqual(health.statusCode, 200, '畸形 upgrade 后进程必须仍在服务其余请求')
  } finally {
    server.kill()
  }
}

// 断言 2：真·未捕获异常触发记录后优雅退出（退出码 1、不挂起、打关停日志）
async function testUncaughtExceptionExitsCleanly() {
  const port = 41500 + Math.floor(Math.random() * 500)
  const dataFile = path.join(tempDir, 'exit-db.json')
  const harnessFile = path.join(tempDir, 'uncaught-harness.js')
  // harness require 真实 src/index.js（同步装上真实的 uncaughtException 兜底），
  // 再在 timer 回调里抛未捕获异常，走真实退出路径。
  fs.writeFileSync(harnessFile, [
    `require(${JSON.stringify(serverEntry)})`,
    'setTimeout(() => { throw new Error("injected-uncaught-for-graceful-exit-test") }, 800)'
  ].join('\n'), 'utf8')

  const child = spawn(process.execPath, [harnessFile], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, V1_DISABLE_LEGACY_ROUTES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  const startedAt = Date.now()
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('未捕获异常后进程未在预期时间内退出（疑似挂起，优雅退出/3s 兜底失效）'))
    }, 8000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, elapsed: Date.now() - startedAt })
    })
  })

  assert.strictEqual(result.signal, null, '进程应主动退出而非被信号杀死')
  assert.strictEqual(result.code, 1, '未捕获异常后必须以退出码 1 退出（交由 systemd 拉起干净实例）')
  // 注入在 800ms 后抛出，加上 server.close 优雅关闭与 3s 兜底，正常应在数秒内退出，不得挂到超时。
  assert.ok(result.elapsed < 7000, `退出耗时 ${result.elapsed}ms 过长，兜底强退可能未生效`)
  assert.ok(
    stderr.includes('未捕获异常') && stderr.includes('injected-uncaught-for-graceful-exit-test'),
    `退出前必须记录未捕获异常日志，实际 stderr：${stderr}`
  )
}

async function run() {
  try {
    await testMalformedUpgradeSurvives()
    await testUncaughtExceptionExitsCleanly()
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('graceful-exit-v1-test passed')
}).catch((error) => {
  console.error(`graceful-exit-v1-test failed: ${error.message}`)
  process.exit(1)
})
