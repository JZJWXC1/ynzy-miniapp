const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

const serverDir = path.resolve(__dirname, '..')
const smokeScript = path.join(__dirname, 'smoke-test.js')
const requiredNames = [
  'SMOKE_BASE_URL',
  'SMOKE_ADMIN_ACCOUNT',
  'SMOKE_ADMIN_PASSWORD'
]

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('smoke-test.js 缺少环境变量时未及时退出'))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

async function run() {
  const source = fs.readFileSync(smokeScript, 'utf8')
  requiredNames.forEach((name) => {
    const literalFallback = new RegExp(`process\\.env\\.${name}\\s*(?:\\|\\||\\?\\?)\\s*['\"\\x60]`)
    assert.ok(!literalFallback.test(source), `${name} 不得保留字面量默认值`)
  })
  const configLoadIndex = source.indexOf('const config = loadSmokeConfig()')
  const dataReadIndex = source.indexOf("fs.readFileSync(dataFile, 'utf8')")
  assert.ok(configLoadIndex >= 0 && dataReadIndex >= 0 && configLoadIndex < dataReadIndex, '环境变量校验必须发生在数据读取之前')

  const { loadSmokeConfig } = require('./smoke-test')
  assert.strictEqual(typeof loadSmokeConfig, 'function', 'smoke-test.js 应导出可测试的配置加载函数')

  requiredNames.forEach((missingName) => {
    const env = {
      SMOKE_BASE_URL: 'http://127.0.0.1:65535',
      SMOKE_ADMIN_ACCOUNT: 'smoke-test-account',
      SMOKE_ADMIN_PASSWORD: 'smoke-test-password'
    }
    delete env[missingName]
    assert.throws(
      () => loadSmokeConfig(env),
      (error) => error && error.code === 'SMOKE_ENV_REQUIRED' && error.message.includes(missingName),
      `缺少 ${missingName} 时必须 fail-closed`
    )
  })

  assert.deepStrictEqual(loadSmokeConfig({
    SMOKE_BASE_URL: ' http://127.0.0.1:65535 ',
    SMOKE_ADMIN_ACCOUNT: ' smoke-test-account ',
    SMOKE_ADMIN_PASSWORD: 'smoke-test-password'
  }), {
    baseUrl: 'http://127.0.0.1:65535',
    adminAccount: 'smoke-test-account',
    adminPassword: 'smoke-test-password'
  }, '三项环境变量齐备时应返回配置，地址和账号去除首尾空白')

  let networkHits = 0
  const canary = http.createServer((req, res) => {
    networkHits += 1
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 1 }))
  })
  await new Promise((resolve) => canary.listen(0, '127.0.0.1', resolve))

  const env = { ...process.env }
  requiredNames.forEach((name) => { delete env[name] })
  env.SMOKE_BASE_URL = `http://127.0.0.1:${canary.address().port}`
  env.SMOKE_ADMIN_ACCOUNT = 'smoke-test-account'

  const child = spawn(process.execPath, [smokeScript], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })

  try {
    const result = await waitForExit(child)
    assert.notStrictEqual(result.code, 0, '缺少后台密码时 CLI 必须非零退出')
    assert.ok(output.includes('SMOKE_ADMIN_PASSWORD'), '失败信息应指出缺失变量名')
    assert.strictEqual(networkHits, 0, '配置不完整时不得发起任何网络请求')
  } finally {
    if (child.exitCode === null) child.kill()
    await new Promise((resolve) => canary.close(resolve))
  }
}

run().then(() => {
  console.log('smoke-credentials-env-v1-test passed')
}).catch((error) => {
  console.error(`smoke-credentials-env-v1-test failed: ${error.stack || error.message}`)
  process.exit(1)
})
