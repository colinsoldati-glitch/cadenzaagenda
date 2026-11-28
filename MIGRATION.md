# Cadenza v23.0.0-rc1 — Comptes utilisateurs

**Statut : version candidate à valider sur un projet Firebase distinct avant production.** Cette archive modifie le site statique fourni, sans accès à GitHub, au Firebase en production ni aux Workers externes. Aucun déploiement, aucune migration réelle et aucune modification de données de production n'ont été effectués.

## Ce qui change

- Firebase Authentication : e-mail/mot de passe, vérification de l'adresse, réinitialisation et déconnexion.
- Un tableau de bord au démarrage : anciens profils détectés sur l'appareil, ensembles liés, prochains événements, sondages restant à traiter et indisponibilités globales. Actualisation à la demande; chaque ensemble conserve son écoute temps réel.
- Un profil historique reste identifié par son `mbr-...`; l'identifiant de l'ensemble et tous les votes, notes, sondages, archives et événements restent en place. L'utilisateur confirme le rattachement des profils détectés. Si un autre appareil est utilisé, le code/lien d'invitation permet de récupérer un profil non encore lié. Les anciens liens avec `member=` sont uniquement des indications de récupération et ne permettent pas une connexion automatique.
- L'identité de compte est le `uid` Firebase. Aucun mot de passe n'est stocké par Cadenza dans Realtime Database. L'e-mail n'est pas répliqué dans les ensembles.
- Nouveaux chemins : `accounts/{uid}/memberships/{ensembleId}` = `memberId`; `profileOwners/{ensembleId}/{memberId}` = `uid`; `accounts/{uid}/absences/{absenceId}` = indisponibilité personnelle. Le champ `revision` protège les opérations concurrentes du client : en cas de conflit, l'opération est rejetée en bloc; actualiser et réessayer.
- Les absences existantes de chaque profil sont importées à son rattachement et leur union est répliquée vers les profils déjà liés. Les périodes exactement identiques (dates + motif) sont dédoublonnées; les chevauchements avec motifs différents restent séparés et les collisions d'identifiants sont renommées sans écraser une période. Les dates passées sont incluses. Les motifs sont visibles dans les ensembles : informer les membres avant le lancement. Aucun vote n'est modifié automatiquement par une absence. Les nouvelles absences et suppressions sont appliquées à tous les ensembles liés en une écriture atomique. Les nouveaux ensembles reçoivent également les absences existantes.
- Les groupes et calendriers restent collaboratifs : le modèle d'édition des sondages/archives/agenda existant est conservé. Une suppression volontaire d'événement, de sondage ou de membre par un utilisateur autorisé n'est pas une migration.

## 1 — Sauvegarder AVANT toute intervention

1. Dans la console Firebase, vérifier le projet actuel `cadenza-dad79`, ouvrir **Realtime Database > Données**, choisir la racine `/`, puis **⋮ > Exporter JSON**. Garder le fichier privé et chiffré, hors de GitHub. Vérifier qu'il contient bien `ensembles`, les membres, les votes, les événements et les archives, ainsi que les éventuels autres nœuds. Exporter également les règles actuellement publiées dans un fichier séparé.
2. Créer un tag Git de la v22.1.4 ou sauvegarder la branche actuelle et noter le commit en production. Sauvegarder les configurations des Workers/calendrier et de leurs données propres. Un export JSON RTDB ne sauvegarde PAS Firebase Authentication ni les données des Workers.
3. Ne jamais importer un fichier JSON vide ou la structure d'exemple par-dessus la base de production. Les nouvelles collections sont créées automatiquement à la première connexion/récupération. Aucun script de réécriture globale n'est nécessaire.

## 2 — Tester sur un Firebase séparé

