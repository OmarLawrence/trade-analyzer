@echo off
setlocal EnableDelayedExpansion

cd /d F:\forex_trader\forex-signal-engine
if not exist logs mkdir logs
if not exist .state mkdir .state

set "LOCKFILE=.state\pipeline.lock"

:: Prevent overlapping runs if a previous execution is still active
if exist "%LOCKFILE%" (
    echo [%date% %time%] Previous run still active - skipping >> logs\run.log
    exit /b 0
)
echo %DATE% %TIME% > "%LOCKFILE%"

:: Capture start time once before running steps
set "HOUR=%TIME:~0,2%"
set "HOUR=%HOUR: =0%"
set "MIN=%TIME:~3,2%"
set "HHMM=%HOUR%%MIN%"

echo [%date% %time%] Starting pipeline at %HHMM% >> logs\run.log

if "%HHMM%" GEQ "0830" if "%HHMM%" LSS "1830" (
    set "INGEST_OUT=.state\last_ingest.tmp"
    set "NEW_COUNT=0"

    echo [%date% %time%] Running ingestor >> logs\run.log
    call npm run ingest > "!INGEST_OUT!" 2>&1
    set "INGEST_EXIT=!ERRORLEVEL!"
    type "!INGEST_OUT!" >> logs\run.log

    if !INGEST_EXIT! NEQ 0 (
        echo [%date% %time%] Ingestor failed with exit code !INGEST_EXIT! - skipping analyzer >> logs\run.log
        goto :cleanup
    )

    :: Look for a line like "NEW_ARTICLES: 3" printed by your ingestor
    for /f "tokens=2 delims=:" %%A in ('findstr /c:"NEW_ARTICLES:" "!INGEST_OUT!" 2^>nul') do (
        set "VAL=%%A"
        set "VAL=!VAL: =!"
        set /a NEW_COUNT=!VAL! 2>nul
    )

    echo [%date% %time%] New articles detected: !NEW_COUNT! >> logs\run.log

    if !NEW_COUNT! GTR 0 (
        echo [%date% %time%] New articles found - running analyzer >> logs\run.log
        call npm run analyze >> logs\run.log 2>&1
        echo [%date% %time%] Analyzer finished with exit code !ERRORLEVEL! >> logs\run.log
    ) else (
        echo [%date% %time%] No new articles - skipping analyzer to save quota >> logs\run.log
    )
) else (
    echo [%date% %time%] Outside 08:30-18:30 - skipping ingestor and analyzer >> logs\run.log
)

:cleanup
if exist "!INGEST_OUT!" del /q "!INGEST_OUT!" >nul 2>&1
if exist "%LOCKFILE%" del /q "%LOCKFILE%" >nul 2>&1
echo [%date% %time%] Finished >> logs\run.log
exit /b 0