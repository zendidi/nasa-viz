#!/usr/bin/env bash
# =====================================================================
#  NASA Viz - lanceur Linux, pendant de Lancer-NASA-Viz.bat + tools/start.ps1.
#
#  Double-cliquez NASA-Viz.desktop (ou ce fichier). Au premier lancement il
#  prépare ce qui manque (dépendances PHP via Composer, build web via Node),
#  puis il démarre un seul processus PHP qui sert la page et l'API, attend une
#  vraie réponse HTTP et ouvre le navigateur.
#
#  Rien n'est installé dans le système par ce script : Composer et, si besoin,
#  Node sont téléchargés dans LINUX/.local/. Seuls PHP, curl et unzip viennent
#  du gestionnaire de paquets, via installer-dependances.sh, qu'il propose de
#  lancer lui-même s'ils manquent.
#
#  Usage : lancer-nasa-viz.sh [port] [--no-open] [--dev]
#    port       : 8010 par défaut (le suivant libre si occupé)
#    --no-open  : ne pas ouvrir le navigateur
#    --dev      : lance aussi le serveur Vite (backend forcé sur 8000)
# =====================================================================
set -u

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
self="$here/$(basename "${BASH_SOURCE[0]}")"
root=$(dirname "$here")
backend=$root/backend
web=$root/web
public=$backend/public
dist=$web/dist
outils=$here/.local

# --- 0. Un terminal, toujours ------------------------------------------------
#
# Lancé depuis un gestionnaire de fichiers (« Exécuter comme un programme »),
# le script n'a pas de terminal : ni messages, ni Ctrl+C, et un PHP orphelin qui
# tourne sans que personne le sache. On se relance donc dans le premier
# émulateur de terminal trouvé. x-terminal-emulator et tilix ne prennent qu'une
# chaîne après -e, d'où le printf %q pour eux seuls.

if [ ! -t 1 ] && [ -z "${NASA_VIZ_TERMINAL:-}" ]; then
    export NASA_VIZ_TERMINAL=1
    for t in gnome-terminal ptyxis kgx konsole xfce4-terminal mate-terminal \
             alacritty kitty foot tilix x-terminal-emulator xterm; do
        command -v "$t" >/dev/null 2>&1 || continue
        case $t in
            gnome-terminal|ptyxis|kgx)    exec "$t" -- bash "$self" "$@" ;;
            xfce4-terminal|mate-terminal) exec "$t" -x bash "$self" "$@" ;;
            kitty|foot)                   exec "$t" bash "$self" "$@" ;;
            tilix|x-terminal-emulator)    exec "$t" -e "$(printf '%q ' bash "$self" "$@")" ;;
            *)                            exec "$t" -e bash "$self" "$@" ;;
        esac
    done
    # Aucun terminal : on continue quand même, la sortie part dans un journal.
    mkdir -p "$outils"
    exec >"$outils/derniere-session.log" 2>&1
fi

if [ -t 1 ]; then
    c_cyan=$'\033[36m'; c_red=$'\033[31m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'
    c_url=$'\033[1;97;44m'; c_off=$'\033[0m'
else
    c_cyan=''; c_red=''; c_green=''; c_yellow=''; c_url=''; c_off=''
fi

info() { printf '  %s\n' "$*"; }
warn() { printf '  %s[!] %s%s\n' "$c_yellow" "$*" "$c_off"; }
ok()   { printf '  %s[ok] %s%s\n' "$c_green" "$*" "$c_off"; }

pause_if_tty() {
    if [ -t 0 ]; then
        printf '\n  Appuyez sur Entrée pour fermer.'
        read -r _
    fi
}

fail() {
    printf '\n  %sERREUR : %s%s\n' "$c_red" "$1" "$c_off"
    shift
    for h in "$@"; do printf '          %s\n' "$h"; done
    echo
    pause_if_tty
    exit 1
}

# Oui par défaut : le but est que la personne n'ait qu'à appuyer sur Entrée.
confirm() {
    [ -t 0 ] || return 1
    local answer
    printf '  %s [O/n] ' "$1"
    read -r answer
    case $answer in [nN]*) return 1 ;; *) return 0 ;; esac
}

