import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Type, type Schema } from '@google/genai';
import { openRouterJson, toJsonSchema } from './openrouter';

const schema: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      start: { type: Type.NUMBER, description: 'seconds' },
      kind: { type: Type.STRING, enum: ['a', 'b'] },
      tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ['start', 'kind', 'tags'],
    propertyOrdering: ['start', 'kind', 'tags'],
  },
};

test("Gemini's schema becomes plain JSON Schema, strict for objects", () => {
  assert.deepEqual(toJsonSchema(schema), {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        start: { type: 'number', description: 'seconds' },
        kind: { type: 'string', enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['start', 'kind', 'tags'],
      additionalProperties: false,
    },
  });
});

/** Swap fetch for answers in turn; returns the requests made. */
function fakeFetch(answers: { status: number; body: unknown }[]) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
    const next = answers.shift() ?? { status: 500, body: { error: { message: 'no more answers' } } };
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const opts = { apiKey: 'sk-test', model: 'example/model-a', baseUrl: 'https://example.test/api/v1', retryDelays: [1, 1, 1] };
const answer = (content: string) => ({ status: 200, body: { choices: [{ message: { content } }] } });

test('a list comes back wrapped in an object and is unwrapped; model, key and schema are sent', async () => {
  const fake = fakeFetch([answer('{"items": [{"start": 1, "kind": "a", "tags": []}]}')]);
  try {
    const items = await openRouterJson<unknown[]>('Pick clips', schema, opts);
    assert.deepEqual(items, [{ start: 1, kind: 'a', tags: [] }]);
    const [call] = fake.calls;
    assert.equal(call.url, 'https://example.test/api/v1/chat/completions');
    assert.equal(call.auth, 'Bearer sk-test');
    assert.equal(call.body.model, 'example/model-a');
    const format = call.body.response_format as { json_schema: { schema: { properties: { items: unknown } } } };
    assert.deepEqual(format.json_schema.schema.properties.items, toJsonSchema(schema));
  } finally {
    fake.restore();
  }
});

test('rate limits are retried, fenced or bare answers are fine', async () => {
  const fake = fakeFetch([
    { status: 429, body: { error: { message: 'slow down' } } },
    answer('```json\n[{"start": 2, "kind": "b", "tags": ["x"]}]\n```'),
  ]);
  try {
    const items = await openRouterJson<unknown[]>('Pick clips', schema, opts);
    assert.deepEqual(items, [{ start: 2, kind: 'b', tags: ['x'] }]);
    assert.equal(fake.calls.length, 2);
  } finally {
    fake.restore();
  }
});

test('errors say what to fix; bad JSON is asked for once more', async () => {
  let fake = fakeFetch([{ status: 401, body: { error: { message: 'No auth' } } }]);
  await assert.rejects(openRouterJson('x', schema, opts), /OPENROUTER_API_KEY/);
  fake.restore();
  fake = fakeFetch([{ status: 404, body: { error: { message: 'No endpoints found' } } }]);
  await assert.rejects(openRouterJson('x', schema, opts), /OPENROUTER_MODEL/);
  fake.restore();
  fake = fakeFetch([answer('not json'), answer('{"items": []}')]);
  try {
    assert.deepEqual(await openRouterJson('x', schema, opts), []);
  } finally {
    fake.restore();
  }
  fake = fakeFetch([answer('nope'), answer('still nope')]);
  await assert.rejects(openRouterJson('x', schema, opts), /ogiltig JSON/);
  fake.restore();
  await assert.rejects(openRouterJson('x', schema, { ...opts, apiKey: '' }), /OPENROUTER_API_KEY/);
});
