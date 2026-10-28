# Dev helper: starts the tracker (port 4301) against the STAGING Supabase project (synthetic users only) with the
# fake UFS People directory (port 4311). Needs server\.staging-local\env.ps1 (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY).
# Data lives in server\data-staging (disposable). Stop with: powershell -File server\stop-staging.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$local = Join-Path $PSScriptRoot '.staging-local'
if (-not (Test-Path (Join-Path $local 'env.ps1'))) { throw 'Missing .staging-local\env.ps1 (see STAGING-SUPABASE.md).' }
. (Join-Path $local 'env.ps1')
foreach ($port in 4301, 4311) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }
$ownerFile = Join-Path $local 'breakglass.json'
if (-not (Test-Path $ownerFile)) {
  $pw = (-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })) + 'aA1!'
  @{ email = 'breakglass@tracker-staging.example.test'; password = $pw } | ConvertTo-Json | Set-Content $ownerFile -Encoding utf8
}
$owner = Get-Content $ownerFile -Raw | ConvertFrom-Json
$data = Join-Path $PSScriptRoot 'data-staging'
if ($args -contains '-Fresh') { Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue }
Start-Process -FilePath node -ArgumentList 'src/fake-directory.ts', '4311' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP 'stg-dir.log') -RedirectStandardError (Join-Path $env:TEMP 'stg-dir.err')
Start-Sleep 2
$env:TRACKER_DATA_DIR = $data; $env:PORT = '4301'
$env:TRACKER_OWNER_EMAIL = $owner.email; $env:TRACKER_OWNER_PASSWORD = $owner.password
# Dev-only token; matches FAKE_TOKEN in src/fake-directory.ts. Never use it against a real directory.
$env:DIRECTORY_URL = 'http://127.0.0.1:4311/directory.json'; $env:DIRECTORY_TOKEN = 'fake-directory-token-for-local-dev-only'; $env:DIRECTORY_OWNER_EMPLOYEE_ID = 'emp-001'
Start-Process -FilePath node -ArgumentList 'src/server.ts' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP 'stg-srv.log') -RedirectStandardError (Join-Path $env:TEMP 'stg-srv.err')
Start-Sleep 6
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4301/api/health).Content
Write-Host 'Tracker: http://127.0.0.1:4301  (sign in with a fake staff email from .staging-local\accounts.json)'
