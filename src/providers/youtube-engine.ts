import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_PLAYBACK_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_PLAYBACK_CHUNK_TIMEOUT_MS = 30_000;
const DEFAULT_PLAYBACK_MAX_RETRIES = 3;
const DEFAULT_PLAYBACK_RETRY_DELAY_MS = 250;
const STREAM_HEADERS = Object.freeze({
  accept: '*/*',
  origin: 'https://www.youtube.com',
  referer: 'https://www.youtube.com',
  DNT: '?1',
});
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{2,128}$/;
const DEFAULT_MAX_PLAYLIST_LENGTH = 500;

export type YouTubeProviderErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PLAYLIST'
  | 'PLAYLIST_MIX_REQUIRES_VIDEO'
  | 'PLAYLIST_UNSUPPORTED'
  | 'PLAYLIST_EMPTY'
  | 'PLAYLIST_UNAVAILABLE'
  | 'LIVE_UNSUPPORTED'
  | 'RESTRICTED'
  | 'NO_RESULTS'
  | 'UNAVAILABLE'
  | 'STREAM_UNAVAILABLE'
  | 'API_UNAVAILABLE';

const ERROR_MESSAGES: Readonly<Record<YouTubeProviderErrorCode, string>> =
  Object.freeze({
    INVALID_INPUT: 'Please provide a valid YouTube video URL or search query.',
    INVALID_PLAYLIST: 'Please provide a valid YouTube playlist URL.',
    PLAYLIST_MIX_REQUIRES_VIDEO:
      'A YouTube Mix/radio link must include a video. Copy the URL from the YouTube watch page and try again.',
    PLAYLIST_UNSUPPORTED:
      'Use `/playlist` to add a YouTube playlist to the queue.',
    PLAYLIST_EMPTY: 'No playable videos were found in that YouTube playlist.',
    PLAYLIST_UNAVAILABLE:
      'That YouTube playlist is private, unavailable, or could not be loaded.',
    LIVE_UNSUPPORTED:
      'Live streams and upcoming premieres are not supported yet.',
    RESTRICTED:
      'This video cannot be played anonymously because it is private, age-restricted, bot-protected, or unavailable in this region.',
    NO_RESULTS: 'No playable YouTube videos were found for that search.',
    UNAVAILABLE:
      'This YouTube video is unavailable or does not contain playable audio.',
    STREAM_UNAVAILABLE:
      'YouTube did not provide a playable audio stream for this video.',
    API_UNAVAILABLE:
      'YouTube could not be reached. Please try again in a moment.',
  });

export class YouTubeProviderError extends Error {
  constructor(
    readonly code: YouTubeProviderErrorCode,
    options?: ErrorOptions,
  ) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'YouTubeProviderError';
  }
}

export type YouTubeVideo = {
  id: string;
  title: string;
  url: string;
  duration: number;
  thumbnail?: string;
};

type SearchVideo = {
  video_id?: string;
  id?: string;
  duration?: { seconds?: number };
  is_live?: boolean;
  is_upcoming?: boolean;
  is_premiere?: boolean;
};

type YouTubeText = string | { toString(): string };

type YouTubeThumbnail = {
  url?: string;
  width?: number;
  height?: number;
};

type YouTubePlaylistItem = {
  type?: string;
  id?: string;
  content_id?: string;
  video_id?: string;
  content_type?: string;
  title?: YouTubeText;
  metadata?: { title?: YouTubeText } | null;
  duration?: { seconds?: number };
  thumbnail?: Iterable<YouTubeThumbnail>;
  thumbnails?: Iterable<YouTubeThumbnail>;
  content_image?: {
    image?: Iterable<YouTubeThumbnail>;
    primary_thumbnail?: {
      image?: Iterable<YouTubeThumbnail>;
      overlays?: Iterable<{ badges?: Iterable<{ text?: string }> }>;
    } | null;
    overlays?: Iterable<{ badges?: Iterable<{ text?: string }> }>;
  } | null;
  is_playable?: boolean;
  is_live?: boolean;
  is_upcoming?: boolean;
};

export type YouTubePlaylistPage = {
  items: Iterable<YouTubePlaylistItem>;
  has_continuation: boolean;
  getContinuation(): Promise<YouTubePlaylistPage>;
};

type BasicVideoInfo = {
  id?: string;
  title?: string;
  duration?: number;
  url_canonical?: string;
  thumbnail?: Array<{ url?: string; width?: number; height?: number }>;
  is_live?: boolean;
  is_live_content?: boolean;
  is_upcoming?: boolean;
  is_private?: boolean;
};