- Créer un projet de test distinct (pas une seconde URL pointant sur le même projet), activer Realtime Database, utiliser des données synthétiques représentatives : deux ensembles avec la même personne sous deux IDs différents, votes, archives, agenda, absences doublonnées et différentes, responsable. Ne pas envoyer des données personnelles réelles sur un hébergement de test public.
- Dans **Authentication > Sign-in method**, activer **Email/Password** (pas Email link). Dans **Authentication > Settings > Authorized domains**, ajouter le domaine du site de test. Configurer une politique de mots de passe (au moins 8 caractères recommandés) et les modèles d'e-mails. Vérifier la délivrabilité et la procédure de confirmation.
- Dans **Project settings > Your apps**, créer/récupérer la configuration Web du projet de test et la coller dans `js/firebase-environment.js` à la place de `null`. Sur les hôtes DEV (localhost, dev.*, *.netlify.app), la version refuse de démarrer si ce fichier n'est pas renseigné. Les endpoints push/calendrier de production sont désactivés sur ces hôtes. Sur d'autres hôtes de prévisualisation, adapter le détecteur `CADENZA_DEV` dans `app/index.html` avant publication : ne pas tester avec la configuration production.
- Publier `database.rules.json` **uniquement dans le projet de test** dans Realtime Database > Règles. Créer un utilisateur de test, confirmer l'e-mail, et effectuer la matrice ci-dessous. Le code ne crée pas d'administrateur automatiquement.
- L'interface d'administration requiert le UID autorisé et l'ancien PIN. Dans la console RTDB, sous `admin_users`, ajouter la clé UID de l'administrateur avec la valeur booléenne `true` (pas la chaîne de caractères). Conserver `admin_config/secret_pin` déjà existant. Ne jamais écrire de PIN ou de clé de service dans GitHub.

### Tests automatisés

Les cinq tests du module de fusion ont été exécutés et réussis. Le résultat figure dans `tests/model-results.txt`. Les modules JS et le service worker passent le contrôle de syntaxe Node et le JSON des règles est syntaxiquement valide. Cela ne remplace pas la validation des règles Firebase.

