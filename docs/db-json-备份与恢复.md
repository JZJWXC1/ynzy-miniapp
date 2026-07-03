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
