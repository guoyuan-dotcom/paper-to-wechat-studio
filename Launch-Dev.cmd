@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 18+ is required.
  pause
  exit /b 1
)

echo [1/4] Clearing old processes on ports 3000 and 3001...
for %%P in (3000 3001) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    taskkill /F /PID %%I >nul 2>nul
  )
)

echo [2/4] Checking backend dependencies...
if not exist "%ROOT%backend\node_modules" (
  pushd "%ROOT%backend"
  call npm install
  if errorlevel 1 (
    echo [ERROR] Backend dependency install failed.
    popd
    pause
    exit /b 1
  )
  popd
)

echo [3/4] Checking frontend dependencies...
if not exist "%ROOT%frontend\node_modules" (
  pushd "%ROOT%frontend"
  call npm install
  if errorlevel 1 (
    echo [ERROR] Frontend dependency install failed.
    popd
    pause
    exit /b 1
  )
  popd
)

echo [4/4] Starting backend and frontend...
start "Research Workbench Backend" cmd /k "cd /d ""%ROOT%backend"" && npm start"
start "Research Workbench Frontend" cmd /k "cd /d ""%ROOT%frontend"" && npm run dev"

timeout /t 4 /nobreak >nul
start "" http://localhost:3000

echo.
echo Started:
echo - Frontend: http://localhost:3000
echo - Backend: http://localhost:3001
echo.
echo Enter your own Kimi API Key in the page before generating.
exit /b 0
