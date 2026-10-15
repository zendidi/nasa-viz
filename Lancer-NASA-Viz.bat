@echo off
rem =====================================================================
rem  NASA Viz - double-cliquez ce fichier pour lancer le site en local.
rem
rem  Il verifie PHP, copie le build web dans backend\public, choisit un
rem  port libre, attend que le serveur reponde vraiment, puis affiche et
rem  copie l'URL dans le presse-papiers.
rem
rem  Usage : Lancer-NASA-Viz.bat [port] [--no-open] [--dev]
rem    port       : 8010 par defaut (le suivant libre si occupe)
rem    --no-open  : ne pas ouvrir le navigateur
rem    --dev      : lance aussi le serveur Vite (demande Node + npm install)
rem
rem  Toute la logique est dans tools\start.ps1.
rem =====================================================================
setlocal
title NASA Viz

set "PS_ARGS="

:parse
if "%~1"=="" goto run
if /i "%~1"=="--no-open" goto arg_noopen
if /i "%~1"=="--dev" goto arg_dev
set "PS_ARGS=%PS_ARGS% -Port %~1"
shift
goto parse
:arg_noopen
set "PS_ARGS=%PS_ARGS% -NoOpen"
shift
goto parse
:arg_dev
set "PS_ARGS=%PS_ARGS% -Dev"
shift
goto parse

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start.ps1"%PS_ARGS%
if errorlevel 1 (
  echo.
  echo   Le lancement a echoue. Voir le message ci-dessus.
  echo.
  pause
)
endlocal
