@echo off
rem kanaterm を起動する。このバッチファイル自身の場所を基準にするので、
rem どこからダブルクリックしても正しく動く。
cd /d "%~dp0"

if not exist node_modules (
    echo node_modules が見つかりません。初回のみ npm install を実行します...
    call npm install
    if errorlevel 1 (
        echo npm install に失敗しました。
        pause
        exit /b 1
    )
)

call npm start
if errorlevel 1 (
    echo kanaterm の起動に失敗しました。上のログを確認してください。
    pause
)
