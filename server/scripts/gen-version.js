'use strict'

// 部署 / 构建期生成 server/version.json，供运行时 src/version.js 读取。
// 生产目录非 git 仓库，故版本信息在有 git 的本地 / CI 生成后随部署一起 scp 上去。
// 非 git 环境或 git 不可用时写 commit=unknown，不报错（版本追溯降级但不阻断部署）。

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const repoRoot = path.join(__dirname, '..', '..')

function git(args) {
  try {
    return execSync('git ' + args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch (error) {
    return ''
  }
}

function main() {
  let pkgVersion = '0.0.0'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    if (pkg && pkg.version) pkgVersion = String(pkg.version)
  } catch (error) {
    // package.json 读不到就用默认，不阻断
  }

  const info = {
    version: pkgVersion,
    commit: git('rev-parse HEAD') || 'unknown',
    branch: git('rev-parse --abbrev-ref HEAD') || '',
    committedAt: git('log -1 --format=%cI') || '',
    builtAt: new Date().toISOString()
  }

  const out = path.join(__dirname, '..', 'version.json')
  fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n')
  process.stdout.write('version.json 已生成: ' + JSON.stringify({
    version: info.version,
    commit: info.commit === 'unknown' ? 'unknown' : info.commit.slice(0, 12),
    branch: info.branch,
    builtAt: info.builtAt
  }) + '\n')
}

main()
