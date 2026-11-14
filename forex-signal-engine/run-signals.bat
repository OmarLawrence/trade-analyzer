@echo off
cd /d F:\forex_trader\forex-signal-engine
if not exist logs mkdir logs
echo [%date% %time%] Starting >> logs\run.log
call npm run ingest >> logs\run.log 2>&1
call npm run analyze >> logs\run.log 2>&1
echo [%date% %time%] Finished >> logs\run.log