type StreamingFormat = {
  url?: string;
  content_length?: number | string;
  decipher?(player: unknown): Promise<string | undefined>;
};

type VideoInfo = {
  playability_status?: { status?: string };
  basic_info?: BasicVideoInfo;
  playlist?: {
    contents?: Iterable<YouTubePlaylistItem>;
  } | null;
  cpn?: string;
  chooseFormat?(options: StreamingOptions): StreamingFormat | undefined;
};

type YouTubeNavigationEndpoint = object;

type StreamingOptions = {
  type: 'audio';
  quality: 'best';
  format: 'any';
};

type StreamingDataOptions = StreamingOptions & { client: string };

type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type YouTubeClient = {
  search(
    query: string,
    options: { type: 'video' },
  ): Promise<{ videos?: Iterable<SearchVideo> }>;
  getPlaylist(id: string): Promise<YouTubePlaylistPage>;
  resolveURL(url: string): Promise<YouTubeNavigationEndpoint>;
  getInfo(target: YouTubeNavigationEndpoint): Promise<VideoInfo>;
  getBasicInfo(id: string, options?: { client: string }): Promise<VideoInfo>;
  getStreamingData(
    id: string,
    options: StreamingDataOptions,
  ): Promise<StreamingFormat | undefined>;
  session?: {
    player?: unknown;
    http?: { fetch_function?: FetchFunction };
  };
};

export type YouTubeEngineOptions = {
  cacheDirectory?: string;
  playbackClient?: string;
  playbackChunkSize?: number;
  playbackChunkTimeoutMs?: number;
  playbackMaxRetries?: number;
  playbackRetryDelayMs?: number;
  createClient?: () => Promise<YouTubeClient> | YouTubeClient;
};

export class YouTubeEngine {
  readonly #cacheDirectory: string;
  readonly #playbackClient: string;
  readonly #playbackChunkSize: number;
  readonly #playbackChunkTimeoutMs: number;
  readonly #playbackMaxRetries: number;
  readonly #playbackRetryDelayMs: number;
  readonly #createClient: () => Promise<YouTubeClient> | YouTubeClient;
  #clientPromise?: Promise<YouTubeClient>;

  constructor(options: YouTubeEngineOptions = {}) {
    this.#cacheDirectory =
      options.cacheDirectory ||
      path.resolve(process.cwd(), '.cache', 'youtubei.js');
    this.#playbackClient = options.playbackClient || 'VISIONOS';
    this.#playbackChunkSize =
      options.playbackChunkSize || DEFAULT_PLAYBACK_CHUNK_SIZE;
    this.#playbackChunkTimeoutMs =
      options.playbackChunkTimeoutMs ?? DEFAULT_PLAYBACK_CHUNK_TIMEOUT_MS;
    this.#playbackMaxRetries =
      options.playbackMaxRetries ?? DEFAULT_PLAYBACK_MAX_RETRIES;
    this.#playbackRetryDelayMs =
      options.playbackRetryDelayMs ?? DEFAULT_PLAYBACK_RETRY_DELAY_MS;
    this.#createClient =
      options.createClient || (() => this.#createDefaultClient());
  }

  isYouTubeUrl(input: string): boolean {
    const url = parseUrl(input);
    return Boolean(url && YOUTUBE_HOSTS.has(url.hostname.toLowerCase()));
  }

  parsePlaylistId(input: string): string {
    const url = parseUrl(input);
    if (!url || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
      throw new YouTubeProviderError('INVALID_PLAYLIST');
    }

    const playlistId = url.searchParams.get('list') || '';
    if (!PLAYLIST_ID_PATTERN.test(playlistId)) {
      throw new YouTubeProviderError('INVALID_PLAYLIST');
    }
    return playlistId;
  }

  parseVideoId(input: string): string {
    const url = parseUrl(input);
    if (!url || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
      throw new YouTubeProviderError('INVALID_INPUT');
    }

    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') {
      return assertVideoId(url.pathname.split('/').filter(Boolean)[0]);
    }
    if (
      url.pathname === '/playlist' ||
      (url.searchParams.has('list') && !url.searchParams.has('v'))
    ) {
      throw new YouTubeProviderError('PLAYLIST_UNSUPPORTED');
    }
    if (url.pathname === '/watch') {
      return assertVideoId(url.searchParams.get('v'));
    }

    const pathParts = url.pathname.split('/').filter(Boolean);
    if (['shorts', 'embed', 'live'].includes(pathParts[0] || '')) {
      return assertVideoId(pathParts[1]);
    }
    throw new YouTubeProviderError('INVALID_INPUT');
  }

