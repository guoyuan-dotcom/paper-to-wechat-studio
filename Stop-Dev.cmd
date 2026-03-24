@echo off
setlocal

echo Stopping processes on ports 3000 and 3001...
for %%P in (3000 3001) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    taskkill /F /PID %%I >nul 2>nul
  )
)

echo Done.
exit /b 0
