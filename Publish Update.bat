@echo off
rem Publish a new version: bumps the version in the app, commits everything, tags it and pushes.
rem GitHub then rebuilds the website (about 1 minute) and the download zip (about 1 minute).
setlocal
cd /d "%~dp0"
for /f "tokens=2 delims='" %%v in ('findstr /c:"const OW_VERSION" open-overwatch.html') do set CUR=%%v
echo Current version: %CUR%
set /p VER=New version number (e.g. 0.6): 
if "%VER%"=="" goto :eof
set /p MSG=What changed? (one line): 
if "%MSG%"=="" set MSG=Update
powershell -NoProfile -Command "(Get-Content -Raw -Encoding UTF8 'open-overwatch.html') -replace \"const OW_VERSION = '[^']*'\", \"const OW_VERSION = '%VER%'\" | Set-Content -NoNewline -Encoding UTF8 'open-overwatch.html'"
git add -A || goto :fail
git commit -m "v%VER%: %MSG%" || goto :fail
git tag -a "v%VER%" -m "%MSG%" || goto :fail
git push origin main --follow-tags || goto :fail
echo.
echo Done. Site:     https://cwbhood.github.io/open-overwatch/
echo       Release:  https://github.com/cwbhood/open-overwatch/releases/tag/v%VER%
pause
goto :eof
:fail
echo Something went wrong - nothing above this line was undone. Check the message and try again.
pause
