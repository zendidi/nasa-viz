#Requires -Version 5.1
<#
.SYNOPSIS
    Démarre NASA Viz sur cette machine et affiche l'URL à ouvrir.

.DESCRIPTION
    Mode par défaut : un seul processus PHP sert la page web (web/dist copié dans
    backend/public) et l'API /api/* — même origine, donc pas de CORS, et rien à
    installer à part PHP (voir Installer-PHP.bat et DEPLOYMENT.md).

    Mode -Dev : lance en plus le serveur Vite (npm run dev) pour travailler sur
    web/src avec rechargement à chaud. Demande Node et un `npm install` déjà fait.

    Lancé normalement via Lancer-NASA-Viz.bat (double-clic).

.PARAMETER Port
    Port du serveur PHP. 8010 par défaut ; si occupé, le script prend le suivant
    libre. 8010 plutôt que 8000 parce que 8000 est le port du backend de dev
    (php -S 127.0.0.1:8000), souvent déjà pris sur une machine de dev — sauf en
    -Dev, où le backend est forcé sur 8000 puisque Vite y proxifie /api en dur.

.PARAMETER NoOpen
    Ne pas ouvrir le navigateur automatiquement.

.PARAMETER Dev
    Lancer aussi le serveur de dev Vite.
#>
[CmdletBinding()]
param(
    [int]$Port = 8010,
    [switch]$NoOpen,
    [switch]$Dev
)

$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$web     = Join-Path $root 'web'
$public  = Join-Path $backend 'public'
$dist    = Join-Path $web 'dist'

$phpProc  = $null
$viteProc = $null

