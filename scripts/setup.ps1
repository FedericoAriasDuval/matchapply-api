# =====================================================================
# MatchApply — instalación en Windows (PowerShell)
#   Uso:  cd matchapply ;  ./scripts/setup.ps1
# =====================================================================
$ErrorActionPreference = 'Stop'
Write-Host "`n=== MatchApply — setup ===`n" -ForegroundColor Cyan

# 1) Node
try {
  $node = (node -v)
  Write-Host "Node detectado: $node" -ForegroundColor Green
  if ([int]($node -replace 'v(\d+)\..*', '$1') -lt 20) { throw "Necesitás Node 20 o superior." }
} catch {
  Write-Host "No encontré Node.js. Instalalo desde https://nodejs.org (LTS) y volvé a correr esto." -ForegroundColor Red
  exit 1
}

# 2) .env con un JWT_SECRET aleatorio real
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  $bytes = New-Object byte[] 64
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  (Get-Content .env) -replace '^JWT_SECRET=.*', "JWT_SECRET=$secret" | Set-Content .env
  Write-Host "Creé .env con un JWT_SECRET aleatorio." -ForegroundColor Green
  Write-Host "Editá .env y completá DATABASE_URL (y ANTHROPIC_API_KEY si querés la IA real)." -ForegroundColor Yellow
} else {
  Write-Host ".env ya existe: no lo toco." -ForegroundColor DarkGray
}

# 3) Dependencias
Write-Host "`nInstalando dependencias..." -ForegroundColor Cyan
npm install

# 4) Tests (no necesitan base de datos)
Write-Host "`nCorriendo tests..." -ForegroundColor Cyan
npm test

# 5) Migración + arranque
$dbUrl = (Get-Content .env | Select-String '^DATABASE_URL=(.*)$').Matches.Groups[1].Value
if ($dbUrl -and $dbUrl -notmatch 'user:pass@host') {
  Write-Host "`nAplicando migraciones..." -ForegroundColor Cyan
  npm run migrate
  Write-Host "`nListo. Arrancá con:  npm start   (API en http://localhost:8080/health)" -ForegroundColor Green
} else {
  Write-Host "`nFalta DATABASE_URL en .env." -ForegroundColor Yellow
  Write-Host "Opción rápida y gratis: creá una base en https://neon.tech y pegá la connection string." -ForegroundColor Yellow
  Write-Host "Después:  npm run migrate  ;  npm start" -ForegroundColor Yellow
}

Write-Host "`nEl frontend NO necesita instalación: abrí web\index.html con doble clic.`n" -ForegroundColor Cyan
