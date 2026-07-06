#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ynzy-miniapp}"
SERVICE_NAME="${SERVICE_NAME:-ynzy-miniapp}"

if [ "$(id -u)" != "0" ]; then
  echo "Please run as root."
  exit 1
fi

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y curl ca-certificates unzip nginx
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates unzip nginx
    return
  fi
  if command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates unzip nginx
    return
  fi
  echo "Unsupported Linux package manager."
  exit 1
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo "0"
    return
  fi
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

install_node() {
  local major
  major="$(node_major)"
  if [ "$major" -ge 18 ] 2>/dev/null; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
    return
  fi
  if command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
    return
  fi
}

install_packages
install_node

if [ ! -f "$APP_DIR/server/.env" ]; then
  echo "server/.env is required on the server; deployment packages intentionally exclude .env files."
  exit 1
fi

if grep -q '^PORT=' "$APP_DIR/server/.env"; then
  sed -i 's/^PORT=.*/PORT=3101/' "$APP_DIR/server/.env"
else
  printf '\nPORT=3101\n' >> "$APP_DIR/server/.env"
fi

cd "$APP_DIR/server"
npm install --omit=dev

install_nginx_config() {
  local nginx_conf_dir="/etc/nginx/conf.d"
  local nginx_conf="$nginx_conf_dir/ynzy-miniapp.conf"
  mkdir -p "$nginx_conf_dir"

  if [ -f "$nginx_conf" ]; then
    cp "$nginx_conf" "$nginx_conf.bak-$(date +%Y%m%d%H%M%S)"
  fi

  cp "$APP_DIR/deploy/nginx-ynzy-miniapp.conf" "$nginx_conf"

  grep -q 'location \^~ /wecom/' "$nginx_conf"
  grep -q 'location \^~ /feishu/' "$nginx_conf"
  grep -q 'location \^~ /room-database/' "$nginx_conf"
  grep -q 'location \^~ /media/' "$nginx_conf"
  grep -q 'proxy_pass http://127.0.0.1:8000;' "$nginx_conf"
  if grep -q 'proxy_pass http://127.0.0.1:3000;' "$nginx_conf"; then
    echo "Miniapp must not share the robot domain fallback port 3000."
    exit 1
  fi
  if grep -q 'zf-api.ynzyqbot.cn' "$nginx_conf"; then
    echo "zf-api.ynzyqbot.cn must stay in its own Nginx config and proxy to 3101."
    exit 1
  fi
}

# zf-api.ynzyqbot.cn 是小程序默认请求的主 API 域，且承载实时 ASR 的 WebSocket 转发
# （location = /mini/asr/realtime，proxy_pass 到 127.0.0.1:3101）。它独立于上面的
# miniapp 域，此前安装脚本从不部署它——只跑脚本时实时语音在生产根本不通。这里按同样的
# 备份+覆盖+校验模式单独部署到自己的 conf 文件。
install_zf_api_nginx_config() {
  local nginx_conf_dir="/etc/nginx/conf.d"
  local zf_api_conf="$nginx_conf_dir/zf-api-miniapp.conf"
  mkdir -p "$nginx_conf_dir"

  if [ -f "$zf_api_conf" ]; then
    cp "$zf_api_conf" "$zf_api_conf.bak-$(date +%Y%m%d%H%M%S)"
  fi

  cp "$APP_DIR/deploy/nginx-zf-api-miniapp.conf" "$zf_api_conf"

  # set -e 下裸 grep -q 即断言：缺任一项即视为 conf 不完整、install 失败。
  grep -q 'server_name zf-api.ynzyqbot.cn' "$zf_api_conf"
  grep -q 'location = /mini/asr/realtime' "$zf_api_conf"
  grep -q 'proxy_set_header Upgrade $http_upgrade' "$zf_api_conf"
  grep -q 'proxy_pass http://127.0.0.1:3101' "$zf_api_conf"
}

