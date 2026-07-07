'use strict'

// 发布记录：每次生产上线向 server/releases.jsonl 追加一条（append-only JSON Lines），形成可审计的
// 上线台账——何时、哪个 commit、成套(full)还是定向(targeted)、验证结果。version.json 记「现网是哪版」，
// 本台账记「历史每次上线」。纯 Node 内置模块、无凭据、只记非敏感元数据。
//
// 用法：node server/scripts/record-release.js [--commit=<sha>] [--scope=full|targeted]
//        [--files=a,b,c] [--verify=ok|...] [--note=...] [--by=...] [--host=...]
// commit 默认取 server/version.json；时间戳按 UTC 生成。

const fs = require('fs')
const os = require('os')
const path = require('path')

const SERVER_DIR = path.join(__dirname, '..')
const RELEASES_FILE = path.join(SERVER_DIR, 'releases.jsonl')
const VERSION_FILE = path.join(SERVER_DIR, 'version.json')

function parseArgs(argv) {
  const args = {}
  for (const raw of argv || []) {
    const matched = /^--([^=]+)=([\s\S]*)$/.exec(raw)
    if (matched) args[matched[1]] = matched[2]
  }
  return args
}

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

function shortOf(commit) {
  const text = String(commit || '').trim()
  if (!text || text === 'unknown') return 'unknown'
  return text.slice(0, 12)
}

// 合成一条发布记录。opts.version / opts.now / opts.host 供测试注入。
function buildRecord(args = {}, opts = {}) {
  const version = opts.version || readJsonSafe(VERSION_FILE) || {}
  const commit = String(args.commit || version.commit || 'unknown').trim()
  const scope = args.scope === 'targeted' ? 'targeted' : (args.scope === 'full' ? 'full' : String(args.scope || 'unknown'))
  const files = args.files
    ? String(args.files).split(',').map((item) => item.trim()).filter(Boolean)
    : []
  return {
    t: opts.now || new Date().toISOString(),
    commit,
    shortCommit: shortOf(commit),
    branch: String(args.branch || version.branch || ''),
    version: String(version.version || ''),
    scope,
    files,
    verify: String(args.verify || ''),
    note: String(args.note || ''),
    host: String(args.host || opts.host || os.hostname() || ''),
    by: String(args.by || 'deploy-script')
  }
}

function appendRelease(record, file) {
  fs.appendFileSync(file || RELEASES_FILE, JSON.stringify(record) + '\n')
  return file || RELEASES_FILE
}

if (require.main === module) {
  const record = buildRecord(parseArgs(process.argv.slice(2)))
  const target = appendRelease(record)
  process.stdout.write('release recorded: ' + JSON.stringify({
    t: record.t, commit: record.shortCommit, scope: record.scope, verify: record.verify
  }) + ' -> ' + target + '\n')
}

module.exports = { parseArgs, readJsonSafe, shortOf, buildRecord, appendRelease, RELEASES_FILE, VERSION_FILE }
