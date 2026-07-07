'use strict'

// 版本追溯：解析当前运行的代码版本 / commit，供 /healthz、/readyz、启动日志展示。
// 部署是 scp 单文件、生产目录 /opt/ynzy-miniapp 非 git 仓库，运行时无法 git rev-parse，
// 因此版本信息按优先级来源：
//   1) 环境变量 APP_VERSION / APP_COMMIT / APP_BRANCH / APP_BUILT_AT（部署时注入，最高优先级）
//   2) server/version.json（部署 / 构建期由 scripts/gen-version.js 生成）
//   3) 兜底：server/package.json 的 version + commit=unknown
// 任一来源缺失或损坏都不抛错，优雅降级。结果缓存（版本在进程生命周期内不变）。

const fs = require('fs')
const path = require('path')

let cached = null

// 读取 JSON，缺文件 / 空内容 / 坏 JSON / 非对象一律返回 null，绝不抛错。
function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
    if (!raw.trim()) return null
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : null
  } catch (error) {
    return null
  }
}

// 取 commit 短号（前 12 位）；空 / unknown 归一为 'unknown'。
function shortOf(commit) {
  const c = String(commit || '').trim()
  if (!c || c === 'unknown') return 'unknown'
  return c.slice(0, 12)
}

// 纯函数：给定三来源，按优先级 env > version.json > package.json 合成版本信息，便于单测。
function computeVersion(sources) {
  const src = sources || {}
  const env = src.env || {}
  const vfile = src.versionJson || {}
  const pkg = src.pkg || {}
  const es = (name) => {
    const v = env[name]
    return v === undefined || v === null ? '' : String(v).trim()
  }

  const version = es('APP_VERSION') || String(vfile.version || pkg.version || '0.0.0')
  const commit = es('APP_COMMIT') || String(vfile.commit || 'unknown')
  const branch = es('APP_BRANCH') || String(vfile.branch || '')
  const builtAt = es('APP_BUILT_AT') || String(vfile.builtAt || '')
  const committedAt = String(vfile.committedAt || '')

  let source = 'package.json'
  if (es('APP_VERSION') || es('APP_COMMIT')) source = 'env'
  else if (vfile.version || vfile.commit) source = 'version.json'

  return { version, commit, shortCommit: shortOf(commit), branch, builtAt, committedAt, source }
}

function readSources() {
  return {
    env: process.env,
    versionJson: readJsonSafe(path.join(__dirname, '..', 'version.json')),
    pkg: readJsonSafe(path.join(__dirname, '..', 'package.json'))
  }
}

function getVersion() {
  if (!cached) cached = computeVersion(readSources())
  return cached
}

// 仅供测试重置缓存。
function resetCacheForTest() {
  cached = null
}

module.exports = { getVersion, computeVersion, readJsonSafe, shortOf, resetCacheForTest }
