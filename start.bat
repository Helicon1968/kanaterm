@echo off
rem kanaterm launcher.
rem
rem IMPORTANT: keep this file ASCII-only, CRLF, and without a BOM.
rem   cmd.exe decodes a .bat using the console code page, which differs
rem   per machine (932 on Japanese Windows, 65001 when UTF-8 is enabled).
rem   Non-ASCII text here is decoded with the wrong code page and can
rem   corrupt parsing, so the launcher speaks English on purpose.
rem   LF-only line endings break multi-line if blocks, and a BOM is read
rem   as a command. See docs/HISTORY.md for the details.
cd /d "%~dp0"

if not exist node_modules (
    echo node_modules not found. Running npm install ^(first time only^)...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

rem The electron package has no postinstall script: the ~200 MB runtime is
rem downloaded the first time it is launched. Download it here instead, so a
rem failure is reported up front with a command that actually works.
rem (The electron package itself suggests "npx install-electron --no" on
rem  failure, but install.js takes no arguments and npx cannot resolve the
rem  name unless the package is already installed, so that form fails.)
if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron runtime not found. Downloading it now ^(about 200 MB, first time only^)...
    call node "node_modules\electron\install.js"
    if errorlevel 1 (
        echo.
        echo Failed to download the Electron runtime.
        echo Retry with this command in this folder:
        echo     node node_modules\electron\install.js
        echo Behind a proxy, set HTTPS_PROXY first.
        echo To use a mirror, set ELECTRON_MIRROR.
        pause
        exit /b 1
    )
)

call npm start
if errorlevel 1 (
    echo Failed to start kanaterm. Check the log above.
    pause
)
