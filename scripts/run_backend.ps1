$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend"
$envFile = Join-Path $backendDir ".env"
$envExampleFile = Join-Path $backendDir ".env.example"
$requirementsFile = Join-Path $backendDir "requirements-colab.txt"
$legacyCorsOrigins = "http://localhost:5173,http://127.0.0.1:5173"

if (-not (Test-Path $backendDir)) {
    throw "No se encontro la carpeta backend en: $backendDir"
}

if ((Test-Path $envExampleFile) -and -not (Test-Path $envFile)) {
    Copy-Item $envExampleFile $envFile
}

function Resolve-PythonPath {
    param(
        [string]$RepoRoot,
        [string]$BackendRoot
    )

    $candidatePaths = @(
        Join-Path $RepoRoot ".venv\Scripts\python.exe"
        Join-Path $BackendRoot ".venv\Scripts\python.exe"
    ) | Where-Object { Test-Path $_ }

    if ($candidatePaths.Count -gt 0) {
        return $candidatePaths[0]
    }

    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        return $pythonCommand.Source
    }

    throw "Python no esta disponible. Crea un entorno virtual o instala Python 3.9+ y agregalo a PATH."
}

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

$pythonPath = Resolve-PythonPath -RepoRoot $repoRoot -BackendRoot $backendDir

& $pythonPath -c "import fastapi, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Faltan dependencias del backend en $pythonPath. Ejecuta: `"$pythonPath`" -m pip install -r `"$requirementsFile`""
}

Write-Host "Iniciando backend en http://127.0.0.1:$($env:AURA_RT_PORT) con Python: $pythonPath"
& $pythonPath -m uvicorn aura_rt_backend.main:app --app-dir $backendDir --host $env:AURA_RT_HOST --port $env:AURA_RT_PORT

if ($LASTEXITCODE -ne 0) {
    throw "uvicorn finalizo con codigo $LASTEXITCODE."
}