function Write-Info { param($m) Write-Host "  $m" }
function Write-Warn { param($m) Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Ok   { param($m) Write-Host "  [ok] $m" -ForegroundColor Green }

function Stop-WithError {
    param([string]$Message, [string[]]$Hints = @())
    Write-Host ''
    Write-Host "  ERREUR : $Message" -ForegroundColor Red
    foreach ($h in $Hints) { Write-Host "          $h" }
    Write-Host ''
    if (-not [Console]::IsInputRedirected) {
        Write-Host '  Appuyez sur Entrée pour fermer.'
        [void][Console]::ReadLine()
    }
    exit 1
}

function Test-PortFree {
    param([int]$p)
    try {
        $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $p
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

function Find-FreePort {
    param([int]$start, [int]$tries = 40)
    for ($p = $start; $p -lt ($start + $tries); $p++) {
        if (Test-PortFree $p) { return $p }
    }
    return 0
}

# Attend que le serveur réponde vraiment, plutôt que de supposer qu'il est prêt :
# c'est ce qui permet d'annoncer une URL déjà valide au moment où on l'affiche.
function Wait-ForHttp {
    param([string]$url, [int]$timeoutSec = 25, $process)
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($process -and $process.HasExited) { return $null }
        try {
            return Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
        } catch [System.Net.WebException] {
            # Une réponse d'erreur HTTP veut quand même dire "le serveur écoute".
            if ($_.Exception.Response) { return $_.Exception.Response }
            Start-Sleep -Milliseconds 300
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    return $null
}

Write-Host ''
Write-Host '  ---- NASA Viz ----------------------------------------' -ForegroundColor Cyan
Write-Host ''

# --- 1. PHP ------------------------------------------------------------------

$localPhp = Join-Path $PSScriptRoot 'php\php.exe'
$php = $null
if (Test-Path -LiteralPath $localPhp) {
    $php = $localPhp
} else {
    $cmd = Get-Command php.exe -ErrorAction SilentlyContinue
    if ($cmd) { $php = $cmd.Source }
}

if (-not $php) {
    Stop-WithError 'PHP est introuvable.' @(
        'Double-cliquez Installer-PHP.bat : il télécharge PHP dans tools\php\',
        'sans rien modifier sur la machine, puis relancez ce script.'
    )
}

$phpVersion = (& $php -r 'echo PHP_VERSION;' 2>$null)
if (-not $phpVersion) {
    Stop-WithError "PHP a été trouvé ($php) mais refuse de démarrer." @(
        'Cause habituelle sous Windows : runtime Visual C++ manquant.',
        'https://aka.ms/vs/17/release/vc_redist.x64.exe'
    )
}

if ([version](($phpVersion -split '-')[0]) -lt [version]'8.3') {
    Stop-WithError "PHP $phpVersion est trop ancien (8.3 minimum)." @(
        'Installer-PHP.bat installe une version récente dans tools\php\,',
        'qui est prioritaire sur le PHP du PATH.'
    )
}
Write-Ok "PHP $phpVersion  ($php)"

$modules = @(& $php -m)
foreach ($ext in @('openssl', 'curl')) {
    if ($modules -notcontains $ext) {
        Write-Warn "extension PHP '$ext' absente : les appels aux API NASA/ESA/IMCCE échoueront."
    }
}

# --- 2. Dépendances et configuration du backend -------------------------------

if (-not (Test-Path -LiteralPath (Join-Path $backend 'vendor\autoload.php'))) {
    Stop-WithError 'backend\vendor\ est absent (dépendances PHP non copiées).' @(
        'Copiez le dossier backend\ complet depuis la machine de dev, vendor\ inclus,',
        'ou lancez "composer install" dans backend\.'
    )
}

$envFile = Join-Path $backend '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    $envExample = Join-Path $backend '.env.example'
    if (-not (Test-Path -LiteralPath $envExample)) {
        Stop-WithError 'backend\.env et backend\.env.example sont absents tous les deux.'
    }
    Copy-Item -LiteralPath $envExample -Destination $envFile
    Write-Info '.env créé depuis .env.example (NASA_API_KEY=DEMO_KEY).'
}

# --- 3. Build web -> backend\public -------------------------------------------

if (Test-Path -LiteralPath (Join-Path $dist 'index.html')) {
    # assets\ d'abord, et en miroir (/MIR = /E + /PURGE) : Vite hache le nom de
    # chaque bundle, donc une fusion simple empile un fichier mort de plus à
    # chaque build. Constaté le 2026-09-29 : trois bundles y cohabitaient, dont
    # deux que plus aucun index.html ne nommait.
    #
    # La purge s'arrête à ce dossier et n'est PAS appliquée à $public entier :
    # backend\public, c'est web\dist + index.php, et un /MIR à la racine
    # effacerait le front controller Symfony. assets\ n'est produit que par le
    # build, rien d'autre n'y vit, il est donc le seul à pouvoir être miroité.
    $distAssets = Join-Path $dist 'assets'
    if (Test-Path -LiteralPath $distAssets) {
        & robocopy $distAssets (Join-Path $public 'assets') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) {
            Stop-WithError "la purge de backend\public\assets a échoué (robocopy $LASTEXITCODE)."
        }
    }

    # Le reste en fusion. robocopy plutôt que Copy-Item : fusionne proprement
    # dans un dossier qui existe déjà. /XF index.php protège le front controller
    # Symfony (DEPLOYMENT.md).
    #
    # textures\ reste en fusion volontairement : les noms n'y sont pas hachés,
    # un fichier réutilisé est écrasé en place, et le jeu three.js y coexiste
    # avec le jeu Solar System Scope tenu en réserve (docs/agent/decisions.md).
    & robocopy $dist $public /E /XF index.php /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Stop-WithError "la copie de web\dist vers backend\public a échoué (robocopy $LASTEXITCODE)."
    }
    Write-Ok 'build web copié dans backend\public'

    $builtAt = (Get-Item -LiteralPath (Join-Path $dist 'index.html')).LastWriteTime
    $newestSrc = Get-ChildItem -LiteralPath $web -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\(node_modules|dist)\\' } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newestSrc -and $newestSrc.LastWriteTime -gt $builtAt) {
        Write-Warn "build plus ancien que $($newestSrc.Name) : refaites 'npm run build' dans web\ si besoin."
    }
} elseif (Test-Path -LiteralPath (Join-Path $public 'index.html')) {
    Write-Info 'web\dist absent, mais backend\public contient déjà un build.'
} else {
    Write-Warn 'aucun build web (web\dist\index.html absent) : seule l''API /api/* répondra.'
    Write-Info 'Pour le construire : cd web && npm install && npm run build'
}

