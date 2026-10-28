# Dev helper: stops any demo servers, re-seeds a fresh demo database, starts a FAKE UFS People directory (synthetic
# people, port 4310), a FAKE Supabase Auth (same people, port 4320) and the tracker server (port 4300) wired to both.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
foreach ($port in 4300, 4310, 4320) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }
Start-Sleep 1
Remove-Item -Recurse -Force data-demo -ErrorAction SilentlyContinue
$env:TRACKER_DATA_DIR = Join-Path $PSScriptRoot 'data-demo'
node src/seed-demo.ts
Start-Process -FilePath node -ArgumentList 'src/fake-directory.ts', '4310' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP 'fake-directory.log') -RedirectStandardError (Join-Path $env:TEMP 'fake-directory.err')
Start-Process -FilePath node -ArgumentList 'src/fake-supabase.ts', '4320' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP 'fake-supabase.log') -RedirectStandardError (Join-Path $env:TEMP 'fake-supabase.err')
Start-Sleep 2
# Dev-only token; matches FAKE_TOKEN in src/fake-directory.ts. Never use it against a real directory.
$env:DIRECTORY_URL = 'http://127.0.0.1:4310/directory.json'
$env:DIRECTORY_TOKEN = 'fake-directory-token-for-local-dev-only'
$env:DIRECTORY_OWNER_EMPLOYEE_ID = 'emp-001'
$env:SUPABASE_URL = 'http://127.0.0.1:4320'
$env:SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_fake_local_dev_key_0123456789'
Start-Process -FilePath node -ArgumentList 'src/server.ts' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP 'tracker-server.log') -RedirectStandardError (Join-Path $env:TEMP 'tracker-server.err')
Start-Sleep 4
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4300/api/health).Content
