# Mes Outils d'Animation

Ce projet contient deux outils accessibles depuis un menu d'accueil :

1. **Quizz Live** (existant, inchangé) — accessible sur `/quizz.html`
2. **Facilitation** (nouveau) — accessible sur `/facilitation.html`

## Installation

```bash
npm install
npm start
```

Le serveur démarre par défaut sur le port défini par la variable d'environnement `PORT` (3000 si non définie).
Ouvrez `http://localhost:3000/` pour accéder au menu.

## Configuration de l'envoi d'email (module Facilitation)

Les identifiants SMTP vont dans un fichier `.env` à la racine (à créer toi-même, voir section Sécurité ci-dessous) :

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=...
SMTP_PASS=...   (mot de passe d'application Gmail)
SMTP_FROM=...
```

Un fichier `.env.example` (sans secret réel) est fourni comme modèle : copie-le en `.env` et remplis tes identifiants.

```bash
cp .env.example .env
```

## Persistance des données (survie aux redémarrages Render)

Render efface le disque local à chaque redéploiement ou réveil du service (comportement standard, y compris sur le plan gratuit). Le module Facilitation utilise donc **le même mécanisme que le module Quizz** : à chaque création/modification/duplication/archivage d'une séquence (ou modification des publics/lieux), le fichier JSON correspondant est automatiquement recopié dans le dépôt GitHub via l'API, en utilisant les variables d'environnement déjà en place pour le Quizz :

```
GITHUB_TOKEN=...
GITHUB_REPO_OWNER=...
GITHUB_REPO_NAME=...
```

Si elles sont déjà configurées sur Render pour le quizz, le module Facilitation les réutilise automatiquement — rien à faire de plus. Au démarrage, le serveur va aussi chercher sur GitHub les séquences et la config qui ne seraient plus présentes localement, pour les restaurer.

⚠️ Seule la **structure** des séquences (nom, groupes, étapes, informations) est synchronisée. Les résultats saisis en direct pendant une session (idées, retenues) restent uniquement en local pendant la session, pour ne pas multiplier les appels à l'API GitHub — pense à exporter/télécharger le CSV en fin d'atelier.

## ⚠️ Si le lien "Quizz" affiche une erreur (page introuvable)

Cela signifie que le fichier `public/quizz.html` n'a pas été correctement déposé sur GitHub (ou n'a pas encore été déployé). Vérifie sur la page GitHub de ton dépôt, dans le dossier `public/`, que le fichier `quizz.html` est bien présent — sinon re-uploade-le (voir section Installation), puis relance un déploiement sur Render ("Manual Deploy → Deploy latest commit").

## 🔒 Sécurité : ne jamais versionner `.env`

Ce projet est livré avec :
- un `.gitignore` qui exclut `.env` (et `node_modules/`)
- un `.env.example` sans secret, à copier en `.env`
- un script `secure-secrets.sh` qui automatise le nettoyage si tu pousses ce projet dans **ton propre dépôt Git**

**Avant ton premier `git push`**, à la racine de ton dépôt :

```bash
chmod +x secure-secrets.sh
./secure-secrets.sh
```

Ce script :
1. Vérifie que `.env` est bien dans `.gitignore`
2. Le retire du suivi Git s'il y était déjà (sans le supprimer de ton disque)
3. Recherche s'il a déjà été commité dans l'historique et te préviens si c'est le cas, avec la marche à suivre (régénérer le mot de passe Gmail + nettoyer l'historique avec `git-filter-repo`)

Si le script t'indique que `.env` a été trouvé dans l'historique, régénère le mot de passe d'application Gmail immédiatement sur https://myaccount.google.com/apppasswords — c'est la seule action réellement indispensable, le nettoyage d'historique est un plus.


## Utilisation du module Facilitation

### Côté animateur
1. Aller sur `/facilitation.html` → "Je suis l'animateur"
2. Créer une séquence (nom, descriptif, public, lieu, heure de démarrage, email destinataire)
3. Ajouter des groupes (nom + couleur) si besoin
4. Ajouter des étapes — l'horaire prévu (début/fin) de chaque étape s'affiche automatiquement si une heure de démarrage a été renseignée :
   - **Travail individuel** : chaque participant peut saisir plusieurs idées, les modifier ou les supprimer, en privé
   - **Mise en commun** : reprend les saisies d'une étape individuelle, permet de "retenir" des idées, les réordonner, en ajouter, les supprimer
   - **Temps libre** : simple minuteur + message pour l'animateur
5. Lancer la session directement depuis la liste des séquences (bouton "🚀 Lancer") ou depuis l'éditeur.
6. Un **QR code** et un **lien à copier** s'affichent pour inviter les participants (`facilitation.html?role=participant&seq=...`) — ils arrivent directement sur l'écran pour rejoindre.
7. Démarrer les étapes une à une depuis la chronologie, contrôler le timer, suivre en direct les saisies des participants pendant une étape individuelle, gérer les groupes (répartition automatique ou affectation manuelle par clic) et consulter la composition de chaque groupe à tout moment.
8. Télécharger l'extraction CSV ou l'envoyer par email depuis le panneau "Extraction des travaux".

### Côté participant
1. Scanner le QR code (ou ouvrir le lien) fourni par l'animateur, ou aller sur `/facilitation.html` → "Je suis participant" et saisir le code de session + son prénom
2. Son prénom et son groupe s'affichent en haut de l'écran
3. Suivre le déroulé : consignes, minuteur (orange à 5 minutes restantes, rouge à 2 minutes), zone de saisie (ajout/modification/suppression de plusieurs idées) ou visualisation des idées partagées selon le type d'étape

## Données

Les séquences, groupes, étapes et résultats sont stockés en fichiers JSON dans `data/facilitation/`. La liste des publics/lieux paramétrables est dans `data/facilitation/config.json`.

- **Dupliquer une séquence** (bouton "⧉ Dupliquer" dans la liste) : crée une copie avec les résultats remis à zéro, pour la réutiliser telle quelle ou la modifier.
- **Archiver** : masque une séquence de la liste active sans la supprimer (historisation).

## Fonctionnalités prévues dans une prochaine itération (non incluses dans cette version)

Pour livrer rapidement une base fonctionnelle, certains points avancés du cahier des charges initial sont volontairement simplifiés et seront ajoutés ensuite si besoin :
- Priorisation par points pondérés (barème 5-3-2-1-1, etc.) — actuellement la mise en commun permet de retenir/réordonner les idées manuellement.
- Restitution en matrice visuelle (colonnes/lignes type Keep/Improve/Stop/Start).
- Affectation des participants aux groupes par glisser-déposer (actuellement : sélection par clic).
- Regroupement automatique en 3 temps façon méthode "1-2-4-tous".

## Structure du projet

```
server.js                → serveur principal (quizz existant + branchement du module facilitation)
facilitation-server.js   → API REST + Socket.io du nouvel outil
public/index.html        → menu d'accueil
public/quizz.html         → application Quizz (ex index.html, inchangée)
public/facilitation.html → application Facilitation (nouveau)
data/facilitation/       → données du module Facilitation (JSON)
.env.example              → modèle de variables d'environnement (à copier en .env)
.gitignore                 → exclut .env, node_modules, données de session
secure-secrets.sh          → script à lancer avant ton premier push (voir Sécurité)
```
