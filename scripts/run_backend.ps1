$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend"
$envFile = Join-Path $backendDir ".env"
$legacyCorsOrigins = "http://localhost:5173,http://127.0.0.1:5173"

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*$' -or $_ -match '^\s*#') {
            return
        }
        $parts = $_ -split '=', 2
        if ($parts.Length -eq 2) {
            [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
        }
    }
}

if (-not $env:AURA_RT_HOST) { $env:AURA_RT_HOST = "0.0.0.0" }
if (-not $env:AURA_RT_PORT) { $env:AURA_RT_PORT = "8000" }
if (-not $env:AURA_RT_CORS_ORIGINS -or $env:AURA_RT_CORS_ORIGINS -eq $legacyCorsOrigins) { $env:AURA_RT_CORS_ORIGINS = "*" }

python -m uvicorn aura_rt_backend.main:app --app-dir $backendDir --host $env:AURA_RT_HOST --port $env:AURA_RT_PORT