  resolveUrl(input: string): Promise<YouTubeVideo> {
    return this.getVideo(this.parseVideoId(input));
  }

  async resolvePlaylist(
    input: string,
    maxVideos = DEFAULT_MAX_PLAYLIST_LENGTH,
  ): Promise<readonly YouTubeVideo[]> {
    const playlistId = this.parsePlaylistId(input);
    if (!Number.isSafeInteger(maxVideos) || maxVideos <= 0) {
      throw new YouTubeProviderError('INVALID_PLAYLIST');
    }

    const client = await this.#getClient();
    const videos: YouTubeVideo[] = [];
    try {
      if (playlistId.startsWith('RD')) {
        try {
          this.parseVideoId(input);
        } catch {
          throw new YouTubeProviderError('PLAYLIST_MIX_REQUIRES_VIDEO');
        }

        const endpoint = await client.resolveURL(input);
        const info = await client.getInfo(endpoint);
        for (const item of info.playlist?.contents || []) {
          const video = mapPlaylistItem(item);
          if (video) videos.push(video);
          if (videos.length >= maxVideos) return videos;
        }
      } else {
        let page = await client.getPlaylist(playlistId);
        for (;;) {
          for (const item of page.items) {
            const video = mapPlaylistItem(item);
            if (video) videos.push(video);
            if (videos.length >= maxVideos) return videos;
          }
          if (!page.has_continuation) break;
          page = await page.getContinuation();
        }
      }
    } catch (error) {
      throw mapApiError(error, 'PLAYLIST_UNAVAILABLE');
    }

    if (videos.length === 0) {
      throw new YouTubeProviderError('PLAYLIST_EMPTY');
    }
    return videos;
  }

  async search(query: string): Promise<YouTubeVideo> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new YouTubeProviderError('INVALID_INPUT');

    const client = await this.#getClient();
    let searchResult;
    try {
      searchResult = await client.search(normalizedQuery, { type: 'video' });
    } catch (error) {
      throw mapApiError(error);
    }

