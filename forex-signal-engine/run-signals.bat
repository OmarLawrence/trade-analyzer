@echo off
cd /d F:\forex_trerd\forex-signal-engine
if not exist logs mkdir logs

echo [%date% %time%] Starting >> logs\run.log
call npm run ingest >> logs\run.log 2>&1

:: Extract current hour (handles leading spaces for single-digit hours like " 7")
set "HOUR=%TIME:~0,2%"
set "HOUR=%HOUR: =0%"

:: Only run Gemini analyzer between 09:00 and 21:00 SAST (12 runs at 60-min intervals)
if "%HOUR%" GEQ "09" if "%HOUR%" LEQ "21" (
    echo [%date% %time%] Active session window - running analyzer >> logs\run.log
    call npm run analyze >> logs\run.log 2>&1
) else (
    echo [%date% %time%] Outside 09:00-21:00 SAST window - skipping analyzer to save quota >> logs\run.log
)

echo [%date% %time%] Finished >> logs\run.log