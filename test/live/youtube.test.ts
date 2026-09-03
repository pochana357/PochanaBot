import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { test } from 'vitest';
import { findFfmpegCommand } from '../../src/audio/ffmpeg.js';
import { YouTubeEngine } from '../../src/providers/youtube-engine.js';

const DEFAULT_VIDEO_URL = 'https://youtu.be/dQw4w9WgXcQ';

test('downloads and decodes a complete YouTube track', async () => {
  const input = process.env.YOUTUBE_TEST_INPUT?.trim() || DEFAULT_VIDEO_URL;
  const provider = new YouTubeEngine();
  const video = provider.isYouTubeUrl(input)
    ? await provider.resolveUrl(input)
    : await provider.search(input);
  const playbackStream = await provider.createPlaybackStream(video);

  await decodeStream(playbackStream);

  assert.ok(video.id);
  assert.ok(video.title);
  assert.ok(video.duration > 0);
});

function decodeStream(playbackStream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      findFfmpegCommand(),
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'null', '-'],
      {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );

    let stderr = '';
    playbackStream.once('error', (error) => child.stdin.destroy(error));
    child.stdin.on('error', () => undefined);
    playbackStream.pipe(child.stdin);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      playbackStream.destroy();
      reject(error);
    });
    child.once('close', (code) => {
      playbackStream.destroy();
      if (code === 0) resolve();
      else
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}.`));
    });
  });
}
