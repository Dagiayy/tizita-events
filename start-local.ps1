# Starts everything for local development. Run from the repo root:  powershell -ExecutionPolicy Bypass -File .\start-local.ps1
#   Web app / host console / admin  http://localhost:3100      Flutter app in Chrome  http://localhost:5000      API  http://localhost:4000
$root = $PSScriptRoot
if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue)) { Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"; Write-Host "Starting Docker Desktop (wait ~30s)..."; Start-Sleep 40 }
docker compose -f "$root\infra\docker-compose.yml" --env-file "$root\.env" up -d
Push-Location "$root\apps\api"; npm run migrate; Pop-Location
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\apps\api'; npm run start:dev"
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\apps\web'; npx next dev -p 3100"
if (-not (Test-Path "$root\apps\mobile\build\web")) { Push-Location "$root\apps\mobile"; flutter build web --dart-define=API_BASE=http://localhost:4000; Pop-Location }
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\apps\mobile\build\web'; python -m http.server 5000"
Write-Host "`nWeb      http://localhost:3100`nFlutter  http://localhost:5000`nAPI      http://localhost:4000"
