'use strict'

// 从飞书云盘自动拉回最新 .ygbak 再跑恢复演练（完整闭环：备份→加密→上传飞书→拉回→演练）。
// 用法：BACKUP_ENCRYPTION_KEY=... FEISHU_BACKUP_*=... node scripts/restore-drill-from-feishu.js
// 流程：取 tenant_access_token → 列云盘文件夹 → 选最新 .ygbak → 下载到临时目录 → 解密演练往返校验。
// 说明：
//   - 下载的是加密 .ygbak（非明文）；解密只到 restoreDrill 自建临时目录、用完即清；本脚本临时目录也在 finally 清掉。
//   - 恢复演练只读：绝不写回生产 db.json。
//   - 任一步失败（缺凭据/无备份/下载失败/解密失败/数量不符）非零退出，供定时任务捕获。

const fs = require('fs')
const os = require('os')
const path = require('path')

const config = require('../src/config')
const feishu = require('../src/feishu-backup')
const backup = require('../src/backup')

function resolveStageDir() {
  return process.env.BACKUP_STAGE_DIR
    ? path.resolve(process.env.BACKUP_STAGE_DIR)
    : path.join(config.rootDir, 'backups')
}

async function main() {
  const passphrase = process.env.BACKUP_ENCRYPTION_KEY
  if (!passphrase) {
    process.stderr.write('[飞书演练] 致命：未设置 BACKUP_ENCRYPTION_KEY，无法解密备份。\n')
    process.exit(2)
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-feishu-drill-'))
  const destPath = path.join(tempDir, 'from-feishu.ygbak')
  let code = 0
  // 状态元数据（非敏感）：从飞书拉回的最新 .ygbak 文件名 + 演练结果，供后台数据备份页展示。
  const status = { ok: false, atMs: Date.now(), kind: 'feishu', fileName: '', countsMatch: null, note: '' }
  try {
    const dl = await feishu.downloadLatestBackup({ env: process.env, destPath })
    status.fileName = dl.name || ''
    process.stdout.write(`[飞书演练] 已从飞书拉回最新备份：${dl.name} | ${dl.size} 字节\n`)

    const drill = backup.restoreDrill({ backupFile: destPath, passphrase })
    status.countsMatch = ((drill.mismatches) || []).length === 0
    if (drill.counts) {
      process.stdout.write(`[飞书演练] 恢复出的计数：${JSON.stringify(drill.counts)}\n`)
      const metaCounts = drill.meta && drill.meta.counts
      if (metaCounts) process.stdout.write(`[飞书演练] 备份记录计数：${JSON.stringify(metaCounts)}\n`)
    }
    if (!drill.ok) {
      process.stderr.write(`[飞书演练] 失败：${drill.error}\n`)
      status.note = 'RESTORE_FAILED'
      code = 1
    } else {
      status.ok = true
      process.stdout.write('[飞书演练] 通过：从飞书拉回的备份往返数量一致、内容哈希吻合，数据可恢复。\n')
    }
  } catch (error) {
    process.stderr.write(`[飞书演练] 失败：${error.message}\n`)
    status.note = 'DRILL_ERROR'
    code = 1
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (cleanupError) { /* 忽略 */ }
    // 状态落盘到备份目录（不含明文/凭据）；写失败不改变演练退出码。
    try {
      const dir = resolveStageDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'feishu-drill-status.json'), JSON.stringify(status))
    } catch (statusError) {
      process.stderr.write(`[飞书演练] 状态写入失败（不影响演练结果）：${statusError.message}\n`)
    }
  }
  process.exit(code)
}

main()
