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

## Backlog de mise en prod

Décision de l'utilisateur du 2026-10-15 : ce fichier tient désormais **le backlog interne de tout ce
qui touche au déploiement**, pour qu'il n'encombre plus le backlog du projet. `docs/agent/backlog.md`
ne porte plus aucune entrée de mise en prod et renvoie ici. Ce qui suit n'est ni daté ni promis :
rien n'est à faire tant qu'une date de mise en ligne n'est pas posée.

### Préchauffage solar-system : brancher sur un vrai cron

La commande `app:solar-system:warm` est livrée (voir « Un cron, pour Horizons cette fois » plus
haut, qui détaille cadence, comportement et mesures — rien n'est dupliqué ici). **Reste** : la
brancher sur un vrai cron en prod, toutes les heures (une fois par jour marche aussi) :

```
0 * * * * cd /chemin/vers/backend && php bin/console app:solar-system:warm
```

plus un passage unique de `php bin/console app:solar-system:warm --all-moons` après chaque
déploiement, et **confirmer que l'offre Infomaniak retenue propose des tâches cron**.

### Vraie clé `NASA_API_KEY`

Toujours sur `DEMO_KEY`. C'est déjà l'étape 1 de « Étapes de mise en prod » ci-dessous : l'entrée
n'est plus qu'un renvoi. Rien à faire pour l'instant (décision de l'utilisateur, 2026-10-15).

### Préchauffage NEO/APOD : cron à brancher

La commande existe depuis le 2026-10-15 : `app:cache:warm`. Elle recalcule de force (même avant
expiration) le flux APOD, et le flux NEO seulement avec `--neo` ; un recalcul qui échoue garde
l'ancienne entrée, et elle sort toujours en code 0. Crontab complet, avec le préchauffage Horizons :

```
0 * * * * cd /chemin/vers/backend && php bin/console app:solar-system:warm && php bin/console app:cache:warm
```

- **APOD tourne à chaque passage** : sans clé (science.nasa.gov), ~24 appels par jour si le cron est
  horaire, sans coût de quota. C'est voulu : une course juste après minuit ne doit pas figer l'image
  de la veille sous la clé du jour.
- **N'ajouter `--neo` qu'avec une vraie `NASA_API_KEY`.** Chaque passage dépense un appel NeoWs : en
  cron horaire, 24 des 50 requêtes par jour de `DEMO_KEY` (calcul, pas mesure) — inacceptable en
  `DEMO_KEY`, négligeable avec une vraie clé (1000 req/h).
- `--dry-run` liste ce qui serait rafraîchi sans rien appeler.
- Même réserve que plus haut : la disponibilité du cron dépend du plan Infomaniak.

### Pré-publication (décidé le 2026-09-29)

**La publication n'est pas prévue.** Décision explicite de l'utilisateur ce jour-là : *« il y aura
un travail de prepublication. Mais la publication n'est pas prevue tant que ce n'est pas explicite
dans le backlog. »* Donc : **rien ici n'est à faire tant que cette section ne porte pas une date de
mise en ligne.** Ne pas traiter ces entrées comme du retard, et ne pas les déclencher au prétexte
qu'une obligation légale est citée — l'obligation ne se déclenche qu'à la distribution publique.

<a id="credits-page"></a>
- **Page de crédits dédiée.** Le lieu unique décidé le 2026-09-29 (voir `docs/agent/decisions.md`),
  plutôt que des attributions saupoudrées dans les panneaux. CC BY 4.0 exige l'attribution **dès la
  distribution** : `web/public/textures/CREDITS.md` la couvre pour le dépôt, la page la couvrira
  pour la mise en ligne. **Due avant toute publication, et seulement à ce moment-là.**
  Matière déjà disponible :
  - Solar System Scope, CC BY 4.0, fichier par fichier (`CREDITS.md`) ;
  - `NEO_CREDITS` (`web/src/neoInfo.js`) : NASA/JPL, ESA NEOCC, IMCCE, NeoWs — aujourd'hui affiché
    seulement dans la fiche d'un NEO, ce qui n'est pas un lieu de publication ;
  - JPL Horizons pour les positions, orbites et orientations ;
  - NASA NSSDCA, *Saturnian Rings Fact Sheet*, pour les rayons d'anneaux (ajouté le 2026-09-29) ;
  - Natural Earth (domaine public) et le gazetteer IAU/USGS, utilisés par les scripts de
    `tools/calibration/` — à citer si ces mesures sont publiées, pas pour le code lui-même.
  - **Dépend d'un arbitrage en attente** : la bascule Terre -> Solar System Scope est faite le
    2026-10-12 mais pas encore validée à l'œil (voir `comparer-textures-terre` dans
    `docs/agent/backlog.md`) ; si la comparaison tourne finalement en faveur des assets three.js,
    la page devra dire noir sur blanc que la Terre reste une exception sous **licence non
    établie**. Depuis le 2026-10-15 (`moon_1024.jpg` retiré), **plus aucun asset three.js n'est en
    service** : l'exception ne revient que si la comparaison Terre favorise le jeu three.js.

