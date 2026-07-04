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

cp "$APP_DIR/deploy/ynzy-miniapp.service" /etc/systemd/system/ynzy-miniapp.service
cp "$APP_DIR/deploy/ynzy-db-backup.service" /etc/systemd/system/ynzy-db-backup.service
cp "$APP_DIR/deploy/ynzy-db-backup.timer" /etc/systemd/system/ynzy-db-backup.timer
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl enable --now ynzy-db-backup.timer
systemctl restart "$SERVICE_NAME"

install_nginx_config
install_zf_api_nginx_config

nginx -t
systemctl enable nginx
systemctl restart nginx

curl -fsS http://127.0.0.1:3101/healthz

echo "Server install finished."
