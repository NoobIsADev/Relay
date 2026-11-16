@echo off
setlocal
cd /d "%~dp0"
where npm.cmd >nul 2>&1 || (echo Install Node.js 22.12 or later first. & exit /b 1)
where git.exe >nul 2>&1 || (echo Install Git first. & exit /b 1)
where gh.exe >nul 2>&1 || (echo Install the GitHub CLI first. & exit /b 1)
gh auth status --hostname github.com >nul 2>&1 || (echo Sign in with gh auth login first. & exit /b 1)
call npm.cmd run release -- %*
if errorlevel 1 (
  echo.
  echo Release failed. Review the error above, then run this file again.
  pause
  exit /b 1
)
echo.
pause
