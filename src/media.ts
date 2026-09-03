import type { Readable } from 'node:stream';

export type Requester = {
  id: string;
  displayName: string;
};

export type Track = {
  provider: 'youtube';
  id: string;
  title: string;
  webpageUrl: string;
  durationSeconds: number;
  thumbnailUrl?: string;
  requestedBy: Requester;
};

export interface MediaProvider {
  supports(input: string): boolean;
  // Resolution is plural so playlists and other multi-track providers can be added
  // without changing the playback queue contract.
  resolve(input: string, requester: Requester): Promise<readonly Track[]>;
  createPlaybackStream(track: Track, signal: AbortSignal): Promise<Readable>;
}

export interface PlaylistProvider {
  resolvePlaylist(
    input: string,
    requester: Requester,
  ): Promise<readonly Track[]>;
}

export class MediaInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MediaInputError';
  }
}
