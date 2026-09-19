import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildSsml,
  edgeTimestamp,
  parseBinaryFrame,
  parseTextFrame,
  secMsGecToken,
} from '../../src/tts/edge-engine.js';
import { TtsError, type TtsVoicePreset } from '../../src/tts/tts.js';

const preset: TtsVoicePreset = {
  id: 'aria',
  label: 'Aria',
  engine: 'edge',
  voice: 'en-US-AriaNeural',
  language: 'en',
};

function binaryFrame(headers: string, payload: Buffer): Buffer {
  const header = Buffer.from(headers);
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(header.length, 0);
  return Buffer.concat([prefix, header, payload]);
}

// Pinned so a change to the epoch offset, window size, or BigInt arithmetic
// fails loudly rather than silently producing 403s at runtime.
test('the Sec-MS-GEC token matches its pinned value for a fixed clock', () => {
  assert.equal(
    secMsGecToken(1_700_000_000_000),
    '42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF',
  );
});

test('the Sec-MS-GEC token is stable within a five-minute window', () => {
  assert.equal(
    secMsGecToken(1_700_000_000_000),
    secMsGecToken(1_700_000_099_000),
  );
  assert.notEqual(
    secMsGecToken(1_700_000_000_000),
    secMsGecToken(1_700_000_200_000),
  );
  assert.match(secMsGecToken(1_700_000_000_000), /^[0-9A-F]{64}$/);
});

test('binary frames yield their payload with the envelope stripped', () => {
  const payload = Buffer.from([0xff, 0xfb, 0x00, 0x11, 0x22]);
  const frame = binaryFrame(
    'X-RequestId:abc\r\nPath:audio\r\nContent-Type:audio/mpeg\r\n',
    payload,
  );

  const parsed = parseBinaryFrame(frame);
  assert.equal(parsed.headers.get('Path'), 'audio');
  assert.equal(parsed.headers.get('Content-Type'), 'audio/mpeg');
  assert.deepEqual([...parsed.payload], [...payload]);
});

test('an empty payload parses without consuming header bytes', () => {
  const parsed = parseBinaryFrame(
    binaryFrame('Path:audio\r\n', Buffer.alloc(0)),
  );
  assert.equal(parsed.headers.get('Path'), 'audio');
  assert.equal(parsed.payload.length, 0);
});

test('malformed binary frames are rejected rather than corrupting the audio', () => {
  assert.throws(() => parseBinaryFrame(Buffer.from([0x00])), TtsError);
  const lying = Buffer.alloc(4);
  lying.writeUInt16BE(999, 0);
  assert.throws(() => parseBinaryFrame(lying), TtsError);
});

test('text frames expose the path that ends a turn', () => {
  const frame =
    'X-RequestId:abc\r\nContent-Type:application/json\r\nPath:turn.end\r\n\r\n{}';
  assert.equal(parseTextFrame(frame).headers.get('Path'), 'turn.end');
});

test('SSML escapes the message so markup cannot break the request', () => {
  const ssml = buildSsml('Tom & <b>Jerry</b>', preset);
  assert.match(ssml, /Tom &amp; &lt;b&gt;Jerry&lt;\/b&gt;/);
  assert.match(ssml, /name='en-US-AriaNeural'/);
  assert.match(ssml, /rate='\+0%'/);
  assert.match(ssml, /volume='\+0%'/);
});

test('SSML converts preset speed and decibel volume to percentages', () => {
  const ssml = buildSsml('hi', { ...preset, speed: 0.85, volume: -6 });
  assert.match(ssml, /rate='-15%'/);
  assert.match(ssml, /volume='-50%'/);
});

test('timestamps use the shape the service expects', () => {
  assert.equal(
    edgeTimestamp(new Date(Date.UTC(2026, 8, 19, 4, 5, 6))),
    'Sat Sep 19 2026 04:05:06 GMT+0000 (Coordinated Universal Time)',
  );
});
