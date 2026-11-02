#!/usr/bin/env bash
# =====================================================================
#  NASA Viz - installe les paquets système dont le lanceur Linux a besoin,
#  pendant d'Installer-PHP.bat.
#
#  Contrairement à Windows, il n'y a pas d'archive PHP officielle à décompresser
#  dans le projet : PHP vient donc du gestionnaire de paquets (apt, dnf, pacman,
#  zypper), avec curl et unzip. C'est la seule étape qui demande les droits
#  administrateur. Composer et Node, eux, sont téléchargés par
#  lancer-nasa-viz.sh dans LINUX/.local/, sans toucher au système.
#
#  Normalement appelé par lancer-nasa-viz.sh quand il manque quelque chose ;
#  peut aussi être lancé seul dans un terminal.
# =====================================================================
set -u

if [ -t 1 ]; then
    c_cyan=$'\033[36m'; c_red=$'\033[31m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_off=$'\033[0m'
else
    c_cyan=''; c_red=''; c_green=''; c_yellow=''; c_off=''
fi

info() { printf '  %s\n' "$*"; }
warn() { printf '  %s[!] %s%s\n' "$c_yellow" "$*" "$c_off"; }
ok()   { printf '  %s[ok] %s%s\n' "$c_green" "$*" "$c_off"; }

# Appelé par le lanceur, on ne fait pas de pause : c'est lui qui s'en charge.
from_launcher=0
[ "${1:-}" = --depuis-lanceur ] && from_launcher=1

finish() {
    if [ "$from_launcher" = 0 ] && [ -t 0 ]; then
        printf '\n  Appuyez sur Entrée pour fermer.'
        read -r _
    fi
    exit "$1"
}

fail() {
    printf '\n  %sERREUR : %s%s\n' "$c_red" "$1" "$c_off"
    shift
    for h in "$@"; do printf '          %s\n' "$h"; done
    echo
    finish 1
}

confirm() {
    [ -t 0 ] || return 1
    local answer
    printf '  %s [O/n] ' "$1"
    read -r answer
    case $answer in [nN]*) return 1 ;; *) return 0 ;; esac
}

php_ok() { "$1" -r 'exit(PHP_VERSION_ID >= 80300 ? 0 : 1);' >/dev/null 2>&1; }

find_php() {
    local c p
    for c in php php8.5 php8.4 php8.3; do
        p=$(command -v "$c" 2>/dev/null) || continue
        php_ok "$p" && { echo "$p"; return 0; }
    done
    return 1
}

if [ "$(id -u)" = 0 ]; then
    sudo=()
elif command -v sudo >/dev/null 2>&1; then
    sudo=(sudo)
else
    fail 'sudo est introuvable.' 'Lancez ce script en root, ou installez à la main : PHP 8.3+ (cli, curl, mbstring, xml), curl, unzip.'
fi

run() {
    printf '  %s$ %s%s\n' "$c_cyan" "$*" "$c_off"
    "${sudo[@]}" "$@"
}

echo
printf '  %s---- NASA Viz : paquets système ----------------------%s\n' "$c_cyan" "$c_off"
echo

# --- 1. Gestionnaire de paquets et liste ---------------------------------------

. /etc/os-release 2>/dev/null || true
distro="${PRETTY_NAME:-Linux}"

# Les noms de paquets diffèrent d'une famille à l'autre ; chaque liste couvre
# ctype, iconv, curl, mbstring, openssl, xml et dom (ce que vérifie le lanceur).
if command -v apt-get >/dev/null 2>&1; then
    pm=apt
    pkgs=(php-cli php-curl php-mbstring php-xml unzip curl ca-certificates)
elif command -v dnf >/dev/null 2>&1; then
    pm=dnf
    pkgs=(php-cli php-common php-mbstring php-xml unzip curl)
elif command -v pacman >/dev/null 2>&1; then
    pm=pacman
    pkgs=(php unzip curl)
elif command -v zypper >/dev/null 2>&1; then
    pm=zypper
    pkgs=(php8 php8-ctype php8-iconv php8-curl php8-mbstring php8-openssl php8-dom
          php8-xmlreader php8-xmlwriter php8-tokenizer unzip curl)
else
    fail "gestionnaire de paquets non reconnu sur $distro." \
        'Installez à la main : PHP 8.3+ (cli, curl, mbstring, xml), curl, unzip.'
fi

info "Système : $distro ($pm)"
info "Paquets : ${pkgs[*]}"
echo

# Le lanceur a déjà posé la question avant de nous appeler.
if [ "$from_launcher" = 0 ]; then
    confirm 'Installer ces paquets maintenant ?' || fail 'installation annulée.'
fi

# --- 2. Un PHP 8.3+ est-il seulement disponible ? ------------------------------
#
# Ubuntu 22.04 (PHP 8.1) et Debian 12 (PHP 8.2) n'en ont pas dans leurs dépôts.
# On le voit avant d'installer quoi que ce soit, pour ne pas poser un PHP
# inutilisable. Seul le dépôt ondrej d'Ubuntu est proposé automatiquement ;
# pour Debian, l'ajout du dépôt sury.org reste un geste manuel.

if [ "$pm" = apt ]; then
    run apt-get update -qq || fail 'apt-get update a échoué.'
    candidate=$(apt-cache policy php-cli 2>/dev/null | awk '/Candidate:/ {print $2}' |
        sed -E 's/^[0-9]+://; s/^([0-9]+\.[0-9]+).*/\1/')
    if [ -n "$candidate" ] && [ "$(printf '%s\n8.3\n' "$candidate" | sort -V | head -1)" != 8.3 ]; then
        warn "les dépôts de $distro ne proposent que PHP $candidate (8.3 minimum)."
        if [ "${ID:-}" = ubuntu ] &&
           confirm 'Ajouter le dépôt ppa:ondrej/php (PHP récents pour Ubuntu) et installer PHP 8.3 ?'; then
            run apt-get install -y software-properties-common || fail "installation de software-properties-common impossible."
            run add-apt-repository -y ppa:ondrej/php || fail "l'ajout du dépôt ondrej/php a échoué."
            run apt-get update -qq || fail 'apt-get update a échoué.'
            pkgs=(php8.3-cli php8.3-curl php8.3-mbstring php8.3-xml unzip curl ca-certificates)
        else
            fail "PHP 8.3+ indisponible dans les dépôts de $distro." \
                'Ubuntu : sudo add-apt-repository ppa:ondrej/php' \
                'Debian : https://packages.sury.org/php/README.txt' \
                'puis relancez ce script.'
        fi
    fi
fi

# --- 3. Installation ------------------------------------------------------------

case $pm in
    apt)    run apt-get install -y "${pkgs[@]}" ;;
    dnf)    run dnf install -y "${pkgs[@]}" ;;
    pacman) run pacman -S --needed --noconfirm "${pkgs[@]}" ;;
    zypper) run zypper --non-interactive install "${pkgs[@]}" ;;
esac || fail "l'installation des paquets a échoué." 'Voir le message ci-dessus.'

# --- 4. Vérification -------------------------------------------------------------

php=$(find_php) || fail "PHP est installé mais en version trop ancienne : $(php -r 'echo PHP_VERSION;' 2>/dev/null || echo inconnue)." \
    'Il faut PHP 8.3 ou plus récent.'

echo
ok "PHP $("$php" -r 'echo PHP_VERSION;') prêt ($php)"
[ "$from_launcher" = 1 ] || info 'Étape suivante : double-cliquez LINUX/NASA-Viz.desktop'
echo
finish 0
