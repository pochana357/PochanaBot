import assert from 'node:assert/strict';
import { once } from 'node:events';
import { buffer } from 'node:stream/consumers';
import { describe, test } from 'vitest';
import {
  YouTubeEngine,
  YouTubeProviderError,
  type YouTubeClient,
  type YouTubeProviderErrorCode,
} from '../src/providers/youtube-engine.js';

const VIDEO_ID = 'dQw4w9WgXcQ';
const WATCH_IN_PLAYLIST_URL =
  'https://www.youtube.com/watch?v=ArmDp-zijuc&list=PLhUJa82bESk1YBz1t6rXa-R2u6saFO5o_&index=9';
type VideoInfo = Awaited<ReturnType<YouTubeClient['getBasicInfo']>>;
type BasicVideoInfo = NonNullable<VideoInfo['basic_info']>;
type StreamingDataOptions = Parameters<YouTubeClient['getStreamingData']>[1];

function playableInfo(overrides: Partial<BasicVideoInfo> = {}): VideoInfo {
  return {
    playability_status: { status: 'OK' },
    basic_info: {
      id: VIDEO_ID,
      title: 'Test video',
      duration: 213,
      url_canonical: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      thumbnail: [
        { url: 'small.jpg', width: 120, height: 90 },
        { url: 'large.jpg', width: 1280, height: 720 },
      ],
      ...overrides,
    },
  };
}

function mockClient(overrides: Partial<YouTubeClient> = {}): YouTubeClient {
  return {
    search: async () => ({ videos: [] }),
    getPlaylist: async () => ({
      items: [],
      has_continuation: false,
      getContinuation: async () => {
        throw new Error('not called');
      },
    }),
    resolveURL: async () => ({}),
    getInfo: async () => playableInfo(),
    getBasicInfo: async () => playableInfo(),
    getStreamingData: async () => undefined,
    ...overrides,
  };
}

