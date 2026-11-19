const { HttpError, request, readLines } = require('../lib/core');

function createOllama({ url, model, numCtx }) {
  const missingModel = `El modelo ${model} no está descargado. Ejecuta: ollama pull ${model}`;

  async function failure(response) {
    let message = `Ollama respondió con el error ${response.status}.`;
    try {
      const data = await response.json();
      if (data.error) message = data.error;
    } catch {}
    if (response.status === 404 && /not found/i.test(message)) return new HttpError(502, missingModel);
    return new HttpError(502, `Ollama: ${message}`);
  }

  function messages(system, prompt, image) {
    const user = { role: 'user', content: prompt };
    if (image) user.images = [image.data];
    return [{ role: 'system', content: system }, user];
  }

  return {
    label() {
      return model;
    },

    async status() {
      try {
        const response = await request(`${url}/api/tags`, { timeout: 2500 }, 'Ollama');
        if (!response.ok) return { ready: false, label: model, detail: `Ollama respondió con el error ${response.status}.` };
        const data = await response.json();
        const installed = (data.models || []).some(item => item.name === model || item.name === `${model}:latest`);
        return { ready: installed, label: model, detail: installed ? '' : missingModel };
      } catch {
        return { ready: false, label: model, detail: `Ollama no responde en ${url}. Ábrelo o revisa OLLAMA_URL.` };
      }
    },

    async *streamStory({ system, prompt, image, signal }) {
      const response = await request(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: messages(system, prompt, image), stream: true, options: { temperature: 0.9, top_p: 0.95, repeat_penalty: 1.08, num_ctx: numCtx } }),
        signal
      }, 'Ollama');
      if (!response.ok) throw await failure(response);
      for await (const line of readLines(response.body)) {
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }
        if (data.error) throw new HttpError(502, `Ollama: ${data.error}`);
        const text = data.message && data.message.content;
        if (text) yield text;
      }
    },

    async complete({ system, prompt }) {
      const response = await request(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: messages(system, prompt), stream: false, options: { temperature: 0.4, num_ctx: numCtx } }),
        timeout: 180000
      }, 'Ollama');
      if (!response.ok) throw await failure(response);
      const data = await response.json();
      return (data.message && data.message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
  };
}

module.exports = { createOllama };
