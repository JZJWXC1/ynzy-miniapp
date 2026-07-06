# db.json 备份与恢复

## 自动备份

生产服务器通过 `ynzy-db-backup.timer` 每 30 分钟备份一次 `server/data/db.json`。

- 备份目录：`/opt/ynzy-miniapp-backups/db`
- 保留份数：最近 48 份
- 最新备份软链：`/opt/ynzy-miniapp-backups/db/latest.json`
- 备份文件命名：`db-YYYYMMDDHHmmss.json`

## 查看备份

```bash
systemctl list-timers ynzy-db-backup.timer
ls -lh /opt/ynzy-miniapp-backups/db
```

## 手动执行一次备份

```bash
systemctl start ynzy-db-backup.service
```

## 恢复命令

先确认要恢复的备份文件，再执行：

```bash
APP_DIR=/opt/ynzy-miniapp
BACKUP=/opt/ynzy-miniapp-backups/db/latest.json
RESTORE_BACKUP=/tmp/ynzy-miniapp-before-db-restore-$(date +%s)

mkdir -p "$RESTORE_BACKUP/server"
cp -a "$APP_DIR/server/data" "$RESTORE_BACKUP/server/data"
systemctl stop ynzy-miniapp
cp "$BACKUP" "$APP_DIR/server/data/db.json"
systemctl start ynzy-miniapp
curl -fsS http://127.0.0.1:3101/healthz
```

恢复前会把当前 `server/data` 复制到 `/tmp/ynzy-miniapp-before-db-restore-*`，便于回滚。

---

## 异地加密备份 + 恢复演练 + 失败告警（P0-1）

上面的 systemd 备份是**本地明文**快照（防误删、快速回滚）。在此之上另加一层**异地加密备份**，用于机器损毁、勒索、整机丢失时的异地恢复。两层互补，都保留。

### 组成

- 核心库 `server/src/backup.js`：AES-256-GCM 加密 + gzip 压缩 + 往返一致性校验 + 保留策略 + 新鲜度巡检 + 告警钩子，零外部依赖。
- 备份 CLI `server/scripts/backup-db.js`：读源 → 加密压缩 → 带时间戳落盘（`db-backup-<UTC>.ygbak`）→ 即时自检 → 异地上传钩子 → 保留清理。
- 恢复演练 CLI `server/scripts/restore-drill.js`：解密到临时目录（不写回生产）→ 校验 JSON → 六项数量往返校验 → 新鲜度巡检。
- 锁定测试 `server/scripts/backup-restore-v1-test.js`。

### 关键约束

- 加密密钥 `BACKUP_ENCRYPTION_KEY`、异地目标 `BACKUP_REMOTE_CMD`、通知命令 `BACKUP_ALERT_CMD` **只从环境变量读取**，仓库不写真实值。
- **异地目标生产必填**：默认未配置 `BACKUP_REMOTE_CMD` 即判失败（`BACKUP_REMOTE_REQUIRED` 告警、非零退出），因为 P0-1 目标是「异地备份」，只做本机备份不算达成；本地演练/临时需显式 `BACKUP_ALLOW_LOCAL_ONLY=1` 才允许仅本地成功（生产禁止开启）。
- 恢复演练**只读**：只把数据解密到系统临时目录做计数校验，绝不覆盖生产 `db.json`。
- 保留最近 `BACKUP_RETENTION_DAYS`（默认 30）天，过期自动清理。
- 本地暂存目录 `server/backups/` 已加入 `.gitignore`（加密备份仍含生产数据，禁止入库）。

### 环境变量、手动操作、cron 配置、告警条件

以 `server/README.md`「异地加密备份（P0-1）」一节为准，不在此重复。要点：

```bash
cd server
BACKUP_ENCRYPTION_KEY=*** BACKUP_REMOTE_CMD='...' node scripts/backup-db.js        # 生产手动备份（必带异地目标）
BACKUP_ENCRYPTION_KEY=*** BACKUP_ALLOW_LOCAL_ONLY=1 node scripts/backup-db.js       # 本地演练（无异地目标）
BACKUP_ENCRYPTION_KEY=*** node scripts/restore-drill.js                            # 手动恢复演练
```

告警种类：`BACKUP_FAILED` / `BACKUP_VERIFY_FAILED` / `BACKUP_EMPTY_SOURCE` / `BACKUP_REMOTE_REQUIRED` / `REMOTE_UPLOAD_FAILED` / `RESTORE_MISMATCH` / `RESTORE_FAILED` / `BACKUP_STALE`，均输出明确错误并以非零码退出，供 cron 捕获。