test('parses supported individual YouTube video URL forms', () => {
  const provider = new YouTubeEngine({
    createClient: async () => mockClient(),
  });

  const urls = [
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com/watch?v=${VIDEO_ID}&list=PL123`,
    `https://music.youtube.com/watch?v=${VIDEO_ID}`,
    `https://m.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?si=abc`,
    `https://www.youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
  ];

  for (const url of urls) {
    assert.equal(provider.isYouTubeUrl(url), true);
    assert.equal(provider.parseVideoId(url), VIDEO_ID);
  }
});

test('parses playlist URLs separately from individual video URLs', () => {
  const provider = new YouTubeEngine({
    createClient: async () => mockClient(),
  });
  const playlistUrl = 'https://www.youtube.com/playlist?list=PL123';

  assert.equal(provider.isYouTubeUrl(playlistUrl), true);
  assert.equal(provider.parsePlaylistId(playlistUrl), 'PL123');
  assert.throws(
    () => provider.parseVideoId(playlistUrl),
    (error) =>
      error instanceof YouTubeProviderError &&
      error.code === 'PLAYLIST_UNSUPPORTED',
  );
});

test('selects the video or playlist part of a shared watch URL by command', () => {
  const provider = new YouTubeEngine({
    createClient: async () => mockClient(),
  });

  assert.equal(provider.parseVideoId(WATCH_IN_PLAYLIST_URL), 'ArmDp-zijuc');
  assert.equal(
    provider.parsePlaylistId(WATCH_IN_PLAYLIST_URL),
    'PLhUJa82bESk1YBz1t6rXa-R2u6saFO5o_',
  );
});

test('parses a generated YouTube Mix playlist id', () => {
  const provider = new YouTubeEngine({
    createClient: async () => mockClient(),
  });
  const mixUrl =
    'https://www.youtube.com/watch?v=6Eo_wssvm2Q&list=RD6Eo_wssvm2Q&index=1';

  assert.equal(provider.parseVideoId(mixUrl), '6Eo_wssvm2Q');
  assert.equal(provider.parsePlaylistId(mixUrl), 'RD6Eo_wssvm2Q');
});

test('resolves only the initial watch panel for a generated YouTube Mix', async () => {
  const text = (value: string) => ({ toString: () => value });
  const mixUrl =
    'https://www.youtube.com/watch?v=6Eo_wssvm2Q&list=RD6Eo_wssvm2Q&index=2';
  const endpoint = {};
  let getPlaylistCalls = 0;
  const provider = new YouTubeEngine({
    createClient: async () =>
      mockClient({
        getPlaylist: async () => {
          getPlaylistCalls += 1;
          throw new Error('not called');
        },
        resolveURL: async (url) => {
          assert.equal(url, mixUrl);
          return endpoint;
        },
        getInfo: async (target) => {
          assert.equal(target, endpoint);
          return {
            playlist: {
              contents: [
                {
                  video_id: '6Eo_wssvm2Q',
                  title: text('Your Letter'),
                  duration: { seconds: 296 },
                  thumbnail: [
                    { url: 'seed-small.jpg', width: 120, height: 90 },
                    { url: 'seed-large.jpg', width: 1280, height: 720 },
                  ],
                },
                {
                  video_id: 'UOKLtaE2U90',
                  title: text('Bansanka'),
                  duration: { seconds: 219 },
                },
              ],
            },
          };
        },
      }),
  });

  const videos = await provider.resolvePlaylist(mixUrl);

  assert.equal(getPlaylistCalls, 0);
  assert.deepEqual(videos, [
    {
      id: '6Eo_wssvm2Q',
      title: 'Your Letter',
      url: 'https://www.youtube.com/watch?v=6Eo_wssvm2Q',
      duration: 296,
      thumbnail: 'seed-large.jpg',
    },
    {
      id: 'UOKLtaE2U90',
      title: 'Bansanka',
      url: 'https://www.youtube.com/watch?v=UOKLtaE2U90',
      duration: 219,
      thumbnail: undefined,
    },
  ]);
});

test('requires a watch URL to resolve a generated YouTube Mix', async () => {
  const provider = new YouTubeEngine({
    createClient: async () => mockClient(),
  });

  await assert.rejects(
    provider.resolvePlaylist(
      'https://www.youtube.com/playlist?list=RD6Eo_wssvm2Q',
    ),
    (error) =>
      error instanceof YouTubeProviderError &&
      error.code === 'PLAYLIST_MIX_REQUIRES_VIDEO',
  );
});

test('resolves playlist pages in order and skips unplayable entries', async () => {
  const text = (value: string) => ({ toString: () => value });
  const item = (id: string, title: string, duration: string) => ({
    type: 'LockupView',
    content_id: id,
    content_type: 'VIDEO',
    metadata: { title: text(title) },
    content_image: {
      image: [
        { url: `${id}-small.jpg`, width: 120, height: 90 },
        { url: `${id}-large.jpg`, width: 1280, height: 720 },
      ],
      overlays: [{ badges: [{ text: duration }] }],
    },
  });
  const continuation = {
    items: [
      { ...item('bbbbbbbbbbb', 'Second track', '1:02:03') },
      { ...item('ccccccccccc', 'Live track', 'LIVE'), is_live: true },
    ],
    has_continuation: false,
    getContinuation: async () => {
      throw new Error('not called');
    },
  };
  const provider = new YouTubeEngine({
    createClient: async () =>
      mockClient({
        getPlaylist: async () => ({
          items: [item('aaaaaaaaaaa', 'First track', '3:07')],
          has_continuation: true,
          getContinuation: async () => continuation,
        }),
      }),
  });

  const videos = await provider.resolvePlaylist(
    'https://www.youtube.com/playlist?list=PLOHoVaTp8R7ccrQM3EpCTVDdwHhXrJhXS',
  );

  assert.deepEqual(videos, [
    {
      id: 'aaaaaaaaaaa',
      title: 'First track',
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      duration: 187,
      thumbnail: 'aaaaaaaaaaa-large.jpg',
    },
    {
      id: 'bbbbbbbbbbb',
      title: 'Second track',
      url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
      duration: 3723,
      thumbnail: 'bbbbbbbbbbb-large.jpg',
    },
  ]);
});

test('initializes the client lazily once and maps direct video metadata', async () => {
  let createCount = 0;
  const client = mockClient({
    getBasicInfo: async () => playableInfo(),
  });
  const provider = new YouTubeEngine({
    createClient: async () => {
      createCount += 1;
      return client;
    },
  });

  assert.equal(createCount, 0);
  const first = await provider.resolveUrl(`https://youtu.be/${VIDEO_ID}`);
  const second = await provider.getVideo(VIDEO_ID);

  assert.equal(createCount, 1);
  assert.equal(first.id, VIDEO_ID);
  assert.equal(first.title, 'Test video');
  assert.equal(first.duration, 213);
  assert.equal(first.thumbnail, 'large.jpg');
  assert.equal(second.id, VIDEO_ID);
});

test('retries lazy initialization after a transient client creation failure', async () => {
  let createCount = 0;
  const provider = new YouTubeEngine({
    createClient: async () => {
      createCount += 1;
      if (createCount === 1) throw new Error('temporary outage');
      return mockClient({ getBasicInfo: async () => playableInfo() });
    },
  });

  await assert.rejects(
    provider.getVideo(VIDEO_ID),
    (error) =>
      error instanceof YouTubeProviderError && error.code === 'API_UNAVAILABLE',
  );
  assert.equal((await provider.getVideo(VIDEO_ID)).id, VIDEO_ID);
  assert.equal(createCount, 2);
});

test('search skips live results and resolves the selected video through basic info', async () => {
  const requestedIds: string[] = [];
  const provider = new YouTubeEngine({
    createClient: async () =>
      mockClient({
        search: async () => ({
          videos: [
            {
              video_id: 'aaaaaaaaaaa',
              duration: { seconds: 30 },
              is_live: true,
            },
            { video_id: VIDEO_ID, duration: { seconds: 213 }, is_live: false },
          ],
        }),
        getBasicInfo: async (id) => {
          requestedIds.push(id);
          return playableInfo();
        },
      }),
  });

  const video = await provider.search('test search');

  assert.equal(video.id, VIDEO_ID);
  assert.deepEqual(requestedIds, [VIDEO_ID]);
});

describe('restricted videos', () => {
  const cases: Array<[string, VideoInfo, YouTubeProviderErrorCode]> = [
    ['live', playableInfo({ is_live: true }), 'LIVE_UNSUPPORTED'],
    ['upcoming', playableInfo({ is_upcoming: true }), 'LIVE_UNSUPPORTED'],
    ['private', playableInfo({ is_private: true }), 'RESTRICTED'],
    [
      'login required',
      {
        playability_status: { status: 'LOGIN_REQUIRED' },
        basic_info: {},
      },
      'RESTRICTED',
    ],
  ];

  for (const [name, info, expectedCode] of cases) {
    test(name, async () => {
      const provider = new YouTubeEngine({
        createClient: async () =>
          mockClient({ getBasicInfo: async () => info }),
      });
      await assert.rejects(
        provider.getVideo(VIDEO_ID),
        (error) =>
          error instanceof YouTubeProviderError && error.code === expectedCode,
      );
    });
  }
});

test('retrieves a fresh best audio URL for every playback request', async () => {
  const calls: Array<{ id: string; options: StreamingDataOptions }> = [];
  const provider = new YouTubeEngine({
    createClient: async () =>
      mockClient({
        getStreamingData: async (id, options) => {
          calls.push({ id, options });
          return { url: `https://media.example/${calls.length}` };
        },
      }),
  });

  assert.equal(
    await provider.getPlaybackUrl(VIDEO_ID),
    'https://media.example/1',
  );
  assert.equal(
    await provider.getPlaybackUrl({ id: VIDEO_ID }),
    'https://media.example/2',
  );
  assert.deepEqual(calls, [
    {
      id: VIDEO_ID,
      options: {
        client: 'VISIONOS',
        type: 'audio',
        quality: 'best',
        format: 'any',
      },
    },
    {
      id: VIDEO_ID,
      options: {
        client: 'VISIONOS',
        type: 'audio',
        quality: 'best',
        format: 'any',
      },
    },
  ]);
});

test('streams audio in ordered CPN-bound ranges instead of exposing a bare media URL', async () => {
  const requests: Array<{ parsed: URL; options?: RequestInit }> = [];
  const player = { name: 'test-player' };
  const bytes = Buffer.from('abcdefghij');
  const info: VideoInfo = {
    ...playableInfo(),
    cpn: 'test-cpn',
    chooseFormat: (options) => {
      assert.deepEqual(options, {
        type: 'audio',
        quality: 'best',
        format: 'any',
      });
      return {
        content_length: bytes.length,
        decipher: async (receivedPlayer) => {
          assert.equal(receivedPlayer, player);
          return 'https://media.example/audio?token=fresh';
        },
      };
    },
  };
  const provider = new YouTubeEngine({
    playbackChunkSize: 4,
    createClient: async () =>
      mockClient({
        getBasicInfo: async (id, options) => {
          assert.equal(id, VIDEO_ID);
          assert.deepEqual(options, { client: 'VISIONOS' });
          return info;
        },
        session: {
          player,
          http: {
            fetch_function: async (url, options) => {
              const parsed = new URL(
                typeof url === 'string'
                  ? url
                  : url instanceof URL
                    ? url
                    : url.url,
              );
              const range = parsed.searchParams.get('range');
              assert.ok(range);
              const [start, end] = range.split('-').map(Number) as [
                number,
                number,
              ];
              requests.push({ parsed, options });
              return new Response(bytes.subarray(start, end + 1));
            },
          },
        },
      }),
  });

  const stream = await provider.createPlaybackStream(VIDEO_ID);
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(stream, 'end');

  assert.equal(Buffer.concat(chunks).toString(), bytes.toString());
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map(({ parsed }) => [
      parsed.searchParams.get('cpn'),
      parsed.searchParams.get('range'),
    ]),
    [
      ['test-cpn', '0-3'],
      ['test-cpn', '4-7'],
      ['test-cpn', '8-9'],
    ],
  );
  for (const { options } of requests) {
    assert.equal(
      new Headers(options?.headers).get('origin'),
      'https://www.youtube.com',
    );
    assert.equal(options?.redirect, 'follow');
  }
});

