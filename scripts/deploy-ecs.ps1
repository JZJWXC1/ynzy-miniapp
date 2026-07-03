param(
  [string]$HostName = "114.55.168.97",
  [string]$User = "root",
  [string]$RemoteDir = "/opt/ynzy-miniapp",
  [string]$KeyFile = "",
  [switch]$IncludeEnv,
  [switch]$IncludeData
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$tempDir = Join-Path $env:TEMP "ynzy-miniapp-deploy-$stamp"
$zipPath = Join-Path $env:TEMP "ynzy-miniapp-deploy-$stamp.zip"

New-Item -ItemType Directory -Path $tempDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempDir "server") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempDir "admin-web") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempDir "utils") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempDir "deploy") | Out-Null

Copy-Item -Path (Join-Path $root "server\src") -Destination (Join-Path $tempDir "server\src") -Recurse
if ($IncludeData) {
  Copy-Item -Path (Join-Path $root "server\data") -Destination (Join-Path $tempDir "server\data") -Recurse
  Write-Host "Included server/data (contains real broker phone numbers). Handle this zip as sensitive."
} else {
  Write-Host "server/data is not included by default. Remote server/data will be preserved during deploy."
}
Copy-Item -Path (Join-Path $root "server\scripts") -Destination (Join-Path $tempDir "server\scripts") -Recurse
Copy-Item -Path (Join-Path $root "server\package.json") -Destination (Join-Path $tempDir "server\package.json")
Copy-Item -Path (Join-Path $root "server\README.md") -Destination (Join-Path $tempDir "server\README.md")
Copy-Item -Path (Join-Path $root "admin-web\*") -Destination (Join-Path $tempDir "admin-web") -Recurse
Copy-Item -Path (Join-Path $root "utils\mock-data.js") -Destination (Join-Path $tempDir "utils\mock-data.js")
Copy-Item -Path (Join-Path $root "deploy\*") -Destination (Join-Path $tempDir "deploy") -Recurse

if ($IncludeEnv) {
  Copy-Item -Path (Join-Path $root "server\.env") -Destination (Join-Path $tempDir "server\.env")
  Write-Host "Included server/.env. This zip contains secrets; use only for your server."
} else {
  Write-Host "server/.env and .env.* files are not included by default. Remote .env will be preserved during deploy."
}

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $tempDir "*") -DestinationPath $zipPath

$sshTarget = "$User@$HostName"
$sshArgs = @()
if ($KeyFile) {
  $sshArgs += @("-i", $KeyFile)
}

scp @sshArgs $zipPath "${sshTarget}:/tmp/ynzy-miniapp.zip"
if ($LASTEXITCODE -ne 0) {
  throw "Upload failed: scp exited with code $LASTEXITCODE"
}

$remoteScript = @"
set -euo pipefail

REMOTE_DIR="$RemoteDir"
case "`$REMOTE_DIR" in
  ""|"/"|"/opt"|"/opt/")
    echo "Refuse unsafe REMOTE_DIR=`$REMOTE_DIR" >&2
    exit 1
    ;;
esac

BACKUP_DIR="/tmp/ynzy-miniapp-backup-`$(date +%s)"
STAGE_DIR="/tmp/ynzy-miniapp-release-`$(date +%s)"
mkdir -p "`$BACKUP_DIR/server" "`$STAGE_DIR"

if [ -f "`$REMOTE_DIR/server/.env" ]; then
  cp "`$REMOTE_DIR/server/.env" "`$BACKUP_DIR/server/.env"
fi
if [ -d "`$REMOTE_DIR/server/data" ]; then
  cp -a "`$REMOTE_DIR/server/data" "`$BACKUP_DIR/server/data"
fi
if [ -d "`$REMOTE_DIR/server/certs" ]; then
  cp -a "`$REMOTE_DIR/server/certs" "`$BACKUP_DIR/server/certs"
fi
for file in "`$REMOTE_DIR"/lark-*.json; do
  if [ -f "`$file" ]; then
    cp "`$file" "`$BACKUP_DIR/"
  fi
done

unzip -oq /tmp/ynzy-miniapp.zip -d "`$STAGE_DIR"
mkdir -p "`$REMOTE_DIR/server" "`$REMOTE_DIR/utils"

rm -rf "`$REMOTE_DIR/server/src" "`$REMOTE_DIR/server/scripts" "`$REMOTE_DIR/admin-web" "`$REMOTE_DIR/deploy"
cp -a "`$STAGE_DIR/server/src" "`$REMOTE_DIR/server/src"
cp -a "`$STAGE_DIR/server/scripts" "`$REMOTE_DIR/server/scripts"
cp -a "`$STAGE_DIR/admin-web" "`$REMOTE_DIR/admin-web"
cp -a "`$STAGE_DIR/deploy" "`$REMOTE_DIR/deploy"
cp "`$STAGE_DIR/server/package.json" "`$REMOTE_DIR/server/package.json"
cp "`$STAGE_DIR/server/README.md" "`$REMOTE_DIR/server/README.md"
cp "`$STAGE_DIR/utils/mock-data.js" "`$REMOTE_DIR/utils/mock-data.js"

if [ -f "`$STAGE_DIR/server/.env" ]; then
  cp "`$STAGE_DIR/server/.env" "`$REMOTE_DIR/server/.env"
elif [ -f "`$BACKUP_DIR/server/.env" ] && [ ! -f "`$REMOTE_DIR/server/.env" ]; then
  cp "`$BACKUP_DIR/server/.env" "`$REMOTE_DIR/server/.env"
fi
if [ -d "`$STAGE_DIR/server/data" ]; then
  rm -rf "`$REMOTE_DIR/server/data"
  cp -a "`$STAGE_DIR/server/data" "`$REMOTE_DIR/server/data"
elif [ -d "`$BACKUP_DIR/server/data" ] && [ ! -d "`$REMOTE_DIR/server/data" ]; then
  cp -a "`$BACKUP_DIR/server/data" "`$REMOTE_DIR/server/data"
fi
if [ -d "`$BACKUP_DIR/server/certs" ] && [ ! -d "`$REMOTE_DIR/server/certs" ]; then
  cp -a "`$BACKUP_DIR/server/certs" "`$REMOTE_DIR/server/certs"
fi
for file in "`$BACKUP_DIR"/lark-*.json; do
  if [ -f "`$file" ] && [ ! -f "`$REMOTE_DIR/`$(basename "`$file")" ]; then
    cp "`$file" "`$REMOTE_DIR/"
  fi
done

rm -rf "`$STAGE_DIR"
chmod +x "`$REMOTE_DIR/deploy/install-on-server.sh"
APP_DIR="`$REMOTE_DIR" "`$REMOTE_DIR/deploy/install-on-server.sh"
echo "Backup kept at `$BACKUP_DIR"
"@

$remoteScript | ssh @sshArgs $sshTarget "bash -s"
if ($LASTEXITCODE -ne 0) {
  throw "Remote deploy failed: ssh exited with code $LASTEXITCODE"
}

Remove-Item -LiteralPath $tempDir -Recurse -Force
Remove-Item -LiteralPath $zipPath -Force

Write-Host "Deploy finished: http://$HostName/admin-web/"