usage() {
    echo "Usage : $(basename "$self") [port] [--no-open] [--dev]"
}

port=8010
open_browser=1
dev=0
for arg in "$@"; do
    case $arg in
        --no-open) open_browser=0 ;;
        --dev) dev=1 ;;
        -h|--help) usage; exit 0 ;;
        ''|*[!0-9]*) usage; fail "argument inconnu : $arg" ;;
        *) port=$arg ;;
    esac
done

echo
printf '  %s---- NASA Viz ----------------------------------------%s\n' "$c_cyan" "$c_off"
echo

# --- 1. Prérequis système : PHP 8.3+, ses extensions, curl, unzip ------------

php=''
php_ok() { "$1" -r 'exit(PHP_VERSION_ID >= 80300 ? 0 : 1);' >/dev/null 2>&1; }

# Les binaires versionnés couvrent un PHP récent installé à côté du PHP par
# défaut (dépôt ondrej/sury), sans que /usr/bin/php pointe dessus.
find_php() {
    php=''
    local c p
    for c in php php8.5 php8.4 php8.3; do
        p=$(command -v "$c" 2>/dev/null) || continue
        if php_ok "$p"; then php=$p; return 0; fi
    done
    return 1
}

# ctype et iconv sont exigés par composer.json, xml (et dom) par FrameworkBundle,
# curl et openssl par tous les appels sortants, qui sont en HTTPS.
required_ext='ctype iconv curl mbstring openssl xml dom'

missing_ext() {
    local mods e
    mods=$("$php" -m 2>/dev/null | tr '[:upper:]' '[:lower:]')
    for e in $required_ext; do
        grep -qx "$e" <<<"$mods" || printf '%s ' "$e"
    done
}

# Certaines distributions (Arch) livrent une extension compilée mais commentée
# dans php.ini. Plutôt que de toucher /etc, on l'active par un .ini à nous, via
# PHP_INI_SCAN_DIR : le ':' initial garde le dossier de scan par défaut, et la
# variable est héritée par tous les PHP lancés ensuite (Composer, ses scripts
# Symfony, le serveur).
enable_missing_ext() {
    local e loadable=''
    for e in $(missing_ext); do
        if "$php" -d "extension=$e" -m 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -qx "$e"; then
            loadable="$loadable$e "
        fi
    done
    [ -n "$loadable" ] || return 0
    mkdir -p "$outils/php.d"
    : >"$outils/php.d/nasa-viz.ini"
    for e in $loadable; do echo "extension=$e" >>"$outils/php.d/nasa-viz.ini"; done
    export PHP_INI_SCAN_DIR="${PHP_INI_SCAN_DIR:-}:$outils/php.d"
    info "extensions PHP activées pour ce projet seulement : $loadable"
}

check_prereqs() {
    problems=''
    if find_php; then
        enable_missing_ext
        local m
        m=$(missing_ext)
        [ -z "$m" ] || problems="${problems}extensions PHP manquantes : $m; "
        "$php" -m 2>/dev/null | grep -qix zip || command -v unzip >/dev/null 2>&1 ||
            problems="${problems}unzip absent; "
    else
        problems="PHP 8.3+ introuvable; "
    fi
    command -v curl >/dev/null 2>&1 || problems="${problems}curl absent; "
    [ -z "$problems" ]
}

if ! check_prereqs; then
    warn "${problems%; }"
    info 'installer-dependances.sh peut les installer avec le gestionnaire de paquets'
    info '(le mot de passe administrateur sera demandé).'
    if confirm 'Lancer cette installation maintenant ?'; then
        bash "$here/installer-dependances.sh" --depuis-lanceur ||
            fail "l'installation des paquets a échoué." 'Voir le message ci-dessus.'
        check_prereqs || fail "toujours incomplet après installation : ${problems%; }" \
            'Lancez LINUX/installer-dependances.sh dans un terminal pour le détail.'
    else
        fail "${problems%; }" 'Lancez LINUX/installer-dependances.sh, puis relancez ce script.'
    fi
