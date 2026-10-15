#Requires -Version 5.1
<#
.SYNOPSIS
    Vérifie la présence de PHP et, s'il manque, le télécharge dans tools\php\.

.DESCRIPTION
    Rien n'est installé au sens Windows du terme : le zip officiel de
    windows.php.net est décompressé dans tools\php\ (à côté du projet), avec un
    php.ini minimal. Aucune modification du PATH, du registre, ni droits admin —
    tools\start.ps1 regarde tools\php\php.exe en premier, puis le PATH.

    Désinstaller = supprimer tools\php\.

.PARAMETER Branch
    Branche PHP à installer (8.3, 8.4, 8.5...). 8.4 par défaut.

.PARAMETER Force
    Télécharger même si un PHP utilisable est déjà présent (remplace tools\php\).
#>
[CmdletBinding()]
param(
    [string]$Branch = '8.4',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$dest        = Join-Path $PSScriptRoot 'php'
$minVersion  = [version]'8.3'
$releasesUrl = 'https://windows.php.net/downloads/releases/releases.json'
$downloadDir = 'https://windows.php.net/downloads/releases/'
$vcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

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

function Get-PhpVersion {
    param([string]$exe)
    try {
        $v = & $exe -r 'echo PHP_VERSION;' 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
        return [version](($v -split '-')[0])
    } catch {
        return $null
    }
}

Write-Host ''
Write-Host '  ---- NASA Viz : PHP ----------------------------------' -ForegroundColor Cyan
Write-Host ''

# --- 1. PHP déjà utilisable ? -------------------------------------------------

if (-not $Force) {
    $candidates = @()
    $local = Join-Path $dest 'php.exe'
    if (Test-Path -LiteralPath $local) { $candidates += $local }
    $onPath = Get-Command php.exe -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }

    foreach ($exe in $candidates) {
        $v = Get-PhpVersion $exe
        if ($v -and $v -ge $minVersion) {
            Write-Ok "PHP $v est déjà utilisable : $exe"
            Write-Host ''
            Write-Info 'Rien à télécharger. Lancez Lancer-NASA-Viz.bat.'
            Write-Host ''
            if (-not [Console]::IsInputRedirected) {
                Write-Host '  Appuyez sur Entrée pour fermer.'
                [void][Console]::ReadLine()
            }
            exit 0
        }
        if ($v) { Write-Warn "PHP $v trouvé ($exe) mais trop ancien (8.3 minimum)." }
    }
    Write-Info 'Aucun PHP 8.3+ trouvé : téléchargement.'
}

# --- 2. Quelle archive télécharger --------------------------------------------

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Info 'lecture de la liste des versions sur windows.php.net...'
try {
    $releases = Invoke-RestMethod -Uri $releasesUrl -UseBasicParsing -TimeoutSec 30
} catch {
    Stop-WithError "impossible de contacter windows.php.net ($($_.Exception.Message))." @(
        'Sans connexion, installez PHP 8.3+ à la main depuis https://windows.php.net/download',
        'et décompressez-le dans tools\php\ (php.exe doit être directement dedans).'
    )
}

$branchNames = $releases.PSObject.Properties.Name |
    Where-Object { $_ -as [version] -and [version]$_ -ge $minVersion } |
    Sort-Object { [version]$_ } -Descending

if ($branchNames -notcontains $Branch) {
    if (-not $branchNames) { Stop-WithError 'aucune branche PHP 8.3+ listée par windows.php.net.' }
    Write-Warn "branche $Branch indisponible, utilisation de $($branchNames[0])."
    $Branch = $branchNames[0]
}

$release = $releases.$Branch
$arch    = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
# NTS (non thread safe) suffit pour le serveur intégré `php -S` ; TS en repli.
$key = $release.PSObject.Properties.Name |
    Where-Object { $_ -match "^nts-.*-$arch$" } | Select-Object -First 1
if (-not $key) {
    $key = $release.PSObject.Properties.Name |
        Where-Object { $_ -match "^ts-.*-$arch$" } | Select-Object -First 1
}
if (-not $key) { Stop-WithError "aucune archive $arch pour PHP $Branch." }

$zipInfo = $release.$key.zip
$zipUrl  = $downloadDir + $zipInfo.path
$zipPath = Join-Path ([IO.Path]::GetTempPath()) $zipInfo.path

Write-Info "PHP $($release.version) ($key, $($zipInfo.size))"

