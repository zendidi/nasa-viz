---
description: Lance les trois vérifications automatiques du projet (PHPUnit + PHPStan backend, build Vite web) et rapporte les chiffres réels
allowed-tools: Bash, Read, Grep, Glob
---

Lance les trois vérifications automatiques du projet, **en parallèle dans un seul message**
(elles sont indépendantes) :

```bash
cd backend && php bin/phpunit
```

```bash
cd backend && php vendor/bin/phpstan analyse --no-progress
```

```bash
cd web && npm run build
```

Si `php` n'est pas sur le PATH, utilise le binaire embarqué `tools/php/php.exe`.

Puis rapporte, en quelques lignes :

- le nombre de tests et d'assertions passés, et le détail de **chaque** échec s'il y en a ;
- le résultat de PHPStan. Il est configuré au **niveau 5 sur `src/` et `tests/`, avec zéro erreur
  et zéro entrée de baseline** (`backend/phpstan.dist.neon`) : une erreur ici est donc une
  régression réelle, jamais du bruit de fond. Ne la fais pas taire — ni `@phpstan-ignore`, ni
  baseline, ni `@var` inline, ni élargissement de type. Remonte à la cause ;
- si le build Vite a réussi, et le poids des bundles produits ;
- pour chaque échec, la cause probable et le fichier concerné — mais **ne corrige rien** sans que
  l'utilisateur l'ait demandé.

Rappelle, seulement s'il reste des modifications non vérifiées dans `web/src`, que la scène 3D
n'est pas couverte par ces commandes : le visuel se valide à l'œil par l'utilisateur, les tests
navigateur étant interdits sur ce projet.

N'appelle jamais `/api/neo` ni `/api/apod` dans le cadre de cette vérification — elles dépensent
le quota `DEMO_KEY`. `GET /api/usage` est gratuit si tu as besoin du compteur.
