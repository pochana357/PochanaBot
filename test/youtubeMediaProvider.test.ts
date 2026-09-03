import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'vitest';
import {
  YouTubeMediaProvider,
  type YouTubeEngineRuntime,
} from '../src/providers/youtube.js';
import type { Track } from '../src/media.js';

test('maps YouTube metadata into the provider-neutral Track contract', async () => {
  const engine: YouTubeEngineRuntime = {
    isYouTubeUrl: () => true,
    resolveUrl: async () => ({
      id: 'dQw4w9WgXcQ',
      title: 'Example video',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      duration: 213,
      thumbnail: 'https://example.com/thumbnail.jpg',
    }),
    resolvePlaylist: async () => {
      throw new Error('not called');
    },
    search: async () => {
      throw new Error('not called');
    },
    createPlaybackStream: async () => Readable.from('audio'),
  };
  const provider = new YouTubeMediaProvider(engine);
  const requester = { id: 'user-1', displayName: 'Listener' };

  const tracks = await provider.resolve(
    'https://youtu.be/dQw4w9WgXcQ',
    requester,
  );

  assert.deepEqual(tracks, [
    {
      provider: 'youtube',
      id: 'dQw4w9WgXcQ',
      title: 'Example video',
      webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      durationSeconds: 213,
      thumbnailUrl: 'https://example.com/thumbnail.jpg',
      requestedBy: requester,
    },
  ]);
});

test('rejects non-YouTube URLs while allowing plain-text search', async () => {
  const engine: YouTubeEngineRuntime = {
    isYouTubeUrl: (input: string) => input.includes('youtube.com'),
    resolveUrl: async () => {
      throw new Error('not called');
    },
    resolvePlaylist: async () => {
      throw new Error('not called');
    },
    search: async () => {
      throw new Error('not called');
    },
    createPlaybackStream: async () => Readable.from('audio'),
  };
  const provider = new YouTubeMediaProvider(engine);

  assert.equal(provider.supports('Daft Punk Around the World'), true);
  assert.equal(provider.supports('https://example.com/video'), false);
  assert.equal(
    provider.supports('https://youtube.com/watch?v=dQw4w9WgXcQ'),
    true,
  );
});

test('maps every resolved playlist video into a separate Track', async () => {
  const engine: YouTubeEngineRuntime = {
    isYouTubeUrl: () => true,
    resolveUrl: async () => {
      throw new Error('not called');
    },
    resolvePlaylist: async () => [
      {
        id: 'aaaaaaaaaaa',
        title: 'First track',
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        duration: 187,
      },
      {
        id: 'bbbbbbbbbbb',
        title: 'Second track',
        url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
        duration: 213,
      },
    ],
    search: async () => {
      throw new Error('not called');
    },
    createPlaybackStream: async () => Readable.from('audio'),
  };
  const provider = new YouTubeMediaProvider(engine);
  const requester = { id: 'user-1', displayName: 'Listener' };

  const tracks = await provider.resolvePlaylist(
    'https://www.youtube.com/playlist?list=PLOHoVaTp8R7ccrQM3EpCTVDdwHhXrJhXS',
    requester,
  );

  assert.deepEqual(
    tracks.map(({ id, title, requestedBy }) => ({ id, title, requestedBy })),
    [
      { id: 'aaaaaaaaaaa', title: 'First track', requestedBy: requester },
      { id: 'bbbbbbbbbbb', title: 'Second track', requestedBy: requester },
    ],
  );
});

test('passes the playback lifetime signal through to the YouTube engine', async () => {
  let receivedId: string | undefined;
  let receivedSignal: AbortSignal | undefined;
  const engine: YouTubeEngineRuntime = {
    isYouTubeUrl: () => true,
    resolveUrl: async () => {
      throw new Error('not called');
    },
    resolvePlaylist: async () => {
      throw new Error('not called');
    },
    search: async () => {
      throw new Error('not called');
    },
    createPlaybackStream: async (id, signal) => {
      receivedId = typeof id === 'string' ? id : id.id;
      receivedSignal = signal;
      return Readable.from('audio');
    },
  };
  const provider = new YouTubeMediaProvider(engine);
  const track: Track = {
    provider: 'youtube',
    id: 'dQw4w9WgXcQ',
    title: 'Example video',
    webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    durationSeconds: 213,
    requestedBy: { id: 'user-1', displayName: 'Listener' },
  };
  const controller = new AbortController();

  const stream = await provider.createPlaybackStream(track, controller.signal);

  assert.equal(receivedId, track.id);
  assert.equal(receivedSignal, controller.signal);
  stream.destroy();
});
