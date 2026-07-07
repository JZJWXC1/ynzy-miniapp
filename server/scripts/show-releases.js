'use strict'

// 打印 server/releases.jsonl 的上线台账（默认最近 20 条）。运维经 SSH 查发布历史。
// 用法：node server/scripts/show-releases.js [--last=20]

const fs = require('fs')
const path = require('path')

const RELEASES_FILE = path.join(__dirname, '..', 'releases.jsonl')

function readReleases(file) {
  let raw
  try {
    raw = fs.readFileSync(file || RELEASES_FILE, 'utf8')
  } catch (error) {
    return []
  }
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    try {
      const obj = JSON.parse(line)
      return obj && typeof obj === 'object' ? obj : null
    } catch (error) {
      return null // 坏行跳过，不影响读取其余记录
    }
  }).filter(Boolean)
}

function formatRelease(record) {
  return [
    record.t || '?',
    record.shortCommit || record.commit || '?',
    record.branch || '-',
    'scope=' + (record.scope || '?'),
    'verify=' + (record.verify || '-'),
    record.note ? '「' + record.note + '」' : '',
    record.host ? '@' + record.host : '',
    record.by ? 'by=' + record.by : ''
  ].filter(Boolean).join('  ')
}

if (require.main === module) {
  const args = {}
  for (const raw of process.argv.slice(2)) {
    const matched = /^--([^=]+)=([\s\S]*)$/.exec(raw)
    if (matched) args[matched[1]] = matched[2]
  }
  const all = readReleases()
  const last = args.last ? Number(args.last) : 20
  const shown = Number.isFinite(last) && last > 0 ? all.slice(-last) : all
  if (!shown.length) {
    process.stdout.write('（暂无发布记录 server/releases.jsonl）\n')
    process.exit(0)
  }
  process.stdout.write('发布台账（共 ' + all.length + ' 条，显示最近 ' + shown.length + '）：\n')
  shown.forEach((record) => process.stdout.write('  ' + formatRelease(record) + '\n'))
}

module.exports = { readReleases, formatRelease, RELEASES_FILE }
