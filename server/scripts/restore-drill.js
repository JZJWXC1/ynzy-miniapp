'use strict'

// db.json 备份恢复演练 CLI。
// 用法：BACKUP_ENCRYPTION_KEY=... node scripts/restore-drill.js [--file <备份文件>] [--out <目录>]
// 不指定 --file 时，取备份目录内最新一份演练。
// 流程：解密到临时目录 → 校验 JSON 可解析 → 往返一致性校验（恢复计数逐项 == 备份时刻源计数）
//       → 新鲜度巡检（最近备份是否超 BACKUP_MAX_AGE_HOURS）。
// 任一异常（解密失败/数量不符/最近备份超期）都会触发告警并以非零码退出。
// 注意：演练只把数据解密到临时目录做计数校验，绝不写回生产 db.json。
//   - 纯演练（不带 --out）：解密产物落到系统临时目录，用完即删，不残留明文。
//   - 真恢复取数（带 --out <目录>）：把解密出的 db.restored.json 保留到你指定的目录，供人工覆盖生产库。

const path = require('path')
const config = require('../src/config')
const backup = require('../src/backup')

function num(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveStageDir() {
  return process.env.BACKUP_STAGE_DIR
    ? path.resolve(process.env.BACKUP_STAGE_DIR)
    : path.join(config.rootDir, 'backups')
}

function parseArg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : null
}

function main() {
  const passphrase = process.env.BACKUP_ENCRYPTION_KEY
  if (!passphrase) {
    process.stderr.write('[恢复演练] 致命：未设置 BACKUP_ENCRYPTION_KEY，无法解密备份。\n')
    process.exit(2)
  }

  const argv = process.argv.slice(2)
  const backupFile = parseArg(argv, '--file')
  const outDir = parseArg(argv, '--out') // 带 --out：保留解密产物到该目录（真恢复取数）；否则纯演练用完即删
  const result = backup.runRestoreDrill({
    dir: resolveStageDir(),
    backupFile: backupFile || undefined,
    tempDir: outDir || undefined,
    passphrase,
    maxAgeHours: num('BACKUP_MAX_AGE_HOURS', 24)
  })

  if (result.freshness) {
    const f = result.freshness
    process.stdout.write(`[恢复演练] 最近备份：${f.latest || '（无）'}（${f.ok ? '新鲜' : '已超期/缺失'}）\n`)
  }
  if (result.target) {
    process.stdout.write(`[恢复演练] 演练目标：${path.basename(result.target)}\n`)
  }
  if (result.drill && result.drill.counts) {
    process.stdout.write(`[恢复演练] 恢复出的计数：${JSON.stringify(result.drill.counts)}\n`)
    const metaCounts = result.drill.meta && result.drill.meta.counts
    if (metaCounts) process.stdout.write(`[恢复演练] 备份记录计数：${JSON.stringify(metaCounts)}\n`)
    if (outDir && result.drill.restoredPath) {
      process.stdout.write(`[恢复演练] 已保留解密产物（真恢复请人工覆盖生产库）：${result.drill.restoredPath}\n`)
    }
  }

  if (result.alerts.length === 0) {
    process.stdout.write('[恢复演练] 通过：往返数量一致、内容哈希吻合，数据可恢复。\n')
    process.exit(0)
  }
  const kinds = result.alerts.map((a) => a.kind).join(',')
  process.stderr.write(`[恢复演练] 失败：已触发告警 [${kinds}]。\n`)
  process.exit(1)
}

main()
