# build-deploy.ps1 — assemble a clean production bundle from this working tree.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-deploy.ps1
#   (optional) -OutDir D:\some\other\folder
#
# Output layout (default D:\Transforme\ANPR-deploy):
#   webroot\        -> /var/www/html/anprc-sigap.dpr.go.id  (10.10.33.144)
#   anpr_backend\   -> /var/www/html/anpr_backend            (10.10.33.144)
#   worker\         -> 10.10.33.143 (runs as a service)
#   PRODUCTION_CHECKLIST(.id).md + DEPLOY-README.txt
#
# Excluded on purpose: config.php (secrets — create config.prod.php on the
# server from config.prod.example.php), logs/ and uploads/ content (dev data;
# uploads\audio IS kept — the S300 downloads prompt WAVs from it), simulators,
# node_modules, vendor installer bundles.

param([string]$OutDir = 'D:\Transforme\ANPR-deploy')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== 1/5 Building frontend (npm run build) ==" -ForegroundColor Cyan
Push-Location (Join-Path $root 'frontend')
npm run build
$buildExit = $LASTEXITCODE
Pop-Location
if ($buildExit -ne 0) { throw "frontend build failed (exit $buildExit)" }

Write-Host "== 2/5 Resetting $OutDir ==" -ForegroundColor Cyan
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force $OutDir | Out-Null

Write-Host "== 3/5 Copying SPA build -> webroot ==" -ForegroundColor Cyan
Copy-Item -Recurse (Join-Path $root 'frontend\dist') (Join-Path $OutDir 'webroot')

Write-Host "== 4/5 Copying backend -> anpr_backend ==" -ForegroundColor Cyan
robocopy (Join-Path $root 'backend') (Join-Path $OutDir 'anpr_backend') /MIR `
    /XD logs uploads /XF config.php /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy backend failed (exit $LASTEXITCODE)" }
# Empty runtime dirs (server chowns these to apache) + keep prompt audio files
New-Item -ItemType Directory -Force (Join-Path $OutDir 'anpr_backend\logs') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $OutDir 'anpr_backend\uploads') | Out-Null
$audio = Join-Path $root 'backend\uploads\audio'
if (Test-Path $audio) {
    Copy-Item -Recurse $audio (Join-Path $OutDir 'anpr_backend\uploads\audio')
}

Write-Host "== 5/5 Copying worker + docs ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force (Join-Path $OutDir 'worker') | Out-Null
Copy-Item (Join-Path $root 'worker\worker.py')     (Join-Path $OutDir 'worker')
Copy-Item (Join-Path $root 'worker\.env.example')  (Join-Path $OutDir 'worker')
Copy-Item (Join-Path $root 'docs\PRODUCTION_CHECKLIST.md')    $OutDir
Copy-Item (Join-Path $root 'docs\PRODUCTION_CHECKLIST.id.md') $OutDir

@"
ANPR production deploy bundle — generated $(Get-Date -Format 'yyyy-MM-dd HH:mm')

Where each folder goes:
  webroot\       -> 10.10.33.144:/var/www/html/anprc-sigap.dpr.go.id  (SPA docroot)
  anpr_backend\  -> 10.10.33.144:/var/www/html/anpr_backend            (Alias /anpr_backend)
  worker\        -> 10.10.33.143 (worker.py runs as a service — restart it after copying)

After copying, ON THE SERVERS:
  .144: cp anpr_backend/config/config.prod.example.php anpr_backend/config/config.prod.php
        -> fill DB password + auth.secret; vhost needs 'SetEnv APP_ENV prod'
        chown -R apache:apache anpr_backend/logs anpr_backend/uploads
  .143: cp worker/.env.example worker/.env -> uncomment the PRODUCTION block
  DB (10.10.33.142/db_sigap, first deploy only):
        psql -h 10.10.33.142 -U sigap -d db_sigap -f anpr_backend/database/schema.sql

Full steps: PRODUCTION_CHECKLIST.md (EN) / PRODUCTION_CHECKLIST.id.md (ID)
"@ | Set-Content -Encoding utf8 (Join-Path $OutDir 'DEPLOY-README.txt')

Write-Host "`nDone -> $OutDir" -ForegroundColor Green
Get-ChildItem $OutDir | Select-Object Name, @{n='Items';e={ if ($_.PSIsContainer) { (Get-ChildItem -Recurse $_.FullName | Measure-Object).Count } else { '' } }}
