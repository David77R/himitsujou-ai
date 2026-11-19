const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, MIME_BY_EXT, EXT_BY_MIME, loadEnv } = require('./lib/core');
const { createStore } = require('./lib/stories');
const { createGemini } = require('./providers/gemini');
const { createOllama } = require('./providers/ollama');
const { createComfy, IMAGE_SIZES, VIDEO_SIZES } = require('./providers/comfyui');

const ROOT = __dirname;
loadEnv(ROOT);

const env = (key, fallback) => process.env[key] === undefined || process.env[key] === '' ? fallback : process.env[key];

const config = {
  host: env('HOST', '127.0.0.1'),
  port: Number(env('PORT', 3000)),
  password: env('APP_PASSWORD', ''),
  outputDir: path.resolve(ROOT, env('OUTPUT_DIR', 'creaciones')),
  textProvider: env('TEXT_PROVIDER', 'gemini').toLowerCase(),
  imageProvider: env('IMAGE_PROVIDER', 'gemini').toLowerCase(),
  enhancePrompts: env('ENHANCE_PROMPTS', 'true').toLowerCase() !== 'false',
  promptSuffix: env('PROMPT_SUFFIX', ''),
  enhanceStyle: env('ENHANCE_STYLE', 'natural').toLowerCase()
};

const gemini = createGemini({
  apiKey: env('GEMINI_API_KEY', ''),
  textModel: env('TEXT_MODEL', 'gemini-2.5-flash'),
  imageModel: env('IMAGE_MODEL', 'gemini-2.5-flash-image')
});

const ollama = createOllama({
  url: env('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  model: env('OLLAMA_MODEL', 'llama3.1:8b')
});

const comfy = createComfy({
  url: env('COMFY_URL', 'http://127.0.0.1:8188').replace(/\/+$/, ''),
  workflowDir: path.join(ROOT, 'workflows'),
  checkpoint: env('COMFY_CHECKPOINT', 'sd_xl_base_1.0.safetensors'),
  negative: env('COMFY_NEGATIVE', 'blurry, low quality, deformed, bad anatomy, extra fingers, watermark, signature, text'),
  negativeVideo: env('COMFY_NEGATIVE_VIDEO', 'blurry, low quality, static, distorted, deformed, watermark, text, jittery'),
  denoise: Number(env('COMFY_DENOISE', 0.65)),
  sampler: env('COMFY_SAMPLER', 'dpmpp_2m'),
  scheduler: env('COMFY_SCHEDULER', 'karras'),
  cfg: Number(env('COMFY_CFG', 6.5)),
  steps: Number(env('COMFY_STEPS', 30)),
  detailPass: {
    scale: Number(env('COMFY_DETAIL_SCALE', 1.5)),
    denoise: Number(env('COMFY_DETAIL_DENOISE', 0.45)),
    steps: Number(env('COMFY_DETAIL_STEPS', 15))
  },
  fps: Number(env('COMFY_FPS', 24)),
  imageTimeout: Number(env('COMFY_IMAGE_TIMEOUT', 600)) * 1000,
  videoTimeout: Number(env('COMFY_VIDEO_TIMEOUT', 1800)) * 1000
});

const TEXT_PROVIDERS = { gemini, ollama };
const IMAGE_PROVIDERS = { gemini, comfyui: comfy };
const text = TEXT_PROVIDERS[config.textProvider];
const images = IMAGE_PROVIDERS[config.imageProvider];

if (!text) {
  console.error(`TEXT_PROVIDER debe ser gemini u ollama (recibido: ${config.textProvider}).`);
  process.exit(1);
}

if (!images) {
  console.error(`IMAGE_PROVIDER debe ser gemini o comfyui (recibido: ${config.imageProvider}).`);
  process.exit(1);
}

if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.password) {
  console.error('El servidor está abierto a la red (HOST) y no tiene APP_PASSWORD. Define una contraseña en .env antes de iniciarlo.');
  process.exit(1);
}

const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 20 * 1024 * 1024;
const STREAM_ERROR = '\u0000';
const STREAM_META = '\u0001';
const JOB_TTL = 2 * 60 * 60 * 1000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_SECONDS = [3, 5];

