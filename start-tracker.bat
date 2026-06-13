@echo off
cd /d "%~dp0"
start "" "http://localhost:8745/portfolio-tracker.html"
python server.py
