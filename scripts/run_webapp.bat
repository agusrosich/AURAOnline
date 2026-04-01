@echo off
setlocal EnableExtensions

set "EXIT_CODE=0"
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
for %%I in ("%REPO_ROOT%\webapp") do set "WEBAPP_DIR=%%~fI"

if not exist "%WEBAPP_DIR%" (
    echo No se encontro la carpeta webapp en:
    echo %WEBAPP_DIR%
    set "EXIT_CODE=1"
    goto :finish
)

call :resolve_npm
if errorlevel 1 (
    set "EXIT_CODE=1"
    goto :finish
)

pushd "%WEBAPP_DIR%" >nul 2>&1
if errorlevel 1 (
    echo No se pudo abrir la carpeta webapp en:
    echo %WEBAPP_DIR%
    set "EXIT_CODE=1"
    goto :finish
)

if exist ".env.example" if not exist ".env" (
    copy /Y ".env.example" ".env" >nul
)

if not exist "node_modules" (
    echo Instalando dependencias de la webapp...
    call "%NPM_CMD%" install
    if errorlevel 1 (
        echo npm install fallo.
        set "EXIT_CODE=1"
        goto :cleanup
    )
)

echo Iniciando webapp en http://127.0.0.1:5173
call "%NPM_CMD%" run dev -- --open
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo La webapp se cerro con error %EXIT_CODE%.
)

:cleanup
popd

:finish
if not "%EXIT_CODE%"=="0" call :maybe_pause
exit /b %EXIT_CODE%

:resolve_npm
where npm.cmd >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%I in ('where npm.cmd') do (
        set "NPM_CMD=%%I"
        goto :eof
    )
)

if exist "%ProgramFiles%\nodejs\npm.cmd" (
    set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
    goto :eof
)

if defined ProgramFiles(x86) if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" (
    set "NPM_CMD=%ProgramFiles(x86)%\nodejs\npm.cmd"
    goto :eof
)

if defined LocalAppData if exist "%LocalAppData%\Programs\nodejs\npm.cmd" (
    set "NPM_CMD=%LocalAppData%\Programs\nodejs\npm.cmd"
    goto :eof
)

echo npm no esta disponible en PATH ni en las rutas tipicas de Node.js.
echo Instala Node.js 18+ y asegurate de incluir npm en PATH antes de ejecutar este lanzador.
echo.
echo Opcion recomendada en Windows:
echo   winget install OpenJS.NodeJS.LTS
echo.
echo O descarga el instalador LTS y activa la opcion "Add to PATH".
exit /b 1

:maybe_pause
if not defined AURA_RT_NO_PAUSE pause
goto :eof