fi
ok "PHP $("$php" -r 'echo PHP_VERSION;')  ($php)"

# --- 2. Backend : .env puis dépendances Composer -----------------------------

# .env avant Composer : ses scripts post-install démarrent Symfony, qui le lit.
if [ ! -f "$backend/.env" ]; then
    [ -f "$backend/.env.example" ] || fail 'backend/.env et backend/.env.example sont absents tous les deux.'
    cp "$backend/.env.example" "$backend/.env"
    info '.env créé depuis .env.example (NASA_API_KEY=DEMO_KEY).'
fi

# Toujours notre composer.phar, lancé par le PHP choisi plus haut : un composer
# système suit son propre shebang, qui peut désigner un PHP plus ancien que
# celui-là (cas d'un PHP 8.3 installé à côté du PHP par défaut). Un seul chemin,
# prévisible, et sans droits root.
get_composer() {
    composer_phar=$outils/composer.phar
    [ -f "$composer_phar" ] && return 0
    info 'téléchargement de Composer...'
    mkdir -p "$outils"
    local base=https://getcomposer.org/download/latest-stable sum
    sum=$(curl -fsSL "$base/composer.phar.sha256") || fail 'impossible de contacter getcomposer.org.'
    curl -fsSL -o "$composer_phar.part" "$base/composer.phar" || fail 'le téléchargement de Composer a échoué.'
    if ! echo "${sum%% *}  $composer_phar.part" | sha256sum -c --status; then
        rm -f "$composer_phar.part"
        fail "empreinte SHA256 de Composer incorrecte, rien n'a été installé."
    fi
    mv "$composer_phar.part" "$composer_phar"
    ok 'Composer téléchargé dans LINUX/.local/'
}

# composer.lock plus récent que ce qu'a installé Composer = un git pull a changé
# les dépendances depuis le dernier lancement.
if [ ! -f "$backend/vendor/autoload.php" ] ||
   [ "$backend/composer.lock" -nt "$backend/vendor/composer/installed.json" ]; then
    get_composer
    info 'installation des dépendances PHP (premier lancement : une minute ou deux)...'
    (cd "$backend" && "$php" "$composer_phar" install --no-interaction --no-progress) ||
        fail 'composer install a échoué.' 'Voir le message ci-dessus.'
    ok 'dépendances PHP installées'
fi

# --- 3. Build web -------------------------------------------------------------

node=''
# Vite 8 demande Node ^20.19 || >=22.12 (engines de node_modules/vite).
node_ok() {
    "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);
             process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=23?0:1)' >/dev/null 2>&1
}

# Node du système s'il est assez récent ; sinon le binaire officiel, téléchargé
# une fois dans LINUX/.local/node/. Ubuntu 24.04 et Debian 12 livrent Node 18,
# trop ancien : c'est le cas courant, pas l'exception.
get_node() {
    [ -n "$node" ] && return 0
    local n
    n=$(command -v node 2>/dev/null) && node_ok "$n" && { node=$n; return 0; }
    n=$outils/node/bin/node
    if [ ! -x "$n" ] || ! node_ok "$n"; then
        local arch base line file
        case $(uname -m) in
            x86_64|amd64) arch=x64 ;;
            aarch64|arm64) arch=arm64 ;;
            *) warn "pas de Node officiel pour l'architecture $(uname -m)."; return 1 ;;
        esac
        base=https://nodejs.org/dist/latest-v24.x
        info 'téléchargement de Node (une fois, ~30 Mo)...'
        line=$(curl -fsSL "$base/SHASUMS256.txt" | grep -E " node-v[0-9.]+-linux-$arch\.tar\.gz$") ||
            { warn 'impossible de contacter nodejs.org.'; return 1; }
        file=${line##* }
        mkdir -p "$outils"
        curl -fL --progress-bar -o "$outils/$file" "$base/$file" ||
            { warn 'le téléchargement de Node a échoué.'; return 1; }
        if ! echo "${line%% *}  $outils/$file" | sha256sum -c --status; then
            rm -f "$outils/$file"
            warn "empreinte SHA256 de Node incorrecte, rien n'a été installé."
            return 1
        fi
        rm -rf "$outils/node"
        mkdir -p "$outils/node"
        tar -xzf "$outils/$file" -C "$outils/node" --strip-components=1
        rm -f "$outils/$file"
        ok "Node $("$n" --version) téléchargé dans LINUX/.local/node/"
    fi
    node=$n
    # npm est un script « #!/usr/bin/env node » : il lui faut ce node-là en tête du PATH.
    export PATH="$outils/node/bin:$PATH"
}