    const candidate = Array.from(searchResult.videos || []).find((video) => {
      const duration = Number(video.duration?.seconds || 0);
      // The video filter can still return premieres and other non-playable entries.
      return (
        getSearchVideoId(video) &&
        duration > 0 &&
        !video.is_live &&
        !video.is_upcoming &&
        !video.is_premiere
      );
    });
    if (!candidate) throw new YouTubeProviderError('NO_RESULTS');
    return this.getVideo(getSearchVideoId(candidate));
  }

  async getVideo(videoId: string): Promise<YouTubeVideo> {
    const id = assertVideoId(videoId);
    const client = await this.#getClient();
    let info;
    try {
      info = await client.getBasicInfo(id);
    } catch (error) {
      throw mapApiError(error);
    }

    assertPlayable(info);
    const basic = info.basic_info || {};
    const duration = Number(basic.duration || 0);
    if (!basic.id || !basic.title || duration <= 0) {
      throw new YouTubeProviderError('UNAVAILABLE');
    }

    const thumbnail = [...(basic.thumbnail || [])].sort(
      (left, right) =>
        Number(right.width || 0) * Number(right.height || 0) -
        Number(left.width || 0) * Number(left.height || 0),
    )[0]?.url;
    return {
      id: basic.id,
      title: basic.title,
      url: basic.url_canonical || `https://www.youtube.com/watch?v=${basic.id}`,
      duration,
      thumbnail,
    };
  }

  async getPlaybackUrl(videoOrId: string | { id: string }): Promise<string> {
    const id = assertVideoId(
      typeof videoOrId === 'string' ? videoOrId : videoOrId.id,
    );
    const client = await this.#getClient();
    try {
      const format = await client.getStreamingData(id, {
        client: this.#playbackClient,
        ...this.#streamingOptions(),
      });
      if (!format?.url) throw new YouTubeProviderError('STREAM_UNAVAILABLE');
      return format.url;
    } catch (error) {
      if (error instanceof YouTubeProviderError) throw error;
      throw mapApiError(error, 'STREAM_UNAVAILABLE');
    }
  }

  async createPlaybackStream(
    videoOrId: string | { id: string },
    signal?: AbortSignal,
  ): Promise<Readable> {
    const id = assertVideoId(
      typeof videoOrId === 'string' ? videoOrId : videoOrId.id,
    );
    const client = await this.#getClient();
    try {
      const info = await client.getBasicInfo(id, {
        client: this.#playbackClient,
      });
      assertPlayable(info);
      const format = info.chooseFormat?.(this.#streamingOptions());
      const playbackUrl = await format?.decipher?.(client.session?.player);
      const contentLength = Number(format?.content_length || 0);
      const cpn = info.cpn;
      // A deciphered URL, its playback nonce, and a known length are all needed for
      // the bounded range requests used below.
      if (
        !playbackUrl ||
        !cpn ||
        !Number.isSafeInteger(contentLength) ||
        contentLength <= 0
      ) {
        throw new YouTubeProviderError('STREAM_UNAVAILABLE');
      }

      const fetchFunction =
        client.session?.http?.fetch_function || globalThis.fetch;
      if (typeof fetchFunction !== 'function')
        throw new YouTubeProviderError('STREAM_UNAVAILABLE');
      signal?.throwIfAborted();
      return Readable.from(
        this.#streamPlaybackChunks({
          playbackUrl,
          cpn,
          contentLength,
          fetchFunction: fetchFunction.bind(client.session?.http),
          signal,
        }),
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof YouTubeProviderError) throw error;
      throw mapApiError(error, 'STREAM_UNAVAILABLE');
    }
  }

  #streamingOptions(): StreamingOptions {
    return { type: 'audio', quality: 'best', format: 'any' };
  }

  async *#streamPlaybackChunks(options: {
    playbackUrl: string;
    cpn: string;
    contentLength: number;
    fetchFunction: FetchFunction;
    signal?: AbortSignal;
  }): AsyncGenerator<Uint8Array> {
    const { playbackUrl, cpn, contentLength, fetchFunction, signal } = options;
    for (
      let start = 0;
      start < contentLength;
      start += this.#playbackChunkSize
    ) {
      const end = Math.min(
        start + this.#playbackChunkSize - 1,
        contentLength - 1,
      );
      yield await this.#fetchPlaybackChunk({
        playbackUrl,
        cpn,
        start,
        end,
        fetchFunction,
        signal,
      });
    }
  }

  async #fetchPlaybackChunk(options: {
    playbackUrl: string;
    cpn: string;
    start: number;
    end: number;
    fetchFunction: FetchFunction;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const { playbackUrl, cpn, start, end, fetchFunction, signal } = options;
    const separator = playbackUrl.includes('?') ? '&' : '?';
    const chunkUrl = `${playbackUrl}${separator}cpn=${encodeURIComponent(cpn)}&range=${start}-${end}`;
    const expectedBytes = end - start + 1;

    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(this.#playbackChunkTimeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      try {
        const response = await fetchFunction(chunkUrl, {
          method: 'GET',
          headers: STREAM_HEADERS,
          redirect: 'follow',
          signal: requestSignal,
        });
        if (!response.ok) {
          throw new PlaybackHttpError(start, end, response.status);
        }

        // Drain the bounded response at network speed before exposing it to FFmpeg. Otherwise
        // Discord's real-time backpressure can leave the CDN response paused long enough for
        // the underlying socket to be reset.
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== expectedBytes) {
          throw new PlaybackRangeLengthError(
            start,
            end,
            bytes.byteLength,
            expectedBytes,
          );
        }
        return bytes;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (
          attempt >= this.#playbackMaxRetries ||
          !isRetryablePlaybackError(error)
        ) {
          throw error;
        }
        const delay = this.#playbackRetryDelayMs * 2 ** attempt;
        if (delay > 0) await sleep(delay, undefined, { signal });
      }
    }
  }

  #getClient(): Promise<YouTubeClient> {
    if (!this.#clientPromise) {
      this.#clientPromise = Promise.resolve()
        .then(() => this.#createClient())
        .catch((error) => {
          // A transient initialization failure must not poison all later requests.
          this.#clientPromise = undefined;
          throw mapApiError(error);
        });
    }
    return this.#clientPromise;
  }

  async #createDefaultClient(): Promise<YouTubeClient> {
    const { Innertube, UniversalCache } = await import('youtubei.js');
    return Innertube.create({
      cache: new UniversalCache(true, this.#cacheDirectory),
    }) as unknown as Promise<YouTubeClient>;
  }
}

class PlaybackHttpError extends Error {
  constructor(
    start: number,
    end: number,
    readonly status: number,
  ) {
    super(
      `YouTube media range ${start}-${end} failed with status ${status || 'unknown'}.`,
    );
    this.name = 'PlaybackHttpError';
  }
}