test('resolves fresh streaming data for every managed playback stream', async () => {
  let infoCalls = 0;
  const provider = new YouTubeEngine({
    createClient: async () =>
      mockClient({
        getBasicInfo: async () => {
          infoCalls += 1;
          return {
            ...playableInfo(),
            cpn: `cpn-${infoCalls}`,
            chooseFormat: () => ({
              content_length: 1,
              decipher: async () => `https://media.example/${infoCalls}`,
            }),
          };
        },
        session: {
          player: {},
          http: { fetch_function: async () => new Response(Buffer.from('x')) },
        },
      }),
  });

  const first = await provider.createPlaybackStream(VIDEO_ID);
  const second = await provider.createPlaybackStream(VIDEO_ID);
  first.destroy();
  second.destroy();

  assert.equal(infoCalls, 2);
});

test('retries a reset media range without exposing partial bytes to FFmpeg', async () => {
  const bytes = Buffer.from('abcd');
  const requests: Array<string | null> = [];
  const reset = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
  });
  let attempts = 0;
  const provider = new YouTubeEngine({
    playbackChunkSize: bytes.length,
    playbackRetryDelayMs: 0,
    createClient: async () =>
      mockClient({
        getBasicInfo: async () => ({
          ...playableInfo(),
          cpn: 'test-cpn',
          chooseFormat: () => ({
            content_length: bytes.length,
            decipher: async () => 'https://media.example/audio',
          }),
        }),
        session: {
          player: {},
          http: {
            fetch_function: async (url) => {
              attempts += 1;
              const parsed = new URL(
                typeof url === 'string'
                  ? url
                  : url instanceof URL
                    ? url
                    : url.url,
              );
              requests.push(parsed.searchParams.get('range'));
              if (attempts === 1) {
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(bytes.subarray(0, 2));
                      controller.error(reset);
                    },
                  }),
                );
              }
              return new Response(bytes);
            },
          },
        },
      }),
  });

  const stream = await provider.createPlaybackStream(VIDEO_ID);

  assert.equal((await buffer(stream)).toString(), bytes.toString());
  assert.deepEqual(requests, ['0-3', '0-3']);
});

