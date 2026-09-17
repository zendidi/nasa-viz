# Mise en prod — NASA Viz

Checklist et guide pour la mise en ligne. Le projet continue d'évoluer avant la bascule réelle —
ce document sert de préparation, pas de trace d'un déploiement déjà fait. À tenir à jour au fil
des changements d'infra (nouvelle route, nouveau service, etc.).

## Où on en est

- **Backend** (Symfony 7, PHP ≥ 8.3) : proxy NASA fonctionnel, cache serveur déjà en place
  (`cache.app`, TTL par route — voir plus bas), compteur d'usage, CORS via `nelmio/cors-bundle`.
- **Web** (Vite + Three.js) : build statique (`npm run build` → `web/dist/`), aucune dépendance
  serveur Node en prod — ce sont des fichiers statiques.
- **Unity VR** : pas commencé, hors scope de cette mise en prod.
- **Clé NASA** : toujours `DEMO_KEY` (30 req/h, 50 req/j) — à remplacer avant toute exposition
  publique (voir étape 1).

## Le cache serveur protège déjà le quota — pas besoin de cron pour ça

`backend/src/Controller/SpaceDataController.php` met déjà chaque route derrière `cache.app` avec un
TTL par type de donnée : NEO 1h, APOD 24h, ISS 5s. Ce cache est partagé entre **tous** les
visiteurs (pas un cache par navigateur comme `web/src/cache.js` côté client) : une fois la première
personne de l'heure déclenché l'appel réel à NASA, tout le monde derrière reçoit la réponse cachée
jusqu'à expiration du TTL — donc au régime permanent, ~1 appel réel/heure pour NEO et ~1/jour pour
APOD, **quel que soit le nombre de visiteurs**. C'est déjà l'équivalent de la règle "1 req/h" visée.

Une tâche cron qui rafraîchit le cache de façon proactive (plutôt que de laisser le premier
visiteur après expiration déclencher l'appel) reste une amélioration possible — elle évite une
petite latence supplémentaire pour cette personne-là et lisse le compteur `/api/usage` — mais ce
n'est **pas un prérequis** pour tenir le quota. Voir `docs/agent/backlog.md` si on veut la faire un
jour.

## Prérequis côté hébergeur (Infomaniak)

- Un hébergement supportant **PHP 8.3+** avec accès Composer (SSH, ou Composer disponible dans le
  manager) — les offres Infomaniak "Hosting Web" le permettent, à vérifier sur le plan exact choisi.
- Accès en écriture sur `backend/var/` (cache Symfony, logs).
- Un nom de domaine (ou sous-domaine) avec HTTPS (Let's Encrypt, généralement automatique côté
  Infomaniak).
- Pas besoin de runtime Node en production — seulement pour builder `web/dist/` en local/CI avant
  upload.

## Architecture de déploiement recommandée : un seul domaine, pas de CORS

Le plus simple sur un hébergement mutualisé : faire servir le build web statique **par le même
Symfony** que l'API, en copiant le contenu de `web/dist/` dans `backend/public/`. Le front
controller de Symfony (`public/index.php` + réécriture Apache) ne route vers PHP que les requêtes
qui ne correspondent à aucun fichier existant, donc les assets statiques (`index.html`, JS, CSS,
textures) sont servis directement, et `/api/*` continue d'aller au backend — même origine, donc
**pas de configuration CORS nécessaire en prod**.

Alternative (si on préfère des pipelines de déploiement séparés, ex. front sur un CDN/hébergement
statique et backend sur un autre sous-domaine) : il faut alors ouvrir `CORS_ALLOW_ORIGIN` sur le
domaine réel du front dans le `.env` de prod, et changer les appels `fetch('/api/...')` de
`web/src/api.js` pour pointer vers l'URL absolue du backend. Non nécessaire avec l'option
recommandée ci-dessus.

## Étapes de mise en prod

1. **Générer une vraie clé NASA API** sur https://api.nasa.gov (gratuite, 1000 req/h) et la mettre
   dans `NASA_API_KEY` du `.env` de prod — ne pas commiter cette valeur.
2. **Backend**
   - `composer install --no-dev --optimize-autoloader`
   - Créer un `.env.local` (ou variables d'environnement serveur) avec :
     - `APP_ENV=prod`
     - `APP_SECRET=<valeur aléatoire générée, différente de dev>`
     - `NASA_API_KEY=<vraie clé>`
     - `CORS_ALLOW_ORIGIN` — pas nécessaire si front+back sur le même domaine (voir ci-dessus)
   - `php bin/console cache:clear --env=prod`
   - Vérifier que `backend/var/` est accessible en écriture par le process PHP.
3. **Frontend**
   - `cd web && npm run build`
   - Copier le contenu de `web/dist/` dans `backend/public/` (garder `backend/public/index.php` —
     ne pas l'écraser).
4. **Domaine / HTTPS** : pointer le domaine choisi sur le document root `backend/public/`, activer
   le certificat.
5. **Vérification post-déploiement**
   - Charger le site, vérifier que le globe/ciel/ISS s'affichent sans erreur console (CORS, 404
     textures, etc.).
   - `GET /api/usage` répond et le compteur progresse normalement (pas de 502 upstream).
   - Cliquer "Mettre à jour" une fois pour confirmer que le vrai appel NASA fonctionne avec la
     nouvelle clé.

## Checklist finale avant bascule publique

- [ ] Vraie clé NASA API en place (plus `DEMO_KEY`)
- [ ] `APP_ENV=prod` + `APP_SECRET` de prod généré
- [ ] `composer install --no-dev` fait, cache Symfony vidé/reconstruit
- [ ] Build web à jour copié dans `backend/public/`
- [ ] HTTPS actif sur le domaine final
- [ ] `/api/usage`, `/api/neo`, `/api/apod`, `/api/iss/position` testés en prod
- [ ] Pas d'erreur CORS/console sur un chargement à froid (cache navigateur vide)
- [ ] `docs/agent/decisions.md` et ce fichier mis à jour si l'archi de déploiement a changé
  entre-temps

## Journal de comparaison des sources NEO

`/api/neo` écrit une ligne JSON dans `backend/var/log/neo-comparison.jsonl` **à chaque fois que les
données des sources changent** (au plus une par heure et par plage de dates, ~25 ko par ligne).

- `backend/var/log/` doit être **persistant et inscriptible** par l'utilisateur du serveur web ;
  un échec d'écriture est journalisé mais ne casse jamais la route.
- Rapport : `php bin/console app:neo:comparison-report --days=30`.
- Prévoir une rotation (logrotate ou équivalent) : le pire cas est de l'ordre de quelques centaines
  de Mo par an si le site est visité en continu ; en pratique bien moins, les lignes identiques
  n'étant pas réécrites.
- Purger le fichier est sans effet sur l'application : il ne sert qu'à l'analyse.