const LENGTHS = {
  corta: 'entre 300 y 500 palabras',
  media: 'entre 800 y 1200 palabras',
  larga: 'entre 1800 y 2500 palabras'
};

const STORY_INSTRUCTIONS = [
  'Escribes ficción original para adultos con voz propia.',
  'Escena, no resumen: cuenta los hechos mientras ocurren, en tiempo presente de la acción, en vez de narrar por encima lo que pasó.',
  'Cada personaje quiere algo concreto y actúa para conseguirlo; lo que uno hace cambia lo que hace el otro, y la escena avanza por esa fricción.',
  'Usa diálogo real, con interrupciones, silencios y frases a medias; que los personajes se contradigan, mientan o esquiven.',
  'Ancla cada escena en detalles físicos concretos: lo que se ve, se oye, se huele y se toca, incluidos los gestos y la respiración.',
  'Muestra lo que sienten por lo que hacen y por su cuerpo, no nombrando la emoción.',
  'Varía el ritmo: frases cortas en los momentos de tensión, más largas cuando el momento se abre.',
  'Evita los lugares comunes, los adjetivos de relleno y las frases hechas; si una imagen suena previsible, busca otra.',
  'Termina en un momento que deje peso, no en una conclusión explicada.',
  'Responde en el mismo idioma en que esté escrita la petición.',
  'La primera línea es solo el título, sin comillas, símbolos ni formato markdown.',
  'Después escribe la historia en párrafos separados por una línea en blanco, sin encabezados ni listas.',
  'Si recibes una imagen, úsala como inspiración principal para personajes, ambiente y tono.'
].join(' ');

const FIDELITY = { suelta: -1.5, normal: 0, alta: 2, maxima: 3.5 };

const CHARACTER_SHEET = [
  'Conviertes una idea breve en la ficha de un protagonista de ficción para adultos.',
  'Responde en el mismo idioma de la idea, en texto plano, sin markdown ni viñetas.',
  'Escribe una línea por apartado, con este orden y estos nombres: Nombre, Edad, Aspecto, Forma de hablar, Carácter, Herida, Deseo, Secreto.',
  'Todos los personajes son adultos; si la idea no dice la edad, ponle treinta y tantos.',
  'En Herida pon lo que le pasó y aún le pesa. En Deseo, lo que persigue ahora. En Secreto, lo que esconde y puede estallar.',
  'Sé concreto y evita los lugares comunes: nada de "misterioso" o "de pasado oscuro" sin decir qué pasó.'
].join(' ');

const ENHANCERS = {
  character: CHARACTER_SHEET,
  summary: 'Resume en tres o cuatro frases lo que ocurre en este capítulo: hechos, decisiones y lo que cambia entre los personajes. Sin valoraciones ni adornos. Responde solo con el resumen, en el idioma del capítulo.',
  scene: 'From the scene you receive, write an image prompt for an anime diffusion model. Reply with exactly two lines and nothing else. First line: "POSITIVO:" followed by comma-separated Danbooru-style tags for the most visual moment — subject count tag (1girl, 1boy, 2girls, 1other, no humans), appearance, clothing, pose, action, setting, lighting and composition. Second line: "NEGATIVO:" followed by comma-separated tags naming what must not appear in that image. Use short tags, never sentences.',
  imageTags: 'Rewrite the user idea as Danbooru-style tags for an anime image diffusion model, separated by commas. Start with the subject count tag (1girl, 1boy, 2girls, 1other or no humans), then appearance, clothing, pose, action, setting, lighting, composition and art style. Use short tags, not sentences. Keep every element the user asked for and do not add or remove content. Reply with the tags only.',
  image: 'Rewrite the user idea as one English prompt for an image diffusion model: comma-separated, concrete visual details (subject, setting, lighting, style, composition, quality). Keep every element the user asked for and do not add or remove content. Reply with the prompt only.',
  video: 'Rewrite the user idea as one English paragraph for a video diffusion model, describing the subject, its motion, camera movement, setting, lighting and style. Keep every element the user asked for and do not add or remove content. Reply with the prompt only.'
};

