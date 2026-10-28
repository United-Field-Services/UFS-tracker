# Stops the staging tracker (4301) and fake directory (4311).
foreach ($port in 4301, 4311) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }
Write-Host 'Staging services stopped.'