class PlaybackRangeLengthError extends Error {
  constructor(start: number, end: number, received: number, expected: number) {
    super(
      `YouTube media range ${start}-${end} returned ${received} of ${expected} expected bytes.`,
    );
    this.name = 'PlaybackRangeLengthError';
  }
}

function isRetryablePlaybackError(error: unknown): boolean {
  if (error instanceof PlaybackRangeLengthError) return true;
  if (error instanceof PlaybackHttpError) {
    return [408, 425, 429].includes(error.status) || error.status >= 500;
  }
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  if (error instanceof TypeError) return true;

  // Node and Undici may wrap the transport error several causes below the surface.
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === 'object';
    depth += 1
  ) {
    const code = String(
      (current as { code?: unknown }).code || '',
    ).toUpperCase();
    if (
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EPIPE',
        'ETIMEDOUT',
        'UND_ERR_BODY_TIMEOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(code)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function assertPlayable(info: VideoInfo): void {
  if (
    info.playability_status?.status &&
    info.playability_status.status !== 'OK'
  ) {
    throw new YouTubeProviderError('RESTRICTED');
  }
  const basic = info.basic_info || {};
  if (basic.is_live || basic.is_live_content || basic.is_upcoming) {
    throw new YouTubeProviderError('LIVE_UNSUPPORTED');
  }
  if (basic.is_private) throw new YouTubeProviderError('RESTRICTED');
}

function parseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

function assertVideoId(videoId: unknown): string {
  const normalized = String(videoId || '');
  if (!VIDEO_ID_PATTERN.test(normalized))
    throw new YouTubeProviderError('INVALID_INPUT');
  return normalized;
}

function getSearchVideoId(video: SearchVideo): string {
  return String(video.video_id || video.id || '');
}

function mapPlaylistItem(item: YouTubePlaylistItem): YouTubeVideo | undefined {
  if (
    item.is_playable === false ||
    item.is_live ||
    item.is_upcoming ||
    (item.content_type && !['VIDEO', 'SHORT'].includes(item.content_type))
  ) {
    return undefined;
  }

  const id = String(item.content_id || item.video_id || item.id || '');
  const title = textValue(item.metadata?.title || item.title);
  const duration =
    Number(item.duration?.seconds || 0) || playlistBadgeDuration(item);
  if (!VIDEO_ID_PATTERN.test(id) || !title || duration <= 0) return undefined;

  const thumbnails = [
    ...(item.thumbnail || []),
    ...(item.thumbnails || []),
    ...(item.content_image?.image || []),
    ...(item.content_image?.primary_thumbnail?.image || []),
  ];
  return {
    id,
    title,
    url: `https://www.youtube.com/watch?v=${id}`,
    duration,
    thumbnail: bestThumbnail(thumbnails),
  };
}

function textValue(value: YouTubeText | undefined): string {
  return value === undefined ? '' : String(value).trim();
}

function playlistBadgeDuration(item: YouTubePlaylistItem): number {
  const overlayGroups = [
    item.content_image?.overlays,
    item.content_image?.primary_thumbnail?.overlays,
  ];
  for (const overlays of overlayGroups) {
    for (const overlay of overlays || []) {
      for (const badge of overlay.badges || []) {
        const duration = parseClockDuration(badge.text || '');
        if (duration > 0) return duration;
      }
    }
  }
  return 0;
}

function parseClockDuration(value: string): number {
  const parts = value.trim().split(':');
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => !/^\d+$/.test(part))
  ) {
    return 0;
  }
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function bestThumbnail(
  thumbnails: Iterable<YouTubeThumbnail>,
): string | undefined {
  return [...thumbnails]
    .filter((thumbnail) => thumbnail.url)
    .sort(
      (left, right) =>
        Number(right.width || 0) * Number(right.height || 0) -
        Number(left.width || 0) * Number(left.height || 0),
    )[0]?.url;
}

function mapApiError(
  error: unknown,
  fallbackCode: YouTubeProviderErrorCode = 'API_UNAVAILABLE',
): YouTubeProviderError {
  if (error instanceof YouTubeProviderError) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    /\blogin\b|sign in|age[- ]restricted|\bprivate\b|region[- ]restricted|bot[- ](?:check|protected)|not a bot/.test(
      message,
    )
  ) {
    return new YouTubeProviderError('RESTRICTED', { cause: error });
  }
  if (/live|premiere/.test(message)) {
    return new YouTubeProviderError('LIVE_UNSUPPORTED', { cause: error });
  }
  return new YouTubeProviderError(fallbackCode, { cause: error });
}