const jobs = new Map();
const stories = createStore(config.outputDir);

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'La imagen es demasiado grande. Prueba con una de menos de 15 MB.'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'La solicitud no tiene un formato válido.'));
      }
    });
    req.on('error', reject);
  });
}

function parseImage(image) {
  if (!image) return null;
  if (!IMAGE_TYPES.includes(image.mimeType) || typeof image.data !== 'string' || !image.data) {
    throw new HttpError(400, 'Formato de imagen no admitido. Usa JPG, PNG o WebP.');
  }
  return { mimeType: image.mimeType, data: image.data };
}

function cleanPrompt(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function saveCreation(prefix, extension, content) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const name = `${prefix}-${timestamp()}-${crypto.randomBytes(2).toString('hex')}.${extension}`;
  fs.writeFileSync(path.join(config.outputDir, name), content);
  return name;
}

async function enhance(kind, prompt) {
  if (!config.enhancePrompts || !prompt || (kind === 'image' && images !== comfy)) return prompt;
  try {
    const system = kind === 'image' && config.enhanceStyle === 'tags' ? ENHANCERS.imageTags : ENHANCERS[kind];
    const result = await text.complete({ system, prompt });
    return result.replace(/^["'\s]+|["'\s]+$/g, '') || prompt;
  } catch (error) {
    console.warn(`No se pudo mejorar el prompt (${error.message}). Se usa el original.`);
    return prompt;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    elapsed: Math.round(((job.finishedAt || Date.now()) - job.createdAt) / 1000),
    result: job.result,
    error: job.error
  };
}

function startJob(kind, task) {
  const job = { id: crypto.randomUUID(), kind, status: 'running', createdAt: Date.now() };
  jobs.set(job.id, job);
  task()
    .then(({ buffer, mimeType, prompt, note }) => {
      const file = saveCreation(kind === 'video' ? 'video' : 'imagen', EXT_BY_MIME[mimeType] || 'bin', buffer);
      job.result = { url: `/creaciones/${encodeURIComponent(file)}`, file, mimeType, prompt, note };
      job.status = 'done';
    })
    .catch(error => {
      if (!(error instanceof HttpError)) console.error(error);
      job.error = error.message || 'Error inesperado del servidor.';
      job.status = 'error';
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return job;
}

setInterval(() => {
  const limit = Date.now() - JOB_TTL;
  for (const [id, job] of jobs) if (job.createdAt < limit) jobs.delete(id);
}, 10 * 60 * 1000).unref();

function chapterPrompt(story, instruction, length) {
  const parts = [];
  if (story.character) parts.push(`Protagonista:\n${story.character}`);
  if (story.tags) parts.push(`Etiquetas que definen el tono, el género y el mundo: ${story.tags}`);
  if (story.chapters.length) {
    parts.push(`Lo ocurrido hasta ahora:\n${story.chapters.map((chapter, index) => `Capítulo ${index + 1}: ${chapter.summary}`).join('\n')}`);
    parts.push(`Final del capítulo anterior, para enlazar la voz y la escena:\n...${story.chapters[story.chapters.length - 1].text.slice(-1200)}`);
    parts.push(`Escribe el capítulo ${story.chapters.length + 1}. Continúa desde ahí sin repetir ni resumir lo ya contado, y haz que la situación cambie respecto al capítulo anterior.`);
  }
  parts.push(instruction ? `Lo que debe pasar en este capítulo: ${instruction}` : 'Continúa la historia como mejor funcione.');
  parts.push(`Extensión: ${length}.`);
  return parts.join('\n\n');
}

async function handleStory(req, res) {
  const body = await readBody(req);
  const image = parseImage(body.image);
  const length = LENGTHS[body.length] || LENGTHS.media;
  const instruction = cleanPrompt(body.prompt);
  const existing = body.storyId ? stories.read(body.storyId) : null;
  if (body.storyId && !existing) throw new HttpError(404, 'Esa historia ya no existe.');
  if (!instruction && !image && !existing) throw new HttpError(400, 'Escribe una idea o sube una imagen para empezar.');

  const story = existing || stories.create({ character: cleanPrompt(body.character), tags: cleanPrompt(body.tags) });
  const prompt = chapterPrompt(story, instruction || (image ? 'Parte de la imagen que recibes.' : ''), length);

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let written = '';
  let started = false;
  let notice = null;
  try {
    for await (const chunk of text.streamStory({ system: STORY_INSTRUCTIONS, prompt, image, signal: controller.signal })) {
      if (!started) {
        started = true;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      }
      written += chunk;
      res.write(chunk);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (!started) throw error;
    notice = error.message || 'La conexión con el modelo se cortó.';
  }

  if (!started) throw new HttpError(502, 'El modelo no devolvió ninguna historia. Intenta de nuevo.');

  const chapterText = written.trim();
  if (chapterText) {
    const heading = chapterText.split('\n')[0].replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    let summary = heading;
    try {
      summary = (await text.complete({ system: ENHANCERS.summary, prompt: chapterText })) || heading;
    } catch (error) {
      console.warn(`No se pudo resumir el capítulo (${error.message}).`);
    }
    story.chapters.push({ title: heading, text: chapterText, summary, created: new Date().toISOString() });
    if (story.chapters.length === 1) story.title = heading || 'Sin título';
    try {
      stories.save(story);
      saveCreation('historia', 'txt', chapterText);
    } catch (error) {
      console.error('No se pudo guardar la historia:', error.message);
    }
  }
  if (notice) res.write(`${STREAM_ERROR}${notice}. El capítulo se guardó hasta donde llegó.`);
  res.write(`${STREAM_META}${JSON.stringify({ storyId: story.id, title: story.title, chapter: story.chapters.length })}`);
  res.end();
}

async function handleCharacter(req, res) {
  const body = await readBody(req);
  const idea = cleanPrompt(body.idea);
  if (!idea) throw new HttpError(400, 'Describe en una línea quién es el protagonista.');
  const sheet = await text.complete({ system: ENHANCERS.character, prompt: idea });
  if (!sheet) throw new HttpError(502, 'El modelo no devolvió ninguna ficha. Intenta de nuevo.');
  sendJson(res, 200, { sheet });
}

async function handleScenePrompt(req, res) {
  const body = await readBody(req);
  const scene = cleanPrompt(body.scene);
  if (!scene) throw new HttpError(400, 'No hay escena de la que partir.');
  const reply = await text.complete({ system: ENHANCERS.scene, prompt: scene.slice(-4000) });
  const positive = (/POSITIVO:\s*(.+)/i.exec(reply) || [])[1] || '';
  const negative = (/NEGATIVO:\s*(.+)/i.exec(reply) || [])[1] || '';
  if (!positive.trim()) throw new HttpError(502, 'El modelo no devolvió un prompt usable. Intenta de nuevo.');
  sendJson(res, 200, { positive: positive.trim(), negative: negative.trim() });
}

function handleStories(req, res) {
  sendJson(res, 200, { stories: stories.list() });
}

function handleStoryRead(req, res, id) {
  const story = stories.read(id);
  if (!story) throw new HttpError(404, 'Esa historia ya no existe.');
  sendJson(res, 200, story);
}

async function handleImage(req, res) {
  const body = await readBody(req);
  const image = parseImage(body.image);
  const aspectRatio = body.aspectRatio in IMAGE_SIZES ? body.aspectRatio : '1:1';
  const original = cleanPrompt(body.prompt);
  const characters = (Array.isArray(body.characters) ? body.characters : []).map(cleanPrompt).filter(Boolean).slice(0, 2);
  if (!original && !image) throw new HttpError(400, 'Describe la imagen o escena que quieres crear.');
  if (characters.length === 1) throw new HttpError(400, 'Describe a los dos personajes, o deja ambos campos vacíos.');
  const job = startJob('image', async () => {
    const raw = body.raw === true;
    const base = raw ? original : original ? await enhance('image', original) : 'detailed expressive illustration based on the reference image';
    const prompt = !raw && images === comfy && config.promptSuffix ? `${base}, ${config.promptSuffix}` : base;
    const regions = images === comfy ? await Promise.all(characters.map(character => raw ? character : enhance('image', character))) : [];
    const sent = images === comfy ? prompt : [prompt, ...characters].join('. ');
    const fidelity = FIDELITY[body.fidelity] || 0;
    const result = await images.generateImage({ prompt: sent, image, aspectRatio, detail: body.detail !== false, regions, fidelity, negativeOverride: cleanPrompt(body.negative) });
    const used = regions.length ? `${prompt} | Izquierda: ${regions[0]} | Derecha: ${regions[1]}` : prompt;
    return { ...result, prompt: used !== original ? used : undefined };
  });
  sendJson(res, 202, publicJob(job));
}

async function handleVideo(req, res) {
  const body = await readBody(req);
  const image = parseImage(body.image);
  const aspectRatio = body.aspectRatio in VIDEO_SIZES ? body.aspectRatio : '16:9';
  const seconds = VIDEO_SECONDS.includes(Number(body.seconds)) ? Number(body.seconds) : 5;
  const original = cleanPrompt(body.prompt);
  if (!original && !image) throw new HttpError(400, 'Describe la escena que quieres animar o sube una imagen.');
  const job = startJob('video', async () => {
    const prompt = original ? await enhance('video', original) : 'natural subtle motion, gentle camera movement, cinematic lighting';
    const result = await comfy.generateVideo({ prompt, image, aspectRatio, seconds });
    return { ...result, prompt: prompt !== original ? prompt : undefined };
  });
  sendJson(res, 202, publicJob(job));
}

function handleJob(req, res, id) {
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, 'Ese trabajo ya no existe. Puede que el servidor se haya reiniciado; revisa la carpeta creaciones.');
  sendJson(res, 200, publicJob(job));
}

async function handleStatus(req, res) {
  const [story, image, video] = await Promise.all([text.status('story'), images.status('image'), comfy.status('video')]);
  sendJson(res, 200, { story, image, video });
}

function streamFile(req, res, file, type, cache) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return sendJson(res, 404, { error: 'No encontrado.' });
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache || 'no-cache' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!range) {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      return fs.createReadStream(file).pipe(res);
    }
    let start = range[1] === '' ? stat.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
    if (range[1] === '' && range[2] === '' || start < 0 || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

function serveCreation(req, res, name) {
  if (!/^[\w.-]+$/.test(name)) return sendJson(res, 404, { error: 'No encontrado.' });
  const file = path.join(config.outputDir, name);
  streamFile(req, res, file, MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream');
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'No encontrado.' });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const cache = relative.startsWith('vendor/') ? 'public, max-age=604800, immutable' : 'no-cache';
  streamFile(req, res, file, types[path.extname(file)] || MIME_BY_EXT[path.extname(file)] || 'application/octet-stream', cache);
}

function authorized(req) {
  if (!config.password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const supplied = decoded.slice(decoded.indexOf(':') + 1).trim();
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(supplied), digest(config.password));
}

const routes = {
  'POST /api/story': handleStory,
  'POST /api/image': handleImage,
  'POST /api/video': handleVideo,
  'POST /api/character': handleCharacter,
  'POST /api/scene-prompt': handleScenePrompt,
  'GET /api/stories': handleStories,
  'GET /api/status': handleStatus
};

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Estudio", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Se necesita la contraseña del Estudio.');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJson(res, 400, { error: 'Ruta no válida.' });
  }
  try {
    const route = routes[`${req.method} ${pathname}`];
    if (route) return await route(req, res);
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Método no permitido.' });
    if (pathname.startsWith('/api/jobs/')) return handleJob(req, res, pathname.slice('/api/jobs/'.length));
    if (pathname.startsWith('/api/stories/')) return handleStoryRead(req, res, pathname.slice('/api/stories/'.length));
    if (pathname.startsWith('/creaciones/')) return serveCreation(req, res, pathname.slice('/creaciones/'.length));
    serveStatic(req, res, pathname);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: error.message || 'Error inesperado del servidor.' });
  }
});

server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`Estudio listo en http://${shown}:${config.port}`);
  console.log(`Historias: ${config.textProvider} · Imágenes: ${config.imageProvider} · Video: comfyui`);
  if (config.password) console.log('Protegido con contraseña.');
});
