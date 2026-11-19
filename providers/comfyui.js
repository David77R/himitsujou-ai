const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, MIME_BY_EXT, request, sleep } = require('../lib/core');

const IMAGE_SIZES = {
  '1:1': [1024, 1024],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '4:3': [1152, 896],
  '3:4': [896, 1152]
};

const VIDEO_SIZES = {
  '16:9': [1280, 704],
  '9:16': [704, 1280],
  '1:1': [960, 960]
};

const WORKFLOWS = {
  image: { text: 'imagen-texto.json', reference: 'imagen-referencia.json' },
  video: { text: 'video-texto.json', reference: 'video-referencia.json' }
};

const MODEL_INPUTS = {
  ckpt_name: 'checkpoints',
  unet_name: 'diffusion_models',
  clip_name: 'text_encoders',
  vae_name: 'vae'
};

const POLL_INTERVAL = 1500;
const MAX_POLL_FAILURES = 20;

function fill(node, values) {
  if (typeof node === 'string') {
    const exact = /^\{\{(\w+)\}\}$/.exec(node);
    if (exact && exact[1] in values) return values[exact[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (match, key) => key in values ? String(values[key]) : match);
  }
  if (Array.isArray(node)) return node.map(item => fill(item, values));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, fill(value, values)]));
  }
  return node;
}

function collectFiles(outputs) {
  const files = [];
  for (const output of Object.values(outputs || {})) {
    for (const list of Object.values(output)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && typeof item === 'object' && item.filename) files.push(item);
      }
    }
  }
  return files;
}

function executionError(messages) {
  const entry = (messages || []).find(([type]) => type === 'execution_error');
  if (!entry) return 'ComfyUI no pudo completar el flujo.';
  const data = entry[1] || {};
  return `ComfyUI falló en el nodo ${data.node_type || 'desconocido'}: ${String(data.exception_message || '').trim()}`;
}

async function rejection(response) {
  try {
    const data = await response.json();
    const details = Object.values(data.node_errors || {})
      .flatMap(node => (node.errors || []).map(error => `${node.class_type}: ${error.details || error.message}`));
    const summary = data.error && (data.error.message || data.error);
    return `ComfyUI rechazó el flujo. ${[summary, ...details].filter(Boolean).join(' | ')}`;
  } catch {
    return `ComfyUI rechazó el flujo con el error ${response.status}.`;
  }
}

