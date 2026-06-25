param(
  [switch]$IncludeEnv
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
Copy-Item -Path (Join-Path $root "server\data") -Destination (Join-Path $stageDir "server\data") -Recurse
Copy-Item -Path (Join-Path $root "server\scripts") -Destination (Join-Path $stageDir "server\scripts") -Recurse
Copy-Item -Path (Join-Path $root "server\package.json") -Destination (Join-Path $stageDir "server\package.json")
Copy-Item -Path (Join-Path $root "server\README.md") -Destination (Join-Path $stageDir "server\README.md")
Copy-Item -Path (Join-Path $root "server\.env.example") -Destination (Join-Path $stageDir "server\.env.example")
Copy-Item -Path (Join-Path $root "admin-web\*") -Destination (Join-Path $stageDir "admin-web") -Recurse
Copy-Item -Path (Join-Path $root "utils\mock-data.js") -Destination (Join-Path $stageDir "utils\mock-data.js")
Copy-Item -Path (Join-Path $root "deploy\*") -Destination (Join-Path $stageDir "deploy") -Recurse

if ($IncludeEnv) {
  Copy-Item -Path (Join-Path $root "server\.env") -Destination (Join-Path $stageDir "server\.env")
  Write-Host "Included server/.env. This zip contains secrets; use only for your server."
} else {
  Write-Host "server/.env is not included. Add it on the server before production-like testing."
}

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath

Write-Host "Deploy package created: $zipPath"
