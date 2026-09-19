import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { test } from 'vitest';
// Loads .env so FISH_API_KEY is picked up the same way the bot picks it up.
import '../../src/config.js';
import { createAudioPipeline } from '../../src/audio/ffmpeg.js';
import { EdgeTtsEngine } from '../../src/tts/edge-engine.js';
import { FishTtsEngine } from '../../src/tts/fish-engine.js';
import { voicePresets } from '../../src/tts/presets.js';
import type { TtsAudio, TtsVoicePreset } from '../../src/tts/tts.js';

function preset(id: string): TtsVoicePreset {
  const found = voicePresets.find((candidate) => candidate.id === id);
  assert.ok(found, `preset ${id} is missing`);
  return found;
}

/**
 * Runs the audio through the exact pipeline playback uses and counts the Opus
 * frames Discord would receive. Each frame is 20 ms, so the count is a duration.
 */
async function decodedFrames(audio: TtsAudio): Promise<number> {
  const pipeline = createAudioPipeline(
    Readable.from(audio.data),
    { text: 'live' },
    (error) => {
      throw error;
    },
  );
  const stream = pipeline.resource.playStream as unknown as Readable;
  let frames = 0;
  for await (const frame of stream) if (frame) frames += 1;
  pipeline.dispose();
  return frames;
}

// One second of speech. The test phrase measures 121 frames on Edge and 82 on
// Fish, which speaks faster, so this clears both without being noise-tolerant.
const MINIMUM_FRAMES = 50;

test('ffmpeg is available for the decode assertions', async () => {
  const code = await new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });
  assert.equal(code, 0, 'FFmpeg must be on PATH for the live TTS tests');
});

// This is the regression guard for the pinned Chromium version: the service
// answers a stale Sec-MS-GEC-Version with 403 even though the token is valid.
test('edge synthesizes English speech that decodes for Discord', async () => {
  const audio = await new EdgeTtsEngine().synthesize(
    'Hello from PochanaBot.',
    preset('aria'),
    new AbortController().signal,
  );

  assert.equal(audio.contentType, 'audio/mpeg');
  assert.ok(audio.data.length > 1_000, 'expected a non-trivial MP3');
  assert.ok(
    (await decodedFrames(audio)) > MINIMUM_FRAMES,
    'expected decodable audio',
  );
});

test('edge synthesizes non-Latin speech', async () => {
  const audio = await new EdgeTtsEngine().synthesize(
    '안녕하세요. 반갑습니다.',
    preset('injoon'),
    new AbortController().signal,
  );
  assert.ok((await decodedFrames(audio)) > MINIMUM_FRAMES);
});

test.skipIf(!process.env.FISH_API_KEY)(
  'fish synthesizes speech that decodes for Discord',
  async () => {
    const audio = await new FishTtsEngine({
      apiKey: process.env.FISH_API_KEY,
    }).synthesize(
      'Hello from PochanaBot.',
      preset('sarah'),
      new AbortController().signal,
    );

    assert.ok(audio.data.length > 1_000);
    assert.ok((await decodedFrames(audio)) > MINIMUM_FRAMES);
  },
);
