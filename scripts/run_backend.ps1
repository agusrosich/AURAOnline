$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend"
$envFile = Join-Path $backendDir ".env"

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

python -m uvicorn aura_rt_backend.main:app --app-dir $backendDir --host $env:AURA_RT_HOST --port $env:AURA_RT_PORT

