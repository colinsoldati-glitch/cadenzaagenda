# Cadenza v21.1 — développement

Version complète, basée sur la v21.0. Aucune migration Firebase.

## Déployer sur la branche dev
Décompresser à la racine du dépôt GitHub sur `dev`, en conservant les dossiers `js/` et `icons/`. Netlify doit publier cette branche, sans commande de compilation. Ne pas changer le réglage GitHub Pages ni le domaine de production. `CNAME` est conservé tel quel pour permettre la fusion ultérieure. Le branding DEV est activé sur `*.netlify.app`, `dev.*`, localhost et 127.0.0.1 ; les autres noms d'hôte utilisent le branding normal. Si le site de production est un jour hébergé directement sur une adresse netlify.app, adapter la condition `devHost` dans index.html.

## Installer sur iPhone
Après le déploiement, ouvrir l'adresse Netlify dans Safari, actualiser, supprimer l'ancien raccourci de développement de l'écran d'accueil (pas celui de production), puis Partager > Sur l'écran d'accueil. Si l'ancien logo persiste, vérifier le déploiement et le cache Safari. Le titre DEV et les manifestes localisés sont sélectionnés automatiquement. Les icônes PNG 180, 192 et 512 pixels sont incluses.

## Proposer des dates et horaires
1. Choisir le type d'événement et une ou plusieurs dates (passées désactivées).
2. Choisir « Mêmes horaires » pour appliquer un ou plusieurs créneaux à chaque date, ou « Par journée » pour les personnaliser. Les horaires communs sont copiés à la première création de chaque journée personnalisée ; les modifications suivantes restent propres à chaque mode.
3. Choisir journée entière, matin, après-midi, soir ou une heure précise. Les trois raccourcis horaires préremplissent les heures. Ajouter autant de créneaux que nécessaire.
4. Déplier les informations facultatives et le récapitulatif. Le bouton d'envoi est toujours visible. Les heures inversées, doublons du brouillon ou créneaux actifs identiques du même type sont bloqués. La détection des doublons utilise les données reçues localement ; ce n'est pas un verrou transactionnel entre utilisateurs.
5. Les fonctions existantes de précision et de contre-proposition utilisent aussi le nouveau panneau, avec date fixe. Les archives et les conflits d'absence restent signalés. La proposition enregistre toujours le vote Oui de son auteur, comme avant.

## Limites et tests
Tests Chromium avec base Firebase simulée, FR/DE/EN (390/320/768 px) : création, plusieurs horaires communs, personnalisation, changement de mode, suppression, validation des horaires, récapitulatif, sauvegarde, remise à zéro, contre-proposition et régressions v21.0 (votes, notes, annulation, agenda et tableau). Vérification de la syntaxe JavaScript et des manifestes. La sélection du branding a été vérifiée avec des noms d'hôte simulés ; le vrai site Netlify et Safari iOS n'ont pas été testés ici. Le cache PWA a été renouvelé en v21.1. Firebase et le serveur de notifications restent ceux de production : tester uniquement dans un ensemble fictif. Aucun déploiement réel ni envoi de notification n'a été effectué.
