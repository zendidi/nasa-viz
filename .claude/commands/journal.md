---
description: Consigne dans docs/agent/ ce qui vient d'être fait ou décidé, via l'agent docs-journal (Sonnet)
argument-hint: [sujet à consigner, ou rien pour laisser choisir depuis la conversation]
allowed-tools: Agent, Read, Grep, Glob
---

Consigne le travail de cette conversation dans le journal agent.

Délègue à l'agent `docs-journal` (Sonnet) avec le tool Agent. Sujet à consigner :
$ARGUMENTS

S'il n'y a pas d'argument, reprends ce qui a été fait ou décidé dans cette conversation.

Dans le prompt que tu passes à l'agent, fournis-lui **explicitement** — il démarre à froid et ne
voit rien de cette conversation :

- la date du jour, en clair ;
- les faits : ce qui a été changé, fichier par fichier, avec les chiffres mesurés ;
- les décisions, **avec leur raison** et les options écartées ;
- ce qui reste ouvert, et s'il s'agit d'une idée non construite (alors c'est `backlog.md`) ;
- le fichier cible quand tu le sais déjà (`decisions.md`, `gotchas.md`, `backlog.md`).

Ne lui demande pas d'écrire du code, ni de deviner un chiffre que tu ne lui as pas donné.

Quand il a rendu, relis l'entrée ajoutée et rapporte-la à l'utilisateur en une ou deux lignes.
