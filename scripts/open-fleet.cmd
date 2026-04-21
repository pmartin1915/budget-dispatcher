@echo off
REM Fleet Dashboard -- opens as a pinnable app window.
REM Pin this shortcut to the taskbar for one-click fleet monitoring.
REM
REM Works with Chrome or Edge. Tries Chrome first, falls back to Edge.
REM The page loads from GitHub Pages (no local server needed).

set "URL=https://pmartin1915.github.io/budget-dispatcher/fleet-dashboard.html"

where chrome >nul 2>nul
if %errorlevel% equ 0 (
    start "" chrome --app="%URL%" --window-size=420,700
    exit /b
)

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app="%URL%" --window-size=420,700
    exit /b
)

if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app="%URL%" --window-size=420,700
    exit /b
)

REM Fallback: open in default browser
start "" "%URL%"