# --- 3. Téléchargement + vérification -----------------------------------------

Write-Info 'téléchargement...'
$progress = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'   # sinon Invoke-WebRequest est ~10x plus lent
try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 600
} catch {
    Stop-WithError "le téléchargement a échoué ($($_.Exception.Message))." @("URL : $zipUrl")
} finally {
    $ProgressPreference = $progress
}

if ($zipInfo.sha256) {
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    if ($hash -ne $zipInfo.sha256.ToUpperInvariant()) {
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        Stop-WithError 'empreinte SHA256 incorrecte : archive corrompue ou altérée, rien n''a été installé.'
    }
    Write-Ok 'empreinte SHA256 vérifiée'
}

# --- 4. Décompression ----------------------------------------------------------

if (Test-Path -LiteralPath $dest) {
    Write-Info 'suppression de l''ancien tools\php\...'
    Remove-Item -LiteralPath $dest -Recurse -Force
}
Write-Info 'décompression dans tools\php\...'
Expand-Archive -LiteralPath $zipPath -DestinationPath $dest -Force
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue

# --- 5. php.ini ----------------------------------------------------------------

# Le zip officiel n'active aucune extension par défaut. openssl et curl sont
# indispensables (tous les appels sortants sont en HTTPS) ; mbstring et fileinfo
# sont attendus par Symfony. ctype et iconv sont compilés en dur sous Windows.
#
# extension_dir reste relatif : sous Windows il est résolu par rapport au dossier
# de php.exe, pas au répertoire courant. Un chemin absolu figerait ce php.ini sur
# cette machine-ci, alors que le principe est justement de pouvoir copier le
# dossier du projet ailleurs.
$iniPath = Join-Path $dest 'php.ini'
# ASCII sans BOM : un php.ini avec BOM fait echouer la lecture de la 1re ligne.
$ini = @'
; Genere par tools\install-php.ps1 pour NASA Viz - modifiable librement.
extension_dir = "ext"
extension=openssl
extension=curl
extension=mbstring
extension=fileinfo
date.timezone = UTC
memory_limit = 256M
'@
Set-Content -LiteralPath $iniPath -Value $ini -Encoding ASCII
Write-Ok 'php.ini écrit (openssl, curl, mbstring, fileinfo activés)'

# --- 6. Vérification ------------------------------------------------------------

$exe = Join-Path $dest 'php.exe'
$v = Get-PhpVersion $exe
if (-not $v) {
    Write-Host ''
    Write-Warn 'PHP est décompressé mais ne démarre pas.'
    Write-Info 'Cause quasi systématique : le runtime Visual C++ 2015-2022 manque sur cette machine.'
    Write-Host ''
    $answer = 'n'
    if (-not [Console]::IsInputRedirected) {
        $answer = Read-Host '  Télécharger et lancer le programme d''installation Microsoft ? (o/N)'
    }
    if ($answer -match '^(o|y)') {
        $vc = Join-Path ([IO.Path]::GetTempPath()) 'vc_redist.x64.exe'
        Invoke-WebRequest -Uri $vcRedistUrl -OutFile $vc -UseBasicParsing -TimeoutSec 600
        Write-Info 'lancement (une fenêtre Windows va demander les droits administrateur)...'
        Start-Process -FilePath $vc -ArgumentList '/install', '/passive', '/norestart' -Verb RunAs -Wait
        $v = Get-PhpVersion $exe
    }
    if (-not $v) {
        Stop-WithError 'PHP ne démarre toujours pas.' @(
            "Installez le runtime manuellement : $vcRedistUrl",
            'puis relancez Installer-PHP.bat.'
        )
    }
}

$missing = @('openssl', 'curl', 'mbstring') | Where-Object { @(& $exe -m) -notcontains $_ }
if ($missing) { Write-Warn "extensions non chargées : $($missing -join ', ')" }

Write-Host ''
Write-Ok "PHP $v installé dans tools\php\"
Write-Host ''
Write-Info 'Il n''est pas ajouté au PATH : seul ce projet l''utilise.'
Write-Info 'Pour le désinstaller, supprimez le dossier tools\php\.'
Write-Host ''
Write-Info 'Étape suivante : double-cliquez Lancer-NASA-Viz.bat'
Write-Host ''

if (-not [Console]::IsInputRedirected) {
    Write-Host '  Appuyez sur Entrée pour fermer.'
    [void][Console]::ReadLine()
}
