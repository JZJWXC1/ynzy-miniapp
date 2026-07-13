'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const root = path.resolve(__dirname, '..', '..')
const serverDir = path.join(root, 'server')
const html = fs.readFileSync(path.join(root, 'admin-web', 'index.html'), 'utf8')

assert.ok(!html.includes('../assets/logo.png'), '后台不能再引用服务端未发布的根 assets/logo.png')
assert.strictEqual((html.match(/\/admin-web\/logo\.svg/g) || []).length, 2, '登录页和侧栏必须统一引用 admin-web 内部 Logo')
assert.ok(fs.existsSync(path.join(root, 'admin-web', 'logo.svg')), 'Logo 必须随 admin-web 发布目录一起打包')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-admin-logo-'))
const dataFile = path.join(tempDir, 'db.json')
fs.writeFileSync(dataFile, JSON.stringify({ users: [], listings: [] }), 'utf8')
const port = 44000 + Math.floor(Math.random() * 1000)

function requestLogo() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/admin-web/logo.svg`, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, raw }))
    }).on('error', reject)
  })
}

async function waitForServer() {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    try { return await requestLogo() } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('后台静态资源服务未启动')
}

async function run() {
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      ADMIN_TOKEN_SECRET: 'synthetic-admin-logo-secret',
      AUTH_TOKEN_SECRET: 'synthetic-mini-logo-secret',
      V1_DISABLE_LEGACY_ROUTES: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk.toString() })
  server.stderr.on('data', (chunk) => { output += chunk.toString() })
  try {
    const response = await waitForServer()
    assert.strictEqual(response.statusCode, 200, `Logo HTTP 应返回 200：${output}`)
    assert.match(String(response.headers['content-type'] || ''), /^image\/svg\+xml/, 'Logo MIME 必须是 image/svg+xml')
    assert.match(response.raw, /<svg[\s>]/, 'Logo 响应必须是有效 SVG 文本')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-web-logo-v1-test passed')
}).catch((error) => {
  console.error(`admin-web-logo-v1-test failed: ${error.message}`)
  process.exit(1)
})