ensure_node_modules() {
    if [ ! -d "$web/node_modules" ] ||
       [ "$web/package-lock.json" -nt "$web/node_modules/.package-lock.json" ]; then
        info 'installation des dépendances web...'
        (cd "$web" && npm ci --no-audit --no-fund) || return 1
    fi
}

build_web() {
    get_node || return 1
    ensure_node_modules || return 1
    info 'construction du site (npm run build)...'
    (cd "$web" && npm run build) || return 1
    ok 'site construit'
}

# Un build plus ancien que ce qui entre dans le build est périmé : on le refait
# plutôt que de seulement prévenir comme sous Windows, puisque la personne qui
# teste ne lance jamais npm à la main. Liste restreinte à ce que lit Vite, pour
# qu'un git pull qui ne touche que tests/ ou la config ESLint ne reconstruise rien.
stale_src=''
if [ -f "$dist/index.html" ]; then
    stale_src=$(cd "$web" && find src public index.html vite.config.js package-lock.json \
        -type f -newer "$dist/index.html" -print -quit 2>/dev/null)
fi

if [ ! -f "$dist/index.html" ] || [ -n "$stale_src" ]; then
    [ -n "$stale_src" ] && info "build plus ancien que $(basename "$stale_src") : reconstruction."
    if ! build_web; then
        if [ -f "$dist/index.html" ] || [ -f "$public/index.html" ]; then
            warn 'reconstruction impossible : le build existant est utilisé tel quel.'
        else
            fail "le site n'a pas pu être construit." 'Voir le message ci-dessus.'
        fi
    fi
fi