test('drains each bounded media response before yielding it to a slow consumer', async () => {
  const bytes = Buffer.from('abcd');
  let responseDrained = false;
  const provider = new YouTubeEngine({
    playbackChunkSize: bytes.length,
    createClient: async () =>
      mockClient({
        getBasicInfo: async () => ({
          ...playableInfo(),
          cpn: 'test-cpn',
          chooseFormat: () => ({
            content_length: bytes.length,
            decipher: async () => 'https://media.example/audio',
          }),
        }),
        session: {
          player: {},
          http: {
            fetch_function: async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(bytes.subarray(0, 2));
                    controller.enqueue(bytes.subarray(2));
                    responseDrained = true;
                    controller.close();
                  },
                }),
              ),
          },
        },
      }),
  });

  const stream = await provider.createPlaybackStream(VIDEO_ID);
  const [firstChunk] = await once(stream, 'data');

  assert.equal(responseDrained, true);
  assert.equal(Buffer.from(firstChunk).toString(), bytes.toString());
});

test('fails a managed playback stream after truncated range retries are exhausted', async () => {
  let attempts = 0;
  const provider = new YouTubeEngine({
    playbackChunkSize: 4,
    playbackMaxRetries: 2,
    playbackRetryDelayMs: 0,
    createClient: async () =>
      mockClient({
        getBasicInfo: async () => ({
          ...playableInfo(),
          cpn: 'test-cpn',
          chooseFormat: () => ({
            content_length: 4,
            decipher: async () => 'https://media.example/audio',
          }),
        }),
        session: {
          player: {},
          http: {
            fetch_function: async () => {
              attempts += 1;
              return new Response(Buffer.from('abc'));
            },
          },
        },
      }),
  });

  const stream = await provider.createPlaybackStream(VIDEO_ID);
  await assert.rejects(buffer(stream), /returned 3 of 4 expected bytes/);
  assert.equal(attempts, 3);
});