Pour exécuter les tests des règles avec un émulateur (nécessite Node, Java et Firebase CLI; dépendances non disponibles dans l'environnement ayant produit cette archive) :

```sh
npm install --prefix tests
npm install -g firebase-tools
firebase emulators:exec --only database --project demo-cadenza 'npm --prefix tests run test:rules'
```

La commande vise un projet `demo-` et utilise un jeu de données fictif. Elle ne doit jamais être exécutée avec un identifiant de projet réel. Les tests vérifient les accès anonymes/refusés, le rattachement, la seconde revendication du même profil, les absences atomiques, l'isolement de compte, les permissions administrateur et la création de groupe. **Ne pas considérer la RC prête tant que cette suite n'est pas passée.**

### Matrice de recette manuelle (projet de test)

| Cas | Résultat attendu |
|---|---|
| Ancienne session locale avec deux groupes, inscription | Deux anciens profils proposés, aucun rattachement sans confirmation |
| Récupération du premier puis du second profil | Mêmes IDs, votes, notes, archives, agenda; union des absences |
| Nouvelle installation, même compte | Les groupes sont retrouvés sans lien personnel ni codes |
| Nouveau compte, ancien lien de transfert vers profil revendiqué | Récupération refusée, aucun écrasement |
| Deux comptes récupérant le même profil en parallèle | Un seul succès, l'autre refusé |
| Même compte sur deux appareils, modifications concurrentes | Une écriture concurrente invalide est refusée, actualiser puis réessayer |
| Créer un ensemble et rejoindre un existant | Nouveaux IDs aléatoires, compte lié, absences globales copiées |
| Déclarer/supprimer depuis la vue compte ou ensemble | Répercussion sur chaque profil lié, y compris conflits proposés |
| Responsable, membre, gestion partagée, départ | Contrôles conformes au mode de gestion, aucun accès à un compte tiers |
| Votes simples, groupés, annulation, notes, archivage, récupération, édition | Comportement historique conservé |
| Déconnexion puis connexion avec un autre compte | Aucun groupe du compte précédent dans son espace; vérifier notifications |
| Mot de passe oublié, adresse non vérifiée | Envoi du lien; accès aux données refusé tant que non vérifié |
| Administration (UID inscrit + PIN), retours, statistiques | Accès admin seulement; réponses utilisateur individuelles |
| iPhone PWA, Android PWA, Safari/Chrome, FR/DE/EN | Login et migration; cache v23; navigation et traduction correctes |
| Workers push, rappel veille, abonnement .ics | À tester séparément après adaptation des services; voir ci-dessous |

## 3 — Points de sécurité restant à traiter avant production

Les anciennes règles autorisaient la lecture publique des ensembles, les écritures anonymes, et l'accès public aux retours. Les nouvelles règles ferment l'accès anonyme aux données et le listing global des ensembles (sauf admin), isolent les comptes, exigent un e-mail vérifié, et empêchent un changement client du propriétaire d'un profil revendiqué. Les règles vérifient l'appartenance pour les écritures sur groupes existants. Les nouveaux codes d'ensemble sont générés par `crypto.getRandomValues` avec 128 bits aléatoires.

**Compromis assumé pour la migration de confiance :** les utilisateurs vérifiés disposant d'un code d'ensemble (y compris un ancien code court ou deviné) peuvent lire cet ensemble complet et réclamer un profil non revendiqué. Cela inclut les données de groupe, les motifs d'absence, les identifiants et les anciens champs FCM. Ce n'est pas une confidentialité stricte réservée aux membres. Les sondages/archives/agenda restent modifiables par les membres authentifiés, y compris les votes car l'ancien modèle permet la réinitialisation/réouverture de sondages et les transactions à ce niveau. La revendication d'un profil empêche de réattribuer son UID, mais ne fournit pas une preuve de l'identité de la personne avant la première revendication. Pour une sécurité plus forte, remplacer ensuite ce mécanisme par invitations à usage unique générées côté serveur, un annuaire de récupération minimal, lecture réservée aux membres, et mutations serveur/permissions granulaires sur votes. Ne pas rouvrir la lecture globale ni les règles publiques pour dépanner.

**Services externes non fournis dans l'archive.** Le code de `cal.cadenzaapp.ch` et `cadenza-notifications.colinsoldati.workers.dev` n'est pas présent. Si ces Workers utilisent un accès REST Firebase anonyme, les nouvelles règles les bloqueront; s'ils utilisent déjà des identifiants de service privilégiés, ils peuvent continuer mais leur propre autorisation doit être vérifiée. Avant production : faire vérifier le Firebase ID token côté serveur pour les requêtes de création de souscription et d'envoi de notification, vérifier UID/propriété/appartenance dans les nouveaux chemins, ne pas exposer de clé privilégiée au navigateur, limiter les abus, protéger les tokens et contrôler les liens .ics existants. Les calendriers abonnés ont besoin de leurs liens secrets et doivent rester révocables. La v23 révoque le token FCM de l'installation lors de la déconnexion quand possible; une réactivation des notifications peut être nécessaire. Le client d'origine n'enregistre qu'un token FCM par membre (pas un modèle multi-appareil complet). Les téléchargements .ics unitaires restent générés côté navigateur. **Ne pas publier en production tant que le calendrier/push/rappels n'ont pas été validés ou explicitement désactivés.**

Les anciennes réponses de feedback, indexées par appareil, sont conservées. Les nouvelles sont indexées par UID; une campagne déjà répondue depuis un ancien appareil peut être comptée une seconde fois. Clore les campagnes actives avant la migration si nécessaire. Les réponses et votes historiques des ensembles ne sont pas convertis.

Un profil revendiqué par erreur ne doit pas être supprimé : effectuer une correction contrôlée avec les outils administrateurs Firebase (sauvegarde, vérification de l'identité, correction des deux chemins `accounts/.../memberships` et `profileOwners/...`, revue des absences importées). Ne pas déplacer les identifiants historiques. Le départ volontaire d'un groupe conserve l'UID réservé sur l'ancien profil pour éviter une reprise frauduleuse; le profil et ses votes actifs sont retirés comme dans la v22.1.4.

## 4 — Mise en production (après validation)

1. Communiquer la migration et demander aux membres de ne pas supprimer la PWA ni effacer les données locales avant d'avoir récupéré tous leurs profils. Prévoir un créneau de maintenance. Activer Email/Password sur le vrai projet Firebase et autoriser `cadenzaapp.ch` (et `www.cadenzaapp.ch` seulement s'il est utilisé) dans Authentication. Le domaine et les DNS Infomaniak n'ont pas besoin de changer si le site reste hébergé comme auparavant. Tester e-mails et réinitialisation.
2. Créer ton compte administrateur, vérifier son adresse et noter le UID de Firebase Authentication. Ajouter ce UID sous `admin_users/{uid}: true`. Conserver le PIN privé actuel. Préparer les services externes. Ne jamais copier les données de test dans la base réelle.
3. Bloquer les écritures clients pendant la bascule en publiant `database.rules.maintenance.json`; suspendre aussi les tâches Workers qui écrivent via des identifiants privilégiés. Exporter une dernière sauvegarde de la base à cet instant. Ce fichier de maintenance bloque aussi les lectures : c'est normal pendant cette fenêtre.
4. Publier les fichiers de l'archive sur une branche GitHub de préparation, puis déployer leur contenu au même emplacement que la v22.1.4 sur la branche de production. Garder `CNAME`, les fichiers du site et le chemin `/app/`. Vérifier que le site sert bien les nouveaux fichiers et le service worker `v23.0.0-rc1`. Le fichier `database.rules.json` n'est pas automatiquement appliqué par GitHub Pages.
5. Publier **les nouvelles règles complètes `database.rules.json`** dans Firebase Realtime Database > Règles. Tester immédiatement connexion/récupération sur un ensemble de contrôle, puis ouvrir progressivement. Les anciens clients non authentifiés seront refusés; leur demander de fermer et rouvrir Cadenza/actualiser. Ne pas leur dire d'effacer le stockage local : il contient les indications de récupération.
6. Vérifier les premières récupérations et les statistiques. Les membres encore sans compte ne disparaissent pas; ils restent dans les ensembles et récupèrent plus tard. Les utilisateurs peuvent récupérer plusieurs profils sur le même compte.

## 5 — Retour arrière / surveillance

- En cas de problème, bloquer les écritures et suspendre les Workers. Exporter la base **après** incident, sauvegarder les comptes/UID et les nouveaux liens, conserver les deux exports. Ne pas écraser des modifications légitimes survenues depuis la première sauvegarde.
- Revenir au commit précédent ne suffit pas : la v22 ne sait pas utiliser les comptes et est incompatible avec les nouvelles règles. L'ancien fonctionnement anonyme était vulnérable; ne pas rétablir publiquement ces règles sans accepter ce risque. Préférer corriger la RC sous maintenance, ou préparer un retour arrière spécifique à partir des données sauvegardées. Ne restaurer un export complet que si une perte est constatée et après réconciliation des écritures postérieures.
- Un contrôle avant/après est possible avec le script lecture seule `tests/audit_backup.py avant.json apres.json`. Il signale les ensembles/profils/sondages/événements/archives et votes historiques disparus ou modifiés; les différences légitimes après ouverture ne sont pas automatiquement des pertes. Exécuter localement, pas dans GitHub Actions avec des exports privés.

## Message prêt à transmettre aux membres

Cadenza évolue ! À votre prochaine ouverture, créez votre compte avec votre adresse e-mail, confirmez-la, puis rattachez chacun de vos anciens profils proposés. Vos votes, répétitions et événements existants restent dans leurs ensembles. Si un profil n'apparaît pas, utilisez le code ou le lien d'invitation de votre ensemble, puis sélectionnez votre nom. Ne récupérez que vos propres profils. Les périodes d'absence et leur motif seront désormais partagés entre tous les ensembles liés à votre compte. En cas de doute, contactez le responsable plutôt que de créer un doublon. Vous pourrez ensuite retrouver vos ensembles sur n'importe quel appareil avec le même compte.

## Documentation Firebase officielle

- Authentification par mot de passe : https://firebase.google.com/docs/auth/web/password-auth
- Règles Realtime Database : https://firebase.google.com/docs/database/security
- Écritures multipaths : https://firebase.google.com/docs/database/web/read-and-write
