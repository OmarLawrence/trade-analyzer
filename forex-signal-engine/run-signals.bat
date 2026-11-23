@echo off
cd /d F:\forex_trader\forex-signal-engine
if not exist logs mkdir logs

:: Capture the start time once, BEFORE the (slow) ingest step runs.
:: %TIME% can start with a space for single-digit hours, so pad with a zero.
set "HOUR=%TIME:~0,2%"
set "HOUR=%HOUR: =0%"
set "MIN=%TIME:~3,2%"
set "HHMM=%HOUR%%MIN%"

echo [%date% %time%] Starting at %HHMM% >> logs\run.log

:: Ingestor: every run from 08:30 to 17:00 (runs are every 30 min, so 17:30 and later are skipped)
if "%HHMM%" GEQ "0830" if "%HHMM%" LSS "1830" (
    echo [%date% %time%] Running ingestor >> logs\run.log
    call npm run ingest >> logs\run.log 2>&1
) else (
    echo [%date% %time%] Outside 08:30-18:30 - skipping ingestor >> logs\run.log
)

:: Analyzer: only on the hour (minute 00-29), from 08:30 to 18:30
if "%MIN%" LSS "30" if "%HHMM%" GEQ "0830" if "%HHMM%" LSS "1830" (
    echo [%date% %time%] Analyzer window - running analyzer >> logs\run.log
    call npm run analyze >> logs\run.log 2>&1
) else (
    echo [%date% %time%] Not an analyzer slot - skipping analyzer to save quota >> logs\run.log
)

echo [%date% %time%] Finished >> logs\run.log