## Le cache serveur protège déjà le quota NASA — pas besoin de cron pour ça

`backend/src/Controller/SpaceDataController.php` met déjà chaque route derrière `cache.app` avec un
TTL par type de donnée : NEO 1h, APOD 24h, ISS 5s. Ce cache est partagé entre **tous** les
visiteurs (pas un cache par navigateur comme `web/src/cache.js` côté client) : une fois la première
personne de l'heure déclenché l'appel réel à NASA, tout le monde derrière reçoit la réponse cachée
jusqu'à expiration du TTL — donc au régime permanent, ~1 appel réel/heure pour NEO et ~1/jour pour
APOD, **quel que soit le nombre de visiteurs**. C'est déjà l'équivalent de la règle "1 req/h" visée.

Une tâche cron qui rafraîchit le cache de façon proactive (plutôt que de laisser le premier
visiteur après expiration déclencher l'appel) est désormais possible : `app:cache:warm` existe (voir
« Backlog de mise en prod » plus haut). Elle évite une petite latence supplémentaire pour le
premier visiteur et lisse le compteur `/api/usage` — mais ce n'est **pas un prérequis** pour tenir le
quota. Avec `--neo`, elle dépense elle-même un appel NeoWs par passage, donc seulement avec une
vraie clé.

## Un cron, pour Horizons cette fois — pas pour le quota

La section ci-dessus dit qu'aucun cron n'est nécessaire pour tenir le quota NASA, et ça reste vrai.
Mais depuis les planètes et les lunes, il y en a un qui vaut le coup pour une **autre** raison : la
latence de JPL Horizons, qui est sans clé et hors quota, mais lente et variable.

Mesuré sur cette machine : **~1 s par requête le 2026-09-29, 5 à 16 s le 2026-09-22**, même code et
même `php.ini` — c'est la charge de Horizons qui varie, pas notre installation (voir la correction
dans `docs/agent/gotchas.md`). Sans préchauffage, c'est le premier visiteur après chaque expiration
qui paie, et il peut tomber un mauvais jour.

```bash
cd /chemin/vers/backend && php bin/console app:solar-system:warm
```

**À passer une fois après chaque déploiement**, pour remplir un cache vide sans attendre un
visiteur :

```bash
php bin/console app:solar-system:warm --all-moons
```

`--dry-run` liste ce qui serait téléchargé sans rien télécharger.

### Cadence

**Une fois par heure suffit largement**, et une fois par jour marche aussi. La commande ne
retélécharge que ce qui a expiré : quand tout est frais, elle ne fait aucune requête sortante et
se termine en quelques dizaines de millisecondes. Faire tourner trop souvent ne coûte donc rien,
mais n'apporte rien non plus.

Ordres de grandeur en régime permanent :

| ce qui est rafraîchi | cadence |
|---|---|
| 8 planètes (positions, Pluton compris) + 8 orbites | 1 fois par mois chacune |
| les 39 lunes (Charon comprise), si toutes étaient visitées | ~6 requêtes/jour au total (estimé pour 38 lunes, Charon en plus) |

### Ce qu'elle rafraîchit, et ce qu'elle ne rafraîchit pas

Elle ne parcourt **pas** le catalogue entier. Elle reprend les planètes, plus les lunes des planètes
qu'un visiteur a réellement centrées — la route l'écrit au passage, parce qu'un pool PSR-6 ne sait
pas être énuméré. Une lune que personne n'a jamais regardée n'est jamais téléchargée, et une planète
non visitée depuis 90 jours sort de la liste toute seule.

C'est volontaire et c'est le cœur du dispositif : **remplissage paresseux par les visites,
rafraîchissement anticipé par le cron**. Personne n'attend Horizons sauf le tout premier visiteur
d'une planète donnée.

### Détails qui comptent

- Elle **sort toujours en code 0**. Un échec Horizons est transitoire par nature, la course suivante
  le rattrape, et les routes savent de toute façon télécharger à la demande. Un code non nul ferait
  envoyer un mail par le cron à chaque incident sans rien apporter.
