#!/usr/bin/env bash
# Garde-fou du quota NASA (PreToolUse sur Bash / PowerShell).
#
# `NASA_API_KEY=DEMO_KEY` vaut 30 requetes/heure et 50/jour, partagees entre tous
# les developpeurs. Seules NeoWs (dans /api/neo) et APOD (/api/apod) les depensent.
# CLAUDE.md l'interdit en toutes lettres, mais une consigne en prose ne tient qu'a
# la memoire de l'agent : ce hook en fait un refus dur.
#
# Refuse une commande qui reunit les deux : un client HTTP, ET une route a quota.
# Un `grep -rn "/api/neo" backend/` reste donc autorise -- c'est une lecture, pas
# un appel. Idem pour JPL, ESA, IMCCE et l'ISS, qui sont sans cle et gratuits.
#
# Sans dependance : pas de jq sur la machine de l'utilisateur (verifie le 2026-09-30).

payload=$(cat)

http_client='curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr[[:space:]]|http_get|fetch[[:space:]]+http'
quota_route='/api/(neo|apod)'

if printf '%s' "$payload" | grep -Eqi "$http_client" \
&& printf '%s' "$payload" | grep -Eqi "$quota_route"; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Quota NASA : /api/neo et /api/apod depensent DEMO_KEY (30 req/h, 50/j, partage). Interdit par CLAUDE.md. Pour verifier le compteur reel : GET /api/usage (gratuit). Pour des donnees fraiches : le bouton \"Mettre a jour\" de l'UI web, qui passe par le cache localStorage. Les tests backend utilisent les fixtures de backend/tests/Fixtures/, jamais le reseau."
  }
}
JSON
  exit 0
fi

exit 0
