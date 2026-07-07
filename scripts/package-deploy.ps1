param(
  [switch]$IncludeEnv,
  [switch]$IncludeData
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $root "dist"
$stageDir = Join-Path $distDir "ynzy-miniapp-deploy"
$zipPath = Join-Path $distDir "ynzy-miniapp-deploy.zip"

if (Test-Path $stageDir) {
  Remove-Item -LiteralPath $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir "server") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir "admin-web") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir "utils") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir "deploy") | Out-Null

Copy-Item -Path (Join-Path $root "server\src") -Destination (Join-Path $stageDir "server\src") -Recurse
if ($IncludeData) {
  Copy-Item -Path (Join-Path $root "server\data") -Destination (Join-Path $stageDir "server\data") -Recurse
  Write-Host "Included server/data (contains real broker phone numbers). Handle this zip as sensitive."
} else {
  Write-Host "server/data is not included by default (contains real phone numbers). Pass -IncludeData only for first-time seeding."
}
Copy-Item -Path (Join-Path $root "server\scripts") -Destination (Join-Path $stageDir "server\scripts") -Recurse
Copy-Item -Path (Join-Path $root "server\package.json") -Destination (Join-Path $stageDir "server\package.json")
Copy-Item -Path (Join-Path $root "server\README.md") -Destination (Join-Path $stageDir "server\README.md")

# Version tracking: production /opt/ynzy-miniapp is not a git repo, so runtime cannot git rev-parse.
# Generate server/version.json at package time and ship it; otherwise runtime falls back to commit=unknown.
& node (Join-Path $root "server\scripts\gen-version.js")
if ($LASTEXITCODE -ne 0) { throw "gen-version.js failed to produce server/version.json" }
Copy-Item -Path (Join-Path $root "server\version.json") -Destination (Join-Path $stageDir "server\version.json")
Copy-Item -Path (Join-Path $root "admin-web\*") -Destination (Join-Path $stageDir "admin-web") -Recurse
Copy-Item -Path (Join-Path $root "utils\mock-data.js") -Destination (Join-Path $stageDir "utils\mock-data.js")
Copy-Item -Path (Join-Path $root "deploy\*") -Destination (Join-Path $stageDir "deploy") -Recurse

if ($IncludeEnv) {
  Copy-Item -Path (Join-Path $root "server\.env") -Destination (Join-Path $stageDir "server\.env")
  Write-Host "Included server/.env. This zip contains secrets; use only for your server."
} else {
  Write-Host "server/.env and .env.* files are not included. Add server/.env on the server before production-like testing."
}

# Deploy artifact assertion: package must contain server/version.json and its commit must match HEAD.
$stageVersionPath = Join-Path $stageDir "server\version.json"
if (-not (Test-Path $stageVersionPath)) { throw "Deploy package missing server/version.json (version tracking would fall back to commit=unknown)" }
$headCommit = (& git -C $root rev-parse HEAD).Trim()
$stageVersion = Get-Content -LiteralPath $stageVersionPath -Raw | ConvertFrom-Json
if (-not $stageVersion.commit -or $stageVersion.commit -eq "unknown") { throw "server/version.json commit is empty/unknown" }
if ($stageVersion.commit -ne $headCommit) { throw "server/version.json commit ($($stageVersion.commit)) does not match HEAD ($headCommit)" }
Write-Host "version.json OK: commit $($stageVersion.commit.Substring(0, 12)) branch $($stageVersion.branch) built $($stageVersion.builtAt)"

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath

Write-Host "Deploy package created: $zipPath"
