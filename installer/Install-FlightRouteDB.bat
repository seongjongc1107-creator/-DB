@echo off
chcp 65001 >nul
title 항로 DB 설치
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-FlightRouteDB.ps1"