function createComfy(options) {
  const { url, workflowDir, checkpoint, negative, negativeVideo, denoise, sampler, scheduler, cfg, steps, fps, imageTimeout, videoTimeout } = options;

  function call(pathname, init) {
    return request(`${url}${pathname}`, init, 'ComfyUI');
  }

  function workflowPath(name) {
    return path.join(workflowDir, name);
  }

  function loadWorkflow(name) {
    const file = workflowPath(name);
    if (!fs.existsSync(file)) throw new HttpError(500, `Falta el flujo workflows/${name}.`);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new HttpError(500, `El flujo workflows/${name} no es un JSON válido.`);
    }
  }

  async function upload(image) {
    const form = new FormData();
    const extension = image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/webp' ? 'webp' : 'jpg';
    form.append('image', new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }), `estudio-${Date.now()}.${extension}`);
    form.append('overwrite', 'true');
    const response = await call('/upload/image', { method: 'POST', body: form, timeout: 60000 });
    if (!response.ok) throw new HttpError(502, `ComfyUI no aceptó la imagen de referencia (error ${response.status}).`);
    const data = await response.json();
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }

  async function wait(promptId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let failures = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);
      let history;
      try {
        const response = await call(`/history/${encodeURIComponent(promptId)}`, { timeout: 15000 });
        if (!response.ok) throw new HttpError(502, `ComfyUI respondió con el error ${response.status}.`);
        history = await response.json();
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) throw error;
        continue;
      }
      const entry = history[promptId];
      if (!entry) continue;
      const status = entry.status || {};
      if (status.status_str === 'error') throw new HttpError(502, executionError(status.messages));
      if (status.completed === false) continue;
      return entry;
    }
    throw new HttpError(504, 'ComfyUI tardó demasiado. Revisa su consola por si se quedó atascado.');
  }

  async function download(file) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
    const response = await call(`/view?${query}`, { timeout: 120000 });
    if (!response.ok) throw new HttpError(502, `No se pudo descargar el resultado de ComfyUI (error ${response.status}).`);
    const mimeType = MIME_BY_EXT[path.extname(file.filename).toLowerCase()] || response.headers.get('content-type') || 'application/octet-stream';
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType };
  }

  async function run(name, values, timeoutMs, wanted) {
    const workflow = fill(loadWorkflow(name), values);
    const response = await call('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
      timeout: 30000
    });
    if (!response.ok) throw new HttpError(502, await rejection(response));
    const { prompt_id: promptId } = await response.json();
    const entry = await wait(promptId, timeoutMs);
    const files = collectFiles(entry.outputs);
    const match = files.find(file => (MIME_BY_EXT[path.extname(file.filename).toLowerCase()] || '').startsWith(wanted));
    if (!match) throw new HttpError(502, `El flujo terminó pero no produjo ningún archivo de ${wanted === 'video/' ? 'video' : 'imagen'}.`);
    return download(match);
  }

  async function missingModels(kind) {
    const needed = [];
    for (const name of Object.values(WORKFLOWS[kind])) {
      const workflow = fill(loadWorkflow(name), { CHECKPOINT: checkpoint });
      for (const node of Object.values(workflow)) {
        for (const [input, folder] of Object.entries(MODEL_INPUTS)) {
          const value = node.inputs && node.inputs[input];
          if (typeof value === 'string' && !needed.some(item => item.value === value)) needed.push({ folder, value });
        }
      }
    }
    const lists = {};
    for (const { folder } of needed) {
      if (folder in lists) continue;
      try {
        const response = await call(`/models/${folder}`, { timeout: 2500 });
        lists[folder] = response.ok ? await response.json() : null;
      } catch {
        lists[folder] = null;
      }
    }
    return needed.filter(({ folder, value }) => Array.isArray(lists[folder]) && !lists[folder].includes(value)).map(item => item.value);
  }

  function seed() {
    return crypto.randomInt(0, 2 ** 47);
  }

  return {
    label(kind) {
      return kind === 'video' ? 'ComfyUI (video)' : `ComfyUI (${checkpoint})`;
    },

    async status(kind) {
      const missing = Object.values(WORKFLOWS[kind]).filter(name => !fs.existsSync(workflowPath(name)));
      if (missing.length) return { ready: false, label: this.label(kind), detail: `Falta el flujo workflows/${missing[0]}.` };
      try {
        const response = await call('/system_stats', { timeout: 2500 });
        if (!response.ok) return { ready: false, label: this.label(kind), detail: `ComfyUI respondió con el error ${response.status}.` };
        const absent = await missingModels(kind);
        if (absent.length) {
          const detail = kind === 'video'
            ? 'Faltan los modelos de video. En la Jupyter Terminal ejecuta: cd /workspace/himitsujou-ai && git pull -q && VIDEO=1 bash scripts/vast-setup.sh'
            : `Falta el modelo ${absent[0]} en ComfyUI.`;
          return { ready: false, label: this.label(kind), detail };
        }
        return { ready: true, label: this.label(kind), detail: '' };
      } catch {
        return { ready: false, label: this.label(kind), detail: `ComfyUI no responde en ${url}. Enciéndelo o revisa COMFY_URL.` };
      }
    },

    async generateImage({ prompt, image, aspectRatio }) {
      const [width, height] = IMAGE_SIZES[aspectRatio] || IMAGE_SIZES['1:1'];
      const values = { PROMPT: prompt, NEGATIVE: negative, SEED: seed(), WIDTH: width, HEIGHT: height, CHECKPOINT: checkpoint, DENOISE: denoise, SAMPLER: sampler, SCHEDULER: scheduler, CFG: cfg, STEPS: steps };
      if (image) values.IMAGE = await upload(image);
      const name = image ? WORKFLOWS.image.reference : WORKFLOWS.image.text;
      return run(name, values, imageTimeout, 'image/');
    },

    async generateVideo({ prompt, image, aspectRatio, seconds }) {
      const [width, height] = VIDEO_SIZES[aspectRatio] || VIDEO_SIZES['16:9'];
      const values = { PROMPT: prompt, NEGATIVE: negativeVideo, SEED: seed(), WIDTH: width, HEIGHT: height, FRAMES: Math.round(seconds * fps / 4) * 4 + 1, FPS: fps };
      if (image) values.IMAGE = await upload(image);
      const name = image ? WORKFLOWS.video.reference : WORKFLOWS.video.text;
      return run(name, values, videoTimeout, 'video/');
    }
  };
}

module.exports = { createComfy, IMAGE_SIZES, VIDEO_SIZES };
