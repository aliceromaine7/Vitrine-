VITRINE CHARIOW — IMPORT AUTOMATIQUE CÔTÉ SERVEUR

Cette version ne tente plus de lire Chariow depuis le navigateur.
Le navigateur appelle /api/chariow-import et le Worker Cloudflare contacte Chariow côté serveur.

FICHIERS
- public/index.html : ta vitrine
- src/index.js : Worker/API d'import Chariow
- wrangler.toml : configuration Cloudflare Workers Static Assets

SECRET À AJOUTER
CHARIOW_API_KEY = ta clé API Chariow

IMPORTANT
Cette version est destinée à Cloudflare Workers + Static Assets, pas au simple Direct Upload d'un projet Pages.
Cloudflare recommande aujourd'hui Workers Static Assets pour les sites qui ont à la fois des assets statiques et une logique serveur.

DÉPLOIEMENT AVEC WRANGLER
1. Décompresse le ZIP.
2. Dans le dossier du projet, ouvre un terminal.
3. Lance : npx wrangler login
4. Ajoute le secret : npx wrangler secret put CHARIOW_API_KEY
5. Déploie : npx wrangler deploy

Après déploiement, teste la vitrine puis colle :
https://chariow.ly/K0IRALEG39

Le bouton Importer automatiquement doit remplir les champs sans message « le lien est conservé ».
