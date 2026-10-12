@echo off
title FlexERP Launcher
echo ====================================================
echo   Starting Flex ERP (Backend + Frontend)
echo ====================================================
echo.

start "FlexERP-Backend-3000" cmd /c "node server.js"
start "FlexERP-Frontend-Vite" cmd /c "npm run dev"

timeout /t 3 >nul
start http://localhost:5173
echo All services launched!

