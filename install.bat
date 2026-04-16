@echo off
chcp 65001 >nul
:: ============================================
::   Video Skill Pro - Install Script
::   Enhanced version with FFmpeg support
:: ============================================

echo.
echo ============================================
echo   Video Skill Pro Installer
echo ============================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo.
    echo Please install Node.js from:
    echo   https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js version:
node -v
echo.

:: Get script directory
set SCRIPT_DIR=%~dp0

:: Install dependencies
echo [1/3] Installing npm dependencies...
cd /d "%SCRIPT_DIR%"
call npm install

if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [OK] Dependencies installed successfully
echo.

:: Check FFmpeg
echo [2/3] Checking FFmpeg...
where ffmpeg >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] FFmpeg is installed
    ffmpeg -version | findstr /R "^ffmpeg"
) else (
    echo [WARN] FFmpeg is NOT installed
    echo.
    echo Some features will not work without FFmpeg.
    echo.
    echo To install FFmpeg:
    echo   1. Visit: https://ffmpeg.org/download.html
    echo   2. Download and extract FFmpeg
    echo   3. Add ffmpeg.exe to system PATH
    echo.
    echo Or use winget:
    echo   winget install ffmpeg
    echo.
)
echo.

:: Check Whisper
echo [3/3] Checking Whisper...
where whisper >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Whisper is installed
    whisper --version
) else (
    echo [WARN] Whisper is NOT installed
    echo.
    echo Speech-to-text features will not work without Whisper.
    echo.
    echo To install Whisper:
    echo   1. Install Python from: https://www.python.org/
    echo   2. Run: pip install openai-whisper
    echo.
    echo Or use pip:
    echo   pip install openai-whisper
    echo.
)
echo.

:: Show configuration
echo ============================================
echo   Claude Desktop Configuration
echo ============================================
echo.

set CONFIG_PATH=%APPDATA%\Claude\claude_desktop_config.json
echo Config file path:
echo   %CONFIG_PATH%
echo.
echo Add the following to your config:
echo.
echo ============================================
echo {
echo   "mcpServers": {
echo     "video-pro": {
echo       "command": "node",
echo       "args": ["%SCRIPT_DIR:~0,-1%\server.js"]
echo     }
echo   }
echo }
echo ============================================
echo.
echo NOTE: If you already have mcpServers config,
echo       just add the "video-pro" section.
echo.
echo ============================================
echo Available Tools:
echo.
echo With FFmpeg:
echo   - analyze_video      : Full video analysis
echo   - extract_subtitles  : Extract embedded subtitles
echo   - extract_keyframes  : Extract keyframe images
echo   - extract_audio      : Extract audio from video
echo   - get_video_metadata : Get video metadata
echo.
echo With FFmpeg + Whisper:
echo   - video_to_text      : Speech-to-text transcription
echo.
echo Without FFmpeg:
echo   - analyze_bilibili   : Bilibili video analysis
echo   - analyze_youtube    : YouTube video analysis
echo.
echo ============================================
echo Next Steps:
echo   1. Press Win+R and paste: %APPDATA%\Claude\claude_desktop_config.json
echo   2. Open with Notepad and add the config above
echo   3. Save the file
echo   4. Restart Claude Desktop
echo   5. Try: "Analyze this video: [path]"
echo ============================================
echo.
echo [DONE] Installation Complete!
echo.
pause
