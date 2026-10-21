@echo off
title Dauntless Builder Local
"%~dp0runtime\node.exe" "%~dp0server.cjs" --open
if errorlevel 1 pause
