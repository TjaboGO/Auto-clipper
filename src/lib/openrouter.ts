// Picking the clips through OpenRouter (https://openrouter.ai), so any model
// it carries can do it. Only text goes
// there (the transcript and what happens on screen); listening to the audio
// and watching the video stay with Gemini. Plain fetch against its
// OpenAI-style chat API, no extra package.
import type { Schema } from '@google/genai';
import { config } from './config';

type JsonSchema = Record<string, unknown>;

/**
 * The same schema in standard JSON Schema form (Gemini's has upper-case
 * type names and its own ordering field). Objects get every property
 * required and nothing else allowed, which strict structured output wants.
 */
export function toJsonSchema(schema: Schema): JsonSchema {
  const out: JsonSchema = {};
  if (schema.type) out.type = String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]));
    out.required = Object.keys(schema.properties);
    out.additionalProperties = false;
  }
  return out;
}

export interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Waits between retries, in ms (tests make them short). */
  retryDelays?: number[];
}

function explain(status: number, body: string, model: string): Error {
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
  } catch {
    // Not JSON: use it as it is.
  }
  if (status === 401) return new Error('OpenRouter godkände inte API-nyckeln. Kolla OPENROUTER_API_KEY.');
  if (status === 402) return new Error('Krediterna på OpenRouter är slut (402). Fyll på, eller byt tillbaka till Gemini.');
  if (status === 404) return new Error(`OpenRouter hittar inte modellen "${model}". Kolla OPENROUTER_MODEL.`);
  if (status === 429) return new Error('OpenRouter begränsar anropen just nu (429). Vänta en stund och försök igen.');
  return new Error(`OpenRouter svarade med fel ${status}: ${message}`);
}

/** Strip ```json ... ``` fences some models add, and parse. */
function parseLoose<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed) as T;
}

/**
 * Ask a model on OpenRouter for JSON matching `schema` (as a top-level
 * array the answer is wrapped in an object, since structured output wants
 * an object). Rate limits and server errors are retried with a pause; an
 * answer that isn't usable JSON is asked for once more.
 */
export async function openRouterJson<T>(prompt: string, schema: Schema, opts: OpenRouterOptions = {}): Promise<T> {
  const apiKey = opts.apiKey ?? config.openrouterApiKey;
  const model = opts.model ?? config.openrouterModel;
  const baseUrl = opts.baseUrl ?? config.openrouterBaseUrl;
  const delays = opts.retryDelays ?? [2000, 5000, 15000];
  if (!apiKey) throw new Error('HIGHLIGHT_PROVIDER=openrouter kräver OPENROUTER_API_KEY.');

  const wrapped = String(schema.type).toUpperCase() === 'ARRAY';
  const jsonSchema = wrapped
    ? { type: 'object', properties: { items: toJsonSchema(schema) }, required: ['items'], additionalProperties: false }
    : toJsonSchema(schema);
  const instruction = wrapped
    ? '\n\nAnswer with a JSON object of the form {"items": [...]} and nothing else.'
    : '\n\nAnswer with JSON only.';
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt + instruction }],
    response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: jsonSchema } },
    reasoning: { effort: 'medium' },
  });

  let lastError: Error = new Error('OpenRouter gav inget användbart svar.');
  let badAnswers = 0;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Auto Clipper',
        },
        body,
      });
    } catch (err) {
      lastError = new Error(`Kunde inte nå OpenRouter: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      lastError = explain(res.status, text, model);
      const retry = res.status === 429 || res.status >= 500;
      if (!retry || attempt >= delays.length) throw lastError;
      await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }
    try {
      const data = JSON.parse(text);
      // OpenRouter can answer 200 with an error from the model's provider.
      if (data?.error) throw explain(Number(data.error.code) || 502, JSON.stringify(data), model);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('OpenRouter gav inget svar.');
      const parsed = parseLoose<Record<string, unknown>>(content);
      if (!wrapped) return parsed as T;
      if (Array.isArray(parsed)) return parsed as T; // a model that answered with the bare list
      if (Array.isArray(parsed?.items)) return parsed.items as T;
      throw new Error('OpenRouter svarade med JSON i fel form.');
    } catch (err) {
      lastError = err instanceof SyntaxError ? new Error('OpenRouter svarade med ogiltig JSON.') : (err as Error);
      if (++badAnswers >= 2) throw lastError;
    }
  }
  throw lastError;
}
