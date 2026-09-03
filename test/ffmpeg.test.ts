import assert from 'node:assert/strict';
import { test } from 'vitest';
import { findFfmpegCommand } from '../src/audio/ffmpeg.js';

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

test('fails clearly when ffmpeg cannot be found', () => {
  assert.throws(
    () => findFfmpegCommand(() => false),
    /system PATH or at \.\/ffmpeg/,
  );
});
