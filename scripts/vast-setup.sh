#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/workspace/himitsujou-ai}"
REPO_URL="${REPO_URL:-https://github.com/David77R/himitsujou-ai.git}"
COMFY_DIR="${COMFY_DIR:-/workspace/ComfyUI}"
saved_profile=$(grep -s '^MODEL_PROFILE=' "$APP_DIR/.env" | cut -d= -f2 || true)
MODEL_PROFILE="${MODEL_PROFILE:-${saved_profile:-realista}}"
VIDEO="${VIDEO:-0}"
VIDEO_FILES="diffusion_models|https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
text_encoders|https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
vae|https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors"
case "$MODEL_PROFILE" in
  realista)
    profile_url="https://huggingface.co/RunDiffusion/Juggernaut-XL-v9/resolve/main/Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors"
    profile_settings="COMFY_SAMPLER=dpmpp_2m
COMFY_SCHEDULER=karras
COMFY_CFG=6.5
COMFY_STEPS=30
COMFY_NEGATIVE=blurry, low quality, deformed, bad anatomy, extra fingers, watermark, signature, text, child, underage
PROMPT_SUFFIX=
ENHANCE_STYLE=natural"
    ;;
  anime)
    profile_url="https://huggingface.co/cagliostrolab/animagine-xl-4.0/resolve/main/animagine-xl-4.0-opt.safetensors"
    profile_settings="COMFY_SAMPLER=euler_ancestral
COMFY_SCHEDULER=normal
COMFY_CFG=5
COMFY_STEPS=28
COMFY_NEGATIVE=lowres, bad anatomy, bad hands, missing fingers, extra digits, text, error, signature, watermark, username, cropped, blurry, worst quality, low score, child, underage
PROMPT_SUFFIX=masterpiece, high score, great score, absurdres
ENHANCE_STYLE=tags"
    ;;
  *)
    printf '\033[1;31mMODEL_PROFILE debe ser realista o anime.\033[0m\n'
    exit 1
    ;;
esac
CHECKPOINT_URL="${CHECKPOINT_URL:-$profile_url}"
saved_text=$(grep -s '^TEXT_SIZE=' "$APP_DIR/.env" | cut -d= -f2 || true)
TEXT="${TEXT:-${saved_text:-normal}}"
case "$TEXT" in
  normal) text_model="dolphin3:8b" ;;
  grande) text_model="huihui_ai/mistral-small-abliterated:24b" ;;
  *) printf '\033[1;31mTEXT debe ser normal o grande.\033[0m\n'; exit 1 ;;
esac
OLLAMA_MODEL="${OLLAMA_MODEL:-$text_model}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-3m}"
PORT="${PORT:-3000}"
NODE_MAJOR=22

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$1"; exit 1; }

step "Comprobando ComfyUI"
[ -d "$COMFY_DIR" ] || fail "No encontré ComfyUI en $COMFY_DIR. Revisa que la máquina use la plantilla ComfyUI."

step "Instalando herramientas del sistema"
missing=()
for tool in git curl xz zstd lspci; do command -v "$tool" >/dev/null || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  packages=$(printf '%s\n' "${missing[@]}" | sed -e 's/^xz$/xz-utils/' -e 's/^lspci$/pciutils/' | tr '\n' ' ')
  apt-get update -qq && apt-get install -y -qq $packages >/dev/null
fi

step "Instalando Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) fail "Arquitectura no soportada: $(uname -m)" ;; esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  file=$(curl -fsSL "$base/SHASUMS256.txt" | grep -oE "node-v[0-9.]+-linux-${arch}\.tar\.xz" | head -1)
  curl -fsSL "$base/$file" | tar -xJ -C /usr/local --strip-components=1
fi
echo "Node $(node --version)"

step "Instalando Ollama"
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
if ! curl -fs http://127.0.0.1:11434/api/tags >/dev/null; then
  nohup ollama serve >/workspace/ollama.log 2>&1 &
  for _ in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
fi
curl -fs http://127.0.0.1:11434/api/tags >/dev/null || fail "Ollama no arrancó. Revisa /workspace/ollama.log."

step "Descargando el modelo de texto ($OLLAMA_MODEL)"
ollama pull "$OLLAMA_MODEL"

if command -v nvidia-smi >/dev/null; then
  echo "Comprobando que Ollama use la GPU (carga el modelo, tarda 1 o 2 minutos)..."
  ollama run "$OLLAMA_MODEL" hola >/dev/null 2>&1 || true
  if ollama ps 2>/dev/null | grep -qi '100% CPU'; then
    echo "Ollama no está usando la GPU. Reinstalando para que la detecte."
    curl -fsSL https://ollama.com/install.sh | sh
    pkill -f "ollama serve" 2>/dev/null || true
    sleep 2
    nohup ollama serve >/workspace/ollama.log 2>&1 &
    for _ in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
  fi