# 异地加密备份（P0-1）：密钥/异地目标/通知命令只从 /etc/default/ynzy-backup 读取，绝不入库。
# 首次安装生成空模板（chmod 600）；已存在则不覆盖（保留运维已填的真实值）。
BACKUP_ENV_FILE="/etc/default/ynzy-backup"
ensure_backup_env() {
  if [ -f "$BACKUP_ENV_FILE" ]; then
    echo "已存在 $BACKUP_ENV_FILE，保留现有内容（不覆盖）。"
    return
  fi
  cat > "$BACKUP_ENV_FILE" <<'EOF'
# 寓你 db.json 异地加密备份环境（本文件含密钥/异地目标，chmod 600，绝不入库/外发）
# 详见 server/README.md「异地加密备份（P0-1）」。填好后 systemctl start ynzy-offsite-backup.service 验证。

# 加密口令：强随机串，务必再异地保管一份——丢失即无法解密任何备份。缺失时备份脚本拒绝运行。
BACKUP_ENCRYPTION_KEY=

# 异地上传命令（生产必填，缺失即判失败）。脚本以环境变量 $BACKUP_FILE 传入备份文件完整路径。
# 例：BACKUP_REMOTE_CMD=rsync -az -e "ssh -i /root/.ssh/backup_offsite" "$BACKUP_FILE" backup@异地主机:/data/ynzy-db-backups/
BACKUP_REMOTE_CMD=

# 可选：外部通知命令（企微/飞书 webhook），触发告警时以 $ALERT_KIND/$ALERT_MESSAGE 传入。
BACKUP_ALERT_CMD=

# 可选调优：本地暂存目录/保留天数/新鲜度阈值(小时)
BACKUP_STAGE_DIR=/opt/ynzy-miniapp/server/backups
BACKUP_RETENTION_DAYS=30
BACKUP_MAX_AGE_HOURS=24
EOF
  chmod 600 "$BACKUP_ENV_FILE"
  echo "已生成 $BACKUP_ENV_FILE 模板（chmod 600）。上线前必须填 BACKUP_ENCRYPTION_KEY 与 BACKUP_REMOTE_CMD。"
}

cp "$APP_DIR/deploy/ynzy-miniapp.service" /etc/systemd/system/ynzy-miniapp.service
cp "$APP_DIR/deploy/ynzy-db-backup.service" /etc/systemd/system/ynzy-db-backup.service
cp "$APP_DIR/deploy/ynzy-db-backup.timer" /etc/systemd/system/ynzy-db-backup.timer
# 异地加密备份 + 恢复演练（P0-1）
cp "$APP_DIR/deploy/ynzy-offsite-backup.service" /etc/systemd/system/ynzy-offsite-backup.service
cp "$APP_DIR/deploy/ynzy-offsite-backup.timer" /etc/systemd/system/ynzy-offsite-backup.timer
cp "$APP_DIR/deploy/ynzy-restore-drill.service" /etc/systemd/system/ynzy-restore-drill.service
cp "$APP_DIR/deploy/ynzy-restore-drill.timer" /etc/systemd/system/ynzy-restore-drill.timer
ensure_backup_env
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl enable --now ynzy-db-backup.timer
# 异地备份/演练定时器（在 /etc/default/ynzy-backup 填好密钥+异地目标前会 fail-loud，属预期）
systemctl enable --now ynzy-offsite-backup.timer
systemctl enable --now ynzy-restore-drill.timer
systemctl restart "$SERVICE_NAME"

install_nginx_config
install_zf_api_nginx_config

nginx -t
systemctl enable nginx
systemctl restart nginx

curl -fsS http://127.0.0.1:3101/healthz

echo "Server install finished."
echo "提醒：异地加密备份需在 $BACKUP_ENV_FILE 填 BACKUP_ENCRYPTION_KEY 与 BACKUP_REMOTE_CMD（异地目标），"
echo "     否则 ynzy-offsite-backup 会 fail-loud。填好后：systemctl start ynzy-offsite-backup.service && journalctl -u ynzy-offsite-backup -n 20"
