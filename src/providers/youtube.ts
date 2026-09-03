import type { Readable } from 'node:stream';
import {
  MediaInputError,
  type MediaProvider,
  type Requester,
  type Track,
} from '../media.js';
import {
  YouTubeEngine,
  YouTubeProviderError,
  type YouTubeVideo,
} from './youtube-engine.js';

export type YouTubeEngineRuntime = Pick<
  YouTubeEngine,
  | 'isYouTubeUrl'
  | 'resolveUrl'
  | 'resolvePlaylist'
  | 'search'
  | 'createPlaybackStream'
>;

export class YouTubeMediaProvider implements MediaProvider {
  readonly #provider: YouTubeEngineRuntime;

  constructor(provider: YouTubeEngineRuntime = new YouTubeEngine()) {
    this.#provider = provider;
  }

  supports(input: string): boolean {
    const normalized = input.trim();
    if (!normalized) return false;
    if (this.#provider.isYouTubeUrl(normalized)) return true;

    try {
      // Do not turn a valid URL for another site into a YouTube search query.
      new URL(normalized);
      return false;
    } catch {
      return true;
    }
  }

  async resolve(
    input: string,
    requester: Requester,
  ): Promise<readonly Track[]> {
    const normalized = input.trim();
    if (!this.supports(normalized)) {
      throw new MediaInputError(
        'Only YouTube video links and YouTube search queries are supported right now.',
      );
    }

    try {
      const video = this.#provider.isYouTubeUrl(normalized)
        ? await this.#provider.resolveUrl(normalized)
        : await this.#provider.search(normalized);
      return [mapTrack(video, requester)];
    } catch (error) {
      throw toMediaInputError(error);
    }
  }

  async createPlaybackStream(
    track: Track,
    signal: AbortSignal,
  ): Promise<Readable> {
    try {
      return await this.#provider.createPlaybackStream(track.id, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw toMediaInputError(error);
    }
  }

  async resolvePlaylist(
    input: string,
    requester: Requester,
  ): Promise<readonly Track[]> {
    try {
      const videos = await this.#provider.resolvePlaylist(input);
      return videos.map((video) => mapTrack(video, requester));
    } catch (error) {
      throw toMediaInputError(error);
    }
  }
}

function mapTrack(video: YouTubeVideo, requestedBy: Requester): Track {
  return {
    provider: 'youtube',
    id: video.id,
    title: video.title,
    webpageUrl: video.url,
    durationSeconds: video.duration,
    thumbnailUrl: video.thumbnail,
    requestedBy,
  };
}

function toMediaInputError(error: unknown): MediaInputError {
  if (error instanceof MediaInputError) return error;
  if (error instanceof YouTubeProviderError) {
    return new MediaInputError(error.message, { cause: error });
  }
  return new MediaInputError(
    'YouTube could not provide playable audio. Please try again in a moment.',
    {
      cause: error,
    },
  );
}