# Même logique que start.ps1 : assets/ (noms hachés par Vite) est remplacé en
# entier pour ne pas empiler les bundles morts ; le reste est fusionné, sans
# jamais toucher public/index.php, le front controller Symfony.
if [ -f "$dist/index.html" ]; then
    rm -rf "$public/assets"
    for f in "$dist"/* "$dist"/.[!.]*; do
        [ -e "$f" ] || continue
        [ "$(basename "$f")" = index.php ] && continue
        cp -a "$f" "$public/" || fail "la copie de web/dist vers backend/public a échoué."
    done
    ok 'build web copié dans backend/public'
fi

# --- 4. Choix du port ---------------------------------------------------------

# Port libre = personne n'y accepte de connexion.
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if [ "$dev" = 1 ]; then
    # web/vite.config.js proxifie /api vers http://localhost:8000, en dur.
    port_free 8000 || fail 'le port 8000 est occupé, or le mode --dev en a besoin.' \
        'Vite proxifie /api vers http://localhost:8000 (web/vite.config.js).'
    port=8000
else
    chosen=0
    for ((p = port; p < port + 40; p++)); do
        if port_free "$p"; then chosen=$p; break; fi
    done
    [ "$chosen" != 0 ] || fail "aucun port libre entre $port et $((port + 39))."
    [ "$chosen" = "$port" ] || info "port $port occupé, bascule sur le port $chosen."
    port=$chosen
fi

# --- 5. Démarrage -------------------------------------------------------------

php_pid=''
vite_pid=''
cleanup() {
    local p
    for p in $vite_pid $php_pid; do kill "$p" 2>/dev/null; done
    [ -z "$php_pid" ] || info 'Serveur(s) arrêté(s).'
}
trap cleanup EXIT
# Fermer la fenêtre du terminal envoie HUP : PHP doit partir avec.
trap 'exit 130' INT TERM HUP

# Attend que le serveur réponde vraiment, plutôt que de supposer qu'il est prêt :
# c'est ce qui permet d'annoncer une URL déjà valide au moment où on l'affiche.
# Toute réponse HTTP, même une erreur, veut dire « le serveur écoute ».
wait_http() {
    local url=$1 timeout=$2 pid=$3 code deadline=$((SECONDS + $2))
    while [ "$SECONDS" -lt "$deadline" ]; do
        kill -0 "$pid" 2>/dev/null || return 1
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url")
        if [ -n "$code" ] && [ "$code" != 000 ]; then echo "$code"; return 0; fi
        sleep 0.3
    done
    return 1
}

info "démarrage du serveur PHP sur le port $port..."
(cd "$backend" && exec "$php" -S "127.0.0.1:$port" -t public) &
php_pid=$!

url="http://127.0.0.1:$port/"
# 60 s et non 25 : au tout premier appel, Symfony compile son conteneur.
code=$(wait_http "$url" 60 "$php_pid") ||
    fail "le serveur PHP n'a pas répondu sur $url." \
        "Réessayez sur un autre port, par exemple : $(basename "$self") 8080"
if [ "$code" -ge 500 ]; then
    warn "le backend répond mais renvoie une erreur HTTP $code."
else
    ok "backend opérationnel (HTTP $code)"
fi

if [ "$dev" = 1 ]; then
    get_node || fail 'le mode --dev demande Node.'
    ensure_node_modules || fail 'npm ci a échoué.'
    webport=0
    for ((p = 5173; p < 5213; p++)); do
        if port_free "$p"; then webport=$p; break; fi
    done
    [ "$webport" != 0 ] || fail 'aucun port libre pour Vite à partir de 5173.'
    info "démarrage du serveur Vite sur le port $webport..."
    # Vite lancé directement par node, pas via npm : un seul processus à arrêter.
    (cd "$web" && exec "$node" node_modules/vite/bin/vite.js --port "$webport" --strictPort) &
    vite_pid=$!
    url="http://localhost:$webport/"
    wait_http "$url" 60 "$vite_pid" >/dev/null || fail "Vite n'a pas répondu sur $url."
    ok 'serveur Vite opérationnel'
fi

copied=0
if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$url" | wl-copy 2>/dev/null && copied=1
elif command -v xclip >/dev/null 2>&1; then
    printf '%s' "$url" | xclip -selection clipboard 2>/dev/null && copied=1
elif command -v xsel >/dev/null 2>&1; then
    printf '%s' "$url" | xsel --clipboard --input 2>/dev/null && copied=1
fi
printf '%s\n' "$url" >"$here/derniere-url.txt" 2>/dev/null

echo
printf '  %s======================================================%s\n' "$c_cyan" "$c_off"
echo
echo '     NASA Viz tourne ici :'
echo
printf '        %s %s %s\n' "$c_url" "$url" "$c_off"
echo
[ "$dev" = 1 ] && echo "     API seule : http://127.0.0.1:$port/api/usage"
[ "$copied" = 1 ] && echo '     URL copiée dans le presse-papiers (Ctrl+V pour la coller).'
echo '     Également écrite dans LINUX/derniere-url.txt'
echo
printf '     %sLaissez cette fenêtre ouverte. Ctrl+C pour arrêter.%s\n' "$c_yellow" "$c_off"
echo
printf '  %s======================================================%s\n' "$c_cyan" "$c_off"
echo

# setsid détache le navigateur : s'il n'était pas déjà ouvert, il ne doit pas
# mourir avec ce terminal.
if [ "$open_browser" = 1 ]; then
    if command -v xdg-open >/dev/null 2>&1; then
        setsid xdg-open "$url" >/dev/null 2>&1 </dev/null &
    else
        warn "xdg-open absent : ouvrez l'URL ci-dessus dans votre navigateur."
    fi
fi

wait "$php_pid"
php_pid=''
fail "le serveur PHP s'est arrêté de lui-même." 'Voir les messages ci-dessus.'