fi

download() {
  local folder="$1" url="$2" name target
  name=$(basename "${url%%\?*}")
  target="$COMFY_DIR/models/$folder/$name"
  if [ -s "$target" ]; then
    echo "Ya estaba descargado: $name"
    return
  fi
  mkdir -p "$(dirname "$target")"
  echo "Descargando $name"
  curl -fL --progress-bar -o "$target.part" "$url" || { rm -f "$target.part"; fail "No se pudo descargar $name."; }
  mv "$target.part" "$target"
}

step "Descargando el modelo de imágenes ($MODEL_PROFILE)"
checkpoint=$(basename "${CHECKPOINT_URL%%\?*}")
download checkpoints "$CHECKPOINT_URL"

if [ "$VIDEO" = 1 ]; then
  step "Descargando los modelos de video (Wan 2.2)"
  free_gb=$(df -BG --output=avail "$COMFY_DIR" | tail -1 | tr -dc '0-9')
  pending=0
  while IFS='|' read -r folder url; do
    [ -s "$COMFY_DIR/models/$folder/$(basename "$url")" ] || pending=1
  done <<<"$VIDEO_FILES"
  if [ "$pending" = 1 ] && [ "${free_gb:-0}" -lt 20 ]; then
    fail "Solo quedan ${free_gb} GB libres y los modelos de video necesitan unos 20 GB. Libera espacio o alquila una máquina con más disco."
  fi
  while IFS='|' read -r folder url; do
    download "$folder" "$url"
  done <<<"$VIDEO_FILES"
fi

step "Descargando el Estudio"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

step "Buscando ComfyUI"
comfy_url=""
for candidate in 18188 8188; do
  if curl -fs "http://127.0.0.1:$candidate/system_stats" >/dev/null; then comfy_url="http://127.0.0.1:$candidate"; break; fi
done
[ -n "$comfy_url" ] || fail "ComfyUI no responde todavía. Espera un minuto y vuelve a correr el comando."
echo "ComfyUI en $comfy_url"

step "Configurando el Estudio"
env_file="$APP_DIR/.env"
if [ -f "$env_file" ] && grep -q '^APP_PASSWORD=.\+' "$env_file"; then
  password_line=$(grep '^APP_PASSWORD=' "$env_file")
else
  while true; do
    read -rp "Contraseña para entrar al Estudio (solo letras y números, mínimo 8): " password </dev/tty
    password="${password//[[:space:]]/}"
    [[ "$password" =~ ^[A-Za-z0-9]{8,}$ ]] && break
    echo "Usa solo letras y números, sin espacios, y al menos 8 caracteres."
  done
  password_line="APP_PASSWORD=$password"
fi
cat >"$env_file" <<EOF
TEXT_PROVIDER=ollama
IMAGE_PROVIDER=comfyui
HOST=0.0.0.0
PORT=$PORT
$password_line
OUTPUT_DIR=/workspace/creaciones
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=$OLLAMA_MODEL
COMFY_URL=$comfy_url
COMFY_CHECKPOINT=$checkpoint
MODEL_PROFILE=$MODEL_PROFILE
TEXT_SIZE=$TEXT
$profile_settings
ENHANCE_PROMPTS=true
EOF
chmod 600 "$env_file"

step "Iniciando el Estudio"
pkill -f "node $APP_DIR/server.js" 2>/dev/null || true
nohup node "$APP_DIR/server.js" >/workspace/estudio.log 2>&1 &
for _ in $(seq 1 15); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
curl -s -o /dev/null "http://127.0.0.1:$PORT/" || fail "El Estudio no arrancó. Revisa /workspace/estudio.log."

step "Abriendo el acceso público"
existing=""
if pgrep -f "cloudflared tunnel --url http://localhost:$PORT" >/dev/null; then
  existing=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /workspace/tunnel.log 2>/dev/null | head -1 || true)
fi
if [ -n "$existing" ]; then
  printf '\n\033[1;32mListo. Tu enlace sigue siendo el mismo:\n%s\033[0m\n' "$existing"
  exit 0
fi
if command -v cloudflared >/dev/null; then
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
  nohup cloudflared tunnel --url "http://localhost:$PORT" >/workspace/tunnel.log 2>&1 &
  link=""
  for _ in $(seq 1 30); do
    link=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /workspace/tunnel.log | head -1 || true)
    [ -n "$link" ] && break
    sleep 1
  done
  if [ -n "$link" ]; then
    printf '\n\033[1;32mListo. Abre este enlace y entra con tu contraseña:\n%s\033[0m\n' "$link"
    exit 0
  fi
fi
printf '\n\033[1;32mEl Estudio está corriendo en el puerto %s.\033[0m\n' "$PORT"
echo "En el Instance Portal, entra en Tunnels, escribe http://localhost:$PORT y toca Create New Tunnel."
