@echo off
rem Workflow Manager launcher: double-click to install missing Node.js/packages and start the app.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
if errorlevel 1 pause
