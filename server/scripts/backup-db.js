'use strict'

// 生产 db.json 异地加密备份 CLI。
// 用法：BACKUP_ENCRYPTION_KEY=... node scripts/backup-db.js
// 关键点：数据文件路径取自 config.dataFile（DATA_FILE 环境变量），加密密钥/异地目标只从环境变量读取。
// 流程：读源 db.json → gzip → AES-256-GCM 加密 → 带时间戳落盘 → 即时自检 → 异地上传钩子 → 保留清理。
// 任一失败都会通过 backup.js 的告警钩子输出明确错误并以非零码退出，便于定时任务捕获。

const path = require('path')
const config = require('../src/config')
const backup = require('../src/backup')

function num(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function boolEnv(name) {
  return /^(1|true|yes|on|是)$/i.test(String(process.env[name] || '').trim())
}

function resolveStageDir() {
  return process.env.BACKUP_STAGE_DIR
    ? path.resolve(process.env.BACKUP_STAGE_DIR)
    : path.join(config.rootDir, 'backups')
}

function main() {
  const passphrase = process.env.BACKUP_ENCRYPTION_KEY
  if (!passphrase) {
    process.stderr.write('[备份] 致命：未设置 BACKUP_ENCRYPTION_KEY，拒绝生成明文备份。\n')
    process.exit(2)
  }

  const result = backup.runBackup({
    dataFile: config.dataFile,
    stageDir: resolveStageDir(),
    passphrase,
    retentionDays: num('BACKUP_RETENTION_DAYS', 30),
    remoteCmd: process.env.BACKUP_REMOTE_CMD,
    // 默认必须异地上传成功才算达成；仅当显式 BACKUP_ALLOW_LOCAL_ONLY=1 时才允许仅本地备份成功退出。
    allowLocalOnly: boolEnv('BACKUP_ALLOW_LOCAL_ONLY')
  })

  if (result.ok) {
    const counts = JSON.stringify((result.meta && result.meta.counts) || {})
    const remoteState = result.remoteUploaded ? '已完成' : '仅本地(已显式允许)'
    process.stdout.write(
      `[备份] 成功：${path.basename(result.file)} | 源计数 ${counts} | ` +
      `异地上传 ${remoteState} | 清理过期 ${result.removed.length} 份\n`
    )
    process.exit(0)
  }

  const kinds = result.alerts.map((a) => a.kind).join(',') || '无'
  process.stderr.write(`[备份] 失败：已触发告警 [${kinds}]，本轮未产出可信/异地备份。\n`)
  process.exit(1)
}

main()
