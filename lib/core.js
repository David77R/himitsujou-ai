const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8'
};

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm'
};

function loadEnv(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function request(url, options, label) {
  const { timeout, signal, ...rest } = options || {};
  const signals = [signal, timeout && AbortSignal.timeout(timeout)].filter(Boolean);
  try {
    return await fetch(url, { ...rest, signal: signals.length ? AbortSignal.any(signals) : undefined });
  } catch (error) {
    if (signal && signal.aborted) throw error;
    if (error.name === 'TimeoutError') throw new HttpError(504, `${label} tardó demasiado en responder.`);
    throw new HttpError(503, `No se pudo conectar con ${label}. Revisa que esté encendido.`);
  }
}

async function* readLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) yield line;
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { HttpError, MIME_BY_EXT, EXT_BY_MIME, loadEnv, request, readLines, sleep };
