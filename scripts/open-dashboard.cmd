@echo off
REM Budget Dispatcher Dashboard -- opens as a pinnable Chrome app window.
REM Pin this shortcut to the taskbar for one-click access.
REM The dashboard server must already be running (via scheduled task or manual start).

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:7380 --window-size=1024,800
