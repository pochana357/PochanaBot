import assert from 'node:assert/strict';
import { test } from 'vitest';
import { JsonLogger } from '../../src/logger.js';
import {
  buildPayload,
  DEFAULT_FISH_MODEL,
  FishTtsEngine,
} from '../../src/tts/fish-engine.js';
import { TtsError, type TtsVoicePreset } from '../../src/tts/tts.js';

const preset: TtsVoicePreset = {
  id: 'sarah',
  label: 'Sarah',
  engine: 'fish',
  voice: '933563129e564b19a115bedd57b7406a',
  language: 'en',
};

type Captured = { url: string; init: RequestInit };

function engineReturning(
  response: Response,
  captured: Captured[] = [],
  apiKey = 'secret-key',
) {
  const engine = new FishTtsEngine({
    apiKey,
    fetchImpl: (async (url: string, init: RequestInit) => {
      captured.push({ url: String(url), init });
      return response;
    }) as unknown as typeof fetch,
  });
  return { engine, captured };
}

function audioResponse(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
    status: 200,
    headers: { 'content-type': 'audio/opus' },
  });
}

// The model infers language from the text; sending a language field changes the
// result, so the payload shape is asserted exactly.
test('the payload omits every language field', () => {
  const payload = buildPayload('hello', preset) as Record<string, unknown>;
  for (const key of ['lang', 'language', 'language_code', 'references']) {
    assert.equal(key in payload, false, `payload must not contain ${key}`);
  }
  assert.equal(payload.reference_id, preset.voice);
  assert.equal(payload.format, 'opus');
  assert.equal(payload.sample_rate, 48000);
  assert.deepEqual(payload.prosody, {
    speed: 1,
    volume: 0,
    normalize_loudness: true,
  });
});

test('preset speed and volume reach the prosody block', () => {
  const payload = buildPayload('hello', {
    ...preset,
    speed: 1.15,
    volume: -6,
  });
  assert.deepEqual(payload.prosody, {
    speed: 1.15,
    volume: -6,
    normalize_loudness: true,
  });
});

test('the model travels in a bare header, not the body', async () => {
  const { engine, captured } = engineReturning(audioResponse([1, 2, 3]));

  const audio = await engine.synthesize(
    'hello',
    preset,
    new AbortController().signal,
  );

  assert.equal(captured.length, 1);
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers.model, DEFAULT_FISH_MODEL);
  assert.equal(headers.Authorization, 'Bearer secret-key');
  assert.equal(captured[0].init.redirect, 'error');
  assert.equal(JSON.parse(String(captured[0].init.body)).model, undefined);
  assert.deepEqual([...audio.data], [1, 2, 3]);
});

test('a JSON body on a 200 is treated as an error, not as audio', async () => {
  const { engine } = engineReturning(
    new Response('{"error":"nope"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  await assert.rejects(
    engine.synthesize('hello', preset, new AbortController().signal),
    TtsError,
  );
});

test('an empty body is rejected rather than played as silence', async () => {
  const { engine } = engineReturning(audioResponse([]));
  await assert.rejects(
    engine.synthesize('hello', preset, new AbortController().signal),
    TtsError,
  );
});

test('the API key never appears in an error message', async () => {
  const { engine } = engineReturning(
    new Response('bad token secret-key rejected', {
      status: 401,
      headers: { 'content-type': 'text/plain' },
    }),
  );

  await assert.rejects(
    engine.synthesize('hello', preset, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof TtsError);
      assert.equal(error.message.includes('secret-key'), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test('a missing key is reported instead of attempting a request', async () => {
  let calls = 0;
  const engine = new FishTtsEngine({
    fetchImpl: (async () => {
      calls += 1;
      return audioResponse([1]);
    }) as unknown as typeof fetch,
  });

  await assert.rejects(
    engine.synthesize('hello', preset, new AbortController().signal),
    /FISH_API_KEY/,
  );
  assert.equal(calls, 0);
});

// JsonLogger walks the whole cause chain, so redacting the thrown message alone
// would still leak the key once PlaybackManager logs the failure.
test('the API key never reaches a serialized cause or stack', async () => {
  const lines: string[] = [];
  const sink = { write: (value: string) => lines.push(value) };
  const engine = new FishTtsEngine({
    apiKey: 'secret-key',
    fetchImpl: (async () => {
      throw new Error('transport failed for Bearer secret-key', {
        cause: new Error('inner secret-key detail'),
      });
    }) as unknown as typeof fetch,
  });

  await assert.rejects(
    engine.synthesize('hello', preset, new AbortController().signal),
    (error: unknown) => {
      new JsonLogger(sink, sink).error('speech_start_failed', error);
      return true;
    },
  );

  const serialized = lines.join('');
  assert.equal(serialized.includes('secret-key'), false);
  assert.match(serialized, /\[REDACTED\]/);
  // The chain is preserved, just scrubbed.
  assert.match(serialized, /inner \[REDACTED\] detail/);
});