# --- 4. Choix du port ---------------------------------------------------------

if ($Dev) {
    # web\vite.config.js proxifie /api vers http://localhost:8000, en dur.
    if (-not (Test-PortFree 8000)) {
        Stop-WithError 'le port 8000 est occupé, or le mode -Dev en a besoin.' @(
            'Vite proxifie /api vers http://localhost:8000 (web\vite.config.js).',
            'Libérez le port 8000, ou lancez sans -Dev.'
        )
    }
    $Port = 8000
} else {
    $chosen = Find-FreePort $Port
    if ($chosen -eq 0) { Stop-WithError "aucun port libre entre $Port et $($Port + 39)." }
    if ($chosen -ne $Port) { Write-Info "port $Port occupé, bascule sur le port $chosen." }
    $Port = $chosen
}

# --- 5. Démarrage -------------------------------------------------------------

try {
    Write-Info "démarrage du serveur PHP sur le port $Port..."
    $phpProc = Start-Process -FilePath $php `
        -ArgumentList @('-S', "127.0.0.1:$Port", '-t', 'public') `
        -WorkingDirectory $backend -NoNewWindow -PassThru

    $url = "http://127.0.0.1:$Port/"
    $resp = Wait-ForHttp -url $url -process $phpProc
    if (-not $resp) {
        Stop-WithError "le serveur PHP n'a pas répondu sur $url." @(
            'Réessayez sur un autre port, par exemple : Lancer-NASA-Viz.bat 8080'
        )
    }
    $code = [int]$resp.StatusCode
    if ($code -ge 500) {
        Write-Warn "le backend répond mais renvoie une erreur HTTP $code."
    } else {
        Write-Ok "backend opérationnel (HTTP $code)"
    }

    if ($Dev) {
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) { Stop-WithError 'le mode -Dev demande Node/npm, introuvable dans le PATH.' }
        if (-not (Test-Path -LiteralPath (Join-Path $web 'node_modules'))) {
            Stop-WithError 'web\node_modules est absent.' @('Lancez une fois : cd web && npm install')
        }
        $webPort = Find-FreePort 5173
        if ($webPort -eq 0) { Stop-WithError 'aucun port libre pour Vite à partir de 5173.' }
        Write-Info "démarrage du serveur Vite sur le port $webPort..."
        $viteProc = Start-Process -FilePath $npm.Source `
            -ArgumentList @('run', 'dev', '--', '--port', "$webPort", '--strictPort') `
            -WorkingDirectory $web -NoNewWindow -PassThru
        $viteUrl = "http://localhost:$webPort/"
        if (-not (Wait-ForHttp -url $viteUrl -timeoutSec 60 -process $viteProc)) {
            Stop-WithError "Vite n'a pas répondu sur $viteUrl."
        }
        Write-Ok 'serveur Vite opérationnel'
        $url = $viteUrl
    }

    $copied = $false
    try { Set-Clipboard -Value $url; $copied = $true } catch { }
    try {
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'derniere-url.txt') -Value $url -Encoding ASCII
    } catch { }

    Write-Host ''
    Write-Host '  ======================================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '     NASA Viz tourne ici :'
    Write-Host ''
    Write-Host "        $url" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host ''
    if ($Dev) { Write-Host "     API seule : http://127.0.0.1:$Port/api/usage" }
    if ($copied) { Write-Host '     URL copiée dans le presse-papiers (Ctrl+V pour la coller).' }
    Write-Host '     Également écrite dans tools\derniere-url.txt'
    Write-Host ''
    Write-Host '     Laissez cette fenêtre ouverte. Ctrl+C pour arrêter.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  ======================================================' -ForegroundColor Cyan
    Write-Host ''

    if (-not $NoOpen) { Start-Process $url }

    Wait-Process -Id $phpProc.Id
}
finally {
    # Ctrl+C atteint déjà les enfants (console partagée via -NoNewWindow) ; ce
    # filet rattrape les sorties par erreur, où PHP survivrait au script.
    $running = @($viteProc, $phpProc) | Where-Object { $_ -and -not $_.HasExited }
    foreach ($p in $running) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    if ($phpProc) { Write-Host '  Serveur(s) arrêté(s).' }
}
