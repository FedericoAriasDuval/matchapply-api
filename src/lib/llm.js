/**
 * src/lib/llm.js
 * Cliente del modelo. Temperatura 0: queremos extracción determinística, no creatividad.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { HttpError } from '../middleware/errors.js';
import { JsonExtractError, extractJson } from './json.js';

export { extractJson } from './json.js';

const client = config.llm.enabled ? new Anthropic({ apiKey: config.llm.apiKey }) : null;

export const completeJson = async ({ system, user, maxTokens = config.llm.maxTokens }) => {
  if (!client) throw new HttpError(503, 'llm_disabled', 'El servicio de IA no está configurado.');

  const attempt = async () => {
    const res = await client.messages.create({
      model: config.llm.model,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [
        { role: 'user', content: user },
        { role: 'assistant', content: '{' }, // prefill: fuerza el arranque del JSON
      ],
    });
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return extractJson(`{${text}`);
  };

  try {
    return await attempt();
  } catch (e) {
    if (e instanceof JsonExtractError) throw new HttpError(502, 'llm_bad_output', e.message);
    await new Promise((r) => setTimeout(r, 700));
    try {
      return await attempt();
    } catch (e2) {
      if (e2 instanceof JsonExtractError) throw new HttpError(502, 'llm_bad_output', e2.message);
      throw new HttpError(502, 'llm_unavailable', 'La IA no está disponible en este momento.');
    }
  }
};
