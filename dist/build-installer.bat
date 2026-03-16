@echo off
echo Building LMU Pitwall Installer...
echo.
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "%~dp0installer\lmu-pitwall-installer.iss"
if errorlevel 1 (
    echo.
    echo ERROR: Inno Setup not found.
    echo Please install Inno Setup 6 from: https://jrsoftware.org/isdl.php
    pause
    exit /b 1
)
echo.
echo Done! Installer created: installer\LMU-Pitwall-Setup-1.0.35.exe
echo.
pause
