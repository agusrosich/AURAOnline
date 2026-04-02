@echo off
setlocal EnableExtensions

set "EXIT_CODE=0"
set "SCRIPT_DIR=%~dp0"
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "SCRIPT_PATH=%SCRIPT_DIR%run_backend.ps1"

if not exist "%SCRIPT_PATH%" (
    echo No se encontro el script PowerShell en:
    echo %SCRIPT_PATH%
    set "EXIT_CODE=1"
    goto :finish
)

if not exist "%POWERSHELL_EXE%" (
    echo No se encontro powershell.exe en:
    echo %POWERSHELL_EXE%
    set "EXIT_CODE=1"
    goto :finish
)

call "%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_PATH%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo El backend se cerro con error %EXIT_CODE%.
)

:finish
if not "%EXIT_CODE%"=="0" if not defined AURA_RT_NO_PAUSE pause
exit /b %EXIT_CODE%
