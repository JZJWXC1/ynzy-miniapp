'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const packageJson = require('../package.json')

const REQUIRED_DEPENDENCIES = Object.keys(packageJson.dependencies || {}).sort()

function listTestFiles(serverRoot) {
  const scriptsDir = path.join(serverRoot, 'scripts')
  return fs.readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('-test.js') && entry.name !== 'smoke-test.js')
    .map((entry) => path.join(scriptsDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en'))
}

function defaultResolveDependency(name, options) {
  return require.resolve(name, options)
}

function checkDependencies(serverRoot, resolveDependency = defaultResolveDependency) {
  return REQUIRED_DEPENDENCIES.filter((name) => {
    try {
      resolveDependency(name, { paths: [serverRoot] })
      return false
    } catch (_error) {
      return true
    }
  })
}

function runSuite(options = {}) {
  const serverRoot = options.serverRoot || path.resolve(__dirname, '..')
  const resolveDependency = options.resolveDependency || defaultResolveDependency
  const spawn = options.spawn || spawnSync
  const write = options.write || ((line) => console.log(line))
  const missingDependencies = checkDependencies(serverRoot, resolveDependency)

  if (missingDependencies.length) {
    write(`V1 测试依赖缺失：${missingDependencies.join(', ')}`)
    write(`请先进入 ${serverRoot} 并执行：`)
    write('npm ci --ignore-scripts --no-audit --no-fund')
    write('依赖未安装，测试未启动；本次结果不计为通过。')
    return 2
  }

  const commands = listTestFiles(serverRoot).concat(path.join(serverRoot, 'scripts', 'v1-final-audit.js'))
  let failed = 0
  commands.forEach((scriptPath, index) => {
    write(`[${index + 1}/${commands.length}] ${path.basename(scriptPath)}`)
    const result = spawn(process.execPath, [scriptPath], {
      cwd: serverRoot,
      env: process.env,
      stdio: 'inherit'
    })
    if (result.status !== 0) failed += 1
  })

  write(`${failed}/${commands.length} 项失败`)
  return failed ? 1 : 0
}

function main() {
  process.exitCode = runSuite()
}

if (require.main === module) main()

module.exports = {
  REQUIRED_DEPENDENCIES,
  listTestFiles,
  checkDependencies,
  runSuite
}
