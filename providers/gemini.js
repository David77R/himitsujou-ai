const { HttpError, request, readLines } = require('../lib/core');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const BLOCK_REASONS = ['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'OTHER'];
const BLOCKED = 'Gemini bloqueó esta petición por sus políticas de contenido. Reformula el prompt o cambia la imagen.';

const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT'
].map(category => ({ category, threshold: 'BLOCK_NONE' }));

function isBlocked(reason) {
  return Boolean(reason) && BLOCK_REASONS.includes(reason);
}

function userParts(prompt, image) {
  const parts = [];
  if (image) parts.push({ inlineData: image });
  parts.push({ text: prompt });
  return parts;
}

function createGemini({ apiKey, textModel, imageModel }) {
  async function call(model, method, body, signal) {
    if (!apiKey) throw new HttpError(500, 'Falta GEMINI_API_KEY en el archivo .env.');
    const response = await request(`${API_BASE}/${model}:${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal
    }, 'Gemini');
    if (!response.ok) {
      let message = `Gemini respondió con el error ${response.status}.`;
      try {
        const data = await response.json();
        if (data.error && data.error.message) message = data.error.message;
      } catch {}
      if (response.status === 429) throw new HttpError(429, `Llegaste al límite de uso de la API. ${message}`);
      throw new HttpError(502, message);
    }
    return response;
  }

  return {
    label(kind) {
      return kind === 'story' ? textModel : imageModel;
    },

    async status(kind) {
      if (kind === 'video') return { ready: false, label: 'Gemini', detail: 'El video solo funciona con ComfyUI.' };
      return { ready: Boolean(apiKey), label: this.label(kind), detail: apiKey ? '' : 'Falta GEMINI_API_KEY en el archivo .env.' };
    },

    async *streamStory({ system, prompt, image, signal }) {
      const response = await call(textModel, 'streamGenerateContent?alt=sse', {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: userParts(prompt, image) }],
        safetySettings: SAFETY_SETTINGS,
        generationConfig: { temperature: 1 }
      }, signal);
      let stopped = false;
      for await (const line of readLines(response.body)) {
        if (!line.startsWith('data:')) continue;
        let data;
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (data.promptFeedback && isBlocked(data.promptFeedback.blockReason)) throw new HttpError(422, BLOCKED);
        const candidate = data.candidates && data.candidates[0];
        if (!candidate) continue;
        const text = (candidate.content && candidate.content.parts || []).map(part => part.text || '').join('');
        if (text) yield text;
        if (isBlocked(candidate.finishReason)) stopped = true;
      }
      if (stopped) throw new HttpError(422, BLOCKED);
    },

    async complete({ system, prompt }) {
      const response = await call(textModel, 'generateContent', {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        safetySettings: SAFETY_SETTINGS,
        generationConfig: { temperature: 0.4 }
      });
      const data = await response.json();
      const candidate = data.candidates && data.candidates[0];
      return (candidate && candidate.content && candidate.content.parts || []).map(part => part.text || '').join('').trim();
    },

    async generateImage({ prompt, image, aspectRatio }) {
      const response = await call(imageModel, 'generateContent', {
        contents: [{ role: 'user', parts: userParts(prompt, image) }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } }
      });
      const data = await response.json();
      if (data.promptFeedback && isBlocked(data.promptFeedback.blockReason)) throw new HttpError(422, BLOCKED);
      const candidate = data.candidates && data.candidates[0];
      const parts = candidate && candidate.content && candidate.content.parts || [];
      const imagePart = parts.find(part => part.inlineData && part.inlineData.data);
      const text = parts.map(part => part.text || '').join('').trim();
      if (!imagePart) {
        if (candidate && isBlocked(candidate.finishReason)) throw new HttpError(422, BLOCKED);
        throw new HttpError(422, text || 'Gemini no devolvió ninguna imagen. Prueba con un prompt más descriptivo.');
      }
      return {
        buffer: Buffer.from(imagePart.inlineData.data, 'base64'),
        mimeType: imagePart.inlineData.mimeType,
        note: text
      };
    }
  };
}

module.exports = { createGemini };