test('times out stalled media chunks and exhausts the existing retry policy', async () => {
  let attempts = 0;
  const provider = new YouTubeEngine({
    playbackChunkSize: 1,
    playbackChunkTimeoutMs: 10,
    playbackMaxRetries: 2,
    playbackRetryDelayMs: 0,
    createClient: async () =>
      mockClient({
        getBasicInfo: async () => ({
          ...playableInfo(),
          cpn: 'test-cpn',
          chooseFormat: () => ({
            content_length: 1,
            decipher: async () => 'https://media.example/audio',
          }),
        }),
        session: {
          player: {},
          http: {
            fetch_function: async (_url, options) => {
              attempts += 1;
              const signal = options?.signal;
              assert.ok(signal);
              return new Promise<Response>((_resolve, reject) => {
                const abort = () => reject(signal.reason);
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
              });
            },
          },
        },
      }),
  });

  const stream = await provider.createPlaybackStream(VIDEO_ID);

  await assert.rejects(
    buffer(stream),
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: string }).name === 'TimeoutError',
  );
  assert.equal(attempts, 3);
});

test('caller cancellation aborts an active media request without retrying', async () => {
  let attempts = 0;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const provider = new YouTubeEngine({
    playbackChunkSize: 1,
    playbackChunkTimeoutMs: 60_000,
    playbackMaxRetries: 3,
    playbackRetryDelayMs: 0,
    createClient: async () =>
      mockClient({
        getBasicInfo: async () => ({
          ...playableInfo(),
          cpn: 'test-cpn',
          chooseFormat: () => ({
            content_length: 1,
            decipher: async () => 'https://media.example/audio',
          }),
        }),
        session: {
          player: {},
          http: {
            fetch_function: async (_url, options) => {
              attempts += 1;
              requestStarted();
              const signal = options?.signal;
              assert.ok(signal);
              return new Promise<Response>((_resolve, reject) => {
                const abort = () => reject(signal.reason);
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
              });
            },
          },
        },
      }),
  });
  const controller = new AbortController();
  const stream = await provider.createPlaybackStream(
    VIDEO_ID,
    controller.signal,
  );
  const reading = buffer(stream);
  await started;

  controller.abort();

  await assert.rejects(
    reading,
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: string }).name === 'AbortError',
  );
  assert.equal(attempts, 1);
});

test('caller cancellation interrupts retry backoff without another request', async () => {
  let attempts = 0;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const provider = new YouTubeEngine({
    playbackChunkSize: 1,
    playbackChunkTimeoutMs: 60_000,
    playbackMaxRetries: 3,
    playbackRetryDelayMs: 60_000,
    createClient: async () =>
      mockClient({
        getBasicInfo: async () => ({
          ...playableInfo(),
          cpn: 'test-cpn',
          chooseFormat: () => ({
            content_length: 1,
            decipher: async () => 'https://media.example/audio',
          }),
        }),
        session: {
          player: {},
          http: {
            fetch_function: async () => {
              attempts += 1;
              requestStarted();
              throw new TypeError('temporary network failure');
            },
          },
        },
      }),
  });
  const controller = new AbortController();
  const stream = await provider.createPlaybackStream(
    VIDEO_ID,
    controller.signal,
  );
  const reading = buffer(stream);
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));

  controller.abort();

  await assert.rejects(
    reading,
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: string }).name === 'AbortError',
  );
  assert.equal(attempts, 1);
});
