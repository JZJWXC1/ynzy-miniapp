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
  Write-Host "server/data is not included by default. Remote db.json will be preserved during deploy."
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
ssh @sshArgs $sshTarget "BACKUP_DIR=/tmp/ynzy-miniapp-backup-`$(date +%s) && mkdir -p `$BACKUP_DIR/server && if [ -f $RemoteDir/server/.env ]; then cp $RemoteDir/server/.env `$BACKUP_DIR/server/.env; fi && if [ -f $RemoteDir/server/data/db.json ]; then mkdir -p `$BACKUP_DIR/server/data && cp $RemoteDir/server/data/db.json `$BACKUP_DIR/server/data/db.json; fi && if [ -d $RemoteDir/server/certs ]; then cp -a $RemoteDir/server/certs `$BACKUP_DIR/server/certs; fi && mkdir -p $RemoteDir && rm -rf $RemoteDir/* && unzip -o /tmp/ynzy-miniapp.zip -d $RemoteDir && if [ -f `$BACKUP_DIR/server/.env ]; then cp `$BACKUP_DIR/server/.env $RemoteDir/server/.env; fi && if [ -f `$BACKUP_DIR/server/data/db.json ]; then mkdir -p $RemoteDir/server/data && cp `$BACKUP_DIR/server/data/db.json $RemoteDir/server/data/db.json; fi && if [ -d `$BACKUP_DIR/server/certs ]; then mkdir -p $RemoteDir/server && rm -rf $RemoteDir/server/certs && cp -a `$BACKUP_DIR/server/certs $RemoteDir/server/certs; fi && chmod +x $RemoteDir/deploy/install-on-server.sh && APP_DIR=$RemoteDir $RemoteDir/deploy/install-on-server.sh"

Remove-Item -LiteralPath $tempDir -Recurse -Force
Remove-Item -LiteralPath $zipPath -Force

Write-Host "Deploy finished: http://$HostName/admin-web/"
