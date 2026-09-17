@echo off
setlocal

rem Lance NASA Viz sur cette machine sans rien installer d'autre que PHP :
rem un seul processus sert la page web et l'API (voir DEPLOYMENT.md).
rem
rem Usage : start-windows.bat [port] [--no-open]
rem   port      : 8000 par defaut
rem   --no-open : ne pas ouvrir le navigateur

cd /d "%~dp0"

set "PORT=8000"
set "OPEN=1"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--no-open" (set "OPEN=0") else (set "PORT=%~1")
shift
goto parse
:parsed

where php >nul 2>nul
if errorlevel 1 (
  echo.
  echo   PHP est introuvable.
  echo.
  echo   Installez PHP 8.3 ou plus recent ^(https://windows.php.net/download^),
  echo   puis ajoutez le dossier de php.exe au PATH, ou lancez ce fichier depuis
  echo   une invite de commandes ou "php" fonctionne.
  echo.
  pause
  exit /b 1
)

if not exist "vendor\autoload.php" (
  echo.
  echo   Le dossier vendor\ est absent : les dependances PHP n'ont pas ete copiees.
  echo   Copiez le dossier backend\ complet depuis la machine de developpement,
  echo   ou lancez "composer install" ici.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    echo [info] .env absent : copie de .env.example
    copy /y ".env.example" ".env" >nul
  )
)

if not exist "public\index.html" (
  echo [info] Le build web n'est pas dans public\ : seule l'API repondra.
  echo        Voir DEPLOYMENT.md, section "machine sans outils de developpement".
)

echo.
echo   NASA Viz : http://127.0.0.1:%PORT%/
echo   Laissez cette fenetre ouverte. Ctrl+C ou fermer la fenetre pour arreter.
echo.

if "%OPEN%"=="1" start "" "http://127.0.0.1:%PORT%/"

php -S 127.0.0.1:%PORT% -t public
if errorlevel 1 (
  echo.
  echo   Le serveur n'a pas demarre. Le port %PORT% est peut-etre deja utilise :
  echo   relancez avec un autre port, par exemple : start-windows.bat 8010
  echo.
  pause
)
