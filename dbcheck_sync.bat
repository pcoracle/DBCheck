@echo off
cd /d "%~dp0"
"C:\Users\fanzh\.workbuddy\binaries\python\versions\3.13.12\python.exe" -X utf8 "%~dp0dbcheck_sync.py"
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
    echo.
    echo [dbcheck_sync] 同步未成功完成（退出码 %RC%）。
    echo   若提示"无可用代理"，请确认代理客户端已启动；或直接用本地缓存解包（已内置缓存优先逻辑）。
)
echo.
echo 按任意键关闭窗口...
pause >nul
