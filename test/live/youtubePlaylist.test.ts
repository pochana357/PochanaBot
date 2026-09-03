import assert from 'node:assert/strict';
import { test } from 'vitest';
import { YouTubeEngine } from '../../src/providers/youtube-engine.js';

const PLAYLIST_URL =
  'https://www.youtube.com/playlist?list=PLOHoVaTp8R7ccrQM3EpCTVDdwHhXrJhXS';

test('resolves every song in the 100-song YouTube playlist', async () => {
  const videos = await new YouTubeEngine().resolvePlaylist(PLAYLIST_URL);

  assert.equal(videos.length, 100);
  for (const video of videos) {
    assert.match(video.id, /^[A-Za-z0-9_-]{11}$/);
    assert.ok(video.title);
    assert.ok(video.duration > 0);
    assert.equal(video.url, `https://www.youtube.com/watch?v=${video.id}`);
  }
});
