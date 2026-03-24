@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 需要先安装 Node.js 18 及以上版本。
  pause
  exit /b 1
)

echo [1/4] 正在清理 3000 和 3001 端口上的旧进程...
for %%P in (3000 3001) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    taskkill /F /PID %%I >nul 2>nul
  )
)

echo [2/4] 正在检查后端依赖...
if not exist "%ROOT%backend\node_modules" (
  pushd "%ROOT%backend"
  call npm install
  if errorlevel 1 (
  echo [ERROR] 后端依赖安装失败。
    popd
    pause
    exit /b 1
  )
  popd
)

echo [3/4] 正在检查前端依赖...
if not exist "%ROOT%frontend\node_modules" (
  pushd "%ROOT%frontend"
  call npm install
  if errorlevel 1 (
  echo [ERROR] 前端依赖安装失败。
    popd
    pause
    exit /b 1
  )
  popd
)

echo [4/4] 正在启动前端和后端...
start "论文转公众号工作台 后端" cmd /k "cd /d ""%ROOT%backend"" && npm start"
start "论文转公众号工作台 前端" cmd /k "cd /d ""%ROOT%frontend"" && npm run dev"

timeout /t 4 /nobreak >nul
start "" http://localhost:3000

echo.
echo 已启动：
echo - 前端: http://localhost:3000
echo - 后端: http://localhost:3001
echo.
echo 生成前请在页面里输入你自己的 Kimi API 密钥。
exit /b 0
