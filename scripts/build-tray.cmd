@echo off
:: Build BudgetDispatcher.exe from tray-app.cs using the .NET Framework C# compiler.
:: No SDK install needed -- csc.exe ships with Windows.

cd /d "%~dp0.."
if not exist bin mkdir bin

C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /target:winexe ^
  /win32icon:assets\tray-green.ico ^
  /out:bin\BudgetDispatcher.exe ^
  /r:System.Windows.Forms.dll ^
  /r:System.Drawing.dll ^
  /r:System.Web.Extensions.dll ^
  scripts\tray-app.cs

if %errorlevel%==0 (
    echo.
    echo Build succeeded: bin\BudgetDispatcher.exe
) else (
    echo.
    echo Build FAILED
    exit /b 1
)
