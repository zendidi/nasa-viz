#!/usr/bin/env bash
# Garde-fou du quota NASA (PreToolUse sur Bash / PowerShell).
#
# `NASA_API_KEY=DEMO_KEY` vaut 30 requetes/heure et 50/jour, partagees entre tous
# les developpeurs. CLAUDE.md l'interdit en toutes lettres, mais une consigne en
# prose ne tient qu'a la memoire de l'agent : ce hook en fait un refus dur.
#
# Depuis le 2026-09-30, **seule `/api/neo` depense le quota**. `/api/apod` est
# sortie de la liste : NASA a deplace l'APOD vers science.nasa.gov, dont l'API
# REST est sans cle, et `ApodClient` lit desormais celle-la. La route est donc
# libre d'etre appelee en verification. Voir docs/agent/decisions.md.
#
# Refuse une commande qui reunit les deux : un client HTTP, ET une route a quota.
# Un `grep -rn "/api/neo" backend/` reste donc autorise -- c'est une lecture, pas
# un appel. Idem pour JPL, ESA, IMCCE, science.nasa.gov et l'ISS, tous sans cle.
#
# Limite connue : le motif porte sur le texte de la commande, donc une commande
# qui *mentionne* les deux sans appeler quoi que ce soit (un echo, une doc) est
# refusee aussi. C'est l'erreur dans le bon sens, mais elle empeche de tester ce
# hook a travers Bash : utiliser un fichier.
#
# Sans dependance : pas de jq sur la machine de l'utilisateur (verifie le 2026-09-30).

payload=$(cat)

http_client='curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr[[:space:]]|http_get|fetch[[:space:]]+http'
quota_route='/api/neo'

if printf '%s' "$payload" | grep -Eqi "$http_client" \
&& printf '%s' "$payload" | grep -Eqi "$quota_route"; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Quota NASA : /api/neo depense DEMO_KEY via NeoWs (30 req/h, 50/j, partage). Interdit par CLAUDE.md. Pour verifier le compteur reel : GET /api/usage (gratuit). Pour des donnees fraiches : le bouton \"Mettre a jour\" de l'UI web, qui passe par le cache localStorage. Les tests backend utilisent les fixtures de backend/tests/Fixtures/, jamais le reseau. Note : /api/apod ne depense plus rien depuis le 2026-09-30 et peut etre appelee librement."
  }
}
JSON
  exit 0
fi

exit 0