- Elle tourne en **CLI**, où `max_execution_time` vaut 0 contre 30 s pour une requête web (vérifié
  sur cette machine). C'est ce qui lui permet d'enchaîner des dizaines de corps dans un seul
  processus — mesuré : les 8 lunes restantes de Jupiter en 7 s, les 38 lunes en 33 s — là où une
  route web doit s'en tenir à un corps par appel sous peine du fatal à 30 s.
- Elle n'appelle **que** JPL Horizons : aucun quota NASA consommé, le compteur `/api/usage` ne bouge
  pas.

### À vérifier sur l'offre Infomaniak choisie

Comme pour PHP 8.3+ et Composer (voir « Prérequis » plus haut), **la disponibilité des tâches cron
dépend du plan** — à confirmer sur l'offre retenue. Si l'hébergement n'en propose pas, rien ne
casse : le cache se remplit à la demande comme aujourd'hui, seul le premier visiteur de chaque
planète paie la latence.

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

## Faire tourner le site sur une machine sans outils de développement

Vérifié le 2026-09-22 : **PHP seul suffit**, ni Node, ni Composer, ni serveur web à installer.

1. Sur la machine de dev : `cd web && npm run build` (le lanceur recopie `web/dist/` dans
   `backend/public/` tout seul à chaque démarrage — il n'y a plus à le faire à la main).
2. **Copier le dossier du projet entier** sur la machine cible, y compris `backend/vendor/`
   (~29 Mo, ce qui rend Composer inutile là-bas) et `web/dist/`. Ces deux dossiers sont dans
   `.gitignore` : un `git clone` ne les contient pas, il faut alors `composer install` +
   `npm install && npm run build`. `web/node_modules/` n'a pas à être copié.
3. Sur la machine cible, **deux double-clics** :
   - `Installer-PHP.bat` — ne fait rien si un PHP 8.3+ est déjà là ; sinon télécharge le zip
     officiel de windows.php.net (version choisie dans `releases.json`, SHA256 vérifié), le
     décompresse dans `tools/php/` et y écrit un `php.ini` activant `openssl`, `curl`, `mbstring`,
     `fileinfo`. Aucun droit admin, PATH et registre inchangés ; désinstaller = supprimer
     `tools/php/`. Arguments : `Installer-PHP.bat 8.3`, `Installer-PHP.bat --force`.
   - `Lancer-NASA-Viz.bat` — vérifie PHP (`tools/php/` d'abord, puis le PATH) et `vendor/`, crée
     `.env` depuis `.env.example`, recopie `web/dist/` dans `backend/public/` (sans toucher
     `index.php`), prend le premier port libre à partir de 8010, **attend que le serveur réponde
     vraiment en HTTP** avant d'annoncer l'URL, l'affiche, la copie dans le presse-papiers, l'écrit
     dans `tools/derniere-url.txt` et ouvre le navigateur. Arguments :
     `Lancer-NASA-Viz.bat 8080 --no-open`, et `--dev` pour lancer en plus le serveur Vite
     (demande Node + `npm install`, et impose le port 8000 côté backend puisque
     `web/vite.config.js` y proxifie `/api` en dur).

   Les deux `.bat` ne font que déléguer à `tools/start.ps1` et `tools/install-php.ps1`, lancés en
   `-ExecutionPolicy Bypass` pour ne rien exiger de la machine. Équivalent manuel depuis
   `backend/` : `php -S 127.0.0.1:8000 -t public`.

Le même processus sert la page, les assets et `/api/*` : même origine, donc pas de CORS.

**Piège `DirectoryIndex`** : une requête sur `/` est une requête de répertoire, et Apache comme le
serveur intégré de PHP préfèrent `public/index.php` (Symfony) à `public/index.html` — sans rien,
la racine répond 404 alors que tous les autres fichiers sont servis. D'où la route `/` de
`App\Controller\FrontendController`, qui renvoie `public/index.html` quand le build est là, et un
petit texte listant les routes d'API sinon. Ne pas la supprimer en croyant à du code mort.

Limites de ce mode « poste isolé » : serveur PHP mono-processus (une requête à la fois, suffisant
pour un poste), `APP_ENV=dev` par défaut (plus lent et plus bavard — passer `APP_ENV=prod` +
`APP_SECRET` dans `backend/.env.local` pour un usage prolongé), et `DEMO_KEY` toujours limitée à
50 requêtes NASA par jour et par adresse IP.
