#Requires -Version 5.1
param(
    [switch]$NoLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    OK  $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "    WARN $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg) Write-Host "    FAIL $Msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# 1. Check prerequisites
# ---------------------------------------------------------------------------
Write-Step "Checking prerequisites"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Fail "Node.js not found. Install Node.js 20.x LTS from https://nodejs.org/en/download and re-run."
}
$nodeVersion = (node --version) -replace 'v', ''
$nodeMajor   = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 20) {
    Write-Fail "Node.js $nodeVersion found but 20.x or newer is required. Update from https://nodejs.org/en/download."
}
Write-Ok "Node.js v$nodeVersion"

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) { Write-Fail "npm not found -- reinstall Node.js." }
Write-Ok "npm $((npm --version))"

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Warn "Git not found. Install from https://git-scm.com/download/win. Git is not required to finish setup, continuing."
} else {
    Write-Ok "git $((git --version))"
}

# ---------------------------------------------------------------------------
# 2. Confirm we are in the repo root
# ---------------------------------------------------------------------------
Write-Step "Verifying working directory"

$repoRoot = $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) {
    Write-Fail "package.json not found under $repoRoot. Run this script from the BoardBI repo root."
}
if (-not (Test-Path (Join-Path $repoRoot 'server\package.json'))) {
    Write-Fail "server\package.json not found. Repo may be incomplete."
}
Set-Location $repoRoot
Write-Ok "Working directory: $repoRoot"

# ---------------------------------------------------------------------------
# 3. Install root dependencies
# ---------------------------------------------------------------------------
Write-Step "Installing root (frontend) dependencies"
npm install
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed." }
Write-Ok "Root dependencies installed"

# ---------------------------------------------------------------------------
# 4. Install server dependencies
# ---------------------------------------------------------------------------
Write-Step "Installing server dependencies"
npm --prefix server install
if ($LASTEXITCODE -ne 0) { Write-Fail "npm --prefix server install failed." }
Write-Ok "Server dependencies installed"

# ---------------------------------------------------------------------------
# 5. Create server/.env (skip if already present)
# ---------------------------------------------------------------------------
Write-Step "Setting up server/.env"

$envFile    = Join-Path $repoRoot 'server\.env'
$envExample = Join-Path $repoRoot 'server\.env.example'

if (Test-Path $envFile) {
    Write-Warn "server\.env already exists -- skipping creation. Remove it manually to regenerate."
} else {
    if (-not (Test-Path $envExample)) {
        Write-Fail "server\.env.example not found. Cannot create .env."
    }
    Copy-Item $envExample $envFile
    Write-Ok "Copied server\.env.example -> server\.env"

    $key = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    if ($LASTEXITCODE -ne 0 -or -not $key) {
        Write-Fail "Failed to generate APP_ENCRYPTION_KEY."
    }

    $envContent = Get-Content $envFile -Raw
    $envContent = $envContent -replace '(?m)^APP_ENCRYPTION_KEY=\s*$', "APP_ENCRYPTION_KEY=$key"
    Set-Content -Path $envFile -Value $envContent -Encoding utf8 -NoNewline
    Write-Ok "APP_ENCRYPTION_KEY generated and written to server\.env"
    Write-Warn "Keep server\.env private -- it is gitignored. Rotating APP_ENCRYPTION_KEY later will invalidate stored JIRA tokens."
}

$envLines = Get-Content $envFile
$keyLine  = $envLines | Where-Object { $_ -match '^APP_ENCRYPTION_KEY=.+' }
if (-not $keyLine) {
    Write-Fail "APP_ENCRYPTION_KEY is still empty in server\.env. Open the file and set it before continuing."
}

# ---------------------------------------------------------------------------
# 6. Run database migrations
# ---------------------------------------------------------------------------
Write-Step "Running database migrations"
npm run db:migrate
if ($LASTEXITCODE -ne 0) { Write-Fail "db:migrate failed. Check the output above." }
Write-Ok "Database ready (server/prisma/dev.db)"

# ---------------------------------------------------------------------------
# 7. Done
# ---------------------------------------------------------------------------
Write-Step "Setup complete"
Write-Host ""
Write-Host "  Next steps inside the app" -ForegroundColor White
Write-Host "  --------------------------" -ForegroundColor White
Write-Host "  1. Open http://localhost:5173 in your browser." -ForegroundColor White
Write-Host "  2. Go to Connections -> add a JIRA connection" -ForegroundColor White
Write-Host "     (site URL, email, API token from https://id.atlassian.com/manage-profile/security/api-tokens)." -ForegroundColor White
Write-Host "     Click Test before saving." -ForegroundColor White
Write-Host "  3. Go to Reports -> New report, pick the connection, write a JQL query, save." -ForegroundColor White
Write-Host "  4. Open the report, add gadgets and slicers, then refresh data." -ForegroundColor White
Write-Host ""

if (-not $NoLaunch) {
    $launch = Read-Host "Launch the app now? (Y/n)"
    if ($launch -eq '' -or $launch -match '^[Yy]') {
        Write-Host "`nStarting BoardBI (Ctrl+C to stop)..." -ForegroundColor Cyan
        Write-Host "  Web  -> http://localhost:5173"
        Write-Host "  API  -> http://localhost:3001"
        npm run dev
    } else {
        Write-Host "`nRun 'npm run dev' when you are ready." -ForegroundColor Cyan
    }
}
