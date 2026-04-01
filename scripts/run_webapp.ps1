$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$webappDir = Join-Path $repoRoot "webapp"

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    $candidatePaths = @(
        Join-Path ${env:ProgramFiles} "nodejs\npm.cmd"
        Join-Path ${env:ProgramFiles(x86)} "nodejs\npm.cmd"
    ) | Where-Object { $_ -and (Test-Path $_) }

    if ($candidatePaths.Count -gt 0) {
        $npmPath = $candidatePaths[0]
    } else {
        throw "npm no esta disponible. Instala Node.js 18+ y asegurate de incluir npm en PATH."
    }
} else {
    $npmPath = $npmCommand.Source
}

Push-Location $webappDir
try {
    if ((Test-Path ".env.example") -and -not (Test-Path ".env")) {
        Copy-Item ".env.example" ".env"
    }

    if (-not (Test-Path "node_modules")) {
        & $npmPath install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install fallo con codigo $LASTEXITCODE."
        }
    }

    & $npmPath run dev -- --open
    if ($LASTEXITCODE -ne 0) {
        throw "npm run dev fallo con codigo $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
