#!/usr/bin/env bash
# ============================================================
#  secure-secrets.sh
#  À lancer à la RACINE de ton dépôt Git réel (pas dans ce zip).
#  Automatise le retrait du fichier .env du suivi Git et
#  détecte s'il a déjà été exposé dans l'historique.
# ============================================================
set -e

if [ ! -d ".git" ]; then
  echo "❌ Ce dossier n'est pas un dépôt Git (pas de dossier .git). Lance ce script à la racine de ton projet cloné."
  exit 1
fi

echo "== 1. Vérification du .gitignore =="
if ! grep -qxF ".env" .gitignore 2>/dev/null; then
  echo ".env" >> .gitignore
  echo "✔ .env ajouté au .gitignore"
else
  echo "✔ .env est déjà dans .gitignore"
fi

echo ""
echo "== 2. Retrait de .env du suivi Git (le fichier reste sur ton disque) =="
if git ls-files --error-unmatch .env > /dev/null 2>&1; then
  git rm --cached .env
  git add .gitignore
  git commit -m "Sécurité: retire .env du suivi git, ajoute .gitignore"
  echo "✔ .env retiré du suivi et commit créé. Pense à faire 'git push'."
else
  echo "✔ .env n'est pas actuellement suivi par Git, rien à faire ici."
fi

echo ""
echo "== 3. Recherche de .env dans l'historique des commits =="
HITS=$(git log --all --full-history --oneline -- .env)
if [ -n "$HITS" ]; then
  echo "⚠️  .env apparaît dans l'historique Git dans ces commits :"
  echo "$HITS"
  echo ""
  echo "   Le mot de passe reste donc récupérable même après suppression."
  echo "   Deux actions à faire toi-même (voir README section Sécurité) :"
  echo "   a) Régénère IMMÉDIATEMENT le mot de passe d'application Gmail :"
  echo "      https://myaccount.google.com/apppasswords"
  echo "   b) Si le dépôt est privé et que tu es seul dessus, nettoie l'historique :"
  echo "        pip install git-filter-repo"
  echo "        git filter-repo --path .env --invert-paths"
  echo "        git push --force"
else
  echo "✔ Aucune trace de .env dans l'historique des commits. Rien de plus à faire côté Git."
fi

echo ""
echo "== Terminé =="
