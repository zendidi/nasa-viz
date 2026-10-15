@echo off
rem =====================================================================
rem  NASA Viz - verifie la presence de PHP, et le telecharge si besoin.
rem
rem  Rien n'est "installe" au sens Windows : le zip officiel de
rem  windows.php.net est decompresse dans tools\php\, avec un php.ini
rem  minimal. Pas de droits admin, pas de PATH modifie, pas de registre.
rem  Desinstaller = supprimer le dossier tools\php\.
rem
rem  Usage : Installer-PHP.bat [branche] [--force]
rem    branche : 8.4 par defaut (8.3, 8.5... au choix)
rem    --force : retelecharger meme si un PHP 8.3+ est deja present
rem
rem  Toute la logique est dans tools\install-php.ps1.
rem =====================================================================
setlocal
title NASA Viz - PHP

set "PS_ARGS="

:parse
if "%~1"=="" goto run
if /i "%~1"=="--force" goto arg_force
set "PS_ARGS=%PS_ARGS% -Branch %~1"
shift
goto parse
:arg_force
set "PS_ARGS=%PS_ARGS% -Force"
shift
goto parse

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-php.ps1"%PS_ARGS%
if errorlevel 1 (
  echo.
  echo   L'installation a echoue. Voir le message ci-dessus.
  echo.
  pause
)
endlocal
