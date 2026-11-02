# NASA Viz sous Linux

Pendant Linux de `Lancer-NASA-Viz.bat`. Prévu pour Ubuntu/Debian, Fedora et Arch ; openSUSE en
best effort.

## Lancer

**Double-cliquez `NASA-Viz.desktop`**, puis attendez : un terminal s'ouvre, puis le navigateur sur
`http://127.0.0.1:8010/`.

Selon le bureau, le premier double-clic demande une confirmation :

| Bureau | Ce qu'il faut faire la première fois |
|---|---|
| KDE (Dolphin), Xfce, Cinnamon, MATE | accepter « Exécuter » / « Faire confiance » |
| GNOME (Ubuntu, Fedora) | `.desktop` ouvert comme texte ? Clic droit sur **`lancer-nasa-viz.sh`** → « Exécuter comme un programme » |

Ou, dans un terminal : `bash LINUX/lancer-nasa-viz.sh`

**Laissez le terminal ouvert** tant que vous utilisez le site. Pour arrêter : Ctrl+C ou fermer la
fenêtre.

## Le premier lancement prend quelques minutes

Il prépare tout ce qui manque, puis les lancements suivants démarrent en quelques secondes :

1. **PHP 8.3+, curl, unzip** — s'ils manquent, le script propose de les installer avec le
   gestionnaire de paquets (apt, dnf, pacman, zypper). C'est la seule étape qui demande **le mot de
   passe administrateur**. Ubuntu 22.04 et Debian 12 n'ont pas PHP 8.3 : sous Ubuntu le script
   propose le dépôt `ppa:ondrej/php`, sous Debian il indique la marche à suivre.
2. **Composer** puis les dépendances PHP — téléchargés dans le projet.
3. **Node** (si celui du système manque ou date d'avant 20.19) puis le build du site —
   téléchargé dans `LINUX/.local/node/`, rien n'est installé dans le système.

Il faut une connexion Internet pour ce premier lancement, et ensuite pour les données du site.

Après un `git pull`, le lanceur refait lui-même ce qui a changé (dépendances, build).

## Options

```bash
bash LINUX/lancer-nasa-viz.sh 8080        # autre port (le suivant libre si occupé)
bash LINUX/lancer-nasa-viz.sh --no-open   # ne pas ouvrir le navigateur
bash LINUX/lancer-nasa-viz.sh --dev       # serveur Vite en plus, rechargement à chaud
```

## En cas de problème

- **Le terminal se ferme tout de suite** : lancez `bash LINUX/lancer-nasa-viz.sh` dans un terminal
  pour lire le message.
- **Rien ne s'ouvre, aucun terminal** : la sortie est dans `LINUX/.local/derniere-session.log`.
- **Le navigateur ne s'ouvre pas** : l'URL est affichée dans le terminal et écrite dans
  `LINUX/derniere-url.txt`.
- **Tout recommencer** : supprimer `LINUX/.local/`, `backend/vendor/`, `web/node_modules/`,
  `web/dist/`.

Désinstaller : supprimer le dossier du projet. Les paquets système (PHP, curl, unzip) restent, ils
se retirent avec le gestionnaire de paquets.
