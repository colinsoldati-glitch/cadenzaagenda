# Cadenza v21.0 — Disponibilités et Agenda

Cette archive contient le projet complet fourni, avec l'arborescence attendue par `index.html` et `sw.js`.

## Installation

1. Sauvegarder le dépôt ou créer une branche de test depuis la version v20.4.
2. Décompresser cette archive à la racine du site (là où se trouve `index.html`). Conserver les modules dans `js/`.
3. Remplacer les fichiers correspondants, sans effacer les autres fichiers éventuels du dépôt.
4. Tester de préférence avec un ensemble de test avant de publier sur le site de production.
5. Publier la mise à jour. Le service worker utilise désormais `cadenza-cache-v21.0` et supprime les anciens caches Cadenza lors de son activation. Si nécessaire, fermer et rouvrir la PWA après la publication.

## Changements

- Disponibilités : vue Liste intelligente, sections automatiques, plusieurs horaires visibles par date et type d'événement, cartes compactes et détails dépliables, compteurs et progression, résultats par musicien, notes et lieux, vote rapide guidé et sélection multiple.
- Comparer : matrice avec date et colonne personnelle fixes, score visible sans défilement horizontal, tri chronologique ou par pertinence, accès direct aux détails.
- Agenda : prochain événement mis en évidence, compteurs, filtres par type, regroupement mensuel, détails dépliables, historique et export calendrier existant.
- Traductions FR / DE / EN, zones tactiles, contraste et prise en compte de la préférence de réduction des animations.
- Écritures de vote, de notes et de lieux via transactions Firebase afin de ne pas recréer un créneau supprimé. La validation d'un créneau et la création de son événement sont regroupées dans une mise à jour atomique.

## Fichiers modifiés

`index.html`, `styles.css`, `sw.js`, `js/polls.js`, `js/agenda.js`, `js/config.js`, `js/translations.js`.

Les autres fichiers fournis sont inclus sans modification. Les identifiants Firebase, la structure des données, la configuration de notifications, le domaine CNAME et les clés de stockage des sessions sont conservés. Aucune migration de données n'est prévue. Les transactions nécessitent les autorisations Firebase de lecture et d'écriture sur les chemins concernés : vérifier les règles réelles de production avant déploiement.

## Choix et limites

- Les créneaux sont classés par statut, puis regroupés par date et type à l'intérieur de chaque section : une journée peut donc apparaître dans plusieurs sections si ses créneaux ont des statuts différents.
- La sélection multiple ne concerne que les créneaux encore sans réponse personnelle, afin de ne pas écraser involontairement des votes existants.
- L'annulation du dernier vote individuel est disponible tant que le créneau est actif et que la réponse correspond encore au dernier vote. Si un vote déclenche l'archivage automatique, le créneau doit être récupéré depuis les archives selon la logique existante.
- La validation d'un créneau non unanime reste possible depuis les détails, comme auparavant ; le nombre de membres disponibles est indiqué dans la confirmation.
- La progression personnelle concerne les créneaux actifs, hors archives et événements déjà planifiés.

## Vérifications effectuées

- Syntaxe de tous les fichiers JavaScript et validité des manifestes JSON.
- Présence des ressources déclarées dans le cache de la PWA.
- Interface dans Chromium avec les fichiers HTML, CSS et modules réels, mais Firebase simulé en mémoire : français (390 px), allemand (320 px), anglais (768 px).
- Vote rapide avec note, annulation, sélection et vote groupé, matrice, sauvegarde de note, affichage des archives, récupération d'une archive, validation vers l'agenda, archivage automatique, filtres et historique.

Les tests ont utilisé des données fictives et un harnais de démarrage isolé. Ils ne valident pas l'authentification, les règles de production, la synchronisation réelle entre plusieurs appareils, les notifications push, l'installation/mise à jour réelle du service worker ni Safari iOS. Aucun changement n'a été envoyé à la base de production.
