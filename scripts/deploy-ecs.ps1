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
$archivePath = Join-Path $env:TEMP "ynzy-miniapp-deploy-$stamp.tar.gz"

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

# Version tracking: generate server/version.json at package time and ship it. Production dir is not a
# git repo, so runtime cannot git rev-parse; missing this file degrades /healthz and startup log to commit=unknown.
& node (Join-Path $root "server\scripts\gen-version.js")
if ($LASTEXITCODE -ne 0) { throw "gen-version.js failed to produce server/version.json" }
Copy-Item -Path (Join-Path $root "server\version.json") -Destination (Join-Path $tempDir "server\version.json")
$headCommit = (& git -C $root rev-parse HEAD).Trim()
$stageVersion = Get-Content -LiteralPath (Join-Path $tempDir "server\version.json") -Raw | ConvertFrom-Json
if (-not $stageVersion.commit -or $stageVersion.commit -eq "unknown") { throw "server/version.json commit is empty/unknown" }
if ($stageVersion.commit -ne $headCommit) { throw "server/version.json commit ($($stageVersion.commit)) does not match HEAD ($headCommit)" }
Write-Host "version.json OK: commit $($stageVersion.commit.Substring(0, 12)) branch $($stageVersion.branch)"
Copy-Item -Path (Join-Path $root "admin-web\*") -Destination (Join-Path $tempDir "admin-web") -Recurse
Copy-Item -Path (Join-Path $root "utils\mock-data.js") -Destination (Join-Path $tempDir "utils\mock-data.js")
Copy-Item -Path (Join-Path $root "deploy\*") -Destination (Join-Path $tempDir "deploy") -Recurse

if ($IncludeEnv) {
  Copy-Item -Path (Join-Path $root "server\.env") -Destination (Join-Path $tempDir "server\.env")
  Write-Host "Included server/.env. This zip contains secrets; use only for your server."
} else {
  Write-Host "server/.env and .env.* files are not included by default. Remote .env will be preserved during deploy."
}

if (Test-Path $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}
tar -czf $archivePath -C $tempDir .
if ($LASTEXITCODE -ne 0) {
  throw "Archive failed: tar exited with code $LASTEXITCODE"
}

$sshTarget = "$User@$HostName"
$sshArgs = @()
if ($KeyFile) {
  $sshArgs += @("-i", $KeyFile)
}

scp @sshArgs $archivePath "${sshTarget}:/tmp/ynzy-miniapp.tar.gz"
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

# Rollback safety net: back up current code dirs (replaced wholesale below) so a bad release reverts fast.
if [ -d "`$REMOTE_DIR/server/src" ]; then cp -a "`$REMOTE_DIR/server/src" "`$BACKUP_DIR/server/src"; fi
if [ -d "`$REMOTE_DIR/server/scripts" ]; then cp -a "`$REMOTE_DIR/server/scripts" "`$BACKUP_DIR/server/scripts"; fi
if [ -d "`$REMOTE_DIR/deploy" ]; then cp -a "`$REMOTE_DIR/deploy" "`$BACKUP_DIR/deploy"; fi

tar -xzf /tmp/ynzy-miniapp.tar.gz -C "`$STAGE_DIR"
mkdir -p "`$REMOTE_DIR/server" "`$REMOTE_DIR/utils"

rm -rf "`$REMOTE_DIR/server/src" "`$REMOTE_DIR/server/scripts" "`$REMOTE_DIR/admin-web" "`$REMOTE_DIR/deploy"
cp -a "`$STAGE_DIR/server/src" "`$REMOTE_DIR/server/src"
cp -a "`$STAGE_DIR/server/scripts" "`$REMOTE_DIR/server/scripts"
cp -a "`$STAGE_DIR/admin-web" "`$REMOTE_DIR/admin-web"
cp -a "`$STAGE_DIR/deploy" "`$REMOTE_DIR/deploy"
cp "`$STAGE_DIR/server/package.json" "`$REMOTE_DIR/server/package.json"
cp "`$STAGE_DIR/server/README.md" "`$REMOTE_DIR/server/README.md"
cp "`$STAGE_DIR/server/version.json" "`$REMOTE_DIR/server/version.json"
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

# Post-deploy verification: healthz + running version commit + a listing detail must not 500.
# The SEV1 (all detail endpoints 500 from a cross-module deploy mismatch) slipped past a healthz-only check.
sleep 4
PORT=3101
HZ=`$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:`$PORT/healthz" || echo 000)
WANT=`$(node -e 'try{process.stdout.write(String(JSON.parse((function(){var _r=require("fs").readFileSync(process.argv[1],"utf8");return _r.charCodeAt(0)===65279?_r.slice(1):_r})()).commit||""))}catch(e){process.stdout.write("")}' "`$REMOTE_DIR/server/version.json" 2>/dev/null)
RUN=`$(curl -s "http://127.0.0.1:`$PORT/healthz" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j.data&&j.data.version&&j.data.version.commit)||""))}catch(e){process.stdout.write("")}})' 2>/dev/null)
LID=`$(node -e 'try{const d=JSON.parse((function(){var _r=require("fs").readFileSync(process.argv[1],"utf8");return _r.charCodeAt(0)===65279?_r.slice(1):_r})());const L=(d.listings||[]);const l=L.find(x=>x&&x.id&&x.companyListing)||L.find(x=>x&&x.id);process.stdout.write(l?String(l.id):"")}catch(e){process.stdout.write("")}' "`$REMOTE_DIR/server/data/db.json" 2>/dev/null)
DZ="skip"
if [ -n "`$LID" ]; then DZ=`$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:`$PORT/mini/listings/`$LID" || echo 000); fi
echo "Post-deploy check: healthz=`$HZ version(run=`$RUN want=`$WANT) listing-detail(`$LID)=`$DZ"
POSTFAIL=0
if [ "`$HZ" != "200" ]; then echo "!! healthz not 200" >&2; POSTFAIL=1; fi
if [ -n "`$WANT" ] && [ "`$RUN" != "`$WANT" ]; then echo "!! running version commit mismatch (run=`$RUN want=`$WANT)" >&2; POSTFAIL=1; fi
if [ "`$DZ" = "500" ] || [ "`$DZ" = "000" ]; then echo "!! listing detail crashed (`$DZ) -- likely cross-module inconsistency" >&2; POSTFAIL=1; fi
if [ "`$POSTFAIL" != "0" ]; then
  echo "!! POST-DEPLOY VERIFICATION FAILED. Rollback: rm -rf `$REMOTE_DIR/server/src && cp -a `$BACKUP_DIR/server/src `$REMOTE_DIR/server/src && systemctl restart ynzy-miniapp" >&2
  exit 1
fi
echo "Post-deploy verification OK."
echo "Backup kept at `$BACKUP_DIR (includes server/src, server/scripts, deploy for code rollback)"
echo "Rollback code: rm -rf `$REMOTE_DIR/server/src && cp -a `$BACKUP_DIR/server/src `$REMOTE_DIR/server/src && systemctl restart ynzy-miniapp"
"@

$remoteScript = $remoteScript -replace "`r`n", "`n"
$remoteScript | ssh @sshArgs $sshTarget "bash -s"
if ($LASTEXITCODE -ne 0) {
  throw "Remote deploy failed: ssh exited with code $LASTEXITCODE"
}

Remove-Item -LiteralPath $tempDir -Recurse -Force
Remove-Item -LiteralPath $archivePath -Force

Write-Host "Deploy finished: http://$HostName/admin-web/"
