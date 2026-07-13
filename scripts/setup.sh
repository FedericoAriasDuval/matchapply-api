#!/usr/bin/env bash
# =====================================================================
# MatchApply — instalación en macOS / Linux
#   Uso:  cd matchapply && bash scripts/setup.sh
# =====================================================================
set -euo pipefail
echo -e "\n=== MatchApply — setup ===\n"

command -v node >/dev/null || { echo "Falta Node.js 20+. Instalalo desde https://nodejs.org"; exit 1; }
major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$major" -ge 20 ] || { echo "Necesitás Node 20 o superior (tenés $(node -v))."; exit 1; }
echo "Node detectado: $(node -v)"

if [ ! -f .env ]; then
  cp .env.example .env
  secret=$(openssl rand -hex 64)
  sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=$secret|" .env && rm -f .env.bak
  echo "Creé .env con un JWT_SECRET aleatorio. Completá DATABASE_URL (y ANTHROPIC_API_KEY si querés IA real)."
else
  echo ".env ya existe: no lo toco."
fi

echo -e "\nInstalando dependencias..."; npm install
echo -e "\nCorriendo tests...";        npm test

if grep -q '^DATABASE_URL=postgres' .env && ! grep -q 'user:pass@host' .env; then
  echo -e "\nAplicando migraciones..."; npm run migrate
  echo -e "\nListo. Arrancá con:  npm start   (API en http://localhost:8080/health)"
else
  echo -e "\nFalta DATABASE_URL en .env. Opción rápida y gratis: https://neon.tech"
  echo "Después:  npm run migrate && npm start"
fi

echo -e "\nEl frontend NO necesita instalación: abrí web/index.html en el navegador.\n"
