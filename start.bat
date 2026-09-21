@echo off
rem Desktop Pet launcher: runs bundled electron directly, no npm, no lingering console
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
