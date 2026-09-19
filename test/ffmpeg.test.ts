import assert from 'node:assert/strict';
import { test } from 'vitest';
import { findFfmpegCommand, MAX_DECODED_SECONDS } from '../src/audio/ffmpeg.js';
import { MAX_TTS_TEXT_LENGTH } from '../src/tts/tts-service.js';

test('prefers ffmpeg from the system PATH', () => {
  const attempts: string[] = [];

  const command = findFfmpegCommand((candidate) => {
    attempts.push(candidate);
    return true;
  });

  assert.equal(command, 'ffmpeg');
  assert.deepEqual(attempts, ['ffmpeg']);
});

test('falls back to a local ffmpeg executable', () => {
  const attempts: string[] = [];

  const command = findFfmpegCommand((candidate) => {
    attempts.push(candidate);
    return candidate === './ffmpeg';
  });

  assert.equal(command, './ffmpeg');
  assert.deepEqual(attempts, ['ffmpeg', './ffmpeg']);
});

// The slowest speech worth accommodating: one character per third of a second,
// which is roughly a Korean or Japanese preset reading syllable by syllable at
// reduced speed. Anything slower than this is not speech we intend to support.
const SLOWEST_CHARACTERS_PER_SECOND = 3;

// These two constants live in different modules but are one decision. A ceiling
// below the longest accepted request rejects valid speech only after paying to
// synthesize it, which is how a thirty-second bound previously failed Korean.
test('the decoded-audio ceiling covers the longest utterance /tts accepts', () => {
  const longestUtteranceSeconds =
    MAX_TTS_TEXT_LENGTH / SLOWEST_CHARACTERS_PER_SECOND;

  assert.ok(
    MAX_DECODED_SECONDS >= longestUtteranceSeconds,
    `${MAX_TTS_TEXT_LENGTH} characters can run ${longestUtteranceSeconds}s, past the ${MAX_DECODED_SECONDS}s decode ceiling`,
  );
});

test('fails clearly when ffmpeg cannot be found', () => {
  assert.throws(
    () => findFfmpegCommand(() => false),
    /system PATH or at \.\/ffmpeg/,
  );
});
