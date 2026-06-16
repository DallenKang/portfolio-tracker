@echo off
cd /d "%~dp0"
rem 先关掉还占着 8745 端口的旧服务器（今天就是旧进程没关，导致抢不到端口、跑旧代码）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8745 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
rem 开服务器（独立窗口，别关这个）
start "Portfolio Tracker Server - 别关这个窗口 Keep this open" python server.py
rem 等服务器起来再开网页，避免一打开就 Failed to fetch
timeout /t 2 /nobreak >nul
start "" "http://localhost:8745/portfolio-tracker.html"
