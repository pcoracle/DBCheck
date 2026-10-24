@echo off
REM SPDX-License-Identifier: Apache-2.0
REM Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
REM Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
REM ---------------------------------------------------------------------
REM  DBCheck Windows launcher (double-click / shortcut / cmd).
REM
REM  Notes:
REM    - Switches to the script directory (repo root) so web_ui.py,
REM      deploy\, modules\ and data\ relative paths resolve correctly.
REM    - Prefers the in-repo .venv; creates one with system Python if absent.
REM    - Dependencies live in deploy\requirements.txt (NOT root requirements.txt).
REM    - Port is fixed at 5003 in modules\web\app.py main().
REM
REM  Keep this file ASCII-only: cmd.exe parses .bat bytes with the OEM
REM  code page, so UTF-8 Chinese text breaks the parser before chcp runs.
REM ---------------------------------------------------------------------

REM Set the title early: a window showing only the cmd.exe path is easy to close by mistake.
title DBCheck Web UI  [starting]  - DO NOT CLOSE
setlocal EnableExtensions
chcp 65001 >nul

REM Pin Python stdio to UTF-8 so Chinese startup logs cannot crash the console.
REM Without this a Chinese print raises UnicodeEncodeError and exits with code 120.
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

REM Always run from the repository root.
cd /d "%~dp0"

set "VENV_DIR=.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "REQ_FILE=deploy\requirements.txt"
REM Must match the port used in modules\web\app.py main().
set "PORT=5003"

call :init_ts
title DBCheck Web UI  [starting]  - DO NOT CLOSE
call :log "========================================"
call :log "  DBCheck - Database Health Inspection"
call :log "========================================"
echo.

REM ---------------------------------------------------------------------
REM [1/4] Python virtual environment
REM ---------------------------------------------------------------------
call :log "[1/4] Checking Python virtual environment..."
set "NEED_VENV="
if not exist "%VENV_PY%" set "NEED_VENV=1"
if not exist "%VENV_DIR%\pyvenv.cfg" set "NEED_VENV=1"

if defined NEED_VENV (
    REM Missing, copied, or trimmed venv: rebuild it from scratch.
    REM Without pyvenv.cfg every .venv python call fails with "No pyvenv.cfg file".
    if exist "%VENV_DIR%" (
        call :log "      .venv is missing or broken, rebuilding (Python 3.9+ required)..."
    ) else (
        call :log "      .venv not found, creating (Python 3.9+ required)..."
    )

    set "VENV_CREATED="
    where python >nul 2>&1 && (
        python -m venv --clear "%VENV_DIR%" && set "VENV_CREATED=1"
    )
    if not defined VENV_CREATED (
        where py >nul 2>&1 && (
            py -3 -m venv --clear "%VENV_DIR%" && set "VENV_CREATED=1"
        )
    )

    if not exist "%VENV_PY%" (
        call :log "      [ERROR] Failed to create the virtual environment."
        call :log "              Install Python 3.9+ (with Add to PATH), then retry."
        pause
        exit /b 1
    )
)

REM A copied or trimmed venv may lack pip; repair it.
if not exist "%VENV_DIR%\Scripts\pip.exe" (
    call :log "      venv has no pip, repairing..."
    "%VENV_PY%" -m ensurepip --upgrade >nul 2>&1
)
"%VENV_PY%" -m pip install --upgrade pip >nul 2>&1

REM ---------------------------------------------------------------------
REM [2/4] Runtime dependencies
REM ---------------------------------------------------------------------
call :log "[2/4] Checking runtime dependencies..."
"%VENV_PY%" -c "import flask, flask_socketio, gevent, psutil" >nul 2>&1
if errorlevel 1 (
    if not exist "%REQ_FILE%" (
        call :log "      [ERROR] Requirements file not found: %REQ_FILE%"
        pause
        exit /b 1
    )
    call :log "      Dependencies missing, installing %REQ_FILE% ..."
    call :log "      (First install can take a while, please wait)"
    "%VENV_PY%" -m pip install -r "%REQ_FILE%"
    if errorlevel 1 (
        REM The full list includes dmpython / gbase8sdb, which need vendor SDKs
        REM and may not install on Windows. Keep the Web UI runnable at least.
        call :log "      [WARN] Full install failed, installing Web UI essentials..."
        "%VENV_PY%" -m pip install flask flask-socketio gevent Werkzeug psutil PyYAML python-docx docxtpl cryptography requests croniter
        if errorlevel 1 (
            call :log "      [ERROR] Dependency installation failed. Check network / pip index."
            call :log "              Manual: .venv\Scripts\python.exe -m pip install -r deploy\requirements.txt"
            pause
            exit /b 1
        )
    )
    "%VENV_PY%" -c "import flask, flask_socketio, gevent, psutil" >nul 2>&1
    if errorlevel 1 (
        call :log "      [ERROR] Dependencies are still incomplete, cannot start."
        pause
        exit /b 1
    )
    call :log "      Dependencies installed."
)

REM ---------------------------------------------------------------------
REM [3/4] Port check
REM ---------------------------------------------------------------------
call :log "[3/4] Checking port %PORT%..."
set "PIDS="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do call :addpid %%a
if defined PIDS goto :port_busy
call :log "      Port %PORT% is free."
goto :port_ok

:port_busy
call :log "      [WARN] Port %PORT% is already in use (PID:%PIDS%)"
call :log "             DBCheck may already be running: http://localhost:%PORT%"
call :log "             This launcher will NOT stop it automatically."
choice /C YN /N /M "             Stop the existing instance and continue? [Y/N]: "
if errorlevel 2 goto :cancelled
for %%p in (%PIDS%) do (
    call :log "      Stopping PID=%%p"
    taskkill /PID %%p /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:port_ok
REM ---------------------------------------------------------------------
REM [4/4] Start
REM ---------------------------------------------------------------------
call :log "[4/4] Starting DBCheck..."
title DBCheck Web UI  port %PORT%  - DO NOT CLOSE
echo.
call :log "  URL   : http://localhost:%PORT%"
call :log "  Login : admin / admin123"
call :log "  Press Ctrl+C to stop the service"
call :log "========================================"
echo.

"%VENV_PY%" web_ui.py
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    call :log "[WARN] DBCheck exited with code %EXIT_CODE%"
) else (
    call :log "DBCheck stopped."
)
pause
endlocal & exit /b %EXIT_CODE%

:cancelled
call :log "      Cancelled - the existing instance was left running."
echo.
pause
endlocal & exit /b 0

:addpid
if defined PIDS (set "PIDS=%PIDS%,%1") else (set "PIDS=%1")
exit /b 0

:log
REM Timestamp prefix for every line shown in this log window.
REM Callers must pass plain text only: %~1 strips quotes, so cmd
REM metacharacters ( > < | & ) would be parsed as redirection or pipes.
call :init_ts
set "TS_NOW=%time: =0%"
echo [%TS_DATE% %TS_NOW:~0,8%] %~1
exit /b 0

:init_ts
REM Fetch the date once per window and cache it in TS_DATE.
REM PowerShell gives a locale-independent ISO date; %date% is the fallback.
if defined TS_DATE exit /b 0
set "TS_DATE="
for /f "delims=" %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd" 2^>nul') do set "TS_DATE=%%a"
if not defined TS_DATE set "TS_DATE=%date%"
exit /b 0
