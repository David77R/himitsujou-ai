# Estudio

Herramienta personal para crear historias, imágenes y videos a partir de un prompt, una imagen de referencia o ambas cosas.

## Motores

| Modo | Motores disponibles | Variable |
| --- | --- | --- |
| Historias | Ollama (modelos abiertos) o Gemini | `TEXT_PROVIDER` |
| Imágenes | ComfyUI (SDXL u otro checkpoint) o Gemini | `IMAGE_PROVIDER` |
| Video | ComfyUI (Wan 2.2) | — |

## Uso

1. Copia `.env.example` como `.env` y ajusta los valores.
2. Ejecuta `npm start`. No hace falta `npm install`: no tiene dependencias.
3. Abre `http://localhost:3000`.

Todo lo generado se guarda en la carpeta indicada por `OUTPUT_DIR`.

## En Vast.ai

1. Alquila una máquina con la plantilla **ComfyUI** (una RTX 3090 basta para imágenes).
2. Abre la **Jupyter Terminal** desde el Instance Portal y ejecuta:

   ```
   bash <(curl -fsSL https://raw.githubusercontent.com/David77R/himitsujou-ai/main/scripts/vast-setup.sh)
   ```

3. Elige la contraseña cuando te la pida y abre el enlace que aparece al final.

El script instala Node y Ollama, descarga el modelo de texto y el de imágenes, configura `.env` e inicia el Estudio. Se puede volver a ejecutar sin perder nada. Variables opcionales: `OLLAMA_MODEL`, `CHECKPOINT_URL`, `PORT`.

## Acceso desde otros dispositivos

Para abrir el Estudio desde el teléfono u otra red, pon `HOST=0.0.0.0` y define `APP_PASSWORD`. El servidor se niega a arrancar abierto a la red sin contraseña.

## Flujos de ComfyUI

Los flujos están en `workflows/` en formato API de ComfyUI. Los marcadores entre llaves se reemplazan en cada petición:

| Marcador | Valor |
| --- | --- |
| `{{PROMPT}}` / `{{NEGATIVE}}` | Prompt positivo y negativo |
| `{{SEED}}` | Semilla aleatoria |
| `{{WIDTH}}` / `{{HEIGHT}}` | Tamaño según el formato elegido |
| `{{IMAGE}}` | Imagen de referencia subida a ComfyUI |
| `{{CHECKPOINT}}` / `{{DENOISE}}` | Modelo e intensidad de cambio sobre la referencia |
| `{{FRAMES}}` / `{{FPS}}` | Duración del video |

Para usar otro flujo, ármalo en ComfyUI, expórtalo con "Export (API)", coloca los marcadores donde correspondan y guárdalo con el mismo nombre.

Los flujos de video siguen la plantilla oficial de Wan 2.2 5B y necesitan estos archivos en ComfyUI:

- `models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`
- `models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
- `models/vae/wan2.2_vae.safetensors`

## Prompts

Con ComfyUI, el prompt se reescribe en inglés con el modelo de historias antes de generar, porque los modelos de imagen y video entienden mejor ese idioma. El prompt usado aparece bajo cada resultado. Se desactiva con `ENHANCE_PROMPTS=false`.
