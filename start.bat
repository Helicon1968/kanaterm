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

call npm start
if errorlevel 1 (
    echo Failed to start kanaterm. Check the log above.
    pause
)
