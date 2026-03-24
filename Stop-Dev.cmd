@echo off
setlocal

echo 正在关闭 3000 和 3001 端口上的进程...
for %%P in (3000 3001) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    taskkill /F /PID %%I >nul 2>nul
  )
)

echo 已关闭。
exit /b 0
