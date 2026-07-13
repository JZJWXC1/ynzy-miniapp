'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const runner = require('./run-v1-tests')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-v1-runner-'))
try {
  const scriptsDir = path.join(tempRoot, 'scripts')
  fs.mkdirSync(scriptsDir)
  ;['b-test.js', 'smoke-test.js', 'a-test.js', 'helper.js', 'v1-final-audit.js'].forEach((name) => {
    fs.writeFileSync(path.join(scriptsDir, name), '', 'utf8')
  })

  assert.deepStrictEqual(
    runner.listTestFiles(tempRoot).map((filePath) => path.basename(filePath)),
    ['a-test.js', 'b-test.js'],
    '统一测试入口必须稳定排序并排除 smoke-test.js'
  )

  const missing = runner.checkDependencies(tempRoot, () => {
    const error = new Error('missing')
    error.code = 'MODULE_NOT_FOUND'
    throw error
  })
  assert.deepStrictEqual(missing, ['@langchain/langgraph', 'ws'], '缺少运行依赖时必须精确列出 package.json 的全部运行依赖')

  const missingOutput = []
  let spawnCount = 0
  const missingExitCode = runner.runSuite({
    serverRoot: tempRoot,
    resolveDependency: () => { throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' }) },
    spawn: () => { spawnCount += 1; return { status: 0 } },
    write: (line) => missingOutput.push(line)
  })
  assert.strictEqual(missingExitCode, 2, '依赖缺失必须非零退出')
  assert.strictEqual(spawnCount, 0, '依赖缺失时不得启动半套测试')
  assert.ok(missingOutput.join('\n').includes('npm ci --ignore-scripts --no-audit --no-fund'), '依赖缺失必须给出可执行安装指令')

  const calls = []
  const completeOutput = []
  const completeExitCode = runner.runSuite({
    serverRoot: tempRoot,
    resolveDependency: () => path.join(tempRoot, 'node_modules', 'ws', 'index.js'),
    spawn: (_command, args) => {
      calls.push(path.basename(args[0]))
      return { status: path.basename(args[0]) === 'b-test.js' ? 1 : 0 }
    },
    write: (line) => completeOutput.push(line)
  })
  assert.deepStrictEqual(calls, ['a-test.js', 'b-test.js', 'v1-final-audit.js'], '完整模式必须运行全部非 smoke 测试并始终执行 final audit')
  assert.strictEqual(completeExitCode, 1, '任一测试失败必须非零退出')
  assert.ok(completeOutput.join('\n').includes('1/3 项失败'), '测试汇总必须准确报告失败数')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('v1-test-runner-v1-test passed')
