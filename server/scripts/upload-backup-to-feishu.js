'use strict'

// 飞书云盘异地备份上传 CLI。
// 由 backup-db.js 的异地上传钩子调用：BACKUP_REMOTE_CMD='node scripts/upload-backup-to-feishu.js'
// 备份文件路径通过环境变量 BACKUP_FILE 传入（backup.js 落盘后自动注入）。
// 飞书凭据只从环境变量读取：
//   FEISHU_BACKUP_APP_ID / FEISHU_BACKUP_APP_SECRET / FEISHU_BACKUP_FOLDER_TOKEN
//   （可选 FEISHU_BACKUP_UPLOAD_NAME_PREFIX、FEISHU_BACKUP_API_BASE_URL）
// 飞书云盘只放 .ygbak 加密备份；BACKUP_ENCRYPTION_KEY 绝不上传。任一步失败即非零退出。

const feishu = require('../src/feishu-backup')

async function main() {
  try {
    const result = await feishu.uploadBackupToFeishu({
      backupFile: process.env.BACKUP_FILE,
      env: process.env
    })
    process.stdout.write(`[飞书备份] 上传成功：${result.fileName} | ${result.size} 字节 | file_token=${result.fileToken}\n`)
    process.exit(0)
  } catch (error) {
    process.stderr.write(`[飞书备份] 上传失败：${error.message}\n`)
    process.exit(1)
  }
}

main()
