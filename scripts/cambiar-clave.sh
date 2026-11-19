#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/workspace/himitsujou-ai}"
env_file="$APP_DIR/.env"

[ -f "$env_file" ] || { echo "No encontré $env_file. Corre primero el instalador."; exit 1; }

while true; do
  read -rp "Nueva contraseña (solo letras y números, mínimo 8): " password </dev/tty
  password="${password//[[:space:]]/}"
  [[ "$password" =~ ^[A-Za-z0-9]{8,}$ ]] && break
  echo "Usa solo letras y números, sin espacios, y al menos 8 caracteres."
done

if grep -q '^APP_PASSWORD=' "$env_file"; then
  sed -i "s/^APP_PASSWORD=.*/APP_PASSWORD=$password/" "$env_file"
else
  echo "APP_PASSWORD=$password" >>"$env_file"
fi

pkill -f "node $APP_DIR/server.js" 2>/dev/null || true
nohup node "$APP_DIR/server.js" >/workspace/estudio.log 2>&1 &
sleep 2
curl -s -o /dev/null "http://127.0.0.1:$(grep '^PORT=' "$env_file" | cut -d= -f2)/" || { echo "El Estudio no arrancó. Revisa /workspace/estudio.log."; exit 1; }

printf '\n\033[1;32mListo. Entra con la contraseña: %s\033[0m\n' "$password"
link=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /workspace/tunnel.log 2>/dev/null | head -1 || true)
[ -n "$link" ] && printf '\033[1;32mEnlace: %s\033[0m\n' "$link"
exit 0
