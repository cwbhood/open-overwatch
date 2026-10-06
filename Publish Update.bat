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
rem No carets or inner double quotes in this line (cmd strips ^ outside its quote pairing, which broke the pattern),
rem and write UTF-8 without a BOM (Windows PowerShell's Set-Content -Encoding UTF8 adds one).
powershell -NoProfile -Command "$f = Join-Path (Get-Location) 'open-overwatch.html'; $t = [IO.File]::ReadAllText($f); $t = $t -replace 'const OW_VERSION = ''[0-9A-Za-z.\-]*''', 'const OW_VERSION = ''%VER%'''; [IO.File]::WriteAllText($f, $t, (New-Object Text.UTF8Encoding $false))"
findstr /c:"const OW_VERSION = '%VER%'" open-overwatch.html >nul || (echo The version number in open-overwatch.html was not updated. & goto :fail)
git add -A || goto :fail
git commit -m "v%VER%: %MSG%" || goto :fail
git tag -a "v%VER%" -m "%MSG%" || goto :fail
git push origin main --follow-tags || goto :fail
echo.
echo Done. Site:     https://destinjones.github.io/open-overwatch/
echo       Release:  https://github.com/destinjones/open-overwatch/releases/tag/v%VER%
pause
goto :eof
:fail
echo Something went wrong - nothing above this line was undone. Check the message and try again.
pause
